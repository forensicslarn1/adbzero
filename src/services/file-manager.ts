import { LinuxFileType, type AdbSyncEntry } from '@yume-chan/adb'
import { Consumable, ReadableStream } from '@yume-chan/stream-extra'
import { useAdbStore } from '@/stores/adbStore'
import { getAdb, shell, acquireAdbLock } from './adb-client'
import {
  escapeShellArg,
  validateChmodMode,
  validateFileName,
  validateFilePath,
  validateOwnerGroup,
} from './command-sanitizer'

export type FileManagerMode = 'user' | 'root'
export type FileEntryKind = 'file' | 'directory' | 'link' | 'other'

export interface FileEntry {
  name: string
  path: string
  kind: FileEntryKind
  size: number
  mtime: number
  mode?: number
  uid?: number
  gid?: number
  writable: boolean
  readable: boolean
  source: 'sync' | 'shell-root'
}

export interface TransferProgress {
  phase: 'preparing' | 'transferring' | 'finalizing'
  loadedBytes: number
  totalBytes?: number
  percent?: number
}

const USER_ALLOWED_PREFIXES = [
  '/sdcard',
  '/sdcard/',
  '/storage',
  '/storage/',
  '/data/local/tmp',
  '/data/local/tmp/',
]

const ROOT_ALLOWED_PREFIXES = ['/']

const PROTECTED_ROOT_PATHS = [
  '/',
  '/system',
  '/vendor',
  '/product',
  '/apex',
  '/data',
  '/proc',
  '/sys',
  '/dev',
  '/mnt',
]

function addSyncLog(command: string, ok: boolean, message?: string) {
  useAdbStore.getState().addCommandLog({
    command,
    result: ok ? 'success' : 'error',
    message,
  })
}

function pathAllowedInUserMode(path: string): boolean {
  return (
    path === '/sdcard' ||
    path.startsWith('/sdcard/') ||
    path === '/storage' ||
    path.startsWith('/storage/') ||
    path === '/data/local/tmp' ||
    path.startsWith('/data/local/tmp/')
  )
}

function validatePathForMode(path: string, mode: FileManagerMode): string {
  return validateFilePath(
    path,
    mode === 'user' ? USER_ALLOWED_PREFIXES : ROOT_ALLOWED_PREFIXES
  )
}

function ensureNotProtectedRootPath(path: string) {
  if (PROTECTED_ROOT_PATHS.includes(path)) {
    throw new Error(`Operation blocked on protected path: ${path}`)
  }
}

function ensureNotProtectedForDestructive(paths: string[], mode: FileManagerMode) {
  if (mode !== 'root') return
  paths.forEach((path) => ensureNotProtectedRootPath(path))
}

export function parentDir(path: string): string {
  if (path === '/') return '/'
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

function baseName(path: string): string {
  if (path === '/') return '/'
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

export function joinPath(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  return `${dir.replace(/\/+$/g, '')}/${name}`
}

function inferKindFromSyncEntry(entry: AdbSyncEntry): FileEntryKind {
  if (entry.type === LinuxFileType.Directory) return 'directory'
  if (entry.type === LinuxFileType.File) return 'file'
  if (entry.type === LinuxFileType.Link) return 'link'
  return 'other'
}

function inferKindFromShellToken(token: string): FileEntryKind {
  if (token === 'directory') return 'directory'
  if (token === 'file') return 'file'
  if (token === 'link') return 'link'
  return 'other'
}

function percent(loaded: number, total?: number): number | undefined {
  if (!total || total <= 0) return undefined
  return Math.min(100, Math.round((loaded / total) * 100))
}

function bytesToStream(
  bytes: Uint8Array,
  onProgress?: (loadedBytes: number, totalBytes: number) => void
): ReadableStream<Consumable<Uint8Array>> {
  const chunkSize = 64 * 1024
  let offset = 0
  let lastProgress = 0
  return new ReadableStream<Consumable<Uint8Array>>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }

      const next = Math.min(offset + chunkSize, bytes.length)
      const chunk = bytes.subarray(offset, next)
      offset = next
      
      const now = Date.now()
      if (now - lastProgress > 100 || offset === bytes.length) {
        lastProgress = now
        onProgress?.(offset, bytes.length)
      }
      
      controller.enqueue(new Consumable(chunk))
    },
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage = 'Operation timed out'): Promise<T> {
  let timeoutId: NodeJS.Timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), ms)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId!)
  }
}

