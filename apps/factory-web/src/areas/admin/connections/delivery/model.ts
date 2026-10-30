import { recordAddress } from '../../../../lib/records/record-links'
import { bulkHeld, reachOf, type BulkNotice, type Reach } from '../../kit/bulk-model'
import type { Ledger } from '../model'
import { DELIVERY_STATES } from '@nexus/factory-domain/email-delivery/rules'
import type { BlockedAddress, DeliveryCounts, DeliveryMail, DeliveryQuery, DeliveryRecord, DeliveryState } from './api'

/**
 * SCR-087 "Delivery log and blocked addresses" (design admin.connections sec:delivery; B-W2a-41, PLT-149): every mail the
 * factory sent with where it is — waiting, sent, delivered, a problem (it bounced or the recipient complained: the address
 * is blocked) or failed — what it is about (its record, a link), to whom (masked unless the person manages that company's
 * mail) and, for a problem, what the provider said; bounced invoices and mail that carried a one-off link have their own
 * filters so they are never missed. Below, the addresses no mail goes to, why and since when, with Unblock (one confirm
 * with a reason; each address one call with its version). Pure: the tests hold every rule.
 */

/** The log's filters: a state (the tiles), or what the mail is about. */
export const ABOUT_FILTERS = ['INVOICES', 'LINKS'] as const
export type AboutFilter = (typeof ABOUT_FILTERS)[number]
export type DeliveryFilter = DeliveryState | AboutFilter | null

export const isState = (filter: DeliveryFilter): filter is DeliveryState => filter !== null && (DELIVERY_STATES as readonly string[]).includes(filter)

/** The API's query for a filter. */
export function queryOf(filter: DeliveryFilter): Pick<DeliveryQuery, 'state' | 'about'> {
  if (filter === null) return {}
  return isState(filter) ? { state: filter } : { about: filter }
}

/** The pill of a state. */
export const STATE_TONE: Readonly<Record<DeliveryState, 'neutral' | 'info' | 'success' | 'danger' | 'warning'>> = {
  WAITING: 'neutral',
  SENT: 'info',
  DELIVERED: 'success',
  PROBLEM: 'danger',
  FAILED: 'warning',
}

/** The record types the log names in words (`conn.delivery.recordType.<type>`); another one is "a record". */
export const KNOWN_RECORD_TYPES = ['Quote', 'SalesOrder', 'PurchaseOrder', 'Invoice', 'Shipment', 'DepositRequest', 'GoodsReceipt', 'Party', 'WorkOrder'] as const
export const recordTypeKey = (type: string): string => ((KNOWN_RECORD_TYPES as readonly string[]).includes(type) ? `conn.delivery.recordType.${type}` : 'conn.delivery.recordType.other')

/** The one-off links a mail may carry (`conn.delivery.link.<purpose>`); another one is "a link". */
export const KNOWN_LINKS = ['QUOTE_ACCEPT', 'PO_CONFIRM', 'DOCUMENT_VIEW', 'DEPOSIT_INFO'] as const
export const linkKey = (purpose: string): string => ((KNOWN_LINKS as readonly string[]).includes(purpose) ? `conn.delivery.link.${purpose}` : 'conn.delivery.link.other')

/**
 * Where a mail's record opens (with the address's company prefix), or null: a sign-in mail and the digest are about a
 * person (never linked from here), and a mail without a record has nothing to open.
 */
export function recordHref(prefix: string, record: DeliveryRecord | null, companyId: string | null, built: ReadonlySet<string>): string | null {
  if (!record || record.type === 'User') return null
  return `${prefix}${recordAddress({ type: record.type, id: record.id, ...(record.label ? { label: record.label } : {}), companyId }, built)}`
}

/** The record's chip: its number, else its type and the end of its id (never empty). */
export const recordName = (record: DeliveryRecord): string => record.label ?? `${record.type} ${record.id.slice(-6)}`

/** Problems are said in words for a person; the provider's own words are kept as data (quoted) beside them. */
export function problemKeyOf(mail: Pick<DeliveryMail, 'state' | 'status'>): string | null {
  if (mail.status === 'BOUNCED') return 'conn.delivery.problem.bounced'
  if (mail.status === 'COMPLAINED') return 'conn.delivery.problem.complained'
  if (mail.status === 'FAILED') return 'conn.delivery.problem.failed'
  return null
}

/** The tiles' numbers (last 30 days), or "—" while unknown. */
export const tileValue = (counts: DeliveryCounts | null, state: DeliveryState): string => (counts ? String(counts[state]) : '—')

// ---- the blocked addresses ----

/** An unblocked row is the record of one: nothing more to do with it. */
export const blockedSelectable = (row: BlockedAddress): string | null => (row.unblocked ? 'conn.blocked.noSelect' : null)

/** Which selected addresses "Unblock N" applies to: the blocked ones (an unblocked one is left out with the reason). */
export function unblockReach(rows: readonly BlockedAddress[]): Reach<BlockedAddress> {
  return reachOf(rows, (row) => (row.unblocked ? 'conn.blocked.left.unblocked' : null))
}

/** Why "Unblock N" is held (a key), or null: the right is over every company, so a narrower grant cannot. */
export const unblockHeld = (reach: Pick<Reach<unknown>, 'applies'>, canUnblock: boolean): string | null =>
  bulkHeld(reach, canUnblock, { right: 'conn.blocked.heldRight', none: 'conn.blocked.noneToUnblock' })

export const REASON_MIN = 3

/** The reason a person gives: required, at least three letters (the API keeps it with the change). */
export function reasonProblem(reason: string): string | null {
  return reason.trim().length < REASON_MIN ? 'conn.blocked.reasonShort' : null
}

/** A complaint means the person asked for no mail: the confirm warns before it lets mail reach them again. */
export const hasComplaint = (rows: readonly BlockedAddress[]): boolean => rows.some((row) => row.reason === 'COMPLAINT')

/** The result notice's keys. */
export const UNBLOCK_NOTICE = { done: 'conn.blocked.unblockedDone', partial: 'conn.blocked.unblockedPartial', failed: 'conn.blocked.unblockedFailed' } as const

export type BlockedView = 'BLOCKED' | 'UNBLOCKED'

export interface DeliveryModel {
  /** The log's pages (newest first; `more` = the next page's anchor). */
  mails: Ledger<DeliveryMail>
  /** Per state over 30 days; null while the first read runs. */
  counts: DeliveryCounts | null
  /** Addresses blocked now. */
  blockedCount: number | null
  filter: DeliveryFilter
  blocked: Ledger<BlockedAddress>
  blockedView: BlockedView
  /** email.delivery.unblock over every company (the API says). */
  canUnblock: boolean
  /** Ticked blocked addresses (ids). */
  selected?: readonly string[]
  /** The unblock confirm, open for these ids. */
  confirm?: readonly string[] | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: BulkNotice | null
}

/** What the section asks of its container (use-delivery.ts). */
export interface DeliveryActions {
  onFilter?: (filter: DeliveryFilter) => void
  onMore?: () => void
  onRetry?: () => void
  onBlockedView?: (view: BlockedView) => void
  onBlockedMore?: () => void
  onBlockedRetry?: () => void
  onSelect?: (ids: string[]) => void
  /** Opens (ids) or closes (null) the unblock confirm. */
  onConfirm?: (ids: readonly string[] | null) => void
  /** Unblocks these addresses with the reason, one call each. */
  onUnblock?: (rows: readonly BlockedAddress[], reason: string) => Promise<void> | void
  onDismissNotice?: () => void
}
