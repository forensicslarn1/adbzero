/**
 * ADB Client Service
 * Manages WebUSB connection with Android devices.
 */

import { Adb, AdbDaemonTransport } from '@yume-chan/adb'
import { AdbDaemonWebUsbDeviceManager, AdbDaemonWebUsbDevice } from '@yume-chan/adb-daemon-webusb'
import AdbWebCredentialStore from '@yume-chan/adb-credential-web'
import {
  validatePackageName,
  validateFilePath,
  validateIntegerValue,
  validatePermission,
  validateAppOp,
  escapeShellArg
} from './command-sanitizer'

const credentialStore = new AdbWebCredentialStore('ADBZero')

let deviceManager: AdbDaemonWebUsbDeviceManager | undefined
let currentAdb: Adb | undefined

export type CommandListener = (command: string, result: ShellResult) => void
const commandListeners = new Set<CommandListener>()

export function addCommandListener(listener: CommandListener) {
  commandListeners.add(listener)
}

export function removeCommandListener(listener: CommandListener) {
  commandListeners.delete(listener)
}

export interface DeviceInfo {
  model: string
  manufacturer: string
  androidVersion: string
  apiLevel: string
  supportedAbis?: string[]
  serialNumber: string
  batteryLevel: number
  batteryStatus: string
  screenResolution: string
  screenDensity: string
  isRooted: boolean
}

export interface PackageInfo {
  packageName: string
  apkPath: string
  isEnabled: boolean
  isSystem: boolean
  versionCode?: number | null
  versionName?: string | null
}

export interface UserInfo {
  id: number
  name: string
  flags: number
  isManaged: boolean
  isRunning: boolean
}

export interface ShellResult {
  exitCode: number
  stdout: string
  stderr?: string
}

export interface PackageVersionInfo {
  versionCode: number | null
  versionName: string | null
}

export interface PackageInstallSourceInfo {
  installerPackageName: string | null
  installingPackageName: string | null
  initiatingPackageName: string | null
  originatingPackageName: string | null
}

export interface DeviceInstallProfile {
  apiLevel: number | null
  supportedAbis: string[]
}

export async function initializeAdbManager(): Promise<boolean> {
  if (!navigator.usb) {
    console.error('WebUSB not supported in this browser')
    return false
  }

  try {
    deviceManager = new AdbDaemonWebUsbDeviceManager(navigator.usb)
    return true
  } catch (error) {
    console.error('ADB manager init error:', error)
    return false
  }
}

export async function connectDevice(onStatusChange?: (status: 'authorizing') => void): Promise<Adb | null> {
  if (!deviceManager) {
    const initialized = await initializeAdbManager()
    if (!initialized) {
      if (!window.isSecureContext) throw new Error('HTTPS_REQUIRED')
      if (!navigator.usb) throw new Error('WEBUSB_NOT_SUPPORTED')
      throw new Error('ADB_INIT_FAILED')
    }
  }

  try {
    const device = await deviceManager!.requestDevice()
    if (!device) return null

    const connection = await device.connect()
    onStatusChange?.('authorizing')

    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore,
    })

    const adb = new Adb(transport)
    currentAdb = adb
    return adb
  } catch (error) {
    console.error('Device connect error:', error)
    currentAdb = undefined
    throw error
  }
}

export async function disconnectDevice(): Promise<void> {
  if (currentAdb) {
    try {
      await currentAdb.close()
    } catch (error) {
      console.error('ADB close error:', error)
    }
  }

  currentAdb = undefined
}

export function isDeviceConnected(): boolean {
  return currentAdb !== undefined
}

export function getAdb(): Adb | undefined {
  return currentAdb
}

// Global ADB Lock to prevent WebUSB socket crashes when commands run concurrently
let adbLock: Promise<void> = Promise.resolve()

