import type { Uom } from '@nexus/factory-db'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { INVENTORY_RECEIVE } from '@nexus/factory-domain/inventory/permissions'
import { holdingProblem, quantityOf, UNPLANNED_LIMITS, unplannedLineProblems, unplannedStateOf } from '@nexus/factory-domain/inventory/unplanned/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { asTenantSystem } from '../../production/bundles/codes'
import { postedBy } from '../ledger/access'
import { receiverOf } from '../receiving/read'
import { receiptNumber } from '../receipts/numbers'
import { byId, DDT_PHOTO_WHERE, ids, readColours } from '../receipts/store'
import { askBuyerAfterFloor } from './buyer'
import { lastHoldingPlace, lineLabel, placeOfScan, PLACE_COLUMNS, readUnplanned, readUnplannedLines, UNPLANNED_ITEM_COLUMNS, type UnplannedItemRow } from './store'

/**
 * Goods without a purchase order on the goods-in tablet (B-W2b-300; SCM-122; design floor.receive › "Goods without a PO":
 * supplier, item, quantity, photo; "Put it in the holding area"). Floor only, inventory.receive at the device's site (the
 * goods-in floor roles hold it). No money anywhere; the supplier's name comes from the tenant's system scope (the floor reads
 * no party).
 *
 *   GET  /inventory/receiving/unplanned/start?q=   the holding place the site's goods without a PO wait in (where the last ones
 *                                                 waited; none yet: the tablet scans its label) and the suppliers to pick
 *   GET  /inventory/receiving/unplanned/items?q=   the materials to pick (code or name), with their colours and units
 *   POST /inventory/receiving/unplanned            ONE floor command: the receipt (kind UNPLANNED, the GR number of the site's
 *                                                 company, no purchase order, OPEN), its lines, into the holding place, NO stock
 *                                                 move (nothing is used until a buyer names the order); then the buyer's task in
 *                                                 a system command of its own (./buyer.ts). The supplier's DDT photo goes through
 *                                                 the receipt's own route (POST /inventory/receipts/:id/ddt-photos, floor allowed).
 *   GET  /inventory/receiving/unplanned/:id        the receipt as the tablet shows it after (its state, lines, photo count)
 *
 * Online only, as every receipt (its number comes from the office's series): the tablet holds it with the reason offline.
 */

const day = (value: Date | null): string | null => (value === null ? null : businessDate(value, 'UTC'))
const CLOCK_SLACK_MS = 5 * 60 * 1000

/** The site's company (the receipt's company: its GR series). */
async function siteOf(caller: CommandCaller, context: FloorContext) {
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: context.siteId }, select: { id: true, companyId: true, code: true } }))
  if (!site) throw new NotFoundError('Site not found.')
  return site
}

const placeView = (place: { id: string; code: string; name: string } | null) => (place ? { id: place.id, code: place.code, name: place.name } : null)

