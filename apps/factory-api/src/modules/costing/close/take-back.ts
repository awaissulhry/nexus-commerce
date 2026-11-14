import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CloseRecordView, ReopenBody, UndoBody } from '@nexus/factory-domain/costing/close/contracts'
import { WORKORDERS_REOPEN } from '@nexus/factory-domain/costing/close/permissions'
import { mayUndo, UNDO_SECONDS } from '@nexus/factory-domain/costing/close/rules'
import { reversalEntry } from '@nexus/factory-domain/costing/ledger/entries'
import { WORKORDERS_MANAGE } from '@nexus/factory-domain/production/work-orders/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../../production/work-orders/access'
import { readWorkOrder } from '../../production/work-orders/store'
import { workOrderView, type WorkOrderView } from '../../production/work-orders/views'
import { officeWorkOrder, todayOfCommand } from '../../production/work-orders/work-orders'
import { entryFacts } from '../actual/store'
import { lockMethodInCommand } from '../method/method'
import { hardLockWords, refusalOf } from '../ppv/settings'
import { liveEntriesOfClose, refused } from './settle'
import { CLOSE_COLUMNS, closeRecordViews } from './views'

/**
 * Taking a close back (B-W2b-411; MES-013; design production.workorders pop "Close work order" › Undo for a few seconds;
 * "reopening later needs permission and a reason"):
 *
 *   POST /production/work-orders/:workOrderId/close/undo   workorders.manage: the person who closed it, within UNDO_SECONDS
 *                                                          of the close (the toast's Undo), without a reason
 *   POST /production/work-orders/:workOrderId/reopen       workorders.reopen: any time, anyone allowed, with a reason
 *
 * ONE command each on the work order (its version checked and bumped): the work order must be CLOSED by a close record
 * (NOT_CLOSED; a work order closed before B-W2b-411 has none: NO_CLOSE_RECORD); the Undo only by its closer in time
 * (NOT_THE_CLOSER, UNDO_TOO_LATE: reopen it with a reason). The close is marked undone (when, by whom, why); every VARIANCE
 * and CLOSE entry it posted is reversed (dated now: refused inside the accountant's HARD lock, LOCKED); the work order goes
 * back to COMPLETED. Audit row, `workorder.status_changed`, `work_order_close.changed` (undone | reopened), and
 * `work_order_cost.posted` for the reversals. A new close is a new row. The database holds the same rules.
 */

export interface TakeBackAnswer {
  readonly workOrder: WorkOrderView
  readonly close: CloseRecordView
}

const UNDO_WORDS = 'The close was undone by the person who closed it.'

