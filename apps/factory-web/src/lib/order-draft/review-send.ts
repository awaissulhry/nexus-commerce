import type { Locale } from '../i18n/locales'
import { customLinesOf, lineCountOf } from './model'
import type { DraftRecord } from './schema'

/**
 * owb-po3.4 (design § 5h "Send… opens Review and send", prototype sheet.js `sendModal`) — "Review and send", pure: ONE card per draft
 * (one or many): its lines and pieces, its price (agreed, agreed for a part, or "the factory answers" — money only), its open points as
 * WARNINGS (never a stop), and after a send of many, each draft's answer (sent, or refused with the server's words). The orders sheet
 * (po7) and the order band (web B) open the window; the New order window sends straight away. No React, no API.
 */

/** A draft's price in the review: today's list price for all its lines, for a part, or none (the factory answers). */
export type ReviewPrice = { readonly kind: 'AGREED'; readonly amount: string } | { readonly kind: 'PART'; readonly amount: string } | { readonly kind: 'FACTORY' }

export interface ReviewDraft {
  readonly id: string
  readonly version: number
  readonly title: string
  readonly lines: number
  readonly pieces: number
  /** The day wanted (YYYY-MM-DD), or null. */
  readonly wanted: string | null
  /** Details still open (the server's Still open count). */
  readonly open: number
  /** Money only (a reader with the price grain); null: no price block, no amount. */
  readonly price: ReviewPrice | null
}

/** A draft of the record as the review reads it (the record's list prices only when it came with the price grain). */
export function reviewDraftOf(record: DraftRecord, title: string): ReviewDraft {
  const request = record.request
  let price: ReviewPrice | null = null
  if (record.seesPrices) {
    const listed = request.lines.filter((line) => line.priceNow !== null && line.priceNow !== undefined && line.pieces > 0)
    const amount = listed.reduce((sum, line) => sum + Number(line.priceNow) * line.pieces, 0)
    const all = lineCountOf(request)
    price = listed.length === 0 ? { kind: 'FACTORY' } : { kind: listed.length === all && customLinesOf(request).length === 0 ? 'AGREED' : 'PART', amount: amount.toFixed(2) }
  }
  return { id: request.id, version: request.version, title, lines: lineCountOf(request), pieces: request.summary.pieces, wanted: request.requestedDate, open: request.stillOpen?.openCount ?? 0, price }
}

/** A card's list: what is there (ok) and what is open (a warning, never a stop), as word keys with their figures. */
export function reviewPointsOf(draft: ReviewDraft): readonly { readonly ok: boolean; readonly key: string; readonly params?: Readonly<Record<string, string | number>> }[] {
  return [
    draft.lines > 0 ? { ok: true, key: 'review.lines', params: { lines: draft.lines, pieces: draft.pieces } } : { ok: false, key: 'review.noLines' },
    draft.wanted ? { ok: true, key: 'review.wanted', params: { day: draft.wanted } } : { ok: false, key: 'review.noWanted' },
    draft.open > 0 ? { ok: false, key: 'review.open', params: { count: draft.open } } : { ok: true, key: 'review.nothingOpen' },
  ]
}

/** One draft's answer of a send of many (`POST …/bulk-send`): sent, or refused with the server's words (EN + IT). */
export interface SendAnswer {
  readonly id: string
  readonly ok: boolean
  readonly words: { readonly en: string; readonly it: string } | null
}

/** The answers in words: how many went, and each refused draft by its title with why (the server's words in the page's language). */
export function sendResultsOf(answers: readonly SendAnswer[], drafts: readonly Pick<ReviewDraft, 'id' | 'title'>[], locale: Locale, otherwise: string): { readonly sent: number; readonly refused: readonly { readonly id: string; readonly title: string; readonly words: string }[] } {
  const titleOf = (id: string) => drafts.find((draft) => draft.id === id)?.title ?? id
  return {
    sent: answers.filter((answer) => answer.ok).length,
    refused: answers.filter((answer) => !answer.ok).map((answer) => ({ id: answer.id, title: titleOf(answer.id), words: answer.words ? answer.words[locale] : otherwise })),
  }
}
