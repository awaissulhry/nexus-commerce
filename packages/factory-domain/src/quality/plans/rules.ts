import { createHash } from 'node:crypto'
import { canonicalJson } from '../../accounting/manifest'
import type { Issue } from '../../core/errors'
import { isUuid } from '../../core/ids'
import { ITEM_KINDS } from '../../product/materials/rules'
import { PRODUCT_TYPES } from '../../product/styles/rules'
import { UOMS, type Uom } from '../../product/units/units'
import { LANGUAGE_CODE } from '../../reasons/rules'
import { DEFECT_CLASSES, type DefectClass } from '../defects/rules'

/**
 * Inspection plans (B-W2b-92; QHS-008 templates, QHS-009 check types, QHS-016 versions frozen on each record; design
 * quality.plans SCR-077 and the plan record in Builder page mode): pure rules, figures by hand in plans.vitest.test.ts.
 * The database holds the same rules for every login (…_inspection_plans_w2b_guards: InspectionPlan_guard,
 * InspectionPlanVersion_guard, InspectionPlanCheck_guard); the API answers with these words first.
 *
 *   a plan         a company's checklist template for one stage (incoming, cutting, in-line, end of line, final, return):
 *                  a code (fixed, "FIN-JACKET"), a name, an owner and where it applies (rule chips by style, category,
 *                  material, supplier, operation, customer; none = everything of its stage). Never deleted.
 *   a version      DRAFT while it is written; APPROVED by a SECOND person, never its author nor anyone who saved a
 *                  change to it (QHS-016), with an e-signature: it is then frozen with its checks and the version that
 *                  was in force is RETIRED in the same command (one APPROVED per plan); a draft nobody wants is RETIRED.
 *                  A record (final, incoming, in-process) names the APPROVED version when it opens and keeps it for
 *                  good, so a later version changes no record.
 *   a check        one line of the checklist (QHS-009): a code kept from version to version (results compare by it),
 *                  words in Italian, English and the floor's other languages, a type (pass/fail, measurement against
 *                  nominal ± tolerance or the size's graded spec, count, choice, free text, photo, signature,
 *                  instruction only), a class (a failed CRITICAL check fails the record), mandatory, photo required.
 *   sampling       an AQL profile (the one named, or the one that applies: style, customer, company default) or a
 *                  fixed number of units; how often (every lot, a share of operations, first piece, every Nth bundle);
 *                  stop at the reject number or finish the sample (null: the company's quality setting).
 */

export const PLAN_STAGES = ['INCOMING', 'CUTTING', 'IN_LINE', 'END_OF_LINE', 'FINAL', 'RETURN'] as const
export type PlanStage = (typeof PLAN_STAGES)[number]

type Words = Readonly<{ it: string; en: string }>
const w = (it: string, en: string): Words => Object.freeze({ it, en })

export const STAGE_WORDS: Readonly<Record<PlanStage, Words>> = Object.freeze({
  INCOMING: w('In arrivo', 'Incoming'),
  CUTTING: w('Taglio', 'Cutting'),
  IN_LINE: w('In linea', 'In-line'),
  END_OF_LINE: w('Fine linea', 'End of line'),
  FINAL: w('Finale', 'Final'),
  RETURN: w('Reso', 'Return'),
})

/** The record an inspection of each stage is (B-W2b-76); a return has none yet (the return's own grading). */
export const STAGE_RECORDS: Readonly<Record<PlanStage, 'Inspection' | 'IncomingInspection' | 'InProcessCheck' | null>> = Object.freeze({
  INCOMING: 'IncomingInspection',
  CUTTING: 'InProcessCheck',
  IN_LINE: 'InProcessCheck',
  END_OF_LINE: 'InProcessCheck',
  FINAL: 'Inspection',
  RETURN: null,
})

