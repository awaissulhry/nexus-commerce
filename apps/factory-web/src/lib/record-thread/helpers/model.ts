/**
 * B-TH-208 — the composer's helpers (threads plan T8; features T8-F01, F02, F07): write faster and safer. The pure part of
 * MentionInput (the @ suggestions, the "cannot read this record" warning, tagged people first), the Saved replies menu
 * (the existing replies of GET /templates/replies, in the five message languages since th-backend-g step 3, shared and mine apart) and the draft kept on this
 * device until drafts live on the server (N6). No React, no API.
 *
 * B-TH-236: the amount field (B-TH-049) is helpers/amount.ts and view/AmountField.tsx. B-TH-287: drafts on the server (B-TH-092) are
 * composer/server-draft.ts, and saved replies come in the five languages written to a customer (B-TH-098: it, en, de, fr, es).
 * B-TH-289: "Remind me in 3 days if no answer" (B-TH-096) on a message to the customer — below.
 *
 * Brand wall (W08, W34): @ offers office people who may read the record only — never a customer's portal person and never
 * the floor; a saved reply is filled by the API from THIS record (the view sends only the reply's id), so its placeholders
 * never carry another customer's values.
 */

import { isMessageLanguage, MESSAGE_LANGUAGES, type MessageLanguage } from '@nexus/factory-domain/templates/message-languages' // th-backend-g step 3

// ── @mentions ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** factory-domain threads/rules.ts MAX_MENTIONS. */
export const MAX_MENTIONS = 20
/** At most this many suggestions under the @. */
export const SUGGESTIONS_MAX = 6

/**
 * A person a note may mention, as GET /threads/<type>/<id>/people gives them (readers of the record, office only), with
 * what a module may add: a `tag` ("Supervisor", shown beside the name; tagged people first — the production page's T7
 * supplies it through `registerMentionTagSource`).
 */
export interface MentionPerson {
  readonly id: string
  readonly name: string
  /** A small label beside the name; tagged people are listed first. */
  readonly tag?: string | null
  /** They may read this record (the API lists readers only: default true). One who cannot is warned, never mentioned silently. */
  readonly canRead?: boolean
  /** Who they are: only office people are offered (a portal person or a floor account never is). Default office. */
  readonly audience?: 'office' | 'partner' | 'floor'
  /** An inactive person is not offered. Default true. */
  readonly active?: boolean
}

/** The people @ may offer: office, active; tagged first (in the API's order inside each group). */
export function mentionCandidates(people: readonly MentionPerson[]): MentionPerson[] {
  const offered = people.filter((person) => (person.audience ?? 'office') === 'office' && person.active !== false && person.name.trim() !== '')
  return [...offered.filter((person) => person.tag), ...offered.filter((person) => !person.tag)]
}

/** The `@words` being typed just before the caret: up to three words of a name. */
const MENTION_TAIL = /(^|\s)@([^\s@]{0,40}(?: [^\s@]{0,40}){0,2})$/u

/** The @ word being typed before the caret, with where its @ sits; null when the caret is not in one. */
export function mentionAt(text: string, caret: number): { readonly query: string; readonly start: number } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  const match = MENTION_TAIL.exec(before)
  if (!match) return null
  return { query: match[2]!, start: match.index + match[1]!.length }
}

/** The people a typed @word may name (their name or a word of it starts with it): tagged first, at most six. */
export function mentionSuggestions(query: string, candidates: readonly MentionPerson[], chosen: readonly string[]): MentionPerson[] {
  const wanted = query.toLocaleLowerCase()
  return candidates
    .filter((person) => !chosen.includes(person.id))
    .filter((person) => {
      const name = person.name.toLocaleLowerCase()
      return name.startsWith(wanted) || name.split(/\s+/).some((part) => part.startsWith(wanted))
    })
    .slice(0, SUGGESTIONS_MAX)
}

/** The text with the @word before the caret replaced by `@Whole Name ` and the caret after it. */
export function completeMention(text: string, caret: number, person: Pick<MentionPerson, 'name'>): { readonly text: string; readonly caret: number } {
  const at = mentionAt(text, caret)
  if (!at) return { text, caret }
  const inserted = `@${person.name} `
  const next = `${text.slice(0, at.start)}${inserted}${text.slice(caret).replace(/^ /, '')}`
  return { text: next, caret: at.start + inserted.length }
}

