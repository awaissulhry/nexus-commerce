import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { OrderRow, RequestRow } from '@nexus/factory-domain/product/changes/contracts'
import { PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import { approvalCount, type ChangeDecision, type ChangeRefusal } from '@nexus/factory-domain/product/changes/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'

/**
 * Change requests and change orders' rows (B-W2b-226; factory-db changes.prisma, B-W2b-212): who may see which, the columns
 * every read names, how rows become the contracts' views, and the refusal every command throws in words. A request or
 * order belongs to a company (`companyId`, never null: a tenant-wide style's is numbered in a company), checked with can().
 */

export type Reader = FactoryClient | CommandTx

/** A change refused in words: 409 `conflict` with the issue `refusal/<CODE>`. */
export class ChangeRefusedError extends ConflictError {
  override name = 'ChangeRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: ChangeRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: ChangeRefusal | null): void => {
  if (refusal) throw new ChangeRefusedError(refusal)
}

/**
 * The last net (the lead: "a database refusal never reaches a person as a 500"): a change-control guard's own refusal
 * (…_changes_samples_w2b_guards: check_violation 'changes: …') or one of its unique keys (one live change order per proposed
 * revision, one work-in-progress line per work order), when a write reached it past this module's checks (a race): a 409
 * in the database's words. Anything else is thrown as it is.
 */
export function databaseRefusal(error: unknown): never {
  const cause = (error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)
  const original = cause?.meta?.driverAdapterError?.cause
  if (original?.originalCode === '23514' && typeof original.originalMessage === 'string' && original.originalMessage.startsWith('changes: ')) {
    const words = original.originalMessage.slice('changes: '.length)
    throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  if (cause?.code === 'P2002' || original?.originalCode === '23505') throw new ConflictError('Someone changed this change order at the same time: load it again.')
  throw error
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export const may = (context: OfficeContext, permission: Permission, companyId: string): boolean => can(actorOf(context), permission, { companyId })

export function assertMay(context: OfficeContext, permission: Permission, companyId: string): void {
  if (!may(context, permission, companyId)) throw new ForbiddenError()
}

/** Whether a person (their live office roles, two-factor taken as proved) holds the permission over the company. */
export async function personMay(client: Reader, tenantId: string, userId: string, permission: Permission, companyId: string, now: Date): Promise<boolean> {
  const actor: Actor = { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, userId, now), true) }
  return can(actor, permission, { companyId })
}

// ---- change requests ----------------------------------------------------------------------------------------------------

export const REQUEST_COLUMNS = {
  id: true,
  number: true,
  companyId: true,
  siteId: true,
  source: true,
  partyId: true,
  sampleRoundId: true,
  styleId: true,
  revisionId: true,
  workOrderId: true,
  title: true,
  reason: true,
  priority: true,
  status: true,
  decidedAt: true,
  decidedById: true,
  decisionNote: true,
  changeOrderId: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.ChangeRequestSelect
export type RequestData = Prisma.ChangeRequestGetPayload<{ select: typeof REQUEST_COLUMNS }>

const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))
const ids = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))]

