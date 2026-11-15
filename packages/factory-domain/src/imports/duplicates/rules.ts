import { codeKey, emailDomain, nameKey, nameScore, SIMILAR_NAME_SCORE, taxKeys, websiteHost } from './match'

/**
 * Likely duplicates and their merge (B-W2b-427; feature PLT-178). Rule 1 of the plan: a second customer record splits
 * its orders and its credit, so a likely duplicate is said on create and on import, and two records that are the same
 * may be merged — always a person's decision, never by itself.
 *
 * What makes two records alike (`DUPLICATE_REASONS`), each with its likelihood:
 *   HIGH    the same VAT number or codice fiscale, the same code once spaces and dashes are dropped, the same supplier
 *           article code of the same supplier, the same name once legal forms are dropped
 *   MEDIUM  a similar name, the same e-mail domain of a contact (never a public mailbox), the same website
 *
 * A merge keeps one record and archives the other ("the duplicate"). It never deletes a row and never re-points a
 * document: every audit row, ledger and document keeps the record it was made for, which still exists (archived, and
 * it still opens). What moves to the record that stays are the duplicate's own parts nobody else points to — a party's
 * active contacts and addresses (a contact whose e-mail the record that stays already has stays behind, as does a part
 * another record points to), its tax identities when the record that stays has none; a material's active colours whose
 * code it lacks. So a merge is offered only while the
 * duplicate is used by nothing else (`IN_USE`, with what uses it): a customer with orders, invoices or payments keeps
 * them, and the screen offers to open the other one instead (or to keep the other one, when that way works).
 */

export const DUPLICATE_RECORD_TYPES = ['PARTY', 'MATERIAL'] as const
export type DuplicateRecordType = (typeof DUPLICATE_RECORD_TYPES)[number]

export const DUPLICATE_REASONS = ['SAME_VAT_NUMBER', 'SAME_FISCAL_CODE', 'SAME_CODE', 'SAME_SUPPLIER_CODE', 'SAME_NAME', 'SIMILAR_NAME', 'SAME_EMAIL_DOMAIN', 'SAME_WEBSITE'] as const
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number]

export const LIKELIHOODS = ['HIGH', 'MEDIUM'] as const
export type Likelihood = (typeof LIKELIHOODS)[number]

const HIGH: ReadonlySet<DuplicateReason> = new Set(['SAME_VAT_NUMBER', 'SAME_FISCAL_CODE', 'SAME_CODE', 'SAME_SUPPLIER_CODE', 'SAME_NAME'])

/** One reason two records look alike: the shared domain or host as data (never a tax number), a name's score. */
export interface ReasonFound {
  readonly code: DuplicateReason
  /** SAME_EMAIL_DOMAIN, SAME_WEBSITE: the domain or host; else null. */
  readonly detail: string | null
  /** SIMILAR_NAME: how alike, 0..100; else null. */
  readonly score: number | null
}

export const likelihoodOf = (reasons: readonly Pick<ReasonFound, 'code'>[]): Likelihood => (reasons.some((reason) => HIGH.has(reason.code)) ? 'HIGH' : 'MEDIUM')

/** At most this many candidates per record checked; at most this many pairs in one scan. */
export const DUPLICATE_LIMITS = Object.freeze({ candidates: 5, pairs: 200, importRows: 500, nameWords: 3 })

// ---- parties -----------------------------------------------------------------------------------------------------------

/** What a party is compared by (a draft on create, a sheet row, a party that exists). */
export interface PartyProbe {
  readonly legalName?: string | null | undefined
  readonly tradeName?: string | null | undefined
  readonly vatNumbers?: readonly (string | null | undefined)[] | undefined
  readonly fiscalCodes?: readonly (string | null | undefined)[] | undefined
  readonly emails?: readonly (string | null | undefined)[] | undefined
  readonly website?: string | null | undefined
}

/** A party's keys (match.ts), worked out once per party. */
export interface PartyKeys {
  readonly names: readonly string[]
  readonly vat: readonly string[]
  readonly fiscal: readonly string[]
  readonly domains: readonly string[]
  readonly website: string | null
}

