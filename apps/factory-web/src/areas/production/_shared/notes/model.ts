import { isApiError, issuePath } from '../../../../lib/api/errors'
import { mentionsIn, type MentionPerson } from '../../../../lib/record-thread/helpers/model'
import type { NoteCheck, NoteDraftBody, NoteRecordType, NotesWritten } from './api'

/**
 * F-PR-22 — "Ask the supervisor" and "Note to N" without a screen (production plan §1 "Ask the supervisor / Note to N", §3 "Note to N
 * / Ask the supervisor — threads.post on each record"; lead picks L23, R-47, R-54, R-55; the Owner's point N4: "mention him to address
 * a specific issue … for that order or multiple orders at once"). ONE dialog for the work order band (Ask the supervisor, the supervisor
 * fact's Ask) and Work orders (a row's ⋯, and "Note to N…" on a selection, up to 100): it names the records, writes on each work order
 * or on their sales orders, the text with @ (the threads MentionInput, B-TH-208) and "Each record's supervisor" ticked, "Needs an
 * answer" (B-PR-43b: a task for each record's supervisor, due at raise + 1 working day). Before Send the check route (B-PR-43a `POST
 * /production/notes/check`) names who cannot read some records, the customers, and the records whose text names ANOTHER customer —
 * Send is held then until the text changes or "This text names no other customer" is ticked (R-47). Send writes one office note in
 * each record's own thread (`POST /production/notes`); then one result per record — a record the API did not name to this reader is
 * counted, never named (PW-13). The box is the threads kit's yellow Office note: never shown to a customer.
 *
 * Pure: no React, no API. The API's English (`why`) is said from its code; the sentences are pinned by a test against the domain.
 */

/** The catalogue of these words (`messages/<locale>/production-notes.json`). */
export const NOTES_NS = 'production-notes'

/** factory-domain production-brand/notes NOTE_RECORDS_MAX (a test holds them equal: the domain file reads node's crypto). */
export const NOTE_RECORDS_MAX = 100
/** factory-domain threads/rules MAX_BODY_LENGTH (the DS counter's limit; a test holds them equal). */
export const NOTE_BODY_MAX = 20_000
/** At most this many people reads for the @ list (one per customer and company of the records). */
export const PEOPLE_READS_MAX = 6

/** A record a note may be written on, as the screen knows it. */
export interface NoteRecord {
  readonly type: NoteRecordType
  readonly id: string
  readonly label: string
  /** Its customer (null: a work order of several customers made before the rule, or of none). */
  readonly partyId: string | null
  /** The customer's name (with parties.view) or its code; null with no customer. */
  readonly partyName: string | null
  readonly companyId: string
}

/** What the dialog was opened over: the work orders, and their sales orders (each once). */
export interface NoteTargets {
  readonly workOrders: readonly NoteRecord[]
  readonly salesOrders: readonly NoteRecord[]
  /** Work orders that make no sales order (a sample): they have no order to write on. */
  readonly withoutOrder: number
}

/** Write on each work order, or on their sales orders. */
export type WriteOn = 'workOrders' | 'salesOrders'
/** Where it was opened: the band's Ask the supervisor, a row's ⋯, a selection's "Note to N…". */
export type NoteFrom = 'band' | 'row' | 'selection'

interface RowLike {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly customer?: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly orders: readonly { readonly id: string; readonly number: string }[]
}

/** The records of a Work orders selection (or one row): each work order, and each of their sales orders once, in the list's order. */
export function targetsOfRows(rows: readonly RowLike[], names: boolean): NoteTargets {
  const seen = new Set<string>()
  const salesOrders: NoteRecord[] = []
  let withoutOrder = 0
  const workOrders = rows.map((row): NoteRecord => {
    const customer = row.customer ?? null
    const partyName = customer ? (names ? customer.name : customer.code) : null
    if (row.orders.length === 0) withoutOrder++
    for (const order of row.orders) {
      if (seen.has(order.id)) continue
      seen.add(order.id)
      salesOrders.push({ type: 'SalesOrder', id: order.id, label: order.number, partyId: customer?.id ?? null, partyName, companyId: row.companyId })
    }
    return { type: 'WorkOrder', id: row.id, label: row.number, partyId: customer?.id ?? null, partyName, companyId: row.companyId }
  })
  return { workOrders, salesOrders, withoutOrder }
}

