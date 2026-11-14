import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { closeBody, closeRecordView, splitView, type CloseBody, type CloseRecordView, type SplitView } from '@nexus/factory-domain/costing/close/contracts'
import { CLOSE_WAITS, reasonRefusal } from '@nexus/factory-domain/costing/close/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { moveChange } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_MANAGE } from '@nexus/factory-domain/production/work-orders/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { WORKORDERS_REOPEN } from '@nexus/factory-domain/costing/close/permissions'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { planCosts, postCostsInCommand } from '../../costing/actual/post'
import { lockWorkOrderCosts, readWorkOrder as readCostedWorkOrder } from '../../costing/actual/store'
import { closeFactsOf } from '../../costing/close/facts'
import { refused, settleInCommand } from '../../costing/close/settle'
import { CLOSE_COLUMNS, closeRecordViews, itemsOf, splitViewOf } from '../../costing/close/views'
import { hardLockWords, refusalOf } from '../../costing/ppv/settings'
import { officeContextOf } from './access'
import { workOrderSchema } from './contract'
import { bumpVersion } from './moves'
import { readWorkOrder } from './store'
import { workOrderView, type WorkOrderView } from './views'
import { officeWorkOrder, todayOfCommand } from './work-orders'

/**
 * Close a work order (B-W2b-411; MES-012, FIN-034; design production.workorders pop "Close work order": planned against
 * actual quantity, material, minutes and scrap; a reason when outside the tolerance; Undo for a few seconds). Replaces
 * W1's status-only close: POST /production/work-orders/:workOrderId/close, workorders.manage over the work order. ONE
 * command:
 *
 *   1. the work order's issue lock, then its row (version checked and bumped): an issue in flight finishes first (./moves)
 *   2. COMPLETED only (else refusal NOT_COMPLETED, in words)
 *   3. the actuals go to costing: under the work order's costing lock, what its ledger lacks is posted first (the same
 *      writer as the worker's, costing/actual/post)
 *   4. planned against actual (costing/close/facts) judged against the company's close tolerance: a reason code exactly
 *      when a figure is beyond it (REASON_NEEDED / REASON_NOT_NEEDED, OTHER with words: NOTE_NEEDED)
 *   5. while the company's figures for the accountant are on (GATE-ACCOUNTANT): nothing may still wait to post
 *      (COSTS_WAITING) and today may not be in the accountant's HARD lock (LOCKED)
 *   6. the WorkOrderClose row; while the figures are on, the cost close (costing/close/settle: the variance split, its
 *      variance entries, the closing entry); the work order CLOSED at the close's time
 * Audit row, `workorder.status_changed`, `work_order_close.changed`, and `work_order_cost.posted` when it settled. While the
 * figures are off the close is a status and the answer says so (CLOSE_WAITS). The database holds every rule too
 * (…_cost_actuals_w2b_guards); a refusal of it is answered in its words (refusal/DATABASE).
 */

export const closeContract = defineContract({
  params: input({ workOrderId: id() }),
  body: closeBody,
  response: { 200: output({ workOrder: workOrderSchema, close: closeRecordView, split: splitView.nullable(), waits: z.string().nullable() }) },
})

export interface CloseAnswer {
  readonly workOrder: WorkOrderView
  readonly close: CloseRecordView
  readonly split: SplitView | null
  readonly waits: string | null
}

