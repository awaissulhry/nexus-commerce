import { DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  confirmNameProblem,
  ERASURE_BLOCKED_WORDS,
  ERASURE_LIMITS,
  eraseReasonProblem,
  KEPT_WHY_WORDS,
  type ErasureBlocked,
  type KeptWhy,
} from '@nexus/factory-domain/privacy/retention/erasure'
import { PRIVACY_ERASE, PRIVACY_REQUESTS_VIEW } from '@nexus/factory-domain/privacy/retention/permissions'
import { REQUEST_HELD_WORDS, type DataSubjectKind } from '@nexus/factory-domain/privacy/retention/requests'
import type { ErasureMethod } from '@nexus/factory-domain/privacy/retention/retention'
import { command, type CommandCaller } from '../../../core/command'
import { refuse } from '../access'
import { actionsOf, readRequest, requestAnswer, type RequestRow } from '../requests/read'
import { personFacts } from './sources/person'
import { mailSendingNow } from './sources/shared'
import { sourcesFor } from './sources'
import type { PersonFacts, PlannedRecord, Reader } from './sources/type'

/**
 * Erase or anonymise a person on their erasure request (B-W2b-405; PLT-203; GDPR art. 17; design admin.privacy "Anonymise …?":
 * what is erased, what stays because the law requires it, the decision is logged, a typed name):
 *
 *   GET  /privacy/requests/:requestId/erasure   the preview (privacy.requests.view): per record type what is anonymised,
 *                                               deleted and kept with why; whether something blocks it now
 *   POST /privacy/requests/:requestId/erase     the erasure (privacy.erase, a fresh code each time: a fixed LEGAL action):
 *                                               {version, reason, confirmName}; ONE command: one ErasureRecord per record
 *                                               looked at (column names, never values) FIRST, then every source's change (the
 *                                               database blanks a mail, a message or an audit row only with its record written
 *                                               in the same transaction: B-W2b-F54), the audit row with the reason,
 *                                               privacy.person_erased and privacy.request_changed ERASED. The request stays
 *                                               IN_PROGRESS: closing it (done) is its own step.
 *
 * Legal holds win: a record the law keeps is KEPT with why (sources/*.ts), the rest of the erasure runs. A block (a portal user
 * with the contact's e-mail, a person still employed, an open office account, a mail to them being sent right now) refuses the
 * whole erasure (409) in words.
 */

export interface PlanGroup {
  readonly recordType: string
  readonly method: ErasureMethod
  readonly count: number
  readonly erasedFields: string[]
  readonly keptFields: string[]
  readonly why: { readonly code: KeptWhy; readonly words: string } | null
}

async function planOf(db: Reader, person: PersonFacts, now: Date): Promise<PlannedRecord[]> {
  const planned: PlannedRecord[] = []
  for (const source of sourcesFor(person.kind)) planned.push(...(await source.plan(db, person, now)))
  return planned
}

function groupsOf(planned: readonly PlannedRecord[]): PlanGroup[] {
  const groups = new Map<string, { recordType: string; method: ErasureMethod; count: number; erasedFields: Set<string>; keptFields: Set<string>; why: KeptWhy | null }>()
  for (const record of planned) {
    const key = `${record.recordType}|${record.method}|${record.why ?? ''}`
    const group = groups.get(key) ?? { recordType: record.recordType, method: record.method, count: 0, erasedFields: new Set<string>(), keptFields: new Set<string>(), why: record.why }
    group.count += 1
    for (const field of record.erasedFields) group.erasedFields.add(field)
    for (const field of record.keptFields) group.keptFields.add(field)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({ ...group, erasedFields: [...group.erasedFields], keptFields: [...group.keptFields], why: group.why ? { code: group.why, words: KEPT_WHY_WORDS[group.why] } : null }))
}

const blockedView = (code: ErasureBlocked | null) => (code ? { code, words: ERASURE_BLOCKED_WORDS[code] } : null)

function blockedError(code: ErasureBlocked): DomainError {
  return new DomainError('conflict', ERASURE_BLOCKED_WORDS[code], [{ path: `privacy/${code}`, message: ERASURE_BLOCKED_WORDS[code] }])
}

async function personOf(db: Reader, request: Pick<RequestRow, 'personKind' | 'personRecordType' | 'personRecordId'>): Promise<PersonFacts> {
  const person = await personFacts(db, request.personKind as DataSubjectKind, request.personRecordType, request.personRecordId)
  if (!person) throw new InvalidStateError("The person's record is no longer there: nothing to erase.")
  return person
}

/** What blocks the erasure now: the person's own block, or a mail to them being sent this minute (B-W2b-F54). */
async function blockOf(db: Reader, person: PersonFacts, now: Date): Promise<ErasureBlocked | null> {
  return person.blocked ?? ((await mailSendingNow(db, person, now)) ? 'MAIL_SENDING' : null)
}

