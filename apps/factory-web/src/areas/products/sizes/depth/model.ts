import { parseSizeValue, sizeValueOf, sizeValueText } from '@nexus/ui/grid/size-columns/index'
import { pointOffsets, RULE_CODE, type GradeFormat } from '@nexus/factory-domain/product/grading/rules'
import { measureOk, POM_CODE, POM_KINDS, POM_LIMITS, POM_UOMS, POM_ZONES, type PomKind, type PomUom, type PomZone } from '@nexus/factory-domain/product/measures/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { PomRow, PomView, RuleRow, RuleView, StepInput } from './api'

/**
 * Sizes & measurements in depth, pure (B-W2b-240; design products.sizes "View switch", "Points of measure", "Grade rules",
 * the Grade rule pop-up, the size scale's Grade rules tab, "Import (W2b)"): which library the page shows and its address,
 * a point's cell checked before it is sent (the API's own rules, said in this page's words), the point and rule dialogs'
 * drafts and their problems, the grade rule's grid (increments per point × size step: the standard one, then each step
 * between neighbour sizes of a fit, or from the base of an absolute rule) and what it grades to, refusals in our words.
 * The views and the containers use these; the tests hold them. No money.
 */

export { POM_KINDS, POM_UOMS, POM_ZONES }
export type { PomKind, PomUom, PomZone }

// ---- the view switch (design sizes.view: "Size scales · Measurement templates · Points of measure · Grade rules") -----

/** The libraries this page shows; `?view=` keeps it (the scales' own `?view=open|archived|all` stays theirs). */
// B-W2b-362: Measurement templates (B-W1-17) join as the second view, the design's order.
export const LIBRARIES = ['scales', 'templates', 'poms', 'rules'] as const
export type Library = (typeof LIBRARIES)[number]
export const libraryOf = (view: string | null | undefined): Library => (view === 'poms' || view === 'rules' || /* B-W2b-362 */ view === 'templates' ? view : 'scales')

/** The state a library list shows (`?status=`). */
export const STATUS_VIEWS = ['open', 'archived', 'all'] as const
export type StatusView = (typeof STATUS_VIEWS)[number]
export const statusViewOf = (value: string | null | undefined): StatusView => ((STATUS_VIEWS as readonly string[]).includes(value ?? '') ? (value as StatusView) : 'open')
export const statusQuery = (view: StatusView): 'ACTIVE' | 'ARCHIVED' | 'ALL' => (view === 'archived' ? 'ARCHIVED' : view === 'all' ? 'ALL' : 'ACTIVE')

export interface DepthFilters {
  status: StatusView
  q: string
  /** Points of measure: BODY or GARMENT; null both. */
  kind: PomKind | null
  /** Grade rules: one scale's; null every scale. */
  scaleId: string | null
}
export const NO_DEPTH_FILTERS: DepthFilters = { status: 'open', q: '', kind: null, scaleId: null }
export const depthFiltered = (filters: DepthFilters): boolean => filters.status !== 'open' || filters.q.trim() !== '' || filters.kind !== null || filters.scaleId !== null

export function depthFiltersOf(params: URLSearchParams | null): DepthFilters {
  const kind = params?.get('kind')
  return {
    status: statusViewOf(params?.get('status')),
    q: params?.get('q') ?? '',
    kind: kind === 'BODY' || kind === 'GARMENT' ? kind : null,
    scaleId: params?.get('scale') || null,
  }
}

