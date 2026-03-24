import { Copy, Scissors, ShieldAlert, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface FileActionBarProps {
  selectedCount: number
  selectedLabel: string
  rootMode: boolean
  labels: {

    copy: string
    cut: string
    chmod: string
    chown: string
    delete: string
    clear: string
  }
  onClear: () => void
  onDelete: () => void
  onCopy: () => void
  onCut: () => void

  onChmod: () => void
  onChown: () => void
}

export function FileActionBar({
  selectedCount,
  selectedLabel,
  rootMode,
  labels,
  onClear,
  onDelete,
  onCopy,
  onCut,

  onChmod,
  onChown,
}: FileActionBarProps) {
  if (selectedCount === 0) return null

  return (
    <div className="sticky bottom-2 z-20 mt-4 rounded-2xl border border-surface-200 dark:border-white/10 bg-white/95 dark:bg-surface-900/95 backdrop-blur-xl p-3 shadow-elevated">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm font-medium text-surface-700 dark:text-surface-300">{selectedCount} {selectedLabel}</p>

        <div className="flex items-center gap-2 flex-wrap">

          <Button size="sm" variant="secondary" icon={<Copy className="w-4 h-4" />} onClick={onCopy}>
            {labels.copy}
          </Button>
          <Button size="sm" variant="secondary" icon={<Scissors className="w-4 h-4" />} onClick={onCut}>
            {labels.cut}
          </Button>

          {rootMode && (
            <>
              <Button size="sm" variant="secondary" icon={<ShieldAlert className="w-4 h-4" />} onClick={onChmod}>
                {labels.chmod}
              </Button>
              <Button size="sm" variant="secondary" icon={<ShieldAlert className="w-4 h-4" />} onClick={onChown}>
                {labels.chown}
              </Button>
            </>
          )}

          <Button size="sm" variant="danger" icon={<Trash2 className="w-4 h-4" />} onClick={onDelete}>
            {labels.delete}
          </Button>
          <Button size="sm" variant="ghost" icon={<X className="w-4 h-4" />} onClick={onClear}>
            {labels.clear}
          </Button>
        </div>
      </div>
    </div>
  )
}
