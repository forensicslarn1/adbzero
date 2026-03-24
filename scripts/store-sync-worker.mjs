import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const cwd = process.cwd()
const envPath = path.join(cwd, '.env')

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return
  }

  const contents = fs.readFileSync(filePath, 'utf8')
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex)
    const value = line.slice(separatorIndex + 1)
    if (!process.env[key]) {
      process.env[key] = value.replace(/^['"]|['"]$/g, '')
    }
  }
}

loadEnvFile(envPath)

const BUILTIN_REPOSITORIES = {
  'fdroid-official': {
    id: 'fdroid-official',
    name: 'F-Droid',
    description: 'Official F-Droid repository',
    baseUrl: 'https://f-droid.org/repo/',
    packagePageBaseUrl: 'https://f-droid.org/en/packages/',
    searchApiUrl: 'https://search.f-droid.org/api/search_apps',
    entryUrl: 'https://f-droid.org/repo/entry.json',
    trustState: 'trusted_builtin',
    trustLabel: 'Built-in pinned trust',
    kind: 'fdroid',
    isBuiltin: true,
    syncEnabled: true,
  },
}

const rawArgs = process.argv.slice(2)
const positionalArgs = rawArgs.filter((value, index) => {
  if (value.startsWith('--')) return false
  return index === 0 || rawArgs[index - 1] !== '--repo-id' && rawArgs[index - 1] !== '--project-ref' && rawArgs[index - 1] !== '--supabase-url'
})

function getArgValue(name, fallback) {
  const index = rawArgs.indexOf(name)
  return index >= 0 ? rawArgs[index + 1] : fallback
}

const repoId = getArgValue('--repo-id', positionalArgs[0] || 'fdroid-official')
const projectRef = getArgValue('--project-ref', positionalArgs[1] || process.env.SUPABASE_PROJECT_REF || '')
const SUPABASE_URL = getArgValue('--supabase-url', positionalArgs[2] || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '')

function resolveServiceRoleKey() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env.SUPABASE_SERVICE_ROLE_KEY
  }

  if (!projectRef) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PROJECT_REF')
  }

  const result = spawnSync('npx', ['supabase', 'projects', 'api-keys', '--project-ref', projectRef, '--output', 'json'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    throw new Error(`Unable to read Supabase API keys for project ${projectRef}`)
  }

  const apiKeys = JSON.parse(result.stdout)
  const serviceRole = apiKeys.find((item) => item.name === 'service_role' || item.id === 'service_role' || item.secret_jwt_template?.role === 'service_role')
  if (!serviceRole?.api_key) {
    throw new Error(`Service role API key not found for project ${projectRef}`)
  }

  return serviceRole.api_key
}

const SUPABASE_SERVICE_ROLE_KEY = resolveServiceRoleKey()

