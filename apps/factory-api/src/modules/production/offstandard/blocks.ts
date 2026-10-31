import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_OFFSTANDARD_APPROVE, PRODUCTION_OFFSTANDARD_VIEW } from '@nexus/factory-domain/production/offstandard/permissions'
import {
  BLOCK_STATUSES,
  CODE_INACTIVE,
  correctRefusal,
  dayClosedRefusal,
  decisionRefusal,
  editOf,
  endRefusal,
  isNormal,
  overlapRefusal,
  overlaps,
  reopenRefusal,
  timesProblems,
  unusualOf,
  type BlockStatus,
  type OffStandardRefusal,
  type UnusualReason,
} from '@nexus/factory-domain/production/offstandard/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { hasAcknowledgedNotice, scanSubjectFor } from '../settings/subject'
import { officeOf, refuse } from './access'
import type { CorrectBody, ListBlocksQuery, RecordBlockBody } from './contract'
import { blocksAround, BLOCK, closedDays, lockBlock, performanceGateOpen, dayKey, editedBlocks, editsOf, linesById, peopleNames, readBlock, readBlocks, readCode, sitesById, stationsById, workerOf, workerUsers, type BlockRow, type CodeRow, type Reader, type Subject } from './store'
import { dayColumn, isoDay, rowFactsOf, rowOf } from './views'
import { endBlock, insertBlock } from './writes'

/**
 * The office's side of off-standard time (B-W2b-29; MES-156, MES-157; design production.labour "Off-standard blocks to
 * approve", the queue's DetailModal with A approve / R reject, "Approve 8 normal off-standard blocks (large or unusual
 * blocks are excluded and say why)"). Read with production.offstandard.view, decided with production.offstandard.approve,
 * each checked with can() on the block's company and site (lists: scopeWhere()).
 *
 * Lists name nobody and offer no filter, group or total by person (Owner answers W1, F2; Statuto dei Lavoratori art. 4):
 * a row says where, which code, when and its state, and whether the block names a person. One block's record names its
 * worker where the site records workers AND the site's legal gate for one person's work figures (PERFORMANCE, art. 4
 * c.1; GATE-LABOUR) is on: off (the default), the record says a person is on it (`workerHidden`), never who. Nobody
 * decides a block they are about: its worker, the office user that worker is, or whoever started or ended it on the
 * floor (the audit rows keep who, also where the site records stations only).
 *
 * Each decision is ONE command() on the block (the version read): approve (PENDING → APPROVED, when and who), reject
 * (→ REJECTED, when, who and why, sent to the person in their language by the screen), reopen (APPROVED | REJECTED →
 * PENDING, with a reason and its labour edit), correct (a waiting block's code or times, with a reason and its labour edit:
 * MES-204, before and after), end (a block left running), and a block typed afterwards (source LEAD). A line's CLOSED day
 * refuses all of them in words (closed days feed pay; MES-203).
 */

/** The audit actions of decisions about a block: their actors are not "involved" in the block itself. */
const DECISIONS = new Set(['production.offStandardApprove', 'production.offStandardReject', 'production.offStandardApproveMany', 'production.offStandardReopen', 'production.offStandardCorrect', 'production.offStandardEndByLead', 'production.offStandardRecord', 'production.offStandardFloorApprove', 'production.offStandardFloorReject'])

/** The people a block's decider may not be: its worker, its floor creator, whoever acted on it on the floor, and their office users. */
export async function involvedOf(db: Reader, block: BlockRow): Promise<Set<string>> {
  const ids = new Set<string>([block.workerId, block.source === 'LEAD' ? null : block.createdById].filter((value): value is string => value !== null))
  const actors = await db.auditLog.findMany({ where: { recordType: 'OffStandardEntry', recordId: block.id }, select: { actorId: true, action: true } })
  for (const row of actors) if (!DECISIONS.has(row.action)) ids.add(row.actorId)
  for (const userId of await workerUsers(db, [...ids])) ids.add(userId)
  return ids
}

async function officeBlock(caller: CommandCaller, blockId: string, permission: Permission): Promise<BlockRow> {
  const context = officeOf(caller)
  const block = await caller.withClient((db) => readBlock(db, blockId))
  if (!block || !can(actorOf(context), PRODUCTION_OFFSTANDARD_VIEW, { companyId: block.companyId, siteId: block.siteId })) throw new NotFoundError('Off-standard block not found.')
  if (permission !== PRODUCTION_OFFSTANDARD_VIEW && !can(actorOf(context), permission, { companyId: block.companyId, siteId: block.siteId })) throw new NotFoundError('Off-standard block not found.')
  return block
}

