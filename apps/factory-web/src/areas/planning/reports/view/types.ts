import type { SectionLayoutValue, SectionSpec } from '@nexus/ui/patterns'
import type { LiveState } from '../../../quality/_shared/model'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import type { Adherence, AdherenceRows, Cover, CoverRow, Utilisation, UtilisationRows } from '../api'
import type { DrillTarget, ReportsAddress, ReportsCan, ReportSection } from '../model'

/** One read: each panel reads and fails on its own (design: "a failed read is never drawn as empty"). */
export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** The drill ("Work orders behind this bar") of one bar or point. */
export type DrillState = { readonly target: Extract<DrillTarget, { section: 'adherence' }>; readonly read: Read<AdherenceRows> } | { readonly target: Extract<DrillTarget, { section: 'utilisation' }>; readonly read: Read<UtilisationRows> }

/** SCR-254 — Planning reports' view model (ReportsView draws it and fetches nothing). */
export interface ReportsModel {
  readonly prefix: string
  readonly can: ReportsCan
  readonly address: ReportsAddress
  /** The top bar's company and site (the site chip). */
  readonly scope: OfficeScope
  /** The site the reports are about: the top bar's, else (all sites) the first one; null: no site to plan. */
  readonly site: { readonly id: string; readonly name: string } | null
  /** The period on show (the address's, else the answer's, else this month so far). */
  readonly range: { readonly from: string; readonly to: string }
  /** Today (the API's, else the browser's). */
  readonly today: string
  readonly adherence: Read<Adherence>
  readonly utilisation: Read<Utilisation>
  readonly cover: Read<Cover>
  /** The adherence chart's line (null: every line; `none`: not on a line). */
  readonly adherenceLine: string | null
  readonly live: LiveState
  readonly asOf: string | null
  readonly layout: SectionLayoutValue
  readonly specs: readonly SectionSpec[]
  readonly arranging: boolean
  readonly drill: DrillState | null
  /** The selected materials of the cover grid (row ids). */
  readonly selected: readonly string[]
  /** Design case: the keyboard shortcuts dialog stands open. */
  readonly keysOpen?: boolean
}

export interface ReportsActions {
  onAddress?: (change: Partial<ReportsAddress>) => void
  onRetry?: (panel: ReportSection) => void
  onArrange?: (open: boolean) => void
  onArranged?: (next: SectionLayoutValue) => void
  /** A panel's rows as a CSV file (the header and rows in the page's words). */
  onExport?: (panel: ReportSection | 'drill', header: string[], rows: (string | number | null)[][]) => void
  onAdherenceLine?: (lineKey: string | null) => void
  /** A bar or a point: open its work orders (null: close). */
  onDrill?: (target: DrillTarget | null) => void
  onDrillRetry?: () => void
  onSelected?: (ids: string[]) => void
}

/** A cover row's id in the grid (a material and its colour). */
export const coverRowId = (row: Pick<CoverRow, 'item' | 'colour'>): string => `${row.item.id}|${row.colour?.id ?? '-'}`
