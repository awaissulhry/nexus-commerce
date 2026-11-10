import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { PPE_CATEGORIES, type PpeCategory } from '../cert-gate/gate'
import { MARKET_CODE, MARKET_CODE_MAX, REASON_MAX, REASON_MIN } from '../markets/rules'
import { OPERATOR_ROLES, type OperatorRole } from '../operators/rules'

/**
 * Requirements as data (B-W2b-254; PRD-271; design compliance.settings › rm-gates, compliance.status › cs-cell), pure.
 * The table is B-W2b-216's ComplianceRequirement: what must exist for a product type, PPE category and market, with its
 * legal reference, the check that computes it (`checkKey`, or the kind's own check), which of the four gates it blocks
 * (work-order release, label print, final release, shipment), the gates the law locks (never switched off, never
 * overridden there), who may override it elsewhere and for how many days, and its switch (ON, or OFF with the reason:
 * the Owner questions Q10, Q22, Q23, Q37 hold some OFF).
 *
 * The check is code, the requirement is data: `checkOf` names the computing check of a row. A check this code does not
 * compute (a test plan or a declaration the plan's later steps compute) is MANUAL: shown on the checklist as checked by a
 * person, never a refusal at a gate.
 *
 * W1's two fixed gates (QHS-051 at the label and the final release, MES-004 at the work-order release) are ONE
 * requirement, `W1_CERTIFICATE_REQUIREMENT` (the seed's CERT-COVERAGE): a tenant without a certificate-coverage row has
 * it built in until the gate first needs the row (then it is written, exactly this).
 */

export const REQUIREMENT_KINDS = ['CERTIFICATE', 'DOC_LANGUAGE', 'USER_INFO_LANGUAGE', 'LABEL', 'TEST', 'OPERATOR_ROLE', 'DECLARATION', 'CLAIM_EVIDENCE'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]
export const COMPLIANCE_GATES = ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'] as const
export type ComplianceGate = (typeof COMPLIANCE_GATES)[number]
export const PRODUCT_TYPES = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'] as const
export type ProductType = (typeof PRODUCT_TYPES)[number]
export const REQUIREMENT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number]

export const CODE = /^[^\s\p{Cc}]{1,60}$/u
export const CHECK_KEY = /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/
export const NAME_MAX = 300
export const LEGAL_MAX = 300
export const NOTE_MAX = 2000
export const ROLE_KEY = /^[a-z][a-z0-9_]{1,59}$/
export const ROLES_MAX = 20
export const OVERRIDE_DAYS_MAX = 7
export { REASON_MIN, REASON_MAX }

/** Words for the gates (API sentences are English; screens say their own words per code). */
export const GATE_WORDS: Readonly<Record<ComplianceGate, { readonly place: string; readonly verb: string; readonly it: string }>> = {
  WORK_ORDER_RELEASE: { place: 'work-order release', verb: 'be released', it: 'rilascio dell\'ordine di lavoro' },
  LABEL_PRINT: { place: 'label print', verb: 'have its labels printed', it: 'stampa etichette' },
  FINAL_RELEASE: { place: 'final release', verb: 'be released by quality', it: 'rilascio finale' },
  SHIPMENT: { place: 'shipment', verb: 'leave', it: 'spedizione' },
}

/** What a check needs: the kinds it serves, whether it reads a market's languages, who clears it and where. */
export interface CheckSpec {
  readonly kinds: readonly RequirementKind[]
  readonly market: boolean
  readonly who: Who
  readonly fix: FixPlace
}

