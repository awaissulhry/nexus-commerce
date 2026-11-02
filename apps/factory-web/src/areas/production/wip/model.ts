import { isApiError, issuePath } from '../../../lib/api/errors'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { readProblem } from '../_shared/model'
import type { HeatmapAnswer, Hour, LineHours, LineTargets, ReasonOption, TrackedBundle } from './api'

/**
 * Floor now's W2b rules (B-W2b-66; SCR-073; MES-161, MES-162, MES-168), pure: who may read and do what, the hours as the
 * chart's rows, a short hour's "Save reason" held in words, the heat map as the DS Heatmap's arrays with its piles in
 * words, the stuck rows, the line TV's address, a line's targets as a draft and what it sends. Line totals only.
 */

export interface FloorBoardsCan {
  /** production.boards.view: hour by hour, the heat map, the line TV. */
  readonly boards: boolean
  /** production.boards.targets: set a line's hourly targets. */
  readonly targets: boolean
  /** production.bundles.view: the stuck bundles and their tile. */
  readonly bundles: boolean
  /** production.calls.view: the open help calls tile. */
  readonly calls: boolean
}

export function floorBoardsCan(permissions: readonly string[]): FloorBoardsCan {
  const held = new Set(permissions)
  return { boards: held.has('production.boards.view'), targets: held.has('production.boards.targets'), bundles: held.has('production.bundles.view'), calls: held.has('production.calls.view') }
}

/** What a live change re-reads: the scan-fed boards (at most every 10 seconds), the help calls, or a short hour's reason. */
export function boardsLiveTouches(change: { type: string }): 'scan' | 'calls' | 'hours' | null {
  if (change.type === 'production.scan_recorded' || change.type === 'production.bundle_stuck') return 'scan'
  if (change.type.startsWith('help_call.')) return 'calls'
  if (change.type === 'line_targets.changed' || change.type === 'line_target.reason_given') return 'hours'
  return null
}

/** Whether a change touches the Office's preview of a line's board. */
export const boardTouched = (change: { type: string }): boolean => boardsLiveTouches(change) !== null

// ---- hour by hour ------------------------------------------------------------------------------------------------------

/** The graph's row of an hour: the bar by what the hour is (met, short, still running: its colour), the target as a line on the same axis. */
export function hourRow(hour: Hour): Record<string, number | string> {
  const row: Record<string, number | string> = { hour: hour.label.slice(0, 5) }
  if (hour.state === 'RUNNING') row.running = hour.done
  if (hour.state === 'OVER') {
    row.met = hour.short ? 0 : hour.done
    row.short = hour.short ? hour.done : 0
  }
  if (hour.target) row.target = hour.target.targetPieces
  return row
}

/** The hours a reason is asked for or was given: over and short, or with words on record. */
export const shortHours = (line: LineHours): Hour[] => line.hours.filter((hour) => hour.short || hour.reason !== null)

/** Why "Save reason" is held, as a catalogue key; null: it may be saved. */
export function reasonHeld(reasons: readonly ReasonOption[], draft: { readonly code: string; readonly note: string }): string | null {
  if (draft.code === '') return 'reason.held.code'
  const reason = reasons.find((entry) => entry.code === draft.code)
  if (reason?.needsDetail && draft.note.trim() === '') return 'reason.held.note'
  return null
}

/** A refused write in our words: `refusal.<CODE>` with its `fix.<CODE>`, else the common problem's key. */
export function boardRefusal(error: unknown): { readonly key: string; readonly fix: string | null } {
  if (isApiError(error)) {
    const refusal = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))
    if (refusal) {
      const code = refusal.slice('refusal/'.length)
      return { key: `refusal.${code}`, fix: `fix.${code}` }
    }
    if (error.code === 'version_conflict' || error.kind === 'conflict') return { key: 'refusal.STALE', fix: 'fix.STALE' }
  }
  return { key: readProblem(error), fix: null }
}

// ---- a line's targets ------------------------------------------------------------------------------------------------

export interface TargetDraftRow {
  readonly hour: number
  readonly label: string
  readonly workingMinutes: number
  readonly value: string
  readonly saved: number | null
  readonly version: number | null
  /** A reason was given for the hour: its target may change, not go. */
  readonly reasonGiven: boolean
}

export const targetDraft = (targets: LineTargets): TargetDraftRow[] =>
  targets.hours.map((hour) => ({ hour: hour.hour, label: hour.label, workingMinutes: hour.workingMinutes, value: hour.target ? String(hour.target.targetPieces) : '', saved: hour.target?.targetPieces ?? null, version: hour.target?.version ?? null, reasonGiven: hour.reasonGiven }))

const pieces = (value: string): number | null | 'bad' => {
  const text = value.trim()
  if (text === '') return null
  return /^\d{1,6}$/.test(text) ? Number(text) : 'bad'
}

