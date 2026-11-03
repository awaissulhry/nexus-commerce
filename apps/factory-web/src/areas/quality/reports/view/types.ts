import type { SectionLayoutValue, SectionSpec } from '@nexus/ui/patterns'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import type { LiveState } from '../../_shared/model'
import type { Compare, Dimension, Incoming, Kpis, Trend } from '../api'
import type { CsvWords, ReportsAddress, ReportsCan, ReportSection } from '../model'

/** One panel's read: each reads and fails on its own (design: "the rest of the page stays usable"). */
export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** SCR-147 — Quality reports' view model (ReportsView draws it and fetches nothing). */
export interface ReportsModel {
  readonly prefix: string
  readonly scope: OfficeScope
  readonly can: ReportsCan
  readonly address: ReportsAddress
  /** The period on show (the address's, else the answer's, else the 30 days up to today). */
  readonly range: { readonly from: string; readonly to: string }
  readonly kpis: Read<Kpis>
  readonly trend: Read<Trend>
  readonly compare: Read<Compare>
  readonly incoming: Read<Incoming>
  readonly live: LiveState
  readonly asOf: string | null
  readonly layout: SectionLayoutValue
  readonly specs: readonly SectionSpec[]
  readonly arranging: boolean
  /** Design cases: the keyboard shortcuts dialog stands open; a week's pop-over stands open. */
  readonly keysOpen?: boolean
  readonly openWeek?: string
}

export interface ReportsActions {
  onAddress?: (change: Partial<ReportsAddress>) => void
  onRetry?: (panel: ReportSection) => void
  onArrange?: (open: boolean) => void
  onArranged?: (next: SectionLayoutValue) => void
  onExport?: (panel: ReportSection, words: CsvWords) => void
  onDimension?: (by: Dimension) => void
}
