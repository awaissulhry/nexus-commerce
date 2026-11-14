import type { SectionLayoutValue, SectionSpec } from '@nexus/ui/patterns'
import type { LiveState } from '../../../quality/_shared/model'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import type { Backlog, Headline, Intake, Returns } from '../api'
import type { DrillTarget, ReportsAddress, ReportsCan, ReportSection } from '../model'

/** One read: each panel reads and fails on its own (design: "a failed read is never drawn as empty"). */
export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** SCR-250 — Sales reports' view model (ReportsView draws it and fetches nothing). */
export interface ReportsModel {
  readonly prefix: string
  readonly can: ReportsCan
  readonly address: ReportsAddress
  /** The top bar's company. */
  readonly scope: OfficeScope
  /** The period on show (the address's, else the answer's, else this month so far). */
  readonly range: { readonly from: string; readonly to: string }
  /** Today (the API's, else the browser's). */
  readonly today: string
  readonly headline: Read<Headline>
  readonly intake: Read<Intake>
  readonly backlog: Read<Backlog>
  readonly returns: Read<Returns>
  readonly live: LiveState
  readonly asOf: string | null
  readonly layout: SectionLayoutValue
  readonly specs: readonly SectionSpec[]
  readonly arranging: boolean
  /** The records behind a bar, a cell or a tile (filtered from the panel's own answer); null: closed. */
  readonly drill: DrillTarget | null
  /** Design case: the keyboard shortcuts dialog stands open. */
  readonly keysOpen?: boolean
}

export interface ReportsActions {
  onAddress?: (change: Partial<ReportsAddress>) => void
  onRetry?: (panel: ReportSection) => void
  onArrange?: (open: boolean) => void
  onArranged?: (next: SectionLayoutValue) => void
  /** A panel's (or the drill's) rows as a CSV file (the header and rows in the page's words). */
  onExport?: (panel: ReportSection | 'drill', header: string[], rows: (string | number | null)[][]) => void
  /** Open what a number counts (null: close). */
  onDrill?: (target: DrillTarget | null) => void
  /** B-W2b-434 (follow-up DB1:01): pin this page's panels to a Home dashboard (saved for me on the server). */
  onSaveAsDashboard?: () => void
}
