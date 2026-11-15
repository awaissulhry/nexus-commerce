import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRIVACY_REQUESTS_MANAGE } from '@nexus/factory-domain/privacy/retention/permissions'
import {
  dueAtOf,
  extendedDueOf,
  PERSON_RECORD_TYPES,
  personRecordFits,
  reasonProblem,
  REQUEST_LIMITS,
  requestProblems,
  type DataRequestKind,
  type DataSubjectKind,
} from '@nexus/factory-domain/privacy/retention/requests'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { officeOf, refuse } from '../access'
import { personFacts } from '../erasure/sources/person'
import { actionsOf, assertMayRequest, COLLECT_ACTIONS, readRequest, requestAnswer, type RequestRow, type RequestView } from './read'

/**
 * A person's data requests (B-W2b-405; PLT-202, PLT-203; GDPR arts. 12, 15, 16, 17, 20; design admin.privacy "Data requests",
 * "New data request"). privacy.requests.manage on the request's company for every write; each a command with its audit row and
 * privacy.request_changed:
 *
 *   POST /privacy/requests                       received: the person (by kind and record), the kind, when it came in (the
 *                                                30-day clock starts there), a note
 *   POST /privacy/requests/:requestId/identity   the person's identity checked (art. 12(6)), how in the reason: the work starts
 *   POST /privacy/requests/:requestId/extend     extended once, within the first month, by 1 or 2 months with the reason (12(3))
 *   POST /privacy/requests/:requestId/collect    an access request's package asked for (the worker collects it: package.ts)
 *   POST /privacy/requests/:requestId/done       done: an access request once its package is made, an erasure once it ran, a
 *                                                correction once made in the record's own screen
 *   POST /privacy/requests/:requestId/refuse     refused with the reason (art. 12(4), 12(5))
 *   POST /privacy/requests/:requestId/withdraw   withdrawn by the person
 */

export interface CreateRequestBody {
  readonly companyId: string
  readonly personKind: DataSubjectKind
  readonly personRecordType?: string | undefined
  readonly personRecordId: string
  readonly kind: DataRequestKind
  readonly receivedAt?: string | undefined
  readonly note?: string | null | undefined
}

type Change = 'RECEIVED' | 'IDENTITY_CHECKED' | 'EXTENDED' | 'DONE' | 'REFUSED' | 'WITHDRAWN'

export function emitChange(tools: Pick<CommandTools, 'emit'>, request: Pick<RequestRow, 'id' | 'companyId' | 'kind' | 'personKind'>, status: string, change: Change | 'PACKAGE_READY' | 'PACKAGE_FAILED'): void {
  tools.emit({ type: 'privacy.request_changed', subject: request.id, companyId: request.companyId, payload: { requestId: request.id, companyId: request.companyId, kind: request.kind, personKind: request.personKind, status, change } })
}

