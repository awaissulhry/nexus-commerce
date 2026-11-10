import { parseSizeValue, sizeValueOf, sizeValueText, type SizeFillChange } from '@nexus/ui/grid/size-columns/index'
import { measureOk } from '@nexus/factory-domain/product/measures/rules'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { CellInput, GradePreviewView, MeasurementSpecView, SpecCellValue, SpecPoint } from './api'

/**
 * The style's Measurement spec, pure (B-W2b-240; design products.styles › Sizes & measurements › "Measurement spec":
 * "POM code and name (how-to picture) · Tolerance ± · Value per size (SizeColumns; base size highlighted) · Graded or
 * typed (manual override marked)"; "Add POMs", "Apply grade rule → preview of changed cells, manual overrides kept unless
 * chosen", "Paste from a spreadsheet", revision-bound): why the spec cannot change now, the rows and their cells, a typed
 * or pasted sheet read into cells (problems in our words, never a silent 0), a row filled from its base, a row's
 * tolerance, the grade preview as review lines, refusals in our words. No money.
 */

export type SpecPart = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: MeasurementSpecView } | { status: 'error'; problem: string }

export type SpecDialog =
  | { kind: 'start' }
  | { kind: 'add' }
  | { kind: 'grade' }
  | { kind: 'paste' }
  | { kind: 'fill'; pointId: string }
  | { kind: 'tolerance'; pointId: string }
  | { kind: 'remove'; ids: string[] }
  | { kind: 'settings' }
  | { kind: 'approve' }
  | { kind: 'reopen' }
  | { kind: 'archive' }

export interface SpecMark {
  state: 'saving' | 'waiting' | 'refused'
  /** The value typed, shown until the server answers. */
  value?: string | null
  problem?: string
}
export const specMarkKey = (pointId: string, size: string): string => `${pointId}:${size}`

export interface SpecCan {
  /** product.bom.manage: start, type, paste, grade, add and remove points. */
  manage: boolean
  /** product.bom.release: approve and reopen. */
  release: boolean
  /** product.styles.view: the grade rules of the scale and the point library. */
  library: boolean
}

export interface GradeState {
  ruleId: string
  keepOverrides: boolean
  preview: { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: GradePreviewView } | { status: 'error'; problem: string }
}

