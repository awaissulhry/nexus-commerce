import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { qualityOf, type QualityState } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { quantityText, type Balance } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_ISSUE } from '@nexus/factory-domain/inventory/permissions'
import { binWalkOrder, MAX_WALK_ORDERS, placesOf, takeInWalkOrder, walkOrder, type BinPlace, type PlacedBin, type StopSource } from '@nexus/factory-domain/inventory/pick-lists/walk'
import { STANDING_STATUSES } from '@nexus/factory-domain/inventory/substitutions/rules'
import { NOT_COUNTED_WORDS, usabilityOf } from '@nexus/factory-domain/planning/usable'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { mayAt, stockContextOf, type StockContext } from '../ledger/access'
import { sheetOf } from '../issue/kits'
import { readLots, readPickHeader, readSiteStock, type LotRow, type PickHeader, type Reader } from '../issue/store'
import { readKits } from '../kits/store'
import { heldByQualityHolds } from '../../quality/holds/stock'
import { substitutionViews, SUBSTITUTION_COLUMNS } from '../substitutions/store'

/**
 * The pick list by bin (B-W2b-298; SCM-212; design floor.pick sec:need "W2b pick list (SCM-212): sorted by bin path,
 * reservations, scan each pick", warehouse.picking pop:pk-list "lines sorted by bin path", tab "Pick list PDF (sorted by bin
 * path)"): one work order's pick list, or one walk for several (rule 1: the cutter and the kit maker pick for the shift's work
 * orders in one round), as the stops of one walk through the site's store in the order of its bins (factory-domain
 * inventory/pick-lists binWalkOrder: the tree depth first, the places inside one place by their codes in natural order).
 * Office and the floor of the work order's site (inventory.issue). Read only: no audit, no event.
 *
 *   RESERVED     the work order's pick list (W2a's Create pick lists: its ACTIVE reservations, the open part), at the places
 *                its lot or hide lies now, with the lot's quality status: a reserved lot put on hold since is shown, not
 *                issuable, in words
 *   SUBSTITUTE   an APPROVED substitute (modules/inventory/substitutions), its lot where it lies (or the material's usable
 *                stock), how much its substitution allows: issued through POST /inventory/substitutions/:id/issue
 *   PROPOSED     what a pick list would reserve now (W2a's proposal: the free stock oldest first), up to what is still to pick
 *                of the line once its reservations and its approved or issued substitutes are counted
 *
 * Per work order: its lines (need, issued, still to issue, reserved, short, the substitutes standing on the line and what they
 * stand for), its kit's place (WorkOrderKit, B-W2b-15) and its open PICK task (B-W2b-292). The issue of a stop is W1's
 * (POST /inventory/picking/work-orders/:id/issue, its `fromLocationId` the stop's place). No money; never a person.
 */

const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))
const unique = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string'))]
const keyOf = (itemId: string, itemColourId: string | null) => `${itemId}|${itemColourId ?? '-'}`

interface Stop {
  readonly workOrderId: string
  readonly workOrderNumber: string
  readonly lineKey: string
  readonly itemId: string
  readonly itemCode: string
  readonly itemName: string
  readonly colourCode: string | null
  readonly baseUom: string
  readonly tracking: string
  readonly locationId: string
  readonly lotId: string | null
  readonly lotCode: string | null
  readonly hideId: string | null
  readonly hideCode: string | null
  readonly quantity: string
  readonly source: StopSource
  readonly reservationId: string | null
  readonly substitutionId: string | null
  readonly quality: QualityState
  readonly issuable: boolean
  readonly words: string | null
}

/** The places of the sites in walking order, with "blocked" as the database reads it today (Europe/Rome). */
async function binsOf(db: Reader, siteIds: readonly string[]): Promise<Map<string, PlacedBin>> {
  const today = businessDate(serverClock.now())
  const rows = await db.location.findMany({ where: { siteId: { in: [...siteIds] } }, select: { id: true, parentId: true, code: true, name: true, kind: true, labelCode: true, blockedAt: true, blockedUntil: true, siteId: true } })
  const out = new Map<string, PlacedBin>()
  for (const siteId of siteIds) {
    const places: BinPlace[] = rows
      .filter((row) => row.siteId === siteId)
      .map((row) => ({ id: row.id, parentId: row.parentId, code: row.code, name: row.name, kind: row.kind, labelCode: row.labelCode, blocked: row.blockedAt !== null && (row.blockedUntil === null || row.blockedUntil.toISOString().slice(0, 10) >= today) }))
    for (const [id, placed] of binWalkOrder(places)) out.set(id, placed)
  }
  return out
}

