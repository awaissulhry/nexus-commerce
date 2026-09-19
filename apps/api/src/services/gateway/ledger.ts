/**
 * P1.1 step 9 — where the gateway writes its one ledger row. Its own module so a unit test of a channel
 * client can stand it in with one line (test-support/gateway-stubs.ts) instead of writing rows to the
 * local database.
 *
 * P1.2 — a send made inside an old `recordApiCall` wrapper takes the wrapper's operation name and entity
 * links, and the wrapper writes no row of its own (one row per send, dashboards keep their names).
 * Never throws: a ledger problem must not become a failed channel call.
 */
import * as callLog from '../outbound-api-call-log.service.js'
import type { GatewayLedgerRow } from '../outbound-api-call-log.service.js'
import { logger } from '../../utils/logger.js'

function enclosing(): ReturnType<typeof callLog.claimEnclosingApiCall> {
  // A test may mock the call-log module without this export; vitest throws on a missing mock export.
  try { return callLog.claimEnclosingApiCall() } catch { return null }
}

export async function writeLedgerRow(row: GatewayLedgerRow): Promise<void> {
  try {
    const outer = enclosing()
    const merged: GatewayLedgerRow = outer
      ? {
          ...row,
          operation: outer.operation || row.operation,
          marketplace: row.marketplace ?? outer.marketplace ?? null,
          connectionId: row.connectionId ?? outer.connectionId ?? null,
          productId: row.productId ?? outer.productId ?? null,
          listingId: row.listingId ?? outer.listingId ?? null,
          orderId: row.orderId ?? outer.orderId ?? null,
          triggeredBy: row.triggeredBy ?? outer.triggeredBy,
        }
      : row
    await callLog.recordGatewayCall(merged)
  } catch (err) {
    logger.warn('gateway ledger: row not written', { error: err instanceof Error ? err.message : String(err), operation: row.operation })
  }
}
