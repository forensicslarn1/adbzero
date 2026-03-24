import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return
  }

  const contents = readFileSync(filePath, 'utf8')
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) {
      continue
    }

    const [, key, rawValue] = match
    if (process.env[key]) {
      continue
    }

    const value = rawValue.replace(/^['"]|['"]$/g, '')
    process.env[key] = value
  }
}

loadEnvFile(path.resolve(process.cwd(), '.env'))

const rawArgs = process.argv.slice(2)
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--')))
const getArgValue = (name) => {
  const index = rawArgs.indexOf(name)
  return index >= 0 ? rawArgs[index + 1] : undefined
}

const projectRef = getArgValue('--project-ref') || process.env.SUPABASE_PROJECT_REF
const dbPassword = getArgValue('--db-password') || process.env.SUPABASE_DB_PASSWORD
const dbUrl = getArgValue('--db-url') || process.env.SUPABASE_DB_URL
const dryRun = flags.has('--dry-run')
const skipDb = flags.has('--skip-db')
const skipFunctions = flags.has('--skip-functions')
const shouldLink = !skipDb && !dbUrl && projectRef && !existsSync(path.resolve(process.cwd(), 'supabase', 'config.toml'))

function run(command, args) {
  const printable = [command, ...args].join(' ')
  console.log(`\n> ${printable}`)

  if (dryRun) {
    return
  }

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

if (shouldLink) {
  run('npx', ['supabase', 'link', '--project-ref', projectRef])
}

if (!skipDb) {
  const dbArgs = ['supabase', 'db', 'push', '--include-all']
  if (dbUrl) {
    dbArgs.push('--db-url', dbUrl)
  }
  if (dbPassword) {
    dbArgs.push('--password', dbPassword)
  }
  run('npx', dbArgs)
}

if (!skipFunctions) {
  const secretEntries = [
    ['STORE_ALLOWED_ORIGINS', process.env.STORE_ALLOWED_ORIGINS || process.env.CMS_ALLOWED_ORIGINS || ''],
    ['CMS_ALLOWED_ORIGINS', process.env.CMS_ALLOWED_ORIGINS || process.env.STORE_ALLOWED_ORIGINS || ''],
    ['ADMIN_UIDS', process.env.ADMIN_UIDS || process.env.VITE_ADMIN_UIDS || ''],
  ].filter(([, value]) => Boolean(value))

  if (secretEntries.length > 0) {
    const secretArgs = ['supabase', 'secrets', 'set', ...secretEntries.map(([key, value]) => `${key}=${value}`)]
    if (projectRef) {
      secretArgs.push('--project-ref', projectRef)
    }
    run('npx', secretArgs)
  }

  const functions = [
    'store-sync-fdroid',
    'store-fdroid-live',
    'store-manage-repository',
    'store-sync-scheduler',
  ]

  for (const fn of functions) {
    const fnArgs = ['supabase', 'functions', 'deploy', fn, '--use-api']
    if (fn === 'store-sync-fdroid' || fn === 'store-fdroid-live') {
      fnArgs.push('--no-verify-jwt')
    }
    if (projectRef) {
      fnArgs.push('--project-ref', projectRef)
    }
    run('npx', fnArgs)
  }
}

if (dryRun) {
  console.log('\nDry run complete.')
}
