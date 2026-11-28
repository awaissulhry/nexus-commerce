import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { RouteTemplateBody, RouteTemplateView, UpdateRouteTemplateBody } from '@nexus/factory-domain/product/routing/contracts'
import { PRODUCT_ROUTING_MANAGE, PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { mayWrite } from '../materials/store'
import { readDepartments, type RoutingDepartment } from '../routing/read'
import { planRouteSteps, routeStepViews, type PlannedRouteStep } from '../routes/plan'

/**
 * The factory's ready-made routes (owb-pd2 2.3; design § 5w "Start from a copy", "Save as ready-made…"; S4 settle 8; factory-db
 * RouteTemplate + RouteTemplateStep of the "routes" wave): a name and its departments in order, with minutes or none. Any product's
 * route builder may start from one; a copy is independent of its source, so closing one changes no product. Closed = gone from
 * "Start from a copy", kept, never deleted, and may always close (S4 settle 8: the design's "one in use cannot close" protects
 * nothing here — the S4 lead tells the Owner at the walk).
 *
 *   GET  /product/route-templates?status=OPEN|CLOSED|ALL          product.routing.view   → { templates }
 *   POST /product/route-templates { name, steps }                  product.routing.manage → 201 { template }
 *   PATCH /product/route-templates/:templateId { version, name?, steps? }                → { template }
 *   POST /product/route-templates/:templateId/close | /open { version }                  → { template }
 *
 * A ready-made route is the whole factory's (no company): kept by a grant over every company. Its name is unique among the OPEN
 * ones, letter case aside (NAME_TAKEN 409 "A ready-made route with this name is open already."). Steps: the route rules
 * (../routes/plan; 400 `refusal/<code>`). Audit per act.
 */

const TEMPLATE_COLUMNS = { id: true, companyId: true, name: true, status: true, version: true } as const satisfies Prisma.RouteTemplateSelect
type TemplateRow = Prisma.RouteTemplateGetPayload<{ select: typeof TEMPLATE_COLUMNS }>
const TEMPLATE_STEP_COLUMNS = { id: true, templateId: true, seq: true, departmentId: true, minutes: true } as const satisfies Prisma.RouteTemplateStepSelect
const SCOPE = { company: { field: 'companyId', nullable: true } } as const

export const TEMPLATE_WORDS = Object.freeze({
  NAME_TAKEN: { en: 'A ready-made route with this name is open already.', it: 'Un percorso pronto con questo nome è già aperto.' },
})

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new UnauthenticatedError()
  return caller.factoryContext
}

function assertMayKeep(context: RequestContext, companyId: string | null): void {
  if (!mayWrite(actorOf(context), PRODUCT_ROUTING_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? 'A ready-made route of the whole factory is kept only by a role over every company.' : undefined)
}

const nameTaken = (): DomainError => new DomainError('conflict', TEMPLATE_WORDS.NAME_TAKEN.en, [{ path: 'refusal/NAME_TAKEN', message: TEMPLATE_WORDS.NAME_TAKEN.en }])

async function viewsOf(client: FactoryClient | CommandTx, rows: readonly TemplateRow[], departments: readonly RoutingDepartment[]): Promise<RouteTemplateView[]> {
  const steps = rows.length === 0 ? [] : await client.routeTemplateStep.findMany({ where: { templateId: { in: rows.map((row) => row.id) } }, select: TEMPLATE_STEP_COLUMNS, orderBy: [{ templateId: 'asc' }, { seq: 'asc' }] })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    steps: routeStepViews(steps.filter((step) => step.templateId === row.id), departments),
    status: row.status as RouteTemplateView['status'],
    version: row.version,
  }))
}

async function oneView(tx: CommandTx, templateId: string): Promise<RouteTemplateView> {
  const row = await tx.routeTemplate.findUniqueOrThrow({ where: { id: templateId }, select: TEMPLATE_COLUMNS })
  return (await viewsOf(tx, [row], await readDepartments(tx)))[0]!
}

/** The ready-made routes the person reaches, by name. */
export async function listTemplates(caller: CommandCaller, status: 'OPEN' | 'CLOSED' | 'ALL'): Promise<RouteTemplateView[]> {
  const actor = actorOf(contextOf(caller))
  return caller.withClient(async (client) => {
    const rows = await client.routeTemplate.findMany({
      where: { AND: [scopeWhere(actor, PRODUCT_ROUTING_VIEW, SCOPE) as Prisma.RouteTemplateWhereInput, status === 'ALL' ? {} : { status }] },
      select: TEMPLATE_COLUMNS,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })
    return viewsOf(client, rows, await readDepartments(client))
  })
}

/** Is the name used by another OPEN ready-made route (letter case aside)? Under the tenant's ready-made-route lock. */
async function openNameTaken(tx: CommandTx, name: string, exceptId?: string): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.route-template', current_setting('factory.tenant_id', true)), 0))`
  const found = await tx.routeTemplate.findFirst({ where: { status: 'OPEN', name: { equals: name.trim(), mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } })
  return found !== null
}

async function writeSteps(tools: CommandTools, templateId: string, steps: readonly PlannedRouteStep[], replace: boolean): Promise<void> {
  const { tx, now } = tools
  if (replace) await tx.routeTemplateStep.deleteMany({ where: { templateId } })
  if (steps.length === 0) return
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.routeTemplateStep.createMany({ data: steps.map((step) => ({ id: newId(), templateId, seq: step.seq, departmentId: step.departmentId, minutes: step.minutes, createdAt: now, updatedAt: now, createdById })) })
}

