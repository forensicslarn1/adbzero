import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { BUILTIN_STORE_REPOSITORIES } from '@/services/store-api'
import type { StorePackageBinding, StoreRepositorySnapshot } from '@/services/store-types'

interface StoreState {
  repositories: Record<string, StoreRepositorySnapshot>
  bindings: Record<string, StorePackageBinding>
  setRepositories: (repositories: StoreRepositorySnapshot[]) => void
  setRepositorySnapshot: (repository: StoreRepositorySnapshot) => void
  setBindings: (bindings: StorePackageBinding[]) => void
  upsertBinding: (binding: StorePackageBinding) => void
  removeBinding: (packageName: string) => void
  clearBindings: () => void
}

function createRepositoryRecord(): Record<string, StoreRepositorySnapshot> {
  return BUILTIN_STORE_REPOSITORIES.reduce<Record<string, StoreRepositorySnapshot>>((acc, repo) => {
    acc[repo.id] = repo
    return acc
  }, {})
}

export const useStoreStore = create<StoreState>()(
  persist(
    (set) => ({
      repositories: createRepositoryRecord(),
      bindings: {},

      setRepositories: (repositories) =>
        set({
          repositories: repositories.reduce<Record<string, StoreRepositorySnapshot>>((acc, repo) => {
            acc[repo.id] = repo
            return acc
          }, {}),
        }),

      setRepositorySnapshot: (repository) =>
        set((state) => ({
          repositories: {
            ...state.repositories,
            [repository.id]: repository,
          },
        })),

      setBindings: (bindings) =>
        set({
          bindings: bindings.reduce<Record<string, StorePackageBinding>>((acc, binding) => {
            acc[binding.packageName] = binding
            return acc
          }, {}),
        }),

      upsertBinding: (binding) =>
        set((state) => ({
          bindings: {
            ...state.bindings,
            [binding.packageName]: binding,
          },
        })),

      removeBinding: (packageName) =>
        set((state) => {
          const nextBindings = { ...state.bindings }
          delete nextBindings[packageName]
          return { bindings: nextBindings }
        }),

      clearBindings: () => set({ bindings: {} }),
    }),
    {
      name: 'adbzero-store',
      version: 1,
      partialize: (state) => ({
        repositories: state.repositories,
        bindings: state.bindings,
      }),
    }
  )
)

