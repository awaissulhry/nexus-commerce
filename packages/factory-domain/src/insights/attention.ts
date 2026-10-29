import { heldGrains, type Grain } from '../auth/grains/grains'
import { EMAIL_TRIAGE } from '../auth/permissions/catalogue'
import { REGISTER_MANAGE, REGISTER_VIEW } from '../compliance/register/permissions'
import { CERTIFICATES_MANAGE, CERTIFICATES_VIEW } from '../compliance/certificates/permissions'
import { LABELS_MANAGE } from '../compliance/labels/permissions'
import { fromMinorUnits, minorPlaces } from '../core/money'
import { can, holds, type Actor, type Permission, type ScopedRecord } from '../core/permissions'
import type { BusinessDate } from '../core/time'
import type { EventType } from '../events/catalogue'
import { INVOICES_ISSUE, INVOICES_MANAGE, INVOICES_VIEW } from '../invoicing/permissions'
import { PRIVACY_MANAGE, PRIVACY_VIEW } from '../privacy/permissions'
import { PRODUCT_BOM_RELEASE } from '../product/bom/permissions'
import { DECLARATIONS_MANAGE } from '../product/compliance/permissions'
import { PRODUCTION_SCAN_CORRECT } from '../production/scans/permissions'
import { WORKORDERS_RELEASE, WORKORDERS_VIEW } from '../production/work-orders/permissions'
import { PURCHASING_SEND, PURCHASING_VIEW } from '../purchasing/permissions'
import { QUALITY_LOTS_REJECT, QUALITY_LOTS_RELEASE, QUALITY_LOTS_VIEW } from '../quality/lab/permissions'
import { ORDERS_MANAGE, ORDERS_VIEW } from '../sales/orders/permissions'
import { QUOTES_APPROVE, QUOTES_VIEW } from '../sales/quotes/permissions'
import { Dec } from '../tax/decimal'

/**
 * Needs attention (B-W1-52; ANA-037; A2 SCR-029 "Today › Needs me now"; design home.today). ONE ranked list of what waits
 * for a person, from every area and company, COMPUTED from the records' own states at read time: nothing is stored, so
 * the list cannot drift from the records (no Alert, Task or Notification table exists in W1; ANA-036's exception rules
 * and PLT-138's notification centre are W2a).
 *
 * Each source (apps/factory-api modules/insights/sources) reads the rows its kind's VIEW permission reaches (scopeWhere)
 * and turns each one that needs a person into a candidate. `whyMine` then keeps only what THIS person may act on: the
 * kind's view and one of its act permissions over the record's company, site and party (can()), never the person who
 * asked (four eyes), and only with the grain the decision rests on. A row nobody may act on is not shown to a viewer
 * (design: "sources the person cannot see are simply not sources"; never an item without the right to act on it).
 *
 * Rank (stable): severity, then due date (none last), then age (oldest first), then the row's key. Amounts follow the
 * reader's grains twice: `presentItem` adds an amount to the sentence and to the row only for a reader holding its grain,
 * and the API's grain filter drops the marked fields again (money.<grain> in the contract).
 *
 * Owner answer O3 = A: approve straight from Today only a one-field change shown in the row, with no signature; anything
 * else opens the review. No W1 kind is a one-field change (a quote approval rests on its rules, a supplier's proposal on
 * its lines, a scan correction on its quantities), so every W1 approval `decide`s by REVIEW and every alert by OPEN.
 */

export const ATTENTION_KINDS = [
  'ORDER_PROMISE',
  'WORK_ORDER_HELD',
  'LOT_HOLD',
  'INVOICE_SDI',
  'QUOTE_APPROVAL',
  'PO_PROPOSAL',
  'PO_NOT_CONFIRMED',
  'SCAN_CORRECTION',
  'SCAN_REFUSAL',
  'INVOICE_TO_ISSUE',
  'REGISTER_DUTY',
  'PRIVACY_DUTY',
  'STYLE_COMPLIANCE',
  'MAIL_TO_SORT',
] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]

