import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { adjustmentAboveLimit } from '@nexus/factory-domain/inventory/posting/rules'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { askApproval } from '../../../platform/approvals/engine'
import { adjustmentChanges, STOCK_ADJUSTMENT_RECORD, storedOf, valueFactOf, withPendingAdjustment, type PendingAdjustment, type StoredAdjustment } from '../../../platform/approvals/kinds/stock-adjustment'
import { officeContextOf } from '../ledger/access'
import { readBalances, type MoveDraft, type PostOptions, type postMoves } from '../ledger/post-moves'
import type { WaitingAdjustmentView } from '../posting/contract'
import { rulesOf } from '../posting/store'
import { SCOPE } from './read-kit'

/**
 * An adjustment above the warehouse rules' value waits for a yes (B-W2b-314; SCM-192; design warehouse.settings ws-adjust,
 * warehouse.stock st-adjust "Needs approval above € 500", warehouse.moves mv-approval). POST /inventory/adjustments runs its
 * command as before and, inside it, after the post:
 *
 *   holdAboveLimit(tools, move, draft, options)   the company's value in force (InventorySettings, the company's or every
 *                                                 company's; none: nothing more) and an approval rule of kind
 *                                                 STOCK_ADJUSTMENT switched on (none: nothing more). The move was posted
 *                                                 and valued as every adjustment is — every check of the ledger ran: the
 *                                                 stock, the place, the posting date, a closed month — so its value is the
 *                                                 one the yes will write. Worth more than the value (or a value nobody can
 *                                                 tell): it throws AdjustmentAboveLimit, the command rolls back (nothing of
 *                                                 it stays: no move, no audit row, no event) and the route runs it again
 *                                                 asking instead (the tenant scope runs no SAVEPOINT, so the trial is a
 *                                                 command of its own);
 *   askToAdjust(tools, pending)                   the second run, under the same Idempotency-Key: the approval engine is
 *                                                 asked (askApproval). No rule holds (its condition, or it names only the
 *                                                 asker): the adjustment posts as today. A rule holds: nothing is posted, the
 *                                                 request waits and the answer is the waiting adjustment (202). The yes
 *                                                 posts it (the kind's onApproved, platform/approvals/kinds/stock-adjustment).
 *   GET /inventory/adjustments/waiting            the requests of the adjustments the reader may see (inventory.stock.view
 *                                                 at their site), PENDING by default: who asked, who approves, since when,
 *                                                 the stock from → to, the value with the cost grain, the words of
 *                                                 mv-approval.
 *
 * Only this route asks: postMoves never does, so the other writers of ADJUSTMENT moves (a count's apply, a lot's split into
 * shade groups LOT_SPLIT / LOT_REGROUP, a transfer's difference written off) post as they always did.
 */

/** The first run of an adjustment found it worth more than the value: roll it back and ask (the route catches it). */
export class AdjustmentAboveLimit extends Error {
  override name = 'AdjustmentAboveLimit'
  constructor(readonly pending: PendingAdjustment) {
    super('The adjustment waits for a yes: worth more than the warehouse rules allow without one.')
  }
}

type PostedMove = Awaited<ReturnType<typeof postMoves>>[number]

/** After the post, in the adjustment's command: worth more than the value with a rule on → AdjustmentAboveLimit. */
export async function holdAboveLimit(tools: CommandTools, move: PostedMove, draft: MoveDraft, options: PostOptions): Promise<void> {
  const context = tools.context
  if (context.audience !== 'office') return
  const site = await tools.tx.site.findUnique({ where: { id: move.siteId }, select: { companyId: true, company: { select: { currency: true } } } })
  if (!site) return
  const limit = (await rulesOf(tools.tx, context.tenantId, site.companyId)).inForce.adjustmentApprovalAmount.value
  if (limit === null) return
  // No rule could hold: nothing to ask (and no run to roll back).
  if ((await tools.tx.approvalRule.count({ where: { kind: 'STOCK_ADJUSTMENT', active: true, OR: [{ companyId: null }, { companyId: site.companyId }] } })) === 0) return
  const valuation = await tools.tx.stockValuation.findFirst({ where: { moveId: move.id }, select: { valueAmount: true, currency: true } })
  const companyCurrency = site.company.currency
  const valueAmount = valuation && valuation.currency === companyCurrency ? valuation.valueAmount : null
  if (!adjustmentAboveLimit({ limit, valueAmount })) return
  const adjustment: StoredAdjustment = {
    siteId: move.siteId,
    itemId: move.itemId,
    itemColourId: move.itemColourId,
    lotId: move.lotId,
    hideId: move.hideId,
    locationId: (move.toLocationId ?? move.fromLocationId)!,
    direction: move.toLocationId ? 'IN' : 'OUT',
    quantity: move.quantity,
    uom: move.uom,
    baseQuantity: move.baseQuantity,
    note: move.note ?? '',
    reasonCode: move.reasonCode,
    reference: move.reference,
    postingDate: options.postingDate ?? null,
    periodLockReason: options.periodLockOverride?.reason?.trim() || null,
  }
  throw new AdjustmentAboveLimit({
    adjustment,
    unitCost: draft.cost?.method === 'MANUAL' ? new Dec(draft.cost.unitCost).toFixed(6) : null,
    value: valueFactOf(valuation?.valueAmount, valuation?.currency, companyCurrency),
    limit,
    valueAmount,
    currency: valuation?.currency ?? null,
  })
}

