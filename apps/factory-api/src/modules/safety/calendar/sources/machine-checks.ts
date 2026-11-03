import type { Prisma } from '@nexus/factory-db'
import { dateOfDay, dayOfDate, defineCalendarSource, sourceOf } from '../source'

/**
 * Statutory machine checks (B-W2b-120 reading factory-db MachineCheckPlan, B-W2b-86; the plans, reminders and results are
 * B-W2b-124's modules/plant/statutory, read here as tables and never edited): the next check of each ACTIVE plan whose due
 * day falls in the window, with the check type's words and legal basis (typed by the tenant: no interval of a law is built
 * in) and the plan's owner. Kept on Plant › Preventive & statutory checks (B-W2b-142); the machine's record opens until then.
 */
export default defineCalendarSource({
  kind: 'MACHINE_CHECK',
  async read(client, _context, window, scope) {
    const plans = await client.machineCheckPlan.findMany({
      where: { AND: [scope.site as Prisma.MachineCheckPlanWhereInput, { status: 'ACTIVE', nextDueOn: { gte: dateOfDay(window.openFrom), lte: dateOfDay(window.to) } }] },
      orderBy: [{ nextDueOn: 'asc' }, { id: 'asc' }],
      take: 2000,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        machineId: true,
        nextDueOn: true,
        ownerId: true,
        checkType: { select: { code: true, labelIt: true, labelEn: true, legalBasis: true } },
        machine: { select: { assetNumber: true, make: true } },
      },
    })
    return plans.map((plan) => ({
      key: `MACHINE_CHECK:${plan.id}`,
      kind: 'MACHINE_CHECK',
      recordType: 'MachineCheckPlan',
      recordId: plan.id,
      companyId: plan.companyId,
      siteId: plan.siteId,
      dueOn: dayOfDate(plan.nextDueOn),
      count: null,
      params: { checkIt: plan.checkType.labelIt, checkEn: plan.checkType.labelEn, checkCode: plan.checkType.code, asset: plan.machine.assetNumber, machine: plan.machine.make ?? '' },
      ownerId: plan.ownerId,
      evidence: null,
      law: plan.checkType.legalBasis.trim() || null,
      source: sourceOf('plant.preventive', 'MachineCheckPlan', plan.id, 'Machine', plan.machineId),
      editable: false,
    }))
  },
})
