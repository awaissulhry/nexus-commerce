import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { OperationMinutesView, TimeVersionView } from '@nexus/factory-domain/product/minutes/contracts'
import { PRODUCT_SMV_APPROVE, PRODUCT_SMV_PROPOSE } from '@nexus/factory-domain/product/minutes/permissions'
import { inForceOn, isGoverned, pendingOf, settlementOn, stepRunSourceOf, waitingToTakeEffect, type StoredMinutes, type TimeVersionStatus, type VersionFacts } from '@nexus/factory-domain/product/minutes/rules'
import { PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { PEOPLE_PIECERATES_VIEW } from '@nexus/factory-domain/people/piecerates/permissions'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { contextOf, mayWrite } from '../materials/store'

/**
 * The rows of SMV governance (factory-db `OperationTimeVersion`, and the minutes columns of `Operation` and
 * `RoutingOperation`, B-W2b-205) and how they become the contracts' views: the columns every read names (no relation
 * selects: inside a transaction Prisma would send them at once on its one connection), who may see and write which
 * operation's minutes, the operation's lock, and the settling of an approved version whose day came (its approval, the
 * hourly job ./take-effect).
 *
 * Lock order: the operation row FOR UPDATE first (a proposal, a decision and the job wait for each other on it; a W1 edit
 * of the operation takes its version), then its versions. A routing step's minutes lock the style and revision first
 * (../routing/store lockDraft), then read the operation's versions without a lock (an approved version stays approved
 * inside the database's own check of the step).
 */

export { contextOf }

const OPERATION_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

export const MINUTES_OPERATION_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  workCentreKind: true,
  status: true,
  standardMinutes: true,
  basicMinutes: true,
  personalPct: true,
  fatiguePct: true,
  delayPct: true,
  version: true,
} as const satisfies Prisma.OperationSelect
export type MinutesOperationRow = Prisma.OperationGetPayload<{ select: typeof MINUTES_OPERATION_COLUMNS }>

export const VERSION_COLUMNS = {
  id: true,
  operationId: true,
  number: true,
  status: true,
  basicMinutes: true,
  personalPct: true,
  fatiguePct: true,
  delayPct: true,
  standardMinutes: true,
  source: true,
  effectiveFrom: true,
  reason: true,
  proposedById: true,
  decidedById: true,
  decidedAt: true,
  decisionNote: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.OperationTimeVersionSelect
export type VersionRow = Prisma.OperationTimeVersionGetPayload<{ select: typeof VERSION_COLUMNS }>

/** A version as the rules read it, with its row. */
export interface VersionRecord extends VersionFacts {
  readonly row: VersionRow
}

const text = (value: { toString(): string }): string => decimalText(value.toString())
const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : text(value))
/** A stored calendar day (a DATE column) as YYYY-MM-DD. */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
/** A calendar day as a DATE column takes it. */
export const dateOf = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
/** Today in the business time zone. */
export const todayOf = (now: Date): BusinessDate => businessDate(now)

export const storedMinutesOf = (row: { standardMinutes: { toString(): string }; basicMinutes: { toString(): string } | null; personalPct: { toString(): string } | null; fatiguePct: { toString(): string } | null; delayPct: { toString(): string } | null }): StoredMinutes => ({
  standardMinutes: text(row.standardMinutes),
  basicMinutes: textOrNull(row.basicMinutes),
  personalPct: textOrNull(row.personalPct),
  fatiguePct: textOrNull(row.fatiguePct),
  delayPct: textOrNull(row.delayPct),
})

export function versionOf(row: VersionRow): VersionRecord {
  return {
    id: row.id,
    number: row.number,
    status: row.status as TimeVersionStatus,
    basicMinutes: text(row.basicMinutes),
    personalPct: text(row.personalPct),
    fatiguePct: text(row.fatiguePct),
    delayPct: text(row.delayPct),
    standardMinutes: text(row.standardMinutes),
    effectiveFrom: dayOf(row.effectiveFrom),
    proposedById: row.proposedById,
    decided: row.decidedAt !== null,
    row,
  }
}

// ---- who may see and write ----------------------------------------------------------------------------------------------

