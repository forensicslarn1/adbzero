import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { z } from 'https://esm.sh/zod@4.3.6'

const STORE_ALLOWED_ORIGINS = (Deno.env.get('STORE_ALLOWED_ORIGINS') ?? Deno.env.get('CMS_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 60
const PACKAGE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,20}$/

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

const FDROID_REPOSITORY = {
  id: 'fdroid-official',
  name: 'F-Droid',
  description: 'Official F-Droid repository',
  baseUrl: 'https://f-droid.org/repo/',
  packagePageBaseUrl: 'https://f-droid.org/en/packages/',
  searchApiUrl: 'https://search.f-droid.org/api/search_apps',
  entryUrl: 'https://f-droid.org/repo/entry.json',
  trustState: 'trusted_builtin',
  trustLabel: 'Built-in pinned trust',
} as const

type LiveAction = 'snapshot' | 'search' | 'detail' | 'artifact'

interface SnapshotPayload {
  action: 'snapshot'
  repoId?: string
}

interface SearchPayload {
  action: 'search'
  repoId?: string
  query: string
}

interface DetailPayload {
  action: 'detail'
  repoId?: string
  packageName: string
}

interface ArtifactPayload {
  action: 'artifact'
  repoId?: string
  downloadUrl: string
}

type RequestPayload = SnapshotPayload | SearchPayload | DetailPayload | ArtifactPayload

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('snapshot'),
    repoId: z.string().trim().optional(),
  }),
  z.object({
    action: z.literal('search'),
    repoId: z.string().trim().optional(),
    query: z.string().trim().min(1).max(120),
  }),
  z.object({
    action: z.literal('detail'),
    repoId: z.string().trim().optional(),
    packageName: z.string().trim().regex(PACKAGE_NAME_REGEX, 'Invalid package name'),
  }),
  z.object({
    action: z.literal('artifact'),
    repoId: z.string().trim().optional(),
    downloadUrl: z.string().trim().url().max(1024),
  }),
])

interface FdroidSearchResponse {
  apps?: Array<{
    name?: string
    summary?: string
    icon?: string
    url?: string
  }>
}

interface FdroidPackageApiResponse {
  packageName?: string
  suggestedVersionCode?: number
  packages?: Array<{
    versionName?: string
    versionCode?: number
  }>
}

