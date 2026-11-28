import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { RouteSourceView } from '@nexus/factory-domain/product/routing/contracts'
import { PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { readDepartments } from '../routing/read'
import { contextOf, departmentOfStep } from '../routing/store'
import { STYLE_SCOPE } from '../styles/store'
import { routeStepViews } from './plan'
import { readRoutes, routeShown } from './store'

/**
 * GET /product/route-sources?q= (owb-pd2 2.3; design § 5w "Start from a copy": any route of any product): at most 50 products the
 * person reaches with product.routing.view (company and brand: another customer's private-label product is never listed), by code,
 * each with its product route (its RELEASED revision's routing, else its newest draft's: departments and minutes) and that
 * revision's model and customer routes — a customer route of a customer out of the person's reach is left out.
 */

export const SOURCES_SHOWN = 50

export async function routeSources(caller: CommandCaller, q: string | undefined): Promise<RouteSourceView[]> {
  const actor = actorOf(contextOf(caller))
  const search = q?.trim()
  return caller.withClient(async (client) => {
    const styles = await client.style.findMany({
      where: {
        AND: [
          scopeWhere(actor, PRODUCT_ROUTING_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput,
          { status: { in: ['DRAFT', 'ACTIVE'] } },
          search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } : {},
        ],
      },
      select: { id: true, code: true, name: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: SOURCES_SHOWN,
    })
    if (styles.length === 0) return []
    const revisions = await client.styleRevision.findMany({ where: { styleId: { in: styles.map((style) => style.id) }, status: { in: ['RELEASED', 'DRAFT'] } }, select: { id: true, styleId: true, revision: true, status: true }, orderBy: { revision: 'desc' } })
    const current = new Map<string, { id: string; revision: number }>()
    for (const style of styles) {
      const own = revisions.filter((revision) => revision.styleId === style.id)
      const pick = own.find((revision) => revision.status === 'RELEASED') ?? own[0]
      if (pick) current.set(style.id, { id: pick.id, revision: pick.revision })
    }
    const revisionIds = [...current.values()].map((revision) => revision.id)
    const steps = revisionIds.length === 0 ? [] : await client.routingOperation.findMany({ where: { revisionId: { in: revisionIds } }, select: { id: true, revisionId: true, seq: true, departmentId: true, workCentreKind: true, standardMinutes: true }, orderBy: [{ revisionId: 'asc' }, { seq: 'asc' }] })
    const routes = revisionIds.length === 0 ? [] : (await readRoutes(client, { revisionId: { in: revisionIds } })).filter((route) => routeShown(actor, route))
    const departments = await readDepartments(client)
    return styles.flatMap((style): RouteSourceView[] => {
      const revision = current.get(style.id)
      if (!revision) return []
      const product = steps
        .filter((step) => step.revisionId === revision.id)
        .flatMap((step) => {
          const department = departmentOfStep(step, departments)
          return department ? [{ id: step.id, seq: step.seq, departmentId: department.id, minutes: step.standardMinutes }] : []
        })
      return [
        {
          styleId: style.id,
          code: style.code,
          name: style.name,
          revision: revision.revision,
          product: routeStepViews(product, departments),
          routes: routes.filter((route) => route.revisionId === revision.id).map((route) => ({ id: route.id, name: route.name, kind: route.kind as 'MODEL' | 'CUSTOMER', steps: routeStepViews(route.steps, departments) })),
        },
      ]
    })
  })
}
