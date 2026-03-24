import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const EDGE_ADMIN_UIDS = (Deno.env.get('ADMIN_UIDS') ?? Deno.env.get('VITE_ADMIN_UIDS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const STORE_ALLOWED_ORIGINS = (Deno.env.get('STORE_ALLOWED_ORIGINS') ?? Deno.env.get('CMS_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const RATE_LIMIT_WINDOW_MS = 10 * 60_000
const RATE_LIMIT_MAX_REQUESTS = 20

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

const BUILTIN_REPOSITORIES = {
  'fdroid-official': {
    id: 'fdroid-official',
    name: 'F-Droid',
    description: 'Official F-Droid repository',
    baseUrl: 'https://f-droid.org/repo/',
    packagePageBaseUrl: 'https://f-droid.org/en/packages/',
    searchApiUrl: 'https://search.f-droid.org/api/search_apps',
    entryUrl: 'https://f-droid.org/repo/entry.json',
    trustState: 'trusted_builtin',
    trustLabel: 'Built-in pinned trust',
    kind: 'fdroid',
    isBuiltin: true,
    syncEnabled: true,
  },
} as const

type SyncMode = 'noop' | 'full' | 'diff'

interface RepoRow {
  id: string
  name: string
  description: string
  base_url: string
  package_page_base_url: string
  search_api_url: string | null
  entry_url: string
  trust_state: 'trusted_builtin' | 'trusted_user_pinned' | 'unverified' | 'quarantined'
  trust_label: string
  kind: 'fdroid'
  is_builtin: boolean
  sync_enabled: boolean
  created_by: string | null
}

interface RepoSyncStateRow {
  last_entry_timestamp: number | null
}

interface RepoIndexSnapshotRow {
  entry_timestamp: number | null
  index_json: Record<string, unknown> | null
}

interface RepoTrustRow {
  trust_state: string
}

interface RepoFileRef {
  name?: string
  sha256?: string
  size?: number
  numPackages?: number
}

interface RequestAuthContext {
  user: {
    id: string
    app_metadata?: Record<string, unknown>
  } | null
  isAdmin: boolean
}

interface EntryResponse {
  timestamp?: number
  maxAge?: number
  index?: RepoFileRef
  diffs?: Record<string, RepoFileRef>
}

function getRequestIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    req.headers.get('cf-connecting-ip') ||
    'unknown'
  )
}

function sweepExpiredBuckets(): void {
  const now = Date.now()
  for (const [k, v] of rateLimitBuckets) {
    if (now >= v.resetAt) rateLimitBuckets.delete(k)
  }
}

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  if (rateLimitBuckets.size > 500) sweepExpiredBuckets()
  const bucket = rateLimitBuckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  if (bucket.count >= limit) {
    return true
  }
  bucket.count += 1
  return false
}

function originFromReferrer(referrer: string | null): string | null {
  if (!referrer) return null
  try {
    return new URL(referrer).origin
  } catch {
    return null
  }
}

function isAllowedOrigin(origin: string | null, referrer: string | null): boolean {
  if (STORE_ALLOWED_ORIGINS.length === 0) return true
  const refOrigin = originFromReferrer(referrer)
  if (origin && STORE_ALLOWED_ORIGINS.includes(origin)) return true
  if (refOrigin && STORE_ALLOWED_ORIGINS.includes(refOrigin)) return true
  return false
}