/**
 * The block at the version the caller read, locked for this transaction (FOR UPDATE), else a stale-version 409. Not
 * command()'s record guard: its version bump would reach a CLOSED day's trigger before the refusal in words.
 */
export async function lockedAt(tools: CommandTools, blockId: string, expectedVersion: number): Promise<BlockRow> {
  const tenantId = (tools.context as { readonly tenantId: string }).tenantId
  const block = await lockBlock(tools.tx, tenantId, blockId)
  if (!block) throw new NotFoundError('Off-standard block not found.')
  if (block.version !== expectedVersion) throw new StaleVersionError('OffStandardEntry', blockId, block.version, expectedVersion)
  return block
}

async function refuseClosedDay(db: Reader, block: { readonly lineId: string | null; readonly workDate: Date }): Promise<void> {
  if (!block.lineId) return
  const closed = await closedDays(db, [{ lineId: block.lineId, workDate: block.workDate }])
  if (closed.has(dayKey(block.lineId, block.workDate))) {
    const line = (await linesById(db, [block.lineId])).get(block.lineId)
    refuse(dayClosedRefusal(line?.code ?? '', isoDay(block.workDate)))
  }
}

// ---- reads -----------------------------------------------------------------------------------------------------------

const statusesOf = (value: string | undefined): BlockStatus[] | null =>
  value ? [...new Set(value.split(',').map((entry) => entry.trim()))].filter((entry): entry is BlockStatus => (BLOCK_STATUSES as readonly string[]).includes(entry)) : null

export async function listBlocks(caller: CommandCaller, query: ListBlocksQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const statuses = query.normal ? ['PENDING' as const] : statusesOf(query.status)
  return caller.withClient(async (db) => {
    const where: Prisma.OffStandardEntryWhereInput = {
      AND: [
        scopeWhere(actor, PRODUCTION_OFFSTANDARD_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.OffStandardEntryWhereInput,
        query.siteId ? { siteId: query.siteId } : {},
        query.lineId ? { lineId: query.lineId } : {},
        query.stationId ? { stationId: query.stationId } : {},
        query.codeId ? { codeId: query.codeId } : {},
        query.kind ? { code: { kind: query.kind } } : {},
        statuses ? { status: { in: statuses } } : {},
        query.from ? { workDate: { gte: dayColumn(query.from) } } : {},
        query.to ? { workDate: { lte: dayColumn(query.to) } } : {},
      ],
    }
    // Waiting blocks oldest first (the inbox's age); anything else newest first.
    const order = statuses && statuses.length === 1 && statuses[0] === 'PENDING' ? 'oldest' : 'newest'
    const now = new Date()
    let blocks = await readBlocks(db, where, order, query.normal ? 1000 : query.limit + 1)
    const facts = await rowFactsOf(db, blocks, now)
    if (query.normal) blocks = blocks.filter((block) => isNormal({ status: block.status, source: block.source, startedAt: block.startedAt, endedAt: block.endedAt, edited: facts.edited.has(block.id) }, now))
    const more = blocks.length > query.limit
    return { blocks: blocks.slice(0, query.limit).map((block) => rowOf(block, facts)), more }
  })
}

/** The inbox's tiles: blocks waiting (normal and unusual) and running, of the sites in scope. Counts of blocks, never of people. */
export async function blockCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly lineId?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const scope: Prisma.OffStandardEntryWhereInput = {
      AND: [scopeWhere(actor, PRODUCTION_OFFSTANDARD_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.OffStandardEntryWhereInput, query.siteId ? { siteId: query.siteId } : {}, query.lineId ? { lineId: query.lineId } : {}],
    }
    const waiting = await db.offStandardEntry.findMany({ where: { AND: [scope, { status: 'PENDING' }] }, select: { id: true, source: true, startedAt: true, endedAt: true } })
    const edited = await editedBlocks(db, waiting.map((block) => block.id))
    const now = new Date()
    const normal = waiting.filter((block) => isNormal({ status: 'PENDING', source: block.source, startedAt: block.startedAt, endedAt: block.endedAt, edited: edited.has(block.id) }, now)).length
    const running = await db.offStandardEntry.count({ where: { AND: [scope, { status: 'OPEN' }] } })
    return { pending: waiting.length, normal, unusual: waiting.length - normal, running }
  })
}