/** The second run: ask for a yes; the waiting adjustment when a rule holds (nothing posted), else null (post it as today). */
export async function askToAdjust(tools: CommandTools, pending: PendingAdjustment): Promise<WaitingAdjustmentView | null> {
  const context = tools.context
  if (context.audience !== 'office') return null
  const { adjustment } = pending
  const site = await tools.tx.site.findUnique({ where: { id: adjustment.siteId }, select: { id: true, companyId: true } })
  if (!site) return null
  const onHand = (await readBalances(tools.tx, [{ ...adjustment, locationId: adjustment.locationId }])).values().next().value ?? new Dec(0)
  const recordId = newId()
  const outcome = await withPendingAdjustment(recordId, pending, () =>
    askApproval(tools, { kind: 'STOCK_ADJUSTMENT', recordId, requester: { userId: context.actorId }, note: adjustment.note, changes: adjustmentChanges(pending, onHand.toString()) }),
  )
  if (!outcome.asked) return null
  tools.audit({
    action: 'inventory.adjustmentWaits',
    recordType: STOCK_ADJUSTMENT_RECORD,
    recordId,
    companyId: site.companyId,
    siteId: site.id,
    after: { ...adjustment, taskId: outcome.taskId, limit: markMoney('cost', pending.limit ?? null), valueAmount: markMoney('cost', pending.valueAmount ?? null), currency: pending.currency ?? null },
    reason: adjustment.note,
  })
  tools.emit({
    type: 'inventory.adjustment_request_changed',
    subject: recordId,
    companyId: site.companyId,
    siteId: site.id,
    payload: { requestId: recordId, taskId: outcome.taskId, siteId: site.id, itemId: adjustment.itemId, lotId: adjustment.lotId, hideId: adjustment.hideId, locationId: adjustment.locationId, direction: adjustment.direction, state: 'WAITING', moveId: null },
  })
  const [view] = await viewsOf(tools.tx, [outcome.taskId])
  return view!
}

// ---- the waiting adjustments (mv-approval) --------------------------------------------------------------------------------

type Reader = FactoryClient | CommandTx

const TASK_SELECT = {
  id: true,
  recordId: true,
  status: true,
  requestedAt: true,
  requestedById: true,
  approverRoleId: true,
  approverUserId: true,
  dueAt: true,
  preview: true,
} as const

/** "10:42", the time of day in Rome (the office's clock). */
const ROME_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const STATUS_WORDS: Readonly<Record<Exclude<WaitingAdjustmentView['status'], 'PENDING'>, { en: string; it: string }>> = {
  APPROVED: { en: 'Approved and posted', it: 'Approvata e registrata' },
  REJECTED: { en: 'Rejected', it: 'Respinta' },
  WITHDRAWN: { en: 'Withdrawn', it: 'Ritirata' },
  STALE: { en: 'The stock changed since it was asked: ask again', it: 'La giacenza è cambiata dalla richiesta: chiedere di nuovo' },
}