function normalizeBaseUrl(input: string): string {
  const parsed = new URL(input)
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`
  }
  return parsed.toString()
}

function corsHeaders(origin: string | null): HeadersInit {
  let allowOrigin = '*'
  if (origin) {
    allowOrigin = origin
  } else if (STORE_ALLOWED_ORIGINS.length > 0) {
    allowOrigin = STORE_ALLOWED_ORIGINS[0]
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function jsonResponse(origin: string | null, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function localizeValue(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string')
    return typeof first === 'string' ? first : undefined
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['en-US', 'en-GB', 'en', 'default']) {
      const localized = record[key]
      if (typeof localized === 'string' && localized.trim()) {
        return localized
      }
    }
    const fallback = Object.values(record).find((item) => typeof item === 'string' && item.trim())
    return typeof fallback === 'string' ? fallback : undefined
  }
  return undefined
}

function buildRepoFileUrl(baseUrl: string, fileName: string | undefined): string {
  if (!fileName) return baseUrl
  if (/^https?:\/\//i.test(fileName)) return fileName
  if (fileName.startsWith('/')) {
    return new URL(fileName.replace(/^\/+/, ''), baseUrl).toString()
  }
  const relative = fileName.replace(/^\/+/, '')
  return new URL(relative, baseUrl).toString()
}

function inferSelectionMode(artifacts: Array<{ fileName: string; abiList: string[] }>) {
  if (artifacts.length <= 1) return 'single'
  if (artifacts.some((artifact) => /(^|[-_.])(base|config|split)/i.test(artifact.fileName))) return 'session'
  if (artifacts.every((artifact) => artifact.abiList.length > 0)) return 'variant'
  return 'multi'
}

function inferArtifactRole(fileName: string, abiList: string[], totalArtifacts: number) {
  if (totalArtifacts <= 1) return 'apk'
  if (/(^|[-_.])(base|config|split)/i.test(fileName)) return 'split'
  if (abiList.length > 0) return 'variant'
  return 'apk'
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

async function fetchTextWithIntegrity(
  input: string,
  expectedSha256?: string | null,
  expectedSize?: number | null
): Promise<{ text: string; sha256: string; size: number }> {
  const response = await fetch(input)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${input}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const observedSha256 = await sha256Hex(bytes)
  const normalizedExpectedSha256 = expectedSha256?.trim().toLowerCase()

  if (normalizedExpectedSha256 && observedSha256 !== normalizedExpectedSha256) {
    throw new Error(`SHA-256 mismatch for ${input}`)
  }

  if (typeof expectedSize === 'number' && expectedSize > 0 && bytes.byteLength !== expectedSize) {
    throw new Error(`Size mismatch for ${input}`)
  }

  return {
    text: new TextDecoder().decode(bytes),
    sha256: observedSha256,
    size: bytes.byteLength,
  }
}

async function fetchJson<T>(
  input: string,
  expectedSha256?: string | null,
  expectedSize?: number | null
): Promise<{ data: T; sha256?: string; size?: number }> {
  if (!expectedSha256 && !expectedSize) {
    const response = await fetch(input)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${input}`)
    }

    return { data: await response.json() as T }
  }

  const payload = await fetchTextWithIntegrity(input, expectedSha256, expectedSize)
  return {
    data: JSON.parse(payload.text) as T,
    sha256: payload.sha256,
    size: payload.size,
  }
}

function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null) {
    return undefined
  }

  if (!isRecord(patch)) {
    return structuredClone(patch)
  }

  const result: Record<string, unknown> = isRecord(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key]
      continue
    }

    result[key] = isRecord(value)
      ? applyMergePatch(result[key], value)
      : structuredClone(value)
  }

  return result
}

async function ensureBuiltinRepository(serviceClient: ReturnType<typeof createClient>, repoId: string) {
  const builtin = BUILTIN_REPOSITORIES[repoId as keyof typeof BUILTIN_REPOSITORIES]
  if (!builtin) return

  await serviceClient.from('store_repositories').upsert({
    id: builtin.id,
    name: builtin.name,
    description: builtin.description,
    base_url: builtin.baseUrl,
    package_page_base_url: builtin.packagePageBaseUrl,
    search_api_url: builtin.searchApiUrl,
    entry_url: builtin.entryUrl,
    trust_state: builtin.trustState,
    trust_label: builtin.trustLabel,
    kind: builtin.kind,
    is_builtin: true,
    sync_enabled: true,
    verification_state: 'pending',
    verification_details: 'Waiting for the first verified sync.',
    updated_at: new Date().toISOString(),
  })
}

