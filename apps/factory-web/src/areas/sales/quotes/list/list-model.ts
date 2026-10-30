import type { CompanyRef } from '../../../../lib/session/session'
import type { PartyDetail, PartyRow, QuoteListRow } from '../api'
import type { DuplicateActions, DuplicateDone, DuplicateModel } from '../duplicate/model'
import type { Grains, ListFilters, QuoteAbilities, QuoteTile, StartFrom, TileCount, Tone } from '../model'

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
  /** B-W2a-49 "Start from" (design pop:quotes.new): Blank, or a past quote copied for this customer. */
  startFrom?: StartFrom
  past?: PastQuotePick
}

/** Start from a past quote: the chosen customer's quotes first, or any quote found by its number. */
export interface PastQuotePick {
  query: string
  /** null: not read yet. */
  results: QuoteListRow[] | null
  problem: string | null
  chosenId: string
  /** The copy's answer, said before the new quote opens (what was left out). */
  done: DuplicateDone | null
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
  /** A bulk action runs (the dialog's button is held meanwhile). */
  busy?: boolean
  /** B-W2a-49: Duplicate a quote (row ⋯); null: closed. */
  duplicate?: DuplicateModel | null
  /** Design cases: the rows ticked, the row that has the focus. */
  selected?: readonly string[]
  focusRow?: number
}

export interface QuotesListActions extends DuplicateActions {
  /** Row ⋯ Duplicate: opens the dialog for that quote. */
  onDuplicateStart?: (row: QuoteListRow) => void
  /** New quote › Start from. */
  onStartFrom?: (startFrom: StartFrom) => void
  onPastSearch?: (query: string) => void
  onPastPick?: (quoteId: string) => void
  onPastOpen?: (quoteId: string) => void
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
  /** Enter on a row: open its record. */
  onOpen?: (id: string) => void
  /** The selected rows as a CSV file (the columns this person sees). */
  onExport?: (ids: readonly string[]) => void
  /** Cancel the selected quotes, one by one with each one's version; resolves true when all were cancelled. */
  onCancelMany?: (ids: readonly string[], reason: string) => Promise<boolean>
}