/** The checks this code computes, with what each needs: the kinds it serves and whether it reads a market's languages. */
export const CHECKS = {
  'certificate.coverage': { kinds: ['CERTIFICATE'], market: false, who: 'COMPLIANCE', fix: 'certificates' },
  'certificate.gloveLevels': { kinds: ['CERTIFICATE'], market: false, who: 'COMPLIANCE', fix: 'certificates' },
  'doc.languages': { kinds: ['DOC_LANGUAGE'], market: true, who: 'COMPLIANCE', fix: 'declarations' },
  'userInfo.languages': { kinds: ['USER_INFO_LANGUAGE'], market: true, who: 'COMPLIANCE', fix: 'declarations' },
  'label.languages': { kinds: ['LABEL'], market: true, who: 'COMPLIANCE', fix: 'labels' },
  'operator.role': { kinds: ['OPERATOR_ROLE'], market: false, who: 'COMPLIANCE', fix: 'operators' },
  'gpsr.contact': { kinds: ['DECLARATION', 'LABEL'], market: false, who: 'COMPLIANCE', fix: 'labels' },
} as const satisfies Record<string, CheckSpec>
export type BuiltInCheck = keyof typeof CHECKS
export const CHECK_KEYS = Object.keys(CHECKS) as BuiltInCheck[]
/** A check's key: a built-in one, or one a later step plugs in by name ("label.ceMarking", B-W2b-253). */
export type CheckKey = string

// Checks a later step plugs in by name (apps/factory-api compliance/gates/plugs.ts `plugGateCheck`): a plugged key wins
// over a built-in one of the same name.
const PLUGGED = new Map<string, CheckSpec>()

/** Declares a plugged check's needs (the API's `plugGateCheck` calls it with the check's computation). */
export function plugCheckSpec(key: string, spec: CheckSpec): void {
  if (!CHECK_KEY.test(key)) throw new Error(`A check key is "area.check": ${key}`)
  PLUGGED.set(key, spec)
}

/** The spec of a check key (plugged first, then built-in); null: no check computes it here. */
export function checkSpecOf(key: string): CheckSpec | null {
  return PLUGGED.get(key) ?? (Object.hasOwn(CHECKS, key) ? CHECKS[key as BuiltInCheck] : null)
}

/** Who can clear a missing requirement (the design's "Compliance lead · Add German", "Quality · Record test result"). */
export const WHO = ['COMPLIANCE', 'QUALITY', 'PRODUCTION', 'SALES'] as const
export type Who = (typeof WHO)[number]
/** Where the fix is (a page of the office; screens link it). */
export const FIX_PLACES = ['certificates', 'declarations', 'labels', 'operators', 'tests', 'markets', 'requirements'] as const
export type FixPlace = (typeof FIX_PLACES)[number]

/** The kind's own check when a row names none (the seed's DOC-LANGUAGE, USER-INFO-LANGUAGE and EU-OPERATOR name none). */
const KIND_CHECK: Readonly<Record<RequirementKind, BuiltInCheck | null>> = {
  CERTIFICATE: 'certificate.coverage',
  DOC_LANGUAGE: 'doc.languages',
  USER_INFO_LANGUAGE: 'userInfo.languages',
  LABEL: 'label.languages',
  OPERATOR_ROLE: 'operator.role',
  TEST: null,
  DECLARATION: null,
  CLAIM_EVIDENCE: null,
}

export const isCheckKey = (value: string | null | undefined): value is CheckKey => typeof value === 'string' && checkSpecOf(value) !== null

/**
 * The check that computes a requirement: its own key when this code computes it for the row's kind, else the kind's
 * check; 'MANUAL' when none (a test plan, a declaration, a claim, a textile rule of B-W2b-208: a person checks it).
 */
export function checkOf(requirement: { readonly kind: RequirementKind; readonly checkKey: string | null }): CheckKey | 'MANUAL' {
  if (requirement.checkKey !== null) {
    const spec = checkSpecOf(requirement.checkKey)
    return spec && spec.kinds.includes(requirement.kind) ? requirement.checkKey : 'MANUAL'
  }
  return KIND_CHECK[requirement.kind] ?? 'MANUAL'
}

