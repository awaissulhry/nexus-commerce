/**
 * Etsy order import, and the rule it sets for Etsy STOCK writes (Owner, 2026-10-01).
 *
 * Etsy order import (`receipt-ingest.ts`, the webhook and the poller) writes Etsy's sales into Nexus stock. It runs
 * for an account only when BOTH are true:
 * - the switch `NEXUS_ENABLE_ETSY_ORDER_INGEST=1` is on in the process, and
 * - the account is ACTIVATED: it has its `EtsyReceiptIngest` row (T0), written once by the explicit activation step
 *   (docs/channel-connections/ETSY-INGEST-ACTIVATION.md). Without it the poller skips the account and the webhook
 *   only reads the event back.
 *
 * A stock number sent to Etsy while either is missing is worked out from a stock that does not know what Etsy has
 * sold: it puts those units back on Etsy, and Etsy sells them again. So a QUANTITY write to Etsy needs both, whatever
 * the publish switches say. Prices and content do not.
 *
 * Its own small file so the queue worker and the inventory writer can ask without loading the order writer.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'

export const ETSY_ORDER_INGEST_FLAG = 'NEXUS_ENABLE_ETSY_ORDER_INGEST'

export const etsyOrderIngestEnabled = (): boolean => process.env[ETSY_ORDER_INGEST_FLAG] === '1'

/** Whether the account has its T0 (explicit activation). Read-only; never establishes it. */
export async function etsyIngestActivated(connectionId: string): Promise<boolean> {
  const row = await prisma.etsyReceiptIngest.findUnique({ where: { workspace_connectionId: workspaceKey({ connectionId }) }, select: { activatedAt: true } })
  return row?.activatedAt instanceof Date
}

export interface EtsyStockWriteRefusal {
  code: 'ETSY_ORDER_IMPORT_OFF' | 'ETSY_ORDER_IMPORT_NOT_ACTIVATED'
  sentence: string
}

const PUTS_BACK_SOLD_UNITS = 'A stock number sent now could put back units Etsy has already sold, so nothing was sent to Etsy.'

/**
 * Why an Etsy stock write for this account must not be sent, or null when it may. The switch is asked first (no
 * database read while it is off), then the account's activation. A failed read throws: "could not tell" is never "on".
 */
export async function etsyStockWriteRefusal(connectionId: string): Promise<EtsyStockWriteRefusal | null> {
  if (!etsyOrderIngestEnabled()) {
    return { code: 'ETSY_ORDER_IMPORT_OFF', sentence: `Etsy order import is off (${ETSY_ORDER_INGEST_FLAG} is not 1), so Etsy's own sales do not reach Nexus stock. ${PUTS_BACK_SOLD_UNITS} Turn on Etsy order import first.` }
  }
  if (!(await etsyIngestActivated(connectionId))) {
    return { code: 'ETSY_ORDER_IMPORT_NOT_ACTIVATED', sentence: `Etsy order import is not activated for this Etsy account (it has no activation record), so its sales do not reach Nexus stock. ${PUTS_BACK_SOLD_UNITS} Activate Etsy order import for this account first.` }
  }
  return null
}