/** The page's address for a library and its filters (+ `open`, `new` when given). */
export function depthSearch(library: Library, filters: DepthFilters, extra: { open?: string | null; new?: boolean } = {}): string {
  const search = new URLSearchParams()
  if (library !== 'scales') search.set('view', library)
  if (filters.status !== 'open') search.set('status', filters.status)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  if (library === 'poms' && filters.kind) search.set('kind', filters.kind)
  if (library === 'rules' && filters.scaleId) search.set('scale', filters.scaleId)
  if (extra.open) search.set('open', extra.open)
  if (extra.new) search.set('new', '1')
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** Keys 1–4 switch the view (design kb "1–4 — switch view"). B-W2b-362: the templates view is key 2 (the design's order). */
export const libraryOfKey = (key: string): Library | null => (key === '1' ? 'scales' : key === '2' ? 'templates' : key === '3' ? 'poms' : key === '4' ? 'rules' : null)

// ---- what a person may do -------------------------------------------------------------------------------------------

export interface DepthCan {
  /** product.styles.view: the libraries. */
  view: boolean
  /** product.styles.manage: points, rules, their pictures and steps. */
  manage: boolean
  /** imports.run + files.upload (+ product.styles.manage): a sheet import. */
  importRun: boolean
  importView: boolean
  importApply: boolean
  /** files.read: the how-to picture (the API serves it with the library's read). */
  upload: boolean
}

export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return {
    view: held.has('product.styles.view'),
    manage: held.has('product.styles.manage'),
    importRun: held.has('imports.run') && held.has('files.upload'),
    importView: held.has('imports.view'),
    importApply: held.has('imports.apply'),
    upload: held.has('product.styles.manage'),
  }
}

/** Why Import is held (a key), or null. */
export const importHeld = (can: DepthCan): string | null => (!can.manage ? 'held.noManage' : !can.importRun ? 'import.held' : null)

// ---- numbers -----------------------------------------------------------------------------------------------------------

const INTL = { it: 'it-IT', en: 'en-GB' } as const
export type Locale = 'it' | 'en'

/** "1,5" in Italian, "1.5" in English; "—" for none. */
export const numberText = (value: string | null | undefined, locale: Locale): string => (value === null || value === undefined ? '—' : (sizeValueText(value, INTL[locale], 2) ?? '—'))

/** "+1,5", "−0,5", "0": an increment or an offset as people read it. */
export function signedText(value: string | null | undefined, locale: Locale): string {
  if (value === null || value === undefined) return '—'
  const text = numberText(value.replace(/^-/, ''), locale)
  if (/^-/.test(value) && Number(value) !== 0) return `−${text}`
  return Number(value) === 0 ? text : `+${text}`
}

export const unitText = (uom: PomUom): string => uom.toLowerCase()

/** A typed measure (a tolerance): "1,5" → "1.5"; '' → null; not a measure → false. */
export function typedMeasure(text: string): string | null | false {
  const parsed = parseSizeValue(text, { scale: 2 })
  if (!parsed.ok) return false
  if (parsed.value === null) return null
  return measureOk(parsed.value) ? parsed.value : false
}

// ---- points of measure: one cell --------------------------------------------------------------------------------------

/** The cells a reader may change in the list itself (design "Inline edit, autosave"); the rest in the point's dialog. */
export const POM_CELLS = ['name', 'howTo', 'uom', 'defaultTolerance'] as const
export type PomCell = (typeof POM_CELLS)[number]

export interface CellMark {
  state: 'saving' | 'waiting' | 'refused'
  value?: string
  /** A key of this page's catalogue (refused). */
  problem?: string
}
export const markKey = (id: string, cell: string): string => `${id}:${cell}`

/** What one typed cell sends (only what it names), or why it is refused before it goes. Nothing when nothing changed. */
export function pomCellPatch(point: Pick<PomRow, 'name' | 'howTo' | 'uom' | 'defaultTolerance'>, cell: PomCell, text: string): { patch: Record<string, string | null> } | { problem: string } | null {
  if (cell === 'name') {
    const name = text.trim()
    if (name === '') return { problem: 'poms.problem.name' }
    if (name.length > POM_LIMITS.name) return { problem: 'poms.problem.tooLong' }
    return name === point.name ? null : { patch: { name } }
  }
  if (cell === 'howTo') {
    const howTo = text.trim() === '' ? null : text.trim()
    if (howTo !== null && howTo.length > POM_LIMITS.howTo) return { problem: 'poms.problem.tooLong' }
    return howTo === (point.howTo ?? null) ? null : { patch: { howTo } }
  }
  if (cell === 'uom') {
    if (!(POM_UOMS as readonly string[]).includes(text)) return { problem: 'poms.problem.uom' }
    return text === point.uom ? null : { patch: { uom: text } }
  }
  const tolerance = typedMeasure(text)
  if (tolerance === false) return { problem: 'poms.problem.tolerance' }
  const before = sizeValueOf(point.defaultTolerance)
  return tolerance === before ? null : { patch: { defaultTolerance: tolerance } }
}

// ---- a point's dialog (New point · Edit point) ------------------------------------------------------------------------

export interface PomDraft {
  companyId: string | null
  code: string
  name: string
  kind: PomKind
  bodyZone: PomZone
  uom: PomUom
  /** As typed ("1,5"). */
  defaultTolerance: string
  bodyPointId: string | null
  howTo: string
}

export const blankPom = (companyId: string | null): PomDraft => ({ companyId, code: '', name: '', kind: 'GARMENT', bodyZone: 'UPPER', uom: 'CM', defaultTolerance: '', bodyPointId: null, howTo: '' })

export const pomDraftOf = (point: PomView, locale: Locale): PomDraft => ({
  companyId: point.companyId,
  code: point.code,
  name: point.name,
  kind: point.kind,
  bodyZone: point.bodyZone,
  uom: point.uom,
  defaultTolerance: point.defaultTolerance === null ? '' : locale === 'it' ? point.defaultTolerance.replace('.', ',') : point.defaultTolerance,
  bodyPointId: point.bodyPoint?.id ?? null,
  howTo: point.howTo ?? '',
})

export type PomField = 'code' | 'name' | 'defaultTolerance' | 'howTo' | 'bodyPointId' | 'kind' | 'uom'

/** What would be refused (field → key): the code's shape and once in the library (whatever the case), a name, a tolerance. */
export function pomDraftProblems(draft: PomDraft, taken: readonly string[], selfCode: string | null): Partial<Record<PomField, string>> {
  const problems: Partial<Record<PomField, string>> = {}
  const code = draft.code.trim()
  if (!POM_CODE.test(code)) problems.code = 'poms.problem.code'
  else if (code.toLowerCase() !== (selfCode ?? '').toLowerCase() && taken.some((other) => other.toLowerCase() === code.toLowerCase())) problems.code = 'poms.problem.codeTaken'
  if (draft.name.trim() === '') problems.name = 'poms.problem.name'
  else if (draft.name.trim().length > POM_LIMITS.name) problems.name = 'poms.problem.tooLong'
  if (typedMeasure(draft.defaultTolerance) === false) problems.defaultTolerance = 'poms.problem.tolerance'
  if (draft.howTo.trim().length > POM_LIMITS.howTo) problems.howTo = 'poms.problem.tooLong'
  return problems
}

/** A new point as the API takes it. */
export function pomBody(draft: PomDraft): Record<string, unknown> {
  const tolerance = typedMeasure(draft.defaultTolerance)
  return {
    companyId: draft.companyId,
    code: draft.code.trim(),
    name: draft.name.trim(),
    kind: draft.kind,
    bodyZone: draft.bodyZone,
    uom: draft.uom,
    defaultTolerance: tolerance === false ? null : tolerance,
    bodyPointId: draft.kind === 'GARMENT' ? draft.bodyPointId : null,
    howTo: draft.howTo.trim() === '' ? null : draft.howTo.trim(),
  }
}

/** Only what the dialog changed on an existing point (the kind and unit only while nothing names it: the API says so). */
export function pomPatchOf(draft: PomDraft, point: PomView): Record<string, unknown> {
  const body = pomBody(draft)
  const now: Record<string, unknown> = { code: point.code, name: point.name, kind: point.kind, bodyZone: point.bodyZone, uom: point.uom, defaultTolerance: sizeValueOf(point.defaultTolerance), bodyPointId: point.bodyPoint?.id ?? null, howTo: point.howTo }
  const patch: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(body)) if (field !== 'companyId' && value !== now[field]) patch[field] = value
  return patch
}

