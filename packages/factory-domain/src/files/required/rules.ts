import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { dayOf, validOn } from '../expiry/rules'

/**
 * Required documents (COL-048; B-W2b-177 on the B-W2b-153 schema), pure. A company says which documents a record type must
 * have before a status move ("a supplier certificate before a purchase order is CONFIRMED"), for every record or only for
 * records whose party has a role (a SUPPLIER), and whether a missing one BLOCKS the move or only WARNS. A module asks
 * `requiredDocumentsProblems(recordType, id, toStatus)` (apps/factory-api platform/files/required/check.ts) inside its own
 * status command; the record's Files panel shows the same answer before anyone tries (design: "a required document blocks
 * a status move with a link, instead of an error after saving").
 *
 *   applies     the company's ACTIVE rules for (record type, beforeStatus = the status moved to) whose party role is null
 *               or one of the record's party's roles
 *   satisfied   by a CURRENT version (AVAILABLE, not superseded) of that category, valid on the day (no expiry date, or
 *               one not passed), on the record itself or on its party (a supplier's certificate is kept once, on the
 *               supplier, and counts for its purchase orders)
 *   states      MET, MISSING (no current file of that kind), EXPIRED (the only ones on file have passed their date)
 *
 * The registry below is the record types and statuses a rule may name (the database checks only the text's shape).
 */

/** The record types a rule may name, the statuses it may name for each, and whether the record has a party. */
export const REQUIRED_RECORD_TYPES = Object.freeze({
  PurchaseOrder: { statuses: ['SENT', 'CONFIRMED', 'RECEIVED', 'CLOSED'], party: true },
  GoodsReceipt: { statuses: ['POSTED'], party: true },
  ShipNotice: { statuses: ['SENT', 'RECEIVED'], party: true },
  SubcontractOrder: { statuses: ['ISSUED', 'RECEIVED', 'CLOSED'], party: true },
  Shipment: { statuses: ['PACKED', 'SHIPPED', 'DELIVERED'], party: true },
  Party: { statuses: ['ACTIVE'], party: true },
} as const satisfies Record<string, { readonly statuses: readonly string[]; readonly party: boolean }>)

export type RequiredRecordType = keyof typeof REQUIRED_RECORD_TYPES
export const REQUIRED_RECORD_TYPE_NAMES = Object.freeze(Object.keys(REQUIRED_RECORD_TYPES)) as readonly RequiredRecordType[]
export const isRequiredRecordType = (value: string): value is RequiredRecordType => Object.hasOwn(REQUIRED_RECORD_TYPES, value)

/** The documents a rule may ask for (FileCategory values; OTHER and the working photos are not documents to require). */
export const REQUIRED_CATEGORIES = [
  'SUPPLIER_CERTIFICATE',
  'TEST_REPORT',
  'DECLARATION',
  'QUESTIONNAIRE',
  'POD',
  'CMR',
  'DDT_PHOTO',
  'CARRIER_INVOICE',
  'PROOF',
  'SAMPLE_PHOTO',
] as const
export type RequiredCategory = (typeof REQUIRED_CATEGORIES)[number]
export const isRequiredCategory = (value: string): value is RequiredCategory => (REQUIRED_CATEGORIES as readonly string[]).includes(value)

/** Every FileCategory a file may be tagged with in the office (the required ones, plus the module-owned tags it may read). */
export const DOCUMENT_CATEGORIES = [...REQUIRED_CATEGORIES, 'CLAIM_PHOTO', 'MACHINE_CE', 'MANUAL', 'CHECK_REPORT', 'BEFORE_WORK', 'AFTER_WORK', 'BODY_PHOTO', 'OTHER'] as const
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]
export const isDocumentCategory = (value: string): value is DocumentCategory => (DOCUMENT_CATEGORIES as readonly string[]).includes(value)

export const PARTY_ROLES = ['CUSTOMER', 'BRAND', 'SUPPLIER', 'SUBCONTRACTOR', 'CARRIER', 'CONSULTANT'] as const
export type RulePartyRole = (typeof PARTY_ROLES)[number]

