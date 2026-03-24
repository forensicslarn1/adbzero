/**
 * Store Icon Cache
 * Fetches remote icons, resizes them via OffscreenCanvas/Canvas,
 * converts to WebP, and persists in IndexedDB for fast repeat loads.
 */

const DB_NAME = 'adbzero_icon_cache'
const DB_VERSION = 1
const STORE_NAME = 'icons'
const MAX_ICON_PX = 160          // max dimension (covers 80px @2x)
const WEBP_QUALITY = 0.82
const MAX_ENTRIES = 2000
const TTL_MS = 14 * 24 * 60 * 60 * 1000   // 14 days

interface CachedIcon {
  url: string
  blob: Blob
  ts: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'url' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function getFromDB(url: string): Promise<CachedIcon | undefined> {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(url)
    req.onsuccess = () => {
      const entry = req.result as CachedIcon | undefined
      if (entry && Date.now() - entry.ts < TTL_MS) {
        resolve(entry)
      } else {
        resolve(undefined)
      }
    }
    req.onerror = () => resolve(undefined)
  })
}

async function putToDB(entry: CachedIcon): Promise<void> {
  const db = await openDB()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

/** Evict oldest entries when over MAX_ENTRIES */
export async function evictStaleIcons(): Promise<void> {
  try {
    const db = await openDB()
    const all = await new Promise<CachedIcon[]>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req = store.getAll()
      req.onsuccess = () => resolve(req.result ?? [])
      req.onerror = () => resolve([])
    })

    const now = Date.now()
    const expired = all.filter((e) => now - e.ts >= TTL_MS)
    const toEvict =
      all.length - expired.length > MAX_ENTRIES
        ? all
            .filter((e) => now - e.ts < TTL_MS)
            .sort((a, b) => a.ts - b.ts)
            .slice(0, all.length - expired.length - MAX_ENTRIES)
        : []

    const deleteUrls = [...expired.map((e) => e.url), ...toEvict.map((e) => e.url)]
    if (deleteUrls.length === 0) return

    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const url of deleteUrls) store.delete(url)
  } catch {
    // best-effort
  }
}

// In-flight dedup map
const inflight = new Map<string, Promise<string | null>>()

/**
 * Returns an object-URL for a compressed/resized icon.
 * Uses IndexedDB cache for repeat visits.
 */
export async function getCachedIconUrl(remoteUrl: string): Promise<string | null> {
  if (!remoteUrl) return null

  // Check in-flight
  const pending = inflight.get(remoteUrl)
  if (pending) return pending

  const work = (async () => {
    try {
      // 1. Check IndexedDB cache
      const cached = await getFromDB(remoteUrl)
      if (cached) {
        return URL.createObjectURL(cached.blob)
      }

      // 2. Fetch remote image
      const resp = await fetch(remoteUrl, { mode: 'cors', credentials: 'omit' })
      if (!resp.ok) return null
      const srcBlob = await resp.blob()

      // 3. Resize + compress via Canvas
      const compressed = await compressIcon(srcBlob)

      // 4. Cache in IndexedDB
      await putToDB({ url: remoteUrl, blob: compressed, ts: Date.now() })

      return URL.createObjectURL(compressed)
    } catch {
      return null
    } finally {
      inflight.delete(remoteUrl)
    }
  })()

  inflight.set(remoteUrl, work)
  return work
}

async function compressIcon(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap

  // Calculate target size
  let tw = width
  let th = height
  if (tw > MAX_ICON_PX || th > MAX_ICON_PX) {
    const scale = MAX_ICON_PX / Math.max(tw, th)
    tw = Math.round(tw * scale)
    th = Math.round(th * scale)
  }

  // Use OffscreenCanvas if available, else fallback
  let resultBlob: Blob
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(tw, th)
    const ctx = oc.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, tw, th)
    resultBlob = await oc.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY })
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, tw, th)
    resultBlob = await new Promise<Blob>((resolve) => {
      canvas.toBlob(
        (b) => resolve(b ?? blob),
        'image/webp',
        WEBP_QUALITY
      )
    })
  }

  bitmap.close()

  // Only use compressed version if it's actually smaller
  return resultBlob.size < blob.size ? resultBlob : blob
}
