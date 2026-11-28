import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { StyleRouteKind, StyleRouteView } from '@nexus/factory-domain/product/routing/contracts'
import { PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { RoutingDepartment } from '../routing/read'
import { routeStepViews, rulesOf, type PlannedRouteStep } from './plan'

/**
 * The model and customer routes of a style revision (owb-pd2 2.3; factory-db StyleRoute + StyleRouteStep of the "routes" wave,
 * owb-pd2w): the columns every read names, how a route becomes its view, who may see a route (a customer route of a customer the
 * person does not reach is not shown: the brand wall), and the writes of its steps. Every read and write of the two tables is in
 * this file.
 *
 * A route belongs to one revision and freezes with it (the wave's guard: written only while the revision is DRAFT); `copyRoutes`
 * carries a frozen revision's routes into its next draft (modules/product/bom copyRevision).
 */

type Reader = FactoryClient | CommandTx

export const ROUTE_COLUMNS = { id: true, styleId: true, revisionId: true, companyId: true, name: true, kind: true, partyId: true, seq: true, version: true } as const satisfies Prisma.StyleRouteSelect
export type RouteRow = Prisma.StyleRouteGetPayload<{ select: typeof ROUTE_COLUMNS }>
export const ROUTE_STEP_COLUMNS = { id: true, routeId: true, seq: true, departmentId: true, operationId: true, minutes: true } as const satisfies Prisma.StyleRouteStepSelect
export type RouteStepRow = Prisma.StyleRouteStepGetPayload<{ select: typeof ROUTE_STEP_COLUMNS }>

export interface RouteData extends RouteRow {
  readonly steps: readonly RouteStepRow[]
}

/** The routes of these revisions with their steps, in their order (one query per table). */
export async function readRoutes(client: Reader, where: Prisma.StyleRouteWhereInput): Promise<RouteData[]> {
  const routes = await client.styleRoute.findMany({ where, select: ROUTE_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  if (routes.length === 0) return []
  const steps = await client.styleRouteStep.findMany({ where: { routeId: { in: routes.map((route) => route.id) } }, select: ROUTE_STEP_COLUMNS, orderBy: [{ routeId: 'asc' }, { seq: 'asc' }] })
  return routes.map((route) => ({ ...route, steps: steps.filter((step) => step.routeId === route.id) }))
}

/** A route the person may see: a model for any customer, or a route of a customer the person reaches (the brand wall). */
export const routeShown = (actor: Actor | null, route: Pick<RouteRow, 'companyId' | 'partyId'>): boolean =>
  actor === null || route.partyId === null || can(actor, PRODUCT_ROUTING_VIEW, { companyId: route.companyId, partyId: route.partyId })

/** The customers these routes name: code and trade name, else legal name. */
export async function partiesOf(client: Reader, routes: readonly Pick<RouteRow, 'partyId'>[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const ids = [...new Set(routes.flatMap((route) => (route.partyId ? [route.partyId] : [])))]
  const rows = ids.length === 0 ? [] : await client.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }]))
}

export function routeViewOf(route: RouteData, departments: readonly RoutingDepartment[], parties: ReadonlyMap<string, { id: string; code: string; name: string }>): StyleRouteView {
  return {
    id: route.id,
    name: route.name,
    kind: route.kind as StyleRouteKind,
    party: route.partyId ? (parties.get(route.partyId) ?? { id: route.partyId, code: '', name: '' }) : null,
    steps: routeStepViews(route.steps, departments),
    rules: rulesOf(route.steps, departments),
    version: route.version,
  }
}

/** The views of a revision's routes the person may see (actor null: every one, as a command's answer to its writer). */
export async function routeViewsOf(client: Reader, revisionId: string, departments: readonly RoutingDepartment[], actor: Actor | null): Promise<StyleRouteView[]> {
  const routes = (await readRoutes(client, { revisionId })).filter((route) => routeShown(actor, route))
  const parties = await partiesOf(client, routes)
  return routes.map((route) => routeViewOf(route, departments, parties))
}

/** Writes a route's steps as planned (a route's whole list: the old steps are removed first by `replaceRouteSteps`). */
export async function insertRouteSteps(tools: CommandTools, route: { readonly id: string; readonly revisionId: string }, steps: readonly PlannedRouteStep[]): Promise<string[]> {
  if (steps.length === 0) return []
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const rows = steps.map((step) => ({ id: newId(), revisionId: route.revisionId, routeId: route.id, seq: step.seq, departmentId: step.departmentId, operationId: step.operationId!, minutes: step.minutes, createdAt: now, updatedAt: now, createdById }))
  await tx.styleRouteStep.createMany({ data: rows })
  return rows.map((row) => row.id)
}

/** A route's steps replaced whole (a route has no depth of its own: its steps are its list). */
export async function replaceRouteSteps(tools: CommandTools, route: { readonly id: string; readonly revisionId: string }, steps: readonly PlannedRouteStep[]): Promise<string[]> {
  await tools.tx.styleRouteStep.deleteMany({ where: { routeId: route.id } })
  return insertRouteSteps(tools, route, steps)
}

/**
 * A frozen revision's routes carried into its next draft (modules/product/bom copyRevision): each route and its steps under new ids,
 * the same names, kinds, customers and minutes. A step whose department was closed since keeps it (a route keeps its departments:
 * closing changes no product, S4 settle 8). Answers how many routes were copied.
 */
export async function copyRoutes(tools: CommandTools, from: { readonly revisionId: string }, to: { readonly styleId: string; readonly revisionId: string; readonly companyId: string | null }): Promise<number> {
  const routes = await readRoutes(tools.tx, { revisionId: from.revisionId })
  if (routes.length === 0) return 0
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  for (const route of routes) {
    const id = newId()
    await tx.styleRoute.create({
      data: { id, styleId: to.styleId, revisionId: to.revisionId, companyId: route.companyId, name: route.name, kind: route.kind, partyId: route.partyId, seq: route.seq, createdAt: now, updatedAt: now, createdById },
      select: { id: true },
    })
    if (route.steps.length > 0) {
      await tx.styleRouteStep.createMany({
        data: route.steps.map((step) => ({ id: newId(), revisionId: to.revisionId, routeId: id, seq: step.seq, departmentId: step.departmentId, operationId: step.operationId, minutes: step.minutes, createdAt: now, updatedAt: now, createdById })),
      })
    }
  }
  return routes.length
}
