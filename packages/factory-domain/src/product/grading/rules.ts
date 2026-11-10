import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { measureText, pointOrder, sameMeasure, type SpecValue, type ValueSource } from '../measures/rules'

/**
 * Grade rules and grading (B-W2b-224; PRD-049, PRD-051, PRD-052; design products.sizes "Grade rules", the Grade rule
 * pop-up, products.styles "Apply grade rule"), pure. factory-db's `GradeRule` and `GradeRuleStep` (B-W2b-210) keep them.
 *
 *   a rule        a library entry of ONE size scale (tenant-wide or a company's): its code, name, base size (a size of the
 *                 scale) and how its increments count: RELATIVE (from one size to the next) or ABSOLUTE (from the base).
 *   a step        a point of measure grows by `increment` (in the point's unit; 0 or negative too) from one size to
 *                 another; a step without sizes is the point's standard increment (one per point and rule). A rule grades
 *                 GARMENT points (the measurement spec).
 *   two dimensions (PRD-049) a scale of size and fit (50R 50L 52R 52L; SizeScale.dimensions 2, Size.fitCode): each size
 *                 still has ONE code everywhere. The sizes of one fit, in the scale's order, are a chain (50R → 52R); a
 *                 standard increment runs along each chain, and a step between two fits (52R → 52L) is always given.
 *
 * Grading (PRD-052): the offset of each size from the rule's base size, per point —
 *   RELATIVE   along the steps: a given step from → to adds its increment (back the other way it takes it off); between
 *              neighbours of one chain without a given step, the standard increment; the shortest way from the base,
 *              the scale's order deciding between two equal ones.
 *   ABSOLUTE   a given step from the base to the size; else the standard increment times the places from the base along
 *              its chain.
 * A size no step reaches is NOT graded (never a silent 0): its cell stays as it is and the preview says so. A spec value
 * of size S = the spec's base value + offset(S) − offset(spec's base size) (the spec's base may differ from the rule's);
 * the tolerances are the base value's. The base size's own value is typed, never graded. A typed value on another size is
 * a manual override: kept unless the person chooses to overwrite it.
 */

export const GRADE_FORMATS = ['RELATIVE', 'ABSOLUTE'] as const
export type GradeFormat = (typeof GRADE_FORMATS)[number]

export const RULE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type RuleStatus = (typeof RULE_STATUSES)[number]

export const RULE_CODE = /^[A-Z0-9](?:[A-Z0-9._/-]{0,58}[A-Z0-9])?$/
export const RULE_CODE_RULE = '1 to 60 capital letters or digits, with . _ - / inside ("GR-JACKET-EU")'
export const RULE_LIMITS = Object.freeze({ name: 200, steps: 2000 })

/** An increment: Decimal(8,2), 0 or negative too. */
export const INCREMENT = /^-?\d{1,6}(?:\.\d{1,2})?$/
export const INCREMENT_RULE = 'a number with at most 6 digits and 2 decimals, negative too ("1.5", "-0.5")'

/** A fit code of a two-dimension scale ("R", "L", "S"): letters or digits, at most 10. */
export const FIT_CODE = /^[A-Z0-9]{1,10}$/

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 })
const issue = (path: string, message: string): Issue => ({ path, message })
const CONTROL = /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/

export const incrementOk = (value: unknown): value is string => typeof value === 'string' && INCREMENT.test(value.trim()) && fitsDecimal(value.trim().replace(/^-/, ''), 8, 2)

// ---- two-dimension scales (PRD-049) -----------------------------------------------------------------------------------

/** A size of a scale as grading reads it: its code, place and fit (null on a one-dimension scale). */
export interface ScaleSize {
  readonly code: string
  readonly seq: number
  readonly fitCode: string | null
}

/**
 * What is wrong with the fits of a scale's sizes (paths `<at>/<i>/fitCode`): on a two-dimension scale every size names
 * its fit ("R", "L"); on a one-dimension scale none does (the database refuses either way).
 */
