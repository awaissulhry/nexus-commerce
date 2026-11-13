import { createElement, type ReactNode } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { QuoteDetail, QuoteLine } from '../../api'
import type { Grains } from '../../model'
// B-W2b-343: the cost breakdown and the waterfall (price-depth/LineWaterfall.tsx).
import { LineWaterfall } from '../price-depth/LineWaterfall'
import { PRICE_DEPTH_NS } from '../price-depth/model'

/**
 * The line drawer's open slot (design pop:quotes.lineDrawer): the parts later steps add to a quote line, each a section
 * of its own between "Sizes and price" and "Delivery schedule". B-W2b-316 builds the drawer with none.
 *
 * How a later step adds its part (one line here, its own component in its own folder):
 *   - B-W2b-343 (prices on screen): `{ id: 'waterfall', order: 10, title: t('…'), body: <LineWaterfall api={api}
 *     quoteId={quote.id} lineId={line.id} editable={editable} /> }` — the cost breakdown and the waterfall (GET …/pricing,
 *     PUT …/lines/:lineId/price).
 *   - B-W2b-340 (the configurator): `{ id: 'options', order: 20, title: …, body: <LineOptions … /> }` — the options of
 *     the line (QuoteLineOption), re-priced through PUT …/price after the picks.
 * A section's body is a container (it may read and write; it calls `onQuote` with the quote a write answers so the
 * record follows). The drawer draws the sections in `order`, each under its title, and never reads their data.
 */
export interface LineDrawerSection {
  id: string
  /** Lower first. */
  order: number
  title: string
  body: ReactNode
}

export interface LineDrawerContext {
  api: ApiClient
  quote: QuoteDetail
  line: QuoteLine
  grains: Grains
  /** A DRAFT version and the person edits quotes. */
  editable: boolean
  /** The record takes the quote a write answers. */
  onQuote: (next: QuoteDetail) => void
  /** The page's words for the section titles (the caller's catalogue). */
  t: (key: string, params?: Record<string, string | number>) => string
  /** B-W2b-343: the page's language (a section's title from its own catalogue). */
  locale?: Locale
}

/** The sections later steps add. */
export function lineDrawerSections(context: LineDrawerContext): LineDrawerSection[] {
  const sections: LineDrawerSection[] = []
  // B-W2b-343: Cost breakdown and Waterfall (GET …/pricing, PUT …/lines/:lineId/price), with the price grain.
  if (context.grains.price) {
    const words = createTranslator(context.locale ?? 'it', messagesFor(context.locale ?? 'it', [PRICE_DEPTH_NS])[PRICE_DEPTH_NS] ?? {})
    sections.push({ id: 'waterfall', order: 10, title: words('drawer.title'), body: createElement(LineWaterfall, { key: context.line.id, api: context.api, quote: context.quote, line: context.line, grains: context.grains, editable: context.editable, onQuote: context.onQuote }) })
  }
  return sections.sort((a, b) => a.order - b.order)
}
