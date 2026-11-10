import type { FastifyInstance, FastifyRequest } from 'fastify'
import { lineAnswer, OPEN, refuseProblem, WAITING, type DeclarationStatus, type LineAnswer } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import type { DeclarationKind } from '@nexus/factory-domain/compliance/substances/rules'
import { ConflictError, ForbiddenError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { SUPPLIER_DOCUMENTS_REVIEW } from '@nexus/factory-domain/purchasing/portal-profile/permissions'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, isBusinessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { markRemindedInCommand, taskById, closeTasksInCommand } from '../../../platform/portal/tasks/store'
import { acceptDocument } from '../../purchasing/portal-profile/review'
import { reevaluateInCommand } from '../material-profiles/reevaluate'
import { officeOf } from '../register-of-rules/common'
import { substancesClock, substancesGuarded, substancesSettings } from '../substances/common'
import { assertMayManage, personName, readRequest } from './common'
import { dayOf, dayValue, linesOf, REQUEST_SELECT, requestDetail, type RequestRow } from './store'

/**
 * A declaration's answer and decision (B-W2b-256; PRD-304; design the Supplier declaration record: Answer, Decision; verbs
 * Remind · Accept · Reject · Re-request). compliance.supplierDeclarations.manage over the request's company; every write
 * is ONE command with the request's version as its edit-conflict guard (a stale version: 409).
 *
 *   remind   a waiting request: its portal task is reminded (the supplier's people are told, while its portal is on) or the
 *            office records that it reminded by hand; the count and the time on the request
 *   answer   a waiting request takes its answer: the supplier's portal upload (a DECLARATION of the party, by default the
 *            one it uploaded against the task) or a file of the request the office uploaded (POST /files, record type
 *            SupplierDeclarationRequest); valid to, the Candidate List version it states (REACH SVHC)
 *   lines    what the answer says per material (contains, above the threshold, the substance, its concentration), while
 *            the request is open; a material with several substances takes one line each
 *   accept   an answered request with every line answered: the supplier's upload is accepted first when it still waits
 *            (B-W2b-189's acceptance: tagged DECLARATION, shared with the supplier), then the request ACCEPTED and its
 *            materials evaluated again in the same command (the evaluator owns their profiles' state)
 *   refuse   an answered request REFUSED with why (the supplier reads it); its materials evaluated again. Asking again is
 *            a new request (ask.ts)
 */

type Caller = CommandCaller & Pick<FastifyRequest, 'withClient'>

/** The request as it stands after the command, for the answer. */
async function answerAfter(tools: CommandTools, requestId: string) {
  const row = await tools.tx.supplierDeclarationRequest.findUniqueOrThrow({ where: { id: requestId }, select: REQUEST_SELECT })
  return { request: await requestDetail(tools.tx, row, tools.now), at: toUtcIso(tools.now) }
}

/** POST /compliance/declarations-asked/:requestId/remind. */
export async function remindRequest(caller: Caller, requestId: string, body: { readonly version: number }, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const first = await caller.withClient((db) => readRequest(db, actor, requestId))
  assertMayManage(actor, first.companyId)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.remind', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'SupplierDeclarationRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const row = await readRequest(tools.tx, actor, requestId)
        await remindInCommand(tools, row, 'PERSON')
        const { request, at } = await answerAfter(tools, requestId)
        return { request, at }
      },
      substancesSettings(),
    ),
  )
  return result
}

