import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { cellLabel, partsOf } from '@nexus/factory-domain/production/cutting/rules'
import { PRODUCTION_SCRAP, PRODUCTION_SCRAP_APPROVE, PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import {
  askRefusal,
  type AskFacts,
  cancelRefusal,
  decisionRefusal,
  recutDoneRefusal,
  replacedFrom,
  type ReplacementKind,
  type ReplacementRefusal,
  type ReplacementStatus,
} from '@nexus/factory-domain/production/scrap/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { readPlannedParts } from '../cutting/store'
import { lockReplacement, readCellLabels, readReplacement, REPLACEMENT_COLUMNS, replacementViews, type ReplacementRow } from './store'
// B-W2b-53 (MES-128): held scrap posts no replacement.
import { scrapPostingHeld } from './over-limit'

/**
 * Replace scrapped garments (B-W2a-13; MES-130; design production.scrap "Replace scrapped quantity"): a RECUT for the
 * cutting room's list, or a REDUCE of what the order is owed that a second person approves. Office only (the floor has
 * no grant on the requests: the recut list is read here, the cut that replaces it is linked here). Each write is ONE
 * command() with an Idempotency-Key; the rules are factory-domain production/scrap/rules; a refusal is a 409 with
 * `refusal/<CODE>`; the …_production_w2a_guards ReplacementRequest trigger is the last word.
 *
 *   ask      production.scrap: the cell (from the scan's bundle, the rework, or named), the source's scrap less what it
 *            replaces already (under the work order's row lock, so two asks of one scan take turns) → the row →
 *            production.replacement_requested.
 *   approve  production.scrap.approve, a REDUCE only, never by the one who asked (four eyes; the trigger too); refuse
 *   refuse   says why → production.replacement_changed. The order line is lowered by the order's short-close (B-W2a-30),
 *            which then marks the request DONE.
 *   done     production.scrap: a RECUT with the cut log entry that cut it (of the work order, live, with pieces of the
 *            cell and of the part when one is named).
 *   cancel   production.scrap: OPEN, or an APPROVED reduction not carried out, with the reason.
 */

export class ReplacementRefusedError extends ConflictError {
  override name = 'ReplacementRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: ReplacementRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}
const refused = (refusal: ReplacementRefusal): never => {
  throw new ReplacementRefusedError(refusal)
}

function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

const may = (context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly siteId: string }) => can(actorOf(context), permission, { companyId: row.companyId, siteId: row.siteId })
const bodyIssue = (path: string, message: string) => new ValidationError(message, [{ path: `body/${path}`, message }])

// ---- ask -----------------------------------------------------------------------------------------------------------------------

export interface AskInput {
  readonly kind: ReplacementKind
  readonly quantity: number
  readonly reason: string
  readonly part?: string | null | undefined
  readonly sourceScanId?: string | undefined
  readonly reworkOrderId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly workOrderSizeId?: string | undefined
  readonly recordType?: string | undefined
  readonly recordId?: string | undefined
  readonly note?: string | undefined
}

async function workOrderOfAsk(caller: CommandCaller, body: AskInput): Promise<string> {
  if (body.sourceScanId) {
    const scan = await caller.withClient((client) => client.operationScan.findUnique({ where: { id: body.sourceScanId! }, select: { workOrderId: true } }))
    if (!scan) throw new NotFoundError('Scan not found.')
    return scan.workOrderId
  }
  if (body.reworkOrderId) {
    const rework = await caller.withClient((client) => client.reworkOrder.findUnique({ where: { id: body.reworkOrderId! }, select: { workOrderId: true } }))
    if (!rework) throw new NotFoundError('Rework not found.')
    return rework.workOrderId
  }
  if (!body.workOrderId) throw bodyIssue('workOrderId', 'Name the scan or rework that scrapped the garments, or the work order and cell.')
  return body.workOrderId
}

/** POST /production/replacements. */
export async function askReplacement(caller: CommandCaller, body: AskInput, idempotencyKey?: string) {
  const context = officeOf(caller)
  const workOrderId = await workOrderOfAsk(caller, body)
  const order = await caller.withClient((client) => client.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true } }))
  if (!order || !may(context, PRODUCTION_SCRAP, order)) throw new NotFoundError('Work order not found.')
  if (body.workOrderId && body.workOrderId !== order.id) throw bodyIssue('workOrderId', 'The scan or rework named is of another work order.')
  if ((body.recordType === undefined) !== (body.recordId === undefined)) throw bodyIssue('recordType', 'Name the record behind it as type and id, or neither.')
  const { result, replayed } = await command(caller, { name: 'production.askReplacement', idempotencyKey, input: body }, async (tools) => askInCommand(tools, order.id, body))
  return { ...result, replayed }
}

