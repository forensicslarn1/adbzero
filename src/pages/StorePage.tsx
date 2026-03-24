import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileBox,
  FolderDown,
  Image as ImageIcon,
  Loader2,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldX,
  Smartphone,
  Upload,
} from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import { StoreIcon } from '@/components/ui/StoreIcon'
import { Button } from '@/components/ui/Button'
import { Modal, ModalActions } from '@/components/ui/Modal'
import { extractStorePlainText, sanitizeStoreHtml } from '@/lib/store-html'
import { useTranslation } from '@/stores/i18nStore'
import { useAppStore } from '@/stores/appStore'
import { useAuthStore } from '@/stores/authStore'
import { useAdb } from '@/hooks/useAdb'
import { useStoreStore } from '@/stores/storeStore'
import {
  fetchRepositorySnapshot,
  fetchStorePackageDetail,
  resolvePackageInstallArtifacts,
  resolveStoreUpdates,
} from '@/services/store-api'
import { syncBuiltinStoreCatalog } from '@/services/store-catalog'
import {
  buildStoreHomeShell,
  buildStoreHomeModel,
  buildStoreLibrary,
  recordStoreRecentActivity,
  searchStoreUniverse,
} from '@/services/store-experience'
import {
  installLocalApkFiles,
  installRemoteApkArtifacts,
  type InstallBatchMode,
  type InstallProgress,
} from '@/services/install-engine'
import {
  getDeviceInstallProfile,
  getPackageInstallSource,
  getPackageVersionInfo,
  uninstallPackage,
} from '@/services/adb-client'
import {
  clearExploreResolvedCardsCache,
  listExploreApps,
  listExploreCategories,
} from '@/services/store-catalog'
import { populateRepoIconIndex, runIconCacheMaintenance } from '@/services/store-icon-bridge'
import {
  getStoreDeviceFingerprint,
  loadServerStoreBindings,
  loadStoreRepositoriesForUser,
  onboardCustomStoreRepository,
  persistServerStoreBinding,
  setStoreRepositoryTrust,
  syncServerDeviceInventory,
  syncStoreRepository,
  runStoreSyncScheduler,
} from '@/services/store-state'
import type {
  StoreHomeModel,
  StorePackageBinding,
  StoreExploreCard,
  StoreCategorySummary,
  StoreLibraryEntry,
  StoreExploreSort,
  StorePackageDetail,
  StoreRepositorySnapshot,
  StoreSearchHit,
  StoreTab,
  StoreUpdatePolicy,
  StoreUpdateCandidate,
} from '@/services/store-types'

type QueueStatus = 'queued' | 'installing' | 'success' | 'error'
type StoreAlertSeverity = 'error' | 'warning' | 'info'
type StoreMigrationChoice = 'cancel' | 'reinstall' | 'keep_data'

interface LocalQueueItem {
  id: string
  file: File
  status: QueueStatus
  progress: number
  message?: string
}

interface StoreTrustAlert {
  id: string
  severity: StoreAlertSeverity
  title: string
  description: string
  targetTab: Extract<StoreTab, 'updates' | 'sources'>
  repoId?: string
}

interface BulkUpdateProgressState {
  totalItems: number
  completedItems: number
  currentAppName?: string
  message: string
  overallPercent: number
  currentPercent: number
  downloadedBytes: number
  totalBytes?: number
  speedBytesPerSecond?: number
}

interface StoreMigrationPromptState {
  packageName: string
  packageLabel: string
}

const STORE_TABS: StoreTab[] = ['home', 'search', 'library', 'updates', 'sources']

const screenshotTransitionVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 72 : -72,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: direction > 0 ? -72 : 72,
    opacity: 0,
  }),
}

const PLAY_STORE_INSTALLER_TOKENS = ['com.android.vending', 'vending']

function isPlayStoreInstallerValue(value: string | null | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === 'null' || normalized === 'none') return false
  return PLAY_STORE_INSTALLER_TOKENS.some((token) => normalized.includes(token))
}

function isLikelyPlayStoreInstallSource(source: {
  installerPackageName?: string | null
  installingPackageName?: string | null
  initiatingPackageName?: string | null
  originatingPackageName?: string | null
} | null): boolean {
  if (!source) return false
  return (
    isPlayStoreInstallerValue(source.installerPackageName) ||
    isPlayStoreInstallerValue(source.installingPackageName) ||
    isPlayStoreInstallerValue(source.initiatingPackageName) ||
    isPlayStoreInstallerValue(source.originatingPackageName)
  )
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatBytesPerSecond(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '-'
  return `${formatBytes(bytesPerSecond)}/s`
}

function formatDate(value: number | string | undefined): string {
  if (!value) return '-'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function getTrustBadgeClass(trustState: StoreRepositorySnapshot['trustState']): string {
  if (trustState === 'trusted_builtin' || trustState === 'trusted_user_pinned') {
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  }
  if (trustState === 'quarantined') {
    return 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
  }
  return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
}

function getFileNameFromUrl(url: string | undefined, fallback: string): string {
  if (!url) return fallback

  try {
    const parsed = new URL(url)
    const candidate = parsed.pathname.split('/').filter(Boolean).pop()
    return candidate || fallback
  } catch {
    return fallback
  }
}

function isApkFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.apk')
}

function toInstallMessage(progress: InstallProgress): string {
  const suffix = progress.percent !== undefined ? ` (${progress.percent}%)` : ''
  return `${progress.message}${suffix}`
}

function isSignerMismatchInstallError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''

  const normalized = message.toLowerCase()
  return (
    normalized.includes('install_failed_update_incompatible') ||
    normalized.includes('install_parse_failed_inconsistent_certificates') ||
    normalized.includes('signatures do not match') ||
    normalized.includes('inconsistent certificates')
  )
}

function isRepositoryMetadataStale(repo: StoreRepositorySnapshot): boolean {
  if (!repo.lastSyncedAt || !repo.maxAgeDays) return false
  const lastSyncedAtMs = new Date(repo.lastSyncedAt).getTime()
  if (Number.isNaN(lastSyncedAtMs)) return false
  return lastSyncedAtMs + repo.maxAgeDays * 24 * 60 * 60 * 1000 < Date.now()
}

function alertToneClasses(severity: StoreAlertSeverity) {
  if (severity === 'error') {
    return 'border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-400'
  }
  if (severity === 'warning') {
    return 'border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-400'
  }
  return 'border-sky-500/20 bg-sky-500/5 text-sky-700 dark:text-sky-400'
}

