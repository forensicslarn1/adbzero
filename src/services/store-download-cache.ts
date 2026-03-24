const DB_NAME = 'adbzero_store_cache'
const DB_VERSION = 1
const APK_STORE = 'apk_artifacts'
const APK_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7
const APK_CACHE_MAX_ENTRIES = 24
const APK_CACHE_MAX_TOTAL_BYTES = 1024 * 1024 * 512
const APK_CACHE_MAX_ENTRY_BYTES = 1024 * 1024 * 200

export interface CachedRemoteArtifactSource {
  fileName: string
  downloadUrl: string
  sha256?: string
}

export interface CachedInstallArtifact {
  fileName: string
  bytes: Uint8Array
}

interface CachedArtifactRecord {
  key: string
  url: string
  fileName: string
  sha256?: string
  blob: Blob
  byteLength: number
  cachedAt: number
  expiresAt: number
  lastAccessedAt: number
}

let dbInstance: IDBDatabase | null = null

function normalizeSha256(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized || undefined
}

function getArtifactCacheKey(source: CachedRemoteArtifactSource): string {
  return normalizeSha256(source.sha256) || source.downloadUrl.trim()
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  if (dbInstance) return dbInstance

  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => resolve(null)
    request.onsuccess = () => {
      dbInstance = request.result
      resolve(dbInstance)
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(APK_STORE)) {
        db.createObjectStore(APK_STORE, { keyPath: 'key' })
      }
    }
  })
}

async function deleteRecord(key: string): Promise<void> {
  const db = await openDb()
  if (!db) return

  await new Promise<void>((resolve) => {
    const tx = db.transaction(APK_STORE, 'readwrite')
    tx.objectStore(APK_STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

async function readAllRecords(): Promise<CachedArtifactRecord[]> {
  const db = await openDb()
  if (!db) return []

  return new Promise((resolve) => {
    const tx = db.transaction(APK_STORE, 'readonly')
    const request = tx.objectStore(APK_STORE).getAll()
    request.onsuccess = () => resolve((request.result || []) as CachedArtifactRecord[])
    request.onerror = () => resolve([])
  })
}

async function touchRecord(record: CachedArtifactRecord): Promise<void> {
  const db = await openDb()
  if (!db) return

  await new Promise<void>((resolve) => {
    const tx = db.transaction(APK_STORE, 'readwrite')
    tx.objectStore(APK_STORE).put({
      ...record,
      lastAccessedAt: Date.now(),
    } satisfies CachedArtifactRecord)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

async function pruneCache(): Promise<void> {
  const records = await readAllRecords()
  if (records.length === 0) return

  const now = Date.now()
  const expired = records.filter((record) => record.expiresAt <= now)
  await Promise.all(expired.map((record) => deleteRecord(record.key)))

  let active = records.filter((record) => record.expiresAt > now)
  let totalBytes = active.reduce((sum, record) => sum + record.byteLength, 0)

  if (active.length <= APK_CACHE_MAX_ENTRIES && totalBytes <= APK_CACHE_MAX_TOTAL_BYTES) {
    return
  }

  const removable = [...active].sort((a, b) => {
    if (a.lastAccessedAt !== b.lastAccessedAt) return a.lastAccessedAt - b.lastAccessedAt
    return a.cachedAt - b.cachedAt
  })

  for (const record of removable) {
    if (active.length <= APK_CACHE_MAX_ENTRIES && totalBytes <= APK_CACHE_MAX_TOTAL_BYTES) {
      break
    }

    await deleteRecord(record.key)
    active = active.filter((item) => item.key !== record.key)
    totalBytes -= record.byteLength
  }
}

export async function getCachedRemoteArtifact(source: CachedRemoteArtifactSource): Promise<CachedInstallArtifact | null> {
  const db = await openDb()
  if (!db) return null

  const key = getArtifactCacheKey(source)
  const record = await new Promise<CachedArtifactRecord | null>((resolve) => {
    const tx = db.transaction(APK_STORE, 'readonly')
    const request = tx.objectStore(APK_STORE).get(key)
    request.onsuccess = () => resolve((request.result as CachedArtifactRecord | undefined) || null)
    request.onerror = () => resolve(null)
  })

  if (!record) return null
  if (record.expiresAt <= Date.now()) {
    await deleteRecord(record.key)
    return null
  }

  try {
    const bytes = new Uint8Array(await record.blob.arrayBuffer())
    const expectedSha256 = normalizeSha256(source.sha256)
    if (expectedSha256) {
      const actualSha256 = await sha256Hex(bytes)
      if (actualSha256 !== expectedSha256) {
        await deleteRecord(record.key)
        return null
      }
    }

    void touchRecord(record)
    return {
      fileName: source.fileName || record.fileName,
      bytes,
    }
  } catch {
    await deleteRecord(record.key)
    return null
  }
}

export async function cacheRemoteArtifact(
  source: CachedRemoteArtifactSource,
  artifact: CachedInstallArtifact,
): Promise<void> {
  if (artifact.bytes.length === 0 || artifact.bytes.length > APK_CACHE_MAX_ENTRY_BYTES) {
    return
  }

  const db = await openDb()
  if (!db) return

  const now = Date.now()
  const record: CachedArtifactRecord = {
    key: getArtifactCacheKey(source),
    url: source.downloadUrl,
    fileName: artifact.fileName,
    sha256: normalizeSha256(source.sha256),
    blob: new Blob([artifact.bytes], { type: 'application/vnd.android.package-archive' }),
    byteLength: artifact.bytes.length,
    cachedAt: now,
    expiresAt: now + APK_CACHE_TTL_MS,
    lastAccessedAt: now,
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(APK_STORE, 'readwrite')
    tx.objectStore(APK_STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })

  await pruneCache()
}
