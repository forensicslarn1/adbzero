import { ChevronUp, FolderTree } from 'lucide-react'
import { motion } from 'framer-motion'

interface FileTreePaneProps {
  roots: string[]
  currentPath: string
  onNavigate: (path: string) => void
  onGoUp: () => void
  canGoUp: boolean
  title: string
}

export function FileTreePane({
  roots,
  currentPath,
  onNavigate,
  onGoUp,
  canGoUp,
  title,
}: FileTreePaneProps) {
  return (
    <aside className="rounded-2xl border border-surface-200/60 dark:border-white/10 bg-white/70 dark:bg-white/5 backdrop-blur-xl p-4">
      <div className="flex items-center gap-2 mb-4 text-surface-700 dark:text-surface-300">
        <FolderTree className="w-4 h-4" strokeWidth={1.5} />
        <span className="text-sm font-semibold">{title}</span>
      </div>

      <button
        disabled={!canGoUp}
        onClick={onGoUp}
        className="w-full flex items-center gap-2 px-3 py-2 mb-3 rounded-xl text-sm bg-surface-100 dark:bg-white/5 hover:bg-surface-200 dark:hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <ChevronUp className="w-4 h-4" strokeWidth={1.5} />
        ..
      </button>

      <div className="space-y-1">
        {roots.map((root) => {
          const active = currentPath === root || currentPath.startsWith(`${root}/`)
          return (
            <motion.button
              key={root}
              whileHover={{ x: 2 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => onNavigate(root)}
              className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-colors ${active
                ? 'bg-accent-500/10 text-accent-600 dark:text-accent-400'
                : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-white/5'
                }`}
            >
              {root}
            </motion.button>
          )
        })}
      </div>
    </aside>
  )
}