export async function shell(command: string): Promise<ShellResult> {
  if (!currentAdb) {
    throw new Error('No connected device')
  }

  // Sequentially queue all shell commands to prevent WebUSB choking
  const releaseLock = await acquireAdbLock()

  try {
    if (!currentAdb.subprocess || !currentAdb.subprocess.shellProtocol) {
      throw new Error('ADB Shell Protocol not supported')
    }

    const { stdout, stderr, exitCode } = await currentAdb.subprocess.shellProtocol.spawnWaitText(command)
    const result: ShellResult = { exitCode, stdout, stderr }
    commandListeners.forEach((listener) => listener(command, result))
    return result
  } catch (error) {
    console.error('Shell command error:', error)
    const result: ShellResult = {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Unknown error',
    }
    commandListeners.forEach((listener) => listener(command, result))
    return result
  } finally {
    releaseLock()
  }
}

/**
 * Helper to queue promises sequentially
 */
export async function acquireAdbLock(): Promise<() => void> {
  let release: () => void = () => {}
  const nextLock = new Promise<void>((resolve) => {
    release = resolve
  })

  const previousLock = adbLock
  adbLock = adbLock.then(() => nextLock)
  await previousLock
  
  return release
}

/**
 * Spawns a shell command and returns the whole process so we can read its stdout stream.
 * Useful for transferring large continuous data safely without out-of-memory errors
 * or spawning hundreds of subcommands.
 */
export async function spawnStream(command: string) {
  if (!currentAdb) {
    throw new Error('No connected device')
  }
  if (!currentAdb.subprocess || !currentAdb.subprocess.shellProtocol) {
    throw new Error('ADB Shell Protocol not supported')
  }

  // NOTE: We DO NOT release this lock immediately because the stream remains open 
  // and actively using the ADB connection. The caller MUST release it when done!
  // To avoid changing the signature everywhere, for spawnStream we actually 
  // CANNOT easily lock the entirety of the stream reading without a custom wrapper.
  // Instead, the most destructive parallel behavior is prevented by locking `shell()`.
  // However, `pm` commands running while stream is open might still crash WebUSB.
  // We'll trust the Mutex in `shell()` to queue `pm` commands *behind* other shell commands.
  
  return await currentAdb.subprocess.shellProtocol.spawn(command)
}

async function checkRootAccess(): Promise<boolean> {
  try {
    const result = await shell('su -c id')
    return result.exitCode === 0 && result.stdout.includes('uid=0(root)')
  } catch {
    return false
  }
}

export async function getDeviceInfo(): Promise<DeviceInfo> {
  const props = await Promise.all([
    shell('getprop ro.product.model'),
    shell('getprop ro.product.manufacturer'),
    shell('getprop ro.build.version.release'),
    shell('getprop ro.build.version.sdk'),
    shell('getprop ro.product.cpu.abilist'),
    shell('getprop ro.serialno'),
    shell('cat /sys/class/power_supply/battery/capacity 2>/dev/null || echo 0'),
    shell('cat /sys/class/power_supply/battery/status 2>/dev/null || echo Unknown'),
    shell('wm size'),
    shell('wm density'),
    checkRootAccess(),
  ])

  const sizeMatch = props[8].stdout.match(/(\d+x\d+)/)
  const densityMatch = props[9].stdout.match(/(\d+)/)

  return {
    model: props[0].stdout.trim() || 'Unknown',
    manufacturer: props[1].stdout.trim() || 'Unknown',
    androidVersion: props[2].stdout.trim() || 'Unknown',
    apiLevel: props[3].stdout.trim() || 'Unknown',
    supportedAbis: props[4].stdout.trim()
      ? props[4].stdout.split(',').map((value) => value.trim()).filter(Boolean)
      : [],
    serialNumber: props[5].stdout.trim() || 'Unknown',
    batteryLevel: parseInt(props[6].stdout, 10) || 0,
    batteryStatus: props[7].stdout.trim() || 'Unknown',
    screenResolution: sizeMatch ? sizeMatch[1] : 'Unknown',
    screenDensity: densityMatch ? densityMatch[1] : 'Unknown',
    isRooted: props[10] as boolean,
  }
}