async function takeBack(caller: CommandCaller, workOrderId: string, mode: 'undo' | 'reopen', body: UndoBody & { readonly reason?: string }, idempotencyKey?: string): Promise<TakeBackAnswer> {
  const header = await officeWorkOrder(caller, workOrderId, mode === 'undo' ? WORKORDERS_MANAGE : WORKORDERS_REOPEN)
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const scope = { companyId: header.companyId, siteId: header.siteId }
  const reason = mode === 'reopen' ? (body.reason ?? '').trim() : null
  try {
    const { result } = await command(
      caller,
      { name: mode === 'undo' ? 'workorders.undoClose' : 'workorders.reopen', idempotencyKey, input: { workOrderId, ...body }, record: { type: 'WorkOrder', id: header.id, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now } = tools
        const current = (await readWorkOrder(tx, header.id))!
        if (current.status !== 'CLOSED') throw refused('NOT_CLOSED', `Work order ${current.number} is ${current.status}: only a CLOSED work order is ${mode === 'undo' ? 'undone' : 'reopened'}.`)
        const live = await tx.workOrderClose.findFirst({ where: { workOrderId: current.id, undoneAt: null, closedAt: current.closedAt ?? undefined }, select: CLOSE_COLUMNS })
        if (!live) throw refused('NO_CLOSE_RECORD', `Work order ${current.number} was closed with no close record (before the close with planned against actual): it is not reopened.`)
        if (mode === 'undo' && !mayUndo(live, context.actorId, now)) {
          throw live.closedById !== context.actorId
            ? refused('NOT_THE_CLOSER', 'Only the person who closed it undoes a close, for a few seconds after it: reopen it with a reason.')
            : refused('UNDO_TOO_LATE', `The Undo lasts ${UNDO_SECONDS} seconds after the close: reopen it with a reason.`)
        }
        const entries = await liveEntriesOfClose(tx, context.tenantId, current.id, live.id)
        if (entries.length > 0) {
          const lock = await hardLockWords(tx, current.companyId, businessDate(now))
          if (lock) throw refused('LOCKED', lock)
        }
        const undone = await tx.workOrderClose.update({ where: { id: live.id }, data: { undoneAt: now, undoneById: context.actorId, reopenReason: reason, version: live.version + 1, updatedAt: now }, select: CLOSE_COLUMNS })
        const why = reason === null ? UNDO_WORDS : `Reopened: ${reason}`
        const reversals = entries.map((entry) => reversalEntry(newId(), entryFacts(entry), now, why))
        if (reversals.length > 0) {
          const method = await lockMethodInCommand(tools, current.companyId)
          // Each reversal takes back its own entry exactly (the same kind, the opposite amount): one statement for all.
          await tx.workOrderCostEntry.createMany({
            data: reversals.map((draft) => ({ ...draft, companyId: current.companyId, siteId: current.siteId, workOrderId: current.id, currency: live.currency, costingMethod: method, createdAt: now, createdById: context.actorId })),
          })
        }
        await tx.workOrder.update({ where: { id: current.id }, data: { status: 'COMPLETED', closedAt: null }, select: { id: true } })
        tools.audit({
          recordType: 'WorkOrder',
          recordId: current.id,
          companyId: current.companyId,
          siteId: current.siteId,
          before: { status: 'CLOSED', closedAt: current.closedAt ? toUtcIso(current.closedAt) : null, closeId: live.id },
          after: { status: 'COMPLETED', closeId: live.id, undone: mode, reversals: reversals.map((draft) => ({ id: draft.id, kind: draft.kind, reversalOfId: draft.reversalOfId, amount: markMoney('cost', draft.amount) })) },
          reason: why,
        })
        const event = { subject: current.id, companyId: current.companyId, siteId: current.siteId }
        tools.emit({ ...event, type: 'workorder.status_changed', payload: { workOrderId: current.id, number: current.number, from: 'CLOSED', to: 'COMPLETED' } })
        tools.emit({ ...event, type: 'work_order_close.changed', payload: { closeId: live.id, workOrderId: current.id, number: current.number, change: mode === 'undo' ? 'undone' : 'reopened', settled: false, beyond: live.reasonCode !== null } })
        if (reversals.length > 0) {
          tools.emit({ ...event, type: 'work_order_cost.posted', payload: { workOrderId: current.id, number: current.number, entryIds: reversals.map((draft) => draft.id), kinds: [...new Set(reversals.map((draft) => draft.kind))], reversals: reversals.length } })
        }
        const [close] = await closeRecordViews(tx, [undone], { actorId: context.actorId, mayManage: true, mayReopen: can(actor, WORKORDERS_REOPEN, scope), now })
        return { workOrder: await workOrderView(tx, (await readWorkOrder(tx, current.id))!, todayOfCommand(tools)), close: close! }
      },
    )
    return result
  } catch (error) {
    throw refusalOf(error)
  }
}

/** POST /production/work-orders/:workOrderId/close/undo */
export const undoClose = (caller: CommandCaller, workOrderId: string, body: UndoBody, idempotencyKey?: string): Promise<TakeBackAnswer> => takeBack(caller, workOrderId, 'undo', body, idempotencyKey)

/** POST /production/work-orders/:workOrderId/reopen */
export const reopenWorkOrder = (caller: CommandCaller, workOrderId: string, body: ReopenBody, idempotencyKey?: string): Promise<TakeBackAnswer> => takeBack(caller, workOrderId, 'reopen', body, idempotencyKey)
