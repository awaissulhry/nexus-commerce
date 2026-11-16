import type { Tone } from '@nexus/ui/primitives'

/**
 * B-TH-298 — the message card (threads plan T3; picture 2, approved 2026-11-17): what ONE message of a record's thread draws,
 * in the office. A card says its side and its audience in words AND colour (design kit §3): the customer's message (blue tint,
 * blue edge, the organisation's tile and name, the channel), our message to the customer (blue edge: the customer reads it,
 * "Us", "Email to <customer>", the delivery word), an Office note (pale yellow, the lock, "Office only"), a note the tablets
 * read too ("Also on the floor") and a station's comment ("From the floor"). One yellow means one thing everywhere: not sent
 * to the customer. This file is pure: the view draws its answers, the office container fills the model.
 *
 * Not drawn until the back end has it (design kit §5): Correct (thread-G20, TH-3), pins (N4), the erased card (thread-G09),
 * files not kept from a mail (thread-G10), unread marks (G10).
 */

export const CARD_KINDS = ['theirs', 'ours', 'note', 'floor'] as const
/** theirs = the customer wrote it · ours = we wrote to the customer · note = an Office note · floor = a station's comment. */
export type CardKind = (typeof CARD_KINDS)[number]

export const CARD_CHANNELS = ['APP', 'EMAIL', 'PORTAL'] as const
export type CardChannel = (typeof CARD_CHANNELS)[number]

/** The mail's state, the code's own words (message.email.*): Waiting to send · Sending · Sent · Delivered · Bounced · Marked as spam · Not sent. */
export const DELIVERY_STATES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED'] as const
export type Delivery = (typeof DELIVERY_STATES)[number]

/** "Delivered" is the DS success pill only after the mail service's webhook said so; amber while it waits. */
export const DELIVERY_TONE: Readonly<Record<Delivery, Tone>> = {
  QUEUED: 'warning',
  SENDING: 'info',
  SENT: 'neutral',
  DELIVERED: 'success',
  BOUNCED: 'danger',
  COMPLAINED: 'danger',
  FAILED: 'danger',
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
  /** A mail we sent: to whom, its subject and its state. */
  email?: { to: readonly string[]; subject: string; status: Delivery } | null
  /** A bounce made a task for the writer (GET /email/delivery-status): where it opens, while the reader sees it. */
  bounceTask?: { href: string } | null
  /** Our message on its way (before the server confirmed it) or not sent (the text is kept). */
  outbox?: { state: 'sending' } | { state: 'failed'; reason: string } | null
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
  /** The message to show unfolded and focused (`?message=<id>`). */
  anchorId?: string | null
}

// ── the words of a card's head ──────────────────────────────────────────────────────────────────────────────────────

/** The marks in a card's head, at most two (design kit §3): the audience first, then the floor mark. Keys of record-thread-card. */
export function cardMarks(message: Pick<CardMessage, 'kind' | 'channel' | 'forFloor'>): Array<{ key: string; icon: 'lock' | 'mail' | 'globe' | 'tablet' }> {
  if (message.kind === 'note') {
    const marks: Array<{ key: string; icon: 'lock' | 'mail' | 'globe' | 'tablet' }> = [{ key: 'mark.note', icon: 'lock' }]
    if (message.forFloor) marks.push({ key: 'mark.alsoFloor', icon: 'tablet' })
    return marks
  }
  if (message.kind === 'floor') return [{ key: 'mark.fromFloor', icon: 'tablet' }]
  if (message.kind === 'theirs') return [{ key: message.channel === 'PORTAL' ? 'mark.portal' : 'mark.email', icon: message.channel === 'PORTAL' ? 'globe' : 'mail' }]
  return [{ key: message.channel === 'PORTAL' ? 'mark.toPortal' : 'mark.toEmail', icon: message.channel === 'PORTAL' ? 'globe' : 'mail' }]
}

/** The side in words beside the writer: the customer's name on their side, "Us" on ours; a note says nothing more (its mark does). */
export function sideKey(kind: CardKind): 'side.theirs' | 'side.ours' | null {
  if (kind === 'theirs') return 'side.theirs'
  if (kind === 'ours') return 'side.ours'
  return null
}

/** The audience read out for a screen reader (T3-F17: side and audience in words, never colour alone). */
export function audienceKey(message: Pick<CardMessage, 'kind' | 'forFloor'>): string {
  if (message.kind === 'note') return message.forFloor ? 'audience.noteFloor' : 'audience.note'
  if (message.kind === 'floor') return 'audience.floor'
  return message.kind === 'theirs' ? 'audience.theirs' : 'audience.ours'
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
}

export function cardFiles(files: readonly CardFile[], canReadFiles: boolean): CardFiles {
  if (!canReadFiles) return { photos: [], others: [], held: [], more: 0, hidden: files.length }
  const shown = files.slice(0, FILES_SHOWN)
  return {
    photos: shown.filter((file) => file.status === 'AVAILABLE' && PICTURES.has(file.contentType)),
    others: shown.filter((file) => file.status === 'AVAILABLE' && !PICTURES.has(file.contentType)),
    held: shown.filter((file) => file.status !== 'AVAILABLE'),
    more: Math.max(0, files.length - FILES_SHOWN),
    hidden: 0,
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

export type CardAction = 'reply' | 'task' | 'link'

/**
 * What the ⋯ of a card offers: Reply on the customer's message (when the reader may answer), Make a task (where the host has
 * tasks), Copy link to message (always: it opens the record with this message unfolded and focused). Remind me is the host's own
 * part beside the menu (B-W2b-388). Correct waits for thread-G20 (TH-3); a message on its way offers nothing yet.
 */
export function cardActions(message: Pick<CardMessage, 'kind' | 'outbox'>, context: Pick<CardContext, 'canReply' | 'canTask'>): CardAction[] {
  if (message.outbox) return []
  const actions: CardAction[] = []
  if (message.kind === 'theirs' && context.canReply) actions.push('reply')
  if (context.canTask) actions.push('task')
  actions.push('link')
  return actions
}

/** The address of a message (thread-G03: the same form as the bell's message anchor): the record's page with `?message=<id>`. */
export function messageLink(recordHref: string, messageId: string): string {
  const [path, hash = ''] = recordHref.split('#')
  const [base, query = ''] = path.split('?')
  const params = new URLSearchParams(query)
  params.set('message', messageId)
  return `${base}?${params.toString()}${hash ? `#${hash}` : ''}`
}
