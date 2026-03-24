export type StoreRepositoryKind = 'fdroid'
export type StoreTrustState =
  | 'trusted_builtin'
  | 'trusted_user_pinned'
  | 'unverified'
  | 'quarantined'
export type StoreRepositoryVerificationState =
  | 'pending'
  | 'verified'
  | 'integrity_mismatch'
  | 'verification_failed'
export type StoreArtifactSelectionMode = 'single' | 'variant' | 'session' | 'multi'
export type StoreArtifactRole = 'apk' | 'variant' | 'split'
export type StoreUserRepoTrustState = 'pending' | 'approved' | 'quarantined' | 'revoked'
export type StoreUpdatePolicy = 'manual' | 'notify' | 'auto_trusted' | 'frozen'
export type StoreBindingTrustState = 'trusted' | 'signer_conflict' | 'migration_required'
export type StoreExploreSort = 'featured' | 'recent' | 'alpha'
export type StoreTab = 'home' | 'search' | 'library' | 'updates' | 'sources'
export type StoreSearchHitKind = 'installed' | 'update' | 'catalog' | 'recent'
export type StoreLibraryState =
  | 'installed'
  | 'update_available'
  | 'migration_required'
  | 'not_installed_tracked'
export type StoreSuggestionReason =
  | 'matches_installed_apps'
  | 'compatible_with_device'
  | 'trusted_source'
  | 'fresh_release'

export interface StoreRepositorySnapshot {
  id: string
  name: string
  description: string
  baseUrl: string
  packagePageBaseUrl: string
  searchApiUrl: string
  entryUrl: string
  trustState: StoreTrustState
  trustLabel: string
  kind: StoreRepositoryKind
  entryTimestamp?: number
  maxAgeDays?: number
  packageCount?: number
  indexSizeBytes?: number
  lastSyncedAt?: string
  lastError?: string | null
  isBuiltin?: boolean
  syncEnabled?: boolean
  declaredFingerprint?: string
  userTrustState?: StoreUserRepoTrustState
  indexSha256?: string
  verificationState?: StoreRepositoryVerificationState
  verificationDetails?: string | null
  lastVerifiedAt?: string
  lastSyncMode?: 'noop' | 'full' | 'diff'
  retryCount?: number
  nextRetryAt?: string
}

export interface StoreSearchResult {
  repoId: string
  packageName: string
  name: string
  summary: string
  iconUrl?: string
  packageUrl: string
}

export interface StorePackageVersion {
  versionCode: number
  versionName: string
  downloadUrl?: string
}

export interface StoreReleaseArtifact {
  id: string
  fileName: string
  downloadUrl: string
  sha256?: string
  sizeBytes?: number
  abiList: string[]
  role: StoreArtifactRole
  isPrimary: boolean
}

export interface StoreMediaAsset {
  url: string
  path?: string
  locale?: string
}

export interface StorePackageRelease {
  id: string
  versionCode: number
  versionName: string
  minSdk?: number
  targetSdk?: number
  signerSha256?: string
  addedAt?: string
  selectionMode: StoreArtifactSelectionMode
  artifacts: StoreReleaseArtifact[]
}

export interface StorePackageDetail extends StoreSearchResult {
  description?: string
  whatsNew?: string
  license?: string
  websiteUrl?: string
  sourceUrl?: string
  issueTrackerUrl?: string
  changelogUrl?: string
  reproducibilityUrl?: string
  minAndroid?: string
  suggestedVersionCode?: number
  suggestedVersionName?: string
  suggestedDownloadUrl?: string
  categories?: string[]
  screenshots?: StoreMediaAsset[]
  featureGraphic?: StoreMediaAsset
  versions: StorePackageVersion[]
  releases: StorePackageRelease[]
  trustState: StoreTrustState
  trustLabel: string
}

export interface StoreCategorySummary {
  name: string
  count: number
}

export interface StoreExploreQuery {
  enabledRepoIds: string[]
  query?: string
  category?: string
  sort?: StoreExploreSort
  page?: number
  pageSize?: number
  language?: string
}

export interface StoreExploreCard {
  repoId: string
  repoName: string
  packageName: string
  name: string
  summary: string
  description?: string
  packageUrl: string
  categories: string[]
  iconUrl?: string
  screenshot?: StoreMediaAsset
  screenshotsPreview?: StoreMediaAsset[]
  latestVersionCode?: number
  latestVersionName?: string
  latestReleaseAt?: string
  trustState: StoreTrustState
  trustLabel: string
  lastSyncedAt?: string
}

export interface StoreExplorePage {
  items: StoreExploreCard[]
  total: number
  page: number
  pageSize: number
}

export interface StorePackageBinding {
  packageName: string
  repoId: string
  appName: string
  iconUrl?: string
  packageUrl?: string
  suggestedDownloadUrl?: string
  signerSha256?: string
  updatePolicy?: StoreUpdatePolicy
  trustState?: StoreBindingTrustState
  installedVersionCode?: number | null
  installedVersionName?: string | null
  lastSeenVersionCode?: number | null
  lastSeenVersionName?: string | null
  installedAt: string
  lastUpdatedAt: string
  source: 'store'
}

export interface StoreUpdateCandidate {
  packageName: string
  appName: string
  repoId: string
  iconUrl?: string
  packageUrl?: string
  currentVersionCode?: number | null
  currentVersionName?: string | null
  latestVersionCode: number
  latestVersionName: string
  latestDownloadUrl?: string
  downloadSizeBytes?: number
  latestSignerSha256?: string
  trustState: StoreBindingTrustState
  trustMessage?: string
}

export interface StoreSuggestionCard extends StoreExploreCard {
  reasons: StoreSuggestionReason[]
  compatible: boolean
}

export interface StoreHomeUpdatesSummary {
  count: number
  totalDownloadSizeBytes: number
  hasConnectedDevice: boolean
}

export interface StoreHomeContinueItem {
  id: string
  kind: 'opened' | 'installed' | 'updated' | 'failed' | 'local'
  title: string
  subtitle: string
  timestamp: string
  packageName?: string
  repoId?: string
}

export interface StoreHomeQuickAction {
  id: 'install-from-computer' | 'open-updates' | 'open-sources' | 'search-apps'
  label: string
  description: string
}

export interface StoreHomeAttentionItem {
  id: string
  severity: 'error' | 'warning' | 'info'
  title: string
  description: string
  repoId?: string
}

export interface StoreHomeModel {
  updates: StoreHomeUpdatesSummary
  suggestions: StoreSuggestionCard[]
  continueItems: StoreHomeContinueItem[]
  quickActions: StoreHomeQuickAction[]
  attentionItems: StoreHomeAttentionItem[]
}

export interface StoreSearchHit {
  id: string
  kind: StoreSearchHitKind
  name?: string
  summary?: string
  title: string
  subtitle: string
  description?: string
  iconUrl?: string
  packageName?: string
  repoId?: string
  compatible?: boolean
  actionLabel?: string
  reason?: string
  target: 'package' | 'library' | 'updates' | 'local'
}

export interface StoreLibraryEntry {
  packageName: string
  repoId: string
  appName: string
  summary?: string
  iconUrl?: string
  packageUrl?: string
  state: StoreLibraryState
  installed: boolean
  currentVersionCode?: number | null
  currentVersionName?: string | null
  latestVersionCode?: number | null
  latestVersionName?: string | null
  trustState?: StoreBindingTrustState
  updatePolicy?: StoreUpdatePolicy
  lastUpdatedAt?: string
}