interface RecordLike {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly partyId?: string | null
  readonly customer?: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly orders: readonly { readonly id: string; readonly number: string; readonly partyId: string; readonly partyName: string }[]
}

/** The records of one work order (the band's Ask the supervisor): the work order, and its sales orders once. */
export function targetsOfRecord(record: RecordLike, names: boolean): NoteTargets {
  const customer = record.customer ?? null
  const seen = new Set<string>()
  const salesOrders = record.orders.flatMap((order): NoteRecord[] => {
    if (seen.has(order.id)) return []
    seen.add(order.id)
    return [{ type: 'SalesOrder', id: order.id, label: order.number, partyId: order.partyId, partyName: order.partyName, companyId: record.companyId }]
  })
  return {
    workOrders: [{ type: 'WorkOrder', id: record.id, label: record.number, partyId: record.partyId ?? customer?.id ?? null, partyName: customer ? (names ? customer.name : customer.code) : null, companyId: record.companyId }],
    salesOrders,
    withoutOrder: record.orders.length === 0 ? 1 : 0,
  }
}

/** The records a note is written on now. */
export const recordsOf = (targets: NoteTargets, on: WriteOn): readonly NoteRecord[] => (on === 'salesOrders' ? targets.salesOrders : targets.workOrders)

/** The customers of these records, as far as the screen knows them (the check route's count is the server's). */
export function customersOf(records: readonly NoteRecord[]): { readonly count: number; readonly name: string | null } {
  const parties = new Map<string, string | null>()
  for (const record of records) if (record.partyId) parties.set(record.partyId, record.partyName)
  return { count: parties.size, name: parties.size === 1 ? ([...parties.values()][0] ?? null) : null }
}

// ── the @ list ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The records whose people the @ list reads (GET /threads/<type>/<id>/people): one per customer and company of the records — the
 * people who may read a record depend on its customer and company — at most PEOPLE_READS_MAX; `complete` false when some groups were
 * not read (a name may then be missing from @; the check route still names, per record, who cannot read it).
 */
export function peopleSources(records: readonly NoteRecord[]): { readonly sources: readonly NoteRecord[]; readonly complete: boolean } {
  const first = new Map<string, NoteRecord>()
  for (const record of records) {
    const key = `${record.companyId}|${record.partyId ?? '-'}`
    if (!first.has(key)) first.set(key, record)
  }
  const sources = [...first.values()]
  return { sources: sources.slice(0, PEOPLE_READS_MAX), complete: sources.length <= PEOPLE_READS_MAX }
}

/** The people of several records' lists, each once (the first tag kept: "Supervisor"), tagged first, then by name. */
export function mergePeople(lists: readonly (readonly { readonly id: string; readonly name: string; readonly tag?: string | null | undefined }[])[]): MentionPerson[] {
  const byId = new Map<string, MentionPerson>()
  for (const list of lists) {
    for (const person of list) {
      const known = byId.get(person.id)
      if (!known) byId.set(person.id, { id: person.id, name: person.name, ...(person.tag ? { tag: person.tag } : {}) })
      else if (!known.tag && person.tag) byId.set(person.id, { ...known, tag: person.tag })
    }
  }
  return [...byId.values()].sort((a, b) => Number(Boolean(b.tag)) - Number(Boolean(a.tag)) || a.name.localeCompare(b.name))
}

// ── the draft ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NoteDraft {
  readonly on: WriteOn
  readonly body: string
  /** "Each record's supervisor": each record's own production supervisor is mentioned on its note (ticked by default). */
  readonly askSupervisor: boolean
  /** "Needs an answer": a question (a task for each record's supervisor, due at raise + 1 working day). */
  readonly needsAnswer: boolean
  /** "This text names no other customer": the writer confirms the text the check found another customer's name in (R-47). */
  readonly namesNoOtherCustomer: boolean
}

export const NEW_DRAFT: NoteDraft = Object.freeze({ on: 'workOrders', body: '', askSupervisor: true, needsAnswer: false, namesNoOtherCustomer: false })

