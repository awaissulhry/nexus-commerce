import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import {
  askedSummary,
  cutoffsOf,
  KIND_WORDS,
  REQUEST_STATUS_WORDS,
  type AskedCell,
  type Cutoffs,
  type CutStart,
  type RequestKind,
  type RequestStatus,
  type RuleLine,
  type Words,
} from '@nexus/factory-domain/sales/change-requests/rules'
import type { SalesLineKind } from '@nexus/factory-domain/sales/quotes/quotes'
import { cancelFeeFor, cancelFeePctOf, type CancelFee, type FeeLine } from '@nexus/factory-domain/sales/change-requests/fee'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandTx } from '../../../core/command'

/**
 * The reads of change and cancel requests (B-W2b-183). Two kinds, never mixed in one query:
 *
 *   the customer's own (a portal session: the party's scope, factory_partner_runtime): its orders, lines and sizes, its
 *   requests and their cells, its delivery addresses. Every select names columns the partner role may read (never who
 *   answered a request: `answeredById` has no grant).
 *   the tenant's (the office scope; for a portal session read as the person, only AFTER the partner read found the order):
 *   the cut-off settings (SalesSettings has no party key), the cuts of the order's lines (cut logs, bundles), the CANCEL
 *   reason list, the sizes a style offers in a colourway, the styles' and colourways' names.
 * One query at a time (one connection runs one query at a time).
 */

export type Reader = FactoryClient | CommandTx

/** A calendar day stored as @db.Date. */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)

// ---- the tenant's reads -----------------------------------------------------------------------------------------------------

export const CUTOFF_COLUMNS = { id: true, companyId: true, cancelCutoffStatus: true, cancelCutoffDays: true, changeCutoffStatus: true, cancelFeePct: true, version: true } as const satisfies Prisma.SalesSettingsSelect
export type CutoffRow = Prisma.SalesSettingsGetPayload<{ select: typeof CUTOFF_COLUMNS }>

/**
 * The cut-off rules in force for a company: its own sales settings when it has them, else the tenant's (B-W2b-157: "the
 * company row, else the tenant row"; the row's id is the company's, or the tenant's). No row: no rule.
 */
export async function readCutoffs(db: Reader, tenantId: string, companyId: string | null): Promise<{ cutoffs: Cutoffs; cancelFeePct: string | null; source: 'COMPANY' | 'TENANT' | 'NONE'; company: CutoffRow | null; tenant: CutoffRow | null }> {
  const ids = companyId === null ? [tenantId] : [companyId, tenantId]
  const rows = await db.salesSettings.findMany({ where: { id: { in: ids } }, select: CUTOFF_COLUMNS })
  const company = companyId === null ? null : (rows.find((row) => row.id === companyId && row.companyId === companyId) ?? null)
  const tenant = rows.find((row) => row.id === tenantId && row.companyId === null) ?? null
  // B-W2b-F14: the cancel fee comes with the same row (the company's, else the tenant's; none: free).
  if (company) return { cutoffs: cutoffsOf(company), cancelFeePct: cancelFeePctOf(company.cancelFeePct), source: 'COMPANY', company, tenant }
  if (tenant) return { cutoffs: cutoffsOf(tenant), cancelFeePct: cancelFeePctOf(tenant.cancelFeePct), source: 'TENANT', company, tenant }
  return { cutoffs: cutoffsOf(null), cancelFeePct: null, source: 'NONE', company, tenant }
}

/**
 * The first cut of each line (its work orders' cells, not a REPAIR work order, not a CANCELLED one): a cut of leather logged
 * on the table for a cell (a cut log that was not reversed) or a bundle made of a cell (not VOID, as fabric lays make
 * them). The earliest day wins; on the same day the leather's words.
 */
