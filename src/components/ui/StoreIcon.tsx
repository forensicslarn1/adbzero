import { useState, useEffect, memo } from 'react'
import { Package } from 'lucide-react'
import { getCachedIconUrl } from '@/services/store-icon-cache'

interface StoreIconProps {
  src: string | undefined | null
  alt?: string
  className?: string
  fallbackClassName?: string
}

export const StoreIcon = memo(function StoreIcon({
  src,
  alt = '',
  className = 'h-11 w-11 rounded-xl bg-surface-200 object-cover',
  fallbackClassName,
}: StoreIconProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!src) {
      setFailed(true)
      return
    }

    let revoked = false
    setFailed(false)
    setObjectUrl(null)

    getCachedIconUrl(src).then((url) => {
      if (revoked) {
        if (url) URL.revokeObjectURL(url)
        return
      }
      if (url) {
        setObjectUrl(url)
      } else {
        setFailed(true)
      }
    })

    return () => {
      revoked = true
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [src])

  if (failed || !objectUrl) {
    return (
      <div className={`${fallbackClassName ?? className} flex items-center justify-center dark:bg-white/10`}>
        <Package className="h-1/2 w-1/2 text-surface-400" />
      </div>
    )
  }

  return (
    <img
      src={objectUrl}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
})
