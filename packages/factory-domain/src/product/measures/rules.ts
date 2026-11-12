import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'

/**
 * Points of measure and the measurement spec (B-W2b-224; PRD-062, PRD-063, PRD-069; design products.sizes "Points of
 * measure", products.styles › Sizes & measurements › "Measurement spec"), pure. factory-db's `PointOfMeasure`,
 * `MeasurementSpec` and `MeasurementSpecValue` (B-W2b-210) keep them; apps/factory-api's modules/product/measures checks
 * every write against these rules BEFORE it writes, so a database refusal never reaches a person.
 *
 *   point of measure   one library per tenant (tenant-wide or a company's): a code that means the same on every style
 *                      ("CHEST_W"), its name per language, how to measure it (text per language and a picture), its kind
 *                      (BODY: what a rider's body measures; GARMENT: what the finished garment measures), its body zone,
 *                      its unit (CM or MM) and the tolerance a spec takes by default. A GARMENT point may name the BODY
 *                      point it answers to (garment chest width ↔ body chest girth, PRD-069). Its kind and unit change
 *                      only while nothing names it; it is archived, never deleted.
 *   the code           1 to 40 letters, digits, `.`, `_` or `-`, starting with a letter or a digit: the final inspection
 *                      records a measured value by this code (InspectionMeasurement.pointCode), so it is the inspection's
 *                      point code too. Unique in the tenant, whatever the letter case (the inspection matches it so).
 *   the spec           a part of a style revision (written only while the revision is DRAFT): per GARMENT point and size
 *                      of the style's range, a nominal (above 0) and a tolerance under and over it (0 or more), in the
 *                      point's unit. Typed for the base size, graded from it by a grade rule (../grading), then edited: a
 *                      typed value on another size is a manual override (`source` TYPED), a graded one is GRADED. One
 *                      live spec per revision (DRAFT or APPROVED); approval needs a value for every point and size of the
 *                      range; an approved spec changes only after it is reopened; an archived one never changes.
 */

export const POM_KINDS = ['BODY', 'GARMENT'] as const
export type PomKind = (typeof POM_KINDS)[number]

/** Where on the body a point is (factory-db BodyZone; the same list as sales/measure-link's BODY_ZONES). */
export const POM_ZONES = ['UPPER', 'ARMS', 'LEGS', 'RIDING', 'OTHER'] as const
export type PomZone = (typeof POM_ZONES)[number]

/** A point measures a length. */
export const POM_UOMS = ['CM', 'MM'] as const
export type PomUom = (typeof POM_UOMS)[number]

export const POM_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type PomStatus = (typeof POM_STATUSES)[number]

export const SPEC_STATUSES = ['DRAFT', 'APPROVED', 'ARCHIVED'] as const
export type SpecStatus = (typeof SPEC_STATUSES)[number]

export const VALUE_SOURCES = ['TYPED', 'GRADED'] as const
export type ValueSource = (typeof VALUE_SOURCES)[number]

export const POM_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
export const POM_CODE_RULE = '1 to 40 letters, digits, dots, dashes or underscores, starting with a letter or a digit ("CHEST_W")'
export const POM_LIMITS = Object.freeze({ name: 200, description: 2000, howTo: 2000, languages: 12 })
/** At most this many points in one spec, and cells written at once (a pasted sheet). */
export const SPEC_LIMITS = Object.freeze({ points: 120, cells: 3000 })

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
// The database's words rule: no control characters but line breaks and tabs.
const CONTROL = /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 })
const issue = (path: string, message: string): Issue => ({ path, message })

/** A measure as stored: Decimal(8,2), written plainly ("58.5", "58"). */
export const MEASURE = /^\d{1,6}(?:\.\d{1,2})?$/
export const MEASURE_RULE = 'a number with at most 6 digits and 2 decimals ("58.5")'

/** A measure written plainly, without trailing zeros: "58.50" → "58.5", "58.00" → "58". */
export function measureText(value: string | { toString(): string }): string {
  const text = new D(value.toString()).toFixed()
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
  return trimmed === '-0' ? '0' : trimmed
}

