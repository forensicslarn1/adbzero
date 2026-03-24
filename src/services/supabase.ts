/**
 * Supabase Client Service
 * Gestisce autenticazione e database per ADBZero
 */

import { createClient, type User, type Session } from '@supabase/supabase-js'
import { validatePackageName, validateTextInput } from './command-sanitizer'

// Configurazione Supabase - Da sostituire con le tue credenziali
// Crea un progetto su https://supabase.com e copia URL e anon key
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').trim()
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()
const FALLBACK_SUPABASE_URL = 'http://127.0.0.1:54321'
const FALLBACK_SUPABASE_ANON_KEY = 'public-anon-key-not-configured'
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NICKNAME_REGEX = /^[a-zA-Z0-9_]{3,30}$/
const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,128}$/
const AUTH_RATE_LIMIT_STORAGE_KEY = 'adbzero_auth_rate_limit'

interface ClientRateLimitEntry {
  count: number
  resetAt: number
}

// Verifica se Supabase è configurato correttamente
// Le chiavi possono essere JWT (eyJ...) o publishable (sb_publishable_...)
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

function ensureSupabaseConfigured(): void {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
  }
}

function validateUuid(value: string, fieldName: string): string {
  const trimmed = value.trim()
  if (!UUID_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return trimmed
}

function validateEmailAddress(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (!EMAIL_REGEX.test(normalized) || normalized.length > 320) {
    throw new Error('Enter a valid email address')
  }
  return normalized
}

function validatePasswordStrength(password: string): string {
  if (!PASSWORD_COMPLEXITY_REGEX.test(password)) {
    throw new Error('Password must be 10+ characters and include uppercase, lowercase, and a number')
  }
  return password
}

function validateNicknameInput(nickname: string): string {
  const trimmed = nickname.trim()
  if (!NICKNAME_REGEX.test(trimmed)) {
    throw new Error('Nickname must be 3-30 characters and use only letters, numbers, or underscores')
  }
  return trimmed
}

function readRateLimitState(): Record<string, ClientRateLimitEntry> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.sessionStorage.getItem(AUTH_RATE_LIMIT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, ClientRateLimitEntry> : {}
  } catch {
    return {}
  }
}

function writeRateLimitState(state: Record<string, ClientRateLimitEntry>): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(AUTH_RATE_LIMIT_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Best effort only.
  }
}

function consumeClientRateLimit(
  action: 'login' | 'signup' | 'reset',
  identifier: string,
  maxAttempts: number,
  windowMs: number
): void {
  const now = Date.now()
  const key = `${action}:${identifier.trim().toLowerCase()}`
  const state = readRateLimitState()
  const entry = state[key]

  if (!entry || now >= entry.resetAt) {
    state[key] = { count: 1, resetAt: now + windowMs }
    writeRateLimitState(state)
    return
  }

  if (entry.count >= maxAttempts) {
    const retryAfterMinutes = Math.max(1, Math.ceil((entry.resetAt - now) / 60_000))
    throw new Error(`Too many ${action} attempts. Try again in about ${retryAfterMinutes} minute(s).`)
  }

  state[key] = { ...entry, count: entry.count + 1 }
  writeRateLimitState(state)
}

function validateOptionalText(value: string | null | undefined, fieldName: string, maxLength: number): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return validateTextInput(trimmed, fieldName, maxLength, 1)
}

// Client Supabase
export const supabase = createClient(SUPABASE_URL || FALLBACK_SUPABASE_URL, SUPABASE_ANON_KEY || FALLBACK_SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
})

// ============================================
// TYPES
// ============================================

export interface Device {
  id: string
  manufacturer: string
  model: string
  android_version: string | null
  api_level: number | null
  fingerprint: string
  created_at: string
}

export interface DiscoveredPackage {
  id: string
  package_name: string
  device_id: string
  is_system: boolean
  apk_path: string | null
  suggested_category: string | null
  suggested_removal_level: string | null
  votes_safe: number
  votes_unsafe: number
  created_at: string
}

export interface UserAction {
  id: string
  user_id: string
  device_id: string
  package_name: string
  action: 'disable' | 'enable' | 'uninstall' | 'reinstall' | 'file_mkdir' | 'file_rename' | 'file_move' | 'file_copy' | 'file_delete' | 'file_chmod' | 'file_chown' | 'file_upload'
  created_at: string
}

