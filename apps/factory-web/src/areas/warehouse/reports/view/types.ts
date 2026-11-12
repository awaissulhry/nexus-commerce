import type { SectionLayoutValue, SectionSpec } from '@nexus/ui/patterns'
import type { LiveState } from '../../../quality/_shared/model'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import type { Ageing, Leather, LeatherMeasure } from '../api'
import type { AgeingSeries, CsvWords, ReportsAddress, ReportsCan, ReportSection } from '../model'

/** One panel's read: each reads and fails on its own (design: "own empty and error state"). */
export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** SCR-257 — Warehouse reports' view model (ReportsView draws it and fetches nothing). */
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
  readonly ageing: Read<Ageing>
  readonly leather: Read<Leather>
  readonly live: LiveState
  readonly asOf: string | null
  readonly layout: SectionLayoutValue
  readonly specs: readonly SectionSpec[]
  readonly arranging: boolean
  /** The ageing chart's series: the share of each type's quantity, or the value (cost grain only). */
  readonly series: AgeingSeries
  /** The leather bars' measure. */
  readonly measure: LeatherMeasure
  /** Design case: the keyboard shortcuts dialog stands open. */
  readonly keysOpen?: boolean
}

export interface ReportsActions {
  onAddress?: (change: Partial<ReportsAddress>) => void
  onRetry?: (panel: ReportSection) => void
  onArrange?: (open: boolean) => void
  onArranged?: (next: SectionLayoutValue) => void
  onExport?: (panel: ReportSection, words: CsvWords) => void
  onSeries?: (series: AgeingSeries) => void
  onMeasure?: (measure: LeatherMeasure) => void
}