export const VERSION_STATUSES = ['DRAFT', 'APPROVED', 'RETIRED'] as const
export type VersionStatus = (typeof VERSION_STATUSES)[number]
export const VERSION_STATUS_WORDS: Readonly<Record<VersionStatus, Words>> = Object.freeze({
  DRAFT: w('Bozza', 'Draft'),
  APPROVED: w('Approvata', 'Approved'),
  RETIRED: w('Ritirata', 'Retired'),
})

export const CHECK_TYPES = ['PASS_FAIL', 'MEASUREMENT', 'COUNT', 'CHOICE', 'FREE_TEXT', 'PHOTO', 'SIGNATURE', 'INSTRUCTION'] as const
export type CheckType = (typeof CHECK_TYPES)[number]

/** Each check type in words, and whether it takes a result (an instruction is only read). */
export const CHECK_TYPE_WORDS: Readonly<Record<CheckType, Words & { readonly takesResult: boolean }>> = Object.freeze({
  PASS_FAIL: { ...w('Conforme / non conforme', 'Pass / fail'), takesResult: true },
  MEASUREMENT: { ...w('Misura', 'Measurement'), takesResult: true },
  COUNT: { ...w('Conteggio', 'Count'), takesResult: true },
  CHOICE: { ...w('Scelta', 'Choice'), takesResult: true },
  FREE_TEXT: { ...w('Testo libero', 'Free text'), takesResult: true },
  PHOTO: { ...w('Foto', 'Photo'), takesResult: true },
  SIGNATURE: { ...w('Firma', 'Signature'), takesResult: true },
  INSTRUCTION: { ...w('Solo istruzione', 'Instruction only'), takesResult: false },
})

export const takesResult = (type: CheckType): boolean => CHECK_TYPE_WORDS[type].takesResult

export const CLASS_WORDS: Readonly<Record<DefectClass, Words>> = Object.freeze({
  CRITICAL: w('Critico', 'Critical'),
  MAJOR: w('Maggiore', 'Major'),
  MINOR: w('Minore', 'Minor'),
})

export const SAMPLING_METHODS = ['AQL_PROFILE', 'FIXED'] as const
export type SamplingMethod = (typeof SAMPLING_METHODS)[number]
export const FREQUENCIES = ['EVERY_LOT', 'PERCENT_OF_OPERATIONS', 'FIRST_PIECE', 'EVERY_NTH_BUNDLE'] as const
export type Frequency = (typeof FREQUENCIES)[number]

export const CHIP_KINDS = ['STYLE', 'CATEGORY', 'MATERIAL', 'SUPPLIER', 'OPERATION', 'CUSTOMER'] as const
export type ChipKind = (typeof CHIP_KINDS)[number]
export const CHIP_KIND_WORDS: Readonly<Record<ChipKind, Words>> = Object.freeze({
  STYLE: w('Modello', 'Style'),
  CATEGORY: w('Categoria', 'Category'),
  MATERIAL: w('Materiale', 'Material'),
  SUPPLIER: w('Fornitore', 'Supplier'),
  OPERATION: w('Operazione', 'Operation'),
  CUSTOMER: w('Cliente', 'Customer'),
})

/** A rule chip of "Applies to": a kind and its value (an id, or a category code). */
export interface Chip {
  readonly kind: ChipKind
  readonly value: string
}

/**
 * The categories a CATEGORY chip names: a garment's product type (the styles' categories) or a material's kind (what
 * arrives at goods receipt).
 */
