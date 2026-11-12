import type { Prisma, Uom } from '@nexus/factory-db'
import type { ApprovalField, PreviewChange } from '@nexus/factory-domain/approvals/rules'
import { fromMinorUnits, isMinorUnits } from '@nexus/factory-domain/core/money'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { postMoves, type MoveDraft } from '../../../modules/inventory/ledger/post-moves'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * STOCK_ADJUSTMENT (B-W2b-314; SCM-192 "adjustments above a value wait for approval"; design warehouse.settings ws-adjust,
 * warehouse.moves mv-approval): an adjustment worth more than the warehouse rules' value, before it is posted.
 *
 * The request is the adjustment's only record until the yes: nothing is posted while it waits. Its subject is
 * `StockAdjustment` with an id of its own (the request's `recordId`); the adjustment as it will be posted (site, item, colour,
 * lot, hide, location, up or down, quantity, why, the posting date) is kept in the request's preview as the change entry
 * `adjustment` (no money), its typed cost as `unitCost` (the cost grain), and the stock at the location as `onHand`
 * (from → to). At the ask, modules/inventory/stock/adjust-approval.ts hands the adjustment to read() for the one command
 * (withPendingAdjustment); afterwards read() takes it from the request. A posted ADJUSTMENT move is read too (by its id),
 * for a rule's test over the latest adjustments.
 *
 * The fingerprint covers the adjustment and the stock at its location now: a move of that stock there before the yes makes
 * the request STALE ("it changed since you looked"), so the approver never approves 84.20 → 82.70 m² when there are 90 m².
 * The facts its rules test: the adjustment's value (the cost grain; in the company's currency, the size of it, up or down;
 * unknown when nothing gives the stock a cost), up or down, the quantity in the base unit, the material's kind and code, the
 * site's code, the reason code. On the yes (onApproved, the approver's command) the adjustment is posted by postMoves, as
 * the adjustment would have been (its key `inventory.adjust:approval:<request>`), valued as the ledger values it.
 */

export const STOCK_ADJUSTMENT_RECORD = 'StockAdjustment'

/** The adjustment as it will be posted (plain JSON, every key present: the fingerprint reads it). */
export interface StoredAdjustment {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
  readonly locationId: string
  readonly direction: 'IN' | 'OUT'
  readonly quantity: string
  readonly uom: string
  readonly baseQuantity: string
  readonly note: string
  readonly reasonCode: string | null
  readonly reference: string | null
  /** The day it counts on (YYYY-MM-DD), or null: the day it is posted. */
  readonly postingDate: string | null
  /** Why it may go into a soft-locked month (the asker's words), or null. */
  readonly periodLockReason: string | null
}

export interface PendingAdjustment {
  readonly adjustment: StoredAdjustment
  /** The typed cost per base unit (MANUAL), or null: the ledger's cost. */
  readonly unitCost: string | null
  /**
   * The size of its value in the company's currency (major units, "612.5"), as the post would write it: the rules' fact
   * `adjustmentValue` (the cost grain); null: unknown (nothing gives the stock a cost, or it is kept in another currency).
   */
  readonly value: string | null
  /** At the ask only (the audit row of the request): the warehouse rules' value and the post's value (minor units), its currency. */
  readonly limit?: number | null
  readonly valueAmount?: number | null
  readonly currency?: string | null
}

const PENDING = new Map<string, PendingAdjustment>()

/** The adjustment of a request being asked, for read() inside the ask's command (the request does not exist yet). */
export async function withPendingAdjustment<Result>(recordId: string, pending: PendingAdjustment, work: () => Promise<Result>): Promise<Result> {
  PENDING.set(recordId, pending)
  try {
    return await work()
  } finally {
    PENDING.delete(recordId)
  }
}

