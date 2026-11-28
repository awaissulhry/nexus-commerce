import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { structureOf } from '@nexus/factory-domain/production/structures/rules'
import type { CommandTx } from '../../../core/command'
import { madeLinesOf, openOverridesOf, rulesOfCompany, structuresByIds } from './facts'

/**
 * The first print keeps each line's structure (owb-ss6 step 6.4 (b); _owb-ss-common L10; design § 5zj C planKeep). Called INSIDE the
 * FIRST print's command (modules/production/print-start/start.ts), after its work orders are made and released: one
 * OrderLineStructureKept per made line of the order (append-only, unique per line) — what the line takes now (structureOf: by hand,
 * else the first rule that fits, else the normal way), the rule that gave it, where it came from, and a snapshot of what it was:
 * its steps (the line's work order's operations, in order), the structure's team names and its office people's names. A rule or a
 * structure that changes later changes nothing on the order. A line that kept already (a replay) is left as it is.
 */
export async function keepStructuresInCommand(tx: CommandTx, order: { readonly id: string; readonly companyId: string; readonly partyId: string }, keptById: string | null, now: Date): Promise<number> {
  const lines = await madeLinesOf(tx, [order.id])
  if (lines.length === 0) return 0
  const already = new Set((await tx.orderLineStructureKept.findMany({ where: { salesOrderId: order.id }, select: { salesOrderLineId: true } })).map((row) => row.salesOrderLineId))
  const fresh = lines.filter((line) => !already.has(line.id))
  if (fresh.length === 0) return 0
  const rules = await rulesOfCompany(tx, order.companyId)
  const override = (await openOverridesOf(tx, [order.id])).get(order.id) ?? null
  const taken = fresh.map((line) => ({ line, at: structureOf({ partyId: order.partyId, category: line.category }, rules, override) }))
  const structures = await structuresByIds(tx, taken.map((entry) => entry.at.structureId))
  const teamIds = [...new Set([...structures.values()].flatMap((structure) => structure.teamIds))]
  const teamNames = new Map((teamIds.length === 0 ? [] : await tx.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } })).map((team) => [team.id, team.name]))
  const userIds = [...new Set([...structures.values()].flatMap((structure) => structure.peopleUserIds))]
  const userNames = new Map((userIds.length === 0 ? [] : await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  // The steps of each line: its work order's operations (the first work order of the line, as the print made or found it).
  const sizes = await tx.workOrderSize.findMany({ where: { salesOrderLineId: { in: fresh.map((line) => line.id) } }, orderBy: [{ workOrderId: 'asc' }], select: { salesOrderLineId: true, workOrderId: true } })
  const workOrderOf = new Map<string, string>()
  for (const size of sizes) if (size.salesOrderLineId && !workOrderOf.has(size.salesOrderLineId)) workOrderOf.set(size.salesOrderLineId, size.workOrderId)
  const operations = workOrderOf.size === 0 ? [] : await tx.workOrderOperation.findMany({ where: { workOrderId: { in: [...new Set(workOrderOf.values())] } }, orderBy: [{ workOrderId: 'asc' }, { seq: 'asc' }], select: { workOrderId: true, seq: true, code: true, name: true } })
  for (const { line, at } of taken) {
    const structure = at.structureId === null ? undefined : structures.get(at.structureId)
    const workOrderId = workOrderOf.get(line.id)
    const snapshot = {
      steps: operations.filter((operation) => operation.workOrderId === workOrderId).map((operation) => ({ seq: operation.seq, code: operation.code, name: operation.name })),
      teams: (structure?.teamIds ?? []).map((teamId) => ({ id: teamId, name: teamNames.get(teamId) ?? '' })),
      people: (structure?.peopleUserIds ?? []).map((userId) => ({ id: userId, name: userNames.get(userId) ?? '' })),
    }
    await tx.orderLineStructureKept.create({
      data: {
        id: newId(),
        companyId: order.companyId,
        partyId: order.partyId,
        salesOrderId: order.id,
        salesOrderLineId: line.id,
        structureId: at.structureId,
        ruleId: at.ruleId,
        keptFrom: at.from,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        keptAt: now,
        keptById,
      },
      select: { id: true },
    })
  }
  return taken.length
}
