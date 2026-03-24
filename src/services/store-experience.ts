import type { DeviceInstallProfile, PackageInfo } from './adb-client'
import { listExploreApps } from './store-catalog'
import { fetchStorePackageDetail, resolvePackageInstallArtifacts } from './store-api'
import type {
  StoreExploreCard,
  StoreHomeAttentionItem,
  StoreHomeContinueItem,
  StoreHomeModel,
  StoreHomeQuickAction,
  StoreLibraryEntry,
  StorePackageBinding,
  StoreSearchHit,
  StoreSuggestionCard,
  StoreSuggestionReason,
  StoreUpdateCandidate,
} from './store-types'

const STORE_RECENT_ACTIVITY_KEY = 'adbzero-store-recents-v1'
const MAX_RECENT_ACTIVITY_ITEMS = 12
const SUGGESTION_COMPATIBILITY_SAMPLE = 6
const SEARCH_COMPATIBILITY_SAMPLE = 12

interface PersistedRecentActivity {
  id: string
  kind: StoreHomeContinueItem['kind']
  title: string
  subtitle: string
  timestamp: string
  packageName?: string
  repoId?: string
}

interface ScoredSuggestion extends StoreSuggestionCard {
  score: number
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase()
}

function safeReadRecentActivity(): PersistedRecentActivity[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(STORE_RECENT_ACTIVITY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is PersistedRecentActivity => Boolean(item && typeof item === 'object'))
      : []
  } catch {
    return []
  }
}

function safeWriteRecentActivity(items: PersistedRecentActivity[]) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(STORE_RECENT_ACTIVITY_KEY, JSON.stringify(items))
  } catch {
    // Best effort cache only.
  }
}

function trustPriority(value: StoreExploreCard['trustState']): number {
  if (value === 'trusted_builtin') return 4
  if (value === 'trusted_user_pinned') return 3
  if (value === 'unverified') return 2
  return 1
}

function bindingStatePriority(state: StoreLibraryEntry['state']): number {
  if (state === 'migration_required') return 4
  if (state === 'update_available') return 3
  if (state === 'installed') return 2
  return 1
}

function matchesSearch(query: string, values: Array<string | null | undefined>): boolean {
  const normalizedQuery = normalizeQuery(query)
  if (!normalizedQuery) return false
  return values.some((value) => value?.toLowerCase().includes(normalizedQuery))
}

function scoreTextMatch(query: string, values: Array<string | null | undefined>): number {
  const normalizedQuery = normalizeQuery(query)
  if (!normalizedQuery) return 0

  let best = 0
  for (const value of values) {
    if (!value) continue
    const normalized = value.toLowerCase()
    if (normalized === normalizedQuery) {
      best = Math.max(best, 1000)
      continue
    }
    if (normalized.startsWith(normalizedQuery)) {
      best = Math.max(best, 700)
      continue
    }
    if (normalized.includes(normalizedQuery)) {
      best = Math.max(best, 450)
    }
  }

  return best
}

function isFreshRelease(card: StoreExploreCard): boolean {
  if (!card.latestReleaseAt) return false
  const timestamp = Date.parse(card.latestReleaseAt)
  if (Number.isNaN(timestamp)) return false
  return Date.now() - timestamp < 1000 * 60 * 60 * 24 * 120
}

function dedupeReasons(reasons: StoreSuggestionReason[]): StoreSuggestionReason[] {
  return [...new Set(reasons)]
}

const compatibilityCache = new Map<string, boolean>()

async function checkCardCompatibility(
  card: StoreExploreCard,
  installProfile?: DeviceInstallProfile,
): Promise<boolean> {
  if (!installProfile) return true

  const key = [
    card.repoId,
    card.packageName,
    installProfile.apiLevel || 'na',
    installProfile.supportedAbis.join(','),
  ].join('|')

  const cached = compatibilityCache.get(key)
  if (cached !== undefined) {
    return cached
  }

  try {
    const detail = await fetchStorePackageDetail(card.packageName, card.repoId)
    const plan = await resolvePackageInstallArtifacts(detail, installProfile)
    const compatible = Boolean(plan)
    compatibilityCache.set(key, compatible)
    return compatible
  } catch {
    compatibilityCache.set(key, false)
    return false
  }
}