/** The people a text mentions (`@Whole Name`, not part of a longer word), in the order they appear; readers only. */
export function mentionsIn(text: string, people: readonly MentionPerson[]): string[] {
  const lower = text.toLocaleLowerCase()
  const word = /[\p{L}\p{N}]/u
  const hits: { id: string; at: number; end: number }[] = []
  for (const person of people) {
    if (person.canRead === false) continue
    const name = person.name.trim().toLocaleLowerCase()
    if (!name) continue
    for (let at = lower.indexOf(`@${name}`); at >= 0; at = lower.indexOf(`@${name}`, at + 1)) {
      const before = at === 0 ? '' : lower[at - 1]!
      const after = lower[at + name.length + 1] ?? ''
      if ((before === '' || !word.test(before)) && (after === '' || !word.test(after))) hits.push({ id: person.id, at, end: at + name.length + 1 })
    }
  }
  const kept = hits.filter((hit) => !hits.some((other) => other !== hit && other.at === hit.at && other.end > hit.end))
  return [...new Set(kept.sort((a, b) => a.at - b.at).map((hit) => hit.id))].slice(0, MAX_MENTIONS)
}

/**
 * The warnings under the box: a typed @Name that is a person who cannot read the record, or that names nobody who can
 * ("they will not be told"), and more than the 20 mentions a note takes. A person is never mentioned silently.
 */
export function mentionWarnings(text: string, people: readonly MentionPerson[]): { readonly key: string; readonly params: Readonly<Record<string, string | number>> }[] {
  const warnings: { key: string; params: Record<string, string | number> }[] = []
  const lower = text.toLocaleLowerCase()
  for (const person of people) {
    if (person.canRead !== false) continue
    if (lower.includes(`@${person.name.toLocaleLowerCase()}`)) warnings.push({ key: 'mention.cannotRead', params: { name: person.name } })
  }
  const known = people.filter((person) => person.canRead !== false).map((person) => person.name.toLocaleLowerCase())
  const blocked = people.filter((person) => person.canRead === false).map((person) => person.name.toLocaleLowerCase())
  for (const match of text.matchAll(/(^|\s)@([\p{Lu}][\p{L}'-]*(?: [\p{Lu}][\p{L}'-]*){0,2})/gu)) {
    const typed = match[2]!
    const name = typed.toLocaleLowerCase()
    if (known.some((one) => one.startsWith(name) || name.startsWith(one)) || blocked.some((one) => name.startsWith(one))) continue
    warnings.push({ key: 'mention.nobody', params: { name: typed } })
  }
  if (new Set(mentionsInAll(text, people)).size > MAX_MENTIONS) warnings.push({ key: 'mention.tooMany', params: { max: MAX_MENTIONS } })
  return warnings
}

/** Every reader mentioned, without the 20 cap (to say "too many"). */
function mentionsInAll(text: string, people: readonly MentionPerson[]): string[] {
  const lower = text.toLocaleLowerCase()
  return people.filter((person) => person.canRead !== false && lower.includes(`@${person.name.toLocaleLowerCase()}`)).map((person) => person.id)
}

// ── saved replies ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The languages saved replies are written in. th-backend-g step 3 (B-TH-098 web half): the five message languages — Italian, English,
 * German, French, Spanish (factory-domain templates/message-languages MESSAGE_LANGUAGES); a person writes them (never translated).
 */
export const REPLY_LANGUAGES = MESSAGE_LANGUAGES
export type ReplyLanguage = MessageLanguage
export const isReplyLanguage = isMessageLanguage

/** th-backend-g step 3: the menu's lines of the replies read (GET /templates/replies), in the five languages (any other is left out). */
export function savedReplyLines(replies: readonly { id: string; name: string; language: string; shared: boolean }[]): SavedReplyLine[] {
  return replies.flatMap((reply) => (isReplyLanguage(reply.language) ? [{ id: reply.id, name: reply.name, language: reply.language, shared: reply.shared }] : []))
}
/** B-TH-287: a language code as the API answers it — one of the five, else null (a line in another language is not listed). */
export const replyLanguageOf = (value: string | null | undefined): ReplyLanguage | null => (isReplyLanguage(value) ? value : null)

