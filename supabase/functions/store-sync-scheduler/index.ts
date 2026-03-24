import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const EDGE_ADMIN_UIDS = (Deno.env.get('ADMIN_UIDS') ?? Deno.env.get('VITE_ADMIN_UIDS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const STORE_ALLOWED_ORIGINS = (Deno.env.get('STORE_ALLOWED_ORIGINS') ?? Deno.env.get('CMS_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const RATE_LIMIT_WINDOW_MS = 10 * 60_000
const RATE_LIMIT_MAX_REQUESTS = 10

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

interface SchedulerRepoRow {
  id: string
  name: string
  is_builtin: boolean | null
  sync_enabled: boolean | null
  sync_interval_minutes: number | null
  last_synced_at: string | null
}

interface SchedulerStateRow {
  repo_id: string
  retry_count: number | null
  next_retry_at: string | null
}

interface RequestAuthContext {
  user: {
    id: string
    app_metadata?: Record<string, unknown>
  } | null
  isAdmin: boolean
}

function getRequestIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    req.headers.get('cf-connecting-ip') ||
    'unknown'
  )
}

function sweepExpiredBuckets(): void {
  const now = Date.now()
  for (const [k, v] of rateLimitBuckets) {
    if (now >= v.resetAt) rateLimitBuckets.delete(k)
  }
}

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  if (rateLimitBuckets.size > 500) sweepExpiredBuckets()
  const bucket = rateLimitBuckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  if (bucket.count >= limit) {
    return true
  }
  bucket.count += 1
  return false
}

function originFromReferrer(referrer: string | null): string | null {
  if (!referrer) return null
  try {
    return new URL(referrer).origin
  } catch {
    return null
  }
}

function isAllowedOrigin(origin: string | null, referrer: string | null): boolean {
  if (STORE_ALLOWED_ORIGINS.length === 0) return true
  const refOrigin = originFromReferrer(referrer)
  if (origin && STORE_ALLOWED_ORIGINS.includes(origin)) return true
  if (refOrigin && STORE_ALLOWED_ORIGINS.includes(refOrigin)) return true
  return false
}

