import type { Issue } from '../../core/errors'
import { ITEM_KINDS } from '../../product/materials/rules'
import { PRODUCT_TYPES } from '../../product/styles/rules'
import { MARKET_CODE, MARKET_CODE_MAX } from '../markets/rules'

/**
 * Restricted substances and their rules (B-W2b-250; PRD-318, PRD-320 … PRD-325, PRD-329), the pure part: the words and
 * checks of B-W2b-217's substances.prisma, said before the database says them (its …_substances_w2b_guards are the last
 * word, for every login). A substance is on one or more lists (REACH Annex XVII with its entries, the SVHC Candidate List,
 * POPs, an industry RSL, a brand's RSL) with its CAS and EC numbers (check digits right, given once); a rule restricts
 * one substance or a group of them, where (material kinds, product types, markets), with its limit, unit and the side a
 * value at the limit falls on, the test method, the evidence that proves it, the exemptions of entry 72, its source and
 * legal reference, and is switched on or off with the reason. No money anywhere.
 */

export const SUBSTANCE_LISTS = ['REACH_ANNEX_XVII', 'SVHC', 'POPS', 'AFIRM_RSL', 'CUSTOMER_RSL'] as const
export type SubstanceList = (typeof SUBSTANCE_LISTS)[number]
export const RULE_CODES = ['AZO', 'NICKEL', 'PAH', 'DMFU', 'NPE', 'CMR', 'PFAS', 'CR6', 'OTHER'] as const
export type RuleCode = (typeof RULE_CODES)[number]
export const RULE_SOURCES = ['LAW', 'INDUSTRY', 'CUSTOMER'] as const
export type RuleSource = (typeof RULE_SOURCES)[number]
export const SUBSTANCE_UNITS = ['MG_KG', 'UG_KG', 'PERCENT_WW', 'UG_CM2_WEEK', 'UG_M2'] as const
export type SubstanceUnit = (typeof SUBSTANCE_UNITS)[number]
export const LIMIT_BOUNDS = ['BELOW', 'AT_MOST'] as const
export type LimitBound = (typeof LIMIT_BOUNDS)[number]
export const EVIDENCE_KINDS = ['TEST', 'DECLARATION', 'EITHER'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]
export const SUBSTANCE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type SubstanceStatus = (typeof SUBSTANCE_STATUSES)[number]
/** The lab tests a rule can ask for (quality.prisma LabTest). */
export const SUBSTANCE_TESTS = ['CR_VI', 'AZO', 'NICKEL', 'PAH', 'DMFU', 'NPE', 'PFAS'] as const
export type SubstanceTest = (typeof SUBSTANCE_TESTS)[number]
/** What a supplier is asked to declare (substances.prisma SupplierDeclarationKind). */
export const DECLARATION_KINDS = ['REACH_SVHC', 'RSL', 'PFAS', 'NICKEL', 'CR6', 'OTHER'] as const
export type DeclarationKind = (typeof DECLARATION_KINDS)[number]
/** The kinds of material a rule names (every ItemKind but FINISHED). */
export const RULE_MATERIAL_KINDS = ITEM_KINDS
export type RuleMaterialKind = (typeof ITEM_KINDS)[number]
export const RULE_PRODUCT_TYPES = PRODUCT_TYPES
export type RuleProductType = (typeof PRODUCT_TYPES)[number]

export const SUBSTANCE_LIMITS = {
  name: 300,
  note: 1000,
  scopeNote: 1000,
  testMethod: 200,
  legalReference: 300,
  url: 2000,
  offReason: 500,
  /** Rows the starter list or one read answers at most. */
  list: 2000,
} as const