export const isAttentionKind = (value: unknown): value is AttentionKind => typeof value === 'string' && (ATTENTION_KINDS as readonly string[]).includes(value)

export const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const
export type Severity = (typeof SEVERITIES)[number]
export const SEVERITY_WORDS: Readonly<Record<Severity, string>> = Object.freeze({ HIGH: 'Urgent', MEDIUM: 'Needs action', LOW: 'When you can' })

/** The design's groups: Now (overdue or urgent) · Today · This week · Later. */
export const GROUPS = ['NOW', 'TODAY', 'THIS_WEEK', 'LATER'] as const
export type Group = (typeof GROUPS)[number]

export const CATEGORIES = ['APPROVAL', 'ALERT', 'TASK'] as const
export type Category = (typeof CATEGORIES)[number]

/** How a row is decided from Today (O3 = A): the review of an approval, or the record of an alert or task. */
export const DECIDE_MODES = ['REVIEW', 'OPEN'] as const
export type DecideMode = (typeof DECIDE_MODES)[number]

/** Due within this many days: "Soon". */
export const SOON_DAYS = 7

export interface KindRule {
  readonly kind: AttentionKind
  readonly category: Category
  /** The tile's label: says exactly what it counts. */
  readonly label: string
  /** Seeing the record (the source reads only rows this reaches). */
  readonly view: Permission
  /** Acting on it: any one of these over the record. */
  readonly act: readonly Permission[]
  /** Why it is mine, per act permission the person holds (the first held, in `act`'s order). */
  readonly why: Readonly<Partial<Record<Permission, string>>>
  readonly decide: DecideMode
  /** The events after which the row may have changed: the web refreshes Today on them (GET /live). */
  readonly live: readonly EventType[]
}

const rule = (content: KindRule): KindRule => Object.freeze({ ...content, act: Object.freeze([...content.act]), live: Object.freeze([...content.live]) })

