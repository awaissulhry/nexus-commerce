import type { FactoryClient } from '@nexus/factory-db'
import type { RouteSummaryStep } from '@nexus/factory-domain/product/styles/contracts'
import { departmentOfKind, OUTSIDE } from '@nexus/factory-domain/production/departments/kinds'
import type { CommandTx } from '../../../core/command'

/**
 * "How it is made" (owb-pd1 1.2; design § 5q Overview, prototype prod.js `prodRouteOf`): the departments a product goes through,
 * read with the style (product.styles.view), so sales and the designer read the names without product.routing.view. Never the
 * minutes, never a step's own words.
 *
 *   revision   the RELEASED one (the product as it is made today), else the newest DRAFT; none: no step.
 *   step       its own department (RoutingOperation.departmentId, copied when the step was made, owb-b1 G3), else the department
 *              of its kind (factory-domain departmentOfKind: an old released route keeps no department); a step done outside
 *              (SUBCONTRACT) has none and is left out.
 *   repeats    a step in the same department as the one before it (an old route of fine steps: two sewing steps) shows once.
 */

type Reader = FactoryClient | CommandTx

export async function routeSummaryOf(client: Reader, styleId: string): Promise<RouteSummaryStep[]> {
  // One query after another: a transaction client runs one at a time anyway.
  const revisions = await client.styleRevision.findMany({ where: { styleId, status: { in: ['RELEASED', 'DRAFT'] } }, select: { id: true, status: true }, orderBy: { revision: 'desc' } })
  const current = revisions.find((revision) => revision.status === 'RELEASED') ?? revisions[0]
  if (!current) return []
  const steps = await client.routingOperation.findMany({ where: { revisionId: current.id }, select: { departmentId: true, workCentreKind: true }, orderBy: { seq: 'asc' } })
  if (steps.length === 0) return []
  // The tenant's departments: a short list (1 Pattern … 9 Assembly and the ones added), closed ones too (an old step names one).
  const departments = await client.department.findMany({ select: { id: true, number: true, shortName: true, tone: true, icon: true }, orderBy: { number: 'asc' } })
  const byId = new Map(departments.map((department) => [department.id, department]))
  const byNumber = new Map(departments.map((department) => [department.number, department]))
  const out: RouteSummaryStep[] = []
  for (const step of steps) {
    const ofKind = departmentOfKind(step.workCentreKind)
    const department = step.departmentId !== null ? byId.get(step.departmentId) : ofKind === OUTSIDE ? undefined : byNumber.get(ofKind)
    if (!department) continue
    if (out.at(-1)?.departmentId === department.id) continue
    out.push({ departmentId: department.id, number: department.number, shortName: department.shortName, tone: department.tone, icon: department.icon })
  }
  return out
}
