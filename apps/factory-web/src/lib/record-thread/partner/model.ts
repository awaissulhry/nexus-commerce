import type { CardAction, CardFile, CardLink } from '../card/model'
import { cardFiles } from '../card/model'
import type { RowModel } from '../card/view/MessageRow'
import type { BarPin } from '../head/pins-bar'
import type { SenderTone } from '../parts/tones'
import { senderTone } from '../parts/tones'

/**
 * pt-w2 W2.1 (lane pt-, S1, S6, S7; ONE SHARED THREAD): the partner face's model — what a customer, a supplier, a workshop, an
 * accountant or a link's guest reads, mapped onto the shared row, list, quote and pinned bar. Pure.
 *
 * THE WALL: a portal message has two sides only — our company and the partner — and NO office field: no audience, no note, no author
 * id, no mail, no amount (the server never sends them to a portal reader; this type has nowhere to put them). Names follow ONE rule
 * (the author rule, ported from the DS PartnerThread, never imported): "You" for the reader's own, the person's name, our company for
 * our unnamed message, "Your team" for an unnamed colleague — never one of the office's fallback names. A quote is drawn
 * ONLY from the message's own `replyTo` (the server's, for THIS reader), never looked up among the loaded messages. A locked (priced)
 * file is counted "locked", with no name and no link.
 */

/** Who wrote it: our company (by mail or in the app) or the partner (a reply by mail, or in the portal). */
export type PartnerSide = 'company' | 'partner'
/** How it came: our mail or their reply to it, written in the portal, or by us in the app. */
export type PartnerChannel = 'email' | 'portal' | 'app'

/** A file of a portal message as the reader may see it. */
export interface PortalThreadFile {
  readonly id: string
  readonly name: string
  /** Its size in the page's words ("84 KB"), when the bytes are not known. */
  readonly size?: string | undefined
  readonly sizeBytes?: number | undefined
  /** Where it downloads (`/api/files/:id/download`); absent: not opened from here. */
  readonly href?: string | undefined
  readonly contentType?: string | undefined
  /** A file that shows prices to a reader who does not see prices: counted "locked", never named, never opened. */
  readonly locked?: boolean | undefined
}

/** The message a portal message answers, as the server sends it for THIS reader (its own link; never an author id, never an audience). */
export interface PortalQuote {
  readonly id: string
  /** Null: our company's unnamed message, or erased. */
  readonly authorName: string | null
  /** PARTY: the partner's side; USER / SYSTEM (and anything else): ours. */
  readonly authorKind?: 'USER' | 'PARTY' | 'WORKER' | 'SYSTEM' | undefined
  readonly excerpt: string
  readonly at: string
  readonly erased?: boolean | undefined
  /** The reader wrote it. */
  readonly mine?: boolean | undefined
  readonly fileCount?: number | undefined
  readonly firstFile?: { readonly id: string; readonly kind: string; readonly contentType: string } | null | undefined
}

/**
 * A message as the portal reads it — the shape of the DS PartnerThread's message (the design fixtures' own type fits it) with what the
 * read carries besides: the message it answers, the newest that corrects it, erased, a file's type and lock.
 */
export interface PortalThreadMessage {
  readonly id: string
  readonly side: PartnerSide
  readonly channel: PartnerChannel
  readonly author: { readonly name: string | null; readonly mine: boolean }
  /** The text, plain, with its line breaks. */
  readonly body: string
  readonly attachments?: readonly PortalThreadFile[] | undefined
  /** ISO instant (UTC). */
  readonly at: string
  /** The old face's written time (kept for its fixtures); the row says the time itself. */
  readonly atText?: string | undefined
  readonly replyTo?: PortalQuote | null | undefined
  readonly correctedBy?: { readonly id: string; readonly at: string } | null | undefined
  /** Erased after a privacy request: "Message removed after a privacy request", no name. */
  readonly erased?: boolean | undefined
}