export const KIND_RULES: Readonly<Record<AttentionKind, KindRule>> = Object.freeze({
  ORDER_PROMISE: rule({
    kind: 'ORDER_PROMISE',
    category: 'ALERT',
    label: 'Orders late or due in 3 days and not ready',
    view: ORDERS_VIEW,
    act: [ORDERS_MANAGE],
    why: { [ORDERS_MANAGE]: "You manage this customer's orders and their promise dates." },
    decide: 'OPEN',
    live: ['sales_order.created', 'sales_order.status_changed', 'sales_order.promise_changed', 'shipment.status_changed'],
  }),
  WORK_ORDER_HELD: rule({
    kind: 'WORK_ORDER_HELD',
    category: 'ALERT',
    label: 'Draft work orders the release check holds',
    view: WORKORDERS_VIEW,
    act: [WORKORDERS_RELEASE],
    why: { [WORKORDERS_RELEASE]: 'You release work orders at this site.' },
    decide: 'OPEN',
    live: ['workorder.created', 'workorder.changed', 'workorder.released', 'workorder.status_changed', 'lot.released', 'inventory.receipt_posted', 'payment.deposit_paid', 'style.revision_released', 'compliance.label_template_activated'],
  }),
  LOT_HOLD: rule({
    kind: 'LOT_HOLD',
    category: 'ALERT',
    label: 'Lots in quarantine or blocked',
    view: QUALITY_LOTS_VIEW,
    act: [QUALITY_LOTS_RELEASE, QUALITY_LOTS_REJECT],
    why: { [QUALITY_LOTS_RELEASE]: 'You release lots at this site.', [QUALITY_LOTS_REJECT]: 'You reject or block lots at this site.' },
    decide: 'OPEN',
    live: ['inventory.receipt_posted', 'inventory.opening_posted', 'lot.test_recorded', 'lot.document_attached', 'lot.released', 'lot.rejected', 'lot.blocked', 'lot.hold_cleared'],
  }),
  INVOICE_SDI: rule({
    kind: 'INVOICE_SDI',
    category: 'ALERT',
    label: 'Invoices SDI rejected or did not take, not delivered, or without their files',
    view: INVOICES_VIEW,
    act: [INVOICES_ISSUE],
    why: { [INVOICES_ISSUE]: "You issue and send this customer's invoices." },
    decide: 'OPEN',
    live: ['invoice.issued', 'invoice.files_attached', 'invoice.sdi_status_changed', 'invoice.sdi_corrected', 'invoice.courtesy_copy_queued', 'invoice.courtesy_copy_missing'],
  }),
  QUOTE_APPROVAL: rule({
    kind: 'QUOTE_APPROVAL',
    category: 'APPROVAL',
    label: 'Quotes waiting for your approval',
    view: QUOTES_VIEW,
    act: [QUOTES_APPROVE],
    why: { [QUOTES_APPROVE]: "You approve this customer's quotes, and someone else asked." },
    decide: 'REVIEW',
    live: ['quote.approval_requested', 'quote.approval_decided', 'quote.reopened', 'quote.cancelled'],
  }),
  PO_PROPOSAL: rule({
    kind: 'PO_PROPOSAL',
    category: 'APPROVAL',
    label: "Suppliers' proposed changes to decide",
    view: PURCHASING_VIEW,
    act: [PURCHASING_SEND],
    why: { [PURCHASING_SEND]: 'You send purchase orders to this supplier.' },
    decide: 'REVIEW',
    live: ['purchase_order.changes_proposed', 'purchase_order.confirmed', 'purchase_order.proposal_refused', 'purchase_order.cancelled'],
  }),
  PO_NOT_CONFIRMED: rule({
    kind: 'PO_NOT_CONFIRMED',
    category: 'ALERT',
    label: 'Purchase orders not confirmed 48 hours after sending',
    view: PURCHASING_VIEW,
    act: [PURCHASING_SEND],
    why: { [PURCHASING_SEND]: 'You send purchase orders to this supplier.' },
    decide: 'OPEN',
    live: ['purchase_order.sent', 'purchase_order.link_sent', 'purchase_order.confirmed', 'purchase_order.declined', 'purchase_order.changes_proposed', 'purchase_order.cancelled'],
  }),
  SCAN_CORRECTION: rule({
    kind: 'SCAN_CORRECTION',
    category: 'APPROVAL',
    label: 'Scan corrections to decide',
    view: PRODUCTION_SCAN_CORRECT,
    act: [PRODUCTION_SCAN_CORRECT],
    why: { [PRODUCTION_SCAN_CORRECT]: "You decide the floor's scan corrections at this site, and you neither scanned nor asked." },
    decide: 'REVIEW',
    live: ['production.scan_correction_requested', 'production.scan_correction_decided'],
  }),
  SCAN_REFUSAL: rule({
    kind: 'SCAN_REFUSAL',
    category: 'TASK',
    label: 'Refused floor scans to look at',
    view: PRODUCTION_SCAN_CORRECT,
    act: [PRODUCTION_SCAN_CORRECT],
    why: { [PRODUCTION_SCAN_CORRECT]: "You look after this site's floor scans." },
    decide: 'OPEN',
    live: ['production.scan_refused', 'production.scan_recorded', 'production.scan_correction_requested'],
  }),
  INVOICE_TO_ISSUE: rule({
    kind: 'INVOICE_TO_ISSUE',
    category: 'TASK',
    label: 'Shipped goods to invoice',
    view: INVOICES_VIEW,
    act: [INVOICES_MANAGE],
    why: { [INVOICES_MANAGE]: "You invoice this customer's shipped goods." },
    decide: 'OPEN',
    live: ['ddt.issued', 'ddt.cancelled', 'shipment.status_changed', 'invoice.draft_saved', 'invoice.draft_deleted', 'invoice.issued'],
  }),
  REGISTER_DUTY: rule({
    kind: 'REGISTER_DUTY',
    category: 'TASK',
    label: 'PPE register entries with duties open',
    view: REGISTER_VIEW,
    act: [REGISTER_MANAGE],
    why: { [REGISTER_MANAGE]: "You keep this company's PPE register." },
    decide: 'OPEN',
    live: ['compliance.register_entry_opened', 'compliance.register_entry_changed', 'compliance.register_entry_closed', 'shipment.status_changed'],
  }),
  PRIVACY_DUTY: rule({
    kind: 'PRIVACY_DUTY',
    category: 'TASK',
    label: 'Companies with privacy duties open',
    view: PRIVACY_VIEW,
    act: [PRIVACY_MANAGE],
    why: { [PRIVACY_MANAGE]: "You keep this company's privacy paperwork." },
    decide: 'OPEN',
    live: ['privacy.notice_published', 'privacy.dpia_stored'],
  }),
  STYLE_COMPLIANCE: rule({
    kind: 'STYLE_COMPLIANCE',
    category: 'ALERT',
    label: 'Released styles with open orders that compliance holds',
    view: CERTIFICATES_VIEW,
    act: [DECLARATIONS_MANAGE, CERTIFICATES_MANAGE, LABELS_MANAGE, PRODUCT_BOM_RELEASE],
    why: {
      [DECLARATIONS_MANAGE]: "You file the styles' Declarations of Conformity and leaflets.",
      [CERTIFICATES_MANAGE]: 'You keep the type-examination certificates.',
      [LABELS_MANAGE]: 'You keep the garment label templates.',
      [PRODUCT_BOM_RELEASE]: 'You release style revisions.',
    },
    decide: 'OPEN',
    live: [
      'style.compliance_document_issued',
      'style.compliance_document_replaced',
      'style.revision_released',
      'compliance.certificate_expired',
      'compliance.label_assigned',
      'compliance.label_template_activated',
      'sales_order.created',
      'sales_order.status_changed',
    ],
  }),
  // Mail no record took, held or unreadable (platform/email-in "Mail to sort", SCR-019). The mail has no assignee in W1:
  // it is the person's when they sort the mail of its company (email.triage; a mail of no company: every company).
  MAIL_TO_SORT: rule({
    kind: 'MAIL_TO_SORT',
    category: 'TASK',
    label: 'Mail to sort',
    view: EMAIL_TRIAGE,
    act: [EMAIL_TRIAGE],
    why: { [EMAIL_TRIAGE]: "You sort this company's received mail." },
    decide: 'REVIEW',
    live: ['email.inbound_sorted'],
  }),
})

