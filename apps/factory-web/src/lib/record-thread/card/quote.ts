import { senderTone, type SenderTone } from '../parts/tones'
import type { CardLink } from './model'

/**
 * tw- W1.1 (10-design §5 "The quote — every case"; 13-backend §3.1 card/quote.ts): what the quote block at the top of a reply says —
 * the quoted sender's name in their colour (a 4 px bar beside it), then 1 to 3 lines of their words, or an icon and a word for a
 * message of files. Drawn ONLY from the reply's own `replyTo` / `corrects` as the server sent it for THIS reader (R1): never looked up
 * among the loaded messages. Words only, never an amount (the server's excerpt is the words; the amount has its own column).
 *
 *   short or long words      tone, name · up to 3 lines, then "…" (one line when short)
 *   mine                     "You" · the words
 *   a colleague / the customer   their name (no company in a quote) · the words
 *   a picture / a file / files   "Photo" / "PDF" or "Document" / "2 files" (the caption instead when it has words)
 *   erased                   slate bar, no name (the erasure blanks the writer too) · "Message removed"
 *   a hidden floor writer    slate, "A person on the floor" · the words
 *   a quoted office note     a small lock after the name (an office read only)
 * Pure: the view (QuoteBlock) draws it.
 */

/** The quote's name: words of record-thread-card (`quote.you`, `author.floorPerson`, `author.SYSTEM`) or a person's name; null: none. */
export type QuoteName = { readonly text: string } | { readonly key: string } | null

/** A message of files: which icon, which word. */
export type QuoteMedia = 'photo' | 'pdf' | 'document' | 'files'

export interface QuoteModel {
  readonly id: string
  readonly at: string
  readonly name: QuoteName
  readonly tone: SenderTone
  /** The quoted words, or a word for its files (`quote.removed`, `quote.photos`, `file.kind.pdf`, …); count for the plural. */
  readonly text: { readonly text: string } | { readonly key: string; readonly count?: number }
  /** The clamp: 1 line (removed, files only), else up to 3. */
  readonly lines: 1 | 3
  readonly media: QuoteMedia | null
  /** The quoted message is an office note (an office read only): a small lock after the name. */
  readonly lock: boolean
  readonly removed: boolean
}

/** The icon and word of a quoted message's files, as THIS reader may open them (a locked file never counts: the server's fileCount). */
export function quoteMediaOf(link: Pick<CardLink, 'fileCount' | 'firstFile'>): { readonly media: QuoteMedia; readonly key: string; readonly count: number } | null {
  const count = link.fileCount ?? 0
  if (count <= 0) return null
  const first = link.firstFile ?? null
  if (count === 1 && first) {
    if (first.kind === 'IMAGE' || first.contentType.toLowerCase().startsWith('image/')) return { media: 'photo', key: 'quote.photos', count: 1 }
    if (first.contentType.toLowerCase() === 'application/pdf') return { media: 'pdf', key: 'file.kind.pdf', count: 1 }
    return { media: 'document', key: 'file.kind.document', count: 1 }
  }
  // Several files: "3 files" — never "3 photos" unless the reader could tell every one is a picture (the read names the first only).
  return { media: 'files', key: 'quote.files', count }
}

/** The quote of a reply or a correction, from its own link (R1). */
export function quoteOf(link: CardLink): QuoteModel {
  const hidden = link.author === null && (link.authorKind === 'WORKER' || link.authorKind === undefined)
  const removed = link.erased === true
  const name: QuoteName = removed ? null : link.mine ? { key: 'quote.you' } : link.author ? { text: link.author } : hidden ? { key: 'author.floorPerson' } : { key: `author.${link.authorKind ?? 'WORKER'}` }
  const tone: SenderTone = removed || hidden ? 'slate' : senderTone(link.senderKey)
  const lock = !removed && link.audience === 'OFFICE'
  if (removed) return { id: link.id, at: link.at, name, tone, text: { key: 'quote.removed' }, lines: 1, media: null, lock, removed }
  const words = link.excerpt.replace(/\s+/g, ' ').trim()
  const media = quoteMediaOf(link)
  if (media) return { id: link.id, at: link.at, name, tone, text: words !== '' ? { text: words } : { key: media.key, count: media.count }, lines: 1, media: media.media, lock, removed }
  return { id: link.id, at: link.at, name, tone, text: { text: words }, lines: 3, media: null, lock, removed }
}