/** Why Archive N / Restore N is held for the selection (a key), or null. */
export function statusHeld(rows: ReadonlyArray<{ status: string }>, to: 'ACTIVE' | 'ARCHIVED', manage: boolean, busy: boolean): string | null {
  if (!manage) return 'held.noManage'
  if (rows.length === 0) return 'held.none'
  if (rows.some((row) => row.status === to)) return to === 'ARCHIVED' ? 'held.alreadyArchived' : 'held.alreadyActive'
  if (busy) return 'held.busy'
  return null
}

// ---- grade rules: the New grade rule dialog -----------------------------------------------------------------------------

export interface RuleDraft {
  companyId: string | null
  code: string
  name: string
  scaleId: string
  baseSize: string
  format: GradeFormat
}

export const blankRule = (companyId: string | null, scaleId: string | null): RuleDraft => ({ companyId, code: '', name: '', scaleId: scaleId ?? '', baseSize: '', format: 'RELATIVE' })

export function ruleDraftProblems(draft: RuleDraft, scaleSizes: readonly string[] | null): Partial<Record<keyof RuleDraft, string>> {
  const problems: Partial<Record<keyof RuleDraft, string>> = {}
  if (!RULE_CODE.test(draft.code.trim().toUpperCase())) problems.code = 'rules.problem.code'
  if (draft.name.trim() === '') problems.name = 'rules.problem.name'
  if (!draft.scaleId) problems.scaleId = 'rules.problem.scale'
  else if (!draft.baseSize || (scaleSizes && !scaleSizes.includes(draft.baseSize))) problems.baseSize = 'rules.problem.base'
  return problems
}