/** The person and the moment the list is computed for. */
export interface Viewer {
  readonly actor: Actor
  /** The office user's id (the session's actor). */
  readonly personId: string
  readonly today: BusinessDate
  readonly now: Date
}

export interface AttentionScope {
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
}

export interface AttentionRecord {
  /** The record's model name (SalesOrder, WorkOrder, Lot, Invoice, Quote, PurchaseOrder, …). */
  readonly type: string
  readonly id: string
  /** Its number or code, as the row's chip shows it. */
  readonly label: string
}

/** The amounts a row may carry; each field has a grain (AMOUNT_GRAINS). */
export const AMOUNT_FIELDS = ['netAmount', 'purchaseAmount', 'marginPct', 'marginAmount'] as const
export type AmountField = (typeof AMOUNT_FIELDS)[number]
export const AMOUNT_GRAINS: Readonly<Record<AmountField, Grain>> = Object.freeze({ netAmount: 'price', purchaseAmount: 'cost', marginPct: 'margin', marginAmount: 'cost' })

export interface CandidateAmounts {
  readonly currency: string
  /** The document's selling value, net, in minor units (price grain). */
  readonly netAmount?: number | null
  /** A purchase order's value at its prices, in minor units (cost grain). */
  readonly purchaseAmount?: number | null
  /** A quote's margin, % as a decimal string (margin grain). */
  readonly marginPct?: string | null
  /** A quote's margin in minor units (cost grain, as the quotes module shows it). */
  readonly marginAmount?: number | null
  /** The one the sentence quotes, for a reader with its grain. */
  readonly inSentence?: AmountField
}

