import type { Tone } from '@nexus/ui/primitives'
import type { SenderTone } from '../parts/tones' // tw- fx2 (G-7)

/**
 * B-TH-298 — the message card (threads plan T3; picture 2, approved 2026-11-17): what ONE message of a record's thread draws,
 * in the office. A card says its side and its audience in words AND colour (design kit §3): the customer's message (blue tint,
 * blue edge, the organisation's tile and name, the channel), our message to the customer (blue edge: the customer reads it,
 * "Us", "Email to <customer>", the delivery word), an Office note (pale yellow, the lock, "Office only"), a note the tablets
 * read too ("Also on the floor") and a station's comment ("From the floor"). One yellow means one thing everywhere: not sent
 * to the customer. This file is pure: the view draws its answers, the office container fills the model.
 *
 * B-TH-236 (TH-3): Correct (a new message linked to the old one, never an edit), "In reply to …", "Corrected below", the amount
 * of an office note (price readers only) and the 10 seconds to take a mail back ("Sending to Brand Alpha… · Undo").
 * B-TH-286 (TH-9, on B-TH-091): pins — "Pin for everyone" / "Unpin" on the ⋯ (whoever may write on the conversation, online), a
 * pinned card's pin beside its time; the files line's "2 pinned" lists them (a pointer to the message, never a copy of its words).
 *
 * B-TH-255 (TH-6, on B-TH-079): the erased card — "Message removed after a privacy request" for a message whose writer was erased
 * (thread-G09; never a message that only carries files) — and the files of an inbound mail that were not kept, with why, under its
 * message (thread-G10; the office only: the API sends them to the office, never a signature logo).
 */

export const CARD_KINDS = ['theirs', 'ours', 'note', 'floor'] as const
/** theirs = the customer wrote it · ours = we wrote to the customer · note = an Office note · floor = a station's comment. */
export type CardKind = (typeof CARD_KINDS)[number]

export const CARD_CHANNELS = ['APP', 'EMAIL', 'PORTAL'] as const
export type CardChannel = (typeof CARD_CHANNELS)[number]

/**
 * The mail's state, the code's own words (message.email.*): Waiting to send · Sending · Sent · Delivered · Bounced · Marked as
 * spam · Not sent · (B-TH-048) Taken back.
 */
export const DELIVERY_STATES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'WITHDRAWN'] as const
export type Delivery = (typeof DELIVERY_STATES)[number]

/**
 * tw- W1.2 (10-design §2 "Foot"; W-022, Z20, P13): our email's state as a small icon beside the time — a clock while it waits or goes,
 * one tick sent, two ticks delivered (only after the mail service's webhook said so) in the time's own grey, NEVER blue (blue reads
 * as "read", and nobody is shown who read what), the alert in danger for bounced, spam and not sent; taken back (B-TH-048) its own
 * mark. The honest word (`delivery.<state>`) is the tooltip and the screen-reader text.
 */
export function deliveryMark(status: Delivery): { readonly icon: 'clock' | 'check' | 'checks' | 'alert' | 'back'; readonly tone: 'plain' | 'bad' } {
  if (status === 'QUEUED' || status === 'SENDING') return { icon: 'clock', tone: 'plain' }
  if (status === 'SENT') return { icon: 'check', tone: 'plain' }
  if (status === 'DELIVERED') return { icon: 'checks', tone: 'plain' }
  if (status === 'WITHDRAWN') return { icon: 'back', tone: 'plain' }
  return { icon: 'alert', tone: 'bad' }
}

export const CARD_FILE_STATUSES = ['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED'] as const
export type CardFileStatus = (typeof CARD_FILE_STATUSES)[number]

export interface CardFile {
  id: string
  name: string
  sizeBytes: number
  contentType: string
  status: CardFileStatus
}