/** GET /inventory/receiving/unplanned/start */
export async function unplannedStart(caller: CommandCaller, query: { readonly q?: string | undefined }) {
  const context = receiverOf(caller)
  const site = await siteOf(caller, context)
  const holding = await caller.withClient((client) => lastHoldingPlace(client, site.id))
  const usable = holding && holdingProblem(holding) === null ? holding : null
  const q = query.q?.trim() ?? ''
  const suppliers = await asTenantSystem(caller, context).withClient((client) =>
    client.party.findMany({
      where: {
        roles: { has: 'SUPPLIER' },
        status: 'ACTIVE',
        ...(q ? { OR: [{ code: { contains: q, mode: 'insensitive' } }, { legalName: { contains: q, mode: 'insensitive' } }, { tradeName: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
      take: UNPLANNED_LIMITS.suppliers,
      select: { id: true, code: true, legalName: true, tradeName: true },
    }),
  )
  return {
    serverTime: toUtcIso(serverClock.now()),
    holding: placeView(usable),
    suppliers: suppliers.map((row) => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName })),
  }
}

/** GET /inventory/receiving/unplanned/items */
export async function unplannedItems(caller: CommandCaller, query: { readonly q: string }) {
  const context = receiverOf(caller)
  const site = await siteOf(caller, context)
  const q = query.q.trim()
  return caller.withClient(async (client) => {
    const items = await client.item.findMany({
      where: { status: 'ACTIVE', tracking: { not: 'SERIAL' }, OR: [{ companyId: null }, { companyId: site.companyId }], AND: [{ OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] }] },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: UNPLANNED_LIMITS.items,
      select: UNPLANNED_ITEM_COLUMNS,
    })
    const colours = await client.itemColour.findMany({ where: { itemId: { in: items.map((item) => item.id) }, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, itemId: true, code: true, name: true } })
    return {
      items: items.map((item) => ({
        id: item.id,
        code: item.code,
        name: item.name,
        tracking: item.tracking as 'NONE' | 'LOT' | 'HIDE',
        baseUom: item.baseUom,
        purchaseUom: item.purchaseUom,
        colours: colours.filter((colour) => colour.itemId === item.id).map((colour) => ({ id: colour.id, code: colour.code, name: colour.name })),
      })),
    }
  })
}

export interface UnplannedLineBody {
  readonly itemId: string
  readonly itemColourId?: string | null | undefined
  readonly quantity: string
  readonly uom?: Uom | undefined
  readonly hideCount?: number | null | undefined
  readonly note?: string | null | undefined
}

export interface UnplannedBody {
  readonly supplierId: string
  /** The holding place: the one the start read suggested, or the label scanned. One of them. */
  readonly holdingLocationId?: string | undefined
  readonly placeCode?: string | undefined
  readonly supplierDdtNumber?: string | null | undefined
  readonly supplierDdtDate?: string | null | undefined
  readonly receivedAt?: string | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly UnplannedLineBody[]
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const unitsOf = (item: UnplannedItemRow) => ({ baseUom: item.baseUom, purchaseUom: item.purchaseUom, purchaseFactor: item.purchaseFactor.toString(), consumptionUom: item.consumptionUom, consumptionFactor: item.consumptionFactor.toString() })

interface Logger {
  readonly log?: { warn(details: object, message: string): void }
}

/** POST /inventory/receiving/unplanned */
export async function receiveUnplanned(caller: CommandCaller & Logger, body: UnplannedBody, idempotencyKey: string | undefined) {
  const context = receiverOf(caller)
  const site = await siteOf(caller, context)
  if (!can(actorOf(context), INVENTORY_RECEIVE, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  if (Boolean(body.holdingLocationId) === Boolean(body.placeCode)) throw new ValidationError('Name the holding place once: the one suggested, or the label you scanned.', [{ path: 'body/placeCode', message: 'Scan the holding place.' }])
  // The supplier, from the tenant's system scope (the floor role reads no party): a supplier of ours, active.
  const supplier = isUuid(body.supplierId) ? await asTenantSystem(caller, context).withClient((client) => client.party.findUnique({ where: { id: body.supplierId }, select: { id: true, roles: true, status: true, code: true } })) : null
  if (!supplier || !supplier.roles.includes('SUPPLIER') || supplier.status !== 'ACTIVE') throw new ValidationError('Pick one of our active suppliers.', [{ path: 'body/supplierId', message: 'An active supplier.' }])

  const { result } = await command(caller, { name: 'inventory.receiveUnplanned', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const by = postedBy(context)
    // 1. The holding place, of this site.
    const place = body.holdingLocationId ? (isUuid(body.holdingLocationId) ? await tx.location.findUnique({ where: { id: body.holdingLocationId }, select: PLACE_COLUMNS }) : null) : await placeOfScan(tx, site.id, body.placeCode!)
    const placeProblem = holdingProblem(place && place.siteId === site.id ? place : null)
    if (placeProblem) throw new ValidationError(placeProblem, [{ path: body.placeCode ? 'body/placeCode' : 'body/holdingLocationId', message: placeProblem }])
    // 2. The lines: each material of ours, its colour, a quantity in a unit it is counted in.
    const items = byId(await tx.item.findMany({ where: { id: { in: ids(body.lines.map((line) => line.itemId)) } }, select: UNPLANNED_ITEM_COLUMNS }))
    const colours = await readColours(tx, body.lines.map((line) => line.itemColourId ?? null))
    const coloured = new Set((await tx.itemColour.findMany({ where: { itemId: { in: [...items.keys()] } }, select: { itemId: true } })).map((row) => row.itemId))
    const problems: Issue[] = []
    const refuse = (...issues: Issue[]): [] => {
      problems.push(...issues)
      return []
    }
    const planned = body.lines.flatMap((line, index) => {
      const at = `body/lines/${index}`
      const item = items.get(line.itemId)
      if (!item || item.status !== 'ACTIVE' || item.tracking === 'SERIAL') return refuse({ path: `${at}/itemId`, message: 'Not one of our materials.' })
      const colour = line.itemColourId ? colours.get(line.itemColourId) : undefined
      if (line.itemColourId && (!colour || colour.itemId !== item.id)) return refuse({ path: `${at}/itemColourId`, message: `Not a colour of ${item.code}.` })
      if (!line.itemColourId && coloured.has(item.id)) return refuse({ path: `${at}/itemColourId`, message: `${item.code} comes in colours: pick the colour that came.` })
      const shape = unplannedLineProblems(line, { code: item.code, tracking: item.tracking as 'NONE' | 'LOT' | 'HIDE' })
      if (shape.length > 0) return refuse(...shape.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message })))
      const uom = line.uom ?? item.baseUom
      const base = baseQuantityOf({ quantity: quantityOf(line.quantity)!, uom }, unitsOf(item))
      if (base.problem) return refuse({ path: `${at}/${base.problem.path}`, message: base.problem.message })
      return [{ seq: (index + 1) * 10, item, colour: colour ?? null, quantity: quantityOf(line.quantity)!, uom, baseQuantity: quantityText(base.baseQuantity), hideCount: item.tracking === 'HIDE' ? (line.hideCount ?? null) : null, note: blank(line.note) }]
    })
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The lines cannot be taken in as they are.', problems)
    const receivedAt = body.receivedAt ? parseInstant(body.receivedAt)! : now
    if (receivedAt.getTime() > now.getTime() + CLOCK_SLACK_MS) throw new ValidationError('The goods cannot arrive in the future.', [{ path: 'body/receivedAt', message: 'Now or earlier.' }])

    // 3. The receipt (OPEN, no order, in the holding place) and its lines: no move.
    const receiptId = newId()
    const number = await receiptNumber(tools, { companyId: site.companyId, receiptId, date: businessDate(receivedAt) })
    await tx.goodsReceipt.create({
      data: {
        id: receiptId,
        companyId: site.companyId,
        siteId: site.id,
        number,
        supplierId: supplier.id,
        purchaseOrderId: null,
        kind: 'UNPLANNED',
        holdingLocationId: place!.id,
        supplierDdtNumber: blank(body.supplierDdtNumber),
        supplierDdtDate: body.supplierDdtDate ? new Date(`${body.supplierDdtDate}T00:00:00.000Z`) : null,
        receivedAt,
        note: blank(body.note),
        createdAt: now,
        updatedAt: now,
        createdById: by.createdById,
      },
      select: { id: true },
    })
    for (const line of planned) {
      await tx.goodsReceiptLine.create({
        data: { id: newId(), siteId: site.id, receiptId, seq: line.seq, purchaseOrderLineId: null, itemId: line.item.id, itemColourId: line.colour?.id ?? null, quantity: line.quantity, uom: line.uom, baseQuantity: line.baseQuantity, hideCount: line.hideCount, note: line.note, createdAt: now, updatedAt: now, createdById: by.createdById },
        select: { id: true },
      })
    }
    const scope = { companyId: site.companyId, siteId: site.id }
    tools.audit({
      action: 'inventory.receiveUnplanned',
      recordType: 'GoodsReceipt',
      recordId: receiptId,
      ...scope,
      after: { number, kind: 'UNPLANNED', status: 'OPEN', supplierId: supplier.id, holdingLocationId: place!.id, supplierDdtNumber: blank(body.supplierDdtNumber), receivedAt: receivedAt.toISOString(), lines: planned.map((line) => ({ seq: line.seq, itemId: line.item.id, itemColourId: line.colour?.id ?? null, quantity: line.quantity, uom: line.uom, baseQuantity: line.baseQuantity, hideCount: line.hideCount })) },
    })
    tools.emit({ type: 'inventory.unplanned_changed', subject: receiptId, ...scope, payload: { receiptId, number, change: 'RECEIVED', supplierId: supplier.id, holdingLocationId: place!.id, purchaseOrderId: null, buyerTaskId: null, lines: planned.length } })
    return { receiptId, number }
  })

  // The buyer's task: a system command of its own (a failure leaves the receipt waiting; a resend of the request mends it).
  try {
    await askBuyerAfterFloor(caller, context, result.receiptId, idempotencyKey!)
  } catch (error) {
    caller.log?.warn({ err: error, receiptId: result.receiptId }, 'goods without a PO: the buyer was not asked')
  }
  return { receipt: await floorUnplannedView(caller, context, result.receiptId) }
}

/** The receipt as the tablet shows it: never a value or a person; the supplier's name from the system scope. */
export async function floorUnplannedView(caller: CommandCaller, context: FloorContext, receiptId: string) {
  const read = await caller.withClient(async (client) => {
    const receipt = isUuid(receiptId) ? await readUnplanned(client, receiptId) : null
    if (!receipt || receipt.siteId !== context.siteId) return null
    const lines = await readUnplannedLines(client, receipt.id)
    const items = byId(await client.item.findMany({ where: { id: { in: ids(lines.map((line) => line.itemId)) } }, select: { id: true, code: true, name: true, tracking: true } }))
    const colours = await readColours(client, lines.map((line) => line.itemColourId))
    const place = receipt.holdingLocationId ? await client.location.findUnique({ where: { id: receipt.holdingLocationId }, select: { id: true, code: true, name: true } }) : null
    const photos = await client.storedFile.count({ where: { ...DDT_PHOTO_WHERE(receipt.id), status: 'AVAILABLE' } })
    return { receipt, lines, items, colours, place, photos }
  })
  if (!read) throw new NotFoundError('Goods receipt not found.')
  const supplier = await asTenantSystem(caller, context).withClient((client) => client.party.findUnique({ where: { id: read.receipt.supplierId }, select: { tradeName: true, legalName: true } }))
  const { receipt } = read
  return {
    id: receipt.id,
    number: receipt.number,
    state: unplannedStateOf(receipt.status),
    supplier: { id: receipt.supplierId, name: supplier?.tradeName ?? supplier?.legalName ?? '' },
    holding: placeView(read.place),
    supplierDdtNumber: receipt.supplierDdtNumber,
    supplierDdtDate: day(receipt.supplierDdtDate),
    receivedAt: toUtcIso(receipt.receivedAt),
    buyerAsked: receipt.buyerTaskId !== null,
    ddtPhotos: read.photos,
    lines: read.lines.map((line) => {
      const item = read.items.get(line.itemId)!
      const colour = line.itemColourId ? read.colours.get(line.itemColourId) : undefined
      return { id: line.id, seq: line.seq, label: lineLabel(line.seq, item, colour), item: { id: item.id, code: item.code, name: item.name, tracking: item.tracking as 'NONE' | 'LOT' | 'HIDE' }, colour: colour ? { code: colour.code, name: colour.name } : null, quantity: quantityText(line.quantity.toString()), uom: line.uom, hideCount: line.hideCount }
    }),
  }
}

/** GET /inventory/receiving/unplanned/:receiptId */
export async function getFloorUnplanned(caller: CommandCaller, receiptId: string) {
  const context = receiverOf(caller)
  return { receipt: await floorUnplannedView(caller, context, receiptId) }
}
