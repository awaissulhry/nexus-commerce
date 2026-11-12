import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { LineView, PlaceRef, ReasonOption, SiteRef, TransferRow, TransferView } from '@nexus/factory-domain/inventory/transfers/contracts'
import { INVENTORY_TRANSFERS_MANAGE } from '@nexus/factory-domain/inventory/transfers/permissions'
import {
  differenceOf,
  inTransitOf,
  isLate,
  lineStateOf,
  openDifference,
  quantityOut,
  transferActions,
  type FieldProblem,
  type TransferProblem,
  type TransferStatus,
} from '@nexus/factory-domain/inventory/transfers/rules'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { standardReasonsOf } from '@nexus/factory-domain/reasons/standard'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { reasonWords } from '../../../platform/reasons/service'

/**
 * Transfers' rows (B-W2b-326; factory-db warehouse-depth.prisma TransferOrder + TransferLine, B-W2b-277): the columns every
 * read names, who may see and act on which, the balances a line reads, and how rows become the contracts' views. A transfer
 * belongs to two sites (and maybe two companies): the caller SEES it with inventory.stock.view at either one; it ships,
 * edits and cancels with inventory.transfers.manage at the SENDING site, and receives and settles with it at the RECEIVING
 * site. A transfer the caller may not see is not found.
 */

export type Reader = FactoryClient | CommandTx

/** A transfer step refused in words: 409 `conflict` with one issue `refusal/<CODE>` per problem. */
export class TransferRefusedError extends ConflictError {
  override name = 'TransferRefusedError'
  override readonly issues: readonly Issue[]
  constructor(problems: readonly TransferProblem[]) {
    super(problems.map((entry) => entry.message).join(' '))
    this.issues = problems.map((entry) => ({ path: `refusal/${entry.code}`, message: entry.message }))
  }
}

export function refuse(problems: readonly TransferProblem[]): void {
  if (problems.length > 0) throw new TransferRefusedError(problems)
}

/** Field problems as a 400 (paths `body/<field>`). */
export function invalid(fields: readonly FieldProblem[]): void {
  if (fields.length === 0) return
  throw new ValidationError(fields.length === 1 ? fields[0]!.message : 'The transfer is not valid as it stands.', fields.map((field) => ({ path: `body/${field.path}`, message: field.message })))
}

// ---- columns ------------------------------------------------------------------------------------------------------------

const SITE = { select: { id: true, code: true, name: true, status: true, companyId: true, address: true, company: { select: { legalName: true, tradeName: true } } } } as const
const PLACE = { select: { id: true, code: true, name: true } } as const

export const TRANSFER_SELECT = {
  id: true,
  companyId: true,
  number: true,
  fromSiteId: true,
  fromLocationId: true,
  toCompanyId: true,
  toSiteId: true,
  toLocationId: true,
  transitLocationId: true,
  status: true,
  shipOn: true,
  expectedOn: true,
  ddtNumberSeriesId: true,
  ddtNumber: true,
  ddtDate: true,
  ddtReason: true,
  ddtReasonText: true,
  transportBy: true,
  carrier: true,
  packages: true,
  grossWeightKg: true,
  appearance: true,
  ddtFileId: true,
  trackingRef: true,
  trackingUrl: true,
  shippedAt: true,
  receivedAt: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  fromSite: SITE,
  toSite: SITE,
  fromLocation: PLACE,
  toLocation: PLACE,
  transitLocation: PLACE,
} as const satisfies Prisma.TransferOrderSelect
export type TransferRowData = Prisma.TransferOrderGetPayload<{ select: typeof TRANSFER_SELECT }>

export const LINE_SELECT = {
  id: true,
  transferId: true,
  fromSiteId: true,
  toSiteId: true,
  seq: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  fromLocationId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  shippedQuantity: true,
  receivedQuantity: true,
  toLocationId: true,
  toLotId: true,
  toHideId: true,
  differenceReasonCode: true,
  differenceNote: true,
  differenceResolution: true,
  resolvedAt: true,
  note: true,
  version: true,
  item: { select: { id: true, code: true, name: true, baseUom: true, tracking: true } },
  itemColour: { select: { id: true, code: true, name: true } },
  lot: { select: { id: true, code: true, qualityStatus: true } },
  hide: { select: { id: true, code: true } },
  fromLocation: PLACE,
  toLocation: PLACE,
  toLot: { select: { id: true, code: true } },
  toHide: { select: { id: true, code: true } },
} as const satisfies Prisma.TransferLineSelect
export type LineRowData = Prisma.TransferLineGetPayload<{ select: typeof LINE_SELECT }>