export interface SpecModel {
  part: SpecPart
  can: SpecCan
  marks: Record<string, SpecMark>
  selected: string[]
  dialog: SpecDialog | null
  offline: boolean
  busy: boolean
  notice: { key: string; tone: 'info' | 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  /** The active grade rules of the style's scale (the grade and settings dialogs); null not read. */
  rules: Array<{ id: string; code: string; name: string; baseSize: string; format: 'RELATIVE' | 'ABSOLUTE' }> | null
  /** The garment points of the library (Add points); null not read. */
  library: Array<{ id: string; code: string; name: string; uom: 'CM' | 'MM'; defaultTolerance: string | null }> | null
  grade: GradeState | null
  /** A how-to picture looked at. */
  looks: Record<string, { state: 'loading' | 'ready' | 'error'; url?: string }>
  /** A refused dialog write, in our words (with the API's own sentences under them). */
  refused: { key: string; messages: string[] } | null
  /** Design cases. */
  focusRow?: number
  paste?: string
}

export interface SpecActions {
  onRetry?: () => void
  onSelect?: (ids: string[]) => void
  onDialog?: (dialog: SpecDialog | null) => void
  onCell?: (pointId: string, size: string, value: string | null) => void
  onRefused?: (pointId: string, size: string, text: string) => void
  onStart?: (body: { baseSize: string; gradeRuleId: string | null; copyFromSpecId: string | null }) => Promise<boolean>
  onSettings?: (patch: { baseSize?: string; gradeRuleId?: string | null }) => Promise<boolean>
  onAdd?: (points: ReadonlyArray<{ pointOfMeasureId: string; nominal: string }>) => Promise<boolean>
  onCells?: (cells: readonly CellInput[], done: { key: string; params?: Record<string, string | number> }) => Promise<boolean>
  onRemove?: (ids: string[]) => Promise<boolean>
  onMove?: (pointId: string, delta: -1 | 1) => void
  onGrade?: (ruleId: string, keepOverrides: boolean) => void
  onApplyGrade?: () => Promise<boolean>
  onSpecMove?: (move: 'approve' | 'reopen' | 'archive', reason?: string) => Promise<boolean>
  onLook?: (pointId: string) => void
  onDismissNotice?: () => void
}

export const NO_SPEC: SpecModel = { part: { status: 'idle' }, can: { manage: false, release: false, library: false }, marks: {}, selected: [], dialog: null, offline: false, busy: false, notice: null, rules: null, library: null, grade: null, looks: {}, refused: null }

// ---- may the spec change now ----------------------------------------------------------------------------------------------

/**
 * Why the spec is read only now (a key), or null: an archived style, a frozen revision, an approved spec (reopen it), no
 * right, the style's edit rule (the API's `editable`).
 */
export function specHeld(view: Pick<MeasurementSpecView, 'style' | 'revision' | 'spec' | 'editable'>, can: Pick<SpecCan, 'manage'>): string | null {
  if (view.style.status === 'ARCHIVED') return 'spec.held.archived'
  if (view.revision.status !== 'DRAFT') return 'spec.held.frozen'
  if (view.spec?.status === 'APPROVED') return 'spec.held.approved'
  if (view.spec?.status === 'ARCHIVED') return 'spec.held.archivedSpec'
  if (!can.manage) return 'spec.held.noManage'
  if (view.spec && !view.editable) return 'spec.held.rule'
  return null
}

/** Why the spec cannot be started now (a key), or null. */
export function startHeld(view: Pick<MeasurementSpecView, 'style' | 'revision' | 'spec' | 'sizes'>, can: Pick<SpecCan, 'manage'>): string | null {
  if (view.style.status === 'ARCHIVED') return 'spec.held.archived'
  if (view.revision.status !== 'DRAFT') return 'spec.held.frozen'
  if (!can.manage) return 'spec.held.noManage'
  if (view.sizes.length === 0) return 'spec.held.noRange'
  return null
}

/** How many cells the range still asks. */
export const missingCount = (view: Pick<MeasurementSpecView, 'missing'>): number => view.missing.reduce((sum, entry) => sum + entry.sizes.length, 0)

/** Why Approve is held (a key), or null: a release right, a draft spec of a draft revision, nothing missing. */
export function approveHeld(view: MeasurementSpecView, can: Pick<SpecCan, 'release'>, busy: boolean): string | null {
  if (!can.release) return 'spec.held.noRelease'
  if (!view.spec || view.spec.status !== 'DRAFT') return 'spec.held.notDraft'
  if (view.revision.status !== 'DRAFT') return 'spec.held.frozen'
  if (view.points.length === 0) return 'spec.held.noPoints'
  if (missingCount(view) > 0) return 'spec.held.missing'
  if (busy) return 'held.busy'
  return null
}

export function reopenHeld(view: MeasurementSpecView, can: Pick<SpecCan, 'release'>, busy: boolean): string | null {
  if (!can.release) return 'spec.held.noRelease'
  if (view.revision.status !== 'DRAFT') return 'spec.held.frozen'
  if (busy) return 'held.busy'
  return null
}

// ---- rows and cells -----------------------------------------------------------------------------------------------------

export interface SpecRow {
  id: string
  point: SpecPoint
  cells: Record<string, SpecCellValue | null>
}

export const specRowsOf = (view: Pick<MeasurementSpecView, 'points'>): SpecRow[] =>
  [...view.points].sort((a, b) => a.seq - b.seq).map((point) => ({ id: point.pointOfMeasureId, point, cells: Object.fromEntries(point.cells.map((cell) => [cell.size, cell.value])) }))

/** A typed value on another size than the base (design "manual override marked"). */
export const isOverride = (row: SpecRow, size: string, base: string | null): boolean => size !== base && row.cells[size]?.source === 'TYPED'

const INTL = { it: 'it-IT', en: 'en-GB' } as const

/** "± 1 cm", "−1 / +1,5 cm"; "varies by size" when the sizes differ; "—" with no value. */
export function toleranceOf(row: SpecRow, base: string | null): { minus: string; plus: string; varies: boolean } | null {
  const values = Object.values(row.cells).filter((value): value is SpecCellValue => value !== null)
  if (values.length === 0) return null
  const first = (base ? row.cells[base] : null) ?? values[0]!
  const varies = values.some((value) => Number(value.toleranceMinus) !== Number(first.toleranceMinus) || Number(value.tolerancePlus) !== Number(first.tolerancePlus))
  return { minus: first.toleranceMinus, plus: first.tolerancePlus, varies }
}

export function toleranceText(tolerance: { minus: string; plus: string } | null, uom: string, locale: 'it' | 'en'): string {
  if (!tolerance) return '—'
  const text = (value: string) => sizeValueText(value, INTL[locale], 2) ?? value
  const unit = uom.toLowerCase()
  return Number(tolerance.minus) === Number(tolerance.plus) ? `± ${text(tolerance.minus)} ${unit}` : `−${text(tolerance.minus)} / +${text(tolerance.plus)} ${unit}`
}

/** The order after moving a point up (-1) or down (+1); null at an end. */
export function movedPoints(rows: readonly SpecRow[], id: string, delta: -1 | 1): string[] | null {
  const ids = rows.map((row) => row.id)
  const at = ids.indexOf(id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= ids.length) return null
  ;[ids[at], ids[to]] = [ids[to]!, ids[at]!]
  return ids
}

/** A cell typed: its nominal must be above 0 (the API's rule), or empty (taken out). Null: fine. */
export function cellProblemOf(value: string | null): string | null {
  if (value === null) return null
  return measureOk(value) && Number(value) > 0 ? null : 'spec.problem.nominal'
}

// ---- paste from a spreadsheet ---------------------------------------------------------------------------------------------

export interface PasteResult {
  cells: CellInput[]
  points: number
  problems: Array<{ key: string; params: Record<string, string | number> }>
}

/**
 * A block copied from a sheet: one line per point (its code first, as in the library, any letter case), then a value per
 * size of the range in its order — or a first line naming the sizes (a header) the values follow. An empty cell is left
 * as it is (never 0); a word or a value of 0 is said, not sent.
 */
export function pasteCells(text: string, view: Pick<MeasurementSpecView, 'points' | 'sizes'>): PasteResult {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim() !== '')
  const split = (line: string) => (line.includes('\t') ? line.split('\t') : line.includes(';') ? line.split(';') : line.trim().split(/\s+/))
  const range = view.sizes.map((size) => size.code)
  const result: PasteResult = { cells: [], points: 0, problems: [] }
  if (lines.length === 0) return result
  let columns = range
  const byCode = new Map(view.points.map((point) => [point.code.toLowerCase(), point]))
  // A first line whose first cell is no point of the spec and whose other cells are sizes of the range is a header.
  const head = split(lines[0]!).map((cell) => cell.trim().toUpperCase())
  const headSizes = head.slice(1)
  if (!byCode.has((head[0] ?? '').toLowerCase()) && headSizes.length > 0 && headSizes.every((cell) => cell === '' || range.includes(cell)) && headSizes.some((cell) => range.includes(cell))) {
    columns = headSizes
    lines.shift()
  }
  for (const line of lines) {
    const cells = split(line)
    const code = (cells[0] ?? '').trim()
    const point = byCode.get(code.toLowerCase())
    if (!point) {
      result.problems.push({ key: 'spec.pasteProblem.unknown', params: { code } })
      continue
    }
    let counted = false
    cells.slice(1).forEach((cell, index) => {
      const size = columns[index]
      if (!size) {
        if (cell.trim() !== '') result.problems.push({ key: 'spec.pasteProblem.over', params: { code: point.code } })
        return
      }
      if (cell.trim() === '') return
      const parsed = parseSizeValue(cell, { scale: 2 })
      if (!parsed.ok || parsed.value === null || cellProblemOf(parsed.value) !== null) {
        result.problems.push({ key: 'spec.pasteProblem.notNumber', params: { code: point.code, size, text: cell.trim() } })
        return
      }
      result.cells.push({ pointOfMeasureId: point.pointOfMeasureId, size, nominal: parsed.value })
      counted = true
    })
    if (counted) result.points++
  }
  // One problem of a kind per point is enough to read.
  const seen = new Set<string>()
  result.problems = result.problems.filter((problem) => {
    const key = `${problem.key}|${problem.params.code}|${problem.key === 'spec.pasteProblem.notNumber' ? problem.params.size : ''}`
    return !seen.has(key) && (seen.add(key), true)
  })
  return result
}