if (!SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL or VITE_SUPABASE_URL')
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function normalizeBaseUrl(input) {
  const parsed = new URL(input)
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`
  }
  return parsed.toString()
}

function buildRepoFileUrl(baseUrl, fileName) {
  if (!fileName) return baseUrl
  if (/^https?:\/\//i.test(fileName)) return fileName
  return new URL(fileName.replace(/^\/+/, ''), baseUrl).toString()
}

function localizeValue(value) {
  if (!value) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string')
    return typeof first === 'string' ? first : undefined
  }
  if (typeof value === 'object') {
    for (const key of ['en-US', 'en-GB', 'en', 'default']) {
      const localized = value[key]
      if (typeof localized === 'string' && localized.trim()) {
        return localized
      }
    }
    const fallback = Object.values(value).find((item) => typeof item === 'string' && item.trim())
    return typeof fallback === 'string' ? fallback : undefined
  }
  return undefined
}

function inferSelectionMode(artifacts) {
  if (artifacts.length <= 1) return 'single'
  if (artifacts.some((artifact) => /(^|[-_.])(base|config|split)/i.test(artifact.fileName))) return 'session'
  if (artifacts.every((artifact) => artifact.abiList.length > 0)) return 'variant'
  return 'multi'
}

function inferArtifactRole(fileName, abiList, totalArtifacts) {
  if (totalArtifacts <= 1) return 'apk'
  if (/(^|[-_.])(base|config|split)/i.test(fileName)) return 'split'
  if (abiList.length > 0) return 'variant'
  return 'apk'
}

function chunkArray(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

async function sha256HexFromBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function fetchJsonWithIntegrity(url, expectedSha256, expectedSize) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const observedSha256 = await sha256HexFromBuffer(bytes)
  const normalizedExpectedSha256 = expectedSha256?.trim().toLowerCase()

  if (normalizedExpectedSha256 && observedSha256 !== normalizedExpectedSha256) {
    throw new Error(`SHA-256 mismatch for ${url}`)
  }

  if (typeof expectedSize === 'number' && expectedSize > 0 && bytes.byteLength !== expectedSize) {
    throw new Error(`Size mismatch for ${url}`)
  }

  return {
    data: JSON.parse(bytes.toString('utf8')),
    sha256: observedSha256,
    size: bytes.byteLength,
  }
}

async function ensureRepository(repositoryId) {
  const builtin = BUILTIN_REPOSITORIES[repositoryId]
  if (builtin) {
    await supabase.from('store_repositories').upsert({
      id: builtin.id,
      name: builtin.name,
      description: builtin.description,
      base_url: builtin.baseUrl,
      package_page_base_url: builtin.packagePageBaseUrl,
      search_api_url: builtin.searchApiUrl,
      entry_url: builtin.entryUrl,
      trust_state: builtin.trustState,
      trust_label: builtin.trustLabel,
      kind: builtin.kind,
      is_builtin: true,
      sync_enabled: true,
      updated_at: new Date().toISOString(),
    })
  }

  const { data, error } = await supabase
    .from('store_repositories')
    .select('*')
    .eq('id', repositoryId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error(`Repository ${repositoryId} not found`)

  return {
    ...data,
    base_url: normalizeBaseUrl(data.base_url),
    package_page_base_url: data.package_page_base_url || normalizeBaseUrl(data.base_url),
    entry_url: data.entry_url || buildRepoFileUrl(data.base_url, 'entry.json'),
  }
}

async function insertChunked(table, rows, size = 500) {
  for (const chunk of chunkArray(rows, size)) {
    const { error } = await supabase.from(table).insert(chunk)
    if (error) throw error
  }
}

async function insertChunkedReturning(table, rows, columns, size = 200) {
  const insertedRows = []

  for (const chunk of chunkArray(rows, size)) {
    const { data, error } = await supabase
      .from(table)
      .insert(chunk)
      .select(columns)

    if (error) throw error
    if (Array.isArray(data) && data.length > 0) {
      insertedRows.push(...data)
    }
  }

  return insertedRows
}

async function syncRepository(repositoryId) {
  const repo = await ensureRepository(repositoryId)
  const nowIso = new Date().toISOString()
  let currentStage = 'initializing'

  const { data: syncRun, error: syncRunError } = await supabase
    .from('store_repo_sync_runs')
    .insert({
      repo_id: repo.id,
      sync_mode: 'full',
      result: 'running',
      packages_touched: 0,
      details: { startedBy: 'store-sync-worker' },
      started_at: nowIso,
    })
    .select('id')
    .single()

  if (syncRunError) throw syncRunError

  try {
    currentStage = 'fetching entry/index metadata'
    const entryResult = await fetchJsonWithIntegrity(repo.entry_url)
    const entry = entryResult.data
    const indexRef = entry.index || {}
    const indexUrl = buildRepoFileUrl(repo.base_url, indexRef.name || 'index-v2.json')
    const signerUrl = buildRepoFileUrl(repo.base_url, 'signer-index.json')

    const [{ data: index, sha256: indexSha256 }, { data: signerIndex }] = await Promise.all([
      fetchJsonWithIntegrity(indexUrl, indexRef.sha256 || null, indexRef.size || null),
      fetchJsonWithIntegrity(signerUrl).catch(() => ({ data: {} })),
    ])

    const packages = Object.entries(index.packages || {})
    const totals = {
      packages: 0,
      releases: 0,
      artifacts: 0,
      signers: 0,
    }

    console.log(`[store-sync-worker] ${repo.id}: fetched index with ${packages.length} packages`)

    currentStage = 'resetting existing catalog rows'
    await supabase.from('store_packages').delete().eq('repo_id', repo.id)
    const packageChunks = chunkArray(packages, 150)

    for (let chunkIndex = 0; chunkIndex < packageChunks.length; chunkIndex += 1) {
      const packageChunk = packageChunks[chunkIndex]
      currentStage = `processing package chunk ${chunkIndex + 1}/${packageChunks.length}`

      const packageRows = packageChunk.map(([packageName, packageEntry]) => {
        const metadata = packageEntry.metadata || {}
        return {
          repo_id: repo.id,
          package_name: packageName,
          app_name: localizeValue(metadata.name) || packageName,
          summary: localizeValue(metadata.summary) || '',
          description: localizeValue(metadata.description) || null,
          license: localizeValue(metadata.license) || null,
          website_url: localizeValue(metadata.webSite) || null,
          source_url: localizeValue(metadata.sourceCode) || null,
          issue_tracker_url: localizeValue(metadata.issueTracker) || null,
          changelog_url: localizeValue(metadata.changelog) || null,
          translation_url: localizeValue(metadata.translation) || null,
          donate_url: localizeValue(metadata.donate) || null,
          icon_path: metadata.icon?.name || null,
          preferred_signer_sha256: typeof metadata.preferredSigner === 'string' ? metadata.preferredSigner : null,
          categories: Array.isArray(metadata.categories) ? metadata.categories : [],
          anti_features: metadata.antiFeatures ? Object.keys(metadata.antiFeatures) : [],
          metadata,
          updated_at: nowIso,
        }
      })

      const insertedPackages = await insertChunkedReturning('store_packages', packageRows, 'id, package_name', 150)
      totals.packages += insertedPackages.length

      const packageIdMap = new Map(insertedPackages.map((row) => [row.package_name, row.id]))
      const releaseRows = []
      const artifactSeedRows = []
      const signerRows = []

      for (const [packageName, packageEntry] of packageChunk) {
        const repoPackageId = packageIdMap.get(packageName)
        if (!repoPackageId) continue

        const grouped = new Map()
        const versions = packageEntry.versions || {}

        for (const [, versionEntry] of Object.entries(versions)) {
          const manifest = versionEntry.manifest || {}
          if (typeof manifest.versionCode !== 'number' || !manifest.versionName || !versionEntry.file?.name) {
            continue
          }

          const signerSha256 =
            manifest.signer?.sha256?.[0] ||
            signerIndex[packageName]?.signer ||
            null

          const releaseKey = `${manifest.versionCode}:${manifest.versionName}:${signerSha256 || 'unsigned'}`
          const existing = grouped.get(releaseKey) || {
            repoPackageId,
            versionKey: releaseKey,
            versionCode: manifest.versionCode,
            versionName: manifest.versionName,
            minSdk: manifest.usesSdk?.minSdkVersion ?? null,
            targetSdk: manifest.usesSdk?.targetSdkVersion ?? null,
            signerSha256,
            addedAt: versionEntry.added ? new Date(versionEntry.added).toISOString() : null,
            artifacts: [],
          }

          existing.artifacts.push({
            fileName: versionEntry.file.name.replace(/^\/+/, ''),
            downloadUrl: buildRepoFileUrl(repo.base_url, versionEntry.file.name),
            sha256: versionEntry.file.sha256 ?? null,
            sizeBytes: versionEntry.file.size ?? null,
            abiList: manifest.nativecode || [],
            metadata: versionEntry,
          })

          grouped.set(releaseKey, existing)
        }

        for (const release of grouped.values()) {
          releaseRows.push({
            repo_package_id: release.repoPackageId,
            version_key: release.versionKey,
            version_code: release.versionCode,
            version_name: release.versionName,
            min_sdk: release.minSdk,
            target_sdk: release.targetSdk,
            signer_sha256: release.signerSha256,
            added_at: release.addedAt,
            artifact_selection_mode: inferSelectionMode(release.artifacts),
            metadata: {},
            updated_at: nowIso,
          })

          if (release.signerSha256) {
            signerRows.push({
              repo_package_id: repoPackageId,
              signer_sha256: release.signerSha256,
              source: 'repo_index',
              status: 'active',
              last_seen_at: nowIso,
            })
          }

          release.artifacts.forEach((artifact, indexInRelease) => {
            artifactSeedRows.push({
              repoPackageId,
              versionKey: release.versionKey,
              fileName: artifact.fileName,
              downloadUrl: artifact.downloadUrl,
              sha256: artifact.sha256,
              sizeBytes: artifact.sizeBytes,
              abiList: artifact.abiList,
              artifactRole: inferArtifactRole(artifact.fileName, artifact.abiList, release.artifacts.length),
              isPrimary: indexInRelease === 0 || /(^|[-_.])base/i.test(artifact.fileName),
              sortOrder: indexInRelease,
              metadata: artifact.metadata,
            })
          })
        }
      }

      const insertedReleases = releaseRows.length > 0
        ? await insertChunkedReturning('store_releases', releaseRows, 'id, repo_package_id, version_key', 150)
        : []
      totals.releases += insertedReleases.length

      const releaseIdMap = new Map(insertedReleases.map((row) => [`${row.repo_package_id}:${row.version_key}`, row.id]))

      const artifactRows = artifactSeedRows.flatMap((artifact) => {
        const releaseId = releaseIdMap.get(`${artifact.repoPackageId}:${artifact.versionKey}`)
        if (!releaseId) return []

        return [{
          release_id: releaseId,
          filename: artifact.fileName,
          download_url: artifact.downloadUrl,
          sha256: artifact.sha256,
          size_bytes: artifact.sizeBytes,
          abi_list: artifact.abiList,
          artifact_role: artifact.artifactRole,
          is_primary: artifact.isPrimary,
          sort_order: artifact.sortOrder,
          metadata: artifact.metadata,
          updated_at: nowIso,
        }]
      })

      if (artifactRows.length > 0) {
        await insertChunked('store_release_artifacts', artifactRows, 200)
      }
      totals.artifacts += artifactRows.length

      if (signerRows.length > 0) {
        const dedupedSignerRows = Array.from(
          new Map(signerRows.map((row) => [`${row.repo_package_id}:${row.signer_sha256}`, row])).values()
        )
        await insertChunked('store_package_signers', dedupedSignerRows, 200)
        totals.signers += dedupedSignerRows.length
      }

      if ((chunkIndex + 1) % 5 === 0 || chunkIndex === packageChunks.length - 1) {
        console.log(
          `[store-sync-worker] ${repo.id}: ${chunkIndex + 1}/${packageChunks.length} chunks, ` +
          `${totals.packages} packages, ${totals.releases} releases, ${totals.artifacts} artifacts`
        )
      }
    }

    currentStage = 'persisting repository snapshot'
    await supabase.from('store_repo_index_snapshots').upsert({
      repo_id: repo.id,
      entry_timestamp: entry.timestamp ?? null,
      index_json: {
        __full: false,
        repo: index.repo || {},
        packageCount: packages.length,
        indexSha256: indexSha256 || indexRef.sha256 || null,
        generatedBy: 'store-sync-worker',
      },
      updated_at: nowIso,
    }, { onConflict: 'repo_id' })

    currentStage = 'updating repository state'
    await supabase
      .from('store_repositories')
      .update({
        entry_timestamp: entry.timestamp ?? null,
        max_age_days: entry.maxAge ?? null,
        package_count: totals.packages,
        index_size_bytes: indexRef.size ?? null,
        index_sha256: indexSha256 || indexRef.sha256 || null,
        metadata: index.repo || {},
        last_synced_at: nowIso,
        last_error: null,
        verification_state: 'verified',
        verification_details: 'Catalog synchronized by store-sync-worker.',
        last_verified_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', repo.id)

    await supabase
      .from('store_repo_sync_state')
      .upsert({
        repo_id: repo.id,
        last_entry_timestamp: entry.timestamp ?? null,
        last_sync_mode: 'full',
        last_synced_at: nowIso,
        last_success_at: nowIso,
        last_error: null,
        retry_count: 0,
        next_retry_at: null,
        updated_at: nowIso,
      }, { onConflict: 'repo_id' })

    await supabase
      .from('store_repo_sync_runs')
      .update({
        result: 'success',
        packages_touched: totals.packages,
        details: {
          packageCount: totals.packages,
          releaseCount: totals.releases,
          artifactCount: totals.artifacts,
          signerCount: totals.signers,
          snapshotMode: 'metadata-only',
          syncSource: 'store-sync-worker',
        },
        finished_at: new Date().toISOString(),
      })
      .eq('id', syncRun.id)

    console.log(
      `[store-sync-worker] synchronized ${repo.id}: ` +
      `${totals.packages} packages, ${totals.releases} releases, ${totals.artifacts} artifacts, ${totals.signers} signers`
    )
  } catch (error) {
    const message = error instanceof Error
      ? `${currentStage}: ${error.message}`
      : `${currentStage}: Unknown sync error`
    await supabase
      .from('store_repositories')
      .update({
        last_error: message,
        verification_state: 'verification_failed',
        verification_details: message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', repo.id)

    await supabase
      .from('store_repo_sync_state')
      .upsert({
        repo_id: repo.id,
        last_sync_mode: 'full',
        last_error: message,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'repo_id' })

    await supabase
      .from('store_repo_sync_runs')
      .update({
        result: 'error',
        details: { error: message, syncSource: 'store-sync-worker' },
        finished_at: new Date().toISOString(),
      })
      .eq('id', syncRun.id)

    throw error
  }
}

syncRepository(repoId).catch((error) => {
  console.error('[store-sync-worker] failed:', error)
  process.exitCode = 1
})