/** Inside a command: one reminder of a waiting request (the person's verb, or the request's own cadence). */
export async function remindInCommand(tools: CommandTools, row: RequestRow, by: 'PERSON' | 'SCHEDULE'): Promise<void> {
  const status = row.status as DeclarationStatus
  if (!WAITING.has(status)) throw new InvalidStateError(status === 'ANSWERED' ? `${row.number} is answered: decide it instead.` : `${row.number} is ${status.toLowerCase()}: nothing to remind.`)
  if (row.channel === 'PORTAL') {
    const task = row.partnerTaskId ? await taskById(tools.tx, row.partnerTaskId) : null
    if (!task) throw new InvalidStateError(`${row.number} has no portal task to remind.`)
    if (task.status !== 'OPEN') throw new InvalidStateError(task.status === 'DONE' ? `The supplier uploaded an answer to ${row.number}: record it (Answer) instead of reminding.` : `The portal task of ${row.number} was withdrawn.`)
    await markRemindedInCommand(tools, task)
  }
  // Each reminder later than the last (the database counts them one at a time).
  const last = row.lastRemindedAt ?? row.sentAt
  const at = tools.now.getTime() > last.getTime() ? tools.now : new Date(last.getTime() + 1)
  await tools.tx.supplierDeclarationRequest.update({ where: { id: row.id }, data: { remindersSent: row.remindersSent + 1, lastRemindedAt: at, updatedAt: tools.now }, select: { id: true } })
  tools.audit({
    action: 'compliance.supplierDeclarations.remind',
    recordType: 'SupplierDeclarationRequest',
    recordId: row.id,
    companyId: row.companyId,
    before: { remindersSent: row.remindersSent },
    after: { remindersSent: row.remindersSent + 1, by, channel: row.channel, sentToSupplier: row.channel === 'PORTAL' },
  })
  tools.emit({ type: 'compliance_material_tests.declaration_reminded', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, partyId: row.partyId, remindersSent: row.remindersSent + 1, by, channel: row.channel as 'PORTAL' | 'LINK' | 'OFFICE' } })
}

export interface AnswerBody {
  readonly version: number
  /** PORTAL: the supplier's upload (default: the newest DECLARATION it uploaded against the request's task). */
  readonly uploadId?: string | null | undefined
  /** OFFICE: the answer's file, uploaded as a file of the request (POST /files, recordType SupplierDeclarationRequest). */
  readonly fileId?: string | null | undefined
  readonly validTo?: string | null | undefined
  readonly answeredListVersionId?: string | null | undefined
  /** The answer per material, recorded with it (optional: PUT …/lines later). */
  readonly lines?: readonly LineBody[] | undefined
}

export interface LineBody extends LineAnswer {
  /** An existing line of the request, or a new one for a material already on it (`itemId`). */
  readonly lineId?: string | null | undefined
  readonly itemId?: string | null | undefined
}

/** The validity and the list version an answer states, checked (every problem at once). */
async function answerFacts(tools: CommandTools, row: RequestRow, body: { readonly validTo?: string | null | undefined; readonly answeredListVersionId?: string | null | undefined }, answeredDay: BusinessDate, issues: Issue[]) {
  const validTo = body.validTo === undefined ? (row.validTo ? dayOf(row.validTo) : null) : body.validTo
  if (validTo !== null && (!isBusinessDate(validTo) || validTo < answeredDay)) issues.push({ path: 'body/validTo', message: `A day (YYYY-MM-DD) not before the answer came (${answeredDay}), or none for no end.` })
  let listVersionId = body.answeredListVersionId === undefined ? row.answeredListVersionId : body.answeredListVersionId
  if (row.kind !== 'REACH_SVHC' && listVersionId) issues.push({ path: 'body/answeredListVersionId', message: 'Only an SVHC declaration states a Candidate List version.' })
  if (row.kind === 'REACH_SVHC' && listVersionId && !(await tools.tx.svhcListVersion.findUnique({ where: { id: listVersionId }, select: { id: true } }))) issues.push({ path: 'body/answeredListVersionId', message: 'Not a Candidate List version.' })
  if (row.kind !== 'REACH_SVHC') listVersionId = null
  return { validTo, listVersionId }
}