export const dayOf = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
export const toDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
export const today = (now: Date = new Date()): BusinessDate => businessDate(now)
const text = (value: Prisma.Decimal | null): string | null => (value === null ? null : quantityOut(new Dec(value.toString())))
export const decOf = (value: Prisma.Decimal | string | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))

// ---- who sees and acts ------------------------------------------------------------------------------------------------

type Ends = Pick<TransferRowData, 'companyId' | 'fromSiteId' | 'toCompanyId' | 'toSiteId'>

export const fromScope = (row: Ends) => ({ companyId: row.companyId, siteId: row.fromSiteId })
export const toScope = (row: Ends) => ({ companyId: row.toCompanyId, siteId: row.toSiteId })

export function mayAt(context: OfficeContext, permission: Permission, scope: { readonly companyId: string; readonly siteId: string }): boolean {
  return can(actorOf(context), permission, scope)
}

export const sees = (context: OfficeContext, row: Ends): boolean => mayAt(context, INVENTORY_STOCK_VIEW, fromScope(row)) || mayAt(context, INVENTORY_STOCK_VIEW, toScope(row))
export const managesFrom = (context: OfficeContext, row: Ends): boolean => mayAt(context, INVENTORY_TRANSFERS_MANAGE, fromScope(row))
export const managesTo = (context: OfficeContext, row: Ends): boolean => mayAt(context, INVENTORY_TRANSFERS_MANAGE, toScope(row))

/** The transfer the caller may see, or not found. */
export async function visibleTransfer(client: Reader, context: OfficeContext, transferId: string): Promise<TransferRowData> {
  if (!isUuid(transferId)) throw new NotFoundError('Transfer not found.')
  const row = await client.transferOrder.findUnique({ where: { id: transferId }, select: TRANSFER_SELECT })
  if (!row || !sees(context, row)) throw new NotFoundError('Transfer not found.')
  return row
}

/** The sending (or receiving) end's right, else 403 in words. */
export function mustManage(context: OfficeContext, row: Ends, end: 'from' | 'to'): void {
  if (end === 'from' ? !managesFrom(context, row) : !managesTo(context, row)) {
    throw new ForbiddenError(`This needs ${INVENTORY_TRANSFERS_MANAGE} at the ${end === 'from' ? 'sending' : 'receiving'} site.`)
  }
}