const auditedSteps = (steps: readonly PlannedRouteStep[]) => steps.map((step) => ({ seq: step.seq, departmentId: step.departmentId, minutes: step.minutes }))

/** product.routing.createTemplate: "Save as ready-made…". */
export async function createTemplate(caller: CommandCaller, body: RouteTemplateBody, idempotencyKey?: string): Promise<RouteTemplateView> {
  const context = contextOf(caller)
  assertMayKeep(context, null)
  const { result } = await command(caller, { name: 'product.routing.createTemplate', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (await openNameTaken(tx, body.name)) throw nameTaken()
    const plan = await planRouteSteps(tx, { steps: body.steps, companyId: null, withOperation: false })
    const id = newId()
    await tx.routeTemplate.create({ data: { id, name: body.name.trim(), createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
    await writeSteps(tools, id, plan.steps, false)
    tools.audit({ recordType: 'RouteTemplate', recordId: id, companyId: null, after: { name: body.name.trim(), status: 'OPEN', steps: auditedSteps(plan.steps) } })
    return oneView(tx, id)
  }).catch(uniqueName)
  return result
}

/** The ready-made route as the person may keep it, inside the command, at the version read (409 otherwise). */
async function templateAt(caller: CommandCaller, tx: CommandTx, templateId: string, version: number): Promise<TemplateRow> {
  const row = isUuid(templateId) ? await tx.routeTemplate.findUnique({ where: { id: templateId }, select: TEMPLATE_COLUMNS }) : null
  if (!row || !can(actorOf(contextOf(caller)), PRODUCT_ROUTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Ready-made route not found.')
  assertMayKeep(contextOf(caller), row.companyId)
  const { count } = await tx.routeTemplate.updateMany({ where: { id: templateId, version }, data: { version: version + 1 } })
  if (count !== 1) throw new StaleVersionError('RouteTemplate', templateId, row.version, version)
  return row
}

const uniqueName = (error: unknown): never => {
  if ((error as { code?: unknown } | null)?.code === 'P2002') throw nameTaken()
  throw error
}

/** product.routing.updateTemplate: its name or its steps, under its version. */
export async function updateTemplate(caller: CommandCaller, templateId: string, body: UpdateRouteTemplateBody, idempotencyKey?: string): Promise<RouteTemplateView> {
  const { result } = await command(caller, { name: 'product.routing.updateTemplate', idempotencyKey, input: { templateId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await templateAt(caller, tx, templateId, body.version)
    if (body.name !== undefined && row.status === 'OPEN' && (await openNameTaken(tx, body.name, templateId))) throw nameTaken()
    const before = await tx.routeTemplateStep.findMany({ where: { templateId }, select: TEMPLATE_STEP_COLUMNS, orderBy: { seq: 'asc' } })
    const plan = body.steps === undefined ? null : await planRouteSteps(tx, { steps: body.steps, companyId: row.companyId, before: before.map((step) => step.departmentId), withOperation: false })
    if (body.name !== undefined) await tx.routeTemplate.update({ where: { id: templateId }, data: { name: body.name.trim(), updatedAt: now }, select: { id: true } })
    if (plan) await writeSteps(tools, templateId, plan.steps, true)
    tools.audit({
      recordType: 'RouteTemplate',
      recordId: templateId,
      companyId: row.companyId,
      before: { ...(body.name !== undefined ? { name: row.name } : {}), ...(plan ? { steps: before.map((step) => ({ seq: step.seq, departmentId: step.departmentId, minutes: step.minutes === null ? null : step.minutes.toString() })) } : {}) },
      after: { ...(body.name !== undefined ? { name: body.name.trim() } : {}), ...(plan ? { steps: auditedSteps(plan.steps) } : {}) },
    })
    return oneView(tx, templateId)
  }).catch(uniqueName)
  return result
}

/** product.routing.closeTemplate / openTemplate: out of "Start from a copy" (kept) and back (its name free among the open ones). */
export async function moveTemplate(caller: CommandCaller, templateId: string, to: 'OPEN' | 'CLOSED', version: number, idempotencyKey?: string): Promise<RouteTemplateView> {
  // Already so: nothing changes (no command, no version bump).
  const seen = isUuid(templateId) ? await caller.withClient((client) => client.routeTemplate.findUnique({ where: { id: templateId }, select: TEMPLATE_COLUMNS })) : null
  if (!seen || !can(actorOf(contextOf(caller)), PRODUCT_ROUTING_VIEW, { companyId: seen.companyId })) throw new NotFoundError('Ready-made route not found.')
  assertMayKeep(contextOf(caller), seen.companyId)
  if (seen.status === to) return caller.withClient(async (client) => (await viewsOf(client, [seen], await readDepartments(client)))[0]!)
  const { result } = await command(caller, { name: to === 'CLOSED' ? 'product.routing.closeTemplate' : 'product.routing.openTemplate', idempotencyKey, input: { templateId, version } }, async (tools) => {
    const { tx, now } = tools
    const row = await templateAt(caller, tx, templateId, version)
    if (to === 'OPEN' && (await openNameTaken(tx, row.name, templateId))) throw nameTaken()
    await tx.routeTemplate.update({ where: { id: templateId }, data: { status: to, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'RouteTemplate', recordId: templateId, companyId: row.companyId, before: { status: row.status }, after: { status: to } })
    return oneView(tx, templateId)
  }).catch(uniqueName)
  return result
}
