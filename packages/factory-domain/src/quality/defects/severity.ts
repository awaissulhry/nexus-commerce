import { CLASS_RANK, DEFECT_CLASSES, useAsIsProblem, type DefectClass, type DispositionOutcome } from './rules'

/**
 * The severity classes and the safety rule (B-W2b-90; QHS-002; design quality.defects df-severity "Critical, major, minor
 * with the safety rule"; quality.plans "critical is locked at 0 with the reason"; quality.ncr "'Use as is' on a major or
 * any critical defect is refused (critical is never accepted)"), pure. One rule, said once, for every step that judges a
 * defect:
 *
 *   classes        CRITICAL, MAJOR, MINOR (factory-db DefectClass, in its order), each with its words and what it means,
 *                  in Italian and English. The texts are fixed here: the tenant's own texts per class need a place to keep
 *                  them (a schema need of B-W2b-90), and the critical one stays locked whatever a tenant writes.
 *   the safety     a critical defect is a safety or compliance failure of a PPE garment (Regulation (EU) 2016/425: the
 *   rule           maker keeps series production in conformity with the essential requirements). It is never accepted:
 *                    - its acceptance number in a sampling plan or an AQL profile is always 0 (`acceptanceProblem`);
 *                    - a defect the library classes critical is recorded critical, never milder (`recordedClassProblem`;
 *                      a major or minor one may be judged worse or milder on the record);
 *                    - no decision lets goods with it go on: not used as they are, not regraded to second quality, not
 *                      sold under a customer's concession (`acceptedDecisionProblem`); a major one is never used as is
 *                      either (W2a's useAsIsProblem, unchanged).
 * The W1 final inspection already fails on any critical defect and never overrides one (quality/final/rules); the steps
 * that judge defects next (B-W2b-93 AQL, -97 final by plan, -98 incoming, -99 in-process, -113 concession) call these.
 */

/** The law the safety rule rests on (the design's LawRef on the critical class). */
export const SAFETY_LAW = 'Regulation (EU) 2016/425 (PPE), art. 8 and Annex II' as const

export interface ClassWords {
  readonly it: string
  readonly en: string
}

export interface SeverityClass {
  readonly class: DefectClass
  /** 0 = worst (CLASS_RANK). */
  readonly rank: number
  readonly words: ClassWords
  /** What the class means, and what it allows. */
  readonly meaning: ClassWords
  /** The acceptance number every plan gives the class, when the rule fixes it (critical: 0); null: the plan's AQL. */
  readonly acceptanceNumber: number | null
  /** Locked: no tenant text or plan changes what it means (the critical class). */
  readonly locked: boolean
  readonly law: string | null
}

const cls = (klass: DefectClass, words: ClassWords, meaning: ClassWords, acceptanceNumber: number | null, locked: boolean, law: string | null): SeverityClass =>
  Object.freeze({ class: klass, rank: CLASS_RANK[klass], words: Object.freeze(words), meaning: Object.freeze(meaning), acceptanceNumber, locked, law })

export const SEVERITY_CLASSES: readonly SeverityClass[] = Object.freeze([
  cls(
    'CRITICAL',
    { it: 'Critico', en: 'Critical' },
    {
      it: 'Un difetto di sicurezza o di conformità (protezione DPI, marcatura CE o etichetta EN 17092, sostanza vietata): mai accettato (AQL 0).',
      en: 'A safety or compliance failure (PPE protection, CE marking or EN 17092 label, a restricted substance): never accepted (AQL 0).',
    },
    0,
    true,
    SAFETY_LAW,
  ),
  cls(
    'MAJOR',
    { it: 'Maggiore', en: 'Major' },
    {
      it: "Un difetto che fa probabilmente fallire il capo nell'uso o lo fa rendere: accettato solo entro l'AQL del piano, mai usato così com'è.",
      en: 'A defect likely to make the garment fail in use or come back: accepted only within the plan\'s AQL, never used as it is.',
    },
    null,
    false,
    null,
  ),
  cls(
    'MINOR',
    { it: 'Minore', en: 'Minor' },
    {
      it: "Uno scostamento dallo standard che non tocca l'uso né la sicurezza: accettato entro l'AQL del piano, può essere usato così com'è.",
      en: 'A departure from the standard that touches neither use nor safety: accepted within the plan\'s AQL, may be used as it is.',
    },
    null,
    false,
    null,
  ),
])