// ---- the Grade rule pop-up: increments per point × size step (SizeColumns) -----------------------------------------------

export interface ScaleSizeRef {
  code: string
  label: string | null
  fitCode: string | null
  status: string
}

/** A step column's key: "50>52" (from > to); the standard increment's key is "*". */
export const STANDARD = '*'
export const stepKey = (from: string, to: string): string => `${from}>${to}`
export const stepEnds = (key: string): [string, string] | null => {
  const at = key.indexOf('>')
  return at <= 0 ? null : [key.slice(0, at), key.slice(at + 1)]
}
/** "50 → 52" (a step column's header). */
export const stepLabel = (key: string): string => {
  const ends = stepEnds(key)
  return ends ? `${ends[0]} → ${ends[1]}` : key
}

/** The scale's fits in order: each fit's sizes in the scale's order (one chain, "", on a one-dimension scale). */
export function chainsOf(sizes: readonly ScaleSizeRef[]): string[][] {
  const chains = new Map<string, string[]>()
  for (const size of sizes) {
    if (size.status === 'ARCHIVED') continue
    const chain = chains.get(size.fitCode ?? '') ?? []
    chain.push(size.code)
    chains.set(size.fitCode ?? '', chain)
  }
  return [...chains.values()]
}

/**
 * The step columns: RELATIVE — every pair of neighbour sizes of each fit (50 → 52, 52 → 54 …), then any other step the
 * rule gives (between two fits: 52R → 52L); ABSOLUTE — from the base to every other size.
 */
export function stepColumns(format: GradeFormat, baseSize: string, sizes: readonly ScaleSizeRef[], given: readonly string[]): string[] {
  const keys: string[] = []
  const add = (key: string) => {
    if (!keys.includes(key)) keys.push(key)
  }
  if (format === 'ABSOLUTE') {
    for (const size of sizes) if (size.status !== 'ARCHIVED' && size.code !== baseSize) add(stepKey(baseSize, size.code))
  } else {
    for (const chain of chainsOf(sizes)) for (let index = 1; index < chain.length; index++) add(stepKey(chain[index - 1]!, chain[index]!))
  }
  for (const key of given) add(key)
  return keys
}

