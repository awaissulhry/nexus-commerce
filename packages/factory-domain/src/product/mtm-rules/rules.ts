import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'

/**
 * Made-to-measure rules (B-W2b-248; PRD-017, PRD-201, PRD-202, PRD-203, PRD-204), pure: ONE check of a rider's measures
 * against the measurement template they were taken with (PRD-200), and, for a style, against the style. factory-db keeps
 * the rules on the template rows (B-W2b-210): `MeasurementRule`, `MeasurementTemplate.baseSizeRule` and `.rulesOn`,
 * `MeasurementPoint.alterationMinus/Plus`, `BomLine.mtmScalePointId/mtmScaleFactor`, `Style.mtmAllowed`. apps/factory-api's
 * modules/product/mtm-rules reads and writes them (checking every write against these rules first, so a database
 * refusal never reaches a person) and answers the check; the measurement link (B-W2b-171, sales/measure-link/checks.ts)
 * calls the same rule check when a rider sends measures.
 *
 *   the switch          the template's rules (its plausibility rules, its base size rule, its points' alteration limits)
 *                       are checked only while `rulesOn` (GATE-MTM; Owner 11-09: built off, turned on per template)
 *   plausibility        (PRD-201) ORDER: the point's measure is not above the other's (an inseam not longer than the
 *                       outseam); RATIO: point ÷ other point between the factors; RANGE: the point between the values. A
 *                       broken BLOCK rule: the measures are not taken (someone measures again or a pattern maker decides);
 *                       a broken WARN rule is said in words. A rule whose measure is missing is not checked (said)
 *   base size           (PRD-202) the rule's points, in priority order, against each size's body measures of the style's
 *                       range: the size whose ranges hold the measures, else the nearest (the smallest distance outside a
 *                       range, point by point in priority order); between equal sizes the larger (default) or the smaller
 *   alteration limits   (PRD-203) per point: the rider's measure against the base size's body measure (the middle of its
 *                       range: the measure its pattern is made for), at most alterationMinus under and alterationPlus
 *                       over it; beyond them a pattern maker reviews the unit and it is outside the certified range of the
 *                       basic model (read with the certificate gate's made-to-measure route, allowsMadeToMeasure)
 *   consumption         (PRD-204) a BOM line marked to scale: the unit's quantity = the base size's quantity × (1 + factor ×
 *                       (the rider's measure ÷ the base size's measure − 1)), four decimals; a line not marked takes the base
 *                       size's quantity
 *   the style           (PRD-017) only a style flagged made-to-measure takes a made-to-measure unit, measured with its
 *                       template (the profile's garment type is the template's code)
 *
 * Measures are decimal strings with their unit ({"value": "61.5", "unit": "cm"}), compared in the point's unit (CM or MM;
 * a centimetre is ten millimetres); never floats.
 */

export const RULE_KINDS = ['ORDER', 'RATIO', 'RANGE'] as const
export type RuleKind = (typeof RULE_KINDS)[number]
export const RULE_SEVERITIES = ['BLOCK', 'WARN'] as const
export type RuleSeverity = (typeof RULE_SEVERITIES)[number]
export const RULE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type RuleStatus = (typeof RULE_STATUSES)[number]
export const TIES = ['LARGER', 'SMALLER'] as const
export type Tie = (typeof TIES)[number]

export const MTM_LIMITS = Object.freeze({
  /** Rules per template, points named at once, languages per message, characters per message, a switch's reason. */
  rules: 60,
  points: 200,
  languages: 12,
  message: 500,
  reason: 500,
  /** The base size rule names 1 to 10 points (factory-db's rule). */
  baseSizePoints: 10,
  /** Measures sent to the check at once. */
  measures: 120,
})

/** A rule's code: as a point's, no spaces ("INSEAM_LE_OUTSEAM"); the database asks no spaces and at most 60 characters. */
export const RULE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/
export const RULE_CODE_RULE = '1 to 60 letters, digits, dots, dashes or underscores, starting with a letter or a digit ("INSEAM_LE_OUTSEAM")'

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 })
type Dec = InstanceType<typeof D>
const issue = (path: string, message: string): Issue => ({ path, message })

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
const CONTROL = /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/
const PLAIN = /^\d{1,6}(?:\.\d{1,4})?$/

/** Words per language {"it": "…", "en": "…"}. */
export type Words = Readonly<Record<string, string>>

/** A decimal written plainly, without trailing zeros: "1.1500" → "1.15", "58.00" → "58". */
export function plain(value: Dec | string): string {
  const text = new D(value.toString()).toFixed()
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
  return trimmed === '-0' ? '0' : trimmed
}

/** A measure, limit or value as stored (Decimal(8,2), 0 or more). */
export const measureOk = (value: string): boolean => /^\d{1,6}(?:\.\d{1,2})?$/.test(value) && fitsDecimal(value, 8, 2)
/** A ratio factor as stored (Decimal(8,4)). */
export const factorOk = (value: string): boolean => /^\d{1,4}(?:\.\d{1,4})?$/.test(value) && fitsDecimal(value, 8, 4)
/** A BOM line's scale factor as stored (Decimal(7,4)): above 0, at most 10. */
export const scaleFactorOk = (value: string): boolean => /^\d{1,3}(?:\.\d{1,4})?$/.test(value) && fitsDecimal(value, 7, 4) && new D(value).gt(0) && new D(value).lte(10)

