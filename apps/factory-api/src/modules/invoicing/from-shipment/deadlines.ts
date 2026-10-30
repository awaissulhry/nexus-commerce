import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { presetDeadline, type InvoiceDeadline } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import type { Reader } from '../store'
import { presetsOf, type DdtRow } from './store'

/**
 * Invoice deadline timers (B-W2a-54; FIN-065 "Deadline timers"; DPR 633/1972 art. 21 c.4): each shipped, not invoiced
 * DDT's own last day to invoice it, by its customer's preset (Party.invoiceTiming, B-W2a-19): a monthly customer's DDT
 * the 15th of the next month (TD24), a per-shipment customer's its 12 days (TD01), then the 15th once they passed
 * (factory-domain from-shipment/deadlines presetDeadline). The one place the date is read: the shipped-not-invoiced list,
 * the deferred invoices due, and the date timers of B-W2a-33's INVOICE_DEADLINE rule (platform/alerts/evaluators.ts) count
 * down to it.
 */
export async function ddtDeadlines(db: Reader, ddts: readonly Pick<DdtRow, 'id' | 'number' | 'date' | 'partyId'>[], today: BusinessDate): Promise<Map<string, InvoiceDeadline>> {
  const presets = await presetsOf(db, ddts.map((ddt) => ddt.partyId))
  return new Map(ddts.map((ddt) => [ddt.id, presetDeadline(ddt, presets.get(ddt.partyId)?.preset ?? 'TD01', today)]))
}