/** Who clears it and where, for a requirement (the check's, else the kind's). */
export function ownerOf(requirement: { readonly kind: RequirementKind; readonly checkKey: string | null }): { readonly who: Who; readonly fix: FixPlace } {
  const spec = checkSpecOf(checkOf(requirement))
  if (spec) return { who: spec.who, fix: spec.fix }
  if (requirement.kind === 'TEST') return { who: 'QUALITY', fix: 'tests' }
  return { who: 'COMPLIANCE', fix: 'requirements' }
}

/** Whether the check reads the market's languages (a language rule means nothing without the market it is for). */
export const needsMarket = (check: CheckKey | 'MANUAL'): boolean => check !== 'MANUAL' && (checkSpecOf(check)?.market ?? false)

// ---- the rows ---------------------------------------------------------------------------------------------------------

export interface RequirementRow {
  readonly id: string | null
  readonly companyId: string | null
  readonly code: string
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>>
  readonly kind: RequirementKind
  readonly checkKey: string | null
  readonly operatorRole: OperatorRole | null
  readonly productTypes: readonly ProductType[]
  readonly productTypeProfileId: string | null
  readonly ppeCategories: readonly PpeCategory[]
  readonly marketCode: string | null
  readonly blocks: readonly ComplianceGate[]
  readonly lockedBlocks: readonly ComplianceGate[]
  readonly overrideRoleKeys: readonly string[]
  readonly overrideMaxDays: number
  readonly legalReference: string
  readonly explanationI18n: Readonly<Record<string, string>>
  readonly appliesFrom: BusinessDate | null
  readonly appliesUntil: BusinessDate | null
  readonly seq: number
  readonly switchedOn: boolean
  readonly status: RequirementStatus
}

/**
 * W1's two gates as one requirement (the seed's CERT-COVERAGE, B-W2b-216): a category II or III style is labelled,
 * released by quality and shipped only under a valid certificate that covers its colourway and size (locked there by
 * the law); the work-order release is the company's choice (blocked by default, as in W1). No role overrides it.
 */
export const W1_CERTIFICATE_REQUIREMENT: Omit<RequirementRow, 'id'> = Object.freeze({
  companyId: null,
  code: 'CERT-COVERAGE',
  name: 'A valid certificate covers the style, colourway and size',
  nameI18n: { it: 'Un certificato valido copre modello, colore e taglia', en: 'A valid certificate covers the style, colourway and size' },
  kind: 'CERTIFICATE',
  checkKey: 'certificate.coverage',
  operatorRole: null,
  productTypes: [],
  productTypeProfileId: null,
  ppeCategories: ['CATEGORY_II', 'CATEGORY_III'],
  marketCode: null,
  blocks: ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'],
  lockedBlocks: ['LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'],
  overrideRoleKeys: [],
  overrideMaxDays: 7,
  legalReference: 'Reg. (EU) 2016/425 art. 8(2), Annex V',
  explanationI18n: {
    it: 'Un DPI di categoria II o III si etichetta e si immette sul mercato solo con un certificato UE del tipo valido.',
    en: 'A category II or III PPE is labelled and placed on the market only under a valid EU type-examination certificate.',
  },
  appliesFrom: null,
  appliesUntil: null,
  seq: 10,
  switchedOn: true,
  status: 'ACTIVE',
}) as Omit<RequirementRow, 'id'>

/** A row computes certificate coverage: W1's certificate gate (the tenant's own row, or the built-in one). */
export const isCertificateCoverage = (requirement: Pick<RequirementRow, 'kind' | 'checkKey'>): boolean => checkOf(requirement) === 'certificate.coverage'

// ---- does it apply ----------------------------------------------------------------------------------------------------

/** The style a requirement is asked about. */
export interface RequirementSubject {
  readonly companyId: string | null
  readonly productType: ProductType
  /** The style's product type profile and its ancestors (ProductTypeProfile.parentId), nearest first. */
  readonly profileIds: readonly string[]
  readonly ppeCategory: PpeCategory
}

