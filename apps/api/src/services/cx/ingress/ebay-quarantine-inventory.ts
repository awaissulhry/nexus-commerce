import type { PoolClient } from 'pg'
import { assertCredentialsMaintenanceKey } from '../../../lib/crypto.js'

interface InventoryRow {
  id: string
  signatureOk: boolean
  payloadPresent: boolean
  payloadKeyId: string | null
  apparentVersion: 'v1' | 'v2' | 'none' | 'malformed'
  resolved: boolean
  ownerKnown: boolean
  receivedAt: Date
}
export interface QuarantineInventoryOptions { pageSize?: number; maxRows?: number; targetKeyArn?: string }
export class QuarantineInventoryError extends Error {
  constructor(readonly code: 'authority_denied' | 'inventory_failed') {
    super('Quarantine inventory could not be completed.'); this.name = 'QuarantineInventoryError'
  }
}

/** Metadata only, through dedicated authority. A completed snapshot is neither
 * cold recovery proof nor a claim about writes arriving after that snapshot. */
export async function readQuarantineInventory(client: Pick<PoolClient, 'query'>, options: QuarantineInventoryOptions = {}) {
  const pageSize = options.pageSize ?? 50, maxRows = options.maxRows ?? 10_000
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100_000) throw new Error('Invalid inventory bounds.')
  if (options.targetKeyArn !== undefined) assertCredentialsMaintenanceKey(options.targetKeyArn)
  const report = { scope: 'all_quarantine' as const, targetKeyArn: options.targetKeyArn ?? null, asOf: '', snapshotComplete: false, examined: 0, verifiedRetained: 0,
    rejectedMetadata: 0, resolved: 0, unresolved: 0, unassignedVerified: 0, oldestUnresolvedAt: null as string | null,
    incompleteReason: null as 'row_limit' | 'time_limit' | null,
    storedKeys: { env: 0, target: 0, otherKms: 0, malformed: 0, missing: 0 },
    apparentFormats: { v1: 0, v2: 0, none: 0, malformed: 0 }, recovery: 'not_checked' as const, retirementReady: false as const }
  let after: string | null = null
  const startedAt = Date.now()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query('SET LOCAL ROLE nexus_ebay_quarantine_maintenance')
    await client.query("SET LOCAL statement_timeout='10s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'")
    const transaction = (await client.query<{ asOf: Date; readOnly: string; isolation: string }>(
      'SELECT transaction_timestamp() AS "asOf", current_setting(\'transaction_read_only\') AS "readOnly", current_setting(\'transaction_isolation\') AS isolation',
    )).rows[0]
    if (transaction.readOnly !== 'on' || transaction.isolation !== 'repeatable read') throw new QuarantineInventoryError('inventory_failed')
    report.asOf = transaction.asOf.toISOString()
    while (report.examined < maxRows) {
      if (Date.now() - startedAt >= 60_000) { report.incompleteReason = 'time_limit'; break }
      const take = Math.min(pageSize, maxRows - report.examined)
      const rows = (await client.query<InventoryRow>('SELECT * FROM public.nexus_ebay_quarantine_inventory($1,$2)', [after, take])).rows
      if (rows.length > take) throw new QuarantineInventoryError('inventory_failed')
      for (const row of rows) {
        if (!row.id || row.id === after || !Object.prototype.hasOwnProperty.call(report.apparentFormats, row.apparentVersion)) throw new QuarantineInventoryError('inventory_failed')
        report.examined++; report.apparentFormats[row.apparentVersion]++
        if (row.resolved) report.resolved++
        else {
          report.unresolved++
          if (row.signatureOk && !row.ownerKnown) report.unassignedVerified++
          const received = row.receivedAt.toISOString()
          if (!report.oldestUnresolvedAt || received < report.oldestUnresolvedAt) report.oldestUnresolvedAt = received
        }
        if (!row.signatureOk) report.rejectedMetadata++
        else {
          if (row.payloadPresent) report.verifiedRetained++
          if (!row.payloadKeyId) report.storedKeys.missing++
          else if (row.payloadKeyId === 'env') report.storedKeys.env++
          else {
            try {
              assertCredentialsMaintenanceKey(row.payloadKeyId)
              if (row.payloadKeyId === options.targetKeyArn) report.storedKeys.target++
              else report.storedKeys.otherKms++
            } catch { report.storedKeys.malformed++ }
          }
        }
        after = row.id
      }
      if (rows.length < take) { report.snapshotComplete = true; break }
    }
    if (!report.snapshotComplete && !report.incompleteReason) {
      if (Date.now() - startedAt >= 60_000) report.incompleteReason = 'time_limit'
      else {
        const lookahead = await client.query<InventoryRow>('SELECT * FROM public.nexus_ebay_quarantine_inventory($1,$2)', [after, 1])
        report.snapshotComplete = lookahead.rows.length === 0
        if (!report.snapshotComplete) report.incompleteReason = 'row_limit'
      }
    }
    await client.query('COMMIT')
    return report
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw new QuarantineInventoryError((error as { code?: string } | null)?.code === '42501' ? 'authority_denied' : 'inventory_failed')
  }
}
