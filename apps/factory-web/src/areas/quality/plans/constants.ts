/**
 * The lists of factory-domain quality/plans and quality/triggers that the screens of Inspection plans & AQL need
 * (B-W2b-104). Those two domain files reach `node:crypto` (the approval's SHA-256, the frequency's fixed draw), which a
 * browser module may not import: the lists are written here and held EQUAL to the domain's by plans.vitest.test.ts. The
 * AQL lists come straight from factory-domain quality/aql (browser-safe).
 */

export const PLAN_STAGES = ['INCOMING', 'CUTTING', 'IN_LINE', 'END_OF_LINE', 'FINAL', 'RETURN'] as const
export type PlanStage = (typeof PLAN_STAGES)[number]

export const VERSION_STATUSES = ['DRAFT', 'APPROVED', 'RETIRED'] as const
export type VersionStatus = (typeof VERSION_STATUSES)[number]

export const CHECK_TYPES = ['PASS_FAIL', 'MEASUREMENT', 'COUNT', 'CHOICE', 'FREE_TEXT', 'PHOTO', 'SIGNATURE', 'INSTRUCTION'] as const
export type CheckType = (typeof CHECK_TYPES)[number]
/** An instruction is only read: every other type takes a result. */
export const takesResult = (type: CheckType): boolean => type !== 'INSTRUCTION'

export const CHECK_CLASSES = ['CRITICAL', 'MAJOR', 'MINOR'] as const
export type CheckClass = (typeof CHECK_CLASSES)[number]

export const SAMPLING_METHODS = ['AQL_PROFILE', 'FIXED'] as const
export type SamplingMethod = (typeof SAMPLING_METHODS)[number]

export const FREQUENCIES = ['EVERY_LOT', 'PERCENT_OF_OPERATIONS', 'FIRST_PIECE', 'EVERY_NTH_BUNDLE'] as const
export type Frequency = (typeof FREQUENCIES)[number]
/** The frequencies that take a number (a share, an N). */
export const FREQUENCY_TAKES_VALUE: Readonly<Record<Frequency, boolean>> = Object.freeze({ EVERY_LOT: false, PERCENT_OF_OPERATIONS: true, FIRST_PIECE: false, EVERY_NTH_BUNDLE: true })

export const CHIP_KINDS = ['STYLE', 'CATEGORY', 'MATERIAL', 'SUPPLIER', 'OPERATION', 'CUSTOMER'] as const
export type ChipKind = (typeof CHIP_KINDS)[number]

/** A CATEGORY chip: a garment's product type, then a material's kind (factory-domain CATEGORY_CODES, in its order). */
export const GARMENT_CATEGORIES = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'] as const
export const MATERIAL_CATEGORIES = ['LEATHER', 'TEXTILE', 'LINING', 'MEMBRANE', 'PADDING', 'THREAD', 'TRIM', 'HARDWARE', 'PROTECTOR', 'LABEL', 'PACKAGING', 'COMPONENT'] as const
export const CATEGORY_CODES: readonly string[] = Object.freeze([...GARMENT_CATEGORIES, ...MATERIAL_CATEGORIES])

/** A measurement's units on the bench (factory-domain UOMS, the lengths). */
export const MEASURE_UOMS = ['CM', 'MM', 'M'] as const

/** "FIN-JACKET": upper-case letters, digits, - and _, 2-40, starting with a letter. Fixed once made. */
export const PLAN_CODE = /^[A-Z][A-Z0-9_-]{1,39}$/
/** "CE_MARK": upper-case letters, digits and _, 2-40, starting with a letter. Kept across versions. */
export const CHECK_CODE = /^[A-Z][A-Z0-9_]{1,39}$/
/** A nominal or tolerance: up to 9 digits and 3 decimals, from 0. */
export const MEASURE = /^\d{1,9}(\.\d{1,3})?$/
/** An AQL profile's code (factory-domain quality/aql/profiles PROFILE_CODE). */
export const PROFILE_CODE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/

export const PLAN_LIMITS = Object.freeze({
  name: 120,
  changeNote: 500,
  reason: 500,
  label: 200,
  checks: 200,
  chips: 40,
  choices: 20,
  choice: 60,
  fixedSample: 10_000,
  everyNth: 10_000,
})

export const TRIGGER_EVENTS = ['GOODS_RECEIPT', 'OPERATION_FINISHED', 'BUNDLE_SCAN', 'PACKING', 'RETURN_RECEIVED'] as const
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number]

// B-W2b-213: FINAL, a final inspection a PACKING rule opens.
export const RECORD_KINDS = ['INCOMING', 'CUTTING', 'FIRST_PIECE', 'ROVING', 'END_OF_LINE', 'FINAL'] as const
export type RecordKind = (typeof RECORD_KINDS)[number]

/** What a rule opens for a plan's stage and the rule's frequency (factory-domain recordKindOf). */
export function recordKindOf(stage: PlanStage, frequency: Frequency): RecordKind | null {
  switch (stage) {
    case 'INCOMING':
      return 'INCOMING'
    case 'CUTTING':
      return 'CUTTING'
    case 'IN_LINE':
      return frequency === 'FIRST_PIECE' ? 'FIRST_PIECE' : 'ROVING'
    case 'END_OF_LINE':
      return 'END_OF_LINE'
    case 'FINAL':
      return 'FINAL'
    default:
      return null
  }
}
