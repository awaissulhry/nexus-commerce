import { BODY_MEASURE_UNITS, MAX_MEASURE_POINTS, MAX_SCALE_SIZES, MEASURE_POINT, SCALE_CODE, SIZE_CODE } from '@nexus/factory-domain/product/sizes/rules'
import { csvOf, type LibraryCan } from '../library/model'
import type { BodyMeasures, ScaleQuery, ScaleRow, ScaleView, SizeView } from './api'

/**
 * Sizes & measurements rules (SCR-049, size scales), pure: the saved views, sizes typed or pasted in order ("44, 46, 48"
 * or one per line), a size range in words ("44–64"), each size's body measures by point in words ("100–104 cm"), the
 * measure grid's points (every point any size has, in the scale's units), the held reasons (the order stays and a used
 * size's code stays once styles use them), and the CSV.
 */

export { BODY_MEASURE_UNITS }
export type MeasureUnit = (typeof BODY_MEASURE_UNITS)[number]

export const SCALE_VIEWS = ['open', 'archived', 'all'] as const
export type ScaleListView = (typeof SCALE_VIEWS)[number]
export const viewOf = (value: string | null | undefined): ScaleListView => ((SCALE_VIEWS as readonly string[]).includes(value ?? '') ? (value as ScaleListView) : 'open')
export const viewQuery = (view: ScaleListView): ScaleQuery => (view === 'archived' ? { status: 'ARCHIVED' } : view === 'all' ? { status: 'ALL' } : {})

export interface ScaleFilters {
  view: ScaleListView
  q: string
}
export const NO_FILTERS: ScaleFilters = { view: 'open', q: '' }
export const isFiltered = (filters: ScaleFilters): boolean => filters.view !== 'open' || filters.q.trim() !== ''

/** Sizes typed or pasted in order: commas, semicolons, spaces or new lines between them; upper-cased, each once. */
export function parseSizes(text: string): string[] {
  const seen = new Set<string>()
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== '' && !seen.has(part) && (seen.add(part), true))
}

/** The sizes that are not size codes (1 to 10 letters or digits, `.` or `_` inside). */
export const badSizes = (codes: readonly string[]): string[] => codes.filter((code) => !SIZE_CODE.test(code))

/** "44 46 48 … 64": the first three and the last, or all when few. */
export function sizesText(codes: readonly string[]): string {
  if (codes.length <= 6) return codes.join(' ')
  return `${codes.slice(0, 3).join(' ')} … ${codes[codes.length - 1]}`
}

/** "44–64" for a range of codes. */
export const rangeText = (codes: readonly string[]): string => (codes.length === 0 ? '—' : codes.length === 1 ? codes[0]! : `${codes[0]}–${codes[codes.length - 1]}`)

export interface NewScaleDraft {
  companyId: string | null
  code: string
  name: string
  sizes: string
}

export function createHeld(draft: NewScaleDraft, busy: boolean): string | null {
  if (!SCALE_CODE.test(draft.code.trim().toUpperCase())) return 'newScale.held.code'
  if (draft.name.trim() === '') return 'newScale.held.name'
  const codes = parseSizes(draft.sizes)
  if (codes.length === 0) return 'newScale.held.sizes'
  if (badSizes(codes).length > 0) return 'newScale.held.badSizes'
  if (codes.length > MAX_SCALE_SIZES) return 'newScale.held.tooMany'
  if (busy) return 'held.busy'
  return null
}

// ---- body measures ------------------------------------------------------------------------------------------------------

/** Every measurement point the scale's sizes carry, in the order first met (chest before height when 44 says so). */
export function pointsOf(scale: Pick<ScaleView, 'sizes' | 'measureUnits'>): string[] {
  const points: string[] = []
  for (const size of [...scale.sizes].sort((a, b) => a.seq - b.seq)) for (const point of Object.keys(size.bodyMeasures ?? {})) if (!points.includes(point)) points.push(point)
  for (const point of Object.keys(scale.measureUnits)) if (!points.includes(point)) points.push(point)
  return points
}

const num = (value: string, locale: 'it' | 'en') => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 2 }).format(Number(value))

/** "100–104 cm", "≥ 100 cm", "≤ 104 cm", or null when the size has no measure for the point. */
export function measureText(size: Pick<SizeView, 'bodyMeasures'>, point: string, locale: 'it' | 'en'): string | null {
  const measure = size.bodyMeasures?.[point]
  if (!measure) return null
  if (measure.min !== null && measure.max !== null) return `${num(measure.min, locale)}–${num(measure.max, locale)} ${measure.unit}`
  if (measure.min !== null) return `≥ ${num(measure.min, locale)} ${measure.unit}`
  if (measure.max !== null) return `≤ ${num(measure.max, locale)} ${measure.unit}`
  return null
}

