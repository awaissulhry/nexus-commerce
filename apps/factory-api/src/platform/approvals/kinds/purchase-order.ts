import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { valueIncreaseOf } from '@nexus/factory-domain/purchasing/po-approvals/approvals'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { ApprovalField } from '@nexus/factory-domain/approvals/rules'
// B-W2b-305: what the order does with the decision (sent with the yes; a draft again after a no).
import { afterApproved, backToDraft, previousSentValue } from '../../../modules/purchasing/po-approvals/hooks'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * PURCHASE_ORDER (SCM-078, SCM-080; B-W2b-282's reference kind, wired by B-W2b-305): a purchase order before it is sent.
 * The facts its rules test: the order's value (the cost grain: the sum of its lines not cancelled, in the order's
 * currency), its currency, how many lines, the supplier's status and code, its site's code; B-W2b-305: its revision, and
 * the value added since the revision sent before (the cost grain; null on a first revision, so a rule on it asks only on a
 * change). The fingerprint covers the order as it would go to the supplier: header (supplier, contact, currency, dates,
 * terms, the note printed for the supplier, the kind, the rate at order, where it is delivered) and every line (item,
 * colour, quantity, unit, price, need date, specification, rolls, certificate, variant, cancelled) with its delivery
 * schedule; NOT its status (a draft and the same order waiting for its yes are one subject) beyond "not sent yet", so a
 * line changed after the request, or the order sent or cancelled meanwhile, makes it STALE.
 *
 * B-W2b-305: the purchasing module asks it from the send (modules/purchasing/send.ts → po-approvals/gate.ts: the order
 * DRAFT → PENDING_APPROVAL in the same command) and the yes sends it (onApproved: purchase_order.approved, then the
 * worker's send as the person who asked); a no, a withdrawal or a change makes it a draft again. A request asked from
 * the generic route (POST /approvals/requests) leaves the draft as it is: approved and still current, the next Send
 * sends it without asking again.
 */

const HELD_SENT = 'This purchase order is not a draft any more: a yes is asked before it is sent.'
const HELD_WAITING = 'This purchase order waits for a yes already.'

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
  kind: true,
  developmentStyleId: true,
  sampleRoundId: true,
  rateAtOrder: true,
  companyNetAmount: true,
  shipToPartyId: true,
  shipToAddressId: true,
  shipToLocationId: true,
  party: { select: { code: true, legalName: true, status: true } },
  site: { select: { code: true } },
} as const

const LINE_SELECT = {
  id: true,
  seq: true,
  itemId: true,
  itemColourId: true,
  description: true,
  supplierArticleCode: true,
  supplierColourCode: true,
  quantity: true,
  uom: true,
  unitPrice: true,
  netAmount: true,
  needDate: true,
  grade: true,
  thicknessMinMm: true,
  thicknessMaxMm: true,
  oneDyeBatch: true,
  areaTolerancePct: true,
  requiresCrViTest: true,
  note: true,
  rolls: true,
  rollLengthM: true,
  rollWidthCm: true,
  certificateId: true,
  variantCode: true,
  cancelledAt: true,
} as const

/** "Not sent yet" for a draft and the same order waiting for its yes; any other status as it is. */
const stageOf = (status: string): string => (status === 'DRAFT' || status === 'PENDING_APPROVAL' ? 'UNSENT' : status)

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const order = await client.purchaseOrder.findUnique({ where: { id: recordId }, select: ORDER_SELECT })
  if (!order) return null
  const rows = await client.purchaseOrderLine.findMany({ where: { purchaseOrderId: recordId }, orderBy: [{ seq: 'asc' }, { id: 'asc' }], select: LINE_SELECT })
  const deliveries =
    rows.length === 0
      ? []
      : await client.purchaseOrderLineDelivery.findMany({ where: { purchaseOrderLineId: { in: rows.map((row) => row.id) } }, orderBy: [{ seq: 'asc' }, { id: 'asc' }], select: { purchaseOrderLineId: true, seq: true, quantity: true, needDate: true, note: true } })
  const lines = rows.map(({ cancelledAt, ...line }) => ({
    ...line,
    cancelled: cancelledAt !== null,
    deliveries: deliveries.filter((delivery) => delivery.purchaseOrderLineId === line.id).map((delivery) => ({ seq: delivery.seq, quantity: delivery.quantity, needDate: delivery.needDate, note: delivery.note })),
  }))
  const live = lines.filter((line) => !line.cancelled)
  const minor = live.reduce((sum, line) => sum + line.netAmount, 0)
  const value = fromMinorUnits(minor, order.currency).toFixed()
  const previous = order.revision > 1 ? await previousSentValue(client, order.id, order.revision) : null
  const count = live.length
  const supplier = order.party.legalName
  const which = order.revision > 1 ? `revision ${order.revision}, ` : ''
  return {
    companyId: order.companyId,
    siteId: order.siteId,
    label: `${order.number} · ${supplier}`,
    summary: `${order.number} to ${supplier}: ${which}${count === 1 ? '1 line' : `${count} lines`}, to be sent${order.revision > 1 ? ' again' : ''}`.slice(0, 500),
    facts: {
      orderValue: value,
      currency: order.currency,
      lineCount: count,
      supplierStatus: order.party.status,
      supplierCode: order.party.code,
      siteCode: order.site.code,
      revision: order.revision,
      valueIncrease: valueIncreaseOf(minor, previous, order.currency),
    },
    snapshot: {
      number: order.number,
      stage: stageOf(order.status),
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
      kind: order.kind,
      developmentStyleId: order.developmentStyleId,
      sampleRoundId: order.sampleRoundId,
      rateAtOrder: order.rateAtOrder,
      companyNetAmount: order.companyNetAmount,
      shipToPartyId: order.shipToPartyId,
      shipToAddressId: order.shipToAddressId,
      shipToLocationId: order.shipToLocationId,
      lines,
    },
    changes: [{ field: 'status', from: order.status, to: 'SENT' }],
    held: order.status === 'DRAFT' ? null : order.status === 'PENDING_APPROVAL' ? HELD_WAITING : HELD_SENT,
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
    // B-W2b-305 (SCM-080): a changed order asks again — every revision, or only when its value grew by more than a rule says.
    { id: 'revision', label: { en: 'revision', it: 'revisione' }, kind: 'number', unit: null, min: 1 },
    { id: 'valueIncrease', label: { en: 'value added since the last send', it: "valore aggiunto dall'ultimo invio" }, kind: 'number', grain: 'cost' },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await tx.$queryRaw`SELECT 1 FROM "PurchaseOrder" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.purchaseOrder.findMany({ where: companyId ? { companyId } : {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  onApproved: afterApproved,
  onRejected: (tools: CommandTools, task: TaskRef) => backToDraft(tools, task, 'REJECTED'),
  onWithdrawn: (tools: CommandTools, task: TaskRef) => backToDraft(tools, task, 'WITHDRAWN'),
  onStale: (tools: CommandTools, task: TaskRef) => backToDraft(tools, task, 'STALE'),
})
