import { Pool } from 'pg'
import { pathToFileURL } from 'node:url'
import { assertCredentialsMaintenanceKey } from '../lib/crypto.js'
import { readQuarantineInventory, QuarantineInventoryError, type QuarantineInventoryOptions } from '../services/cx/ingress/ebay-quarantine-inventory.js'

export function parseInventoryArguments(args: string[]): QuarantineInventoryOptions {
  const options: QuarantineInventoryOptions = {}, seen = new Set<string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (seen.has(key) || value === undefined) throw new Error('Invalid inventory arguments.')
    seen.add(key)
    if (key === '--target-key-arn') { assertCredentialsMaintenanceKey(value); options.targetKeyArn = value }
    else if (key === '--max-rows' || key === '--page-size') {
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid inventory bounds.')
      const n = Number(value), maximum = key === '--max-rows' ? 100_000 : 100
      if (!Number.isSafeInteger(n) || n > maximum) throw new Error('Invalid inventory bounds.')
      if (key === '--max-rows') options.maxRows = n; else options.pageSize = n
    } else throw new Error('Unknown inventory argument.')
  }
  return options
}

/** No dotenv loading, app pool, tenant cron, or DATABASE_URL fallback. The operator
 * supplies a separate login with SET membership in the dedicated maintenance role. */
export async function quarantineInventoryMain(args: string[], env: NodeJS.ProcessEnv) {
  const options = parseInventoryArguments(args), connectionString = env.CX_QUARANTINE_MAINTENANCE_DATABASE_URL
  if (!connectionString) throw new Error('Dedicated quarantine maintenance connection is required.')
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000, application_name: 'nexus-quarantine-inventory' })
  pool.on('error', () => {}) // A dropped session fails the next query statically instead of crashing with server text.
  try {
    const client = await pool.connect()
    client.on('error', () => {})
    try { return await readQuarantineInventory(client, options) }
    finally { client.release() }
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  quarantineInventoryMain(process.argv.slice(2), process.env).then(report => {
    console.log(JSON.stringify(report, null, 2))
    if (!report.snapshotComplete) process.exitCode = 2
  }).catch(error => {
    console.error(JSON.stringify({ error: error instanceof QuarantineInventoryError ? error.code : 'inventory_unavailable' }))
    process.exitCode = 1
  })
}
