import type { DeviceInstallProfile } from './adb-client'
import type {
  StorePackageDetail,
  StorePackageRelease,
  StoreReleaseArtifact,
} from './store-types'

export interface ResolvedStoreInstallPlan {
  release: StorePackageRelease
  artifacts: StoreReleaseArtifact[]
}

function normalizeAbi(value: string): string {
  return value.trim().toLowerCase()
}

function abiCompatibilityScore(artifact: StoreReleaseArtifact, supportedAbis: string[]): number {
  if (artifact.abiList.length === 0) return 50

  const normalizedSupported = supportedAbis.map(normalizeAbi)
  const normalizedArtifact = artifact.abiList.map(normalizeAbi)

  for (let i = 0; i < normalizedSupported.length; i += 1) {
    if (normalizedArtifact.includes(normalizedSupported[i])) {
      return 100 - i
    }
  }

  return -1
}

function isArtifactAbiCompatible(artifact: StoreReleaseArtifact, supportedAbis: string[]): boolean {
  if (artifact.abiList.length === 0) return true
  return abiCompatibilityScore(artifact, supportedAbis) >= 0
}

function isReleaseCompatible(release: StorePackageRelease, profile: DeviceInstallProfile): boolean {
  if (!profile.apiLevel || !release.minSdk) return true
  return release.minSdk <= profile.apiLevel
}

function sortReleases(
  releases: StorePackageRelease[],
  profile: DeviceInstallProfile,
  preferredSigner?: string
): StorePackageRelease[] {
  return [...releases].sort((left, right) => {
    const leftSignerBonus = preferredSigner && left.signerSha256 === preferredSigner ? 1000 : 0
    const rightSignerBonus = preferredSigner && right.signerSha256 === preferredSigner ? 1000 : 0

    const leftArtifactScore = Math.max(...left.artifacts.map((item) => abiCompatibilityScore(item, profile.supportedAbis)), -1)
    const rightArtifactScore = Math.max(...right.artifacts.map((item) => abiCompatibilityScore(item, profile.supportedAbis)), -1)

    return (
      rightSignerBonus - leftSignerBonus ||
      right.versionCode - left.versionCode ||
      rightArtifactScore - leftArtifactScore ||
      right.artifacts.length - left.artifacts.length
    )
  })
}

function resolveArtifactsForRelease(
  release: StorePackageRelease,
  profile: DeviceInstallProfile
): StoreReleaseArtifact[] {
  if (release.artifacts.length === 0) {
    return []
  }

  if (release.artifacts.length === 1) {
    return isArtifactAbiCompatible(release.artifacts[0], profile.supportedAbis)
      ? release.artifacts
      : []
  }

  if (release.selectionMode === 'variant') {
    const ranked = [...release.artifacts]
      .map((artifact) => ({ artifact, score: abiCompatibilityScore(artifact, profile.supportedAbis) }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score)

    if (ranked.length > 0) {
      return [ranked[0].artifact]
    }

    return []
  }

  if (release.selectionMode === 'session') {
    const abiSpecificArtifacts = release.artifacts.filter((artifact) => artifact.abiList.length > 0)
    const compatibleAbiArtifacts = abiSpecificArtifacts.filter((artifact) => (
      isArtifactAbiCompatible(artifact, profile.supportedAbis)
    ))

    if (abiSpecificArtifacts.length > 0 && compatibleAbiArtifacts.length === 0) {
      return []
    }

    const selected = release.artifacts.filter((artifact) => {
      if (artifact.isPrimary || artifact.abiList.length === 0) return true
      return abiCompatibilityScore(artifact, profile.supportedAbis) >= 0
    })

    if (selected.length > 0) {
      return selected
    }
  }

  const primaries = release.artifacts.filter((artifact) => (
    artifact.isPrimary &&
    isArtifactAbiCompatible(artifact, profile.supportedAbis)
  ))
  if (primaries.length > 0) {
    return primaries
  }

  const firstCompatible = release.artifacts.find((artifact) => (
    isArtifactAbiCompatible(artifact, profile.supportedAbis)
  ))

  return firstCompatible ? [firstCompatible] : []
}

export function resolveStoreInstallPlan(
  detail: StorePackageDetail,
  profile: DeviceInstallProfile,
  options?: {
    preferredSigner?: string
    targetVersionCode?: number
  }
): ResolvedStoreInstallPlan | null {
  const compatibleReleases = detail.releases
    .filter((release) => !options?.targetVersionCode || release.versionCode === options.targetVersionCode)
    .filter((release) => isReleaseCompatible(release, profile))

  if (compatibleReleases.length === 0) {
    return null
  }

  const sorted = sortReleases(compatibleReleases, profile, options?.preferredSigner)

  for (const release of sorted) {
    const artifacts = resolveArtifactsForRelease(release, profile)
    if (artifacts.length > 0) {
      return { release, artifacts }
    }
  }

  return null
}
