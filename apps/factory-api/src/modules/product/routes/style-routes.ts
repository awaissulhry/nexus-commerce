import { ConflictError, DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { StyleRouteBody, StyleRouteView, UpdateStyleRouteBody } from '@nexus/factory-domain/product/routing/contracts'
import { PRODUCT_ROUTING_MANAGE, PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { editRefusal } from '@nexus/factory-domain/product/routing/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { findRevision, lockStyleRow, type BomStyleRow, type LockedStyle } from '../bom/store'
import { requireEditRule } from '../lifecycle/edit-rule'
import { readDepartments } from '../routing/read'
import { assertMayWrite, contextOf, readRevisionFor } from '../routing/store'
import { planRouteSteps } from './plan'
import { insertRouteSteps, partiesOf, readRoutes, replaceRouteSteps, routeViewOf, routeViewsOf, ROUTE_COLUMNS } from './store'

/**
 * The model and customer routes of a style revision (owb-pd2 2.3; design § 5u, § 5w "New route…": a name, "A model: for any
 * customer" / "Only for ⟨customer⟩"; S4 settle 5): read with product.routing.view, made, changed whole and taken out with
 * product.routing.manage (the production manager), only while the revision is DRAFT (a released revision's routes are frozen with
 * it; the wave's guard holds it too).
 *
 *   GET    …/revisions/:revisionId/routes                 → { routes }   (a customer route of a customer out of reach: not listed)
 *   POST   …/routes { name, kind, partyId, steps }         → 201 { route }
 *   PUT    …/routes/:routeId { version, name, kind, partyId, steps } → { route }
 *   DELETE …/routes/:routeId?version=                      → { routes }  (what stays)
 *
 *   kind      CUSTOMER names its customer (required); MODEL may be "only for" one customer (partyId) or for any (null)
 *   customer  a party with the CUSTOMER or BRAND role, not blocked or archived, of the style's company or every company, that the
 *             person reaches (the brand wall); a product made for one customer (Style.brandPartyId) takes routes for that customer
 *             only
 *   steps     factory-domain routeProblems (./plan): 400 `refusal/<code>` on an error; each step works with its department's default
 *             operation
 *   in use    a route an order line picked is not taken out (409 in words)
 *
 * Audit: a row on the StyleRoute and one on the revision (the product's history line, no money); `style.routing_changed`.
 */

/** The style row locked and the revision checked: a DRAFT of this style, the style not archived (409 in words otherwise). */
async function lockDraftRevision(tx: CommandTx, styleId: string, revisionId: string): Promise<{ style: LockedStyle; revision: number }> {
  const style = await lockStyleRow(tx, styleId)
  const revision = await findRevision(tx, styleId, revisionId)
  const refusal = editRefusal(revision, style.status)
  if (refusal) throw new InvalidStateError(refusal.replace('its routing is frozen', 'its routes are frozen'))
  await requireEditRule(tx, styleId, 'DRAFT')
  return { style, revision: revision.revision }
}

/** The customer of a route (see the header), or a 400 in words. */
async function customerProblem(caller: CommandCaller, tx: CommandTx, style: Pick<BomStyleRow, 'companyId' | 'brandPartyId'>, kind: StyleRouteBody['kind'], partyId: string | null): Promise<string | null> {
  if (partyId === null) return kind === 'CUSTOMER' ? 'A customer route names its customer.' : null
  const party = await tx.party.findUnique({ where: { id: partyId }, select: { roles: true, status: true, companyId: true } })
  if (!party || !can(actorOf(contextOf(caller)), PRODUCT_ROUTING_VIEW, { companyId: party.companyId, partyId })) return 'No such customer.'
  if (!party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) return 'This party is not a customer.'
  if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') return `This customer is ${party.status.toLowerCase()}.`
  if (party.companyId !== null && style.companyId !== null && party.companyId !== style.companyId) return "This customer belongs to another company than the product's."
  if (style.brandPartyId !== null && style.brandPartyId !== partyId) return 'This product is made for another customer: its routes are for that customer only.'
  return null
}

/** The revision's history line (no money) and the routing's event, for a route change. */
function record(tools: CommandTools, style: LockedStyle, revisionId: string, revision: number, stepIds: readonly string[], change: Record<string, unknown>): void {
  tools.audit({ recordType: 'StyleRevision', recordId: revisionId, companyId: style.companyId, after: { routes: change } })
  tools.emit({ type: 'style.routing_changed', subject: style.id, companyId: style.companyId, payload: { styleId: style.id, code: style.code, revisionId, revision, stepIds: [...stepIds] } })
}

/** A revision's routes have different names (the wave's unique key): 409 in words. */
const ROUTE_NAME_TAKEN = { en: 'Another route of this revision has this name.', it: 'Un altro percorso di questa revisione ha questo nome.' }
const nameTaken = (error: unknown): never => {
  if ((error as { code?: unknown } | null)?.code === 'P2002') throw new DomainError('conflict', ROUTE_NAME_TAKEN.en, [{ path: 'refusal/NAME_TAKEN', message: ROUTE_NAME_TAKEN.en }])
  throw error
}

async function routeAnswer(tx: CommandTx, routeId: string): Promise<StyleRouteView> {
  const [route] = await readRoutes(tx, { id: routeId })
  if (!route) throw new NotFoundError('Route not found.')
  return routeViewOf(route, await readDepartments(tx), await partiesOf(tx, [route]))
}

/** The routes of the revision the person may see. */
export async function listStyleRoutes(caller: CommandCaller, styleId: string, revisionId: string): Promise<StyleRouteView[]> {
  const context = contextOf(caller)
  await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient(async (client) => routeViewsOf(client, revisionId, await readDepartments(client), actorOf(context)))
}

/** product.routing.createRoute: a model or customer route on the DRAFT revision. */
export async function createStyleRoute(caller: CommandCaller, styleId: string, revisionId: string, body: StyleRouteBody, idempotencyKey?: string): Promise<StyleRouteView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.routing.createRoute', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const draft = await lockDraftRevision(tx, styleId, revisionId)
    const problem = await customerProblem(caller, tx, style, body.kind, body.partyId)
    if (problem) throw new ValidationError(problem, [{ path: 'body/partyId', message: problem }])
    const plan = await planRouteSteps(tx, { steps: body.steps, companyId: style.companyId, withOperation: true })
    const last = await tx.styleRoute.findFirst({ where: { revisionId }, select: { seq: true }, orderBy: { seq: 'desc' } })
    const id = newId()
    await tx.styleRoute.create({
      data: { id, styleId, revisionId, companyId: style.companyId, name: body.name, kind: body.kind, partyId: body.partyId, seq: (last?.seq ?? 0) + 1, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: { id: true },
    })
    const stepIds = await insertRouteSteps(tools, { id, revisionId }, plan.steps)
    tools.audit({ recordType: 'StyleRoute', recordId: id, companyId: style.companyId, after: { styleId, revisionId, name: body.name, kind: body.kind, partyId: body.partyId, steps: plan.steps.map((step) => ({ seq: step.seq, departmentId: step.departmentId, minutes: step.minutes })) } })
    record(tools, draft.style, revisionId, draft.revision, stepIds, { added: id, name: body.name, kind: body.kind })
    return routeAnswer(tx, id)
  }).catch(nameTaken)
  return result
}

