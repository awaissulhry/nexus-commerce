import { Pool, type PoolClient } from 'pg'
import { assertCredentialsMaintenanceKey } from '../lib/crypto.js'

export class QuarantineArgumentsError extends Error {
  readonly code = 'invalid_arguments'
  constructor() { super('Invalid quarantine maintenance arguments.'); this.name = 'QuarantineArgumentsError' }
}
export interface MaintenanceArguments { targetKeyArn: string; maxRows?: number; budgetMs?: number }

/** Verify/rewrap arguments. `--apply` (exactly once) is accepted only where the
 * command writes; every refusal happens before any connection is made. */
export function parseMaintenanceArguments(args: string[], writes: boolean): MaintenanceArguments {
  const rest = [...args], seen = new Set<string>(), options: Partial<MaintenanceArguments> = {}
  if (writes) {
    if (rest.filter(arg => arg === '--apply').length !== 1) throw new QuarantineArgumentsError()
    rest.splice(rest.indexOf('--apply'), 1)
  }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1]
    if (seen.has(key) || value === undefined) throw new QuarantineArgumentsError()
    seen.add(key)
    if (key === '--target-key-arn') {
      try { assertCredentialsMaintenanceKey(value) } catch { throw new QuarantineArgumentsError() }
      options.targetKeyArn = value
    } else if (key === '--max-rows' || key === '--budget-seconds') {
      const n = /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN
      if (key === '--max-rows' && n <= 10_000) options.maxRows = n
      else if (key === '--budget-seconds' && n >= 60 && n <= 1_800) options.budgetMs = n * 1_000
      else throw new QuarantineArgumentsError()
    } else throw new QuarantineArgumentsError()
  }
  if (!options.targetKeyArn) throw new QuarantineArgumentsError()
  return options as MaintenanceArguments
}

/** The dedicated operator login only: no dotenv, no DATABASE_URL fallback. A server
 * that ends the session during KMS work surfaces as a failed next query, never as an
 * unhandled 'error' event that would crash with the server's own text. */
export async function withMaintenanceClient<T>(env: NodeJS.ProcessEnv, applicationName: string, run: (client: PoolClient) => Promise<T>) {
  const connectionString = env.CX_QUARANTINE_MAINTENANCE_DATABASE_URL
  if (!connectionString) throw new Error('Dedicated quarantine maintenance connection is required.')
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000, application_name: applicationName })
  pool.on('error', () => {})
  try {
    const client = await pool.connect()
    client.on('error', () => {})
    // Always discard the connection: after an unknown outcome it may still carry an
    // open transaction, and the server rolls back whatever it never saw committed.
    try { return await run(client) }
    finally { client.release(true) }
  } finally { await pool.end() }
}

/** SIGINT/SIGTERM become the operator's cancellation signal (reported `cancelled`). */
export function runOperatorCommand<T extends { complete: boolean }>(main: (signal: AbortSignal) => Promise<T>, errorCode: (error: unknown) => string) {
  const controller = new AbortController(), stop = () => controller.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  main(controller.signal).then(report => {
    console.log(JSON.stringify(report, null, 2))
    if (!report.complete) process.exitCode = 2
  }).catch(error => {
    console.error(JSON.stringify({ error: error instanceof QuarantineArgumentsError ? error.code : errorCode(error) }))
    process.exitCode = 1
  }).finally(() => { process.off('SIGINT', stop); process.off('SIGTERM', stop) })
}
