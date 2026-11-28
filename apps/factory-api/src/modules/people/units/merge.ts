import { newId } from '@nexus/factory-domain/core/ids'
import type { MovePlan } from '@nexus/factory-domain/people/teams/rules'
import { UNIT_ACTIONS } from '@nexus/factory-domain/people/units/history'
import { mergeIdProblems, mergePlan, OPEN_ORDER_STATES, UNIT_REFUSALS, unitFieldProblems, type UnitRefusal } from '@nexus/factory-domain/people/units/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorIdOf, dateOf, dayOf, officeOf, todayOf } from '../employees/access'
import { lockStructure, lockUnit, readUnit, unitRecordView, type UnitRow } from './read'
import { refuseAll, tenantOf, writableUnit } from './units'

/**
 * Merge (owb-ss5 step 5.2; design § 5zb "Merge teams (or units), ANY number … Every person and every order moves. The others are
 * closed, not erased", § 5zd; prototype org.js unitMerge): POST /people/units/merge { keepId, mergeIds[], name, leaderEmployeeId? }.
 * Office only, people.structure.manage over the kept unit and every merged one (can() against their company and site).
 *
 * One command, all or nothing, the plan made by the domain's mergePlan (factory-domain people/units/rules) from facts read under
 * the structure's lock and the units' row locks:
 *   1. the tree     the kept unit takes the place of the highest merged unit above it (if any); the open units under a merged
 *                   unit go under the kept one (each audited as a move "because the units were merged")
 *   2. people       each person of a merged unit moves into the kept unit, effective today (the old row ends yesterday, or the row
 *                   that began today is removed; a leader loses the flag first), one audit row on each person
 *   3. orders       per order still in work: the merged teams' open rows end (when and who); the kept team's own row takes their
 *                   baskets (and the summed share), or ONE new row of the kept team does; it takes the charge only when a merged
 *                   row had it and no other team holds it — never the kept team twice on an order; one audit row per order
 *   4. close        each merged unit is archived with mergedIntoId (Team_unit_check: a merged unit is archived), one audit row each
 *   5. the kept     its name, and its leader when one is named (a person of the units that became one)
 * Order rows of orders no longer in work stay where they are (the history of a finished order is not rewritten).
 */

export interface MergeBody {
  readonly keepId: string
  readonly mergeIds: readonly string[]
  readonly name: string
  readonly leaderEmployeeId?: string | null | undefined
}