export function wordsProblems(words: Words | null | undefined, path: string, max: number): Issue[] {
  if (!words || Object.keys(words).length === 0) return [issue(path, 'Say what is wrong in at least one language: {"it": "…", "en": "…"}.')]
  const entries = Object.entries(words)
  if (entries.length > MTM_LIMITS.languages) return [issue(path, `At most ${MTM_LIMITS.languages} languages.`)]
  return entries.flatMap(([language, text]) => {
    const at = `${path}/${language}`
    if (!LANGUAGE.test(language)) return [issue(at, 'A language code ("it", "en", "de-CH").')]
    if (typeof text !== 'string' || text.trim() === '') return [issue(at, 'Not blank.')]
    if (text.length > max) return [issue(at, `At most ${max} characters.`)]
    if (CONTROL.test(text)) return [issue(at, 'No control characters.')]
    return []
  })
}

/** Words cleaned for storage: trimmed, languages in order. */
export const cleanWords = (words: Words): Words =>
  Object.fromEntries(
    Object.entries(words)
      .map(([language, text]) => [language.trim(), text.trim()] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )

/** The words of `words` in `locale`, else English, else the first language there is. */
export function wordsIn(words: Words | null | undefined, locale: string): string | null {
  if (!words) return null
  return words[locale] ?? words.en ?? Object.values(words)[0] ?? null
}

// ---- the template -----------------------------------------------------------------------------------------------------

/** A point of the template (MeasurementPoint) as the rules read it. */
export interface TemplatePoint {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly uom: string
  readonly status: string
  /** How far under and over the base size's measure a unit may be (null: no limit that side), in the point's unit. */
  readonly alterationMinus: string | null
  readonly alterationPlus: string | null
}

/** A plausibility rule (MeasurementRule) by its points' codes. */
export interface RuleFields {
  readonly code: string
  readonly kind: RuleKind
  readonly pointCode: string
  readonly otherPointCode: string | null
  readonly minFactor: string | null
  readonly maxFactor: string | null
  readonly minValue: string | null
  readonly maxValue: string | null
  readonly severity: RuleSeverity
  readonly messageI18n: Words
  readonly status: RuleStatus
}

export interface BaseSizeRule {
  readonly points: readonly string[]
  readonly tie: Tie
}

/** MeasurementTemplate.baseSizeRule as stored, read safely (null when it is not one). */
export function baseSizeRuleOf(value: unknown): BaseSizeRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.points) || !record.points.every((code) => typeof code === 'string')) return null
  return { points: record.points as string[], tie: record.tie === 'SMALLER' ? 'SMALLER' : 'LARGER' }
}

const blankToNull = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())

/** A rule as written: codes and numbers trimmed, empty bounds null, words cleaned. */
export function normaliseRule(rule: RuleFields): RuleFields {
  return {
    code: rule.code.trim(),
    kind: rule.kind,
    pointCode: rule.pointCode.trim(),
    otherPointCode: blankToNull(rule.otherPointCode),
    minFactor: blankToNull(rule.minFactor),
    maxFactor: blankToNull(rule.maxFactor),
    minValue: blankToNull(rule.minValue),
    maxValue: blankToNull(rule.maxValue),
    severity: rule.severity,
    messageI18n: cleanWords(rule.messageI18n),
    status: rule.status,
  }
}

/** Two stored decimals say the same ("4.00" and "4"); null only equals null. */
export const sameDecimal = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : new D(a).eq(new D(b)))
const same = sameDecimal
const sameWords = (a: Words, b: Words): boolean => JSON.stringify(cleanWords(a)) === JSON.stringify(cleanWords(b))

/** Two rules say the same (the same code kept as it is). */
export function sameRule(a: RuleFields, b: RuleFields): boolean {
  return (
    a.code === b.code &&
    a.kind === b.kind &&
    a.pointCode === b.pointCode &&
    a.otherPointCode === b.otherPointCode &&
    same(a.minFactor, b.minFactor) &&
    same(a.maxFactor, b.maxFactor) &&
    same(a.minValue, b.minValue) &&
    same(a.maxValue, b.maxValue) &&
    a.severity === b.severity &&
    a.status === b.status &&
    sameWords(a.messageI18n, b.messageI18n)
  )
}

/**
 * Why a template's rules cannot be saved (paths `rules/<i>/…`), in words: the database's own rules (MeasurementRule_check)
 * said first, plus: each code once, the points the template's (an archived point only on an archived rule).
 */
