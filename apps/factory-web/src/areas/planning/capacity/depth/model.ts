import { HEAT_BANDS, type HeatBand } from '@nexus/factory-domain/planning/heatmap/bands'
import { formatNumber } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { kindWords } from '../../allocation/depth/model'
export { DEPTH_NAMESPACE } from '../../allocation/depth/model'
import type { Capacity, CapacityLane } from '../api'
import { bucketLabel, dayWords, lanesOf, rangeWords, type CapacityTile, type Words as CapacityWords } from '../model'
import type { HeatCell, Heatmap, HeatLane, Subcontractors, WorkshopCell, WorkshopLine } from './api'

/**
 * Capacity & load in depth (SCR-123; B-W2b-338 on B-W2b-321's API; design planning.capacity table#1 "subcontractors with
 * their weekly minutes or pieces", tiles#1 "Subcontractors over their capacity", sec:heatmap "Lanes down, weeks across,
 * cells coloured by % load with the number in each cell"), pure: the workshop rows of the load table (their cells, how a
 * workshop's capacity is made, what the plan proposes beside it), the tile and the rows it filters to, and the heatmap
 * (its rows, the band of each cell as a colour AND the number written in it, a cell's words, the order the arrows and
 * J / K walk, the key a cell is opened by). Minutes or garments per workshop line only: no money, no person.
 */

export interface Words {
  t: Translate
  locale: Locale
}

const number = (value: number | string, locale: Locale, digits = 1): string => formatNumber(Number(value), locale, { maximumFractionDigits: digits })

// ---- the workshop rows ------------------------------------------------------------------------------------------------

/** A workshop line's tag in a key: its kind of work, `all` for the row with no kind, `none` when no capacity is set. */
export const lineTag = (line: Pick<WorkshopLine, 'unit' | 'workCentreKind'>): string => (line.unit === null ? 'none' : (line.workCentreKind ?? 'all'))

export const workshopRowKey = (line: Pick<WorkshopLine, 'id' | 'unit' | 'workCentreKind'>): string => `WORKSHOP:${line.id}:${lineTag(line)}`
export const workshopCellKey = (line: Pick<WorkshopLine, 'id' | 'unit' | 'workCentreKind'>, bucketKey: string): string => `${workshopRowKey(line)}:${bucketKey}`

export function parseWorkshopKey(key: string | null): { partyId: string; tag: string; bucketKey: string } | null {
  if (!key) return null
  const [kind, partyId, tag, ...rest] = key.split(':')
  if (kind !== 'WORKSHOP' || !partyId || !tag || rest.length === 0) return null
  return { partyId, tag, bucketKey: rest.join(':') }
}

export function workshopCellAt(subs: Subcontractors, key: string | null): { line: WorkshopLine; cell: WorkshopCell } | null {
  const parsed = parseWorkshopKey(key)
  if (!parsed) return null
  const line = subs.lanes.find((entry) => entry.id === parsed.partyId && lineTag(entry) === parsed.tag)
  const cell = line?.cells.find((entry) => entry.key === parsed.bucketKey)
  return line && cell ? { line, cell } : null
}

/** The `workCentreKind` a workshop cell's read names (the row with no kind, or none set: none). */
export const kindOfTag = (tag: string): string | null => (tag === 'all' || tag === 'none' ? null : tag)

/** The workshop line's cell that holds today. */
export const todayWorkshopCell = (line: WorkshopLine, today: string): WorkshopCell | null => line.cells.find((cell) => cell.from <= today && today <= cell.to) ?? null

/** The workshop lines a tile shows: every line (no tile), the lines over this week ('subs'); our lanes' tiles show none. */
export function workshopLinesOf(subs: Subcontractors | null, tile: CapacityTile | null): WorkshopLine[] {
  if (!subs) return []
  if (tile === null) return [...subs.lanes]
  if (tile === 'subs') return subs.lanes.filter((line) => todayWorkshopCell(line, subs.today)?.over ?? false)
  return []
}

/** One row of the load table: a line or work centre (B-W2a-70), or a workshop's capacity line (B-W2b-338). */
export type CapacityRow = { kind: 'lane'; key: string; lane: CapacityLane } | { kind: 'workshop'; key: string; line: WorkshopLine }

export const laneRowKey = (lane: Pick<CapacityLane, 'kind' | 'id'>): string => `${lane.kind}:${lane.id}`

/** The table's rows for a tile: our lanes as B-W2a-70 filters them, then the workshop lines. */
export function rowsOf(capacity: Capacity, subs: Subcontractors | null, tile: CapacityTile | null): CapacityRow[] {
  const lanes = tile === 'subs' ? [] : lanesOf(capacity, tile)
  return [...lanes.map((lane): CapacityRow => ({ kind: 'lane', key: laneRowKey(lane), lane })), ...workshopLinesOf(subs, tile).map((line): CapacityRow => ({ kind: 'workshop', key: workshopRowKey(line), line }))]
}