async function askInCommand(tools: CommandTools, workOrderId: string, body: AskInput) {
  const context = tools.context as OfficeContext
  const { tx } = tools
  // The work order's row: two asks of one source take turns (the scrap left to replace is read under it).
  await tx.$queryRaw`SELECT "id" FROM "WorkOrder" WHERE "id" = ${workOrderId}::uuid FOR UPDATE`
  const workOrder = (await tx.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true, number: true, status: true } }))!
  let cellId = body.workOrderSizeId ?? null
  let source: AskFacts['source'] = null
  if (body.sourceScanId) {
    const scan = (await tx.operationScan.findUnique({ where: { id: body.sourceScanId }, select: { id: true, bundleId: true, scrapQuantity: true, kind: true } }))!
    const bundle = await tx.bundle.findUnique({ where: { id: scan.bundleId }, select: { workOrderSizeId: true, code: true } })
    cellId = bundle?.workOrderSizeId ?? cellId
    const voided = (await tx.operationScan.count({ where: { correctsId: scan.id } })) > 0
    source = {
      what: `The scan of bundle ${bundle?.code ?? ''}`,
      scrapped: voided ? 0 : scan.scrapQuantity,
      replaced: replacedFrom(await tx.replacementRequest.findMany({ where: { sourceScanId: scan.id }, select: { status: true, quantity: true } })),
      // B-W2b-53 (MES-128): scrap above the site's limit is replaced only once the team leader approved it.
      heldBy: await scrapPostingHeld(tx, scan.id),
    }
  } else if (body.reworkOrderId) {
    const rework = (await tx.reworkOrder.findUnique({ where: { id: body.reworkOrderId }, select: { id: true, workOrderSizeId: true, status: true, scrapQuantity: true } }))!
    cellId = rework.workOrderSizeId
    source = { what: 'That rework', scrapped: rework.status === 'DONE' ? rework.scrapQuantity : 0, replaced: replacedFrom(await tx.replacementRequest.findMany({ where: { reworkOrderId: rework.id }, select: { status: true, quantity: true } })) }
  }
  if (!cellId) throw bodyIssue('workOrderSizeId', 'Name the cell (colourway and size) of the scrapped garments.')
  const cell = (await readCellLabels(tx, [cellId])).get(cellId)
  if (!cell || cell.workOrderId !== workOrder.id) throw bodyIssue('workOrderSizeId', 'Not a cell of this work order.')
  const part = body.part?.trim() || null
  const refusal = askRefusal({
    workOrder,
    cell: { label: cellLabel(cell.colourwayCode, cell.size), quantity: cell.quantity, parts: partsOf(await readPlannedParts(tx, workOrder.id), cell.id) },
    kind: body.kind,
    quantity: body.quantity,
    part,
    source,
  })
  if (refusal) refused(refusal)
  const id = newId()
  const data: Prisma.ReplacementRequestUncheckedCreateInput = {
    id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    workOrderId: workOrder.id,
    workOrderSizeId: cell.id,
    kind: body.kind,
    quantity: body.quantity,
    part,
    sourceScanId: body.sourceScanId ?? null,
    reworkOrderId: body.reworkOrderId ?? null,
    recordType: body.recordType ?? null,
    recordId: body.recordId ?? null,
    reason: body.reason.trim(),
    note: body.note?.trim() || null,
    createdAt: tools.now,
    updatedAt: tools.now,
    createdById: context.actorId,
  }
  await tx.replacementRequest.create({ data, select: { id: true } })
  const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
  tools.audit({ action: 'production.askReplacement', recordType: 'ReplacementRequest', recordId: id, ...scope, after: { kind: body.kind, quantity: body.quantity, part, workOrderSizeId: cell.id, sourceScanId: data.sourceScanId, reworkOrderId: data.reworkOrderId }, reason: body.reason.trim() })
  tools.audit({ action: 'production.askReplacement', recordType: 'WorkOrder', recordId: workOrder.id, ...scope, after: { replacementId: id, kind: body.kind, quantity: body.quantity } })
  tools.emit({
    type: 'production.replacement_requested',
    subject: workOrder.id,
    ...scope,
    payload: { workOrderId: workOrder.id, number: workOrder.number, replacementId: id, workOrderSizeId: cell.id, kind: body.kind, quantity: body.quantity, sourceScanId: data.sourceScanId ?? null, reworkOrderId: data.reworkOrderId ?? null },
  })
  const [view] = await replacementViews(tx, [(await readReplacement(tx, id))!])
  return { replacement: view! }
}