export function rulesProblems(rules: readonly RuleFields[], points: readonly TemplatePoint[]): Issue[] {
  const out: Issue[] = []
  if (rules.length > MTM_LIMITS.rules) return [issue('rules', `At most ${MTM_LIMITS.rules} rules per template.`)]
  const byCode = new Map(points.map((point) => [point.code, point]))
  const seen = new Set<string>()
  rules.forEach((rule, index) => {
    const at = `rules/${index}`
    if (!RULE_CODE.test(rule.code)) out.push(issue(`${at}/code`, `A code of ${RULE_CODE_RULE}.`))
    else if (seen.has(rule.code)) out.push(issue(`${at}/code`, `${rule.code} is named twice: each rule once.`))
    seen.add(rule.code)
    out.push(...wordsProblems(rule.messageI18n, `${at}/messageI18n`, MTM_LIMITS.message))
    const point = byCode.get(rule.pointCode)
    if (!point) out.push(issue(`${at}/pointCode`, `${rule.pointCode || 'The point'} is not a point of this template.`))
    else if (point.status !== 'ACTIVE' && rule.status === 'ACTIVE') out.push(issue(`${at}/pointCode`, `${point.code} is archived: archive the rule, or name an active point.`))
    const compared = rule.kind !== 'RANGE'
    if (compared) {
      const other = rule.otherPointCode === null ? undefined : byCode.get(rule.otherPointCode)
      if (rule.otherPointCode === null) out.push(issue(`${at}/otherPointCode`, `A ${rule.kind} rule compares its point with another point: name it.`))
      else if (!other) out.push(issue(`${at}/otherPointCode`, `${rule.otherPointCode} is not a point of this template.`))
      else if (rule.otherPointCode === rule.pointCode) out.push(issue(`${at}/otherPointCode`, 'Two different points.'))
      else if (other.status !== 'ACTIVE' && rule.status === 'ACTIVE') out.push(issue(`${at}/otherPointCode`, `${other.code} is archived: archive the rule, or name an active point.`))
      else if (rule.kind === 'ORDER' && point && point.uom !== other.uom) out.push(issue(`${at}/otherPointCode`, `An ORDER rule compares two points of one unit (${point.code} is in ${point.uom}, ${other.code} in ${other.uom}).`))
    } else if (rule.otherPointCode !== null) {
      out.push(issue(`${at}/otherPointCode`, 'A RANGE rule checks one point: leave the other point out.'))
    }
    const factors = rule.minFactor !== null || rule.maxFactor !== null
    const values = rule.minValue !== null || rule.maxValue !== null
    if (rule.kind === 'ORDER' && (factors || values)) out.push(issue(at, 'An ORDER rule has no factor and no value: the point is simply not above the other.'))
    if (rule.kind === 'RATIO') {
      if (values) out.push(issue(`${at}/minValue`, 'A RATIO rule has factors, not values.'))
      if (!factors) out.push(issue(`${at}/minFactor`, 'At least one factor: the smallest or the largest point ÷ other point.'))
      out.push(...boundProblems(rule.minFactor, rule.maxFactor, `${at}/minFactor`, `${at}/maxFactor`, 'factor'))
    }
    if (rule.kind === 'RANGE') {
      if (factors) out.push(issue(`${at}/minFactor`, 'A RANGE rule has values, not factors.'))
      if (!values) out.push(issue(`${at}/minValue`, "At least one value: the point's smallest or largest measure."))
      out.push(...boundProblems(rule.minValue, rule.maxValue, `${at}/minValue`, `${at}/maxValue`, 'value'))
    }
  })
  return out
}

function boundProblems(min: string | null, max: string | null, minPath: string, maxPath: string, kind: 'factor' | 'value'): Issue[] {
  const ok = kind === 'factor' ? factorOk : measureOk
  const shape = kind === 'factor' ? 'a number above 0 with at most 4 digits and 4 decimals ("1.15")' : 'a number with at most 6 digits and 2 decimals ("116")'
  const out: Issue[] = []
  if (min !== null && !ok(min)) out.push(issue(minPath, `The smallest: ${shape}.`))
  if (max !== null && !ok(max)) out.push(issue(maxPath, `The largest: ${shape}.`))
  if (out.length > 0) return out
  if (kind === 'factor') {
    if (min !== null && new D(min).lte(0)) out.push(issue(minPath, 'Above 0.'))
    if (max !== null && new D(max).lte(0)) out.push(issue(maxPath, 'Above 0.'))
  } else if (max !== null && new D(max).lte(0)) {
    out.push(issue(maxPath, 'Above 0.'))
  }
  if (out.length === 0 && min !== null && max !== null && new D(min).gt(max)) out.push(issue(maxPath, 'Not below the smallest.'))
  return out
}

/** Why a base size rule cannot be saved (paths `baseSizeRule/…`): 1 to 10 points of the template, each once. */
export function baseSizeRuleProblems(rule: BaseSizeRule | null, points: readonly TemplatePoint[]): Issue[] {
  if (rule === null) return []
  const out: Issue[] = []
  if (rule.points.length < 1 || rule.points.length > MTM_LIMITS.baseSizePoints) out.push(issue('baseSizeRule/points', `1 to ${MTM_LIMITS.baseSizePoints} points, the one that decides first.`))
  const codes = new Set(points.map((point) => point.code))
  const seen = new Set<string>()
  rule.points.forEach((code, index) => {
    if (!codes.has(code)) out.push(issue(`baseSizeRule/points/${index}`, `${code} is not a point of this template.`))
    else if (seen.has(code)) out.push(issue(`baseSizeRule/points/${index}`, `${code} is named twice: each point once.`))
    seen.add(code)
  })
  return out
}

/** A point's limits as written: its inspection tolerance and its alteration limits (null: not set). */
export interface PointLimits {
  readonly code: string
  readonly tolerance: string | null
  readonly alterationMinus: string | null
  readonly alterationPlus: string | null
}

/** Why the points' limits cannot be saved (paths `points/<i>/…`): points of the template, each once, 0 or more. */
export function limitsProblems(limits: readonly PointLimits[], points: readonly TemplatePoint[]): Issue[] {
  const out: Issue[] = []
  if (limits.length > MTM_LIMITS.points) return [issue('points', `At most ${MTM_LIMITS.points} points at once.`)]
  const codes = new Set(points.map((point) => point.code))
  const seen = new Set<string>()
  limits.forEach((limit, index) => {
    const at = `points/${index}`
    if (!codes.has(limit.code)) out.push(issue(`${at}/code`, `${limit.code} is not a point of this template.`))
    else if (seen.has(limit.code)) out.push(issue(`${at}/code`, `${limit.code} is named twice: each point once.`))
    seen.add(limit.code)
    for (const field of ['tolerance', 'alterationMinus', 'alterationPlus'] as const) {
      const value = limit[field]
      if (value !== null && !measureOk(value)) out.push(issue(`${at}/${field}`, 'In the point\'s unit, 0 or more: a number with at most 6 digits and 2 decimals ("4").'))
    }
  })
  return out
}

// ---- measures ---------------------------------------------------------------------------------------------------------

/** A rider's measures by point code: {"chest": {"value": "100", "unit": "cm"}} (MeasurementProfile.measurements). */
export type Measures = Readonly<Record<string, { readonly value: string; readonly unit: string }>>

