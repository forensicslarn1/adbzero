import { LinuxFileType } from '@yume-chan/adb'
import { Consumable, ReadableStream } from '@yume-chan/stream-extra'
import { useAdbStore } from '@/stores/adbStore'
import { escapeShellArg, validateFileName, validateFilePath } from './command-sanitizer'
import { getAdb, shell } from './adb-client'
import { cacheRemoteArtifact, getCachedRemoteArtifact } from './store-download-cache'

export type InstallBatchMode = 'separate' | 'together'
export type InstallProgressPhase =
  | 'preparing'
  | 'downloading'
  | 'uploading'
  | 'installing'
  | 'verifying'
  | 'complete'
  | 'error'

export interface InstallProgress {
  phase: InstallProgressPhase
  message: string
  percent?: number
  currentItem?: number
  totalItems?: number
  fileName?: string
  loadedBytes?: number
  totalBytes?: number
  aggregateLoadedBytes?: number
  aggregateTotalBytes?: number
}

export interface InstallArtifact {
  fileName: string
  bytes: Uint8Array
}

export interface RemoteInstallArtifact {
  fileName: string
  downloadUrl: string
  sha256?: string
  sizeBytes?: number
}

export interface InstallResult {
  success: boolean
  message: string
  fileName?: string
}

interface InstallSessionOptions {
  allowDowngrade?: boolean
}

const TEMP_ALLOWED_PREFIXES = ['/data/local/tmp/']
const SUPABASE_BASE_URL = String(import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/\/$/, '')
const STORE_FUNCTION_URL = SUPABASE_BASE_URL
  ? `${SUPABASE_BASE_URL}/functions/v1/store-fdroid-live`
  : ''
const SUPABASE_ANON_KEY = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()

function addInstallLog(command: string, success: boolean, message?: string) {
  useAdbStore.getState().addCommandLog({
    command,
    result: success ? 'success' : 'error',
    message,
  })
}

function toPercent(value: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.min(100, Math.round((value / total) * 100))
}

function createTempPath(fileName: string, index: number): string {
  const sanitized = validateFileName(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')
  return validateFilePath(
    `/data/local/tmp/adbzero_store_${Date.now()}_${index}_${sanitized}`,
    TEMP_ALLOWED_PREFIXES
  )
}

function createInstallName(fileName: string, index: number, total: number): string {
  const normalized = fileName.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
  if (total === 1) return 'base.apk'

  const lower = normalized.toLowerCase()
  if (lower === 'base.apk' || lower.startsWith('base_') || lower.startsWith('base-')) {
    return 'base.apk'
  }

  if (!lower.endsWith('.apk')) {
    return `split_${index + 1}.apk`
  }

  return normalized
}

function parseSessionId(stdout: string): string {
  const match = stdout.match(/\[(\d+)\]/) || stdout.match(/(\d+)/)
  if (!match) {
    throw new Error(`Unable to parse install session ID from: ${stdout}`)
  }
  return match[1]
}

function bytesToStream(
  bytes: Uint8Array,
  onProgress?: (loadedBytes: number, totalBytes: number) => void
): ReadableStream<Consumable<Uint8Array>> {
  const chunkSize = 64 * 1024
  let offset = 0

  return new ReadableStream<Consumable<Uint8Array>>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }

      const next = Math.min(offset + chunkSize, bytes.length)
      const chunk = bytes.subarray(offset, next)
      offset = next
      onProgress?.(offset, bytes.length)
      controller.enqueue(new Consumable(chunk))
    },
  })
}

async function withSync<T>(
  fn: (sync: Awaited<ReturnType<NonNullable<ReturnType<typeof getAdb>>['sync']>>) => Promise<T>
): Promise<T> {
  const adb = getAdb()
  if (!adb) {
    throw new Error('No connected device')
  }

  const sync = await adb.sync()
  try {
    return await fn(sync)
  } finally {
    await sync.dispose().catch(() => undefined)
  }
}

async function pushArtifactToTemp(
  artifact: InstallArtifact,
  tempPath: string,
  itemIndex: number,
  totalItems: number,
  onProgress?: (progress: InstallProgress) => void
): Promise<void> {
  addInstallLog(`sync write ${tempPath}`, true, `Uploading ${artifact.fileName}`)

  await withSync(async (sync) => {
    await sync.write({
      filename: tempPath,
      type: LinuxFileType.File,
      permission: 0o666,
      mtime: Math.trunc(Date.now() / 1000),
      file: bytesToStream(artifact.bytes, (loadedBytes, totalBytes) => {
        onProgress?.({
          phase: 'uploading',
          message: `Uploading ${artifact.fileName}`,
          percent: toPercent(loadedBytes, totalBytes),
          currentItem: itemIndex + 1,
          totalItems,
          fileName: artifact.fileName,
          loadedBytes,
          totalBytes,
        })
      }),
    })
  })
}