// ---- decide, done, cancel -------------------------------------------------------------------------------------------------------

type Change = 'approve' | 'refuse' | 'done' | 'cancel'

export interface ChangeInput {
  readonly version: number
  readonly note?: string | undefined
  /** done: the cut log entry that cut the recut. */
  readonly cutLogId?: string | undefined
  /** cancel: why. */
  readonly reason?: string | undefined
}

const PERMISSION: Record<Change, Permission> = { approve: PRODUCTION_SCRAP_APPROVE, refuse: PRODUCTION_SCRAP_APPROVE, done: PRODUCTION_SCRAP, cancel: PRODUCTION_SCRAP }

/** POST /production/replacements/:replacementId/approve|refuse|done|cancel. */
export async function changeReplacement(caller: CommandCaller, replacementId: string, change: Change, body: ChangeInput, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await caller.withClient((client) => readReplacement(client, replacementId))
  if (!known || !may(context, PERMISSION[change], known)) throw new NotFoundError('Replacement not found.')
  if (change === 'refuse' && !body.note?.trim()) throw bodyIssue('note', 'Say why the reduction is refused.')
  if (change === 'cancel' && !body.reason?.trim()) throw bodyIssue('reason', 'Say why the request is cancelled.')
  if (change === 'done' && !body.cutLogId) throw bodyIssue('cutLogId', 'Name the cut log entry that cut the recut.')
  const { result, replayed } = await command(caller, { name: `production.${change}Replacement`, idempotencyKey, input: { replacementId, change, ...body } }, async (tools) => {
    const { tx } = tools
    const row = await lockReplacement(tx, replacementId)
    if (!row) throw new NotFoundError('Replacement not found.')
    if (row.version !== body.version) throw new ConflictError(`This request changed since you read it (version ${row.version}, not ${body.version}): read it again.`)
    const refusal = refusalOf(change, row, context, await doneFacts(tools, row, body))
    if (refusal) refused(refusal)
    const status: ReplacementStatus = change === 'approve' ? 'APPROVED' : change === 'refuse' ? 'REFUSED' : change === 'done' ? 'DONE' : 'CANCELLED'
    const data: Prisma.ReplacementRequestUncheckedUpdateInput = {
      status,
      version: { increment: 1 },
      updatedAt: tools.now,
      ...(change === 'approve' || change === 'refuse' ? { decidedAt: tools.now, decidedById: context.actorId, decisionNote: body.note?.trim() || null } : {}),
      ...(change === 'done' ? { doneAt: tools.now, cutLogId: body.cutLogId! } : {}),
      ...(change === 'cancel' ? { cancelledAt: tools.now, cancelReason: body.reason!.trim() } : {}),
      ...(change !== 'approve' && change !== 'refuse' && body.note?.trim() ? { note: body.note.trim() } : {}),
    }
    await tx.replacementRequest.update({ where: { id: row.id }, data, select: { id: true } })
    const workOrder = (await tx.workOrder.findUnique({ where: { id: row.workOrderId }, select: { number: true } }))!
    const scope = { companyId: row.companyId, siteId: row.siteId }
    tools.audit({
      action: `production.${change}Replacement`,
      recordType: 'ReplacementRequest',
      recordId: row.id,
      ...scope,
      before: { status: row.status },
      after: { status, ...(change === 'done' ? { cutLogId: body.cutLogId } : {}) },
      ...(change === 'cancel' ? { reason: body.reason!.trim() } : body.note?.trim() ? { reason: body.note.trim() } : {}),
    })
    tools.emit({
      type: 'production.replacement_changed',
      subject: row.workOrderId,
      ...scope,
      payload: { workOrderId: row.workOrderId, number: workOrder.number, replacementId: row.id, kind: row.kind, status, cutLogId: change === 'done' ? body.cutLogId! : null },
    })
    const [view] = await replacementViews(tx, [(await readReplacement(tx, row.id))!])
    return { replacement: view! }
  })
  return { ...result, replayed }
}