/** A balance's quality and whether it may be issued now, in words when not. */
function qualityFor(balance: Pick<Balance, 'lotId' | 'hideId'>, lots: ReadonlyMap<string, LotRow>, onHold: boolean, bin: PlacedBin | undefined): { quality: QualityState; issuable: boolean; words: string | null } {
  const lot = balance.lotId ? lots.get(balance.lotId) : undefined
  const quality = qualityOf({ lotStatus: (lot?.qualityStatus as 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED' | undefined) ?? null, onHold })
  const usability = usabilityOf(lot ?? null)
  if (onHold) return { quality, issuable: false, words: `Lot ${lot?.code ?? '?'} is on a quality hold: it is not issued until quality releases it.` }
  if (!usability.usable) return { quality, issuable: false, words: `Lot ${lot?.code ?? '?'}: ${NOT_COUNTED_WORDS[usability.reason]}. Only released stock is issued.` }
  if (bin?.blocked) return { quality, issuable: false, words: `${bin.code} is blocked: nothing is taken from it until it is unblocked.` }
  return { quality, issuable: true, words: null }
}

async function walkOfOne(db: Reader, context: StockContext, header: PickHeader, bins: ReadonlyMap<string, PlacedBin>) {
  const sheet = await sheetOf(db, context, header)
  const itemIds = unique([...sheet.lines.map((line) => line.itemId)])
  const substitutions = (await db.materialSubstitution.findMany({ where: { workOrderId: header.id, status: { in: [...STANDING_STATUSES] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: SUBSTITUTION_COLUMNS }))
  const views = await substitutionViews(db, substitutions, { requests: context.audience !== 'floor' })
  const approved = substitutions.filter((row) => row.status === 'APPROVED')
  const stock = await readSiteStock(db, header.siteId, { itemIds: unique([...itemIds, ...approved.map((row) => row.toItemId)]) })
  const lots = await readLots(db, unique(stock.map((row) => row.lotId)))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: unique(stock.map((row) => row.hideId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const holds = await heldByQualityHolds(db, { lotIds: stock.map((row) => row.lotId), hideIds: stock.map((row) => row.hideId) })
  const reservations = await db.reservation.findMany({ where: { workOrderId: header.id, status: 'ACTIVE' }, select: { id: true, itemId: true, itemColourId: true, lotId: true, hideId: true, quantity: true, issuedQuantity: true }, orderBy: { id: 'asc' } })
  const items = new Map((await db.item.findMany({ where: { id: { in: unique([...itemIds, ...approved.map((row) => row.toItemId)]) } }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } })).map((row) => [row.id, row]))
  const colours = new Map((await db.itemColour.findMany({ where: { id: { in: unique([...sheet.lines.map((line) => line.itemColourId), ...approved.map((row) => row.toItemColourId)]) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))

  const stops: Stop[] = []
  const stopOf = (base: Omit<Stop, 'quality' | 'issuable' | 'words' | 'lotCode' | 'hideCode'>): Stop => ({
    ...base,
    lotCode: base.lotId ? (lots.get(base.lotId)?.code ?? null) : null,
    hideCode: base.hideId ? (hides.get(base.hideId) ?? null) : null,
    ...qualityFor(base, lots, holds.holds({ lotId: base.lotId, hideId: base.hideId }), bins.get(base.locationId)),
  })
  const lines = sheet.lines.map((line) => {
    const lineKey = keyOf(line.itemId, line.itemColourId)
    const bomLineIds = new Set(line.rows.map((row) => row.bomLineId))
    const mine = views.filter((view) => bomLineIds.has(view.line.id))
    const substituted = mine.filter((view) => view.status === 'APPROVED' || view.status === 'ISSUED').reduce((sum, view) => sum.plus(dec(view.replaces?.quantity)), ZERO)
    const toPick = Dec.max(ZERO, new Dec(line.toIssue).minus(substituted))
    const common = { workOrderId: header.id, workOrderNumber: header.number, lineKey, itemId: line.itemId, itemCode: line.itemCode, itemName: line.itemName, colourCode: line.colourCode, baseUom: line.baseUom, tracking: line.tracking }
    // RESERVED: the open part of each ACTIVE reservation, where its stock lies (in walking order).
    let reservedOpen = ZERO
    for (const reservation of reservations.filter((row) => row.itemId === line.itemId && row.itemColourId === line.itemColourId)) {
      const open = Dec.max(ZERO, dec(reservation.quantity).minus(dec(reservation.issuedQuantity)))
      if (open.lte(ZERO)) continue
      reservedOpen = reservedOpen.plus(open)
      // A reservation of any lot takes from the usable stock (a named lot or hide: wherever it lies, said when it is held).
      const lying = stock.filter(
        (row) =>
          row.itemId === line.itemId &&
          row.itemColourId === line.itemColourId &&
          (reservation.hideId ? row.hideId === reservation.hideId : reservation.lotId ? row.lotId === reservation.lotId : qualityFor(row, lots, holds.holds(row), bins.get(row.locationId)).issuable),
      )
      const byKey = new Map<string, Balance[]>()
      for (const row of lying) byKey.set(`${row.lotId ?? '-'}|${row.hideId ?? '-'}`, [...(byKey.get(`${row.lotId ?? '-'}|${row.hideId ?? '-'}`) ?? []), row])
      let left = open
      for (const rows of byKey.values()) {
        if (left.lte(ZERO)) break
        const first = rows[0]!
        for (const take of takeInWalkOrder(quantityText(left), rows.map((row) => ({ locationId: row.locationId, onHand: quantityText(row.onHand) })), bins, reservation.hideId !== null)) {
          stops.push(stopOf({ ...common, locationId: take.locationId, lotId: first.lotId, hideId: first.hideId, quantity: take.quantity, source: 'RESERVED', reservationId: reservation.id, substitutionId: null }))
          left = left.minus(new Dec(take.quantity))
        }
      }
    }
    // PROPOSED: what a pick list would reserve now, up to what is left to pick of the line.
    let budget = Dec.max(ZERO, toPick.minus(reservedOpen))
    for (const pick of line.pick.proposed) {
      if (budget.lte(ZERO)) break
      const whole = pick.kind === 'HIDE'
      const quantity = whole ? new Dec(pick.quantity) : Dec.min(budget, new Dec(pick.quantity))
      for (const take of takeInWalkOrder(quantityText(quantity), pick.locations.map((place) => ({ locationId: place.locationId, onHand: place.onHand })), bins, whole)) {
        stops.push(stopOf({ ...common, locationId: take.locationId, lotId: pick.lotId, hideId: pick.hideId, quantity: take.quantity, source: 'PROPOSED', reservationId: null, substitutionId: null }))
      }
      budget = budget.minus(quantity)
    }
    return {
      key: lineKey,
      itemId: line.itemId,
      itemCode: line.itemCode,
      itemName: line.itemName,
      tracking: line.tracking,
      baseUom: line.baseUom,
      itemColourId: line.itemColourId,
      colourCode: line.colourCode,
      planned: line.planned,
      issued: line.issued,
      toIssue: line.toIssue,
      reserved: quantityText(reservedOpen),
      short: line.pick.short,
      /** What approved and issued substitutes stand for of it. */
      substituted: quantityText(substituted),
      /** Still to pick of the line's own material once its substitutes are counted. */
      toPick: quantityText(toPick),
      covered: toPick.lte(ZERO),
      held: line.held.map((entry) => ({ reason: entry.reason, words: entry.words, lotCode: entry.lotCode, onHand: entry.onHand })),
      substitutes: mine,
    }
  })
  // SUBSTITUTE: each approved substitute, where its lot (or its usable stock) lies.
  for (const row of approved) {
    const item = items.get(row.toItemId)
    if (!item) continue
    const view = views.find((entry) => entry.id === row.id)
    const lying = stock.filter((balance) => balance.itemId === row.toItemId && balance.itemColourId === row.toItemColourId && (row.toLotId ? balance.lotId === row.toLotId : true))
    const usable = lying.filter((balance) => row.toLotId !== null || qualityFor(balance, lots, holds.holds(balance), bins.get(balance.locationId)).issuable)
    let left = dec(row.baseQuantity)
    const lineKey = sheet.lines.find((line) => line.rows.some((entry) => entry.bomLineId === row.bomLineId))
    for (const balance of [...usable].sort((a, b) => (bins.get(a.locationId)?.rank ?? Number.MAX_SAFE_INTEGER) - (bins.get(b.locationId)?.rank ?? Number.MAX_SAFE_INTEGER))) {
      if (left.lte(ZERO)) break
      const whole = balance.hideId !== null
      const take = whole ? balance.onHand : Dec.min(left, balance.onHand)
      stops.push(
        stopOf({
          workOrderId: header.id,
          workOrderNumber: header.number,
          lineKey: lineKey ? keyOf(lineKey.itemId, lineKey.itemColourId) : keyOf(row.fromItemId, null),
          itemId: item.id,
          itemCode: item.code,
          itemName: item.name,
          colourCode: row.toItemColourId ? (colours.get(row.toItemColourId) ?? null) : null,
          baseUom: item.baseUom,
          tracking: item.tracking,
          locationId: balance.locationId,
          lotId: balance.lotId,
          hideId: balance.hideId,
          quantity: quantityText(take),
          source: 'SUBSTITUTE',
          reservationId: null,
          substitutionId: view?.id ?? row.id,
        }),
      )
      left = left.minus(take)
    }
  }
  const task = await db.warehouseTask.findFirst({ where: { kind: 'PICK', sourceType: 'WorkOrder', sourceId: header.id, status: { in: ['OPEN', 'TAKEN'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, status: true, version: true } })
  const kit = (await readKits(db, [header.id])).get(header.id)!
  return {
    workOrder: { id: header.id, number: header.number, status: header.status, siteId: header.siteId, companyId: header.companyId, dueDate: sheet.workOrder.dueDate, style: sheet.workOrder.style, issuable: sheet.workOrder.issuable },
    kit: { location: kit.location, checkedAt: kit.checkedAt },
    task: task ? { id: task.id, status: task.status, version: task.version } : null,
    lines,
    stops,
  }
}

const placeView = (bin: PlacedBin | undefined, locationId: string) =>
  bin ? { id: bin.id, code: bin.code, name: bin.name, kind: bin.kind, labelCode: bin.labelCode, path: [...bin.path], rank: bin.rank, blocked: bin.blocked } : { id: locationId, code: '?', name: '', kind: 'OTHER', labelCode: null, path: [], rank: Number.MAX_SAFE_INTEGER, blocked: false }

/** The walk of these work orders (each one the caller may pick for, at its site; another's is not found). */
export async function pickWalk(caller: CommandCaller, workOrderIds: readonly string[]) {
  const context = stockContextOf(caller)
  const ids = [...new Set(workOrderIds)]
  if (ids.length === 0 || ids.length > MAX_WALK_ORDERS || ids.some((value) => !isUuid(value))) {
    throw new ValidationError(`Name 1 to ${MAX_WALK_ORDERS} work orders by their ids.`, [{ path: 'querystring/workOrderIds', message: `Comma-separated work order ids, 1 to ${MAX_WALK_ORDERS}.` }])
  }
  return caller.withClient(async (db) => {
    const headers: PickHeader[] = []
    for (const id of ids) {
      const header = await readPickHeader(db, id)
      if (!header || !mayAt(context, INVENTORY_ISSUE, header)) throw new NotFoundError('Work order not found.')
      headers.push(header)
    }
    const bins = await binsOf(db, unique(headers.map((header) => header.siteId)))
    const orders = []
    for (const header of headers) orders.push(await walkOfOne(db, context, header, bins))
    const stops = walkOrder(
      orders.flatMap((order) => order.stops),
      bins,
    ).map((stop, index) => ({ ...stop, turn: index + 1, location: placeView(bins.get(stop.locationId), stop.locationId) }))
    const places = placesOf(stops).map((place) => ({ ...placeView(bins.get(place.locationId), place.locationId), stops: place.stops }))
    return {
      asOf: toUtcIso(serverClock.now()),
      workOrders: orders.map(({ stops: _stops, ...order }) => order),
      stops: stops.map(({ locationId: _location, ...stop }) => stop),
      places,
    }
  })
}

export type PickWalk = Awaited<ReturnType<typeof pickWalk>>

/**
 * Where the PICK task of a work order's pick list starts and ends (B-W2b-292's task source, modules/inventory/tasks/sources/
 * pick-lists.ts): the first place of its walk that has a stop to take, how many places the walk passes, and the kit's
 * staging place (when it is another). Null when there is nothing to take.
 */
export async function walkStartOf(db: Reader, context: StockContext, workOrderId: string): Promise<{ fromLocationId: string; fromCode: string; places: number; toLocationId: string | null } | null> {
  const header = await readPickHeader(db, workOrderId)
  if (!header) return null
  const bins = await binsOf(db, [header.siteId])
  const one = await walkOfOne(db, context, header, bins)
  const stops = walkOrder(one.stops, bins).filter((stop) => stop.issuable)
  const first = stops[0]
  if (!first) return null
  const kitPlace = one.kit.location?.id ?? null
  return { fromLocationId: first.locationId, fromCode: bins.get(first.locationId)?.code ?? '?', places: placesOf(stops).length, toLocationId: kitPlace !== null && kitPlace !== first.locationId ? kitPlace : null }
}