/** POST /privacy/requests */
export async function createRequest(caller: CommandCaller, body: CreateRequestBody, now: Date, idempotencyKey?: string): Promise<{ request: RequestView }> {
  const company = isUuid(body.companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: body.companyId }, select: { id: true } })) : null
  if (!company) throw new NotFoundError('Company not found.')
  const context = officeOf(caller)
  assertMayRequest(context, PRIVACY_REQUESTS_MANAGE, company.id)
  const recordType = body.personRecordType ?? PERSON_RECORD_TYPES[body.personKind][0]!
  if (!personRecordFits(body.personKind, recordType)) refuse([{ path: 'personRecordType', message: `A ${body.personKind.toLowerCase()} is named by ${PERSON_RECORD_TYPES[body.personKind].join(' or ')}.` }], 'The person is not named right.')
  const receivedAt = body.receivedAt === undefined ? now : parseInstant(body.receivedAt)
  if (receivedAt === null) refuse([{ path: 'receivedAt', message: 'When the request came in, as a date and time.' }], 'When the request came in, as a date and time.')
  refuse(requestProblems({ receivedAt: receivedAt!, note: body.note }, now), 'The request is not valid.')
  const person = isUuid(body.personRecordId) ? await caller.withClient((client) => personFacts(client, body.personKind, recordType, body.personRecordId)) : null
  if (!person) throw new NotFoundError('The person was not found.')
  if (person.companyId !== null && person.companyId !== company.id) refuse([{ path: 'personRecordId', message: "This person's record belongs to another company: record the request in that company." }], "This person's record belongs to another company.")
  const { result } = await command(caller, { name: 'privacy.requestReceive', idempotencyKey, input: body }, async (tools) => {
    const id = newId()
    const at = receivedAt!
    const row = { id, companyId: company.id, personKind: body.personKind, personRecordType: recordType, personRecordId: body.personRecordId, kind: body.kind, receivedAt: at, dueAt: dueAtOf(at), note: body.note?.trim() || null, status: 'RECEIVED' as const, createdById: context.actorId }
    await tools.tx.dataRequest.create({ data: row, select: { id: true } })
    // The audit names the person's record (type and id), never their name.
    tools.audit({ recordType: 'DataRequest', recordId: id, companyId: company.id, after: { personKind: body.personKind, personRecordType: recordType, personRecordId: body.personRecordId, kind: body.kind, receivedAt: toUtcIso(at), dueAt: toUtcIso(row.dueAt) } })
    emitChange(tools, row, 'RECEIVED', 'RECEIVED')
    return id
  })
  return { request: await requestAnswer(caller, result, now) }
}

interface Writes {
  readonly idempotencyKey?: string | undefined
  readonly now: Date
}

/** A write on an open request at the version read: the work sets the columns; the audit and the event follow. */
async function move(caller: CommandCaller, requestId: string, version: number, name: string, input: unknown, held: (actions: ReturnType<typeof actionsOf>) => { allowed: boolean; held: { words: string } | null }, writes: Writes, work: (tools: CommandTools & { readonly actorId: string }, request: RequestRow) => Promise<{ data: Record<string, unknown>; change: Change; status: string; audit: { before?: unknown; after: unknown; reason?: string } }>) {
  const { context, request } = await readRequest(caller, requestId, PRIVACY_REQUESTS_MANAGE)
  const erasures = await caller.withClient((client) => client.erasureRecord.count({ where: { dataRequestId: request.id } }))
  const action = held(actionsOf(request, erasures, writes.now))
  if (!action.allowed) throw new InvalidStateError(action.held!.words)
  await command(caller, { name: name as Permission, idempotencyKey: writes.idempotencyKey, input, record: { type: 'DataRequest', id: requestId, expectedVersion: version } }, async (tools) => {
    const { data, change, status, audit } = await work({ ...tools, actorId: context.actorId }, request)
    await tools.tx.dataRequest.update({ where: { id: requestId }, data: { ...data, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'DataRequest', recordId: requestId, companyId: request.companyId, ...audit })
    emitChange(tools, request, status, change)
    return null
  })
  return { request: await requestAnswer(caller, requestId, writes.now) }
}

/** POST /privacy/requests/:requestId/identity {version, how}: checked once; RECEIVED → IN_PROGRESS. */
export async function checkIdentity(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly how: string }, writes: Writes) {
  refuse([reasonProblem('how', body.how, REQUEST_LIMITS.reason, "how the person's identity was checked (without the document's number)")].filter((issue) => issue !== null), 'Say how the identity was checked.')
  return move(caller, requestId, body.version, 'privacy.requestIdentity', body, (actions) => actions.checkIdentity, writes, async ({ now, actorId }, request) => ({
    data: { identityCheckedAt: now, identityCheckedById: actorId, ...(request.status === 'RECEIVED' ? { status: 'IN_PROGRESS' } : {}) },
    change: 'IDENTITY_CHECKED',
    status: request.status === 'RECEIVED' ? 'IN_PROGRESS' : request.status,
    audit: { before: { status: request.status, identityChecked: false }, after: { status: 'IN_PROGRESS', identityCheckedAt: toUtcIso(now) }, reason: body.how.trim() },
  }))
}