export interface CardMessage {
  id: string
  kind: CardKind
  channel: CardChannel
  /** Who wrote it; null: the system, or a person the reader may not see. */
  author: string | null
  authorKind: 'USER' | 'WORKER' | 'PARTY' | 'SYSTEM'
  /** A floor worker wrote it and the site's legal gate keeps back who: the card says "A person on the floor". */
  authorHidden?: boolean
  /** ISO instant (UTC). */
  at: string
  body: string
  /** The tablets of the work order read this note too (B-W2b-F5). */
  forFloor?: boolean
  /** The people a note mentioned (null: someone the reader does not know). */
  mentions: readonly (string | null)[]
  files: readonly CardFile[]
  /**
   * A mail we sent: to whom, its subject and its state. B-TH-236 (B-TH-048): its id and copies, and — for the person who sent it,
   * while it waits its 10 seconds — until when it may be taken back ("Sending to Brand Alpha… · Undo").
   */
  email?: { to: readonly string[]; subject: string; status: Delivery; id?: string; cc?: readonly string[]; undoUntil?: string } | null
  /** A bounce made a task for the writer (GET /email/delivery-status): where it opens, while the reader sees it. */
  bounceTask?: { href: string } | null
  /** Our message on its way (before the server confirmed it) or not sent (the text is kept). */
  outbox?: { state: 'sending' } | { state: 'failed'; reason: string } | null
  // ---- B-TH-231: files the reader may not see are counted ("One file you cannot open"); B-TH-083: sheets they may not open.
  hiddenFiles?: number
  lockedSheets?: number
  /** B-CP-014: files that show prices, locked for this reader: "Priced document — you cannot open it", counted, never named. */
  lockedPriced?: number
  // ---- end B-TH-231
  // ---- B-TH-236 (B-TH-049, B-TH-050): the price typed in the amount field (an office note; price readers only), what it answers
  // or corrects, the newest message that corrects it ("Corrected below"), and whether the reader wrote it (Correct is one's own).
  amount?: { value: number; currency: string }
  replyTo?: CardLink | null
  corrects?: CardLink | null
  correctedBy?: { id: string; at: string } | null
  mine?: boolean
  // ---- end B-TH-236
  // ---- B-TH-255 (B-TH-079; T3-F14, T3-F15): erased after a privacy request (its writer's name and words blanked by the erasure — never
  // a message that only carries files), and — office only — the files of an inbound mail that were not kept, with why.
  erased?: boolean
  skipped?: readonly SkippedFile[]
  // ---- end B-TH-255
  // ---- F-SA-265 (B-SA-061): office only — the part of its order the message is about; the card offers "Show on the page".
  about?: { kind: string; id: string } | null
  // ---- F-SA-244: office only, filled by the record page — the customer's ask (its request's live chip, Answer…) and a change's
  // system line (its live Still to do, when the floor and the workshop were told, Who was told).
  ask?: CardAsk | null
  change?: CardChange | null
  // ---- B-TH-286 (B-TH-091; T3-F12): pinned for everyone on the record (the files line's "2 pinned" lists it).
  pinned?: boolean
  // ---- end B-TH-286
  // ---- tw- W1.1 (10-design §3): who wrote it as ONE key — runs and the person's colour hang on it. A user, a party contact or a
  // floor worker the reader may see: kind + id (a party with no id: kind + name); a writer the site's gate keeps back and the system:
  // none (R5: never a run, never a person colour). `senderKeyOf` makes it.
  senderKey?: string
  // ---- end tw- W1.1
  // ---- tw- W2.2 (B7, Z2; 10-design §9): office only — an INBOUND email's headers and sender checks as the mail came (tw-s part 7);
  // null or absent: Email details says the sender, the time and the words only. And the reader's own follow-up on their message
  // ("remind me if no answer"): the bell in its foot, for its sender only (reminders are personal).
  mail?: CardInboundMail | null
  followUp?: { readonly at: string } | null
  // ---- end tw- W2.2
}

/** tw- W2.2 (Z2): an inbound email's headers and the sender checks (office read; the verdicts as the server's MAIL_VERDICTS words). */
export interface CardInboundMail {
  readonly from: { readonly address: string | null; readonly name: string | null }
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly subject: string | null
  readonly verdicts: { readonly spf: string; readonly dkim: string; readonly dmarc: string }
}

// ---- B-TH-255: a file of an inbound mail that was not kept (the API's skippedAttachments; never a signature logo).
export interface SkippedFile {
  name: string
  contentType: string
  sizeBytes: number
  /** factory-domain email-in/rules SKIP_REASONS (without `inline`): type_not_allowed · too_large · empty · too_many. */
  reason: string
}
// ---- end B-TH-255

/** B-TH-236 (B-TH-050): a message another one points at, as a card names it ("In reply to Alma, 14 Nov: …"). */
export interface CardLink {
  id: string
  /** Null: a floor worker the site's gate keeps back ("A person on the floor"). */
  author: string | null
  excerpt: string
  at: string
  // ---- tw- W1.1 (S10 (1), tw-server § "Shapes"): the quote's details as the server sends them for THIS reader — every one optional.
  /** Who wrote it, by kind (a floor worker behind the gate: WORKER with no name). */
  authorKind?: 'USER' | 'PARTY' | 'WORKER' | 'SYSTEM'
  /** The quoted writer's key (`senderKeyOf`): their colour in the quote bar; none for a hidden writer or the system. */
  senderKey?: string
  /** Office reads only: the quoted message was an office note (OFFICE) or shared with the customer (PARTNER). */
  audience?: 'OFFICE' | 'PARTNER'
  /** Erased after a privacy request: "Message removed", no name. */
  erased?: boolean
  /** The reader wrote it: "You". */
  mine?: boolean
  /** The files of the quoted message THIS reader may open (a locked or walled one never counts). */
  fileCount?: number
  /** The first of those files ("Photo" / "PDF" / "File"); `kind` is the API's FILE_KINDS (PHOTO, DOCUMENT, ATTACHMENT, …). */
  firstFile?: { id: string; kind: string; contentType: string } | null
  // ---- end tw- W1.1
}