/** J / K over the workshop cells of the rows shown, row by row, bucket by bucket. */
export const workshopCellOrder = (lines: readonly WorkshopLine[]): string[] => lines.flatMap((line) => line.cells.map((cell) => workshopCellKey(line, cell.key)))

/** A workshop row's second line: "LAB-B · Workshop · sewing, minutes a week". */
export function workshopRowWords(line: WorkshopLine, words: Words): string {
  const { t } = words
  const kind = kindWords(line.workCentreKind, words)
  return line.unit === null ? t('cp.row.none', { code: line.code }) : t(`cp.row.${line.unit}`, { code: line.code, kind })
}

/** The row end: the weekly capacity in force (the design's "with their weekly minutes or pieces"). */
export function workshopRowEnd(line: WorkshopLine, today: string, words: Words): { main: string; full: string } {
  const { t, locale } = words
  if (line.unit === null || line.capacity.length === 0) return { main: t('cp.end.none'), full: t('cp.end.noneFull') }
  const now = line.capacity.find((row) => row.validFrom <= today && (row.validTo === null || today <= row.validTo)) ?? line.capacity[0]!
  const main = t(`cp.end.${line.unit}`, { perWeek: number(now.perWeek, locale, 0) })
  const full = line.capacity
    .map((row) => t(`cp.end.row.${line.unit}`, { perWeek: number(row.perWeek, locale, 0), kind: kindWords(line.workCentreKind, words), from: dayWords(row.validFrom, locale), to: row.validTo ? dayWords(row.validTo, locale) : t('cp.end.open') }))
    .join(' · ')
  return { main, full }
}

/** "How this capacity is made" for a workshop cell: its weekly capacity, the open and closed weekdays, booked and proposed. */
export function workshopHowWords(line: WorkshopLine, cell: Pick<WorkshopCell, 'available' | 'booked' | 'proposed' | 'openDays' | 'closedDays'>, words: Words): string[] {
  const { t, locale } = words
  const lines: string[] = []
  const unit = line.unit ?? 'PIECES'
  if (line.unit === null) lines.push(t('cp.how.noCapacity', { workshop: line.name }))
  else {
    for (const row of line.capacity) lines.push(t(`cp.how.row.${line.unit}`, { perWeek: number(row.perWeek, locale, 0), kind: kindWords(line.workCentreKind, words), from: dayWords(row.validFrom, locale), to: row.validTo ? dayWords(row.validTo, locale) : t('cp.end.open') }))
    lines.push(t('cp.how.spread'))
  }
  lines.push(t('cp.how.days', { open: String(cell.openDays), closed: String(cell.closedDays), count: cell.openDays }))
  if (cell.available !== null) lines.push(t(`cp.how.available.${unit}`, { available: number(cell.available, locale) }))
  lines.push(t(`cp.how.booked.${unit}`, { booked: number(cell.booked, locale) }))
  if (Number(cell.proposed) > 0) lines.push(t(`cp.how.proposed.${unit}`, { proposed: number(cell.proposed, locale) }))
  return lines
}

/** What the plan proposes beside the bar (never in the %): "+772 min proposed". */
export function proposedWords(line: WorkshopLine, cell: Pick<WorkshopCell, 'proposed'>, words: Words): string | null {
  return Number(cell.proposed) > 0 ? words.t(`cp.proposed.${line.unit ?? 'PIECES'}`, { proposed: number(cell.proposed, words.locale, 0) }) : null
}

/** The workshop rows as CSV rows (the same columns as the lanes'; the bucket heads in the page's capacity words). */
export function csvWorkshopRows(subs: Subcontractors, lines: readonly WorkshopLine[], words: Words, capacity: CapacityWords): Array<Array<string | number>> {
  return lines.flatMap((line) =>
    line.cells.map((cell) => {
      const bucket = subs.buckets.find((entry) => entry.key === cell.key) ?? { key: cell.key, kind: subs.bucket, from: cell.from, to: cell.to }
      return [line.code, `${words.t('cp.kind.WORKSHOP')} · ${kindWords(line.workCentreKind, words)}${line.unit ? ` · ${words.t(`cp.unit.${line.unit}`)}` : ''}`, bucketLabel(bucket, capacity), cell.from, cell.to, cell.available ?? '', cell.booked, cell.loadPct ?? '', '', '']
    }),
  )
}

// ---- the heatmap (design sec:heatmap) ---------------------------------------------------------------------------------------