export async function readCuts(db: Reader, lineIds: readonly string[]): Promise<Map<string, CutStart>> {
  const found = new Map<string, CutStart>()
  if (lineIds.length === 0) return found
  const cells = await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: [...lineIds] }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } }, select: { id: true, salesOrderLineId: true } })
  if (cells.length === 0) return found
  const lineOf = new Map(cells.map((cell) => [cell.id, cell.salesOrderLineId]))
  const cellIds = cells.map((cell) => cell.id)
  const note = (cellId: string, at: Date, leather: boolean) => {
    const lineId = lineOf.get(cellId)
    if (!lineId) return
    const day = businessDate(at)
    const known = found.get(lineId)
    if (!known || day < known.day || (day === known.day && leather && !known.leather)) found.set(lineId, { day, leather })
  }
  const pieces = await db.cutLogPiece.findMany({ where: { workOrderSizeId: { in: cellIds }, pieces: { gt: 0 }, cutLog: { reversalOfId: null, reversals: { none: {} } } }, select: { workOrderSizeId: true, serverTime: true } })
  for (const piece of pieces) note(piece.workOrderSizeId, piece.serverTime, true)
  const bundles = await db.bundle.findMany({ where: { workOrderSizeId: { in: cellIds }, status: { not: 'VOID' } }, select: { workOrderSizeId: true, createdAt: true } })
  for (const bundle of bundles) note(bundle.workOrderSizeId, bundle.createdAt, false)
  return found
}

export interface CancelReason {
  readonly code: string
  readonly words: Words
  readonly needsNote: boolean
}