function toQuickActions(): StoreHomeQuickAction[] {
  return [
    {
      id: 'install-from-computer',
      label: 'Install from computer',
      description: 'Queue one or more APK files from this computer.',
    },
    {
      id: 'open-updates',
      label: 'Open updates',
      description: 'Review and install pending updates on the connected device.',
    },
    {
      id: 'open-sources',
      label: 'Open sources',
      description: 'Manage repositories, trust state, and sync status.',
    },
    {
      id: 'search-apps',
      label: 'Search apps',
      description: 'Search the enabled catalog and jump straight to app pages.',
    },
  ]
}

export function listStoreRecentActivity(): StoreHomeContinueItem[] {
  return safeReadRecentActivity()
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, MAX_RECENT_ACTIVITY_ITEMS)
}

export function recordStoreRecentActivity(
  item: Omit<StoreHomeContinueItem, 'id' | 'timestamp'> & { timestamp?: string }
) {
  const nextTimestamp = item.timestamp || new Date().toISOString()
  const id = [
    item.kind,
    item.packageName || item.title,
    item.repoId || 'local',
  ].join(':')

  const nextEntry: PersistedRecentActivity = {
    id,
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle,
    timestamp: nextTimestamp,
    packageName: item.packageName,
    repoId: item.repoId,
  }

  const existing = safeReadRecentActivity()
    .filter((entry) => entry.id !== id)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))

  safeWriteRecentActivity([nextEntry, ...existing].slice(0, MAX_RECENT_ACTIVITY_ITEMS))
}

export function buildStoreLibrary(input: {
  bindings: StorePackageBinding[]
  installedPackages: PackageInfo[]
  updates: StoreUpdateCandidate[]
}): StoreLibraryEntry[] {
  const installedMap = new Map(input.installedPackages.map((pkg) => [pkg.packageName, pkg]))
  const updateMap = new Map(input.updates.map((update) => [update.packageName, update]))

  return [...input.bindings]
    .map<StoreLibraryEntry>((binding) => {
      const installed = installedMap.get(binding.packageName)
      const update = updateMap.get(binding.packageName)
      const state: StoreLibraryEntry['state'] = !installed
        ? 'not_installed_tracked'
        : update?.trustState === 'migration_required'
          ? 'migration_required'
          : update
            ? 'update_available'
            : 'installed'

      return {
        packageName: binding.packageName,
        repoId: binding.repoId,
        appName: binding.appName || binding.packageName,
        iconUrl: binding.iconUrl,
        packageUrl: binding.packageUrl,
        state,
        installed: Boolean(installed),
        currentVersionCode:
          installed?.versionCode ??
          binding.lastSeenVersionCode ??
          binding.installedVersionCode ??
          null,
        currentVersionName:
          installed?.versionName ??
          binding.lastSeenVersionName ??
          binding.installedVersionName ??
          null,
        latestVersionCode: update?.latestVersionCode ?? null,
        latestVersionName: update?.latestVersionName ?? null,
        trustState: update?.trustState || binding.trustState,
        updatePolicy: binding.updatePolicy,
        lastUpdatedAt: binding.lastUpdatedAt,
      }
    })
    .sort((left, right) => (
      bindingStatePriority(right.state) - bindingStatePriority(left.state) ||
      Date.parse(right.lastUpdatedAt || '') - Date.parse(left.lastUpdatedAt || '') ||
      left.appName.localeCompare(right.appName)
    ))
}

export function buildStoreHomeShell(input: {
  updates: StoreUpdateCandidate[]
  hasConnectedDevice: boolean
  attentionItems?: StoreHomeAttentionItem[]
}): StoreHomeModel {
  const recentItems = listStoreRecentActivity()

  return {
    updates: {
      count: input.updates.length,
      totalDownloadSizeBytes: input.updates.reduce((sum, item) => sum + (item.downloadSizeBytes || 0), 0),
      hasConnectedDevice: input.hasConnectedDevice,
    },
    suggestions: [],
    continueItems: recentItems.slice(0, 6),
    quickActions: toQuickActions(),
    attentionItems: (input.attentionItems || []).slice(0, 4),
  }
}