/** What every card of one thread shares. */
export interface CardContext {
  /** The record's customer (or supplier): "Email to <it>", the organisation on their side. */
  partyName: string | null
  /** files.read: the reader opens the files (else they are counted: "1 file you cannot open"). */
  canReadFiles: boolean
  /** The reader may answer a customer's message (a party on the record, email.send). */
  canReply: boolean
  /** Make a task from a message (home.view + tasks): offered only when the host has it. */
  canTask?: boolean
  /** B-TH-231: "Use on another record…" for the message's files (files.upload; the host carries them). */
  canUseOn?: boolean
  /**
   * B-TH-236 (B-TH-050): Correct on one's own message, by the way it went — an office note (threads.post), a mail (email.send), a
   * reply in the portal (threads.post, the portal offered). Absent: Correct is not offered.
   */
  canCorrect?: { readonly note: boolean; readonly email: boolean; readonly portal: boolean }
  /** B-TH-236: "now" in ms for Undo's seconds (a design case passes a fixed one; the thread passes none: the clock). */
  now?: number
  /** The message to show unfolded and focused (`?message=<id>`). */
  anchorId?: string | null
  /** B-TH-286 (B-TH-091): "Pin for everyone" / "Unpin" — threads.post, online (the API checks again). Absent: not offered. */
  canPin?: boolean
  /**
   * tw- W1.1 (D4, Z12): the ways this reader may answer — an office note (threads.post), the customer by email (email.send and a
   * customer on the record), in the customer's portal (offered on the record). Reply is then on EVERY message (`replyWay`). Absent:
   * Reply on the customer's message only, for a reader who may answer it (`canReply`), as before.
   */
  replyWays?: { readonly note: boolean; readonly email: boolean; readonly portal: boolean }
  /** tw- W2.2: "Remind me" on a message — the reader's own reminders (home.view). Absent: not offered. */
  canRemind?: boolean
  /** tw- fx2 (walk G-7): the list's colours by sender key (`tonesFor`): one colour per person inside the list. Absent: the key's own. */
  tones?: ReadonlyMap<string, SenderTone>
}

// ── the words of a bubble's foot (tw- W1.2) ─────────────────────────────────────────────────────────────────────────

/**
 * tw- W1.2 (10-design §2 "Foot", §12 homes 1–3; R17): who reads it, as small icons beside the time — the lock on an office note
 * ("Office only"; the tablet too when the floor reads it), the lock and the tablet on a station's comment ("From the floor"), the mail
 * or the globe on what the customer reads. Never told by side or colour alone: each icon carries its word (record-thread-card `foot.*`)
 * as the tooltip and for screen readers, and the bubble's name says it in full (`audienceKey`).
 */
export function footMarks(message: Pick<CardMessage, 'kind' | 'channel' | 'forFloor'>): Array<{ key: string; icon: 'lock' | 'mail' | 'globe' | 'tablet' }> {
  if (message.kind === 'note') return message.forFloor ? [{ key: 'foot.office', icon: 'lock' }, { key: 'foot.floor', icon: 'tablet' }] : [{ key: 'foot.office', icon: 'lock' }]
  if (message.kind === 'floor') return [{ key: 'foot.office', icon: 'lock' }, { key: 'foot.fromFloor', icon: 'tablet' }]
  if (message.channel === 'PORTAL') return [{ key: 'foot.portal', icon: 'globe' }]
  if (message.channel === 'EMAIL') return [{ key: 'foot.email', icon: 'mail' }]
  // tw- fx2 (walk G-11; R17): a shared message of channel APP (written in the app, read by the customer in their portal) carries the
  // portal's icon — never "shared" by colour alone.
  return [{ key: 'foot.portal', icon: 'globe' }]
}

/** The audience read out for a screen reader (T3-F17: side and audience in words, never colour alone). */
export function audienceKey(message: Pick<CardMessage, 'kind' | 'forFloor'>): string {
  if (message.kind === 'note') return message.forFloor ? 'audience.noteFloor' : 'audience.note'
  if (message.kind === 'floor') return 'audience.floor'
  return message.kind === 'theirs' ? 'audience.theirs' : 'audience.ours'
}

/**
 * tw- W1.1 (10-design §3): the sender's ONE key — runs and the person's colour hang on it. A user, a party contact or a floor worker
 * the reader may see: kind + id; a party with no id (a mail with no contact): kind + name. A writer the site's gate keeps back and
 * the system have none: they never form a run and never get a person colour (R5).
 */
export function senderKeyOf(author: { readonly kind: CardMessage['authorKind']; readonly id?: string | null | undefined; readonly name: string | null }, hidden = false): string | undefined {
  if (hidden || author.kind === 'SYSTEM') return undefined
  if (author.id) return `${author.kind}:${author.id}`
  if (author.kind === 'PARTY' && author.name) return `PARTY~${author.name}`
  return undefined
}

