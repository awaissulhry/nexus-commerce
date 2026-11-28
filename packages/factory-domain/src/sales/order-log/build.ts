import { orderLifeOf, type OrderLife } from '../order-life'
import type { SalesOrderStatus } from '../orders/orders'
import type { RequestStatus } from '../portal-ordering/rules'
import { actionFaceOf, customerMayRead, PICTURE_SET_ACTION, whoFaceOf, type FaceGate, type LogAudience, type LogDoor, type OrderLogAction, type WhoOfRow } from './faces'

/**
 * The ONE order log's builder (owb- order workflow, b3.1; research R-base D): the AuditLog rows of ONE order's records (the
 * order, its lines, its request and the request's lines, its shipments, its files) → the rows a reader of one door sees, each
 * with its face (./faces whoFaceOf), ONE word and icon (actionFaceOf), its subject and a from → to in typed values. Pure: the
 * API reads the rows (tenant scope, ONE record's ids, after the brand wall), the names and the subjects' labels.
 *
 *   values   only typed values the reader may see: a life word (an order's or a request's status said as one of the nine),
 *            a date (a promise moved), a count (lines added), a picture (its file id), a department; never a raw `after`, a
 *            price, a cost or an office note — by construction no money reaches a log value, whatever the reader's grains
 *   reason   the office's only; always null for the portal and the floor
 *   portal   only the rows customerMayRead allows (the ALLOW-list; own-rows-only actions written by its own people), only the
 *            customer-facing record types, and a FILE subject only when the file is shared with the customer
 *   order    newest first (at, then id); the API pages with the cursor of the last row (encodeLogCursor)
 */

export const LOG_SUBJECT_KINDS = ['ORDER', 'LINE', 'SHIPMENT', 'FILE', 'BASKET', 'REQUEST'] as const
export type LogSubjectKind = (typeof LOG_SUBJECT_KINDS)[number]

/** The audit record type of each subject kind (what the API asks the per-record audit index for). */
export const SUBJECT_OF_RECORD_TYPE: Readonly<Record<string, LogSubjectKind>> = Object.freeze({
  SalesOrder: 'ORDER',
  SalesOrderLine: 'LINE',
  PortalOrderRequest: 'REQUEST',
  PortalOrderRequestLine: 'LINE',
  Shipment: 'SHIPMENT',
  StoredFile: 'FILE',
  Bundle: 'BASKET',
})

/** The record types a customer's log may hold (never a basket: the floor's). */
export const CUSTOMER_RECORD_TYPES: ReadonlySet<string> = new Set(['SalesOrder', 'SalesOrderLine', 'PortalOrderRequest', 'PortalOrderRequestLine', 'Shipment', 'StoredFile'])

export type LogValue =
  | { readonly kind: 'LIFE'; readonly life: OrderLife }
  | { readonly kind: 'DEPT'; readonly no: number }
  | { readonly kind: 'DATE'; readonly date: string }
  | { readonly kind: 'TEXT'; readonly text: string }
  | { readonly kind: 'COUNT'; readonly n: number }
  | { readonly kind: 'PICTURE'; readonly fileId: string | null }

export interface OrderLogRow {
  readonly id: string
  readonly at: string
  readonly who: WhoOfRow
  readonly action: OrderLogAction
  readonly icon: string
  readonly subject: { readonly kind: LogSubjectKind; readonly label: string | null }
  readonly from: LogValue | null
  readonly to: LogValue | null
  readonly reason: string | null
}

export interface OrderLogAnswer {
  readonly rows: readonly OrderLogRow[]
  readonly nextCursor: string | null
}

/** One audit row as the API read it. */
export interface LogAuditRow {
  readonly id: string
  /** ISO time (UTC, toUtcIso). */
  readonly at: string
  readonly audience: LogAudience
  readonly actorId: string
  readonly action: string
  readonly recordType: string
  readonly recordId: string
  readonly before: unknown
  readonly after: unknown
  readonly reason: string | null
}