/** Millimetres in one of these units (lengths only). */
const MM_PER: Readonly<Record<string, number>> = Object.freeze({ mm: 1, cm: 10 })

/** A value in `unit` converted to `to` (cm ↔ mm), or null when it is no number or the units do not go together. */
export function inUnit(value: string, unit: string, to: string): Dec | null {
  const text = value.trim()
  if (!PLAIN.test(text)) return null
  const from = unit.trim().toLowerCase()
  const target = to.trim().toLowerCase()
  if (from === target) return new D(text)
  const a = MM_PER[from]
  const b = MM_PER[target]
  return a === undefined || b === undefined ? null : new D(text).times(a).div(b)
}

type Read = { readonly value: Dec } | { readonly missing: 'NOT_MEASURED' | 'NOT_COMPARABLE' }

/** The rider's measure of a point in the point's unit. */
function readMeasure(measures: Measures, point: Pick<TemplatePoint, 'code' | 'uom'>): Read {
  const entry = Object.hasOwn(measures, point.code) ? measures[point.code] : undefined
  if (!entry || typeof entry.value !== 'string' || entry.value.trim() === '') return { missing: 'NOT_MEASURED' }
  const value = inUnit(entry.value, entry.unit ?? '', point.uom)
  return value === null ? { missing: 'NOT_COMPARABLE' } : { value }
}

const shown = (value: Dec, uom: string): string => `${plain(value.toDecimalPlaces(2))} ${uom.toLowerCase()}`

// ---- PRD-201: plausibility -------------------------------------------------------------------------------------------

export const RULE_OUTCOMES = ['PASSED', 'BROKEN', 'NOT_CHECKED'] as const
export type RuleOutcome = (typeof RULE_OUTCOMES)[number]

export interface RuleResult {
  readonly code: string
  readonly kind: RuleKind
  readonly severity: RuleSeverity
  readonly outcome: RuleOutcome
  readonly pointCode: string
  readonly otherPointCode: string | null
  /** The measures compared (in the point's unit), and point ÷ other point for a RATIO rule; null when not measured. */
  readonly value: string | null
  readonly otherValue: string | null
  readonly ratio: string | null
  /** The rule's own words (what is wrong), per language. */
  readonly words: Words
  /** What was found, with the numbers (English). */
  readonly detail: string
}

/** The template's ACTIVE rules on these measures (an archived rule is not checked). */
export function checkRules(rules: readonly RuleFields[], points: readonly TemplatePoint[], measures: Measures): RuleResult[] {
  const byCode = new Map(points.map((point) => [point.code, point]))
  return rules
    .filter((rule) => rule.status === 'ACTIVE')
    .map((rule): RuleResult => {
      const point = byCode.get(rule.pointCode)
      const other = rule.otherPointCode === null ? undefined : byCode.get(rule.otherPointCode)
      const base = { code: rule.code, kind: rule.kind, severity: rule.severity, pointCode: rule.pointCode, otherPointCode: rule.otherPointCode, words: rule.messageI18n }
      const notChecked = (detail: string): RuleResult => ({ ...base, outcome: 'NOT_CHECKED', value: null, otherValue: null, ratio: null, detail })
      if (!point || (rule.kind !== 'RANGE' && !other)) return notChecked('A point of the rule is no longer in the template.')
      const read = readMeasure(measures, point)
      if ('missing' in read) return notChecked(read.missing === 'NOT_MEASURED' ? `${point.name} is not measured.` : `${point.name} is not in a unit that can be compared (${point.uom}).`)
      const value = read.value
      if (rule.kind === 'RANGE') {
        const low = rule.minValue === null ? null : new D(rule.minValue)
        const high = rule.maxValue === null ? null : new D(rule.maxValue)
        const broken = (low !== null && value.lt(low)) || (high !== null && value.gt(high))
        const range = `${low === null ? '…' : plain(low)}–${high === null ? '…' : plain(high)} ${point.uom.toLowerCase()}`
        return { ...base, outcome: broken ? 'BROKEN' : 'PASSED', value: plain(value), otherValue: null, ratio: null, detail: `${point.name} ${shown(value, point.uom)} is ${broken ? 'outside' : 'inside'} ${range}.` }
      }
      const otherRead = readMeasure(measures, { code: other!.code, uom: point.uom })
      if ('missing' in otherRead) return notChecked(otherRead.missing === 'NOT_MEASURED' ? `${other!.name} is not measured.` : `${other!.name} is not in a unit that can be compared (${point.uom}).`)
      const otherValue = otherRead.value
      if (rule.kind === 'ORDER') {
        const broken = value.gt(otherValue)
        return {
          ...base,
          outcome: broken ? 'BROKEN' : 'PASSED',
          value: plain(value),
          otherValue: plain(otherValue),
          ratio: null,
          detail: `${point.name} ${shown(value, point.uom)} is ${broken ? 'longer than' : 'not above'} ${other!.name} ${shown(otherValue, point.uom)}.`,
        }
      }
      if (otherValue.lte(0)) return notChecked(`${other!.name} is 0: no ratio.`)
      const ratio = value.div(otherValue).toDecimalPlaces(4)
      const low = rule.minFactor === null ? null : new D(rule.minFactor)
      const high = rule.maxFactor === null ? null : new D(rule.maxFactor)
      const broken = (low !== null && ratio.lt(low)) || (high !== null && ratio.gt(high))
      const range = `${low === null ? '…' : plain(low)}–${high === null ? '…' : plain(high)}`
      return {
        ...base,
        outcome: broken ? 'BROKEN' : 'PASSED',
        value: plain(value),
        otherValue: plain(otherValue),
        ratio: plain(ratio),
        detail: `${point.name} ${shown(value, point.uom)} ÷ ${other!.name} ${shown(otherValue, point.uom)} = ${plain(ratio)}, ${broken ? 'outside' : 'inside'} ${range}.`,
      }
    })
}