interface LiveRelease {
  id: string
  versionCode: number
  versionName: string
  addedAt?: string
  selectionMode: 'single'
  artifacts: Array<{
    id: string
    fileName: string
    downloadUrl: string
    role: 'apk'
    isPrimary: true
    abiList: string[]
  }>
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

function stripTags(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractPackageNameFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const match = url.match(/\/packages\/([^/?#]+)\/?$/)
  return match ? match[1] : null
}

function normalizePackagePageUrl(packageName: string) {
  return `${FDROID_REPOSITORY.packagePageBaseUrl}${packageName}/`
}

function parseVersionBlocks(html: string): LiveRelease[] {
  const releases: LiveRelease[] = []
  const segments = html.split(/<li class="package-version"[^>]*>/i).slice(1)

  for (const segment of segments) {
    const block = segment
    const versionHeaderMatch = segment.match(/<b>Version\s+([^<]+)<\/b>\s+\((\d+)\)/i)
    const versionName = stripTags(versionHeaderMatch?.[1])
    const versionCode = Number(versionHeaderMatch?.[2])
    const downloadMatch = block.match(/href="([^"]*\/repo\/[^"]+\.apk)"/i)

    if (!versionName || !Number.isFinite(versionCode) || !downloadMatch?.[1]) {
      continue
    }

    const addedAt = stripTags(block.match(/Added on ([^<\n]+)/i)?.[1])
    const downloadUrl = downloadMatch[1].startsWith('http')
      ? downloadMatch[1]
      : new URL(downloadMatch[1], 'https://f-droid.org').toString()
    const fileName = downloadUrl.split('/').filter(Boolean).pop() || `${versionCode}.apk`
    const abiMatches = [...block.matchAll(/class="package-nativecode">([^<]+)<\/code>/g)]
      .map((abiMatch) => stripTags(abiMatch[1]))
      .filter((value): value is string => Boolean(value))

    releases.push({
      id: `${versionCode}:${versionName}`,
      versionCode,
      versionName,
      addedAt,
      selectionMode: 'single',
      artifacts: [{
        id: `${versionCode}:${fileName}`,
        fileName,
        downloadUrl,
        role: 'apk',
        isPrimary: true,
        abiList: abiMatches,
      }],
    })
  }

  return releases.sort((left, right) => right.versionCode - left.versionCode)
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  return response.json() as Promise<T>
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }
  return response.text()
}

async function handleSnapshot(origin: string | null) {
  const entry = await fetchJson<{
    timestamp?: number
    maxAge?: number
    index?: { sha256?: string; size?: number; numPackages?: number }
  }>(FDROID_REPOSITORY.entryUrl)

  return jsonResponse(origin, 200, {
    ok: true,
    snapshot: {
      ...FDROID_REPOSITORY,
      entryTimestamp: entry.timestamp,
      maxAgeDays: entry.maxAge,
      packageCount: entry.index?.numPackages,
      indexSizeBytes: entry.index?.size,
      indexSha256: entry.index?.sha256,
      verificationState: 'pending',
      verificationDetails: 'Live F-Droid metadata proxied by the backend. Full catalog ingestion is not active yet.',
      isBuiltin: true,
      syncEnabled: true,
    },
  })
}

async function handleSearch(origin: string | null, query: string) {
  const trimmed = query.trim()
  if (!trimmed) {
    return jsonResponse(origin, 200, { ok: true, results: [] })
  }

  const data = await fetchJson<FdroidSearchResponse>(`${FDROID_REPOSITORY.searchApiUrl}?q=${encodeURIComponent(trimmed)}`)
  const results = (data.apps || []).flatMap((app) => {
    const packageName = extractPackageNameFromUrl(app.url)
    if (!packageName || !app.name) return []

    return [{
      repoId: FDROID_REPOSITORY.id,
      packageName,
      name: app.name,
      summary: app.summary || '',
      iconUrl: app.icon,
      packageUrl: app.url || normalizePackagePageUrl(packageName),
    }]
  })

  return jsonResponse(origin, 200, { ok: true, results })
}

async function handleDetail(origin: string | null, packageName: string) {
  const normalizedPackageName = packageName.trim()
  if (!normalizedPackageName) {
    return jsonResponse(origin, 400, { error: 'packageName is required' })
  }

  const packageUrl = normalizePackagePageUrl(normalizedPackageName)
  const [apiData, html] = await Promise.all([
    fetchJson<FdroidPackageApiResponse>(`https://f-droid.org/api/v1/packages/${normalizedPackageName}`),
    fetchText(packageUrl),
  ])

  const name = stripTags(html.match(/class="package-name"[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]) || normalizedPackageName
  const summary = stripTags(html.match(/class="package-summary"[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1]) || ''
  const iconUrl = html.match(/property="og:image" content="([^"]+)"/i)?.[1]
  const releases = parseVersionBlocks(html)
  const latestRelease = releases[0]
  const latestArtifact = latestRelease?.artifacts[0]
  const versions = (apiData.packages || [])
    .filter((item) => typeof item.versionCode === 'number' && typeof item.versionName === 'string')
    .map((item) => {
      const release = releases.find((candidate) => candidate.versionCode === item.versionCode)
      return {
        versionCode: item.versionCode as number,
        versionName: item.versionName as string,
        downloadUrl: release?.artifacts[0]?.downloadUrl,
      }
    })

  return jsonResponse(origin, 200, {
    ok: true,
    detail: {
      repoId: FDROID_REPOSITORY.id,
      packageName: normalizedPackageName,
      name,
      summary,
      iconUrl,
      packageUrl,
      description: summary || undefined,
      suggestedVersionCode: apiData.suggestedVersionCode || latestRelease?.versionCode,
      suggestedVersionName: latestRelease?.versionName,
      suggestedDownloadUrl: latestArtifact?.downloadUrl,
      versions,
      releases,
      trustState: FDROID_REPOSITORY.trustState,
      trustLabel: FDROID_REPOSITORY.trustLabel,
    },
  })
}

function resolveAllowedArtifactUrl(downloadUrl: string): string | null {
  try {
    const parsed = new URL(downloadUrl)
    if (parsed.protocol !== 'https:') return null
    if (parsed.hostname !== 'f-droid.org') return null
    if (!parsed.pathname.startsWith('/repo/')) return null
    if (!parsed.pathname.toLowerCase().endsWith('.apk')) return null
    return parsed.toString()
  } catch {
    return null
  }
}

async function handleArtifact(origin: string | null, downloadUrl: string) {
  const normalizedUrl = resolveAllowedArtifactUrl(downloadUrl)
  if (!normalizedUrl) {
    return jsonResponse(origin, 400, { error: 'Unsupported artifact URL' })
  }

  const upstream = await fetch(normalizedUrl, {
    headers: {
      'User-Agent': 'ADBZero-Store-Proxy/1.0',
    },
  })

  if (!upstream.ok || !upstream.body) {
    return jsonResponse(origin, upstream.status || 502, {
      error: 'Artifact fetch failed',
      details: `HTTP ${upstream.status} for ${normalizedUrl}`,
    })
  }

  const headers = new Headers({
    ...corsHeaders(origin),
    'Cache-Control': 'no-store',
    'Content-Type': upstream.headers.get('content-type') || 'application/vnd.android.package-archive',
  })
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) {
    headers.set('Content-Length', contentLength)
  }
  const contentDisposition = upstream.headers.get('content-disposition')
  if (contentDisposition) {
    headers.set('Content-Disposition', contentDisposition)
  }

  return new Response(upstream.body, {
    status: 200,
    headers,
  })
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

  if (!isAllowedOrigin(origin, referrer)) {
    console.warn('[store-fdroid-live] blocked origin', { origin, referrer })
    return jsonResponse(origin, 403, { error: 'Origin not allowed' })
  }

  const requestKey = getRequestIp(req)
  if (isRateLimited(requestKey, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    console.warn('[store-fdroid-live] rate limited', { requestKey })
    return jsonResponse(origin, 429, { error: 'Too many requests' })
  }

  let payloadRaw: unknown
  try {
    payloadRaw = await req.json()
  } catch {
    return jsonResponse(origin, 400, { error: 'Invalid JSON payload' })
  }

  const parsedPayload = requestSchema.safeParse(payloadRaw)
  if (!parsedPayload.success) {
    return jsonResponse(origin, 400, {
      error: parsedPayload.error.issues[0]?.message || 'Invalid payload',
    })
  }
  const payload = parsedPayload.data as RequestPayload

  if (payload.repoId && payload.repoId !== FDROID_REPOSITORY.id) {
    return jsonResponse(origin, 400, { error: 'Only the built-in F-Droid repository is supported by the live backend' })
  }

  try {
    switch (payload.action) {
      case 'snapshot':
        return await handleSnapshot(origin)
      case 'search':
        return await handleSearch(origin, payload.query)
      case 'detail':
        return await handleDetail(origin, payload.packageName)
      case 'artifact':
        return await handleArtifact(origin, payload.downloadUrl)
      default:
        return jsonResponse(origin, 400, { error: 'Unsupported action' })
    }
  } catch (error) {
    return jsonResponse(origin, 500, {
      error: 'Live F-Droid backend failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})