export const CAS_SHAPE = /^[1-9][0-9]{1,6}-[0-9]{2}-[0-9]$/
export const EC_SHAPE = /^[0-9]{3}-[0-9]{3}-[0-9]$/
export const GROUP_CODE = /^[A-Z][A-Z0-9_]{0,39}$/
export const RULE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
export const ANNEX_ENTRY = /^[1-9][0-9]{0,2}[a-z]?$/
const HTTPS = /^https:\/\/[^\s\p{Cc}]+$/u
// Control characters (a line break and a tab allowed where `lines`).
const CONTROL = /\p{Cc}/u
const CONTROL_BUT_LINES = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** A CAS Registry Number with its check digit right: the digits weighted 1, 2, 3 … from the right, the sum mod 10. */
export function casOk(cas: string): boolean {
  if (!CAS_SHAPE.test(cas)) return false
  const digits = cas.slice(0, -2).replace(/-/g, '').split('').reverse()
  const sum = digits.reduce((total, digit, index) => total + (index + 1) * Number(digit), 0)
  return sum % 10 === Number(cas.at(-1))
}

/** An EC number with its check digit right: the six digits weighted 1 to 6 from the left, the sum mod 11. */
export function ecOk(ec: string): boolean {
  if (!EC_SHAPE.test(ec)) return false
  const digits = ec.slice(0, 7).replace('-', '').split('')
  const sum = digits.reduce((total, digit, index) => total + (index + 1) * Number(digit), 0)
  return sum % 11 === Number(ec.at(-1))
}

/** Does the text look like a CAS number (its shape; the check digit is casOk's)? */
export const looksLikeCas = (text: string): boolean => CAS_SHAPE.test(text.trim())

const wordsOk = (words: string | null | undefined, longest: number, lines = false): boolean =>
  words === null || words === undefined || (words.trim() !== '' && words.length <= longest && !(lines ? CONTROL_BUT_LINES : CONTROL).test(words))
const i18nOk = (words: Readonly<Record<string, string>> | null | undefined, longest: number): boolean =>
  words === null || words === undefined || Object.entries(words).every(([tag, value]) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag) && wordsOk(value, longest))
const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length
export const httpsOk = (url: string | null | undefined): boolean => url === null || url === undefined || (url.length <= SUBSTANCE_LIMITS.url && HTTPS.test(url))
export const marketCodeOk = (code: string): boolean => code.length <= MARKET_CODE_MAX && MARKET_CODE.test(code)

// ---- substances -----------------------------------------------------------------------------------------------------

export interface SubstanceDraft {
  readonly casNumber?: string | null | undefined
  readonly ecNumber?: string | null | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly groupCode?: string | null | undefined
  readonly lists?: readonly SubstanceList[] | undefined
  readonly annexXviiEntries?: readonly string[] | undefined
  readonly svhcListVersionId?: string | null | undefined
  readonly note?: string | null | undefined
}

/**
 * What is wrong with a substance as it would be stored (every field given), in words with `body/…` paths: the check digits,
 * a name, a group code, at least one list each once, the Annex XVII entries exactly when on REACH_ANNEX_XVII, the Candidate
 * List version only on SVHC.
 */