// ---- PRD-202: the base size -------------------------------------------------------------------------------------------

/** One body measure range of a size (Size.bodyMeasures entries), decimal strings. */
export interface MeasureRange {
  readonly min: string
  readonly max: string
  readonly unit: string
}

/** A size of the style's range, in the scale's order, with its body measures by point code. */
export interface SizeFacts {
  readonly code: string
  readonly seq: number
  readonly bodyMeasures: Readonly<Record<string, MeasureRange>> | null
}

/** A size's range of a point in the point's unit, or null (none, or not comparable). */
function rangeOf(size: SizeFacts, point: Pick<TemplatePoint, 'code' | 'uom'>): { min: Dec; max: Dec } | null {
  const range = size.bodyMeasures?.[point.code]
  if (!range) return null
  const min = inUnit(range.min, range.unit, point.uom)
  const max = inUnit(range.max, range.unit, point.uom)
  return min === null || max === null || min.gt(max) ? null : { min, max }
}

export interface BaseSizePoint {
  readonly code: string
  /** The rider's measure in the point's unit; null: not measured (the point is passed over). */
  readonly value: string | null
  /** The suggested size's range for it, and how far the measure is outside it (0: inside); null when the size gives none. */
  readonly range: { readonly min: string; readonly max: string } | null
  readonly distance: string | null
}

export interface BaseSizeSuggestion {
  /** The suggested size; null: none (the rule is not set, nothing it names is measured, no size gives those measures). */
  readonly size: string | null
  /** INSIDE: the size's ranges hold every measure of the rule; NEAREST: the closest size. */
  readonly how: 'INSIDE' | 'NEAREST' | null
  /** Other sizes were as close: the rule's tie chose (LARGER or SMALLER). */
  readonly tie: boolean
  readonly points: readonly BaseSizePoint[]
  readonly detail: string
}

/**
 * The base size the measures point to (PRD-202): for each size of the range, per point of the rule, the distance of the
 * rider's measure outside the size's range (0 inside it; a size without a range for the point is the farthest); the
 * sizes compared point by point in the rule's order (the first point decides, the next breaks a tie), and equal sizes
 * left to the rule's tie (the larger by default). A point not measured is passed over.
 */
export function suggestBaseSize(rule: BaseSizeRule | null, sizes: readonly SizeFacts[], points: readonly TemplatePoint[], measures: Measures): BaseSizeSuggestion {
  const none = (detail: string, rows: BaseSizePoint[] = []): BaseSizeSuggestion => ({ size: null, how: null, tie: false, points: rows, detail })
  if (rule === null) return none('The template has no base size rule: no base size is suggested.')
  const byCode = new Map(points.map((point) => [point.code, point]))
  const measured = rule.points.flatMap((code) => {
    const point = byCode.get(code)
    if (!point) return []
    const read = readMeasure(measures, point)
    return 'value' in read ? [{ point, value: read.value }] : []
  })
  const unmeasured = rule.points.filter((code) => !measured.some((entry) => entry.point.code === code))
  if (measured.length === 0) return none(`${rule.points.join(', ')} ${rule.points.length === 1 ? 'is' : 'are'} not measured: no base size is suggested.`)
  const ordered = [...sizes].sort((a, b) => a.seq - b.seq || (a.code < b.code ? -1 : 1))
  const scored = ordered
    .map((size, place) => ({
      size,
      place,
      distances: measured.map(({ point, value }) => {
        const range = rangeOf(size, point)
        if (!range) return null
        return value.lt(range.min) ? range.min.minus(value) : value.gt(range.max) ? value.minus(range.max) : new D(0)
      }),
    }))
    .filter((entry) => entry.distances.some((distance) => distance !== null))
  if (scored.length === 0) return none(`No size of the range gives body measures for ${measured.map(({ point }) => point.code).join(', ')}: no base size is suggested.`)
  const compare = (a: (typeof scored)[number], b: (typeof scored)[number]): number => {
    for (let index = 0; index < measured.length; index += 1) {
      const x = a.distances[index] ?? null
      const y = b.distances[index] ?? null
      if (x === null && y === null) continue
      if (x === null) return 1
      if (y === null) return -1
      const order = x.comparedTo(y)
      if (order !== 0) return order
    }
    return 0
  }
  const best = scored.reduce((winner, entry) => (compare(entry, winner) < 0 ? entry : winner))
  const equal = scored.filter((entry) => compare(entry, best) === 0)
  const chosen = rule.tie === 'SMALLER' ? equal[0]! : equal[equal.length - 1]!
  const inside = chosen.distances.every((distance) => distance !== null && distance.isZero())
  const rows: BaseSizePoint[] = rule.points.map((code) => {
    const at = measured.findIndex((entry) => entry.point.code === code)
    if (at < 0) return { code, value: null, range: null, distance: null }
    const point = measured[at]!.point
    const range = rangeOf(chosen.size, point)
    const distance = chosen.distances[at] ?? null
    return { code, value: plain(measured[at]!.value), range: range ? { min: plain(range.min), max: plain(range.max) } : null, distance: distance === null ? null : plain(distance) }
  })
  const said = measured.map(({ point, value }) => `${point.name} ${shown(value, point.uom)}`).join(', ')
  const passed = unmeasured.length > 0 ? ` (${unmeasured.join(', ')} not measured: passed over)` : ''
  const tieWords = equal.length > 1 ? `; ${equal.map((entry) => entry.size.code).join(' and ')} were as close, the ${rule.tie === 'SMALLER' ? 'smaller' : 'larger'} is taken` : ''
  return {
    size: chosen.size.code,
    how: inside ? 'INSIDE' : 'NEAREST',
    tie: equal.length > 1,
    points: rows,
    detail: `${said}${passed}: size ${chosen.size.code} ${inside ? 'holds the measures' : 'is the nearest'}${tieWords}.`,
  }
}

