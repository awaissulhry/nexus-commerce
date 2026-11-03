import { Dec } from '../../tax/decimal'
import { SAFETY_LAW, SAFETY_RULE } from '../defects/severity'
import {
  AQL_COLUMNS,
  codeLetterFor,
  INSPECTION_LEVELS,
  isInspectionLevel,
  LOT_SIZE_MAX,
  SAMPLE_SIZES,
  tablePlan,
  type AqlColumn,
  type CodeLetter,
  type InspectionLevel,
} from './iso2859'

/**
 * The AQL sample-size engine (B-W2b-93; QHS-020): ISO 2859-1 single sampling, normal inspection, for the three defect
 * classes of a garment inspection — the same model as the design system's AqlCounter (packages/ui floor aqlModel): ONE
 * sample of n units, and per class its acceptance number Ac and rejection number Re = Ac + 1.
 *
 *   lot size + level  → Table 1 → code letter        (iso2859.ts codeLetterFor)
 *   letter + class AQL → Table 2-A → that class's plan (iso2859.ts tablePlan: n, Ac, Re after the arrows)
 *
 * - **Critical** is always AQL 0: accept 0, reject 1, on the whole sample (QHS-002; Regulation (EU) 2016/425). It reads no
 *   table: "AQL 0" is not a column of Table 2-A. A major or minor AQL of 0 means the same (no defect of the class).
 * - **One sample**: each class's plan is Table 2-A's, exactly. When the arrows give the classes different sample sizes,
 *   the inspection takes the largest of them, and each class keeps its own Ac and Re: a class whose own plan asks fewer
 *   units is then judged on more, which is stricter, never looser, than its plan (design: one sample, one counter).
 * - **100 % inspection**: a sample as large as the lot, or larger, inspects the whole lot (Table 2-A's note); the
 *   acceptance numbers stay the plan's.
 * - A lot of 1 unit has no code letter (Table 1 starts at 2): it is inspected whole, nothing of any class accepted.
 *
 * The record keeps the code letter of Table 1 (the lot's), the sample and the acceptance numbers (Inspection.codeLetter,
 * sampleSize, acceptMajor, acceptMinor); the words say where an arrow moved a class.
 */

export const DEFECT_CLASSES_AQL = ['CRITICAL', 'MAJOR', 'MINOR'] as const
export type AqlDefectClass = (typeof DEFECT_CLASSES_AQL)[number]

/** The AQLs a profile may name for major and minor: 0 (no defect of the class accepted) or a column of Table 2-A. */
export const AQL_VALUES: readonly string[] = Object.freeze(['0', ...AQL_COLUMNS])

/** The critical class's AQL, always (QHS-002). */
export const CRITICAL_AQL = '0'

/** Why critical is locked at 0, for the screens (the defect vocabulary's safety rule and its law). */
export const CRITICAL_LOCK = Object.freeze({ aql: CRITICAL_AQL, accept: 0, reject: 1, rule: Object.freeze({ it: SAFETY_RULE.it, en: SAFETY_RULE.en }), law: SAFETY_LAW })

const isDecimalText = (value: string): boolean => /^\d{1,4}(\.\d{1,3})?$/.test(value.trim())

/** The Table 2-A column of an AQL written any way ("2.5", "2.500", "10.000"); null: 0 or not a column. */
export function aqlColumnOf(value: string): AqlColumn | null {
  if (!isDecimalText(value)) return null
  const asked = new Dec(value.trim())
  return AQL_COLUMNS.find((column) => new Dec(column).equals(asked)) ?? null
}

/** An AQL the engine takes: 0 or a column of Table 2-A. */
export function isAqlValue(value: string): boolean {
  if (!isDecimalText(value)) return false
  return new Dec(value.trim()).isZero() || aqlColumnOf(value) !== null
}

/** The AQL as Table 2-A prints it ("2.500" → "2.5", "0.000" → "0"); unchanged when it is no AQL value. */
export function aqlWords(value: string): string {
  if (!isDecimalText(value)) return value
  if (new Dec(value.trim()).isZero()) return '0'
  return aqlColumnOf(value) ?? value.trim()
}

/** The AQL as the database keeps it (Decimal(7,3)): "2.5" → "2.500". */
export const aqlStored = (value: string): string => new Dec(value.trim()).toFixed(3)

/** The AQLs a major or minor may take, in words, for a refusal. */
export const AQL_VALUES_WORDS = AQL_VALUES.join(', ')

// ---- the inspection level as W1's Inspection keeps it (text) --------------------------------------------------------

