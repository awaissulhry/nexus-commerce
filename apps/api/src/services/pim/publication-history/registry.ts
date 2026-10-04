/**
 * Sheet publish parity, step 4 — the sources the publish history merges. Add a source here (one line) and in its own
 * file; the core never changes. A source missing from this list is reported in `coverage` as not included.
 *
 * Build shape v2 (P7): the selling changes (`listing-action`) rank after the product sheet. A source whose runs all
 * belong to fixed "What" groups says so here (`what`), so the core leaves it out of a filter that names none of them.
 */
import type { PublicationHistoryAdapter } from './types.js'
import { studioHistorySource } from './studio.js'
import { listingActionHistorySource } from './listing-action.js'
import { amazonFlatFileHistorySource } from './amazon-flat-file.js'
import { ebayFlatFileHistorySource } from './ebay-flat-file.js'
import { photosHistorySource } from './photos.js'

export const HISTORY_ADAPTERS: PublicationHistoryAdapter[] = [
  studioHistorySource,
  listingActionHistorySource,
  { ...amazonFlatFileHistorySource, what: ['updates'] },
  { ...ebayFlatFileHistorySource, what: ['updates'] },
  { ...photosHistorySource, what: ['photos'] },
]