/** What Save sends: the hours that changed, each at the version read. */
export function targetChanges(rows: readonly TargetDraftRow[]): { hour: number; targetPieces: number | null; version?: number }[] {
  return rows.flatMap((row) => {
    const value = pieces(row.value)
    if (value === 'bad' || value === row.saved) return []
    return [{ hour: row.hour, targetPieces: value, ...(row.version === null ? {} : { version: row.version }) }]
  })
}

/** Why Save is held, as a catalogue key; null: it may be saved. */
export function targetsHeld(rows: readonly TargetDraftRow[]): string | null {
  if (rows.some((row) => pieces(row.value) === 'bad')) return 'targets.held.number'
  if (rows.some((row) => row.reasonGiven && row.saved !== null && pieces(row.value) === null)) return 'targets.held.reasonGiven'
  if (targetChanges(rows).length === 0) return 'targets.held.nothing'
  return null
}

export const targetsTotal = (rows: readonly TargetDraftRow[]): number => rows.reduce((sum, row) => sum + (typeof pieces(row.value) === 'number' ? (pieces(row.value) as number) : 0), 0)

// ---- the heat map ------------------------------------------------------------------------------------------------------

export interface HeatGrid {
  readonly data: number[][]
  readonly rowLabels: string[]
  readonly colLabels: string[]
  readonly colTitles: string[]
  /** Pile cells, keyed `"row:col"` (the DS outline). */
  readonly marked: ReadonlySet<string>
  /** The piles in words: a colour never says it alone. */
  readonly piles: readonly { readonly line: string | null; readonly operation: string; readonly bundles: number }[]
  readonly rows: HeatmapAnswer['rows']
}

/** The map as the DS Heatmap draws it, only the picked line's row when a line is picked. */
export function heatGrid(map: HeatmapAnswer, lineScope: string | null): HeatGrid {
  const rows = lineScope ? map.rows.filter((row) => row.line?.id === lineScope) : map.rows
  const marked = new Set<string>()
  const piles: { line: string | null; operation: string; bundles: number }[] = []
  rows.forEach((row, r) =>
    row.cells.forEach((cell, c) => {
      if (!cell.pile) return
      marked.add(`${r}:${c}`)
      piles.push({ line: row.line?.code ?? null, operation: map.columns[c]?.name ?? cell.code, bundles: cell.bundles })
    }),
  )
  return {
    data: rows.map((row) => row.cells.map((cell) => cell.bundles)),
    rowLabels: rows.map((row) => row.line?.code ?? ''),
    colLabels: map.columns.map((column) => column.code),
    colTitles: map.columns.map((column) => column.name),
    marked,
    piles,
    rows,
  }
}

// ---- bundles ----------------------------------------------------------------------------------------------------------

/** The last place in words: the operation, the station; or null when it was never scanned. */
export function lastPlace(row: TrackedBundle): { readonly operation: string | null; readonly station: string | null } {
  return { operation: row.lastScan?.operation?.name ?? row.operation?.name ?? null, station: row.lastScan?.station?.code ?? null }
}

/** Where a bundle opens: its record (its panels until the Bundles page is built). */
export const bundleHref = (prefix: string, row: Pick<TrackedBundle, 'id' | 'code' | 'siteId'>): string => `${prefix}${recordAddress({ type: 'Bundle', id: row.id, label: row.code, siteId: row.siteId }, OFFICE_PAGES)}`

/** "Open bundles": Production › Bundles once it is built (never a link that opens nothing). */
export const bundlesHref = (prefix: string, query: string): string | null => (OFFICE_PAGES.has('/production/bundles') ? `${prefix}/production/bundles${query}` : null)

/** CSV of the picked stuck bundles (Export N). */
export function stuckCsv(rows: readonly TrackedBundle[], head: readonly string[]): string {
  const cell = (value: string | number | null) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const lines = rows.map((row) => {
    const where = lastPlace(row)
    return [row.code, row.workOrder.number, row.size, row.quantity, where.operation, where.station, row.stuck.workingHours].map(cell).join(';')
  })
  return [head.map(cell).join(';'), ...lines].join('\r\n')
}

// ---- the line TV -------------------------------------------------------------------------------------------------------

/** The Office's preview of a line's TV (design floor.display › display.preview): a new tab, a window page. */
export const lineTvHref = (prefix: string, lineId: string): string => `${prefix}/production/floor/display?line=${encodeURIComponent(lineId)}`

/** The line `t` and "Open line TV" open: the picked line, else the only one; null: the person picks one first. */
export function tvLine(lines: readonly { readonly id: string }[] | null, scope: string | null): string | null {
  if (scope) return scope
  return lines?.length === 1 ? lines[0]!.id : null
}