/** One block's record: the list's facts, its worker where the site records workers, the decision and its labour edits. */
export async function recordOf(db: Reader, block: BlockRow, viewer: { readonly actorId: string; readonly mayDecide: boolean }) {
  const now = new Date()
  const facts = await rowFactsOf(db, [block], now)
  const edits = await editsOf(db, block.id)
  const names = await peopleNames(db, [block.workerId, block.approvedById, block.rejectedById, ...edits.map((edit) => edit.createdById)])
  const someone = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null)
  const own = (await involvedOf(db, block)).has(viewer.actorId)
  // One person's record of work: their name only where the site's PERFORMANCE gate is on (art. 4 c.1; GATE-LABOUR).
  const shown = block.workerId !== null && (await performanceGateOpen(db, block.siteId))
  const json = (value: Prisma.JsonValue): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
  return {
    ...rowOf(block, facts),
    worker: shown ? someone(block.workerId) : null,
    workerHidden: block.workerId !== null && !shown,
    note: block.note,
    approvedAt: block.approvedAt ? toUtcIso(block.approvedAt) : null,
    approvedBy: someone(block.approvedById),
    rejectedAt: block.rejectedAt ? toUtcIso(block.rejectedAt) : null,
    rejectedBy: someone(block.rejectedById),
    rejectReason: block.rejectReason,
    deviceTime: block.deviceTime ? toUtcIso(block.deviceTime) : null,
    createdAt: toUtcIso(block.createdAt),
    edits: edits.map((edit) => ({ id: edit.id, at: toUtcIso(edit.createdAt), by: someone(edit.createdById), reason: edit.reason, before: json(edit.before), after: json(edit.after), disputeId: edit.disputeId })),
    canDecide: viewer.mayDecide && block.status === 'PENDING' && !own,
    own,
  }
}

export async function blockRecord(caller: CommandCaller, blockId: string) {
  const context = officeOf(caller)
  const block = await officeBlock(caller, blockId, PRODUCTION_OFFSTANDARD_VIEW)
  const mayDecide = can(actorOf(context), PRODUCTION_OFFSTANDARD_APPROVE, { companyId: block.companyId, siteId: block.siteId })
  return { block: await caller.withClient((db) => recordOf(db, block, { actorId: context.actorId, mayDecide })) }
}

async function answer(tools: CommandTools, blockId: string, actorId: string) {
  const block = (await readBlock(tools.tx, blockId))!
  return { block: await recordOf(tools.tx, block, { actorId, mayDecide: true }) }
}

// ---- decisions ---------------------------------------------------------------------------------------------------------

/** Approve or reject one waiting block, inside its command (the office's and the floor team leader's). */
export async function decideInCommand(tools: CommandTools, block: BlockRow, decision: { readonly status: 'APPROVED' | 'REJECTED'; readonly actorId: string; readonly involved: Set<string>; readonly reason?: string; readonly on: 'OFFICE' | 'FLOOR'; readonly bump: boolean; readonly bulk: boolean }): Promise<BlockRow> {
  const refusal = decisionRefusal({ status: block.status, involved: decision.involved.has(decision.actorId) })
  if (refusal) refuse(refusal)
  await refuseClosedDay(tools.tx, block)
  const approved = decision.status === 'APPROVED'
  const after = await tools.tx.offStandardEntry.update({
    where: { id: block.id },
    data: approved
      ? { status: 'APPROVED', approvedAt: tools.now, approvedById: decision.actorId, updatedAt: tools.now, ...(decision.bump ? { version: { increment: 1 } } : {}) }
      : { status: 'REJECTED', rejectedAt: tools.now, rejectedById: decision.actorId, rejectReason: decision.reason!.trim(), updatedAt: tools.now, ...(decision.bump ? { version: { increment: 1 } } : {}) },
    select: BLOCK,
  })
  const code = (await readCode(tools.tx, block.codeId))!
  tools.audit({
    recordType: 'OffStandardEntry',
    recordId: block.id,
    companyId: block.companyId,
    siteId: block.siteId,
    before: { status: block.status },
    after: approved ? { status: 'APPROVED', approvedAt: toUtcIso(tools.now) } : { status: 'REJECTED', rejectedAt: toUtcIso(tools.now) },
    ...(decision.reason ? { reason: decision.reason.trim() } : {}),
  })
  tools.emit({
    type: 'production.off_standard_decided',
    subject: block.id,
    companyId: block.companyId,
    siteId: block.siteId,
    payload: { blockId: block.id, siteId: block.siteId, lineId: block.lineId, codeId: code.id, code: code.code, status: decision.status, decidedOn: decision.on, bulk: decision.bulk },
  })
  return after
}