// ---- PRD-203: alteration limits --------------------------------------------------------------------------------------

export const ALTERATION_OUTCOMES = ['WITHIN', 'BEYOND', 'NO_LIMIT', 'NOT_MEASURED', 'NO_BASE_MEASURE'] as const
export type AlterationOutcome = (typeof ALTERATION_OUTCOMES)[number]

export interface Alteration {
  readonly code: string
  readonly uom: string
  readonly outcome: AlterationOutcome
  /** The rider's measure, the base size's measure (the middle of its range) and the difference (+ over, − under). */
  readonly value: string | null
  readonly base: string | null
  readonly difference: string | null
  readonly alterationMinus: string | null
  readonly alterationPlus: string | null
  readonly detail: string
}

/**
 * Each active point against the base size (PRD-203): the rider's measure minus the base size's body measure (the middle of
 * its range, what the size's pattern is made for); beyond alterationMinus under it or alterationPlus over it, the unit is
 * outside the alteration limits (a pattern maker reviews it; outside the certified range of the basic model).
 */
export function alterationsOf(points: readonly TemplatePoint[], baseSize: SizeFacts, measures: Measures): Alteration[] {
  return points
    .filter((point) => point.status === 'ACTIVE')
    .map((point): Alteration => {
      const limits = { code: point.code, uom: point.uom, alterationMinus: point.alterationMinus === null ? null : plain(point.alterationMinus), alterationPlus: point.alterationPlus === null ? null : plain(point.alterationPlus) }
      const empty = { value: null, base: null, difference: null }
      if (point.alterationMinus === null && point.alterationPlus === null) return { ...limits, ...empty, outcome: 'NO_LIMIT', detail: `${point.name} has no alteration limit.` }
      const read = readMeasure(measures, point)
      if ('missing' in read) return { ...limits, ...empty, outcome: 'NOT_MEASURED', detail: read.missing === 'NOT_MEASURED' ? `${point.name} is not measured.` : `${point.name} is not in a unit that can be compared (${point.uom}).` }
      const range = rangeOf(baseSize, point)
      if (!range) return { ...limits, ...empty, value: plain(read.value), outcome: 'NO_BASE_MEASURE', detail: `Size ${baseSize.code} gives no body measure for ${point.name}: its alteration is not checked.` }
      const base = range.min.plus(range.max).div(2)
      const difference = read.value.minus(base)
      const under = point.alterationMinus !== null && difference.lt(new D(point.alterationMinus).neg())
      const over = point.alterationPlus !== null && difference.gt(new D(point.alterationPlus))
      const signed = `${difference.gte(0) ? '+' : '−'}${plain(difference.abs())}`
      const limit = `${point.alterationMinus === null ? '…' : `−${plain(point.alterationMinus)}`}/${point.alterationPlus === null ? '…' : `+${plain(point.alterationPlus)}`}`
      return {
        ...limits,
        value: plain(read.value),
        base: plain(base),
        difference: plain(difference),
        outcome: under || over ? 'BEYOND' : 'WITHIN',
        detail: `${point.name} ${shown(read.value, point.uom)} is ${signed} ${point.uom.toLowerCase()} from size ${baseSize.code} (${plain(base)}): ${under || over ? 'beyond' : 'within'} its limits ${limit}.`,
      }
    })
}

// ---- PRD-204: consumption -------------------------------------------------------------------------------------------

/** A BOM line as the consumption reads it. */
export interface ConsumptionLine {
  readonly id: string
  readonly seq: number
  readonly item: { readonly id: string; readonly code: string; readonly name: string }
  readonly placement: string | null
  /** Per garment, in `uom`: for every size, or the base size's when size-dependent (then `sizes` holds each size's). */
  readonly qty: string
  readonly uom: string
  readonly wastagePct: string
  readonly sizeDependent: boolean
  readonly sizes: Readonly<Record<string, string>>
  /** The template point its quantity follows and the share that follows it; null: not marked. */
  readonly scale: { readonly pointCode: string; readonly factor: string } | null
}

export interface ConsumptionRow {
  readonly lineId: string
  readonly seq: number
  readonly item: { readonly id: string; readonly code: string; readonly name: string }
  readonly placement: string | null
  readonly uom: string
  readonly wastagePct: string
  /** The base size's quantity per garment, and the unit's (null both: the base size does not use the line). */
  readonly baseQty: string | null
  readonly unitQty: string | null
  readonly scaled: { readonly pointCode: string; readonly factor: string; readonly value: string; readonly base: string } | null
  readonly detail: string
}

/**
 * The unit's quantity per BOM line (PRD-204): a line marked to scale follows the rider's measure against the base size's
 * (the middle of its body measure range): base quantity × (1 + factor × (measure ÷ base measure − 1)), four decimals,
 * half up. A line not marked, or whose measure cannot be read, takes the base size's quantity (said); a result of 0 or
 * less keeps the base size's quantity (said).
 */