async function cleanupTempFiles(paths: string[]) {
  for (const path of paths) {
    await shell(`rm -f "${escapeShellArg(path)}"`).catch(() => undefined)
  }
}

async function createInstallSession(totalSize: number, options?: InstallSessionOptions): Promise<string> {
  const downgradeFlag = options?.allowDowngrade ? ' -d' : ''
  const result = await shell(`pm install-create -r${downgradeFlag} -S ${totalSize}`)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Unable to create install session')
  }

  return parseSessionId(result.stdout)
}

async function writeInstallSession(
  sessionId: string,
  artifacts: Array<{ artifact: InstallArtifact; tempPath: string }>
): Promise<void> {
  for (let i = 0; i < artifacts.length; i += 1) {
    const { artifact, tempPath } = artifacts[i]
    const installName = createInstallName(artifact.fileName, i, artifacts.length)
    const result = await shell(
      `pm install-write -S ${artifact.bytes.length} ${sessionId} "${escapeShellArg(installName)}" "${escapeShellArg(tempPath)}"`
    )

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr || result.stdout || `Unable to write ${artifact.fileName} to install session`
      )
    }
  }
}

async function commitInstallSession(sessionId: string): Promise<void> {
  const result = await shell(`pm install-commit ${sessionId}`)
  if (result.exitCode !== 0 || !result.stdout.toLowerCase().includes('success')) {
    throw new Error(result.stderr || result.stdout || 'Install commit failed')
  }
}

async function abandonInstallSession(sessionId: string) {
  await shell(`pm install-abandon ${sessionId}`).catch(() => undefined)
}

async function runInstallSession(
  artifacts: InstallArtifact[],
  onProgress?: (progress: InstallProgress) => void,
  options?: InstallSessionOptions,
): Promise<InstallResult> {
  if (artifacts.length === 0) {
    throw new Error('No APK artifacts provided')
  }

  const stagedArtifacts: Array<{ artifact: InstallArtifact; tempPath: string }> = []
  const tempPaths: string[] = []
  let sessionId: string | null = null

  try {
    onProgress?.({
      phase: 'preparing',
      message: 'Preparing install session',
      percent: 0,
      totalItems: artifacts.length,
    })

    for (let i = 0; i < artifacts.length; i += 1) {
      const artifact = artifacts[i]
      const tempPath = createTempPath(artifact.fileName, i)
      tempPaths.push(tempPath)
      await pushArtifactToTemp(artifact, tempPath, i, artifacts.length, onProgress)
      stagedArtifacts.push({ artifact, tempPath })
    }

    const totalSize = artifacts.reduce((sum, artifact) => sum + artifact.bytes.length, 0)
    onProgress?.({
      phase: 'installing',
      message: 'Creating Android install session',
      percent: 5,
      totalItems: artifacts.length,
    })

    sessionId = await createInstallSession(totalSize, options)

    onProgress?.({
      phase: 'installing',
      message: 'Writing APKs into install session',
      percent: 50,
      totalItems: artifacts.length,
    })

    await writeInstallSession(sessionId, stagedArtifacts)

    onProgress?.({
      phase: 'installing',
      message: 'Committing install session',
      percent: 85,
      totalItems: artifacts.length,
    })

    await commitInstallSession(sessionId)

    onProgress?.({
      phase: 'verifying',
      message: 'Verifying installed package state',
      percent: 95,
      totalItems: artifacts.length,
    })

    onProgress?.({
      phase: 'complete',
      message: artifacts.length > 1 ? 'APKs installed successfully' : `${artifacts[0].fileName} installed successfully`,
      percent: 100,
      totalItems: artifacts.length,
    })

    return {
      success: true,
      message: artifacts.length > 1 ? 'Multi-APK install completed successfully' : 'APK installed successfully',
      fileName: artifacts.length === 1 ? artifacts[0].fileName : undefined,
    }
  } catch (error) {
    if (sessionId) {
      await abandonInstallSession(sessionId)
    }

    const message = error instanceof Error ? error.message : 'Install failed'
    onProgress?.({
      phase: 'error',
      message,
      percent: 0,
      totalItems: artifacts.length,
    })

    throw error
  } finally {
    await cleanupTempFiles(tempPaths)
  }
}