/** The sites the caller sees stock at (the list's scope). */
export async function visibleSites(client: Reader, context: OfficeContext): Promise<{ id: string; companyId: string }[]> {
  const sites = await client.site.findMany({ select: { id: true, companyId: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  return sites.filter((site) => mayAt(context, INVENTORY_STOCK_VIEW, { companyId: site.companyId, siteId: site.id }))
}

// ---- balances ---------------------------------------------------------------------------------------------------------------

export interface StockKeyAt {
  readonly locationId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
}

export const keyText = (key: StockKeyAt): string => [key.locationId, key.itemId, key.itemColourId ?? '-', key.lotId ?? '-', key.hideId ?? '-'].join('|')

/** What each place of a site holds per stock key (moves in − moves out), for the keys `where` narrows to. */
export async function balancesAt(client: Reader, siteId: string, where: Prisma.StockMoveWhereInput = {}): Promise<Map<string, Decimal>> {
  const base: Prisma.StockMoveWhereInput = { AND: [{ siteId }, where] }
  const into = await client.stockMove.groupBy({ by: ['toLocationId', 'itemId', 'itemColourId', 'lotId', 'hideId'], where: { AND: [base, { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
  const out = await client.stockMove.groupBy({ by: ['fromLocationId', 'itemId', 'itemColourId', 'lotId', 'hideId'], where: { AND: [base, { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
  const balances = new Map<string, Decimal>()
  const add = (key: StockKeyAt, value: Decimal) => balances.set(keyText(key), (balances.get(keyText(key)) ?? ZERO).plus(value))
  for (const row of into) add({ locationId: row.toLocationId!, itemId: row.itemId, itemColourId: row.itemColourId, lotId: row.lotId, hideId: row.hideId }, decOf(row._sum.baseQuantity))
  for (const row of out) add({ locationId: row.fromLocationId!, itemId: row.itemId, itemColourId: row.itemColourId, lotId: row.lotId, hideId: row.hideId }, decOf(row._sum.baseQuantity).negated())
  return balances
}

/** The moves that name these lines, per line. */
export async function lineMoves(client: Reader, lineIds: readonly string[]) {
  const moves = lineIds.length === 0
    ? []
    : await client.stockMove.findMany({
        where: { transferLineId: { in: [...lineIds] } },
        select: { id: true, transferLineId: true, reason: true, fromLocationId: true, toLocationId: true, baseQuantity: true, reversalOfId: true, siteId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
  const byLine = new Map<string, typeof moves>()
  for (const move of moves) byLine.set(move.transferLineId!, [...(byLine.get(move.transferLineId!) ?? []), move])
  return byLine
}

/** What of each line lies on the transit place now. */
export async function inTransitByLine(client: Reader, transitLocationId: string, lineIds: readonly string[]): Promise<Map<string, Decimal>> {
  const byLine = await lineMoves(client, lineIds)
  return new Map(lineIds.map((lineId) => [lineId, inTransitOf((byLine.get(lineId) ?? []).map((move) => ({ fromLocationId: move.fromLocationId, toLocationId: move.toLocationId, baseQuantity: move.baseQuantity.toString() })), transitLocationId)]))
}

/** The active codes of the DISCREPANCY list (a tenant whose list is still empty: the standard codes). */
export async function differenceReasons(client: Reader): Promise<ReasonOption[]> {
  const words = await reasonWords(client as CommandTx, 'DISCREPANCY')
  const active = [...words.values()].filter((fact) => fact.active)
  if (words.size === 0) return standardReasonsOf('DISCREPANCY').map((reason) => ({ code: reason.code, labelIt: reason.labelIt, labelEn: reason.labelEn }))
  return active.map((fact) => ({ code: fact.code, labelIt: fact.labelIt, labelEn: fact.labelEn }))
}

// ---- views --------------------------------------------------------------------------------------------------------------------

type SiteData = TransferRowData['fromSite']
const siteRef = (site: SiteData): SiteRef => ({ id: site.id, code: site.code, name: site.name, companyId: site.companyId, companyName: site.company.tradeName ?? site.company.legalName })
const placeRef = (place: { id: string; code: string; name: string } | null): PlaceRef | null => (place ? { id: place.id, code: place.code, name: place.name } : null)

type ListLines = Pick<LineRowData, 'shippedQuantity' | 'receivedQuantity' | 'differenceReasonCode' | 'resolvedAt'>[]

const figuresOf = (line: Pick<LineRowData, 'shippedQuantity' | 'receivedQuantity' | 'differenceReasonCode' | 'resolvedAt'>, inTransit: Decimal = ZERO) => ({
  shippedQuantity: text(line.shippedQuantity),
  receivedQuantity: text(line.receivedQuantity) ?? '0',
  inTransit: quantityOut(inTransit),
  differenceReasonCode: line.differenceReasonCode,
  resolvedAt: line.resolvedAt ? toUtcIso(line.resolvedAt) : null,
})

export const openDifferencesOf = (lines: ListLines): number => lines.filter((line) => openDifference(figuresOf(line, ZERO))).length

export function rowView(row: TransferRowData, lines: ListLines, day: BusinessDate): TransferRow {
  return {
    id: row.id,
    number: row.number,
    status: row.status as TransferStatus,
    from: siteRef(row.fromSite),
    to: siteRef(row.toSite),
    interCompany: row.companyId !== row.toCompanyId,
    lines: lines.length,
    shipOn: dayOf(row.shipOn),
    expectedOn: dayOf(row.expectedOn),
    ddtNumber: row.ddtNumber,
    ddtDate: dayOf(row.ddtDate),
    differences: openDifferencesOf(lines),
    late: isLate({ status: row.status as TransferStatus, expectedOn: dayOf(row.expectedOn) }, day),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
  }
}

/** The record as the caller sees it now: lines with what is in transit, the DDT, the actions held with their reason. */
export async function recordView(client: Reader, context: OfficeContext, row: TransferRowData, now: Date = new Date()): Promise<TransferView> {
  const lines = await client.transferLine.findMany({ where: { transferId: row.id }, select: LINE_SELECT, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  const status = row.status as TransferStatus
  const transit = await inTransitByLine(client, row.transitLocationId, lines.map((line) => line.id))
  // A draft's lines: what their pick place holds of them now.
  const balances = status === 'DRAFT' && lines.length > 0 ? await balancesAt(client, row.fromSiteId, { itemId: { in: [...new Set(lines.map((line) => line.itemId))] } }) : new Map<string, Decimal>()
  const pickOf = (line: LineRowData) => line.fromLocationId ?? row.fromLocationId
  const availableOf = (line: LineRowData): Decimal | null => {
    const place = pickOf(line)
    return status === 'DRAFT' && place ? (balances.get(keyText({ locationId: place, itemId: line.itemId, itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId })) ?? ZERO) : null
  }
  const views: LineView[] = lines.map((line) => {
    const inTransit = transit.get(line.id) ?? ZERO
    const figures = figuresOf(line, inTransit)
    const available = availableOf(line)
    return {
      id: line.id,
      seq: line.seq,
      item: { id: line.item.id, code: line.item.code, name: line.item.name, baseUom: line.item.baseUom, tracking: line.item.tracking },
      colour: line.itemColour ? { id: line.itemColour.id, code: line.itemColour.code, name: line.itemColour.name } : null,
      lot: line.lot ? { id: line.lot.id, code: line.lot.code, qualityStatus: line.lot.qualityStatus } : null,
      hide: line.hide ? { id: line.hide.id, code: line.hide.code } : null,
      fromLocation: placeRef(line.fromLocation),
      quantity: quantityOut(decOf(line.baseQuantity)),
      uom: line.item.baseUom,
      available: available === null ? null : quantityOut(available),
      shippedQuantity: figures.shippedQuantity,
      receivedQuantity: figures.receivedQuantity,
      inTransit: figures.inTransit,
      difference: quantityOut(differenceOf(figures)),
      state: lineStateOf(figures),
      toLocation: placeRef(line.toLocation),
      toLot: line.toLot ? { id: line.toLot.id, code: line.toLot.code } : null,
      toHide: line.toHide ? { id: line.toHide.id, code: line.toHide.code } : null,
      differenceReasonCode: line.differenceReasonCode,
      differenceNote: line.differenceNote,
      differenceResolution: line.differenceResolution,
      resolvedAt: figures.resolvedAt,
      note: line.note,
      version: line.version,
    }
  })
  const openDifferences = views.filter((line) => line.state === 'SHORT').length
  const actions = transferActions({
    status,
    lines: lines.length,
    unplacedLines: lines.filter((line) => pickOf(line) === null).length,
    shortLines: lines.filter((line) => {
      const available = availableOf(line)
      return available !== null && decOf(line.baseQuantity).greaterThan(available)
    }).length,
    openDifferences,
    hasDdt: row.ddtNumber !== null,
    manageFrom: managesFrom(context, row),
    manageTo: managesTo(context, row),
  })
  const carrier = row.carrier && typeof row.carrier === 'object' && !Array.isArray(row.carrier) ? (row.carrier as { name?: unknown; vatNumber?: unknown }) : null
  return {
    id: row.id,
    number: row.number,
    status,
    from: siteRef(row.fromSite),
    to: siteRef(row.toSite),
    interCompany: row.companyId !== row.toCompanyId,
    fromLocation: placeRef(row.fromLocation),
    toLocation: placeRef(row.toLocation),
    transit: placeRef(row.transitLocation)!,
    shipOn: dayOf(row.shipOn),
    expectedOn: dayOf(row.expectedOn),
    late: isLate({ status, expectedOn: dayOf(row.expectedOn) }, today(now)),
    ddt:
      row.ddtNumber && row.ddtDate && row.transportBy && row.packages !== null && row.grossWeightKg !== null && row.appearance
        ? {
            number: row.ddtNumber,
            date: dayOf(row.ddtDate)!,
            reason: row.ddtReason,
            reasonText: row.ddtReasonText,
            transportBy: row.transportBy,
            carrier: carrier && typeof carrier.name === 'string' ? { name: carrier.name, vatNumber: typeof carrier.vatNumber === 'string' ? carrier.vatNumber : null } : null,
            packages: row.packages,
            grossWeightKg: quantityOut(decOf(row.grossWeightKg)),
            appearance: row.appearance,
            fileId: row.ddtFileId,
          }
        : null,
    trackingRef: row.trackingRef,
    trackingUrl: row.trackingUrl,
    shippedAt: row.shippedAt ? toUtcIso(row.shippedAt) : null,
    receivedAt: row.receivedAt ? toUtcIso(row.receivedAt) : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    lines: views,
    totals: {
      lines: views.length,
      inTransitLines: views.filter((line) => !new Dec(line.inTransit).isZero()).length,
      openDifferences,
      settled: views.filter((line) => line.state === 'SETTLED').length,
    },
    actions,
    // The words of the reasons a line names (and the list to pick from while goods are on their way).
    reasons: status === 'SHIPPED' || status === 'PARTLY_RECEIVED' || lines.some((line) => line.differenceReasonCode !== null) ? await differenceReasons(client) : [],
  }
}
