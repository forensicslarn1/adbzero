import { supabase } from './supabase'

type FunctionInvokeBody =
  | string
  | ArrayBuffer
  | Blob
  | Record<string, any>
  | ReadableStream<Uint8Array>
  | File
  | FormData

interface InvokeStoreFunctionOptions {
  body?: FunctionInvokeBody
  headers?: Record<string, string>
}

function getFunctionStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('context' in error)) {
    return null
  }

  const context = (error as { context?: unknown }).context
  if (!context || typeof context !== 'object' || !('status' in context)) {
    return null
  }

  const status = (context as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

async function getStoreFunctionAuthHeaders(options?: { forceRefresh?: boolean }) {
  const forceRefresh = options?.forceRefresh === true
  const emptyHeaders: Record<string, string> = {}

  if (forceRefresh) {
    const { data, error } = await supabase.auth.refreshSession()
    if (!error && data.session?.access_token) {
      return { Authorization: `Bearer ${data.session.access_token}` }
    }
    console.warn('[store-functions] forceRefresh failed:', error?.message ?? 'no session after refresh')
    return emptyHeaders
  }

  // Primary: use getUser() which always validates server-side and returns a fresh JWT
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError) {
    console.warn('[store-functions] getUser failed:', userError.message)
  }

  if (user) {
    // getUser succeeded — the session is valid, grab the (potentially refreshed) token
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      return { Authorization: `Bearer ${session.access_token}` }
    }
  }

  // Fallback: try explicit refresh
  const { data, error } = await supabase.auth.refreshSession()
  if (!error && data.session?.access_token) {
    return { Authorization: `Bearer ${data.session.access_token}` }
  }

  console.warn('[store-functions] No authenticated session available for store function call')
  return emptyHeaders
}

export async function invokeStoreFunction<T = unknown>(
  functionName: string,
  options: InvokeStoreFunctionOptions = {}
) {
  const invoke = async (authHeaders: Record<string, string>) => supabase.functions.invoke<T>(functionName, {
    ...options,
    headers: {
      ...options.headers,
      ...authHeaders,
    },
  })

  const authHeaders = await getStoreFunctionAuthHeaders()

  if (!authHeaders.Authorization) {
    console.error('[store-functions] Invoking', functionName, 'WITHOUT auth token — will likely fail with 401')
  }

  let response = await invoke(authHeaders)

  if (response.error && getFunctionStatus(response.error) === 401) {
    console.warn('[store-functions]', functionName, 'returned 401, retrying with refreshed session…')
    const refreshedAuthHeaders = await getStoreFunctionAuthHeaders({ forceRefresh: true })
    if (refreshedAuthHeaders.Authorization) {
      response = await invoke(refreshedAuthHeaders)
    }
  }

  return response
}