/** Writes one person's move inside the command (planned by movePlan, effective today), as today's team moves do. */
async function writeMembershipMove(tools: CommandTools, employeeId: string, plan: Extract<MovePlan, { kind: 'MOVE' }>, siteId: string): Promise<void> {
  const { tx, now } = tools
  if (plan.remove) await tx.teamMember.delete({ where: { id: plan.remove }, select: { id: true } })
  if (plan.end) {
    if (plan.wasLead) await tx.teamMember.update({ where: { id: plan.end.id }, data: { isLead: false, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    await tx.teamMember.update({ where: { id: plan.end.id }, data: { until: dateOf(plan.end.until), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  }
  if (plan.start) {
    await tx.teamMember.create({ data: { id: newId(), siteId, teamId: plan.start.teamId, employeeId, isLead: false, since: dateOf(plan.start.since), createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) }, select: { id: true } })
  }
}

const refusalOf = (code: keyof typeof UNIT_REFUSALS, field: string): UnitRefusal => ({ code, words: UNIT_REFUSALS[code], field })

/** POST /people/units/merge. */
export async function mergeUnits(caller: CommandCaller, body: MergeBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = [...mergeIdProblems(body.keepId, body.mergeIds), ...unitFieldProblems({ name: body.name })]
  if (problems.length > 0) refuseAll(problems)
  // Read and write rights first, outside the transaction: a unit the caller cannot read is not found, one they cannot keep is a 403.
  for (const unitId of [body.keepId, ...body.mergeIds]) await writableUnit(caller, context, unitId)
  const actorId = context.actorId
  const { result } = await command(caller, { name: UNIT_ACTIONS.merge, idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    await lockStructure(tx, tenantOf(tools))
    const locked = new Map<string, UnitRow>()
    for (const unitId of [body.keepId, ...body.mergeIds].sort()) locked.set(unitId, await lockUnit(tx, unitId))
    const kept = locked.get(body.keepId)!
    const merged = body.mergeIds.map((unitId) => locked.get(unitId)!)
    if (kept.status !== 'ACTIVE') refuseAll([refusalOf('MERGE_CLOSED', 'keepId')])
    if (merged.some((unit) => unit.status !== 'ACTIVE')) refuseAll([refusalOf('MERGE_CLOSED', 'mergeIds')])
    if (merged.some((unit) => unit.siteId !== kept.siteId || unit.companyId !== kept.companyId)) refuseAll([refusalOf('MERGE_OTHER_SITE', 'mergeIds')])

    const allIds = [kept.id, ...merged.map((unit) => unit.id)]
    const members = await tx.teamMember.findMany({ where: { teamId: { in: allIds }, until: null }, select: { id: true, teamId: true, employeeId: true, isLead: true, since: true } })
    // The people's rows in id order (a concurrent move of the same people waits), as today's team moves do.
    for (const employeeId of [...new Set(members.map((member) => member.employeeId))].sort()) await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId}::uuid FOR UPDATE`
    if (body.leaderEmployeeId && !members.some((member) => member.employeeId === body.leaderEmployeeId)) refuseAll([refusalOf('MERGE_LEADER_NOT_MEMBER', 'leaderEmployeeId')])

    const units = await tx.team.findMany({ where: { companyId: kept.companyId }, select: { id: true, parentTeamId: true, status: true, name: true } })
    const unitName = new Map(units.map((unit) => [unit.id, unit.name]))
    const working = await tx.orderTeam.findMany({ where: { teamId: { in: allIds }, endedAt: null, salesOrder: { status: { in: [...OPEN_ORDER_STATES] } } }, select: { salesOrderId: true } })
    const orderIds = [...new Set(working.map((row) => row.salesOrderId))].sort()
    for (const orderId of orderIds) await tx.$queryRaw`SELECT "id" FROM "OrderTeam" WHERE "salesOrderId" = ${orderId}::uuid AND "endedAt" IS NULL FOR UPDATE`
    const orderRows =
      orderIds.length === 0
        ? []
        : await tx.orderTeam.findMany({ where: { salesOrderId: { in: orderIds }, endedAt: null }, select: { id: true, salesOrderId: true, companyId: true, partyId: true, siteId: true, teamId: true, inCharge: true, basketShare: true, bundleIds: true, givenBy: true } })

    const plan = mergePlan({
      keepId: kept.id,
      mergeIds: merged.map((unit) => unit.id),
      today,
      units: units.map((unit) => ({ id: unit.id, parentId: unit.parentTeamId, closed: unit.status !== 'ACTIVE' })),
      members: members.map((member) => ({ id: member.id, teamId: member.teamId, employeeId: member.employeeId, isLead: member.isLead, since: dayOf(member.since) })),
      orderRows: orderRows.map((row) => ({ ...row, givenBy: row.givenBy as 'USER' | 'RULE' })),
    })
    const keptName = body.name.trim()
    const audit = (entry: Parameters<CommandTools['audit']>[0]) => tools.audit({ action: UNIT_ACTIONS.merge, ...entry })

    // 1. The tree.
    if (plan.keptParent) {
      await tx.team.update({ where: { id: kept.id }, data: { parentTeamId: plan.keptParent.to, updatedAt: now }, select: { id: true } })
      tools.audit({ action: UNIT_ACTIONS.move, recordType: 'Team', recordId: kept.id, companyId: kept.companyId, siteId: kept.siteId, reason: 'The units above it were merged into it.', before: { parentId: plan.keptParent.from, parentName: plan.keptParent.from ? (unitName.get(plan.keptParent.from) ?? null) : null }, after: { parentId: plan.keptParent.to, parentName: plan.keptParent.to ? (unitName.get(plan.keptParent.to) ?? null) : null } })
    }
    for (const move of plan.reparent) {
      const child = await lockUnit(tx, move.unitId)
      await tx.team.update({ where: { id: child.id }, data: { parentTeamId: kept.id, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: UNIT_ACTIONS.move, recordType: 'Team', recordId: child.id, companyId: child.companyId, siteId: child.siteId, reason: 'The unit above it was merged.', before: { parentId: move.from, parentName: unitName.get(move.from) ?? null }, after: { parentId: kept.id, parentName: keptName } })
      tools.emit({ type: 'team.changed', subject: child.id, companyId: child.companyId, siteId: child.siteId, payload: { teamId: child.id, code: child.code, change: 'EDITED', employeeIds: [] } })
    }

    // 2. People.
    const movedOut = new Map<string, string[]>()
    for (const person of plan.people) {
      await writeMembershipMove(tools, person.employeeId, person.plan, kept.siteId)
      movedOut.set(person.fromTeamId, [...(movedOut.get(person.fromTeamId) ?? []), person.employeeId])
      audit({ recordType: 'Employee', recordId: person.employeeId, companyId: kept.companyId, siteId: kept.siteId, before: { teamId: person.fromTeamId }, after: { from: { id: person.fromTeamId, name: unitName.get(person.fromTeamId) ?? null }, to: { id: kept.id, name: keptName }, wasLeader: person.plan.wasLead } })
    }

    // 3. Orders: the merged rows end first (the charge and the baskets are free), then the kept rows take them.
    const rowById = new Map(orderRows.map((row) => [row.id, row]))
    for (const rowId of plan.endRows) await tx.orderTeam.update({ where: { id: rowId }, data: { endedAt: now, endedById: actorId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    for (const update of plan.updateRows) {
      await tx.orderTeam.update({ where: { id: update.rowId }, data: { inCharge: update.inCharge, basketShare: update.basketShare, bundleIds: [...update.bundleIds], version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    }
    for (const insert of plan.insertRows) {
      await tx.orderTeam.create({
        data: {
          id: newId(),
          companyId: insert.companyId,
          partyId: insert.partyId,
          siteId: insert.siteId,
          salesOrderId: insert.salesOrderId,
          teamId: kept.id,
          inCharge: insert.inCharge,
          basketShare: insert.basketShare,
          ...(insert.bundleIds.length > 0 ? { bundleIds: [...insert.bundleIds] } : {}),
          givenBy: insert.givenBy,
          createdAt: now,
          updatedAt: now,
          createdById: actorId,
        },
        select: { id: true },
      })
    }
    const touched = [...plan.updateRows.map((row) => ({ salesOrderId: row.salesOrderId, fromRowIds: row.fromRowIds, inCharge: row.inCharge })), ...plan.insertRows.map((row) => ({ salesOrderId: row.salesOrderId, fromRowIds: row.fromRowIds, inCharge: row.inCharge }))]
    for (const order of touched) {
      const first = rowById.get(order.fromRowIds[0]!)!
      audit({
        recordType: 'SalesOrder',
        recordId: order.salesOrderId,
        companyId: first.companyId,
        siteId: first.siteId,
        before: { teams: order.fromRowIds.map((rowId) => { const row = rowById.get(rowId)!; return { teamId: row.teamId, name: unitName.get(row.teamId) ?? null, inCharge: row.inCharge, basketShare: row.basketShare } }) },
        after: { teamId: kept.id, name: keptName, inCharge: order.inCharge, why: 'The teams were merged.' },
      })
    }

    // 4. The merged units close, merged into the kept one.
    for (const unit of merged) {
      await tx.team.update({ where: { id: unit.id }, data: { status: 'ARCHIVED', mergedIntoId: kept.id, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      audit({ recordType: 'Team', recordId: unit.id, companyId: unit.companyId, siteId: unit.siteId, before: { status: 'ACTIVE', name: unit.name }, after: { status: 'ARCHIVED', keptId: kept.id, keptName } })
      tools.emit({ type: 'team.changed', subject: unit.id, companyId: unit.companyId, siteId: unit.siteId, payload: { teamId: unit.id, code: unit.code, change: 'ARCHIVED', employeeIds: movedOut.get(unit.id) ?? [] } })
    }

    // 5. The kept unit: its name, its leader.
    let leaderNow = members.find((member) => member.teamId === kept.id && member.isLead)?.employeeId ?? null
    if (body.leaderEmployeeId !== undefined && body.leaderEmployeeId !== leaderNow) {
      const current = await tx.teamMember.findFirst({ where: { teamId: kept.id, isLead: true, until: null }, select: { id: true } })
      if (current) await tx.teamMember.update({ where: { id: current.id }, data: { isLead: false, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      if (body.leaderEmployeeId) {
        const next = await tx.teamMember.findFirst({ where: { teamId: kept.id, employeeId: body.leaderEmployeeId, until: null }, select: { id: true } })
        if (!next) return refuseAll([refusalOf('MERGE_LEADER_NOT_MEMBER', 'leaderEmployeeId')])
        await tx.teamMember.update({ where: { id: next.id }, data: { isLead: true, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      }
      leaderNow = body.leaderEmployeeId
    }
    await tx.team.update({ where: { id: kept.id }, data: { ...(keptName !== kept.name ? { name: keptName } : {}), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    audit({
      recordType: 'Team',
      recordId: kept.id,
      companyId: kept.companyId,
      siteId: kept.siteId,
      before: { name: kept.name },
      after: { name: keptName, merged: merged.map((unit) => ({ id: unit.id, name: unit.name })), people: plan.people.length, orders: touched.length, units: plan.reparent.length, leaderEmployeeId: leaderNow },
    })
    const movedIn = plan.people.map((person) => person.employeeId)
    tools.emit({ type: 'team.changed', subject: kept.id, companyId: kept.companyId, siteId: kept.siteId, payload: { teamId: kept.id, code: kept.code, change: movedIn.length > 0 ? 'MEMBERS_MOVED' : 'EDITED', employeeIds: movedIn } })

    return {
      unit: await unitRecordView(tx, context, (await readUnit(tx, kept.id))!),
      moved: { people: plan.people.length, orders: touched.length, units: plan.reparent.length },
      closed: merged.map((unit) => unit.id),
    }
  })
  return result
}