export function consumptionOf(lines: readonly ConsumptionLine[], points: readonly TemplatePoint[], baseSize: SizeFacts, measures: Measures): ConsumptionRow[] {
  const byCode = new Map(points.map((point) => [point.code, point]))
  return [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line): ConsumptionRow => {
      const head = { lineId: line.id, seq: line.seq, item: line.item, placement: line.placement, uom: line.uom, wastagePct: plain(line.wastagePct) }
      const baseText = line.sizeDependent ? (line.sizes[baseSize.code] ?? null) : line.qty
      if (baseText === null) return { ...head, baseQty: null, unitQty: null, scaled: null, detail: `Size ${baseSize.code} does not use this line.` }
      const baseQty = new D(baseText)
      const kept = (detail: string): ConsumptionRow => ({ ...head, baseQty: plain(baseQty), unitQty: plain(baseQty), scaled: null, detail })
      if (!line.scale) return kept(`Not marked to scale: size ${baseSize.code}'s quantity.`)
      const point = byCode.get(line.scale.pointCode)
      if (!point) return kept(`Its point ${line.scale.pointCode} is not in the template any more: size ${baseSize.code}'s quantity.`)
      const read = readMeasure(measures, point)
      if ('missing' in read) return kept(`${point.name} is not measured: size ${baseSize.code}'s quantity.`)
      const range = rangeOf(baseSize, point)
      if (!range) return kept(`Size ${baseSize.code} gives no body measure for ${point.name}: its quantity.`)
      const base = range.min.plus(range.max).div(2)
      if (base.lte(0)) return kept(`Size ${baseSize.code}'s ${point.name} is 0: its quantity.`)
      const factor = new D(line.scale.factor)
      const unit = baseQty.times(new D(1).plus(factor.times(read.value.div(base).minus(1)))).toDecimalPlaces(4)
      const scaled = { pointCode: point.code, factor: plain(factor), value: plain(read.value), base: plain(base) }
      if (unit.lte(0)) return { ...head, baseQty: plain(baseQty), unitQty: plain(baseQty), scaled, detail: `Scaled by ${point.name} it would be 0 or less: size ${baseSize.code}'s quantity is kept.` }
      return {
        ...head,
        baseQty: plain(baseQty),
        unitQty: plain(unit),
        scaled,
        detail: `${plain(baseQty)} × (1 + ${plain(factor)} × (${point.name} ${plain(read.value)} ÷ ${plain(base)} − 1)) = ${plain(unit)} ${line.uom.toLowerCase()}.`,
      }
    })
}

// ---- PRD-017: the style ----------------------------------------------------------------------------------------------

export interface StyleFacts {
  readonly code: string
  readonly mtmAllowed: boolean
  readonly measurementTemplateId: string | null
}

export const FINDING_KINDS = ['STYLE_NOT_MTM', 'NO_TEMPLATE', 'OTHER_TEMPLATE', 'GARMENT_TYPE', 'RULE', 'ALTERATION', 'CERTIFICATE', 'BASE_SIZE'] as const
export type FindingKind = (typeof FINDING_KINDS)[number]

/** One thing the check found: a block (the unit is not taken as it stands) or a warning (said in words). */
export interface Finding {
  readonly kind: FindingKind
  /** The rule, point or certificate it is about. */
  readonly ref: string | null
  readonly message: string
  /** The rule's own words per language (RULE findings). */
  readonly words: Words | null
}

/**
 * Only a style flagged made-to-measure takes a made-to-measure unit (PRD-017), measured with its own template; measures
 * taken for another garment type are not its measures.
 */
export function styleFindings(style: StyleFacts, template: { readonly id: string; readonly code: string } | null, garmentType: string | null): Finding[] {
  const out: Finding[] = []
  if (!style.mtmAllowed) out.push({ kind: 'STYLE_NOT_MTM', ref: style.code, message: `Style ${style.code} is not made to measure: a made-to-measure unit is not made from it.`, words: null })
  if (style.measurementTemplateId === null) out.push({ kind: 'NO_TEMPLATE', ref: style.code, message: `Style ${style.code} has no measurement template: choose the one its made-to-measure units are measured with.`, words: null })
  else if (template !== null && template.id !== style.measurementTemplateId) out.push({ kind: 'OTHER_TEMPLATE', ref: template.code, message: `Style ${style.code} is measured with another template than ${template.code}.`, words: null })
  if (garmentType !== null && template !== null && garmentType !== template.code) {
    out.push({ kind: 'GARMENT_TYPE', ref: garmentType, message: `These measures were taken for garment type ${garmentType}; ${style.code} is measured with template ${template.code}.`, words: null })
  }
  return out
}

// ---- the one check ---------------------------------------------------------------------------------------------------

export interface CertificateFacts {
  readonly allowed: boolean
  readonly outcome: string
  readonly reasons: readonly { readonly code: string; readonly message: string; readonly point?: string | undefined }[]
}

export interface MtmCheckInput {
  readonly template: {
    readonly id: string
    readonly code: string
    readonly rulesOn: boolean
    readonly baseSizeRule: BaseSizeRule | null
    readonly points: readonly TemplatePoint[]
    readonly rules: readonly RuleFields[]
  }
  readonly measures: Measures
  /** The profile's garment type, when the measures are a profile's. */
  readonly garmentType: string | null
  /** For a style: its flag and template, the sizes of its range in the scale's order. */
  readonly style: (StyleFacts & { readonly sizes: readonly SizeFacts[] }) | null
  /** A base size typed (a size of the style's range); else the one suggested. */
  readonly baseSize: string | null
  /** The BOM lines of the style's revision (null: not asked, or not shown to the caller). */
  readonly lines: readonly ConsumptionLine[] | null
  /** The certificate gate's made-to-measure answer (null: not asked). */
  readonly certificate: CertificateFacts | null
}

export type Verdict = 'OK' | 'WARN' | 'BLOCK'