/** How many active sizes lack a measure for a point (said under the grid, never 0 drawn as a value). */
export const missingFor = (sizes: readonly SizeView[], point: string): number => sizes.filter((size) => size.status === 'ACTIVE' && !size.bodyMeasures?.[point]).length

/** One row of the size dialog's measures: a point with its range as typed. */
export interface MeasureRow {
  point: string
  min: string
  max: string
  unit: MeasureUnit
}

export const rowsOf = (size: Pick<SizeView, 'bodyMeasures'>, points: readonly string[], units: Readonly<Record<string, MeasureUnit>>, locale: 'it' | 'en'): MeasureRow[] =>
  points.map((point) => {
    const measure = size.bodyMeasures?.[point]
    const edit = (value: string | null | undefined) => (value === null || value === undefined ? '' : locale === 'it' ? value.replace('.', ',') : value)
    return { point, min: edit(measure?.min), max: edit(measure?.max), unit: (measure?.unit ?? units[point] ?? 'cm') as MeasureUnit }
  })

const plain = (text: string) => text.trim().replace(/\s/g, '').replace(',', '.')

export type MeasureProblem = { point: string; reason: 'point' | 'number' | 'order' | 'unit' | 'tooMany' }

/** What the measures as typed would be refused for (the API's own rules: a point code, numbers, min ≤ max, one unit per point). */
export function measureProblems(rows: readonly MeasureRow[], units: Readonly<Record<string, MeasureUnit>>): MeasureProblem[] {
  const problems: MeasureProblem[] = []
  const filled = rows.filter((row) => plain(row.min) !== '' || plain(row.max) !== '')
  if (filled.length > MAX_MEASURE_POINTS) problems.push({ point: '', reason: 'tooMany' })
  for (const row of filled) {
    if (!MEASURE_POINT.test(row.point)) problems.push({ point: row.point, reason: 'point' })
    const min = plain(row.min)
    const max = plain(row.max)
    const ok = (value: string) => value === '' || (/^\d{1,6}(?:\.\d{1,2})?$/.test(value) && Number(value) > 0)
    if (!ok(min) || !ok(max)) problems.push({ point: row.point, reason: 'number' })
    else if (min !== '' && max !== '' && Number(min) > Number(max)) problems.push({ point: row.point, reason: 'order' })
    if (units[row.point] && units[row.point] !== row.unit) problems.push({ point: row.point, reason: 'unit' })
  }
  return problems
}

/** The measures as the API wants them: only points with a range; null when none. */
export function measuresOf(rows: readonly MeasureRow[]): BodyMeasures | null {
  const entries = rows
    .filter((row) => plain(row.min) !== '' || plain(row.max) !== '')
    .map((row) => [row.point, { min: plain(row.min) || null, max: plain(row.max) || null, unit: row.unit }] as const)
  return entries.length ? Object.fromEntries(entries) : null
}

// ---- held reasons -------------------------------------------------------------------------------------------------------

/** The order stays once a style uses the scale (their ranges keep it): sizes are added before a size instead. */
export const reorderHeld = (scale: Pick<ScaleView, 'styleCount' | 'status'>, can: Pick<LibraryCan, 'scalesManage'>): string | null =>
  !can.scalesManage ? 'held.noManage' : scale.status !== 'ACTIVE' ? 'scale.held.archived' : scale.styleCount > 0 ? 'scale.held.order' : null

/** The scale's code changes only while no style uses it. */
export const scaleCodeHeld = (scale: Pick<ScaleView, 'styleCount'>): boolean => scale.styleCount > 0

export function archiveHeld(rows: readonly ScaleRow[], can: Pick<LibraryCan, 'scalesManage'>): string | null {
  if (!can.scalesManage) return 'held.noManage'
  if (rows.some((row) => row.status === 'ARCHIVED')) return 'list.bulk.archiveHeld'
  return null
}

export const STATUS_TONE = { ACTIVE: 'success', ARCHIVED: 'neutral' } as const

export const SCALE_TABS = ['sizes', 'points', 'whereused'] as const
export type ScaleTab = (typeof SCALE_TABS)[number]
export const tabOf = (value: string | null | undefined): ScaleTab => ((SCALE_TABS as readonly string[]).includes(value ?? '') ? (value as ScaleTab) : 'sizes')

/** The order after moving one size up (-1) or down (+1); null at an end. */
export function moved(codes: readonly string[], code: string, by: -1 | 1): string[] | null {
  const at = codes.indexOf(code)
  const to = at + by
  if (at < 0 || to < 0 || to >= codes.length) return null
  const next = [...codes]
  ;[next[at], next[to]] = [next[to]!, next[at]!]
  return next
}

export function scalesCsv(rows: readonly ScaleRow[], words: { header: readonly string[]; status: (status: string) => string }): string {
  return csvOf(
    words.header,
    rows.map((row) => [row.code, row.name, row.codes.join(' '), row.codes.length, row.styleCount, words.status(row.status)]),
  )
}
