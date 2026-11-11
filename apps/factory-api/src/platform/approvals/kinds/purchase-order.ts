import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandTx } from '../../../core/command'
import type { ApprovalField } from '@nexus/factory-domain/approvals/rules'
import type { ApprovalKindDefinition, ApprovalSubject, Reader } from './kind'

/**
 * PURCHASE_ORDER (SCM-078; B-W2b-282's reference kind): a purchase order before it is sent. The facts its rules test: the
 * order's value (the cost grain: the sum of its lines, in the order's currency), its currency, how many lines, the
 * supplier's status and code, and its site's code. The fingerprint covers the order as it would go to the supplier: header
 * (supplier, contact, currency, dates, terms, the note printed for the supplier) and every line (item, colour, quantity,
 * unit, price, need date, specification), so a line changed after the request makes it STALE. B-W2b-305 asks it from the
 * send (send.ts, "pending approval only") and sends the order on the yes (onApproved); until then a person asks it from
 * the generic route, and the yes changes nothing on the order.
 */

const HELD_SENT = 'This purchase order is not a draft any more: a yes is asked before it is sent.'

const ORDER_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  status: true,
  revision: true,
  currency: true,
  orderDate: true,
  requestedDate: true,
  incoterms: true,
  paymentTerms: true,
  note: true,
  partyId: true,
  contactId: true,
  party: { select: { code: true, legalName: true, status: true } },
  site: { select: { code: true } },
} as const

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const order = await client.purchaseOrder.findUnique({ where: { id: recordId }, select: ORDER_SELECT })
  if (!order) return null
  const lines = await client.purchaseOrderLine.findMany({
    where: { purchaseOrderId: recordId },
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    select: { id: true, seq: true, itemId: true, itemColourId: true, description: true, quantity: true, uom: true, unitPrice: true, netAmount: true, needDate: true, grade: true, thicknessMinMm: true, thicknessMaxMm: true, oneDyeBatch: true, areaTolerancePct: true, requiresCrViTest: true, note: true },
  })
  const minor = lines.reduce((sum, line) => sum + line.netAmount, 0)
  const value = fromMinorUnits(minor, order.currency).toFixed()
  const count = lines.length
  const supplier = order.party.legalName
  return {
    companyId: order.companyId,
    siteId: order.siteId,
    label: `${order.number} · ${supplier}`,
    summary: `${order.number} to ${supplier}: ${count === 1 ? '1 line' : `${count} lines`}, to be sent`.slice(0, 500),
    facts: {
      orderValue: value,
      currency: order.currency,
      lineCount: count,
      supplierStatus: order.party.status,
      supplierCode: order.party.code,
      siteCode: order.site.code,
    },
    snapshot: {
      number: order.number,
      status: order.status,
      revision: order.revision,
      partyId: order.partyId,
      contactId: order.contactId,
      currency: order.currency,
      orderDate: order.orderDate,
      requestedDate: order.requestedDate,
      incoterms: order.incoterms,
      paymentTerms: order.paymentTerms,
      note: order.note,
      siteId: order.siteId,
      lines,
    },
    changes: [{ field: 'status', from: order.status, to: 'SENT' }],
    held: order.status === 'DRAFT' ? null : HELD_SENT,
  }
}

export const PURCHASE_ORDER_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'PURCHASE_ORDER',
  recordType: 'PurchaseOrder',
  label: { en: 'Purchase order', it: "Ordine d'acquisto" },
  view: PURCHASING_VIEW,
  ask: PURCHASING_MANAGE,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'orderValue', label: { en: 'order value', it: "valore dell'ordine" }, kind: 'number', grain: 'cost', min: 0 },
    { id: 'currency', label: { en: 'currency', it: 'valuta' }, kind: 'text' },
    { id: 'lineCount', label: { en: 'lines', it: 'righe' }, kind: 'number', unit: null, min: 0 },
    {
      id: 'supplierStatus',
      label: { en: 'supplier status', it: 'stato del fornitore' },
      kind: 'choice',
      options: [
        { value: 'PROSPECT', label: { en: 'Prospect', it: 'Potenziale' } },
        { value: 'ACTIVE', label: { en: 'Active', it: 'Attivo' } },
        { value: 'BLOCKED', label: { en: 'Blocked', it: 'Bloccato' } },
        { value: 'ARCHIVED', label: { en: 'Archived', it: 'Archiviato' } },
      ],
    },
    { id: 'supplierCode', label: { en: 'supplier code', it: 'codice fornitore' }, kind: 'text' },
    { id: 'siteCode', label: { en: 'site code', it: 'codice sede' }, kind: 'text' },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await tx.$queryRaw`SELECT 1 FROM "PurchaseOrder" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.purchaseOrder.findMany({ where: companyId ? { companyId } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
})
