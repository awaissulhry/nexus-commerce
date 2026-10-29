import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LocalisedNames } from '@nexus/factory-domain/product/materials/rules'
import type { OperationRow, OperationView } from '@nexus/factory-domain/product/routing/contracts'
import { sameMinutes, type OperationFields } from '@nexus/factory-domain/product/routing/operations'
import { PRODUCT_OPERATIONS_MANAGE, PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { decimalOf, decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { contextOf, mayWrite } from '../materials/store'

/**
 * The operation library's rows (factory-db `Operation`) and where each is used (`RoutingOperation`, `StyleRevision`,
 * `Style`): the columns every read names (no relation selects: inside a transaction Prisma would send them at once on
 * its one connection), how a row becomes the contracts' views, and who may see and write which operation.
 *
 * Where an operation is used is counted over the styles the reader may see (their routing.view scope), so the counts and
 * the "where used" list of the record agree.
 */

export { contextOf }

export const OPERATION_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }
const STYLE_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

export const OPERATION_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  workCentreKind: true,
  machineType: true,
  skill: true,
  standardMinutes: true,
  instructions: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.OperationSelect
export type OperationRowData = Prisma.OperationGetPayload<{ select: typeof OPERATION_COLUMNS }>

const text = (value: { toString(): string }): string => decimalText(value.toString())

export function fieldsOf(row: OperationRowData): OperationFields {
  return {
    code: row.code,
    name: row.name,
    nameI18n: (row.nameI18n as LocalisedNames | null) ?? null,
    workCentreKind: row.workCentreKind,
    machineType: row.machineType,
    skill: row.skill,
    standardMinutes: text(row.standardMinutes),
    instructions: row.instructions,
  }
}

// ---- who may see and write ----------------------------------------------------------------------------------------------

export function assertMayWrite(context: RequestContext, companyId: string | null): void {
  if (!mayWrite(actorOf(context), PRODUCT_OPERATIONS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'An operation for every company is changed only by a role over every company.' : undefined)
  }
}

/** The operation as the caller may see it; another company's (outside the caller's grants) or another tenant's is not found. */
export async function readOperation(caller: CommandCaller, operationId: string): Promise<OperationRowData> {
  const context = contextOf(caller)
  if (!isUuid(operationId)) throw new NotFoundError('Operation not found.')
  const row = await caller.withClient((client) => client.operation.findUnique({ where: { id: operationId }, select: OPERATION_COLUMNS }))
  if (!row || !can(actorOf(context), PRODUCT_ROUTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Operation not found.')
  return row
}

// ---- where used ---------------------------------------------------------------------------------------------------------

/** The routing steps (of styles the reader may see) made from these operations, each with its revision's status. */
export interface UseRecord {
  readonly operationId: string
  readonly stepId: string
  readonly seq: number
  readonly standardMinutes: string
  readonly styleId: string
  readonly revisionId: string
  readonly revision: number
  readonly status: 'DRAFT' | 'RELEASED' | 'OBSOLETE'
}

/** The styles the reader may see their routing of, as a `where` on the step's revision. */
const visibleSteps = (context: RequestContext): Prisma.RoutingOperationWhereInput => ({
  revision: { style: scopeWhere(actorOf(context), PRODUCT_ROUTING_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput },
})

export async function readUses(client: FactoryClient | CommandTx, context: RequestContext, operationIds: readonly string[]): Promise<UseRecord[]> {
  if (operationIds.length === 0) return []
  const steps = await client.routingOperation.findMany({
    where: { AND: [{ operationId: { in: [...operationIds] } }, visibleSteps(context)] },
    select: { id: true, operationId: true, seq: true, standardMinutes: true, styleId: true, revisionId: true },
    orderBy: [{ styleId: 'asc' }, { revisionId: 'asc' }, { seq: 'asc' }],
  })
  const revisionIds = [...new Set(steps.map((step) => step.revisionId))]
  const revisions = revisionIds.length === 0 ? [] : await client.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true, status: true } })
  const revisionOf = new Map(revisions.map((row) => [row.id, row]))
  return steps.flatMap((step) => {
    const revision = revisionOf.get(step.revisionId)
    return revision
      ? [{ operationId: step.operationId, stepId: step.id, seq: step.seq, standardMinutes: text(step.standardMinutes), styleId: step.styleId, revisionId: step.revisionId, revision: revision.revision, status: revision.status }]
      : []
  })
}

/** Per operation: the revisions using it, and the draft or released ones where a step has other minutes than the library. */
export function usageOf(uses: readonly UseRecord[], libraryMinutes: ReadonlyMap<string, string>): Map<string, { usedIn: number; differing: number }> {
  const usedIn = new Map<string, Set<string>>()
  const differing = new Map<string, Set<string>>()
  for (const use of uses) {
    usedIn.set(use.operationId, (usedIn.get(use.operationId) ?? new Set()).add(use.revisionId))
    const library = libraryMinutes.get(use.operationId)
    if (library !== undefined && use.status !== 'OBSOLETE' && !sameMinutes(use.standardMinutes, library)) {
      differing.set(use.operationId, (differing.get(use.operationId) ?? new Set()).add(use.revisionId))
    }
  }
  const out = new Map<string, { usedIn: number; differing: number }>()
  for (const id of libraryMinutes.keys()) out.set(id, { usedIn: usedIn.get(id)?.size ?? 0, differing: differing.get(id)?.size ?? 0 })
  return out
}

/**
 * The operations (of the caller's view) whose minutes some draft or released routing differs from: the steps' distinct
 * minutes per operation, compared with the library's here (Prisma cannot compare columns of two tables).
 */
export async function differingOperationIds(client: FactoryClient, context: RequestContext): Promise<string[]> {
  const steps = await client.routingOperation.findMany({
    where: { AND: [{ revision: { status: { in: ['DRAFT', 'RELEASED'] } } }, visibleSteps(context)] },
    select: { operationId: true, standardMinutes: true },
    distinct: ['operationId', 'standardMinutes'],
  })
  const ids = [...new Set(steps.map((step) => step.operationId))]
  const library = ids.length === 0 ? [] : await client.operation.findMany({ where: { id: { in: ids } }, select: { id: true, standardMinutes: true } })
  const minutesOf = new Map(library.map((row) => [row.id, row.standardMinutes.toString()]))
  return [...new Set(steps.filter((step) => minutesOf.has(step.operationId) && !decimalOf(step.standardMinutes.toString()).eq(minutesOf.get(step.operationId)!)).map((step) => step.operationId))]
}

/** Steps of styles the reader may see that name the operation at all. */
export const visibleUseFilter = (context: RequestContext): Prisma.OperationWhereInput => ({ routing: { some: visibleSteps(context) } })

// ---- views --------------------------------------------------------------------------------------------------------------

export function operationRowView(row: OperationRowData, usage: { usedIn: number; differing: number }): OperationRow {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    nameI18n: (row.nameI18n as LocalisedNames | null) ?? null,
    workCentreKind: row.workCentreKind,
    machineType: row.machineType,
    skill: row.skill,
    standardMinutes: text(row.standardMinutes),
    status: row.status,
    usedIn: usage.usedIn,
    differing: usage.differing,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The operation record: its definition and minutes, and where it is used (styles in code order, revisions newest first). */
export async function operationViewOf(client: FactoryClient | CommandTx, context: RequestContext, row: OperationRowData): Promise<OperationView> {
  const uses = await readUses(client, context, [row.id])
  const library = text(row.standardMinutes)
  const usage = usageOf(uses, new Map([[row.id, library]])).get(row.id)!
  const styleIds = [...new Set(uses.map((use) => use.styleId))]
  const styles = styleIds.length === 0 ? [] : await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })
  const styleOf = new Map(styles.map((style) => [style.id, style]))
  const whereUsed = uses
    .filter((use) => styleOf.has(use.styleId))
    .sort((a, b) => {
      const byCode = styleOf.get(a.styleId)!.code.localeCompare(styleOf.get(b.styleId)!.code)
      return byCode !== 0 ? byCode : b.revision - a.revision || a.seq - b.seq
    })
    .map((use) => ({
      style: { ...styleOf.get(use.styleId)! },
      revision: { id: use.revisionId, revision: use.revision, status: use.status },
      stepId: use.stepId,
      seq: use.seq,
      standardMinutes: use.standardMinutes,
      difference: decimalText(decimalOf(use.standardMinutes).minus(library)),
    }))
  return {
    ...operationRowView(row, usage),
    instructions: row.instructions,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
    whereUsed,
  }
}

/** The operation as the command left it (its answer). */
export async function operationViewInTx(tx: CommandTx, context: RequestContext, operationId: string): Promise<OperationView> {
  const row = await tx.operation.findUniqueOrThrow({ where: { id: operationId }, select: OPERATION_COLUMNS })
  return operationViewOf(tx, context, row)
}

/** Clearing the JSON names: factory-db exports Prisma's types, not its runtime DbNull. */
export async function clearNames(tx: CommandTx, operationId: string): Promise<void> {
  await tx.$executeRaw`UPDATE "Operation" SET "nameI18n" = NULL WHERE "id" = ${operationId}::uuid`
}

export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