function StoreEmptyState({
  icon,
  title,
  description,
  tone = 'neutral',
}: {
  icon: typeof Smartphone
  title: string
  description: string
  tone?: 'neutral' | 'success'
}) {
  const Icon = icon
  const iconToneClass = tone === 'success'
    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    : 'bg-surface-200/70 text-surface-500 dark:bg-white/5 dark:text-surface-400'

  return (
    <Card variant="glass" className="p-10 text-center">
      <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl ${iconToneClass}`}>
        <Icon className="h-6 w-6" strokeWidth={1.5} />
      </div>
      <h3 className="text-lg font-semibold text-surface-900 dark:text-white">{title}</h3>
      <p className="mt-2 text-sm text-surface-500">{description}</p>
    </Card>
  )
}

export function StorePage() {
  const { t, language } = useTranslation()
  const { showToast } = useAppStore()
  const theme = useAppStore((state) => state.theme)
  const user = useAuthStore((state) => state.user)
  const isAdmin = useAuthStore((state) => state.isAdmin)
  const { isConnected, isDemoMode, deviceInfo, packages, packagesLoading, loadPackages } = useAdb()
  const [searchParams, setSearchParams] = useSearchParams()

  const repositoryRecord = useStoreStore((state) => state.repositories)
  const bindingRecord = useStoreStore((state) => state.bindings)
  const setRepositories = useStoreStore((state) => state.setRepositories)
  const setBindings = useStoreStore((state) => state.setBindings)
  const upsertBinding = useStoreStore((state) => state.upsertBinding)

  const [activeTab, setActiveTab] = useState<StoreTab>('home')
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<StoreSearchHit[]>([])
  const [selectedPackage, setSelectedPackage] = useState<StorePackageDetail | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [homeLoading, setHomeLoading] = useState(true)
  const [homeSuggestionsLoading, setHomeSuggestionsLoading] = useState(false)
  const [exploreLoading, setExploreLoading] = useState(false)
  const [repoLoading, setRepoLoading] = useState(false)
  const [updatesLoading, setUpdatesLoading] = useState(false)
  const [bulkUpdating, setBulkUpdating] = useState(false)
  const [bulkUpdateProgress, setBulkUpdateProgress] = useState<BulkUpdateProgressState | null>(null)
  const [catalogSyncLoading, setCatalogSyncLoading] = useState(false)
  const [updates, setUpdates] = useState<StoreUpdateCandidate[]>([])
  const [exploreCards, setExploreCards] = useState<StoreExploreCard[]>([])
  const [exploreCategories, setExploreCategories] = useState<StoreCategorySummary[]>([])
  const [exploreQuery] = useState('')
  const [exploreCategory, setExploreCategory] = useState('all')
  const [exploreSort, setExploreSort] = useState<StoreExploreSort>('featured')
  const [explorePage, setExplorePage] = useState(1)
  const [exploreTotal, setExploreTotal] = useState(0)
  const [enabledExploreRepoIds, setEnabledExploreRepoIds] = useState<string[]>([])
  const [exploreScreenshotIndex, setExploreScreenshotIndex] = useState(0)
  const [exploreScreenshotDirection, setExploreScreenshotDirection] = useState<1 | -1>(1)
  const [remoteInstallKey, setRemoteInstallKey] = useState<string | null>(null)
  const [remoteInstallMessage, setRemoteInstallMessage] = useState('')
  const [localQueue, setLocalQueue] = useState<LocalQueueItem[]>([])
  const [localMode, setLocalMode] = useState<InstallBatchMode>('separate')
  const [showLocalInstallPanel, setShowLocalInstallPanel] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [selectedRepoId, setSelectedRepoId] = useState('fdroid-official')
  const [customRepoUrl, setCustomRepoUrl] = useState('')
  const [customRepoFingerprint, setCustomRepoFingerprint] = useState('')
  const [repoActionLoadingId, setRepoActionLoadingId] = useState<string | null>(null)
  const [onboardingRepo, setOnboardingRepo] = useState(false)
  const [homeModel, setHomeModel] = useState<StoreHomeModel | null>(null)
  const [migrationPrompt, setMigrationPrompt] = useState<StoreMigrationPromptState | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const localPanelRef = useRef<HTMLDivElement>(null)
  const dragDepthRef = useRef(0)
  const exploreTouchStartXRef = useRef<number | null>(null)
  const autoUpdatingRef = useRef(false)
  const catalogBootstrapRef = useRef(false)
  const migrationPromptResolveRef = useRef<((choice: StoreMigrationChoice) => void) | null>(null)
  const installSourceCacheRef = useRef<Map<string, {
    installerPackageName?: string | null
    installingPackageName?: string | null
    initiatingPackageName?: string | null
    originatingPackageName?: string | null
  } | null>>(new Map())

  const canInstall = isConnected && !isDemoMode
  const exploreSelectColorScheme: 'light' | 'dark' = theme === 'dark' ? 'dark' : 'light'
  const repositories = useMemo(() => Object.values(repositoryRecord), [repositoryRecord])
  const bindings = useMemo(() => Object.values(bindingRecord), [bindingRecord])
  const packageRouteRepoId = searchParams.get('storeRepo')
  const packageRoutePackageName = searchParams.get('storePackage')
  const isSearchDetailPage = activeTab === 'search' && Boolean(packageRouteRepoId && packageRoutePackageName)

  const installedMap = useMemo(() => new Map(packages.map((item) => [item.packageName, item])), [packages])
  const syncEnabledRepoIds = useMemo(
    () => repositories.filter((repo) => repo.syncEnabled !== false).map((repo) => repo.id),
    [repositories]
  )
  const bindingMap = useMemo(
    () => bindings.reduce<Record<string, StorePackageBinding>>((acc, binding) => {
      acc[binding.packageName] = binding
      return acc
    }, {}),
    [bindings]
  )
  const totalUpdateDownloadBytes = useMemo(
    () => updates.reduce((sum, candidate) => sum + (candidate.downloadSizeBytes || 0), 0),
    [updates]
  )
  const deviceFingerprint = useMemo(() => getStoreDeviceFingerprint(deviceInfo), [deviceInfo])
  const libraryEntries = useMemo<StoreLibraryEntry[]>(() => buildStoreLibrary({
    bindings,
    installedPackages: packages,
    updates,
  }), [bindings, packages, updates])

  const resolveMigrationPrompt = useCallback((choice: StoreMigrationChoice) => {
    const resolve = migrationPromptResolveRef.current
    migrationPromptResolveRef.current = null
    setMigrationPrompt(null)
    resolve?.(choice)
  }, [])

  const requestMigrationChoice = useCallback((packageName: string, packageLabel: string) => {
    migrationPromptResolveRef.current?.('cancel')
    return new Promise<StoreMigrationChoice>((resolve) => {
      migrationPromptResolveRef.current = resolve
      setMigrationPrompt({ packageName, packageLabel })
    })
  }, [])

  useEffect(() => (
    () => {
      const resolve = migrationPromptResolveRef.current
      migrationPromptResolveRef.current = null
      resolve?.('cancel')
    }
  ), [])

  const refreshRepositories = useCallback(async () => {
    setRepoLoading(true)
    try {
      if (user) {
        const nextRepositories = await loadStoreRepositoriesForUser(user.id)
        setRepositories(nextRepositories.length > 0 ? nextRepositories : [await fetchRepositorySnapshot()])
      } else {
        const snapshot = await fetchRepositorySnapshot()
        setRepositories([snapshot])
      }
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.repositoryRefreshFailed'),
      })
    } finally {
      setRepoLoading(false)
    }
  }, [setRepositories, showToast, t, user])

  const syncPackages = useCallback(async () => {
    if (!isConnected) return

    try {
      await loadPackages()
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.installedRefreshFailed'),
      })
    }
  }, [isConnected, loadPackages, showToast, t])

  const filterOutLikelyPlayStoreUpdates = useCallback(async (
    candidates: StoreUpdateCandidate[]
  ): Promise<StoreUpdateCandidate[]> => {
    if (candidates.length === 0) return candidates

    const boundPackageNames = new Set(bindings.map((binding) => binding.packageName))
    const filtered: StoreUpdateCandidate[] = []

    for (const candidate of candidates) {
      if (boundPackageNames.has(candidate.packageName)) {
        filtered.push(candidate)
        continue
      }

      let source = installSourceCacheRef.current.get(candidate.packageName) || null
      if (!installSourceCacheRef.current.has(candidate.packageName)) {
        try {
          source = await getPackageInstallSource(candidate.packageName)
        } catch {
          source = null
        }
        installSourceCacheRef.current.set(candidate.packageName, source)
      }

      if (isLikelyPlayStoreInstallSource(source)) {
        continue
      }

      filtered.push(candidate)
    }

    return filtered
  }, [bindings])

  const refreshUpdates = useCallback(async () => {
    if (!isConnected) return

    setUpdatesLoading(true)

    try {
      const installProfile = await getDeviceInstallProfile()
      const resolvedBindings = await Promise.all(
        bindings.map(async (binding) => {
          const installed = installedMap.get(binding.packageName)
          let versionCode = installed?.versionCode ?? binding.lastSeenVersionCode ?? binding.installedVersionCode ?? null
          let versionName = installed?.versionName ?? binding.lastSeenVersionName ?? binding.installedVersionName ?? null

          if (versionCode === null || !versionName) {
            try {
              const versionInfo = await getPackageVersionInfo(binding.packageName)
              versionCode = versionInfo.versionCode ?? versionCode
              versionName = versionInfo.versionName ?? versionName
            } catch {
              // Best effort only.
            }
          }

          const versionChanged = (
            binding.lastSeenVersionCode !== versionCode ||
            binding.lastSeenVersionName !== versionName
          )

          const nextBinding: StorePackageBinding = versionChanged
            ? {
                ...binding,
                lastSeenVersionCode: versionCode,
                lastSeenVersionName: versionName,
                lastUpdatedAt: new Date().toISOString(),
              }
            : binding

          if (versionChanged) {
            upsertBinding(nextBinding)
            if (user && deviceFingerprint) {
              await persistServerStoreBinding(user.id, deviceFingerprint, nextBinding).catch(() => undefined)
            }
          }

          return nextBinding
        })
      )

      const nextUpdatesRaw = await resolveStoreUpdates(resolvedBindings, packages, {
        discoveryRepoId: selectedRepoId || 'fdroid-official',
        discoveryRepoIds: syncEnabledRepoIds,
        language,
        installProfile,
      })
      const nextUpdates = await filterOutLikelyPlayStoreUpdates(nextUpdatesRaw)
      const updateMap = new Map(nextUpdates.map((item) => [item.packageName, item]))
      await Promise.all(resolvedBindings.map(async (binding) => {
        const candidate = updateMap.get(binding.packageName)
        const nextTrustState = candidate?.trustState || 'trusted'
        if ((binding.trustState || 'trusted') === nextTrustState) return

        const nextBinding: StorePackageBinding = {
          ...binding,
          trustState: nextTrustState,
          lastUpdatedAt: new Date().toISOString(),
        }
        upsertBinding(nextBinding)
        if (user && deviceFingerprint) {
          await persistServerStoreBinding(user.id, deviceFingerprint, nextBinding).catch(() => undefined)
        }
      }))
      setUpdates(nextUpdates)
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.updatesRefreshFailed'),
      })
    } finally {
      setUpdatesLoading(false)
    }
  }, [bindings, filterOutLikelyPlayStoreUpdates, language, selectedRepoId, syncEnabledRepoIds, deviceFingerprint, installedMap, isConnected, packages, showToast, t, upsertBinding, user])

  const syncCatalog = useCallback(async () => {
    setCatalogSyncLoading(true)
    try {
      await syncBuiltinStoreCatalog()
      clearExploreResolvedCardsCache()
      await refreshRepositories()
      showToast({
        type: 'success',
        title: t('common.success'),
        message: t('store.catalogSyncSuccess'),
      })
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.catalogSyncFailed'),
      })
    } finally {
      setCatalogSyncLoading(false)
    }
  }, [refreshRepositories, showToast, t])

  const syncRepositoryCatalog = useCallback(async (repoId: string) => {
    setRepoActionLoadingId(repoId)
    try {
      if (repoId === 'fdroid-official' && isAdmin) {
        await syncBuiltinStoreCatalog()
      } else {
        await syncStoreRepository(repoId)
      }
      clearExploreResolvedCardsCache()
      await refreshRepositories()
      showToast({
        type: 'success',
        title: t('common.success'),
        message: t('store.repositorySyncSuccess'),
      })
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.repositorySyncFailed'),
      })
    } finally {
      setRepoActionLoadingId(null)
    }
  }, [isAdmin, refreshRepositories, showToast, t])

  const runScheduler = useCallback(async () => {
    setRepoActionLoadingId('__scheduler__')
    try {
      await runStoreSyncScheduler()
      await refreshRepositories()
      showToast({
        type: 'success',
        title: t('common.success'),
        message: t('store.schedulerRunSuccess'),
      })
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.schedulerRunFailed'),
      })
    } finally {
      setRepoActionLoadingId(null)
    }
  }, [refreshRepositories, showToast, t])

  const onboardRepository = useCallback(async () => {
    const trimmedUrl = customRepoUrl.trim()
    if (!trimmedUrl) return

    setOnboardingRepo(true)
    try {
      const result = await onboardCustomStoreRepository(trimmedUrl, customRepoFingerprint.trim() || undefined)
      await refreshRepositories()
      if (result?.repoId) {
        setSelectedRepoId(result.repoId as string)
        await syncStoreRepository(result.repoId as string).catch(() => undefined)
        clearExploreResolvedCardsCache()
        await refreshRepositories()
      }
      setCustomRepoUrl('')
      setCustomRepoFingerprint('')
      showToast({
        type: 'success',
        title: t('common.success'),
        message: t('store.repositoryAdded'),
      })
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.repositoryAddFailed'),
      })
    } finally {
      setOnboardingRepo(false)
    }
  }, [customRepoFingerprint, customRepoUrl, refreshRepositories, showToast, t])

  const updateRepositoryTrust = useCallback(async (repoId: string, trustState: 'approved' | 'quarantined' | 'revoked') => {
    setRepoActionLoadingId(repoId)
    try {
      await setStoreRepositoryTrust(repoId, trustState)
      await refreshRepositories()
      showToast({
        type: 'success',
        title: t('common.success'),
        message: t('store.repositoryTrustUpdated'),
      })
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.repositoryTrustUpdateFailed'),
      })
    } finally {
      setRepoActionLoadingId(null)
    }
  }, [refreshRepositories, showToast, t])

  const updateBindingPolicy = useCallback(async (binding: StorePackageBinding, updatePolicy: StoreUpdatePolicy) => {
    const nextBinding: StorePackageBinding = {
      ...binding,
      updatePolicy,
      lastUpdatedAt: new Date().toISOString(),
    }

    upsertBinding(nextBinding)
    try {
      if (user && deviceFingerprint) {
        await persistServerStoreBinding(user.id, deviceFingerprint, nextBinding)
      }
      showToast({
        type: 'success',
        title: t('common.success'),
        message: t('store.policySaved'),
      })
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.installFailed'),
      })
    }
  }, [deviceFingerprint, showToast, t, upsertBinding, user])

  const currentRepository = repositories.find((repo) => repo.id === selectedRepoId) || repositories[0]
  const explorePageSize = 18
  const exploreTotalPages = Math.max(1, Math.ceil(exploreTotal / explorePageSize))
  const activeExploreRepoIds = useMemo(() => {
    const defaultRepoIds = repositories
      .filter((repo) => repo.syncEnabled !== false)
      .map((repo) => repo.id)
    if (enabledExploreRepoIds.length === 0) {
      return defaultRepoIds
    }

    const allowed = new Set(defaultRepoIds)
    return enabledExploreRepoIds.filter((repoId) => allowed.has(repoId))
  }, [enabledExploreRepoIds, repositories])

  // On mount: evict stale icons + populate repo icon index for debloater bridge
  useEffect(() => {
    runIconCacheMaintenance().catch(() => undefined)
    populateRepoIconIndex().catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshRepositories().catch(() => undefined)
  }, [refreshRepositories])

  useEffect(() => {
    if (!isAdmin || isDemoMode || catalogSyncLoading) return
    if (catalogBootstrapRef.current) return
    if (!currentRepository || currentRepository.id !== 'fdroid-official') return
    if ((currentRepository.packageCount || 0) > 0) return
    if (currentRepository.verificationState !== 'pending') return

    catalogBootstrapRef.current = true
    syncCatalog().catch(() => undefined)
  }, [catalogSyncLoading, currentRepository, isAdmin, isDemoMode, syncCatalog])

  useEffect(() => {
    if (isConnected) {
      syncPackages().catch(() => undefined)
    }
  }, [isConnected, syncPackages])

  useEffect(() => {
    if ((activeTab === 'home' || activeTab === 'updates' || activeTab === 'library') && isConnected) {
      refreshUpdates().catch(() => undefined)
    }
  }, [activeTab, isConnected, refreshUpdates])

  useEffect(() => {
    if (repositories.length === 0) return
    if (!repositories.some((repo) => repo.id === selectedRepoId)) {
      setSelectedRepoId(repositories[0].id)
    }
  }, [repositories, selectedRepoId])

  useEffect(() => {
    if (repositories.length === 0) return

    const defaultRepoIds = repositories
      .filter((repo) => repo.syncEnabled !== false)
      .map((repo) => repo.id)

    if (enabledExploreRepoIds.length === 0) {
      setEnabledExploreRepoIds(defaultRepoIds)
      return
    }

    const allowed = new Set(defaultRepoIds)
    const cleaned = enabledExploreRepoIds.filter((repoId) => allowed.has(repoId))
    if (cleaned.length !== enabledExploreRepoIds.length) {
      setEnabledExploreRepoIds(cleaned.length > 0 ? cleaned : defaultRepoIds)
    }
  }, [enabledExploreRepoIds, repositories])

  useEffect(() => {
    setExplorePage(1)
  }, [exploreQuery, exploreCategory, exploreSort, enabledExploreRepoIds])

  useEffect(() => {
    setExploreScreenshotIndex(0)
    setExploreScreenshotDirection(1)
  }, [selectedPackage?.packageName, selectedPackage?.repoId])

  useEffect(() => {
    if (!user || !deviceFingerprint) return

    loadServerStoreBindings(user.id, deviceFingerprint)
      .then((serverBindings) => {
        setBindings(serverBindings)
      })
      .catch((error) => {
        console.warn('Failed to load store bindings', error)
      })
  }, [deviceFingerprint, setBindings, user])

  useEffect(() => {
    if (!user || !deviceFingerprint || !isConnected || packagesLoading) return

    syncServerDeviceInventory(user.id, deviceFingerprint, packages, bindingMap).catch((error) => {
      console.warn('Failed to sync store device inventory', error)
    })
  }, [bindingMap, deviceFingerprint, isConnected, packages, packagesLoading, user])

  const runSearch = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchResults([])
      return
    }

    setSearchLoading(true)
    try {
      const installProfile = isConnected
        ? await getDeviceInstallProfile().catch(() => undefined)
        : undefined
      const results = await searchStoreUniverse({
        query: trimmed,
        enabledRepoIds: activeExploreRepoIds,
        language,
        bindings,
        installedPackages: packages,
        updates,
        installProfile,
        sessionLocalApks: localQueue.map((item) => ({
          id: item.id,
          name: item.file.name,
          sizeBytes: item.file.size,
        })),
      })
      setSearchResults(results)
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.searchFailed'),
      })
    } finally {
      setSearchLoading(false)
    }
  }, [activeExploreRepoIds, bindings, isConnected, language, localQueue, packages, query, showToast, t, updates])

  const loadExploreData = useCallback(async () => {
    if (activeExploreRepoIds.length === 0) {
      setExploreCards([])
      setExploreCategories([])
      setExploreTotal(0)
      return
    }

    setExploreLoading(true)
    try {
      const [categories, page] = await Promise.all([
        listExploreCategories({
          enabledRepoIds: activeExploreRepoIds,
          query: exploreQuery,
          language,
        }),
        listExploreApps({
          enabledRepoIds: activeExploreRepoIds,
          query: exploreQuery,
          category: exploreCategory === 'all' ? undefined : exploreCategory,
          sort: exploreSort,
          page: explorePage,
          pageSize: explorePageSize,
          language,
        }),
      ])

      setExploreCategories(categories)
      setExploreCards(page.items)
      setExploreTotal(page.total)
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.exploreLoadFailed'),
      })
    } finally {
      setExploreLoading(false)
    }
  }, [
    activeExploreRepoIds,
    exploreCategory,
    explorePage,
    explorePageSize,
    exploreQuery,
    exploreSort,
    language,
    showToast,
    t,
  ])

  const setPackageDetailRoute = useCallback((repoId: string, packageName: string, targetTab: StoreTab = 'search') => {
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('storeTab', targetTab)
    nextParams.set('storeRepo', repoId)
    nextParams.set('storePackage', packageName)
    setSearchParams(nextParams, { replace: false })
  }, [searchParams, setSearchParams])

  const clearPackageDetailRoute = useCallback(() => {
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('storeTab')
    nextParams.delete('storeRepo')
    nextParams.delete('storePackage')
    setSearchParams(nextParams, { replace: false })
  }, [searchParams, setSearchParams])

  const openStorePackagePage = useCallback((
    card: Pick<StoreExploreCard, 'repoId' | 'packageName' | 'name'>,
    targetTab: StoreTab = 'search',
  ) => {
    setActiveTab(targetTab)
    setPackageDetailRoute(card.repoId, card.packageName, targetTab)
    recordStoreRecentActivity({
      kind: 'opened',
      title: card.name,
      subtitle: card.packageName,
      packageName: card.packageName,
      repoId: card.repoId,
    })
  }, [setPackageDetailRoute])

  const openPackageDetailFromHit = useCallback((hit: StoreSearchHit) => {
    if (hit.target === 'local') {
      setActiveTab('home')
      setShowLocalInstallPanel(true)
      window.setTimeout(() => {
        localPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 32)
      return
    }

    if (hit.packageName && hit.repoId) {
      openStorePackagePage({
        repoId: hit.repoId,
        packageName: hit.packageName,
        name: hit.title,
      }, 'search')
      return
    }

    setActiveTab(hit.kind === 'update' ? 'updates' : 'library')
  }, [openStorePackagePage])

  useEffect(() => {
    const requestedTab = searchParams.get('storeTab')
    if (requestedTab && STORE_TABS.includes(requestedTab as StoreTab) && activeTab !== requestedTab) {
      setActiveTab(requestedTab as StoreTab)
    }
  }, [activeTab, searchParams])

  useEffect(() => {
    if (activeTab !== 'search') return
    loadExploreData().catch(() => undefined)
  }, [activeTab, loadExploreData, query])

  useEffect(() => {
    if (activeTab !== 'search') return
    if (!packageRouteRepoId || !packageRoutePackageName) return

    if (
      selectedPackage &&
      selectedPackage.repoId === packageRouteRepoId &&
      selectedPackage.packageName === packageRoutePackageName
    ) {
      return
    }

    setDetailLoading(true)
    fetchStorePackageDetail(packageRoutePackageName, packageRouteRepoId, language)
      .then((detail) => {
        setSelectedPackage(detail)
        setExploreScreenshotIndex(0)
        recordStoreRecentActivity({
          kind: 'opened',
          title: detail.name,
          subtitle: detail.packageName,
          packageName: detail.packageName,
          repoId: detail.repoId,
        })
      })
      .catch((error) => {
        showToast({
          type: 'error',
          title: t('common.error'),
          message: error instanceof Error ? error.message : t('store.packageLoadFailed'),
        })
      })
      .finally(() => {
        setDetailLoading(false)
      })
  }, [activeTab, language, packageRoutePackageName, packageRouteRepoId, selectedPackage, showToast, t])

  useEffect(() => {
    if (activeTab !== 'search') return
    if (!query.trim()) {
      setSearchResults([])
      return
    }

    const handle = window.setTimeout(() => {
      runSearch().catch(() => undefined)
    }, 180)

    return () => window.clearTimeout(handle)
  }, [activeTab, query, runSearch])

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTypingContext = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable
      if (isTypingContext || event.key !== '/') return
      event.preventDefault()
      setActiveTab('search')
      window.setTimeout(() => {
        searchInputRef.current?.focus()
      }, 0)
    }

    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [])

  const updateBindingFromDevice = useCallback(async (
    packageName: string,
    partial: Pick<StorePackageBinding, 'repoId' | 'appName' | 'iconUrl' | 'packageUrl' | 'suggestedDownloadUrl' | 'signerSha256'>
  ) => {
    let versionCode: number | null = null
    let versionName: string | null = null

    try {
      const versionInfo = await getPackageVersionInfo(packageName)
      versionCode = versionInfo.versionCode ?? null
      versionName = versionInfo.versionName ?? null
    } catch {
      // Best effort only.
    }

    const nextBinding: StorePackageBinding = {
      packageName,
      repoId: partial.repoId,
      appName: partial.appName,
      iconUrl: partial.iconUrl,
      packageUrl: partial.packageUrl,
      suggestedDownloadUrl: partial.suggestedDownloadUrl,
      signerSha256: partial.signerSha256,
      updatePolicy: bindingMap[packageName]?.updatePolicy || 'manual',
      trustState: 'trusted',
      installedVersionCode: versionCode,
      installedVersionName: versionName,
      lastSeenVersionCode: versionCode,
      lastSeenVersionName: versionName,
      installedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      source: 'store',
    }

    upsertBinding(nextBinding)
    if (user && deviceFingerprint) {
      await persistServerStoreBinding(user.id, deviceFingerprint, nextBinding).catch((error) => {
        console.warn('Failed to persist store binding', error)
      })
    }
  }, [bindingMap, deviceFingerprint, upsertBinding, user])

  const migrateInstalledPackage = useCallback(async (
    packageName: string,
    packageLabel: string,
    targetSignerSha256?: string
  ): Promise<Exclude<StoreMigrationChoice, 'cancel'>> => {
    const choice = await requestMigrationChoice(packageName, packageLabel)
    if (choice === 'cancel') {
      throw new Error(t('store.migrationCancelled'))
    }

    const keepData = choice === 'keep_data'
    const uninstallResult = await uninstallPackage(packageName, { keepData })
    if (uninstallResult.exitCode !== 0 && !uninstallResult.stdout.includes('Success')) {
      throw new Error(uninstallResult.stderr || uninstallResult.stdout || t('store.migrationUninstallFailed'))
    }

    const existingBinding = bindingMap[packageName]
    if (existingBinding) {
      const nextBinding: StorePackageBinding = {
        ...existingBinding,
        trustState: 'migration_required',
        signerSha256: targetSignerSha256 || existingBinding.signerSha256,
        lastUpdatedAt: new Date().toISOString(),
      }
      upsertBinding(nextBinding)
      if (user && deviceFingerprint) {
        await persistServerStoreBinding(user.id, deviceFingerprint, nextBinding).catch(() => undefined)
      }
    }

    if (keepData) {
      showToast({
        type: 'warning',
        title: t('common.warning'),
        message: t('store.migrationKeepDataNotice'),
      })
    }

    return choice
  }, [bindingMap, deviceFingerprint, requestMigrationChoice, showToast, t, upsertBinding, user])

  const installSelectedPackage = useCallback(async (detail: StorePackageDetail, targetVersionCode?: number) => {
    if (!detail.suggestedDownloadUrl) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: t('store.noInstallArtifact'),
      })
      return
    }

    if (!canInstall) {
      showToast({
        type: 'warning',
        title: t('common.warning'),
        message: isDemoMode ? t('store.demoInstallDisabled') : t('store.connectDevice'),
      })
      return
    }

    setRemoteInstallKey(detail.packageName)
    setRemoteInstallMessage('')

    let migrationStarted = false

    try {
      const installProfile = await getDeviceInstallProfile()
      const existingBinding = bindingMap[detail.packageName]
      let installPlan = await resolvePackageInstallArtifacts(detail, installProfile, {
        preferredSigner: existingBinding?.signerSha256,
        targetVersionCode,
      })
      let requiresMigration = false

      if (!installPlan && existingBinding?.signerSha256 && installedMap.has(detail.packageName)) {
        installPlan = await resolvePackageInstallArtifacts(detail, installProfile, { targetVersionCode })
        requiresMigration = Boolean(
          installPlan &&
          installPlan.release.signerSha256 &&
          installPlan.release.signerSha256 !== existingBinding.signerSha256
        )
      }

      if (!installPlan) {
        throw new Error(t('store.noCompatibleArtifact'))
      }

      if (
        !requiresMigration &&
        existingBinding?.signerSha256 &&
        installPlan.release.signerSha256 &&
        installPlan.release.signerSha256 !== existingBinding.signerSha256 &&
        installedMap.has(detail.packageName)
      ) {
        requiresMigration = true
      }

      if (requiresMigration) {
        await migrateInstalledPackage(detail.packageName, detail.name, installPlan.release.signerSha256)
        migrationStarted = true
      }

      const installedVersionCode = installedMap.get(detail.packageName)?.versionCode
      const allowDowngrade = (
        typeof installedVersionCode === 'number' &&
        installPlan.release.versionCode < installedVersionCode
      )

      const installArtifacts = installPlan.artifacts.map((artifact) => ({
        fileName: getFileNameFromUrl(artifact.downloadUrl, artifact.fileName),
        downloadUrl: artifact.downloadUrl,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      }))

      const runRemoteInstall = async () => {
        await installRemoteApkArtifacts(installArtifacts, (progress) => {
          setRemoteInstallMessage(toInstallMessage(progress))
        }, {
          allowDowngrade,
        })
      }

      try {
        await runRemoteInstall()
      } catch (error) {
        if (
          !migrationStarted &&
          installedMap.has(detail.packageName) &&
          isSignerMismatchInstallError(error)
        ) {
          await migrateInstalledPackage(detail.packageName, detail.name, installPlan.release.signerSha256)
          migrationStarted = true
          await runRemoteInstall()
        } else {
          throw error
        }
      }

      await updateBindingFromDevice(detail.packageName, {
        repoId: detail.repoId,
        appName: detail.name,
        iconUrl: detail.iconUrl,
        packageUrl: detail.packageUrl,
        suggestedDownloadUrl: installPlan.artifacts[0]?.downloadUrl || detail.suggestedDownloadUrl,
        signerSha256: installPlan.release.signerSha256,
      })

      await syncPackages()
      await refreshUpdates()
      setUpdates((current) => current.filter((item) => item.packageName !== detail.packageName))
      recordStoreRecentActivity({
        kind: 'installed',
        title: detail.name,
        subtitle: detail.packageName,
        packageName: detail.packageName,
        repoId: detail.repoId,
      })

      showToast({
        type: 'success',
        title: t('common.success'),
        message: t('store.installSuccess', { name: detail.name }),
      })
    } catch (error) {
      if (migrationStarted) {
        await syncPackages().catch(() => undefined)
        await refreshUpdates().catch(() => undefined)
      }
      recordStoreRecentActivity({
        kind: 'failed',
        title: detail.name,
        subtitle: detail.packageName,
        packageName: detail.packageName,
        repoId: detail.repoId,
      })
      showToast({
        type: 'error',
        title: t('common.error'),
        message: error instanceof Error ? error.message : t('store.installFailed'),
      })
    } finally {
      setRemoteInstallKey(null)
      setRemoteInstallMessage('')
    }
  }, [bindingMap, canInstall, installedMap, isDemoMode, migrateInstalledPackage, refreshUpdates, showToast, syncPackages, t, updateBindingFromDevice])

  const installFromExploreCard = useCallback(async (card: StoreExploreCard) => {
    const current = (
      selectedPackage &&
      selectedPackage.packageName === card.packageName &&
      selectedPackage.repoId === card.repoId
    )
      ? selectedPackage
      : await fetchStorePackageDetail(card.packageName, card.repoId, language)

    await installSelectedPackage(current)
  }, [installSelectedPackage, language, selectedPackage])

  const installUpdateCandidate = useCallback(async (
    candidate: StoreUpdateCandidate,
    options?: {
      silent?: boolean
      skipRefresh?: boolean
      onProgress?: (progress: InstallProgress) => void
    }
  ): Promise<boolean> => {
    if (!candidate.latestDownloadUrl) {
      if (!options?.silent) {
        showToast({
          type: 'error',
          title: t('common.error'),
          message: t('store.noInstallArtifact'),
        })
      }
      return false
    }

    const binding = bindings.find((item) => item.packageName === candidate.packageName)
    setRemoteInstallKey(candidate.packageName)
    setRemoteInstallMessage('')

    let migrationStarted = false

    try {
      const detail = await fetchStorePackageDetail(candidate.packageName, candidate.repoId, language)
      const installProfile = await getDeviceInstallProfile()
      const installPlan = await resolvePackageInstallArtifacts(detail, installProfile, {
        preferredSigner: candidate.trustState === 'migration_required' ? undefined : binding?.signerSha256,
        targetVersionCode: candidate.latestVersionCode,
      })
      if (!installPlan) {
        throw new Error(t('store.noCompatibleArtifact'))
      }

      if (candidate.trustState === 'migration_required') {
        await migrateInstalledPackage(candidate.packageName, candidate.appName, installPlan.release.signerSha256)
        migrationStarted = true
      }

      const installArtifacts = installPlan.artifacts.map((artifact) => ({
        fileName: getFileNameFromUrl(artifact.downloadUrl, artifact.fileName),
        downloadUrl: artifact.downloadUrl,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      }))

      const runRemoteInstall = async () => {
        await installRemoteApkArtifacts(installArtifacts, (progress) => {
          setRemoteInstallMessage(toInstallMessage(progress))
          options?.onProgress?.(progress)
        })
      }

      try {
        await runRemoteInstall()
      } catch (error) {
        if (
          !migrationStarted &&
          installedMap.has(candidate.packageName) &&
          isSignerMismatchInstallError(error)
        ) {
          await migrateInstalledPackage(candidate.packageName, candidate.appName, installPlan.release.signerSha256)
          migrationStarted = true
          await runRemoteInstall()
        } else {
          throw error
        }
      }

      await updateBindingFromDevice(candidate.packageName, {
        repoId: candidate.repoId,
        appName: candidate.appName,
        iconUrl: candidate.iconUrl,
        packageUrl: candidate.packageUrl,
        suggestedDownloadUrl: installPlan.artifacts[0]?.downloadUrl || candidate.latestDownloadUrl,
        signerSha256: installPlan.release.signerSha256,
      })

      if (binding) {
        const nextBinding: StorePackageBinding = {
          ...binding,
          lastUpdatedAt: new Date().toISOString(),
          suggestedDownloadUrl: candidate.latestDownloadUrl,
        }
        upsertBinding(nextBinding)
        if (user && deviceFingerprint) {
          await persistServerStoreBinding(user.id, deviceFingerprint, nextBinding).catch(() => undefined)
        }
      }

      if (!options?.skipRefresh) {
        await syncPackages()
        await refreshUpdates()
      }
      setUpdates((current) => current.filter((item) => item.packageName !== candidate.packageName))
      recordStoreRecentActivity({
        kind: 'updated',
        title: candidate.appName,
        subtitle: candidate.packageName,
        packageName: candidate.packageName,
        repoId: candidate.repoId,
      })

      if (!options?.silent) {
        showToast({
          type: 'success',
          title: t('common.success'),
          message: t('store.updateSuccess', { name: candidate.appName }),
        })
      }
      return true
    } catch (error) {
      if (migrationStarted) {
        await syncPackages().catch(() => undefined)
        await refreshUpdates().catch(() => undefined)
      }
      recordStoreRecentActivity({
        kind: 'failed',
        title: candidate.appName,
        subtitle: candidate.packageName,
        packageName: candidate.packageName,
        repoId: candidate.repoId,
      })
      if (!options?.silent) {
        showToast({
          type: 'error',
          title: t('common.error'),
          message: error instanceof Error ? error.message : t('store.installFailed'),
        })
      }
      return false
    } finally {
      setRemoteInstallKey(null)
      setRemoteInstallMessage('')
    }
  }, [bindings, deviceFingerprint, language, migrateInstalledPackage, refreshUpdates, showToast, syncPackages, t, updateBindingFromDevice, upsertBinding, user])

  const updateAllCandidates = useCallback(async () => {
    if (!canInstall || bulkUpdating || updates.length === 0) return

    setBulkUpdating(true)
    const totalItems = updates.length
    const totalBytes = totalUpdateDownloadBytes > 0 ? totalUpdateDownloadBytes : undefined
    setBulkUpdateProgress({
      totalItems,
      completedItems: 0,
      currentAppName: updates[0]?.appName,
      message: `${t('common.update')} ${t('common.all')}`,
      overallPercent: 0,
      currentPercent: 0,
      downloadedBytes: 0,
      totalBytes,
      speedBytesPerSecond: undefined,
    })

    let successCount = 0
    let errorCount = 0
    let completedDownloadBytes = 0

    try {
      for (let index = 0; index < updates.length; index += 1) {
        const candidate = updates[index]
        let candidateDownloadedBytes = 0
        let lastSpeedSampleAt = 0
        let lastSpeedSampleBytes = completedDownloadBytes

        const ok = await installUpdateCandidate(candidate, {
          silent: true,
          skipRefresh: true,
          onProgress: (progress) => {
            const currentPercent = progress.percent ?? 0
            const currentDownloadedBytes = progress.phase === 'downloading'
              ? completedDownloadBytes + (progress.aggregateLoadedBytes ?? progress.loadedBytes ?? 0)
              : completedDownloadBytes + (candidate.downloadSizeBytes || candidateDownloadedBytes)

            candidateDownloadedBytes = Math.max(
              candidateDownloadedBytes,
              currentDownloadedBytes - completedDownloadBytes,
            )

            let speedBytesPerSecond: number | undefined
            if (progress.phase === 'downloading') {
              const now = performance.now()
              if (lastSpeedSampleAt > 0 && currentDownloadedBytes >= lastSpeedSampleBytes) {
                const elapsedMs = now - lastSpeedSampleAt
                if (elapsedMs > 0) {
                  speedBytesPerSecond = ((currentDownloadedBytes - lastSpeedSampleBytes) * 1000) / elapsedMs
                }
              }
              lastSpeedSampleAt = now
              lastSpeedSampleBytes = currentDownloadedBytes
            }

            setBulkUpdateProgress((current) => ({
              totalItems,
              completedItems: index,
              currentAppName: candidate.appName,
              message: progress.message,
              overallPercent: Math.min(100, Math.round(((index + (currentPercent / 100)) / totalItems) * 100)),
              currentPercent,
              downloadedBytes: currentDownloadedBytes,
              totalBytes,
              speedBytesPerSecond: progress.phase === 'downloading'
                ? (speedBytesPerSecond ?? current?.speedBytesPerSecond)
                : undefined,
            }))
          },
        })

        completedDownloadBytes += candidate.downloadSizeBytes || candidateDownloadedBytes
        if (ok) {
          successCount += 1
        } else {
          errorCount += 1
        }

        setBulkUpdateProgress({
          totalItems,
          completedItems: index + 1,
          currentAppName: candidate.appName,
          message: ok
            ? t('store.updateSuccess', { name: candidate.appName })
            : t('store.installFailed'),
          overallPercent: Math.min(100, Math.round(((index + 1) / totalItems) * 100)),
          currentPercent: 100,
          downloadedBytes: completedDownloadBytes,
          totalBytes,
          speedBytesPerSecond: undefined,
        })
      }
    } finally {
      await syncPackages()
      await refreshUpdates()
      setBulkUpdating(false)
      setBulkUpdateProgress(null)
    }

    showToast({
      type: errorCount > 0 ? 'warning' : 'success',
      title: errorCount > 0 ? t('common.warning') : t('common.success'),
      message: errorCount > 0
        ? t('store.installPartial', { success: successCount, errors: errorCount })
        : t('store.installSuccessCount', { count: successCount }),
    })
  }, [bulkUpdating, canInstall, installUpdateCandidate, refreshUpdates, showToast, syncPackages, t, totalUpdateDownloadBytes, updates])

  useEffect(() => {
    if (!canInstall || bulkUpdating || autoUpdatingRef.current || updates.length === 0) return

    const eligible = updates.filter((candidate) => {
      const binding = bindingMap[candidate.packageName]
      const repo = repositories.find((item) => item.id === candidate.repoId)
      return (
        binding?.updatePolicy === 'auto_trusted' &&
        binding.trustState !== 'signer_conflict' &&
        binding.trustState !== 'migration_required' &&
        (repo?.trustState === 'trusted_builtin' || repo?.trustState === 'trusted_user_pinned')
      )
    })

    if (eligible.length === 0) return

    autoUpdatingRef.current = true
    ;(async () => {
      for (const candidate of eligible) {
        await installUpdateCandidate(candidate).catch(() => undefined)
      }
      autoUpdatingRef.current = false
    })()
  }, [bindingMap, bulkUpdating, canInstall, installUpdateCandidate, repositories, updates])

  const appendLocalFiles = useCallback((files: FileList | File[]) => {
    const validFiles = Array.from(files).filter(isApkFile)
    if (validFiles.length === 0) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: t('store.localOnlyApk'),
      })
      return
    }

    setLocalQueue((current) => [
      ...current,
      ...validFiles.map((file) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${crypto.randomUUID()}`,
        file,
        status: 'queued' as QueueStatus,
        progress: 0,
      })),
    ])
  }, [showToast, t])

  const handleLocalFileSelection = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      appendLocalFiles(event.target.files)
      event.target.value = ''
    }
  }, [appendLocalFiles])

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setDragActive(true)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDragActive(false)

    if (event.dataTransfer.files.length > 0) {
      appendLocalFiles(event.dataTransfer.files)
    }
  }, [appendLocalFiles])

  const removeLocalItem = useCallback((id: string) => {
    setLocalQueue((current) => current.filter((item) => item.id !== id))
  }, [])

  const clearLocalQueue = useCallback(() => {
    setLocalQueue((current) => current.filter((item) => item.status === 'installing'))
  }, [])

  const installLocalQueueItems = useCallback(async () => {
    const queuedItems = localQueue.filter((item) => item.status === 'queued' || item.status === 'error')
    if (queuedItems.length === 0) return

    if (!canInstall) {
      showToast({
        type: 'warning',
        title: t('common.warning'),
        message: isDemoMode ? t('store.demoInstallDisabled') : t('store.connectDevice'),
      })
      return
    }

    const queuedIds = new Set(queuedItems.map((item) => item.id))

    setLocalQueue((current) => current.map((item) => (
      queuedIds.has(item.id)
        ? { ...item, status: 'installing', progress: 0, message: t('store.pendingInstall') }
        : item
    )))

    try {
      if (localMode === 'together' || queuedItems.length === 1) {
        try {
          await installLocalApkFiles(
            queuedItems.map((item) => item.file),
            'together',
            (progress) => {
              setLocalQueue((current) => current.map((item) => (
                queuedIds.has(item.id)
                  ? {
                    ...item,
                    status: 'installing',
                    progress: progress.percent ?? item.progress,
                    message: toInstallMessage(progress),
                  }
                  : item
              )))
            }
          )

          setLocalQueue((current) => current.map((item) => (
            queuedIds.has(item.id)
              ? { ...item, status: 'success', progress: 100, message: t('store.localInstallComplete') }
              : item
          )))

          showToast({
            type: 'success',
            title: t('common.success'),
            message: t('store.installSuccessCount', { count: queuedItems.length }),
          })
          queuedItems.slice(0, 4).forEach((item) => {
            recordStoreRecentActivity({
              kind: 'local',
              title: item.file.name,
              subtitle: t('store.localInstall'),
            })
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : t('store.installFailed')
          setLocalQueue((current) => current.map((item) => (
            queuedIds.has(item.id)
              ? { ...item, status: 'error', progress: 0, message }
              : item
          )))
          showToast({ type: 'error', title: t('common.error'), message })
        }
      } else {
        const orderedIds = queuedItems.map((item) => item.id)
        const results = await installLocalApkFiles(
          queuedItems.map((item) => item.file),
          'separate',
          (progress) => {
            if (!progress.currentItem) return
            const targetId = orderedIds[progress.currentItem - 1]
            if (!targetId) return

            setLocalQueue((current) => current.map((item) => (
              item.id === targetId
                ? {
                  ...item,
                  status: 'installing',
                  progress: progress.percent ?? item.progress,
                  message: toInstallMessage(progress),
                }
                : item
            )))
          }
        )

        setLocalQueue((current) => current.map((item) => {
          const resultIndex = orderedIds.indexOf(item.id)
          if (resultIndex === -1) return item
          const result = results[resultIndex]
          return {
            ...item,
            status: result?.success ? 'success' : 'error',
            progress: result?.success ? 100 : item.progress,
            message: result?.message,
          }
        }))

        const successCount = results.filter((result) => result.success).length
        const errorCount = results.length - successCount

        showToast({
          type: errorCount > 0 ? 'warning' : 'success',
          title: errorCount > 0 ? t('common.warning') : t('common.success'),
          message: errorCount > 0
            ? t('store.installPartial', { success: successCount, errors: errorCount })
            : t('store.installSuccessCount', { count: successCount }),
        })
        queuedItems
          .filter((_, index) => results[index]?.success)
          .slice(0, 4)
          .forEach((item) => {
            recordStoreRecentActivity({
              kind: 'local',
              title: item.file.name,
              subtitle: t('store.localInstall'),
            })
          })
      }
    } finally {
      await syncPackages()
      await refreshUpdates()
    }
  }, [canInstall, isDemoMode, localMode, localQueue, refreshUpdates, showToast, syncPackages, t])

  const selectedPackageBinding = selectedPackage ? bindingMap[selectedPackage.packageName] : undefined
  const selectedPackageRepository = selectedPackage
    ? repositories.find((repo) => repo.id === selectedPackage.repoId)
    : undefined
  const selectedInstalledVersionCode = selectedPackage ? installedMap.get(selectedPackage.packageName)?.versionCode : undefined
  const selectedPackageLinks = selectedPackage
    ? [
        selectedPackage.websiteUrl,
        selectedPackage.sourceUrl,
        selectedPackage.issueTrackerUrl,
        selectedPackage.changelogUrl,
        selectedPackage.reproducibilityUrl,
      ].filter((value): value is string => Boolean(value))
    : []
  const selectedPackageSummaryText = selectedPackage
    ? extractStorePlainText(selectedPackage.summary || selectedPackage.packageName)
    : ''
  const selectedPackageDescriptionHtml = useMemo(
    () => selectedPackage?.description ? sanitizeStoreHtml(selectedPackage.description) : '',
    [selectedPackage?.description]
  )
  const selectedPackageWhatsNewHtml = useMemo(
    () => selectedPackage?.whatsNew ? sanitizeStoreHtml(selectedPackage.whatsNew) : '',
    [selectedPackage?.whatsNew]
  )
  const selectedScreenshots = selectedPackage?.screenshots || []
  const selectedScreenshotCount = selectedScreenshots.length
  const currentScreenshot = selectedScreenshots[exploreScreenshotIndex]
  const effectivePreviewImage = currentScreenshot?.url || selectedPackage?.featureGraphic?.url

  const selectedExploreAction = useMemo<'install' | 'update' | 'installed' | 'migrate'>(() => {
    if (!selectedPackage) return 'install'
    const installed = installedMap.get(selectedPackage.packageName)
    if (!installed || typeof installed.versionCode !== 'number') {
      return 'install'
    }
    if (selectedPackageBinding?.trustState === 'migration_required') {
      return 'migrate'
    }
    if (
      typeof selectedPackage.suggestedVersionCode === 'number' &&
      selectedPackage.suggestedVersionCode > installed.versionCode
    ) {
      return 'update'
    }
    return 'installed'
  }, [installedMap, selectedPackage, selectedPackageBinding])

  const navigateExploreScreenshot = useCallback((direction: 'prev' | 'next') => {
    if (selectedScreenshotCount <= 1) return
    setExploreScreenshotDirection(direction === 'prev' ? -1 : 1)
    setExploreScreenshotIndex((current) => (
      direction === 'prev'
        ? (current - 1 + selectedScreenshotCount) % selectedScreenshotCount
        : (current + 1) % selectedScreenshotCount
    ))
  }, [selectedScreenshotCount])

  const selectExploreScreenshot = useCallback((nextIndex: number) => {
    if (nextIndex === exploreScreenshotIndex) return
    setExploreScreenshotDirection(nextIndex > exploreScreenshotIndex ? 1 : -1)
    setExploreScreenshotIndex(nextIndex)
  }, [exploreScreenshotIndex])

  const handleExploreCarouselKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      navigateExploreScreenshot('prev')
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      navigateExploreScreenshot('next')
    }
  }, [navigateExploreScreenshot])

  const handleExploreCarouselTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    exploreTouchStartXRef.current = event.touches[0]?.clientX ?? null
  }, [])

  const handleExploreCarouselTouchEnd = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const start = exploreTouchStartXRef.current
    const end = event.changedTouches[0]?.clientX
    exploreTouchStartXRef.current = null
    if (selectedScreenshotCount <= 1 || start === null || typeof end !== 'number') return

    const delta = end - start
    if (Math.abs(delta) < 40) return
    navigateExploreScreenshot(delta > 0 ? 'prev' : 'next')
  }, [navigateExploreScreenshot, selectedScreenshotCount])

  const getExploreCardAction = useCallback((card: StoreExploreCard): 'install' | 'update' | 'installed' | 'migrate' => {
    const installed = installedMap.get(card.packageName)
    if (!installed || typeof installed.versionCode !== 'number') {
      return 'install'
    }
    if (bindingMap[card.packageName]?.trustState === 'migration_required') {
      return 'migrate'
    }
    if (typeof card.latestVersionCode === 'number' && card.latestVersionCode > installed.versionCode) {
      return 'update'
    }
    return 'installed'
  }, [bindingMap, installedMap])

  const trustAlerts = useMemo<StoreTrustAlert[]>(() => {
    const alerts: StoreTrustAlert[] = []

    repositories.forEach((repo) => {
      if (repo.trustState === 'quarantined' || repo.userTrustState === 'quarantined') {
        alerts.push({
          id: `repo-quarantined-${repo.id}`,
          severity: 'error',
          title: t('store.alertRepoQuarantinedTitle', { name: repo.name }),
          description: t('store.alertRepoQuarantinedDesc'),
          targetTab: 'sources',
          repoId: repo.id,
        })
      }

      if (repo.userTrustState === 'pending') {
        alerts.push({
          id: `repo-pending-${repo.id}`,
          severity: 'warning',
          title: t('store.alertRepoPendingApprovalTitle', { name: repo.name }),
          description: t('store.alertRepoPendingApprovalDesc'),
          targetTab: 'sources',
          repoId: repo.id,
        })
      }

      if (repo.verificationState === 'integrity_mismatch') {
        alerts.push({
          id: `repo-integrity-${repo.id}`,
          severity: 'error',
          title: t('store.alertRepoIntegrityTitle', { name: repo.name }),
          description: repo.verificationDetails || t('store.alertRepoIntegrityDesc'),
          targetTab: 'sources',
          repoId: repo.id,
        })
      } else if (repo.verificationState === 'verification_failed') {
        alerts.push({
          id: `repo-verification-failed-${repo.id}`,
          severity: 'warning',
          title: t('store.alertRepoVerificationFailedTitle', { name: repo.name }),
          description: repo.verificationDetails || t('store.alertRepoVerificationFailedDesc'),
          targetTab: 'sources',
          repoId: repo.id,
        })
      } else if ((repo.verificationState || 'pending') === 'pending') {
        alerts.push({
          id: `repo-unverified-${repo.id}`,
          severity: 'info',
          title: t('store.alertRepoPendingVerificationTitle', { name: repo.name }),
          description: t('store.alertRepoPendingVerificationDesc'),
          targetTab: 'sources',
          repoId: repo.id,
        })
      }

      if (repo.retryCount && repo.retryCount > 0) {
        alerts.push({
          id: `repo-retry-${repo.id}`,
          severity: 'warning',
          title: t('store.alertRepoRetryTitle', { name: repo.name }),
          description: t('store.alertRepoRetryDesc', { count: repo.retryCount }),
          targetTab: 'sources',
          repoId: repo.id,
        })
      }

      if (isRepositoryMetadataStale(repo)) {
        alerts.push({
          id: `repo-stale-${repo.id}`,
          severity: 'warning',
          title: t('store.alertRepoStaleTitle', { name: repo.name }),
          description: t('store.alertRepoStaleDesc'),
          targetTab: 'sources',
          repoId: repo.id,
        })
      }
    })

    updates.forEach((candidate) => {
      if (candidate.trustState !== 'migration_required') return
      alerts.push({
        id: `migration-${candidate.packageName}`,
        severity: 'warning',
        title: t('store.alertMigrationTitle', { name: candidate.appName }),
        description: candidate.trustMessage || t('store.alertMigrationDesc'),
        targetTab: 'updates',
      })
    })

    return alerts
  }, [repositories, t, updates])

  const searchResultSections = useMemo(() => ([
    { kind: 'update' as const, title: t('store.searchSectionUpdates'), items: searchResults.filter((item) => item.kind === 'update') },
    { kind: 'installed' as const, title: t('store.searchSectionInstalled'), items: searchResults.filter((item) => item.kind === 'installed') },
    { kind: 'catalog' as const, title: t('store.searchSectionCatalog'), items: searchResults.filter((item) => item.kind === 'catalog') },
    { kind: 'recent' as const, title: t('store.searchSectionRecent'), items: searchResults.filter((item) => item.kind === 'recent') },
  ]).filter((section) => section.items.length > 0), [searchResults, t])

  useEffect(() => {
    if (activeTab !== 'home') return

    let cancelled = false
    setHomeLoading(true)
    setHomeSuggestionsLoading(true)

    const shellModel = buildStoreHomeShell({
      updates,
      hasConnectedDevice: isConnected && !isDemoMode,
      attentionItems: trustAlerts.map((item) => ({
        id: item.id,
        severity: item.severity,
        title: item.title,
        description: item.description,
        repoId: item.repoId,
      })),
    })
    setHomeModel((current) => ({
      ...shellModel,
      suggestions: current?.suggestions || [],
    }))
    setHomeLoading(false)

    ;(async () => {
      try {
        const nextHomeModel = await buildStoreHomeModel({
          enabledRepoIds: activeExploreRepoIds,
          language,
          installedPackages: packages,
          bindings,
          updates,
          hasConnectedDevice: isConnected && !isDemoMode,
          attentionItems: trustAlerts.map((item) => ({
            id: item.id,
            severity: item.severity,
            title: item.title,
            description: item.description,
            repoId: item.repoId,
          })),
        })

        if (!cancelled) {
          setHomeModel(nextHomeModel)
        }
      } catch (error) {
        if (!cancelled) {
          setHomeModel(null)
          showToast({
            type: 'error',
            title: t('common.error'),
            message: error instanceof Error ? error.message : t('store.homeLoadFailed'),
          })
        }
      } finally {
        if (!cancelled) {
          setHomeSuggestionsLoading(false)
          setHomeLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeExploreRepoIds, activeTab, bindings, isConnected, isDemoMode, language, packages, showToast, t, trustAlerts, updates])

  return (
    <div className="terminal-spacer p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"
        >
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-surface-900 dark:text-white">{t('store.title')}</h1>
            <p className="mt-2 max-w-3xl text-sm text-surface-500">{t('store.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {currentRepository?.name || 'F-Droid'} · {currentRepository?.trustLabel || t('store.trustBuiltin')}
            </div>
            {currentRepository?.verificationState && currentRepository.verificationState !== 'verified' && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                {t(`store.verificationStateLabels.${currentRepository.verificationState}`)}
              </div>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                refreshRepositories().catch(() => undefined)
                syncPackages().catch(() => undefined)
                refreshUpdates().catch(() => undefined)
              }}
              loading={repoLoading || packagesLoading || updatesLoading}
              icon={<RefreshCw className="h-4 w-4" />}
            >
              {t('common.refresh')}
            </Button>
          </div>
        </motion.div>

        <div className="flex flex-wrap gap-2">
          {STORE_TABS.map((tab) => {
            const isActive = activeTab === tab
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={[
                  'rounded-xl px-4 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent-500/10 text-accent-600 dark:text-accent-400'
                    : 'bg-surface-100 text-surface-600 hover:bg-surface-200 dark:bg-white/5 dark:text-surface-400 dark:hover:bg-white/10',
                ].join(' ')}
              >
                {t(`store.tabs.${tab}`)}
              </button>
            )
          })}
        </div>

        {activeTab === 'home' && (
          <div className="space-y-6">
            <Card variant="glass" className="p-5">
              <CardHeader title={t('store.homeTitle')} subtitle={t('store.homeSubtitle')} />

              {homeLoading && !homeModel ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div
                      key={`home-skeleton-${index}`}
                      className="animate-pulse rounded-3xl border border-surface-200 bg-surface-50 p-5 dark:border-white/10 dark:bg-white/[0.03]"
                    >
                      <div className="h-5 w-1/3 rounded bg-surface-200 dark:bg-white/10" />
                      <div className="mt-3 h-3 w-4/5 rounded bg-surface-200 dark:bg-white/10" />
                      <div className="mt-6 h-24 rounded-2xl bg-surface-200 dark:bg-white/10" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                    <div className="rounded-3xl border border-surface-200 bg-surface-50 p-5 dark:border-white/10 dark:bg-white/[0.03]">
                      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-surface-500">{t('store.homeUpdatesTitle')}</p>
                          <h3 className="mt-2 text-2xl font-semibold text-surface-900 dark:text-white">
                            {homeModel?.updates.count || 0} {t('store.homeUpdatesAvailable')}
                          </h3>
                          <p className="mt-2 text-sm text-surface-500">
                            {isConnected
                              ? t('store.homeUpdatesDesc', { size: formatBytes(homeModel?.updates.totalDownloadSizeBytes) })
                              : t('store.homeConnectPrompt')}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="primary"
                            onClick={() => {
                              setActiveTab('updates')
                              updateAllCandidates().catch(() => undefined)
                            }}
                            disabled={!isConnected || updates.length === 0 || bulkUpdating}
                            loading={bulkUpdating}
                            icon={<RefreshCw className="h-4 w-4" />}
                          >
                            {t('store.updateAll')}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => setActiveTab('updates')}
                            icon={<ChevronRight className="h-4 w-4" />}
                          >
                            {t('store.openUpdates')}
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-3xl border border-surface-200 bg-surface-50 p-5 dark:border-white/10 dark:bg-white/[0.03]">
                      <p className="text-xs font-semibold uppercase tracking-wide text-surface-500">{t('store.homeQuickActionsTitle')}</p>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                        {homeModel?.quickActions.map((action) => (
                          <button
                            key={action.id}
                            type="button"
                            onClick={() => {
                              if (action.id === 'install-from-computer') {
                                setShowLocalInstallPanel(true)
                                window.setTimeout(() => {
                                  localPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                  fileInputRef.current?.click()
                                }, 32)
                                return
                              }
                              if (action.id === 'open-updates') {
                                setActiveTab('updates')
                                return
                              }
                              if (action.id === 'open-sources') {
                                setActiveTab('sources')
                                return
                              }
                              setActiveTab('search')
                              window.setTimeout(() => searchInputRef.current?.focus(), 0)
                            }}
                            className="rounded-2xl border border-surface-200 bg-white px-4 py-4 text-left transition-colors hover:border-accent-500/30 hover:bg-surface-50 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/5"
                          >
                            <p className="text-sm font-semibold text-surface-900 dark:text-white">{t(`store.quickActions.${action.id}.label`)}</p>
                            <p className="mt-1 text-xs text-surface-500">{t(`store.quickActions.${action.id}.description`)}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
                    <div className="space-y-6">
                      <Card variant="glass" className="p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                          <div>
                            <h3 className="text-lg font-semibold text-surface-900 dark:text-white">{t('store.homeSuggestionsTitle')}</h3>
                            <p className="mt-1 text-sm text-surface-500">{t('store.homeSuggestionsSubtitle')}</p>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setActiveTab('search')}
                            icon={<Search className="h-4 w-4" />}
                          >
                            {t('store.homeBrowseCatalog')}
                          </Button>
                        </div>

                        {homeSuggestionsLoading && (!homeModel?.suggestions || homeModel.suggestions.length === 0) ? (
                          <div className="grid gap-4 sm:grid-cols-2">
                            {Array.from({ length: 4 }).map((_, index) => (
                              <div
                                key={`home-suggestion-skeleton-${index}`}
                                className="animate-pulse rounded-3xl border border-surface-200 bg-surface-50 p-3 dark:border-white/10 dark:bg-white/[0.03]"
                              >
                                <div className="h-48 rounded-2xl bg-surface-200 dark:bg-white/10" />
                                <div className="mt-3 flex items-start gap-3">
                                  <div className="h-11 w-11 rounded-xl bg-surface-200 dark:bg-white/10" />
                                  <div className="flex-1 space-y-2">
                                    <div className="h-4 w-2/3 rounded bg-surface-200 dark:bg-white/10" />
                                    <div className="h-3 w-full rounded bg-surface-200 dark:bg-white/10" />
                                    <div className="h-3 w-4/5 rounded bg-surface-200 dark:bg-white/10" />
                                  </div>
                                </div>
                                <div className="mt-3 h-9 rounded-xl bg-surface-200 dark:bg-white/10" />
                              </div>
                            ))}
                          </div>
                        ) : homeModel?.suggestions && homeModel.suggestions.length > 0 ? (
                          <div className="grid gap-4 sm:grid-cols-2">
                            {homeModel.suggestions.map((card) => {
                              const action = getExploreCardAction(card)
                              const previewScreens = (card.screenshotsPreview && card.screenshotsPreview.length > 0)
                                ? card.screenshotsPreview
                                : (card.screenshot ? [card.screenshot] : [])
                              return (
                                <div
                                  key={`home-${card.repoId}:${card.packageName}`}
                                  className="flex h-full flex-col rounded-3xl border border-surface-200 bg-surface-50 p-3 dark:border-white/10 dark:bg-white/[0.03]"
                                >
                                  <button
                                    type="button"
                                    onClick={() => openStorePackagePage(card, 'search')}
                                    className="flex flex-1 flex-col text-left"
                                  >
                                    <div className="grid h-48 grid-cols-2 gap-1 overflow-hidden rounded-2xl bg-surface-200 p-1 dark:bg-white/10">
                                      {(previewScreens.length > 0 ? previewScreens.slice(0, 2) : []).map((screen, index) => (
                                        <div key={`${card.packageName}-home-preview-${index}`} className="overflow-hidden rounded-xl bg-surface-100 dark:bg-white/5">
                                          <img
                                            src={screen.url}
                                            alt={t('store.exploreScreenshotAlt', { name: `${card.name} ${index + 1}` })}
                                            className="h-full w-full object-contain"
                                            loading="lazy"
                                          />
                                        </div>
                                      ))}
                                      {previewScreens.length === 0 && (
                                        <div className="col-span-2 flex items-center justify-center rounded-xl bg-surface-100 dark:bg-white/5">
                                          <StoreIcon src={card.iconUrl} className="h-20 w-20 object-contain" fallbackClassName="h-20 w-20 flex items-center justify-center" />
                                        </div>
                                      )}
                                    </div>
                                    <div className="mt-3 flex items-start gap-3">
                                      <StoreIcon src={card.iconUrl} />
                                      <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-semibold text-surface-900 dark:text-white">{card.name}</p>
                                        <p className="mt-1 line-clamp-2 text-xs text-surface-500">
                                          {extractStorePlainText(card.summary || card.packageName)}
                                        </p>
                                      </div>
                                    </div>
                                  </button>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {card.reasons.map((reason) => (
                                      <span
                                        key={`${card.packageName}-${reason}`}
                                        className="rounded-full bg-accent-500/10 px-2 py-1 text-[11px] font-medium text-accent-600 dark:text-accent-400"
                                      >
                                        {t(`store.suggestionReasons.${reason}`)}
                                      </span>
                                    ))}
                                  </div>
                                  <div className="mt-3">
                                    <Button
                                      variant={action === 'installed' ? 'secondary' : action === 'migrate' ? 'danger' : 'primary'}
                                      size="sm"
                                      className="w-full"
                                      onClick={() => installFromExploreCard(card).catch(() => undefined)}
                                      disabled={action === 'installed'}
                                      loading={remoteInstallKey === card.packageName}
                                      icon={
                                        action === 'update'
                                          ? <RefreshCw className="h-4 w-4" />
                                          : action === 'migrate'
                                            ? <AlertTriangle className="h-4 w-4" />
                                            : <Download className="h-4 w-4" />
                                      }
                                    >
                                      {action === 'migrate'
                                        ? t('store.migrateAction')
                                        : action === 'update'
                                        ? t('common.update')
                                        : action === 'installed'
                                          ? t('store.exploreInstalled')
                                          : t('common.install')}
                                    </Button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <StoreEmptyState
                            icon={Package}
                            title={t('store.homeSuggestionsEmptyTitle')}
                            description={t('store.homeSuggestionsEmptyDesc')}
                          />
                        )}
                      </Card>

                      {showLocalInstallPanel && (
                        <div ref={localPanelRef} className="space-y-6">
                          <Card variant="glass" className="p-5">
                            <div className="mb-4 flex items-center justify-between gap-3">
                              <CardHeader title={t('store.localTitle')} subtitle={t('store.localSubtitle')} />
                              <Button variant="ghost" size="sm" onClick={() => setShowLocalInstallPanel(false)}>
                                {t('common.close')}
                              </Button>
                            </div>
                            <div className="rounded-2xl border border-surface-200 bg-surface-50 px-4 py-4 text-sm text-surface-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-surface-300">
                              {t('store.homeLocalFlowHint')}
                            </div>
                          </Card>
                        </div>
                      )}
                    </div>

                    <div className="space-y-6">
                      <Card variant="glass" className="p-5">
                        <h3 className="text-lg font-semibold text-surface-900 dark:text-white">{t('store.homeContinueTitle')}</h3>
                        <p className="mt-1 text-sm text-surface-500">{t('store.homeContinueSubtitle')}</p>
                        <div className="mt-4 space-y-3">
                          {homeModel?.continueItems && homeModel.continueItems.length > 0 ? (
                            homeModel.continueItems.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => {
                                  if (item.packageName && item.repoId) {
                                    openStorePackagePage({
                                      repoId: item.repoId,
                                      packageName: item.packageName,
                                      name: item.title,
                                    }, 'search')
                                    return
                                  }
                                  setShowLocalInstallPanel(true)
                                  window.setTimeout(() => localPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 32)
                                }}
                                className="w-full rounded-2xl border border-surface-200 bg-surface-50 px-4 py-3 text-left transition-colors hover:border-accent-500/30 hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/5"
                              >
                                <p className="text-sm font-semibold text-surface-900 dark:text-white">{item.title}</p>
                                <p className="mt-1 text-xs text-surface-500">{item.subtitle}</p>
                                <p className="mt-2 text-[11px] uppercase tracking-wide text-surface-400">{formatDate(item.timestamp)}</p>
                              </button>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-dashed border-surface-300 p-4 text-sm text-surface-500 dark:border-white/10">
                              {t('store.homeContinueEmpty')}
                            </div>
                          )}
                        </div>
                      </Card>

                      {homeModel?.attentionItems && homeModel.attentionItems.length > 0 && (
                        <Card variant="glass" className="p-5">
                          <h3 className="text-lg font-semibold text-surface-900 dark:text-white">{t('store.homeAttentionTitle')}</h3>
                          <p className="mt-1 text-sm text-surface-500">{t('store.homeAttentionSubtitle')}</p>
                          <div className="mt-4 space-y-3">
                            {homeModel.attentionItems.map((alert) => (
                              <div
                                key={alert.id}
                                className={`rounded-2xl border px-4 py-4 ${alertToneClasses(alert.severity)}`}
                              >
                                <p className="text-sm font-semibold">{alert.title}</p>
                                <p className="mt-2 text-sm opacity-90">{alert.description}</p>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="mt-3"
                                  onClick={() => {
                                    if (alert.repoId) {
                                      setSelectedRepoId(alert.repoId)
                                    }
                                    setActiveTab('sources')
                                  }}
                                >
                                  {t('store.openSources')}
                                </Button>
                              </div>
                            ))}
                          </div>
                        </Card>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>
        )}

        {activeTab === 'search' && (
          <div className={isSearchDetailPage ? 'grid gap-6' : 'grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]'}>
            {!isSearchDetailPage && (
            <Card variant="glass" className="space-y-4 p-5 xl:sticky xl:top-24 xl:self-start">
              <CardHeader title={t('store.searchTitle')} subtitle={t('store.searchSubtitle')} />

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-surface-500">
                  {t('store.exploreSearchLabel')}
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
                  <input
                    ref={searchInputRef}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('store.unifiedSearchPlaceholder')}
                    className="w-full rounded-xl border border-surface-200 bg-surface-50 py-2.5 pl-10 pr-4 text-sm text-surface-900 outline-none transition focus:border-accent-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                  />
                </div>
              </div>

              {!query.trim() && (
              <>
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-surface-500">
                  {t('store.exploreCategoryLabel')}
                </label>
                <select
                  value={exploreCategory}
                  onChange={(event) => setExploreCategory(event.target.value)}
                  style={{ colorScheme: exploreSelectColorScheme }}
                  className="w-full rounded-xl border border-surface-200 bg-surface-50 px-3 py-2.5 text-sm text-surface-900 outline-none transition focus:border-accent-500 dark:border-white/10 dark:bg-surface-900 dark:text-surface-100"
                >
                  <option className="bg-surface-50 text-surface-900 dark:bg-surface-900 dark:text-surface-100" value="all">
                    {t('store.exploreCategoryAll')}
                  </option>
                  {exploreCategories.map((category) => (
                    <option
                      key={category.name}
                      value={category.name}
                      className="bg-surface-50 text-surface-900 dark:bg-surface-900 dark:text-surface-100"
                    >
                      {category.name} ({category.count})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-surface-500">
                  {t('store.exploreSortLabel')}
                </label>
                <select
                  value={exploreSort}
                  onChange={(event) => setExploreSort(event.target.value as StoreExploreSort)}
                  style={{ colorScheme: exploreSelectColorScheme }}
                  className="w-full rounded-xl border border-surface-200 bg-surface-50 px-3 py-2.5 text-sm text-surface-900 outline-none transition focus:border-accent-500 dark:border-white/10 dark:bg-surface-900 dark:text-surface-100"
                >
                  <option className="bg-surface-50 text-surface-900 dark:bg-surface-900 dark:text-surface-100" value="featured">
                    {t('store.exploreSortFeatured')}
                  </option>
                  <option className="bg-surface-50 text-surface-900 dark:bg-surface-900 dark:text-surface-100" value="recent">
                    {t('store.exploreSortRecent')}
                  </option>
                  <option className="bg-surface-50 text-surface-900 dark:bg-surface-900 dark:text-surface-100" value="alpha">
                    {t('store.exploreSortAlpha')}
                  </option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-surface-500">
                  {t('store.exploreRepositoryLabel')}
                </label>
                <div className="flex flex-wrap gap-2">
                  {repositories
                    .filter((repo) => repo.syncEnabled !== false)
                    .map((repo) => {
                      const isActive = activeExploreRepoIds.includes(repo.id)
                      return (
                        <button
                          key={repo.id}
                          type="button"
                          onClick={() => {
                            setEnabledExploreRepoIds((current) => {
                              const source = current.length > 0
                                ? current
                                : repositories.filter((item) => item.syncEnabled !== false).map((item) => item.id)
                              if (source.includes(repo.id)) {
                                const next = source.filter((item) => item !== repo.id)
                                return next.length > 0 ? next : source
                              }
                              return [...source, repo.id]
                            })
                          }}
                          className={[
                            'rounded-xl border px-3 py-2 text-xs font-medium transition-colors',
                            isActive
                              ? 'border-accent-500/30 bg-accent-500/10 text-accent-600 dark:text-accent-400'
                              : 'border-surface-200 bg-surface-50 text-surface-600 hover:bg-surface-100 dark:border-white/10 dark:bg-white/5 dark:text-surface-300 dark:hover:bg-white/10',
                          ].join(' ')}
                        >
                          {repo.name}
                        </button>
                      )
                    })}
                </div>
              </div>
              </>
              )}
            </Card>
            )}

            <div className="space-y-6">
              {!isSearchDetailPage && (
              <Card variant="glass" className="p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <p className="text-sm text-surface-500">
                    {query.trim()
                      ? t('store.searchResultsCount', { count: searchResults.length })
                      : t('store.exploreResultsCount', { count: exploreTotal })}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (query.trim()) {
                        runSearch().catch(() => undefined)
                        return
                      }
                      loadExploreData().catch(() => undefined)
                    }}
                    loading={query.trim() ? searchLoading : exploreLoading}
                    icon={<RefreshCw className="h-4 w-4" />}
                  >
                    {t('common.refresh')}
                  </Button>
                </div>

                {(query.trim() ? searchLoading : exploreLoading) ? (
                  <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                    {Array.from({ length: 6 }).map((_, index) => (
                      <div
                        key={`explore-skeleton-${index}`}
                        className="animate-pulse rounded-3xl border border-surface-200 bg-surface-50 p-3 dark:border-white/10 dark:bg-white/[0.03]"
                      >
                        <div className="h-56 rounded-2xl bg-surface-200 dark:bg-white/10" />
                        <div className="mt-3 h-4 w-2/3 rounded bg-surface-200 dark:bg-white/10" />
                        <div className="mt-2 h-3 w-full rounded bg-surface-200 dark:bg-white/10" />
                        <div className="mt-2 h-3 w-4/5 rounded bg-surface-200 dark:bg-white/10" />
                      </div>
                    ))}
                  </div>
                ) : query.trim() ? (
                  searchResultSections.length === 0 ? (
                    <StoreEmptyState
                      icon={Search}
                      title={t('store.searchNoResultsTitle')}
                      description={t('store.searchNoResultsDesc')}
                    />
                  ) : (
                    <div className="space-y-5">
                      {searchResultSections.map((section) => (
                        <div key={section.kind} className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-semibold uppercase tracking-wide text-surface-500">{section.title}</h3>
                            <span className="text-xs text-surface-400">{section.items.length}</span>
                          </div>
                          <div className="grid gap-3 xl:grid-cols-2">
                            {section.items.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => openPackageDetailFromHit(item)}
                                className="rounded-2xl border border-surface-200 bg-surface-50 p-4 text-left transition-colors hover:border-accent-500/30 hover:bg-white dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/5"
                              >
                                <div className="flex items-start gap-3">
                                  <StoreIcon src={item.iconUrl} className="h-12 w-12 rounded-xl bg-surface-200 object-cover" />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="truncate text-sm font-semibold text-surface-900 dark:text-white">{item.title}</p>
                                      <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[11px] font-medium capitalize text-surface-600 dark:bg-white/10 dark:text-surface-300">
                                        {t(`store.searchKinds.${item.kind}`)}
                                      </span>
                                      {item.compatible === false && (
                                        <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
                                          {t('store.notCompatible')}
                                        </span>
                                      )}
                                    </div>
                                    <p className="mt-1 truncate text-xs text-surface-500">{item.subtitle}</p>
                                    {item.description && (
                                      <p className="mt-2 line-clamp-2 text-xs text-surface-500">
                                        {extractStorePlainText(item.description)}
                                      </p>
                                    )}
                                  </div>
                                  <span className="rounded-xl bg-accent-500/10 px-3 py-2 text-xs font-medium text-accent-600 dark:text-accent-400">
                                    {item.actionLabel || t('store.openPackagePage')}
                                  </span>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : exploreCards.length === 0 ? (
                  <StoreEmptyState
                    icon={ImageIcon}
                    title={t('store.exploreNoResultsTitle')}
                    description={t('store.exploreNoResultsDesc')}
                  />
                ) : (
                  <div className="space-y-5">
                    <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                      {exploreCards.map((card) => {
                        const action = getExploreCardAction(card)
                        const isSelected = selectedPackage?.packageName === card.packageName && selectedPackage?.repoId === card.repoId
                        const previewScreens = (card.screenshotsPreview && card.screenshotsPreview.length > 0)
                          ? card.screenshotsPreview
                          : (card.screenshot ? [card.screenshot] : [])
                        return (
                          <div
                            key={`${card.repoId}:${card.packageName}`}
                            className={[
                              'flex h-full flex-col rounded-3xl border p-3 transition-colors',
                              isSelected
                                ? 'border-accent-500/40 bg-accent-500/5'
                                : 'border-surface-200 bg-surface-50 hover:border-accent-500/20 dark:border-white/10 dark:bg-white/[0.03]',
                            ].join(' ')}
                          >
                            <button
                              type="button"
                              onClick={() => openStorePackagePage(card, 'search')}
                              className="flex flex-1 flex-col text-left"
                            >
                              {previewScreens.length >= 2 ? (
                                <div className="grid h-56 grid-cols-2 gap-1 overflow-hidden rounded-2xl bg-surface-200 p-1 dark:bg-white/10">
                                  {previewScreens.slice(0, 2).map((screen, index) => (
                                    <div key={`${card.packageName}-preview-${index}`} className="overflow-hidden rounded-xl bg-surface-100 dark:bg-white/5">
                                      <img
                                        src={screen.url}
                                        alt={t('store.exploreScreenshotAlt', { name: `${card.name} ${index + 1}` })}
                                        className="h-full w-full object-contain"
                                        loading="lazy"
                                      />
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="flex h-56 items-center justify-center overflow-hidden rounded-2xl bg-surface-200 dark:bg-white/10">
                                  {previewScreens[0]?.url ? (
                                    <img
                                      src={previewScreens[0].url}
                                      alt={t('store.exploreScreenshotAlt', { name: card.name })}
                                      className="h-full w-full object-contain"
                                      loading="lazy"
                                    />
                                  ) : (
                                    <StoreIcon src={card.iconUrl} className="h-full w-full object-contain p-6" fallbackClassName="h-full w-full flex items-center justify-center text-surface-500" />
                                  )}
                                </div>
                              )}

                              <div className="mt-3 flex items-start gap-3">
                                <StoreIcon src={card.iconUrl} />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-semibold text-surface-900 dark:text-white">{card.name}</p>
                                  <p className="mt-1 line-clamp-2 text-xs text-surface-500">
                                    {extractStorePlainText(card.summary || card.packageName)}
                                  </p>
                                </div>
                              </div>
                            </button>

                            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="rounded-full bg-surface-200 px-2 py-1 text-[11px] font-medium text-surface-600 dark:bg-white/10 dark:text-surface-300">
                                  {card.categories[0] || t('store.exploreUncategorized')}
                                </span>
                                <span className="truncate rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                  {card.repoName}
                                </span>
                                <span className={['rounded-full px-2 py-1 text-[11px] font-medium', getTrustBadgeClass(card.trustState)].join(' ')}>
                                  {card.trustLabel}
                                </span>
                              </div>
                            </div>

                            <div className="mt-3">
                              <Button
                                variant={action === 'installed' ? 'secondary' : action === 'migrate' ? 'danger' : 'primary'}
                                size="sm"
                                className="w-full"
                                onClick={() => installFromExploreCard(card).catch(() => undefined)}
                                disabled={action === 'installed'}
                                loading={remoteInstallKey === card.packageName}
                                icon={
                                  action === 'update'
                                    ? <RefreshCw className="h-4 w-4" />
                                    : action === 'migrate'
                                      ? <AlertTriangle className="h-4 w-4" />
                                      : <Download className="h-4 w-4" />
                                }
                              >
                                {action === 'migrate'
                                  ? t('store.migrateAction')
                                  : action === 'update'
                                  ? t('common.update')
                                  : action === 'installed'
                                    ? t('store.exploreInstalled')
                                    : t('common.install')}
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {exploreTotalPages > 1 && (
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setExplorePage((current) => Math.max(1, current - 1))}
                          disabled={explorePage <= 1}
                          icon={<ChevronLeft className="h-4 w-4" />}
                        >
                          {t('common.back')}
                        </Button>
                        <span className="text-xs text-surface-500">
                          {t('store.explorePage', { page: explorePage, total: exploreTotalPages })}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setExplorePage((current) => Math.min(exploreTotalPages, current + 1))}
                          disabled={explorePage >= exploreTotalPages}
                          icon={<ChevronRight className="h-4 w-4" />}
                        >
                          {t('common.next')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </Card>
              )}

              {isSearchDetailPage && (detailLoading ? (
                <Card variant="glass" className="flex min-h-[20rem] items-center justify-center p-6">
                  <Loader2 className="h-8 w-8 animate-spin text-accent-500" />
                </Card>
              ) : selectedPackage ? (
                <Card
                  variant="glass"
                  className={isSearchDetailPage ? 'mx-auto w-full max-w-5xl space-y-5 p-5 sm:p-6' : 'space-y-5 p-5'}
                >
                  {isSearchDetailPage && (
                    <div className="flex items-center justify-between gap-3">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => clearPackageDetailRoute()}
                        icon={<ChevronLeft className="h-4 w-4" />}
                      >
                        {t('common.back')}
                      </Button>
                      <p className="truncate text-xs text-surface-500">{selectedPackage.packageName}</p>
                    </div>
                  )}
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex items-start gap-3">
                      <StoreIcon src={selectedPackage.iconUrl} className="h-14 w-14 rounded-2xl bg-surface-200 object-cover" />
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-xl font-semibold text-surface-900 dark:text-white">{selectedPackage.name}</h3>
                          <span className={['rounded-full px-2.5 py-1 text-xs font-medium', getTrustBadgeClass(selectedPackage.trustState)].join(' ')}>
                            {selectedPackage.trustLabel}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-surface-500">{selectedPackageSummaryText}</p>
                        <p className="mt-1 text-xs text-surface-400">{selectedPackage.packageName}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={
                          selectedExploreAction === 'installed'
                            ? 'secondary'
                            : selectedExploreAction === 'migrate'
                              ? 'danger'
                              : 'primary'
                        }
                        onClick={() => installSelectedPackage(selectedPackage).catch(() => undefined)}
                        disabled={selectedExploreAction === 'installed' || !selectedPackage.suggestedDownloadUrl}
                        loading={remoteInstallKey === selectedPackage.packageName}
                        icon={
                          selectedExploreAction === 'update'
                            ? <RefreshCw className="h-4 w-4" />
                            : selectedExploreAction === 'migrate'
                              ? <AlertTriangle className="h-4 w-4" />
                              : <Download className="h-4 w-4" />
                        }
                      >
                        {selectedExploreAction === 'migrate'
                          ? t('store.migrateAction')
                          : selectedExploreAction === 'update'
                          ? t('common.update')
                          : selectedExploreAction === 'installed'
                            ? t('store.exploreInstalled')
                            : t('common.install')}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => window.open(selectedPackage.packageUrl, '_blank', 'noopener,noreferrer')}
                        icon={<ExternalLink className="h-4 w-4" />}
                      >
                        {t('store.openPackagePage')}
                      </Button>
                    </div>
                  </div>

                  {remoteInstallKey === selectedPackage.packageName && remoteInstallMessage && (
                    <div className="rounded-2xl border border-accent-500/20 bg-accent-500/5 px-4 py-3 text-sm text-accent-600 dark:text-accent-400">
                      {remoteInstallMessage}
                    </div>
                  )}

                  {selectedPackageBinding?.trustState === 'migration_required' && (
                    <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
                      {t('store.migrationRequiredMessage')}
                    </div>
                  )}

                  <div className="overflow-hidden rounded-2xl border border-surface-200 bg-surface-50 dark:border-white/10 dark:bg-white/[0.03]">
                    <div
                      className="relative h-[68vh] min-h-[24rem] max-h-[46rem] outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                      tabIndex={selectedScreenshotCount > 1 ? 0 : -1}
                      onKeyDown={handleExploreCarouselKeyDown}
                      onTouchStart={handleExploreCarouselTouchStart}
                      onTouchEnd={handleExploreCarouselTouchEnd}
                    >
                      {effectivePreviewImage ? (
                        <AnimatePresence initial={false} custom={exploreScreenshotDirection} mode="sync">
                          <motion.img
                            key={effectivePreviewImage}
                            custom={exploreScreenshotDirection}
                            variants={screenshotTransitionVariants}
                            initial="enter"
                            animate="center"
                            exit="exit"
                            transition={{ duration: 0.28, ease: 'easeInOut' }}
                            src={effectivePreviewImage}
                            alt={t('store.exploreScreenshotAlt', { name: selectedPackage.name })}
                            className="absolute inset-0 h-full w-full object-contain"
                          />
                        </AnimatePresence>
                      ) : (
                        <div className="flex h-full items-center justify-center text-surface-500">
                          <ImageIcon className="h-10 w-10" />
                        </div>
                      )}
                      {selectedScreenshotCount > 1 && (
                        <>
                          <button
                            type="button"
                            aria-label={t('common.back')}
                            onClick={() => navigateExploreScreenshot('prev')}
                            className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white transition hover:bg-black/70"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            aria-label={t('common.next')}
                            onClick={() => navigateExploreScreenshot('next')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white transition hover:bg-black/70"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                    {selectedScreenshotCount > 0 && (
                      <div className="flex gap-2 overflow-x-auto border-t border-surface-200 p-3 dark:border-white/10">
                        {selectedScreenshots.map((screenshot, index) => (
                          <button
                            key={`${selectedPackage.packageName}-shot-${index}`}
                            type="button"
                            onClick={() => selectExploreScreenshot(index)}
                            aria-label={t('store.exploreScreenshotAlt', { name: `${selectedPackage.name} ${index + 1}` })}
                            className={[
                              'h-24 w-16 shrink-0 overflow-hidden rounded-lg border bg-surface-100 transition dark:bg-white/5',
                              exploreScreenshotIndex === index
                                ? 'border-accent-500'
                                : 'border-surface-200 dark:border-white/10',
                            ].join(' ')}
                          >
                            <img src={screenshot.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-surface-500">{t('store.about')}</h4>
                      {selectedPackageDescriptionHtml ? (
                        <div
                          className="prose prose-sm mt-2 max-w-none text-surface-700 prose-headings:text-surface-900 prose-p:text-surface-700 prose-li:text-surface-700 prose-strong:text-surface-900 prose-a:text-accent-600 dark:prose-invert dark:prose-p:text-surface-300 dark:prose-li:text-surface-300 dark:prose-strong:text-white dark:prose-a:text-accent-400"
                          dangerouslySetInnerHTML={{ __html: selectedPackageDescriptionHtml }}
                        />
                      ) : (
                        <p className="mt-2 text-sm leading-6 text-surface-700 dark:text-surface-300">
                          {t('store.noDescription')}
                        </p>
                      )}
                      {selectedPackageWhatsNewHtml && (
                        <div className="mt-5">
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-surface-500">{t('store.whatsNew')}</h4>
                          <div
                            className="prose prose-sm mt-2 max-w-none text-surface-700 prose-headings:text-surface-900 prose-p:text-surface-700 prose-li:text-surface-700 prose-strong:text-surface-900 prose-a:text-accent-600 dark:prose-invert dark:prose-p:text-surface-300 dark:prose-li:text-surface-300 dark:prose-strong:text-white dark:prose-a:text-accent-400"
                            dangerouslySetInnerHTML={{ __html: selectedPackageWhatsNewHtml }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-surface-500">{t('store.exploreCategoriesTitle')}</h4>
                      <div className="flex flex-wrap gap-2">
                        {(selectedPackage.categories && selectedPackage.categories.length > 0
                          ? selectedPackage.categories
                          : [t('store.exploreUncategorized')])
                          .map((category) => (
                            <span
                              key={`${selectedPackage.packageName}-${category}`}
                              className="rounded-full bg-surface-200 px-2.5 py-1 text-xs font-medium text-surface-600 dark:bg-white/10 dark:text-surface-300"
                            >
                              {category}
                            </span>
                          ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <section className="rounded-2xl border border-surface-200 bg-surface-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-surface-500">{t('store.packageFacts')}</h4>
                      <dl className="mt-3 space-y-2 text-sm">
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-surface-500">{t('store.repository')}</dt>
                          <dd className="text-right font-medium text-surface-900 dark:text-white">{selectedPackage.repoId}</dd>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-surface-500">{t('store.latestVersion')}</dt>
                          <dd className="text-right font-medium text-surface-900 dark:text-white">
                            {selectedPackage.suggestedVersionName || '-'}
                          </dd>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-surface-500">{t('store.minAndroid')}</dt>
                          <dd className="text-right font-medium text-surface-900 dark:text-white">
                            {selectedPackage.minAndroid || '-'}
                          </dd>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-surface-500">{t('store.license')}</dt>
                          <dd className="text-right font-medium text-surface-900 dark:text-white">
                            {selectedPackage.license || '-'}
                          </dd>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-surface-500">{t('store.verificationState')}</dt>
                          <dd className="text-right font-medium text-surface-900 dark:text-white">
                            {t(`store.verificationStateLabels.${selectedPackageRepository?.verificationState || 'pending'}`)}
                          </dd>
                        </div>
                        <div className="flex items-start justify-between gap-3">
                          <dt className="text-surface-500">{t('store.indexFingerprint')}</dt>
                          <dd className="max-w-[14rem] break-all text-right font-medium text-surface-900 dark:text-white">
                            {selectedPackageRepository?.indexSha256 || '-'}
                          </dd>
                        </div>
                      </dl>
                    </section>

                    <section className="rounded-2xl border border-surface-200 bg-surface-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-surface-500">{t('store.availableVersions')}</h4>
                        {selectedPackage.changelogUrl && (
                          <a
                            href={selectedPackage.changelogUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-medium text-accent-600 hover:underline dark:text-accent-400"
                          >
                            {t('store.whatsNew')}
                          </a>
                        )}
                      </div>
                      <div className="mt-3 space-y-2">
                        {selectedPackage.versions.slice(0, 8).map((version) => (
                          <div
                            key={`${selectedPackage.packageName}-explore-version-${version.versionCode}`}
                            className="rounded-xl border border-surface-200 bg-white px-3 py-2 text-sm dark:border-white/10 dark:bg-white/[0.02]"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <span className="font-medium text-surface-900 dark:text-white">{version.versionName}</span>
                                <p className="text-xs text-surface-500">vc {version.versionCode}</p>
                              </div>
                              <Button
                                variant={selectedInstalledVersionCode === version.versionCode ? 'secondary' : 'primary'}
                                size="sm"
                                onClick={() => installSelectedPackage(selectedPackage, version.versionCode).catch(() => undefined)}
                                disabled={selectedInstalledVersionCode === version.versionCode}
                                loading={remoteInstallKey === selectedPackage.packageName}
                              >
                                {selectedInstalledVersionCode === version.versionCode
                                  ? t('store.exploreInstalled')
                                  : t('common.install')}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>

                  {selectedPackageLinks.length > 0 && (
                    <section className="rounded-2xl border border-surface-200 bg-surface-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-surface-500">{t('store.links')}</h4>
                      <div className="mt-3 space-y-2 text-sm">
                        {selectedPackageLinks.map((value) => (
                          <a
                            key={value}
                            href={value}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 text-accent-600 hover:underline dark:text-accent-400"
                          >
                            <ExternalLink className="h-4 w-4" />
                            <span className="truncate">{value}</span>
                          </a>
                        ))}
                      </div>
                    </section>
                  )}
                </Card>
              ) : (
                <Card variant="glass" className="mx-auto w-full max-w-5xl space-y-4 p-6">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => clearPackageDetailRoute()}
                    icon={<ChevronLeft className="h-4 w-4" />}
                  >
                    {t('common.back')}
                  </Button>
                  <StoreEmptyState
                    icon={Package}
                    title={t('common.error')}
                    description={t('store.packageLoadFailed')}
                  />
                </Card>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'home' && showLocalInstallPanel && (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="space-y-6">
              <Card variant="glass" className="p-5">
                <CardHeader title={t('store.localTitle')} subtitle={t('store.localSubtitle')} />
                <div
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={[
                    'relative rounded-3xl border-2 border-dashed p-10 text-center transition-all',
                    dragActive
                      ? 'border-accent-500 bg-accent-500/5'
                      : 'border-surface-300 hover:border-accent-500/40 hover:bg-surface-50 dark:border-white/10 dark:hover:bg-white/[0.03]',
                  ].join(' ')}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".apk"
                    multiple
                    onChange={handleLocalFileSelection}
                    className="hidden"
                  />
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-500/10 text-accent-500">
                    <Upload className="h-7 w-7" strokeWidth={1.5} />
                  </div>
                  <h3 className="text-lg font-semibold text-surface-900 dark:text-white">
                    {dragActive ? t('store.localDropTitleActive') : t('store.localDropTitle')}
                  </h3>
                  <p className="mt-2 text-sm text-surface-500">{t('store.localDropSubtitle')}</p>
                  <p className="mt-4 text-xs text-surface-400">{t('store.localOnlyApk')}</p>
                  {dragActive && (
                    <div className="pointer-events-none absolute inset-0 rounded-3xl border-2 border-accent-500 bg-accent-500/10" />
                  )}
                </div>
              </Card>

              <Card variant="glass" className="p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-surface-900 dark:text-white">{t('store.localQueueTitle')}</h3>
                    <p className="mt-1 text-sm text-surface-500">{t('store.localQueueSubtitle')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setLocalMode('separate')}
                      className={[
                        'rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                        localMode === 'separate'
                          ? 'bg-accent-500/10 text-accent-600 dark:text-accent-400'
                          : 'bg-surface-100 text-surface-600 hover:bg-surface-200 dark:bg-white/5 dark:text-surface-400 dark:hover:bg-white/10',
                      ].join(' ')}
                    >
                      {t('store.localModeSeparate')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setLocalMode('together')}
                      className={[
                        'rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                        localMode === 'together'
                          ? 'bg-accent-500/10 text-accent-600 dark:text-accent-400'
                          : 'bg-surface-100 text-surface-600 hover:bg-surface-200 dark:bg-white/5 dark:text-surface-400 dark:hover:bg-white/10',
                      ].join(' ')}
                    >
                      {t('store.localModeTogether')}
                    </button>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  {localQueue.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-surface-300 p-5 text-sm text-surface-500 dark:border-white/10">
                      {t('store.localQueueEmpty')}
                    </div>
                  ) : (
                    localQueue.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-2xl border border-surface-200 bg-surface-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <FileBox className="h-4 w-4 text-surface-500" />
                              <p className="truncate text-sm font-medium text-surface-900 dark:text-white">{item.file.name}</p>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-surface-500">
                              <span>{formatBytes(item.file.size)}</span>
                              <span className="rounded-full bg-surface-200 px-2 py-0.5 capitalize dark:bg-white/10">{item.status}</span>
                              {item.message && <span className="truncate">{item.message}</span>}
                            </div>
                            {item.status === 'installing' && (
                              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-200 dark:bg-white/10">
                                <div className="h-full rounded-full bg-accent-500" style={{ width: `${item.progress}%` }} />
                              </div>
                            )}
                          </div>
                          {item.status !== 'installing' && (
                            <button
                              type="button"
                              onClick={() => removeLocalItem(item.id)}
                              className="rounded-xl p-2 text-surface-400 transition-colors hover:bg-surface-200 hover:text-red-500 dark:hover:bg-white/10"
                            >
                              <ShieldX className="h-4 w-4" strokeWidth={1.5} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs text-surface-500">
                    {localMode === 'together' ? t('store.localInstallTipSplit') : t('store.localInstallTipSeparate')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" onClick={clearLocalQueue}>
                      {t('store.clearQueue')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => installLocalQueueItems().catch(() => undefined)}
                      icon={<FolderDown className="h-4 w-4" />}
                      disabled={localQueue.length === 0}
                    >
                      {t('store.installQueuedApks')}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>

            <div className="space-y-6">
              <Card variant="glass" className="p-5">
                <CardHeader title={t('store.localInstall')} subtitle={t('store.localInstallDesc')} />
                <div className="space-y-3 text-sm text-surface-600 dark:text-surface-300">
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
                      <p>{t('store.localInstallTipBody')}</p>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-surface-200 bg-surface-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                    <p className="font-medium text-surface-900 dark:text-white">{t('store.localModeTogether')}</p>
                    <p className="mt-1 text-xs text-surface-500">{t('store.localInstallModeTogetherDesc')}</p>
                  </div>
                  <div className="rounded-2xl border border-surface-200 bg-surface-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                    <p className="font-medium text-surface-900 dark:text-white">{t('store.localModeSeparate')}</p>
                    <p className="mt-1 text-xs text-surface-500">{t('store.localInstallModeSeparateDesc')}</p>
                  </div>
                  {!canInstall && (
                    <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
                      {isDemoMode ? t('store.demoInstallDisabled') : t('store.connectDevice')}
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>
        )}

        {activeTab === 'library' && (
          <div className="space-y-6">
            <Card variant="glass" className="p-5">
              <CardHeader
                title={t('store.libraryTitle')}
                subtitle={t('store.librarySubtitle', { count: libraryEntries.length })}
                action={
                  <Button variant="secondary" size="sm" onClick={() => syncPackages().catch(() => undefined)} icon={<RefreshCw className="h-4 w-4" />}>
                    {t('common.refresh')}
                  </Button>
                }
              />
              {libraryEntries.length === 0 ? (
                <StoreEmptyState icon={Package} title={t('store.libraryEmptyTitle')} description={t('store.libraryEmptyDesc')} />
              ) : (
                <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                  {libraryEntries.map((entry) => {
                    const binding = bindings.find((item) => item.packageName === entry.packageName)
                    const candidate = updates.find((item) => item.packageName === entry.packageName)
                    const stateLabel = entry.state === 'installed'
                      ? t('store.libraryStateInstalled')
                      : entry.state === 'update_available'
                        ? t('store.libraryStateUpdateAvailable')
                        : entry.state === 'migration_required'
                          ? t('store.libraryStateMigrationRequired')
                          : t('store.libraryStateTracked')
                    return (
                      <div
                        key={entry.packageName}
                        className="rounded-2xl border border-surface-200 bg-surface-50 p-4 dark:border-white/10 dark:bg-white/[0.03]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-surface-900 dark:text-white">{entry.appName}</p>
                            <p className="mt-1 truncate text-xs text-surface-500">{entry.packageName}</p>
                          </div>
                          <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                            {stateLabel}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-surface-500">
                          <span>{t('store.currentVersion')}: {entry.currentVersionName || entry.currentVersionCode || '-'}</span>
                          <span>{t('store.latestVersion')}: {entry.latestVersionName || entry.latestVersionCode || '-'}</span>
                          <span>{entry.installed ? t('common.active') : t('store.libraryNotInstalled')}</span>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openStorePackagePage({
                              repoId: entry.repoId,
                              packageName: entry.packageName,
                              name: entry.appName,
                            }, 'search')}
                          >
                            {t('store.openPackagePage')}
                          </Button>
                          {candidate && (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => installUpdateCandidate(candidate).catch(() => undefined)}
                              loading={remoteInstallKey === candidate.packageName}
                              icon={<RefreshCw className="h-4 w-4" />}
                            >
                              {candidate.trustState === 'migration_required' ? t('store.migrateAction') : t('common.update')}
                            </Button>
                          )}
                        </div>
                        {binding && (
                          <div className="mt-4">
                            <label className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-surface-500">
                              {t('store.updatePolicy')}
                            </label>
                            <select
                              value={binding.updatePolicy || 'manual'}
                              onChange={(event) => updateBindingPolicy(binding, event.target.value as StoreUpdatePolicy).catch(() => undefined)}
                              className="w-full rounded-xl border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 outline-none transition focus:border-accent-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
                            >
                              <option value="manual">{t('store.policyManual')}</option>
                              <option value="notify">{t('store.policyNotify')}</option>
                              <option value="auto_trusted">{t('store.policyAutoTrusted')}</option>
                              <option value="frozen">{t('store.policyFrozen')}</option>
                            </select>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          </div>
        )}

        {activeTab === 'updates' && (
          <div className="space-y-6">
            <Card variant="glass" className="p-5">
              <CardHeader
                title={t('store.updatesTitle')}
                subtitle={t('store.updatesSubtitle')}
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => refreshUpdates().catch(() => undefined)}
                      loading={updatesLoading}
                      icon={<RefreshCw className="h-4 w-4" />}
                    >
                      {t('common.refresh')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => updateAllCandidates().catch(() => undefined)}
                      loading={bulkUpdating}
                      disabled={!canInstall || updates.length === 0 || updatesLoading}
                      icon={<Download className="h-4 w-4" />}
                    >
                      {`${t('common.update')} ${t('common.all')}`}
                    </Button>
                  </div>
                }
              />

              {updates.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-surface-200 px-3 py-1 text-xs font-medium text-surface-600 dark:bg-white/10 dark:text-surface-300">
                    {updates.length}
                  </span>
                  <span className="rounded-full bg-surface-200 px-3 py-1 text-xs font-medium text-surface-600 dark:bg-white/10 dark:text-surface-300">
                    {`${t('fileManager.size')}: ${formatBytes(totalUpdateDownloadBytes || undefined)}`}
                  </span>
                </div>
              )}

              {bulkUpdating && bulkUpdateProgress && (
                <div className="mb-4 rounded-2xl border border-accent-500/20 bg-accent-500/5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-surface-900 dark:text-white">
                        {bulkUpdateProgress.currentAppName || t('store.updatesTitle')}
                      </p>
                      <p className="mt-1 text-xs text-surface-500">{bulkUpdateProgress.message}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-accent-700 dark:text-accent-300">
                        {bulkUpdateProgress.overallPercent}%
                      </p>
                      <p className="text-xs text-surface-500">
                        {bulkUpdateProgress.completedItems}/{bulkUpdateProgress.totalItems}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-200 dark:bg-white/10">
                    <div
                      className="h-full rounded-full bg-accent-600 transition-all duration-300"
                      style={{ width: `${bulkUpdateProgress.overallPercent}%` }}
                    />
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-surface-200 bg-white px-3 py-3 text-sm dark:border-white/10 dark:bg-white/[0.03]">
                      <p className="text-xs uppercase tracking-wide text-surface-500">{t('fileManager.size')}</p>
                      <p className="mt-1 font-medium text-surface-900 dark:text-white">
                        {bulkUpdateProgress.totalBytes
                          ? `${formatBytes(bulkUpdateProgress.downloadedBytes)} / ${formatBytes(bulkUpdateProgress.totalBytes)}`
                          : formatBytes(bulkUpdateProgress.downloadedBytes)}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-surface-200 bg-white px-3 py-3 text-sm dark:border-white/10 dark:bg-white/[0.03]">
                      <p className="text-xs uppercase tracking-wide text-surface-500">{t('common.download')}</p>
                      <p className="mt-1 font-medium text-surface-900 dark:text-white">
                        {formatBytesPerSecond(bulkUpdateProgress.speedBytesPerSecond)}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-surface-200 bg-white px-3 py-3 text-sm dark:border-white/10 dark:bg-white/[0.03]">
                      <p className="text-xs uppercase tracking-wide text-surface-500">{t('common.update')}</p>
                      <p className="mt-1 font-medium text-surface-900 dark:text-white">
                        {bulkUpdateProgress.completedItems}/{bulkUpdateProgress.totalItems}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {updates.length === 0 ? (
                <StoreEmptyState icon={CheckCircle2} title={t('store.noUpdates')} description={t('store.noUpdatesDesc')} />
              ) : (
                <div className="grid gap-4 xl:grid-cols-2">
                  {updates.map((candidate) => (
                    <div
                      key={candidate.packageName}
                      className="rounded-2xl border border-surface-200 bg-surface-50 p-4 dark:border-white/10 dark:bg-white/[0.03]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-base font-semibold text-surface-900 dark:text-white">{candidate.appName}</p>
                          <p className="mt-1 truncate text-xs text-surface-500">{candidate.packageName}</p>
                        </div>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => installUpdateCandidate(candidate).catch(() => undefined)}
                          loading={remoteInstallKey === candidate.packageName}
                          disabled={!candidate.latestDownloadUrl || bulkUpdating}
                          icon={<Download className="h-4 w-4" />}
                        >
                          {candidate.trustState === 'migration_required' ? t('store.migrateAction') : t('common.update')}
                        </Button>
                      </div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-surface-200 bg-white px-3 py-3 text-sm dark:border-white/10 dark:bg-white/[0.03]">
                          <p className="text-xs uppercase tracking-wide text-surface-500">{t('store.currentVersion')}</p>
                          <p className="mt-1 font-medium text-surface-900 dark:text-white">
                            {candidate.currentVersionName || candidate.currentVersionCode || '-'}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-surface-200 bg-white px-3 py-3 text-sm dark:border-white/10 dark:bg-white/[0.03]">
                          <p className="text-xs uppercase tracking-wide text-surface-500">{t('store.latestVersion')}</p>
                          <p className="mt-1 font-medium text-surface-900 dark:text-white">
                            {candidate.latestVersionName} ({candidate.latestVersionCode})
                          </p>
                        </div>
                        <div className="rounded-2xl border border-surface-200 bg-white px-3 py-3 text-sm dark:border-white/10 dark:bg-white/[0.03]">
                          <p className="text-xs uppercase tracking-wide text-surface-500">{t('fileManager.size')}</p>
                          <p className="mt-1 font-medium text-surface-900 dark:text-white">
                            {formatBytes(candidate.downloadSizeBytes)}
                          </p>
                        </div>
                      </div>

                      {candidate.trustState !== 'trusted' && (
                        <div className="mt-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-3 py-3 text-sm text-amber-700 dark:text-amber-400">
                          {candidate.trustMessage || (
                            candidate.trustState === 'migration_required'
                              ? t('store.migrationRequiredMessage')
                              : t('store.signerConflictMessage')
                          )}
                        </div>
                      )}

                      {remoteInstallKey === candidate.packageName && remoteInstallMessage && (
                        <div className="mt-3 rounded-2xl border border-accent-500/20 bg-accent-500/5 px-3 py-2 text-sm text-accent-600 dark:text-accent-400">
                          {remoteInstallMessage}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {activeTab === 'sources' && (
          <div className="space-y-6">
            <Card variant="glass" className="p-5">
              <CardHeader
                title={t('store.alertsTitle')}
                subtitle={t('store.alertsSubtitle', { count: trustAlerts.length })}
              />

              {trustAlerts.length === 0 ? (
                <StoreEmptyState icon={ShieldCheck} title={t('store.noAlertsTitle')} description={t('store.noAlertsDesc')} tone="success" />
              ) : (
                <div className="grid gap-4 xl:grid-cols-2">
                  {trustAlerts.map((alert) => (
                    <div
                      key={alert.id}
                      className={`rounded-2xl border px-4 py-4 ${alertToneClasses(alert.severity)}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold">{alert.title}</p>
                          <p className="mt-2 text-sm opacity-90">{alert.description}</p>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            if (alert.repoId) {
                              setSelectedRepoId(alert.repoId)
                            }
                            setActiveTab(alert.targetTab)
                          }}
                        >
                          {alert.targetTab === 'updates' ? t('store.openUpdates') : t('store.openSources')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {activeTab === 'sources' && (
          <div className="space-y-6">
            <Card variant="glass" className="p-5">
              <CardHeader
                title={t('store.repositoriesTitle')}
                subtitle={t('store.repositoriesSubtitle')}
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => refreshRepositories().catch(() => undefined)}
                      loading={repoLoading}
                      icon={<RefreshCw className="h-4 w-4" />}
                    >
                      {t('common.refresh')}
                    </Button>
                    {isAdmin && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => runScheduler().catch(() => undefined)}
                        loading={repoActionLoadingId === '__scheduler__'}
                        icon={<RefreshCw className="h-4 w-4" />}
                      >
                        {t('store.runScheduler')}
                      </Button>
                    )}
                    {isAdmin && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => syncCatalog().catch(() => undefined)}
                        loading={catalogSyncLoading}
                        icon={<Download className="h-4 w-4" />}
                      >
                        {t('store.syncCatalog')}
                      </Button>
                    )}
                  </div>
                }
              />

              {user && (
                <div className="mb-5 grid gap-3 rounded-3xl border border-surface-200 bg-surface-50 p-4 dark:border-white/10 dark:bg-white/[0.03] xl:grid-cols-[minmax(0,1fr)_16rem_auto]">
                  <input
                    type="url"
                    value={customRepoUrl}
                    onChange={(event) => setCustomRepoUrl(event.target.value)}
                    placeholder={t('store.customRepoUrl')}
                    className="rounded-xl border border-surface-200 bg-white px-3 py-2.5 text-sm text-surface-900 outline-none transition focus:border-accent-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
                  />
                  <input
                    type="text"
                    value={customRepoFingerprint}
                    onChange={(event) => setCustomRepoFingerprint(event.target.value)}
                    placeholder={t('store.customRepoFingerprint')}
                    className="rounded-xl border border-surface-200 bg-white px-3 py-2.5 text-sm text-surface-900 outline-none transition focus:border-accent-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-white"
                  />
                  <Button
                    variant="primary"
                    onClick={() => onboardRepository().catch(() => undefined)}
                    loading={onboardingRepo}
                    disabled={!customRepoUrl.trim()}
                    icon={<Upload className="h-4 w-4" />}
                  >
                    {t('store.addRepository')}
                  </Button>
                </div>
              )}

              <div className="grid gap-4 xl:grid-cols-2">
                {repositories.map((repo) => (
                  <div
                    key={repo.id}
                    className="rounded-3xl border border-surface-200 bg-surface-50 p-5 dark:border-white/10 dark:bg-white/[0.03]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-surface-900 dark:text-white">{repo.name}</h3>
                        <p className="mt-1 text-sm text-surface-500">{repo.description}</p>
                      </div>
                      <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        {repo.trustLabel}
                      </span>
                    </div>

                    <dl className="mt-5 space-y-3 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.entryTimestamp')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">{formatDate(repo.entryTimestamp)}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.packageCount')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">{repo.packageCount ?? '-'}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.indexSize')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">{formatBytes(repo.indexSizeBytes)}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.metadataWindow')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">{repo.maxAgeDays ?? '-'} days</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.lastSynced')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">{formatDate(repo.lastSyncedAt)}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.lastSyncMode')}</dt>
                        <dd className="text-right font-medium uppercase text-surface-900 dark:text-white">{repo.lastSyncMode || '-'}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.userTrustState')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">{repo.userTrustState || '-'}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.verificationState')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">
                          {t(`store.verificationStateLabels.${repo.verificationState || 'pending'}`)}
                        </dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.indexFingerprint')}</dt>
                        <dd className="max-w-[16rem] break-all text-right font-medium text-surface-900 dark:text-white">
                          {repo.indexSha256 || '-'}
                        </dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.retryCount')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">{repo.retryCount ?? 0}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.nextRetryAt')}</dt>
                        <dd className="text-right font-medium text-surface-900 dark:text-white">{formatDate(repo.nextRetryAt)}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-surface-500">{t('store.fingerprint')}</dt>
                        <dd className="max-w-[16rem] break-all text-right font-medium text-surface-900 dark:text-white">
                          {repo.declaredFingerprint || '-'}
                        </dd>
                      </div>
                    </dl>

                    {repo.lastError && (
                      <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
                        {repo.lastError}
                      </div>
                    )}

                    {repo.verificationDetails && (
                      <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${alertToneClasses(repo.verificationState === 'verified' ? 'info' : repo.verificationState === 'integrity_mismatch' ? 'error' : 'warning')}`}>
                        {repo.verificationDetails}
                      </div>
                    )}

                    <div className="mt-5 flex flex-wrap gap-2">
                      <a
                        href={repo.entryUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-xl border border-surface-200 px-3 py-2 text-sm text-surface-600 transition-colors hover:bg-surface-100 dark:border-white/10 dark:text-surface-300 dark:hover:bg-white/10"
                      >
                        <ExternalLink className="h-4 w-4" />
                        {t('store.openEntryJson')}
                      </a>
                      <a
                        href={repo.baseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-xl border border-surface-200 px-3 py-2 text-sm text-surface-600 transition-colors hover:bg-surface-100 dark:border-white/10 dark:text-surface-300 dark:hover:bg-white/10"
                      >
                        <ExternalLink className="h-4 w-4" />
                        {t('store.openRepository')}
                      </a>
                      {(isAdmin || !repo.isBuiltin) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => syncRepositoryCatalog(repo.id).catch(() => undefined)}
                          loading={repoActionLoadingId === repo.id}
                          icon={<RefreshCw className="h-4 w-4" />}
                        >
                          {t('store.syncRepository')}
                        </Button>
                      )}
                      {!repo.isBuiltin && user && (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => updateRepositoryTrust(repo.id, 'approved').catch(() => undefined)}
                            loading={repoActionLoadingId === repo.id}
                            icon={<ShieldCheck className="h-4 w-4" />}
                          >
                            {t('store.approveRepository')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => updateRepositoryTrust(repo.id, 'quarantined').catch(() => undefined)}
                            loading={repoActionLoadingId === repo.id}
                            icon={<AlertTriangle className="h-4 w-4" />}
                          >
                            {t('store.quarantineRepository')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}
      </div>

      <Modal
        isOpen={Boolean(migrationPrompt)}
        onClose={() => resolveMigrationPrompt('cancel')}
        title={t('store.migrationDialogTitle')}
        size="lg"
      >
        {migrationPrompt && (
          <>
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
              <p className="font-semibold">{t('store.migrationRequiredMessage')}</p>
              <p className="mt-2">{t('store.migrationDialogIntro', { name: migrationPrompt.packageLabel })}</p>
            </div>

            <div className="mt-5 space-y-3">
              <div className="rounded-2xl border border-surface-200 bg-surface-50 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-xl bg-red-500/10 p-2 text-red-600 dark:text-red-400">
                    <ShieldX className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-surface-900 dark:text-white">
                      {t('store.migrationOptionReinstallTitle')}
                    </h3>
                    <p className="mt-1 text-sm text-surface-600 dark:text-surface-300">
                      {t('store.migrationOptionReinstallDesc')}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-surface-200 bg-surface-50 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-xl bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-surface-900 dark:text-white">
                        {t('store.migrationOptionKeepDataTitle')}
                      </h3>
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                        {t('store.experimental')}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-surface-600 dark:text-surface-300">
                      {t('store.migrationOptionKeepDataDesc')}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <ModalActions>
              <Button variant="ghost" onClick={() => resolveMigrationPrompt('cancel')}>
                {t('common.cancel')}
              </Button>
              <Button variant="secondary" onClick={() => resolveMigrationPrompt('keep_data')}>
                {t('store.migrationOptionKeepDataAction')}
              </Button>
              <Button variant="danger" onClick={() => resolveMigrationPrompt('reinstall')}>
                {t('store.migrationOptionReinstallAction')}
              </Button>
            </ModalActions>
          </>
        )}
      </Modal>
    </div>
  )
}