/** Who wrote it, in words: the name; "A person on the floor" behind the gate; the system's name; "Someone" otherwise. */
export function authorWords(message: Pick<CardMessage, 'author' | 'authorKind' | 'authorHidden'>): { key: string } | { text: string } {
  if (message.authorHidden) return { key: 'author.floorPerson' }
  if (message.author) return { text: message.author }
  return { key: `author.${message.authorKind}` }
}

// ── the body: quoted text and the signature fold behind "…" (T3-F04); a long mail folds after 12 lines (T3-F01) ───────

/** Lines that start the repeated part of a mail reply: "On 12 Nov, Alex wrote:", "Il … ha scritto:", "-----Original Message-----", "From:" headers, "> …". */
const QUOTE_START = [/^On .{3,200} wrote:\s*$/i, /^Il .{3,200} ha scritto:\s*$/i, /^-{2,}\s*(Original Message|Messaggio originale)\s*-{2,}\s*$/i, /^(From|Da):\s.+$/i, /^>/]
/** The signature's own line ("-- "). */
const SIGNATURE = /^--\s?$/

/**
 * A mail's own words and its repeated part (the quoted reply, the signature). Nothing is deleted: the view shows the rest behind
 * "…". Only the customer's mail and ours fold; a note never does. A body that would leave no words of its own does not fold
 * (the heuristic is wrong then, and "…" would hide everything).
 */
export function splitQuoted(body: string, kind: CardKind): { text: string; quoted: string | null } {
  if (kind === 'note' || kind === 'floor') return { text: body, quoted: null }
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((line) => SIGNATURE.test(line) || QUOTE_START.some((pattern) => pattern.test(line.trim())))
  if (start <= 0) return { text: body, quoted: null }
  const text = lines.slice(0, start).join('\n').replace(/\s+$/, '')
  if (text.trim() === '') return { text: body, quoted: null }
  return { text, quoted: lines.slice(start).join('\n') }
}

/** A body folds after this many lines ("Show all (34 lines)"). */
export const FOLD_LINES = 12

/** How many lines a text has, and whether it folds. */
export function longFold(text: string): { lines: number; folds: boolean } {
  const lines = text.split(/\r?\n/).length
  return { lines, folds: lines > FOLD_LINES }
}

// ── files on a card (T3-F06) ───────────────────────────────────────────────────────────────────────────────────────

const PICTURES = new Set(['image/jpeg', 'image/png', 'image/webp'])
/** At most this many files show; the rest is "+N". */
export const FILES_SHOWN = 6

export interface CardFiles {
  /** Files the reader opens, as pictures (JPEG, PNG, WebP). */
  photos: CardFile[]
  /** Files the reader opens, as a row with their kind. */
  others: CardFile[]
  /** Held for the virus scan (a lock) or removed: shown as such, never opened. */
  held: CardFile[]
  /** Beyond the first six: "+14". */
  more: number
  /** Files the reader may not open (no right to files): counted, never dropped ("1 file you cannot open"). */
  hidden: number
  /** B-TH-083 (B-TH-231): measurement sheets the reader may not open: "Measurement sheet — you cannot open it". */
  sheets: number
  /** B-CP-014: priced documents the reader may not open: "Priced document — you cannot open it" (absent: none). */
  priced?: number
}

/** `counted`: B-TH-231 — the message's files the API left out for this reader, and its sheets locked for them. */
export function cardFiles(files: readonly CardFile[], canReadFiles: boolean, all = false, counted: { readonly hidden?: number; readonly sheets?: number; /* B-CP-014 */ readonly priced?: number } = {}): CardFiles {
  const extra = counted.hidden ?? 0
  const sheets = counted.sheets ?? 0
  const priced = counted.priced ?? 0 // B-CP-014
  if (!canReadFiles) return { photos: [], others: [], held: [], more: 0, hidden: files.length + extra + sheets + priced, sheets: 0 }
  const shown = all ? [...files] : files.slice(0, FILES_SHOWN)
  return {
    photos: shown.filter((file) => file.status === 'AVAILABLE' && PICTURES.has(file.contentType)),
    others: shown.filter((file) => file.status === 'AVAILABLE' && !PICTURES.has(file.contentType)),
    held: shown.filter((file) => file.status !== 'AVAILABLE'),
    more: all ? 0 : Math.max(0, files.length - FILES_SHOWN),
    hidden: extra,
    sheets,
    ...(priced > 0 ? { priced } : {}), // B-CP-014
  }
}

/** A file's kind word (design kit §5: File · Document · Photo; PDF names itself). */
export function fileKindKey(file: Pick<CardFile, 'contentType'>): string {
  if (file.contentType.startsWith('image/')) return 'file.kind.photo'
  if (file.contentType === 'application/pdf') return 'file.kind.pdf'
  if (file.contentType.startsWith('audio/')) return 'file.kind.audio'
  if (/word|spreadsheet|opendocument|csv/.test(file.contentType)) return 'file.kind.document'
  return 'file.kind.file'
}