/** Why a requirement does not apply (null: it applies). Words for the checklist's "Not needed". */
export function notApplying(requirement: RequirementRow, subject: RequirementSubject, marketCode: string | null, day: BusinessDate): string | null {
  if (requirement.status !== 'ACTIVE') return 'Archived.'
  if (!requirement.switchedOn) return 'Switched off.'
  if (requirement.appliesFrom !== null && day < requirement.appliesFrom) return `Applies from ${requirement.appliesFrom}.`
  if (requirement.appliesUntil !== null && day > requirement.appliesUntil) return `Applied until ${requirement.appliesUntil}.`
  if (requirement.companyId !== null && requirement.companyId !== subject.companyId) return 'For another company.'
  if (requirement.productTypes.length > 0 && !requirement.productTypes.includes(subject.productType)) return `Only for ${requirement.productTypes.join(', ').toLowerCase()}.`
  if (requirement.productTypeProfileId !== null && !subject.profileIds.includes(requirement.productTypeProfileId)) return 'For another product type.'
  if (requirement.ppeCategories.length > 0 && !requirement.ppeCategories.includes(subject.ppeCategory)) return `Only for ${requirement.ppeCategories.map(categoryWords).join(', ')}.`
  if (requirement.marketCode !== null && requirement.marketCode !== marketCode) return `Only for market ${requirement.marketCode}.`
  return null
}

export function categoryWords(category: PpeCategory): string {
  return { NOT_PPE: 'not PPE', CATEGORY_I: 'PPE category I', CATEGORY_II: 'PPE category II', CATEGORY_III: 'PPE category III' }[category]
}

/** The order the gate refuses in: seq, then code. */
export function byGateOrder<T extends Pick<RequirementRow, 'seq' | 'code'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.code.localeCompare(b.code)))
}

// ---- writing a requirement --------------------------------------------------------------------------------------------

export interface RequirementInput {
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly kind?: RequirementKind | undefined
  readonly checkKey?: string | null | undefined
  readonly operatorRole?: OperatorRole | null | undefined
  readonly productTypes?: readonly string[] | undefined
  readonly ppeCategories?: readonly string[] | undefined
  readonly marketCode?: string | null | undefined
  readonly blocks?: readonly string[] | undefined
  readonly lockedBlocks?: readonly string[] | undefined
  readonly overrideRoleKeys?: readonly string[] | undefined
  readonly overrideMaxDays?: number | undefined
  readonly legalReference?: string | undefined
  readonly explanationI18n?: Readonly<Record<string, string>> | null | undefined
  readonly appliesFrom?: string | null | undefined
  readonly appliesUntil?: string | null | undefined
  readonly seq?: number | undefined
  readonly note?: string | null | undefined
}

const twice = <T>(list: readonly T[]): T[] => list.filter((value, index) => list.indexOf(value) !== index)
const WORDS_LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/

function wordsProblems(path: string, words: Readonly<Record<string, string>> | null | undefined, max: number): Issue[] {
  if (!words) return []
  const problems: Issue[] = []
  for (const [language, text] of Object.entries(words)) {
    if (!WORDS_LANGUAGE.test(language)) problems.push({ path: `${path}/${language}`, message: `"${language}" is not a language code.` })
    else if (text.trim().length === 0 || text.length > max) problems.push({ path: `${path}/${language}`, message: `Words of 1 to ${max} characters.` })
  }
  return problems
}

/**
 * What is wrong with a requirement (the database's ComplianceRequirement_check in words, before the database is asked):
 * fields left out are not checked (an edit sends what changes; `full` merges it with the stored row first).
 */
