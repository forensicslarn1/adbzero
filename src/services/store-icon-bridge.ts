/**
 * Store → Debloater Icon Bridge
 *
 * After a Store catalog sync, this module feeds F-Droid icon URLs into the
 * debloater's icon pipeline so that packages displayed in the debloater can
 * show high-quality icons sourced from trusted repositories — without
 * duplicating data (we reuse the existing store-icon-cache IndexedDB).
 *
 * The bridge also triggers automatic cache eviction on startup.
 */

import { supabase } from './supabase'
import { getCachedIconUrl, evictStaleIcons } from './store-icon-cache'

/** In-memory map: package_name → resolved icon URL (remote). */
const repoIconIndex = new Map<string, string>()

/** Whether the index has been populated at least once. */
let populated = false
let populatePromise: Promise<void> | null = null

/**
 * Build (or refresh) the in-memory index of package_name → icon URL from
 * store_packages + store_repositories.  Lightweight: only fetches two
 * small columns per row.
 */
export async function populateRepoIconIndex(): Promise<void> {
  if (populatePromise) return populatePromise
  populatePromise = _populate()
  return populatePromise
}

async function _populate(): Promise<void> {
  try {
    // 1. Fetch repo base URLs
    const { data: repos, error: repoErr } = await supabase
      .from('store_repositories')
      .select('id, base_url')

    if (repoErr || !repos?.length) return

    const repoBaseUrls = new Map(repos.map((r: { id: string; base_url: string }) => [r.id, r.base_url]))

    // 2. Fetch all package_name + icon_path pairs (very small payload)
    const { data: packages, error: pkgErr } = await supabase
      .from('store_packages')
      .select('repo_id, package_name, icon_path')
      .not('icon_path', 'is', null)

    if (pkgErr || !packages?.length) return

    for (const pkg of packages as { repo_id: string; package_name: string; icon_path: string }[]) {
      const baseUrl = repoBaseUrls.get(pkg.repo_id)
      if (!baseUrl || !pkg.icon_path) continue

      // Resolve relative icon path against repo base URL
      let iconUrl: string
      if (/^https?:\/\//i.test(pkg.icon_path)) {
        iconUrl = pkg.icon_path
      } else {
        iconUrl = new URL(pkg.icon_path.replace(/^\/+/, ''), baseUrl).toString()
      }

      // Only set if not already present (first repo wins — usually the trusted one)
      if (!repoIconIndex.has(pkg.package_name)) {
        repoIconIndex.set(pkg.package_name, iconUrl)
      }
    }

    populated = true
  } catch {
    // best-effort
  } finally {
    populatePromise = null
  }
}

/**
 * Get an icon for a debloater package using the Store repo index.
 * Returns an object-URL from the compressed IndexedDB cache (same cache as
 * StoreIcon), or null if the package has no repo icon.
 *
 * This is meant to be called from the debloater's icon resolution pipeline
 * as an additional fallback *before* attempting expensive device extraction.
 */
export async function getRepoIconForPackage(packageName: string): Promise<string | null> {
  if (!populated) await populateRepoIconIndex()

  const remoteUrl = repoIconIndex.get(packageName)
  if (!remoteUrl) return null

  // Reuse the store-icon-cache pipeline (IndexedDB + WebP compression)
  return getCachedIconUrl(remoteUrl)
}

/**
 * Run best-effort maintenance: evict expired/overflow entries from the
 * store icon IndexedDB cache.  Safe to call on every Store page mount.
 */
export async function runIconCacheMaintenance(): Promise<void> {
  try {
    await evictStaleIcons()
  } catch {
    // best-effort
  }
}
