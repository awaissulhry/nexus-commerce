import type { SectionLayoutValue, SectionSpec } from '@nexus/ui/patterns'
import type { LiveState } from '../../../quality/_shared/model'
import type { Actions, Board, CellDetail, Expiries, Feed, GateEvent } from '../api'
import type { CellRef, OverrideDraft, StatusAddress, StatusCan } from '../model'

/** One part's read: each reads and fails on its own (design: "the rest of the page stays usable"). */
export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** The design's sections (cs-kpi, cs-actions, cs-matrix, cs-gates, cs-expiry), in its order. */
export const STATUS_SECTIONS = ['kpi', 'actions', 'matrix', 'gates', 'expiry'] as const
export type StatusSection = (typeof STATUS_SECTIONS)[number]

/** The override pop-up (cs-override): the refusal, the draft, sending, the API's refusal in our words. */
export interface OverrideState {
  readonly event: GateEvent
  readonly draft: OverrideDraft
  /** The fields the person left (their problems show after). */
  readonly touched: readonly ('reason' | 'day')[]
  readonly busy: boolean
  /** A message key of the API's refusal. */
  readonly problem: string | null
}

/** The step-up dialog: open while the override waits for a fresh code. */
export interface StepUpView {
  readonly open: boolean
  readonly busy: boolean
  /** A message key of a refused code. */
  readonly problem: string | null
}

/** SCR-119 — the status board's view model (StatusView draws it and fetches nothing). */
export interface StatusModel {
  readonly prefix: string
  readonly can: StatusCan
  readonly address: StatusAddress
  /** Today in Rome (the ValidityBar's today, the override's days). */
  readonly today: string
  /** Now (the override's limits); an ISO instant. */
  readonly now: string
  readonly board: Read<Board>
  readonly feed: Read<Feed>
  readonly expiries: Read<Expiries>
  /** The markets seen on the board (the markets picker keeps them while some are picked). */
  readonly knownMarkets: readonly { readonly code: string; readonly name: string }[]
  /** The brands seen on the board (the brand picker). */
  readonly brands: readonly { readonly id: string; readonly code: string; readonly name: string }[]
  readonly live: LiveState
  readonly asOf: string | null
  readonly layout: SectionLayoutValue
  readonly specs: readonly SectionSpec[]
  readonly arranging: boolean
  /** The matrix's and the refusals' selected rows (style ids, event ids). */
  readonly selectedStyles: readonly string[]
  readonly selectedEvents: readonly string[]
  /** The cell pop-up (cs-cell): which cell, its read. */
  readonly cell: { readonly at: CellRef; readonly read: Read<CellDetail> } | null
  /** "See all N" (every Needs action line). */
  readonly allActions: Read<Actions> | null
  readonly override: OverrideState | null
  readonly stepUp: StepUpView
  /** A receipt after an override (message key + params). */
  readonly notice: { readonly key: string; readonly params?: Record<string, string | number> } | null
  /** "Show evidence for…" open. */
  readonly finder: boolean
  /** Design cases: the keyboard shortcuts dialog stands open. */
  readonly keysOpen?: boolean
}

export interface StatusActions {
  onAddress?: (change: Partial<StatusAddress>) => void
  onRetry?: (part: 'board' | 'feed' | 'expiry' | 'cell' | 'allActions') => void
  onArrange?: (open: boolean) => void
  onArranged?: (next: SectionLayoutValue) => void
  onSelectStyles?: (ids: string[]) => void
  onSelectEvents?: (ids: string[]) => void
  onCell?: (at: CellRef | null) => void
  onAllActions?: (open: boolean) => void
  onOverride?: (event: GateEvent | null) => void
  onOverrideDraft?: (change: Partial<OverrideDraft>) => void
  onOverrideTouch?: (field: 'reason' | 'day') => void
  onOverrideSend?: () => void
  onStepUpCode?: (code: string) => void
  onStepUpCancel?: () => void
  onDismissNotice?: () => void
  /** Export board (CSV) / the refusals / the lines: the rows given, in the words given. */
  onExport?: (part: 'board' | 'refusals' | 'actions', header: readonly string[], rows: (string | number | null)[][]) => void
  onFinder?: (open: boolean) => void
  /** Open a page of the office (a Fix button, a record). */
  onGo?: (href: string) => void
}