/** A change of the draft: a new text takes the tick away (it confirmed the text that was there, R-47). */
export function draftAfter(draft: NoteDraft, next: Partial<NoteDraft>): NoteDraft {
  const changed = { ...draft, ...next }
  return next.body !== undefined && next.body !== draft.body && next.namesNoOtherCustomer === undefined ? { ...changed, namesNoOtherCustomer: false } : changed
}

/** The body the check and the write take (the same for both): the records, the text, its @mentions (readers of the list only). */
export function bodyOf(targets: NoteTargets, draft: NoteDraft, people: readonly MentionPerson[]): NoteDraftBody {
  return {
    records: recordsOf(targets, draft.on).map((record) => ({ type: record.type, id: record.id })),
    body: draft.body,
    mentions: mentionsIn(draft.body, people),
    askSupervisor: draft.askSupervisor,
    needsAnswer: draft.needsAnswer,
    namesNoOtherCustomer: draft.namesNoOtherCustomer,
  }
}

/** One draft's key: a check or a write answers the draft of the same key only. */
export const draftKeyOf = (body: NoteDraftBody): string => JSON.stringify(body)

// ── the check ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type CheckState =
  | { readonly status: 'idle' }
  /** `previous`: the last answer (of an earlier draft), still drawn while this one is checked — Send waits all the same. */
  | { readonly status: 'checking'; readonly key: string; readonly previous?: NoteCheck | undefined }
  | { readonly status: 'ready'; readonly key: string; readonly answer: NoteCheck }
  | { readonly status: 'failed'; readonly key: string }

/** The last answer a state holds (a ready one, or the one before a check in flight). */
export const lastAnswerOf = (check: CheckState): NoteCheck | undefined => (check.status === 'ready' ? check.answer : check.status === 'checking' ? check.previous : undefined)

/** The check of THIS draft (an answer for another draft is no answer yet: "checking", the last answer kept to draw). */
export function checkOf(check: CheckState, key: string): CheckState {
  if (check.status === 'idle') return check
  return check.key === key ? check : { status: 'checking', key, previous: lastAnswerOf(check) }
}

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const labels = (records: readonly { readonly label: string }[]): string => records.map((record) => record.label).join(', ')

/** What the check says before Send, as phrases (the dialog draws them in this order). */
export interface CheckLines {
  /** "Dora Campione cannot read 2 of 12: not mentioned there (WO-0311, WO-0305). The note is still written." */
  readonly people: readonly Phrase[]
  /** "These records belong to 2 customers. Office notes never reach a customer." (null: one customer, or none) */
  readonly customers: Phrase | null
  readonly notWritable: Phrase | null
  readonly unknown: Phrase | null
  readonly noSupervisor: Phrase | null
  readonly noIssue: Phrase | null
  /** The records whose text names another customer (with the names the writer may know); null: none. */
  readonly namesOther: { readonly lead: Phrase; readonly records: readonly Phrase[] } | null
}

export function checkLines(answer: NoteCheck, draft: Pick<NoteDraft, 'askSupervisor' | 'needsAnswer'>): CheckLines {
  const writable = answer.records.filter((record) => record.canWrite)
  const blocked = answer.records.filter((record) => !record.canWrite)
  return {
    people: answer.people.filter((person) => person.cannotRead.length > 0).map((person) => ({ key: 'check.cannotRead', params: { name: person.name, count: person.cannotRead.length, of: writable.length, records: labels(person.cannotRead) } })),
    customers: answer.customers > 1 ? { key: 'check.customers', params: { count: answer.customers } } : null,
    notWritable: blocked.length > 0 ? { key: 'check.notWritable', params: { records: labels(blocked) } } : null,
    unknown: answer.unknown > 0 ? { key: 'check.unknown', params: { count: answer.unknown } } : null,
    noSupervisor: answer.noSupervisor.length > 0 && (draft.askSupervisor || draft.needsAnswer) ? { key: draft.needsAnswer ? 'check.noSupervisorTask' : 'check.noSupervisor', params: { records: labels(answer.noSupervisor) } } : null,
    noIssue: draft.needsAnswer && answer.noIssue.length > 0 ? { key: 'check.noIssue', params: { records: labels(answer.noIssue) } } : null,
    namesOther:
      answer.namesOtherCustomer.length > 0
        ? {
            lead: { key: 'check.namesOther', params: { records: labels(answer.namesOtherCustomer) } },
            records: answer.namesOtherCustomer.filter((record) => record.names.length > 0).map((record) => ({ key: 'check.namesOtherNamed', params: { record: record.label, names: record.names.join(', ') } })),
          }
        : null,
  }
}