const LEVEL_TEXT: Readonly<Record<InspectionLevel, string>> = Object.freeze({ S1: 'S-1', S2: 'S-2', S3: 'S-3', S4: 'S-4', I: 'I', II: 'II', III: 'III' })

/** The level in ISO 2859-1's words, as Inspection.inspectionLevel keeps it ("II", "S-3"). */
export const levelText = (level: InspectionLevel): string => LEVEL_TEXT[level]

/** A level typed in words ("II", "s-3", "S3", "level II") to the profile's level; null: not an ISO 2859-1 level. */
export function levelOf(text: string): InspectionLevel | null {
  const plain = text.trim().toUpperCase().replace(/^LEVEL\s+/, '').replace(/[\s-]/g, '')
  return isInspectionLevel(plain) ? plain : null
}

export const LEVEL_WORDS: Readonly<Record<InspectionLevel, { readonly it: string; readonly en: string }>> = Object.freeze({
  S1: { it: 'Speciale S-1', en: 'Special S-1' },
  S2: { it: 'Speciale S-2', en: 'Special S-2' },
  S3: { it: 'Speciale S-3', en: 'Special S-3' },
  S4: { it: 'Speciale S-4', en: 'Special S-4' },
  I: { it: 'Generale I', en: 'General I' },
  II: { it: 'Generale II', en: 'General II' },
  III: { it: 'Generale III', en: 'General III' },
})

/** "general level II", "special level S-3". */
export const levelPhrase = (level: InspectionLevel): string => `${level.startsWith('S') ? 'special' : 'general'} level ${levelText(level)}`

// ---- the plan -------------------------------------------------------------------------------------------------------

/** What the engine is asked: the lot, the level, and the major and minor AQLs (critical is always 0). */
export interface SamplingAsk {
  readonly lotSize: number
  readonly level: InspectionLevel
  readonly aqlMajor: string
  readonly aqlMinor: string
}

/** One class of the plan. */
export interface ClassPlan {
  readonly defectClass: AqlDefectClass
  /** As Table 2-A prints it ("2.5"); "0" for critical (and a major or minor of 0). */
  readonly aql: string
  /** Ac: the most units with a defect of this class the sample may hold and pass. */
  readonly accept: number
  /** Re = Ac + 1: this many rejects the lot at once. */
  readonly reject: number
  /** The class's own plan in Table 2-A: its letter and sample size (after an arrow); null for AQL 0 (no table read). */
  readonly planLetter: CodeLetter | null
  readonly planSampleSize: number | null
  /** The arrow Table 2-A showed at the lot's letter, if any. */
  readonly arrow: 'down' | 'up' | null
  /** Critical: locked at 0 (QHS-002). */
  readonly locked: boolean
}

export interface SamplingPlanResult {
  readonly lotSize: number
  readonly level: InspectionLevel
  /** Table 1's letter for the lot; null for a lot of 1 (inspected whole). */
  readonly codeLetter: CodeLetter | null
  /** The units to inspect: the largest of the classes' plans, at most the lot. */
  readonly sampleSize: number
  /** The plan asks the whole lot (its sample is as large as the lot, or larger). */
  readonly hundredPercent: boolean
  /** The classes' plans differ in sample size (the largest is taken; the others are judged on more units). */
  readonly samplesDiffer: boolean
  /** Critical, major, minor. */
  readonly classes: readonly ClassPlan[]
  /** The derivation in one sentence ("Lot 480 · general level II → code letter H → inspect 50."). */
  readonly words: string
  /** One line per class ("Major 2.5: accept 3, reject 4."), and where an arrow moved a class's plan. */
  readonly classWords: readonly string[]
}

export interface SamplingProblem {
  readonly path: string
  readonly message: string
}

/** What is wrong with an ask, every problem at once (paths: lotSize, level, aqlMajor, aqlMinor). */
export function samplingProblems(ask: { readonly lotSize: number; readonly level: string; readonly aqlMajor: string; readonly aqlMinor: string }): SamplingProblem[] {
  const problems: SamplingProblem[] = []
  if (!Number.isInteger(ask.lotSize) || ask.lotSize < 1) problems.push({ path: 'lotSize', message: 'The lot is at least one unit.' })
  else if (ask.lotSize > LOT_SIZE_MAX) problems.push({ path: 'lotSize', message: `At most ${LOT_SIZE_MAX} units in one lot.` })
  if (!isInspectionLevel(ask.level)) problems.push({ path: 'level', message: `An ISO 2859-1 inspection level: ${INSPECTION_LEVELS.join(', ')}.` })
  for (const key of ['aqlMajor', 'aqlMinor'] as const) {
    if (!isAqlValue(ask[key])) problems.push({ path: key, message: `An AQL of ISO 2859-1 Table 2-A (percent of units with a defect): ${AQL_VALUES_WORDS}. "${ask[key]}" is not one.` })
  }
  return problems
}