export async function closeWorkOrder(caller: CommandCaller, workOrderId: string, body: CloseBody, idempotencyKey?: string): Promise<CloseAnswer> {
  const header = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const scope = { companyId: header.companyId, siteId: header.siteId }
  try {
    const { result } = await command(caller, { name: 'workorders.close', idempotencyKey, input: { workOrderId, ...body } }, async (tools) => {
      const { tx, now } = tools
      await lockWorkOrderIssues(tx, context.tenantId, header.id)
      await bumpVersion(tx, header.id, body.version)
      const current = (await readWorkOrder(tx, header.id))!
      if (current.status !== 'COMPLETED') throw refused('NOT_COMPLETED', `Work order ${current.number} is ${current.status}: a work order is closed once it is COMPLETED.`)

      // The actuals go to costing: what the ledger lacks is posted first (nothing is written when nothing is missing).
      await lockWorkOrderCosts(tx, context.tenantId, current.id)
      const costed = (await readCostedWorkOrder(tx, current.id))!
      const plan = await planCosts(tx, costed, undefined)
      const waiting = plan.drafts.length > 0 ? (await postCostsInCommand(tools, current.id)).waiting : plan.waiting
      const facts = await closeFactsOf(tx, costed, now)
      const refusal = reasonRefusal(facts.beyond, body.reasonCode, body.reasonNote, facts.tolerancePct)
      if (refusal) throw refused(refusal.code, refusal.message)
      if (facts.settles) {
        if (waiting.length > 0) throw refused('COSTS_WAITING', `The cost close freezes the actual cost, so nothing may still wait to post: ${waiting.map((row) => row.words).join(' ')}`)
        const lock = await hardLockWords(tx, costed.companyId, businessDate(now))
        if (lock) throw refused('LOCKED', lock)
      }

      const closeId = newId()
      const row = await tx.workOrderClose.create({
        data: {
          id: closeId,
          companyId: current.companyId,
          siteId: current.siteId,
          workOrderId: current.id,
          ...facts.figures,
          currency: costed.currency,
          tolerancePct: facts.tolerancePct,
          reasonCode: body.reasonCode ?? null,
          reasonNote: body.reasonNote ?? null,
          closedAt: now,
          closedById: context.actorId,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
        select: CLOSE_COLUMNS,
      })
      const settlement = facts.settles ? await settleInCommand(tools, costed, closeId, facts.split) : null
      await tx.workOrder.update({ where: { id: current.id }, data: moveChange('CLOSED', now), select: { id: true } })

      tools.audit({
        recordType: 'WorkOrder',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { status: current.status },
        after: {
          status: 'CLOSED',
          closedAt: toUtcIso(now),
          closeId,
          reasonCode: body.reasonCode ?? null,
          ...facts.figures,
          plannedMaterialCost: markMoney('cost', facts.figures.plannedMaterialCost),
          actualMaterialCost: markMoney('cost', facts.figures.actualMaterialCost),
          tolerancePct: facts.tolerancePct,
          beyond: facts.beyond,
          settled: settlement !== null,
        },
        ...(body.reasonNote ? { reason: body.reasonNote } : {}),
      })
      const event = { subject: current.id, companyId: current.companyId, siteId: current.siteId }
      tools.emit({ ...event, type: 'workorder.status_changed', payload: { workOrderId: current.id, number: current.number, from: current.status, to: 'CLOSED' } })
      tools.emit({ ...event, type: 'work_order_close.changed', payload: { closeId, workOrderId: current.id, number: current.number, change: 'closed', settled: settlement !== null, beyond: facts.beyond.any } })
      if (settlement) {
        tools.emit({ ...event, type: 'work_order_cost.posted', payload: { workOrderId: current.id, number: current.number, entryIds: [...settlement.entryIds], kinds: settlement.varianceIds.length > 0 ? ['VARIANCE', 'CLOSE'] : ['CLOSE'], reversals: 0 } })
      }
      const mayCost = can(actor, COSTING_VIEW, scope)
      const [close] = await closeRecordViews(tx, [row], { actorId: context.actorId, mayManage: true, mayReopen: can(actor, WORKORDERS_REOPEN, scope), now })
      return {
        workOrder: await workOrderView(tx, (await readWorkOrder(tx, current.id))!, todayOfCommand(tools)),
        close: close!,
        split: settlement && mayCost ? splitViewOf(facts.split, await itemsOf(tx, facts.itemIds), settlement.varianceIds.map((varianceId) => ({ id: varianceId }))) : null,
        waits: facts.settles ? null : CLOSE_WAITS,
      }
    })
    return result
  } catch (error) {
    throw refusalOf(error)
  }
}
