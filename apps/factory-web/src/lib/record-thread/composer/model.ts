import { mentionsIn } from '../helpers/model'

/**
 * B-TH-205 — the composer's audience switch (threads plan T5; picture 3, approved 2026-11-17): who reads what I write, safe by
 * default. Every visit starts on "Office note", so nothing reaches a customer by mistake (P3); one click (or R) switches to
 * "Reply to <customer>" — the customer's real name, only when the record has a customer and the person may send mail. The whole
 * box takes the audience's colour and Send names it ("Add note" / "Send to Brand Alpha"). Typed text survives a switch;
 * @mentions are taken out of a mail and named. A work order's note may tick "For the floor". Held states: closed, no right,
 * offline, a prospect ("Make the customer first"). Office only: the portal keeps the DS PartnerThread box (PR-15). Pure.
 *
 * Not built until the back end has it: the portal-only reply (G15, TH-3), the price check of a floor note (N7), drafts on the
 * server (N6).
 */

export const COMPOSER_MODES = ['note', 'reply'] as const
export type ComposerMode = (typeof COMPOSER_MODES)[number]

/** What the person may do (the API checks every call again). */
export interface ComposerAbilities {
  /** threads.post: an Office note. */
  post: boolean
  /** email.send: a mail to the record's customer. */
  email: boolean
  /** threads.manage: reopen a closed thread. */
  manage: boolean
}

export interface ComposerPerson {
  id: string
  name: string
}

export interface ComposerContext {
  /** The record's model name: only a work order offers "For the floor". */
  recordType: string
  /** The record's number, for the floor line ("The tablets of WO-2026-0311 show it"). */
  recordLabel: string
  /** The record's customer (or supplier): the reply's audience. */
  party: { name: string } | null
  /** A request from someone who is not a customer yet (Incoming): the reply waits for "Make the customer". */
  prospect?: { name: string } | null
  can: ComposerAbilities
  /** The thread is closed: by whom and when, when the history says so. */
  closed?: { by: string | null; at: string | null } | null
  /** No network: Send waits, the text stays on this device. */
  offline?: boolean
  /** Who a note may mention (the person themself left out). */
  people: readonly ComposerPerson[]
}

export interface ComposerDraft {
  mode: ComposerMode
  body: string
  /** A work order's note the tablets read too: off by default. */
  forFloor: boolean
}

/** The longest text (the API's own: threads rules MAX_BODY_LENGTH). */
export const MAX_BODY = 20_000
/** The tablet shows the first 1000 characters of a floor note (production dispatch FLOOR_MESSAGES.text). */
export const FLOOR_TEXT = 1000
/** The counter shows this close to the limit. */
export const COUNTER_FROM = 18_000

/** The modes offered, in order: a note needs threads.post; a reply needs email.send AND a customer (or a prospect, held). */
export function composerModes(context: Pick<ComposerContext, 'can' | 'party' | 'prospect'>): ComposerMode[] {
  const modes: ComposerMode[] = []
  if (context.can.post) modes.push('note')
  if (context.can.email && (context.party !== null || context.prospect)) modes.push('reply')
  return modes
}

/** Every visit starts on Office note (P3); a person who may only send mail starts on the reply. */
export function startDraft(context: Pick<ComposerContext, 'can' | 'party' | 'prospect'>): ComposerDraft {
  return { mode: composerModes(context)[0] ?? 'note', body: '', forFloor: false }
}

/** What stands in place of the box: the closed thread, no right to write, or the box itself. */
export function boxState(context: Pick<ComposerContext, 'can' | 'party' | 'prospect' | 'closed'>): 'closed' | 'noRight' | 'open' {
  if (context.closed) return 'closed'
  if (composerModes(context).length === 0) return 'noRight'
  return 'open'
}

