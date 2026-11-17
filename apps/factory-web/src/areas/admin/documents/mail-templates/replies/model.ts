import { REPLY_LIMITS, REPLY_RECORD_TYPES, replyPlaceholdersOf, type ReplyRecordType } from '@nexus/factory-domain/templates/replies'
import { fillPlaceholders, type PlaceholderValues } from '@nexus/factory-domain/templates/placeholders'
import type { CompanyChoice, ListNotice, ListRead } from '../../doc-templates/model'
import { wordProblems, type Said } from '../../template-editor/model'
import type { SavedRepliesAnswer, SavedReply, SavedReplyBody } from './api'

/**
 * B-TH-279 — Admin › Documents › E-mail templates › Saved replies (threads plan TH-6, O-ADM-MAILTPL.replies-F01; back end B-W2b-422's
 * saved replies and B-TH-046's requests), pure: the messages a person writes again and again — a delay notice, a question about a
 * request, a certificate sent — per language (Italian and English today: decision C17) and per kind of record (or any), a person's
 * own or shared with the office. This view keeps them; the send panel and the thread only pick one, fill it with the record's
 * values and let the person change it before sending: a saved reply sends nothing.
 *
 * Who may do what (the API decides; the screen says it before the click): email.send keeps one's own and uses the shared ones;
 * email.replies.share writes, changes and deletes the shared ones (`mayShare` of the list, `mayChange` of each reply). A shared
 * reply is shown to everyone who writes mail for its company, by name, with nobody's private replies (each person sees only
 * their own and the shared ones). Placeholders are the record's own names (factory-domain templates/replies REPLY_PLACEHOLDERS);
 * the preview fills them with made-up values here — never a real customer, never a record.
 */

/** The languages a saved reply is written in (C17: "Italian · English", never "in their language"). */
export const REPLY_LANGUAGES = ['it', 'en'] as const
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number]

/** The record kinds a reply may be for, then ANY (a reply for any record). */
export const RECORD_CHOICES = [...REPLY_RECORD_TYPES, 'ANY'] as const
export type RecordChoice = (typeof RECORD_CHOICES)[number]

/** The E-mail templates section's two parts: the mails Nexus sends by itself, and the saved replies people send. */
export const MAIL_PARTS = ['templates', 'replies'] as const
export type MailPart = (typeof MAIL_PARTS)[number]
export const mailPartOf = (params: { get(name: string): string | null } | null): MailPart => (params?.get('part') === 'replies' ? 'replies' : 'templates')

export interface RepliesFilter {
  readonly language: ReplyLanguage | null
  readonly record: RecordChoice | null
  readonly q: string
}

export const NO_FILTER: RepliesFilter = { language: null, record: null, q: '' }

/** A reply as typed in the editor: a new one (no id), or a change of one read at its version. */
export interface ReplyDraft {
  readonly id: string | null
  readonly version: number | null
  readonly name: string
  readonly language: ReplyLanguage
  readonly record: RecordChoice
  readonly shared: boolean
  readonly body: string
}

export interface SavedRepliesModel {
  prefix: string
  companies: readonly CompanyChoice[]
  companyId: string | null
  read: ListRead<SavedRepliesAnswer>
  /** The reader writes mail (email.send): may keep their own; without it the list is read only and says why. */
  mayWrite: boolean
  filter?: RepliesFilter
  selected?: readonly string[]
  /** The editor open (a new reply or a change), and why its last save was refused. */
  editor?: { draft: ReplyDraft; problem: Said | null } | null
  /** Delete N? (the replies the reader may change among the selected). */
  confirm?: { rows: readonly SavedReply[] } | null
  busy?: boolean
  notice?: ListNotice | null
  asOf?: string | null
  updates?: number
}

const recordOf = (type: string | null): RecordChoice => ((REPLY_RECORD_TYPES as readonly string[]).includes(type ?? '') ? (type as ReplyRecordType) : 'ANY')
const typeOf = (record: RecordChoice): ReplyRecordType | null => (record === 'ANY' ? null : record)
const languageOf = (language: string): ReplyLanguage => (language === 'en' ? 'en' : 'it')