async function downloadRemoteArtifact(
  source: RemoteInstallArtifact,
  onProgress?: (progress: InstallProgress) => void
): Promise<InstallArtifact> {
  const url = source.downloadUrl
  const fileName = source.fileName
  const cachedArtifact = await getCachedRemoteArtifact(source)
  if (cachedArtifact) {
    onProgress?.({
      phase: 'downloading',
      message: `Using cached ${fileName}`,
      percent: 100,
      fileName,
      loadedBytes: cachedArtifact.bytes.length,
      totalBytes: cachedArtifact.bytes.length,
    })
    addInstallLog(`cache ${url}`, true, `Reused cached ${fileName}`)
    return cachedArtifact
  }
  const candidates: Array<
    | { kind: 'direct'; value: string }
    | { kind: 'store-proxy'; value: string }
  > = [{ kind: 'direct', value: url }]

  try {
    const parsed = new URL(url)
    const canUseStoreProxy = (
      Boolean(STORE_FUNCTION_URL) &&
      parsed.protocol === 'https:' &&
      parsed.hostname === 'f-droid.org' &&
      parsed.pathname.startsWith('/repo/') &&
      parsed.pathname.toLowerCase().endsWith('.apk')
    )
    if (canUseStoreProxy) {
      candidates.push({ kind: 'store-proxy', value: STORE_FUNCTION_URL })
    }
  } catch {
    // Keep direct attempt; invalid URLs will fail below with a clear error.
  }
  let lastError: Error | null = null

  for (const candidate of candidates) {
    try {
      const response = candidate.kind === 'direct'
        ? await fetch(candidate.value)
        : await fetch(candidate.value, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : {}),
          },
          body: JSON.stringify({
            action: 'artifact',
            repoId: 'fdroid-official',
            downloadUrl: url,
          }),
        })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      if (!response.body) {
        throw new Error('Empty response body')
      }

      const totalBytes = parseInt(response.headers.get('content-length') || '0', 10) || undefined
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let loadedBytes = 0

      onProgress?.({
        phase: 'downloading',
        message: `Downloading ${fileName}`,
        percent: 0,
        fileName,
        loadedBytes: 0,
        totalBytes,
      })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        chunks.push(value)
        loadedBytes += value.length
        onProgress?.({
          phase: 'downloading',
          message: `Downloading ${fileName}`,
          percent: totalBytes ? toPercent(loadedBytes, totalBytes) : undefined,
          fileName,
          loadedBytes,
          totalBytes,
        })
      }

      const bytes = new Uint8Array(loadedBytes)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }

      if (source.sha256) {
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        const actualSha256 = Array.from(new Uint8Array(digest))
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')

        if (actualSha256 !== source.sha256.toLowerCase()) {
          throw new Error(`SHA-256 mismatch for ${fileName}`)
        }
      }

      const artifact = { fileName, bytes }
      void cacheRemoteArtifact(source, artifact)
      addInstallLog(
        `download ${url}`,
        true,
        candidate.kind === 'direct'
          ? `Downloaded ${fileName}`
          : `Downloaded ${fileName} via Store proxy`
      )
      return artifact
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  addInstallLog(`download ${url}`, false, lastError?.message || 'Download failed')
  throw lastError || new Error('Download failed')
}

export async function installLocalApkFiles(
  files: File[],
  mode: InstallBatchMode = 'separate',
  onProgress?: (progress: InstallProgress) => void
): Promise<InstallResult[]> {
  if (files.length === 0) {
    return []
  }

  const artifacts = await Promise.all(
    files.map(async (file) => ({
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    }))
  )

  if (mode === 'together' || artifacts.length === 1) {
    const result = await runInstallSession(artifacts, onProgress)
    return [result]
  }

  const results: InstallResult[] = []

  for (let i = 0; i < artifacts.length; i += 1) {
    const artifact = artifacts[i]
    try {
      const result = await runInstallSession([artifact], (progress) => {
        onProgress?.({
          ...progress,
          currentItem: i + 1,
          totalItems: artifacts.length,
          fileName: artifact.fileName,
          message: progress.message,
        })
      })
      results.push(result)
    } catch (error) {
      results.push({
        success: false,
        message: error instanceof Error ? error.message : 'Install failed',
        fileName: artifact.fileName,
      })
    }
  }

  return results
}

export async function installRemoteApkArtifact(
  url: string,
  fileName: string,
  onProgress?: (progress: InstallProgress) => void,
  options?: InstallSessionOptions,
): Promise<InstallResult> {
  const artifact = await downloadRemoteArtifact({ downloadUrl: url, fileName }, onProgress)
  return runInstallSession([artifact], onProgress, options)
}

export async function installRemoteApkArtifacts(
  sources: RemoteInstallArtifact[],
  onProgress?: (progress: InstallProgress) => void,
  options?: InstallSessionOptions,
): Promise<InstallResult> {
  if (sources.length === 0) {
    throw new Error('No remote APK artifacts provided')
  }

  const artifacts: InstallArtifact[] = []
  const aggregateTotalBytes = sources.every((source) => typeof source.sizeBytes === 'number' && source.sizeBytes > 0)
    ? sources.reduce((sum, source) => sum + (source.sizeBytes || 0), 0)
    : undefined
  let aggregateLoadedBytes = 0

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i]
    const artifact = await downloadRemoteArtifact(source, (progress) => {
      onProgress?.({
        ...progress,
        currentItem: i + 1,
        totalItems: sources.length,
        aggregateLoadedBytes: aggregateLoadedBytes + (progress.loadedBytes || 0),
        aggregateTotalBytes,
      })
    })
    artifacts.push(artifact)
    aggregateLoadedBytes += artifact.bytes.length
  }

  return runInstallSession(artifacts, onProgress, options)
}