export function substanceProblems(draft: SubstanceDraft, at = 'body'): Issue[] {
  const issues: Issue[] = []
  if (draft.casNumber !== null && draft.casNumber !== undefined && !casOk(draft.casNumber)) {
    issues.push({ path: `${at}/casNumber`, message: `${draft.casNumber} is not a CAS number with its check digit right (N…N-NN-R).` })
  }
  if (draft.ecNumber !== null && draft.ecNumber !== undefined && !ecOk(draft.ecNumber)) {
    issues.push({ path: `${at}/ecNumber`, message: `${draft.ecNumber} is not an EC number with its check digit right (NNN-NNN-R).` })
  }
  if (draft.name !== undefined && !wordsOk(draft.name, SUBSTANCE_LIMITS.name)) issues.push({ path: `${at}/name`, message: `Name the substance in 1 to ${SUBSTANCE_LIMITS.name} characters on one line.` })
  if (!i18nOk(draft.nameI18n, SUBSTANCE_LIMITS.name)) issues.push({ path: `${at}/nameI18n`, message: 'Each language tag ("it", "en") takes the name in words on one line.' })
  if (draft.groupCode !== null && draft.groupCode !== undefined && !GROUP_CODE.test(draft.groupCode)) {
    issues.push({ path: `${at}/groupCode`, message: 'A group code is capitals, digits and _ (up to 40), starting with a letter: "AZO_AMINES", "PAH_8".' })
  }
  if (!wordsOk(draft.note, SUBSTANCE_LIMITS.note, true)) issues.push({ path: `${at}/note`, message: `A note takes up to ${SUBSTANCE_LIMITS.note} characters.` })
  const lists = draft.lists ?? []
  if (draft.lists !== undefined && (lists.length === 0 || !distinct(lists))) issues.push({ path: `${at}/lists`, message: 'Put the substance on at least one list, each once.' })
  const entries = draft.annexXviiEntries ?? []
  if (!distinct(entries) || entries.some((entry) => !ANNEX_ENTRY.test(entry))) {
    issues.push({ path: `${at}/annexXviiEntries`, message: 'Name each REACH Annex XVII entry once, as the annex numbers it ("43", "46a").' })
  } else if (draft.lists !== undefined && (entries.length > 0) !== lists.includes('REACH_ANNEX_XVII')) {
    issues.push({
      path: `${at}/annexXviiEntries`,
      message: entries.length > 0 ? 'Annex XVII entries go with the list REACH_ANNEX_XVII: add the list, or leave the entries out.' : 'A substance on REACH_ANNEX_XVII names the entries that restrict it ("43", "46a").',
    })
  }
  if (draft.lists !== undefined && draft.svhcListVersionId && !lists.includes('SVHC')) {
    issues.push({ path: `${at}/svhcListVersionId`, message: 'Only a substance on the SVHC Candidate List names the list version that added it.' })
  }
  return issues
}

// ---- rules ----------------------------------------------------------------------------------------------------------

export interface RuleDraft {
  readonly key?: string | undefined
  readonly code?: RuleCode | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly substanceId?: string | null | undefined
  readonly substanceGroup?: string | null | undefined
  readonly materialKinds?: readonly string[] | undefined
  readonly productTypes?: readonly string[] | undefined
  readonly marketCodes?: readonly string[] | undefined
  readonly scopeNote?: string | null | undefined
  readonly limitValue?: string | null | undefined
  readonly limitUnit?: SubstanceUnit | null | undefined
  readonly limitBound?: LimitBound | null | undefined
  readonly testMethod?: string | null | undefined
  readonly evidence?: EvidenceKind | undefined
  readonly source?: RuleSource | undefined
  readonly customerPartyId?: string | null | undefined
  readonly legalReference?: string | undefined
  readonly legalUrl?: string | null | undefined
  readonly note?: string | null | undefined
}

const positiveDecimal = (value: string): boolean => /^\d{1,12}(\.\d{1,6})?$/.test(value) && Number(value) > 0

/**
 * What is wrong with a rule as it would be stored (every field given), in words with `body/…` paths: the key's shape; one
 * substance or one group; kinds (never FINISHED), product types and markets each once; a limit above 0 with its unit and
 * bound, or none of the three; a CUSTOMER rule with its brand; the legal reference and an https link.
 */
