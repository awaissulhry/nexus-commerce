import type { ApprovalField } from '@nexus/factory-domain/approvals/rules'
import { decimalOf, QUANTITY_SCALE, toBase, type Uom } from '@nexus/factory-domain/product/units/units'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * PURCHASE_REQUEST (SCM-035; B-W2b-332): a request to buy from someone in the office (factory-db PurchaseRequest), before it
 * reaches the buyer. modules/purchasing/ask-to-buy asks it in the ask's own command (the request written OPEN, then
 * PENDING_APPROVAL with the task when a switched-on rule holds); nobody approves their own request, the Owner included.
 *
 *   facts      the estimated value (the cost grain: the asked quantity in the material's base unit × its standard cost, in
 *              the material's currency), the kind and code of the material, where it comes from (asked in the office, or a
 *              work order's shortage), whether it names a work order, the site's code, the days until it is needed
 *   snapshot   what was asked: material, colour, words, quantity and unit, need date, reason, work order, source and site
 *              (the database freezes them once the request leaves OPEN, so a request never goes STALE; its status is not in
 *              the snapshot: it moves from OPEN to PENDING_APPROVAL after the ask)
 *   yes        back to OPEN: it waits for the buyer (purchase_requests.status_changed)
 *   no         REJECTED by the approver, with the request's reason words
 *   withdrawn  by the person who asked (the approvals inbox), or the system when the request went away: CANCELLED, unless
 *              the module took it back itself in the same command (then nothing more)
 */

const HELD_NOT_OPEN = 'This request is not waiting for the buyer: a yes is asked only before the buyer sees it.'
const WITHDRAWN_WORDS = 'The request for a yes was taken back.'

const REQUEST_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  requestedById: true,
  requestedAt: true,
  source: true,
  itemId: true,
  itemColourId: true,
  description: true,
  quantity: true,
  uom: true,
  needDate: true,
  reason: true,
  workOrderId: true,
  status: true,
  item: { select: { code: true, name: true, kind: true, baseUom: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true, standardCost: true } },
  site: { select: { code: true } },
  workOrder: { select: { number: true } },
} as const

const DAY_MS = 86_400_000
const day = (value: Date): string => value.toISOString().slice(0, 10)

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const row = await client.purchaseRequest.findUnique({ where: { id: recordId }, select: REQUEST_SELECT })
  if (!row) return null
  const quantity = row.quantity.toFixed(QUANTITY_SCALE)
  let value: string | null = null
  if (row.item?.standardCost !== null && row.item?.standardCost !== undefined) {
    try {
      const base = toBase(quantity, row.uom as Uom, { baseUom: row.item.baseUom as Uom, purchaseUom: row.item.purchaseUom as Uom, purchaseFactor: row.item.purchaseFactor.toString(), consumptionUom: row.item.consumptionUom as Uom, consumptionFactor: row.item.consumptionFactor.toString() }, { scale: QUANTITY_SCALE, rounding: 'HALF_UP' })
      value = base.times(decimalOf(row.item.standardCost.toString())).toFixed(2)
    } catch {
      value = null
    }
  }
  const material = row.item ? row.item.code : (row.description ?? '').slice(0, 60)
  const needDate = day(row.needDate)
  const forOrder = row.workOrder ? ` for ${row.workOrder.number}` : ''
  return {
    companyId: row.companyId,
    siteId: row.siteId,
    label: `Request to buy · ${material}`.slice(0, 200),
    summary: `${quantity.replace(/\.?0+$/, '')} ${row.uom} of ${material} by ${needDate} at ${row.site.code}${forOrder}`.slice(0, 500),
    facts: {
      estimatedValue: value,
      materialKind: row.item?.kind ?? null,
      materialCode: row.item?.code ?? null,
      source: row.source,
      forWorkOrder: row.workOrderId !== null,
      siteCode: row.site.code,
      daysUntilNeeded: Math.round((row.needDate.getTime() - Date.parse(`${day(serverClock.now())}T00:00:00.000Z`)) / DAY_MS),
    },
    snapshot: {
      itemId: row.itemId,
      itemColourId: row.itemColourId,
      description: row.description,
      quantity,
      uom: row.uom,
      needDate,
      reason: row.reason,
      workOrderId: row.workOrderId,
      source: row.source,
      siteId: row.siteId,
      requestedById: row.requestedById,
    },
    changes: [{ field: 'status', from: 'OPEN', to: 'APPROVED' }],
    held: row.status === 'OPEN' ? null : HELD_NOT_OPEN,
  }
}

