/**
 * P1.1 step 9 — where the gateway writes its one ledger row. Its own module so a unit test of a channel
 * client can stand it in with one line (test-support/gateway-stubs.ts) instead of writing rows to the
 * local database.
 */
import { recordGatewayCall, type GatewayLedgerRow } from '../outbound-api-call-log.service.js'

export function writeLedgerRow(row: GatewayLedgerRow): Promise<void> {
  return recordGatewayCall(row)
}