export async function approveBlock(caller: CommandCaller, blockId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await officeBlock(caller, blockId, PRODUCTION_OFFSTANDARD_APPROVE)
  const { result } = await command(caller, { name: 'production.offStandardApprove', idempotencyKey, input: { blockId, ...body } }, async (tools) => {
    const block = await lockedAt(tools, blockId, body.version)
    await decideInCommand(tools, block, { status: 'APPROVED', actorId: context.actorId, involved: await involvedOf(tools.tx, block), on: 'OFFICE', bump: true, bulk: false })
    return answer(tools, blockId, context.actorId)
  })
  return result
}

export async function rejectBlock(caller: CommandCaller, blockId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await officeBlock(caller, blockId, PRODUCTION_OFFSTANDARD_APPROVE)
  const { result } = await command(caller, { name: 'production.offStandardReject', idempotencyKey, input: { blockId, ...body } }, async (tools) => {
    const block = await lockedAt(tools, blockId, body.version)
    await decideInCommand(tools, block, { status: 'REJECTED', actorId: context.actorId, involved: await involvedOf(tools.tx, block), reason: body.reason, on: 'OFFICE', bump: true, bulk: false })
    return answer(tools, blockId, context.actorId)
  })
  return result
}

/**
 * "Approve N normal off-standard blocks": each named block at the version read, only if it is normal (waiting, short,
 * recorded on the floor as it happened, never changed) and the viewer may decide it; the others are skipped and say why.
 * ONE command for all of them.
 */
export async function approveMany(caller: CommandCaller, body: { readonly blocks: readonly { readonly id: string; readonly version: number }[] }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const ids = [...new Set(body.blocks.map((entry) => entry.id))]
  const { result } = await command(caller, { name: 'production.offStandardApproveMany', idempotencyKey, input: body }, async (tools) => {
    const approved: string[] = []
    const skipped: { id: string; code: string; message: string; unusual: UnusualReason[] }[] = []
    const rows = new Map((await tools.tx.offStandardEntry.findMany({ where: { id: { in: ids } }, select: BLOCK })).map((row) => [row.id, row]))
    const edited = await editedBlocks(tools.tx, ids)
    const skip = (id: string, refusal: Pick<OffStandardRefusal, 'code' | 'message'>, unusual: UnusualReason[] = []) => skipped.push({ id, code: refusal.code, message: refusal.message, unusual })
    for (const sent of body.blocks) {
      if (approved.includes(sent.id) || skipped.some((entry) => entry.id === sent.id)) continue
      const block = rows.get(sent.id)
      if (!block || !can(actor, PRODUCTION_OFFSTANDARD_APPROVE, { companyId: block.companyId, siteId: block.siteId })) {
        skip(sent.id, { code: 'NOT_FOUND', message: 'Off-standard block not found.' })
        continue
      }
      if (block.version !== sent.version) {
        skip(sent.id, { code: 'CHANGED', message: `This block changed since it was read (version ${sent.version}; now ${block.version}): reload it.` })
        continue
      }
      const facts = { status: block.status, source: block.source, startedAt: block.startedAt, endedAt: block.endedAt, edited: edited.has(block.id) }
      const unusual = block.status === 'PENDING' ? unusualOf(facts, tools.now) : []
      if (unusual.length > 0) {
        skip(sent.id, { code: 'UNUSUAL', message: 'Decided one by one, not with others.' }, unusual)
        continue
      }
      const refusal = decisionRefusal({ status: block.status, involved: (await involvedOf(tools.tx, block)).has(context.actorId) })
      if (refusal) {
        skip(sent.id, refusal)
        continue
      }
      if (block.lineId && (await closedDays(tools.tx, [{ lineId: block.lineId, workDate: block.workDate }])).size > 0) {
        const line = (await linesById(tools.tx, [block.lineId])).get(block.lineId)
        skip(sent.id, dayClosedRefusal(line?.code ?? '', isoDay(block.workDate)))
        continue
      }
      // Bumped at the version read: a decision of another person in flight makes this one count nothing.
      const { count } = await tools.tx.offStandardEntry.updateMany({ where: { id: block.id, version: sent.version, status: 'PENDING' }, data: { version: { increment: 1 } } })
      if (count === 0) {
        skip(sent.id, { code: 'CHANGED', message: 'This block changed since it was read: reload it.' })
        continue
      }
      await decideInCommand(tools, block, { status: 'APPROVED', actorId: context.actorId, involved: new Set(), on: 'OFFICE', bump: false, bulk: true })
      approved.push(block.id)
    }
    if (approved.length === 0) tools.audit({ recordType: 'OffStandardEntry', recordId: ids[0]!, after: { approved: 0, skipped: skipped.length } })
    return { approved, skipped }
  })
  return result
}

