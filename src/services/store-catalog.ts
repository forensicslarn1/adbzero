import { supabase } from './supabase'
import { toStoreBackendError } from './store-errors'
import { invokeStoreFunction } from './store-functions'
import type { DeviceInstallProfile, PackageInfo } from './adb-client'
import { resolveStoreInstallPlan } from './store-artifact-resolver'
import type {
  StoreCategorySummary,
  StoreExploreCard,
  StoreExplorePage,
  StoreExploreQuery,
  StoreExploreSort,
  StoreMediaAsset,
  StorePackageDetail,
  StorePackageRelease,
  StoreReleaseArtifact,
  StoreRepositoryVerificationState,
  StoreRepositorySnapshot,
  StoreSearchResult,
  StoreTrustState,
  StoreUpdateCandidate,
} from './store-types'

const catalogReadyCache = new Map<string, boolean>()

const TRUST_PRIORITY: Record<StoreTrustState, number> = {
  trusted_builtin: 4,
  trusted_user_pinned: 3,
  unverified: 2,
  quarantined: 1,
}

interface StoreRepositoryRow {
  id: string
  name: string
  description: string
  base_url: string
  package_page_base_url: string
  search_api_url: string | null
  entry_url: string
  trust_state: StoreRepositorySnapshot['trustState']
  trust_label: string
  kind: StoreRepositorySnapshot['kind']
  entry_timestamp: number | null
  max_age_days: number | null
  package_count: number | null
  index_size_bytes: number | null
  last_synced_at: string | null
  last_error: string | null
  is_builtin?: boolean | null
  sync_enabled?: boolean | null
  declared_fingerprint?: string | null
  index_sha256?: string | null
  verification_state?: StoreRepositoryVerificationState | null
  verification_details?: string | null
  last_verified_at?: string | null
}

interface StorePackageRow {
  id: string
  repo_id: string
  package_name: string
  app_name: string
  summary: string | null
  description: string | null
  license: string | null
  website_url: string | null
  source_url: string | null
  issue_tracker_url: string | null
  changelog_url: string | null
  icon_path: string | null
  preferred_signer_sha256: string | null
  categories?: string[] | null
  metadata?: Record<string, unknown> | null
}

interface StoreReleaseRow {
  id: string
  repo_package_id: string
  version_key: string
  version_code: number
  version_name: string
  min_sdk: number | null
  target_sdk: number | null
  signer_sha256: string | null
  added_at: string | null
  artifact_selection_mode: StorePackageRelease['selectionMode']
}

interface StoreArtifactRow {
  id: string
  release_id: string
  filename: string
  download_url: string
  sha256: string | null
  size_bytes: number | null
  abi_list: string[] | null
  artifact_role: StoreReleaseArtifact['role']
  is_primary: boolean | null
  sort_order: number | null
}

interface CatalogUpdatePackageRow {
  id: string
  package_name: string
  app_name: string
  icon_path: string | null
  metadata?: Record<string, unknown> | null
}

interface ExploreRepositoryRow {
  id: string
  name: string
  base_url: string
  package_page_base_url: string
  trust_state: StoreTrustState
  trust_label: string
  last_synced_at: string | null
}

interface ExplorePackageRow {
  id: string
  repo_id: string
  package_name: string
  app_name: string
  summary: string | null
  description: string | null
  categories: string[] | null
  icon_path: string | null
  metadata: Record<string, unknown> | null
}

interface ExploreReleaseRow {
  repo_package_id: string
  version_code: number
  version_name: string
  added_at: string | null
}

interface ExploreResolvedCard {
  card: StoreExploreCard
  trustPriority: number
  latestVersionCode: number
  latestReleaseAt: number
  lastSyncedAt: number
  featuredScore: number
}

interface ExploreLatestRelease {
  versionCode: number
  versionName: string
  addedAt?: string
}

type MetadataRecord = Record<string, unknown>
type ExploreResolvedCardsQuery = Pick<StoreExploreQuery, 'enabledRepoIds' | 'query' | 'language'>