export const REQUIRED_LEVELS = ['BLOCK', 'WARN'] as const
export type RequiredLevel = (typeof REQUIRED_LEVELS)[number]

/** A rule as it is kept. */
export interface RequiredRule {
  readonly id: string
  readonly recordType: string
  readonly category: string
  readonly beforeStatus: string
  readonly partyRole: string | null
  readonly level: RequiredLevel
  readonly active: boolean
}

/** A rule as typed (New rule, an edit). */
export interface RuleDraft {
  readonly recordType: string
  readonly category: string
  readonly beforeStatus: string
  readonly partyRole: string | null
  readonly level: string
}

/** What is wrong with a rule, by field; none: it may be kept. */
export function ruleDraftProblems(draft: RuleDraft): Issue[] {
  const issues: Issue[] = []
  if (!isRequiredRecordType(draft.recordType)) issues.push({ path: 'body/recordType', message: 'Rules can be set for purchase orders, goods receipts, ship notices, subcontract orders, shipments and parties.' })
  else if (!(REQUIRED_RECORD_TYPES[draft.recordType].statuses as readonly string[]).includes(draft.beforeStatus)) {
    issues.push({ path: 'body/beforeStatus', message: `A ${recordWords(draft.recordType)} rule names one of its statuses: ${REQUIRED_RECORD_TYPES[draft.recordType].statuses.map(statusWords).join(', ')}.` })
  }
  if (!isRequiredCategory(draft.category)) issues.push({ path: 'body/category', message: 'This kind of file is not a document a rule can ask for.' })
  if (draft.partyRole !== null && !(PARTY_ROLES as readonly string[]).includes(draft.partyRole)) issues.push({ path: 'body/partyRole', message: 'The party role is not one of customer, brand, supplier, subcontractor, carrier or consultant.' })
  if (!(REQUIRED_LEVELS as readonly string[]).includes(draft.level)) issues.push({ path: 'body/level', message: 'A rule blocks the move or warns.' })
  return issues
}

/** Two rules that cannot both be active (the database's one-active-rule indexes): same record type, document, status and party role. */
export const sameRuleKey = (a: Omit<RuleDraft, 'level'>, b: Omit<RuleDraft, 'level'>): boolean =>
  a.recordType === b.recordType && a.category === b.category && a.beforeStatus === b.beforeStatus && (a.partyRole ?? null) === (b.partyRole ?? null)

/** The active rules for a move to `toStatus` of a record whose party has `partyRoles` (none: only the every-record rules). */
export function rulesThatApply<T extends RequiredRule>(rules: readonly T[], recordType: string, toStatus: string, partyRoles: readonly string[]): T[] {
  return rules.filter((rule) => rule.active && rule.recordType === recordType && rule.beforeStatus === toStatus && (rule.partyRole === null || partyRoles.includes(rule.partyRole)))
}

/** A file of the record (or its party) as the check reads it. */
export interface DocumentFile {
  readonly id: string
  readonly category: string | null
  readonly status: string
  readonly supersededAt: Date | string | null
  /** The validity end as a business date, or null. */
  readonly expiresOn: BusinessDate | Date | null
}

export type RequirementReason = 'MET' | 'MISSING' | 'EXPIRED'

/** One rule against the record's documents. */
export interface RequirementState {
  readonly ruleId: string
  readonly recordType: string
  readonly category: string
  readonly beforeStatus: string
  readonly partyRole: string | null
  readonly level: RequiredLevel
  readonly reason: RequirementReason
  /** The file that meets it (the one valid longest), or the latest expired one; null when missing. */
  readonly fileId: string | null
  readonly expiresOn: BusinessDate | null
}