// ── why Send waits ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HeldInput {
  /** threads.post (the session's): every office person who may read those records may write on them. */
  readonly can: boolean
  readonly records: number
  readonly body: string
  readonly offline: boolean
  readonly busy: boolean
  /** The check of THIS draft (checkOf). */
  readonly check: CheckState
}

/** Why Send waits (a phrase of this catalogue), or null: it may go. */
export function sendHeld(input: HeldInput): Phrase | null {
  if (!input.can) return { key: 'held.noRight' }
  if (input.records === 0) return { key: 'held.noRecords' }
  if (input.records > NOTE_RECORDS_MAX) return { key: 'held.tooMany', params: { count: input.records, max: NOTE_RECORDS_MAX } }
  if (input.body.trim() === '') return { key: 'held.empty' }
  if (input.offline) return { key: 'held.offline' }
  if (input.busy) return { key: 'held.busy' }
  if (input.check.status === 'failed') return { key: 'held.checkFailed' }
  if (input.check.status !== 'ready') return { key: 'held.checking' }
  if (!input.check.answer.records.some((record) => record.canWrite)) return { key: 'held.noneWritable' }
  if (input.check.answer.held) return { key: 'held.namesOther' }
  return null
}

/** Why "Note to N…" / Ask the supervisor waits before the dialog opens (a phrase), or null. */
export function openHeld(can: boolean, count: number): Phrase | null {
  if (!can) return { key: 'held.noRight' }
  if (count === 0) return { key: 'held.noRecords' }
  if (count > NOTE_RECORDS_MAX) return { key: 'held.tooMany', params: { count, max: NOTE_RECORDS_MAX } }
  return null
}

/** Why "their sales orders" cannot be picked (a phrase), or null. */
export function salesOrdersHeld(targets: NoteTargets): Phrase | null {
  if (targets.salesOrders.length === 0) return { key: 'on.noOrder' }
  if (targets.salesOrders.length > NOTE_RECORDS_MAX) return { key: 'on.tooMany', params: { count: targets.salesOrders.length, max: NOTE_RECORDS_MAX } }
  return null
}

// ── after Send ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The sentences only the API's and the domain's files hold (factory-domain production-brand/notes NOTE_WORDS, issues ISSUE_WORDS):
 * the answer's `why` is their English; a test finds each one there. Never drawn: the screen says its own words from the code.
 */
export const API_SENTENCES = Object.freeze({
  CANNOT_POST: 'Your role does not write notes on this record.',
  THREAD_CLOSED: "This record's thread is closed: reopen it to write a note.",
  NOT_A_PERSON: 'Not an active person of the office.',
  NO_CUSTOMER: 'A work order of several customers or of none raises no issue: its note is written without one.',
})

const SKIP_KEYS: Readonly<Record<string, string>> = Object.freeze({ [API_SENTENCES.CANNOT_POST]: 'skip.CANNOT_POST', [API_SENTENCES.THREAD_CLOSED]: 'skip.THREAD_CLOSED' })
export const skipKeyOf = (why: string): string => SKIP_KEYS[why] ?? 'skip.other'
export const notRaisedKeyOf = (why: string): string => (why === API_SENTENCES.NO_CUSTOMER ? 'issue.noCustomer' : 'issue.other')

export type ResultLine =
  | { readonly key: string; readonly label: string; readonly state: 'written'; readonly mentioned: number; readonly supervisorAsked: boolean; readonly issue: boolean }
  | { readonly key: string; readonly label: string; readonly state: 'skipped'; readonly why: string }

export interface NoteResult {
  /** One line per record the API named to this reader, in the dialog's order. */
  readonly lines: readonly ResultLine[]
  readonly written: number
  /** Records the API did not name to this reader: counted, never named (PW-13). */
  readonly unknown: number
  /** Each person left out of some notes (they cannot read those records). */
  readonly notMentioned: readonly Phrase[]
  /** "Needs an answer": the tasks made (on which record, for how many, given or not yet) and the records that raised none. */
  readonly tasks: readonly Phrase[]
  readonly notRaised: readonly Phrase[]
}