export const CATEGORY_WORDS: Readonly<Record<string, Words>> = Object.freeze({
  JACKET: w('Giacche', 'Jackets'),
  TROUSERS: w('Pantaloni', 'Trousers'),
  SUIT: w('Tute', 'Suits'),
  GLOVES: w('Guanti', 'Gloves'),
  VEST: w('Gilet', 'Vests'),
  OTHER: w('Altri capi', 'Other garments'),
  LEATHER: w('Pelle', 'Leather'),
  TEXTILE: w('Tessuto', 'Textile'),
  LINING: w('Fodera', 'Lining'),
  MEMBRANE: w('Membrana', 'Membrane'),
  PADDING: w('Imbottitura', 'Padding'),
  THREAD: w('Filo', 'Thread'),
  TRIM: w('Accessori', 'Trims'),
  HARDWARE: w('Minuteria', 'Hardware'),
  PROTECTOR: w('Protezioni', 'Protectors'),
  LABEL: w('Etichette', 'Labels'),
  PACKAGING: w('Imballo', 'Packaging'),
  COMPONENT: w('Componenti', 'Components'),
})
export const CATEGORY_CODES: readonly string[] = Object.freeze([...PRODUCT_TYPES, ...ITEM_KINDS])

/** A plan's code: upper-case letters, digits, - and _, 2-40, starting with a letter ("FIN-JACKET"). Fixed once made. */
export const PLAN_CODE = /^[A-Z][A-Z0-9_-]{1,39}$/
/** A check's code: upper-case letters, digits and _, 2-40, starting with a letter ("CE_MARK"). Kept across versions. */
export const CHECK_CODE = /^[A-Z][A-Z0-9_]{1,39}$/
/** A measurement's nominal or tolerance as text: up to 9 digits and 3 decimals, from 0 (Decimal(12, 3)). */
export const MEASURE = /^\d{1,9}(\.\d{1,3})?$/

export const PLAN_LIMITS = Object.freeze({
  name: 120,
  changeNote: 500,
  reason: 500,
  label: 200,
  languages: 12,
  checks: 200,
  chips: 40,
  choices: 20,
  choice: 60,
  plansPerCompany: 500,
  fixedSample: 10_000,
  everyNth: 10_000,
})

const blank = (value: string | null | undefined): boolean => value === undefined || value === null || value.trim() === ''

// ---- the plan ----------------------------------------------------------------------------------------------------------

export interface PlanDraft {
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly appliesTo?: readonly Chip[] | undefined
}

/** A chip list: known kinds, ids where an id is named, a known category, each chip once. */
export function chipsProblems(chips: readonly Chip[], path = 'appliesTo'): Issue[] {
  const problems: Issue[] = []
  if (chips.length > PLAN_LIMITS.chips) problems.push({ path, message: `At most ${PLAN_LIMITS.chips} chips.` })
  const seen = new Set<string>()
  chips.forEach((chip, index) => {
    const at = `${path}/${index}`
    if (!(CHIP_KINDS as readonly string[]).includes(chip.kind)) problems.push({ path: `${at}/kind`, message: 'A chip is a style, category, material, supplier, operation or customer.' })
    else if (chip.kind === 'CATEGORY' ? !CATEGORY_CODES.includes(chip.value) : !isUuid(chip.value)) {
      problems.push({ path: `${at}/value`, message: chip.kind === 'CATEGORY' ? 'Pick one of the categories offered (a kind of garment or of material).' : `Pick the ${CHIP_KIND_WORDS[chip.kind].en.toLowerCase()} from the list.` })
    }
    const key = `${chip.kind}|${chip.value}`
    if (seen.has(key)) problems.push({ path: `${at}/value`, message: 'This chip is there already.' })
    seen.add(key)
  })
  return problems
}

/** A new plan (creating: code and name needed) or a change of one: code, name and chips, every problem at once. */
export function planDraftProblems(draft: PlanDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating || draft.code !== undefined) {
    const code = draft.code ?? ''
    if (!PLAN_CODE.test(code)) problems.push({ path: 'code', message: 'A plan code is 2 to 40 upper-case letters, digits, - or _, starting with a letter (FIN-JACKET).' })
  }
  if (creating || draft.name !== undefined) {
    if (blank(draft.name)) problems.push({ path: 'name', message: 'Name the plan.' })
    else if (draft.name!.trim().length > PLAN_LIMITS.name) problems.push({ path: 'name', message: `At most ${PLAN_LIMITS.name} characters.` })
  }
  if (draft.appliesTo !== undefined) problems.push(...chipsProblems(draft.appliesTo))
  return problems
}