interface ExploreResolvedCardsCacheEntry {
  expiresAt: number
  promise: Promise<ExploreResolvedCard[]>
}

const EXPLORE_RESOLVED_CACHE_TTL_MS = 60_000
const exploreResolvedCardsCache = new Map<string, ExploreResolvedCardsCacheEntry>()

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function normalizeLanguage(input?: string): string {
  return (input || 'en-US').trim() || 'en-US'
}

function getExploreResolvedCardsCacheKey(query: ExploreResolvedCardsQuery): string {
  const language = normalizeLanguage(query.language)
  const search = sanitizeSearchTerm((query.query || '').trim()).toLowerCase()
  const repoIds = [...(query.enabledRepoIds || [])].sort((left, right) => left.localeCompare(right))
  return JSON.stringify({ language, search, repoIds })
}

function localeCandidates(language?: string): string[] {
  const normalized = normalizeLanguage(language)
  const lower = normalized.toLowerCase()
  const base = normalized.split('-')[0].toLowerCase()
  const candidates = [
    normalized,
    lower,
    base,
    'en-US',
    'en-us',
    'en',
  ]
  return [...new Set(candidates.filter(Boolean))]
}

function toRecord(value: unknown): MetadataRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MetadataRecord
    : undefined
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function localizedFromRecord(record: MetadataRecord, candidates: string[]): unknown {
  for (const candidate of candidates) {
    if (record[candidate] !== undefined) {
      return record[candidate]
    }
  }

  const exactKey = Object.keys(record).find((key) => candidates.includes(key.toLowerCase()))
  if (exactKey) {
    return record[exactKey]
  }

  const fallbackValue = Object.values(record)[0]
  return fallbackValue
}

function extractAssetPath(input: unknown, candidates: string[]): string | undefined {
  if (!input) return undefined
  if (typeof input === 'string') return input

  if (Array.isArray(input)) {
    for (const entry of input) {
      const path = extractAssetPath(entry, candidates)
      if (path) return path
    }
    return undefined
  }

  const record = toRecord(input)
  if (!record) return undefined

  if (typeof record.name === 'string' && record.name.trim()) {
    return record.name.trim()
  }

  return extractAssetPath(localizedFromRecord(record, candidates), candidates)
}

function resolveRepositoryAsset(baseUrl: string, value: string | null | undefined): string | undefined {
  if (!value) return undefined
  if (/^https?:\/\//i.test(value)) return value
  if (!baseUrl) return value
  return new URL(value.replace(/^\/+/, ''), baseUrl).toString()
}

function buildMediaAsset(baseUrl: string, path: string | undefined, locale?: string): StoreMediaAsset | undefined {
  const url = resolveRepositoryAsset(baseUrl, path)
  if (!url) return undefined
  return {
    url,
    path,
    locale,
  }
}

function extractScreenshotAssets(
  baseUrl: string,
  metadata: MetadataRecord | null | undefined,
  candidates: string[],
): StoreMediaAsset[] {
  const screens = toRecord(metadata?.screenshots)
  if (!screens) return []

  const buckets = ['phone', 'sevenInch', 'tenInch', 'tablet', 'tv', 'wear']
  const assets: StoreMediaAsset[] = []
  const seen = new Set<string>()

  for (const bucket of buckets) {
    const bucketValue = screens[bucket]
    if (!bucketValue) continue

    const localizedRaw = Array.isArray(bucketValue)
      ? bucketValue
      : toArray(localizedFromRecord(toRecord(bucketValue) || {}, candidates))

    for (const entry of localizedRaw) {
      const path = extractAssetPath(entry, candidates)
      const media = buildMediaAsset(baseUrl, path)
      if (!media || seen.has(media.url)) continue
      seen.add(media.url)
      assets.push(media)
    }
  }

  return assets
}

export function extractLocalizedMedia(input: {
  repoBaseUrl: string
  language?: string
  iconPath?: string | null
  metadata?: MetadataRecord | null
}) {
  const candidates = localeCandidates(input.language)
  const iconPath = input.iconPath || extractAssetPath(input.metadata?.icon, candidates)
  const featureGraphicPath = extractAssetPath(input.metadata?.featureGraphic, candidates)

  return {
    iconUrl: resolveRepositoryAsset(input.repoBaseUrl, iconPath),
    screenshots: extractScreenshotAssets(input.repoBaseUrl, input.metadata, candidates),
    featureGraphic: buildMediaAsset(input.repoBaseUrl, featureGraphicPath),
  }
}

function rowToRepository(row: StoreRepositoryRow): StoreRepositorySnapshot {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    baseUrl: row.base_url,
    packagePageBaseUrl: row.package_page_base_url,
    searchApiUrl: row.search_api_url || '',
    entryUrl: row.entry_url,
    trustState: row.trust_state,
    trustLabel: row.trust_label,
    kind: row.kind,
    entryTimestamp: row.entry_timestamp ?? undefined,
    maxAgeDays: row.max_age_days ?? undefined,
    packageCount: row.package_count ?? undefined,
    indexSizeBytes: row.index_size_bytes ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    lastError: row.last_error,
    isBuiltin: Boolean(row.is_builtin),
    syncEnabled: row.sync_enabled ?? true,
    declaredFingerprint: row.declared_fingerprint || undefined,
    indexSha256: row.index_sha256 || undefined,
    verificationState: row.verification_state || undefined,
    verificationDetails: row.verification_details || undefined,
    lastVerifiedAt: row.last_verified_at || undefined,
  }
}

