import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_LABOUR_ANSWER, PRODUCTION_LABOUR_VIEW } from '@nexus/factory-domain/production/labour/permissions'
import {
  answerProblems,
  BLOCK_RUNNING,
  changesOf,
  dayClosedRefusal,
  DISPUTE_NOT_OPEN,
  disputeMessageOf,
  labourRecordsOf,
  NOT_DISPUTABLE,
  NOT_YOURS,
  OWN_DISPUTE,
  raiseProblems,
  readDisputeMessage,
  reportOf,
  STATION_SITE,
  type DisputeRecordType,
} from '@nexus/factory-domain/production/labour/rules'
import { CODE_INACTIVE, editOf, minutesOf, overlapRefusal, overlaps, timesProblems } from '@nexus/factory-domain/production/offstandard/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { assertPersonDecides } from '../../people/privacy/decide'
import { refuse as refuseOffStandard } from '../offstandard/access'
import { blocksAround, BLOCK, closedDays, dayKey, lockBlock, readBlock, readCode, type BlockRow } from '../offstandard/store'
import { scanSubjectFor } from '../settings/subject'
import { floorOf, officeOf, reaches, refuse } from './access'
import type { AnswerBody, RaiseBody, WithdrawBody } from './contract'
import { performanceOpen } from './records'
import { bundlesById, chainsOf, COUNT_KINDS, dayColumn, isoDay, jsonObject, lineOfScan, linesById, peopleNames, recordsFor, SCAN, sitesById, toLabourScan, usersOfPerson, type Reader } from './store'

/**
 * Disputes of an entry (B-W2b-45; MES-206 "dispute an entry"; GDPR arts. 15-16; design floor.myday "Dispute an entry":
 * reason tiles (wrong quantity, not me, wrong operation, other) → Send, "your open disputes and the answers below";
 * production.labour "Reject: reason (required), sent to the person in their language").
 *
 *   raise      floor.work, the signed-in worker with the PIN (My day): one of their OWN records — a report of theirs or an
 *              off-standard block of theirs that ended — with a reason tile and words. At a site that records workers
 *              only (a station's records name nobody: nothing to dispute). The same record already disputed and open
 *              answers that dispute (nothing twice); a resend under the same client event id answers it too.
 *   withdraw   floor.work: the worker's own open dispute.
 *   answer     production.labour.answer: the team leader or HR (a person, never the system: assertPersonDecides
 *              LABOUR_CORRECTION), never the worker whose record it is (their floor sign-in, their office user, their
 *              employee's user): UPHELD or REJECTED with the answer in words. Upheld, an off-standard block may be
 *              corrected in the same command (its code or times; its labour edit names the dispute; MES-204); a report's
 *              counts change through its correction (the worker asks, a lead approves: MES-096).
 *
 * Disputes are the worker's rights over their own records (GDPR arts. 15-16): they work whatever the site's legal gate for
 * one person's work figures says. The office record names the worker only where that gate is on (`workerHidden`).
 */