/** A row a source found: what needs a person, before it is matched to the viewer. */
export interface AttentionCandidate {
  readonly kind: AttentionKind
  /** The kind's state of this row (LATE | AT_RISK, QUARANTINE | BLOCKED, REJECTED | ERROR | …). */
  readonly state: string
  readonly severity: Severity
  readonly record: AttentionRecord
  readonly scope: AttentionScope
  readonly sentence: string
  readonly blocks: string | null
  readonly due: BusinessDate | null
  /** Since when it waits (its age). */
  readonly since: Date
  /** The permissions that act on THIS row, when only some of the kind's do (a style's blockers). */
  readonly act?: readonly Permission[]
  /** The people who may not act on it (four eyes: who asked, who received, who scanned). */
  readonly notBy?: readonly string[]
  /** The grain the decision rests on (a margin-floor approval needs the margin grain). */
  readonly needsGrain?: Grain
  /** Why it is mine when the record says so (the person follows the entry up). */
  readonly why?: (personId: string) => string | null
  readonly amounts?: CandidateAmounts | null
  /** Tells apart rows of one record (a customer's DDTs per company and month). */
  readonly subKey?: string
}

/** What decides whether a row is the viewer's (a source may ask it before an expensive read). */
export type ActingQuestion = Pick<AttentionCandidate, 'kind' | 'scope' | 'act' | 'notBy' | 'needsGrain'>

/**
 * The permission the viewer acts on the row with, or null when the row is not theirs: the viewer sees the record (the
 * kind's view permission over its company, site and party), holds one of the permissions that act on it there, is not
 * someone four eyes exclude, and holds the grain the decision rests on.
 */
export function actingPermission(viewer: Viewer, question: ActingQuestion): Permission | null {
  const kindRule = KIND_RULES[question.kind]
  const record: ScopedRecord = question.scope
  if (!can(viewer.actor, kindRule.view, record)) return null
  const act = (question.act ?? kindRule.act).find((permission) => can(viewer.actor, permission, record))
  if (act === undefined) return null
  if (question.notBy?.includes(viewer.personId)) return null
  if (question.needsGrain !== undefined && !heldGrains(viewer.actor).has(question.needsGrain)) return null
  return act
}

/** Why the row is the viewer's, in words, or null when it is not (actingPermission). */
export function whyMine(viewer: Viewer, candidate: AttentionCandidate): string | null {
  const act = actingPermission(viewer, candidate)
  if (act === null) return null
  const kindRule = KIND_RULES[candidate.kind]
  return candidate.why?.(viewer.personId) ?? kindRule.why[act] ?? 'You act on these records.'
}

/** The kinds whose records the actor can see somewhere: the sources worth reading for them. */
export function sourcesFor(actor: Actor): AttentionKind[] {
  return ATTENTION_KINDS.filter((kind) => holds(actor, KIND_RULES[kind].view))
}

/** The kinds the actor may act on somewhere: the tiles of Today (0 is an answer). */
export function tileKindsFor(actor: Actor): AttentionKind[] {
  return ATTENTION_KINDS.filter((kind) => holds(actor, KIND_RULES[kind].view) && KIND_RULES[kind].act.some((permission) => holds(actor, permission)))
}

// ---- the row as the viewer gets it ---------------------------------------------------------------------------------------

export interface ItemAmounts {
  readonly currency: string
  readonly netAmount?: number
  readonly purchaseAmount?: number
  readonly marginPct?: string
  readonly marginAmount?: number
}

export interface AttentionItem {
  /** `<kind>:<record id>[:<sub key>]`: stable while the row needs attention. */
  readonly key: string
  readonly kind: AttentionKind
  readonly state: string
  readonly category: Category
  readonly severity: Severity
  readonly severityWord: string
  readonly group: Group
  readonly record: AttentionRecord
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
  readonly sentence: string
  readonly why: string
  readonly blocks: string | null
  readonly due: { readonly date: BusinessDate; readonly days: number; readonly word: 'OVERDUE' | 'TODAY' | 'SOON' | null } | null
  readonly since: Date
  readonly ageDays: number
  readonly decide: DecideMode
  readonly amounts: ItemAmounts | null
}

const DAY_MS = 86_400_000
const dayNumber = (date: BusinessDate): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS
/** Whole days from `from` to `to`. */
export const daysFrom = (from: BusinessDate, to: BusinessDate): number => Math.round(dayNumber(to) - dayNumber(from))

