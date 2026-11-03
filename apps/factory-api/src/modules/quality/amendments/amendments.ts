import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_AMENDMENTS_REQUEST, QUALITY_AMENDMENTS_SIGN } from '@nexus/factory-domain/quality/amendments/permissions'
import {
  AMEND_LIMITS,
  answerSha256,
  correctionProblems,
  correctionsOf,
  currentValue,
  fieldRuleOf,
  fieldsOf,
  fieldWords,
  LOCKED_WORDS,
  requestSha256,
  standing,
  STATE_WORDS,
  storedValue,
  targetKey,
  valueWords,
  waitingOn,
  waitingWords,
  checklistCodeOf,
  normalValue,
  type AmendedRecord,
  type AmendedRow,
  type AmendmentRow,
  type AmendmentState,
  type AmendValue,
  type Correction,
  type FieldRule,
} from '@nexus/factory-domain/quality/amendments/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { amendableRows, causesOf, checklistWords, isSigned, maySee, namesOf, readRecord, recordFor, type AmendableRow, type AmendedRecordRow, type Reader } from './records'

/**
 * Locked results with amendments (B-W2b-123; QHS-145; design quality.inspections ins-amend "Amend signed result" and the
 * Decision tab's dec-amend "Amendments"). Office only. A signed final inspection, a decided incoming inspection or in-process
 * check never changes (the database freezes it); a correction is two append-only InspectionAmendment rows:
 *
 *   request   quality.amendments.request over the record: the field, the row it is on, the new value and the reason; the
 *             value before is the API's (what stands now, with the signed corrections), never the screen's. Refused in
 *             words: an unsigned record (409), a field no correction takes or a value not of its kind (400), no change
 *             (400), a verdict (409 `refusal/VERDICT`: a measured value across its tolerance), a request already waiting on
 *             the same field (409 `refusal/WAITING`). Signed by who asks (SHA-256 of the statement).
 *   sign      quality.amendments.sign over the record, by another person than who asked (409 `refusal/SAME_PERSON`, the
 *             database's rule too), with a fresh step-up code asked after every other check; the value still stands as the
 *             request found it (409 `refusal/STALE` otherwise: refuse it and ask again). SIGNED: it stands.
 *   refuse    the same person rule, with the reason; no code (a refusal changes nothing). REFUSED.
 *
 * Every write is ONE command(): the record's advisory lock `factory.amendment|<tenant>|<record>` first (two requests on
 * one field, or an answer and a new request, meet there), the corrections read again, the row, its audit row on the record
 * (the record's Activity timeline) and one event. The unique answer per request is the database's last word.
 */

export class AmendmentRefusedError extends ConflictError {
  override name = 'AmendmentRefusedError'
  override readonly issues: readonly Issue[]
  constructor(code: 'NOT_SIGNED' | 'VERDICT' | 'WAITING' | 'SAME_PERSON' | 'STALE' | 'ANSWERED', message: string) {
    super(message)
    this.issues = [{ path: `refusal/${code}`, message }]
  }
}