function mapReleases(
  releaseRows: StoreReleaseRow[],
  artifactRows: StoreArtifactRow[],
): StorePackageRelease[] {
  const artifactMap = new Map<string, StoreReleaseArtifact[]>()

  for (const artifactRow of artifactRows) {
    const releaseArtifacts = artifactMap.get(artifactRow.release_id) || []
    releaseArtifacts.push({
      id: artifactRow.id,
      fileName: artifactRow.filename,
      downloadUrl: artifactRow.download_url,
      sha256: artifactRow.sha256 || undefined,
      sizeBytes: artifactRow.size_bytes ?? undefined,
      abiList: artifactRow.abi_list || [],
      role: artifactRow.artifact_role,
      isPrimary: Boolean(artifactRow.is_primary),
    })
    artifactMap.set(artifactRow.release_id, releaseArtifacts)
  }

  return [...releaseRows]
    .sort((left, right) => right.version_code - left.version_code)
    .map((releaseRow) => ({
      id: releaseRow.id,
      versionCode: releaseRow.version_code,
      versionName: releaseRow.version_name,
      minSdk: releaseRow.min_sdk ?? undefined,
      targetSdk: releaseRow.target_sdk ?? undefined,
      signerSha256: releaseRow.signer_sha256 ?? undefined,
      addedAt: releaseRow.added_at ?? undefined,
      selectionMode: releaseRow.artifact_selection_mode,
      artifacts: (artifactMap.get(releaseRow.id) || []).sort((left, right) => {
        const leftOrder = left.isPrimary ? -1 : 0
        const rightOrder = right.isPrimary ? -1 : 0
        return leftOrder - rightOrder || left.fileName.localeCompare(right.fileName)
      }),
    }))
}

function resolveArtifactsForReleaseFallback(release: StorePackageRelease): StoreReleaseArtifact[] {
  const primaries = release.artifacts.filter((artifact) => artifact.isPrimary)
  if (primaries.length > 0) {
    return primaries
  }

  return release.artifacts.length > 0 ? [release.artifacts[0]] : []
}

async function fetchAllRows<T>(
  pageSize: number,
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = []
  let from = 0

  while (true) {
    const to = from + pageSize - 1
    const { data, error } = await fetchPage(from, to)
    if (error) {
      throw error
    }

    const page = data || []
    rows.push(...page)

    if (page.length < pageSize) {
      break
    }
    from += pageSize
  }

  return rows
}

function sanitizeSearchTerm(input: string): string {
  return input.replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').trim()
}

function toTimestamp(input?: string | null): number {
  if (!input) return 0
  const parsed = Date.parse(input)
  return Number.isNaN(parsed) ? 0 : parsed
}

