import type { Prisma, ReservationStatus } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { availabilityOf, openOf, type Availability } from '@nexus/factory-domain/inventory/reservations/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, officeContextOf, siteFor } from '../ledger/access'
import type { Reader } from '../issue/store'
import type { ReservationView } from './contract'
import { demandOpen, readDemands, readKeyFacts, RESERVATION_COLUMNS, type ReservationRow } from './store'

export type { ReservationView }

/**
 * The reservations' reads (B-W2a-11; SCM-205, SCM-209, SCM-210): the list the stock, hides and work-order screens show
 * (filters per site, material, colour, lot, hide, demand, status, stale), one reservation with the figures of its stock
 * now, and the availability of a material at a site (on hand − held − reserved, for the item and colour and per lot) that
 * a reserve dialog shows before it asks. Office only, inventory.stock.view; no cost on any of them. Office users are
 * named (who reserved, who released); never a floor worker.
 */

const SCOPE = { company: 'companyId', site: 'siteId' } as const


const byId = <Row extends { id: string }>(rows: readonly Row[]) => new Map(rows.map((row) => [row.id, row]))

/** The views of some reservations (names of their stock, demand and people), in the order given. */
export async function viewsOf(db: Reader, rows: readonly ReservationRow[], options: { readonly withOrders: boolean }): Promise<ReservationView[]> {
  if (rows.length === 0) return []
  const set = (pick: (row: ReservationRow) => string | null) => [...new Set(rows.flatMap((row) => (pick(row) ? [pick(row)!] : [])))]
  const sites = byId(await db.site.findMany({ where: { id: { in: set((row) => row.siteId) } }, select: { id: true, code: true } }))
  const items = byId(await db.item.findMany({ where: { id: { in: set((row) => row.itemId) } }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } }))
  const colours = byId(await db.itemColour.findMany({ where: { id: { in: set((row) => row.itemColourId) } }, select: { id: true, code: true, name: true } }))
  const lots = byId(await db.lot.findMany({ where: { id: { in: set((row) => row.lotId) } }, select: { id: true, code: true, qualityStatus: true } }))
  const hides = byId(await db.hide.findMany({ where: { id: { in: set((row) => row.hideId) } }, select: { id: true, code: true } }))
  const users = byId(
    (await db.user.findMany({ where: { id: { in: [...set((row) => row.createdById), ...set((row) => row.releasedById)] } }, select: { id: true, displayName: true } })).map((user) => ({
      id: user.id,
      name: user.displayName,
    })),
  )
  const demands = await readDemands(db, rows, options)
  return rows.map((row) => {
    const item = items.get(row.itemId)!
    const workOrder = row.workOrderId ? demands.workOrders.get(row.workOrderId) : undefined
    const line = row.salesOrderLineId ? demands.orderLines.get(row.salesOrderLineId) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      siteCode: sites.get(row.siteId)?.code ?? '',
      kind: row.kind,
      status: row.status,
      item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, tracking: item.tracking },
      colour: row.itemColourId ? (colours.get(row.itemColourId) ?? null) : null,
      lot: row.lotId ? (lots.get(row.lotId) ?? null) : null,
      hide: row.hideId ? (hides.get(row.hideId) ?? null) : null,
      quantity: row.quantity.toFixed(4),
      issuedQuantity: row.issuedQuantity.toFixed(4),
      open: row.status === 'ACTIVE' ? quantityText(openOf({ quantity: row.quantity.toString(), issuedQuantity: row.issuedQuantity.toString() })) : quantityText('0'),
      demand: row.workOrderId
        ? { type: 'WorkOrder' as const, id: row.workOrderId, number: workOrder?.number ?? '', status: workOrder?.status ?? '' }
        : { type: 'SalesOrderLine' as const, id: row.salesOrderLineId!, orderId: line?.orderId ?? '', orderNumber: line?.number ?? '', seq: line?.seq ?? 0, status: line?.status ?? '' },
      stale: row.status === 'ACTIVE' && !demandOpen(row, demands),
      needDate: row.needDate ? row.needDate.toISOString().slice(0, 10) : null,
      note: row.note,
      issuedAt: row.issuedAt ? toUtcIso(row.issuedAt) : null,
      releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
      releasedBy: row.releasedById ? (users.get(row.releasedById) ?? null) : null,
      releaseReason: row.releaseReason,
      createdAt: toUtcIso(row.createdAt),
      createdBy: row.createdById ? (users.get(row.createdById) ?? null) : null,
      version: row.version,
    }
  })
}

export interface ListReservationsQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly salesOrderLineId?: string | undefined
  readonly statuses?: readonly ReservationStatus[] | undefined
  /** Only ACTIVE ones whose demand is done. */
  readonly stale?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** GET /inventory/reservations: newest first (UUIDv7 ids), in pages with a cursor. */