export interface LogContext {
  readonly door: LogDoor
  readonly gate: FaceGate
  /** Names by actor id: office users, customer people; a worker's only where the gate is open (else leave it out). */
  readonly names: ReadonlyMap<string, string>
  /** The party of each partner or link actor (the customer reads its own colleagues by name, and its own rows). */
  readonly actorParties: ReadonlyMap<string, string>
  /** The floor rows whose worker stays unnamed (the site's PERFORMANCE gate is not open): never a name, the department. */
  readonly hiddenWorkerRows?: ReadonlySet<string>
  /** The department number of a floor row, by audit row id (S5 fills it for basket rows); absent: none known. */
  readonly departments?: ReadonlyMap<string, number>
  /** The label of each subject record, by record id ("Line 2 · JK-100", "SH-0012", a file's name); absent: null. */
  readonly labels?: ReadonlyMap<string, string>
  /** portal: the files shared with the customer — a FILE subject (or a PICTURE value) outside it is dropped / blanked. */
  readonly visibleFileIds?: ReadonlySet<string>
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
const DAY = /^\d{4}-\d{2}-\d{2}/

const SALES_ORDER_STATUS_SET: ReadonlySet<string> = new Set(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED', 'CANCELLED', 'PENDING_APPROVAL', 'DELIVERED'])
const REQUEST_STATUS_SET: ReadonlySet<string> = new Set(['DRAFT', 'SENT', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'])

/** A status written on an order's or a request's audit row, said as one of the nine. */
function lifeValue(recordType: string, status: unknown): LogValue | null {
  if (typeof status !== 'string') return null
  if (recordType === 'SalesOrder' && SALES_ORDER_STATUS_SET.has(status)) return { kind: 'LIFE', life: orderLifeOf({ order: { status: status as SalesOrderStatus } }).life }
  if (recordType === 'PortalOrderRequest' && REQUEST_STATUS_SET.has(status)) return { kind: 'LIFE', life: orderLifeOf({ request: { status: status as RequestStatus } }).life }
  if (recordType === 'Shipment' && status === 'SHIPPED') return { kind: 'LIFE', life: 'SHIPPED' }
  if (recordType === 'Shipment' && status === 'DELIVERED') return { kind: 'LIFE', life: 'DELIVERED' }
  return null
}

const dateValue = (value: unknown): LogValue | null => (typeof value === 'string' && DAY.test(value) ? { kind: 'DATE', date: value.slice(0, 10) } : null)

/** The from → to of one row, in typed values only (never a raw value of the row). */
export function valuesOf(row: Pick<LogAuditRow, 'action' | 'recordType' | 'before' | 'after'>): { from: LogValue | null; to: LogValue | null } {
  const before = record(row.before)
  const after = record(row.after)
  if (row.action === 'orders.changePromise') return { from: dateValue(after.previous ?? before.promiseDate), to: dateValue(after.promiseDate) }
  if (row.action === PICTURE_SET_ACTION) return { from: { kind: 'PICTURE', fileId: text(before.pictureFileId) }, to: { kind: 'PICTURE', fileId: text(after.pictureFileId) } }
  if (row.action === 'portalOrdering.addLines' || row.action === 'portalOrdering.reorder') {
    const added = Array.isArray(after.lines) ? after.lines.length : typeof after.added === 'number' ? after.added : Array.isArray(after.added) ? after.added.length : null
    return { from: null, to: added === null ? null : { kind: 'COUNT', n: added } }
  }
  const from = lifeValue(row.recordType, before.status)
  const to = lifeValue(row.recordType, after.status)
  return { from, to }
}

/** A reader of the portal may read this row: a customer record type, an allowed action, a shared file. */
function portalKeeps(row: LogAuditRow, context: LogContext): boolean {
  const viewer = context.gate.viewerPartyId
  if (!viewer || !CUSTOMER_RECORD_TYPES.has(row.recordType)) return false
  if (!customerMayRead({ action: row.action, audience: row.audience, actorPartyId: context.actorParties.get(row.actorId) ?? null }, viewer)) return false
  if (row.recordType === 'StoredFile') return context.visibleFileIds?.has(row.recordId) ?? false
  return true
}

/** A PICTURE value the portal may not open becomes "no picture" (the file id never reaches the customer). */
function shownValue(value: LogValue | null, context: LogContext): LogValue | null {
  if (!value || value.kind !== 'PICTURE' || context.door !== 'portal' || value.fileId === null) return value
  return context.visibleFileIds?.has(value.fileId) ? value : { kind: 'PICTURE', fileId: null }
}

/** The rows a reader of `context.door` sees, newest first. */
export function buildOrderLog(rows: readonly LogAuditRow[], context: LogContext): OrderLogRow[] {
  const kept = context.door === 'portal' ? rows.filter((row) => portalKeeps(row, context)) : rows
  return [...kept]
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
    .map((row) => {
      const face = actionFaceOf(row.action)
      const who = whoFaceOf(
        {
          audience: row.audience,
          actorId: row.actorId,
          actorName: row.audience === 'FLOOR' && context.hiddenWorkerRows?.has(row.id) ? null : (context.names.get(row.actorId) ?? null),
          actorPartyId: context.actorParties.get(row.actorId) ?? null,
          departmentNo: context.departments?.get(row.id) ?? null,
        },
        context.door,
        context.gate,
      )
      const values = valuesOf(row)
      return {
        id: row.id,
        at: row.at,
        who,
        action: face.key,
        icon: face.icon,
        subject: { kind: SUBJECT_OF_RECORD_TYPE[row.recordType] ?? 'ORDER', label: context.labels?.get(row.recordId) ?? null },
        from: shownValue(values.from, context),
        to: shownValue(values.to, context),
        reason: context.door === 'office' ? row.reason : null,
      }
    })
}

// ---- the cursor ---------------------------------------------------------------------------------------------------------------

/** The page cursor after a row: its time in milliseconds and its id (rows are read newest first by at, then id). */
export function encodeLogCursor(row: { readonly at: string; readonly id: string }): string {
  return `${Date.parse(row.at)}_${row.id}`
}

/** The cursor's time and id; null for a cursor that is not one of ours. */
export function decodeLogCursor(cursor: string | null | undefined): { readonly at: Date; readonly id: string } | null {
  const match = /^(\d{1,15})_([0-9a-f-]{36})$/i.exec(cursor ?? '')
  if (!match) return null
  const at = new Date(Number(match[1]))
  return Number.isNaN(at.getTime()) ? null : { at, id: match[2]!.toLowerCase() }
}
