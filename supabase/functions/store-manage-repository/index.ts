import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { z } from 'https://esm.sh/zod@4.3.6'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const STORE_ALLOWED_ORIGINS = (Deno.env.get('STORE_ALLOWED_ORIGINS') ?? Deno.env.get('CMS_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const RATE_LIMIT_WINDOW_MS = 10 * 60_000
const RATE_LIMIT_MAX_REQUESTS = 20
const FINGERPRINT_REGEX = /^[A-F0-9]{40,128}$/

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('onboard'),
    baseUrl: z.string().trim().url().refine((value) => new URL(value).protocol === 'https:', {
      message: 'Repository URL must use HTTPS',
    }),
    fingerprint: z.string().trim().regex(FINGERPRINT_REGEX, 'Fingerprint must be uppercase hex').optional(),
  }),
  z.object({
    action: z.literal('trust-decision'),
    repoId: z.string().trim().min(1).max(160),
    trustState: z.enum(['pending', 'approved', 'quarantined', 'revoked']),
    fingerprint: z.string().trim().regex(FINGERPRINT_REGEX, 'Fingerprint must be uppercase hex').optional(),
  }),
])

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
    'Vary': 'Origin',
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

function normalizeBaseUrl(input: string): string {
  const parsed = new URL(input)
  parsed.search = ''
  parsed.hash = ''

  const fileSuffixes = [
    '/entry.json',
    '/index-v2.json',
    '/index.jar',
    '/index-v1.jar',
    '/index.xml',
  ]

  const lowerPathname = parsed.pathname.toLowerCase()
  const matchedSuffix = fileSuffixes.find((suffix) => lowerPathname.endsWith(suffix))
  if (matchedSuffix) {
    parsed.pathname = parsed.pathname.slice(0, -matchedSuffix.length)
  }

  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`
  }
  return parsed.toString()
}

function normalizeFingerprint(input: string | undefined): string | undefined {
  const trimmed = input?.trim()
  return trimmed ? trimmed.toUpperCase() : undefined
}

async function deriveRepoId(baseUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(baseUrl)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return `custom-${hex.slice(0, 16)}`
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

  if (!isAllowedOrigin(origin, referrer)) {
    console.warn('[store-manage-repository] blocked origin', { origin, referrer })
    return jsonResponse(origin, 403, { error: 'Origin not allowed' })
  }

  let payloadRaw: unknown
  try {
    payloadRaw = await req.json()
  } catch {
    return jsonResponse(origin, 400, { error: 'Invalid JSON payload' })
  }

  const parsedPayload = requestSchema.safeParse(payloadRaw)
  if (!parsedPayload.success) {
    return jsonResponse(origin, 400, { error: parsedPayload.error.issues[0]?.message || 'Invalid payload' })
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: userData } = await userClient.auth.getUser(token)
  const user = userData.user
  if (!user) {
    console.warn('[store-manage-repository] unauthenticated request')
    return jsonResponse(origin, 401, { error: 'Authentication required' })
  }

  const rateLimitKey = user.id || getRequestIp(req)
  if (isRateLimited(rateLimitKey, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    console.warn('[store-manage-repository] rate limited', { userId: user.id })
    return jsonResponse(origin, 429, { error: 'Too many requests' })
  }

  const payload = parsedPayload.data

  try {
    if (payload.action === 'onboard') {
      const parsedUrl = new URL(payload.baseUrl)
      const baseUrl = normalizeBaseUrl(payload.baseUrl)
      const extractedFingerprint = normalizeFingerprint(
        payload.fingerprint || parsedUrl.searchParams.get('fingerprint') || undefined
      )
      const entryUrl = new URL('entry.json', baseUrl).toString()
      const entryResponse = await fetch(entryUrl)
      if (!entryResponse.ok) {
        return jsonResponse(origin, 400, { error: `Unable to read entry.json (${entryResponse.status})` })
      }

      const entry = await entryResponse.json()
      const repoId = await deriveRepoId(baseUrl)
      const existingRepo = await serviceClient
        .from('store_repositories')
        .select('id, declared_fingerprint, trust_state')
        .eq('id', repoId)
        .maybeSingle()

      const fingerprintChanged =
        existingRepo.data?.declared_fingerprint &&
        extractedFingerprint &&
        existingRepo.data.declared_fingerprint !== extractedFingerprint

      const repoTrustState = fingerprintChanged
        ? 'quarantined'
        : extractedFingerprint
          ? 'trusted_user_pinned'
          : 'unverified'

      const repoTrustLabel = fingerprintChanged
        ? 'Fingerprint mismatch - quarantined'
        : extractedFingerprint
          ? 'User-pinned fingerprint'
          : 'Pending fingerprint approval'

      await serviceClient.from('store_repositories').upsert({
        id: repoId,
        name: new URL(baseUrl).hostname,
        description: `Custom F-Droid-compatible repository (${new URL(baseUrl).hostname})`,
        base_url: baseUrl,
        package_page_base_url: baseUrl,
        search_api_url: null,
        entry_url: entryUrl,
        trust_state: repoTrustState,
        trust_label: repoTrustLabel,
        kind: 'fdroid',
        is_builtin: false,
        sync_enabled: true,
        declared_fingerprint: extractedFingerprint || existingRepo.data?.declared_fingerprint || null,
        verification_state: 'pending',
        verification_details: 'Repository added. Waiting for the first verified sync.',
        last_verified_at: null,
        created_by: user.id,
        entry_timestamp: entry.timestamp ?? null,
        index_sha256: entry.index?.sha256 ?? null,
        max_age_days: entry.maxAge ?? null,
        package_count: entry.index?.numPackages ?? null,
        index_size_bytes: entry.index?.size ?? null,
        metadata: {
          entry,
        },
        updated_at: new Date().toISOString(),
      })

      await serviceClient.from('user_repo_trust').upsert({
        user_id: user.id,
        repo_id: repoId,
        trust_state: fingerprintChanged ? 'quarantined' : (extractedFingerprint ? 'approved' : 'pending'),
        approved_fingerprint: extractedFingerprint || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,repo_id' })

      return jsonResponse(origin, 200, {
        ok: true,
        repoId,
        trustState: fingerprintChanged ? 'quarantined' : (extractedFingerprint ? 'approved' : 'pending'),
      })
    }

    const repoLookup = await serviceClient
      .from('store_repositories')
      .select('id, declared_fingerprint')
      .eq('id', payload.repoId)
      .maybeSingle()

    if (!repoLookup.data) {
      return jsonResponse(origin, 404, { error: 'Repository not found' })
    }

    const shouldQuarantine =
      payload.trustState === 'approved' &&
      payload.fingerprint &&
      repoLookup.data.declared_fingerprint &&
      repoLookup.data.declared_fingerprint !== payload.fingerprint

    await serviceClient.from('user_repo_trust').upsert({
      user_id: user.id,
      repo_id: payload.repoId,
      trust_state: shouldQuarantine ? 'quarantined' : payload.trustState,
      approved_fingerprint: payload.fingerprint || repoLookup.data.declared_fingerprint || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,repo_id' })

    if (shouldQuarantine) {
      await serviceClient
        .from('store_repositories')
        .update({
          trust_state: 'quarantined',
          trust_label: 'Fingerprint mismatch - quarantined',
          updated_at: new Date().toISOString(),
        })
        .eq('id', payload.repoId)
    }

    return jsonResponse(origin, 200, {
      ok: true,
      repoId: payload.repoId,
      trustState: shouldQuarantine ? 'quarantined' : payload.trustState,
    })
  } catch (error) {
    return jsonResponse(origin, 500, {
      error: 'Repository management failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})