function compareDedupCandidate(a: ExploreResolvedCard, b: ExploreResolvedCard): number {
  if (a.trustPriority !== b.trustPriority) return a.trustPriority - b.trustPriority
  if (a.latestVersionCode !== b.latestVersionCode) return a.latestVersionCode - b.latestVersionCode
  if (a.lastSyncedAt !== b.lastSyncedAt) return a.lastSyncedAt - b.lastSyncedAt
  if (a.featuredScore !== b.featuredScore) return a.featuredScore - b.featuredScore
  return b.card.repoId.localeCompare(a.card.repoId)
}

function sortExploreCards(cards: ExploreResolvedCard[], sort: StoreExploreSort): ExploreResolvedCard[] {
  if (sort === 'alpha') {
    return [...cards].sort((left, right) => left.card.name.localeCompare(right.card.name))
  }

  if (sort === 'recent') {
    return [...cards].sort((left, right) => (
      right.latestReleaseAt - left.latestReleaseAt ||
      right.latestVersionCode - left.latestVersionCode ||
      left.card.name.localeCompare(right.card.name)
    ))
  }

  return [...cards].sort((left, right) => (
    right.featuredScore - left.featuredScore ||
    right.latestVersionCode - left.latestVersionCode ||
    left.card.name.localeCompare(right.card.name)
  ))
}

function filterExploreResolvedCardsByCategory(
  cards: ExploreResolvedCard[],
  category?: string,
): ExploreResolvedCard[] {
  if (!category || category === 'all') {
    return cards
  }

  return cards.filter((entry) => entry.card.categories.includes(category))
}

