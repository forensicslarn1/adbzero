import type { DeviceInstallProfile, PackageInfo } from './adb-client'
import {
  fetchCatalogPackageDetail,
  fetchCatalogRepositorySnapshot,
  isStoreCatalogReady,
  resolveCatalogUpdatesForInstalledPackages,
  searchCatalogPackages,
} from './store-catalog'
import {
  fetchLiveFdroidPackageDetail,
  fetchLiveFdroidRepositorySnapshot,
  searchLiveFdroidPackages,
} from './store-live'
import { resolveStoreInstallPlan } from './store-artifact-resolver'
import type {
  StoreBindingTrustState,
  StorePackageBinding,
  StorePackageDetail,
  StoreRepositorySnapshot,
  StoreSearchResult,
  StoreUpdateCandidate,
} from './store-types'

export const BUILTIN_STORE_REPOSITORIES: StoreRepositorySnapshot[] = [
  {
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
]

function getRepository(repoId: string): StoreRepositorySnapshot {
  const repo = BUILTIN_STORE_REPOSITORIES.find((item) => item.id === repoId)
  return repo || {
    id: repoId,
    name: repoId,
    description: 'Custom F-Droid-compatible repository',
    baseUrl: '',
    packagePageBaseUrl: '',
    searchApiUrl: '',
    entryUrl: '',
    trustState: 'unverified',
    trustLabel: 'Unverified repository',
    kind: 'fdroid',
    isBuiltin: false,
    syncEnabled: true,
  }
}

export async function fetchRepositorySnapshot(repoId: string = 'fdroid-official'): Promise<StoreRepositorySnapshot> {
  try {
    if (await isStoreCatalogReady(repoId)) {
      const catalogSnapshot = await fetchCatalogRepositorySnapshot(repoId)
      if (catalogSnapshot) {
        return catalogSnapshot
      }
    }
  } catch {
    // Fall through to the server-side live backend.
  }

  return fetchLiveFdroidRepositorySnapshot(repoId)
}

export async function searchStorePackages(
  query: string,
  repoId: string = 'fdroid-official'
): Promise<StoreSearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const repo = getRepository(repoId)

  try {
    if (await isStoreCatalogReady(repoId)) {
      const catalogResults = await searchCatalogPackages(trimmed, repoId)
      return catalogResults.map((item) => ({
        ...item,
        packageUrl: `${repo.packagePageBaseUrl}${item.packageName}/`,
      }))
    }
  } catch {
    // Fall through to the server-side live backend.
  }

  return searchLiveFdroidPackages(trimmed, repoId)
}

export async function fetchStorePackageDetail(
  packageName: string,
  repoId: string = 'fdroid-official',
  language?: string,
): Promise<StorePackageDetail> {
  try {
    if (await isStoreCatalogReady(repoId)) {
      const catalogDetail = await fetchCatalogPackageDetail(packageName, repoId, language)
      if (catalogDetail) return catalogDetail
      throw new Error(`Package ${packageName} not found in synchronized catalog`)
    }
  } catch {
    // Fall through to the server-side live backend.
  }

  return fetchLiveFdroidPackageDetail(packageName, repoId)
}