async function withSync<T>(
  fn: (sync: Awaited<ReturnType<NonNullable<ReturnType<typeof getAdb>>['sync']>>) => Promise<T>,
  timeoutMs: number = 45000
): Promise<T> {
  const adb = getAdb()
  if (!adb) {
    throw new Error('No connected device')
  }

  const sync = await adb.sync()
  try {
    return timeoutMs > 0 
      ? await withTimeout(fn(sync), timeoutMs, 'ADB Sync operation timed out')
      : await fn(sync)
  } finally {
    await withTimeout(sync.dispose(), 5000, 'ADB Sync dispose timed out').catch(() => undefined)
  }
}

async function executeShellCommand(command: string, mode: FileManagerMode): Promise<string> {
  const wrapped = mode === 'root'
    ? `su -c "${escapeShellArg(command)}"`
    : command

  const result = await withTimeout(shell(wrapped), 30000, `Shell command timed out: ${command}`)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Shell command failed')
  }
  return result.stdout
}

async function listDirectoryWithSync(path: string): Promise<FileEntry[]> {
  const commandLabel = `sync ls ${path}`
  try {
    const entries = await withSync(async (sync) => {
      const results = await sync.readdir(path)
      return results
    })
    addSyncLog(commandLabel, true, `Listed ${entries.length} items`)
    return entries.filter((entry) => entry.name !== '.' && entry.name !== '..')
      .map((entry) => {
        const entryMode = typeof entry.mode === 'number' ? entry.mode : undefined
        return {
          name: entry.name,
          path: joinPath(path, entry.name),
          kind: inferKindFromSyncEntry(entry),
          size: Number(entry.size || 0),
          mtime: Number(entry.mtime || 0),
          mode: entryMode,
          writable: entryMode !== undefined ? (entryMode & 0o200) !== 0 : true,
          readable: entryMode !== undefined ? (entryMode & 0o400) !== 0 : true,
          source: 'sync',
        } satisfies FileEntry
      })
  } catch (error) {
    addSyncLog(commandLabel, false, error instanceof Error ? error.message : 'List failed')
    throw error
  }
}

function decodeBase64Utf8(input: string): string {
  try {
    const binary = atob(input)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return input
  }
}

async function listDirectoryWithRootShell(path: string): Promise<FileEntry[]> {
  const script = [
    `target="${escapeShellArg(path)}"`,
    '[ -d "$target" ] || exit 1',
    'for item in "$target"/* "$target"/.[!.]* "$target"/..?*; do',
    '  [ -e "$item" ] || continue',
    '  name=$(basename "$item")',
    '  kind="other"',
    '  [ -d "$item" ] && kind="directory"',
    '  [ -f "$item" ] && kind="file"',
    '  [ -L "$item" ] && kind="link"',
    '  size=$(stat -c %s "$item" 2>/dev/null || echo 0)',
    '  mtime=$(stat -c %Y "$item" 2>/dev/null || echo 0)',
    '  mode_hex=$(stat -c %f "$item" 2>/dev/null || echo 0)',
    '  uid=$(stat -c %u "$item" 2>/dev/null || echo 0)',
    '  gid=$(stat -c %g "$item" 2>/dev/null || echo 0)',
    '  name_b64=$(printf "%s" "$name" | base64 | tr -d "\\n")',
    '  echo "$name_b64|$kind|$size|$mtime|$mode_hex|$uid|$gid"',
    'done',
  ].join('; ')

  const result = await shell(`su -c "${escapeShellArg(script)}"`)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Unable to list directory')
  }

  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line) => {
    const [nameB64, kindRaw, sizeRaw, mtimeRaw, modeHexRaw, uidRaw, gidRaw] = line.split('|')
    const name = decodeBase64Utf8(nameB64 || '')
    const mode = parseInt(modeHexRaw || '0', 16)
    return {
      name,
      path: joinPath(path, name),
      kind: inferKindFromShellToken(kindRaw || ''),
      size: Number(sizeRaw || 0),
      mtime: Number(mtimeRaw || 0),
      mode: Number.isFinite(mode) ? mode : undefined,
      uid: Number(uidRaw || 0),
      gid: Number(gidRaw || 0),
      writable: Number.isFinite(mode) ? (mode & 0o200) !== 0 : true,
      readable: Number.isFinite(mode) ? (mode & 0o400) !== 0 : true,
      source: 'shell-root',
    }
  })
}