/** The operation as the caller may see its minutes; another company's (outside the caller's grants) or another tenant's is not found. */
export async function readOperationFor(caller: CommandCaller, operationId: string): Promise<MinutesOperationRow> {
  const context = contextOf(caller)
  if (!isUuid(operationId)) throw new NotFoundError('Operation not found.')
  const row = await caller.withClient((client) => client.operation.findUnique({ where: { id: operationId }, select: MINUTES_OPERATION_COLUMNS }))
  if (!row || !can(actorOf(context), PRODUCT_ROUTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Operation not found.')
  return row
}

/** The operations whose minutes the caller may see, as a `where`. */
export const visibleOperations = (context: RequestContext): Prisma.OperationWhereInput => scopeWhere(actorOf(context), PRODUCT_ROUTING_VIEW, OPERATION_SCOPE) as Prisma.OperationWhereInput

export const mayPropose = (context: RequestContext, companyId: string | null): boolean => context.audience === 'office' && mayWrite(actorOf(context), PRODUCT_SMV_PROPOSE, companyId)
export const mayDecide = (context: RequestContext, companyId: string | null): boolean => context.audience === 'office' && mayWrite(actorOf(context), PRODUCT_SMV_APPROVE, companyId)

/** The office person acting (the proposer, the decider). */
export const actorIdOf = (context: RequestContext): string | null => (context.audience === 'office' ? context.actorId : null)

// ---- reads --------------------------------------------------------------------------------------------------------------

/** One operation's versions, newest first. */
export async function readVersions(client: FactoryClient | CommandTx, operationId: string): Promise<VersionRecord[]> {
  const rows = await client.operationTimeVersion.findMany({ where: { operationId }, select: VERSION_COLUMNS, orderBy: { number: 'desc' } })
  return rows.map(versionOf)
}

/** Several operations' versions, by operation, newest first. */
export async function readVersionsOf(client: FactoryClient | CommandTx, operationIds: readonly string[]): Promise<Map<string, VersionRecord[]>> {
  const ids = [...new Set(operationIds)].filter(isUuid)
  const rows = ids.length === 0 ? [] : await client.operationTimeVersion.findMany({ where: { operationId: { in: ids } }, select: VERSION_COLUMNS, orderBy: [{ operationId: 'asc' }, { number: 'desc' }] })
  const out = new Map<string, VersionRecord[]>()
  for (const row of rows) out.set(row.operationId, [...(out.get(row.operationId) ?? []), versionOf(row)])
  return out
}

/** Office people's names by id (a proposer or decider no longer readable shows as its id). */
export async function userNames(client: FactoryClient | CommandTx, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((value): value is string => value !== null && isUuid(value)))]
  const rows = wanted.length === 0 ? [] : await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

const personOf = (names: ReadonlyMap<string, string>, id: string) => ({ id, name: names.get(id) ?? id })

export function timeVersionViewOf(version: VersionRecord, names: ReadonlyMap<string, string>, inForceId: string | null, waitingIds: ReadonlySet<string>): TimeVersionView {
  const { row } = version
  return {
    id: row.id,
    number: row.number,
    status: version.status,
    basicMinutes: version.basicMinutes,
    personalPct: version.personalPct,
    fatiguePct: version.fatiguePct,
    delayPct: version.delayPct,
    standardMinutes: version.standardMinutes,
    source: row.source,
    effectiveFrom: version.effectiveFrom,
    reason: row.reason,
    proposedBy: personOf(names, row.proposedById),
    proposedAt: toUtcIso(row.createdAt),
    decidedBy: row.decidedById === null ? null : personOf(names, row.decidedById),
    decidedAt: row.decidedAt === null ? null : toUtcIso(row.decidedAt),
    decisionNote: row.decisionNote,
    inForce: row.id === inForceId,
    waiting: waitingIds.has(row.id),
    version: row.version,
  }
}

/** The versions' views with who proposed and decided them. */
export async function versionViews(client: FactoryClient | CommandTx, versions: readonly VersionRecord[], today: BusinessDate): Promise<TimeVersionView[]> {
  const names = await userNames(
    client,
    versions.flatMap((version) => [version.row.proposedById, version.row.decidedById]),
  )
  const inForce = inForceOn(versions, today)
  const waiting = new Set(waitingToTakeEffect(versions, today).map((version) => version.id))
  return versions.map((version) => timeVersionViewOf(version, names, inForce?.id ?? null, waiting))
}

/** The SMV that applies on a day: the approved version in force, else the operation's own numbers. */
export function smvOnDay(operation: StoredMinutes, versions: readonly VersionRecord[], day: BusinessDate): { standardMinutes: string; version: VersionRecord | null } {
  const version = inForceOn(versions, day)
  return { standardMinutes: version?.standardMinutes ?? operation.standardMinutes, version }
}

const STYLE_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

/** "Routings and piece rates affected": the draft and released steps made from it, and the piece rates naming it. */
async function impactOf(client: FactoryClient | CommandTx, context: RequestContext, operationId: string, versions: readonly VersionRecord[]): Promise<OperationMinutesView['impact']> {
  const steps = await client.routingOperation.findMany({
    where: { operationId, revision: { status: { in: ['DRAFT', 'RELEASED'] }, style: scopeWhere(actorOf(context), PRODUCT_ROUTING_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput } },
    select: { id: true, seq: true, styleId: true, revisionId: true, standardMinutes: true, basicMinutes: true, timeVersionId: true },
    orderBy: [{ styleId: 'asc' }, { revisionId: 'asc' }, { seq: 'asc' }],
    take: 500,
  })
  const styleIds = [...new Set(steps.map((step) => step.styleId))]
  const revisionIds = [...new Set(steps.map((step) => step.revisionId))]
  const styles = styleIds.length === 0 ? [] : await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })
  const revisions = revisionIds.length === 0 ? [] : await client.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true, status: true } })
  const styleOf = new Map(styles.map((style) => [style.id, style]))
  const revisionOf = new Map(revisions.map((revision) => [revision.id, revision]))
  const numberOf = new Map(versions.map((version) => [version.id, version.number]))
  const routings = steps.flatMap((step) => {
    const style = styleOf.get(step.styleId)
    const revision = revisionOf.get(step.revisionId)
    if (!style || !revision) return []
    return [
      {
        style,
        revision,
        stepId: step.id,
        seq: step.seq,
        standardMinutes: text(step.standardMinutes),
        runFrom: stepRunSourceOf({ basicMinutes: textOrNull(step.basicMinutes), timeVersionId: step.timeVersionId }),
        timeVersionNumber: step.timeVersionId === null ? null : (numberOf.get(step.timeVersionId) ?? null),
      },
    ]
  })
  routings.sort((a, b) => a.style.code.localeCompare(b.style.code) || b.revision.revision - a.revision.revision || a.seq - b.seq)

  const entries = await client.pieceRateEntry.findMany({
    where: { operationId, rateVersion: { status: { in: ['DRAFT', 'PROVISIONAL', 'PUBLISHED'] } } },
    select: { versionId: true, sizeBand: true, standardMinutes: true },
    take: 500,
  })
  const pieceVersionIds = [...new Set(entries.map((entry) => entry.versionId))]
  const pieceVersions =
    pieceVersionIds.length === 0 ? [] : await client.pieceRateVersion.findMany({ where: { id: { in: pieceVersionIds } }, select: { id: true, tableId: true, companyId: true, siteId: true, versionNo: true, status: true, effectiveFrom: true } })
  const tableIds = [...new Set(pieceVersions.map((version) => version.tableId))]
  const tables = tableIds.length === 0 ? [] : await client.pieceRateTable.findMany({ where: { id: { in: tableIds } }, select: { id: true, code: true, name: true } })
  const tableOf = new Map(tables.map((table) => [table.id, table]))
  const pieceVersionOf = new Map(pieceVersions.map((version) => [version.id, version]))
  const actor = actorOf(context)
  const seen = pieceVersions.every((version) => can(actor, PEOPLE_PIECERATES_VIEW, { companyId: version.companyId, siteId: version.siteId }))
  const rows = entries.flatMap((entry) => {
    const version = pieceVersionOf.get(entry.versionId)
    const table = version ? tableOf.get(version.tableId) : undefined
    if (!version || !table) return []
    return [{ table, versionId: version.id, versionNo: version.versionNo, status: version.status, effectiveFrom: dayOf(version.effectiveFrom), sizeBand: entry.sizeBand, standardMinutes: textOrNull(entry.standardMinutes) }]
  })
  rows.sort((a, b) => a.table.code.localeCompare(b.table.code) || b.versionNo - a.versionNo || a.sizeBand.localeCompare(b.sizeBand))
  return { routings, pieceRates: { count: pieceVersionIds.length, rows: seen ? rows : null } }
}