/** One row of the pop-up: a point, its standard increment and its steps by column key (null: none given). */
export interface StepRow {
  pointOfMeasureId: string
  code: string
  name: string
  uom: PomUom
  status: 'ACTIVE' | 'ARCHIVED'
  standard: string | null
  steps: Record<string, string | null>
}

export function stepRowsOf(rule: Pick<RuleView, 'byPoint'>): StepRow[] {
  return rule.byPoint.map((point) => ({
    pointOfMeasureId: point.pointOfMeasureId,
    code: point.code,
    name: point.name,
    uom: point.uom,
    status: point.status,
    standard: point.standard,
    steps: Object.fromEntries(point.steps.filter((step) => step.fromSize !== null && step.toSize !== null).map((step) => [stepKey(step.fromSize!, step.toSize!), step.increment])),
  }))
}

/** Every given step of the rows (to keep their columns). */
export const givenKeys = (rows: readonly StepRow[]): string[] => [...new Set(rows.flatMap((row) => Object.entries(row.steps).filter(([, value]) => value !== null).map(([key]) => key)))]

/** The rows as the pop-up's Save sends them: the standard increment, then each given step. */
export function stepsOf(rows: readonly StepRow[]): StepInput[] {
  return rows.flatMap((row) => [
    ...(row.standard !== null ? [{ pointOfMeasureId: row.pointOfMeasureId, fromSize: null, toSize: null, increment: row.standard }] : []),
    ...Object.entries(row.steps).flatMap(([key, increment]) => {
      const ends = stepEnds(key)
      return increment === null || !ends ? [] : [{ pointOfMeasureId: row.pointOfMeasureId, fromSize: ends[0], toSize: ends[1], increment }]
    }),
  ])
}

/** The steps a different base or format no longer allows (an absolute rule's steps start at its base): left out on Save, said first. */
export function droppedSteps(rows: readonly StepRow[], format: GradeFormat, baseSize: string): number {
  if (format !== 'ABSOLUTE') return 0
  return rows.reduce((count, row) => count + Object.entries(row.steps).filter(([key, value]) => value !== null && stepEnds(key)?.[0] !== baseSize).length, 0)
}

/** The rows with only what the format allows (an absolute rule keeps its steps from the base). */
export const allowedRows = (rows: readonly StepRow[], format: GradeFormat, baseSize: string): StepRow[] =>
  format !== 'ABSOLUTE' ? [...rows] : rows.map((row) => ({ ...row, steps: Object.fromEntries(Object.entries(row.steps).filter(([key]) => stepEnds(key)?.[0] === baseSize)) }))

/** The same steps both ways (50 → 52 and 52 → 50) — the API refuses it: the first such pair, or null. */
export function bothWays(rows: readonly StepRow[]): { code: string; from: string; to: string } | null {
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.steps)) {
      const ends = stepEnds(key)
      if (value === null || !ends) continue
      if (row.steps[stepKey(ends[1], ends[0])] !== undefined && row.steps[stepKey(ends[1], ends[0])] !== null) return { code: row.code, from: ends[0], to: ends[1] }
    }
  }
  return null
}

const sameSteps = (a: readonly StepInput[], b: readonly StepInput[]): boolean => {
  const text = (steps: readonly StepInput[]) => steps.map((step) => `${step.pointOfMeasureId}|${step.fromSize ?? ''}|${step.toSize ?? ''}|${Number(step.increment)}`).sort().join(',')
  return text(a) === text(b)
}