/** For a recut's done: the entry (of the work order; live; its pieces) and the cell's label. */
async function doneFacts(tools: CommandTools, row: ReplacementRow, body: ChangeInput) {
  if (!body.cutLogId) return null
  const { tx } = tools
  const entry = await tx.cutLog.findUnique({ where: { id: body.cutLogId }, select: { id: true, workOrderId: true, reversalOfId: true } })
  const reversed = entry ? (await tx.cutLog.count({ where: { reversalOfId: entry.id } })) > 0 : false
  const pieces = entry ? await tx.cutLogPiece.findMany({ where: { cutLogId: entry.id }, select: { workOrderSizeId: true, part: true, pieces: true } }) : []
  const cell = (await readCellLabels(tx, [row.workOrderSizeId])).get(row.workOrderSizeId)
  return {
    entry: entry && entry.workOrderId === row.workOrderId ? { live: entry.reversalOfId === null && !reversed, pieces: pieces.map((piece) => ({ cellId: piece.workOrderSizeId, part: piece.part, pieces: piece.pieces })) } : null,
    cellLabel: cell ? cellLabel(cell.colourwayCode, cell.size) : 'this cell',
  }
}

function refusalOf(change: Change, row: ReplacementRow, context: OfficeContext, done: Awaited<ReturnType<typeof doneFacts>>): ReplacementRefusal | null {
  if (change === 'approve' || change === 'refuse') return decisionRefusal({ kind: row.kind, status: row.status, createdById: row.createdById, deciderId: context.actorId })
  if (change === 'cancel') return cancelRefusal(row.status)
  return recutDoneRefusal({ kind: row.kind, status: row.status, part: row.part, cellLabel: done?.cellLabel ?? 'this cell', entry: done?.entry ?? null, cellId: row.workOrderSizeId })
}

// ---- reads ----------------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly kind?: ReplacementKind | undefined
  readonly status?: readonly ReplacementStatus[] | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const SCOPE = { company: 'companyId', site: 'siteId' } as const

/** GET /production/replacements: newest first (the recut list: kind=RECUT&status=OPEN). */
export async function listReplacements(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const where: Prisma.ReplacementRequestWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PRODUCTION_SCRAP_VIEW, SCOPE) as Prisma.ReplacementRequestWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.kind ? { kind: query.kind } : {},
      query.status && query.status.length > 0 ? { status: { in: [...query.status] } } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.replacementRequest.findMany({ where, select: REPLACEMENT_COLUMNS, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    return { replacements: await replacementViews(client, page), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

/** GET /production/replacements/:replacementId. */
export async function replacementRecord(caller: CommandCaller, replacementId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const row = await readReplacement(client, replacementId)
    if (!row || !may(context, PRODUCTION_SCRAP_VIEW, row)) throw new NotFoundError('Replacement not found.')
    const [view] = await replacementViews(client, [row])
    return { replacement: view! }
  })
}