export const measureOk = (value: unknown): value is string => typeof value === 'string' && MEASURE.test(value.trim()) && fitsDecimal(value.trim(), 8, 2)
export const nominalOk = (value: unknown): value is string => measureOk(value) && new D(value.trim()).gt(0)
export const sameMeasure = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : new D(a).eq(new D(b)))

const textProblems = (value: string | null, path: string, max: number, required: boolean): Issue[] => {
  if (value === null) return required ? [issue(path, 'Required.')] : []
  if (value.trim() === '') return [issue(path, required ? 'Required.' : 'Leave it out instead of blank.')]
  if (value.length > max) return [issue(path, `At most ${max} characters.`)]
  if (CONTROL.test(value)) return [issue(path, 'No control characters.')]
  return []
}

/** Words per language {"it": "…", "en": "…"}: a language code each, never blank. */
export type Words = Readonly<Record<string, string>>

export function wordsProblems(words: Words | null, path: string, max: number): Issue[] {
  if (words === null) return []
  const entries = Object.entries(words)
  if (entries.length === 0) return [issue(path, 'Give at least one language, or leave it out.')]
  if (entries.length > POM_LIMITS.languages) return [issue(path, `At most ${POM_LIMITS.languages} languages.`)]
  return entries.flatMap(([language, text]) =>
    LANGUAGE.test(language) ? textProblems(typeof text === 'string' ? text : '', `${path}/${language}`, max, true) : [issue(`${path}/${language}`, 'A language code ("it", "en", "de-CH").')],
  )
}