export function dueWord(days: number): 'OVERDUE' | 'TODAY' | 'SOON' | null {
  if (days < 0) return 'OVERDUE'
  if (days === 0) return 'TODAY'
  return days <= SOON_DAYS ? 'SOON' : null
}

/** Now: overdue or urgent; Today: due today, or needs action; This week: due within 7 days, or when you can. */
export function groupOf(severity: Severity, dueDays: number | null): Group {
  if (severity === 'HIGH' || (dueDays !== null && dueDays < 0)) return 'NOW'
  if (dueDays === null) return severity === 'MEDIUM' ? 'TODAY' : 'THIS_WEEK'
  if (dueDays === 0) return 'TODAY'
  return dueDays <= SOON_DAYS ? 'THIS_WEEK' : 'LATER'
}

/** The amounts the reader's grains reach (none: null). The one rule for the row and its sentence. */
export function visibleAmounts(amounts: CandidateAmounts | null | undefined, grains: ReadonlySet<Grain>): ItemAmounts | null {
  if (!amounts) return null
  const shown: { -readonly [Field in keyof ItemAmounts]: ItemAmounts[Field] } = { currency: amounts.currency }
  let any = false
  for (const field of AMOUNT_FIELDS) {
    const value = amounts[field]
    if (value === null || value === undefined || !grains.has(AMOUNT_GRAINS[field])) continue
    ;(shown as Record<string, unknown>)[field] = value
    any = true
  }
  return any ? shown : null
}

/** An amount in words: `EUR 1200.00`, or `margin 18.2 %`. */
export function amountWords(field: AmountField, amounts: ItemAmounts): string | null {
  const value = amounts[field]
  if (value === undefined) return null
  if (field === 'marginPct') return `margin ${new Dec(String(value)).toFixed(1)} %`
  const minor = value as number
  return `${field === 'marginAmount' ? 'margin ' : ''}${amounts.currency} ${fromMinorUnits(minor, amounts.currency).toFixed(minorPlaces(amounts.currency))}`
}

/** The row as the viewer gets it: grouped, due in days, amounts only with their grain (the sentence too). */
export function presentItem(viewer: Viewer, candidate: AttentionCandidate, why: string): AttentionItem {
  const kindRule = KIND_RULES[candidate.kind]
  const amounts = visibleAmounts(candidate.amounts, heldGrains(viewer.actor))
  const field = candidate.amounts?.inSentence
  const quoted = field && amounts ? amountWords(field, amounts) : null
  const days = candidate.due === null ? null : daysFrom(viewer.today, candidate.due)
  return {
    key: `${candidate.kind}:${candidate.record.id}${candidate.subKey ? `:${candidate.subKey}` : ''}`,
    kind: candidate.kind,
    state: candidate.state,
    category: kindRule.category,
    severity: candidate.severity,
    severityWord: SEVERITY_WORDS[candidate.severity],
    group: groupOf(candidate.severity, days),
    record: candidate.record,
    companyId: candidate.scope.companyId,
    siteId: candidate.scope.siteId,
    partyId: candidate.scope.partyId,
    sentence: quoted ? `${candidate.sentence.replace(/[.:]$/, '')} (${quoted}).` : candidate.sentence,
    why,
    blocks: candidate.blocks,
    due: candidate.due === null || days === null ? null : { date: candidate.due, days, word: dueWord(days) },
    since: candidate.since,
    ageDays: Math.max(0, Math.floor((viewer.now.getTime() - candidate.since.getTime()) / DAY_MS)),
    decide: kindRule.decide,
    amounts,
  }
}

/** The viewer's rows of these candidates, ranked. */
export function attentionFor(viewer: Viewer, candidates: readonly AttentionCandidate[]): AttentionItem[] {
  const items: AttentionItem[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const why = whyMine(viewer, candidate)
    if (why === null) continue
    const item = presentItem(viewer, candidate, why)
    if (seen.has(item.key)) continue
    seen.add(item.key)
    items.push(item)
  }
  return items.sort(compareItems)
}