export async function getDeviceInstallProfile(): Promise<DeviceInstallProfile> {
  const [sdkResult, abiResult] = await Promise.all([
    shell('getprop ro.build.version.sdk'),
    shell('getprop ro.product.cpu.abilist'),
  ])

  return {
    apiLevel: parseInt(sdkResult.stdout.trim(), 10) || null,
    supportedAbis: abiResult.stdout
      .trim()
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

export async function listPackages(): Promise<PackageInfo[]> {
  let result = await shell('pm list packages -f -u --show-versioncode')
  let hasVersionCodes = result.exitCode === 0

  if (result.exitCode !== 0) {
    result = await shell('pm list packages -f -u')
    if (result.exitCode !== 0) {
      throw new Error('Unable to load package list')
    }
  }

  const packages: PackageInfo[] = []
  const lines = result.stdout.split('\n').filter((line) => line.trim())

  for (const line of lines) {
    if (!line.startsWith('package:')) continue

    let content = line.slice('package:'.length)
    let versionCode: number | null = null

    if (hasVersionCodes) {
      const versionCodeMatch = content.match(/\s+versionCode:(\d+)\s*$/)
      if (versionCodeMatch) {
        versionCode = parseInt(versionCodeMatch[1], 10)
        content = content.slice(0, versionCodeMatch.index).trimEnd()
      } else {
        hasVersionCodes = false
      }
    }

    const lastEqualsIndex = content.lastIndexOf('=')
    if (lastEqualsIndex === -1) continue

    const apkPath = content.slice(0, lastEqualsIndex)
    const packageName = content.slice(lastEqualsIndex + 1).trim()

    if (!packageName || packageName.includes('/') || packageName.includes('==')) {
      continue
    }

    const isSystem = apkPath.startsWith('/system/') ||
      apkPath.startsWith('/product/') ||
      apkPath.startsWith('/vendor/') ||
      apkPath.startsWith('/apex/')

    packages.push({
      packageName,
      apkPath,
      isEnabled: true,
      isSystem,
      versionCode,
      versionName: null,
    })
  }

  const disabledResult = await shell('pm list packages -d')
  const disabledPackages = new Set(
    disabledResult.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => line.replace('package:', '').trim())
  )

  const installedResult = await shell('pm list packages')
  const installedPackages = new Set(
    installedResult.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => line.replace('package:', '').trim())
  )

  for (const pkg of packages) {
    const isDisabled = disabledPackages.has(pkg.packageName)
    const isUninstalled = !installedPackages.has(pkg.packageName)
    pkg.isEnabled = !isDisabled && !isUninstalled
  }

  return filterGhostPackages(packages)
}

export async function getPackageVersionInfo(packageName: string): Promise<PackageVersionInfo> {
  const safeName = validatePackageName(packageName)
  const result = await shell(`dumpsys package ${safeName}`)

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Unable to inspect package')
  }

  const versionCodeMatch = result.stdout.match(/versionCode=(\d+)/)
  const versionNameMatch = result.stdout.match(/versionName=([^\s]+)/)

  return {
    versionCode: versionCodeMatch ? parseInt(versionCodeMatch[1], 10) : null,
    versionName: versionNameMatch ? versionNameMatch[1] : null,
  }
}

function normalizeInstallSourceValue(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.trim()
  if (!normalized || normalized === 'null' || normalized === 'none') return null
  return normalized
}

function extractInstallSourceValue(output: string, key: string): string | null {
  const regex = new RegExp(`${key}=([^\\s]+)`, 'i')
  const match = output.match(regex)
  return normalizeInstallSourceValue(match ? match[1] : null)
}

function parseInstallSourceOutput(output: string): PackageInstallSourceInfo {
  const parsed: PackageInstallSourceInfo = {
    installerPackageName: extractInstallSourceValue(output, 'installerPackageName'),
    installingPackageName: extractInstallSourceValue(output, 'installingPackageName'),
    initiatingPackageName: extractInstallSourceValue(output, 'initiatingPackageName'),
    originatingPackageName: extractInstallSourceValue(output, 'originatingPackageName'),
  }

  if (
    !parsed.installerPackageName &&
    !parsed.installingPackageName &&
    !parsed.initiatingPackageName &&
    !parsed.originatingPackageName
  ) {
    const installedBy = output.match(/installed by\s+([^\s]+)/i)
    if (installedBy) {
      parsed.installerPackageName = normalizeInstallSourceValue(installedBy[1])
    }
  }

  return parsed
}

