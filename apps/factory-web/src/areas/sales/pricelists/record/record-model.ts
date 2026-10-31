import type { ReactNode } from 'react'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { PartyRow, StyleDetail, StyleRow } from '../../quotes/api'
import type { CompareAnswer, PriceEntry, PriceListDetail, VersionAnswer } from '../api'
import type { Phrase, PriceListAbilities, RecordTab, Tone } from '../model'
import type { Loaded } from '../parts'

/**
 * The price list record's view model (SCR-106-record; design sales.pricelists "Record: Price list"): everything the
 * record view draws, from the container (PriceListRecord.tsx). Loaded parts say whether they are there, still coming or
 * failed; nothing is fetched by the view.
 */

export type RecordDialog =
  | { kind: 'activate'; validFrom: string; validTo: string }
  | { kind: 'raise'; pct: string }
  | { kind: 'removePrices' }
  | { kind: 'addPrice' }
  | { kind: 'addCustomers' }
  | { kind: 'removeCustomers' }
  | { kind: 'compare' }
  | { kind: 'archive' }
  | { kind: 'help' }

export interface StylePick {
  query: string
  /** null: not searched yet. */
  results: StyleRow[] | null
  problem: string | null
  /** The style picked, with its colourways. */
  chosen: StyleDetail | null
  /** '' = the style's price for every colourway. */
  colourwayId: string
  price: string
}

export interface CustomerPick {
  query: string
  results: PartyRow[] | null
  problem: string | null
  picked: readonly string[]
  /** B-W2b-16: the customers' "From" (YYYY-MM-DD): today or an earlier day; '' = today. */
  from?: string
}

export interface CompareView {
  beforeId: string
  afterId: string
  answer: CompareAnswer | null
  problem: string | null
  loading: boolean
}

export type CellState = 'saving' | 'failed'

export interface PriceListRecordModel {
  /** `/w/<company>` */
  prefix: string
  tab: RecordTab
  /** Today in the site's zone (YYYY-MM-DD). */
  today: string
  can: PriceListAbilities
  list: Loaded<PriceListDetail>
  /** The version the Prices tab shows (`?version=`, else the draft, else the one in force). */
  versionId: string | null
  prices: { answer: VersionAnswer | null; problem: string | null; loading: boolean }
  /** Rows that changed against the version before, per version (Versions tab); null: not known (yet). */
  changedRows: Readonly<Record<string, number | null>>
  asOf: string | null
  live: 'connecting' | 'live' | 'offline'
  /** Someone else changed the list while a dialog held work. */
  changedAt: string | null
  notice: { tone: Tone; words: Phrase } | null
  busy: boolean
  dialog: RecordDialog | null
  dialogProblem: Phrase | null
  q: string
  selectedPrices: readonly string[]
  selectedCustomers: readonly string[]
  /** A price cell's save: in flight, or refused (the typed value stays until fixed). */
  cells: Readonly<Record<string, CellState>>
  stylePick: StylePick
  customerPick: CustomerPick
  compare: CompareView
  /** The design index's stand-in for the record panels (the live page mounts the real ones). */
  panelsPreview?: RecordPanelsViewModel
  /** Design cases: the row that has the focus. */
  focusRow?: number
}

export interface PriceListRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onRetryPrices?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  /** The Prices tab's version picker (`?version=`). */
  onVersion?: (versionId: string) => void
  onSearch?: (q: string) => void
  onSelectPrices?: (ids: readonly string[]) => void
  onSelectCustomers?: (ids: readonly string[]) => void
  /** A typed price for one row (autosave per cell, on the draft only). */
  onPrice?: (entry: PriceEntry, text: string) => void
  onRaise?: (pct: string) => void
  onRemovePrices?: () => void
  onStyleQuery?: (query: string) => void
  onStylePick?: (styleId: string | null) => void
  onStyleField?: (field: 'colourwayId' | 'price', value: string) => void
  onAddPrice?: () => void
  onCustomerFrom?: (day: string) => void
  onCustomerQuery?: (query: string) => void
  onCustomerToggle?: (partyId: string) => void
  onAddCustomers?: () => void
  onRemoveCustomers?: () => void
  onCompare?: (beforeId: string, afterId: string) => void
  onActivate?: (days: { validFrom: string; validTo: string }) => void
  onNextVersion?: () => void
  onArchive?: () => void
  onReactivate?: () => void
  onCopyCode?: () => void
}

export interface PriceListRecordProps {
  model: PriceListRecordModel
  actions?: PriceListRecordActions
  /** The record panels (thread, files, history) for Activity: the container mounts them. */
  panels?: ReactNode
}
