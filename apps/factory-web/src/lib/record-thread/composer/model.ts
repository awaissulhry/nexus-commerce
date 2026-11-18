import { mentionsIn } from '../helpers/model'
// B-TH-236: the amount field and the floor's price check (B-TH-049).
import { amountProblem, floorPriceFound } from '../helpers/amount'

/**
 * B-TH-205 — the composer's audience switch (threads plan T5; picture 3, approved 2026-11-17): who reads what I write, safe by
 * default. Every visit starts on "Office note", so nothing reaches a customer by mistake (P3); one click (or R) switches to
 * "Reply to <customer>" — the customer's real name, only when the record has a customer and the person may send mail. The whole
 * box takes the audience's colour and Send names it ("Add note" / "Send to Brand Alpha"). Typed text survives a switch;
 * @mentions are taken out of a mail and named. A work order's note may tick "For the floor". Held states: closed, no right,
 * offline, a prospect ("Make the customer first"). Office only: the portal keeps the DS PartnerThread box (PR-15). Pure.
 *
 * B-TH-237 (TH-3, G15): a third audience, "In the portal only" — a message the customer reads in its portal, no e-mail (POST
 * …/replies), offered when the record's customer may read it there. B-TH-236: Reply / Correct name the message they answer or
 * correct ("Replying to Alma, 14 Nov ×"); a correction goes the way the message went; the amount field (price readers, an office
 * note only) and the floor's price check hold Send with the reason. B-TH-287: drafts on the server (N6) — composer/server-draft.ts.
 *
 * F-SA-282a (sales page plan R7; B-SA-073): a message in the portal whose text names another customer of ours comes back from the API
 * (409 NAMES_OTHER_CUSTOMER, never naming whom): the box says why in words and offers the tick "This text names no other customer";
 * Send waits until the text changes or the tick is set, then goes again with the tick. Both go with a change of the text (the API
 * checks the new text again) and when the box leaves the portal; neither is kept with a draft.
 *
 * F-SA-282 (Reply to <customer> on N, the Orders sheet): the same box in N mode (`many`) — the portal only, one text for the own
 * conversation of each of N orders of one customer; the window (areas/sales/orders/list/view/ReplyManyDialog) gives no clip.
 */

export const COMPOSER_MODES = ['note', 'reply', 'portal'] as const
export type ComposerMode = (typeof COMPOSER_MODES)[number]

/** What the person may do (the API checks every call again). */
export interface ComposerAbilities {
  /** threads.post: an Office note. */
  post: boolean
  /** email.send: a mail to the record's customer. */
  email: boolean
  /** threads.manage: reopen a closed thread. */
  manage: boolean
  /** B-TH-236 (B-TH-049): money.price — the amount field on an office note. */
  price?: boolean
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
  /**
   * B-TH-237 (B-TH-044): "In the portal only" is offered — the record has a customer, the person may post, the record is shared
   * with its customer, and the API has not said that nobody of the customer reads it in the portal (NO_PORTAL).
   */
  portal?: boolean
  // ---- F-SA-282 (sales page plan R7; the Orders sheet's Reply to N): N mode — the same words go into the own conversation of each of
  // N records of ONE customer, in the portal only (an office note on N records is Note to N…; a mail goes per record).
  many?: boolean
}

/** B-TH-236 (B-TH-050): the message a draft answers or corrects, as the box names it ("Replying to Alma, 14 Nov ×"). */
export interface DraftLink {
  kind: 'reply' | 'correct'
  messageId: string
  /** Who wrote it (null: a floor worker kept back); "your message" for one's own correction. */
  who: string | null
  at: string
  /** A correction goes the way the message went: a note, a mail, the portal. */
  way?: ComposerMode
  /** The note corrected was on the floor's tablets: the correction goes there too. */
  forFloor?: boolean
}

export interface ComposerDraft {
  mode: ComposerMode
  body: string
  /** A work order's note the tablets read too: off by default. */
  forFloor: boolean
  // ---- B-TH-236: the amount as typed (absent: the field is folded), its currency, and what the message answers or corrects.
  amount?: string
  currency?: string
  link?: DraftLink
  // ---- end B-TH-236
  // ---- th-backend-g step 1 (threads plan §0.5, counts do not leak): a saved reply filled for an office note names the office's numbers
  // (INQ-…, SO-…); these are the pairs it named (POST …/fill `numbers`), swapped for the customer's own ("#7") when the note becomes a
  // text to the customer.
  numbers?: readonly NumberSwap[]
  // ---- F-SA-282a (B-SA-073): the API held this text in the portal — it names another customer of ours (`namesOther`) — and the
  // writer's tick "This text names no other customer" (`namesNoOtherCustomer`), sent with the next try.
  namesOther?: boolean
  namesNoOtherCustomer?: boolean
}