const isCurrent = (file: DocumentFile): boolean => file.status === 'AVAILABLE' && (file.supersededAt ?? null) === null
const expiryOf = (file: DocumentFile): BusinessDate | null => (file.expiresOn === null ? null : dayOf(file.expiresOn))
/** Longest valid first: no date beats any date, a later date beats an earlier one. */
const laterFirst = (a: DocumentFile, b: DocumentFile): number => {
  const ea = expiryOf(a)
  const eb = expiryOf(b)
  if (ea === eb) return a.id < b.id ? -1 : 1
  if (ea === null) return -1
  if (eb === null) return 1
  return ea > eb ? -1 : 1
}

/** Each rule against the documents on `today`. */
export function requirementStates(rules: readonly RequiredRule[], files: readonly DocumentFile[], today: BusinessDate): RequirementState[] {
  return rules.map((rule) => {
    const kind = files.filter((file) => isCurrent(file) && file.category === rule.category).sort(laterFirst)
    const valid = kind.find((file) => validOn(expiryOf(file), today)) ?? null
    const best = valid ?? kind[0] ?? null
    return {
      ruleId: rule.id,
      recordType: rule.recordType,
      category: rule.category,
      beforeStatus: rule.beforeStatus,
      partyRole: rule.partyRole,
      level: rule.level,
      reason: valid ? 'MET' : best ? 'EXPIRED' : 'MISSING',
      fileId: best?.id ?? null,
      expiresOn: best ? expiryOf(best) : null,
    }
  })
}

/** The rules not met, split by what they do to the move. */
export function problemsOf(states: readonly RequirementState[]): { readonly blocks: RequirementState[]; readonly warnings: RequirementState[] } {
  const open = states.filter((state) => state.reason !== 'MET')
  return { blocks: open.filter((state) => state.level === 'BLOCK'), warnings: open.filter((state) => state.level === 'WARN') }
}

// ---- words (the API's refusals and audit rows; the web says its own) ------------------------------------------------------

export const CATEGORY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  SUPPLIER_CERTIFICATE: 'supplier certificate',
  TEST_REPORT: 'test report',
  DECLARATION: 'declaration',
  QUESTIONNAIRE: 'supplier questionnaire',
  POD: 'proof of delivery',
  CMR: 'CMR consignment note',
  DDT_PHOTO: "photo of the supplier's DDT",
  CARRIER_INVOICE: "carrier's invoice",
  PROOF: 'proof',
  SAMPLE_PHOTO: 'sample photo',
  CLAIM_PHOTO: 'claim photo',
  MACHINE_CE: 'CE declaration',
  MANUAL: 'manual',
  CHECK_REPORT: 'check report',
  BEFORE_WORK: 'photo before the work',
  AFTER_WORK: 'photo after the work',
  BODY_PHOTO: 'body photo',
  OTHER: 'other document',
})

const RECORD_WORDS: Readonly<Record<string, string>> = Object.freeze({
  PurchaseOrder: 'purchase order',
  GoodsReceipt: 'goods receipt',
  ShipNotice: 'ship notice',
  SubcontractOrder: 'subcontract order',
  Shipment: 'shipment',
  Party: 'party',
})

export const recordWords = (recordType: string): string => RECORD_WORDS[recordType] ?? recordType
export const statusWords = (status: string): string => status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ')
export const categoryWords = (category: string): string => CATEGORY_WORDS[category] ?? category.toLowerCase().replace(/_/g, ' ')

/** One unmet rule in words: "A supplier certificate is needed before Confirmed: none is on file." */
export function requirementSentence(state: RequirementState): string {
  const what = categoryWords(state.category)
  const article = /^[aeiou]/i.test(what) ? 'An' : 'A'
  const why = state.reason === 'EXPIRED' ? `the one on file expired on ${state.expiresOn}` : 'none is on file'
  return `${article} ${what} is needed before ${statusWords(state.beforeStatus)}: ${why}.`
}

/** The refusal of a blocked move, in words (the module's 409). */
export function blockedSentence(blocks: readonly RequirementState[]): string {
  if (blocks.length === 0) return ''
  const first = blocks[0]!
  const head = `This ${recordWords(first.recordType)} cannot move to ${statusWords(first.beforeStatus)} yet.`
  return [head, ...blocks.map(requirementSentence)].join(' ')
}