/** The CANCEL reason list in use (tenant-wide), in its order. */
export async function readCancelReasons(db: Reader): Promise<CancelReason[]> {
  const rows = await db.reasonCode.findMany({ where: { list: 'CANCEL', active: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { code: true, labelIt: true, labelEn: true, needsDetail: true } })
  return rows.map((row) => ({ code: row.code, words: { it: row.labelIt, en: row.labelEn }, needsNote: row.needsDetail }))
}

/** A reason's words (an inactive one too: a request keeps the code it chose). */
export async function reasonWordsOf(db: Reader, codes: readonly string[]): Promise<Map<string, Words>> {
  const wanted = [...new Set(codes)]
  if (wanted.length === 0) return new Map()
  const rows = await db.reasonCode.findMany({ where: { list: 'CANCEL', code: { in: wanted } }, select: { code: true, labelIt: true, labelEn: true } })
  return new Map(rows.map((row) => [row.code, { it: row.labelIt, en: row.labelEn }]))
}

export interface LineCatalogue {
  /** The style's size range, in its order. */
  readonly range: readonly string[]
  /** The sizes the style offers in the line's colourway (an active SKU). */
  readonly offered: ReadonlySet<string>
  readonly style: { readonly code: string; readonly name: string } | null
  readonly colourway: { readonly code: string; readonly name: string } | null
}

/** Per line: its style's range, the sizes offered in its colourway, and the names. */
export async function readCatalogue(db: Reader, lines: readonly { readonly id: string; readonly styleId: string; readonly colourwayId: string }[]): Promise<Map<string, LineCatalogue>> {
  const out = new Map<string, LineCatalogue>()
  if (lines.length === 0) return out
  const styleIds = [...new Set(lines.map((line) => line.styleId))]
  const colourwayIds = [...new Set(lines.map((line) => line.colourwayId))]
  const styles = new Map((await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true, sizes: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const variants = await db.variant.findMany({ where: { styleId: { in: styleIds }, colourwayId: { in: colourwayIds }, status: 'ACTIVE' }, select: { styleId: true, colourwayId: true, size: true } })
  for (const line of lines) {
    const style = styles.get(line.styleId)
    const colourway = colourways.get(line.colourwayId)
    const range = style?.sizes ?? []
    const offered = new Set(variants.filter((row) => row.styleId === line.styleId && row.colourwayId === line.colourwayId && range.includes(row.size)).map((row) => row.size))
    out.set(line.id, { range, offered, style: style ? { code: style.code, name: style.name } : null, colourway: colourway ? { code: colourway.code, name: colourway.name } : null })
  }
  return out
}

// ---- the requests ------------------------------------------------------------------------------------------------------------

/** What the partner role reads of a request (never `answeredById`). */
export const REQUEST_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  orderId: true,
  kind: true,
  reasonCode: true,
  reason: true,
  requestedDate: true,
  shipToAddressId: true,
  status: true,
  answer: true,
  answeredAt: true,
  amendmentId: true,
  withdrawnAt: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.OrderChangeRequestSelect
export type RequestRow = Prisma.OrderChangeRequestGetPayload<{ select: typeof REQUEST_COLUMNS }>

/** The office's read: who answered, too. */
export const OFFICE_REQUEST_COLUMNS = { ...REQUEST_COLUMNS, answeredById: true } as const satisfies Prisma.OrderChangeRequestSelect
export type OfficeRequestRow = Prisma.OrderChangeRequestGetPayload<{ select: typeof OFFICE_REQUEST_COLUMNS }>

/** The cells of these requests, by request, in the order's line order then size. */
export async function readCells(db: Reader, requestIds: readonly string[]): Promise<Map<string, AskedCell[]>> {
  const out = new Map<string, AskedCell[]>()
  if (requestIds.length === 0) return out
  const rows = await db.orderChangeRequestLine.findMany({ where: { requestId: { in: [...requestIds] } }, select: { requestId: true, orderLineId: true, size: true, quantityBefore: true, quantity: true }, orderBy: [{ id: 'asc' }] })
  for (const row of rows) out.set(row.requestId, [...(out.get(row.requestId) ?? []), { orderLineId: row.orderLineId, size: row.size, quantityBefore: row.quantityBefore, quantity: row.quantity }])
  return out
}

/** Locks one request row for its move (FOR UPDATE: the office's answer and the customer's withdrawal wait for each other). */
export async function lockRequest(tx: CommandTx, requestId: string): Promise<void> {
  await tx.$queryRaw`SELECT r.id FROM "OrderChangeRequest" r WHERE r.id = ${requestId}::uuid FOR UPDATE`
}

/** One line of the order as a request shows it. */
export interface ShownLine {
  readonly id: string
  readonly seq: number
  readonly kind: SalesLineKind
  readonly styleId: string
  readonly colourwayId: string
  readonly closedShortQuantity: number | null
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
}

/** The rule's view of the order's lines (sizes and the first cut). */
export const ruleLinesOf = (lines: readonly ShownLine[], cuts: ReadonlyMap<string, CutStart>): RuleLine[] =>
  lines.map((line) => ({ id: line.id, seq: line.seq, kind: line.kind, closedShort: line.closedShortQuantity !== null, sizes: line.sizes.map(({ size, quantity }) => ({ size, quantity })), cut: cuts.get(line.id) ?? null }))

export interface AddressRow {
  readonly id: string
  readonly name: string | null
  readonly line1: string
  readonly postalCode: string
  readonly city: string
  readonly country: string
}

/** "Warehouse Nord, Via Roma 1, 20100 Milano (IT)". */
export const addressLabel = (row: AddressRow): string => `${row.name ? `${row.name}, ` : ''}${row.line1}, ${row.postalCode} ${row.city} (${row.country})`

const ADDRESS_COLUMNS = { id: true, name: true, line1: true, postalCode: true, city: true, country: true } as const satisfies Prisma.PartyAddressSelect

/** The party's delivery addresses in use (SHIP_TO, ACTIVE). */
export const readShipTos = (db: Reader, partyId: string): Promise<AddressRow[]> =>
  db.partyAddress.findMany({ where: { partyId, status: 'ACTIVE', kinds: { has: 'SHIP_TO' } }, select: ADDRESS_COLUMNS, orderBy: [{ name: 'asc' }, { line1: 'asc' }, { id: 'asc' }] })

/** These addresses by id (any status: a request keeps the one it asked for). */
export async function addressesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, AddressRow>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.partyAddress.findMany({ where: { id: { in: wanted } }, select: ADDRESS_COLUMNS })).map((row) => [row.id, row]))
}

// ---- the views ---------------------------------------------------------------------------------------------------------------

/** B-W2b-F14: what a waiting cancel request's fee is read from (the order's lines and currency, the percent in force now). */
export interface FeeFacts {
  readonly pct: string | null
  readonly currency: string
  readonly lines: readonly FeeLine[]
}

