import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { can, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandTx } from '../../core/command'
import { styleBrandWhere } from '../product/styles/store'
import { workOrderWhere } from '../production/work-orders/scope'

type Reader = FactoryClient | CommandTx

/**
 * B-PR-10 — the brand wall of compliance records (production plan §2; Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all. And manage it all as
 * well."). A compliance record of a style (a production-control test, a declaration's batch, a technical file, a register
 * entry) names its style's brand (a private-label style is its customer's; our own collection names none) and, when it has
 * one, the work order it was made from. A person limited to some customers reaches it only when it reaches both (a work order
 * of no customer needs every customer, B-PR-03); the production unit is not filtered (`{}`).
 */

/** The rows of a model with a `style` relation and an optional `workOrder` relation that `permission` reaches. */
export function styleWorkWall(actor: Actor, permission: Permission, relations: { readonly workOrder?: boolean } = { workOrder: true }): Record<string, unknown> {
  const work = workOrderWhere(actor, permission)
  if (Object.keys(work).length === 0) return {}
  const parts: Record<string, unknown>[] = [{ style: { is: styleBrandWhere(actor, permission) } }]
  if (relations.workOrder) parts.push({ OR: [{ workOrderId: null }, { workOrder: { is: work } }] })
  return { AND: parts }
}

/** A style's brand the person reaches (our own collection: always). */
export const reachesBrand = (actor: Actor, permission: Permission, brandPartyId: string | null): boolean => can(actor, permission, { partyId: brandPartyId })

/**
 * B-PR-10: a record about a work order OR a shipment by `subjectType` / `subjectId` (a gate event): the subjects a person limited
 * to some customers reaches — its customers' work orders (B-PR-03's wall) and shipments (a shipment is its customer's). Null
 * for the production unit (nothing to wall).
 */
export async function reachedSubjects(db: Reader, actor: Actor, permission: Permission): Promise<{ readonly workOrders: Set<string>; readonly shipments: Set<string> } | null> {
  const work = workOrderWhere(actor, permission)
  if (Object.keys(work).length === 0) return null
  const workOrders = await db.workOrder.findMany({ where: work, select: { id: true } })
  const shipments = await db.shipment.findMany({ where: scopeWhere(actor, permission, { company: 'companyId', party: 'partyId' }) as Prisma.ShipmentWhereInput, select: { id: true } })
  return { workOrders: new Set(workOrders.map((row) => row.id)), shipments: new Set(shipments.map((row) => row.id)) }
}

/** Whether a subject (`WorkOrder` or `Shipment`, by id) is among the reached ones (null: every subject). */
export const subjectReached = (reached: Awaited<ReturnType<typeof reachedSubjects>>, subjectType: string, subjectId: string): boolean =>
  reached === null || (subjectType === 'WorkOrder' ? reached.workOrders.has(subjectId) : subjectType === 'Shipment' ? reached.shipments.has(subjectId) : true)
