import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { RoutingView, StepView } from '@nexus/factory-domain/product/routing/contracts'
import { MINUTES_ROUND, routingMinutes } from '@nexus/factory-domain/product/routing/minutes'
import { sameMinutes } from '@nexus/factory-domain/product/routing/operations'
import { PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { editRefusal, finalStepOf, routingIssues, type StepData, type StepFields } from '@nexus/factory-domain/product/routing/rules'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { bumpRevision, findRevision, lockStyleRow, revisionViewOf, STYLE_COLUMNS, type BomStyleRow, type LockedStyle, type RevisionRow } from '../bom/store'
import { contextOf, mayWrite } from '../materials/store'
import { readOperations, readSteps, type OperationFacts, type StepRecord } from './read'

/**
 * The routing's rows (factory-db `RoutingOperation`) and what they name (`Style`, `StyleRevision`, `Operation`): the
 * columns every read names (no relation selects: inside a transaction Prisma would send them at once on its one
 * connection), how they become the domain's steps and the routing view, who may see and write a style's routing, and
 * the locks its writes take.
 *
 * Lock order (the BOM's, B-W1-13): the style row first (`lockStyleRow`, FOR UPDATE), then the revision row by
 * compare-and-set of its version (`lockDraft`; the …_product_guards part trigger then takes it FOR SHARE, which this
 * transaction already holds), then the library operations a step names (FOR SHARE, in id order), then the steps. A
 * revision's BOM and routing are one versioned record: a BOM write and a routing write on one revision wait for each
 * other on the style row and the second fails on the version (409), never a deadlock. A library write locks only its
 * operation row, so it never waits for a style.
 *
 * A draft's steps are removed with DELETE: the runtime role holds it on RoutingOperation (ownership/product.json), and
 * the …_product_guards trigger allows it only while the revision is DRAFT. A step's place is unique per revision, so a
 * reorder parks the moving steps at their negative place first, then sets the new one.
 */

export { contextOf }
export { OPERATION_REF_COLUMNS, readOperations, readSteps, STEP_COLUMNS, type OperationFacts, type StepRecord } from './read'

// ---- who may see and write ----------------------------------------------------------------------------------------------

/** The style as the caller may see its routing; another company's (outside the caller's grants) or another tenant's is not found. */
export async function readStyleFor(caller: CommandCaller, styleId: string): Promise<BomStyleRow> {
  const context = contextOf(caller)
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const row = await caller.withClient((client) => client.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS }))
  if (!row || !can(actorOf(context), PRODUCT_ROUTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Style not found.')
  return row
}

export async function readRevisionFor(caller: CommandCaller, styleId: string, revisionId: string): Promise<{ style: BomStyleRow; revision: RevisionRow }> {
  const style = await readStyleFor(caller, styleId)
  return { style, revision: await caller.withClient((client) => findRevision(client, styleId, revisionId)) }
}

export function assertMayWrite(context: RequestContext, permission: Permission, companyId: string | null): void {
  if (!mayWrite(actorOf(context), permission, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The routing of a style for every company is changed only by a role over every company.' : undefined)
  }
}

// ---- reads --------------------------------------------------------------------------------------------------------------

/** Everything the routing view shows, read with one client. */
export interface LoadedRouting {
  readonly style: BomStyleRow
  readonly revision: RevisionRow
  readonly steps: readonly StepRecord[]
  readonly operations: ReadonlyMap<string, OperationFacts>
  readonly sizeLabels: ReadonlyMap<string, string | null>
}

export async function loadRouting(client: FactoryClient | CommandTx, style: BomStyleRow, revision: RevisionRow): Promise<LoadedRouting> {
  const steps = await readSteps(client, revision.id)
  const operations = await readOperations(client, steps.map((step) => step.operationId))
  const sizes = await client.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, label: true } })
  return { style, revision, steps, operations, sizeLabels: new Map(sizes.map((size) => [size.code, size.label])) }
}

// ---- the view -----------------------------------------------------------------------------------------------------------

/** The routing of one revision (SCR-043): its steps, minutes, final operation and what the release check will say. */
export function routingViewOf(loaded: LoadedRouting): RoutingView {
  const { style, revision, steps, operations } = loaded
  const draft = revision.status === 'DRAFT'
  const check = draft ? routingIssues(steps, operations) : { blockers: [], warnings: [] }
  const final = finalStepOf(steps)
  const stepViews: StepView[] = steps.map((step) => {
    const operation = operations.get(step.operationId)
    if (!operation) throw new ApiError('internal_error', `Routing step operation ${step.operationId} was not read.`)
    return {
      id: step.id,
      seq: step.seq,
      operation: {
        id: operation.id,
        code: operation.code,
        name: operation.name,
        status: operation.status,
        machineType: operation.machineType,
        skill: operation.skill,
        standardMinutes: operation.standardMinutes,
      },
      code: step.code,
      name: step.name,
      nameI18n: step.nameI18n,
      workCentreKind: step.workCentreKind,
      standardMinutes: step.standardMinutes,
      differsFromLibrary: !sameMinutes(step.standardMinutes, operation.standardMinutes),
      scanRequired: step.scanRequired,
      final: final?.id === step.id,
      instructions: step.instructions,
      version: step.version,
      createdAt: toUtcIso(step.createdAt),
      updatedAt: toUtcIso(step.updatedAt),
    }
  })
  const minutes = routingMinutes(steps, style.sizes, MINUTES_ROUND)
  return {
    revision: revisionViewOf(revision),
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status },
    sizes: style.sizes.map((code) => ({ code, label: loaded.sizeLabels.get(code) ?? code })),
    steps: stepViews,
    minutes: { ...minutes, byKind: minutes.byKind.map((entry) => ({ ...entry })), bySize: minutes.bySize.map((entry) => ({ ...entry })) },
    finalStepId: final?.id ?? null,
    issues: check.blockers.map((issue) => ({ ...issue })),
    warnings: check.warnings.map((issue) => ({ ...issue })),
    editable: draft && style.status !== 'ARCHIVED',
  }
}