/** One move of the request in the decision's command: only from PENDING_APPROVAL (else nothing: it was moved already). */
async function move(tools: CommandTools, task: TaskRef, to: 'OPEN' | 'REJECTED' | 'CANCELLED', data: Record<string, unknown>): Promise<void> {
  const row = await tools.tx.purchaseRequest.findUnique({ where: { id: task.recordId }, select: { id: true, companyId: true, siteId: true, status: true, requestedById: true } })
  if (!row || row.status !== 'PENDING_APPROVAL') return
  await tools.tx.purchaseRequest.update({ where: { id: row.id }, data: { status: to, ...data, version: { increment: 1 }, updatedAt: tools.now } })
  tools.audit({ action: `purchasing.askToBuy.${to === 'OPEN' ? 'approved' : to === 'REJECTED' ? 'rejected' : 'withdrawn'}`, recordType: 'PurchaseRequest', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: to, approvalTaskId: task.id } })
  tools.emit({ type: 'purchase_requests.status_changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { purchaseRequestId: row.id, siteId: row.siteId, from: 'PENDING_APPROVAL', to, purchaseOrderId: null, requestedById: row.requestedById } })
}

export const PURCHASE_REQUEST_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'PURCHASE_REQUEST',
  recordType: 'PurchaseRequest',
  label: { en: 'Request to buy', it: "Richiesta d'acquisto" },
  view: PURCHASING_VIEW,
  ask: null,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'estimatedValue', label: { en: 'estimated value (standard cost)', it: 'valore stimato (costo standard)' }, kind: 'number', grain: 'cost', min: 0 },
    {
      id: 'materialKind',
      label: { en: 'kind of material', it: 'tipo di materiale' },
      kind: 'choice',
      options: [
        { value: 'LEATHER', label: { en: 'Leather', it: 'Pelle' } },
        { value: 'TEXTILE', label: { en: 'Textile', it: 'Tessuto' } },
        { value: 'LINING', label: { en: 'Lining', it: 'Fodera' } },
        { value: 'MEMBRANE', label: { en: 'Membrane', it: 'Membrana' } },
        { value: 'PADDING', label: { en: 'Padding', it: 'Imbottitura' } },
        { value: 'THREAD', label: { en: 'Thread', it: 'Filo' } },
        { value: 'TRIM', label: { en: 'Trim', it: 'Accessorio' } },
        { value: 'HARDWARE', label: { en: 'Hardware', it: 'Minuteria' } },
        { value: 'PROTECTOR', label: { en: 'Protector', it: 'Protezione' } },
        { value: 'LABEL', label: { en: 'Label', it: 'Etichetta' } },
        { value: 'PACKAGING', label: { en: 'Packaging', it: 'Imballaggio' } },
        { value: 'COMPONENT', label: { en: 'Component', it: 'Componente' } },
      ],
    },
    { id: 'materialCode', label: { en: 'material code', it: 'codice materiale' }, kind: 'text' },
    {
      id: 'source',
      label: { en: 'asked from', it: 'chiesta da' },
      kind: 'choice',
      options: [
        { value: 'OFFICE', label: { en: 'the office (Ask to buy)', it: "l'ufficio (Chiedi di acquistare)" } },
        { value: 'SHORTAGE', label: { en: 'a work order’s shortage', it: 'una mancanza di un ordine di produzione' } },
      ],
    },
    { id: 'forWorkOrder', label: { en: 'for a work order', it: 'per un ordine di produzione' }, kind: 'yesNo' },
    { id: 'siteCode', label: { en: 'site code', it: 'codice sede' }, kind: 'text' },
    { id: 'daysUntilNeeded', label: { en: 'days until needed', it: 'giorni alla data richiesta' }, kind: 'number', unit: 'd', min: 0 },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await tx.$queryRaw`SELECT 1 FROM "PurchaseRequest" WHERE id = ${recordId}::uuid FOR UPDATE`
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const rows = await client.purchaseRequest.findMany({ where: companyId ? { companyId } : {}, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  async onApproved(tools: CommandTools, task: TaskRef) {
    await move(tools, task, 'OPEN', {})
  },
  async onRejected(tools: CommandTools, task: TaskRef) {
    const decided = await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { rejectReason: true, decidedById: true } })
    const reason = (decided?.rejectReason ?? '').trim().slice(0, 2000) || 'Refused by the approver.'
    await move(tools, task, 'REJECTED', { rejectedAt: tools.now, rejectedById: decided?.decidedById ?? task.decidedById, rejectReason: reason })
  },
  async onWithdrawn(tools: CommandTools, task: TaskRef) {
    await move(tools, task, 'CANCELLED', { cancelledAt: tools.now, cancelReason: WITHDRAWN_WORDS })
  },
})