async function resolveRepository(serviceClient: ReturnType<typeof createClient>, repoId: string): Promise<RepoRow> {
  await ensureBuiltinRepository(serviceClient, repoId)

  const { data, error } = await serviceClient
    .from('store_repositories')
    .select('id, name, description, base_url, package_page_base_url, search_api_url, entry_url, trust_state, trust_label, kind, is_builtin, sync_enabled, created_by')
    .eq('id', repoId)
    .maybeSingle<RepoRow>()

  if (error) throw error
  if (!data) {
    throw new Error(`Repository ${repoId} not found`)
  }

  return {
    ...data,
    base_url: normalizeBaseUrl(data.base_url),
    package_page_base_url: data.package_page_base_url || normalizeBaseUrl(data.base_url),
    entry_url: data.entry_url || buildRepoFileUrl(data.base_url, 'entry.json'),
  }
}

async function resolveRequestAuth(userClient: ReturnType<typeof createClient>, jwt?: string): Promise<RequestAuthContext> {
  const { data: userData } = await userClient.auth.getUser(jwt)
  const user = userData.user

  if (!user) {
    return { user: null, isAdmin: false }
  }

  if (user.app_metadata?.role === 'admin') {
    return { user, isAdmin: true }
  }

  if (EDGE_ADMIN_UIDS.includes(user.id)) {
    return { user, isAdmin: true }
  }

  try {
    const { data: isAdminData, error: isAdminError } = await userClient.rpc('is_admin')
    if (!isAdminError && Boolean(isAdminData)) {
      return { user, isAdmin: true }
    }
  } catch {
    // Best effort only. Some projects don't expose is_admin().
  }

  return { user, isAdmin: false }
}

async function authorizeSync(
  userClient: ReturnType<typeof createClient>,
  serviceClient: ReturnType<typeof createClient>,
  repo: RepoRow,
  isServiceRoleRequest: boolean,
  jwt?: string
) {
  if (isServiceRoleRequest) {
    return
  }

  const { user, isAdmin } = await resolveRequestAuth(userClient, jwt)

  if (repo.is_builtin) {
    return
  }

  if (!user) {
    throw new Error('Authentication required')
  }

  if (isAdmin || repo.created_by === user.id) {
    return
  }

  const { data: trustRow, error: trustError } = await serviceClient
    .from('user_repo_trust')
    .select('trust_state')
    .eq('user_id', user.id)
    .eq('repo_id', repo.id)
    .maybeSingle<RepoTrustRow>()

  if (trustError) throw trustError
  if (trustRow?.trust_state !== 'approved') {
    throw new Error('Repository sync is allowed only to the owner, admins, or approved users')
  }
}

async function countRepoPackages(serviceClient: ReturnType<typeof createClient>, repoId: string) {
  const { count, error } = await serviceClient
    .from('store_packages')
    .select('id', { head: true, count: 'exact' })
    .eq('repo_id', repoId)

  if (error) throw error
  return count || 0
}

async function persistSyncState(
  serviceClient: ReturnType<typeof createClient>,
  repoId: string,
  mode: SyncMode,
  entryTimestamp: number | null,
  nowIso: string,
  lastError: string | null
) {
  const { error } = await serviceClient
    .from('store_repo_sync_state')
    .upsert({
      repo_id: repoId,
      last_entry_timestamp: entryTimestamp,
      last_sync_mode: mode,
      last_synced_at: nowIso,
      last_success_at: lastError ? null : nowIso,
      last_error: lastError,
      retry_count: lastError ? undefined : 0,
      next_retry_at: lastError ? undefined : null,
      updated_at: nowIso,
    }, { onConflict: 'repo_id' })

  if (error) throw error
}