/** The operation's Minutes tab (GET …/minutes and every write's answer). */
export async function operationMinutesViewOf(client: FactoryClient | CommandTx, context: RequestContext, row: MinutesOperationRow, today: BusinessDate): Promise<OperationMinutesView> {
  const versions = await readVersions(client, row.id)
  const current = storedMinutesOf(row)
  const { standardMinutes, version } = smvOnDay(current, versions, today)
  return {
    operation: { id: row.id, code: row.code, name: row.name, companyId: row.companyId, workCentreKind: row.workCentreKind, status: row.status, version: row.version },
    current,
    governed: isGoverned(versions),
    today,
    inForce: { standardMinutes, versionId: version?.id ?? null, number: version?.number ?? null, effectiveFrom: version?.effectiveFrom ?? null },
    pendingId: pendingOf(versions)?.id ?? null,
    versions: await versionViews(client, versions, today),
    impact: await impactOf(client, context, row.id, versions),
    may: { propose: mayPropose(context, row.companyId), decide: mayDecide(context, row.companyId) },
  }
}

/** The view as the command left it. */
export async function operationMinutesInTx(tx: CommandTx, context: RequestContext, operationId: string, today: BusinessDate): Promise<OperationMinutesView> {
  const row = await tx.operation.findUniqueOrThrow({ where: { id: operationId }, select: MINUTES_OPERATION_COLUMNS })
  return operationMinutesViewOf(tx, context, row, today)
}

