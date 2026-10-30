import { ConflictError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { entryKeys, reversalEntry } from '@nexus/factory-domain/costing/ledger/entries'
import type { LedgerEntryView } from '@nexus/factory-domain/costing/ledger/contracts'
import { COSTING_LEDGER_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/materials/store'
import { lockMethodInCommand } from '../method/method'
import { postWorkOrderCosts } from './post'
import { ENTRY_COLUMNS, entryFacts, lockedPeriods, lockWorkOrderCosts, readWorkOrder } from './store'
import { ledgerViews } from './views'

/**
 * The person's two writes on the cost ledger (B-W2a-21; FIN-038; design finance.costing "Cost ledger" › "Reverse entry
 * (reason, ActionConfirm)"), costing.ledger.manage over the work order's company and site:
 *   - reverse an entry: its opposite, with the reason, dated now (never inside a locked period); the overhead applied on
 *     it is reversed with it. A reversal is not reversed, and an entry is reversed once (the DB holds both too). The
 *     source event keeps its key, so a later catch-up does not post it again: a wrong value is put right by reversing it
 *     and, when a cost is still due, by the work that posts it (a new stock move, a corrected scan).
 *   - post now: the catch-up of every source of the work order (what the worker would have posted).
 */

async function workOrderFor(caller: CommandCaller, workOrderId: string) {
  const context = contextOf(caller)
  const row = isUuid(workOrderId) ? await caller.withClient((db) => readWorkOrder(db, workOrderId)) : null
  const actor = actorOf(context)
  if (!row || !can(actor, COSTING_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Work order not found.')
  if (!can(actor, COSTING_LEDGER_MANAGE, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError()
  return row
}

/** POST /costing/work-orders/:workOrderId/post */
export async function postNow(caller: CommandCaller, workOrderId: string, idempotencyKey?: string) {
  await workOrderFor(caller, workOrderId)
  const outcome = await postWorkOrderCosts(caller, workOrderId, { idempotencyKey })
  const posted = outcome.posted.length === 0 ? [] : await caller.withClient(async (db) => ledgerViews(db, await db.workOrderCostEntry.findMany({ where: { id: { in: outcome.posted.map((entry) => entry.id) } }, select: ENTRY_COLUMNS, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })))
  return { posted, waiting: outcome.waiting, method: outcome.method, provisional: outcome.method === 'UNDECIDED', replayed: outcome.replayed }
}

/** POST /costing/entries/:entryId/reverse */
export async function reverseEntry(caller: CommandCaller, entryId: string, reason: string, idempotencyKey?: string): Promise<{ entry: LedgerEntryView; reversals: LedgerEntryView[]; replayed: boolean }> {
  const seen = isUuid(entryId) ? await caller.withClient((db) => db.workOrderCostEntry.findUnique({ where: { id: entryId }, select: { workOrderId: true } })) : null
  if (!seen) throw new NotFoundError('Cost entry not found.')
  const workOrder = await workOrderFor(caller, seen.workOrderId)
  const { result, replayed } = await command(caller, { name: 'costing.reverseEntry', idempotencyKey, input: { entryId, reason } }, async (tools) => {
    const { tx, now } = tools
    if (!('tenantId' in tools.context)) throw new NotFoundError('Cost entry not found.')
    await lockWorkOrderCosts(tx, tools.context.tenantId, workOrder.id)
    const entry = await tx.workOrderCostEntry.findUniqueOrThrow({ where: { id: entryId }, select: ENTRY_COLUMNS })
    if (entry.reversalOfId) throw new ConflictError('This entry is a reversal: it is not reversed in turn (post the cost again through its source).')
    const taken = await tx.workOrderCostEntry.findFirst({ where: { reversalOfId: entryId }, select: { occurredAt: true, reason: true } })
    if (taken) throw new ConflictError(`This entry was reversed on ${businessDate(taken.occurredAt)}${taken.reason ? ` (${taken.reason})` : ''}: an entry is reversed once.`)
    const today = businessDate(now)
    const locked = (await lockedPeriods(tx, workOrder.companyId)).find((lock) => lock.periodStart <= today && today <= lock.periodEnd)
    if (locked) throw new ConflictError(`Today is in the locked period ${locked.periodStart} to ${locked.periodEnd}: a reversal is dated today, so it waits until the period opens.`)
    const facts = entryFacts(entry)
    const drafts = [reversalEntry(newId(), facts, now, reason)]
    // The overhead applied on it goes with it.
    const overhead = await tx.workOrderCostEntry.findFirst({ where: { workOrderId: workOrder.id, idempotencyKey: entryKeys.overhead(entryId) }, select: ENTRY_COLUMNS })
    if (overhead && !(await tx.workOrderCostEntry.findFirst({ where: { reversalOfId: overhead.id }, select: { id: true } }))) {
      drafts.push(reversalEntry(newId(), entryFacts(overhead), now, `With the entry it was applied on: ${reason}`, { key: entryKeys.reversal(overhead.id), sourceType: 'WorkOrderCostEntry', sourceId: entryId }))
    }
    const method = await lockMethodInCommand(tools, workOrder.companyId)
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    for (const draft of drafts) {
      await tx.workOrderCostEntry.create({ data: { ...draft, companyId: workOrder.companyId, siteId: workOrder.siteId, workOrderId: workOrder.id, currency: entry.currency, costingMethod: method, createdAt: now, createdById }, select: { id: true } })
    }
    tools.audit({
      action: 'costing.reverseEntry',
      recordType: 'WorkOrderCostEntry',
      recordId: entryId,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      after: { reversals: drafts.map((draft) => ({ id: draft.id, kind: draft.kind, amount: markMoney('cost', draft.amount) })) },
      reason,
    })
    tools.emit({ type: 'work_order_cost.reversed', subject: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, payload: { workOrderId: workOrder.id, number: workOrder.number, entryId, reversalIds: drafts.map((draft) => draft.id) } })
    const rows = await tx.workOrderCostEntry.findMany({ where: { id: { in: [entryId, ...drafts.map((draft) => draft.id)] } }, select: ENTRY_COLUMNS })
    const views = await ledgerViews(tx, rows)
    return { entry: views.find((view) => view.id === entryId)!, reversals: drafts.map((draft) => views.find((view) => view.id === draft.id)!) }
  })
  return { ...result, replayed }
}
