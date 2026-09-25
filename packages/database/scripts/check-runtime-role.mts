import { Client } from 'pg'
import { auditRuntimeRole } from '../runtime-role.js'

// Read-only preflight. Deliberately does not load a local .env or print credentials.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
let client: Client | undefined
try {
  client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, query_timeout: 30_000 })
  await client.connect()
  await auditRuntimeRole(client)
  console.log('Runtime database login passed the privilege audit')
} catch {
  console.error('Runtime database login failed the connection or privilege audit; review the dedicated login and grants')
  process.exitCode = 1
} finally { await client?.end().catch(() => {}) }