/** Sizes in the reader's numbers ("240 KB", "2.4 MB"). */
export const sizeWords = (bytes: number, intlLocale: string): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toLocaleString(intlLocale, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(intlLocale)} KB`

// ── the card's ⋯ menu (T3-F07, F09, F10) ─────────────────────────────────────────────────────────────────────────────

export type CardAction = 'answerThere' | 'reply' | 'replyPrivately' | 'copyText' | 'link' | 'pin' | 'unpin' | 'remind' | 'task' | 'answer' | 'correct' | 'emailDetails' | 'useOn'

/** tw- W2.2 (S8): the ONE order of a message's menu — whatever a row's right, a row keeps its place. */
export const MENU_ORDER: readonly CardAction[] = ['answerThere', 'reply', 'replyPrivately', 'copyText', 'link', 'pin', 'unpin', 'remind', 'task', 'answer', 'correct', 'emailDetails', 'useOn']

/** tw- W2.5 (10-design §9 "All of Brand Alpha"): a read-only card's menu — Answer in its thread · Copy text · Copy link, each by its door. */
export const READ_ONLY_MENU: readonly CardAction[] = ['answerThere', 'copyText', 'link']

// ---- tw- W1.1 (D4, Z12, P15; 10-design §9 "Reply keeps the audience") ------------------------------------------------------------
/** How a reply goes: an office note, the customer by email, or the customer's portal (the composer's modes). */
export type ReplyWay = 'note' | 'reply' | 'portal'

/**
 * How Reply answers this message, or null when it is not offered. Reply keeps the audience of what it answers: the customer's
 * message → the customer (in the portal when it came from there and the portal is offered, else by email, else in the portal); our
 * own shared message (a colleague's email too, P15) → the customer, the same way first; an office note or a floor note → an office
 * note. A reader with neither way to the customer (Z12) answers the customer's message with an office note that quotes it. Never on a
 * message on its way, a mail in its 10 seconds or taken back, or the system's own line (a pill: no menu). Without `replyWays` (a host
 * that does not say): Reply on the customer's message only, for a reader who may answer it, as before.
 */
export function replyWay(
  message: Pick<CardMessage, 'kind' | 'outbox'> & Partial<Pick<CardMessage, 'channel' | 'authorKind' | 'email'>>,
  context: Pick<CardContext, 'canReply' | 'replyWays'>,
): ReplyWay | null {
  if (!pinnable(message)) return null
  if (message.kind === 'note' && message.authorKind === 'SYSTEM') return null
  const ways = context.replyWays
  if (!ways) return message.kind === 'theirs' && context.canReply ? 'reply' : null
  const toCustomer = (first: 'reply' | 'portal'): ReplyWay | null => {
    if (first === 'portal' && ways.portal) return 'portal'
    if (ways.email) return 'reply'
    if (ways.portal) return 'portal'
    return ways.note ? 'note' : null
  }
  if (message.kind === 'theirs' || message.kind === 'ours') return toCustomer(message.channel === 'PORTAL' ? 'portal' : 'reply')
  return ways.note ? 'note' : null
}

/** "Reply privately" (W-037): on the customer's message, an office note that quotes it — only beside a Reply that goes to the customer. */
export function repliesPrivately(message: Pick<CardMessage, 'kind' | 'outbox'> & Partial<Pick<CardMessage, 'channel' | 'authorKind' | 'email'>>, context: Pick<CardContext, 'canReply' | 'replyWays'>): boolean {
  if (message.kind !== 'theirs' || !context.replyWays?.note) return false
  const way = replyWay(message, context)
  return way === 'reply' || way === 'portal'
}
// ---- end tw- W1.1

/**
 * What a message's menu offers (tw- W2.2, 10-design §9: ONE menu, ONE order — `MENU_ORDER`; a row without its right is not drawn, never
 * a hint line under a row): Reply (on every message the reader may answer, `replyWay`) · Reply privately (beside it on the customer's
 * message) · Copy text (a message with words) · Copy link (always) · Pin / Unpin (for everyone) · Remind me (the reader's own reminder,
 * home.view) · Make a task (where the host has tasks) · Answer… (the customer's ask the reader may answer now) · Correct (one's own
 * message, by the way it went) · Email details (an email, ours or theirs) · Use on another record… (its files). A message on its way
 * offers nothing yet; the system's line is a pill (no menu). Never Forward, Star, Delete, Edit, Message info, Report or React (R15).
 * The view drops a row whose door the host does not give (Answer…, Remind me, Email details).
 */
export function cardActions(
  message: Pick<CardMessage, 'kind' | 'outbox'> &
    Partial<Pick<CardMessage, 'channel' | 'authorKind' | 'mine' | 'email' | 'pinned' | 'body' | 'erased' | 'ask'>> & { files?: readonly Pick<CardFile, 'status'>[] },
  context: Pick<CardContext, 'canReply' | 'canTask' | 'canUseOn' | 'canCorrect' | 'canPin' | 'replyWays' | 'canRemind'> & { readonly canReadFiles?: boolean },
): CardAction[] {
  if (message.outbox) return []
  if (message.kind === 'note' && message.authorKind === 'SYSTEM') return []
  const offered = new Set<CardAction>()
  if (replyWay(message, context) !== null) offered.add('reply')
  if (repliesPrivately(message, context)) offered.add('replyPrivately')
  if (copyTextOf(message) !== null) offered.add('copyText')
  offered.add('link')
  // B-TH-286 (B-TH-091): pinned for everyone, or unpinned; never a mail in its undo window or taken back (the API refuses it too).
  if (context.canPin && (message.pinned || pinnable(message))) offered.add(message.pinned ? 'unpin' : 'pin')
  if (context.canRemind && pinnable(message)) offered.add('remind')
  if (context.canTask) offered.add('task')
  if (message.ask?.answer) offered.add('answer') // F-SA-244: the customer's ask, when the reader may answer it now
  // B-TH-236 (B-TH-050): Correct on one's own message, by the way it went (never an edit: a new message linked to the old one).
  if (correctionWay(message, context) !== null) offered.add('correct')
  if (message.channel === 'EMAIL' && (message.kind === 'theirs' || (message.kind === 'ours' && message.email))) offered.add('emailDetails')
  // B-TH-231: "Use on another record…" when the message has a file the reader opens and may add files elsewhere (files.upload).
  if (context.canUseOn && context.canReadFiles && (message.files ?? []).some((file) => file.status === 'AVAILABLE')) offered.add('useOn')
  return MENU_ORDER.filter((action) => offered.has(action))
}

/** tw- W2.2: the words "Copy text" copies — the message's own words; none when erased or when it only carries files. */
export function copyTextOf(message: Partial<Pick<CardMessage, 'body' | 'erased'>>): string | null {
  if (message.erased) return null
  const text = (message.body ?? '').trim()
  return text === '' ? null : text
}

/**
 * tw- W2.2 (B7, Z2; 10-design §9 "Email details"): what the one Email details window shows of a message — our email: To, Cc, Subject,
 * its state, the date and our words; an inbound one: From, To, Cc, Subject and the sender checks as the mail came (tw-s part 7), else
 * the sender's name, the time and the words. Null: not an email. Pure; the window draws it (popups/view/OriginalEmail).
 */
export interface EmailDetails {
  readonly from: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly subject: string | null
  readonly at: string
  /** Ours: sent (its delivery state below); theirs: received (its sender checks, when the mail row was read). */
  readonly sent: boolean
  readonly status: Delivery | null
  readonly verdicts: { readonly spf: string; readonly dkim: string; readonly dmarc: string } | null
  readonly text: string
}

export function emailDetailsOf(message: Pick<CardMessage, 'kind' | 'channel' | 'author' | 'at' | 'body'> & Partial<Pick<CardMessage, 'email' | 'mail' | 'erased'>>): EmailDetails | null {
  if (message.channel !== 'EMAIL') return null
  const text = message.erased ? '' : message.body
  if (message.kind === 'ours') {
    const mail = message.email
    if (!mail) return null
    return { from: message.author ?? '', to: mail.to, cc: mail.cc ?? [], subject: mail.subject, at: message.at, sent: true, status: mail.status, verdicts: null, text }
  }
  if (message.kind !== 'theirs') return null
  const mail = message.mail ?? null
  if (!mail) return { from: message.author ?? '', to: [], cc: [], subject: null, at: message.at, sent: false, status: null, verdicts: null, text }
  const name = mail.from.name ?? message.author
  const from = name && mail.from.address ? `${name} <${mail.from.address}>` : (mail.from.address ?? name ?? '')
  return { from, to: mail.to, cc: mail.cc, subject: mail.subject, at: message.at, sent: false, status: null, verdicts: mail.verdicts, text }
}

// ---- B-TH-286 (B-TH-091): what may be pinned — a message the server holds (never one on its way), and not a mail still in its 10
// seconds to take it back or one taken back (the API's HELD refusal said before it is asked).
export function pinnable(message: Pick<CardMessage, 'outbox'> & Partial<Pick<CardMessage, 'email'>>): boolean {
  if (message.outbox) return false
  const mail = message.email
  if (mail && (mail.status === 'WITHDRAWN' || (mail.status === 'QUEUED' && mail.undoUntil))) return false
  return true
}
// ---- end B-TH-286

/** The address of a message (thread-G03: the same form as the bell's message anchor): the record's page with `?message=<id>`. */
export function messageLink(recordHref: string, messageId: string): string {
  const [path, hash = ''] = recordHref.split('#')
  const [base, query = ''] = path.split('?')
  const params = new URLSearchParams(query)
  params.set('message', messageId)
  return `${base}?${params.toString()}${hash ? `#${hash}` : ''}`
}

// ── B-TH-236 (B-TH-048, B-TH-049, B-TH-050): Correct, the links, the amount, Undo ────────────────────────────────────────────

/** The way a correction goes: the way the message went (an office note by a note, a mail by a mail, a portal reply in the portal). */
export type CorrectionWay = 'note' | 'reply' | 'portal'

/** The mail states a correction follows: the mail reached the mail service (a mail still waiting is taken back instead; one taken back or not sent never reached them). */
const CORRECTABLE_MAIL: readonly Delivery[] = ['SENDING', 'SENT', 'DELIVERED']

/**
 * How Correct goes for this message, or null when it is not offered: only on the reader's own message, never one on its way; an
 * office note they wrote (the floor's copy follows when it went to the floor), a mail they sent once it left, a reply of theirs in
 * the portal — each only with the right that way needs. Never on the customer's message (they correct their own) or the floor's.
 */
export function correctionWay(
  message: Pick<CardMessage, 'kind' | 'outbox'> & Partial<Pick<CardMessage, 'channel' | 'authorKind' | 'mine' | 'email'>>,
  context: Pick<CardContext, 'canCorrect'>,
): CorrectionWay | null {
  const can = context.canCorrect
  if (!can || !message.mine || message.outbox) return null
  if (message.kind === 'note' && message.authorKind === 'USER') return can.note ? 'note' : null
  if (message.kind !== 'ours') return null
  if (message.channel === 'PORTAL') return can.portal ? 'portal' : null
  if (message.channel === 'EMAIL' && message.email && CORRECTABLE_MAIL.includes(message.email.status) && !message.email.undoUntil) return can.email ? 'reply' : null
  return null
}

/** Whole seconds left to take a mail back (0: the window passed), from the API's `undoUntil`. */
export function undoLeft(undoUntil: string | null | undefined, now: number): number {
  if (!undoUntil) return 0
  const until = Date.parse(undoUntil)
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - now) / 1000)) : 0
}

/** The card's Undo shows on our mail while its sender may still take it back. */
export const showsUndo = (message: Pick<CardMessage, 'kind' | 'outbox' | 'email'>, now: number): boolean => message.kind === 'ours' && !message.outbox && message.email?.status === 'QUEUED' && undoLeft(message.email.undoUntil, now) > 0

/** A linked message in one short line: at most 90 characters of its words. */
export function excerptOf(text: string, max = 90): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** The amount in the reader's numbers ("€ 1.250,00", "€1,250.00"): minor units of its currency. */
export function amountWords(amount: { readonly value: number; readonly currency: string }, intlLocale: string): string {
  const places = (() => {
    try {
      return new Intl.NumberFormat(intlLocale, { style: 'currency', currency: amount.currency }).resolvedOptions().maximumFractionDigits ?? 2
    } catch {
      return 2
    }
  })()
  const units = amount.value / 10 ** places
  try {
    return new Intl.NumberFormat(intlLocale, { style: 'currency', currency: amount.currency }).format(units)
  } catch {
    return `${units.toFixed(places)} ${amount.currency}`
  }
}

// ── B-TH-255 (B-TH-079; T3-F14 erased, T3-F15 files not kept) ─────────────────────────────────────────────────────────

/**
 * Why a file of an inbound mail was not kept (factory-domain email-in/rules SKIP_REASONS; the test holds them together — the domain's
 * rules reach node:crypto, so a browser module never imports them). `inline` (a signature logo) is never listed: skipped silently.
 */
export const SKIP_REASON_CODES = ['type_not_allowed', 'too_large', 'empty', 'too_many'] as const

/** The reason's words: a key of record-thread-card (`skipped.reason.too_large`); an unknown code says "not kept" plainly. */
export const skipReasonKey = (reason: string): string => ((SKIP_REASON_CODES as readonly string[]).includes(reason) ? `skipped.reason.${reason}` : 'skipped.reason.other')

/**
 * What a card's body says (T3-F14): the words; "Message removed after a privacy request" when the writer was erased (the API's
 * `erased`); nothing more when it only carries files (an empty text with files is NEVER the erased card); nothing when it has neither
 * (its files are counted below: "1 file you cannot open").
 */
export function bodyKind(message: Pick<CardMessage, 'erased' | 'body' | 'files'> & Partial<Pick<CardMessage, 'hiddenFiles' | 'lockedSheets' | /* B-CP-014 */ 'lockedPriced'>>): 'erased' | 'text' | 'files' | 'empty' {
  if (message.erased) return 'erased'
  if (message.body.trim() !== '') return 'text'
  return message.files.length > 0 || (message.hiddenFiles ?? 0) > 0 || (message.lockedSheets ?? 0) > 0 || (message.lockedPriced ?? 0) > 0 ? 'files' : 'empty'
}

/**
 * The line under an inbound mail (T3-F15): "2 files in this e-mail were not kept: logo.ai (type not accepted), clip.mov (too
 * large)" — each file by its name with the reason's words key; a signature logo (`inline`) is never listed. Null: nothing was dropped.
 */
export function skippedLine(skipped: readonly SkippedFile[] | undefined): { readonly count: number; readonly items: readonly { readonly name: string; readonly reasonKey: string }[] } | null {
  const items = (skipped ?? []).filter((file) => file.reason !== 'inline').map((file) => ({ name: file.name, reasonKey: skipReasonKey(file.reason) }))
  return items.length === 0 ? null : { count: items.length, items }
}

/** The API message's depth as the card carries it (the office read's `erased`, `skippedAttachments` and — tw- W2.2 — the inbound `mail`). */
export function cardDepth(message: {
  readonly erased?: boolean | undefined
  readonly skippedAttachments?: readonly SkippedFile[] | undefined
  readonly mail?: CardInboundMail | null | undefined
}): Pick<CardMessage, 'erased' | 'skipped' | 'mail'> {
  return {
    ...(message.erased ? { erased: true } : {}),
    ...(message.mail ? { mail: message.mail } : {}),
    ...(message.skippedAttachments && message.skippedAttachments.length > 0 ? { skipped: message.skippedAttachments.map((file) => ({ name: file.name, contentType: file.contentType, sizeBytes: file.sizeBytes, reason: file.reason })) } : {}),
  }
}

// ---- F-SA-244 (sales page plan P5, P8', P21, R2, R7; 14-change-flow §3.1 "the ask message's card Answer…", §4.1 "its card draws a
// live chip from the follow-ups read"; review WP-1, WP-2) -----------------------------------------------------------------------
/**
 * The conversation side of a change, office only and filled by the record page (the order page knows its requests, its Still to do
 * and who was told; every other host fills nothing and the card draws as before):
 *
 *   the customer's ask   their message (the request's askMessageId): the live chip "Request · waiting on us" → "Request · accepted ·
 *                        2 still to do" → "Request · accepted", and Answer… while it waits for this reader (the ONE review window,
 *                        through the record frame's answer door)
 *   a change's line      the system's office note: "Still to do: 2" (a door to the page's Still to do) → "Done"; "Told the floor at
 *                        10:42" · "Told the workshop at 10:44"; Who was told… — who was TOLD, never who read anything (R2)
 * A work order's number is never on the card: the line's own words name a mixed one "a work order" (B-SA-052, R7).
 */
export const ASK_STATES = ['OPEN', 'COUNTERED', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
export type AskState = (typeof ASK_STATES)[number]

export interface CardAsk {
  readonly requestId: string
  /** The request's status now (OPEN waits on us; COUNTERED waits for the customer's answer to our counter-offer). */
  readonly state: AskState
  /** Accepted: the Still to do rows it left for this reader's page (0: none left). */
  readonly stillToDo: number
  /** The reader may answer it now (it waits on us and the reader's team answers its kind): the card offers Answer…. */
  readonly answer: boolean
}

export interface CardChange {
  /** The change's Still to do as the page counts it now (null: not counted for this reader — the card claims nothing). */
  readonly stillToDo: number | null
  /** When the floor notes were written (null: no floor note). */
  readonly floorAt: string | null
  /** When the first workshop was told (null: none). */
  readonly workshopAt: string | null
}

/** The ask's chip: its words (a key of record-thread-card) and its tone. */
export function askChip(ask: Pick<CardAsk, 'state' | 'stillToDo'>): { readonly key: string; readonly params?: { readonly count: number }; readonly tone: Tone } {
  if (ask.state === 'OPEN') return { key: 'ask.chip.OPEN', tone: 'warning' }
  if (ask.state === 'COUNTERED') return { key: 'ask.chip.COUNTERED', tone: 'info' }
  if (ask.state === 'ACCEPTED') return ask.stillToDo > 0 ? { key: 'ask.chip.acceptedStill', params: { count: ask.stillToDo }, tone: 'info' } : { key: 'ask.chip.ACCEPTED', tone: 'success' }
  return { key: `ask.chip.${ask.state}`, tone: 'neutral' }
}

/** The line's chip: "Still to do: N" while rows are left, "Done" once none is; null: not counted for this reader (no claim). */
export function changeChip(change: Pick<CardChange, 'stillToDo'>): { readonly key: string; readonly params?: { readonly count: number }; readonly tone: Tone; readonly door: boolean } | null {
  if (change.stillToDo === null) return null
  return change.stillToDo > 0 ? { key: 'change.still', params: { count: change.stillToDo }, tone: 'warning', door: true } : { key: 'change.done', tone: 'success', door: false }
}

/** The card's facts by message (the record page's), set on the feed's messages; a message it does not name keeps none. */
export function withChangeSide(message: CardMessage, facts: { readonly asks: ReadonlyMap<string, CardAsk>; readonly changes: ReadonlyMap<string, CardChange> } | null | undefined): CardMessage {
  if (!facts) return message
  // Their ask is the customer's own message; a change's line is the system's office note — any other message keeps nothing.
  const ask = message.kind === 'theirs' ? facts.asks.get(message.id) : undefined
  const change = message.kind === 'note' && message.authorKind === 'SYSTEM' ? facts.changes.get(message.id) : undefined
  if (!ask && !change) return message
  return { ...message, ...(ask ? { ask } : {}), ...(change ? { change } : {}) }
}
// ---- end F-SA-244