export function fitProblems(dimensions: number, sizes: readonly { readonly code: string; readonly fitCode: string | null }[], at = 'sizes', scaleCode = 'This scale'): Issue[] {
  if (dimensions !== 1 && dimensions !== 2) return [issue('dimensions', 'A size scale has one dimension (size) or two (size and fit).')]
  return sizes.flatMap((size, index) => {
    const path = `${at}/${index}/fitCode`
    if (dimensions === 1) return size.fitCode === null ? [] : [issue(path, `${scaleCode} has one dimension: size ${size.code} names no fit. A scale of size and fit (52R, 52L) is made with two dimensions.`)]
    if (size.fitCode === null) return [issue(path, `${scaleCode} has two dimensions (size and fit): name the fit of size ${size.code} ("R" regular, "L" long, "S" short).`)]
    return FIT_CODE.test(size.fitCode) ? [] : [issue(path, 'A fit is 1 to 10 capital letters or digits ("R", "L").')]
  })
}

/** A fit as stored: trimmed and upper-cased; blank is none. */
export const normaliseFit = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim().toUpperCase())

/** The scale's chains: the sizes of each fit in the scale's order (one chain, key "", on a one-dimension scale). */
export function fitChains(sizes: readonly ScaleSize[]): Map<string, string[]> {
  const chains = new Map<string, string[]>()
  for (const size of [...sizes].sort((a, b) => a.seq - b.seq || (a.code < b.code ? -1 : 1))) {
    const chain = chains.get(size.fitCode ?? '') ?? []
    chain.push(size.code)
    chains.set(size.fitCode ?? '', chain)
  }
  return chains
}

// ---- the rule and its steps -------------------------------------------------------------------------------------------

export interface RuleFields {
  readonly code: string
  readonly name: string
  readonly baseSize: string
  readonly format: GradeFormat
}

export const normaliseRule = (fields: RuleFields): RuleFields => ({ code: fields.code.trim().toUpperCase(), name: fields.name.trim(), baseSize: fields.baseSize.trim().toUpperCase(), format: fields.format })

/** What is wrong with a rule's fields against its scale's sizes. */
export function ruleProblems(fields: RuleFields, scaleSizes: readonly string[]): Issue[] {
  const problems: Issue[] = []
  if (!RULE_CODE.test(fields.code)) problems.push(issue('code', `Expected ${RULE_CODE_RULE}.`))
  if (fields.name === '' || fields.name.length > RULE_LIMITS.name || CONTROL.test(fields.name)) problems.push(issue('name', `A name of 1 to ${RULE_LIMITS.name} characters.`))
  if (!scaleSizes.includes(fields.baseSize)) problems.push(issue('baseSize', `The base size is a size of the scale: ${scaleSizes.join(', ')}.`))
  if (!(GRADE_FORMATS as readonly string[]).includes(fields.format)) problems.push(issue('format', 'RELATIVE (from one size to the next) or ABSOLUTE (from the base size).'))
  return problems
}

export interface StepData {
  readonly pointOfMeasureId: string
  readonly fromSize: string | null
  readonly toSize: string | null
  readonly increment: string
}