async function loadExploreResolvedCards(query: ExploreResolvedCardsQuery): Promise<ExploreResolvedCard[]> {
  const language = normalizeLanguage(query.language)
  const enabledRepoIds = query.enabledRepoIds || []
  const search = sanitizeSearchTerm((query.query || '').trim())

  const repositoriesQuery = supabase
    .from('store_repositories')
    .select('id, name, base_url, package_page_base_url, trust_state, trust_label, last_synced_at, sync_enabled')
    .eq('sync_enabled', true)
    .order('is_builtin', { ascending: false })
    .order('name', { ascending: true })

  const repositoriesResult = enabledRepoIds.length > 0
    ? await repositoriesQuery.in('id', enabledRepoIds)
    : await repositoriesQuery

  if (repositoriesResult.error) {
    throw repositoriesResult.error
  }

  const repositories = (repositoriesResult.data || []) as ExploreRepositoryRow[]
  if (repositories.length === 0) {
    return []
  }

  const activeRepoIds = repositories.map((repo) => repo.id)
  const repoMap = new Map(repositories.map((repo) => [repo.id, repo]))

  const packages = await fetchAllRows<ExplorePackageRow>(800, (from, to) => {
    let queryBuilder = supabase
      .from('store_packages')
      .select('id, repo_id, package_name, app_name, summary, description, categories, icon_path, metadata')
      .in('repo_id', activeRepoIds)
      .order('package_name', { ascending: true })
      .range(from, to)

      if (search) {
        queryBuilder = queryBuilder.or(`app_name.ilike.%${search}%,package_name.ilike.%${search}%,summary.ilike.%${search}%`)
      }

      return queryBuilder
  })

  if (packages.length === 0) {
    return []
  }

  const packageIds = packages.map((item) => item.id)
  const latestReleaseByPackage = new Map<string, ExploreLatestRelease>()

  const releaseChunkResults = await Promise.all(
    chunkArray(packageIds, 300).map(async (chunk) => {
      const { data, error } = await supabase
        .from('store_releases')
        .select('repo_package_id, version_code, version_name, added_at')
        .in('repo_package_id', chunk)

      if (error) {
        throw error
      }

      return (data || []) as ExploreReleaseRow[]
    })
  )

  for (const rows of releaseChunkResults) {
    for (const row of rows) {
      const current = latestReleaseByPackage.get(row.repo_package_id)
      if (!current || row.version_code > current.versionCode) {
        latestReleaseByPackage.set(row.repo_package_id, {
          versionCode: row.version_code,
          versionName: row.version_name,
          addedAt: row.added_at || undefined,
        })
      }
    }
  }

  const dedup = new Map<string, ExploreResolvedCard>()

  for (const pkg of packages) {
    const repo = repoMap.get(pkg.repo_id)
    if (!repo) continue

    const media = extractLocalizedMedia({
      repoBaseUrl: repo.base_url,
      iconPath: pkg.icon_path,
      metadata: pkg.metadata || undefined,
      language,
    })
    const categories = Array.isArray(pkg.categories) ? pkg.categories.filter((entry) => typeof entry === 'string') : []
    const latestRelease = latestReleaseByPackage.get(pkg.id)
    const latestVersionCode = latestRelease?.versionCode || 0
    const latestReleaseAt = toTimestamp(latestRelease?.addedAt || repo.last_synced_at)
    const trustPriority = TRUST_PRIORITY[repo.trust_state] || 0

    const hasDescription = Boolean((pkg.description || '').trim() || (pkg.summary || '').trim())
    const hasScreenshot = media.screenshots.length > 0
    const hasIcon = Boolean(media.iconUrl)
    const freshnessScore = Math.round(latestReleaseAt / (1000 * 60 * 60 * 24))
    const featuredScore = (
      trustPriority * 1_000_000_000 +
      (hasScreenshot ? 10_000_000 : 0) +
      (hasIcon ? 5_000_000 : 0) +
      (hasDescription ? 2_000_000 : 0) +
      freshnessScore
    )

    const candidate: ExploreResolvedCard = {
      card: {
        repoId: repo.id,
        repoName: repo.name,
        packageName: pkg.package_name,
        name: pkg.app_name,
        summary: pkg.summary || '',
        description: pkg.description || undefined,
        packageUrl: `${repo.package_page_base_url}${pkg.package_name}/`,
        categories,
        iconUrl: media.iconUrl,
        screenshot: media.screenshots[0],
        screenshotsPreview: media.screenshots.slice(0, 2),
        latestVersionCode: latestRelease?.versionCode,
        latestVersionName: latestRelease?.versionName,
        latestReleaseAt: latestRelease?.addedAt,
        trustState: repo.trust_state,
        trustLabel: repo.trust_label,
        lastSyncedAt: repo.last_synced_at || undefined,
      },
      trustPriority,
      latestVersionCode,
      latestReleaseAt,
      lastSyncedAt: toTimestamp(repo.last_synced_at),
      featuredScore,
    }

    const existing = dedup.get(pkg.package_name)
    if (!existing || compareDedupCandidate(existing, candidate) < 0) {
      dedup.set(pkg.package_name, candidate)
    }
  }

  return [...dedup.values()]
}

async function getExploreResolvedCards(query: ExploreResolvedCardsQuery): Promise<ExploreResolvedCard[]> {
  const key = getExploreResolvedCardsCacheKey(query)
  const now = Date.now()
  const cached = exploreResolvedCardsCache.get(key)

  if (cached && cached.expiresAt > now) {
    return cached.promise
  }

  const promise = loadExploreResolvedCards(query).catch((error) => {
    exploreResolvedCardsCache.delete(key)
    throw error
  })

  exploreResolvedCardsCache.set(key, {
    expiresAt: now + EXPLORE_RESOLVED_CACHE_TTL_MS,
    promise,
  })

  return promise
}

export function clearExploreResolvedCardsCache() {
  exploreResolvedCardsCache.clear()
}

export async function isStoreCatalogReady(repoId: string = 'fdroid-official'): Promise<boolean> {
  const cached = catalogReadyCache.get(repoId)
  if (cached !== undefined) {
    return cached
  }

  const { data, error } = await supabase
    .from('store_repositories')
    .select('id, package_count, verification_state')
    .eq('id', repoId)
    .maybeSingle<{ id: string; package_count: number | null; verification_state: StoreRepositoryVerificationState | null }>()

  const ready = !error && !!data && data.verification_state === 'verified' && (data.package_count || 0) > 0
  catalogReadyCache.set(repoId, ready)
  return ready
}