export async function listReservations(caller: CommandCaller, query: ListReservationsQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.ReservationWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.ReservationWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.itemId ? { itemId: query.itemId } : {},
      query.itemColourId ? { itemColourId: query.itemColourId } : {},
      query.lotId ? { lotId: query.lotId } : {},
      query.hideId ? { hideId: query.hideId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.salesOrderLineId ? { salesOrderLineId: query.salesOrderLineId } : {},
      query.statuses && query.statuses.length > 0 ? { status: { in: [...query.statuses] } } : {},
      query.stale ? { status: 'ACTIVE' } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (client) => {
    if (!query.stale) {
      const rows = await client.reservation.findMany({ where, select: RESERVATION_COLUMNS, orderBy: { id: 'desc' }, take: query.limit + 1 })
      const page = rows.slice(0, query.limit)
      return { reservations: await viewsOf(client, page, { withOrders: true }), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
    }
    // Stale is the demand's state, not a column: read ACTIVE ones page by page until the page is full.
    const found: ReservationRow[] = []
    let cursor = query.cursor
    for (;;) {
      const rows = await client.reservation.findMany({ where: { AND: [where, cursor ? { id: { lt: cursor } } : {}] }, select: RESERVATION_COLUMNS, orderBy: { id: 'desc' }, take: 500 })
      const demands = await readDemands(client, rows, { withOrders: true })
      for (const row of rows) if (!demandOpen(row, demands) && found.length <= query.limit) found.push(row)
      if (rows.length < 500 || found.length > query.limit) break
      cursor = rows.at(-1)!.id
    }
    const page = found.slice(0, query.limit)
    return { reservations: await viewsOf(client, page, { withOrders: true }), nextCursor: found.length > query.limit ? page.at(-1)!.id : null }
  })
}

const figures = (value: Availability) => ({
  onHand: quantityText(value.onHand),
  held: quantityText(value.held),
  reserved: quantityText(value.reserved),
  available: quantityText(value.available),
  overReserved: value.overReserved,
})

/** GET /inventory/reservations/:id: one reservation, and the figures of its stock now (the item and colour at the site, and its lot). */
export async function reservationRecord(caller: CommandCaller, reservationId: string) {
  const context = officeContextOf(caller)
  const row = isUuid(reservationId) ? await caller.withClient((client) => client.reservation.findUnique({ where: { id: reservationId }, select: RESERVATION_COLUMNS })) : null
  if (!row || !mayAt(context, INVENTORY_STOCK_VIEW, row)) throw new NotFoundError('Reservation not found.')
  return caller.withClient(async (client) => {
    const [view] = await viewsOf(client, [row], { withOrders: true })
    const facts = await readKeyFacts(client, { siteId: row.siteId, itemId: row.itemId, itemColourId: row.itemColourId }, { withOrders: true })
    return {
      reservation: view!,
      stock: {
        site: figures(availabilityOf(facts.stock, facts.reservations)),
        lot: row.lotId ? figures(availabilityOf(facts.stock, facts.reservations, { lotId: row.lotId })) : null,
      },
    }
  })
}

export interface AvailabilityQuery {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId?: string | undefined
}

/**
 * GET /inventory/reservations/availability: what of a material (in one colour) a site can still reserve — on hand,
 * held, reserved and available for the whole site and per lot, the hides in stock with who holds each, and the ACTIVE
 * reservations behind the reserved figure.
 */
export async function availability(caller: CommandCaller, query: AvailabilityQuery) {
  officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'query/siteId')
  return caller.withClient(async (client) => {
    const item = await client.item.findUnique({ where: { id: query.itemId }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } })
    const colour = query.itemColourId ? await client.itemColour.findUnique({ where: { id: query.itemColourId }, select: { id: true, code: true, name: true, itemId: true } }) : null
    if (!item || (query.itemColourId && colour?.itemId !== item.id)) throw new NotFoundError('Material not found.')
    const facts = await readKeyFacts(client, { siteId: site.id, itemId: item.id, itemColourId: query.itemColourId ?? null }, { withOrders: true })
    const lotIds = [...new Set(facts.stock.flatMap((part) => (part.lotId ? [part.lotId] : [])))].sort((a, b) => ((facts.lots.get(a)?.code ?? '') < (facts.lots.get(b)?.code ?? '') ? -1 : 1))
    const hideIds = facts.stock.flatMap((part) => (part.hideId ? [part.hideId] : []))
    const hides = byId(hideIds.length > 0 ? await client.hide.findMany({ where: { id: { in: hideIds } }, select: { id: true, code: true, lotId: true } }) : [])
    const views = await viewsOf(client, facts.rows, { withOrders: true })
    const holder = new Map(views.filter((view) => view.hide && !view.stale).map((view) => [view.hide!.id, view]))
    return {
      site: { id: site.id, code: site.code },
      item,
      colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
      figures: figures(availabilityOf(facts.stock, facts.reservations)),
      lots: lotIds.map((lotId) => ({
        lot: { id: lotId, code: facts.lots.get(lotId)?.code ?? '', qualityStatus: facts.lots.get(lotId)?.qualityStatus ?? '' },
        ...figures(availabilityOf(facts.stock, facts.reservations, { lotId })),
      })),
      hides: facts.stock
        .filter((part) => part.hideId)
        .map((part) => {
          const hide = hides.get(part.hideId!)
          const held = holder.get(part.hideId!)
          return {
            hide: { id: part.hideId!, code: hide?.code ?? '' },
            lotId: part.lotId,
            onHand: quantityText(part.onHand),
            held: part.held,
            reservedFor: held ? held.demand : null,
          }
        })
        .sort((a, b) => (a.hide.code < b.hide.code ? -1 : 1)),
      reservations: views,
    }
  })
}
