import { ConflictError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { PRODUCTION_TEAMS_ASSIGN } from '@nexus/factory-domain/production/order-teams/permissions'
import { ORDER_TEAM_REFUSALS, orderTeamMode, teamRowsProblems, type TeamRowIn } from '@nexus/factory-domain/production/order-teams/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { refuse } from '../../people/employees/access'
import { liveAssignment } from '../../../platform/auth/roles/access'
import { createTask, mayBeAssigned } from '../../../platform/tasks/tasks'
import { assertMay, mayOn, officeContextOf } from '../../sales/orders/access'
import { basketsOfOrders, ORDER_DONE_STATUSES, orderTeamsAnswer, orderTeamsVersion, readOrder, seesOrderTeams } from './read'

/**
 * Teams own the work (owb-ss5 step 5.1; build/briefs/owb-ss5.md; design § 5za teamModal, teamAskSales; PL-schema G4). Writes.
 *
 *   PUT  /production/orders/:orderId/teams      the order's teams as a whole: one in charge; a split when any row has a share (every
 *                                               team its share, 1 or more, the shares adding up to the order's baskets). The rows
 *                                               that stay are kept (a change of charge only moves the flag), the rows taken off
 *                                               are ended and the new ones inserted (G4: an ended row never changes). After the
 *                                               order's FIRST print the shares stay: only rows without a share are added or
 *                                               taken off. One audit row on the order (before, after: rows, mode, why).
 *   POST /production/orders/:orderId/team-asks  whoever sees the order (sales) asks the production managers to give it to a team:
 *                                               a task on the order to each person who gives its work (production.teams.assign
 *                                               over its company), or one task for nobody yet when there is none.
 *
 * Refusals are 409s in words with `refusal/<CODE>` (the web's words per code): ORDER_TEAM_REFUSALS, ORDER_DONE, TEAM_NOT_OPEN.
 */

/** The words of the refusals this file adds to ORDER_TEAM_REFUSALS. */
export const ORDER_TEAM_WRITE_WORDS = {
  ORDER_DONE: 'This order has left or ended: its teams no longer change.',
  TEAM_NOT_OPEN: 'A team on the order is an open team of the order’s company that takes orders.',
  NOT_GIVER: 'You may see this order’s teams but not give its work.',
} as const

/** The most production managers one ask reaches. */
const ASK_REACH = 10

/** PUT /production/orders/:orderId/teams. */
export async function putOrderTeams(caller: CommandCaller, orderId: string, body: { readonly version: number; readonly rows: readonly TeamRowIn[]; readonly why?: string | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await caller.withClient((client) => readOrder(client, orderId))
  if (!seen || !seesOrderTeams(context, seen)) throw new NotFoundError('Sales order not found.')
  if (!mayOn(context, PRODUCTION_TEAMS_ASSIGN, seen)) throw new ForbiddenError(ORDER_TEAM_WRITE_WORDS.NOT_GIVER)
  const { result } = await command(caller, { name: 'production.setOrderTeams', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    // One PUT of an order's teams at a time (the rows are compared with the version read, then written).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.order-teams|${orderId}`}::text, 0))`
    const order = (await readOrder(tx, orderId))!
    if ((ORDER_DONE_STATUSES as readonly string[]).includes(order.status)) refuse('ORDER_DONE', ORDER_TEAM_WRITE_WORDS.ORDER_DONE)
    const version = await orderTeamsVersion(tx, orderId)
    if (version !== body.version) throw new ConflictError(`The order’s teams changed since you read them (version ${version}, not ${body.version}): read them again.`)
    const current = await tx.orderTeam.findMany({ where: { salesOrderId: orderId, endedAt: null }, select: { id: true, teamId: true, inCharge: true, basketShare: true } })
    const printed = (await tx.orderPrint.findFirst({ where: { salesOrderId: orderId, kind: 'FIRST' }, select: { id: true } })) !== null
    const plannedBaskets = (await basketsOfOrders(tx, [orderId])).get(orderId)?.planned ?? 0
    const problems = teamRowsProblems(body.rows, { plannedBaskets, printed, current })
    if (problems.length > 0) refuse(problems[0]!, ORDER_TEAM_REFUSALS[problems[0]!], 'rows', problems.slice(1).map((code) => ({ path: `refusal/${code}`, message: ORDER_TEAM_REFUSALS[code] })))
    // A team added (not on the order now): an open team of the order's company that takes orders.
    const added = body.rows.filter((row) => !current.some((have) => have.teamId === row.teamId))
    const teams = new Map(added.length === 0 ? [] : (await tx.team.findMany({ where: { id: { in: added.map((row) => row.teamId) } }, select: { id: true, companyId: true, siteId: true, status: true, takesOrders: true } })).map((team) => [team.id, team]))
    for (const row of added) {
      const team = teams.get(row.teamId)
      if (!team || team.companyId !== order.companyId || team.status !== 'ACTIVE' || !team.takesOrders) refuse('TEAM_NOT_OPEN', ORDER_TEAM_WRITE_WORDS.TEAM_NOT_OPEN, 'rows')
    }
    const actorId = context.actorId
    // Taken off, or a new share: ended. The same team and share: kept (its charge moves by an update). Ends and charges taken off
    // go first, so the one-in-charge index never sees two.
    const ended = current.filter((have) => !body.rows.some((row) => row.teamId === have.teamId && row.basketShare === have.basketShare))
    const kept = current.filter((have) => !ended.includes(have))
    for (const row of ended) await tx.orderTeam.update({ where: { id: row.id }, data: { endedAt: now, endedById: actorId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const chargeOff = kept.filter((have) => have.inCharge && !body.rows.find((row) => row.teamId === have.teamId)!.inCharge)
    const chargeOn = kept.filter((have) => !have.inCharge && body.rows.find((row) => row.teamId === have.teamId)!.inCharge)
    for (const row of chargeOff) await tx.orderTeam.update({ where: { id: row.id }, data: { inCharge: false, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const inserts = body.rows.filter((row) => !kept.some((have) => have.teamId === row.teamId))
    const siteOf = new Map((inserts.length === 0 ? [] : await tx.team.findMany({ where: { id: { in: inserts.map((row) => row.teamId) } }, select: { id: true, siteId: true } })).map((team) => [team.id, team.siteId]))
    for (const row of inserts) {
      await tx.orderTeam.create({
        data: { id: newId(), companyId: order.companyId, partyId: order.partyId, siteId: siteOf.get(row.teamId)!, salesOrderId: orderId, teamId: row.teamId, inCharge: row.inCharge, basketShare: row.basketShare, givenBy: 'USER', createdAt: now, updatedAt: now, createdById: actorId },
        select: { id: true },
      })
    }
    for (const row of chargeOn) await tx.orderTeam.update({ where: { id: row.id }, data: { inCharge: true, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: 'production.setOrderTeams',
      recordType: 'SalesOrder',
      recordId: orderId,
      companyId: order.companyId,
      before: { rows: current.map(({ teamId, inCharge, basketShare }) => ({ teamId, inCharge, basketShare })), mode: orderTeamMode(current) },
      after: { rows: body.rows.map(({ teamId, inCharge, basketShare }) => ({ teamId, inCharge, basketShare })), mode: orderTeamMode(body.rows), why: body.why ?? null },
    })
    return orderTeamsAnswer(tx, context, order, now)
  })
  return result
}

/** The people who give this company's work to teams (a live assignment of an office role with production.teams.assign), at most ASK_REACH. */
async function productionManagersOf(caller: CommandCaller, companyId: string, now: Date): Promise<string[]> {
  return caller.withClient(async (client) => {
    const rows = await client.roleAssignment.findMany({
      where: { ...liveAssignment(now), user: { status: 'ACTIVE' }, role: { audience: 'OFFICE', permissions: { has: PRODUCTION_TEAMS_ASSIGN } }, OR: [{ allCompanies: true }, { companyIds: { has: companyId } }] },
      orderBy: [{ userId: 'asc' }],
      select: { userId: true },
      take: 200,
    })
    return [...new Set(rows.map((row) => row.userId))]
  })
}

/** POST /production/orders/:orderId/team-asks. */
export async function askForTeam(caller: CommandCaller, orderId: string, body: { readonly why: string }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeContextOf(caller)
  const order = await caller.withClient((client) => readOrder(client, orderId))
  assertMay(context, ORDERS_VIEW, order)
  const scope = { companyId: order.companyId, siteId: null, partyId: order.partyId }
  const managers: string[] = []
  for (const userId of await productionManagersOf(caller, order.companyId, now)) {
    if (managers.length >= ASK_REACH) break
    if (userId === context.actorId) continue
    if (await caller.withClient((client) => mayBeAssigned(client, context.tenantId, userId, scope, true, now, 'SalesOrder'))) managers.push(userId)
  }
  const task = (assigneeId: string | null, index: number) =>
    createTask(caller, { title: `Give order ${order.number} to a team`, description: body.why, record: { type: 'SalesOrder', id: order.id }, assigneeId }, idempotencyKey ? `${idempotencyKey}:${index}` : undefined)
  // One task a person, one after the other (each its own command); none: one task for nobody yet.
  const first = await task(managers[0] ?? null, 0)
  for (let index = 1; index < managers.length; index++) await task(managers[index]!, index)
  return { taskId: first.task.id, replayed: false }
}