const office = (caller: CommandCaller): OfficeContext => {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

const AMENDMENT_COLUMNS = {
  id: true,
  siteId: true,
  inspectionId: true,
  incomingInspectionId: true,
  inProcessCheckId: true,
  kind: true,
  requestId: true,
  field: true,
  recordType: true,
  recordId: true,
  before: true,
  after: true,
  reason: true,
  signedById: true,
  signedAt: true,
  signatureSha256: true,
  createdAt: true,
} as const satisfies Prisma.InspectionAmendmentSelect
type AmendmentDbRow = Prisma.InspectionAmendmentGetPayload<{ select: typeof AMENDMENT_COLUMNS }>

const parentWhere = (type: AmendedRecord, id: string) => (type === 'Inspection' ? { inspectionId: id } : type === 'IncomingInspection' ? { incomingInspectionId: id } : { inProcessCheckId: id })
const recordOf = (row: Pick<AmendmentDbRow, 'inspectionId' | 'incomingInspectionId' | 'inProcessCheckId'>): { type: AmendedRecord; id: string } =>
  row.inspectionId ? { type: 'Inspection', id: row.inspectionId } : row.incomingInspectionId ? { type: 'IncomingInspection', id: row.incomingInspectionId } : { type: 'InProcessCheck', id: row.inProcessCheckId! }

const asRow = (row: AmendmentDbRow): AmendmentRow => ({ ...row, kind: row.kind as AmendmentRow['kind'] })

/** Every signed correction's number, in the order it was signed (A1, A2 …), also when a later one overrode it. */
export function refsOf(corrections: readonly Correction[]): Map<string, number> {
  const signed = corrections.filter((item) => item.state === 'SIGNED').sort((a, b) => a.answer!.signedAt.getTime() - b.answer!.signedAt.getTime() || a.answer!.id.localeCompare(b.answer!.id))
  return new Map(signed.map((entry, index) => [entry.request.id, index + 1]))
}

export async function readAmendments(db: Reader, type: AmendedRecord, id: string): Promise<AmendmentRow[]> {
  return (await db.inspectionAmendment.findMany({ where: parentWhere(type, id), select: AMENDMENT_COLUMNS, orderBy: [{ signedAt: 'asc' }, { id: 'asc' }] })).map(asRow)
}

/** One record's corrections at a time (requests on one field, an answer and a new request). */
export async function lockAmendments(tx: CommandTx, tenantId: string, recordId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.amendment', ${tenantId}::uuid, ${recordId}::uuid), 0))`
}

const languageOf = async (db: Reader, userId: string): Promise<'it' | 'en'> => ((await db.user.findUnique({ where: { id: userId }, select: { locale: true } }))?.locale === 'it' ? 'it' : 'en')

const rowKey = (row: Pick<AmendableRow, 'type' | 'id'>): { type: AmendedRow; id: string } | null => (row.type && row.id ? { type: row.type, id: row.id } : null)

/** The field rules of a row (a record's W1 checklist notes are its own fields). */
const rulesOfRow = (record: AmendedRecordRow, row: AmendableRow): { field: string; rule: FieldRule }[] => {
  if (row.type !== null) return fieldsOf(record.type, row.type).map((rule) => ({ field: rule.field, rule }))
  return Object.keys(row.values).flatMap((field) => {
    const rule = fieldRuleOf(record.type, field, null)
    return rule ? [{ field, rule }] : []
  })
}

// ---- reads -------------------------------------------------------------------------------------------------------------------

function correctionView(entry: Correction, context: { record: AmendedRecordRow; rows: readonly AmendableRow[]; names: ReadonlyMap<string, string>; causes: ReadonlyMap<string, string>; language: 'it' | 'en'; refs: ReadonlyMap<string, number>; me: string }) {
  const { request, answer } = entry
  const rowType = (request.recordType as AmendedRow | null) ?? null
  const field = request.field ?? ''
  const rule = fieldRuleOf(context.record.type, field, rowType)
  const row = context.rows.find((candidate) => candidate.type === rowType && candidate.id === request.recordId)
  const kind = rule?.kind ?? 'text'
  const before = storedValue(request.before)
  const after = storedValue(request.after)
  return {
    id: request.id,
    ref: context.refs.get(request.id) ?? null,
    field,
    fieldWords: rule ? `${fieldWords(context.record.type, field, rowType, context.language)}${row && row.type !== null ? ` · ${row.label}` : ''}` : field,
    row: rowType && request.recordId ? { type: rowType, id: request.recordId, label: row?.label ?? rowType } : null,
    before,
    after,
    beforeWords: valueWords(kind, before, context.language, context.causes),
    afterWords: valueWords(kind, after, context.language, context.causes),
    reason: request.reason ?? '',
    state: entry.state,
    stateWords: STATE_WORDS[entry.state][context.language],
    askedBy: { id: request.signedById, name: context.names.get(request.signedById) ?? null },
    askedAt: toUtcIso(request.signedAt),
    signatureSha256: request.signatureSha256,
    mine: request.signedById === context.me,
    answer: answer ? { id: answer.id, kind: answer.kind as 'SIGNED' | 'REFUSED', by: { id: answer.signedById, name: context.names.get(answer.signedById) ?? null }, at: toUtcIso(answer.signedAt), reason: answer.reason, signatureSha256: answer.signatureSha256 } : null,
  }
}

function fieldView(record: AmendedRecordRow, row: AmendableRow, field: string, rule: FieldRule, context: { now: ReturnType<typeof standing>; corrections: readonly Correction[]; language: 'it' | 'en'; causes: ReadonlyMap<string, string> }) {
  const key = targetKey(field, rowKey(row))
  const value = currentValue(row.values[field] ?? null, context.now, key)
  const code = row.type === null ? checklistCodeOf(field) : null
  return {
    field,
    row: row.type && row.id ? { type: row.type, id: row.id, label: row.label } : null,
    kind: rule.kind,
    words: `${fieldWords(record.type, field, row.type, context.language)}${code ? ` · ${checklistWords(code)}` : ''}`,
    value,
    valueWords: valueWords(rule.kind, value, context.language, context.causes),
    nullable: rule.nullable,
    amendedBy: context.now.get(key)?.requestId ?? null,
    waiting: waitingOn(context.corrections, key)?.request.id ?? null,
    ...(row.choices && field === 'value' ? { choices: [...row.choices] } : {}),
  }
}

/** A record's corrections with their answers, and every field a correction may take with what stands now. */
export async function amendmentsOf(caller: CommandCaller, type: AmendedRecord, id: string) {
  const context = office(caller)
  const record = await recordFor(caller, context, type, id)
  return caller.withClient(async (db) => {
    const language = await languageOf(db, context.actorId)
    const corrections = correctionsOf(await readAmendments(db, type, id))
    const now = standing(corrections)
    const refs = refsOf(corrections)
    const rows = await amendableRows(db, record)
    const causes = (await causesOf(db, language)).words
    const names = await namesOf(db, corrections.flatMap((entry) => [entry.request.signedById, entry.answer?.signedById ?? null]))
    const fields = rows.flatMap((row) => rulesOfRow(record, row).map(({ field, rule }) => fieldView(record, row, field, rule, { now, corrections, language, causes })))
    const signed = isSigned(record)
    return {
      record: { type, id: record.id, label: record.label, status: record.status, signed, companyId: record.companyId, siteId: record.siteId, amended: now.size > 0 },
      corrections: corrections.map((entry) => correctionView(entry, { record, rows, names, causes, language, refs, me: context.actorId })),
      fields,
      waiting: corrections.filter((entry) => entry.state === 'WAITING').length,
      words: { locked: LOCKED_WORDS[language], waiting: waitingWords(language) },
      may: { request: signed && maySee(context, record, QUALITY_AMENDMENTS_REQUEST), sign: signed && maySee(context, record, QUALITY_AMENDMENTS_SIGN) },
    }
  })
}

export interface QueueQuery {
  readonly state?: AmendmentState | 'all' | undefined
  readonly recordType?: AmendedRecord | undefined
  readonly limit?: number | undefined
}

/**
 * GET /quality/amendments: the corrections the caller may see (each record's own view permission), newest first; by
 * default those WAITING for a second signature (Home › Approvals' and the list's "Amended results"). No value, no reason
 * in a list row: the record holds them.
 */
export async function amendmentQueue(caller: CommandCaller, query: QueueQuery) {
  const context = office(caller)
  const state = query.state ?? 'WAITING'
  const limit = Math.min(query.limit ?? 50, AMEND_LIMITS.list)
  return caller.withClient(async (db) => {
    const language = await languageOf(db, context.actorId)
    const typeWhere = query.recordType ? { [query.recordType === 'Inspection' ? 'inspectionId' : query.recordType === 'IncomingInspection' ? 'incomingInspectionId' : 'inProcessCheckId']: { not: null } } : {}
    const raw = await db.inspectionAmendment.findMany({ where: { kind: 'REQUEST', ...typeWhere }, select: AMENDMENT_COLUMNS, orderBy: [{ signedAt: 'desc' }, { id: 'desc' }], take: 1000 })
    const targets = new Map(raw.map((row) => [row.id, recordOf(row)]))
    const requests = raw.map(asRow)
    const answers = requests.length === 0 ? [] : (await db.inspectionAmendment.findMany({ where: { requestId: { in: requests.map((row) => row.id) } }, select: AMENDMENT_COLUMNS })).map(asRow)
    const corrections = correctionsOf([...requests, ...answers]).reverse().filter((entry) => state === 'all' || entry.state === state)
    const records = new Map<string, AmendedRecordRow | null>()
    const rows: ReturnType<typeof queueRow>[] = []
    for (const entry of corrections) {
      if (rows.length >= limit) break
      const target = targets.get(entry.request.id)!
      if (!records.has(target.id)) records.set(target.id, await readRecord(db, target.type, target.id))
      const record = records.get(target.id)
      if (!record || !maySee(context, record)) continue
      rows.push(queueRow(entry, record, language, context))
    }
    const names = await namesOf(db, rows.flatMap((row) => [row.askedBy.id, row.answeredBy?.id ?? null]))
    return { state, amendments: rows.map((row) => ({ ...row, askedBy: { ...row.askedBy, name: names.get(row.askedBy.id) ?? null }, answeredBy: row.answeredBy ? { ...row.answeredBy, name: names.get(row.answeredBy.id) ?? null } : null })) }
  })
}

function queueRow(entry: Correction, record: AmendedRecordRow, language: 'it' | 'en', context: OfficeContext) {
  const rowType = (entry.request.recordType as AmendedRow | null) ?? null
  const field = entry.request.field ?? ''
  return {
    id: entry.request.id,
    record: { type: record.type, id: record.id, label: record.label },
    field,
    fieldWords: fieldRuleOf(record.type, field, rowType) ? fieldWords(record.type, field, rowType, language) : field,
    rowType,
    state: entry.state,
    stateWords: STATE_WORDS[entry.state][language],
    askedBy: { id: entry.request.signedById, name: null as string | null },
    askedAt: toUtcIso(entry.request.signedAt),
    answeredBy: entry.answer ? { id: entry.answer.signedById, name: null as string | null } : null,
    answeredAt: entry.answer ? toUtcIso(entry.answer.signedAt) : null,
    mine: entry.request.signedById === context.actorId,
    maySign: entry.state === 'WAITING' && entry.request.signedById !== context.actorId && maySee(context, record, QUALITY_AMENDMENTS_SIGN),
  }
}

// ---- writes ------------------------------------------------------------------------------------------------------------------

export interface RequestBody {
  readonly field: string
  readonly row?: { readonly type: AmendedRow; readonly id: string } | null | undefined
  readonly after: string | null
  readonly reason: string
}

/** What the correction is of, and its value before (what stands now) and after, with every check in words. */
async function prepared(db: Reader, record: AmendedRecordRow, body: RequestBody, language: 'it' | 'en') {
  if (!isSigned(record)) throw new AmendmentRefusedError('NOT_SIGNED', `${record.label} is ${record.status}: a record is amended once it is signed; while it is open, correct it on the record.`)
  const rowRef = body.row ?? null
  const rule = fieldRuleOf(record.type, body.field, rowRef?.type ?? null)
  if (!rule) throw new ValidationError('A correction cannot change this field.', [{ path: 'body/field', message: `${body.field}${rowRef ? ` of a ${rowRef.type}` : ''} is not a field a correction of a ${record.type} takes.` }])
  const rows = await amendableRows(db, record)
  const row = rows.find((candidate) => candidate.type === (rowRef?.type ?? null) && candidate.id === (rowRef?.id ?? null))
  if (!row || (rowRef === null && !(body.field in row.values))) throw new ValidationError('Not a row of this record.', [{ path: rowRef ? 'body/row' : 'body/field', message: rowRef ? `${rowRef.type} ${rowRef.id} is not a row of ${record.label}.` : `${body.field} is not a line of ${record.label}.` }])
  const corrections = correctionsOf(await readAmendments(db, record.type, record.id))
  const key = targetKey(body.field, rowRef)
  const before = currentValue(row.values[body.field] ?? null, standing(corrections), key)
  const facts = rule.kind === 'cause' ? { ...row.facts, activeCauses: (await causesOf(db, language)).active } : row.facts
  const after: AmendValue = normalValue(rule.kind, body.after)
  return { rule, row, rowRef, corrections, key, before, after, facts }
}

/** POST …/amendments: asks for a correction (see the file's comment). */
export async function requestAmendment(caller: CommandCaller, type: AmendedRecord, id: string, body: RequestBody, idempotencyKey: string | undefined) {
  const context = office(caller)
  const record = await recordFor(caller, context, type, id, QUALITY_AMENDMENTS_REQUEST)
  const language = await caller.withClient((db) => languageOf(db, context.actorId))
  // Every check in words before the command, and again under the lock.
  const check = (ready: Awaited<ReturnType<typeof prepared>>) => {
    const problems = correctionProblems({ rule: ready.rule, facts: ready.facts, before: ready.before, after: ready.after, reason: body.reason })
    const verdict = problems.find((problem) => problem.path === 'refusal/VERDICT')
    if (verdict) throw new AmendmentRefusedError('VERDICT', verdict.message)
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    const waiting = waitingOn(ready.corrections, ready.key)
    if (waiting) throw new AmendmentRefusedError('WAITING', `A correction of this field waits for its second signature already (asked ${toUtcIso(waiting.request.signedAt)}): answer it first.`)
  }
  check(await caller.withClient((db) => prepared(db, record, body, language)))
  const { result } = await command(caller, { name: 'quality.requestAmendment', idempotencyKey, input: { type, id, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockAmendments(tx, context.tenantId, record.id)
    const current = (await readRecord(tx, type, id))!
    const ready = await prepared(tx, current, body, language)
    check(ready)
    const amendmentId = newId()
    const at = toUtcIso(now)
    const signature = requestSha256({ recordType: type, recordId: id, recordSignature: current.signatureSha256, field: body.field, row: ready.rowRef, before: ready.before, after: ready.after, reason: body.reason.trim(), signedById: context.actorId, at })
    await tx.inspectionAmendment.create({
      data: {
        id: amendmentId,
        siteId: current.siteId,
        ...parentWhere(type, id),
        kind: 'REQUEST',
        field: body.field,
        recordType: ready.rowRef?.type ?? null,
        recordId: ready.rowRef?.id ?? null,
        before: ready.before as Prisma.InputJsonValue,
        after: ready.after as Prisma.InputJsonValue,
        reason: body.reason.trim(),
        signedById: context.actorId,
        signedAt: now,
        signatureSha256: signature,
        createdAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      action: 'quality.requestAmendment',
      recordType: type,
      recordId: id,
      companyId: current.companyId,
      siteId: current.siteId,
      after: { amendmentId, field: body.field, row: ready.rowRef, before: ready.before, after: ready.after, signatureSha256: signature },
      reason: body.reason.trim(),
    })
    tools.emit({ type: 'inspection_amendment.requested', subject: id, companyId: current.companyId, siteId: current.siteId, payload: { amendmentId, recordType: type, recordId: id, field: body.field, rowType: ready.rowRef?.type ?? null } })
    return { amendmentId }
  })
  return { amendmentId: result.amendmentId, amendments: await amendmentsOf(caller, type, id) }
}

/** The request and its record, as the caller may answer it (seen, else 404; the sign permission, else 403). */
async function requestFor(caller: CommandCaller, context: OfficeContext, requestId: string) {
  const request = isUuid(requestId) ? await caller.withClient((db) => db.inspectionAmendment.findUnique({ where: { id: requestId }, select: AMENDMENT_COLUMNS })) : null
  if (!request || request.kind !== 'REQUEST') throw new NotFoundError('Amendment not found.')
  const target = recordOf(request)
  const record = await recordFor(caller, context, target.type, target.id, QUALITY_AMENDMENTS_SIGN)
  return { request: asRow(request), record }
}

/** Why an answer cannot be given now (who asked, an answer given, the value moved since), in words; null: it can. */
async function answerRefusal(db: Reader, context: OfficeContext, record: AmendedRecordRow, request: AmendmentRow): Promise<AmendmentRefusedError | null> {
  if (request.signedById === context.actorId) return new AmendmentRefusedError('SAME_PERSON', 'You asked for this correction: a second person signs or refuses it.')
  const corrections = correctionsOf(await readAmendments(db, record.type, record.id))
  const entry = corrections.find((item) => item.request.id === request.id)
  if (entry && entry.state !== 'WAITING') return new AmendmentRefusedError('ANSWERED', `This correction was ${entry.state.toLowerCase()} already (${toUtcIso(entry.answer!.signedAt)}).`)
  const rowRef = request.recordType && request.recordId ? { type: request.recordType as AmendedRow, id: request.recordId } : null
  const rows = await amendableRows(db, record)
  const row = rows.find((candidate) => candidate.type === (rowRef?.type ?? null) && candidate.id === (rowRef?.id ?? null))
  const field = request.field ?? ''
  const key = targetKey(field, rowRef)
  const own = row?.values[field] ?? null
  const now = currentValue(own, standing(corrections), key)
  const before = storedValue(request.before)
  const rule = fieldRuleOf(record.type, field, rowRef?.type ?? null)
  const same = rule?.kind === 'decimal' && now !== null && before !== null ? Number(now) === Number(before) : now === before
  if (!same) return new AmendmentRefusedError('STALE', `The value changed since this correction was asked (it is ${now ?? 'empty'} now): refuse it, and ask again from what stands.`)
  return null
}

export interface AnswerOptions {
  /** The fresh step-up code (signing only), asked after every other check. */
  readonly sign?: () => void | Promise<void>
  readonly idempotencyKey?: string | undefined
}

async function answer(caller: CommandCaller, requestId: string, kind: 'SIGNED' | 'REFUSED', reason: string | null, options: AnswerOptions) {
  const context = office(caller)
  const { request, record } = await requestFor(caller, context, requestId)
  if (kind === 'REFUSED') {
    const text = reason?.trim() ?? ''
    if (text.length < AMEND_LIMITS.reasonMin || text.length > AMEND_LIMITS.reason) throw new ValidationError('Say why it is refused.', [{ path: 'body/reason', message: `Say why, in ${AMEND_LIMITS.reasonMin} to ${AMEND_LIMITS.reason} characters.` }])
  }
  const refusal = await caller.withClient((db) => answerRefusal(db, context, record, request))
  if (refusal) throw refusal
  if (kind === 'SIGNED') await options.sign?.()
  const { result } = await command(caller, { name: kind === 'SIGNED' ? 'quality.signAmendment' : 'quality.refuseAmendment', idempotencyKey: options.idempotencyKey, input: { requestId, reason } }, async (tools) => {
    const { tx, now } = tools
    await lockAmendments(tx, context.tenantId, record.id)
    const again = await answerRefusal(tx, context, record, request)
    if (again) throw again
    const answerId = newId()
    const words = kind === 'REFUSED' ? reason!.trim() : null
    const signature = answerSha256({ requestId, requestSignature: request.signatureSha256, answer: kind, reason: words, signedById: context.actorId, at: toUtcIso(now) })
    await tx.inspectionAmendment.create({
      data: { id: answerId, siteId: record.siteId, ...parentWhere(record.type, record.id), kind, requestId, reason: words, signedById: context.actorId, signedAt: now, signatureSha256: signature, createdAt: now, createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({
      action: kind === 'SIGNED' ? 'quality.signAmendment' : 'quality.refuseAmendment',
      recordType: record.type,
      recordId: record.id,
      companyId: record.companyId,
      siteId: record.siteId,
      after: { amendmentId: answerId, requestId, answer: kind, field: request.field, row: request.recordType ? { type: request.recordType, id: request.recordId } : null, before: request.before, after: request.after, signatureSha256: signature },
      ...(words ? { reason: words } : {}),
    })
    tools.emit({ type: 'inspection_amendment.answered', subject: record.id, companyId: record.companyId, siteId: record.siteId, payload: { amendmentId: answerId, recordType: record.type, recordId: record.id, requestId, answer: kind } })
    return { answerId }
  })
  return { answerId: result.answerId, amendments: await amendmentsOf(caller, record.type, record.id) }
}

/** POST /quality/amendments/:amendmentId/sign: the second signature (a fresh code). */
export const signAmendment = (caller: CommandCaller, requestId: string, options: AnswerOptions) => answer(caller, requestId, 'SIGNED', null, options)

/** POST /quality/amendments/:amendmentId/refuse {reason}: the second person refuses it; nothing changes. */
export const refuseAmendment = (caller: CommandCaller, requestId: string, body: { readonly reason: string }, options: AnswerOptions) => answer(caller, requestId, 'REFUSED', body.reason, options)