export function ruleProblems(draft: RuleDraft, at = 'body'): Issue[] {
  const issues: Issue[] = []
  if (draft.key !== undefined && !RULE_KEY.test(draft.key)) issues.push({ path: `${at}/key`, message: 'A rule key is a letter or digit, then letters, digits, ".", "_" or "-", up to 80: "REACH-XVII-43", "BRAND-RSL-2026-14".' })
  if (draft.name !== undefined && !wordsOk(draft.name, SUBSTANCE_LIMITS.name)) issues.push({ path: `${at}/name`, message: `Say what the rule restricts in 1 to ${SUBSTANCE_LIMITS.name} characters on one line.` })
  if (!i18nOk(draft.nameI18n, SUBSTANCE_LIMITS.name)) issues.push({ path: `${at}/nameI18n`, message: 'Each language tag ("it", "en") takes the words on one line.' })
  const one = draft.substanceId ? 1 : 0
  const group = draft.substanceGroup ? 1 : 0
  if (draft.substanceId !== undefined || draft.substanceGroup !== undefined) {
    if (one + group !== 1) issues.push({ path: `${at}/substanceId`, message: 'A rule restricts one substance of the list or one group of it: name exactly one.' })
    else if (draft.substanceGroup && !GROUP_CODE.test(draft.substanceGroup)) issues.push({ path: `${at}/substanceGroup`, message: 'A group code is capitals, digits and _ (up to 40): "AZO_AMINES", "PAH_8".' })
  }
  const kinds = draft.materialKinds ?? []
  if (!distinct(kinds) || kinds.some((kind) => !(RULE_MATERIAL_KINDS as readonly string[]).includes(kind))) {
    issues.push({ path: `${at}/materialKinds`, message: 'Name each kind of material once (never a finished garment); none: every kind.' })
  }
  const types = draft.productTypes ?? []
  if (!distinct(types) || types.some((type) => !(RULE_PRODUCT_TYPES as readonly string[]).includes(type))) {
    issues.push({ path: `${at}/productTypes`, message: 'Name each product type once; none: every product type.' })
  }
  const markets = draft.marketCodes ?? []
  if (!distinct(markets) || markets.some((code) => !marketCodeOk(code))) issues.push({ path: `${at}/marketCodes`, message: 'Name each market once by its code ("IT", "FR", "US-CA"); none: every market.' })
  if (!wordsOk(draft.scopeNote, SUBSTANCE_LIMITS.scopeNote, true)) issues.push({ path: `${at}/scopeNote`, message: `The law's words on where it applies take up to ${SUBSTANCE_LIMITS.scopeNote} characters.` })
  const limitParts = [draft.limitValue, draft.limitUnit, draft.limitBound].filter((part) => part !== null && part !== undefined).length
  if (draft.limitValue !== undefined || draft.limitUnit !== undefined || draft.limitBound !== undefined) {
    if (limitParts !== 0 && limitParts !== 3) issues.push({ path: `${at}/limitValue`, message: 'A limit goes with its unit and the side a value at it falls on (BELOW or AT_MOST); a ban has none of the three.' })
    else if (draft.limitValue && !positiveDecimal(draft.limitValue)) issues.push({ path: `${at}/limitValue`, message: 'A limit is a number above 0 with up to 6 decimals.' })
  }
  if (!wordsOk(draft.testMethod, SUBSTANCE_LIMITS.testMethod)) issues.push({ path: `${at}/testMethod`, message: `Name the test method in up to ${SUBSTANCE_LIMITS.testMethod} characters ("EN ISO 17234-1").` })
  if (draft.source !== undefined || draft.customerPartyId !== undefined) {
    if ((draft.source === 'CUSTOMER') !== Boolean(draft.customerPartyId)) {
      issues.push({ path: `${at}/customerPartyId`, message: draft.source === 'CUSTOMER' ? "A brand's rule names the brand whose RSL it is." : "Only a brand's rule (source CUSTOMER) names a brand." })
    }
  }
  if (draft.legalReference !== undefined && !wordsOk(draft.legalReference, SUBSTANCE_LIMITS.legalReference)) {
    issues.push({ path: `${at}/legalReference`, message: `Name the law or list the rule carries out in 1 to ${SUBSTANCE_LIMITS.legalReference} characters ("REACH Annex XVII entry 43").` })
  }
  if (!httpsOk(draft.legalUrl)) issues.push({ path: `${at}/legalUrl`, message: 'A link to the law is an https address (up to 2000 characters).' })
  if (!wordsOk(draft.note, SUBSTANCE_LIMITS.note, true)) issues.push({ path: `${at}/note`, message: `A note takes up to ${SUBSTANCE_LIMITS.note} characters.` })
  return issues
}