async function persistIndexSnapshot(
  serviceClient: ReturnType<typeof createClient>,
  repoId: string,
  entryTimestamp: number | null,
  indexJson: Record<string, unknown>,
  nowIso: string
) {
  const { error } = await serviceClient
    .from('store_repo_index_snapshots')
    .upsert({
      repo_id: repoId,
      entry_timestamp: entryTimestamp,
      index_json: indexJson,
      updated_at: nowIso,
    }, { onConflict: 'repo_id' })

  if (error) throw error
}

async function quarantineRepository(
  serviceClient: ReturnType<typeof createClient>,
  repoId: string,
  reason: string
) {
  const { error } = await serviceClient
    .from('store_repositories')
    .update({
      trust_state: 'quarantined',
      trust_label: 'Integrity mismatch - quarantined',
      verification_state: 'integrity_mismatch',
      verification_details: reason,
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', repoId)

  if (error) throw error
}

async function persistPackageSnapshot(
  serviceClient: ReturnType<typeof createClient>,
  repo: RepoRow,
  packages: Array<[string, any]>,
  signerIndex: Record<string, { signer?: string }>,
  nowIso: string
) {
  if (packages.length === 0) {
    return { packageCount: 0, releaseCount: 0, artifactCount: 0, signerCount: 0 }
  }

  const packageRows = packages.map(([packageName, packageEntry]) => {
    const metadata = packageEntry.metadata || {}
    return {
      repo_id: repo.id,
      package_name: packageName,
      app_name: localizeValue(metadata.name) || packageName,
      summary: localizeValue(metadata.summary) || '',
      description: localizeValue(metadata.description) || null,
      license: localizeValue(metadata.license) || null,
      website_url: localizeValue(metadata.webSite) || null,
      source_url: localizeValue(metadata.sourceCode) || null,
      issue_tracker_url: localizeValue(metadata.issueTracker) || null,
      changelog_url: localizeValue(metadata.changelog) || null,
      translation_url: localizeValue(metadata.translation) || null,
      donate_url: localizeValue(metadata.donate) || null,
      icon_path: metadata.icon?.name || null,
      preferred_signer_sha256: typeof metadata.preferredSigner === 'string' ? metadata.preferredSigner : null,
      categories: Array.isArray(metadata.categories) ? metadata.categories : [],
      anti_features: metadata.antiFeatures ? Object.keys(metadata.antiFeatures) : [],
      metadata,
      updated_at: nowIso,
    }
  })

  for (const chunk of chunkArray(packageRows, 250)) {
    const { error } = await serviceClient.from('store_packages').insert(chunk)
    if (error) throw error
  }

  const { data: insertedPackages, error: insertedPackagesError } = await serviceClient
    .from('store_packages')
    .select('id, package_name')
    .eq('repo_id', repo.id)
    .in('package_name', packageRows.map((row) => row.package_name))

  if (insertedPackagesError) throw insertedPackagesError

  const packageIdMap = new Map((insertedPackages || []).map((row: any) => [row.package_name, row.id]))
  const releaseRows: any[] = []
  const artifactSeedRows: Array<{
    repoPackageId: string
    releaseKey: string
    fileName: string
    downloadUrl: string
    sha256: string | null
    sizeBytes: number | null
    abiList: string[]
    artifactRole: 'apk' | 'variant' | 'split'
    isPrimary: boolean
    sortOrder: number
    metadata: Record<string, unknown>
  }> = []
  const signerRows: any[] = []

  for (const [packageName, packageEntry] of packages) {
    const repoPackageId = packageIdMap.get(packageName)
    if (!repoPackageId) continue

    const grouped = new Map<string, any>()
    const versions = packageEntry.versions || {}

    for (const [versionKey, versionEntry] of Object.entries(versions as Record<string, any>)) {
      const manifest = versionEntry.manifest || {}
      if (typeof manifest.versionCode !== 'number' || !manifest.versionName || !versionEntry.file?.name) {
        continue
      }

      const signerSha256 =
        manifest.signer?.sha256?.[0] ||
        signerIndex[packageName]?.signer ||
        null

      const releaseKey = `${manifest.versionCode}:${manifest.versionName}:${signerSha256 || 'unsigned'}`
      const existing = grouped.get(releaseKey) || {
        repoPackageId,
        versionKey: releaseKey,
        versionCode: manifest.versionCode,
        versionName: manifest.versionName,
        minSdk: manifest.usesSdk?.minSdkVersion ?? null,
        targetSdk: manifest.usesSdk?.targetSdkVersion ?? null,
        signerSha256,
        addedAt: versionEntry.added ? new Date(versionEntry.added).toISOString() : null,
        metadata: {},
        artifacts: [] as any[],
      }

      existing.artifacts.push({
        versionKey,
        fileName: versionEntry.file.name.replace(/^\/+/, ''),
        downloadUrl: buildRepoFileUrl(repo.base_url, versionEntry.file.name),
        sha256: versionEntry.file.sha256 ?? null,
        sizeBytes: versionEntry.file.size ?? null,
        abiList: manifest.nativecode || [],
        metadata: {
          ...versionEntry,
          __storeVersionKey: versionKey,
        },
      })

      grouped.set(releaseKey, existing)
    }

    for (const release of grouped.values()) {
      const selectionMode = inferSelectionMode(release.artifacts)
      releaseRows.push({
        repo_package_id: release.repoPackageId,
        version_key: release.versionKey,
        version_code: release.versionCode,
        version_name: release.versionName,
        min_sdk: release.minSdk,
        target_sdk: release.targetSdk,
        signer_sha256: release.signerSha256,
        added_at: release.addedAt,
        artifact_selection_mode: selectionMode,
        metadata: release.metadata,
        updated_at: nowIso,
      })

      if (release.signerSha256) {
        signerRows.push({
          repo_package_id: repoPackageId,
          signer_sha256: release.signerSha256,
          source: 'repo_index',
          status: 'active',
          last_seen_at: nowIso,
        })
      }

      release.artifacts.forEach((artifact: any, index: number) => {
        artifactSeedRows.push({
          repoPackageId,
          releaseKey: release.versionKey,
          fileName: artifact.fileName,
          downloadUrl: artifact.downloadUrl,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          abiList: artifact.abiList,
          artifactRole: inferArtifactRole(artifact.fileName, artifact.abiList, release.artifacts.length),
          isPrimary: index === 0 || /(^|[-_.])base/i.test(artifact.fileName),
          sortOrder: index,
          metadata: artifact.metadata,
        })
      })
    }
  }

  for (const chunk of chunkArray(releaseRows, 500)) {
    const { error } = await serviceClient.from('store_releases').insert(chunk)
    if (error) throw error
  }

  const repoPackageIds = [...new Set(releaseRows.map((row) => row.repo_package_id))]
  const { data: insertedReleases, error: insertedReleasesError } = await serviceClient
    .from('store_releases')
    .select('id, repo_package_id, version_key')
    .in('repo_package_id', repoPackageIds.length > 0 ? repoPackageIds : ['00000000-0000-0000-0000-000000000000'])

  if (insertedReleasesError) throw insertedReleasesError

  const releaseIdMap = new Map((insertedReleases || []).map((row: any) => [`${row.repo_package_id}:${row.version_key}`, row.id]))

  const artifactRows = artifactSeedRows.flatMap((artifact) => {
    const releaseId = releaseIdMap.get(`${artifact.repoPackageId}:${artifact.releaseKey}`)
    if (!releaseId) return []

    return [{
      release_id: releaseId,
      filename: artifact.fileName,
      download_url: artifact.downloadUrl,
      sha256: artifact.sha256,
      size_bytes: artifact.sizeBytes,
      abi_list: artifact.abiList,
      artifact_role: artifact.artifactRole,
      is_primary: artifact.isPrimary,
      sort_order: artifact.sortOrder,
      metadata: artifact.metadata,
      updated_at: nowIso,
    }]
  })

  for (const chunk of chunkArray(artifactRows, 500)) {
    const { error } = await serviceClient.from('store_release_artifacts').insert(chunk)
    if (error) throw error
  }

  if (signerRows.length > 0) {
    const dedupedSignerRows = Array.from(
      new Map(signerRows.map((row) => [`${row.repo_package_id}:${row.signer_sha256}`, row])).values()
    )

    for (const chunk of chunkArray(dedupedSignerRows, 500)) {
      const { error } = await serviceClient.from('store_package_signers').insert(chunk)
      if (error) throw error
    }
  }

  return {
    packageCount: packageRows.length,
    releaseCount: releaseRows.length,
    artifactCount: artifactRows.length,
    signerCount: signerRows.length,
  }
}

serve(async (req) => {
  const origin = req.headers.get('origin')
  const referrer = req.headers.get('referer')

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(origin) })
  }

  if (req.method !== 'POST') {
    return jsonResponse(origin, 405, { error: 'Method not allowed' })
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(origin, 500, { error: 'Missing Supabase env' })
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  const isServiceRoleRequest = authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`

  if (!isServiceRoleRequest && !isAllowedOrigin(origin, referrer)) {
    console.warn('[store-sync-fdroid] blocked origin', { origin, referrer })
    return jsonResponse(origin, 403, { error: 'Origin not allowed' })
  }

  const requestKey = isServiceRoleRequest ? 'service-role' : (token || getRequestIp(req))
  if (!isServiceRoleRequest && isRateLimited(requestKey, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    console.warn('[store-sync-fdroid] rate limited', { requestKey })
    return jsonResponse(origin, 429, { error: 'Too many requests' })
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let payload: { repoId?: string } = {}
  try {
    payload = await req.json().catch(() => ({}))
  } catch {
    payload = {}
  }

  const repoId = typeof payload.repoId === 'string' && payload.repoId.trim() ? payload.repoId.trim() : 'fdroid-official'
  let repo: RepoRow | null = null
  let syncRunId: string | null = null

  try {
    repo = await resolveRepository(serviceClient, repoId)
    await authorizeSync(userClient, serviceClient, repo, isServiceRoleRequest, token)

    if (!repo.sync_enabled) {
      return jsonResponse(origin, 400, { error: 'Repository sync is disabled' })
    }

    const { data: entry } = await fetchJson<EntryResponse>(repo.entry_url)
    const nowIso = new Date().toISOString()
    const [{ data: syncStateRow }, { data: snapshotRow }] = await Promise.all([
      serviceClient
        .from('store_repo_sync_state')
        .select('last_entry_timestamp')
        .eq('repo_id', repo.id)
        .maybeSingle<RepoSyncStateRow>(),
      serviceClient
        .from('store_repo_index_snapshots')
        .select('entry_timestamp, index_json')
        .eq('repo_id', repo.id)
        .maybeSingle<RepoIndexSnapshotRow>(),
    ])

    const lastEntryTimestamp = syncStateRow?.last_entry_timestamp ?? null
    const nextEntryTimestamp = entry.timestamp ?? null
    const diffRef = lastEntryTimestamp ? entry.diffs?.[String(lastEntryTimestamp)] : undefined
    const requestedSyncMode: SyncMode =
      nextEntryTimestamp !== null && lastEntryTimestamp !== null && nextEntryTimestamp === lastEntryTimestamp
        ? 'noop'
        : diffRef?.name
          ? 'diff'
          : 'full'
    const hasUsableSnapshot = (
      requestedSyncMode === 'diff' &&
      snapshotRow?.index_json &&
      snapshotRow.index_json.__full === true &&
      snapshotRow.entry_timestamp === lastEntryTimestamp
    )
    const syncMode: SyncMode =
      requestedSyncMode === 'diff' && !hasUsableSnapshot
        ? 'full'
        : requestedSyncMode

    const { data: syncRun, error: syncRunError } = await serviceClient
      .from('store_repo_sync_runs')
      .insert({
        repo_id: repo.id,
        sync_mode: syncMode,
        result: 'running',
        packages_touched: 0,
        details: {
          entryTimestamp: nextEntryTimestamp,
          previousEntryTimestamp: lastEntryTimestamp,
          requestedSyncMode,
        },
        started_at: nowIso,
      })
      .select('id')
      .single<{ id: string }>()

    if (syncRunError) throw syncRunError
    syncRunId = syncRun.id

    await serviceClient
      .from('store_repositories')
      .update({
        name: repo.name,
        description: repo.description,
        base_url: repo.base_url,
        package_page_base_url: repo.package_page_base_url,
        search_api_url: repo.search_api_url,
        entry_url: repo.entry_url,
        trust_state: repo.trust_state,
        trust_label: repo.trust_label,
        kind: repo.kind,
        is_builtin: repo.is_builtin,
        sync_enabled: repo.sync_enabled,
        entry_timestamp: nextEntryTimestamp,
        index_sha256: entry.index?.sha256 ?? null,
        max_age_days: entry.maxAge ?? null,
        index_size_bytes: entry.index?.size ?? null,
        last_synced_at: nowIso,
        last_error: null,
        updated_at: nowIso,
      })
      .eq('id', repo.id)

    if (repo.id === 'fdroid-official') {
      await persistSyncState(serviceClient, repo.id, 'full', nextEntryTimestamp, nowIso, null)
      await serviceClient
        .from('store_repositories')
        .update({
          package_count: entry.index?.numPackages ?? null,
          last_synced_at: nowIso,
          last_error: null,
          verification_state: 'verified',
          verification_details: 'Repository metadata synchronized. Live package discovery remains enabled until external catalog ingestion is configured.',
          last_verified_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', repo.id)

      await serviceClient
        .from('store_repo_sync_runs')
        .update({
          result: 'success',
          packages_touched: 0,
          details: {
            packageCount: entry.index?.numPackages ?? 0,
            syncMode: 'full',
            catalogMode: 'live-proxy',
            verificationState: 'verified',
          },
          finished_at: new Date().toISOString(),
        })
        .eq('id', syncRunId)

      return jsonResponse(origin, 200, {
        ok: true,
        repositoryId: repo.id,
        syncMode: 'full',
        packageCount: entry.index?.numPackages ?? 0,
        packagesTouched: 0,
        catalogMode: 'live-proxy',
      })
    }

    if (syncMode === 'noop') {
      await persistSyncState(serviceClient, repo.id, 'noop', nextEntryTimestamp, nowIso, null)
      await serviceClient
        .from('store_repo_sync_runs')
        .update({
          result: 'skipped',
          details: {
            entryTimestamp: nextEntryTimestamp,
            previousEntryTimestamp: lastEntryTimestamp,
            reason: 'entry timestamp unchanged',
            verificationState: 'verified',
          },
          finished_at: new Date().toISOString(),
        })
        .eq('id', syncRunId)

      return jsonResponse(origin, 200, {
        ok: true,
        repositoryId: repo.id,
        syncMode: 'noop',
        packagesTouched: 0,
      })
    }

    const [signerIndexResult, fullIndexResult, diffResult] = await Promise.all([
      fetchJson<Record<string, { signer?: string }>>(buildRepoFileUrl(repo.base_url, 'signer-index.json')).catch(() => ({ data: {} })),
      syncMode === 'full'
        ? fetchJson<Record<string, unknown>>(
            buildRepoFileUrl(repo.base_url, entry.index?.name || 'index-v2.json'),
            entry.index?.sha256 ?? null,
            entry.index?.size ?? null
          )
        : Promise.resolve(null),
      syncMode === 'diff' && diffRef?.name
        ? fetchJson<Record<string, unknown>>(
            buildRepoFileUrl(repo.base_url, diffRef.name),
            diffRef.sha256 ?? null,
            diffRef.size ?? null
          )
        : Promise.resolve(null),
    ])

    const signerIndex = signerIndexResult.data || {}
    const index = syncMode === 'diff'
      ? applyMergePatch(snapshotRow?.index_json || {}, diffResult?.data || {}) as Record<string, unknown>
      : (fullIndexResult?.data || {}) as Record<string, unknown>

    await persistIndexSnapshot(serviceClient, repo.id, nextEntryTimestamp, index, nowIso)

    const allPackages = Object.entries((index.packages || {}) as Record<string, any>)
    const touchedPackageNames = syncMode === 'diff'
      ? Object.keys((((diffResult?.data as Record<string, unknown> | undefined)?.packages) || {}) as Record<string, any>)
      : allPackages.map(([packageName]) => packageName)

    const packageSubset = syncMode === 'diff'
      ? allPackages.filter(([packageName]) => touchedPackageNames.includes(packageName))
      : allPackages

    if (syncMode === 'full') {
      await serviceClient.from('store_packages').delete().eq('repo_id', repo.id)
    } else if (touchedPackageNames.length > 0) {
      await serviceClient
        .from('store_packages')
        .delete()
        .eq('repo_id', repo.id)
        .in('package_name', touchedPackageNames)
    }

    const result = await persistPackageSnapshot(serviceClient, repo, packageSubset, signerIndex, nowIso)
    const packageCount = await countRepoPackages(serviceClient, repo.id)

    await serviceClient
      .from('store_repositories')
      .update({
        package_count: packageCount,
        last_synced_at: nowIso,
        last_error: null,
        metadata: index.repo || {},
        verification_state: 'verified',
        verification_details: syncMode === 'diff'
          ? 'Verified diff SHA-256 against entry.json and applied it to the trusted snapshot.'
          : 'Verified index-v2.json SHA-256 against entry.json.',
        last_verified_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', repo.id)

    await persistSyncState(serviceClient, repo.id, syncMode, nextEntryTimestamp, nowIso, null)
    await serviceClient
      .from('store_repo_sync_runs')
      .update({
        result: 'success',
        packages_touched: touchedPackageNames.length,
        details: {
          packageCount,
          syncMode,
          verificationState: 'verified',
          verifiedArtifactSha256: syncMode === 'full'
            ? fullIndexResult?.sha256 || null
            : diffResult?.sha256 || null,
          ...result,
        },
        finished_at: new Date().toISOString(),
      })
      .eq('id', syncRunId)

    return jsonResponse(origin, 200, {
      ok: true,
      repositoryId: repo.id,
      syncMode,
      packageCount,
      packagesTouched: touchedPackageNames.length,
      releaseCount: result.releaseCount,
      artifactCount: result.artifactCount,
      signerCount: result.signerCount,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown sync error'
    const status = /Authentication required/i.test(message)
      ? 401
      : /Admin privileges required|allowed only/i.test(message)
        ? 403
        : 500

    if (repo) {
      if (/SHA-256 mismatch|Size mismatch/i.test(message)) {
        await quarantineRepository(serviceClient, repo.id, message)
      } else {
        await serviceClient
          .from('store_repositories')
          .update({
            verification_state: 'verification_failed',
            verification_details: message,
            last_error: message,
            updated_at: new Date().toISOString(),
          })
          .eq('id', repo.id)
      }

      await persistSyncState(serviceClient, repo.id, 'full', null, new Date().toISOString(), message)
    }

    if (syncRunId) {
      await serviceClient
        .from('store_repo_sync_runs')
        .update({
          result: 'error',
          details: { error: message },
          finished_at: new Date().toISOString(),
        })
        .eq('id', syncRunId)
    }

    return jsonResponse(origin, status, {
      error: status === 500 ? 'Sync failed' : 'Sync not authorized',
      details: message,
    })
  }
})