/** A pin of a message shared with the reader, as the portal reads it (never who pinned). */
export interface PortalPin {
  readonly messageId: string
  readonly pinnedAt: string
  readonly authorName: string | null
  readonly excerpt: string
  readonly files: number
  readonly removed: boolean
}

/** The author rule's words: the reader's own, an unnamed colleague of theirs, our company's name. */
export interface PartnerNames {
  readonly you: string
  readonly yourTeam: string
  readonly company: string
}

/** The face's kinds: a record's messages (orders, requests, projects, …), the account's, a link's guest (no Reply, no quote: A10). */
export const PARTNER_KINDS = ['record', 'account', 'link'] as const
export type PartnerKind = (typeof PARTNER_KINDS)[number]

/** The author rule: You · the person · our company · Your team. */
export function partnerWho(message: { readonly side: PartnerSide; readonly author: { readonly name: string | null; readonly mine: boolean } }, names: PartnerNames): string {
  if (message.author.mine) return names.you
  const name = message.author.name?.trim()
  if (name) return name
  return message.side === 'company' ? names.company : names.yourTeam
}

/** Sides by the reader: theirs on the right, everyone else — us and their own colleagues — on the left (the WhatsApp rule). */
export const partnerSideOf = (message: { readonly author: { readonly mine: boolean } }): 'mine' | 'others' => (message.author.mine ? 'mine' : 'others')

/** The sender's ONE key in the portal: side + name (the read carries no author id: the wall). Runs and the person's colour hang on it. */
export const partnerSenderKey = (side: PartnerSide | 'mine', who: string): string => `${side}~${who}`

/** The quote of a reply, from its OWN link: the writer by the author rule (PARTY their side, everyone else ours); erased: no name. */
export function partnerQuoteOf(quote: PortalQuote, names: PartnerNames): CardLink {
  const side: PartnerSide = quote.authorKind === 'PARTY' ? 'partner' : 'company'
  const mine = quote.mine === true
  const who = partnerWho({ side, author: { name: quote.authorName, mine } }, names)
  return {
    id: quote.id,
    author: quote.erased ? null : who,
    excerpt: quote.excerpt,
    at: quote.at,
    // The kind only says the side; a quote always carries a name, so the shared quote never falls back to an office word.
    authorKind: side === 'partner' ? 'PARTY' : 'USER',
    ...(quote.erased ? {} : { senderKey: partnerSenderKey(mine ? 'mine' : side, who) }),
    ...(quote.erased ? { erased: true } : {}),
    ...(mine ? { mine: true } : {}),
    ...(quote.fileCount !== undefined ? { fileCount: quote.fileCount } : {}),
    ...(quote.firstFile !== undefined ? { firstFile: quote.firstFile } : {}),
  }
}

/** The pinned bar's pins (newest pin first): only shared messages', never who pinned; the writer by the author rule ("You", our company). */
export function partnerPinsOf(pins: readonly PortalPin[], names: PartnerNames, mine: ReadonlySet<string> = new Set()): BarPin[] {
  return pins
    .map((pin) => ({
      messageId: pin.messageId,
      pinnedAt: pin.pinnedAt,
      author: pin.removed ? null : mine.has(pin.messageId) ? names.you : pin.authorName?.trim() || names.company,
      hidden: false,
      excerpt: pin.removed ? '' : pin.excerpt,
      office: false,
      files: pin.files,
      removed: pin.removed,
    }))
    .sort((a, b) => (a.pinnedAt === b.pinnedAt ? a.messageId.localeCompare(b.messageId) : a.pinnedAt < b.pinnedAt ? 1 : -1))
}

const PICTURE_TYPE = /^image\//
const SIZE_TEXT = /^([\d.,]+)\s*(B|KB|MB|GB)$/i

/** A size in the page's words back to bytes ("84 KB" → 86016); unknown: 0. */
export function bytesOf(size: string | undefined): number {
  const found = SIZE_TEXT.exec((size ?? '').trim())
  if (!found) return 0
  // Italian writes "1,5" (its dot groups thousands); English "1.5".
  const raw = found[1]!
  const value = raw.includes(',') ? Number(raw.replace(/\./g, '').replace(',', '.')) : Number(raw)
  const power = ['B', 'KB', 'MB', 'GB'].indexOf(found[2]!.toUpperCase())
  return Number.isFinite(value) ? Math.round(value * 1024 ** power) : 0
}

