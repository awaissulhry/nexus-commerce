import { Pool } from 'pg'
import { pathToFileURL } from 'node:url'
import { readEbayDeletionCensus, EbayDeletionCensusError } from '../services/cx/ingress/ebay-deletion-census.js'

/** No dotenv, ordinary app connection fallback, decryption, or mutation mode. */
export async function ebayDeletionCensusMain(args: string[], env: NodeJS.ProcessEnv) {
  if (args.length) throw new Error('The eBay deletion census accepts no arguments.')
  const connectionString = env.CX_QUARANTINE_MAINTENANCE_DATABASE_URL
  if (!connectionString) throw new Error('Dedicated quarantine maintenance connection is required.')
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000, application_name: 'nexus-ebay-deletion-census' })
  pool.on('error', () => {})
  try {
    const client = await pool.connect()
    client.on('error', () => {})
    try { return await readEbayDeletionCensus(client) }
    finally { client.release() }
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ebayDeletionCensusMain(process.argv.slice(2), process.env).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(JSON.stringify({ error: error instanceof EbayDeletionCensusError ? error.code : 'census_unavailable' }))
    process.exitCode = 1
  })
}
