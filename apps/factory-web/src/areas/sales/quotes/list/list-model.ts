import type { CompanyRef } from '../../../../lib/session/session'
import type { PartyDetail, PartyRow, QuoteListRow } from '../api'
import type { Grains, ListFilters, QuoteAbilities, QuoteTile, TileCount, Tone } from '../model'

/** The quotes list's view model (SCR-034; design sales.quotes): the container (QuotesPage.tsx) fills it. */

export interface NewQuoteModel {
  /** The selling companies the person may quote for (asked only when there are several). */
  companies: readonly CompanyRef[]
  companyId: string
  /** null: not searched yet. */
  results: PartyRow[] | null
  searchProblem: string | null
  /** The customer picked, read in full (contacts, addresses, warnings). */
  party: PartyDetail | null
  partyProblem: string | null
  contactId: string
  customerRef: string
  /** The number it will get: undefined while it is read, null when the company has no single active series. */
  number: string | null | undefined
  busy: boolean
  problem: string | null
}

export interface QuotesListViewModel {
  /** `/w/<company>` */
  prefix: string
  me: string
  grains: Grains
  can: QuoteAbilities
  filters: ListFilters
  rows: { items: QuoteListRow[] | null; more: boolean; problem: string | null }
  tiles: Readonly<Record<QuoteTile, TileCount>>
  /** When the rows were read. */
  asOf: string | null
  today: string
  /** Changes the live stream announced since the rows were read ("3 updates · Show"); rows never move by themselves. */
  updates: number
  newQuote: NewQuoteModel | null
  notice: { key: string; tone: Tone; params?: Record<string, string | number> } | null
}

export interface QuotesListActions {
  onFilters?: (filters: ListFilters) => void
  onTile?: (tile: QuoteTile) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onNewQuote?: (open: boolean) => void
  onNewCompany?: (companyId: string) => void
  onNewSearch?: (query: string) => void
  onNewPick?: (partyId: string | null) => void
  onNewField?: (field: 'contactId' | 'customerRef', value: string) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}