export async function buildStoreHomeModel(input: {
  enabledRepoIds: string[]
  language?: string
  installedPackages: PackageInfo[]
  bindings: StorePackageBinding[]
  updates: StoreUpdateCandidate[]
  installProfile?: DeviceInstallProfile
  hasConnectedDevice: boolean
  attentionItems?: StoreHomeAttentionItem[]
}): Promise<StoreHomeModel> {
  const shell = buildStoreHomeShell({
    updates: input.updates,
    hasConnectedDevice: input.hasConnectedDevice,
    attentionItems: input.attentionItems,
  })
  const installedNames = new Set(input.installedPackages.map((pkg) => pkg.packageName))
  const updateNames = new Set(input.updates.map((item) => item.packageName))
  const trackedNames = new Set(input.bindings.map((binding) => binding.packageName))
  const hasCompatibilityProfile = Boolean(input.hasConnectedDevice && input.installProfile)

  const featuredPage = await listExploreApps({
    enabledRepoIds: input.enabledRepoIds,
    sort: 'featured',
    page: 1,
    pageSize: 18,
    language: input.language,
  })

  const installedCategories = new Set<string>()
  for (const card of featuredPage.items) {
    if (installedNames.has(card.packageName) || trackedNames.has(card.packageName)) {
      card.categories.forEach((category) => installedCategories.add(category))
    }
  }

  const candidateCards = featuredPage.items
    .filter((card) => !installedNames.has(card.packageName))
    .filter((card) => !updateNames.has(card.packageName))

  const compatibilitySubset = candidateCards.slice(0, SUGGESTION_COMPATIBILITY_SAMPLE)
  const compatibilityResults = hasCompatibilityProfile
    ? await Promise.all(
      compatibilitySubset.map(async (card) => ({
        card,
        compatible: await checkCardCompatibility(card, input.installProfile),
      }))
    )
    : []
  const compatibilityMap = new Map(
    compatibilityResults.map((entry) => [`${entry.card.repoId}:${entry.card.packageName}`, entry.compatible])
  )

  const suggestions = candidateCards
    .map<ScoredSuggestion | null>((card) => {
      const compatible = hasCompatibilityProfile
        ? compatibilityMap.get(`${card.repoId}:${card.packageName}`) ?? true
        : true

      if (hasCompatibilityProfile && !compatible) {
        return null
      }

      const reasons: StoreSuggestionReason[] = []
      let score = trustPriority(card.trustState) * 100

      const matchesInstalled = card.categories.some((category) => installedCategories.has(category))
      if (matchesInstalled) {
        score += 240
        reasons.push('matches_installed_apps')
      }

      if (compatible && hasCompatibilityProfile) {
        score += 180
        reasons.push('compatible_with_device')
      }

      if (trustPriority(card.trustState) >= 3) {
        score += 120
        reasons.push('trusted_source')
      }

      if (isFreshRelease(card)) {
        score += 90
        reasons.push('fresh_release')
      }

      score += card.latestVersionCode || 0

      return {
        ...card,
        reasons: dedupeReasons(reasons),
        compatible,
        score,
      }
    })
    .flatMap((entry) => entry ? [entry] : [])
    .sort((left, right) => (
      right.score - left.score ||
      left.name.localeCompare(right.name)
    ))
    .slice(0, 8)
    .map(({ score: _score, ...item }) => item)

  return {
    ...shell,
    suggestions,
  }
}