export async function fetchCatalogRepositorySnapshot(repoId: string): Promise<StoreRepositorySnapshot | null> {
  const { data, error } = await supabase
    .from('store_repositories')
    .select('*')
    .eq('id', repoId)
    .maybeSingle<StoreRepositoryRow>()

  if (error || !data) return null
  return rowToRepository(data)
}

export async function searchCatalogPackages(query: string, repoId: string): Promise<StoreSearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const { data: repoRow } = await supabase
    .from('store_repositories')
    .select('base_url, package_page_base_url')
    .eq('id', repoId)
    .maybeSingle<{ base_url: string; package_page_base_url: string }>()

  const safeQuery = sanitizeSearchTerm(trimmed)
  const { data, error } = await supabase
    .from('store_packages')
    .select('repo_id, package_name, app_name, summary, icon_path, metadata')
    .eq('repo_id', repoId)
    .or(`app_name.ilike.%${safeQuery}%,package_name.ilike.%${safeQuery}%,summary.ilike.%${safeQuery}%`)
    .order('app_name', { ascending: true })
    .limit(50)

  if (error || !data) {
    return []
  }

  return data.map((row: any) => {
    const media = extractLocalizedMedia({
      repoBaseUrl: repoRow?.base_url || '',
      iconPath: row.icon_path,
      metadata: row.metadata || undefined,
    })

    return {
      repoId: row.repo_id,
      packageName: row.package_name,
      name: row.app_name,
      summary: row.summary || '',
      iconUrl: media.iconUrl,
      packageUrl: `${repoRow?.package_page_base_url || ''}${row.package_name}/`,
    }
  })
}

export async function fetchCatalogPackageDetail(
  packageName: string,
  repoId: string,
  language?: string,
): Promise<StorePackageDetail | null> {
  const { data: packageRow, error: packageError } = await supabase
    .from('store_packages')
    .select('*')
    .eq('repo_id', repoId)
    .eq('package_name', packageName)
    .maybeSingle<StorePackageRow>()

  if (packageError || !packageRow) {
    return null
  }

  const { data: repoRow } = await supabase
    .from('store_repositories')
    .select('*')
    .eq('id', repoId)
    .maybeSingle<StoreRepositoryRow>()

  const { data: releaseRows } = await supabase
    .from('store_releases')
    .select('*')
    .eq('repo_package_id', packageRow.id)
    .order('version_code', { ascending: false })

  const releases = (releaseRows || []) as StoreReleaseRow[]
  const releaseIds = releases.map((item) => item.id)

  const { data: artifactRows } = await supabase
    .from('store_release_artifacts')
    .select('*')
    .in('release_id', releaseIds.length > 0 ? releaseIds : ['00000000-0000-0000-0000-000000000000'])
    .order('sort_order', { ascending: true })

  const mappedReleases = mapReleases(releases, (artifactRows || []) as StoreArtifactRow[])
  const latestRelease = mappedReleases[0]
  const latestArtifact = latestRelease?.artifacts.find((item) => item.isPrimary) || latestRelease?.artifacts[0]

  const media = extractLocalizedMedia({
    repoBaseUrl: repoRow?.base_url || '',
    iconPath: packageRow.icon_path,
    metadata: packageRow.metadata || undefined,
    language,
  })

  return {
    repoId,
    packageName,
    name: packageRow.app_name,
    summary: packageRow.summary || '',
    iconUrl: media.iconUrl,
    packageUrl: repoRow ? `${repoRow.package_page_base_url}${packageName}/` : '',
    description: packageRow.description || undefined,
    license: packageRow.license || undefined,
    websiteUrl: packageRow.website_url || undefined,
    sourceUrl: packageRow.source_url || undefined,
    issueTrackerUrl: packageRow.issue_tracker_url || undefined,
    changelogUrl: packageRow.changelog_url || undefined,
    categories: (packageRow.categories || []).filter((entry): entry is string => typeof entry === 'string'),
    screenshots: media.screenshots,
    featureGraphic: media.featureGraphic,
    minAndroid: latestRelease?.minSdk ? `Android ${latestRelease.minSdk}+` : undefined,
    suggestedVersionCode: latestRelease?.versionCode,
    suggestedVersionName: latestRelease?.versionName,
    suggestedDownloadUrl: latestArtifact?.downloadUrl,
    versions: mappedReleases.map((release) => ({
      versionCode: release.versionCode,
      versionName: release.versionName,
      downloadUrl: release.artifacts[0]?.downloadUrl,
    })),
    releases: mappedReleases,
    trustState: repoRow?.trust_state || 'trusted_builtin',
    trustLabel: repoRow?.trust_label || 'Built-in pinned trust',
  }
}