/**
 * Shell-based binary download in Medium Chunks.
 * Instead of continuous streaming (which buffers WebUSB to death) or 32KB chunks 
 * (which spawns thousands of shell processes crashing adbd), this downloads in safe 2MB chunks.
 * 2MB chunks = ~2.6MB base64 output per shell call.
 * This is fast, won't clog WebUSB buffers, and only requires a few processes per file.
 */
async function readFileWithShell(
  remotePath: string,
  mode: FileManagerMode,
  onProgress?: (progress: TransferProgress) => void,
  maxBytes?: number
): Promise<Uint8Array> {
  const releaseAdbLock = await acquireAdbLock()

  try {
    let total: number | undefined
    try {
      const sizeCmd = mode === 'root'
        ? `su -c "stat -c %s '${escapeShellArg(remotePath)}'"`
        : `stat -c %s "${escapeShellArg(remotePath)}"`
      const sizeResult = await withTimeout(shell(sizeCmd), 10_000, 'stat timed out')
      if (sizeResult.exitCode === 0) {
        total = parseInt(sizeResult.stdout.trim(), 10)
        if (isNaN(total) || total <= 0) total = undefined
      }
    } catch {
      total = undefined
    }

    const effectiveMax = maxBytes ?? total ?? undefined
    onProgress?.({ phase: 'preparing', loadedBytes: 0, totalBytes: effectiveMax, percent: percent(0, effectiveMax) })

    // 2MB chunks. Big enough to be fast, small enough to not run out of memory.
    const CHUNK_SIZE = 2 * 1024 * 1024 
    const chunks: Uint8Array[] = []
    let loaded = 0

    while (true) {
      if (effectiveMax && loaded >= effectiveMax) break



      // Use `dd` safely with `ifunc=skip,count` using bs=1 for exact bytes
      // To improve `dd` speed, we tell it bs=1048576 (1MB) when possible, but for safe arbitrary chunks we just stick to dd offsets.
      // Alternatively, reading chunks by blocks: (bs=CHUNK_SIZE skip=Index) since we only want 2MB jumps.
      const blockIndex = Math.floor(loaded / CHUNK_SIZE)
      
      const cmd = mode === 'root'
        ? `su -c "dd if='${escapeShellArg(remotePath)}' bs=${CHUNK_SIZE} skip=${blockIndex} count=1 2>/dev/null | base64"`
        : `dd if="${escapeShellArg(remotePath)}" bs=${CHUNK_SIZE} skip=${blockIndex} count=1 2>/dev/null | base64`

      // 60-second timeout allows very slow devices (like watches) to base64-encode 2MB
      const result: { exitCode: number; stdout: string; stderr?: string } = await withTimeout(shell(cmd), 60_000, 'Chunk download timed out')

      const b64Text = result.stdout.replace(/[\s\r\n]/g, '')

      if (b64Text.length === 0) {
        if (result.exitCode === 0) break // EOF properly reached
        throw new Error(`ADB Shell crashed unexpectedly: ${result.stderr}`)
      }

      const bin = Uint8Array.from(atob(b64Text), c => c.charCodeAt(0))
      chunks.push(bin)
      loaded += bin.length

      onProgress?.({
        phase: 'transferring',
        loadedBytes: loaded,
        totalBytes: effectiveMax,
        percent: percent(loaded, effectiveMax),
      })

      // Less bytes returned than requested block size? It's EOF.
      if (bin.length < CHUNK_SIZE) break
      
      // Small pause to prevent choking the device's CPU back-to-back
      await new Promise(r => setTimeout(r, 100))
    }

    if (loaded === 0 && total !== 0) {
      throw new Error('Download produced 0 bytes — file may be unreadable or connection dropped')
    }

    if (total && !maxBytes && loaded < total) {
      throw new Error(`Download incomplete: got ${loaded} of ${total} bytes (${Math.round(loaded / total * 100)}%)`)
    }

    const output = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.length
    }

    const data = maxBytes ? output.subarray(0, maxBytes) : output
    onProgress?.({ phase: 'finalizing', loadedBytes: data.length, totalBytes: effectiveMax, percent: 100 })
    addSyncLog(`shell read ${remotePath}`, true, `Read ${data.length} bytes in 2MB chunks`)
    return data
    
  } finally {
    releaseAdbLock()
  }
}