export const BAND_CLASS: Readonly<Record<HeatBand, string>> = { LOW: 'is-low', MEDIUM: 'is-medium', HIGH: 'is-high', OVER: 'is-over', UNKNOWN: 'is-unknown' }

/** A heat lane's key (a workshop's is its capacity line's). */
export const heatLaneKey = (lane: Pick<HeatLane, 'kind' | 'id' | 'unit' | 'workCentreKind'>): string => (lane.kind === 'WORKSHOP' ? workshopRowKey(lane) : `${lane.kind}:${lane.id}`)
export const heatCellKey = (lane: Pick<HeatLane, 'kind' | 'id' | 'unit' | 'workCentreKind'>, weekKey: string): string => `${heatLaneKey(lane)}:${weekKey}`

export function heatCellAt(heat: Heatmap, key: string | null): { lane: HeatLane; cell: HeatCell; row: number; col: number } | null {
  if (!key) return null
  for (const [row, lane] of heat.lanes.entries()) {
    const prefix = `${heatLaneKey(lane)}:`
    if (!key.startsWith(prefix)) continue
    const col = lane.cells.findIndex((cell) => cell.key === key.slice(prefix.length))
    if (col >= 0) return { lane, cell: lane.cells[col]!, row, col }
  }
  return null
}

/** J / K walk the heatmap lane by lane, week by week. */
export const heatOrder = (heat: Heatmap): string[] => heat.lanes.flatMap((lane) => lane.cells.map((cell) => heatCellKey(lane, cell.key)))

/** Where an arrow key goes from a cell (row, column), or null at an edge. */
export function heatStep(heat: Heatmap, row: number, col: number, key: string): { row: number; col: number } | null {
  const rows = heat.lanes.length
  const cols = heat.weeks.length
  const next =
    key === 'ArrowRight' ? { row, col: col + 1 } : key === 'ArrowLeft' ? { row, col: col - 1 } : key === 'ArrowDown' ? { row: row + 1, col } : key === 'ArrowUp' ? { row: row - 1, col } : key === 'Home' ? { row, col: 0 } : key === 'End' ? { row, col: cols - 1 } : null
  if (!next || next.row < 0 || next.row >= rows || next.col < 0 || next.col >= cols) return null
  return next.row === row && next.col === col ? null : next
}

/** A heat lane's name and second line: "Linea 2" · "Line"; "Laboratorio Beta" · "Workshop · sewing, minutes". */
export function heatLaneWords(lane: HeatLane, words: Words): { name: string; sub: string } {
  const { t } = words
  if (lane.kind !== 'WORKSHOP') return { name: lane.name, sub: t(`cp.kind.${lane.kind}`) }
  const kind = kindWords(lane.workCentreKind, words)
  return { name: lane.name, sub: lane.unit === null ? t('cp.heat.subNone') : t(`cp.heat.sub.${lane.unit}`, { kind }) }
}

/** The text a cell writes: the whole percent, "—" when nothing is available (never 0 %). */
export const heatText = (cell: Pick<HeatCell, 'loadPct'>, locale: Locale): string => (cell.loadPct === null ? '—' : `${formatNumber(Math.round(Number(cell.loadPct)), locale, { maximumFractionDigits: 0 })}%`)

/** A cell's whole sentence (its name for a reader and its tooltip): the lane, the week, the load and its band in words. */
export function heatCellWords(lane: HeatLane, cell: HeatCell, words: Words): string {
  const { t, locale } = words
  const week = t('cp.heat.week', { range: rangeWords(cell.from, cell.to, locale) })
  const unit = lane.unit ?? 'MINUTES'
  if (cell.available === null) return t('cp.heat.cellUnknown', { lane: lane.name, week, booked: number(cell.booked, locale, 0), unit: t(`cp.unit.${unit}`) })
  return t('cp.heat.cell', { lane: lane.name, week, pct: heatText(cell, locale), booked: number(cell.booked, locale, 0), available: number(cell.available, locale, 0), unit: t(`cp.unit.${unit}`), band: t(`cp.band.${cell.band}`) })
}

/** The legend, in our words (the API's legend is English). */
export const legendOf = (words: Words): Array<{ band: HeatBand; label: string }> => HEAT_BANDS.map((band) => ({ band, label: words.t(`cp.legend.${band}`) }))

/** A week's column head, as the load table says it ("Week 47 · 16–22 Nov"; the capacity page's words). */
export function heatWeekLabel(week: Heatmap['weeks'][number], capacity: CapacityWords): string {
  return bucketLabel({ key: week.key, kind: 'WEEK', from: week.from, to: week.to }, capacity)
}