export function requirementProblems(input: RequirementInput): Issue[] {
  const problems: Issue[] = []
  const add = (path: string, message: string) => problems.push({ path: `body/${path}`, message })
  if (input.code !== undefined && !CODE.test(input.code)) add('code', 'A code of 1 to 60 characters, no spaces.')
  if (input.name !== undefined && (input.name.trim().length === 0 || input.name.length > NAME_MAX)) add('name', `A name of 1 to ${NAME_MAX} characters.`)
  problems.push(...wordsProblems('body/nameI18n', input.nameI18n, NAME_MAX))
  problems.push(...wordsProblems('body/explanationI18n', input.explanationI18n, 2000))
  if (input.checkKey !== undefined && input.checkKey !== null) {
    if (!CHECK_KEY.test(input.checkKey)) add('checkKey', 'A check key is "area.check" ("certificate.coverage").')
    else if (input.kind !== undefined && checkSpecOf(input.checkKey) && !(checkSpecOf(input.checkKey)!.kinds as readonly string[]).includes(input.kind)) {
      add('checkKey', `The check ${input.checkKey} computes ${checkSpecOf(input.checkKey)!.kinds.join(' or ').toLowerCase().replace(/_/g, ' ')} requirements, not ${input.kind.toLowerCase().replace(/_/g, ' ')}.`)
    }
  }
  if (input.kind !== undefined) {
    const role = input.operatorRole ?? null
    if (input.kind === 'OPERATOR_ROLE' && role === null) add('operatorRole', 'An operator requirement names the role (manufacturer, importer …).')
    if (input.kind !== 'OPERATOR_ROLE' && role !== null) add('operatorRole', 'Only an operator requirement names a role.')
  }
  if (input.operatorRole !== undefined && input.operatorRole !== null && !OPERATOR_ROLES.includes(input.operatorRole)) add('operatorRole', 'Not an operator role.')
  const lists: [string, readonly string[] | undefined, readonly string[]][] = [
    ['productTypes', input.productTypes, PRODUCT_TYPES],
    ['ppeCategories', input.ppeCategories, PPE_CATEGORIES],
    ['blocks', input.blocks, COMPLIANCE_GATES],
    ['lockedBlocks', input.lockedBlocks, COMPLIANCE_GATES],
  ]
  for (const [path, list, allowed] of lists) {
    if (list === undefined) continue
    list.forEach((value, index) => {
      if (!allowed.includes(value)) add(`${path}/${index}`, `"${value}" is not one of ${allowed.join(', ')}.`)
    })
    if (twice(list).length > 0) add(path, `Name each once (${[...new Set(twice(list))].join(', ')}).`)
  }
  if (input.blocks !== undefined && input.lockedBlocks !== undefined) {
    const loose = input.lockedBlocks.filter((gate) => !input.blocks!.includes(gate))
    if (loose.length > 0) add('lockedBlocks', `A gate is locked only where the requirement blocks it (${loose.join(', ')}).`)
  }
  if (input.overrideRoleKeys !== undefined) {
    if (input.overrideRoleKeys.length > ROLES_MAX) add('overrideRoleKeys', `At most ${ROLES_MAX} roles.`)
    input.overrideRoleKeys.forEach((key, index) => {
      if (!ROLE_KEY.test(key)) add(`overrideRoleKeys/${index}`, `"${key}" is not a role key ("quality_inspector").`)
    })
    if (twice(input.overrideRoleKeys).length > 0) add('overrideRoleKeys', 'Name each role once.')
  }
  if (input.overrideMaxDays !== undefined && (!Number.isInteger(input.overrideMaxDays) || input.overrideMaxDays < 1 || input.overrideMaxDays > OVERRIDE_DAYS_MAX)) {
    add('overrideMaxDays', `An override lasts 1 to ${OVERRIDE_DAYS_MAX} days at most.`)
  }
  if (input.legalReference !== undefined && (input.legalReference.trim().length === 0 || input.legalReference.length > LEGAL_MAX)) add('legalReference', `The legal reference (1 to ${LEGAL_MAX} characters) is required: every rule says its law.`)
  if (input.marketCode !== undefined && input.marketCode !== null && (!MARKET_CODE.test(input.marketCode) || input.marketCode.length > MARKET_CODE_MAX)) add('marketCode', 'A market code ("IT", "UK", "US-CA").')
  for (const [path, value] of [['appliesFrom', input.appliesFrom], ['appliesUntil', input.appliesUntil]] as const) {
    if (value !== undefined && value !== null && !isBusinessDate(value)) add(path, 'A calendar day (YYYY-MM-DD).')
  }
  if (input.appliesFrom && input.appliesUntil && isBusinessDate(input.appliesFrom) && isBusinessDate(input.appliesUntil) && input.appliesUntil < input.appliesFrom) add('appliesUntil', 'The last day comes after the first.')
  if (input.seq !== undefined && (!Number.isInteger(input.seq) || input.seq < 0)) add('seq', 'A whole number from 0.')
  if (input.note !== undefined && input.note !== null && input.note.length > NOTE_MAX) add('note', `At most ${NOTE_MAX} characters.`)
  return problems
}