/** POST /privacy/requests/:requestId/extend {version, months, reason}: once, before the first month ends. */
export async function extendRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly months: 1 | 2; readonly reason: string }, writes: Writes) {
  refuse([reasonProblem('reason', body.reason, REQUEST_LIMITS.extensionReason, 'why the request needs longer (the person is told)')].filter((issue) => issue !== null), 'Say why the request needs longer.')
  return move(caller, requestId, body.version, 'privacy.requestExtend', body, (actions) => actions.extend, writes, async (_tools, request) => {
    const extendedDueAt = extendedDueOf(request.dueAt, body.months)
    return {
      data: { extendedDueAt, extensionReason: body.reason.trim() },
      change: 'EXTENDED',
      status: request.status,
      audit: { before: { dueAt: toUtcIso(request.dueAt) }, after: { extendedDueAt: toUtcIso(extendedDueAt), months: body.months, extensionReason: body.reason.trim() } },
    }
  })
}

/** POST /privacy/requests/:requestId/done {version} */
export async function finishRequest(caller: CommandCaller, requestId: string, body: { readonly version: number }, writes: Writes) {
  return move(caller, requestId, body.version, 'privacy.requestDone', body, (actions) => actions.close, writes, async ({ now, actorId }, request) => ({
    data: { status: 'DONE', decidedAt: now, decidedById: actorId },
    change: 'DONE',
    status: 'DONE',
    audit: { before: { status: request.status }, after: { status: 'DONE', decidedAt: toUtcIso(now), packageFileId: request.packageFileId } },
  }))
}

/** POST /privacy/requests/:requestId/refuse {version, reason} */
export async function refuseRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly reason: string }, writes: Writes) {
  refuse([reasonProblem('reason', body.reason, REQUEST_LIMITS.refusalReason, 'why the request is refused (the person is told, with their right to complain to the Garante)')].filter((issue) => issue !== null), 'Say why the request is refused.')
  return move(caller, requestId, body.version, 'privacy.requestRefuse', body, (actions) => actions.refuse, writes, async ({ now, actorId }, request) => ({
    data: { status: 'REFUSED', decidedAt: now, decidedById: actorId, refusalReason: body.reason.trim() },
    change: 'REFUSED',
    status: 'REFUSED',
    audit: { before: { status: request.status }, after: { status: 'REFUSED', refusalReason: body.reason.trim() } },
  }))
}

/** POST /privacy/requests/:requestId/withdraw {version, reason?} */
export async function withdrawRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly reason?: string | undefined }, writes: Writes) {
  return move(caller, requestId, body.version, 'privacy.requestWithdraw', body, (actions) => actions.withdraw, writes, async ({ now, actorId }, request) => ({
    data: { status: 'WITHDRAWN', decidedAt: now, decidedById: actorId },
    change: 'WITHDRAWN',
    status: 'WITHDRAWN',
    audit: { before: { status: request.status }, after: { status: 'WITHDRAWN' }, ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}) },
  }))
}

/** POST /privacy/requests/:requestId/collect: the package asked for; the worker's handler collects it (package.ts). */
export async function askPackage(caller: CommandCaller, requestId: string, writes: Writes): Promise<{ request: RequestView }> {
  const { request } = await readRequest(caller, requestId, PRIVACY_REQUESTS_MANAGE)
  const action = actionsOf(request, 0, writes.now).collect
  if (!action.allowed) throw new InvalidStateError(action.held!.words)
  await command(caller, { name: COLLECT_ACTIONS.asked, idempotencyKey: writes.idempotencyKey, input: { requestId } }, async (tools) => {
    tools.audit({ recordType: 'DataRequest', recordId: request.id, companyId: request.companyId, after: { askedAt: toUtcIso(tools.now) } })
    tools.emit({ type: 'privacy.request_collect_asked', subject: request.id, companyId: request.companyId, payload: { requestId: request.id, companyId: request.companyId } })
    return null
  })
  return { request: await requestAnswer(caller, requestId, writes.now) }
}