/** GET /privacy/requests/:requestId/erasure */
export async function erasurePreview(caller: CommandCaller, requestId: string, now: Date) {
  const { request } = await readRequest(caller, requestId, PRIVACY_REQUESTS_VIEW)
  if (request.kind !== 'ERASURE') throw new InvalidStateError(REQUEST_HELD_WORDS.NOT_ERASURE)
  return caller.withClient(async (client) => {
    const person = await personOf(client, request)
    const planned = await planOf(client, person, now)
    const groups = groupsOf(planned)
    const tooMany = planned.length > ERASURE_LIMITS.records
    const done = await client.erasureRecord.count({ where: { dataRequestId: request.id } })
    const action = actionsOf(request, done, now).erase
    return {
      person: { kind: person.kind, recordType: person.recordType, recordId: person.recordId, name: person.name, erased: person.erased },
      blocked: blockedView((await blockOf(client, person, now)) ?? (tooMany ? 'TOO_MANY' : null)),
      anonymised: groups.filter((group) => group.method === 'ANONYMISED'),
      deleted: groups.filter((group) => group.method === 'DELETED'),
      kept: groups.filter((group) => group.method === 'KEPT'),
      records: planned.length,
      action,
    }
  })
}

export interface EraseBody {
  readonly version: number
  readonly reason: string
  readonly confirmName: string
}

/** POST /privacy/requests/:requestId/erase */
export async function erasePerson(caller: CommandCaller, requestId: string, body: EraseBody, writes: { readonly stepUp: () => void; readonly idempotencyKey?: string | undefined; readonly now: Date }) {
  const { context, request } = await readRequest(caller, requestId, PRIVACY_ERASE)
  const done = await caller.withClient((client) => client.erasureRecord.count({ where: { dataRequestId: request.id } }))
  const action = actionsOf(request, done, writes.now).erase
  if (!action.allowed) throw new InvalidStateError(action.held!.words)
  const person = await caller.withClient((client) => personOf(client, request))
  const blocked = await caller.withClient((client) => blockOf(client, person, writes.now))
  if (blocked) throw blockedError(blocked)
  refuse([eraseReasonProblem(body.reason), confirmNameProblem(body.confirmName, person.name)].filter((issue) => issue !== null), 'The erasure needs its reason and the typed name.')
  // GDPR art. 17 is a decision in the company's name: a fresh code every time (step-up-actions.ts: a fixed LEGAL action).
  writes.stepUp()
  const { result } = await command(
    caller,
    { name: 'privacy.erase', idempotencyKey: writes.idempotencyKey, input: { requestId, version: body.version, reason: body.reason }, record: { type: 'DataRequest', id: requestId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      // Planned again inside the transaction: what is erased is what the records hold now.
      const current = await personOf(tx, request)
      const block = await blockOf(tx, current, now)
      if (block) throw blockedError(block)
      const planned = await planOf(tx, current, now)
      if (planned.length > ERASURE_LIMITS.records) throw blockedError('TOO_MANY')
      // Every ErasureRecord first: the database's door blanks a mail, a message or an audit row only with its record written in
      // this same transaction (B-W2b-F54).
      const records = planned.map((record) => ({
        id: newId(),
        companyId: request.companyId,
        dataRequestId: request.id,
        recordType: record.recordType,
        recordId: record.recordId,
        method: record.method,
        erasedFields: [...record.erasedFields],
        keptFields: [...record.keptFields],
        keptWhy: record.why ? KEPT_WHY_WORDS[record.why] : null,
        erasedAt: now,
        erasedById: context.actorId,
      }))
      await tx.erasureRecord.createMany({ data: records })
      for (const [index, record] of planned.entries()) await record.apply?.({ tx, now, actorId: context.actorId, erasureId: records[index]!.id, emit: tools.emit })
      const counts = { anonymised: planned.filter((record) => record.method === 'ANONYMISED').length, deleted: planned.filter((record) => record.method === 'DELETED').length, kept: planned.filter((record) => record.method === 'KEPT').length }
      // The decision is logged: what was asked (the reason, without the person's details), by whom, and what happened (counts).
      tools.audit({ recordType: 'DataRequest', recordId: request.id, companyId: request.companyId, after: { erasedAt: toUtcIso(now), personKind: request.personKind, ...counts, groups: groupsOf(planned).map((group) => ({ recordType: group.recordType, method: group.method, count: group.count, why: group.why?.code ?? null })) }, reason: body.reason.trim() })
      tools.emit({ type: 'privacy.person_erased', subject: request.id, companyId: request.companyId, payload: { requestId: request.id, companyId: request.companyId, personKind: request.personKind, ...counts } })
      tools.emit({ type: 'privacy.request_changed', subject: request.id, companyId: request.companyId, payload: { requestId: request.id, companyId: request.companyId, kind: request.kind, personKind: request.personKind, status: request.status, change: 'ERASED' } })
      return counts
    },
  )
  return { request: await requestAnswer(caller, request.id, writes.now), erased: result }
}