/** The rows as the contracts show them, their references read in one pass. */
export async function requestRowsOf(db: Reader, rows: readonly RequestData[]): Promise<RequestRow[]> {
  if (rows.length === 0) return []
  const [styles, revisions, workOrders, parties, rounds, orders, photos] = await Promise.all([
    db.style.findMany({ where: { id: { in: ids(rows.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } }),
    db.styleRevision.findMany({ where: { id: { in: ids(rows.map((row) => row.revisionId)) } }, select: { id: true, revision: true, status: true } }),
    db.workOrder.findMany({ where: { id: { in: ids(rows.map((row) => row.workOrderId)) } }, select: { id: true, number: true, status: true } }),
    db.party.findMany({ where: { id: { in: ids(rows.map((row) => row.partyId)) } }, select: { id: true, code: true, legalName: true } }),
    db.sampleRound.findMany({ where: { id: { in: ids(rows.map((row) => row.sampleRoundId)) } }, select: { id: true, number: true } }),
    db.changeOrder.findMany({ where: { id: { in: ids(rows.map((row) => row.changeOrderId)) } }, select: { id: true, number: true, status: true } }),
    db.storedFile.groupBy({ by: ['recordId'], where: { recordType: 'ChangeRequest', recordId: { in: rows.map((row) => row.id) }, kind: 'PHOTO', status: 'AVAILABLE' }, _count: { _all: true } }),
  ])
  const style = byId(styles)
  const revision = byId(revisions)
  const workOrder = byId(workOrders)
  const partyOf = byId(parties)
  const round = byId(rounds)
  const order = byId(orders)
  const photoCount = new Map(photos.map((row) => [row.recordId, row._count._all]))
  return rows.map((row) => {
    const styleRow = style.get(row.styleId)
    const revisionRow = row.revisionId ? revision.get(row.revisionId) : undefined
    const workOrderRow = row.workOrderId ? workOrder.get(row.workOrderId) : undefined
    const partyRow = row.partyId ? partyOf.get(row.partyId) : undefined
    const roundRow = row.sampleRoundId ? round.get(row.sampleRoundId) : undefined
    const orderRow = row.changeOrderId ? order.get(row.changeOrderId) : undefined
    return {
      id: row.id,
      number: row.number,
      companyId: row.companyId,
      siteId: row.siteId,
      source: row.source,
      party: partyRow ? { id: partyRow.id, code: partyRow.code, name: partyRow.legalName } : null,
      sampleRound: roundRow ? { id: roundRow.id, number: roundRow.number } : null,
      style: { id: row.styleId, code: styleRow?.code ?? '', name: styleRow?.name ?? '' },
      revision: revisionRow ? { id: revisionRow.id, revision: revisionRow.revision, status: revisionRow.status } : null,
      workOrder: workOrderRow ? { id: workOrderRow.id, number: workOrderRow.number, status: workOrderRow.status } : null,
      title: row.title,
      reason: row.reason,
      priority: row.priority,
      status: row.status,
      changeOrder: orderRow ? { id: orderRow.id, number: orderRow.number, status: orderRow.status } : null,
      createdById: row.createdById,
      createdAt: toUtcIso(row.createdAt),
      decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
      decidedById: row.decidedById,
      decisionNote: row.decisionNote,
      photos: photoCount.get(row.id) ?? 0,
      version: row.version,
    }
  })
}

/** The request the caller may see with the permission (else 404 / 403). */
export async function readRequestFor(caller: CommandCaller, changeRequestId: string, permission: Permission = PRODUCT_CHANGES_VIEW): Promise<{ context: OfficeContext; row: RequestData }> {
  const context = officeOf(caller)
  const row = isUuid(changeRequestId) ? await caller.withClient((client) => client.changeRequest.findUnique({ where: { id: changeRequestId }, select: REQUEST_COLUMNS })) : null
  if (!row || !may(context, PRODUCT_CHANGES_VIEW, row.companyId)) throw new NotFoundError('Change request not found.')
  assertMay(context, permission, row.companyId)
  return { context, row }
}

// ---- change orders ------------------------------------------------------------------------------------------------------

export const ORDER_COLUMNS = {
  id: true,
  number: true,
  companyId: true,
  styleId: true,
  fromRevisionId: true,
  toRevisionId: true,
  title: true,
  reason: true,
  description: true,
  priority: true,
  effect: true,
  effectiveDate: true,
  status: true,
  authorId: true,
  submittedAt: true,
  decidedAt: true,
  releasedAt: true,
  releasedById: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.ChangeOrderSelect
export type OrderData = Prisma.ChangeOrderGetPayload<{ select: typeof ORDER_COLUMNS }>

/** A Prisma date column (@db.Date) as the business day it holds. */
export const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

export async function orderRowsOf(db: Reader, rows: readonly OrderData[]): Promise<OrderRow[]> {
  if (rows.length === 0) return []
  const [styles, revisions, approvals, requests] = await Promise.all([
    db.style.findMany({ where: { id: { in: ids(rows.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } }),
    db.styleRevision.findMany({ where: { id: { in: ids(rows.flatMap((row) => [row.fromRevisionId, row.toRevisionId])) } }, select: { id: true, revision: true, status: true } }),
    db.changeApproval.findMany({ where: { changeOrderId: { in: rows.map((row) => row.id) } }, select: { changeOrderId: true, approverId: true, required: true, decision: true } }),
    db.changeRequest.groupBy({ by: ['changeOrderId'], where: { changeOrderId: { in: rows.map((row) => row.id) } }, _count: { _all: true } }),
  ])
  const style = byId(styles)
  const revision = byId(revisions)
  const requestCount = new Map(requests.map((row) => [row.changeOrderId, row._count._all]))
  const revisionRef = (revisionId: string) => {
    const found = revision.get(revisionId)
    return { id: revisionId, revision: found?.revision ?? 0, status: found?.status ?? 'DRAFT' }
  }
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    companyId: row.companyId,
    style: { id: row.styleId, code: style.get(row.styleId)?.code ?? '', name: style.get(row.styleId)?.name ?? '' },
    fromRevision: revisionRef(row.fromRevisionId),
    toRevision: row.toRevisionId ? revisionRef(row.toRevisionId) : null,
    title: row.title,
    // B-W2b-244: the list's Reason column.
    reason: row.reason,
    priority: row.priority,
    effect: row.effect,
    effectiveDate: dayOf(row.effectiveDate),
    status: row.status,
    authorId: row.authorId,
    approvals: approvalCount(approvals.filter((approval) => approval.changeOrderId === row.id).map((approval) => ({ ...approval, decision: approval.decision as ChangeDecision | null }))),
    requests: requestCount.get(row.id) ?? 0,
    createdAt: toUtcIso(row.createdAt),
    submittedAt: row.submittedAt ? toUtcIso(row.submittedAt) : null,
    decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
    releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
    version: row.version,
  }))
}

/** The change order the caller may see with the permission (else 404 / 403). */
export async function readOrderFor(caller: CommandCaller, changeOrderId: string, permission: Permission = PRODUCT_CHANGES_VIEW): Promise<{ context: OfficeContext; row: OrderData }> {
  const context = officeOf(caller)
  const row = isUuid(changeOrderId) ? await caller.withClient((client) => client.changeOrder.findUnique({ where: { id: changeOrderId }, select: ORDER_COLUMNS })) : null
  if (!row || !may(context, PRODUCT_CHANGES_VIEW, row.companyId)) throw new NotFoundError('Change order not found.')
  assertMay(context, permission, row.companyId)
  return { context, row }
}

/** Locks the change order row (FOR UPDATE) inside a command: its moves, lines and approvals take turns. */
export async function lockOrder(tx: CommandTx, changeOrderId: string): Promise<OrderData> {
  await tx.$queryRaw`SELECT 1 FROM "ChangeOrder" WHERE "id" = ${changeOrderId}::uuid FOR UPDATE`
  const row = await tx.changeOrder.findUnique({ where: { id: changeOrderId }, select: ORDER_COLUMNS })
  if (!row) throw new NotFoundError('Change order not found.')
  return row
}

// ---- what of a work order is made (MES-006) ------------------------------------------------------------------------------

export interface Made {
  readonly cut: { readonly bundles: number; readonly pieces: number }
  readonly worked: { readonly bundles: number; readonly pieces: number }
}

/** Per work order: its live bundles (cut) and those reported at an operation and not undone (worked). */
export async function madeOf(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, Made>> {
  const made = new Map<string, Made>()
  if (workOrderIds.length === 0) return made
  const bundles = await db.bundle.findMany({ where: { workOrderId: { in: [...workOrderIds] }, status: 'ACTIVE' }, select: { id: true, workOrderId: true, quantity: true } })
  const reports = await db.operationScan.findMany({ where: { workOrderId: { in: [...workOrderIds] }, kind: { in: ['REPORT', 'UNDO'] } }, select: { id: true, bundleId: true, kind: true, correctsId: true } })
  const undone = new Set(reports.filter((scan) => scan.kind === 'UNDO' && scan.correctsId !== null).map((scan) => scan.correctsId!))
  const worked = new Set(reports.filter((scan) => scan.kind === 'REPORT' && !undone.has(scan.id)).map((scan) => scan.bundleId))
  for (const workOrderId of workOrderIds) {
    const own = bundles.filter((bundle) => bundle.workOrderId === workOrderId)
    const done = own.filter((bundle) => worked.has(bundle.id))
    made.set(workOrderId, {
      cut: { bundles: own.length, pieces: own.reduce((sum, bundle) => sum + bundle.quantity, 0) },
      worked: { bundles: done.length, pieces: done.reduce((sum, bundle) => sum + bundle.quantity, 0) },
    })
  }
  return made
}

export const NOTHING_MADE: Made = Object.freeze({ cut: { bundles: 0, pieces: 0 }, worked: { bundles: 0, pieces: 0 } })
