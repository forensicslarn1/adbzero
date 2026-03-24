import { supabase } from './supabase'
import { generateDeviceFingerprint } from './supabase'
import { toStoreBackendError } from './store-errors'
import { invokeStoreFunction } from './store-functions'
import type {
  StorePackageBinding,
  StoreRepositorySnapshot,
  StoreRepositoryVerificationState,
  StoreUpdatePolicy,
  StoreUserRepoTrustState,
} from './store-types'
import type { DeviceInfo, PackageInfo } from './adb-client'

interface StoreBindingRow {
  repo_id: string
  package_name: string
  app_name: string
  icon_url: string | null
  package_url: string | null
  suggested_download_url: string | null
  signer_sha256: string | null
  update_policy: StoreUpdatePolicy
  trust_state: 'trusted' | 'signer_conflict' | 'migration_required'
  installed_version_code: number | null
  installed_version_name: string | null
  last_seen_version_code: number | null
  last_seen_version_name: string | null
  installed_at: string
  last_updated_at: string
}

interface RepoTrustRow {
  repo_id: string
  trust_state: StoreUserRepoTrustState
  approved_fingerprint: string | null
}

interface RepositoryRow {
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
  is_builtin: boolean | null
  sync_enabled: boolean | null
  declared_fingerprint: string | null
  sync_interval_minutes: number | null
  index_sha256: string | null
  verification_state: StoreRepositoryVerificationState | null
  verification_details: string | null
  last_verified_at: string | null
}

interface RepoSyncStateSnapshotRow {
  repo_id: string
  last_sync_mode: 'noop' | 'full' | 'diff'
  retry_count: number
  next_retry_at: string | null
}

interface OnboardRepositoryResponse {
  ok: boolean
  repoId?: string
  trustState?: StoreUserRepoTrustState
}

interface TrustDecisionResponse {
  ok: boolean
  repoId: string
  trustState: StoreUserRepoTrustState
}

interface SyncRepositoryResponse {
  ok: boolean
  repositoryId: string
  syncMode?: 'noop' | 'full' | 'diff'
}

interface SchedulerResponse {
  ok: boolean
  scanned: number
  due: number
  processed: number
}

interface NormalizedCustomRepoInput {
  baseUrl: string
  fingerprint?: string
}

const REPOSITORY_FINGERPRINT_REGEX = /^[A-F0-9]{40,128}$/

