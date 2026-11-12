import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { quarantinePlan } from '@nexus/factory-domain/inventory/tasks/sources'
import { STOCK_SUBJECTS, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import type { CommandCaller } from '../../../../core/command'
import type { Reader } from '../../issue/store'
import { cancelInCommand, changeInCommand, createTaskInCommand, openTasksOf } from '../lifecycle'
import { defineTaskSource, sourceCommand } from '../source-kit'

/**
 * The quarantine move a hold asks is a QUARANTINE task (B-W2b-292; follow-up WT1:01; QHS-078; design quality.holds "'Ask for a
 * move to quarantine' … creates the floor move task", floor.move "a quarantine move closes its task"). It follows the hold's
 * events and makes its one open task match the hold as it stands (factory-domain inventory/tasks sources quarantinePlan):
 *
 *   asked (placed with the move, or asked later)  one QUARANTINE task to the asked place (source QualityHold); a hold of one
 *                                                 lot or hide names it on the task
 *   asked elsewhere                               the open task follows to the new place
 *   released, closed, or no longer asked          the task is cancelled with why
 * The move itself is done by the scan of the quarantine place on the tablet, or by the office's confirm: both close the task
 * in their own command (modules/quality/holds depth.ts moveIntoQuarantineInCommand). A move confirmed by a path that did not
 * close it cancels it here.
 */

const HOLD = { id: true, companyId: true, siteId: true, subjectType: true, subjectIds: true, status: true, quarantine: true, quarantineLocationId: true } as const

async function onHold(caller: CommandCaller, event: EventEnvelope): Promise<void> {
  // Every event of the four names its hold by holdId.
  const { holdId } = event.payload as { holdId: string }
  const read = await caller.withClient(async (client) => {
    const db = client as unknown as Reader
    const hold = await db.qualityHold.findUnique({ where: { id: holdId }, select: HOLD })
    if (!hold) return null
    const open = await openTasksOf(db, { type: 'QualityHold', id: hold.id }, 'QUARANTINE')
    return { hold, plan: quarantinePlan({ ...hold, stock: STOCK_SUBJECTS.includes(hold.subjectType as HoldSubjectType) }, open) }
  })
  if (!read || read.plan.action === 'NONE') return
  const { hold } = read
  await sourceCommand(caller, 'holds', event, { holdId: hold.id }, async (tools) => {
    // Planned again on the rows as they are in the command (a second job of the same event finds nothing to do).
    const open = await openTasksOf(tools.tx, { type: 'QualityHold', id: hold.id }, 'QUARANTINE')
    const current = await tools.tx.qualityHold.findUniqueOrThrow({ where: { id: hold.id }, select: HOLD })
    const plan = quarantinePlan({ ...current, stock: STOCK_SUBJECTS.includes(current.subjectType as HoldSubjectType) }, open)
    if (plan.action === 'CREATE') {
      const one = current.subjectIds.length === 1 ? current.subjectIds[0]! : null
      const hide = one && current.subjectType === 'Hide' ? await tools.tx.hide.findUnique({ where: { id: one }, select: { id: true, lotId: true, itemId: true } }) : null
      const lot = one && current.subjectType === 'Lot' ? await tools.tx.lot.findUnique({ where: { id: one }, select: { id: true, itemId: true, itemColourId: true } }) : null
      await createTaskInCommand(tools, {
        companyId: current.companyId,
        siteId: current.siteId,
        kind: 'QUARANTINE',
        source: { type: 'QualityHold', id: current.id },
        itemId: hide?.itemId ?? lot?.itemId ?? null,
        itemColourId: lot?.itemColourId ?? null,
        lotId: hide?.lotId ?? lot?.id ?? null,
        hideId: hide?.id ?? null,
        toLocationId: plan.toLocationId,
      })
    } else if (plan.action === 'FOLLOW') {
      await changeInCommand(tools, open.find((row) => row.id === plan.taskId)!, { toLocationId: plan.toLocationId })
    } else if (plan.action === 'CANCEL') {
      for (const row of open.filter((entry) => plan.taskIds.includes(entry.id))) await cancelInCommand(tools, row, plan.reason)
    } else {
      tools.audit({ action: 'inventory.warehouseTaskSource', recordType: 'QualityHold', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { quarantineTask: 'unchanged' } })
    }
  })
}

export default defineTaskSource({
  name: 'holds',
  events: ['quality.hold_placed', 'quality.hold_changed', 'quality.hold_released', 'ncr.hold_closed'],
  handle: onHold,
})