function generateTempPath(prefix: string): string {
  return `/data/local/tmp/adbzero_${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
}

async function writeFileWithSync(
  remotePath: string,
  bytes: Uint8Array,
  onProgress?: (progress: TransferProgress) => void
): Promise<void> {
  await withSync(async (sync) => {
    onProgress?.({
      phase: 'preparing',
      loadedBytes: 0,
      totalBytes: bytes.length,
      percent: percent(0, bytes.length),
    })

    await sync.write({
      filename: remotePath,
      type: LinuxFileType.File,
      permission: 0o666,
      mtime: Math.trunc(Date.now() / 1000),
      file: bytesToStream(bytes, (loadedBytes, totalBytes) => {
        onProgress?.({
          phase: 'transferring',
          loadedBytes,
          totalBytes,
          percent: percent(loadedBytes, totalBytes),
        })
      }),
    })

    onProgress?.({
      phase: 'finalizing',
      loadedBytes: bytes.length,
      totalBytes: bytes.length,
      percent: 100,
    })
  }, 0)
}

export async function checkRootCapability(): Promise<boolean> {
  const result = await shell('su -c "id"')
  return result.exitCode === 0 && result.stdout.includes('uid=0')
}

export async function listDirectory(path: string, mode: FileManagerMode): Promise<FileEntry[]> {
  const safePath = validatePathForMode(path, mode)

  if (mode === 'root' && !pathAllowedInUserMode(safePath)) {
    return listDirectoryWithRootShell(safePath)
  }

  try {
    return await listDirectoryWithSync(safePath)
  } catch (error) {
    if (mode === 'root') {
      return listDirectoryWithRootShell(safePath)
    }
    throw error
  }
}

export async function uploadFile(
  localFile: File,
  targetDir: string,
  mode: FileManagerMode,
  onProgress?: (progress: TransferProgress) => void
): Promise<void> {
  const safeDir = validatePathForMode(targetDir, mode)
  const safeFileName = validateFileName(localFile.name)
  const destinationPath = validatePathForMode(joinPath(safeDir, safeFileName), mode)
  const fileBytes = new Uint8Array(await localFile.arrayBuffer())
  const commandLabel = `sync write ${destinationPath}`

  try {
    if (mode === 'root' && !pathAllowedInUserMode(safeDir)) {
      const tempPath = validateFilePath(generateTempPath('upload'), USER_ALLOWED_PREFIXES)
      await writeFileWithSync(tempPath, fileBytes, onProgress)

      try {
        await executeShellCommand(
          `cp "${escapeShellArg(tempPath)}" "${escapeShellArg(destinationPath)}"`,
          'root'
        )
      } finally {
        await executeShellCommand(`rm -f "${escapeShellArg(tempPath)}"`, 'root').catch(() => undefined)
      }
    } else {
      await writeFileWithSync(destinationPath, fileBytes, onProgress)
    }

    addSyncLog(commandLabel, true, `Uploaded ${safeFileName}`)
  } catch (error) {
    addSyncLog(commandLabel, false, error instanceof Error ? error.message : 'Upload failed')
    throw error
  }
}

export async function readFileContents(
  remotePath: string,
  mode: FileManagerMode,
  onProgress?: (progress: TransferProgress) => void,
  maxBytes?: number
): Promise<Uint8Array> {
  const safePath = validatePathForMode(remotePath, mode)
  const commandLabel = `read ${safePath}`

  // For root paths outside user space, copy to temp first
  if (mode === 'root' && !pathAllowedInUserMode(safePath)) {
    const tempPath = validateFilePath(generateTempPath('download'), USER_ALLOWED_PREFIXES)

    try {
      await executeShellCommand(
        `cp "${escapeShellArg(safePath)}" "${escapeShellArg(tempPath)}"`,
        'root'
      )
      await executeShellCommand(
        `chown shell:shell "${escapeShellArg(tempPath)}" && chmod 644 "${escapeShellArg(tempPath)}"`,
        'root'
      )
      const data = await readFileWithShell(tempPath, 'user', onProgress, maxBytes)
      addSyncLog(commandLabel, true, `Downloaded ${baseName(safePath)} (root)`)
      return data
    } finally {
      await executeShellCommand(`rm -f "${escapeShellArg(tempPath)}"`, 'root').catch(() => undefined)
    }
  }

  // Use shell-based download directly (sync protocol is unreliable over WebUSB)
  try {
    const data = await readFileWithShell(safePath, mode, onProgress, maxBytes)
    addSyncLog(commandLabel, true, `Downloaded ${baseName(safePath)}`)
    return data
  } catch (error) {
    addSyncLog(commandLabel, false, error instanceof Error ? error.message : 'Download failed')
    throw error
  }
}



export async function createDirectory(path: string, mode: FileManagerMode): Promise<void> {
  const safePath = validatePathForMode(path, mode)
  await executeShellCommand(`mkdir -p "${escapeShellArg(safePath)}"`, mode)
}

export async function renamePath(path: string, newName: string, mode: FileManagerMode): Promise<void> {
  const safePath = validatePathForMode(path, mode)
  ensureNotProtectedForDestructive([safePath], mode)

  const safeName = validateFileName(newName)
  const targetPath = validatePathForMode(joinPath(parentDir(safePath), safeName), mode)

  await executeShellCommand(
    `mv -f "${escapeShellArg(safePath)}" "${escapeShellArg(targetPath)}"`,
    mode
  )
}

export async function movePaths(paths: string[], targetDir: string, mode: FileManagerMode): Promise<void> {
  if (paths.length === 0) return

  const safeTargetDir = validatePathForMode(targetDir, mode)
  const safePaths = paths.map((path) => validatePathForMode(path, mode))
  ensureNotProtectedForDestructive(safePaths, mode)

  for (const sourcePath of safePaths) {
    const destPath = validatePathForMode(joinPath(safeTargetDir, baseName(sourcePath)), mode)
    await executeShellCommand(
      `mv -f "${escapeShellArg(sourcePath)}" "${escapeShellArg(destPath)}"`,
      mode
    )
  }
}

export async function copyPaths(paths: string[], targetDir: string, mode: FileManagerMode): Promise<void> {
  if (paths.length === 0) return

  const safeTargetDir = validatePathForMode(targetDir, mode)
  const safePaths = paths.map((path) => validatePathForMode(path, mode))

  for (const sourcePath of safePaths) {
    const destPath = validatePathForMode(joinPath(safeTargetDir, baseName(sourcePath)), mode)
    await executeShellCommand(
      `cp -R "${escapeShellArg(sourcePath)}" "${escapeShellArg(destPath)}"`,
      mode
    )
  }
}

export async function deletePaths(paths: string[], mode: FileManagerMode): Promise<void> {
  if (paths.length === 0) return

  const safePaths = paths.map((path) => validatePathForMode(path, mode))
  ensureNotProtectedForDestructive(safePaths, mode)

  for (const path of safePaths) {
    await executeShellCommand(`rm -rf "${escapeShellArg(path)}"`, mode)
  }
}

export async function chmodPath(path: string, modeBits: string, mode: FileManagerMode): Promise<void> {
  const safePath = validatePathForMode(path, mode)
  const safeModeBits = validateChmodMode(modeBits)
  await executeShellCommand(`chmod ${safeModeBits} "${escapeShellArg(safePath)}"`, mode)
}

export async function chownPath(path: string, owner: string, mode: FileManagerMode): Promise<void> {
  const safePath = validatePathForMode(path, mode)
  const safeOwner = validateOwnerGroup(owner)
  await executeShellCommand(`chown ${safeOwner} "${escapeShellArg(safePath)}"`, mode)
}
