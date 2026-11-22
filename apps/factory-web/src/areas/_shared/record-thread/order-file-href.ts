import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'

/**
 * F-OF-101 (order FILES tab, 10-design §5; plan §2 "Open on <its home> ›"): where a block's door goes — the source record's own page
 * (a work order, an inspection, a shipment, a DDT, an invoice, a case: its page keeps every command for its files, one path per job);
 * a change request's files open on this order's Changes tab; the order's own files and its lines' have no door (their acts are on the
 * card). `prefix` is the company's (`/w/<code>`), `companyId` the order's. Pure.
 */
export function orderFileHrefOf(record: { readonly type: string; readonly id: string; readonly label: string }, order: { readonly prefix: string; readonly id: string; readonly companyId: string | null }): string | null {
  if (record.type === 'SalesOrder' || record.type === 'SalesOrderLine') return null
  if (record.type === 'OrderChangeRequest' || record.type === 'OrderChangeRequestLine') return `${order.prefix}/sales/orders/${encodeURIComponent(order.id)}?tab=changes`
  return `${order.prefix}${recordAddress({ type: record.type, id: record.id, label: record.label, companyId: order.companyId }, OFFICE_PAGES)}`
}