// ---- locks and settling ---------------------------------------------------------------------------------------------------

/** The operation row FOR UPDATE: proposals, decisions and the job on one operation wait for each other. */
export async function lockOperation(tx: CommandTx, operationId: string): Promise<MinutesOperationRow> {
  await tx.$queryRaw`SELECT "id" FROM "Operation" WHERE "id" = ${operationId}::uuid FOR UPDATE`
  const row = await tx.operation.findUnique({ where: { id: operationId }, select: MINUTES_OPERATION_COLUMNS })
  if (!row) throw new NotFoundError('Operation not found.')
  return row
}

export interface Settled {
  /** The version whose numbers the operation took now, or null (nothing came into force). */
  readonly tookEffect: string | null
  readonly superseded: readonly string[]
}

/**
 * Settles the operation's approved versions today (inside a command, the operation locked): the APPROVED ones before the
 * one in force and those shadowed on their day become SUPERSEDED (decision kept), then the operation takes the numbers of
 * the one in force (its version moves: an open edit of it sees a newer one). Audited on the operation and each version.
 */
export async function settleOperation(tools: CommandTools, operation: MinutesOperationRow, by: 'APPROVAL' | 'SCHEDULE'): Promise<Settled> {
  const { tx, now } = tools
  const today = todayOf(now)
  const versions = await readVersions(tx, operation.id)
  const { inForce, supersede } = settlementOn(versions, today)
  for (const version of supersede) {
    await tx.operationTimeVersion.update({ where: { id: version.id }, data: { status: 'SUPERSEDED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'product.smv.supersede', recordType: 'OperationTimeVersion', recordId: version.id, companyId: operation.companyId, before: { status: 'APPROVED' }, after: { status: 'SUPERSEDED', by: inForce?.number ?? null } })
    tools.emit({
      type: 'smv_version.changed',
      subject: version.id,
      companyId: operation.companyId,
      payload: { operationId: operation.id, code: operation.code, versionId: version.id, number: version.number, status: 'SUPERSEDED', change: 'SUPERSEDED', standardMinutes: version.standardMinutes, effectiveFrom: version.effectiveFrom },
    })
  }
  const current = storedMinutesOf(operation)
  if (inForce === null) return { tookEffect: null, superseded: supersede.map((version) => version.id) }
  const numbers = { standardMinutes: inForce.standardMinutes, basicMinutes: inForce.basicMinutes, personalPct: inForce.personalPct, fatiguePct: inForce.fatiguePct, delayPct: inForce.delayPct }
  const changed = (Object.keys(numbers) as (keyof typeof numbers)[]).some((field) => current[field] === null || decimalText(current[field]!) !== decimalText(numbers[field]))
  if (!changed) return { tookEffect: null, superseded: supersede.map((version) => version.id) }
  await tx.operation.update({ where: { id: operation.id }, data: { ...numbers, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'product.smv.takeEffect', recordType: 'Operation', recordId: operation.id, companyId: operation.companyId, before: { ...current }, after: { ...numbers, timeVersionId: inForce.id, number: inForce.number, by } })
  tools.emit({
    type: 'operation.smv_changed',
    subject: operation.id,
    companyId: operation.companyId,
    payload: { operationId: operation.id, code: operation.code, versionId: inForce.id, number: inForce.number, from: current.standardMinutes, standardMinutes: inForce.standardMinutes, by },
  })
  return { tookEffect: inForce.id, superseded: supersede.map((version) => version.id) }
}