/** A saved reply as the menu lists it (GET /templates/replies: name, language, shared or mine). Never its text. */
export interface SavedReplyLine {
  readonly id: string
  readonly name: string
  readonly language: ReplyLanguage
  readonly shared: boolean
}

export interface SavedRepliesModel {
  /** `notForThis`: the record kind has no saved replies yet (requests before N5). */
  readonly status: 'loading' | 'ready' | 'failed' | 'notForThis'
  readonly replies: readonly SavedReplyLine[]
  /** The language the customer reads (the recipient-language rule): its replies first. */
  readonly language: ReplyLanguage
  /** A reply is being filled with the record's values. */
  readonly filling?: boolean
  /** The placeholders the record had no value for (left for the person to fill), after a pick. */
  readonly missing?: readonly string[]
  /** Why picking is held now (offline, sending), in words, or null. */
  readonly held?: string | null
}

/** The menu's groups: shared with the office first, then mine; in each, the customer's language first, then by name. */
export function replyGroups(replies: readonly SavedReplyLine[], language: ReplyLanguage, locale: string): { readonly shared: SavedReplyLine[]; readonly mine: SavedReplyLine[] } {
  const order = (a: SavedReplyLine, b: SavedReplyLine) => Number(b.language === language) - Number(a.language === language) || a.name.localeCompare(b.name, locale)
  return { shared: replies.filter((reply) => reply.shared).sort(order), mine: replies.filter((reply) => !reply.shared).sort(order) }
}

// ── the draft kept on this device ───────────────────────────────────────────────────────────────────────────────────

/** A draft older than this is forgotten (it was kept for an interruption, not as an archive). */
export const DRAFT_DAYS = 30

export interface LocalDraft {
  readonly text: string
  readonly savedAt: number
}

/** One draft per person, record and audience (an office note and a reply to the customer are kept apart). */
export const draftKey = (personId: string, record: { readonly type: string; readonly id: string }, mode: 'note' | 'reply' | 'portal') => `factory.thread.draft.${personId}.${record.type}.${record.id}.${mode}`

/** The draft kept on this device, or null (none, too old, unreadable, or storage closed). */
export function readDraft(storage: Pick<Storage, 'getItem'> | null, key: string, now: number): LocalDraft | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null) return null
    const { text, savedAt } = value as { text?: unknown; savedAt?: unknown }
    if (typeof text !== 'string' || typeof savedAt !== 'number' || text.trim() === '') return null
    if (now - savedAt > DRAFT_DAYS * 86_400_000) return null
    return { text, savedAt }
  } catch {
    return null
  }
}

/** Keeps the draft (empty text: forgets it). A closed storage forgets quietly: the box itself still holds the text. */
export function writeDraft(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, key: string, text: string, now: number): LocalDraft | null {
  try {
    if (text.trim() === '') {
      storage?.removeItem(key)
      return null
    }
    storage?.setItem(key, JSON.stringify({ text, savedAt: now }))
    return storage ? { text, savedAt: now } : null
  } catch {
    return null
  }
}

// ── B-TH-289 (B-TH-096; T8-F05): "Remind me in 3 days if no answer" ─────────────────────────────────────────────────────────

/** The follow-up comes back after this many days when the customer has not answered. */
export const FOLLOW_UP_DAYS = 3

/**
 * Offered on a message to the customer (a reply by e-mail or in the portal) to whoever has reminders (Home: home.view), online.
 * Only an answer from the customer's side stops it (their mail or portal post); a colleague's note, another mail of ours or a
 * closed conversation's — the API's rule (platform/threads/follow-ups) — never the box's.
 */
export const followUpOffered = (mode: 'note' | 'reply' | 'portal', can: { readonly remind: boolean; readonly offline?: boolean }): boolean => mode !== 'note' && can.remind && !can.offline

/** When the follow-up comes back: three days after the send (the reminder's own time, AT_TIME). */
export const followUpAt = (now: number): string => new Date(now + FOLLOW_UP_DAYS * 86_400_000).toISOString()