export async function resolveStoreUpdates(
  bindings: StorePackageBinding[],
  installedPackages: PackageInfo[],
  options?: {
    discoveryRepoId?: string
    discoveryRepoIds?: string[]
    language?: string
    installProfile?: DeviceInstallProfile
  },
): Promise<StoreUpdateCandidate[]> {
  const discoveryRepoId = options?.discoveryRepoId || 'fdroid-official'
  const discoveryRepoIds = options?.discoveryRepoIds
  const language = options?.language
  const installProfile = options?.installProfile
  const installedMap = new Map(installedPackages.map((item) => [item.packageName, item]))
  const boundCandidates = await Promise.all(
    bindings.map(async (binding) => {
      if (binding.updatePolicy === 'frozen') {
        return null
      }

      try {
        const detail = await fetchStorePackageDetail(binding.packageName, binding.repoId, language)
        const installed = installedMap.get(binding.packageName)
        const currentVersionCode =
          installed?.versionCode ??
          binding.lastSeenVersionCode ??
          binding.installedVersionCode ??
          null

        if (currentVersionCode === null) {
          return null
        }

        const candidateReleases = detail.releases.filter((release) => release.versionCode > currentVersionCode)
        if (candidateReleases.length === 0) {
          return null
        }

        let trustState: StoreBindingTrustState = 'trusted'
        let trustMessage: string | undefined
        const compatibleSignerDetail = binding.signerSha256
          ? {
              ...detail,
              releases: candidateReleases.filter((release) => release.signerSha256 === binding.signerSha256),
            }
          : null
        const preferredDetail = compatibleSignerDetail && compatibleSignerDetail.releases.length > 0
          ? compatibleSignerDetail
          : { ...detail, releases: candidateReleases }
        const selectedPlan = installProfile
          ? resolveStoreInstallPlan(
              preferredDetail,
              installProfile,
              { preferredSigner: binding.signerSha256 }
            )
          : null

        if (!selectedPlan) {
          if (!installProfile) {
            const selectedRelease = preferredDetail.releases[0]
            const selectedArtifact = selectedRelease?.artifacts.find((artifact) => artifact.isPrimary) || selectedRelease?.artifacts[0]
            if (!selectedRelease || !selectedArtifact) {
              return null
            }

            const fallbackTrustState: StoreBindingTrustState = (
              binding.signerSha256 &&
              selectedRelease.signerSha256 &&
              selectedRelease.signerSha256 !== binding.signerSha256
            )
              ? 'migration_required'
              : trustState
            const fallbackTrustMessage = fallbackTrustState === 'migration_required'
              ? 'Signer changed. Android requires uninstall + reinstall to migrate.'
              : trustMessage

            return {
              packageName: binding.packageName,
              appName: binding.appName || detail.name,
              repoId: binding.repoId,
              iconUrl: binding.iconUrl || detail.iconUrl,
              packageUrl: binding.packageUrl || detail.packageUrl,
              currentVersionCode,
              currentVersionName:
                binding.lastSeenVersionName ??
                binding.installedVersionName ??
                installed?.versionName ??
                null,
              latestVersionCode: selectedRelease.versionCode,
              latestVersionName: selectedRelease.versionName || String(selectedRelease.versionCode),
              latestDownloadUrl: selectedArtifact.downloadUrl,
              downloadSizeBytes: selectedArtifact.sizeBytes || undefined,
              latestSignerSha256: selectedRelease.signerSha256,
              trustState: fallbackTrustState,
              trustMessage: fallbackTrustMessage,
            } satisfies StoreUpdateCandidate
          }

          return null
        }

        const selectedRelease = selectedPlan.release
        const selectedArtifact = selectedPlan.artifacts[0]
        if (selectedRelease.versionCode <= currentVersionCode) {
          return null
        }

        if (
          binding.signerSha256 &&
          selectedRelease.signerSha256 &&
          selectedRelease.signerSha256 !== binding.signerSha256
        ) {
          trustState = 'migration_required'
          trustMessage = 'Signer changed. Android requires uninstall + reinstall to migrate.'
        }

        const downloadSizeBytes = selectedPlan.artifacts.reduce((sum, artifact) => (
          sum + (artifact.sizeBytes || 0)
        ), 0) || undefined

        return {
          packageName: binding.packageName,
          appName: binding.appName || detail.name,
          repoId: binding.repoId,
          iconUrl: binding.iconUrl || detail.iconUrl,
          packageUrl: binding.packageUrl || detail.packageUrl,
          currentVersionCode,
          currentVersionName:
            binding.lastSeenVersionName ??
            binding.installedVersionName ??
            installed?.versionName ??
            null,
          latestVersionCode: selectedRelease.versionCode,
          latestVersionName: selectedRelease.versionName || String(selectedRelease.versionCode),
          latestDownloadUrl: selectedArtifact?.downloadUrl,
          downloadSizeBytes,
          latestSignerSha256: selectedRelease.signerSha256,
          trustState,
          trustMessage,
        } satisfies StoreUpdateCandidate
      } catch {
        return null
      }
    })
  )

  const catalogDiscoveredMap = new Map<string, StoreUpdateCandidate>()
  const boundNames = new Set(bindings.map((binding) => binding.packageName))

  const repoScanOrder = Array.from(new Set(
    [
      ...(discoveryRepoIds || []),
      discoveryRepoId,
      'fdroid-official',
    ].filter((value): value is string => Boolean(value))
  ))

  for (const repoId of repoScanOrder) {
    try {
      if (!(await isStoreCatalogReady(repoId))) {
        continue
      }

      const repoUpdates = await resolveCatalogUpdatesForInstalledPackages(repoId, installedPackages, language, installProfile)
      for (const candidate of repoUpdates) {
        if (boundNames.has(candidate.packageName)) {
          continue
        }

        const existing = catalogDiscoveredMap.get(candidate.packageName)
        if (!existing) {
          catalogDiscoveredMap.set(candidate.packageName, candidate)
          continue
        }

        const existingVersion = existing.latestVersionCode || 0
        const nextVersion = candidate.latestVersionCode || 0
        if (nextVersion > existingVersion) {
          catalogDiscoveredMap.set(candidate.packageName, candidate)
          continue
        }

        if (nextVersion === existingVersion && !existing.latestDownloadUrl && candidate.latestDownloadUrl) {
          catalogDiscoveredMap.set(candidate.packageName, candidate)
        }
      }
    } catch {
      // Best effort discovery. Bound updates still work.
    }
  }

  const catalogDiscovered = [...catalogDiscoveredMap.values()]
  const merged = new Map<string, StoreUpdateCandidate>()
  for (const item of catalogDiscovered) {
    merged.set(item.packageName, item)
  }
  for (const item of boundCandidates.flatMap<StoreUpdateCandidate>((entry) => entry ? [entry] : [])) {
    merged.set(item.packageName, item)
  }

  return [...merged.values()]
    .sort((left, right) => left.appName.localeCompare(right.appName))
}

export async function resolvePackageInstallArtifacts(
  detail: StorePackageDetail,
  profile: DeviceInstallProfile,
  options?: {
    preferredSigner?: string
    targetVersionCode?: number
  }
) {
  return resolveStoreInstallPlan(detail, profile, options)
}