export interface DegoogleProfile {
  id: string
  user_id: string
  device_id: string
  level: 'essential' | 'low' | 'medium' | 'high' | 'total'
  packages_removed: string[]
  created_at: string
}

export interface DebloatList {
  id: string
  user_id: string
  nickname: string
  title: string
  description: string | null
  is_public: boolean
  device_model: string | null
  device_manufacturer: string | null
  total_votes: number
  items_count: number
  created_at: string
  updated_at: string
  user_vote?: number // Virtual field for the current user's vote
}

export interface DebloatListItem {
  id: string
  list_id: string
  package_name: string
  label: string | null
  description: string | null
  level: 'Recommended' | 'Advanced' | 'Expert' | 'Unsafe'
  created_at: string
}

export interface DebloatComment {
  id: string
  list_id: string
  user_id: string | null
  parent_id: string | null
  nickname: string
  content: string
  total_votes: number
  created_at: string
  user_vote?: number
}

export interface MobileAudit {
  id: string
  user_id: string
  device_model: string
  manifest_data: Record<string, any>
  is_executed: boolean
  created_at: string
}

// ============================================
// DATABASE FUNCTIONS - DEVICES
// ============================================

/**
 * Registra un nuovo utente con email, password e nickname
 */
export async function signUp(email: string, password: string, nickname: string) {
  ensureSupabaseConfigured()
  const validatedEmail = validateEmailAddress(email)
  const validatedPassword = validatePasswordStrength(password)
  const validatedNickname = validateNicknameInput(nickname)
  consumeClientRateLimit('signup', validatedEmail, 3, 60 * 60_000)

  const { data, error } = await supabase.auth.signUp({
    email: validatedEmail,
    password: validatedPassword,
    options: {
      data: {
        nickname: validatedNickname
      },
      emailRedirectTo: window.location.origin
    }
  })
  if (error) throw error
  return data
}

/**
 * Verifica se un nickname è disponibile chiamando l'RPC nel database
 */
export async function checkNicknameAvailable(nickname: string): Promise<boolean> {
  ensureSupabaseConfigured()
  let validatedNickname: string
  try {
    validatedNickname = validateNicknameInput(nickname)
  } catch {
    return false
  }

  const { data, error } = await supabase.rpc('check_nickname_available', {
    p_nickname: validatedNickname
  })

  if (error) {
    console.error('Error checking nickname availability:', error)
    return false
  }

  return !!data
}

/**
 * Login con email e password
 */
export async function signIn(email: string, password: string) {
  ensureSupabaseConfigured()
  const validatedEmail = validateEmailAddress(email)
  const sanitizedPassword = validateTextInput(password, 'Password', 128, 1)
  consumeClientRateLimit('login', validatedEmail, 5, 15 * 60_000)

  const { data, error } = await supabase.auth.signInWithPassword({
    email: validatedEmail,
    password: sanitizedPassword,
  })
  if (error) throw error
  return data
}

/**
 * Login con provider OAuth (Google, GitHub, etc.)
 */
export async function signInWithOAuth(provider: 'google' | 'github') {
  ensureSupabaseConfigured()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: window.location.origin
    }
  })
  if (error) throw error
  return data
}

/**
 * Logout
 */