const refKey = (record: { readonly type: string; readonly id: string }): string => `${record.type}:${record.id}`

/** The answer as one line per record, in the order the dialog named them; a record the answer does not name is only counted. */
export function resultOf(answer: NotesWritten, records: readonly NoteRecord[], names: ReadonlyMap<string, string>): NoteResult {
  const written = new Map(answer.written.map((entry) => [refKey(entry), entry]))
  const skipped = new Map(answer.skipped.map((entry) => [refKey(entry), entry]))
  const lines: ResultLine[] = []
  let missing = 0
  for (const record of records) {
    const key = refKey(record)
    const done = written.get(key)
    const left = skipped.get(key)
    if (done) lines.push({ key, label: done.label, state: 'written', mentioned: done.mentioned.length, supervisorAsked: done.supervisorAsked, issue: done.issueId !== null })
    else if (left) lines.push({ key, label: left.label, state: 'skipped', why: skipKeyOf(left.why) })
    else missing++
  }
  return {
    lines,
    written: answer.written.length,
    unknown: Math.max(answer.unknown, missing),
    notMentioned: answer.notMentioned.map((entry) => ({ key: 'result.notMentioned', params: { name: names.get(entry.userId) ?? '—', records: labels(entry.records) } })),
    tasks: (answer.issues?.tasks ?? []).map((task) => ({ key: task.assigned ? 'result.taskAssigned' : 'result.taskNobody', params: { record: task.label, count: task.records } })),
    notRaised: (answer.issues?.notRaised ?? []).map((entry) => ({ key: 'result.notRaised', params: { record: entry.label, why: notRaisedKeyOf(entry.why) } })),
  }
}

/** A refused Send, in words: the text names another customer (409: the check is read again), none found, no right, a mention, else. */
export function writeProblemOf(error: unknown): { readonly key: string; readonly recheck: boolean } {
  if (!isApiError(error)) return { key: 'problem.failed', recheck: false }
  if (error.kind === 'conflict' && error.issues.some((issue) => issuePath(issue).replace(/\./g, '/') === 'refusal/NAMES_OTHER_CUSTOMER')) return { key: 'problem.namesOther', recheck: true }
  if (error.kind === 'not_found') return { key: 'problem.noneFound', recheck: false }
  if (error.kind === 'forbidden') return { key: 'problem.cannotPost', recheck: false }
  if (error.kind === 'invalid') return { key: error.issues.some((issue) => issue.message === API_SENTENCES.NOT_A_PERSON) ? 'problem.notAPerson' : 'problem.invalid', recheck: false }
  if (error.kind === 'unavailable') return { key: 'problem.offline', recheck: false }
  return { key: 'problem.failed', recheck: false }
}

// ── the dialog's model ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PeopleState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly people: readonly MentionPerson[]; readonly complete: boolean } | { readonly status: 'error' }

export interface NoteDialogModel {
  readonly from: NoteFrom
  readonly targets: NoteTargets
  readonly draft: NoteDraft
  readonly people: PeopleState
  /** The check of the draft as it stands (checkOf: an answer of another draft is "checking"). */
  readonly check: CheckState
  readonly offline: boolean
  readonly busy: boolean
  /** threads.post. */
  readonly can: boolean
  /** A refused Send (a key of this catalogue); the text stays. */
  readonly problem: string | null
  readonly result: NoteResult | null
}

export interface NoteDialogActions {
  readonly onDraft?: (next: Partial<NoteDraft>) => void
  readonly onSend?: () => void
  readonly onRetryCheck?: () => void
  readonly onRetryPeople?: () => void
  readonly onClose?: () => void
}

/** The dialog's title: Ask the supervisor (the band), or the office note on N records of the kind written on. */
export function titleOf(model: Pick<NoteDialogModel, 'from' | 'targets' | 'draft'>): Phrase {
  const records = recordsOf(model.targets, model.draft.on)
  if (model.from === 'band') return { key: 'title.ask', params: { number: model.targets.workOrders[0]?.label ?? '' } }
  if (records.length === 1) return { key: 'title.one', params: { number: records[0]!.label } }
  return { key: model.draft.on === 'salesOrders' ? 'title.salesOrders' : 'title.workOrders', params: { count: records.length } }
}
