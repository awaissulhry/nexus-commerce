import type { FactoryClient } from '@nexus/factory-db'
import type { ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { PURCHASING_SUBCONTRACT_MANAGE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import type { CommandTx } from '../../core/command'
import { words, type ApprovalRecord, type RecordAdapter } from './adapter'

/**
 * Samples, colours, leathers and artworks (B-W2b-184; COL-064 "approval requests to partners (samples)"; design
 * links.approve "Sample, colour, leather, artwork: photos and spec, comments with photo markup"; products.samples ›
 * Approval): asked on a record that has a thread and a partner — a brand's style, a quote or an order of a customer, a
 * purchase order of a supplier (a lab dip, a leather), a subcontract order of a workshop. The office sends the photos and
 * files of the record with it (copied onto the request); the answer is kept on the record's thread (the partner's own
 * message, signed) and its marks on the request's photo. No money on any of them.
 */

type Client = FactoryClient | CommandTx

interface Basics {
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
  readonly label: string
  /** Why the record takes no request now (closed, cancelled), or null. */
  readonly closed: string | null
}

function sampleAdapter(recordType: string, view: Permission, ask: Permission, basics: (client: Client, id: string) => Promise<Basics | null>, labelWords: { it: string; en: string }): RecordAdapter {
  return Object.freeze<RecordAdapter>({
    recordType,
    kinds: ['SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK'],
    view,
    ask,
    async read(client, recordId): Promise<ApprovalRecord | null> {
      const row = await basics(client, recordId)
      if (!row) return null
      const held =
        row.companyId === null
          ? `${row.label} is shared by every company: ask on a quote or an order of the customer.`
          : row.partyId === null
            ? `${row.label} is made for no customer or supplier: ask on its quote or order.`
            : row.closed
      return { companyId: row.companyId ?? '', siteId: row.siteId, partyId: row.partyId, label: row.label, held, thread: { type: recordType, id: recordId } }
    },
    async fileRecords(_client, recordId) {
      return [{ type: recordType, id: recordId }]
    },
    async content(client, request, locale: ApprovalLocale) {
      const row = await basics(client, request.recordId)
      return { facts: row ? [{ label: words(locale, labelWords.it, labelWords.en), value: row.label }] : [], revisedOrder: null }
    },
  })
}

const ended = (status: string, label: string, final: readonly string[]): string | null => (final.includes(status) ? `${label} is ${status.toLowerCase()}.` : null)

export const SAMPLE_ADAPTERS: readonly RecordAdapter[] = Object.freeze([
  sampleAdapter(
    'Style',
    PRODUCT_STYLES_VIEW,
    PRODUCT_STYLES_MANAGE,
    async (client, id) => {
      const row = await client.style.findUnique({ where: { id }, select: { companyId: true, brandPartyId: true, code: true, name: true } })
      return row ? { companyId: row.companyId, siteId: null, partyId: row.brandPartyId, label: `${row.code} ${row.name}`, closed: null } : null
    },
    { it: 'Modello', en: 'Style' },
  ),
  sampleAdapter(
    'Quote',
    QUOTES_VIEW,
    QUOTES_MANAGE,
    async (client, id) => {
      const row = await client.quote.findUnique({ where: { id }, select: { companyId: true, partyId: true, number: true, status: true } })
      return row ? { companyId: row.companyId, siteId: null, partyId: row.partyId, label: row.number, closed: ended(row.status, row.number, ['DECLINED', 'EXPIRED', 'CANCELLED']) } : null
    },
    { it: 'Offerta', en: 'Quote' },
  ),
  sampleAdapter(
    'SalesOrder',
    ORDERS_VIEW,
    ORDERS_MANAGE,
    async (client, id) => {
      const row = await client.salesOrder.findUnique({ where: { id }, select: { companyId: true, partyId: true, number: true, status: true } })
      return row ? { companyId: row.companyId, siteId: null, partyId: row.partyId, label: row.number, closed: ended(row.status, row.number, ['CLOSED', 'CANCELLED']) } : null
    },
    { it: 'Ordine', en: 'Order' },
  ),
  sampleAdapter(
    'PurchaseOrder',
    PURCHASING_VIEW,
    PURCHASING_MANAGE,
    async (client, id) => {
      const row = await client.purchaseOrder.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true, number: true, status: true } })
      return row ? { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId, label: row.number, closed: ended(row.status, row.number, ['CLOSED', 'CANCELLED']) } : null
    },
    { it: "Ordine d'acquisto", en: 'Purchase order' },
  ),
  sampleAdapter(
    'SubcontractOrder',
    PURCHASING_VIEW,
    PURCHASING_SUBCONTRACT_MANAGE,
    async (client, id) => {
      const row = await client.subcontractOrder.findUnique({ where: { id }, select: { companyId: true, siteId: true, partyId: true, number: true, status: true } })
      return row ? { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId, label: row.number, closed: ended(row.status, row.number, ['CLOSED', 'CANCELLED']) } : null
    },
    { it: 'Lavorazione', en: 'Subcontract order' },
  ),
])