/** Did the pop-up change anything (the rule's fields or a step)? */
export function ruleChanged(rule: RuleView, fields: { name: string; baseSize: string; format: GradeFormat }, rows: readonly StepRow[]): { fields: boolean; steps: boolean } {
  const changedFields = fields.name.trim() !== rule.name || fields.baseSize !== rule.baseSize || fields.format !== rule.format
  return { fields: changedFields, steps: !sameSteps(stepsOf(allowedRows(rows, fields.format, fields.baseSize)), stepsOf(stepRowsOf(rule))) }
}

/**
 * What the rule grades to for one row: each size's offset from the base (the domain's own grading: never a silent 0 —
 * a size no step reaches is null).
 */
export function offsetsOf(row: StepRow, rule: { baseSize: string; format: GradeFormat }, sizes: readonly ScaleSizeRef[]): Record<string, string | null> {
  const active = sizes.filter((size) => size.status !== 'ARCHIVED')
  const steps = stepsOf([row]).map((step) => ({ ...step }))
  let offsets: Map<string, { toFixed(): string }>
  try {
    offsets = pointOffsets(rule, steps, active.map((size, index) => ({ code: size.code, seq: index + 1, fitCode: size.fitCode })))
  } catch {
    offsets = new Map()
  }
  return Object.fromEntries(active.map((size) => [size.code, offsets.has(size.code) ? offsets.get(size.code)!.toFixed() : null]))
}

/** Why the pop-up is read only (a key), or null. */
export function ruleHeld(rule: Pick<RuleRow, 'status'>, manage: boolean): string | null {
  if (!manage) return 'held.noManage'
  if (rule.status === 'ARCHIVED') return 'rules.held.archived'
  return null
}

// ---- refusals in our words --------------------------------------------------------------------------------------------

export interface DepthProblem {
  key: string
  /** The refused fields, without `body/`. */
  paths: string[]
  /** The API's own sentences, kept under our words (as the libraries do). */
  messages: string[]
  reload: boolean
}

export function depthProblem(error: unknown): DepthProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', paths: [], messages: [], reload: false }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[./]/, '').replace(/\./g, '/')).filter((path) => path !== '')
  const messages = error.issues.map((issue) => issue.message ?? '').filter((message) => message !== '')
  if (error.kind === 'conflict') {
    if (error.code === 'version_conflict' || paths.some((path) => path.split('/').includes('version'))) return { key: 'problem.write.moved', paths, messages, reload: true }
    if (/in use/i.test(error.message)) return { key: 'problem.write.inUse', paths, messages: messages.length ? messages : [error.message], reload: false }
    if (/taken|already/i.test(error.message)) return { key: 'problem.write.codeTaken', paths, messages, reload: false }
    return { key: 'problem.write.state', paths, messages: messages.length ? messages : [error.message], reload: true }
  }
  if (error.kind === 'invalid') return { key: paths.some((path) => path === 'code') && messages.some((message) => /taken/i.test(message)) ? 'problem.write.codeTaken' : 'problem.write.invalid', paths, messages, reload: false }
  if (error.kind === 'forbidden') return { key: 'held.noManage', paths, messages, reload: false }
  if (['signed_out', 'not_found', 'rate_limited', 'unavailable'].includes(error.kind)) return { key: `problem.write.${error.kind}`, paths, messages, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', paths, messages, reload: false }
}

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  return ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract'].includes(error.kind) ? `problem.read.${error.kind}` : 'problem.read.internal'
}

/** A one-cell refusal for its mark: in use, a bad value, someone else's change. */
export function cellProblem(error: unknown): string {
  const problem = depthProblem(error)
  if (problem.key === 'problem.write.inUse') return 'poms.problem.inUse'
  if (problem.key === 'problem.write.moved') return 'poms.problem.moved'
  if (problem.key === 'problem.write.invalid') return 'poms.problem.invalid'
  if (problem.key === 'held.noManage') return 'held.noManage'
  return 'poms.problem.write'
}

// ---- export (Export N of the selected rows, CSV) --------------------------------------------------------------------

export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
export const csvOf = (rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string => rows.map((row) => row.map(csvCell).join(',')).join('\n')