/** Inside a command: the lines of the answer written (checked first, every problem at once). How many lines and how many answered. */
async function writeLines(tools: CommandTools, row: RequestRow, lines: readonly LineBody[], removeLineIds: readonly string[], actorId: string): Promise<{ readonly lines: number; readonly answered: number }> {
  const issues: Issue[] = []
  const current = (await linesOf(tools.tx, [row.id])).get(row.id) ?? []
  const byId = new Map(current.map((line) => [line.id, line]))
  const substanceIds = [...new Set(lines.flatMap((line) => (line.substanceId ? [line.substanceId] : [])))]
  const substances = new Set((substanceIds.length === 0 ? [] : await tools.tx.restrictedSubstance.findMany({ where: { id: { in: substanceIds.filter(isUuid) } }, select: { id: true } })).map((substance) => substance.id))
  const writes: { readonly lineId: string | null; readonly itemId: string; readonly articleLabel: string; readonly answer: ReturnType<typeof lineAnswer>['answer'] }[] = []
  lines.forEach((line, index) => {
    const at = `body/lines/${index}`
    const existing = line.lineId ? byId.get(line.lineId) : undefined
    if (line.lineId && !existing) issues.push({ path: `${at}/lineId`, message: 'Not a line of this request.' })
    const material = existing ?? (line.itemId ? current.find((entry) => entry.itemId === line.itemId) : undefined)
    if (!line.lineId && !material) issues.push({ path: `${at}/itemId`, message: 'A line of the request, or a material already on it (a second substance).' })
    if (line.substanceId && !substances.has(line.substanceId)) issues.push({ path: `${at}/substanceId`, message: 'Not a substance of the list.' })
    const checked = lineAnswer(line, row.kind as DeclarationKind, at)
    issues.push(...checked.problems)
    if (material) writes.push({ lineId: existing?.id ?? null, itemId: material.itemId, articleLabel: material.articleLabel, answer: checked.answer })
  })
  removeLineIds.forEach((id, index) => {
    if (!byId.has(id)) issues.push({ path: `body/removeLineIds/${index}`, message: 'Not a line of this request.' })
  })
  const kept = current.filter((line) => !removeLineIds.includes(line.id))
  for (const itemId of new Set(current.map((line) => line.itemId))) {
    if (!kept.some((line) => line.itemId === itemId) && !writes.some((write) => write.itemId === itemId && write.lineId === null)) issues.push({ path: 'body/removeLineIds', message: 'Every material asked about keeps a line.' })
  }
  if (issues.length > 0) throw new ValidationError('The answer per material is not valid.', issues)
  for (const id of removeLineIds) await tools.tx.supplierDeclarationLine.delete({ where: { id } })
  let seq = current.reduce((max, line) => Math.max(max, line.seq), 0)
  for (const write of writes) {
    const data = { ...write.answer, updatedAt: tools.now }
    if (write.lineId) await tools.tx.supplierDeclarationLine.update({ where: { id: write.lineId }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    else {
      seq += 1
      await tools.tx.supplierDeclarationLine.create({ data: { id: newId(), partyId: row.partyId, requestId: row.id, seq, itemId: write.itemId, articleLabel: write.articleLabel, ...data, createdAt: tools.now, createdById: actorId }, select: { id: true } })
    }
  }
  const after = (await linesOf(tools.tx, [row.id])).get(row.id) ?? []
  const counts = { lines: after.length, answered: after.filter((line) => line.contains !== null).length }
  tools.audit({ action: 'compliance.supplierDeclarations.lines', recordType: 'SupplierDeclarationRequest', recordId: row.id, companyId: row.companyId, after: { written: writes.length, removed: removeLineIds.length, ...counts } })
  tools.emit({ type: 'compliance_material_tests.declaration_lines_recorded', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, partyId: row.partyId, ...counts } })
  return counts
}

/** Inside a command: a waiting request ANSWERED by an upload or a file (also the worker's, for a portal upload). */
export async function answerInCommand(tools: CommandTools, row: RequestRow, answer: { readonly uploadId: string | null; readonly fileId: string | null; readonly answeredAt: Date; readonly validTo: BusinessDate | null; readonly listVersionId: string | null }, by: 'PORTAL' | 'OFFICE'): Promise<void> {
  await tools.tx.supplierDeclarationRequest.update({
    where: { id: row.id },
    data: { status: 'ANSWERED', answeredAt: answer.answeredAt, uploadId: answer.uploadId, answerFileId: answer.fileId, validTo: answer.validTo ? dayValue(answer.validTo) : null, answeredListVersionId: answer.listVersionId, updatedAt: tools.now },
    select: { id: true },
  })
  // Answered by the office (an upload linked by hand, a file): the portal task asked for nothing more.
  if (row.partnerTaskId && by === 'OFFICE') await closeTasksInCommand(tools, { recordType: 'SupplierDeclarationRequest', recordId: row.id, kinds: ['UPLOAD_DOCUMENT'], status: 'DONE', doneById: null })
  tools.audit({ action: 'compliance.supplierDeclarations.answer', recordType: 'SupplierDeclarationRequest', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'ANSWERED', uploadId: answer.uploadId, fileId: answer.fileId, validTo: answer.validTo, answeredListVersionId: answer.listVersionId, by } })
  tools.emit({ type: 'compliance_material_tests.declaration_answered', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, partyId: row.partyId, channel: row.channel as 'PORTAL' | 'LINK' | 'OFFICE', by } })
}