/** A message's files as the shared row draws them: the ones the reader opens, and how many are locked (counted, never named). */
export function partnerFilesOf(attachments: readonly PortalThreadFile[] | undefined): { readonly files: CardFile[]; readonly locked: number } {
  const open = (attachments ?? []).filter((file) => !file.locked)
  return {
    files: open.map((file) => ({ id: file.id, name: file.name, sizeBytes: file.sizeBytes ?? bytesOf(file.size), contentType: file.contentType ?? (PICTURE_TYPE.test(file.name) ? 'image/jpeg' : 'application/octet-stream'), status: 'AVAILABLE' })),
    locked: (attachments ?? []).length - open.length,
  }
}

/** The message's menu: Reply (when the person may write and the kind answers: not a link's guest) · Copy text (words to copy). */
export function partnerMenuOf(message: Pick<PortalThreadMessage, 'body' | 'erased'>, may: { readonly reply: boolean }): CardAction[] {
  const rows: CardAction[] = []
  if (may.reply) rows.push('reply')
  if (!message.erased && message.body.trim() !== '') rows.push('copyText')
  return rows
}

/** What the list's rows carry for one portal message: the run's fields, the quote and files as drawn, and the message itself. */
export interface PartnerFeedMessage {
  readonly id: string
  readonly at: string
  /** Theirs (the partner wrote it) or ours (our company): its CSS look only — a run never mixes a note, and there is none here. */
  readonly kind: 'theirs' | 'ours'
  readonly senderKey: string
  readonly mine: boolean
  readonly replyTo: CardLink | null
  readonly files: readonly CardFile[]
  readonly source: PortalThreadMessage
}

/** The list's messages, in the order given (oldest first). A link's guest reads no quote (A10: its read carries none). */
export function partnerFeedOf(messages: readonly PortalThreadMessage[], names: PartnerNames, options: { readonly quotes: boolean }): PartnerFeedMessage[] {
  return messages.map((message): PartnerFeedMessage => {
    const who = partnerWho(message, names)
    return {
      id: message.id,
      at: message.at,
      kind: message.side === 'partner' ? 'theirs' : 'ours',
      senderKey: partnerSenderKey(message.author.mine ? 'mine' : message.side, who),
      mine: message.author.mine,
      replyTo: options.quotes && message.replyTo ? partnerQuoteOf(message.replyTo, names) : null,
      files: partnerFilesOf(message.attachments).files,
      source: message,
    }
  })
}

/**
 * The shared row of one portal message: the side by the reader, the name by the author rule (with our company's name beside our
 * people's — the company shows when it is not the reader's own), the words or "erased", the quote from its own link, its files.
 */
export function partnerRowOf(message: PartnerFeedMessage, input: { readonly names: PartnerNames; readonly tones?: ReadonlyMap<string, SenderTone> | undefined; readonly label: string; readonly pinned?: boolean | undefined }): RowModel {
  const source = message.source
  const who = partnerWho(source, input.names)
  const counted = partnerFilesOf(source.attachments)
  return {
    id: message.id,
    at: message.at,
    kindClass: `is-${message.kind}`,
    ariaLabel: input.label,
    who,
    face: who,
    org: source.side === 'company' && !source.author.mine && who !== input.names.company ? input.names.company : null,
    tone: input.tones?.get(message.senderKey) ?? senderTone(message.senderKey),
    words: source.erased ? 'erased' : source.body.trim() === '' ? null : { text: source.body, quoted: null },
    replyTo: message.replyTo,
    correctedBy: source.correctedBy ?? null,
    files: cardFiles(message.files, true, true, { priced: counted.locked }),
    ...(input.pinned ? { pinned: true } : {}),
  }
}