/** Why a rule cannot be switched as asked (null: it can). OFF needs the reason; never to the state it is in. */
export function switchRefusal(rule: { readonly key: string; readonly switchedOn: boolean; readonly status: SubstanceStatus }, on: boolean, reason: string | null | undefined): string | null {
  if (rule.status !== 'ACTIVE') return `Rule ${rule.key} is archived: restore it before switching it.`
  if (rule.switchedOn === on) return `Rule ${rule.key} is already ${on ? 'on' : 'off'}.`
  const words = (reason ?? '').trim()
  if (!on && (words.length < 3 || !wordsOk(words, SUBSTANCE_LIMITS.offReason, true))) return `Say why rule ${rule.key} is switched off, in 3 to ${SUBSTANCE_LIMITS.offReason} characters (the question it waits for).`
  return null
}

// ---- words ----------------------------------------------------------------------------------------------------------

export const UNIT_WORDS: Readonly<Record<SubstanceUnit, string>> = Object.freeze({
  MG_KG: 'mg/kg',
  UG_KG: 'µg/kg',
  PERCENT_WW: '% w/w',
  UG_CM2_WEEK: 'µg/cm²/week',
  UG_M2: 'µg/m²',
})

/** "at most 30 mg/kg", "below 3 mg/kg", or "not allowed (no limit value)" for a ban. */
export function limitWords(limitValue: string | null, unit: SubstanceUnit | null, bound: LimitBound | null): string {
  if (limitValue === null || unit === null || bound === null) return 'not allowed (no limit value: the evidence answers yes or no)'
  return `${bound === 'BELOW' ? 'below' : 'at most'} ${limitValue} ${UNIT_WORDS[unit]}`
}

/** Where a rule comes from, as the substance list's Source column says it. */
export function sourceWords(rule: { readonly source: RuleSource; readonly legalReference: string }): string {
  if (rule.source === 'CUSTOMER') return `Brand RSL: ${rule.legalReference}`
  return rule.legalReference
}

/** The lab test that proves a rule (null: none of its own: CMR and our own rules are proved by a declaration or a supplier's report). */
export const TEST_OF_RULE: Readonly<Record<RuleCode, SubstanceTest | null>> = Object.freeze({
  AZO: 'AZO',
  NICKEL: 'NICKEL',
  PAH: 'PAH',
  DMFU: 'DMFU',
  NPE: 'NPE',
  CMR: null,
  PFAS: 'PFAS',
  CR6: 'CR_VI',
  OTHER: null,
})

/** The declaration a supplier is asked for to prove a rule: its own kind for nickel, Cr VI and PFAS, an RSL declaration otherwise. */
export const DECLARATION_OF_RULE: Readonly<Record<RuleCode, DeclarationKind>> = Object.freeze({
  AZO: 'RSL',
  NICKEL: 'NICKEL',
  PAH: 'RSL',
  DMFU: 'RSL',
  NPE: 'RSL',
  CMR: 'RSL',
  PFAS: 'PFAS',
  CR6: 'CR6',
  OTHER: 'RSL',
})

/** Splits a cell or a field of several values ("TEXTILE, LINING"; "43; 46a") into its values, trimmed, blanks dropped. */
export const splitValues = (text: string): string[] =>
  text
    .split(/[,;|\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')

/** Sorted and once each (the list orders values the way the enum declares them, when given). */
export function ordered<T extends string>(values: readonly T[], order?: readonly T[]): T[] {
  const once = [...new Set(values)]
  return order ? order.filter((value) => once.includes(value)) : once.sort()
}
