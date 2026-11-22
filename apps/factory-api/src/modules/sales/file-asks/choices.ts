import { z } from 'zod'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { liveAssignment } from '../../../platform/auth/roles/access'
import { takesIssueTask } from '../../production/issues/tasks'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { mayKeepAsks, NOT_YOURS, reachOrder } from './file-asks'

/**
 * B-OF-035 (order files tab; the lead's S3 item for W2) — what the "Ask for a file…" window may pick, in ONE walled read:
 *
 *   GET /sales/orders/:orderId/file-asks/choices
 *
 * The same right as making an ask (tasks.manage + threads.post over the order; another customer's order, or an unknown id: "Sales
 * order not found."), so everyone who may ask can pick an office role or a team without roles.view or people.view. What comes back:
 *   people        the ACTIVE office people who may be given a task on the order (as ./people.ts picks them: they read its thread and
 *                 keep tasks there; a person limited to other customers falls out), by name
 *   officeRoles   the live office roles with at least one such person among their holders (an ask to one reaches somebody)
 *   floorRoles    the live floor roles with a live holder at a plant of the order's work orders, with those plants
 *   teams         the ACTIVE teams of those plants
 *   lines         the order's lines
 *   workOrders    the order's work orders the reader reaches (live, not a repair, making one of its lines), each with its steps
 * Names of office people only: NEVER a floor worker's name, never a count of members (worker privacy), no price. A read: nothing written.
 */

/** The most office people the read weighs (each is checked on the order). */
export const CHOICES_PEOPLE_MAX = 300

const named = output({ id: id(), name: z.string() })

export const askChoicesContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      people: z.array(named),
      officeRoles: z.array(named),
      floorRoles: z.array(named.extend({ siteIds: z.array(id()) })),
      teams: z.array(named.extend({ siteId: id() })),
      lines: z.array(output({ id: id(), seq: z.number().int(), label: z.string() })),
      workOrders: z.array(output({ id: id(), number: z.string(), siteId: id(), steps: z.array(output({ id: id(), seq: z.number().int(), name: z.string() })) })),
      /** More office people than the read weighs: pick by role or ask again later. */
      truncated: z.boolean(),
    }),
  },
})

const byName = <T extends { readonly name: string }>(a: T, b: T): number => a.name.localeCompare(b.name, 'it')

/** The answer (of-fx1s: a written type, not one inferred from the queries). */
export interface AskChoices {
  readonly people: { id: string; name: string }[]
  readonly officeRoles: { id: string; name: string }[]
  readonly floorRoles: { id: string; name: string; siteIds: string[] }[]
  readonly teams: { id: string; name: string; siteId: string }[]
  readonly lines: { id: string; seq: number; label: string }[]
  readonly workOrders: { id: string; number: string; siteId: string; steps: { id: string; seq: number; name: string }[] }[]
  readonly truncated: boolean
}