/** The request's change entries: the stock at the location from → to, the adjustment itself, its typed cost (cost grain). */
export function adjustmentChanges(pending: PendingAdjustment, onHand: string): PreviewChange[] {
  const { adjustment } = pending
  const after = adjustment.direction === 'IN' ? new Dec(onHand).plus(adjustment.baseQuantity) : new Dec(onHand).minus(adjustment.baseQuantity)
  return [
    { field: 'onHand', from: quantityText(onHand), to: quantityText(after), grain: null },
    { field: 'adjustment', from: null, to: adjustment, grain: null },
    ...(pending.unitCost !== null ? [{ field: 'unitCost', from: null, to: pending.unitCost, grain: 'cost' as const }] : []),
  ]
}

/** A request's adjustment read back from its preview (the shape adjustmentChanges wrote), or null. */
export function storedOf(preview: unknown): PendingAdjustment | null {
  const raw = (preview && typeof preview === 'object' ? preview : {}) as { changes?: unknown; facts?: unknown }
  const changes = Array.isArray(raw.changes) ? (raw.changes as Array<Record<string, unknown>>) : []
  const facts = Array.isArray(raw.facts) ? (raw.facts as Array<Record<string, unknown>>) : []
  const entry = changes.find((change) => change?.field === 'adjustment')?.to as StoredAdjustment | undefined
  if (!entry || typeof entry !== 'object' || typeof entry.siteId !== 'string' || typeof entry.locationId !== 'string') return null
  const cost = changes.find((change) => change?.field === 'unitCost')?.to
  const value = facts.find((fact) => fact?.field === 'adjustmentValue')?.value
  return { adjustment: entry, unitCost: typeof cost === 'string' ? cost : null, value: typeof value === 'string' ? value : null }
}

/** A value of the ledger (signed minor units in a currency) as the rules' fact for a company (null: another currency). */
export const valueFactOf = (valueAmount: number | null | undefined, currency: string | null | undefined, companyCurrency: string): string | null =>
  valueAmount === null || valueAmount === undefined || !isMinorUnits(valueAmount) || currency !== companyCurrency ? null : fromMinorUnits(Math.abs(valueAmount), companyCurrency).toFixed()

const SELECT_ITEM = { id: true, code: true, name: true, kind: true, baseUom: true } as const

async function fromRequest(client: Reader, recordId: string): Promise<PendingAdjustment | null> {
  const task = await client.approvalTask.findFirst({ where: { kind: 'STOCK_ADJUSTMENT', recordType: STOCK_ADJUSTMENT_RECORD, recordId }, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }], select: { preview: true } })
  return task ? storedOf(task.preview) : null
}

/** A posted adjustment (a rule's test reads the latest ones by their move ids). */
async function fromPosted(client: Reader, moveId: string): Promise<PendingAdjustment | null> {
  const move = await client.stockMove.findFirst({
    where: { id: moveId, reason: 'ADJUSTMENT' },
    select: {
      siteId: true,
      itemId: true,
      itemColourId: true,
      lotId: true,
      hideId: true,
      fromLocationId: true,
      toLocationId: true,
      quantity: true,
      uom: true,
      baseQuantity: true,
      note: true,
      reasonCode: true,
      reference: true,
      postingDate: true,
      site: { select: { company: { select: { currency: true } } } },
      valuations: { select: { valueAmount: true, currency: true }, take: 1 },
    },
  })
  if (!move) return null
  const valuation = move.valuations[0]
  return {
    adjustment: {
      siteId: move.siteId,
      itemId: move.itemId,
      itemColourId: move.itemColourId,
      lotId: move.lotId,
      hideId: move.hideId,
      locationId: (move.toLocationId ?? move.fromLocationId)!,
      direction: move.toLocationId ? 'IN' : 'OUT',
      quantity: quantityText(move.quantity.toString()),
      uom: move.uom,
      baseQuantity: quantityText(move.baseQuantity.toString()),
      note: move.note ?? '',
      reasonCode: move.reasonCode,
      reference: move.reference,
      postingDate: move.postingDate ? move.postingDate.toISOString().slice(0, 10) : null,
      periodLockReason: null,
    },
    unitCost: null,
    value: valueFactOf(valuation?.valueAmount, valuation?.currency, move.site.company.currency),
  }
}