// ---- tightening, loosening and the law's locks --------------------------------------------------------------------------

export type Editable = Pick<
  RequirementRow,
  'kind' | 'checkKey' | 'operatorRole' | 'productTypes' | 'productTypeProfileId' | 'ppeCategories' | 'marketCode' | 'blocks' | 'lockedBlocks' | 'overrideRoleKeys' | 'overrideMaxDays' | 'appliesFrom' | 'appliesUntil' | 'switchedOn' | 'status'
>

export const LOOSENINGS = ['BLOCK_REMOVED', 'OVERRIDE_ROLE_ADDED', 'OVERRIDE_LONGER', 'SWITCHED_OFF', 'ARCHIVED', 'SCOPE_NARROWED', 'DATES_SHORTER', 'CHECK_CHANGED'] as const
export type Loosening = (typeof LOOSENINGS)[number]

export interface LooseningEntry {
  readonly code: Loosening
  readonly message: string
}

const added = <T>(before: readonly T[], after: readonly T[]): T[] => after.filter((value) => !before.includes(value))
const removed = <T>(before: readonly T[], after: readonly T[]): T[] => before.filter((value) => !after.includes(value))

/**
 * What a change makes looser (design rm-gates "EditModeBar + StepUpModal to loosen", rm-loosen "Confirm a looser rule"):
 * a gate no longer blocked, a role that may now override, longer overrides, switched off or archived, fewer styles or
 * markets in scope (a list that names more kinds narrows it), a shorter period, another check. Each needs the person's
 * step-up; tightening needs none.
 */
export function looseningOf(before: Editable, after: Editable): LooseningEntry[] {
  const out: LooseningEntry[] = []
  for (const gate of removed(before.blocks, after.blocks)) out.push({ code: 'BLOCK_REMOVED', message: `It no longer blocks the ${GATE_WORDS[gate].place}.` })
  for (const role of added(before.overrideRoleKeys, after.overrideRoleKeys)) out.push({ code: 'OVERRIDE_ROLE_ADDED', message: `The role ${role} may now override it.` })
  if (after.overrideMaxDays > before.overrideMaxDays) out.push({ code: 'OVERRIDE_LONGER', message: `An override may last ${after.overrideMaxDays} days (was ${before.overrideMaxDays}).` })
  if (before.switchedOn && !after.switchedOn) out.push({ code: 'SWITCHED_OFF', message: 'It is switched off: no gate checks it.' })
  if (before.status === 'ACTIVE' && after.status === 'ARCHIVED') out.push({ code: 'ARCHIVED', message: 'It is archived: no gate checks it.' })
  const narrows = (was: readonly string[], now: readonly string[]) => (was.length === 0 && now.length > 0) || removed(was, now).length > 0
  if (
    narrows(before.productTypes, after.productTypes) ||
    narrows(before.ppeCategories, after.ppeCategories) ||
    (before.productTypeProfileId === null && after.productTypeProfileId !== null) ||
    (before.productTypeProfileId !== null && after.productTypeProfileId !== null && before.productTypeProfileId !== after.productTypeProfileId) ||
    (before.marketCode === null && after.marketCode !== null) ||
    (before.marketCode !== null && after.marketCode !== null && before.marketCode !== after.marketCode)
  ) {
    out.push({ code: 'SCOPE_NARROWED', message: 'It covers fewer styles or markets.' })
  }
  const later = (was: string | null, now: string | null) => (was === null && now !== null) || (was !== null && now !== null && now > was)
  const earlier = (was: string | null, now: string | null) => (was === null && now !== null) || (was !== null && now !== null && now < was)
  if (later(before.appliesFrom, after.appliesFrom) || earlier(before.appliesUntil, after.appliesUntil)) out.push({ code: 'DATES_SHORTER', message: 'It applies for a shorter time.' })
  if (before.kind !== after.kind || before.checkKey !== after.checkKey || before.operatorRole !== after.operatorRole) out.push({ code: 'CHECK_CHANGED', message: 'It is checked another way.' })
  return out
}

