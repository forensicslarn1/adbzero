import { File, FileSymlink, Folder, ArrowDown, ArrowUp } from 'lucide-react'
import type { FileEntry } from '@/services/file-manager'

type SortKey = 'name' | 'kind' | 'size' | 'mtime'
type SortDir = 'asc' | 'desc'
type ViewMode = 'list' | 'grid'

interface HeaderLabels {
  name: string
  type: string
  size: string
  modified: string
  noEntries: string
}

interface FileListPaneProps {
  entries: FileEntry[]
  selected: Set<string>
  onToggleSelect: (path: string) => void
  onOpen: (entry: FileEntry) => void
  viewMode: ViewMode
  sortBy: SortKey
  sortDir: SortDir
  onSortChange: (key: SortKey) => void
  labels: HeaderLabels
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatMtime(timestamp: number): string {
  if (!timestamp) return '-'
  return new Date(timestamp * 1000).toLocaleString()
}

function EntryIcon({ kind }: { kind: FileEntry['kind'] }) {
  if (kind === 'directory') return <Folder className="w-4 h-4 text-blue-500" strokeWidth={1.6} />
  if (kind === 'link') return <FileSymlink className="w-4 h-4 text-amber-500" strokeWidth={1.6} />
  return <File className="w-4 h-4 text-surface-500" strokeWidth={1.6} />
}

export function FileListPane({
  entries,
  selected,
  onToggleSelect,
  onOpen,
  viewMode,
  sortBy,
  sortDir,
  onSortChange,
  labels,
}: FileListPaneProps) {
  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-surface-300 dark:border-white/10 p-10 text-center text-surface-500">
        {labels.noEntries}
      </div>
    )
  }

  const SortArrow = ({ keyName }: { keyName: SortKey }) => {
    if (sortBy !== keyName) return null
    return sortDir === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5" strokeWidth={2} />
      : <ArrowDown className="w-3.5 h-3.5" strokeWidth={2} />
  }

  if (viewMode === 'grid') {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {entries.map((entry) => {
          const isSelected = selected.has(entry.path)
          return (
            <button
              key={entry.path}
              onClick={() => onOpen(entry)}
              onContextMenu={(e) => {
                e.preventDefault()
                onToggleSelect(entry.path)
              }}
              className={`text-left rounded-2xl border p-3 sm:p-4 transition-all duration-200 active:scale-[0.98] ${isSelected
                ? 'border-accent-500 bg-accent-500/10 shadow-lg shadow-accent-500/5'
                : 'border-surface-200 dark:border-white/10 bg-white/70 dark:bg-white/5 hover:bg-surface-100 dark:hover:bg-white/10'
                }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 rounded-lg bg-surface-100 dark:bg-white/5">
                    <EntryIcon kind={entry.kind} />
                  </div>
                  <span className="truncate font-semibold text-surface-900 dark:text-white text-sm sm:text-base">{entry.name}</span>
                </div>
                <div className="pt-1">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelect(entry.path)}
                    onClick={(e) => e.stopPropagation()}
                    className="w-5 h-5 rounded-md border-surface-300 text-accent-600 focus:ring-accent-500"
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] text-surface-500 font-medium tracking-tight">
                <div className="uppercase">{entry.kind}</div>
                <div>{entry.kind === 'directory' ? '-' : formatBytes(entry.size)}</div>
              </div>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-surface-200 dark:border-white/10 overflow-hidden bg-white/70 dark:bg-white/5 backdrop-blur-xl shadow-sm">
      <div className="grid grid-cols-[2.5rem_1.6fr_hidden_hidden_hidden] sm:grid-cols-[3rem_1.6fr_0.8fr_0.8fr_1fr] gap-2 px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-surface-400 border-b border-surface-200 dark:border-white/10 bg-surface-50/50 dark:bg-white/[0.02]">
        <span />
        <button className="flex items-center gap-1.5 text-left hover:text-surface-700 dark:hover:text-surface-200 transition-colors" onClick={() => onSortChange('name')}>
          {labels.name}
          <SortArrow keyName="name" />
        </button>
        <button className="hidden sm:flex items-center gap-1.5 text-left hover:text-surface-700 dark:hover:text-surface-200 transition-colors" onClick={() => onSortChange('kind')}>
          {labels.type}
          <SortArrow keyName="kind" />
        </button>
        <button className="hidden sm:flex items-center gap-1.5 text-left hover:text-surface-700 dark:hover:text-surface-200 transition-colors" onClick={() => onSortChange('size')}>
          {labels.size}
          <SortArrow keyName="size" />
        </button>
        <button className="hidden sm:flex items-center gap-1.5 text-left hover:text-surface-700 dark:hover:text-surface-200 transition-colors" onClick={() => onSortChange('mtime')}>
          {labels.modified}
          <SortArrow keyName="mtime" />
        </button>
      </div>

      <div className="divide-y divide-surface-200 dark:divide-white/10">
        {entries.map((entry) => {
          const isSelected = selected.has(entry.path)
          return (
            <button
              key={entry.path}
              onClick={() => onOpen(entry)}
              className={`w-full grid grid-cols-[2.5rem_1fr] sm:grid-cols-[3rem_1.6fr_0.8fr_0.8fr_1fr] gap-2 px-4 py-3 sm:py-2.5 text-sm items-center text-left transition-all duration-200 ${isSelected
                ? 'bg-accent-500/15'
                : 'hover:bg-surface-100/80 dark:hover:bg-white/10'
                }`}
            >
              <div className="flex justify-center">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleSelect(entry.path)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-5 h-5 sm:w-4 sm:h-4 rounded border-surface-300 text-accent-600 focus:ring-accent-500"
                />
              </div>
              <span className="flex items-center gap-3 min-w-0">
                <div className="shrink-0 p-1.5 rounded-lg bg-surface-100 dark:bg-white/5 sm:bg-transparent">
                  <EntryIcon kind={entry.kind} />
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2 min-w-0">
                  <span className="truncate text-surface-900 dark:text-white font-medium sm:font-normal">{entry.name}</span>
                  <span className="sm:hidden text-[10px] text-surface-400 font-bold uppercase tracking-tighter">
                    {entry.kind === 'directory' ? 'Cartella' : formatBytes(entry.size)}
                  </span>
                </div>
              </span>
              <span className="hidden sm:inline text-surface-500 italic text-xs">{entry.kind}</span>
              <span className="hidden sm:inline text-surface-500 font-mono text-xs">{entry.kind === 'directory' ? '-' : formatBytes(entry.size)}</span>
              <span className="hidden sm:inline text-surface-500 truncate text-xs">{formatMtime(entry.mtime)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