export async function syncBuiltinStoreCatalog() {
  const { data, error } = await invokeStoreFunction('store-sync-fdroid', {
    body: { repoId: 'fdroid-official' },
  })

  if (error) {
    throw toStoreBackendError(error, 'sync')
  }

  catalogReadyCache.clear()
  exploreResolvedCardsCache.clear()
  return data
}

export async function resolveCatalogUpdatesForInstalledPackages(
  repoId: string,
  installedPackages: PackageInfo[],
  language?: string,
  installProfile?: DeviceInstallProfile,
): Promise<StoreUpdateCandidate[]> {
  const installedByPackage = new Map(
    installedPackages
      .filter((pkg) => typeof pkg.versionCode === 'number')
      .map((pkg) => [pkg.packageName, pkg]),
  )

  const packageNames = [...installedByPackage.keys()]
  if (packageNames.length === 0) {
    return []
  }

  const { data: repoRow } = await supabase
    .from('store_repositories')
    .select('base_url, package_page_base_url')
    .eq('id', repoId)
    .maybeSingle<{ base_url: string; package_page_base_url: string }>()

  const packageRows: CatalogUpdatePackageRow[] = []
  for (const chunk of chunkArray(packageNames, 200)) {
    const { data, error } = await supabase
      .from('store_packages')
      .select('id, package_name, app_name, icon_path, metadata')
      .eq('repo_id', repoId)
      .in('package_name', chunk)

    if (error) {
      throw error
    }

    if (data) {
      packageRows.push(...(data as CatalogUpdatePackageRow[]))
    }
  }

  if (packageRows.length === 0) {
    return []
  }

  const packageIds = packageRows.map((row) => row.id)
  const releaseRows: StoreReleaseRow[] = []
  for (const chunk of chunkArray(packageIds, 250)) {
    const { data, error } = await supabase
      .from('store_releases')
      .select('id, repo_package_id, version_key, version_code, version_name, min_sdk, target_sdk, signer_sha256, added_at, artifact_selection_mode')
      .in('repo_package_id', chunk)

    if (error) {
      throw error
    }

    if (data) {
      releaseRows.push(...(data as StoreReleaseRow[]))
    }
  }

  const releaseIds = releaseRows.map((release) => release.id)
  const artifactRows: StoreArtifactRow[] = []
  for (const chunk of chunkArray(releaseIds, 250)) {
    const { data, error } = await supabase
      .from('store_release_artifacts')
      .select('id, release_id, filename, download_url, sha256, size_bytes, abi_list, artifact_role, is_primary, sort_order')
      .in('release_id', chunk)
      .order('sort_order', { ascending: true })

    if (error) {
      throw error
    }

    if (data) {
      artifactRows.push(...(data as StoreArtifactRow[]))
    }
  }

  const updates: StoreUpdateCandidate[] = []
  for (const pkgRow of packageRows) {
    const installed = installedByPackage.get(pkgRow.package_name)
    if (!installed || typeof installed.versionCode !== 'number') continue
    const installedVersionCode = installed.versionCode

    const packageReleases = mapReleases(
      releaseRows.filter((release) => release.repo_package_id === pkgRow.id),
      artifactRows,
    ).filter((release) => release.versionCode > installedVersionCode)

    if (packageReleases.length === 0) continue

    const media = extractLocalizedMedia({
      repoBaseUrl: repoRow?.base_url || '',
      iconPath: pkgRow.icon_path,
      metadata: pkgRow.metadata || undefined,
      language,
    })

    const detailLike: StorePackageDetail = {
      repoId,
      packageName: pkgRow.package_name,
      name: pkgRow.app_name,
      summary: '',
      packageUrl: `${repoRow?.package_page_base_url || ''}${pkgRow.package_name}/`,
      trustState: 'trusted_builtin',
      trustLabel: 'Built-in pinned trust',
      versions: packageReleases.map((release) => ({
        versionCode: release.versionCode,
        versionName: release.versionName,
        downloadUrl: release.artifacts[0]?.downloadUrl,
      })),
      releases: packageReleases,
      iconUrl: media.iconUrl,
    }

    const installPlan = installProfile
      ? resolveStoreInstallPlan(detailLike, installProfile)
      : null

    const selectedRelease = installPlan?.release || packageReleases[0]
    const selectedArtifacts = installPlan?.artifacts || resolveArtifactsForReleaseFallback(selectedRelease)
    const preferredArtifact = selectedArtifacts[0]

    if (selectedRelease.versionCode <= installedVersionCode || selectedArtifacts.length === 0) continue

    const downloadSizeBytes = selectedArtifacts.reduce((sum, artifact) => (
      sum + (artifact.sizeBytes || 0)
    ), 0) || undefined

    updates.push({
      packageName: pkgRow.package_name,
      appName: pkgRow.app_name,
      repoId,
      iconUrl: media.iconUrl,
      packageUrl: `${repoRow?.package_page_base_url || ''}${pkgRow.package_name}/`,
      currentVersionCode: installedVersionCode,
      currentVersionName: installed.versionName ?? null,
      latestVersionCode: selectedRelease.versionCode,
      latestVersionName: selectedRelease.versionName,
      latestDownloadUrl: preferredArtifact?.downloadUrl,
      downloadSizeBytes,
      latestSignerSha256: selectedRelease.signerSha256 || undefined,
      trustState: 'trusted',
    })
  }

  return updates
}

