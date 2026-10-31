import type { SearchMatch, SearchResult } from '@nexus/factory-domain/search/contracts'
import { recordAddress } from '../../lib/records/record-links'
import { companyPrefix } from '../../lib/session/session'

/**
 * The search screens' pure rules (B-W2a-32; SCR-004 the palette's Records group, SCR-248 All results): where a result
 * opens, the page's address terms, the words a type or status is said with, the numbers copied from a selection.
 */

/** The record types the index holds today (one indexer each, apps/factory-api platform/search/indexers/). */
export const SEARCH_TYPES = ['SalesOrder', 'Quote', 'Party', 'Style', 'Item', 'PurchaseOrder', 'WorkOrder', 'Lot', 'Hide', 'GoodsReceipt', 'Shipment', 'Invoice', /* B-W2a-83 */ 'ReturnAuthorisation', 'RepairOrder', 'Complaint', 'SupplierClaim',
  // B-W2b-23: every other W1 and W2a record type.
  'Payment', 'SupplierInvoice', 'Inspection', 'QualityHold', 'Nonconformance', 'Certificate', 'LabelTemplate', 'PpeRegisterEntry', 'StockCount', 'Location', 'Ddt', 'SubcontractOrder', 'Operation', 'SizeScale', 'Machine', 'MaintenanceJob'] as const

/** The status codes the search catalogue says in words (`search:status.<code>`); another code is not shown. */
export const STATUS_CODES: ReadonlySet<string> = new Set([
  'PROSPECT', 'ACTIVE', 'BLOCKED', 'ARCHIVED', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED',
  'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED',
  'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD', 'QUARANTINE', 'REJECTED', 'OPEN', 'POSTED', 'REVERSED', 'PACKED', 'DELIVERED', 'RETURNED',
  'ISSUED', 'NOT_DELIVERABLE', 'ERROR',
  // B-W2a-83: a customer return, a repair, a complaint.
  'REQUESTED', 'AUTHORISED', 'INSPECTED', 'AWAITING_GOODS', 'ESTIMATED', 'IN_REPAIR', 'REPAIRED', 'NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED',
  // B-W2b-23: payments, supplier invoices, inspections, NCRs, certificates, label templates, counts, subcontract orders,
  // machines and maintenance jobs.
  'VOIDED', 'PAID', 'DISPUTED', 'PASSED', 'FAILED', 'CONTAINED', 'DECIDED', 'VALID', 'SUSPENDED', 'WITHDRAWN', 'RETIRED', 'COUNTING', 'SUBMITTED',
  'APPLIED', 'SIGNED_OFF', 'AT_WORKSHOP', 'RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE', 'PLANNED', 'WAITING_PARTS', 'HANDED_BACK',
  // A quality hold in force (its indexer says ACTIVE as HELD).
  'HELD',
])

/** The areas whose name the shell's navigation says (`shell:nav.<area>.area`). */
export const AREAS: ReadonlySet<string> = new Set(['home', 'sales', 'products', 'planning', 'purchasing', 'warehouse', 'production', 'quality', 'compliance', 'finance', /* B-W2b-23 */ 'plant', 'admin'])

const KNOWN_TYPES: ReadonlySet<string> = new Set(SEARCH_TYPES)

/** `search:type.<type>` (a type a later step indexes before its words exist is "Record"). */
export const typeKey = (type: string): string => `type.${KNOWN_TYPES.has(type) ? type : 'other'}`
export const chipKey = (type: string): string => `chip.${KNOWN_TYPES.has(type) ? type : 'other'}`
/** `search:status.<code>`, or null for a code without words. */
export const statusKey = (code: string | null): string | null => (code && STATUS_CODES.has(code) ? `status.${code}` : null)
export const areaKey = (area: string): string | null => (AREAS.has(area) ? `shell:nav.${area}.area` : null)
export const whyKey = (match: SearchMatch): string => `why.${match}`

/**
 * A record's second page by the area it was found in (the page as OFFICE_PAGES names it; its one dynamic segment is the
 * record's id): a party that only supplies opens on the buying side.
 */
const AREA_PAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  Party: Object.freeze({ purchasing: '/purchasing/suppliers/[partyId]' }),
})

export interface Place {
  /** The Office pages that are built (OFFICE_PAGES). */
  built: ReadonlySet<string>
  /** The companies the person may switch to (id → code), and the screen's own company code. */
  companies: readonly { id: string; code: string }[]
  company: string
}