/** The stock of the adjustment's key at its location now (base unit). */
async function onHandAt(client: Reader, adjustment: StoredAdjustment): Promise<string> {
  const key = { siteId: adjustment.siteId, itemId: adjustment.itemId, itemColourId: adjustment.itemColourId, lotId: adjustment.lotId, hideId: adjustment.hideId }
  const into = await client.stockMove.aggregate({ where: { ...key, toLocationId: adjustment.locationId }, _sum: { baseQuantity: true } })
  const outOf = await client.stockMove.aggregate({ where: { ...key, fromLocationId: adjustment.locationId }, _sum: { baseQuantity: true } })
  return quantityText(new Dec(into._sum.baseQuantity?.toString() ?? '0').minus(outOf._sum.baseQuantity?.toString() ?? '0'))
}

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const pending = PENDING.get(recordId)
  const fromTask = pending ? null : await fromRequest(client, recordId)
  const posted = pending || fromTask ? null : await fromPosted(client, recordId)
  const source = pending ?? fromTask ?? posted
  if (!source) return null
  const { adjustment } = source
  const site = await client.site.findUnique({ where: { id: adjustment.siteId }, select: { id: true, companyId: true, code: true } })
  const item = await client.item.findUnique({ where: { id: adjustment.itemId }, select: SELECT_ITEM })
  const location = await client.location.findUnique({ where: { id: adjustment.locationId }, select: { id: true, code: true, siteId: true } })
  if (!site || !item || !location || location.siteId !== site.id) return null
  const lot = adjustment.lotId ? await client.lot.findUnique({ where: { id: adjustment.lotId }, select: { code: true } }) : null
  const onHand = posted ? null : await onHandAt(client, adjustment)
  const sign = adjustment.direction === 'IN' ? '+' : '−'
  const what = `${item.code}${lot ? ` lot ${lot.code}` : ''}`
  return {
    companyId: site.companyId,
    siteId: site.id,
    label: `${what} · ${location.code}`,
    summary: `Adjustment ${sign}${new Dec(adjustment.quantity).toFixed()} ${adjustment.uom} of ${what} at ${site.code} ${location.code}: ${adjustment.note}`.slice(0, 500),
    facts: {
      adjustmentValue: source.value,
      direction: adjustment.direction,
      quantity: adjustment.baseQuantity,
      itemKind: item.kind,
      itemCode: item.code,
      siteCode: site.code,
      reasonCode: adjustment.reasonCode,
    },
    snapshot: { adjustment, onHand },
    changes: onHand === null ? [] : adjustmentChanges(source, onHand),
    held: posted ? 'This adjustment is posted already.' : null,
  }
}

/** The request's adjustment, read in the decision's command. */
async function storedOfTask(tools: CommandTools, task: TaskRef): Promise<PendingAdjustment | null> {
  const row = await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { preview: true } })
  return row ? storedOf(row.preview) : null
}

function told(tools: CommandTools, task: TaskRef, pending: PendingAdjustment, state: 'POSTED' | 'REJECTED' | 'WITHDRAWN' | 'STALE', moveId: string | null): void {
  const { adjustment } = pending
  tools.emit({
    type: 'inventory.adjustment_request_changed',
    subject: task.recordId,
    companyId: task.companyId,
    siteId: adjustment.siteId,
    payload: { requestId: task.recordId, taskId: task.id, siteId: adjustment.siteId, itemId: adjustment.itemId, lotId: adjustment.lotId, hideId: adjustment.hideId, locationId: adjustment.locationId, direction: adjustment.direction, state, moveId },
  })
}