function normalizeCustomRepoInput(
  rawBaseUrl: string,
  rawFingerprint?: string
): NormalizedCustomRepoInput {
  const parsed = new URL(rawBaseUrl.trim())
  if (parsed.protocol !== 'https:') {
    throw new Error('Custom repositories must use HTTPS')
  }
  const queryFingerprint = parsed.searchParams.get('fingerprint')?.trim() || undefined
  const fingerprint = (rawFingerprint?.trim() || queryFingerprint || undefined)?.toUpperCase()

  if (fingerprint && !REPOSITORY_FINGERPRINT_REGEX.test(fingerprint)) {
    throw new Error('Repository fingerprint must be uppercase hex without separators')
  }

  parsed.search = ''
  parsed.hash = ''

  const fileSuffixes = [
    '/entry.json',
    '/index-v2.json',
    '/index.jar',
    '/index-v1.jar',
    '/index.xml',
  ]

  const matchedSuffix = fileSuffixes.find((suffix) => parsed.pathname.toLowerCase().endsWith(suffix))
  if (matchedSuffix) {
    parsed.pathname = parsed.pathname.slice(0, -matchedSuffix.length)
  }

  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`
  }

  return {
    baseUrl: parsed.toString(),
    fingerprint,
  }
}

export function getStoreDeviceFingerprint(deviceInfo: DeviceInfo | null): string | null {
  if (!deviceInfo) return null
  return generateDeviceFingerprint(deviceInfo.manufacturer, deviceInfo.model, deviceInfo.serialNumber)
}

export async function loadServerStoreBindings(
  userId: string,
  deviceFingerprint: string
): Promise<StorePackageBinding[]> {
  const { data, error } = await supabase
    .from('store_user_package_bindings')
    .select(`
      repo_id,
      package_name,
      app_name,
      icon_url,
      package_url,
      suggested_download_url,
      signer_sha256,
      update_policy,
      trust_state,
      installed_version_code,
      installed_version_name,
      last_seen_version_code,
      last_seen_version_name,
      installed_at,
      last_updated_at
    `)
    .eq('user_id', userId)
    .eq('device_fingerprint', deviceFingerprint)

  if (error) {
    throw error
  }

  return ((data || []) as StoreBindingRow[]).map((row) => ({
    packageName: row.package_name,
    repoId: row.repo_id,
    appName: row.app_name,
    iconUrl: row.icon_url || undefined,
    packageUrl: row.package_url || undefined,
    suggestedDownloadUrl: row.suggested_download_url || undefined,
    signerSha256: row.signer_sha256 || undefined,
    updatePolicy: row.update_policy,
    trustState: row.trust_state,
    installedVersionCode: row.installed_version_code,
    installedVersionName: row.installed_version_name,
    lastSeenVersionCode: row.last_seen_version_code,
    lastSeenVersionName: row.last_seen_version_name,
    installedAt: row.installed_at,
    lastUpdatedAt: row.last_updated_at,
    source: 'store',
  }))
}

export async function persistServerStoreBinding(
  userId: string,
  deviceFingerprint: string,
  binding: StorePackageBinding
): Promise<void> {
  const { error } = await supabase
    .from('store_user_package_bindings')
    .upsert({
      user_id: userId,
      device_fingerprint: deviceFingerprint,
      package_name: binding.packageName,
      repo_id: binding.repoId,
      app_name: binding.appName,
      icon_url: binding.iconUrl || null,
      package_url: binding.packageUrl || null,
      suggested_download_url: binding.suggestedDownloadUrl || null,
      signer_sha256: binding.signerSha256 || null,
      update_policy: binding.updatePolicy || 'manual',
      trust_state: binding.trustState || 'trusted',
      installed_version_code: binding.installedVersionCode ?? null,
      installed_version_name: binding.installedVersionName ?? null,
      last_seen_version_code: binding.lastSeenVersionCode ?? null,
      last_seen_version_name: binding.lastSeenVersionName ?? null,
      installed_at: binding.installedAt,
      last_updated_at: binding.lastUpdatedAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,device_fingerprint,package_name' })

  if (error) {
    throw error
  }
}

export async function syncServerDeviceInventory(
  userId: string,
  deviceFingerprint: string,
  packages: PackageInfo[],
  bindingMap?: Record<string, StorePackageBinding>
): Promise<void> {
  if (packages.length === 0) return

  const rows = packages.map((pkg) => {
    const binding = bindingMap?.[pkg.packageName]
    return {
      user_id: userId,
      device_fingerprint: deviceFingerprint,
      package_name: pkg.packageName,
      version_code: pkg.versionCode ?? null,
      version_name: pkg.versionName ?? null,
      signer_sha256: binding?.signerSha256 || null,
      source_repo_id: binding?.repoId || null,
      metadata: {
        apkPath: pkg.apkPath,
        isEnabled: pkg.isEnabled,
        isSystem: pkg.isSystem,
      },
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  })

  const { error } = await supabase
    .from('store_device_inventory')
    .upsert(rows, { onConflict: 'user_id,device_fingerprint,package_name' })

  if (error) {
    throw error
  }
}

export async function loadStoreRepositoriesForUser(
  userId: string
): Promise<StoreRepositorySnapshot[]> {
  const [{ data: repoRows, error: repoError }, { data: trustRows, error: trustError }, { data: syncRows, error: syncError }] = await Promise.all([
    supabase
      .from('store_repositories')
      .select('*')
      .eq('sync_enabled', true)
      .order('is_builtin', { ascending: false })
      .order('name', { ascending: true }),
    supabase
      .from('user_repo_trust')
      .select('repo_id, trust_state, approved_fingerprint')
      .eq('user_id', userId),
    supabase
      .from('store_repo_sync_state')
      .select('repo_id, last_sync_mode, retry_count, next_retry_at'),
  ])

  if (repoError) throw repoError
  if (trustError) throw trustError
  if (syncError) throw syncError

  const trustMap = new Map((trustRows || []).map((row: any) => [row.repo_id, row as RepoTrustRow]))
  const syncMap = new Map((syncRows || []).map((row: any) => [row.repo_id, row as RepoSyncStateSnapshotRow]))

  return ((repoRows || []) as RepositoryRow[])
    .filter((row) => row.is_builtin || trustMap.has(row.id))
    .map((row) => {
      const trust = trustMap.get(row.id)
      const syncState = syncMap.get(row.id)
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
        declaredFingerprint: trust?.approved_fingerprint || row.declared_fingerprint || undefined,
        userTrustState: trust?.trust_state,
        indexSha256: row.index_sha256 || undefined,
        verificationState: row.verification_state || undefined,
        verificationDetails: row.verification_details || undefined,
        lastVerifiedAt: row.last_verified_at || undefined,
        lastSyncMode: syncState?.last_sync_mode,
        retryCount: syncState?.retry_count ?? 0,
        nextRetryAt: syncState?.next_retry_at ?? undefined,
      }
    })
}

export async function onboardCustomStoreRepository(
  baseUrl: string,
  fingerprint?: string
) {
  const normalized = normalizeCustomRepoInput(baseUrl, fingerprint)
  const { data, error } = await invokeStoreFunction<OnboardRepositoryResponse>('store-manage-repository', {
    body: {
      action: 'onboard',
      baseUrl: normalized.baseUrl,
      fingerprint: normalized.fingerprint,
    },
  })

  if (error) {
    throw toStoreBackendError(error, 'repository')
  }

  return data
}

export async function setStoreRepositoryTrust(
  repoId: string,
  trustState: StoreUserRepoTrustState,
  approvedFingerprint?: string
) {
  const { data, error } = await invokeStoreFunction<TrustDecisionResponse>('store-manage-repository', {
    body: {
      action: 'trust-decision',
      repoId,
      trustState,
      fingerprint: approvedFingerprint,
    },
  })

  if (error) {
    throw toStoreBackendError(error, 'repository')
  }

  return data
}

export async function syncStoreRepository(repoId: string) {
  const { data, error } = await invokeStoreFunction<SyncRepositoryResponse>('store-sync-fdroid', {
    body: { repoId },
  })

  if (error) {
    throw toStoreBackendError(error, 'sync')
  }

  return data
}

export async function runStoreSyncScheduler() {
  const { data, error } = await invokeStoreFunction<SchedulerResponse>('store-sync-scheduler')

  if (error) {
    throw toStoreBackendError(error, 'scheduler')
  }

  return data
}