export function partyKeys(probe: PartyProbe): PartyKeys {
  const tax = taxKeys(probe.vatNumbers ?? [], probe.fiscalCodes ?? [])
  return {
    names: [...new Set([nameKey(probe.legalName), nameKey(probe.tradeName)].filter((key) => key !== ''))],
    vat: tax.vat,
    fiscal: tax.fiscal,
    domains: [...new Set((probe.emails ?? []).map(emailDomain).filter((domain): domain is string => domain !== null))].sort(),
    website: websiteHost(probe.website),
  }
}

const shared = (a: readonly string[], b: readonly string[]): string[] => a.filter((value) => b.includes(value))

/** The best name score between two lists of keys (0..1). */
export function bestNameScore(a: readonly string[], b: readonly string[]): number {
  let best = 0
  for (const left of a) for (const right of b) best = Math.max(best, nameScore(left, right))
  return best
}

const nameReason = (a: readonly string[], b: readonly string[]): ReasonFound | null => {
  const score = bestNameScore(a, b)
  if (score >= 1) return { code: 'SAME_NAME', detail: null, score: null }
  if (score >= SIMILAR_NAME_SCORE) return { code: 'SIMILAR_NAME', detail: null, score: Math.floor(score * 100) }
  return null
}

/** Why two parties look alike (empty: they do not), strongest first. */
export function partyReasons(a: PartyKeys, b: PartyKeys): ReasonFound[] {
  const reasons: ReasonFound[] = []
  if (shared(a.vat, b.vat).length > 0) reasons.push({ code: 'SAME_VAT_NUMBER', detail: null, score: null })
  else if (shared(a.fiscal, b.fiscal).length > 0) reasons.push({ code: 'SAME_FISCAL_CODE', detail: null, score: null })
  const name = nameReason(a.names, b.names)
  if (name) reasons.push(name)
  for (const domain of shared(a.domains, b.domains).slice(0, 1)) reasons.push({ code: 'SAME_EMAIL_DOMAIN', detail: domain, score: null })
  if (a.website !== null && a.website === b.website && !a.domains.includes(a.website)) reasons.push({ code: 'SAME_WEBSITE', detail: a.website, score: null })
  return reasons
}

// ---- materials ---------------------------------------------------------------------------------------------------------

export interface MaterialProbe {
  readonly code?: string | null | undefined
  readonly name?: string | null | undefined
  readonly supplierId?: string | null | undefined
  readonly supplierArticleCode?: string | null | undefined
}

export interface MaterialKeys {
  readonly code: string
  readonly name: string
  readonly supplierId: string | null
  readonly article: string
}

export function materialKeys(probe: MaterialProbe): MaterialKeys {
  return { code: codeKey(probe.code), name: nameKey(probe.name), supplierId: probe.supplierId ?? null, article: codeKey(probe.supplierArticleCode) }
}

/**
 * Why two materials look alike: the same code once spaces and dashes are dropped, the same supplier article code (of
 * the same supplier when both name one), the same or a similar name.
 */
export function materialReasons(a: MaterialKeys, b: MaterialKeys): ReasonFound[] {
  const reasons: ReasonFound[] = []
  if (a.code !== '' && a.code === b.code) reasons.push({ code: 'SAME_CODE', detail: null, score: null })
  if (a.article.length >= 3 && a.article === b.article && (a.supplierId === null || b.supplierId === null || a.supplierId === b.supplierId)) reasons.push({ code: 'SAME_SUPPLIER_CODE', detail: null, score: null })
  const name = nameReason(a.name ? [a.name] : [], b.name ? [b.name] : [])
  if (name) reasons.push(name)
  return reasons
}

/** Candidates in the order a person reads them: HIGH first, then more reasons, then the better name, then by code. */
export function byLikelihood<Candidate extends { readonly code: string; readonly reasons: readonly ReasonFound[] }>(a: Candidate, b: Candidate): number {
  const rank = (candidate: Candidate) => (likelihoodOf(candidate.reasons) === 'HIGH' ? 0 : 1)
  const score = (candidate: Candidate) => Math.max(0, ...candidate.reasons.map((reason) => (reason.code === 'SAME_NAME' ? 100 : (reason.score ?? 0))))
  return rank(a) - rank(b) || b.reasons.length - a.reasons.length || score(b) - score(a) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
}

// ---- what uses a record ------------------------------------------------------------------------------------------------