export async function getPackageInstallSource(packageName: string): Promise<PackageInstallSourceInfo> {
  const safeName = validatePackageName(packageName)

  const primary = await shell(`cmd package get-install-source ${safeName}`)
  if (primary.exitCode === 0) {
    const parsed = parseInstallSourceOutput(`${primary.stdout}\n${primary.stderr || ''}`)
    if (
      parsed.installerPackageName ||
      parsed.installingPackageName ||
      parsed.initiatingPackageName ||
      parsed.originatingPackageName
    ) {
      return parsed
    }
  }

  const fallback = await shell(`dumpsys package ${safeName}`)
  if (fallback.exitCode !== 0) {
    throw new Error(fallback.stderr || fallback.stdout || 'Unable to inspect package install source')
  }

  return parseInstallSourceOutput(fallback.stdout)
}

async function filterGhostPackages(packages: PackageInfo[]): Promise<PackageInfo[]> {
  // Rather than running `pm path` 300 times (which kills ADB), we assume a package is physical
  // if it's found in either the default list (`pm list packages`) or if we can query it.
  // The fastest way to filter is to just try getting a 3rd party package list and ensuring
  // everything behaves consistently. WebUSB doesn't survive aggressive polling.
  
  // Ghost filtering disabled/reduced in strictness to prevent connection crashes.
  return packages
}

export async function disablePackage(packageName: string): Promise<ShellResult> {
  const safeName = validatePackageName(packageName)
  const disableResult = await shell(`pm disable-user --user 0 ${safeName}`)

  if (
    disableResult.exitCode === 0 &&
    !disableResult.stdout.includes('SecurityException') &&
    !disableResult.stdout.includes('Cannot disable')
  ) {
    return disableResult
  }

  const uninstallResult = await shell(`pm uninstall -k --user 0 ${safeName}`)
  if (uninstallResult.exitCode === 0 || uninstallResult.stdout.includes('Success')) {
    return {
      exitCode: 0,
      stdout: `[Fallback: uninstall] ${uninstallResult.stdout}`.trim(),
      stderr: uninstallResult.stderr,
    }
  }

  return {
    exitCode: 1,
    stdout: disableResult.stdout,
    stderr: `Neither disable nor uninstall worked. Disable: ${disableResult.stdout} | Uninstall: ${uninstallResult.stdout || uninstallResult.stderr}`,
  }
}

export async function enablePackage(packageName: string): Promise<ShellResult> {
  const safeName = validatePackageName(packageName)
  const enableResult = await shell(`pm enable ${safeName}`)

  if (enableResult.exitCode === 0 && enableResult.stdout.includes('new state')) {
    return enableResult
  }

  const installResult = await shell(`pm install-existing ${safeName}`)
  if (installResult.exitCode === 0 || installResult.stdout.includes('installed')) {
    return {
      exitCode: 0,
      stdout: `[Reinstall] ${installResult.stdout}`.trim(),
      stderr: installResult.stderr,
    }
  }

  return {
    exitCode: 1,
    stdout: enableResult.stdout,
    stderr: `Enable: ${enableResult.stdout} | Install-existing: ${installResult.stdout || installResult.stderr}`,
  }
}

export async function uninstallPackage(
  packageName: string,
  options?: { keepData?: boolean }
): Promise<ShellResult> {
  const safeName = validatePackageName(packageName)
  const keepDataFlag = options?.keepData ? ' -k' : ''
  return shell(`pm uninstall${keepDataFlag} --user 0 ${safeName}`)
}