/** The yes: the adjustment is posted as it was asked, in the approver's command (its key names the request). */
async function postOnYes(tools: CommandTools, task: TaskRef): Promise<void> {
  const pending = await storedOfTask(tools, task)
  if (!pending) throw new Error(`approvals: request ${task.id} keeps no adjustment`)
  const { adjustment } = pending
  const draft: MoveDraft = {
    siteId: adjustment.siteId,
    reason: 'ADJUSTMENT',
    itemId: adjustment.itemId,
    itemColourId: adjustment.itemColourId,
    lotId: adjustment.lotId,
    hideId: adjustment.hideId,
    quantity: adjustment.quantity,
    uom: adjustment.uom as Uom,
    baseQuantity: adjustment.baseQuantity,
    ...(adjustment.direction === 'IN' ? { toLocationId: adjustment.locationId } : { fromLocationId: adjustment.locationId }),
    note: adjustment.note,
    reasonCode: adjustment.reasonCode,
    reference: adjustment.reference,
    cost: pending.unitCost !== null ? { method: 'MANUAL', unitCost: pending.unitCost } : null,
  }
  const [move] = await postMoves(tools, [draft], {
    key: `inventory.adjust:approval:${task.id}`,
    issuePath: () => 'adjustment',
    periodLockOverride: adjustment.periodLockReason ? { reason: adjustment.periodLockReason } : undefined,
    postingDate: adjustment.postingDate,
    postingDatePath: 'adjustment/postingDate',
  })
  told(tools, task, pending, 'POSTED', move!.id)
}

async function tell(tools: CommandTools, task: TaskRef, state: 'REJECTED' | 'WITHDRAWN' | 'STALE'): Promise<void> {
  const pending = await storedOfTask(tools, task)
  if (pending) told(tools, task, pending, state, null)
}

export const STOCK_ADJUSTMENT_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'STOCK_ADJUSTMENT',
  recordType: STOCK_ADJUSTMENT_RECORD,
  label: { en: 'Stock adjustment', it: 'Rettifica di magazzino' },
  view: INVENTORY_STOCK_VIEW,
  // Only the adjustment asks (POST /inventory/adjustments, above the warehouse rules' value): never the generic route.
  ask: null,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'adjustmentValue', label: { en: 'adjustment value', it: 'valore della rettifica' }, kind: 'number', grain: 'cost', min: 0 },
    {
      id: 'direction',
      label: { en: 'up or down', it: 'in più o in meno' },
      kind: 'choice',
      options: [
        { value: 'IN', label: { en: 'Found more', it: 'In più' } },
        { value: 'OUT', label: { en: 'Found less', it: 'In meno' } },
      ],
    },
    { id: 'quantity', label: { en: 'quantity (base unit)', it: 'quantità (unità base)' }, kind: 'number', unit: null, min: 0 },
    {
      id: 'itemKind',
      label: { en: 'material kind', it: 'tipo di materiale' },
      kind: 'choice',
      options: [...ITEM_KINDS, 'FINISHED'].map((value) => ({ value, label: { en: value.charAt(0) + value.slice(1).toLowerCase(), it: value.charAt(0) + value.slice(1).toLowerCase() } })),
    },
    { id: 'itemCode', label: { en: 'material code', it: 'codice materiale' }, kind: 'text' },
    { id: 'siteCode', label: { en: 'site code', it: 'codice sede' }, kind: 'text' },
    { id: 'reasonCode', label: { en: 'reason code', it: 'codice causale' }, kind: 'text' },
  ]),
  read: readSubject,
  async recent(client: Reader, companyId: string | null, limit: number) {
    const where: Prisma.StockMoveWhereInput = { reason: 'ADJUSTMENT', reversalOfId: null, ...(companyId ? { companyId } : {}) }
    const rows = await client.stockMove.findMany({ where, orderBy: [{ id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  onApproved: postOnYes,
  onRejected: (tools: CommandTools, task: TaskRef) => tell(tools, task, 'REJECTED'),
  onWithdrawn: (tools: CommandTools, task: TaskRef) => tell(tools, task, 'WITHDRAWN'),
  onStale: (tools: CommandTools, task: TaskRef) => tell(tools, task, 'STALE'),
})