/** th-backend-g step 1: one record number as the office writes it and as its customer reads it (null: none of its own yet). */
export interface NumberSwap {
  office: string
  customer: string | null
}

/**
 * th-backend-g step 1: the office's numbers in a text swapped for the customer's own ("INQ-2026-0042" → "#7"; one the customer has no
 * number for is taken out), and the swaps made, for the switch note. Only whole numbers are swapped (never inside a longer word).
 */
export function swapNumbers(body: string, numbers: readonly NumberSwap[]): { body: string; swapped: string[] } {
  let text = body
  const swapped: string[] = []
  for (const pair of numbers) {
    if (!pair.office) continue
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}-])${escape(pair.office)}(?![\\p{L}\\p{N}])`, 'gu')
    const next = text.replace(pattern, (_all, before: string) => `${before}${pair.customer ?? ''}`)
    if (next === text) continue
    text = next
    swapped.push(pair.customer ? `${pair.office} → ${pair.customer}` : pair.office)
  }
  return { body: text, swapped }
}

/** The longest text (the API's own: threads rules MAX_BODY_LENGTH). */
export const MAX_BODY = 20_000
/** The tablet shows the first 1000 characters of a floor note (production dispatch FLOOR_MESSAGES.text). */
export const FLOOR_TEXT = 1000
/** The counter shows this close to the limit. */
export const COUNTER_FROM = 18_000

/**
 * The modes offered, in order: a note needs threads.post; a reply needs email.send AND a customer (or a prospect, held);
 * B-TH-237: "In the portal only" needs threads.post, a customer, and the record offered to the portal (`portal`).
 */
export function composerModes(context: Pick<ComposerContext, 'can' | 'party' | 'prospect'> & Partial<Pick<ComposerContext, 'portal' | 'many'>>): ComposerMode[] {
  // F-SA-282: N mode offers the portal only (and nothing when the record's customer may not read it there).
  if (context.many) return context.portal && context.can.post && context.party ? ['portal'] : []
  const modes: ComposerMode[] = []
  if (context.can.post) modes.push('note')
  if (context.can.email && (context.party !== null || context.prospect)) modes.push('reply')
  if (context.portal && context.can.post && context.party) modes.push('portal')
  return modes
}

/** B-TH-237: the modes that reach the customer (a reply by e-mail, a message in the portal). */
export const toCustomer = (mode: ComposerMode): boolean => mode === 'reply' || mode === 'portal'

// ---- th-backend-g step 1 (threads plan §0.5, counts do not leak) ------------------------------------------------------------
/** The reader a saved reply is filled for (POST …/fill `audience`): the office in an office note, else the customer (its own numbers). */
export const replyAudienceOf = (mode: ComposerMode): 'CUSTOMER' | 'OFFICE' => (toCustomer(mode) ? 'CUSTOMER' : 'OFFICE')

/**
 * A saved reply's filled text added to the draft (after what is typed, a blank line between). Filled for an office note, the office's
 * numbers it named are kept with the draft, so a switch to the customer swaps them for the customer's own (switchMode).
 */
export function withSavedReply(draft: ComposerDraft, filled: { body: string; audience?: 'CUSTOMER' | 'OFFICE' | undefined; numbers?: readonly { office: string; customer: string | null }[] | undefined }): ComposerDraft {
  const body = draft.body.trim() ? `${draft.body}\n\n${filled.body}` : filled.body
  const named = filled.audience === 'OFFICE' ? (filled.numbers ?? []).filter((pair) => pair.office !== pair.customer) : []
  // F-SA-282a: new words — the API checks them again, so the hold and the tick go.
  return { ...withoutNamesOther(draft), body, ...(named.length > 0 ? { numbers: [...(draft.numbers ?? []), ...named.map(({ office, customer }) => ({ office, customer }))] } : {}) }
}
// ---- end th-backend-g step 1

/** Every visit starts on Office note (P3); a person who may only send mail starts on the reply. */
export function startDraft(context: Pick<ComposerContext, 'can' | 'party' | 'prospect'> & Partial<Pick<ComposerContext, 'portal' | 'many'>> /* F-SA-282 */): ComposerDraft {
  return { mode: composerModes(context)[0] ?? 'note', body: '', forFloor: false }
}

/** What stands in place of the box: the closed thread, no right to write, or the box itself. */
export function boxState(context: Pick<ComposerContext, 'can' | 'party' | 'prospect' | 'closed'> & Partial<Pick<ComposerContext, 'portal' | 'many'>> /* F-SA-282 */): 'closed' | 'noRight' | 'open' {
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
  // B-TH-236: a correction keeps the way of the message it corrects; leaving that way lets the correction go (said).
  const correction = draft.link?.kind === 'correct' && draft.link.way && draft.link.way !== to
  const keptLink = draft.link && !correction ? { link: draft.link } : {}
  const linkNotes: SwitchNote[] = correction ? [{ key: 'switch.correction' }] : []
  if (to === 'note') {
    // F-SA-282a: an office note is never checked for another customer's name: the portal's hold and its tick go.
    const { link: _link, ...rest } = withoutNamesOther(draft)
    void _link
    return { draft: { ...rest, mode: to, ...keptLink }, notes: linkNotes }
  }
  const mentioned = mentionsOf(draft.body, people)
  let body = draft.body
  for (const person of mentioned) body = body.replace(new RegExp(`(^|[^\\p{L}\\p{N}])@${escape(person.name)}(?![\\p{L}\\p{N}])[ \\t]?`, 'giu'), '$1')
  const notes: SwitchNote[] = mentioned.length > 0 ? [{ key: 'switch.mentions', params: { names: mentioned.map((person) => `@${person.name}`).join(', ') } }] : []
  // B-TH-236: an amount stays on office notes: leaving the note takes it off (said).
  if (draft.amount !== undefined && draft.amount.trim() !== '') notes.push({ key: 'switch.amount' })
  // th-backend-g step 1 (§0.5): the office's numbers a saved reply put in the note become the customer's own (said).
  if (draft.numbers && draft.numbers.length > 0) {
    const swapped = swapNumbers(body, draft.numbers)
    body = swapped.body
    if (swapped.swapped.length > 0) notes.push({ key: 'switch.numbers', params: { numbers: swapped.swapped.join(', ') } })
  }
  return { draft: { mode: to, body, forFloor: false, ...keptLink }, notes: [...notes, ...linkNotes] }
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
  if (toCustomer(draft.mode) && !context.party && context.prospect) return { key: 'held.prospect' }
  if (draft.body.trim() === '' && !more.hasFiles) return { key: 'held.empty' }
  const length = [...draft.body].length
  if (length > MAX_BODY) return { key: 'held.tooLong', params: { count: length - MAX_BODY } }
  // ---- B-TH-236 (B-TH-049): the amount as typed, and a floor note whose words look like a price (held with what looked like one).
  if (draft.mode === 'note') {
    const problem = amountProblem(draft.amount, { forFloor: draft.forFloor })
    if (problem) return { key: problem.key === 'amount.floor' ? 'held.amountFloor' : 'held.amount' }
    const found = floorPriceFound(draft.body, draft.forFloor)
    if (found) return { key: 'held.floorPrice', params: { found } }
  }
  // ---- end B-TH-236
  // ---- F-SA-282a (B-SA-073): the API held the text — it names another customer of ours — until it changes or the writer ticks it.
  if (namesOtherAsked(draft) && draft.namesNoOtherCustomer !== true) return { key: 'held.namesOther' }
  return null
}

// ---- F-SA-282a (sales page plan R7; B-SA-073; the production notes' R-47 rule) --------------------------------------------------
/** The box offers the tick "This text names no other customer": the API held this text in the portal (409 NAMES_OTHER_CUSTOMER). */
export const namesOtherAsked = (draft: Pick<ComposerDraft, 'mode' | 'namesOther'>): boolean => draft.mode === 'portal' && draft.namesOther === true

/** The draft without the API's hold and the writer's tick (new words, another audience). */
export function withoutNamesOther(draft: ComposerDraft): ComposerDraft {
  if (draft.namesOther === undefined && draft.namesNoOtherCustomer === undefined) return draft
  const { namesOther: _held, namesNoOtherCustomer: _ticked, ...rest } = draft
  void _held
  void _ticked
  return rest
}

/** The text back in the box after the API held it: in the portal, held, the tick not set. */
export const heldForNamesOther = (draft: ComposerDraft): ComposerDraft => ({ ...withoutNamesOther(draft), mode: 'portal', namesOther: true, namesNoOtherCustomer: false })

/** A change of the draft in the box: a change of the words lets the hold and the tick go (the API checks the new words again). */
export function draftAfter(draft: ComposerDraft, next: Partial<ComposerDraft>): ComposerDraft {
  const changed = { ...draft, ...next }
  return next.body !== undefined && next.body !== draft.body ? withoutNamesOther(changed) : changed
}

/** What the next try in the portal sends: the tick, only when the box asked for it and it is set. */
export const namesNoOtherCustomerOf = (draft: ComposerDraft): boolean => namesOtherAsked(draft) && draft.namesNoOtherCustomer === true
// ---- end F-SA-282a

/** Send names who gets it. B-TH-237: "Post to Brand Alpha" in the portal. */
export const sendKey = (mode: ComposerMode): string => (mode === 'note' ? 'send.note' : mode === 'portal' ? 'send.portal' : 'send.reply')

/** B-TH-236: the floor tick of a note that corrects a note on the floor's tablets is on and stays on (the floor reads the correction too). */
export const floorLocked = (draft: Pick<ComposerDraft, 'link'>): boolean => draft.link?.kind === 'correct' && draft.link.forFloor === true

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
