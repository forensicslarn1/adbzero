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

export function toStoreBackendError(error: unknown, action: 'sync' | 'scheduler' | 'repository'): Error {
  const message = error instanceof Error ? error.message : String(error)
  const status = getFunctionStatus(error)

  if (/Failed to send a request to the Edge Function/i.test(message)) {
    if (action === 'sync') {
      return new Error(
        'Store backend unreachable. Verify that the Edge Function `store-sync-fdroid` is deployed to the same Supabase project used by this frontend and that the function CORS origin configuration allows this site.'
      )
    }

    if (action === 'scheduler') {
      return new Error(
        'Store scheduler backend unreachable. Verify that the Edge Function `store-sync-scheduler` is deployed to the same Supabase project used by this frontend and that the function CORS origin configuration allows this site.'
      )
    }

    return new Error(
      'Store repository backend unreachable. Verify that the Edge Function `store-manage-repository` is deployed to the same Supabase project used by this frontend and that the function CORS origin configuration allows this site.'
    )
  }

  if (/Edge Function returned a non-2xx status code/i.test(message)) {
    if (status === 401) {
      return new Error('Store sync requires an authenticated session. Sign in again and retry.')
    }

    if (status === 403) {
      return new Error('Store sync was denied by the backend for this session. Verify admin permissions or backend admin configuration, then retry.')
    }

    if (status === 404) {
      return new Error('Store backend route not found. Verify that the Edge Function is deployed to the same Supabase project used by this frontend.')
    }

    if (status === 500) {
      return new Error('Store sync backend failed internally. Check the Edge Function state and repository sync details, then retry.')
    }
  }

  return error instanceof Error ? error : new Error(message)
}