/** POST /compliance/declarations-asked/:requestId/answer. */
export async function answerRequest(caller: Caller, requestId: string, body: AnswerBody, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const first = await caller.withClient((db) => readRequest(db, actor, requestId))
  assertMayManage(actor, first.companyId)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.answer', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'SupplierDeclarationRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const row = await readRequest(tools.tx, actor, requestId)
        const status = row.status as DeclarationStatus
        if (!WAITING.has(status)) throw new InvalidStateError(status === 'ANSWERED' ? `${row.number} is answered already: its answer never changes; refuse it and ask again.` : `${row.number} is ${status.toLowerCase()}: it takes no answer.`)
        const issues: Issue[] = []
        let uploadId: string | null = null
        let fileId: string | null = null
        let answeredAt = tools.now
        if (row.channel === 'PORTAL') {
          if (body.fileId) issues.push({ path: 'body/fileId', message: "A request asked in the portal is answered by the supplier's upload (uploadId)." })
          const upload = body.uploadId
            ? isUuid(body.uploadId)
              ? await tools.tx.supplierDocumentUpload.findUnique({ where: { id: body.uploadId }, select: { id: true, partyId: true, companyId: true, category: true, status: true, receivedAt: true } })
              : null
            : row.partnerTaskId
              ? await tools.tx.supplierDocumentUpload.findFirst({ where: { taskId: row.partnerTaskId, category: 'DECLARATION', status: { not: 'REFUSED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, partyId: true, companyId: true, category: true, status: true, receivedAt: true } })
              : null
          if (!upload) issues.push({ path: 'body/uploadId', message: body.uploadId ? 'Not an upload of this supplier.' : 'The supplier has not uploaded a declaration for this request yet: name its upload.' })
          else if (upload.partyId !== row.partyId || upload.companyId !== row.companyId) issues.push({ path: 'body/uploadId', message: 'An upload of this supplier in the portal of the company that asks.' })
          else if (upload.category !== 'DECLARATION') issues.push({ path: 'body/uploadId', message: `The supplier sent it as a ${upload.category.toLowerCase().replace('_', ' ')}: only a declaration answers.` })
          else if (upload.status === 'REFUSED') issues.push({ path: 'body/uploadId', message: 'That upload was refused.' })
          else {
            uploadId = upload.id
            if (upload.receivedAt && upload.receivedAt.getTime() >= row.sentAt.getTime()) answeredAt = upload.receivedAt
          }
        } else {
          if (body.uploadId) issues.push({ path: 'body/uploadId', message: 'A request asked by the office is answered by a file of the request (fileId).' })
          const file = body.fileId && isUuid(body.fileId) ? await tools.tx.storedFile.findUnique({ where: { id: body.fileId }, select: { id: true, recordType: true, recordId: true, status: true } }) : null
          if (!file || file.recordType !== 'SupplierDeclarationRequest' || file.recordId !== row.id) issues.push({ path: 'body/fileId', message: 'Upload the answer as a file of this request first (POST /files with recordType SupplierDeclarationRequest and its id).' })
          else if (file.status !== 'AVAILABLE') issues.push({ path: 'body/fileId', message: 'The file has not arrived (confirm its upload first).' })
          else fileId = file.id
        }
        const answeredDay = businessDate(answeredAt)
        const facts = await answerFacts(tools, row, body, answeredDay, issues)
        if (issues.length > 0) throw new ValidationError('The answer is not valid.', issues)
        await answerInCommand(tools, row, { uploadId, fileId, answeredAt, validTo: facts.validTo, listVersionId: facts.listVersionId }, 'OFFICE')
        if (body.lines && body.lines.length > 0) await writeLines(tools, { ...row, status: 'ANSWERED' }, body.lines, [], context.actorId)
        const { request, at } = await answerAfter(tools, requestId)
        return { request, at }
      },
      substancesSettings(),
    ),
  )
  return result
}

/** PUT /compliance/declarations-asked/:requestId/lines. */
export async function recordLines(caller: Caller, requestId: string, body: { readonly version: number; readonly lines: readonly LineBody[]; readonly removeLineIds?: readonly string[] | undefined }, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const first = await caller.withClient((db) => readRequest(db, actor, requestId))
  assertMayManage(actor, first.companyId)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.lines', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'SupplierDeclarationRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const row = await readRequest(tools.tx, actor, requestId)
        if (!OPEN.has(row.status as DeclarationStatus)) throw new InvalidStateError(`${row.number} is ${row.status.toLowerCase()}: its lines no longer change.`)
        await writeLines(tools, row, body.lines, body.removeLineIds ?? [], context.actorId)
        const { request, at } = await answerAfter(tools, requestId)
        return { request, at }
      },
      substancesSettings(),
    ),
  )
  return result
}

