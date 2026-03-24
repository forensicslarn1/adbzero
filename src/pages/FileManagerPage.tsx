import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  FolderPlus,
  Grid3X3,
  List,
  RefreshCw,
  Shield,
  ShieldAlert,
  Upload,
  Pencil,
  Move,
  Copy as CopyIcon,

  Trash2,
  ClipboardPaste,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal, ModalActions } from '@/components/ui/Modal'
import { useAdb } from '@/hooks/useAdb'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useAppStore } from '@/stores/appStore'
import { useAuthStore } from '@/stores/authStore'
import { useTranslation } from '@/stores/i18nStore'
import { logUserAction, type UserAction } from '@/services/supabase'
import {
  checkRootCapability,
  chmodPath,
  chownPath,
  copyPaths,
  createDirectory,
  deletePaths,
  readFileContents,
  type FileEntry,
  type FileManagerMode,
  joinPath,
  listDirectory,
  movePaths,
  parentDir,
  renamePath,
  type TransferProgress,
  uploadFile,
} from '@/services/file-manager'
import { FileActionBar } from '@/components/file-manager/FileActionBar'
import { FileListPane } from '@/components/file-manager/FileListPane'
import { FilePreviewPanel, type PreviewState } from '@/components/file-manager/FilePreviewPanel'
import { FileTreePane } from '@/components/file-manager/FileTreePane'

type SortKey = 'name' | 'kind' | 'size' | 'mtime'
type SortDir = 'asc' | 'desc'
type ViewMode = 'list' | 'grid'
type DialogType = 'none' | 'mkdir' | 'rename' | 'move' | 'copy' | 'delete' | 'chmod' | 'chown'

interface DialogState {
  type: DialogType
  value: string
  paths: string[]
}

interface ClipboardState {
  op: 'copy' | 'cut'
  paths: string[]
}

const USER_ROOTS = ['/sdcard', '/storage', '/data/local/tmp']
const ROOT_ROOTS = ['/', '/sdcard', '/storage', '/data', '/system', '/vendor', '/product', '/data/local/tmp']

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'json', 'xml', 'md', 'csv', 'ini', 'properties', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx', 'html', 'css',
])

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024

function hasDragFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types).includes('Files')
}

function isUserSpacePath(path: string): boolean {
  return (
    path === '/sdcard' ||
    path.startsWith('/sdcard/') ||
    path === '/storage' ||
    path.startsWith('/storage/') ||
    path === '/data/local/tmp' ||
    path.startsWith('/data/local/tmp/')
  )
}


function getExtension(name: string): string {
  const index = name.lastIndexOf('.')
  if (index === -1) return ''
  return name.slice(index + 1).toLowerCase()
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}