export async function uninstallPackageRoot(packageName: string, apkPath: string): Promise<ShellResult> {
  const safeName = validatePackageName(packageName)
  const safePath = validateFilePath(apkPath, ['/system/', '/product/', '/vendor/', '/apex/', '/data/app/'])

  try {
    await shell('su -c "mount -o rw,remount /"')
    await shell('su -c "mount -o rw,remount /system"')
    await shell('su -c "mount -o rw,remount /product"')
    await shell('su -c "mount -o rw,remount /vendor"')

    const parentDir = safePath.slice(0, safePath.lastIndexOf('/'))
    let removeCmd = `rm -rf "${escapeShellArg(safePath)}"`

    if (!['/system/app', '/system/priv-app', '/product/app', '/product/priv-app', '/vendor/app'].includes(parentDir)) {
      removeCmd = `rm -rf "${escapeShellArg(parentDir)}"`
    }

    const removeResult = await shell(`su -c "${removeCmd}"`)
    const uninstallResult = await shell(`su -c "pm uninstall ${safeName}"`)

    if (removeResult.exitCode === 0 || uninstallResult.exitCode === 0) {
      return {
        exitCode: 0,
        stdout: `Root removal executed. rm=${removeResult.exitCode}, pm=${uninstallResult.stdout}`,
        stderr: uninstallResult.stderr,
      }
    }

    return {
      exitCode: 1,
      stdout: uninstallResult.stdout,
      stderr: `Root uninstall failed: ${removeResult.stderr || ''} ${uninstallResult.stderr || ''}`.trim(),
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Unknown root error',
    }
  }
}

export async function reinstallPackage(packageName: string): Promise<ShellResult> {
  const safeName = validatePackageName(packageName)
  return shell(`pm install-existing ${safeName}`)
}

export async function setScreenResolution(width: number, height: number): Promise<ShellResult> {
  const safeWidth = validateIntegerValue(width, 240, 7680, 'Screen width')
  const safeHeight = validateIntegerValue(height, 240, 7680, 'Screen height')
  return shell(`wm size ${safeWidth}x${safeHeight}`)
}

export async function setScreenDensity(density: number): Promise<ShellResult> {
  const safeDensity = validateIntegerValue(density, 72, 960, 'Screen density')
  return shell(`wm density ${safeDensity}`)
}

export async function resetScreenSettings(): Promise<void> {
  await shell('wm size reset')
  await shell('wm density reset')
}

export async function grantPermission(packageName: string, permission: string): Promise<ShellResult> {
  const safeName = validatePackageName(packageName)
  const safePerm = validatePermission(permission)
  return shell(`pm grant ${safeName} ${safePerm}`)
}

export async function revokePermission(packageName: string, permission: string): Promise<ShellResult> {
  const safeName = validatePackageName(packageName)
  const safePerm = validatePermission(permission)
  return shell(`pm revoke ${safeName} ${safePerm}`)
}

export async function setAppOps(packageName: string, op: string, mode: 'allow' | 'deny' | 'default'): Promise<ShellResult> {
  const safeName = validatePackageName(packageName)
  const safeOp = validateAppOp(op)
  return shell(`appops set ${safeName} ${safeOp} ${mode}`)
}

export async function getAuthorizedDevices(): Promise<AdbDaemonWebUsbDevice[]> {
  if (!deviceManager) {
    await initializeAdbManager()
  }

  if (!deviceManager) return []

  try {
    return await deviceManager.getDevices()
  } catch {
    return []
  }
}

export async function reconnectDevice(device: AdbDaemonWebUsbDevice): Promise<Adb | null> {
  try {
    const connection = await device.connect()

    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore,
    })

    const adb = new Adb(transport)
    currentAdb = adb
    return adb
  } catch (error) {
    console.error('Reconnect error:', error)
    currentAdb = undefined
    return null
  }
}

export async function pushFile(
  data: Uint8Array,
  remotePath: string,
  onProgress?: (progress: number) => void
): Promise<void> {
  if (!currentAdb) throw new Error('No connected device')

  const safePath = validateFilePath(remotePath, ['/data/local/tmp/', '/sdcard/', '/storage/'])

  onProgress?.(0.1)

  let binaryString = ''
  const chunkFullSize = 8192
  for (let i = 0; i < data.length; i += chunkFullSize) {
    const chunk = data.subarray(i, i + chunkFullSize)
    binaryString += String.fromCharCode.apply(null, Array.from(chunk))
  }
  const base64 = btoa(binaryString)

  onProgress?.(0.3)

  const chunkSize = 50000
  const chunks = Math.ceil(base64.length / chunkSize)

  if (chunks === 1) {
    await shell(`echo "${base64}" | base64 -d > "${escapeShellArg(safePath)}"`)
  } else {
    await shell(`> "${escapeShellArg(safePath)}"`)
    for (let i = 0; i < chunks; i++) {
      const chunk = base64.slice(i * chunkSize, (i + 1) * chunkSize)
      await shell(`echo "${chunk}" | base64 -d >> "${escapeShellArg(safePath)}"`)
      onProgress?.(0.3 + (0.6 * (i + 1) / chunks))
    }
  }

  onProgress?.(1)
}