/** A rule's point as the step rules read it. */
export interface StepPoint {
  readonly id: string
  readonly code: string
  readonly kind: 'BODY' | 'GARMENT'
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

/** A step as stored: sizes upper-cased, the increment written plainly. */
export const normaliseStep = (step: StepData): StepData => ({
  pointOfMeasureId: step.pointOfMeasureId,
  fromSize: step.fromSize === null || step.fromSize.trim() === '' ? null : step.fromSize.trim().toUpperCase(),
  toSize: step.toSize === null || step.toSize.trim() === '' ? null : step.toSize.trim().toUpperCase(),
  increment: incrementOk(step.increment) ? measureText(step.increment.trim()) : step.increment,
})

/**
 * What is wrong with a rule's whole list of steps (paths `steps/<i>/…`): a GARMENT point (a new one ACTIVE: `kept` are
 * the points the rule had); both sizes or neither, sizes of the scale, never the same; the increment's shape; each
 * (point, from, to) once, one standard increment per point, a pair of sizes in one direction only; an ABSOLUTE rule's
 * steps from its base size.
 */
export function stepProblems(
  steps: readonly StepData[],
  context: { readonly scaleSizes: readonly string[]; readonly baseSize: string; readonly format: GradeFormat; readonly points: ReadonlyMap<string, StepPoint>; readonly kept?: ReadonlySet<string> },
): Issue[] {
  if (steps.length > RULE_LIMITS.steps) return [issue('steps', `At most ${RULE_LIMITS.steps} steps in one rule.`)]
  const problems: Issue[] = []
  const seen = new Set<string>()
  steps.forEach((step, index) => {
    const at = `steps/${index}`
    const point = context.points.get(step.pointOfMeasureId)
    if (!point) problems.push(issue(`${at}/pointOfMeasureId`, 'No such point of measure.'))
    else if (point.kind !== 'GARMENT') problems.push(issue(`${at}/pointOfMeasureId`, `${point.code} is a body point: a grade rule grades the garment spec.`))
    else if (point.status !== 'ACTIVE' && !context.kept?.has(point.id)) problems.push(issue(`${at}/pointOfMeasureId`, `${point.code} is archived: it is not added to a rule.`))
    const name = point?.code ?? 'the point'
    if ((step.fromSize === null) !== (step.toSize === null)) problems.push(issue(`${at}/toSize`, 'Give both sizes of a step, or neither (the standard increment of every step).'))
    for (const end of ['fromSize', 'toSize'] as const) {
      const size = step[end]
      if (size !== null && !context.scaleSizes.includes(size)) problems.push(issue(`${at}/${end}`, `Not a size of the rule's scale: ${size} (${context.scaleSizes.join(', ')}).`))
    }
    if (step.fromSize !== null && step.fromSize === step.toSize) problems.push(issue(`${at}/toSize`, 'A step goes from one size to another.'))
    if (!incrementOk(step.increment)) problems.push(issue(`${at}/increment`, `The increment is ${INCREMENT_RULE}.`))
    if (context.format === 'ABSOLUTE' && step.fromSize !== null && step.fromSize !== context.baseSize) {
      problems.push(issue(`${at}/fromSize`, `An absolute rule counts every increment from its base size ${context.baseSize}: the step of ${name} starts there.`))
    }
    const own = `${step.pointOfMeasureId}|${step.fromSize ?? ''}|${step.toSize ?? ''}`
    const back = `${step.pointOfMeasureId}|${step.toSize ?? ''}|${step.fromSize ?? ''}`
    if (seen.has(own)) problems.push(issue(`${at}/pointOfMeasureId`, step.fromSize === null ? `${name} has one standard increment.` : `${name} from ${step.fromSize} to ${step.toSize} is given twice.`))
    else if (step.fromSize !== null && seen.has(back)) problems.push(issue(`${at}/pointOfMeasureId`, `${name} between ${step.fromSize} and ${step.toSize} is given both ways: give the step once (the other way takes the increment off).`))
    seen.add(own)
  })
  return problems
}

// ---- grading ----------------------------------------------------------------------------------------------------------

/** Each size's offset from the rule's base size for one point (a size no step reaches is absent). */
export function pointOffsets(rule: { readonly baseSize: string; readonly format: GradeFormat }, steps: readonly StepData[], sizes: readonly ScaleSize[]): Map<string, Decimal> {
  const codes = [...sizes].sort((a, b) => a.seq - b.seq || (a.code < b.code ? -1 : 1)).map((size) => size.code)
  const offsets = new Map<string, Decimal>()
  if (!codes.includes(rule.baseSize)) return offsets
  offsets.set(rule.baseSize, new D(0))
  const given = steps.filter((step) => step.fromSize !== null && step.toSize !== null && incrementOk(step.increment))
  const standard = steps.find((step) => step.fromSize === null && incrementOk(step.increment))
  const chains = fitChains(sizes)

  if (rule.format === 'ABSOLUTE') {
    const chainOfBase = [...chains.values()].find((chain) => chain.includes(rule.baseSize)) ?? []
    for (const code of codes) {
      if (code === rule.baseSize) continue
      const out = given.find((step) => step.fromSize === rule.baseSize && step.toSize === code)
      const back = given.find((step) => step.toSize === rule.baseSize && step.fromSize === code)
      if (out) offsets.set(code, new D(out.increment))
      else if (back) offsets.set(code, new D(back.increment).neg())
      else if (standard && chainOfBase.includes(code)) offsets.set(code, new D(standard.increment).times(chainOfBase.indexOf(code) - chainOfBase.indexOf(rule.baseSize)))
    }
    return offsets
  }

  // RELATIVE: the steps as edges both ways, then the standard increment between neighbours of a chain without one.
  const edges = new Map<string, Map<string, Decimal>>(codes.map((code) => [code, new Map()]))
  const link = (from: string, to: string, by: Decimal) => {
    if (!edges.get(from)?.has(to)) edges.get(from)?.set(to, by)
  }
  for (const step of given) {
    edges.get(step.fromSize!)?.set(step.toSize!, new D(step.increment))
  }
  for (const step of given) link(step.toSize!, step.fromSize!, new D(step.increment).neg())
  if (standard) {
    const by = new D(standard.increment)
    for (const chain of chains.values()) {
      for (let index = 1; index < chain.length; index += 1) {
        const lower = chain[index - 1]!
        const upper = chain[index]!
        if (edges.get(lower)?.has(upper) || edges.get(upper)?.has(lower)) continue
        link(lower, upper, by)
        link(upper, lower, by.neg())
      }
    }
  }
  // The shortest way from the base (breadth first; between equal ways, the scale's order).
  const queue = [rule.baseSize]
  while (queue.length > 0) {
    const at = queue.shift()!
    const next = edges.get(at)!
    for (const code of codes) {
      const by = next.get(code)
      if (by === undefined || offsets.has(code)) continue
      offsets.set(code, offsets.get(at)!.plus(by))
      queue.push(code)
    }
  }
  return offsets
}

export const GRADE_ACTIONS = ['ADD', 'CHANGE', 'OVERWRITE', 'KEEP_OVERRIDE', 'SAME', 'NOT_REACHED', 'OUT_OF_RANGE'] as const
export type GradeAction = (typeof GRADE_ACTIONS)[number]

export interface GradedCell {
  readonly pointOfMeasureId: string
  readonly size: string
  readonly action: GradeAction
  readonly before: { readonly nominal: string; readonly toleranceMinus: string; readonly tolerancePlus: string; readonly source: ValueSource } | null
  /** What the cell becomes (ADD, CHANGE, OVERWRITE), or what grading gives where it is kept (KEEP_OVERRIDE, SAME); null where nothing is graded. */
  readonly after: { readonly nominal: string; readonly toleranceMinus: string; readonly tolerancePlus: string } | null
  readonly words: string
}

export interface GradePlan {
  readonly cells: readonly GradedCell[]
  /** The spec's points the rule does not grade (no step names them): left as they are. */
  readonly notInRule: readonly string[]
  /** The spec's points without a value for the spec's base size: nothing to grade from. */
  readonly noBase: readonly string[]
  readonly counts: Readonly<Record<GradeAction, number>>
}

/** The cells a write makes of a plan: added, changed and overwritten (GRADED). */
export const writtenCells = (plan: GradePlan): GradedCell[] => plan.cells.filter((cell) => cell.action === 'ADD' || cell.action === 'CHANGE' || cell.action === 'OVERWRITE')

/**
 * What applying a rule does to a spec (the "Apply grade rule" preview, and the write): every point of the spec the rule
 * grades × every size of the style's range but the spec's base size. `keepOverrides` (the default) keeps a TYPED value
 * on another size; false overwrites it.
 */
export function gradeSpec(input: {
  readonly rule: { readonly baseSize: string; readonly format: GradeFormat }
  readonly steps: readonly StepData[]
  readonly scaleSizes: readonly ScaleSize[]
  readonly baseSize: string
  readonly range: readonly string[]
  readonly values: readonly SpecValue[]
  readonly codeOf: (pointId: string) => string
  readonly unitOf: (pointId: string) => string
  readonly keepOverrides: boolean
}): GradePlan {
  const cells: GradedCell[] = []
  const notInRule: string[] = []
  const noBase: string[] = []
  const counts = Object.fromEntries(GRADE_ACTIONS.map((action) => [action, 0])) as Record<GradeAction, number>
  const push = (cell: GradedCell) => {
    cells.push(cell)
    counts[cell.action] += 1
  }
  for (const pointId of pointOrder(input.values)) {
    const code = input.codeOf(pointId)
    const unit = input.unitOf(pointId).toLowerCase()
    const ofPoint = input.values.filter((value) => value.pointOfMeasureId === pointId)
    const own = input.steps.filter((step) => step.pointOfMeasureId === pointId)
    if (own.length === 0) {
      notInRule.push(pointId)
      continue
    }
    const base = ofPoint.find((value) => value.size === input.baseSize)
    if (!base) {
      noBase.push(pointId)
      continue
    }
    const offsets = pointOffsets(input.rule, own, input.scaleSizes)
    const from = offsets.get(input.baseSize)
    for (const size of input.range) {
      if (size === input.baseSize) continue
      const current = ofPoint.find((value) => value.size === size) ?? null
      const before = current ? { nominal: current.nominal, toleranceMinus: current.toleranceMinus, tolerancePlus: current.tolerancePlus, source: current.source } : null
      const offset = offsets.get(size)
      if (from === undefined || offset === undefined) {
        const missing = from === undefined ? input.baseSize : size
        push({ pointOfMeasureId: pointId, size, action: 'NOT_REACHED', before, after: null, words: `${code} ${size}: no step of the rule reaches ${missing}${current ? '; the value stays' : ''}.` })
        continue
      }
      const nominal = new D(base.nominal).plus(offset).minus(from)
      const text = measureText(nominal.toFixed(2))
      if (nominal.lte(0) || !fitsDecimal(nominal.toFixed(2), 8, 2)) {
        push({ pointOfMeasureId: pointId, size, action: 'OUT_OF_RANGE', before, after: null, words: `${code} ${size}: grading gives ${text} ${unit}, not a measure above 0${current ? '; the value stays' : ''}.` })
        continue
      }
      const after = { nominal: text, toleranceMinus: base.toleranceMinus, tolerancePlus: base.tolerancePlus }
      if (!current) {
        push({ pointOfMeasureId: pointId, size, action: 'ADD', before, after, words: `${code} ${size}: ${text} ${unit} added.` })
        continue
      }
      const same = sameMeasure(current.nominal, after.nominal) && sameMeasure(current.toleranceMinus, after.toleranceMinus) && sameMeasure(current.tolerancePlus, after.tolerancePlus)
      if (current.source === 'TYPED') {
        if (input.keepOverrides) {
          push({ pointOfMeasureId: pointId, size, action: 'KEEP_OVERRIDE', before, after, words: `${code} ${size}: the typed ${measureText(current.nominal)} ${unit} is kept (grading gives ${text}).` })
          continue
        }
        push({ pointOfMeasureId: pointId, size, action: 'OVERWRITE', before, after, words: `${code} ${size}: the typed ${measureText(current.nominal)} ${unit} becomes ${text} ${unit}.` })
        continue
      }
      if (same) {
        push({ pointOfMeasureId: pointId, size, action: 'SAME', before, after, words: `${code} ${size}: ${text} ${unit}, as it is.` })
        continue
      }
      push({ pointOfMeasureId: pointId, size, action: 'CHANGE', before, after, words: `${code} ${size}: ${measureText(current.nominal)} → ${text} ${unit}.` })
    }
  }
  return { cells, notInRule, noBase, counts }
}

/** The preview in one line: "6 cells added, 2 changed, 1 typed value kept, 1 size not reached". */
export function gradeWords(plan: GradePlan): string {
  const { counts } = plan
  const parts = [
    counts.ADD > 0 ? `${counts.ADD} cell(s) added` : null,
    counts.CHANGE > 0 ? `${counts.CHANGE} changed` : null,
    counts.OVERWRITE > 0 ? `${counts.OVERWRITE} typed value(s) overwritten` : null,
    counts.KEEP_OVERRIDE > 0 ? `${counts.KEEP_OVERRIDE} typed value(s) kept` : null,
    counts.SAME > 0 ? `${counts.SAME} as they are` : null,
    counts.NOT_REACHED > 0 ? `${counts.NOT_REACHED} not reached by the rule` : null,
    counts.OUT_OF_RANGE > 0 ? `${counts.OUT_OF_RANGE} not a measure above 0` : null,
    plan.notInRule.length > 0 ? `${plan.notInRule.length} point(s) the rule does not grade` : null,
    plan.noBase.length > 0 ? `${plan.noBase.length} point(s) without a base size value` : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? 'Nothing to grade.' : `${parts.join(', ')}.`
}

/** The rule's steps grouped per point, in the spec's order of codes (the Grade rule pop-up's rows). */
export function stepsByPoint(steps: readonly (StepData & { readonly id?: string })[]): Map<string, (StepData & { readonly id?: string })[]> {
  const out = new Map<string, (StepData & { readonly id?: string })[]>()
  for (const step of steps) out.set(step.pointOfMeasureId, [...(out.get(step.pointOfMeasureId) ?? []), step])
  return out
}

/** Steps of two lists that are the same (point, sizes and increment): what a full replace leaves as it is. */
export const sameStep = (a: StepData, b: StepData): boolean => a.pointOfMeasureId === b.pointOfMeasureId && a.fromSize === b.fromSize && a.toSize === b.toSize && sameMeasure(a.increment, b.increment)