/** The materials of a request (each once). */
const materialsOf = async (tools: CommandTools, requestId: string): Promise<string[]> => [...new Set(((await linesOf(tools.tx, [requestId])).get(requestId) ?? []).map((line) => line.itemId))]

/** POST /compliance/declarations-asked/:requestId/accept. */
export async function acceptRequest(app: FastifyInstance, caller: Caller, requestId: string, body: { readonly version: number; readonly validTo?: string | null | undefined; readonly answeredListVersionId?: string | null | undefined }, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const first = await caller.withClient((db) => readRequest(db, actor, requestId))
  assertMayManage(actor, first.companyId)
  if (first.status !== 'ANSWERED') throw new InvalidStateError(`${first.number} is ${first.status.toLowerCase()}: only an answered request is accepted.`)
  const open = ((await caller.withClient((db) => linesOf(db, [first.id]))).get(first.id) ?? []).filter((line) => line.contains === null)
  if (open.length > 0) throw new ConflictError(`Record what the answer says for every material first: ${open.map((line) => line.articleLabel).join('; ')}.`)
  // A portal answer rests on the supplier's document: accepted first when it still waits (B-W2b-189), tagged a declaration.
  if (first.uploadId) {
    const upload = await caller.withClient((db) => db.supplierDocumentUpload.findUnique({ where: { id: first.uploadId! }, select: { fileId: true, status: true, expiresOn: true } }))
    if (upload?.status === 'REFUSED') throw new InvalidStateError("The supplier's upload was refused: refuse this declaration and ask again.")
    if (upload?.status === 'WAITING') {
      if (!can(actor, SUPPLIER_DOCUMENTS_REVIEW, { companyId: first.companyId, partyId: first.partyId })) {
        throw new ForbiddenError("The supplier's document still waits for its check: accepting it needs purchasing.supplierDocuments.review (ask a buyer to accept it in Supplier documents first).")
      }
      const file = await caller.withClient((db) => db.storedFile.findUnique({ where: { id: upload.fileId }, select: { version: true } }))
      const validTo = body.validTo === undefined ? (first.validTo ? dayOf(first.validTo) : upload.expiresOn ? dayOf(upload.expiresOn) : null) : body.validTo
      await acceptDocument(app, caller, upload.fileId, { category: 'DECLARATION', expiresOn: validTo, version: file?.version ?? 1 }, substancesClock().now(), key ? `${key.slice(0, 120)}:upload` : undefined)
    }
  }
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.accept', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'SupplierDeclarationRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const row = await readRequest(tools.tx, actor, requestId)
        if (row.status !== 'ANSWERED') throw new InvalidStateError(`${row.number} is ${row.status.toLowerCase()}: only an answered request is accepted.`)
        const issues: Issue[] = []
        const facts = await answerFacts(tools, row, { validTo: body.validTo, answeredListVersionId: body.answeredListVersionId === undefined ? (row.answeredListVersionId ?? row.svhcListVersionId) : body.answeredListVersionId }, businessDate(row.answeredAt!), issues)
        if (issues.length > 0) throw new ValidationError('The acceptance is not valid.', issues)
        const name = await personName(tools.tx, context.actorId)
        await tools.tx.supplierDeclarationRequest.update({
          where: { id: row.id },
          data: { status: 'ACCEPTED', decidedAt: tools.now, decidedById: context.actorId, decidedByName: name, validTo: facts.validTo ? dayValue(facts.validTo) : null, answeredListVersionId: facts.listVersionId, updatedAt: tools.now },
          select: { id: true },
        })
        const items = await materialsOf(tools, row.id)
        tools.audit({ action: 'compliance.supplierDeclarations.accept', recordType: 'SupplierDeclarationRequest', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'ACCEPTED', validTo: facts.validTo, answeredListVersionId: facts.listVersionId, decidedByName: name } })
        tools.emit({ type: 'compliance_material_tests.declaration_decided', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, partyId: row.partyId, kind: row.kind as DeclarationKind, outcome: 'ACCEPTED', validTo: facts.validTo, materials: items.length } })
        // The evaluator says again what each material needs and whether it is met (B-W2b-250's one writer).
        await reevaluateInCommand(tools, items, context.actorId)
        const { request, at } = await answerAfter(tools, requestId)
        return { request, at }
      },
      substancesSettings(),
    ),
  )
  return result
}