function classPlan(defectClass: AqlDefectClass, aql: string, letter: CodeLetter | null): ClassPlan {
  const column = defectClass === 'CRITICAL' ? null : aqlColumnOf(aql)
  if (column === null || letter === null) {
    // AQL 0 (critical always), or a lot of one unit (no code letter): nothing of the class is accepted; the AQL stays as asked.
    return { defectClass, aql: column ?? '0', accept: 0, reject: 1, planLetter: null, planSampleSize: null, arrow: null, locked: defectClass === 'CRITICAL' }
  }
  const plan = tablePlan(letter, column)
  return { defectClass, aql: column, accept: plan.accept, reject: plan.reject, planLetter: plan.letter, planSampleSize: plan.sampleSize, arrow: plan.arrow, locked: false }
}

const CLASS_NAME: Readonly<Record<AqlDefectClass, string>> = Object.freeze({ CRITICAL: 'Critical', MAJOR: 'Major', MINOR: 'Minor' })

/**
 * The sampling plan of a lot (QHS-020): the code letter, the one sample, and per class AQL, Ac and Re, with the
 * derivation in words. Throws on an ask with problems (check samplingProblems first).
 */
export function samplingPlan(ask: SamplingAsk): SamplingPlanResult {
  const problems = samplingProblems(ask)
  if (problems.length > 0) throw new RangeError(problems.map((problem) => `${problem.path}: ${problem.message}`).join(' '))
  const letter = ask.lotSize >= 2 ? codeLetterFor(ask.lotSize, ask.level) : null
  const classes = [classPlan('CRITICAL', CRITICAL_AQL, letter), classPlan('MAJOR', ask.aqlMajor, letter), classPlan('MINOR', ask.aqlMinor, letter)]
  const planSizes = classes.map((entry) => entry.planSampleSize).filter((size): size is number => size !== null)
  // No class reads the table (every AQL 0): the letter's own sample.
  const largest = planSizes.length > 0 ? Math.max(...planSizes) : letter ? SAMPLE_SIZES[letter] : 1
  const sampleSize = Math.min(largest, ask.lotSize)
  const hundredPercent = largest >= ask.lotSize
  const samplesDiffer = new Set(planSizes).size > 1
  const lot = `Lot ${ask.lotSize} · ${levelPhrase(ask.level)}`
  const words = letter
    ? `${lot} → code letter ${letter} → inspect ${sampleSize}${hundredPercent ? ` (the whole lot: the plan's sample of ${largest} is not smaller than the lot)` : ''}.`
    : `${lot} → a lot of one unit is inspected whole.`
  const classWords = classes.map((entry) => {
    const head = `${CLASS_NAME[entry.defectClass]} ${entry.aql}: accept ${entry.accept}, reject ${entry.reject}`
    if (entry.locked) return `${head} (a critical defect is never accepted).`
    if (entry.planLetter === null) return `${head} (${entry.aql === '0' ? 'AQL 0: no defect of the class is accepted' : 'a lot of one unit is inspected whole: nothing is accepted'}).`
    const moved = entry.arrow ? ` Table 2-A has an arrow at ${letter}: the plan is at ${entry.planLetter} (n ${entry.planSampleSize}).` : ''
    const stricter = entry.planSampleSize !== null && entry.planSampleSize < sampleSize ? ` Its plan asks ${entry.planSampleSize}; it is judged on the whole sample of ${sampleSize}, which is stricter.` : ''
    return `${head}.${moved}${stricter}`
  })
  return { lotSize: ask.lotSize, level: ask.level, codeLetter: letter, sampleSize, hundredPercent, samplesDiffer, classes, words, classWords }
}

/** The acceptance numbers a record keeps (Inspection.acceptMajor, acceptMinor). */
export function acceptanceOf(plan: SamplingPlanResult): { readonly acceptMajor: number; readonly acceptMinor: number } {
  const find = (defectClass: AqlDefectClass) => plan.classes.find((entry) => entry.defectClass === defectClass)!.accept
  return { acceptMajor: find('MAJOR'), acceptMinor: find('MINOR') }
}