const cleanWords = (words: Words | null | undefined): Words | null => {
  if (!words) return null
  const entries = Object.entries(words).map(([language, text]) => [language.trim(), typeof text === 'string' ? text.trim() : text] as const)
  return entries.length === 0 ? null : Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

const cleanText = (value: string | null | undefined): string | null => (value === null || value === undefined ? null : value.trim() === '' ? null : value.trim())

// ---- the point of measure ---------------------------------------------------------------------------------------------

/** What a point of measure holds (its company and status apart). */
export interface PomFields {
  readonly code: string
  readonly name: string
  readonly nameI18n: Words | null
  readonly description: string | null
  readonly howTo: string | null
  readonly howToI18n: Words | null
  readonly kind: PomKind
  readonly bodyZone: PomZone
  readonly uom: PomUom
  /** The tolerance a spec takes by default, under and over, in its unit; null: typed per spec. */
  readonly defaultTolerance: string | null
  /** A GARMENT point's BODY point (PRD-069). */
  readonly bodyPointId: string | null
}

export type PomPatch = Partial<PomFields>

/** The fields as stored: trimmed, measures written plainly, words in language order. */
export function normalisePom(fields: PomFields): PomFields {
  return {
    code: fields.code.trim(),
    name: fields.name.trim(),
    nameI18n: cleanWords(fields.nameI18n),
    description: cleanText(fields.description),
    howTo: cleanText(fields.howTo),
    howToI18n: cleanWords(fields.howToI18n),
    kind: fields.kind,
    bodyZone: fields.bodyZone,
    uom: fields.uom,
    defaultTolerance: fields.defaultTolerance === null || !measureOk(fields.defaultTolerance) ? fields.defaultTolerance : measureText(fields.defaultTolerance.trim()),
    bodyPointId: fields.bodyPointId,
  }
}

/** A point's body point as the rules need it. */
export interface BodyPointFacts {
  readonly id: string
  readonly code: string
  readonly kind: PomKind
  readonly uom: PomUom
  readonly status: PomStatus
}

/** What is wrong with a point's fields (paths are its field names), everything at once. */
export function pomProblems(fields: PomFields, context: { readonly id: string | null; readonly bodyPoint?: BodyPointFacts | null } = { id: null }): Issue[] {
  const problems: Issue[] = []
  if (!POM_CODE.test(fields.code)) problems.push(issue('code', `Expected ${POM_CODE_RULE}.`))
  problems.push(...textProblems(fields.name, 'name', POM_LIMITS.name, true))
  problems.push(...wordsProblems(fields.nameI18n, 'nameI18n', POM_LIMITS.name))
  problems.push(...textProblems(fields.description, 'description', POM_LIMITS.description, false))
  problems.push(...textProblems(fields.howTo, 'howTo', POM_LIMITS.howTo, false))
  problems.push(...wordsProblems(fields.howToI18n, 'howToI18n', POM_LIMITS.howTo))
  if (!(POM_KINDS as readonly string[]).includes(fields.kind)) problems.push(issue('kind', 'BODY or GARMENT.'))
  if (!(POM_ZONES as readonly string[]).includes(fields.bodyZone)) problems.push(issue('bodyZone', `One of ${POM_ZONES.join(', ')}.`))
  if (!(POM_UOMS as readonly string[]).includes(fields.uom)) problems.push(issue('uom', 'A point of measure is a length: CM or MM.'))
  if (fields.defaultTolerance !== null && !measureOk(fields.defaultTolerance)) problems.push(issue('defaultTolerance', `The default tolerance is 0 or more: ${MEASURE_RULE}.`))
  if (fields.bodyPointId !== null) {
    if (fields.kind !== 'GARMENT') problems.push(issue('bodyPointId', 'Only a garment point names the body point it answers to; a body point is itself the body measure.'))
    else if (context.id !== null && fields.bodyPointId === context.id) problems.push(issue('bodyPointId', 'A point cannot answer to itself.'))
    else if (context.bodyPoint === null) problems.push(issue('bodyPointId', 'No such point of measure.'))
    else if (context.bodyPoint) {
      if (context.bodyPoint.kind !== 'BODY') problems.push(issue('bodyPointId', `${context.bodyPoint.code} is a garment point: name a body point (what the rider's body measures).`))
      else if (context.bodyPoint.status !== 'ACTIVE') problems.push(issue('bodyPointId', `${context.bodyPoint.code} is archived: restore it first, or name another body point.`))
    }
  }
  return problems
}

/** The fields after a patch (only what it names changes; null clears an optional field). */
export function patchedPom(current: PomFields, patch: PomPatch): PomFields {
  const has = (name: keyof PomFields) => Object.hasOwn(patch, name) && patch[name] !== undefined
  return normalisePom({
    code: has('code') ? patch.code! : current.code,
    name: has('name') ? patch.name! : current.name,
    nameI18n: has('nameI18n') ? patch.nameI18n! : current.nameI18n,
    description: has('description') ? patch.description! : current.description,
    howTo: has('howTo') ? patch.howTo! : current.howTo,
    howToI18n: has('howToI18n') ? patch.howToI18n! : current.howToI18n,
    kind: has('kind') ? patch.kind! : current.kind,
    bodyZone: has('bodyZone') ? patch.bodyZone! : current.bodyZone,
    uom: has('uom') ? patch.uom! : current.uom,
    defaultTolerance: has('defaultTolerance') ? patch.defaultTolerance! : current.defaultTolerance,
    bodyPointId: has('bodyPointId') ? patch.bodyPointId! : current.bodyPointId,
  })
}

const sameWords = (a: Words | null, b: Words | null): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The fields that differ (in field order). */
export function pomChanges(before: PomFields, after: PomFields): (keyof PomFields)[] {
  const fields: (keyof PomFields)[] = ['code', 'name', 'nameI18n', 'description', 'howTo', 'howToI18n', 'kind', 'bodyZone', 'uom', 'defaultTolerance', 'bodyPointId']
  return fields.filter((field) => {
    if (field === 'nameI18n' || field === 'howToI18n') return !sameWords(before[field], after[field])
    if (field === 'defaultTolerance') return !sameMeasure(before.defaultTolerance, after.defaultTolerance)
    return before[field] !== after[field]
  })
}

/** What names a point (its kind and unit change only while nothing does; the database refuses it too). */
export interface PomUse {
  readonly templatePoints: number
  readonly specValues: number
  readonly gradeSteps: number
  readonly garmentPoints: number
}

export const inUse = (use: PomUse): boolean => use.templatePoints + use.specValues + use.gradeSteps + use.garmentPoints > 0

/** Words for what names a point: "2 specs' values, 1 grade rule step". */
export function useWords(use: PomUse): string {
  const parts = [
    use.specValues > 0 ? `${use.specValues} measurement spec value(s)` : null,
    use.gradeSteps > 0 ? `${use.gradeSteps} grade rule step(s)` : null,
    use.templatePoints > 0 ? `${use.templatePoints} made-to-measure template point(s)` : null,
    use.garmentPoints > 0 ? `${use.garmentPoints} garment point(s) answering to it` : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? 'nothing' : parts.join(', ')
}

/** Why a change of kind or unit is refused (null: allowed), in words. */
export function kindChangeRefusal(code: string, changed: readonly (keyof PomFields)[], use: PomUse): string | null {
  const fixed = changed.filter((field) => field === 'kind' || field === 'uom')
  if (fixed.length === 0 || !inUse(use)) return null
  const what = fixed.map((field) => (field === 'kind' ? 'kind' : 'unit')).join(' and ')
  return `Point of measure ${code} is in use (${useWords(use)}): its ${what} stay as they are. Make a new point instead.`
}

// ---- the measurement spec ---------------------------------------------------------------------------------------------

/** One cell of a spec. */
export interface SpecCell {
  readonly pointOfMeasureId: string
  readonly size: string
  readonly nominal: string
  readonly toleranceMinus: string
  readonly tolerancePlus: string
  readonly source: ValueSource
}

/** A cell as stored, with its place in the spec. */
export interface SpecValue extends SpecCell {
  readonly id: string
  readonly seq: number
}

/** A cell as written: null nominal takes the cell out. Tolerances left out keep the cell's, else the point's, else its default. */
export interface CellInput {
  readonly pointOfMeasureId: string
  readonly size: string
  readonly nominal: string | null
  readonly toleranceMinus?: string | null | undefined
  readonly tolerancePlus?: string | null | undefined
}

/** A spec's point as the rules know it. */
export interface SpecPoint {
  readonly id: string
  readonly code: string
  readonly kind: PomKind
  readonly status: PomStatus
  readonly defaultTolerance: string | null
}

export interface PlannedCell extends SpecCell {
  /** The cell before (null: new). */
  readonly before: SpecValue | null
}

export interface CellPlan {
  readonly write: readonly PlannedCell[]
  readonly remove: readonly SpecValue[]
  readonly problems: readonly Issue[]
}

const key = (pointId: string, size: string): string => `${pointId}|${size}`

/** The point's tolerance as the spec has it: its base size's, else any size's, else the library's default. */
function pointTolerance(values: readonly SpecValue[], point: SpecPoint, baseSize: string): { minus: string; plus: string } | null {
  const ofPoint = values.filter((value) => value.pointOfMeasureId === point.id)
  const from = ofPoint.find((value) => value.size === baseSize) ?? ofPoint[0]
  if (from) return { minus: from.toleranceMinus, plus: from.tolerancePlus }
  return point.defaultTolerance === null ? null : { minus: point.defaultTolerance, plus: point.defaultTolerance }
}

/**
 * What a list of typed cells does to a spec (a cell of the grid, a pasted sheet, the base size of new points): each cell
 * is written TYPED (the base size, or a manual override of another size), or taken out (nominal null); every problem at
 * once, by `cells/<i>/<field>`. A size is one of the style's range; a point a GARMENT point (a new point of the spec is
 * also an ACTIVE one); each (point, size) once; the nominal above 0; tolerances 0 or more.
 */
export function planCells(
  input: readonly CellInput[],
  context: { readonly values: readonly SpecValue[]; readonly points: ReadonlyMap<string, SpecPoint>; readonly sizes: readonly string[]; readonly baseSize: string },
): CellPlan {
  const problems: Issue[] = []
  const write: PlannedCell[] = []
  const remove: SpecValue[] = []
  if (input.length > SPEC_LIMITS.cells) return { write, remove, problems: [issue('cells', `At most ${SPEC_LIMITS.cells} cells at once.`)] }
  const existing = new Map(context.values.map((value) => [key(value.pointOfMeasureId, value.size), value]))
  const inSpec = new Set(context.values.map((value) => value.pointOfMeasureId))
  const seen = new Set<string>()
  input.forEach((cell, index) => {
    const at = `cells/${index}`
    const before = problems.length
    const point = context.points.get(cell.pointOfMeasureId)
    const size = cell.size.trim().toUpperCase()
    if (!point) problems.push(issue(`${at}/pointOfMeasureId`, 'No such point of measure.'))
    else if (point.kind !== 'GARMENT') problems.push(issue(`${at}/pointOfMeasureId`, `${point.code} is a body point: a measurement spec measures the garment (body measures stay on the size scale).`))
    else if (!inSpec.has(point.id) && point.status !== 'ACTIVE') problems.push(issue(`${at}/pointOfMeasureId`, `${point.code} is archived: it is not added to a spec.`))
    if (!context.sizes.includes(size)) problems.push(issue(`${at}/size`, `Not a size of the style's range: ${cell.size} (${context.sizes.join(', ')}).`))
    const id = key(cell.pointOfMeasureId, size)
    if (seen.has(id)) problems.push(issue(`${at}/size`, `${point?.code ?? 'This point'} of size ${size} is given twice.`))
    seen.add(id)
    if (problems.length > before || !point) return
    const current = existing.get(id) ?? null
    if (cell.nominal === null) {
      if (current) remove.push(current)
      return
    }
    if (!nominalOk(cell.nominal)) problems.push(issue(`${at}/nominal`, `The nominal is above 0: ${MEASURE_RULE}.`))
    for (const end of ['toleranceMinus', 'tolerancePlus'] as const) {
      const value = cell[end]
      if (value !== undefined && value !== null && !measureOk(value)) problems.push(issue(`${at}/${end}`, `A tolerance is 0 or more: ${MEASURE_RULE}.`))
    }
    if (problems.length > before) return
    const fallback = current ? { minus: current.toleranceMinus, plus: current.tolerancePlus } : pointTolerance(context.values, point, context.baseSize)
    const minus = cell.toleranceMinus ?? fallback?.minus ?? null
    const plus = cell.tolerancePlus ?? fallback?.plus ?? null
    if (minus === null || plus === null) {
      problems.push(issue(`${at}/toleranceMinus`, `Type the tolerance of ${point.code}: it has no default tolerance in the library.`))
      return
    }
    write.push({ pointOfMeasureId: point.id, size, nominal: measureText(cell.nominal.trim()), toleranceMinus: measureText(minus.trim()), tolerancePlus: measureText(plus.trim()), source: 'TYPED', before: current })
  })
  return { write, remove, problems }
}

/** A cell's fields that a write changes (nothing: the cell is left as it is). */
export const cellChanged = (cell: SpecCell, before: SpecValue | null): boolean =>
  before === null || !sameMeasure(cell.nominal, before.nominal) || !sameMeasure(cell.toleranceMinus, before.toleranceMinus) || !sameMeasure(cell.tolerancePlus, before.tolerancePlus) || cell.source !== before.source

/** The spec's points in their place (a point's place is the same on every size). */
export function pointOrder(values: readonly Pick<SpecValue, 'pointOfMeasureId' | 'seq'>[]): string[] {
  const place = new Map<string, number>()
  for (const value of values) place.set(value.pointOfMeasureId, Math.min(place.get(value.pointOfMeasureId) ?? Number.MAX_SAFE_INTEGER, value.seq))
  return [...place].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id)
}

/** The place a new point takes: after the last. */
export const nextPlace = (values: readonly Pick<SpecValue, 'seq'>[]): number => values.reduce((last, value) => Math.max(last, value.seq), 0) + 1

/** Each point's new place from an order of every point of the spec once: 1, 2, 3 … */
export function orderProblems(current: readonly string[], asked: readonly string[]): Issue[] {
  const problems: Issue[] = []
  if (new Set(asked).size !== asked.length) problems.push(issue('pointOfMeasureIds', 'Each point once.'))
  const missing = current.filter((id) => !asked.includes(id))
  const unknown = asked.filter((id) => !current.includes(id))
  if (missing.length > 0 || unknown.length > 0) problems.push(issue('pointOfMeasureIds', 'Name every point of the spec once, in the new order.'))
  return problems
}

/** The cells the range asks that the spec does not have, per point (the screen's "— missing"). */
export function missingCells(values: readonly Pick<SpecValue, 'pointOfMeasureId' | 'size'>[], sizes: readonly string[]): { pointOfMeasureId: string; sizes: string[] }[] {
  const have = new Set(values.map((value) => key(value.pointOfMeasureId, value.size)))
  return pointOrder(values.map((value) => ({ ...value, seq: 0 })))
    .map((pointId) => ({ pointOfMeasureId: pointId, sizes: sizes.filter((size) => !have.has(key(pointId, size))) }))
    .filter((entry) => entry.sizes.length > 0)
}

/**
 * Why a spec cannot be approved, in words (empty: it can): at least one point; every value of a size of the range; every
 * point with a value for the base size and every other size of the range (what samples and the final inspection are
 * measured against has no gap).
 */
export function approvalProblems(values: readonly Pick<SpecValue, 'pointOfMeasureId' | 'size'>[], context: { readonly sizes: readonly string[]; readonly baseSize: string; readonly codeOf: (pointId: string) => string }): Issue[] {
  if (values.length === 0) return [issue('spec', 'Add at least one point of measure with its base size value before approving the spec.')]
  const problems: Issue[] = []
  const outside = [...new Set(values.filter((value) => !context.sizes.includes(value.size)).map((value) => value.size))]
  if (outside.length > 0) problems.push(issue('spec', `Sizes ${outside.join(', ')} left the style's range: take their values out first.`))
  const gaps = missingCells(
    values.filter((value) => context.sizes.includes(value.size)),
    context.sizes,
  )
  for (const gap of gaps) problems.push(issue(`points/${gap.pointOfMeasureId}`, `${context.codeOf(gap.pointOfMeasureId)} has no value for ${gap.sizes.join(', ')}${gap.sizes.includes(context.baseSize) ? ' (the base size among them)' : ''}.`))
  return problems
}

/** "58 −1/+1.5 cm", "58 ± 1 cm". */
export function toleranceWords(nominal: string, minus: string, plus: string, uom: string): string {
  const unit = uom.toLowerCase()
  return sameMeasure(minus, plus) ? `${measureText(nominal)} ± ${measureText(minus)} ${unit}` : `${measureText(nominal)} −${measureText(minus)}/+${measureText(plus)} ${unit}`
}

/** Why a spec of a revision cannot be written now (null: it can), in words: the revision a draft, the spec not archived or approved. */
export function specEditRefusal(revision: { readonly revision: number; readonly status: string }, spec: { readonly status: SpecStatus } | null, styleStatus: string): string | null {
  if (styleStatus === 'ARCHIVED') return 'The style is archived: its measurement spec does not change.'
  if (revision.status !== 'DRAFT') return `Revision ${revision.revision} is ${revision.status.toLowerCase()} and frozen: its measurement spec changes only in a new revision (start one from it).`
  if (spec?.status === 'APPROVED') return 'The measurement spec is approved: reopen it to change it.'
  if (spec?.status === 'ARCHIVED') return 'This measurement spec is archived: it never changes.'
  return null
}