// ---- a row filled from its base, its tolerance -----------------------------------------------------------------------------

/** SizeFill's changes as cells (a value it would make 0 or below is refused by the fill itself). */
export const fillCells = (pointId: string, changes: readonly SizeFillChange[]): CellInput[] => changes.map((change) => ({ pointOfMeasureId: pointId, size: change.size, nominal: change.to }))

/** Every value of a row with a new tolerance under and over (the nominal kept). */
export function toleranceCells(row: SpecRow, minus: string, plus: string): CellInput[] {
  return Object.entries(row.cells)
    .filter(([, value]) => value !== null)
    .map(([size, value]) => ({ pointOfMeasureId: row.id, size, nominal: sizeValueOf(value!.nominal) ?? value!.nominal, toleranceMinus: minus, tolerancePlus: plus }))
}

/** A tolerance typed: 0 or more, at most 2 decimals; null when not. */
export function typedTolerance(text: string): string | null {
  const parsed = parseSizeValue(text, { scale: 2 })
  return parsed.ok && parsed.value !== null && measureOk(parsed.value) ? parsed.value : null
}

// ---- Add points ----------------------------------------------------------------------------------------------------------

export interface AddLine {
  id: string
  picked: boolean
  /** The base size's value as typed. */
  value: string
}

/** What Add sends, or why it is held (a key). */
export function addPlan(lines: readonly AddLine[]): { points: Array<{ pointOfMeasureId: string; nominal: string }> } | { held: string } {
  const picked = lines.filter((line) => line.picked)
  if (picked.length === 0) return { held: 'spec.addDialog.held.none' }
  const points: Array<{ pointOfMeasureId: string; nominal: string }> = []
  for (const line of picked) {
    const parsed = parseSizeValue(line.value, { scale: 2 })
    if (!parsed.ok || parsed.value === null || cellProblemOf(parsed.value) !== null) return { held: 'spec.addDialog.held.value' }
    points.push({ pointOfMeasureId: line.id, nominal: parsed.value })
  }
  return { points }
}