// ---- checks (QHS-009) --------------------------------------------------------------------------------------------------

export interface CheckDraft {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n?: Readonly<Record<string, string>> | undefined
  readonly type: CheckType
  readonly checkClass?: DefectClass | null | undefined
  /** Default: true, but an instruction is never mandatory. */
  readonly mandatory?: boolean | undefined
  readonly photoRequired?: boolean | undefined
  readonly nominal?: string | null | undefined
  readonly tolerance?: string | null | undefined
  readonly uom?: Uom | null | undefined
  readonly choices?: readonly string[] | undefined
}

/** A check as it is stored: every field said (defaults filled, words trimmed). */
export interface CheckContent {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly type: CheckType
  readonly checkClass: DefectClass | null
  readonly mandatory: boolean
  readonly photoRequired: boolean
  readonly nominal: string | null
  readonly tolerance: string | null
  readonly uom: Uom | null
  readonly choices: readonly string[]
}

/** The check with its defaults: mandatory unless an instruction; words and choices trimmed; languages sorted. */
export function checkContentOf(draft: CheckDraft): CheckContent {
  const instruction = draft.type === 'INSTRUCTION'
  return {
    code: draft.code.trim(),
    labelIt: draft.labelIt.trim(),
    labelEn: draft.labelEn.trim(),
    labelI18n: Object.fromEntries(Object.entries(draft.labelI18n ?? {}).map(([language, words]) => [language, words.trim()] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    type: draft.type,
    checkClass: draft.checkClass ?? null,
    mandatory: draft.mandatory ?? !instruction,
    photoRequired: draft.photoRequired ?? false,
    nominal: blank(draft.nominal) ? null : draft.nominal!.trim(),
    tolerance: blank(draft.tolerance) ? null : draft.tolerance!.trim(),
    uom: draft.uom ?? null,
    choices: (draft.choices ?? []).map((choice) => choice.trim()),
  }
}

/** The checks of a version in order, every problem at once (paths `checks/<i>/<field>`). An empty list is a draft's right. */
export function checksProblems(drafts: readonly CheckDraft[]): Issue[] {
  const problems: Issue[] = []
  if (drafts.length > PLAN_LIMITS.checks) problems.push({ path: 'checks', message: `A version holds at most ${PLAN_LIMITS.checks} checks.` })
  const codes = new Set<string>()
  drafts.forEach((draft, index) => {
    const at = `checks/${index}`
    const check = checkContentOf(draft)
    if (!CHECK_CODE.test(check.code)) problems.push({ path: `${at}/code`, message: 'A check code is 2 to 40 upper-case letters, digits or _, starting with a letter (CE_MARK).' })
    else if (codes.has(check.code)) problems.push({ path: `${at}/code`, message: `${check.code} is on the list twice: each check once.` })
    codes.add(check.code)
    for (const field of ['labelIt', 'labelEn'] as const) {
      if (check[field] === '') problems.push({ path: `${at}/${field}`, message: field === 'labelIt' ? 'Say the check in Italian.' : 'Say the check in English.' })
      else if (check[field].length > PLAN_LIMITS.label) problems.push({ path: `${at}/${field}`, message: `At most ${PLAN_LIMITS.label} characters.` })
    }
    const languages = Object.entries(check.labelI18n)
    if (languages.length > PLAN_LIMITS.languages) problems.push({ path: `${at}/labelI18n`, message: `At most ${PLAN_LIMITS.languages} other languages.` })
    for (const [language, words] of languages) {
      if (!LANGUAGE_CODE.test(language) || language === 'it' || language === 'en') problems.push({ path: `${at}/labelI18n/${language}`, message: 'A language is its ISO 639 code (ro, ur, zh); Italian and English have their own words.' })
      else if (words === '') problems.push({ path: `${at}/labelI18n/${language}`, message: 'Leave a language out instead of blank words.' })
      else if (words.length > PLAN_LIMITS.label) problems.push({ path: `${at}/labelI18n/${language}`, message: `At most ${PLAN_LIMITS.label} characters.` })
    }
    if (!(CHECK_TYPES as readonly string[]).includes(check.type)) {
      problems.push({ path: `${at}/type`, message: 'Pick one of the check types.' })
      return
    }
    if (check.checkClass !== null && !(DEFECT_CLASSES as readonly string[]).includes(check.checkClass)) problems.push({ path: `${at}/checkClass`, message: 'A class is critical, major or minor.' })
    const measured = [check.nominal, check.tolerance, check.uom].filter((value) => value !== null).length
    if (check.type === 'MEASUREMENT') {
      if (measured !== 0 && measured !== 3) problems.push({ path: `${at}/nominal`, message: 'A measurement has a nominal, a ± tolerance and a unit, or none of them (the size chart of the style gives the value).' })
      if (check.nominal !== null && !MEASURE.test(check.nominal)) problems.push({ path: `${at}/nominal`, message: 'A number from 0, with at most 3 decimals (58.5).' })
      if (check.tolerance !== null && !MEASURE.test(check.tolerance)) problems.push({ path: `${at}/tolerance`, message: 'A tolerance from 0, with at most 3 decimals (1.0).' })
      if (check.uom !== null && !(UOMS as readonly string[]).includes(check.uom)) problems.push({ path: `${at}/uom`, message: 'Pick one of the units.' })
    } else if (measured > 0) {
      problems.push({ path: `${at}/nominal`, message: 'Only a measurement has a nominal, a tolerance and a unit.' })
    }
    if (check.type === 'CHOICE') {
      const lower = check.choices.map((choice) => choice.toLowerCase())
      if (check.choices.length < 2) problems.push({ path: `${at}/choices`, message: 'A choice offers at least two answers.' })
      else if (check.choices.length > PLAN_LIMITS.choices) problems.push({ path: `${at}/choices`, message: `At most ${PLAN_LIMITS.choices} answers.` })
      if (check.choices.some((choice) => choice === '')) problems.push({ path: `${at}/choices`, message: 'An answer is not blank.' })
      else if (new Set(lower).size !== lower.length) problems.push({ path: `${at}/choices`, message: 'Each answer once.' })
      if (check.choices.some((choice) => choice.length > PLAN_LIMITS.choice)) problems.push({ path: `${at}/choices`, message: `An answer has at most ${PLAN_LIMITS.choice} characters.` })
    } else if (check.choices.length > 0) {
      problems.push({ path: `${at}/choices`, message: 'Only a choice offers answers.' })
    }
    if (check.type === 'INSTRUCTION' && (check.mandatory || check.checkClass !== null || check.photoRequired)) {
      problems.push({ path: `${at}/type`, message: 'An instruction is only read: it has no class, is not mandatory and asks no photo.' })
    }
  })
  return problems
}

// ---- sampling ----------------------------------------------------------------------------------------------------------

export interface SamplingDraft {
  readonly samplingMethod: SamplingMethod
  /** AQL_PROFILE: the profile named; null: the one that applies (style, customer, company default). */
  readonly aqlProfileId?: string | null | undefined
  readonly fixedSampleSize?: number | null | undefined
  readonly frequency?: Frequency | null | undefined
  readonly frequencyValue?: number | null | undefined
  /** Stop at the reject number (true) or finish the sample (false); null: the company's quality setting. */
  readonly stopAtReject?: boolean | null | undefined
}

/** How much and how often, every problem at once (paths `sampling/<field>`). */
export function samplingProblems(sampling: SamplingDraft): Issue[] {
  const problems: Issue[] = []
  const size = sampling.fixedSampleSize ?? null
  if (sampling.samplingMethod === 'FIXED') {
    if (size === null || !Number.isInteger(size) || size < 1 || size > PLAN_LIMITS.fixedSample) problems.push({ path: 'sampling/fixedSampleSize', message: `A fixed sample is 1 to ${PLAN_LIMITS.fixedSample} units.` })
    if (sampling.aqlProfileId) problems.push({ path: 'sampling/aqlProfileId', message: 'A fixed sample names no AQL profile.' })
  } else if (sampling.samplingMethod === 'AQL_PROFILE') {
    if (size !== null) problems.push({ path: 'sampling/fixedSampleSize', message: 'An AQL profile gives the sample: no fixed number.' })
  } else {
    problems.push({ path: 'sampling/samplingMethod', message: 'Sample by an AQL profile or a fixed number of units.' })
  }
  const frequency = sampling.frequency ?? null
  const value = sampling.frequencyValue ?? null
  if (frequency === null) {
    if (value !== null) problems.push({ path: 'sampling/frequencyValue', message: 'Say how often first.' })
  } else if (frequency === 'PERCENT_OF_OPERATIONS') {
    if (value === null || !Number.isInteger(value) || value < 1 || value > 100) problems.push({ path: 'sampling/frequencyValue', message: 'A share of the operations is 1 to 100 %.' })
  } else if (frequency === 'EVERY_NTH_BUNDLE') {
    if (value === null || !Number.isInteger(value) || value < 1 || value > PLAN_LIMITS.everyNth) problems.push({ path: 'sampling/frequencyValue', message: `Every Nth bundle: N is 1 to ${PLAN_LIMITS.everyNth}.` })
  } else if (value !== null) {
    problems.push({ path: 'sampling/frequencyValue', message: 'This frequency takes no number.' })
  }
  return problems
}

// ---- approval (QHS-016) -------------------------------------------------------------------------------------------------

export interface ApprovalFacts {
  readonly number: number
  readonly status: VersionStatus
  readonly authorId: string
  /** Everyone who saved a change to the draft (the author included). */
  readonly editorIds: readonly string[]
  readonly approverId: string
  readonly checks: readonly CheckDraft[]
  readonly sampling: SamplingDraft
}

/** Why the person may not approve now, as the refusal's code and words; null when they may (the content is apart). */
export function approverRefusal(facts: Pick<ApprovalFacts, 'number' | 'status' | 'authorId' | 'editorIds' | 'approverId'>): { readonly code: 'NOT_DRAFT' | 'AUTHOR' | 'EDITOR'; readonly message: string } | null {
  if (facts.status !== 'DRAFT') return { code: 'NOT_DRAFT', message: `Version ${facts.number} is ${VERSION_STATUS_WORDS[facts.status].en.toLowerCase()}: only a draft is approved.` }
  if (facts.approverId === facts.authorId) return { code: 'AUTHOR', message: `You wrote version ${facts.number}: a second person approves it (QHS-016).` }
  if (facts.editorIds.includes(facts.approverId)) return { code: 'EDITOR', message: `You changed version ${facts.number}: a person who did not write it approves it (QHS-016).` }
  return null
}

/** What stops a draft from being approved, whoever approves it: something to check, valid checks, valid sampling. */
export function contentProblems(facts: Pick<ApprovalFacts, 'number' | 'checks' | 'sampling'>): Issue[] {
  const problems = [...checksProblems(facts.checks), ...samplingProblems(facts.sampling)]
  if (!facts.checks.some((check) => (CHECK_TYPES as readonly string[]).includes(check.type) && takesResult(check.type))) {
    problems.unshift({ path: 'checks', message: `Version ${facts.number} has nothing to check: add at least one check that takes a result (an instruction takes none).` })
  }
  return problems
}

/** What the approver signs (canonical JSON): the plan, the version and its whole content, who and when. */
export interface ApprovalStatement {
  readonly planId: string
  readonly planCode: string
  readonly stage: PlanStage
  readonly versionId: string
  readonly number: number
  readonly approvedById: string
  /** UTC ISO instant. */
  readonly approvedAt: string
  readonly sampling: SamplingDraft
  readonly checks: readonly CheckContent[]
}

export const approvalText = (statement: ApprovalStatement): string => canonicalJson({ signs: 'inspection plan version approval', ...statement })
/** The SHA-256 (hex) kept on the version: the e-signature over what was approved. */
export const approvalSha256 = (statement: ApprovalStatement): string => createHash('sha256').update(approvalText(statement), 'utf8').digest('hex')

// ---- comparing two versions (ChangeReview) ------------------------------------------------------------------------------

export interface VersionContent {
  readonly number: number
  readonly sampling: SamplingDraft
  /** In list order. */
  readonly checks: readonly CheckContent[]
}

export interface FieldChange {
  readonly field: string
  readonly before: unknown
  readonly after: unknown
}

export interface Comparison {
  readonly fromNumber: number | null
  readonly toNumber: number
  readonly added: readonly { readonly code: string; readonly labelIt: string; readonly labelEn: string }[]
  readonly removed: readonly { readonly code: string; readonly labelIt: string; readonly labelEn: string }[]
  readonly changed: readonly { readonly code: string; readonly changes: readonly FieldChange[] }[]
  /** Checks on both, at another place in the list. */
  readonly moved: readonly string[]
  readonly sampling: readonly FieldChange[]
  readonly same: boolean
}

const CHECK_FIELDS = ['labelIt', 'labelEn', 'labelI18n', 'type', 'checkClass', 'mandatory', 'photoRequired', 'nominal', 'tolerance', 'uom', 'choices'] as const
const SAMPLING_FIELDS = ['samplingMethod', 'aqlProfileId', 'fixedSampleSize', 'frequency', 'frequencyValue', 'stopAtReject'] as const
const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null)

/** What changed from one version to another, check by check (by code: codes are kept across versions). */
export function compareVersions(from: VersionContent | null, to: VersionContent): Comparison {
  const before = new Map((from?.checks ?? []).map((check) => [check.code, check] as const))
  const after = new Map(to.checks.map((check) => [check.code, check] as const))
  const added = to.checks.filter((check) => !before.has(check.code)).map(({ code, labelIt, labelEn }) => ({ code, labelIt, labelEn }))
  const removed = (from?.checks ?? []).filter((check) => !after.has(check.code)).map(({ code, labelIt, labelEn }) => ({ code, labelIt, labelEn }))
  const changed: { code: string; changes: FieldChange[] }[] = []
  for (const check of to.checks) {
    const old = before.get(check.code)
    if (!old) continue
    const changes = CHECK_FIELDS.filter((field) => !same(old[field], check[field])).map((field) => ({ field, before: old[field], after: check[field] }))
    if (changes.length > 0) changed.push({ code: check.code, changes })
  }
  const kept = (list: readonly CheckContent[], other: ReadonlyMap<string, CheckContent>) => list.filter((check) => other.has(check.code)).map((check) => check.code)
  const oldOrder = kept(from?.checks ?? [], after)
  const newOrder = kept(to.checks, before)
  const moved = newOrder.filter((code, index) => oldOrder[index] !== code)
  const sampling = from ? SAMPLING_FIELDS.filter((field) => !same(from.sampling[field], to.sampling[field])).map((field) => ({ field, before: from.sampling[field] ?? null, after: to.sampling[field] ?? null })) : []
  return { fromNumber: from?.number ?? null, toNumber: to.number, added, removed, changed, moved, sampling, same: from !== null && added.length + removed.length + changed.length + moved.length + sampling.length === 0 }
}

// ---- where a plan applies ----------------------------------------------------------------------------------------------

/** What a record or a style is, by chip kind; a kind left out cannot be judged here. */
export type ChipFacts = Partial<Record<ChipKind, readonly (string | null | undefined)[]>>

/**
 * Does a plan (or a rule) apply to these facts? Chips of one kind are alternatives, kinds together all apply ("jackets
 * of customer P1"); no chip = everything. A kind the facts do not say is judged by `unknown`: 'fail' (the default: a rule
 * that names an operation never applies where no operation is known) or 'pass' (a preview that cannot know it).
 * `because`: the chips that matched, for "FIN-JACKET applies because: category Jacket, customer P1".
 */
export function chipsMatch(chips: readonly Chip[], facts: ChipFacts, unknown: 'pass' | 'fail' = 'fail'): { readonly matches: boolean; readonly because: readonly Chip[] } {
  const because: Chip[] = []
  for (const kind of CHIP_KINDS) {
    const ofKind = chips.filter((chip) => chip.kind === kind)
    if (ofKind.length === 0) continue
    const known = facts[kind]
    if (known === undefined) {
      if (unknown === 'pass') continue
      return { matches: false, because: [] }
    }
    const hit = ofKind.filter((chip) => known.includes(chip.value))
    if (hit.length === 0) return { matches: false, because: [] }
    because.push(...hit)
  }
  return { matches: true, because }
}

// ---- words of a version -------------------------------------------------------------------------------------------------

export const FREQUENCY_WORDS: Readonly<Record<Frequency, Words>> = Object.freeze({
  EVERY_LOT: w('Ogni lotto', 'Every lot'),
  PERCENT_OF_OPERATIONS: w('{value}% delle operazioni', '{value}% of operations'),
  FIRST_PIECE: w('Primo capo', 'First piece'),
  EVERY_NTH_BUNDLE: w('Un pacco ogni {value}', 'Every {value}th bundle'),
})

const fill = (template: string, value: number | null): string => template.replace('{value}', String(value ?? ''))
const lang = (language: string): 'it' | 'en' => (language === 'it' ? 'it' : 'en')

/** The sampling in words: "AQL profile AQL-STD", "The AQL profile that applies", "Fixed sample: 5 units" · frequency · stop. */
export function samplingWords(sampling: SamplingDraft, language: string, profile: { readonly code: string; readonly name: string } | null): { readonly sample: string; readonly frequency: string | null; readonly stop: string } {
  const l = lang(language)
  const sample =
    sampling.samplingMethod === 'FIXED'
      ? l === 'it' ? `Campione fisso: ${sampling.fixedSampleSize ?? '?'} pezzi` : `Fixed sample: ${sampling.fixedSampleSize ?? '?'} units`
      : profile
        ? l === 'it' ? `Profilo AQL ${profile.code} (${profile.name})` : `AQL profile ${profile.code} (${profile.name})`
        : l === 'it' ? "Il profilo AQL che si applica (modello, cliente, predefinito dell'azienda)" : 'The AQL profile that applies (style, customer, company default)'
  const frequency = sampling.frequency ? fill(FREQUENCY_WORDS[sampling.frequency][l], sampling.frequencyValue ?? null) : null
  const stop =
    sampling.stopAtReject === true ? (l === 'it' ? 'Ci si ferma al numero di rifiuto' : 'Stop at the reject number')
    : sampling.stopAtReject === false ? (l === 'it' ? 'Si finisce il campione' : 'Finish the sample')
    : l === 'it' ? "Come dice l'impostazione qualità dell'azienda" : "As the company's quality setting says"
  return { sample, frequency, stop }
}

/** A measurement's specification in words: "58.000 ± 1.000 cm", or the size chart when it names no nominal. */
export function specWords(check: Pick<CheckContent, 'type' | 'nominal' | 'tolerance' | 'uom'>, language: string): string | null {
  if (check.type !== 'MEASUREMENT') return null
  if (check.nominal === null) return lang(language) === 'it' ? 'Dalla tabella taglie del modello' : "From the style's size chart"
  return `${check.nominal} ± ${check.tolerance} ${(check.uom ?? '').toLowerCase()}`.trim()
}
