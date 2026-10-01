/**
 * The Etsy order-import switch, and the rule it sets for Etsy STOCK writes (Owner, 2026-10-01).
 *
 * Etsy order import (`receipt-ingest.ts`, the webhook and the poller) writes Etsy's sales into Nexus stock, and it is
 * off unless `NEXUS_ENABLE_ETSY_ORDER_INGEST=1`. A stock number sent to Etsy while it is off is worked out from a
 * stock that does not know what Etsy has sold: it puts those units back on Etsy, and Etsy sells them again. So a
 * QUANTITY write to Etsy needs order import on, whatever the publish switches say. Prices and content do not.
 *
 * Its own small file so the queue worker and the inventory writer can ask without loading the order writer.
 */
export const ETSY_ORDER_INGEST_FLAG = 'NEXUS_ENABLE_ETSY_ORDER_INGEST'

export const etsyOrderIngestEnabled = (): boolean => process.env[ETSY_ORDER_INGEST_FLAG] === '1'

/** The sentence to show when an Etsy stock write must not be sent, or null when it may. */
export function etsyStockWriteRefusal(): string | null {
  if (etsyOrderIngestEnabled()) return null
  return `Etsy order import is off (${ETSY_ORDER_INGEST_FLAG} is not 1), so Etsy's own sales do not reach Nexus stock. A stock number sent now could put back units Etsy has already sold, so nothing was sent to Etsy. Turn on Etsy order import first.`
}