/** The requests as the warehouse sees them (in the given order); a request whose adjustment cannot be read is left out. */
async function viewsOf(db: Reader, taskIds: readonly string[]): Promise<WaitingAdjustmentView[]> {
  if (taskIds.length === 0) return []
  const tasks = await db.approvalTask.findMany({ where: { id: { in: [...taskIds] } }, select: TASK_SELECT })
  const stored = new Map(tasks.flatMap((task) => {
    const pending = storedOf(task.preview)
    return pending ? [[task.id, { task, pending }] as const] : []
  }))
  const all = [...stored.values()]
  const ids = (pick: (entry: (typeof all)[number]) => string | null) => [...new Set(all.flatMap((entry) => (pick(entry) ? [pick(entry)!] : [])))]
  const [sites, items, colours, lots, hides, locations, roles, users] = [
    await db.site.findMany({ where: { id: { in: ids((entry) => entry.pending.adjustment.siteId) } }, select: { id: true, code: true, name: true, company: { select: { currency: true } } } }),
    await db.item.findMany({ where: { id: { in: ids((entry) => entry.pending.adjustment.itemId) } }, select: { id: true, code: true, name: true, baseUom: true } }),
    await db.itemColour.findMany({ where: { id: { in: ids((entry) => entry.pending.adjustment.itemColourId) } }, select: { id: true, code: true, name: true } }),
    await db.lot.findMany({ where: { id: { in: ids((entry) => entry.pending.adjustment.lotId) } }, select: { id: true, code: true } }),
    await db.hide.findMany({ where: { id: { in: ids((entry) => entry.pending.adjustment.hideId) } }, select: { id: true, code: true } }),
    await db.location.findMany({ where: { id: { in: ids((entry) => entry.pending.adjustment.locationId) } }, select: { id: true, code: true, name: true } }),
    await db.role.findMany({ where: { id: { in: ids((entry) => entry.task.approverRoleId) } }, select: { id: true, name: true } }),
    await db.user.findMany({ where: { id: { in: [...ids((entry) => entry.task.approverUserId), ...ids((entry) => entry.task.requestedById)] } }, select: { id: true, displayName: true } }),
  ]
  const byId = <Row extends { id: string }>(rows: readonly Row[]) => new Map(rows.map((row) => [row.id, row]))
  const [siteOf, itemOf, colourOf, lotOf, hideOf, locationOf, roleOf, userOf] = [byId(sites), byId(items), byId(colours), byId(lots), byId(hides), byId(locations), byId(roles), byId(users)]
  return taskIds.flatMap((taskId) => {
    const entry = stored.get(taskId)
    if (!entry) return []
    const { task, pending } = entry
    const { adjustment } = pending
    const site = siteOf.get(adjustment.siteId)
    const item = itemOf.get(adjustment.itemId)
    const location = locationOf.get(adjustment.locationId)
    if (!site || !item || !location) return []
    const preview = (task.preview ?? {}) as { changes?: Array<{ field?: unknown; from?: unknown; to?: unknown }> }
    const onHand = preview.changes?.find((change) => change.field === 'onHand')
    const approverName = task.approverRoleId ? (roleOf.get(task.approverRoleId)?.name ?? null) : task.approverUserId ? (userOf.get(task.approverUserId)?.displayName ?? null) : null
    const colour = adjustment.itemColourId ? colourOf.get(adjustment.itemColourId) : undefined
    const lot = adjustment.lotId ? lotOf.get(adjustment.lotId) : undefined
    const hide = adjustment.hideId ? hideOf.get(adjustment.hideId) : undefined
    const since = ROME_TIME.format(task.requestedAt)
    const who = approverName ?? (task.approverRoleId ? 'a role' : 'a person')
    return [
      {
        requestId: task.recordId,
        taskId: task.id,
        status: task.status as WaitingAdjustmentView['status'],
        requestedAt: toUtcIso(task.requestedAt),
        requestedBy: task.requestedById ? { id: task.requestedById, name: userOf.get(task.requestedById)?.displayName ?? null } : null,
        approver: task.approverRoleId ? { kind: 'ROLE' as const, id: task.approverRoleId, name: approverName } : { kind: 'PERSON' as const, id: task.approverUserId!, name: approverName },
        dueAt: task.dueAt ? toUtcIso(task.dueAt) : null,
        site: { id: site.id, code: site.code, name: site.name },
        item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom },
        colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
        lot: lot ? { id: lot.id, code: lot.code } : null,
        hide: hide ? { id: hide.id, code: hide.code } : null,
        location: { id: location.id, code: location.code, name: location.name },
        direction: adjustment.direction,
        quantity: adjustment.quantity,
        uom: adjustment.uom as WaitingAdjustmentView['uom'],
        baseQuantity: adjustment.baseQuantity,
        onHand: { from: typeof onHand?.from === 'string' ? onHand.from : '0.0000', to: typeof onHand?.to === 'string' ? onHand.to : '0.0000' },
        note: adjustment.note,
        reasonCode: adjustment.reasonCode,
        postingDate: adjustment.postingDate,
        value: asMoney('cost', { amount: asMoney('cost', pending.value), currency: site.company.currency }),
        words: task.status === 'PENDING' ? { en: `Waiting for approval by ${who} since ${since}`, it: `In attesa di approvazione da ${who} dalle ${since}` } : STATUS_WORDS[task.status as keyof typeof STATUS_WORDS],
      },
    ]
  })
}

/** GET /inventory/adjustments/waiting */
export async function waitingAdjustments(
  caller: CommandCaller,
  query: { readonly siteId?: string | undefined; readonly itemId?: string | undefined; readonly locationId?: string | undefined; readonly status?: WaitingAdjustmentView['status'] | undefined; readonly limit: number },
) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.ApprovalTaskWhereInput
  const where: Prisma.ApprovalTaskWhereInput = {
    AND: [
      scope,
      { kind: 'STOCK_ADJUSTMENT', recordType: STOCK_ADJUSTMENT_RECORD, status: query.status ?? 'PENDING' },
      query.siteId ? { siteId: query.siteId } : {},
      query.itemId ? { preview: { path: ['changes', '1', 'to', 'itemId'], equals: query.itemId } } : {},
      query.locationId ? { preview: { path: ['changes', '1', 'to', 'locationId'], equals: query.locationId } } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const [rows, count] = [await db.approvalTask.findMany({ where, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: query.limit, select: { id: true } }), await db.approvalTask.count({ where })]
    return { rows: await viewsOf(db, rows.map((row) => row.id)), count }
  })
}