/**
 * The law's padlocks (design rm-gates "Locked cells (law) show a padlock and the reason"; the database's own rule, said
 * first in words): a locked gate never unlocks or stops being blocked; a requirement with a locked gate stays ON and
 * ACTIVE and keeps its kind, check, operator role, scope and dates. Empty: allowed.
 */
export function lockedProblems(before: Editable, after: Editable): Issue[] {
  const problems: Issue[] = []
  const add = (path: string, message: string) => problems.push({ path: `body/${path}`, message })
  const unlocked = removed(before.lockedBlocks, after.lockedBlocks)
  if (unlocked.length > 0) add('lockedBlocks', `The law locks it at the ${unlocked.map((gate) => GATE_WORDS[gate].place).join(' and ')}: that lock never opens.`)
  const unblocked = removed(before.blocks, after.blocks).filter((gate) => before.lockedBlocks.includes(gate))
  if (unblocked.length > 0) add('blocks', `The law locks it at the ${unblocked.map((gate) => GATE_WORDS[gate].place).join(' and ')}: it keeps blocking there.`)
  if (before.lockedBlocks.length === 0) return problems
  if (!after.switchedOn) add('switchedOn', 'A requirement the law locks at a gate is never switched off.')
  if (after.status !== 'ACTIVE') add('status', 'A requirement the law locks at a gate is never archived.')
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value) => b.includes(value))
  if (before.kind !== after.kind || before.checkKey !== after.checkKey || before.operatorRole !== after.operatorRole) add('kind', 'A requirement the law locks at a gate keeps its kind and check.')
  if (!same(before.productTypes, after.productTypes) || !same(before.ppeCategories, after.ppeCategories) || before.productTypeProfileId !== after.productTypeProfileId || before.marketCode !== after.marketCode) {
    add('scope', 'A requirement the law locks at a gate keeps what it covers (types, categories, market).')
  }
  if (before.appliesFrom !== after.appliesFrom || before.appliesUntil !== after.appliesUntil) add('appliesFrom', 'A requirement the law locks at a gate keeps its dates.')
  return problems
}

/** A switch's refusal: OFF needs a reason in words; never to the state it is in; a locked requirement stays ON. */
export function switchRefusal(input: { readonly code: string; readonly on: boolean; readonly switchedOn: boolean; readonly locked: boolean; readonly reason?: string | undefined }): { readonly code: 'REASON_NEEDED' | 'ALREADY' | 'LOCKED'; readonly message: string } | null {
  if (input.on === input.switchedOn) return { code: 'ALREADY', message: `Requirement ${input.code} is already ${input.on ? 'on' : 'off'}.` }
  if (!input.on && input.locked) return { code: 'LOCKED', message: `The law locks requirement ${input.code} at a gate: it is never switched off.` }
  const reason = input.reason?.trim() ?? ''
  if (!input.on && (reason.length < REASON_MIN || reason.length > REASON_MAX)) return { code: 'REASON_NEEDED', message: `Say why requirement ${input.code} is off (${REASON_MIN} to ${REASON_MAX} characters): the question it waits for.` }
  return null
}