/** The safety rule in one line (the design's locked text). */
export const SAFETY_RULE: ClassWords = Object.freeze({
  it: 'Critico = difetto di sicurezza o di conformità; mai accettato (AQL 0).',
  en: 'Critical = safety or compliance failure; never accepted (AQL 0).',
})

export const severityClassOf = (klass: DefectClass): SeverityClass => SEVERITY_CLASSES.find((entry) => entry.class === klass)!

/** The words of a class in Italian or English (another language: English; the caller says the words are missing). */
export const classWordsIn = (klass: DefectClass, language: string): string => (language === 'it' ? severityClassOf(klass).words.it : severityClassOf(klass).words.en)

/**
 * The classes a defect may be recorded as, worst first: a defect the library classes critical stays critical; a major or
 * minor one (or one with no class: a free defect) may be judged any class.
 */
export function classesAllowed(defaultClass: DefectClass | null | undefined): DefectClass[] {
  return defaultClass === 'CRITICAL' ? ['CRITICAL'] : [...DEFECT_CLASSES]
}

/** Is a defect locked to its class on a record (a critical defect of the library)? */
export const classLocked = (defaultClass: DefectClass | null | undefined): boolean => defaultClass === 'CRITICAL'

/** Why a record may not class a defect this way (null: it may). A critical defect of the library is never recorded milder. */
export function recordedClassProblem(defaultClass: DefectClass | null | undefined, recorded: DefectClass, code?: string): string | null {
  if (classesAllowed(defaultClass).includes(recorded)) return null
  return `${code ?? 'This defect'} is critical in the defect library (a safety or compliance failure): it is recorded critical, never ${recorded.toLowerCase()}.`
}

/** Why an acceptance number may not be given to a class (null: it may). Critical is always 0; major and minor from 0. */
export function acceptanceProblem(klass: DefectClass, acceptanceNumber: number): string | null {
  if (!Number.isInteger(acceptanceNumber) || acceptanceNumber < 0) return 'An acceptance number is a whole number from 0.'
  if (klass === 'CRITICAL' && acceptanceNumber !== 0) return `A critical defect is never accepted: its acceptance number is always 0 (${SAFETY_LAW}).`
  return null
}

/**
 * The decisions that let goods with a defect go on: used as they are, regraded to second quality, sold under the
 * customer's written concession (B-W2b-113's NcrConcession). Every other outcome (rework, repair, return to the supplier,
 * quarantine, scrap) takes the goods out of the way and is open to every class.
 */
export const ACCEPTING_DECISIONS = ['USE_AS_IS', 'REGRADE', 'CONCESSION'] as const
export type AcceptingDecision = (typeof ACCEPTING_DECISIONS)[number]

/** Why a decision may not be taken on a defect of this class (null: it may). */
export function acceptedDecisionProblem(decision: AcceptingDecision | DispositionOutcome, severity: DefectClass): string | null {
  if (severity === 'CRITICAL' && (ACCEPTING_DECISIONS as readonly string[]).includes(decision)) {
    const what = decision === 'USE_AS_IS' ? 'used as it is' : decision === 'REGRADE' ? 'regraded to second quality' : 'sold under a concession'
    return `A critical defect is never accepted: the goods are not ${what} (rework, repair, return, quarantine or scrap them).`
  }
  // A major one is never used as it is: W2a's rule, in its own words.
  return decision === 'USE_AS_IS' ? useAsIsProblem(decision, severity) : null
}
