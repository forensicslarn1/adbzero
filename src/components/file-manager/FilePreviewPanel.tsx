import { FileText, Image as ImageIcon, Info, Eye, Clock, HardDrive, FileQuestion } from 'lucide-react'
import type { FileEntry } from '@/services/file-manager'
import { Button } from '@/components/ui/Button'

type PreviewType = 'none' | 'text' | 'image' | 'metadata'

export interface PreviewState {
  loading: boolean
  type: PreviewType
  content?: string
  imageUrl?: string
  error?: string
}

interface FilePreviewPanelProps {
  title: string
  emptyLabel: string
  loadingLabel: string
  loadLabel: string
  labels: {
    text: string
    image: string
    metadata: string
    type: string
    size: string
    modified: string
    source: string
  }
  entry: FileEntry | null
  preview: PreviewState
  onLoadPreview?: () => void
  canPreview?: boolean
  isMobile?: boolean
  onCloseMobile?: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function FilePreviewPanel({
  title,
  emptyLabel,
  loadingLabel,
  loadLabel,
  labels,
  entry,
  preview,
  onLoadPreview,
  canPreview,
  isMobile,
  onCloseMobile
}: FilePreviewPanelProps) {
  if (!entry && isMobile) return null

  const content = (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <h3 className="font-semibold text-surface-900 dark:text-white truncate">{title}</h3>
          <div className="text-xs text-surface-500 break-all bg-surface-100 dark:bg-white/5 p-2 rounded-lg border border-surface-200/50 dark:border-white/5">
            {entry?.path}
          </div>
        </div>
        {isMobile && onCloseMobile && (
          <Button variant="secondary" size="sm" onClick={onCloseMobile} className="shrink-0">
            Chiudi
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {/* Main Details Card */}
        <div className="rounded-xl border border-surface-200/60 dark:border-white/10 bg-white/50 dark:bg-white/5 p-4 space-y-3 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent-500/10 text-accent-600 dark:text-accent-400">
              {entry?.kind === 'directory' ? <HardDrive className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <div className="font-bold text-surface-900 dark:text-white truncate text-base">{entry?.name}</div>
              <div className="text-xs text-surface-500 uppercase tracking-wider font-medium">{entry?.kind}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2">
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase text-surface-400 font-bold">{labels.size}</div>
              <div className="text-sm text-surface-700 dark:text-surface-200">
                {entry?.kind === 'directory' ? '-' : formatBytes(entry?.size || 0)}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase text-surface-400 font-bold">{labels.type}</div>
              <div className="text-sm text-surface-700 dark:text-surface-200 flex items-center gap-1.5">
                <FileQuestion className="w-3.5 h-3.5 opacity-50" />
                {entry?.kind}
              </div>
            </div>
          </div>

          <div className="pt-2 border-t border-surface-200/50 dark:border-white/5 space-y-2">
            <div className="flex items-center gap-2 text-xs text-surface-500">
              <Clock className="w-3.5 h-3.5" />
              <span>{labels.modified}:</span>
              <span className="text-surface-700 dark:text-surface-200">
                {entry ? new Date(entry.mtime * 1000).toLocaleString() : '-'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-surface-500">
              <Info className="w-3.5 h-3.5" />
              <span>{labels.source}:</span>
              <span className="text-surface-700 dark:text-surface-200 px-1.5 py-0.5 rounded-md bg-surface-200 dark:bg-white/10 text-[10px] font-bold">
                {entry?.source}
              </span>
            </div>
          </div>
        </div>

        {/* Preview Actions & Content */}
        <div className="space-y-3">
          {preview.loading && (
            <div className="flex items-center justify-center p-8 rounded-xl bg-surface-100/50 dark:bg-black/20 animate-pulse">
              <div className="flex flex-col items-center gap-3">
                <div className="w-6 h-6 border-2 border-accent-500 border-t-transparent rounded-full animate-spin" />
                <div className="text-xs text-surface-500 font-medium">{loadingLabel}</div>
              </div>
            </div>
          )}

          {!preview.loading && !preview.error && preview.type === 'metadata' && canPreview && (
            <Button 
              size="lg" 
              variant="primary" 
              className="w-full gap-2 shadow-lg shadow-accent-500/10 py-6"
              onClick={onLoadPreview}
            >
              <Eye className="w-5 h-5" />
              {loadLabel}
            </Button>
          )}

          {!preview.loading && preview.error && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20">
              <div className="text-sm text-red-500 font-bold mb-1">Errore</div>
              <div className="text-xs text-red-400 leading-relaxed">{preview.error}</div>
            </div>
          )}

          {!preview.loading && !preview.error && preview.type === 'image' && preview.imageUrl && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-surface-600 dark:text-surface-400 font-bold text-xs uppercase tracking-tight">
                <ImageIcon className="w-4 h-4" />
                {labels.image}
              </div>
              <div className="p-2 rounded-xl bg-black/40 border border-white/5">
                <img src={preview.imageUrl} alt={entry?.name} className="max-w-full rounded-lg shadow-2xl mx-auto" />
              </div>
            </div>
          )}

          {!preview.loading && !preview.error && preview.type === 'text' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-surface-600 dark:text-surface-400 font-bold text-xs uppercase tracking-tight">
                <FileText className="w-4 h-4" />
                {labels.text}
              </div>
              <div className="relative">
                <pre className="whitespace-pre-wrap break-words text-[11px] font-mono p-4 rounded-xl bg-surface-900 text-surface-200 max-h-[60vh] overflow-auto border border-white/10 leading-relaxed custom-scrollbar">
                  {preview.content || ''}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm p-4 flex items-end sm:items-center justify-center animate-in fade-in duration-200">
        <div className="bg-surface-50 dark:bg-surface-900 w-full max-w-lg rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl max-h-[90vh] overflow-auto animate-in slide-in-from-bottom duration-300">
          {content}
        </div>
      </div>
    )
  }

  return (
    <aside className="sticky top-24 w-full rounded-2xl border border-surface-200/60 dark:border-white/10 bg-white/70 dark:bg-white/5 backdrop-blur-xl p-5 max-h-[calc(100vh-8rem)] overflow-auto shadow-sm custom-scrollbar">
      {entry ? content : <div className="text-sm text-surface-500 text-center py-10 italic">{emptyLabel}</div>}
    </aside>
  )
}