/** The kinds of records that can use a party or a material, as the merge screen names them. */
export const USE_GROUPS = ['SALES', 'MONEY', 'PURCHASING', 'STOCK', 'PRODUCTION', 'PRODUCTS', 'QUALITY', 'PORTAL', 'PEOPLE', 'OTHER'] as const
export type UseGroup = (typeof USE_GROUPS)[number]

const GROUP_PATTERNS: readonly (readonly [UseGroup, RegExp])[] = [
  ['MONEY', /^(Invoice|Payment|Refund|SupplierInvoice|BankMatch|DeclarationOfIntent|CreditCheck|CustomerStatementFigures|PaymentIntent|PaymentReminder|DepositRequest|PaymentProposal|Riba|ReminderStop|CreditNote|DebitNote)/],
  ['SALES', /^(Quote|SalesOrder|Inquiry|PortalOrderRequest|OrderGate|ReturnAuthorisation|Complaint|ServiceCase|Appointment|MeasurementProfile|Fitting|Collection|PriceList|PartyPriceList)/],
  ['PURCHASING', /^(PurchaseOrder|PurchaseRequest|GoodsReceipt|PurchasePriceVariance|DeliveryTolerance|MaterialRequirement|ItemPlanning|SupplierDeclaration|ShipNotice|SupplierPrice|SupplierBank|ApprovedSource|Subcontract)/],
  ['STOCK', /^(Lot|Stock|Reservation|Hide|Inventory|Transfer|Location|Carton|Shipment|Pick|Pack)/],
  ['PRODUCTION', /^(WorkOrder|Bundle|Cutting|Kit|Scrap|Rework|Routing|Operation|Planning)/],
  ['PRODUCTS', /^(Style|Bom|Item|Variant|ChangeRequest|Sample|BrandingSet|LabelTemplate|Certificate|ComplianceDocument|EvidencePack|EconomicOperatorRole|SubstanceRule|SustainabilityClaim|TechFile|Pocket|Option)/],
  ['QUALITY', /^(Capa|Ncr|Nonconformance|Recall|Distributor|Inspection|Machine|ClickingDie|Ppe|Safety|ProductSafety)/],
  ['PORTAL', /^(User|Session|Invitation|Portal|Partner|RecordShare|ApprovalRequest|OneOffLink|InboundEmail)/],
  ['PEOPLE', /^(Employee|People|Worker)/],
]

/** The group of a table that points to a record (by its model name); OTHER when no group fits. */
export function useGroupOf(table: string): UseGroup {
  return GROUP_PATTERNS.find(([, pattern]) => pattern.test(table))?.[0] ?? 'OTHER'
}

/** One table that points to a record, and how many of its rows do. */
export interface TableUse {
  readonly table: string
  readonly count: number
}

/** The uses of a record per group, in USE_GROUPS order (the tables named, for the curious). */
export function useGroups(uses: readonly TableUse[]): { group: UseGroup; count: number; tables: string[] }[] {
  const groups = new Map<UseGroup, { count: number; tables: Set<string> }>()
  for (const use of uses) {
    if (use.count <= 0) continue
    const group = useGroupOf(use.table)
    const entry = groups.get(group) ?? { count: 0, tables: new Set<string>() }
    entry.count += use.count
    entry.tables.add(use.table)
    groups.set(group, entry)
  }
  return USE_GROUPS.flatMap((group) => {
    const entry = groups.get(group)
    return entry ? [{ group, count: entry.count, tables: [...entry.tables].sort() }] : []
  })
}

// ---- the merge ---------------------------------------------------------------------------------------------------------

/**
 * Why a merge is refused, each said in words on screen:
 *   SAME_RECORD          a record merged into itself
 *   KEPT_ARCHIVED        the record that stays is archived (reactivate it first)
 *   DROPPED_ARCHIVED     the duplicate is archived already
 *   DROPPED_BLOCKED      the duplicate is a blocked party: unblock it first, so the block is never lost
 *   KIND_DIFFERS         two materials of different kinds (a leather and a zip are never the same material)
 *   OTHER_COMPANY        the two belong to different companies
 *   EVERY_COMPANY        a record for every company is merged only into another record for every company
 *   IN_USE               the duplicate is used by other records (orders, invoices, stock …): they keep it
 *   NO_RIGHT             the person may not change both records (the record type's manage permission over both)
 */
