/**
 * Negative Targeting page, Words view (step 4, 2026-10-25) — the shapes the view reads from `/api/advertising/waste/words`,
 * `/words/ids` and `/word/:id`, as the API answers them (`apps/api/src/services/advertising/waste/words.ts`; the code is the
 * contract). Money is in cents of the row's currency; a money key the server left out (no ad-spend permission) is
 * `undefined` and reads as a dash. Hrefs carry no `/w/<id>` prefix: the workspace `Link` adds it.
 */
import type { HistoryItem, Ref, RowNumbers, RowState, RowTest, WasteCriteria, WasteFreshness } from '../waste/wasteTypes'

export type WordState = 'WASTING' | 'PARTLY_BLOCKED' | 'BLOCKED' | 'PROTECTED' | 'HELD' | 'NOT_WASTING'
export type WordPlaceState = 'OPEN' | 'BLOCKED' | 'HELD' | 'NOT_WASTING'
export interface Held { label: string; reason: string }

export interface WordRow {
  /** `word:<market>|<word>` */
  id: string
  word: string
  words: 1 | 2
  market: string
  currency: string
  /** Distinct shoppers' search terms that hold it (its words next to each other, in order). */
  terms: number
  /** Of those, the ones that sold in their window. */
  sold: number
  d: RowNumbers
  places: { adGroups: number; campaigns: number; open: number; blocked: number }
  products: number
  product: Ref | null
  state: WordState
  /** The state in one sentence, true for the whole row (which product's part wastes; the numbers are every product's). */
  stateWhy: string
  /** The product whose part wastes (the one that spent most when several do); null when none does. */
  wastesFor: null | { product: Ref | null; terms: number; adGroups: number; orders: number; products: number }
  verb: { action: 'NEGATE_PHRASE'; where: 'adGroup'; held: Held | null; places: number }
  test: RowTest
  /** A 2-word piece one of whose words wastes too: blocking that word blocks it. */
  coveredBy: string | null
  stockOutDays: number
}

export interface WordTotals { wasting: number; blocked: number; held: number; protected: number; all: number }

export interface WordsAnswer {
  rows: WordRow[]
  total: number
  page: number
  pageSize: number
  totals: WordTotals
  criteria: WasteCriteria
  freshness: WasteFreshness
}

export interface WordTerm {
  rowId: string
  text: string
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref
  product: Ref | null
  productCount: number
  d: RowNumbers | null
  sold: boolean
  state: RowState
}

export interface WordPlace {
  level: 'AD_GROUP' | 'CAMPAIGN'
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref | null
  product: Ref | null
  productCount: number
  campaignId: string
  adGroupId: string | null
  terms: number
  d: RowNumbers
  state: WordPlaceState
  held: Held | null
  blockedBy: null | { rowId: string; text: string; level: 'AD_GROUP' | 'CAMPAIGN' }
}

export interface WordProduct { product: Ref | null; productCount: number; terms: number; places: number; d: RowNumbers; test: RowTest }

export interface WordDetail { row: WordRow; terms: WordTerm[]; places: WordPlace[]; products: WordProduct[]; history: HistoryItem[] }