export interface MtmCheck {
  readonly rulesOn: boolean
  readonly rules: readonly RuleResult[]
  readonly baseSize: BaseSizeSuggestion & { readonly used: string | null; readonly typed: string | null }
  readonly alterations: readonly Alteration[]
  /** null: no style, or no base size to scale from, or not asked. */
  readonly consumption: readonly ConsumptionRow[] | null
  /** The alteration limits hold and the certificate allows the unit; null: not known (no style or rules off). */
  readonly insideCertifiedRange: boolean | null
  readonly blocks: readonly Finding[]
  readonly warnings: readonly Finding[]
  readonly verdict: Verdict
  /** What was and was not checked, in words (English). */
  readonly notes: readonly string[]
}

const OFF_NOTE = 'The made-to-measure rules of this template are off: no plausibility rule, base size rule or alteration limit is checked.'

/**
 * The one check (PRD-017, PRD-201 … PRD-204): the style's flag, the template's rules (while on), the base size (typed, else
 * suggested while on), the alteration limits against it (while on), the certificate's answer, and the consumption of the
 * BOM lines from the base size. A BLOCK finding: the unit is not taken as it stands; a warning is said.
 */
export function mtmCheck(input: MtmCheckInput): MtmCheck {
  const { template, measures, style } = input
  const blocks: Finding[] = []
  const warnings: Finding[] = []
  const notes: string[] = []
  if (style) blocks.push(...styleFindings(style, template, input.garmentType))
  else if (input.garmentType !== null && input.garmentType !== template.code) {
    blocks.push({ kind: 'GARMENT_TYPE', ref: input.garmentType, message: `These measures were taken for garment type ${input.garmentType}, not with template ${template.code}.`, words: null })
  }

  const rules = template.rulesOn ? checkRules(template.rules, template.points, measures) : []
  if (!template.rulesOn) notes.push(OFF_NOTE)
  for (const result of rules) {
    if (result.outcome !== 'BROKEN') continue
    const finding: Finding = { kind: 'RULE', ref: result.code, message: `${wordsIn(result.words, 'en') ?? result.code} (${result.detail})`, words: result.words }
    ;(result.severity === 'BLOCK' ? blocks : warnings).push(finding)
  }
  const skipped = rules.filter((result) => result.outcome === 'NOT_CHECKED')
  if (skipped.length > 0) notes.push(`Not checked: ${skipped.map((result) => `${result.code} (${result.detail})`).join('; ')}`)

  const sizes = style?.sizes ?? []
  const suggestion: BaseSizeSuggestion = template.rulesOn && style ? suggestBaseSize(template.baseSizeRule, sizes, template.points, measures) : { size: null, how: null, tie: false, points: [], detail: style ? OFF_NOTE : 'No style: no base size.' }
  const typed = input.baseSize
  const used = typed ?? suggestion.size
  if (typed !== null && suggestion.size !== null && typed !== suggestion.size) {
    warnings.push({ kind: 'BASE_SIZE', ref: typed, message: `Base size ${typed} is typed; the measures point to ${suggestion.size} (${suggestion.detail})`, words: null })
  }
  const baseFacts = used === null ? null : (sizes.find((size) => size.code === used) ?? null)

  const alterations = template.rulesOn && baseFacts ? alterationsOf(template.points, baseFacts, measures) : []
  for (const alteration of alterations) {
    if (alteration.outcome === 'BEYOND') {
      blocks.push({ kind: 'ALTERATION', ref: alteration.code, message: `${alteration.detail} A pattern maker reviews the unit: it is outside the certified range of the basic model.`, words: null })
    }
  }
  if (template.rulesOn && style && !baseFacts) notes.push('No base size: the alteration limits are not checked.')

  if (input.certificate && !input.certificate.allowed) {
    // The gate's own "not made to measure" is the style's finding above (PRD-017): said once.
    for (const reason of input.certificate.reasons) {
      if (reason.code !== 'style_not_made_to_measure') blocks.push({ kind: 'CERTIFICATE', ref: reason.point ?? reason.code, message: reason.message, words: null })
    }
  }

  let consumption: ConsumptionRow[] | null = null
  if (style && input.lines !== null) {
    if (baseFacts) consumption = consumptionOf(input.lines, template.points, baseFacts, measures)
    else notes.push('No base size: the consumption is not scaled (type one, or turn the rules on to have one suggested).')
  }

  const known = template.rulesOn && style !== null && baseFacts !== null
  const insideCertifiedRange = known ? !alterations.some((row) => row.outcome === 'BEYOND') && (input.certificate === null || input.certificate.allowed) : null
  const verdict: Verdict = blocks.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARN' : 'OK'
  return { rulesOn: template.rulesOn, rules, baseSize: { ...suggestion, used, typed }, alterations, consumption, insideCertifiedRange, blocks, warnings, verdict, notes }
}

/** The rules of a template in words, for its header ("On · 2 rules (1 blocks) · base size from chest · limits on 3 points"). */
export function rulesSummary(template: { readonly rulesOn: boolean; readonly baseSizeRule: BaseSizeRule | null; readonly points: readonly TemplatePoint[]; readonly rules: readonly RuleFields[] }): string {
  const active = template.rules.filter((rule) => rule.status === 'ACTIVE')
  const blocking = active.filter((rule) => rule.severity === 'BLOCK').length
  const limited = template.points.filter((point) => point.status === 'ACTIVE' && (point.alterationMinus !== null || point.alterationPlus !== null)).length
  return [
    template.rulesOn ? 'On' : 'Off (nothing is checked)',
    `${active.length} rule${active.length === 1 ? '' : 's'}${blocking > 0 ? ` (${blocking} blocking)` : ''}`,
    template.baseSizeRule ? `base size from ${template.baseSizeRule.points.join(', ')}` : 'no base size rule',
    `alteration limits on ${limited} point${limited === 1 ? '' : 's'}`,
  ].join(' · ')
}
