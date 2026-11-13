import type { LiveState } from '../../_shared/buying/hooks'
import type { AcceptAnswer, Atp, Calculation, PromiseHistory, PromiseList, Proposal, QuoteSuggestion, RepromiseDraft, RiskState, StockStyle, StyleDetail, StyleOption, PromiseTile } from './api'
import type { CalcForm, PromiseCan, PromiseControls, RepromiseForm } from './model'

/**
 * The ONE view model of Planning › Promise dates (SCR-109) and what it may ask for. The view fetches nothing: the page
 * container (PromisePage.tsx) reads the API and fills this; the design cases fill it with made-up data.
 */

/** One read's state: a failed read is never drawn as empty. */
export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

/** A site the page can read promises at (the planning sites; without planning.view the person's own sites). */
export interface PromiseSite {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** A notice after a write (a key of the catalogue and its values). */
export interface PromiseNotice {
  readonly tone: 'success' | 'danger' | 'info'
  readonly key: string
  readonly params?: Record<string, string | number>
}

/** The open history popover of a line (the Changes cell). */
export interface HistoryPopover {
  readonly lineId: string
  readonly history: Loaded<PromiseHistory>
}

/** The Re-promise modal of one line: the draft (with a proposal that waits, if any), the form, a write on its way. */
export interface RepromiseDialog {
  readonly lineId: string
  readonly draft: Loaded<RepromiseDraft>
  readonly form: RepromiseForm | null
  /** Sales' word: tell the customer now (on by default when sales may), the decline's reason. */
  readonly tell: boolean
  readonly declining: boolean
  readonly declineReason: string
  readonly busy: 'propose' | 'accept' | 'decline' | 'withdraw' | null
  /** A refusal in words, with the sizes it names (indexes of the moved sizes sent). */
  readonly problem: { key: string; sizes: readonly number[] } | null
  /** What happened (the modal shows it and offers Close). */
  readonly done: { kind: 'proposed' | 'accepted' | 'declined' | 'withdrawn'; proposal: Proposal; answer?: AcceptAnswer } | null
}

/** The Promise calculator: the style list, the chosen style, the form, the answer; a quote's suggestion when opened from one. */
export interface CalculatorDialog {
  readonly styles: Loaded<StyleOption[]>
  readonly style: Loaded<StyleDetail> | null
  readonly form: CalcForm
  readonly answer: Loaded<Calculation> | null
  readonly quote: Loaded<QuoteSuggestion> | null
  readonly using: boolean
  readonly used: { promiseDate: string } | null
  readonly problem: string | null
}

export interface PromiseModel {
  readonly prefix: string
  readonly can: PromiseCan
  /** The signed-in person (nobody decides their own proposal). */
  readonly me: string
  readonly sites: Loaded<PromiseSite[]>
  readonly siteId: string | null
  readonly controls: PromiseControls
  /** GET /planning/promises: the tiles and the open order lines. */
  readonly list: Loaded<PromiseList>
  readonly history: HistoryPopover | null
  /** Available to promise: the stock styles, the grid of the style picked. */
  readonly styles: Loaded<StockStyle[]>
  readonly atp: Loaded<Atp> | null
  readonly repromise: RepromiseDialog | null
  readonly calculator: CalculatorDialog | null
  readonly live: LiveState
  /** Live changes wait behind "N updates · Show" (rows never move under the cursor). */
  readonly updates: number
  readonly notice: PromiseNotice | null
  readonly dialog: { readonly kind: 'keys' } | null
  /** The office pages that are built (record-links: the order opens its own page once built). */
  readonly built: ReadonlySet<string>
  /** Design cases only: a preset selection, a focused row, the keys panel. */
  readonly selected?: readonly string[]
  readonly selectedAtp?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface PromiseActions {
  onSite?: (siteId: string) => void
  /** A tile pressed: the lines of that saved filter (null: every line). */
  onTile?: (tile: PromiseTile | null) => void
  onRisk?: (risk: RiskState | null) => void
  onSearch?: (q: string) => void
  onRetry?: (section: 'list' | 'atp' | 'styles') => void
  onShowUpdates?: () => void
  /** Open (or close: null) the history popover of a line. */
  onHistory?: (lineId: string | null) => void
  onRetryHistory?: () => void
  /** The re-promise of a line (null: close). */
  onRepromise?: (lineId: string | null) => void
  onRetryDraft?: () => void
  onForm?: (next: Partial<RepromiseForm>) => void
  onDate?: (sizeKey: string, date: string) => void
  onPropose?: () => void
  onTell?: (tell: boolean) => void
  onAccept?: () => void
  onDeclining?: (declining: boolean) => void
  onDeclineReason?: (reason: string) => void
  onDecline?: () => void
  onWithdraw?: () => void
  /** Available to promise: the style (null: none), the weeks, the week of the size grid. */
  onStyle?: (styleId: string | null) => void
  onWeeks?: (weeks: number | null) => void
  onWeek?: (week: string) => void
  /** The calculator (open with a form, e.g. the ticked sizes of Available to promise; close: null). */
  onCalculator?: (open: boolean, form?: CalcForm) => void
  onCalcStyle?: (styleId: string) => void
  onCalcForm?: (next: Partial<CalcForm>) => void
  onCalculate?: () => void
  onUseOnQuote?: () => void
  onOpenOrder?: (href: string) => void
  onExport?: (lineIds: readonly string[]) => void
  onKeys?: () => void
  onCloseDialog?: () => void
  onDismissNotice?: () => void
}