/** The route of this revision, inside the command, at the version the person read (409 otherwise). */
async function routeAt(tx: CommandTx, revisionId: string, routeId: string, version: number) {
  const route = isUuid(routeId) ? await tx.styleRoute.findUnique({ where: { id: routeId }, select: ROUTE_COLUMNS }) : null
  if (!route || route.revisionId !== revisionId) throw new NotFoundError('Route not found.')
  const { count } = await tx.styleRoute.updateMany({ where: { id: routeId, version }, data: { version: version + 1 } })
  if (count !== 1) throw new StaleVersionError('StyleRoute', routeId, route.version, version)
  return route
}

/** product.routing.updateRoute: the whole route — its name, kind, customer and steps — under its version. */
export async function updateStyleRoute(caller: CommandCaller, styleId: string, revisionId: string, routeId: string, body: UpdateStyleRouteBody, idempotencyKey?: string): Promise<StyleRouteView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)
  const { version, ...change } = body

  const { result } = await command(caller, { name: 'product.routing.updateRoute', idempotencyKey, input: { styleId, revisionId, routeId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const draft = await lockDraftRevision(tx, styleId, revisionId)
    const [before] = await readRoutes(tx, { id: routeId })
    const route = await routeAt(tx, revisionId, routeId, version)
    const problem = await customerProblem(caller, tx, style, change.kind, change.partyId)
    if (problem) throw new ValidationError(problem, [{ path: 'body/partyId', message: problem }])
    const plan = await planRouteSteps(tx, { steps: change.steps, companyId: style.companyId, before: (before?.steps ?? []).map((step) => step.departmentId), withOperation: true })
    await tx.styleRoute.update({ where: { id: routeId }, data: { name: change.name, kind: change.kind, partyId: change.partyId, updatedAt: now }, select: { id: true } })
    const stepIds = await replaceRouteSteps(tools, { id: routeId, revisionId }, plan.steps)
    tools.audit({
      recordType: 'StyleRoute',
      recordId: routeId,
      companyId: style.companyId,
      before: { name: route.name, kind: route.kind, partyId: route.partyId, steps: (before?.steps ?? []).map((step) => ({ seq: step.seq, departmentId: step.departmentId, minutes: step.minutes === null ? null : step.minutes.toString() })) },
      after: { name: change.name, kind: change.kind, partyId: change.partyId, steps: plan.steps.map((step) => ({ seq: step.seq, departmentId: step.departmentId, minutes: step.minutes })) },
    })
    record(tools, draft.style, revisionId, draft.revision, stepIds, { changed: routeId, name: change.name })
    return routeAnswer(tx, routeId)
  }).catch(nameTaken)
  return result
}

/** product.routing.deleteRoute: the route taken out of the DRAFT revision (refused while an order line picked it). */
export async function deleteStyleRoute(caller: CommandCaller, styleId: string, revisionId: string, routeId: string, version: number, idempotencyKey?: string): Promise<StyleRouteView[]> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.routing.deleteRoute', idempotencyKey, input: { styleId, revisionId, routeId, version } }, async (tools) => {
    const { tx } = tools
    const draft = await lockDraftRevision(tx, styleId, revisionId)
    const route = await routeAt(tx, revisionId, routeId, version)
    const picked = await tx.salesOrderLineRoute.count({ where: { styleRouteId: routeId } })
    if (picked > 0) throw new ConflictError(`${picked} order line(s) use this route: it stays while they do.`)
    const steps = await tx.styleRouteStep.deleteMany({ where: { routeId } })
    const removed = await tx.styleRoute.deleteMany({ where: { id: routeId } })
    if (removed.count !== 1) throw new ConflictError('The route could not be taken out: load the routes again.')
    tools.audit({ recordType: 'StyleRoute', recordId: routeId, companyId: style.companyId, before: { name: route.name, kind: route.kind, partyId: route.partyId, steps: steps.count }, after: { removed: true } })
    record(tools, draft.style, revisionId, draft.revision, [], { removed: routeId, name: route.name })
    return routeViewsOf(tx, revisionId, await readDepartments(tx), actorOf(context))
  })
  return result
}
