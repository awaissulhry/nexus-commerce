import type { SectionLayoutValue, SectionSpec } from '@nexus/ui/patterns'
import type { LiveState } from '../../../quality/_shared/model'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import type { ChasePreview, Late, LateRow, Spend, SpendLines } from '../api'
import type { ChaseGroup, ReportsAddress, ReportsCan, ReportSection, SpendCsvWords, SpendMeasure } from '../model'

/** One read: each panel reads and fails on its own (design: "own empty and error state"). */
export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** The drill ("POs behind this bar") of one group. */
export interface DrillState {
  readonly key: string
  readonly read: Read<SpendLines>
}

/** One order's chase, once sent (or refused, in words). */
export interface ChaseResult {
  readonly orderId: string
  readonly number: string
  readonly ok: boolean
  /** The address it went to, or the refusal's message key (purchasing-reports). */
  readonly words: string
}

/** A chase being prepared or sent: one order (with its preview) or several (Chase N orders). */
export interface ChaseState {
  readonly groups: readonly ChaseGroup[]
  /** One order: what its chase would say (GET …/chase). */
  readonly preview: Read<ChasePreview> | null
  readonly message: string
  readonly busy: boolean
  readonly results: readonly ChaseResult[] | null
}

/** SCR-255 — Purchasing reports' view model (ReportsView draws it and fetches nothing). */
export interface ReportsModel {
  readonly prefix: string
  readonly can: ReportsCan
  readonly address: ReportsAddress
  /** The top bar's company and site (the site chip). */
  readonly scope: OfficeScope
  /** The period on show (the address's, else the answer's, else this month so far). */
  readonly range: { readonly from: string; readonly to: string }
  /** Today (the API's, else the browser's). */
  readonly today: string
  readonly spend: Read<Spend>
  readonly late: Read<Late>
  /** Late lines read with "Show more" after the first page. */
  readonly lateMore: readonly LateRow[]
  readonly lateMoreBusy: boolean
  /** The next page of late lines (null: all read). */
  readonly lateCursor: string | null
  readonly live: LiveState
  readonly asOf: string | null
  readonly layout: SectionLayoutValue
  readonly specs: readonly SectionSpec[]
  readonly arranging: boolean
  /** What the spend bars show. */
  readonly measure: SpendMeasure
  readonly drill: DrillState | null
  /** The late line whose chain is drawn (null: the first one). */
  readonly chainLine: string | null
  /** The selected late lines (their ids). */
  readonly selected: readonly string[]
  readonly chase: ChaseState | null
  /** Design case: the keyboard shortcuts dialog stands open. */
  readonly keysOpen?: boolean
}

export interface ReportsActions {
  onAddress?: (change: Partial<ReportsAddress>) => void
  onRetry?: (panel: ReportSection) => void
  onArrange?: (open: boolean) => void
  onArranged?: (next: SectionLayoutValue) => void
  onExportSpend?: (words: SpendCsvWords, total: string) => void
  onExportLate?: (rows: readonly LateRow[], header: string[], reason: (reason: LateRow['reasons'][number]) => string) => void
  onMeasure?: (measure: SpendMeasure) => void
  /** A bar: open its drill (null: close it). */
  onDrill?: (key: string | null) => void
  onDrillRetry?: () => void
  onDrillExport?: (header: string[], words: { kind: (kind: 'production' | 'samples') => string; locale: 'it' | 'en'; cost: boolean }) => void
  onChain?: (lineId: string) => void
  /** B-W2b-434 (follow-up DB1:01): pin this page's panels to a Home dashboard (saved for me on the server). */
  onSaveAsDashboard?: () => void
  onSelected?: (ids: string[]) => void
  onLateMore?: () => void
  /** Chase one order's late lines, or the selected lines by order (null: close). */
  onChase?: (groups: readonly ChaseGroup[] | null) => void
  onChaseMessage?: (text: string) => void
  onChaseSend?: () => void
}