/** GET /sales/orders/:orderId/file-asks/choices */
export async function askChoices(caller: CommandCaller, orderId: string): Promise<AskChoices> {
  const { context, actor, order } = await reachOrder(caller, orderId)
  if (!mayKeepAsks(actor, order, true)) throw new ForbiddenError(NOT_YOURS)
  const now = serverClock.now()
  const record = { type: 'SalesOrder', id: order.id, label: order.number, companyId: order.companyId, siteId: null, partyId: order.partyId }
  return caller.withClient(async (db): Promise<AskChoices> => {
    // ---- office people who may be given a task on the order, and the office roles that reach one of them --------------------------
    const assignments = await db.roleAssignment.findMany({
      where: { ...liveAssignment(now), role: { audience: 'OFFICE', archivedAt: null }, user: { status: 'ACTIVE', audience: 'OFFICE' } },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      take: CHOICES_PEOPLE_MAX * 10,
      select: { userId: true, roleId: true, user: { select: { displayName: true } } },
    })
    const candidates = new Map<string, { name: string; roleIds: Set<string> }>()
    for (const row of assignments) {
      const entry = candidates.get(row.userId) ?? { name: row.user.displayName, roleIds: new Set<string>() }
      entry.roleIds.add(row.roleId)
      candidates.set(row.userId, entry)
    }
    const weighed = [...candidates].slice(0, CHOICES_PEOPLE_MAX)
    const people: { id: string; name: string }[] = []
    const reachingRoles = new Set<string>()
    for (const [userId, entry] of weighed) {
      if (!(await takesIssueTask(db, context.tenantId, userId, record, now))) continue
      people.push({ id: userId, name: entry.name })
      for (const roleId of entry.roleIds) reachingRoles.add(roleId)
    }
    const officeRoles = reachingRoles.size === 0 ? [] : (await db.role.findMany({ where: { id: { in: [...reachingRoles] }, audience: 'OFFICE', archivedAt: null }, select: { id: true, name: true } })).map((row) => ({ id: row.id, name: row.name }))

    // ---- the order's lines, its work orders the reader reaches and their steps --------------------------------------------------
    const lines = await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, seq: true }, orderBy: { seq: 'asc' } })
    const lineIds = lines.map((line) => line.id)
    const workOrders = lineIds.length === 0
      ? []
      : (await db.workOrder.findMany({
          where: { companyId: order.companyId, partyId: order.partyId, status: { not: 'CANCELLED' }, kind: { not: 'REPAIR' }, sizes: { some: { salesOrderLineId: { in: lineIds } } } },
          select: { id: true, number: true, companyId: true, siteId: true, partyId: true },
          orderBy: { number: 'asc' },
        })).filter((row) => reachesWorkOrder(actor, WORKORDERS_VIEW, row))
    const workOrderIds = workOrders.map((row) => row.id)
    const steps = workOrderIds.length === 0 ? [] : await db.workOrderOperation.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true, seq: true, name: true }, orderBy: [{ workOrderId: 'asc' }, { seq: 'asc' }] })
    const siteIds = [...new Set(workOrders.map((row) => row.siteId))]

    // ---- the floor of those plants: active teams, live floor roles with a live holder there (never a worker named or counted) --------
    const teams = siteIds.length === 0 ? [] : await db.team.findMany({ where: { siteId: { in: siteIds }, status: 'ACTIVE' }, select: { id: true, name: true, siteId: true } })
    const held = siteIds.length === 0 ? [] : await db.workerRole.findMany({ where: { siteId: { in: siteIds }, endedAt: null }, select: { roleId: true, siteId: true } })
    const sitesOfRole = new Map<string, Set<string>>()
    for (const row of held) sitesOfRole.set(row.roleId, (sitesOfRole.get(row.roleId) ?? new Set<string>()).add(row.siteId))
    const floorRoles = sitesOfRole.size === 0 ? [] : (await db.role.findMany({ where: { id: { in: [...sitesOfRole.keys()] }, audience: 'FLOOR', archivedAt: null }, select: { id: true, name: true } })).map((row) => ({ id: row.id, name: row.name, siteIds: [...(sitesOfRole.get(row.id) ?? [])].sort() }))

    return {
      people: people.sort(byName),
      officeRoles: officeRoles.sort(byName),
      floorRoles: floorRoles.sort(byName),
      teams: teams.map((row) => ({ id: row.id, name: row.name, siteId: row.siteId })).sort(byName),
      lines: lines.map((line) => ({ id: line.id, seq: line.seq, label: `${order.number} · ${line.seq}` })),
      workOrders: workOrders.map((row) => ({ id: row.id, number: row.number, siteId: row.siteId, steps: steps.filter((step) => step.workOrderId === row.id).map((step) => ({ id: step.id, seq: step.seq, name: step.name })) })),
      truncated: candidates.size > CHOICES_PEOPLE_MAX,
    }
  })
}