export async function listExploreCategories(query: {
  enabledRepoIds: string[]
  query?: string
  language?: string
}): Promise<StoreCategorySummary[]> {
  const resolved = await getExploreResolvedCards({
    enabledRepoIds: query.enabledRepoIds,
    query: query.query,
    language: query.language,
  })

  const counter = new Map<string, number>()
  for (const entry of resolved) {
    const categories = entry.card.categories.length > 0 ? entry.card.categories : ['Uncategorized']
    for (const category of categories) {
      const current = counter.get(category) || 0
      counter.set(category, current + 1)
    }
  }

  return [...counter.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

export async function listExploreApps(query: StoreExploreQuery): Promise<StoreExplorePage> {
  const sort = query.sort || 'featured'
  const page = Math.max(1, query.page || 1)
  const pageSize = Math.max(1, Math.min(60, query.pageSize || 24))

  const resolved = filterExploreResolvedCardsByCategory(await getExploreResolvedCards({
    enabledRepoIds: query.enabledRepoIds,
    query: query.query,
    language: query.language,
  }), query.category)

  const sorted = sortExploreCards(resolved, sort)
  const total = sorted.length
  const offset = (page - 1) * pageSize
  const items = sorted.slice(offset, offset + pageSize).map((entry) => entry.card)

  return {
    items,
    total,
    page,
    pageSize,
  }
}

export function buildExploreInstallLabel(params: {
  installedVersionCode?: number | null
  latestVersionCode?: number
}) {
  if (typeof params.installedVersionCode !== 'number') return 'install'
  if (typeof params.latestVersionCode === 'number' && params.latestVersionCode > params.installedVersionCode) return 'update'
  return 'installed'
}

export function resolveExploreSortLabel(sort: StoreExploreSort) {
  if (sort === 'recent') return 'recent'
  if (sort === 'alpha') return 'alpha'
  return 'featured'
}