export async function searchStoreUniverse(input: {
  query: string
  enabledRepoIds: string[]
  language?: string
  bindings: StorePackageBinding[]
  installedPackages: PackageInfo[]
  updates: StoreUpdateCandidate[]
  installProfile?: DeviceInstallProfile
  sessionLocalApks?: Array<{ id: string; name: string; sizeBytes?: number }>
}): Promise<StoreSearchHit[]> {
  const query = input.query.trim()
  if (!query) return []

  const libraryEntries = buildStoreLibrary({
    bindings: input.bindings,
    installedPackages: input.installedPackages,
    updates: input.updates,
  })
  const recentItems = listStoreRecentActivity()

  const installedHits = libraryEntries
    .filter((entry) => entry.installed)
    .filter((entry) => matchesSearch(query, [entry.appName, entry.packageName]))
    .map<StoreSearchHit>((entry) => ({
      id: `installed:${entry.packageName}`,
      kind: 'installed',
      title: entry.appName,
      subtitle: entry.packageName,
      iconUrl: entry.iconUrl,
      packageName: entry.packageName,
      repoId: entry.repoId,
      compatible: true,
      actionLabel: entry.state === 'update_available' ? 'Update' : 'Open',
      target: 'package',
    }))

  const updateHits = input.updates
    .filter((entry) => matchesSearch(query, [entry.appName, entry.packageName]))
    .map<StoreSearchHit>((entry) => ({
      id: `update:${entry.packageName}`,
      kind: 'update',
      title: entry.appName,
      subtitle: entry.packageName,
      description: `${entry.currentVersionName || entry.currentVersionCode || '-'} -> ${entry.latestVersionName}`,
      iconUrl: entry.iconUrl,
      packageName: entry.packageName,
      repoId: entry.repoId,
      compatible: entry.trustState !== 'signer_conflict',
      actionLabel: entry.trustState === 'migration_required' ? 'Migrate' : 'Update',
      target: 'package',
    }))

  const recentHits = [
    ...recentItems
      .filter((entry) => matchesSearch(query, [entry.title, entry.subtitle, entry.packageName]))
      .map<StoreSearchHit>((entry) => ({
        id: `recent:${entry.id}`,
        kind: 'recent',
        title: entry.title,
        subtitle: entry.subtitle,
        packageName: entry.packageName,
        repoId: entry.repoId,
        compatible: true,
        actionLabel: entry.kind === 'failed' ? 'Retry' : 'Open',
        target: entry.packageName && entry.repoId ? 'package' : 'local',
      })),
    ...(input.sessionLocalApks || [])
      .filter((entry) => matchesSearch(query, [entry.name]))
      .map<StoreSearchHit>((entry) => ({
        id: `local:${entry.id}`,
        kind: 'recent',
        title: entry.name,
        subtitle: entry.sizeBytes ? `${Math.round(entry.sizeBytes / 1024)} KB` : 'Local APK',
        compatible: true,
        actionLabel: 'Install',
        target: 'local',
      })),
  ]

  const catalogPage = await listExploreApps({
    enabledRepoIds: input.enabledRepoIds,
    query,
    sort: 'featured',
    page: 1,
    pageSize: 24,
    language: input.language,
  })

  const compatibilitySubset = catalogPage.items.slice(0, SEARCH_COMPATIBILITY_SAMPLE)
  const compatibilityResults = await Promise.all(
    compatibilitySubset.map(async (card) => ({
      card,
      compatible: await checkCardCompatibility(card, input.installProfile),
    }))
  )
  const compatibilityMap = new Map(
    compatibilityResults.map((entry) => [`${entry.card.repoId}:${entry.card.packageName}`, entry.compatible])
  )

  const catalogHits = catalogPage.items.map<StoreSearchHit>((entry) => {
    const hitCompatibility = input.installProfile
      ? compatibilityMap.get(`${entry.repoId}:${entry.packageName}`) ?? false
      : true

    return {
      id: `catalog:${entry.repoId}:${entry.packageName}`,
      kind: 'catalog',
      title: entry.name,
      subtitle: entry.packageName,
      description: entry.summary,
      iconUrl: entry.iconUrl,
      packageName: entry.packageName,
      repoId: entry.repoId,
      compatible: hitCompatibility,
      actionLabel: 'Open',
      reason: entry.categories[0],
      target: 'package',
    }
  })

  const deduped = new Map<string, StoreSearchHit>()
  for (const hit of [...updateHits, ...installedHits, ...recentHits, ...catalogHits]) {
    if (!deduped.has(hit.id)) {
      deduped.set(hit.id, hit)
    }
  }

  const kindBonus: Record<StoreSearchHit['kind'], number> = {
    update: 300,
    installed: 240,
    recent: 160,
    catalog: 120,
  }

  return [...deduped.values()].sort((left, right) => {
    const leftScore = (
      scoreTextMatch(query, [left.title, left.subtitle, left.packageName]) +
      kindBonus[left.kind] +
      (left.compatible === false ? -150 : 80)
    )
    const rightScore = (
      scoreTextMatch(query, [right.title, right.subtitle, right.packageName]) +
      kindBonus[right.kind] +
      (right.compatible === false ? -150 : 80)
    )

    return rightScore - leftScore || left.title.localeCompare(right.title)
  })
}
