import type {
  StorePackageDetail,
  StoreRepositorySnapshot,
  StoreSearchResult,
} from './store-types'
import { invokeStoreFunction } from './store-functions'
import { toStoreBackendError } from './store-errors'

interface LiveSnapshotResponse {
  ok: boolean
  snapshot: StoreRepositorySnapshot
}

interface LiveSearchResponse {
  ok: boolean
  results: StoreSearchResult[]
}

interface LiveDetailResponse {
  ok: boolean
  detail: StorePackageDetail
}

export async function fetchLiveFdroidRepositorySnapshot(repoId: string): Promise<StoreRepositorySnapshot> {
  const { data, error } = await invokeStoreFunction<LiveSnapshotResponse>('store-fdroid-live', {
    body: {
      action: 'snapshot',
      repoId,
    },
  })

  if (error) {
    throw toStoreBackendError(error, 'sync')
  }

  if (!data?.snapshot) {
    throw new Error('Live Store snapshot is unavailable')
  }

  return data.snapshot
}

export async function searchLiveFdroidPackages(
  query: string,
  repoId: string
): Promise<StoreSearchResult[]> {
  const { data, error } = await invokeStoreFunction<LiveSearchResponse>('store-fdroid-live', {
    body: {
      action: 'search',
      repoId,
      query,
    },
  })

  if (error) {
    throw toStoreBackendError(error, 'sync')
  }

  return data?.results || []
}

export async function fetchLiveFdroidPackageDetail(
  packageName: string,
  repoId: string
): Promise<StorePackageDetail> {
  const { data, error } = await invokeStoreFunction<LiveDetailResponse>('store-fdroid-live', {
    body: {
      action: 'detail',
      repoId,
      packageName,
    },
  })

  if (error) {
    throw toStoreBackendError(error, 'sync')
  }

  if (!data?.detail) {
    throw new Error('Live Store package detail is unavailable')
  }

  return data.detail
}