/** The page's company and site filters (the top bar's switcher). */
export interface ScopeFilter {
  readonly companyId?: string | undefined
  /** A site and its company: rows of the site, and the company's rows that belong to no site (an order, an invoice). */
  readonly site?: { readonly id: string; readonly companyId: string } | null | undefined
}

/** Whether a row falls inside the filter. A tenant-wide row (no company: a shared style) belongs to every company. */
export function matchesScope(row: Pick<AttentionScope, 'companyId' | 'siteId'>, filter: ScopeFilter): boolean {
  if (filter.companyId && row.companyId !== null && row.companyId !== filter.companyId) return false
  if (filter.site) {
    if (row.siteId !== null) return row.siteId === filter.site.id
    return row.companyId === null || row.companyId === filter.site.companyId
  }
  return true
}

// ---- rank and pages ---------------------------------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 })
const NO_DUE = '9999-12-31'

/** A row's place in the rank: severity, due date (none last), age (oldest first), key. */
export type RankKey = readonly [number, string, string, string]

export const rankKeyOf = (item: Pick<AttentionItem, 'severity' | 'due' | 'since' | 'key'>): RankKey => [SEVERITY_RANK[item.severity], item.due?.date ?? NO_DUE, item.since.toISOString(), item.key]

export function compareRankKeys(a: RankKey, b: RankKey): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  for (const index of [1, 2, 3] as const) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export const compareItems = (a: AttentionItem, b: AttentionItem): number => compareRankKeys(rankKeyOf(a), rankKeyOf(b))

/** The cursor after a row: its rank key, base64url JSON (opaque to the web). */
export const cursorAfter = (item: AttentionItem): string => Buffer.from(JSON.stringify(rankKeyOf(item))).toString('base64url')

/** The rank key a cursor names, or null for a cursor that is not one. */
export function parseCursor(cursor: string): RankKey | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== 'number' || !value.slice(1).every((part) => typeof part === 'string')) return null
    return value as unknown as RankKey
  } catch {
    return null
  }
}

/**
 * One page of ranked rows after the cursor (rows ranked after the last one shown, so a row decided meanwhile never shifts
 * the next page), with the cursor of the next page.
 */
export function pageOf(items: readonly AttentionItem[], cursor: RankKey | null, limit: number): { readonly items: AttentionItem[]; readonly nextCursor: string | null } {
  const after = cursor === null ? items : items.filter((item) => compareRankKeys(rankKeyOf(item), cursor) > 0)
  const page = after.slice(0, limit)
  return { items: page, nextCursor: after.length > limit ? cursorAfter(page[page.length - 1]!) : null }
}

// ---- the tiles ----------------------------------------------------------------------------------------------------------

export interface AttentionCounts {
  readonly total: number
  /** Overdue or urgent. */
  readonly now: number
  readonly byCategory: Readonly<Record<Category, number>>
  readonly byKind: readonly { readonly kind: AttentionKind; readonly label: string; readonly count: number }[]
}

/** The tiles: one per kind the person acts on (0 is an answer), plus any kind a row has; each count = its rows. */
export function countsOf(items: readonly AttentionItem[], tileKinds: readonly AttentionKind[]): AttentionCounts {
  const byCategory = { APPROVAL: 0, ALERT: 0, TASK: 0 } as Record<Category, number>
  const byKind = new Map<AttentionKind, number>(tileKinds.map((kind) => [kind, 0]))
  for (const item of items) {
    byCategory[item.category] += 1
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1)
  }
  return {
    total: items.length,
    now: items.filter((item) => item.group === 'NOW').length,
    byCategory,
    byKind: ATTENTION_KINDS.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, label: KIND_RULES[kind].label, count: byKind.get(kind)! })),
  }
}

/** Every event any of these kinds refreshes on, sorted (the web's GET /live filter for Today). */
export function liveEventsOf(kinds: readonly AttentionKind[]): EventType[] {
  return [...new Set(kinds.flatMap((kind) => KIND_RULES[kind].live))].sort()
}