export const MERGE_REFUSALS = ['SAME_RECORD', 'KEPT_ARCHIVED', 'DROPPED_ARCHIVED', 'DROPPED_BLOCKED', 'KIND_DIFFERS', 'OTHER_COMPANY', 'EVERY_COMPANY', 'IN_USE', 'NO_RIGHT'] as const
export type MergeRefusal = (typeof MERGE_REFUSALS)[number]

/** One side of a merge as the rules read it. */
export interface MergeSide {
  readonly id: string
  readonly code: string
  readonly status: string
  readonly companyId: string | null
  /** A material's kind; a party's none. */
  readonly kind?: string | null
}

export interface MergeFacts {
  readonly recordType: DuplicateRecordType
  readonly kept: MergeSide
  readonly dropped: MergeSide
  /** What points to the duplicate, beyond its own parts (a part something else points to stays on it, never refuses). */
  readonly uses: readonly TableUse[]
  /** The person may change both records. */
  readonly mayChangeBoth: boolean
}

/** Every reason the merge is refused (empty: it may go ahead), in MERGE_REFUSALS order. */
export function mergeRefusals(facts: MergeFacts): MergeRefusal[] {
  const { kept, dropped } = facts
  const refusals: MergeRefusal[] = []
  if (kept.id === dropped.id) return ['SAME_RECORD']
  if (kept.status === 'ARCHIVED') refusals.push('KEPT_ARCHIVED')
  if (dropped.status === 'ARCHIVED') refusals.push('DROPPED_ARCHIVED')
  if (facts.recordType === 'PARTY' && dropped.status === 'BLOCKED') refusals.push('DROPPED_BLOCKED')
  if (facts.recordType === 'MATERIAL' && (kept.kind ?? null) !== (dropped.kind ?? null)) refusals.push('KIND_DIFFERS')
  if (kept.companyId !== null && dropped.companyId !== null && kept.companyId !== dropped.companyId) refusals.push('OTHER_COMPANY')
  if (kept.companyId !== null && dropped.companyId === null) refusals.push('EVERY_COMPANY')
  if (facts.uses.some((use) => use.count > 0)) refusals.push('IN_USE')
  if (!facts.mayChangeBoth) refusals.push('NO_RIGHT')
  return refusals
}

/** The merge's reason: 3 to 500 characters, kept in both records' audit rows. */
export const MERGE_REASON = Object.freeze({ min: 3, max: 500 })

export function mergeReasonProblem(reason: string | null | undefined): string | null {
  const text = (reason ?? '').trim()
  if (text.length < MERGE_REASON.min) return `Say why they are the same record (at least ${MERGE_REASON.min} characters).`
  if (text.length > MERGE_REASON.max) return `At most ${MERGE_REASON.max} characters.`
  return null
}

/** A contact of the duplicate moves unless the record that stays already has its e-mail (compared lower case). */
export function contactsToMove<Contact extends { readonly email: string | null }>(dropped: readonly Contact[], keptEmails: readonly (string | null)[]): { move: Contact[]; stay: Contact[] } {
  const taken = new Set(keptEmails.filter((email): email is string => !!email).map((email) => email.trim().toLowerCase()))
  const move: Contact[] = []
  const stay: Contact[] = []
  for (const contact of dropped) {
    const email = contact.email?.trim().toLowerCase() ?? null
    if (email && taken.has(email)) stay.push(contact)
    else {
      move.push(contact)
      if (email) taken.add(email)
    }
  }
  return { move, stay }
}

/** A colour of the duplicate moves unless the material that stays has its code (compared as codes). */
export function coloursToMove<Colour extends { readonly code: string }>(dropped: readonly Colour[], keptCodes: readonly string[]): { move: Colour[]; stay: Colour[] } {
  const taken = new Set(keptCodes.map(codeKey))
  const move: Colour[] = []
  const stay: Colour[] = []
  for (const colour of dropped) {
    const key = codeKey(colour.code)
    if (taken.has(key)) stay.push(colour)
    else {
      move.push(colour)
      taken.add(key)
    }
  }
  return { move, stay }
}