/** "For the floor" is offered on a work order's note only (B-W2b-F5; the API refuses it elsewhere). */
export const floorOffered = (context: Pick<ComposerContext, 'recordType'>, mode: ComposerMode): boolean => mode === 'note' && context.recordType === 'WorkOrder'

/** The reply's audience: the customer, or the prospect. */
export const audienceName = (context: Pick<ComposerContext, 'party' | 'prospect'>): string => context.party?.name ?? context.prospect?.name ?? ''

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The people a text @mentions, by TH-1c's one rule (helpers' mentionsIn: a whole name after "@", case aside, not inside a word). */
export function mentionsOf(body: string, people: readonly ComposerPerson[]): ComposerPerson[] {
  return mentionsIn(body, people).flatMap((id) => people.filter((person) => person.id === id))
}

/** A switch note: a key of record-thread-composer and its parameters. */
export interface SwitchNote {
  key: string
  params?: Record<string, string | number>
}

/**
 * A switch of audience. The text stays; leaving the note, each @mention is taken out of the text (mentions live only in Office
 * notes, T5-F05) and named; the floor tick goes (only a note goes to the floor). Files are the tray's: the tray marks an office-only
 * file in a reply and Send waits until it is shared or taken off (B-TH-206).
 */
export function switchMode(draft: ComposerDraft, to: ComposerMode, people: readonly ComposerPerson[]): { draft: ComposerDraft; notes: SwitchNote[] } {
  if (draft.mode === to) return { draft, notes: [] }
  if (to === 'note') return { draft: { ...draft, mode: to }, notes: [] }
  const mentioned = mentionsOf(draft.body, people)
  let body = draft.body
  for (const person of mentioned) body = body.replace(new RegExp(`(^|[^\\p{L}\\p{N}])@${escape(person.name)}(?![\\p{L}\\p{N}])[ \\t]?`, 'giu'), '$1')
  const notes: SwitchNote[] = mentioned.length > 0 ? [{ key: 'switch.mentions', params: { names: mentioned.map((person) => `@${person.name}`).join(', ') } }] : []
  return { draft: { mode: to, body, forFloor: false }, notes }
}

/**
 * Why Send waits (a key of record-thread-composer, and its parameters), or null: offline first (the text stays here), then a
 * send on its way, a prospect's reply, an empty message, a text too long; then the tray's or the recipients' own reason
 * (`extra`, already in words: "Waiting for 2 files").
 */
export function heldReason(
  draft: ComposerDraft,
  context: Pick<ComposerContext, 'offline' | 'prospect' | 'party'>,
  more: { sending?: boolean; hasFiles?: boolean } = {},
): { key: string; params?: Record<string, string | number> } | null {
  if (context.offline) return { key: 'held.offline' }
  if (more.sending) return { key: 'held.sending' }
  if (draft.mode === 'reply' && !context.party && context.prospect) return { key: 'held.prospect' }
  if (draft.body.trim() === '' && !more.hasFiles) return { key: 'held.empty' }
  const length = [...draft.body].length
  if (length > MAX_BODY) return { key: 'held.tooLong', params: { count: length - MAX_BODY } }
  return null
}

/** Send names who gets it. */
export const sendKey = (mode: ComposerMode): string => (mode === 'note' ? 'send.note' : 'send.reply')

/** The box's line under the text when a floor note is longer than a tablet shows. */
export const floorTooLong = (draft: ComposerDraft): boolean => draft.forFloor && [...draft.body].length > FLOOR_TEXT

/**
 * R and N switch the box from outside it (T5-F11): R = reply (when offered), N = note. Inside a field the keys type text; with
 * the box held they do nothing. Answers the mode to take, or null.
 */
export function keyMode(key: string, modes: readonly ComposerMode[], inField: boolean): ComposerMode | null {
  if (inField) return null
  const lower = key.toLowerCase()
  if (lower === 'r' && modes.includes('reply')) return 'reply'
  if (lower === 'n' && modes.includes('note')) return 'note'
  return null
}