/** The routing as the command left it (its answer). */
export async function routingViewInTx(tx: CommandTx, styleId: string, revisionId: string): Promise<RoutingView> {
  const style = await tx.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  if (!style) throw new NotFoundError('Style not found.')
  return routingViewOf(await loadRouting(tx, style, await findRevision(tx, styleId, revisionId)))
}

// ---- locks and versions -------------------------------------------------------------------------------------------------

export interface LockedDraft {
  readonly style: LockedStyle
  readonly revisionId: string
  readonly revision: number
  /** The revision's version after this write. */
  readonly version: number
}

/**
 * The first step of every change to a draft's routing: the style row locked, the revision checked (a DRAFT of this
 * style, the style not archived: a clear 409 before the database's own refusal) and its version compared and set.
 */
export async function lockDraft(tools: CommandTools, styleId: string, revisionId: string, expectedVersion: number): Promise<LockedDraft> {
  const { tx, now } = tools
  const style = await lockStyleRow(tx, styleId)
  const row = await findRevision(tx, styleId, revisionId)
  const refusal = editRefusal(row, style.status)
  if (refusal) throw new InvalidStateError(refusal)
  const version = await bumpRevision(tx, revisionId, expectedVersion, now)
  return { style, revisionId, revision: row.revision, version }
}

/** The library operations' rows FOR SHARE, in id order: none is archived or changed under a write that copies it. */
export async function lockOperations(tx: CommandTx, operationIds: readonly string[]): Promise<void> {
  const ids = [...new Set(operationIds)].filter(isUuid).sort()
  if (ids.length === 0) return
  await tx.$queryRaw`SELECT "id" FROM "Operation" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`
}

/** An operation a step of this style may be made from: of the style's company, or of every company. */
export const fitsStyle = (operation: Pick<OperationFacts, 'companyId'>, styleCompanyId: string | null): boolean => operation.companyId === null || operation.companyId === styleCompanyId

/**
 * A draft revision's steps are named by work order operations only by mistake (a work order is released with a RELEASED
 * revision); while one does, its steps keep their places: a clear 409 before the reference's refusal.
 */
export async function assertNoWorkOrders(tx: CommandTx, revisionId: string): Promise<void> {
  const used = await tx.workOrderOperation.count({ where: { styleRevisionId: revisionId } })
  if (used > 0) throw new ConflictError(`Work orders name ${used} operation(s) of this draft's routing: its steps keep their places.`)
}

export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
export const invalid = (issues: readonly Issue[], what = 'routing step'): ValidationError => new ValidationError(`The ${what} is not valid.`, issues)
export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

// ---- writes -------------------------------------------------------------------------------------------------------------

/** A step's fields as the audit row keeps them. */
export function auditedStep(step: StepFields): Record<string, unknown> {
  return {
    seq: step.seq,
    operationId: step.operationId,
    code: step.code,
    name: step.name,
    nameI18n: step.nameI18n,
    workCentreKind: step.workCentreKind,
    standardMinutes: step.standardMinutes,
    scanRequired: step.scanRequired,
    instructions: step.instructions,
  }
}

const removed = (count: number, expected: number, what: string): void => {
  // Row-level security without a DELETE policy removes nothing and says nothing: never let that pass as done.
  if (count !== expected) throw new ApiError('internal_error', `The database removed ${count} of ${expected} ${what}.`)
}

/** Inserts new steps of a draft, as planned. */
export async function insertSteps(tools: CommandTools, target: { readonly styleId: string; readonly revisionId: string }, steps: readonly StepData[]): Promise<void> {
  if (steps.length === 0) return
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.routingOperation.createMany({
    data: steps.map((step) => ({
      id: step.id,
      styleId: target.styleId,
      revisionId: target.revisionId,
      seq: step.seq,
      operationId: step.operationId,
      code: step.code,
      name: step.name,
      nameI18n: step.nameI18n ?? undefined,
      workCentreKind: step.workCentreKind,
      standardMinutes: step.standardMinutes,
      scanRequired: step.scanRequired,
      instructions: step.instructions,
      createdAt: now,
      updatedAt: now,
      createdById,
    })),
  })
}

/** Removes steps of a draft. */
export async function deleteSteps(tools: CommandTools, stepIds: readonly string[]): Promise<void> {
  if (stepIds.length === 0) return
  removed((await tools.tx.routingOperation.deleteMany({ where: { id: { in: [...stepIds] } } })).count, stepIds.length, 'routing steps')
}

/** Moves steps to new places: each parked at its negative place first (free: places are above 0), then set. */
export async function moveSteps(tools: CommandTools, moves: readonly { readonly id: string; readonly to: number }[]): Promise<void> {
  if (moves.length === 0) return
  const { tx, now } = tools
  const { count } = await tx.routingOperation.updateMany({ where: { id: { in: moves.map((move) => move.id) } }, data: { seq: { multiply: -1 } } })
  if (count !== moves.length) throw new ApiError('internal_error', `The database parked ${count} of ${moves.length} routing steps.`)
  for (const move of moves) await tx.routingOperation.update({ where: { id: move.id }, data: { seq: move.to, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
}