// ---- reopen, correct, end ----------------------------------------------------------------------------------------------

async function writeEdit(tools: CommandTools, block: BlockRow, change: { readonly before: Record<string, string | number | boolean | null>; readonly after: Record<string, string | number | boolean | null> }, reason: string, actorId: string): Promise<void> {
  await tools.tx.labourEdit.create({
    data: {
      id: newId(),
      companyId: block.companyId,
      siteId: block.siteId,
      lineId: block.lineId,
      workDate: block.workDate,
      recordType: 'OffStandardEntry',
      recordId: block.id,
      workerId: block.workerId,
      employeeId: block.employeeId,
      before: change.before,
      after: change.after,
      reason,
      createdById: actorId,
    },
    select: { id: true },
  })
}

export async function reopenBlock(caller: CommandCaller, blockId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await officeBlock(caller, blockId, PRODUCTION_OFFSTANDARD_APPROVE)
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'production.offStandardReopen', idempotencyKey, input: { blockId, ...body } }, async (tools) => {
    const block = await lockedAt(tools, blockId, body.version)
    const refusal = reopenRefusal(block.status)
    if (refusal) refuse(refusal)
    await refuseClosedDay(tools.tx, block)
    await writeEdit(tools, block, { before: { status: block.status }, after: { status: 'PENDING' } }, reason, context.actorId)
    await tools.tx.offStandardEntry.update({ where: { id: block.id }, data: { status: 'PENDING', approvedAt: null, approvedById: null, rejectedAt: null, rejectedById: null, rejectReason: null, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'OffStandardEntry', recordId: block.id, companyId: block.companyId, siteId: block.siteId, before: { status: block.status }, after: { status: 'PENDING' }, reason })
    tools.emit({ type: 'production.off_standard_changed', subject: block.id, companyId: block.companyId, siteId: block.siteId, payload: { blockId: block.id, siteId: block.siteId, lineId: block.lineId, change: 'REOPENED', fields: ['status'], status: 'PENDING' } })
    return answer(tools, blockId, context.actorId)
  })
  return result
}

const subjectOf = (block: BlockRow): Subject => ({ workerId: block.workerId, stationId: block.workerId ? null : block.stationId })

async function refuseOverlap(db: Reader, siteId: string, subject: Subject, span: { readonly startedAt: Date; readonly endedAt: Date }, except: string | null, now: Date): Promise<void> {
  const others = await blocksAround(db, siteId, subject, span.startedAt, span.endedAt, except)
  const other = others.find((row) => overlaps(span, row, now))
  if (other) {
    const code = (await readCode(db, other.codeId))!
    refuse(overlapRefusal({ startedAt: other.startedAt, endedAt: other.endedAt, code: code.code }))
  }
}

