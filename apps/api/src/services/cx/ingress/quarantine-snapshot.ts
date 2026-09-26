import type { PoolClient, QueryResultRow } from 'pg'
import { performance } from 'node:perf_hooks'

export class QuarantineDeadlineError extends Error {
  constructor() { super('Quarantine read deadline expired.'); this.name = 'QuarantineDeadlineError' }
}
function remaining(deadline?: number) {
  if (deadline === undefined) return 10_000
  const ms = Math.floor(deadline - performance.now())
  if (ms <= 0) throw new QuarantineDeadlineError()
  return Math.min(10_000, ms)
}
/** Re-evaluate the remaining monotonic budget for each potentially large read. */
export async function boundedQuarantineQuery<T extends QueryResultRow>(client: Pick<PoolClient, 'query'>, sql: string, values: unknown[], deadline: number) {
  await client.query("SELECT set_config('statement_timeout',$1,true)", [`${remaining(deadline)}ms`])
  remaining(deadline)
  const result = await client.query<T>(sql, values)
  remaining(deadline)
  return result
}

/** Metadata authority, or the separate custodian authority that may read ciphertext. */
export type QuarantineRole = 'nexus_ebay_quarantine_maintenance' | 'nexus_ebay_quarantine_custodian'

/** Exclusive operator connection only. The callback must contain bounded database
 * reads/local computation, never KMS/network work that would pin an old snapshot.
 * `asOf` is the transaction start: a lower bound for the snapshot, which PostgreSQL
 * takes at the first statement after BEGIN. */
export async function withQuarantineSnapshot<T>(client: Pick<PoolClient, 'query'>, read: (asOf: string) => Promise<T>, deadline?: number,
  role: QuarantineRole = 'nexus_ebay_quarantine_maintenance'): Promise<T> {
  try {
    remaining(deadline)
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query(`SET LOCAL ROLE ${role === 'nexus_ebay_quarantine_custodian' ? role : 'nexus_ebay_quarantine_maintenance'}`)
    if (deadline === undefined) await client.query("SET LOCAL statement_timeout='10s'")
    else await client.query("SELECT set_config('statement_timeout',$1,true)", [`${remaining(deadline)}ms`])
    await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'")
    const transaction = (await client.query<{ asOf: Date; readOnly: string; isolation: string }>(
      'SELECT transaction_timestamp() AS "asOf", current_setting(\'transaction_read_only\') AS "readOnly", current_setting(\'transaction_isolation\') AS isolation',
    )).rows[0]
    if (transaction.readOnly !== 'on' || transaction.isolation !== 'repeatable read') throw new Error('Quarantine reads require a read-only repeatable-read transaction.')
    remaining(deadline)
    const result = await read(transaction.asOf.toISOString())
    remaining(deadline)
    await client.query('COMMIT')
    remaining(deadline)
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}