/** POST /compliance/declarations-asked/:requestId/refuse. */
export async function refuseRequest(caller: Caller, requestId: string, body: { readonly version: number; readonly reason: string }, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const first = await caller.withClient((db) => readRequest(db, actor, requestId))
  assertMayManage(actor, first.companyId)
  const problem = refuseProblem(body.reason)
  if (problem) throw new ValidationError('The refusal is not valid.', [{ path: 'body/reason', message: problem }])
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.refuse', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'SupplierDeclarationRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const row = await readRequest(tools.tx, actor, requestId)
        if (row.status !== 'ANSWERED') throw new InvalidStateError(WAITING.has(row.status as DeclarationStatus) ? `${row.number} has no answer yet: cancel it instead.` : `${row.number} is ${row.status.toLowerCase()} already.`)
        const name = await personName(tools.tx, context.actorId)
        const reason = body.reason.trim()
        await tools.tx.supplierDeclarationRequest.update({ where: { id: row.id }, data: { status: 'REFUSED', decidedAt: tools.now, decidedById: context.actorId, decidedByName: name, refuseReason: reason, updatedAt: tools.now }, select: { id: true } })
        const items = await materialsOf(tools, row.id)
        tools.audit({ action: 'compliance.supplierDeclarations.refuse', recordType: 'SupplierDeclarationRequest', recordId: row.id, companyId: row.companyId, reason, before: { status: row.status }, after: { status: 'REFUSED', decidedByName: name } })
        tools.emit({ type: 'compliance_material_tests.declaration_decided', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, partyId: row.partyId, kind: row.kind as DeclarationKind, outcome: 'REFUSED', validTo: row.validTo ? dayOf(row.validTo) : null, materials: items.length } })
        await reevaluateInCommand(tools, items, context.actorId)
        const { request, at } = await answerAfter(tools, requestId)
        return { request, at }
      },
      substancesSettings(),
    ),
  )
  return result
}