function corsHeaders(origin: string | null): HeadersInit {
  let allowOrigin = '*'
  if (origin) {
    allowOrigin = origin
  } else if (STORE_ALLOWED_ORIGINS.length > 0) {
    allowOrigin = STORE_ALLOWED_ORIGINS[0]
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function jsonResponse(origin: string | null, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

const MAX_RETRY_COUNT = 20

function computeNextRetryAt(retryCount: number) {
  const cappedRetry = Math.min(retryCount, 8)
  const minutes = Math.min(15 * (2 ** cappedRetry), 24 * 60)
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function isRepoDue(repo: SchedulerRepoRow, state: SchedulerStateRow | undefined, nowMs: number) {
  if (state?.next_retry_at && new Date(state.next_retry_at).getTime() <= nowMs) {
    return true
  }

  if (!repo.last_synced_at) {
    return true
  }

  const intervalMinutes = repo.sync_interval_minutes ?? (repo.is_builtin ? 360 : 720)
  return (new Date(repo.last_synced_at).getTime() + intervalMinutes * 60 * 1000) <= nowMs
}

async function resolveRequestAuth(userClient: ReturnType<typeof createClient>, jwt?: string): Promise<RequestAuthContext> {
  const { data: userData } = await userClient.auth.getUser(jwt)
  const user = userData.user

  if (!user) {
    return { user: null, isAdmin: false }
  }

  if (user.app_metadata?.role === 'admin') {
    return { user, isAdmin: true }
  }

  if (EDGE_ADMIN_UIDS.includes(user.id)) {
    return { user, isAdmin: true }
  }

  try {
    const { data: isAdminData, error: isAdminError } = await userClient.rpc('is_admin')
    if (!isAdminError && Boolean(isAdminData)) {
      return { user, isAdmin: true }
    }
  } catch {
    // Best effort only. Some projects don't expose is_admin().
  }

  return { user, isAdmin: false }
}

serve(async (req) => {
  const origin = req.headers.get('origin')
  const referrer = req.headers.get('referer')

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(origin) })
  }

  if (req.method !== 'POST') {
    return jsonResponse(origin, 405, { error: 'Method not allowed' })
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(origin, 500, { error: 'Missing Supabase env' })
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  const isServiceRoleRequest = authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`

  if (!isServiceRoleRequest && !isAllowedOrigin(origin, referrer)) {
    console.warn('[store-sync-scheduler] blocked origin', { origin, referrer })
    return jsonResponse(origin, 403, { error: 'Origin not allowed' })
  }

  const requestKey = isServiceRoleRequest ? 'service-role' : (token || getRequestIp(req))
  if (!isServiceRoleRequest && isRateLimited(requestKey, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    console.warn('[store-sync-scheduler] rate limited', { requestKey })
    return jsonResponse(origin, 429, { error: 'Too many requests' })
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  if (!isServiceRoleRequest) {
    const { user, isAdmin } = await resolveRequestAuth(userClient, token)
    if (!user) {
      return jsonResponse(origin, 401, { error: 'Authentication required' })
    }
    if (!isAdmin) {
      return jsonResponse(origin, 403, { error: 'Admin privileges required' })
    }
  }

  let payload: { limit?: number } = {}
  try {
    payload = await req.json().catch(() => ({}))
  } catch {
    payload = {}
  }

  const limit = Math.max(1, Math.min(10, payload.limit || 3))

  try {
    const [{ data: repos, error: repoError }, { data: stateRows, error: stateError }] = await Promise.all([
      serviceClient
        .from('store_repositories')
        .select('id, name, is_builtin, sync_enabled, sync_interval_minutes, last_synced_at')
        .eq('sync_enabled', true)
        .order('is_builtin', { ascending: false })
        .order('name', { ascending: true }),
      serviceClient
        .from('store_repo_sync_state')
        .select('repo_id, retry_count, next_retry_at'),
    ])

    if (repoError) throw repoError
    if (stateError) throw stateError

    const syncStateMap = new Map((stateRows || []).map((row: any) => [row.repo_id, row as SchedulerStateRow]))
    const nowMs = Date.now()

    const dueRepos = ((repos || []) as SchedulerRepoRow[])
      .filter((repo) => isRepoDue(repo, syncStateMap.get(repo.id), nowMs))
      .slice(0, limit)

    const results: Array<Record<string, unknown>> = []

    for (const repo of dueRepos) {
      const state = syncStateMap.get(repo.id)
      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/store-sync-fdroid`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ repoId: repo.id }),
        })

        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error((data as { details?: string; error?: string }).details || (data as { error?: string }).error || `HTTP ${response.status}`)
        }

        await serviceClient
          .from('store_repo_sync_state')
          .upsert({
            repo_id: repo.id,
            retry_count: 0,
            next_retry_at: null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'repo_id' })

        results.push({
          repoId: repo.id,
          status: 'success',
          syncMode: (data as { syncMode?: string }).syncMode || null,
        })
      } catch (error) {
        const nextRetryCount = (state?.retry_count || 0) + 1
        const errorMsg = error instanceof Error ? error.message : 'Unknown scheduler error'

        if (nextRetryCount >= MAX_RETRY_COUNT) {
          // Disable the repo after too many consecutive failures
          await serviceClient
            .from('store_repositories')
            .update({ sync_enabled: false })
            .eq('id', repo.id)

          await serviceClient
            .from('store_repo_sync_state')
            .upsert({
              repo_id: repo.id,
              retry_count: 0,
              next_retry_at: null,
              last_error: `Auto-disabled after ${MAX_RETRY_COUNT} failures. Last: ${errorMsg}`,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'repo_id' })

          results.push({
            repoId: repo.id,
            status: 'disabled',
            reason: `${MAX_RETRY_COUNT} consecutive failures`,
            error: errorMsg,
          })
        } else {
          const nextRetryAt = computeNextRetryAt(nextRetryCount)

          await serviceClient
            .from('store_repo_sync_state')
            .upsert({
              repo_id: repo.id,
              retry_count: nextRetryCount,
              next_retry_at: nextRetryAt,
              last_error: errorMsg,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'repo_id' })

          results.push({
            repoId: repo.id,
            status: 'error',
            retryCount: nextRetryCount,
            nextRetryAt,
            error: errorMsg,
          })
        }
      }
    }

    return jsonResponse(origin, 200, {
      ok: true,
      scanned: (repos || []).length,
      due: dueRepos.length,
      processed: results.length,
      results,
    })
  } catch (error) {
    return jsonResponse(origin, 500, {
      error: 'Scheduler failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})