export interface ViewFacts {
  readonly orderNumber: string
  readonly customerRef: string | null
  readonly lines: ReadonlyMap<string, { readonly seq: number; readonly styleId: string; readonly colourwayId: string }>
  /** B-W2b-F14: the fee facts of the request's order (none: no fee shown). */
  readonly fee?: FeeFacts | null
  readonly names: { readonly styles: ReadonlyMap<string, { readonly code: string; readonly name: string }>; readonly colourways: ReadonlyMap<string, { readonly code: string; readonly name: string }> }
  readonly addresses: ReadonlyMap<string, AddressRow>
  readonly reasons: ReadonlyMap<string, Words>
}

/** A request as both audiences see it (the office adds its own fields). */
export function requestView(row: RequestRow, cells: readonly AskedCell[], facts: ViewFacts) {
  const kind = row.kind as RequestKind
  const status = row.status as RequestStatus
  const summary = askedSummary(kind, cells, { requestedDate: dayOrNull(row.requestedDate), shipToAddressId: row.shipToAddressId })
  const shipTo = row.shipToAddressId ? (facts.addresses.get(row.shipToAddressId) ?? null) : null
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: facts.orderNumber,
    customerRef: facts.customerRef,
    kind,
    kindWords: KIND_WORDS[kind],
    status,
    words: REQUEST_STATUS_WORDS[status],
    askedAt: toUtcIso(row.createdAt),
    cells: [...cells]
      .map((cell) => {
        const line = facts.lines.get(cell.orderLineId)
        const style = line ? facts.names.styles.get(line.styleId) : undefined
        const colourway = line ? facts.names.colourways.get(line.colourwayId) : undefined
        return { lineId: cell.orderLineId, seq: line?.seq ?? 0, style: style ? { code: style.code, name: style.name } : null, colourway: colourway ? { code: colourway.code, name: colourway.name } : null, size: cell.size, before: cell.quantityBefore, asked: cell.quantity }
      })
      .sort((a, b) => a.seq - b.seq),
    wholeOrder: summary.wholeOrder,
    requestedDate: dayOrNull(row.requestedDate),
    shipTo: row.shipToAddressId ? { id: row.shipToAddressId, label: shipTo ? addressLabel(shipTo) : row.shipToAddressId } : null,
    reasonCode: row.reasonCode,
    reasonWords: row.reasonCode ? (facts.reasons.get(row.reasonCode) ?? { it: row.reasonCode, en: row.reasonCode }) : null,
    note: row.reason,
    answer: row.answer,
    answeredAt: row.answeredAt ? toUtcIso(row.answeredAt) : null,
    withdrawnAt: row.withdrawnAt ? toUtcIso(row.withdrawnAt) : null,
    // B-W2b-F14: a waiting cancel's fee as the settings say it now (not stored on the request: shown while it waits).
    cancelFee: kind === 'CANCEL' && status === 'OPEN' && facts.fee ? feeView(cancelFeeFor(facts.fee.lines, cells.map((cell) => cell.orderLineId), facts.fee.pct, facts.fee.currency)) : null,
    version: row.version,
  }
}

/** A cancel fee as the answers carry it: the amounts are prices (dropped for a reader without the grain). */
export const feeView = (fee: CancelFee) => ({
  pct: fee.pct,
  words: fee.words,
  currency: fee.currency,
  lines: fee.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, fee: asMoney('price', line.fee) })),
  totalFee: asMoney('price', fee.totalFee),
})

/** The fee facts of an order's lines (any reader that read their net values and closed-short quantities). */
export const feeLinesOf = (lines: readonly { readonly id: string; readonly seq: number; readonly netAmount: number; readonly closedShortQuantity: number | null }[]): FeeLine[] =>
  lines.map((line) => ({ id: line.id, seq: line.seq, netAmount: line.netAmount, closedShort: line.closedShortQuantity !== null }))

/** The events after which a request's screens read again. */
export const LIVE_EVENTS = ['order_change_request.asked', 'order_change_request.withdrawn', 'order_change_request.answered', 'sales_order.amended', 'sales_order.status_changed'] as const