/** Where a result opens: its company's Office (the screen's when it has none) and its record page or panels. */
export function resultHref(result: Pick<SearchResult, 'recordType' | 'recordId' | 'number' | 'title' | 'companyId' | 'siteId' | 'area'>, place: Place): string {
  const code = (result.companyId && place.companies.find((company) => company.id === result.companyId)?.code) || place.company
  const second = AREA_PAGES[result.recordType]?.[result.area]
  const address =
    second && place.built.has(second)
      ? second.replace(/\[[^\]/]+\]/, encodeURIComponent(result.recordId))
      : recordAddress({ type: result.recordType, id: result.recordId, label: result.number ?? result.title, companyId: result.companyId, siteId: result.siteId }, place.built)
  return `${companyPrefix(code)}${address}`
}

/** The company's code a result belongs to, for its row (null: every company). */
export function companyCodeOf(companyId: string | null, companies: readonly { id: string; code: string; name?: string }[]): string | null {
  if (!companyId) return null
  return companies.find((company) => company.id === companyId)?.code ?? null
}

/** The results page's address terms: `?q=` and `?type=` (one record type, the chip). */
export interface SearchTerms {
  q: string
  type: string | null
}

const TYPE = /^[A-Z][A-Za-z0-9]*$/

export function readTerms(params: { get(name: string): string | null } | null | undefined): SearchTerms {
  const q = (params?.get('q') ?? '').slice(0, 200)
  const type = params?.get('type') ?? null
  return { q, type: type && TYPE.test(type) ? type : null }
}

export function termsQuery(terms: SearchTerms): string {
  const query = new URLSearchParams()
  if (terms.q.trim() !== '') query.set('q', terms.q.trim())
  if (terms.type) query.set('type', terms.type)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** The All results page for a query (full address). */
export const searchPageHref = (company: string, q: string, type: string | null = null): string => `${companyPrefix(company)}/search${termsQuery({ q, type })}`

/** The numbers of the selected results, one per line, in the order shown (results without a number are skipped). */
export function numbersOf(results: readonly Pick<SearchResult, 'recordId' | 'number'>[], selected: readonly string[]): string[] {
  const chosen = new Set(selected)
  return results.filter((result) => chosen.has(result.recordId) && result.number).map((result) => result.number!)
}

const WARNING = new Set(['PENDING_APPROVAL', 'CHANGES_PROPOSED', 'ON_HOLD', 'QUARANTINE', 'PARTLY_SHIPPED', 'PARTLY_RECEIVED', /* B-W2b-23 */ 'DISPUTED', 'SUSPENDED', 'UNDER_MAINTENANCE', 'WAITING_PARTS', 'SUBMITTED', 'HELD'])
const DANGER = new Set(['BLOCKED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'REJECTED', 'NOT_DELIVERABLE', 'ERROR', 'REVERSED', 'RETURNED', /* B-W2b-23 */ 'VOIDED', 'FAILED', 'WITHDRAWN', 'DOWN', 'DO_NOT_USE'])
const DONE = new Set(['ACCEPTED', 'SHIPPED', 'RECEIVED', 'RELEASED', 'COMPLETED', 'DELIVERED', 'POSTED', 'ISSUED', 'ACTIVE', 'CONFIRMED', 'APPROVED', 'INSPECTED', 'REPAIRED', 'ANSWERED', /* B-W2b-23 */ 'PAID', 'PASSED', 'VALID', 'APPLIED', 'SIGNED_OFF', 'RUNNING', 'HANDED_BACK'])

/** The tone a status is drawn in (a pill): waiting, refused or stopped, done, or neutral. */
export function statusTone(code: string | null): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (!code) return 'neutral'
  if (WARNING.has(code)) return 'warning'
  if (DANGER.has(code)) return 'danger'
  if (DONE.has(code)) return 'success'
  if (code === 'DRAFT' || code === 'ARCHIVED' || code === 'CLOSED' || code === 'PROSPECT' || code === 'RETIRED') return 'neutral'
  return 'info'
}

/** The view permissions of the record types the index holds: a person who holds none of them has nothing to search. */
export const SEARCH_VIEW_PERMISSIONS: readonly string[] = Object.freeze(['parties.view', 'quotes.view', 'orders.view', 'product.styles.view', 'product.materials.view', 'purchasing.view', 'workorders.view', 'inventory.stock.view', 'shipping.view', 'invoices.view', /* B-W2a-83 */ 'sales.returns.view', 'sales.repairs.view', 'quality.complaints.view',
  /* B-W2b-23 */ 'payments.view', 'payables.view', 'quality.inspections.view', 'quality.holds.view', 'quality.ncr.view', 'compliance.certificates.view', 'compliance.register.view', 'inventory.counts.view', 'inventory.locations.view', 'product.routing.view', 'plant.view'])

export const canSearchSomething = (permissions: readonly string[]): boolean => permissions.some((permission) => SEARCH_VIEW_PERMISSIONS.includes(permission))