export function FileManagerPage() {
  const { isConnected, isDemoMode, currentDeviceId } = useAdb()
  const { user } = useAuthStore()
  const { showToast } = useAppStore()
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewObjectUrlRef = useRef<string | null>(null)
  const dragDepthRef = useRef(0)

  const [mode, setMode] = useState<FileManagerMode>('user')
  const [hasRoot, setHasRoot] = useState(false)
  const [currentPath, setCurrentPath] = useState('/sdcard')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null)
  const [dialog, setDialog] = useState<DialogState>({ type: 'none', value: '', paths: [] })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sortBy, setSortBy] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ loading: false, type: 'none' })
  const [isDragOver, setIsDragOver] = useState(false)

  const roots = mode === 'root' ? ROOT_ROOTS : USER_ROOTS
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths])

  const navigateTo = useCallback((path: string) => {
    if (mode === 'user' && !isUserSpacePath(path)) return
    setCurrentPath(path)
    setSelectedPaths([])
  }, [mode])

  const loadCurrentDirectory = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const list = await listDirectory(path, mode)
      setEntries(list)
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: toErrorMessage(error),
      })
    } finally {
      setLoading(false)
    }
  }, [mode, showToast, t])

  useEffect(() => {
    let mounted = true
    checkRootCapability()
      .then((value) => {
        if (!mounted) return
        setHasRoot(value)
        if (!value) setMode('user')
      })
      .catch(() => {
        if (!mounted) return
        setHasRoot(false)
        setMode('user')
      })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (mode === 'user' && !isUserSpacePath(currentPath)) {
      setCurrentPath('/sdcard')
      setSelectedPaths([])
    }
  }, [mode, currentPath])

  useEffect(() => {
    if (!isConnected) return
    void loadCurrentDirectory(currentPath)
  }, [isConnected, currentPath, mode, loadCurrentDirectory])

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current)
        previewObjectUrlRef.current = null
      }
    }
  }, [])

  const shownEntries = useMemo(() => {
    const lowerSearch = search.trim().toLowerCase()
    const filtered = lowerSearch
      ? entries.filter((entry) => entry.name.toLowerCase().includes(lowerSearch))
      : entries

    const dirMultiplier = sortDir === 'asc' ? 1 : -1
    const sorted = [...filtered].sort((a, b) => {
      if (a.kind === 'directory' && b.kind !== 'directory') return -1
      if (a.kind !== 'directory' && b.kind === 'directory') return 1

      if (sortBy === 'name') {
        return a.name.localeCompare(b.name) * dirMultiplier
      }
      if (sortBy === 'kind') {
        return a.kind.localeCompare(b.kind) * dirMultiplier
      }
      if (sortBy === 'size') {
        return (a.size - b.size) * dirMultiplier
      }
      return (a.mtime - b.mtime) * dirMultiplier
    })

    return sorted
  }, [entries, search, sortBy, sortDir])

  const singleSelectedEntry = useMemo(() => {
    if (selectedPaths.length !== 1) return null
    return entries.find((entry) => entry.path === selectedPaths[0]) || null
  }, [entries, selectedPaths])

  // Handle Preview State
  useEffect(() => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current)
      previewObjectUrlRef.current = null
    }

    if (!singleSelectedEntry) {
      setPreview({ loading: false, type: 'none' })
      return
    }

    setPreview({
      loading: false,
      type: 'metadata',
    })
  }, [singleSelectedEntry])

  const canPreview = useMemo(() => {
    if (!singleSelectedEntry || singleSelectedEntry.kind !== 'file') return false
    const ext = getExtension(singleSelectedEntry.name)
    return TEXT_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)
  }, [singleSelectedEntry])

  const handleLoadPreview = useCallback(async () => {
    if (!singleSelectedEntry || singleSelectedEntry.kind !== 'file') return
    const pathOnStart = singleSelectedEntry.path

    const ext = getExtension(singleSelectedEntry.name)
    const textPreview = TEXT_EXTENSIONS.has(ext)
    const imagePreview = IMAGE_EXTENSIONS.has(ext)

    if (textPreview && singleSelectedEntry.size > MAX_TEXT_PREVIEW_BYTES) {
      setPreview({
        loading: false,
        type: 'metadata',
        content: t('fileManager.previewTextTooLarge'),
      })
      return
    }

    setPreview({ loading: true, type: 'metadata' })

    try {
      // 1MB max for text, 10MB max for images to prevent infinite reads 
      // of pseudo-files (like in /proc or /sys) that report size 0
      const maxBytes = textPreview ? MAX_TEXT_PREVIEW_BYTES : 10 * 1024 * 1024
      const bytes = await readFileContents(singleSelectedEntry.path, mode, undefined, maxBytes)
      
      // Check if selection changed while downloading
      if (singleSelectedEntry.path !== pathOnStart) return

      if (imagePreview) {
        const blob = new Blob([bytes as any])
        const url = URL.createObjectURL(blob)
        previewObjectUrlRef.current = url
        setPreview({ loading: false, type: 'image', imageUrl: url })
        return
      }

      if (textPreview) {
        const text = new TextDecoder().decode(bytes)
        setPreview({ loading: false, type: 'text', content: text })
        return
      }

      setPreview({ loading: false, type: 'metadata' })
    } catch (error) {
      // Re-verify selection
      if (singleSelectedEntry.path !== pathOnStart) return
      
      setPreview({
        loading: false,
        type: 'metadata',
        error: toErrorMessage(error),
      })
    }
  }, [singleSelectedEntry, mode, t])

  const breadcrumbs = useMemo(() => {
    if (currentPath === '/') {
      return [{ label: '/', path: '/' }]
    }

    const result: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
    const parts = currentPath.split('/').filter(Boolean)
    let cursor = ''
    for (const part of parts) {
      cursor += `/${part}`
      result.push({ label: part, path: cursor })
    }
    return result
  }, [currentPath])

  const canGoUp = useMemo(() => {
    const parent = parentDir(currentPath)
    if (!parent || parent === currentPath) return false
    if (mode === 'user' && !isUserSpacePath(parent)) return false
    return true
  }, [currentPath, mode])

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortBy(key)
    setSortDir('asc')
  }

  const toggleSelected = (path: string) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path]
    )
  }

  const clearSelection = () => setSelectedPaths([])

  const handleOpenEntry = (entry: FileEntry) => {
    if (entry.kind === 'directory') {
      navigateTo(entry.path)
      return
    }

    if (selectedPaths.length === 1 && selectedPaths[0] === entry.path) {
      toggleSelected(entry.path)
      return
    }

    setSelectedPaths([entry.path])
  }

  const runOperation = async (
    operation: () => Promise<void>,
    successMessage?: string,
    logActivity?: { path: string; action: UserAction['action'] }
  ) => {
    setBusy(true)
    try {
      await operation()
      if (successMessage) {
        showToast({
          type: 'success',
          title: t('common.success'),
          message: successMessage,
        })
      }

      if (logActivity && user?.id && currentDeviceId && !isDemoMode) {
        await logUserAction(user.id, currentDeviceId, logActivity.path, logActivity.action).catch(() => { })
      }

      await loadCurrentDirectory(currentPath)
    } catch (error) {
      showToast({
        type: 'error',
        title: t('common.error'),
        message: toErrorMessage(error),
      })
    } finally {
      setBusy(false)
      setTransferProgress(null)
    }
  }

  const handleUploadPicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    const list = Array.from(files)
    await runOperation(async () => {
      for (const file of list) {
        const destinationPath = joinPath(currentPath, file.name)
        await uploadFile(file, currentPath, mode, (progress) => setTransferProgress(progress))
        if (user?.id && currentDeviceId && !isDemoMode) {
          await logUserAction(user.id, currentDeviceId, destinationPath, 'file_upload').catch(() => { })
        }
      }
    }, t('fileManager.uploadComplete', { count: list.length }))
  }

  const resetDragState = () => {
    dragDepthRef.current = 0
    setIsDragOver(false)
  }

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDragFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current += 1
    setIsDragOver(true)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDragFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDragFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsDragOver(false)
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDragFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()

    const files = e.dataTransfer.files
    resetDragState()
    if (!files || files.length === 0) return
    if (busy) return

    void handleUploadPicked(files)
  }



  const openDialog = (type: DialogType, paths: string[] = [], value = '') => {
    setDialog({ type, paths, value })
  }

  const closeDialog = () => setDialog({ type: 'none', paths: [], value: '' })

  const confirmDialog = async () => {
    const targets = dialog.paths.length > 0 ? dialog.paths : selectedPaths

    if (dialog.type === 'mkdir') {
      const fullPath = joinPath(currentPath, dialog.value.trim())
      await runOperation(
        async () => createDirectory(fullPath, mode),
        t('fileManager.operationSuccess'),
        { path: fullPath, action: 'file_mkdir' }
      )
      closeDialog()
      return
    }

    if (dialog.type === 'rename' && targets.length === 1) {
      const newName = dialog.value.trim()
      const newPath = joinPath(parentDir(targets[0]), newName)
      await runOperation(
        async () => renamePath(targets[0], newName, mode),
        t('fileManager.operationSuccess'),
        { path: newPath, action: 'file_rename' }
      )
      closeDialog()
      return
    }

    if (dialog.type === 'move') {
      const destDir = dialog.value.trim()
      await runOperation(
        async () => movePaths(targets, destDir, mode),
        t('fileManager.operationSuccess'),
        { path: `${targets.length} items to ${destDir}`, action: 'file_move' }
      )
      closeDialog()
      return
    }

    if (dialog.type === 'copy') {
      const destDir = dialog.value.trim()
      await runOperation(
        async () => copyPaths(targets, destDir, mode),
        t('fileManager.operationSuccess'),
        { path: `${targets.length} items to ${destDir}`, action: 'file_copy' }
      )
      closeDialog()
      return
    }

    if (dialog.type === 'delete') {
      await runOperation(
        async () => deletePaths(targets, mode),
        t('fileManager.operationSuccess'),
        { path: targets.join(', '), action: 'file_delete' }
      )
      closeDialog()
      setSelectedPaths([])
      return
    }

    if (dialog.type === 'chmod') {
      await runOperation(async () => {
        for (const path of targets) {
          await chmodPath(path, dialog.value.trim(), mode)
        }
      }, t('fileManager.operationSuccess'), { path: targets.join(', '), action: 'file_chmod' })
      closeDialog()
      return
    }

    if (dialog.type === 'chown') {
      await runOperation(async () => {
        for (const path of targets) {
          await chownPath(path, dialog.value.trim(), mode)
        }
      }, t('fileManager.operationSuccess'), { path: targets.join(', '), action: 'file_chown' })
      closeDialog()
      return
    }
  }

  const handlePaste = async () => {
    if (!clipboard || clipboard.paths.length === 0) return

    await runOperation(async () => {
      if (clipboard.op === 'copy') {
        await copyPaths(clipboard.paths, currentPath, mode)
      } else {
        await movePaths(clipboard.paths, currentPath, mode)
        setClipboard(null)
      }
    }, t('fileManager.operationSuccess'))
  }

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedSet.has(entry.path)),
    [entries, selectedSet]
  )

  if (!isConnected) {
    return (
      <div className="p-6 lg:p-8 max-w-5xl mx-auto terminal-spacer">
        <div className="rounded-2xl border border-surface-200 dark:border-white/10 bg-white/70 dark:bg-white/5 p-10 text-center text-surface-500">
          {t('fileManager.notConnected')}
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-[120rem] mx-auto terminal-spacer">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-surface-900 dark:text-white tracking-tight">
            {t('fileManager.title')}
          </h1>
          <p className="text-surface-500 mt-1">{t('fileManager.subtitle')}</p>
        </div>

        <div className="flex items-center gap-2">
          {hasRoot ? (
            <Button
              size="sm"
              variant={mode === 'root' ? 'danger' : 'secondary'}
              icon={mode === 'root' ? <ShieldAlert className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
              onClick={() => setMode((prev) => (prev === 'user' ? 'root' : 'user'))}
            >
              {mode === 'root' ? t('fileManager.modeRoot') : t('fileManager.modeUser')}
            </Button>
          ) : (
            <div className="text-xs text-surface-500">{t('fileManager.rootRequired')}</div>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-surface-200 dark:border-white/10 bg-white/70 dark:bg-white/5 backdrop-blur-xl p-3 sm:p-4 mb-4">
        <div className="flex overflow-x-auto no-scrollbar gap-2 items-center mb-3 pb-1">
          {breadcrumbs.map((crumb, index) => {
            const disabled = mode === 'user' && !isUserSpacePath(crumb.path)
            return (
              <div key={crumb.path} className="flex items-center shrink-0">
                {index > 0 && <span className="text-surface-300 dark:text-white/10 mx-1">/</span>}
                <button
                  onClick={() => !disabled && navigateTo(crumb.path)}
                  className={`text-xs sm:text-sm px-2 py-1.5 rounded-lg transition-colors ${disabled
                    ? 'text-surface-400 cursor-not-allowed'
                    : 'text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-white/10 font-medium'
                    }`}
                >
                  {index === 0 ? 'Root' : crumb.label}
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('fileManager.searchPlaceholder')}
            className="min-w-[150px] flex-1 h-10"
          />
          <div className="flex items-center gap-2 ml-auto">
            <Button
              size="sm"
              variant="secondary"
              className="h-10 w-10 sm:w-auto px-0 sm:px-3"
              icon={<RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />}
              onClick={() => loadCurrentDirectory(currentPath)}
              disabled={busy}
            >
              <span className="hidden sm:inline ml-2">{t('fileManager.refresh')}</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-10 w-10 sm:w-auto px-0 sm:px-3"
              icon={<Upload className="w-4 h-4" />}
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <span className="hidden sm:inline ml-2">{t('fileManager.upload')}</span>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-10 w-10 sm:w-auto px-0 sm:px-3"
              icon={<FolderPlus className="w-4 h-4" />}
              onClick={() => openDialog('mkdir')}
              disabled={busy}
            >
              <span className="hidden sm:inline ml-2">{t('fileManager.newFolder')}</span>
            </Button>
            {clipboard && (
              <Button
                size="sm"
                variant="secondary"
                className="h-10 w-10 sm:w-auto px-0 sm:px-3"
                icon={<ClipboardPaste className="w-4 h-4" />}
                onClick={handlePaste}
                disabled={busy}
              >
                <span className="hidden sm:inline ml-2">{t('fileManager.paste')}</span>
              </Button>
            )}
            <div className="h-6 w-px bg-surface-200 dark:bg-white/10 mx-1 hidden sm:block" />
            <Button
              size="sm"
              variant={viewMode === 'list' ? 'primary' : 'secondary'}
              className="h-10 w-10 px-0"
              icon={<List className="w-4 h-4" />}
              onClick={() => setViewMode('list')}
              disabled={busy}
            >
              {''}
            </Button>
            <Button
              size="sm"
              variant={viewMode === 'grid' ? 'primary' : 'secondary'}
              className="h-10 w-10 px-0"
              icon={<Grid3X3 className="w-4 h-4" />}
              onClick={() => setViewMode('grid')}
              disabled={busy}
            >
              {''}
            </Button>
          </div>
        </div>

        {/* ... input file remains ... */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => {
            void handleUploadPicked(e.target.files)
            e.currentTarget.value = ''
          }}
        />

        {transferProgress && (
          <div className="mt-3">
            <div className="text-[10px] sm:text-xs text-surface-500 mb-1.5 font-bold uppercase tracking-wider">
              {transferProgress.phase === 'preparing'
                ? t('fileManager.phasePreparing')
                : transferProgress.phase === 'transferring'
                  ? t('fileManager.phaseTransferring')
                  : t('fileManager.phaseFinalizing')
              } • {transferProgress.percent ?? 0}%
            </div>
            <div className="h-1.5 rounded-full bg-surface-200 dark:bg-white/10 overflow-hidden shadow-inner">
              <motion.div
                className="h-full bg-accent-500 shadow-[0_0_10px_rgba(var(--accent-500),0.3)]"
                animate={{ width: `${transferProgress.percent ?? 0}%` }}
                transition={{ duration: 0.15 }}
              />
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-32 text-surface-500 gap-4">
          <div className="w-10 h-10 border-3 border-accent-500 border-t-transparent rounded-full animate-spin" />
          <div className="text-sm font-medium tracking-wide animate-pulse uppercase">
            {t('common.loading')}
          </div>
        </div>
      ) : (
        <div className={`grid gap-6 items-start ${isMobile ? 'grid-cols-1' : 'grid-cols-[16rem_minmax(0,1fr)_22rem]'}`}>
          {!isMobile && (
            <div className="sticky top-24">
              <FileTreePane
                roots={roots}
                currentPath={currentPath}
                onNavigate={navigateTo}
                onGoUp={() => {
                  const parent = parentDir(currentPath)
                  if (parent && parent !== currentPath) {
                    navigateTo(parent)
                  }
                }}
                canGoUp={canGoUp}
                title={t('fileManager.roots')}
              />
            </div>
          )}

          <div
            className={`relative rounded-2xl transition-all ${isDragOver ? 'ring-2 ring-accent-500 bg-accent-500/5' : ''}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {isMobile && (
              <div className="flex overflow-x-auto no-scrollbar gap-2 mb-4 pb-1">
                {roots.map((root) => (
                  <button
                    key={root}
                    onClick={() => navigateTo(root)}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all shrink-0 border ${currentPath === root || currentPath.startsWith(`${root}/`)
                      ? 'bg-accent-500 border-accent-600 text-white shadow-lg shadow-accent-500/20'
                      : 'bg-white/70 dark:bg-white/5 text-surface-600 dark:text-surface-400 border-surface-200 dark:border-white/10'
                      }`}
                  >
                    {root}
                  </button>
                ))}
              </div>
            )}

            {isDragOver && (
              <div className="absolute inset-0 z-10 rounded-2xl border-2 border-dashed border-accent-500 bg-accent-500/10 flex items-center justify-center pointer-events-none backdrop-blur-[2px]">
                <div className="px-6 py-3 rounded-2xl bg-surface-900 border border-white/10 text-white text-sm font-bold shadow-2xl flex items-center gap-3">
                  <Upload className="w-5 h-5 animate-bounce" />
                  {t('fileManager.dropToUpload')}
                </div>
              </div>
            )}

            <FileListPane
              entries={shownEntries}
              selected={selectedSet}
              onToggleSelect={toggleSelected}
              onOpen={handleOpenEntry}
              viewMode={viewMode}
              sortBy={sortBy}
              sortDir={sortDir}
              onSortChange={toggleSort}
              labels={{
                name: t('fileManager.name'),
                type: t('fileManager.type'),
                size: t('fileManager.size'),
                modified: t('fileManager.modified'),
                noEntries: t('fileManager.noEntries'),
              }}
            />

            <div className="flex items-center gap-2 flex-wrap mt-4">
              <Button
                size="sm"
                variant="secondary"
                icon={<Pencil className="w-4 h-4" />}
                disabled={selectedPaths.length !== 1 || busy}
                onClick={() => openDialog('rename', selectedPaths, selectedEntries[0]?.name || '')}
              >
                {t('fileManager.rename')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<Move className="w-4 h-4" />}
                disabled={selectedPaths.length === 0 || busy}
                onClick={() => openDialog('move', selectedPaths, currentPath)}
              >
                {t('fileManager.move')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<CopyIcon className="w-4 h-4" />}
                disabled={selectedPaths.length === 0 || busy}
                onClick={() => openDialog('copy', selectedPaths, currentPath)}
              >
                {t('fileManager.copy')}
              </Button>

              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 className="w-4 h-4" />}
                disabled={selectedPaths.length === 0 || busy}
                onClick={() => openDialog('delete', selectedPaths)}
              >
                {t('fileManager.delete')}
              </Button>
            </div>
          </div>

          <FilePreviewPanel
            title="Informazioni File"
            emptyLabel={t('fileManager.noPreview')}
            loadingLabel={t('fileManager.previewLoading')}
            labels={{
              text: t('fileManager.previewText'),
              image: t('fileManager.previewImage'),
              metadata: t('fileManager.previewMetadata'),
              type: t('fileManager.type'),
              size: t('fileManager.size'),
              modified: t('fileManager.modified'),
              source: t('fileManager.source'),
            }}
            entry={singleSelectedEntry}
            preview={preview}
            loadLabel={t('fileManager.loadPreview')}
            onLoadPreview={handleLoadPreview}
            canPreview={canPreview}
            isMobile={isMobile}
            onCloseMobile={() => setSelectedPaths([])}
          />
        </div>
      )}

      <FileActionBar
        selectedCount={selectedPaths.length}
        selectedLabel={t('common.selected')}
        rootMode={mode === 'root'}
        labels={{

          copy: t('fileManager.copy'),
          cut: t('fileManager.cut'),
          chmod: t('fileManager.chmod'),
          chown: t('fileManager.chown'),
          delete: t('fileManager.delete'),
          clear: t('common.clear'),
        }}
        onClear={clearSelection}
        onDelete={() => openDialog('delete', selectedPaths)}
        onCopy={() => setClipboard({ op: 'copy', paths: selectedPaths })}
        onCut={() => setClipboard({ op: 'cut', paths: selectedPaths })}

        onChmod={() => openDialog('chmod', selectedPaths, '644')}
        onChown={() => openDialog('chown', selectedPaths, '0:0')}
      />

      <Modal
        isOpen={dialog.type !== 'none'}
        onClose={closeDialog}
        title={
          dialog.type === 'mkdir' ? t('fileManager.createFolderTitle') :
            dialog.type === 'rename' ? t('fileManager.renameTitle') :
              dialog.type === 'move' ? t('fileManager.moveTitle') :
                dialog.type === 'copy' ? t('fileManager.copyTitle') :
                  dialog.type === 'delete' ? t('fileManager.confirmDeleteTitle') :
                    dialog.type === 'chmod' ? t('fileManager.chmodTitle') :
                      dialog.type === 'chown' ? t('fileManager.chownTitle') : ''
        }
      >
        {mode === 'root' && dialog.type !== 'none' && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">
            {t('fileManager.rootDangerWarning')}
          </p>
        )}

        {dialog.type === 'delete' ? (
          <p className="text-sm text-surface-600 dark:text-surface-400">
            {t('fileManager.confirmDeleteMessage', { count: dialog.paths.length || selectedPaths.length })}
          </p>
        ) : (
          <Input
            value={dialog.value}
            onChange={(e) => setDialog((prev) => ({ ...prev, value: e.target.value }))}
            placeholder={
              dialog.type === 'mkdir' || dialog.type === 'rename' ? t('fileManager.fileName') :
                dialog.type === 'chmod' ? t('fileManager.modeBits') :
                  dialog.type === 'chown' ? t('fileManager.owner') : t('fileManager.targetPath')
            }
          />
        )}

        <ModalActions>
          <Button variant="ghost" onClick={closeDialog}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => void confirmDialog()}
            loading={busy}
            disabled={
              dialog.type !== 'delete' &&
              dialog.value.trim().length === 0
            }
          >
            {t('common.confirm')}
          </Button>
        </ModalActions>
      </Modal>
    </div>
  )
}
