/**
 * Sheet publish parity, step 4 — the sources the publish history merges. Add a source here (one line) and in its own
 * file; the core never changes. A source missing from this list is reported in `coverage` as not included.
 */
import type { PublicationHistoryAdapter } from './types.js'
import { studioHistorySource } from './studio.js'
import { amazonFlatFileHistorySource } from './amazon-flat-file.js'
import { ebayFlatFileHistorySource } from './ebay-flat-file.js'
import { photosHistorySource } from './photos.js'

export const HISTORY_ADAPTERS: PublicationHistoryAdapter[] = [
  studioHistorySource,
  amazonFlatFileHistorySource,
  ebayFlatFileHistorySource,
  photosHistorySource,
]