export async function signOut() {
  ensureSupabaseConfigured()
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

/**
 * Ottiene la sessione corrente
 */
export async function getSession(): Promise<Session | null> {
  if (!isSupabaseConfigured) return null
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

/**
 * Ottiene l'utente corrente
 */
export async function getUser(): Promise<User | null> {
  if (!isSupabaseConfigured) return null
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

/**
 * Reset password via email
 */
export async function resetPassword(email: string) {
  ensureSupabaseConfigured()
  const validatedEmail = validateEmailAddress(email)
  consumeClientRateLimit('reset', validatedEmail, 3, 15 * 60_000)

  const { error } = await supabase.auth.resetPasswordForEmail(validatedEmail, {
    redirectTo: `${window.location.origin}/reset-password`
  })
  if (error) throw error
}

// ============================================
// DEVICE FUNCTIONS
// ============================================

/**
 * Genera un fingerprint unico per il dispositivo
 */
export function generateDeviceFingerprint(
  manufacturer: string,
  model: string,
  serialNumber: string
): string {
  // Rimuoviamo androidVersion per mantenere il fingerprint costante dopo gli aggiornamenti
  return `${manufacturer}:${model}:${serialNumber}`.toLowerCase()
}

/**
 * Registra o trova un dispositivo
 */
export async function upsertDevice(device: Omit<Device, 'id' | 'created_at'>): Promise<Device> {
  const { data, error } = await supabase
    .from('devices')
    .upsert(device, { onConflict: 'fingerprint' })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Ottiene un dispositivo per fingerprint
 */
export async function getDeviceByFingerprint(fingerprint: string): Promise<Device | null> {
  const { data, error } = await supabase
    .from('devices')
    .select()
    .eq('fingerprint', fingerprint)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data
}

/**
 * Ottiene tutti i dispositivi dell'utente (basato sulle azioni)
 */
export async function getUserDevices(userId: string): Promise<Device[]> {
  const { data, error } = await supabase
    .from('user_actions')
    .select('device_id')
    .eq('user_id', userId)

  if (error) throw error

  const deviceIds = [...new Set(data.map(a => a.device_id))]

  if (deviceIds.length === 0) return []

  const { data: devices, error: devError } = await supabase
    .from('devices')
    .select()
    .in('id', deviceIds)

  if (devError) throw devError
  return devices || []
}

// ============================================
// PACKAGE FUNCTIONS
// ============================================

/**
 * Registra pacchetti scoperti (bulk)
 */
export async function uploadDiscoveredPackages(
  packages: Array<{
    package_name: string
  }>
): Promise<void> {
  // Sanitize input to ensure only valid columns are sent (defensive coding)
  const sanitizedPackages = packages.map(p => ({
    package_name: p.package_name
    // is_system removed as it does not exist in the DB schema
  }))

  const { error } = await supabase
    .from('uad_packages')
    .upsert(sanitizedPackages, {
      onConflict: 'package_name',
      ignoreDuplicates: true
    })

  if (error) throw error
}

/**
 * Ottiene pacchetti scoperti dalla community
 */
export async function getCommunityPackages(): Promise<DiscoveredPackage[]> {
  const { data, error } = await supabase
    .from('uad_packages')
    .select()
    .order('votes_safe', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Vota un pacchetto come safe o unsafe
 */
export async function votePackage(
  packageName: string,
  voteType: 'safe' | 'unsafe'
): Promise<void> {
  // Validate inputs
  const validatedPackage = validatePackageName(packageName)

  // Whitelist for vote types
  if (voteType !== 'safe' && voteType !== 'unsafe') {
    throw new Error('Invalid vote type')
  }

  const column = voteType === 'safe' ? 'votes_safe' : 'votes_unsafe'

  const { error } = await supabase.rpc('increment_vote', {
    p_package_name: validatedPackage,
    p_column: column
  })

  if (error) throw error
}

// Whitelist of allowed categories and removal levels
const ALLOWED_CATEGORIES = [
  'system', 'google', 'carrier', 'oem', 'misc', 'game', 'social', 'media', 'utility', 'other'
] as const

const ALLOWED_REMOVAL_LEVELS = [
  'Recommended', 'Advanced', 'Expert', 'Unsafe'
] as const

function validateDebloatListItems(
  items: Array<Omit<DebloatListItem, 'id' | 'list_id' | 'created_at'>>
): Array<Omit<DebloatListItem, 'id' | 'list_id' | 'created_at'>> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one package is required')
  }

  if (items.length > 500) {
    throw new Error('Too many list items')
  }

  const seenPackages = new Set<string>()
  return items.map((item) => {
    const packageName = validatePackageName(item.package_name)
    if (seenPackages.has(packageName)) {
      throw new Error(`Duplicate package in list: ${packageName}`)
    }
    seenPackages.add(packageName)

    const level = validateTextInput(item.level, 'Removal level', 20, 1) as DebloatListItem['level']
    if (!ALLOWED_REMOVAL_LEVELS.includes(level)) {
      throw new Error(`Invalid removal level: "${level}"`)
    }

    return {
      package_name: packageName,
      label: validateOptionalText(item.label, 'Label', 120),
      description: validateOptionalText(item.description, 'Description', 1000),
      level
    }
  })
}

/**
 * Suggerisci categoria/livello per un pacchetto
 */
export async function suggestPackageInfo(
  packageName: string,
  category: string,
  removalLevel: string
): Promise<void> {
  // Validate package name
  const validatedPackage = validatePackageName(packageName)

  // Validate category against whitelist
  const trimmedCategory = validateTextInput(category, 'Category', 50, 1)
  if (!ALLOWED_CATEGORIES.includes(trimmedCategory as typeof ALLOWED_CATEGORIES[number])) {
    throw new Error(`Invalid category: "${trimmedCategory}". Allowed: ${ALLOWED_CATEGORIES.join(', ')}`)
  }

  // Validate removal level against whitelist
  const trimmedLevel = validateTextInput(removalLevel, 'Removal level', 50, 1)
  if (!ALLOWED_REMOVAL_LEVELS.includes(trimmedLevel as typeof ALLOWED_REMOVAL_LEVELS[number])) {
    throw new Error(`Invalid removal level: "${trimmedLevel}". Allowed: ${ALLOWED_REMOVAL_LEVELS.join(', ')}`)
  }

  const { error } = await supabase
    .from('uad_packages')
    .update({
      suggested_category: trimmedCategory,
      suggested_removal_level: trimmedLevel
    })
    .eq('package_name', validatedPackage)

  if (error) throw error
}

// ============================================
// USER ACTIONS FUNCTIONS
// ============================================

/**
 * Registra un'azione dell'utente e incrementa le statistiche del pacchetto
 */
export async function logUserAction(
  userId: string,
  deviceId: string,
  packageName: string,
  action: UserAction['action']
): Promise<void> {
  // 1. Logga l'azione
  const { error } = await supabase
    .from('user_actions')
    .insert({
      user_id: userId,
      device_id: deviceId,
      package_name: packageName,
      action
    })

  if (error) throw error

  // 2. Incrementa statistiche nel database globale SE si tratta di un'azione pacchetto
  const packageActions: Array<UserAction['action']> = ['disable', 'enable', 'uninstall', 'reinstall']
  if (packageActions.includes(action)) {
    await incrementPackageStat(packageName, action === 'disable' ? 'times_disabled' : 'times_enabled')
  }
}

// Whitelist of allowed stat columns
const ALLOWED_STAT_COLUMNS = ['times_found', 'times_disabled', 'times_enabled'] as const
type StatColumn = typeof ALLOWED_STAT_COLUMNS[number]

/**
 * Incrementa un contatore per un pacchetto (times_found, times_disabled, etc.)
 */
export async function incrementPackageStat(
  packageName: string,
  column: StatColumn
): Promise<void> {
  try {
    // Validate package name
    const validatedPackage = validatePackageName(packageName)

    // Validate column against whitelist (TypeScript already enforces this, but double-check at runtime)
    if (!ALLOWED_STAT_COLUMNS.includes(column)) {
      throw new Error(`Invalid stat column: "${column}"`)
    }

    // Usiamo una RPC se disponibile, altrimenti un update diretto (meno preciso ma funzionante)
    // Se hai creato la funzione SQL increment_package_stat, usala:
    const { error } = await supabase.rpc('increment_package_stat', {
      p_package_name: validatedPackage,
      p_column: column
    })

    if (error) {
      // Fallback: aggiornamento diretto se la RPC fallisce (es. non esiste)
      const { data: current } = await supabase
        .from('uad_packages')
        .select(column)
        .eq('package_name', validatedPackage)
        .single()

      if (current) {
        const val = (current as Record<string, number>)[column] || 0
        await supabase
          .from('uad_packages')
          .update({ [column]: val + 1 })
          .eq('package_name', validatedPackage)
      }
    }
  } catch (e) {
    console.warn(`Failed to increment stat ${column} for ${packageName}:`, e)
  }
}

/**
 * Ottiene lo storico azioni per un dispositivo
 */
export async function getDeviceActions(
  userId: string,
  deviceId: string
): Promise<UserAction[]> {
  const { data, error } = await supabase
    .from('user_actions')
    .select()
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Ottiene tutte le azioni dell'utente
 */
export async function getAllUserActions(userId: string): Promise<UserAction[]> {
  const { data, error } = await supabase
    .from('user_actions')
    .select()
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Ottiene i pacchetti che erano stati rimossi ma ora sono ritornati (abilitati)
 */
export async function getReturnedPackages(
  userId: string,
  deviceId: string,
  currentEnabledPackages: string[]
): Promise<string[]> {
  // 1. Ottieni tutte le azioni dell'utente per questo dispositivo
  const { data: actions, error } = await supabase
    .from('user_actions')
    .select('package_name, action')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .order('created_at', { ascending: false })

  if (error) throw error

  // 2. Determina l'ultimo stato voluto per ogni pacchetto
  const intendedDisabled = new Set<string>()
  const processed = new Set<string>()

  for (const action of (actions || [])) {
    if (!processed.has(action.package_name)) {
      processed.add(action.package_name)
      if (action.action === 'disable' || action.action === 'uninstall') {
        intendedDisabled.add(action.package_name)
      }
    }
  }

  // 3. Trova i pacchetti che dovrebbero essere disabilitati ma sono nella lista di quelli abilitati
  return currentEnabledPackages.filter(pkg => intendedDisabled.has(pkg))
}

// ============================================
// DEGOOGLE PROFILES FUNCTIONS
// ============================================

/**
 * Salva un profilo de-googling
 */
export async function saveDegoogleProfile(
  userId: string,
  deviceId: string,
  level: DegoogleProfile['level'],
  packagesRemoved: string[]
): Promise<void> {
  const { error } = await supabase
    .from('degoogle_profiles')
    .insert({
      user_id: userId,
      device_id: deviceId,
      level,
      packages_removed: packagesRemoved
    })

  if (error) throw error
}

/**
 * Ottiene profili de-googling per dispositivo
 */
export async function getDegoogleProfiles(
  userId: string,
  deviceId?: string
): Promise<DegoogleProfile[]> {
  let query = supabase
    .from('degoogle_profiles')
    .select()
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (deviceId) {
    query = query.eq('device_id', deviceId)
  }

  const { data, error } = await query

  if (error) throw error
  return data || []
}

// ============================================
// REALTIME SUBSCRIPTIONS
// ============================================

/**
 * Sottoscrivi a cambiamenti auth
 */
export function onAuthStateChange(callback: (event: string, session: Session | null) => void) {
  if (!isSupabaseConfigured) {
    return {
      data: {
        subscription: {
          unsubscribe: () => undefined
        }
      }
    } as ReturnType<typeof supabase.auth.onAuthStateChange>
  }
  return supabase.auth.onAuthStateChange(callback)
}

// ============================================
// FEEDBACK / SUGGESTIONS
// ============================================

export interface Suggestion {
  id: string
  user_id: string
  subject: string
  message: string
  created_at: string
}

/**
 * Invia una proposta di miglioramento
 */
export async function sendSuggestion(
  userId: string,
  subject: string,
  message: string
): Promise<void> {
  // Input validation
  const trimmedSubject = subject.trim()
  const trimmedMessage = message.trim()

  if (!trimmedSubject || trimmedSubject.length > 200) {
    throw new Error('Subject must be between 1 and 200 characters')
  }
  if (!trimmedMessage || trimmedMessage.length > 5000) {
    throw new Error('Message must be between 1 and 5000 characters')
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid user ID')
  }

  const { error } = await supabase
    .from('suggestions')
    .insert({
      user_id: userId,
      subject: trimmedSubject,
      message: trimmedMessage
    })

  if (error) throw error
}

// ============================================
// DEBLOAT LISTS FUNCTIONS
// ============================================

/**
 * Crea una nuova lista di debloating
 */
export async function createDebloatList(
  userId: string,
  nickname: string,
  title: string,
  description: string | null,
  isPublic: boolean,
  items: Array<Omit<DebloatListItem, 'id' | 'list_id' | 'created_at'>>,
  deviceModel?: string | null,
  deviceManufacturer?: string | null
): Promise<DebloatList> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const validatedNickname = validateNicknameInput(nickname)
  const validatedTitle = validateTextInput(title, 'Title', 160, 3)
  const validatedDescription = validateOptionalText(description, 'Description', 2000)
  const validatedDeviceModel = validateOptionalText(deviceModel, 'Device model', 120)
  const validatedDeviceManufacturer = validateOptionalText(deviceManufacturer, 'Device manufacturer', 120)
  const sanitizedItems = validateDebloatListItems(items)

  const { data: list, error: listError } = await supabase
    .from('debloat_lists')
    .insert({
      user_id: validatedUserId,
      nickname: validatedNickname,
      title: validatedTitle,
      description: validatedDescription,
      is_public: isPublic,
      device_model: validatedDeviceModel,
      device_manufacturer: validatedDeviceManufacturer
    })
    .select()
    .single()

  if (listError) throw listError

  if (sanitizedItems.length > 0) {
    const listItems = sanitizedItems.map(item => ({
      ...item,
      list_id: list.id
    }))

    const { error: itemsError } = await supabase
      .from('debloat_list_items')
      .insert(listItems)

    if (itemsError) throw itemsError
  }

  return list
}

/**
 * Ottiene le liste pubbliche della community, ordinate per voti
 */
export async function getCommunityDebloatLists(userId?: string): Promise<DebloatList[]> {
  ensureSupabaseConfigured()
  const validatedUserId = userId ? validateUuid(userId, 'user ID') : undefined
  // Se l'utente è loggato, mostriamo le liste pubbliche + le SUE liste (anche se private)
  let query = supabase
    .from('debloat_lists')
    .select('*, debloat_list_votes(user_id,vote)')

  if (validatedUserId) {
    query = query.or(`is_public.eq.true,user_id.eq.${validatedUserId}`)
  } else {
    query = query.eq('is_public', true)
  }

  const { data, error } = await query.order('total_votes', { ascending: false })

  if (error) throw error

  // Calculate user_vote from the joined table if userId is provided
  return (data || []).map(list => ({
    ...list,
    user_vote: (list.debloat_list_votes as any[])?.find((v: any) => v.user_id === validatedUserId)?.vote || 0
  }))
}

/**
 * Ottiene le liste private dell'utente
 */
export async function getMyDebloatLists(userId: string): Promise<DebloatList[]> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const { data, error } = await supabase
    .from('debloat_lists')
    .select('*')
    .eq('user_id', validatedUserId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Carica i dettagli di una lista (inclusi gli item)
 */
export async function getDebloatListDetails(listId: string): Promise<{ list: DebloatList, items: DebloatListItem[] }> {
  ensureSupabaseConfigured()
  const validatedListId = validateUuid(listId, 'list ID')
  const { data: list, error: listError } = await supabase
    .from('debloat_lists')
    .select('*')
    .eq('id', validatedListId)
    .single()

  if (listError) throw listError

  const { data: items, error: itemsError } = await supabase
    .from('debloat_list_items')
    .select('*')
    .eq('list_id', validatedListId)

  if (itemsError) throw itemsError

  return { list, items: items || [] }
}

/**
 * Vota una lista (Reddit-style: 1, -1, 0 per rimuovere il voto)
 */
export async function voteDebloatList(
  userId: string,
  listId: string,
  vote: 1 | -1 | 0
): Promise<void> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const validatedListId = validateUuid(listId, 'list ID')

  if (vote === 0) {
    // Delete existing vote
    const { error } = await supabase
      .from('debloat_list_votes')
      .delete()
      .eq('user_id', validatedUserId)
      .eq('list_id', validatedListId)

    if (error) throw error
  } else {
    // Upsert vote
    const { error } = await supabase
      .from('debloat_list_votes')
      .upsert({
        user_id: validatedUserId,
        list_id: validatedListId,
        vote
      })

    if (error) throw error
  }

  // NOTE: In a real Supabase setup, you'd use a trigger to update 'total_votes' in 'debloat_lists'.
  // If no trigger exists, we do a quick RPC call here.
  const { error: rpcError } = await supabase.rpc('update_list_votes_count', {
    p_list_id: validatedListId
  })

  if (rpcError) {
    console.warn('Voting trigger failed or not implemented, votes might be out of sync in list view.')
  }
}

/**
 * Elimina una lista
 */
export async function deleteDebloatList(userId: string, listId: string): Promise<void> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const validatedListId = validateUuid(listId, 'list ID')
  const { error } = await supabase
    .from('debloat_lists')
    .delete()
    .eq('id', validatedListId)
    .eq('user_id', validatedUserId)

  if (error) throw error
}

/**
 * Aggiorna la visibilità di una lista
 */
export async function updateDebloatListVisibility(userId: string, listId: string, isPublic: boolean): Promise<void> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const validatedListId = validateUuid(listId, 'list ID')
  const { error } = await supabase
    .from('debloat_lists')
    .update({ is_public: isPublic })
    .eq('id', validatedListId)
    .eq('user_id', validatedUserId)

  if (error) throw error
}

/**
 * Ottiene i commenti di una lista
 */
export async function getDebloatListComments(listId: string, userId?: string): Promise<DebloatComment[]> {
  ensureSupabaseConfigured()
  const validatedListId = validateUuid(listId, 'list ID')
  const { data, error } = await supabase
    .from('debloat_list_comments')
    .select('*, debloat_list_comment_votes(user_id,vote)')
    .eq('list_id', validatedListId)
    .order('total_votes', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) throw error

  return (data || []).map(c => ({
    ...c,
    user_vote: (c.debloat_list_comment_votes as any[])?.find((v: any) => v.user_id === userId)?.vote || 0
  }))
}

/**
 * Invia un commento
 */
export async function postDebloatListComment(
  listId: string,
  userId: string,
  nickname: string,
  content: string,
  parentId: string | null = null
): Promise<DebloatComment> {
  ensureSupabaseConfigured()
  const validatedListId = validateUuid(listId, 'list ID')
  const validatedUserId = validateUuid(userId, 'user ID')
  const validatedNickname = validateNicknameInput(nickname)
  const validatedContent = validateTextInput(content, 'Comment', 5000, 1)
  const validatedParentId = parentId ? validateUuid(parentId, 'parent comment ID') : null

  const { data, error } = await supabase
    .from('debloat_list_comments')
    .insert({
      list_id: validatedListId,
      user_id: validatedUserId,
      nickname: validatedNickname,
      content: validatedContent,
      parent_id: validatedParentId
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Vota un commento
 */
export async function voteDebloatListComment(
  userId: string,
  commentId: string,
  vote: 1 | -1 | 0
): Promise<void> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const validatedCommentId = validateUuid(commentId, 'comment ID')

  if (vote === 0) {
    const { error } = await supabase
      .from('debloat_list_comment_votes')
      .delete()
      .eq('user_id', validatedUserId)
      .eq('comment_id', validatedCommentId)

    if (error) throw error
  } else {
    const { error } = await supabase
      .from('debloat_list_comment_votes')
      .upsert({
        user_id: validatedUserId,
        comment_id: validatedCommentId,
        vote
      })

    if (error) throw error
  }

  // Trigger manuale se necessario (anche se abbiamo il trigger DB)
  await supabase.rpc('update_comment_votes_count_rpc', {
    p_comment_id: validatedCommentId
  })
}

// ============================================
// DATABASE FUNCTIONS - MOBILE AUDITS (BRIDGE)
// ============================================

/**
 * Fetches mobile audits for the current user
 */
export async function getMobileAudits(userId: string): Promise<MobileAudit[]> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const { data, error } = await supabase
    .from('mobile_audits')
    .select('*')
    .eq('user_id', validatedUserId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Error fetching mobile audits:', error)
    return []
  }

  return data as MobileAudit[]
}

/**
 * Deletes a mobile audit
 */
export async function deleteMobileAudit(userId: string, auditId: string): Promise<boolean> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const validatedAuditId = validateUuid(auditId, 'audit ID')
  const { error } = await supabase
    .from('mobile_audits')
    .delete()
    .eq('id', validatedAuditId)
    .eq('user_id', validatedUserId)

  if (error) {
    console.error('Error deleting mobile audit:', error)
    return false
  }

  return true
}

/**
 * Marks a mobile audit as executed (optional utility)
 */
export async function markMobileAuditExecuted(userId: string, auditId: string): Promise<boolean> {
  ensureSupabaseConfigured()
  const validatedUserId = validateUuid(userId, 'user ID')
  const validatedAuditId = validateUuid(auditId, 'audit ID')
  const { error } = await supabase
    .from('mobile_audits')
    .update({ is_executed: true })
    .eq('id', validatedAuditId)
    .eq('user_id', validatedUserId)

  if (error) {
    console.error('Error marking mobile audit as executed:', error)
    return false
  }

  return true
}