/** The rows of the filter: a language, a kind of record (ANY = the replies for any record), a search in the name and the words. */
export function replyRowsOf(answer: SavedRepliesAnswer | null, filter: RepliesFilter = NO_FILTER): SavedReply[] {
  if (!answer) return []
  const q = filter.q.trim().toLowerCase()
  return answer.replies
    .filter((reply) => (filter.language ? reply.language === filter.language : true))
    .filter((reply) => (filter.record ? recordOf(reply.recordType) === filter.record : true))
    .filter((reply) => (q ? reply.name.toLowerCase().includes(q) || reply.body.toLowerCase().includes(q) : true))
    .sort((a, b) => Number(b.shared) - Number(a.shared) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** "Shared with the office" or "Yours" (a person's own replies are never anyone else's to see). */
export const whoseKey = (reply: Pick<SavedReply, 'shared'>): string => (reply.shared ? 'tpl.replies.whose.shared' : 'tpl.replies.whose.own')

/** The kind of record in words (`tpl.replies.record.Inquiry` = "A request (Sales › Incoming)"). */
export const recordKey = (type: string | null): string => `tpl.replies.record.${recordOf(type)}`

/** A new reply: the filter's language and record when one is chosen; own unless the reader keeps the shared ones and asks. */
export const newDraft = (filter: RepliesFilter = NO_FILTER, shared = false): ReplyDraft => ({ id: null, version: null, name: '', language: filter.language ?? 'it', record: filter.record ?? 'Inquiry', shared, body: '' })

export const draftOf = (reply: SavedReply): ReplyDraft => ({ id: reply.id, version: reply.version, name: reply.name, language: languageOf(reply.language), record: recordOf(reply.recordType), shared: reply.shared, body: reply.body })

/** The placeholders a reply for this record may use (the record's own names, then those every record fills). */
export const placeholdersFor = (record: RecordChoice): readonly string[] => replyPlaceholdersOf(typeOf(record))

/** The problems of a draft, by field: the name (one line, 1 to 120), the words (not empty, the limit, the placeholders offered). */
export function draftProblems(draft: ReplyDraft): { name: Said[]; body: Said[] } {
  const name = draft.name.trim()
  const nameProblems: Said[] = name === '' || name.length > REPLY_LIMITS.name || /[\r\n]/.test(draft.name) ? [{ key: 'tpl.replies.problem.name', params: { limit: REPLY_LIMITS.name } }] : []
  const bodyProblems: Said[] = draft.body.trim() === '' ? [{ key: 'tpl.replies.problem.body' }] : wordProblems(draft.body, REPLY_LIMITS.body, placeholdersFor(draft.record))
  return { name: nameProblems, body: bodyProblems }
}

const hasProblems = (draft: ReplyDraft): boolean => {
  const problems = draftProblems(draft)
  return problems.name.length + problems.body.length > 0
}

/** What a save sends: a new reply whole; a change only what changed (null: nothing changed). */
export function draftBody(reply: SavedReply | null, draft: ReplyDraft, companyId: string | null): (SavedReplyBody & { shared: boolean }) | Partial<SavedReplyBody> | null {
  const words: SavedReplyBody = { name: draft.name.trim(), language: draft.language, body: draft.body.replace(/\r\n?/g, '\n').trim(), recordType: typeOf(draft.record), companyId: reply ? reply.companyId : companyId }
  if (!reply) return { ...words, shared: draft.shared }
  const changed: Partial<SavedReplyBody> = {}
  if (words.name !== reply.name) changed.name = words.name
  if (words.language !== reply.language) changed.language = words.language
  if (words.body !== reply.body) changed.body = words.body
  if (words.recordType !== reply.recordType) changed.recordType = words.recordType
  return Object.keys(changed).length > 0 ? changed : null
}

/** Why Save waits (the right first, then a shared reply without the share right, busy, the words' problems, nothing changed), or null. */
export function saveHeld(state: { reply: SavedReply | null; draft: ReplyDraft; mayWrite: boolean; mayShare: boolean; busy: boolean; companyId: string | null }): string | null {
  if (!state.mayWrite) return 'tpl.replies.held.noRight'
  if (state.reply && !state.reply.mayChange) return state.reply.shared ? 'tpl.replies.held.sharedNoRight' : 'tpl.replies.held.notYours'
  if (!state.reply && state.draft.shared && !state.mayShare) return 'tpl.replies.held.share'
  if (state.busy) return 'tpl.held.busy'
  if (hasProblems(state.draft)) return 'tpl.held.problems'
  if (state.reply && draftBody(state.reply, state.draft, state.companyId) === null) return 'tpl.held.nothingChanged'
  return null
}

/** The replies of a selection a person may delete (their own; a shared one with the share right): the rest are left out, said. */
export function deleteReach(rows: readonly SavedReply[]): { applies: SavedReply[]; left: number } {
  const applies = rows.filter((reply) => reply.mayChange)
  return { applies, left: rows.length - applies.length }
}

/** A row that cannot be ticked, in words (null: it can). */
export const replyRowHeld = (reply: Pick<SavedReply, 'mayChange' | 'shared'>): string | null => (reply.mayChange ? null : reply.shared ? 'tpl.replies.held.sharedNoRight' : 'tpl.replies.held.notYours')

/** Made-up values of a sample record for the preview, per language (never a real customer, order or person). */
export const SAMPLE_VALUES: Readonly<Record<ReplyLanguage, PlaceholderValues>> = Object.freeze({
  it: {
    'contact.name': 'Anna Esempio',
    'party.name': 'Cliente Esempio S.r.l.',
    'me.name': 'Lucia Esempio',
    today: '29/10/2026',
    'company.name': 'Fabbrica Demo',
    'company.legalName': 'Fabbrica Demo S.r.l.',
    'company.tradeName': 'Fabbrica Demo',
    'order.number': 'SO-2026-0042',
    'order.customerRef': 'PO-7781',
    'order.promiseDate': '20/11/2026',
    'order.deliveryDate': '18/11/2026',
    'quote.number': 'QT-2026-0017',
    'quote.validUntil': '30/11/2026',
    'case.number': 'SVC-2026-0042',
    'shipment.number': 'SH-2026-0031',
    'inquiry.number': 'INQ-2026-0007',
    'inquiry.subject': 'Giacca touring, 120 pezzi',
    'inquiry.wantedDate': '15/01/2027',
  },
  en: {
    'contact.name': 'Ann Example',
    'party.name': 'Example Customer Ltd',
    'me.name': 'Lucy Example',
    today: '29 Oct 2026',
    'company.name': 'Demo Factory',
    'company.legalName': 'Fabbrica Demo S.r.l.',
    'company.tradeName': 'Demo Factory',
    'order.number': 'SO-2026-0042',
    'order.customerRef': 'PO-7781',
    'order.promiseDate': '20 Nov 2026',
    'order.deliveryDate': '18 Nov 2026',
    'quote.number': 'QT-2026-0017',
    'quote.validUntil': '30 Nov 2026',
    'case.number': 'SVC-2026-0042',
    'shipment.number': 'SH-2026-0031',
    'inquiry.number': 'INQ-2026-0007',
    'inquiry.subject': 'Touring jacket, 120 pieces',
    'inquiry.wantedDate': '15 Jan 2027',
  },
})

/** The draft's words as a sample record fills them: only the placeholders its record offers (any other is left empty, as a record leaves it). */
export function replyPreview(draft: Pick<ReplyDraft, 'body' | 'language' | 'record'>): string {
  const offered = new Set(placeholdersFor(draft.record))
  const values = Object.fromEntries(Object.entries(SAMPLE_VALUES[draft.language]).filter(([name]) => offered.has(name)))
  return fillPlaceholders(draft.body, values)
}