/** Correcting a waiting block's code or times, with a reason and its labour edit (MES-204); its day follows its start. */
export async function correctBlock(caller: CommandCaller, blockId: string, body: CorrectBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const found = await officeBlock(caller, blockId, PRODUCTION_OFFSTANDARD_APPROVE)
  const reason = body.reason.trim()
  const startedAt = body.startedAt ? parseInstant(body.startedAt)! : found.startedAt
  const endedAt = body.endedAt ? parseInstant(body.endedAt)! : found.endedAt
  if (body.codeId === undefined && body.startedAt === undefined && body.endedAt === undefined) throw new ValidationError('Say what changes: the code, the start or the end.', [{ path: 'body', message: 'Nothing to change.' }])
  const { result } = await command(caller, { name: 'production.offStandardCorrect', idempotencyKey, input: { blockId, ...body } }, async (tools) => {
    const block = await lockedAt(tools, blockId, body.version)
    const refusal = correctRefusal(block.status)
    if (refusal) refuse(refusal)
    if (!endedAt) refuse(correctRefusal('OPEN')!)
    const problems = timesProblems({ startedAt, endedAt: endedAt! }, tools.now)
    if (problems.length > 0) throw new ValidationError('The times are not valid.', problems)
    let code: CodeRow = (await readCode(tools.tx, block.codeId))!
    if (body.codeId !== undefined && body.codeId !== block.codeId) {
      const next = await readCode(tools.tx, body.codeId)
      if (!next || next.companyId !== block.companyId) throw new ValidationError('The code is not valid.', [{ path: 'body/codeId', message: "Not an off-standard code of this block's company." }])
      if (!next.active) refuse(CODE_INACTIVE)
      code = next
    }
    const site = (await sitesById(tools.tx, [block.siteId])).get(block.siteId)!
    const workDate = dayColumn(businessDate(startedAt, site.timezone))
    await refuseClosedDay(tools.tx, block)
    await refuseClosedDay(tools.tx, { lineId: block.lineId, workDate })
    await refuseOverlap(tools.tx, block.siteId, subjectOf(block), { startedAt, endedAt: endedAt! }, block.id, tools.now)
    const change = editOf(
      { codeId: block.codeId, startedAt: toUtcIso(block.startedAt), endedAt: block.endedAt ? toUtcIso(block.endedAt) : null, workDate: isoDay(block.workDate) },
      { codeId: code.id, startedAt: toUtcIso(startedAt), endedAt: toUtcIso(endedAt!), workDate: isoDay(workDate) },
    )
    if (!change) throw new ValidationError('Nothing changes: the block already says this.', [{ path: 'body', message: 'Nothing to change.' }])
    await writeEdit(tools, block, change, reason, context.actorId)
    await tools.tx.offStandardEntry.update({ where: { id: block.id }, data: { codeId: code.id, startedAt, endedAt, workDate, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'OffStandardEntry', recordId: block.id, companyId: block.companyId, siteId: block.siteId, before: change.before, after: change.after, reason })
    tools.emit({ type: 'production.off_standard_changed', subject: block.id, companyId: block.companyId, siteId: block.siteId, payload: { blockId: block.id, siteId: block.siteId, lineId: block.lineId, change: 'CORRECTED', fields: Object.keys(change.after), status: block.status } })
    return answer(tools, blockId, context.actorId)
  })
  return result
}

/** Ending a block left running (the worker forgot): now, or when it really ended with why. */
export async function endBlockByLead(caller: CommandCaller, blockId: string, body: { readonly version: number; readonly endedAt?: string | undefined; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await officeBlock(caller, blockId, PRODUCTION_OFFSTANDARD_APPROVE)
  if (body.endedAt !== undefined && !body.reason) throw new ValidationError('Say why it ended at another time than now.', [{ path: 'body/reason', message: 'Required with endedAt.' }])
  const { result } = await command(caller, { name: 'production.offStandardEndByLead', idempotencyKey, input: { blockId, ...body } }, async (tools) => {
    const block = await lockedAt(tools, blockId, body.version)
    const refusal = endRefusal(block.status)
    if (refusal) refuse(refusal)
    const at = body.endedAt ? parseInstant(body.endedAt)! : tools.now
    if (at.getTime() > tools.now.getTime()) throw new ValidationError('A block cannot end in the future.', [{ path: 'body/endedAt', message: 'In the future.' }])
    if (at.getTime() < block.startedAt.getTime()) throw new ValidationError('A block ends after it starts.', [{ path: 'body/endedAt', message: `Before its start (${toUtcIso(block.startedAt)}).` }])
    await refuseClosedDay(tools.tx, block)
    const code = (await readCode(tools.tx, block.codeId))!
    await endBlock(tools, block, code, { at, endedBy: 'LEAD', bump: true, ...(body.reason ? { reason: body.reason.trim() } : {}) })
    return answer(tools, blockId, context.actorId)
  })
  return result
}

// ---- typed afterwards --------------------------------------------------------------------------------------------------

/**
 * A block typed afterwards by the team leader or the office (source LEAD; design production.labour): the site's rules
 * say whom it names (the worker who acknowledged the notice, or the station), it does not overlap the subject's other
 * blocks, and its day is not closed. A code that needs approval waits PENDING — it is "typed afterwards", so never
 * approved with others at once.
 */
export async function recordBlock(caller: CommandCaller, body: RecordBlockBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const site = await caller.withClient(async (db) => (await sitesById(db, [body.siteId])).get(body.siteId) ?? null)
  if (!site || !can(actor, PRODUCTION_OFFSTANDARD_APPROVE, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  const startedAt = parseInstant(body.startedAt)!
  const endedAt = parseInstant(body.endedAt)!
  const { result } = await command(caller, { name: 'production.offStandardRecord', idempotencyKey, input: body }, async (tools) => {
    const problems = timesProblems({ startedAt, endedAt }, tools.now)
    if (problems.length > 0) throw new ValidationError('The times are not valid.', problems)
    const code = await readCode(tools.tx, body.codeId)
    if (!code || code.companyId !== site.companyId) throw new ValidationError('The code is not valid.', [{ path: 'body/codeId', message: "Not an off-standard code of the site's company." }])
    if (!code.active) refuse(CODE_INACTIVE)
    const station = body.stationId ? ((await stationsById(tools.tx, [body.stationId])).get(body.stationId) ?? null) : null
    if (body.stationId && (!station || !(await tools.tx.station.findFirst({ where: { id: body.stationId, siteId: site.id }, select: { id: true } })))) throw new ValidationError('The station is not valid.', [{ path: 'body/stationId', message: 'Not a station of this site.' }])
    if (body.lineId && !(await tools.tx.line.findFirst({ where: { id: body.lineId, siteId: site.id }, select: { id: true } }))) throw new ValidationError('The line is not valid.', [{ path: 'body/lineId', message: 'Not a line of this site.' }])
    if (station?.lineId && body.lineId && station.lineId !== body.lineId) throw new ValidationError('The line is not the station’s.', [{ path: 'body/lineId', message: 'The station stands on another line.' }])
    // Who it names: the site's floor rules, as the database checks them.
    const scanSubject = await scanSubjectFor(tools.tx, site.id)
    let subject: Subject
    let employeeId: string | null = null
    if (scanSubject === 'STATION') {
      if (body.workerId) throw new ValidationError('This site records the station only.', [{ path: 'body/workerId', message: 'Name no worker: this site records the station, never the worker.' }])
      if (!station) throw new ValidationError('Name the station.', [{ path: 'body/stationId', message: 'This site records the station: name it.' }])
      subject = { workerId: null, stationId: station.id }
    } else {
      if (!body.workerId) throw new ValidationError('Name the worker.', [{ path: 'body/workerId', message: 'This site records the worker: name them.' }])
      const worker = await workerOf(tools.tx, body.workerId)
      if (!worker || worker.siteId !== site.id) throw new ValidationError('The worker is not valid.', [{ path: 'body/workerId', message: 'Not a worker of this site.' }])
      if (!(await hasAcknowledgedNotice(tools.tx, site.id, worker.id))) throw new InvalidStateError('This worker has not acknowledged the information notice yet: no record names them before that (L. 300/1970 art. 4 c.3; GDPR art. 13).')
      subject = { workerId: worker.id, stationId: station?.id ?? null }
      employeeId = worker.employeeId
    }
    const lineId = station?.lineId ?? body.lineId ?? null
    const workDate = dayColumn(businessDate(startedAt, site.timezone))
    await refuseClosedDay(tools.tx, { lineId, workDate })
    await refuseOverlap(tools.tx, site.id, subject.workerId ? { workerId: subject.workerId, stationId: null } : subject, { startedAt, endedAt }, null, tools.now)
    const block = await insertBlock(tools, {
      companyId: site.companyId,
      siteId: site.id,
      timeZone: site.timezone,
      lineId,
      stationId: subject.stationId,
      workerId: subject.workerId,
      employeeId,
      code,
      source: 'LEAD',
      startedAt,
      endedAt,
      note: body.note ?? null,
      createdById: context.actorId,
    })
    return answer(tools, block.id, context.actorId)
  })
  return result
}

