import type { SectionLayoutValue, SectionSpec } from '@nexus/ui/patterns'
import type { LiveState } from '../../../quality/_shared/model'
import type { Cr6, Expiries, Gaps, Kpis, Register } from '../api'
import type { CsvWords, ReportsAddress, ReportsCan, ReportSection } from '../model'

/** One panel's read: each reads and fails on its own (design: "the rest of the page stays usable"). */
export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** SCR-261 — Compliance reports' view model (ReportsView draws it and fetches nothing). */
export interface ReportsModel {
  readonly prefix: string
  readonly can: ReportsCan
  readonly address: ReportsAddress
  /** The screen's company, by name (the top bar's). */
  readonly companyName: string | null
  /** The period on show (the address's, else the answer's, else the 365 days up to today). */
  readonly range: { readonly from: string; readonly to: string }
  /** Today (the API's, else the browser's): the annual review's years. */
  readonly today: string
  readonly kpis: Read<Kpis>
  readonly gaps: Read<Gaps>
  readonly expiries: Read<Expiries>
  readonly cr6: Read<Cr6>
  readonly register: Read<Register>
  readonly live: LiveState
  readonly asOf: string | null
  readonly layout: SectionLayoutValue
  readonly specs: readonly SectionSpec[]
  readonly arranging: boolean
  /** Design case: the keyboard shortcuts dialog stands open. */
  readonly keysOpen?: boolean
}

export interface ReportsActions {
  onAddress?: (change: Partial<ReportsAddress>) => void
  onRetry?: (panel: ReportSection) => void
  onArrange?: (open: boolean) => void
  onArranged?: (next: SectionLayoutValue) => void
  onExport?: (panel: ReportSection, words: CsvWords) => void
}
