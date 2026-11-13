import type { ReactNode } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import type { QuoteDetail, QuoteLine } from '../../api'
import type { Grains } from '../../model'

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
}

/** The sections later steps add (none yet). */
export function lineDrawerSections(_context: LineDrawerContext): LineDrawerSection[] {
  const sections: LineDrawerSection[] = []
  return sections.sort((a, b) => a.order - b.order)
}
