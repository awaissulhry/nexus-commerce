import type { FactoryClient } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { orderTeamMode } from '@nexus/factory-domain/production/order-teams/rules'
import { planTeams, structureOf } from '@nexus/factory-domain/production/structures/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { putPeopleOnOrder } from '../../sales/orders/people-writer'
import { readOrder, type OrderRow } from '../order-teams/read'
import { isPrinted, madeLinesOf, openOverridesOf, rulesOfCompany, structuresByIds } from './facts'

/**
 * At Confirm the structure gives the team and the people (owb-ss6 step 6.4 a; _owb-ss-common L10; design § 5zj C "When": "At
 * Confirm the structure gives the team and the people", prototype rules.js planApply). The worker's `production.structuresAtConfirm`
 * (background.ts HANDLERS, beside the orders' handlers), as the system of the event's tenant:
 *
 *   sales_order.created                               an order made CONFIRMED (one made waiting for a yes waits for its move)
 *   sales_order.status_changed PENDING_APPROVAL → CONFIRMED   an order that waited for its yes got it
 *
 * When the order is CONFIRMED, no team has it (no open OrderTeam row) and it was never printed (no FIRST OrderPrint): each made
 * line takes its structure (structureOf: by hand, else the first rule that fits), the structures' teams that are open and take
 * orders become the order's teams (planTeams: together, or split by the lines' pieces; one in charge; givenBy RULE, no person;
 * each row at its team's site), and the structures' office people are put on the order (S2's putPeopleOnOrder, as the system).
 * An order whose teams were given by hand is never touched; a repeat or a late event changes nothing (the facts are read again
 * under the order's teams lock, the same lock as PUT /production/orders/:orderId/teams).
 */

type Client = FactoryClient | CommandTx

/** What the structures give one confirmed order: its team rows (with each team's site) and its office people. */
export interface ConfirmPlan {
  readonly order: OrderRow
  readonly rows: Array<{ readonly teamId: string; readonly inCharge: boolean; readonly basketShare: number | null; readonly siteId: string }>
  readonly people: readonly string[]
  readonly structureIds: readonly string[]
}

/** The plan of one order, or null when nothing is to be given (not confirmed, a team has it, printed, or no structure gives anything). */
export async function confirmPlan(client: Client, orderId: string): Promise<ConfirmPlan | null> {
  const order = await readOrder(client, orderId)
  if (!order || order.status !== 'CONFIRMED') return null
  if ((await client.orderTeam.count({ where: { salesOrderId: orderId, endedAt: null } })) > 0) return null
  if (await isPrinted(client, orderId)) return null
  const lines = await madeLinesOf(client, [orderId])
  if (lines.length === 0) return null
  const rules = await rulesOfCompany(client, order.companyId)
  const override = (await openOverridesOf(client, [orderId])).get(orderId) ?? null
  const taken = lines.map((line) => ({ line, structureId: structureOf({ partyId: order.partyId, category: line.category }, rules, override).structureId }))
  const structures = await structuresByIds(client, taken.map((entry) => entry.structureId))
  // Only a team of the order's company that is open and takes orders is given; any other is skipped.
  const teamIds = [...new Set([...structures.values()].flatMap((structure) => structure.teamIds))]
  const teams = new Map((teamIds.length === 0 ? [] : await client.team.findMany({ where: { id: { in: teamIds }, companyId: order.companyId, status: 'ACTIVE', takesOrders: true }, select: { id: true, siteId: true } })).map((team) => [team.id, team.siteId]))
  const planned = planTeams(
    taken.map(({ line, structureId }) => {
      const structure = structureId === null ? undefined : structures.get(structureId)
      return { pieces: line.pieces, teamIds: structure && !structure.closed ? structure.teamIds.filter((teamId) => teams.has(teamId)) : [] }
    }),
  )
  const used = [...new Set(taken.flatMap((entry) => (entry.structureId === null ? [] : [entry.structureId])))]
  const people = [...new Set(used.flatMap((structureId) => { const structure = structures.get(structureId); return structure && !structure.closed ? structure.peopleUserIds : [] }))]
  if (planned.length === 0 && people.length === 0) return null
  return { order, rows: planned.map((row) => ({ ...row, siteId: teams.get(row.teamId)! })), people, structureIds: used }
}

/** Gives one confirmed order its structures' teams and people (a system command; nothing when there is nothing to give). */
export async function structuresAtConfirm(caller: CommandCaller, orderId: string, causationId?: string): Promise<{ readonly teams: number; readonly people: number }> {
  if (!(await caller.withClient((client) => confirmPlan(client, orderId)))) return { teams: 0, people: 0 }
  const { result } = await command(caller, { name: 'production.structuresAtConfirm', idempotencyKey: `structures-at-confirm-${orderId}`, input: { orderId }, ...(causationId ? { causationId } : {}) }, async (tools) => {
    const { tx, now } = tools
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.order-teams|${orderId}`}::text, 0))`
    // Read again under the lock: a team given by hand meanwhile (or a print) wins, and the audit row says so.
    const plan = await confirmPlan(tx, orderId)
    if (!plan) {
      const order = await readOrder(tx, orderId)
      tools.audit({ action: 'production.structuresAtConfirm', recordType: 'SalesOrder', recordId: orderId, companyId: order?.companyId ?? null, after: { skipped: true } })
      return { teams: 0, people: 0 }
    }
    for (const row of plan.rows) {
      await tx.orderTeam.create({
        data: { id: newId(), companyId: plan.order.companyId, partyId: plan.order.partyId, siteId: row.siteId, salesOrderId: orderId, teamId: row.teamId, inCharge: row.inCharge, basketShare: row.basketShare, givenBy: 'RULE', createdAt: now, updatedAt: now, createdById: null },
        select: { id: true },
      })
    }
    const added = plan.people.length === 0 ? 0 : await putPeopleOnOrder(tools, { salesOrderId: orderId, userIds: plan.people, byUserId: null })
    tools.audit({
      action: 'production.structuresAtConfirm',
      recordType: 'SalesOrder',
      recordId: orderId,
      companyId: plan.order.companyId,
      after: { structures: [...plan.structureIds], rows: plan.rows.map(({ teamId, inCharge, basketShare }) => ({ teamId, inCharge, basketShare })), mode: orderTeamMode(plan.rows), people: [...plan.people], peopleAdded: added },
    })
    return { teams: plan.rows.length, people: added }
  })
  return result
}

/** The worker's handler (background.ts HANDLERS, beside orderHandlers()). */
export function structureHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'production.structuresAtConfirm',
      events: ['sales_order.created', 'sales_order.status_changed'],
      attempts: 5,
      async handle(event, { caller }) {
        const payload = event.payload as { orderId?: string; from?: string; to?: string }
        if (!payload.orderId) return
        if (event.type === 'sales_order.status_changed' && (payload.from !== 'PENDING_APPROVAL' || payload.to !== 'CONFIRMED')) return
        await structuresAtConfirm(caller, payload.orderId, event.eventId)
      },
    }),
  ]
}