export async function pullFile(remotePath: string): Promise<Uint8Array> {
  if (!currentAdb) throw new Error('No connected device')

  const safePath = validateFilePath(remotePath)
  const result = await shell(`base64 "${escapeShellArg(safePath)}"`)

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to read file')
  }

  const binaryString = atob(result.stdout.trim())
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  return bytes
}

export async function fileExists(remotePath: string): Promise<boolean> {
  const safePath = validateFilePath(remotePath)
  const result = await shell(`[ -f "${escapeShellArg(safePath)}" ] && echo "exists" || echo "not found"`)
  return result.stdout.includes('exists')
}

export async function createDirectory(remotePath: string): Promise<ShellResult> {
  const safePath = validateFilePath(remotePath, ['/data/local/tmp/', '/sdcard/', '/storage/'])
  return shell(`mkdir -p "${escapeShellArg(safePath)}"`)
}

export async function installApk(
  data: Uint8Array,
  onProgress?: (progress: number) => void
): Promise<ShellResult> {
  const tempPath = `/data/local/tmp/app_install_${Date.now()}.apk`

  try {
    await pushFile(data, tempPath, onProgress)
    const result = await shell(`pm install -r "${tempPath}"`)
    await shell(`rm "${tempPath}"`)
    return result
  } catch (error) {
    await shell(`rm "${tempPath}"`).catch(() => undefined)
    throw error
  }
}

export async function listUsers(): Promise<UserInfo[]> {
  const result = await shell('pm list users')
  if (result.exitCode !== 0) return []

  const users: UserInfo[] = []
  const lines = result.stdout.split('\n')

  for (const line of lines) {
    const match = line.match(/UserInfo\{(\d+):([^:]+):([0-9a-fA-F]+)\}(?:\s+(running))?/)
    if (!match) continue

    const id = parseInt(match[1], 10)
    const name = match[2]
    const flags = parseInt(match[3], 16)
    const isRunning = Boolean(match[4])
    const isManaged = (flags & 0x00000020) !== 0

    users.push({ id, name, flags, isManaged, isRunning })
  }

  return users
}

export async function createManagedProfile(name: string = 'ClonedApps'): Promise<number | null> {
  const safeName = name.replace(/[^a-zA-Z0-9 ]/g, '')
  const result = await shell(`pm create-user --profileOf 0 --managed "${safeName}"`)

  if (result.exitCode === 0) {
    const match = result.stdout.match(/created user id (\d+)/)
    if (match) return parseInt(match[1], 10)
  }

  return null
}

export async function startUser(userId: number): Promise<boolean> {
  const result = await shell(`am start-user ${userId}`)
  return result.exitCode === 0
}

export async function removeUser(userId: number): Promise<boolean> {
  const result = await shell(`pm remove-user ${userId}`)
  return result.exitCode === 0
}

export type SetupProgressCallback = (progress: {
  phase: 'settings' | 'scanning' | 'debloating' | 'done'
  message: string
  currentPkg?: string
  current?: number
  total?: number
  removed?: number
  kept?: number
}) => void