export const DISPUTE = {
  id: true,
  siteId: true,
  workerId: true,
  employeeId: true,
  lineId: true,
  workDate: true,
  recordType: true,
  recordId: true,
  message: true,
  status: true,
  answer: true,
  answeredAt: true,
  answeredById: true,
  withdrawnAt: true,
  deviceId: true,
  clientEventId: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.LabourDisputeSelect
export type DisputeRow = Prisma.LabourDisputeGetPayload<{ select: typeof DISPUTE }>

const recordTypeOf = (value: string): DisputeRecordType => (value === 'OffStandardEntry' ? 'OffStandardEntry' : 'OperationScan')

export function floorDisputeOf(row: DisputeRow) {
  const { reason, words } = readDisputeMessage(row.message)
  return {
    id: row.id,
    version: row.version,
    recordType: recordTypeOf(row.recordType),
    recordId: row.recordId,
    workDate: isoDay(row.workDate),
    reason,
    words,
    status: row.status,
    answer: row.answer,
    answeredAt: row.answeredAt ? toUtcIso(row.answeredAt) : null,
    withdrawnAt: row.withdrawnAt ? toUtcIso(row.withdrawnAt) : null,
    raisedAt: toUtcIso(row.createdAt),
  }
}

async function readDispute(db: Reader, disputeId: string): Promise<DisputeRow | null> {
  if (!isUuid(disputeId)) return null
  return db.labourDispute.findUnique({ where: { id: disputeId }, select: DISPUTE })
}

async function lockDispute(tools: CommandTools, disputeId: string, expectedVersion: number): Promise<DisputeRow> {
  const tenantId = (tools.context as { readonly tenantId: string }).tenantId
  const rows = await tools.tx.$queryRaw<{ id: string }[]>`SELECT "id"::text FROM "LabourDispute" WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${disputeId}::uuid FOR UPDATE`
  const row = rows[0] ? await readDispute(tools.tx, rows[0].id) : null
  if (!row) throw new NotFoundError('Dispute not found.')
  if (row.version !== expectedVersion) throw new StaleVersionError('LabourDispute', disputeId, row.version, expectedVersion)
  return row
}

// ---- the office: one dispute and its answer --------------------------------------------------------------------------

async function summaryOf(db: Reader, row: DisputeRow, now: Date) {
  if (row.recordType === 'OffStandardEntry') {
    const block = await readBlock(db, row.recordId)
    if (!block) return null
    const code = await readCode(db, block.codeId)
    return { label: code ? `${code.code} · ${code.labelEn}` : 'Off-standard block', counts: null, code: code?.code ?? null, startedAt: toUtcIso(block.startedAt), endedAt: block.endedAt ? toUtcIso(block.endedAt) : null, minutes: minutesOf(block.startedAt, block.endedAt, now), status: block.status, version: block.version }
  }
  const scan = await db.operationScan.findUnique({ where: { id: row.recordId }, select: SCAN })
  if (!scan) return null
  const set = await recordsFor(db, [scan], BUSINESS_TIME_ZONE)
  const record = set.records[0]
  const operation = set.operations.get(scan.workOrderOperationId)
  const bundle = (await bundlesById(db, [scan.bundleId])).get(scan.bundleId)
  return {
    label: `${bundle?.code ?? ''} · ${operation ? `${operation.seq} ${operation.code}` : ''}`.trim(),
    counts: record?.counts ?? { good: 0, scrap: 0, rework: 0 },
    code: null,
    startedAt: null,
    endedAt: null,
    minutes: null,
    status: record?.state ?? 'UNDONE',
    version: null,
  }
}

async function disputeAnswer(db: Reader, row: DisputeRow, viewer: { readonly actorId: string; readonly mayAnswer: boolean }) {
  const now = new Date()
  const shown = await performanceOpen(db, row.siteId)
  const edits = await db.labourEdit.findMany({ where: { disputeId: row.id }, select: { id: true, before: true, after: true, reason: true, createdAt: true, createdById: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const names = await peopleNames(db, [shown ? row.workerId : null, row.answeredById, ...edits.map((edit) => edit.createdById)])
  const someone = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null)
  const line = row.lineId ? (await linesById(db, [row.lineId])).get(row.lineId) : undefined
  const own = (await usersOfPerson(db, row)).has(viewer.actorId)
  const { reason, words } = readDisputeMessage(row.message)
  return {
    id: row.id,
    version: row.version,
    siteId: row.siteId,
    line: line ? { id: line.id, code: line.code, name: line.name } : null,
    workDate: isoDay(row.workDate),
    recordType: recordTypeOf(row.recordType),
    recordId: row.recordId,
    reason,
    words,
    status: row.status,
    answer: row.answer,
    answeredAt: row.answeredAt ? toUtcIso(row.answeredAt) : null,
    answeredBy: someone(row.answeredById),
    withdrawnAt: row.withdrawnAt ? toUtcIso(row.withdrawnAt) : null,
    raisedAt: toUtcIso(row.createdAt),
    raisedOn: row.deviceId ? ('FLOOR' as const) : ('OFFICE' as const),
    worker: shown ? someone(row.workerId) : null,
    workerHidden: !shown,
    record: await summaryOf(db, row, now),
    edits: edits.map((edit) => ({ id: edit.id, at: toUtcIso(edit.createdAt), by: someone(edit.createdById), reason: edit.reason, changes: changesOf(jsonObject(edit.before), jsonObject(edit.after)) })),
    canAnswer: viewer.mayAnswer && row.status === 'OPEN' && !own,
    own,
  }
}

async function officeDispute(caller: CommandCaller, disputeId: string, permission: typeof PRODUCTION_LABOUR_VIEW | typeof PRODUCTION_LABOUR_ANSWER) {
  const context = officeOf(caller)
  const found = await caller.withClient(async (db) => {
    const row = await readDispute(db, disputeId)
    const site = row ? (await sitesById(db, [row.siteId])).get(row.siteId) : undefined
    return row && site ? { row, site } : null
  })
  if (!found || !reaches(context, permission, { companyId: found.site.companyId, siteId: found.site.id })) throw new NotFoundError('Dispute not found.')
  return { context, ...found }
}

export async function disputeOf(caller: CommandCaller, disputeId: string) {
  const { context, row, site } = await officeDispute(caller, disputeId, PRODUCTION_LABOUR_VIEW)
  const mayAnswer = reaches(context, PRODUCTION_LABOUR_ANSWER, { companyId: site.companyId, siteId: site.id })
  return { dispute: await caller.withClient((db) => disputeAnswer(db, row, { actorId: context.actorId, mayAnswer })) }
}

/** An upheld dispute's correction of its off-standard block: code and/or times, with the labour edit naming the dispute. */
async function correctBlock(tools: CommandTools, dispute: DisputeRow, correction: NonNullable<AnswerBody['correction']>, reason: string, actorId: string): Promise<void> {
  const tenantId = (tools.context as { readonly tenantId: string }).tenantId
  const block = await lockBlock(tools.tx, tenantId, dispute.recordId)
  if (!block) throw new NotFoundError('Off-standard block not found.')
  if (block.version !== correction.version) throw new StaleVersionError('OffStandardEntry', block.id, block.version, correction.version)
  if (block.status === 'OPEN' || !block.endedAt) refuse(BLOCK_RUNNING)
  if (correction.codeId === undefined && correction.startedAt === undefined && correction.endedAt === undefined) throw new ValidationError('Say what changes: the code, the start or the end.', [{ path: 'body/correction', message: 'Nothing to change.' }])
  const startedAt = correction.startedAt ? parseInstant(correction.startedAt)! : block.startedAt
  const endedAt = correction.endedAt ? parseInstant(correction.endedAt)! : block.endedAt!
  const problems = timesProblems({ startedAt, endedAt }, tools.now, 'body/correction')
  if (problems.length > 0) throw new ValidationError('The times are not valid.', problems)
  let codeId = block.codeId
  if (correction.codeId !== undefined && correction.codeId !== block.codeId) {
    const next = await readCode(tools.tx, correction.codeId)
    if (!next || next.companyId !== block.companyId) throw new ValidationError('The code is not valid.', [{ path: 'body/correction/codeId', message: "Not an off-standard code of this block's company." }])
    if (!next.active) refuseOffStandard(CODE_INACTIVE)
    codeId = next.id
  }
  const site = (await sitesById(tools.tx, [block.siteId])).get(block.siteId)!
  const workDate = dayColumn(businessDate(startedAt, site.timezone))
  for (const day of [block.workDate, workDate]) {
    if (block.lineId && (await closedDays(tools.tx, [{ lineId: block.lineId, workDate: day }])).has(dayKey(block.lineId, day))) {
      const line = (await linesById(tools.tx, [block.lineId])).get(block.lineId)
      refuse(dayClosedRefusal(line?.code ?? '', isoDay(day)))
    }
  }
  const subject = { workerId: block.workerId, stationId: block.workerId ? null : block.stationId }
  const other = (await blocksAround(tools.tx, block.siteId, subject, startedAt, endedAt, block.id)).find((row) => overlaps({ startedAt, endedAt }, row, tools.now))
  if (other) refuseOffStandard(overlapRefusal({ startedAt: other.startedAt, endedAt: other.endedAt, code: (await readCode(tools.tx, other.codeId))?.code ?? '' }))
  const change = editOf(
    { codeId: block.codeId, startedAt: toUtcIso(block.startedAt), endedAt: toUtcIso(block.endedAt!), workDate: isoDay(block.workDate) },
    { codeId, startedAt: toUtcIso(startedAt), endedAt: toUtcIso(endedAt), workDate: isoDay(workDate) },
  )
  if (!change) throw new ValidationError('Nothing changes: the block already says this.', [{ path: 'body/correction', message: 'Nothing to change.' }])
  await tools.tx.labourEdit.create({
    data: { id: newId(), companyId: block.companyId, siteId: block.siteId, lineId: block.lineId, workDate: block.workDate, recordType: 'OffStandardEntry', recordId: block.id, workerId: block.workerId, employeeId: block.employeeId, before: change.before, after: change.after, reason, disputeId: dispute.id, createdById: actorId },
    select: { id: true },
  })
  await tools.tx.offStandardEntry.update({ where: { id: block.id }, data: { codeId, startedAt, endedAt, workDate, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'production.labourDisputeCorrect', recordType: 'OffStandardEntry', recordId: block.id, companyId: block.companyId, siteId: block.siteId, before: change.before, after: change.after, reason })
  tools.emit({ type: 'production.off_standard_changed', subject: block.id, companyId: block.companyId, siteId: block.siteId, payload: { blockId: block.id, siteId: block.siteId, lineId: block.lineId, change: 'CORRECTED', fields: Object.keys(change.after), status: block.status as 'PENDING' | 'APPROVED' | 'REJECTED' } })
}

/** Answer a worker's dispute (MES-206): upheld or rejected in words; upheld, its off-standard block corrected with it. */
export async function answerDispute(caller: CommandCaller, disputeId: string, body: AnswerBody, idempotencyKey?: string) {
  const { context, site } = await officeDispute(caller, disputeId, PRODUCTION_LABOUR_ANSWER)
  const answer = body.answer.trim()
  const { result } = await command(caller, { name: 'production.labourDisputeAnswer', idempotencyKey, input: { disputeId, ...body } }, async (tools) => {
    // A decision about a worker's record is a person's (D.Lgs. 152/1997 art. 1-bis; GDPR art. 22).
    const actorId = assertPersonDecides(tools.context, 'LABOUR_CORRECTION')
    const row = await lockDispute(tools, disputeId, body.version)
    if (row.status !== 'OPEN') refuse(DISPUTE_NOT_OPEN)
    if ((await usersOfPerson(tools.tx, row)).has(actorId)) refuse(OWN_DISPUTE)
    const problems = answerProblems({ outcome: body.outcome, answer, correcting: body.correction !== undefined, recordType: row.recordType })
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    if (body.correction) await correctBlock(tools, row, body.correction, `Dispute upheld: ${answer}`.slice(0, 1000), actorId)
    await tools.tx.labourDispute.update({ where: { id: row.id }, data: { status: body.outcome, answer, answeredAt: tools.now, answeredById: actorId, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'LabourDispute', recordId: row.id, companyId: site.companyId, siteId: row.siteId, before: { status: 'OPEN' }, after: { status: body.outcome, corrected: body.correction !== undefined }, reason: answer })
    tools.emit({ type: 'labour_dispute.answered', subject: row.id, companyId: site.companyId, siteId: row.siteId, payload: { disputeId: row.id, siteId: row.siteId, lineId: row.lineId, workDate: isoDay(row.workDate), outcome: body.outcome, corrected: body.correction !== undefined } })
    const saved = (await readDispute(tools.tx, row.id))!
    return { dispute: await disputeAnswer(tools.tx, saved, { actorId: context.actorId, mayAnswer: true }) }
  })
  return result
}

// ---- the floor: raise and withdraw -----------------------------------------------------------------------------------

const keyOf = (context: FloorContext, clientEventId: string) => `${context.deviceId}.${clientEventId}`

/** The worker's own record a dispute is about: its REPORT (a correction goes back to it) or its ended block, line and day. */
async function ownRecord(db: Reader, context: FloorContext, recordType: DisputeRecordType, recordId: string): Promise<{ readonly recordId: string; readonly lineId: string | null; readonly workDate: Date }> {
  const site = (await sitesById(db, [context.siteId])).get(context.siteId)
  if (!site) throw new NotFoundError('Site not found.')
  if (recordType === 'OffStandardEntry') {
    const block: BlockRow | null = isUuid(recordId) ? await db.offStandardEntry.findUnique({ where: { id: recordId }, select: BLOCK }) : null
    if (!block || block.siteId !== context.siteId) throw new NotFoundError('Record not found.')
    if (block.workerId !== context.actorId) refuse(NOT_YOURS)
    if (block.status === 'OPEN' || !block.endedAt) refuse(NOT_DISPUTABLE)
    return { recordId: block.id, lineId: block.lineId, workDate: block.workDate }
  }
  const scan = isUuid(recordId) ? await db.operationScan.findUnique({ where: { id: recordId }, select: SCAN }) : null
  if (!scan || scan.siteId !== context.siteId || !(COUNT_KINDS as readonly string[]).includes(scan.kind)) throw new NotFoundError('Record not found.')
  const chain = await chainsOf(db, [scan])
  const report = reportOf(toLabourScan(scan), new Map(chain.map((row) => [row.id, toLabourScan(row)])))
  const root = report ? chain.find((row) => row.id === report.id) : undefined
  if (!root) refuse(NOT_DISPUTABLE)
  if (root!.workerId !== context.actorId) refuse(NOT_YOURS)
  // An undone report counts nothing: there is nothing of it to dispute.
  if (labourRecordsOf(chain.map(toLabourScan), new Map(), site.timezone).find((record) => record.scanId === root!.id)?.state === 'UNDONE') refuse(NOT_DISPUTABLE)
  return { recordId: root!.id, lineId: await lineOfScan(db, root!), workDate: dayColumn(businessDate(root!.serverTime, site.timezone)) }
}

/** My day: dispute one of my own records (MES-206). The PIN was asked by the route (requireFloorStepUp). */
export async function raiseDispute(caller: CommandCaller, body: RaiseBody): Promise<{ dispute: ReturnType<typeof floorDisputeOf>; existing: boolean; replayed: boolean }> {
  const context = floorOf(caller)
  const before = await caller.withClient((db) => db.labourDispute.findFirst({ where: { deviceId: context.deviceId, clientEventId: body.clientEventId }, select: DISPUTE }))
  if (before) return { dispute: floorDisputeOf(before), existing: true, replayed: true }
  const problems = raiseProblems({ recordType: body.recordType, reason: body.reason, words: body.message })
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { result, replayed } = await command(caller, { name: 'production.labourDisputeRaise', idempotencyKey: keyOf(context, body.clientEventId), input: body }, async (tools) => {
    if ((await scanSubjectFor(tools.tx, context.siteId)) === 'STATION') refuse(STATION_SITE)
    const record = await ownRecord(tools.tx, context, body.recordType, body.recordId)
    const open = await tools.tx.labourDispute.findFirst({ where: { workerId: context.actorId, recordType: body.recordType, recordId: record.recordId, status: 'OPEN' }, select: DISPUTE })
    if (open) {
      tools.audit({ recordType: 'LabourDispute', recordId: open.id, siteId: open.siteId, after: { existing: true } })
      return { dispute: floorDisputeOf(open), existing: true }
    }
    const worker = await tools.tx.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true } })
    const row = await tools.tx.labourDispute.create({
      data: {
        id: newId(),
        siteId: context.siteId,
        workerId: context.actorId,
        employeeId: worker?.employeeId ?? null,
        lineId: record.lineId,
        workDate: record.workDate,
        recordType: body.recordType,
        recordId: record.recordId,
        message: disputeMessageOf(body.reason, body.message),
        deviceId: context.deviceId,
        clientEventId: body.clientEventId,
        createdById: context.actorId,
      },
      select: DISPUTE,
    })
    tools.audit({ recordType: 'LabourDispute', recordId: row.id, siteId: row.siteId, after: { status: 'OPEN', recordType: row.recordType, recordId: row.recordId, reason: body.reason } })
    tools.emit({ type: 'labour_dispute.raised', subject: row.id, siteId: row.siteId, payload: { disputeId: row.id, siteId: row.siteId, lineId: row.lineId, workDate: isoDay(row.workDate), recordType: body.recordType } })
    return { dispute: floorDisputeOf(row), existing: false }
  })
  return { ...result, replayed }
}

/** My day: withdraw my own open dispute. */
export async function withdrawDispute(caller: CommandCaller, disputeId: string, body: WithdrawBody) {
  const context = floorOf(caller)
  const found = await caller.withClient((db) => readDispute(db, disputeId))
  if (!found || found.siteId !== context.siteId || found.workerId !== context.actorId) throw new NotFoundError('Dispute not found.')
  const { result } = await command(caller, { name: 'production.labourDisputeWithdraw', idempotencyKey: keyOf(context, body.clientEventId), input: { disputeId, ...body } }, async (tools) => {
    const row = await lockDispute(tools, disputeId, found.version)
    if (row.status !== 'OPEN') refuse(DISPUTE_NOT_OPEN)
    await tools.tx.labourDispute.update({ where: { id: row.id }, data: { status: 'WITHDRAWN', withdrawnAt: tools.now, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'LabourDispute', recordId: row.id, siteId: row.siteId, before: { status: 'OPEN' }, after: { status: 'WITHDRAWN' } })
    tools.emit({ type: 'labour_dispute.withdrawn', subject: row.id, siteId: row.siteId, payload: { disputeId: row.id, siteId: row.siteId, lineId: row.lineId, workDate: isoDay(row.workDate) } })
    return { dispute: floorDisputeOf((await readDispute(tools.tx, row.id))!) }
  })
  return result
}