// ---- Apply grade rule: the preview as review lines ------------------------------------------------------------------------

export type GradeAction = GradePreviewView['cells'][number]['action']
export const WRITTEN: readonly GradeAction[] = ['ADD', 'CHANGE', 'OVERWRITE']

/** The cells Apply writes (ADD, CHANGE, OVERWRITE), and the others counted by kind for the lines under them. */
export function gradeLines(preview: GradePreviewView): { written: GradePreviewView['cells']; kept: number; notReached: GradePreviewView['cells']; outOfRange: GradePreviewView['cells'] } {
  return {
    written: preview.cells.filter((cell) => WRITTEN.includes(cell.action)),
    kept: preview.cells.filter((cell) => cell.action === 'KEEP_OVERRIDE').length,
    notReached: preview.cells.filter((cell) => cell.action === 'NOT_REACHED'),
    outOfRange: preview.cells.filter((cell) => cell.action === 'OUT_OF_RANGE'),
  }
}

export function gradeHeld(grade: GradeState | null, busy: boolean, held: string | null): string | null {
  if (held) return held
  if (!grade?.ruleId) return 'spec.grade.held.rule'
  if (grade.preview.status !== 'ready') return 'spec.grade.held.preview'
  if (gradeLines(grade.preview.value).written.length === 0) return 'spec.grade.held.nothing'
  if (busy) return 'held.busy'
  return null
}

// ---- refusals in our words ------------------------------------------------------------------------------------------------

export function specProblem(error: unknown): { key: string; messages: string[]; reload: boolean } {
  if (!isApiError(error)) return { key: 'problem.write.internal', messages: [], reload: false }
  const paths = error.issues.map((issue) => issuePath(issue))
  const messages = error.issues.map((issue) => issue.message ?? '').filter((message) => message !== '')
  if (error.kind === 'conflict') {
    if (error.code === 'version_conflict' || paths.some((path) => path.split(/[./]/).includes('version'))) return { key: 'problem.write.moved', messages, reload: true }
    if (paths.some((path) => path.startsWith('refusal/'))) return { key: 'spec.held.rule', messages, reload: false }
    return { key: 'problem.write.state', messages: messages.length ? messages : [error.message], reload: true }
  }
  if (error.kind === 'invalid') return { key: 'problem.write.invalid', messages, reload: false }
  if (error.kind === 'forbidden') return { key: 'spec.held.noManage', messages, reload: false }
  if (['signed_out', 'not_found', 'rate_limited', 'unavailable'].includes(error.kind)) return { key: `problem.write.${error.kind}`, messages, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', messages, reload: false }
}

/** A cell's refusal for its mark. */
export function specCellProblem(error: unknown): string {
  const problem = specProblem(error)
  if (problem.key === 'problem.write.moved') return 'spec.problem.moved'
  if (problem.key === 'problem.write.invalid') return 'spec.problem.nominal'
  if (problem.key === 'spec.held.rule' || problem.key === 'spec.held.noManage') return problem.key
  if (problem.key === 'problem.write.state') return 'spec.problem.state'
  return 'spec.problem.write'
}