export async function setupManagedProfile(
  userId: number,
  onProgress?: SetupProgressCallback
): Promise<{
  success: boolean
  debloatStats: { removed: number; kept: number; failed: number; failedPackages: string[] }
}> {
  onProgress?.({ phase: 'settings', message: 'Configuring profile settings...' })
  const res1 = await shell(`settings put --user ${userId} secure user_setup_complete 1`)

  onProgress?.({ phase: 'settings', message: 'Enabling sideload permissions...' })
  const res2 = await shell(`settings put --user ${userId} secure install_non_market_apps 1`)

  onProgress?.({ phase: 'settings', message: 'Finalizing provisioning...' })
  const res3 = await shell(`settings put --user ${userId} global device_provisioned 1`)

  const debloatStats = await debloatManagedProfile(userId, onProgress)

  onProgress?.({
    phase: 'done',
    message: 'Profile ready!',
    removed: debloatStats.removed,
    kept: debloatStats.kept,
  })

  return {
    success: res1.exitCode === 0 && res2.exitCode === 0 && res3.exitCode === 0,
    debloatStats,
  }
}

const MANAGED_PROFILE_WHITELIST = new Set([
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.providers.settings',
  'com.android.providers.contacts',
  'com.android.providers.media',
  'com.android.providers.media.module',
  'com.android.providers.downloads',
  'com.android.providers.downloads.ui',
  'com.android.providers.userdictionary',
  'com.android.providers.blockednumber',
  'com.android.providers.telephony',
  'com.android.shell',
  'com.android.keychain',
  'com.android.permissioncontroller',
  'com.android.packageinstaller',
  'com.android.certinstaller',
  'com.android.externalstorage',
  'com.android.documentsui',
  'com.android.inputdevices',
  'com.android.location.fused',
  'com.android.networkstack.tethering',
  'com.android.se',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.google.android.gsf.login',
  'com.android.vending',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.trichromelibrary',
  'com.android.launcher3',
  'com.google.android.apps.nexuslauncher',
  'com.android.managedprovisioning',
  'com.google.android.apps.work.oobconfig',
  'com.android.companiondevicemanager',
  'com.android.networkstack',
  'com.android.captiveportallogin',
  'com.android.theme.icon.roundedrect',
  'com.android.theme.icon.teardrop',
])

const SAFE_PREFIXES = [
  'com.android.providers.',
  'com.android.server.',
  'com.android.internal.',
  'com.android.overlay.',
  'com.android.theme.',
  'android.auto_generated_rro',
]

export async function debloatManagedProfile(
  userId: number,
  onProgress?: SetupProgressCallback
): Promise<{
  removed: number
  kept: number
  failed: number
  failedPackages: string[]
}> {
  const stats = { removed: 0, kept: 0, failed: 0, failedPackages: [] as string[] }

  onProgress?.({ phase: 'scanning', message: 'Scanning installed packages...' })

  const activePkgs = await shell(`pm list packages --user ${userId} -e`)
  const packages = activePkgs.stdout
    .split('\n')
    .map((line) => line.replace('package:', '').trim())
    .filter((pkg) => pkg.length > 0)

  if (packages.length === 0) return stats

  onProgress?.({
    phase: 'scanning',
    message: `Found ${packages.length} packages to analyze`,
    total: packages.length,
  })

  let processed = 0

  for (const pkg of packages) {
    processed += 1

    if (MANAGED_PROFILE_WHITELIST.has(pkg)) {
      stats.kept += 1
      continue
    }

    if (SAFE_PREFIXES.some((prefix) => pkg.startsWith(prefix))) {
      stats.kept += 1
      continue
    }

    onProgress?.({
      phase: 'debloating',
      message: 'Removing bloatware...',
      currentPkg: pkg,
      current: processed,
      total: packages.length,
      removed: stats.removed,
      kept: stats.kept,
    })

    const uninstallResult = await shell(`pm uninstall -k --user ${userId} ${pkg}`)
    if (uninstallResult.exitCode === 0 || uninstallResult.stdout.includes('Success')) {
      stats.removed += 1
      continue
    }

    const disableResult = await shell(`pm disable-user --user ${userId} ${pkg}`)
    if (disableResult.exitCode === 0) {
      stats.removed += 1
    } else {
      stats.failed += 1
      stats.failedPackages.push(pkg)
    }
  }

  return stats
}

export async function installExistingForUser(packageName: string, userId: number): Promise<boolean> {
  const safePkg = validatePackageName(packageName)
  const result = await shell(`pm install-existing --user ${userId} ${safePkg}`)
  return result.exitCode === 0 || result.stdout.includes('installed')
}
