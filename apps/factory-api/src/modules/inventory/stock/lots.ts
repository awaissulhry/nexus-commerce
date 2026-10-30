import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { workOrderUses } from '@nexus/factory-domain/quality/lab/trace'
import { ZERO } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, officeContextOf } from '../ledger/access'
import { decimalText, fixed, locatedBy, PARTY_SELECT, partyName, SCOPE, type Located } from './read-kit'
import type { LotRow } from './reads-contract'

/**
 * Warehouse › Lots & traceability (design warehouse.lots; SCM-232, SCM-240, SCM-241; Owner answer Q3 (a): goods on
 * hold are reached from here): every lot with its stock, tests, documents and quality status, and one lot's record with
 * where its stock is and its trace as far as the records go — backward to the supplier, the purchase order line, the
 * receipt and the supplier's DDT; forward to the work orders that took it (the issue ledger, less reversals), their
 * shipments and the customers reached. Office reads, inventory.stock.view; quality decisions stay with the quality step
 * (modules/quality/lab).
 */

const LOT_SELECT = {
  id: true,
  code: true,
  companyId: true,
  siteId: true,
  supplierLotRef: true,
  dyeBatch: true,
  shade: true,
  receivedAt: true,
  receiptLineId: true,
  qualityStatus: true,
  qualityNote: true,
  qualityDecidedAt: true,
  requiresCrViTest: true,
  crViStatus: true,
  crViMgKg: true,
  crViLimitMgKg: true,
  crViEvidence: true,
  crViTestedAt: true,
  site: { select: { code: true } },
  item: { select: { id: true, code: true, name: true, baseUom: true, tracking: true } },
  itemColour: { select: { id: true, code: true, name: true } },
  supplier: { select: PARTY_SELECT },
  receiptLine: { select: { seq: true, receipt: { select: { id: true, number: true } }, purchaseOrderLine: { select: { seq: true, purchaseOrder: { select: { id: true, number: true } } } } } },
} as const satisfies Prisma.LotSelect
type LotData = Prisma.LotGetPayload<{ select: typeof LOT_SELECT }>

interface LotFigures {
  readonly located: Located | undefined
  readonly hides: number
  readonly documents: number
  readonly issuedTo: number
}

function rowOf(lot: LotData, figures: LotFigures): LotRow {
  return {
    id: lot.id,
    code: lot.code,
    companyId: lot.companyId,
    siteId: lot.siteId,
    siteCode: lot.site.code,
    item: lot.item,
    colour: lot.itemColour,
    supplier: partyName(lot.supplier),
    supplierLotRef: lot.supplierLotRef,
    dyeBatch: lot.dyeBatch,
    shade: lot.shade,
    receivedAt: lot.receivedAt ? toUtcIso(lot.receivedAt) : null,
    receipt: lot.receiptLine?.receipt ?? null,
    opening: lot.receiptLineId === null,
    qualityStatus: lot.qualityStatus,
    qualityNote: lot.qualityNote,
    qualityDecidedAt: lot.qualityDecidedAt ? toUtcIso(lot.qualityDecidedAt) : null,
    crVi: {
      required: lot.requiresCrViTest,
      status: lot.crViStatus,
      valueMgKg: decimalText(lot.crViMgKg, 3),
      limitMgKg: decimalText(lot.crViLimitMgKg, 3),
      evidence: lot.crViEvidence ?? null,
      testedOn: lot.crViTestedAt ? lot.crViTestedAt.toISOString().slice(0, 10) : null,
    },
    documents: figures.documents,
    onHand: fixed(figures.located?.onHand),
    hides: figures.hides,
    issuedTo: figures.issuedTo,
  }
}

/** The stock, the hides in stock, the documents and the work orders of each lot (one read per figure, all lots at once). */
async function figuresOf(client: FactoryClient, lotIds: readonly string[]): Promise<Map<string, LotFigures>> {
  if (lotIds.length === 0) return new Map()
  const ids = [...lotIds]
  const [located, hides, documents, issues] = await Promise.all([
    locatedBy(client, 'lotId', { lotId: { in: ids } }),
    locatedBy(client, 'hideId', { lotId: { in: ids }, hideId: { not: null } }).then(async (byHide) => {
      const inStock = [...byHide].filter(([, entry]) => entry.onHand.greaterThan(0)).map(([hideId]) => hideId)
      const rows = inStock.length > 0 ? await client.hide.findMany({ where: { id: { in: inStock } }, select: { lotId: true } }) : []
      const counts = new Map<string, number>()
      for (const row of rows) counts.set(row.lotId, (counts.get(row.lotId) ?? 0) + 1)
      return counts
    }),
    client.lotDocument.groupBy({ by: ['lotId'], where: { lotId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } }),
    client.stockMove.findMany({ where: { lotId: { in: ids }, reason: { in: ['ISSUE', 'RETURN'] } }, select: { id: true, lotId: true, reason: true, workOrderId: true, baseQuantity: true, reversalOfId: true, hideId: true } }),
  ])
  const documentsOf = new Map(documents.map((row) => [row.lotId, row._count._all]))
  const result = new Map<string, LotFigures>()
  for (const lotId of ids) {
    const moves = issues.filter((move) => move.lotId === lotId).map((move) => ({ ...move, baseQuantity: move.baseQuantity.toString() }))
    result.set(lotId, { located: located.get(lotId), hides: hides.get(lotId) ?? 0, documents: documentsOf.get(lotId) ?? 0, issuedTo: workOrderUses(moves).length })
  }
  return result
}

export interface StockLotQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly supplierId?: string | undefined
  readonly quality?: 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED' | undefined
  readonly onHold?: boolean | undefined
  readonly crVi?: 'NOT_REQUIRED' | 'PENDING' | 'PASS' | 'FAIL' | undefined
  readonly inStock?: boolean | undefined
  readonly receivedFrom?: string | undefined
  readonly receivedTo?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The lots the caller may see, newest first (UUIDv7: the order they were made), with the tiles' counts. */
export async function listStockLots(caller: CommandCaller, query: StockLotQuery) {
  const context = officeContextOf(caller)
  const scope: Prisma.LotWhereInput = { AND: [scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.LotWhereInput, query.siteId ? { siteId: query.siteId } : {}] }
  const text = query.q?.trim()
  return caller.withClient(async (client) => {
    let inStock: string[] | null = null
    if (query.inStock) {
      const scoped = await client.lot.findMany({ where: scope, select: { id: true } })
      const located = scoped.length > 0 ? await locatedBy(client, 'lotId', { lotId: { in: scoped.map((lot) => lot.id) } }) : new Map<string, Located>()
      inStock = [...located].filter(([, entry]) => entry.onHand.greaterThan(0)).map(([lotId]) => lotId)
    }
    const filters: Prisma.LotWhereInput = {
      AND: [
        scope,
        query.itemId ? { itemId: query.itemId } : {},
        query.supplierId ? { supplierId: query.supplierId } : {},
        query.quality ? { qualityStatus: query.quality } : query.onHold ? { qualityStatus: { in: ['QUARANTINE', 'BLOCKED'] } } : {},
        query.crVi ? { crViStatus: query.crVi } : {},
        query.receivedFrom ? { receivedAt: { gte: parseInstant(query.receivedFrom)! } } : {},
        query.receivedTo ? { receivedAt: { lt: parseInstant(query.receivedTo)! } } : {},
        text
          ? { OR: [{ code: { contains: text, mode: 'insensitive' } }, { supplierLotRef: { contains: text, mode: 'insensitive' } }, { dyeBatch: { contains: text, mode: 'insensitive' } }] }
          : {},
        inStock ? { id: { in: inStock } } : {},
        query.cursor ? { id: { lt: query.cursor } } : {},
      ],
    }
    const page = await client.lot.findMany({ where: filters, select: LOT_SELECT, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const shown = page.slice(0, query.limit)
    const [figures, byStatus, byCrVi] = await Promise.all([
      figuresOf(client, shown.map((lot) => lot.id)),
      client.lot.groupBy({ by: ['qualityStatus'], where: scope, _count: { _all: true } }),
      client.lot.groupBy({ by: ['crViStatus'], where: { AND: [scope, { qualityStatus: { not: 'REJECTED' } }] }, _count: { _all: true } }),
    ])
    const status = (value: string) => byStatus.find((row) => row.qualityStatus === value)?._count._all ?? 0
    const crVi = (value: string) => byCrVi.find((row) => row.crViStatus === value)?._count._all ?? 0
    return {
      lots: shown.map((lot) => rowOf(lot, figures.get(lot.id)!)),
      nextCursor: page.length > query.limit ? shown[shown.length - 1]!.id : null,
      counts: { quarantine: status('QUARANTINE'), waitingCrVi: crVi('PENDING'), crViFailed: crVi('FAIL'), blocked: status('BLOCKED'), rejected: status('REJECTED'), released: status('RELEASED') },
    }
  })
}

/** One lot: where its stock is, its hides, and its trace both ways. */
export async function stockLotRecord(caller: CommandCaller, lotId: string) {
  const context = officeContextOf(caller)
  const lot = isUuid(lotId) ? await caller.withClient((client) => client.lot.findUnique({ where: { id: lotId }, select: { ...LOT_SELECT, receiptLine: { select: { ...LOT_SELECT.receiptLine.select, receipt: { select: { id: true, number: true, status: true, receivedAt: true, supplierDdtNumber: true, supplierDdtDate: true } } } } } })) : null
  if (!lot || !mayAt(context, INVENTORY_STOCK_VIEW, lot)) throw new NotFoundError('Lot not found.')
  return caller.withClient(async (client) => {
    const [figures, located, hideStates, issueMoves, moves] = await Promise.all([
      figuresOf(client, [lot.id]),
      locatedBy(client, 'lotId', { lotId: lot.id }),
      client.hide.groupBy({ by: ['state'], where: { lotId: lot.id }, _count: { _all: true } }),
      client.stockMove.findMany({ where: { lotId: lot.id, reason: { in: ['ISSUE', 'RETURN'] } }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], select: { id: true, reason: true, workOrderId: true, baseQuantity: true, reversalOfId: true, hideId: true } }),
      client.stockMove.count({ where: { lotId: lot.id } }),
    ])
    const here = located.get(lot.id)
    const placeIds = [...(here?.at.keys() ?? [])]
    const [places, hidesAt] = await Promise.all([
      placeIds.length > 0 ? client.location.findMany({ where: { id: { in: placeIds } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }) : Promise.resolve([]),
      // Hides in stock per place: a hide's stock lies where its balance is.
      locatedBy(client, 'hideId', { lotId: lot.id, hideId: { not: null } }),
    ])
    const hidesPerPlace = new Map<string, number>()
    for (const entry of hidesAt.values()) for (const [placeId, quantity] of entry.at) if (quantity.greaterThan(0)) hidesPerPlace.set(placeId, (hidesPerPlace.get(placeId) ?? 0) + 1)
    const held = lot.qualityStatus !== 'RELEASED'

    const uses = workOrderUses(issueMoves.map((move) => ({ ...move, baseQuantity: move.baseQuantity.toString() })))
    const workOrderIds = uses.map((use) => use.workOrderId)
    const [orders, lines] = await Promise.all([
      workOrderIds.length > 0 ? client.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, batchNumber: true, status: true } }) : Promise.resolve([]),
      workOrderIds.length > 0
        ? client.shipmentLine.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { quantity: true, shipment: { select: { id: true, number: true, status: true, partyId: true } } } })
        : Promise.resolve([]),
    ])
    const orderOf = new Map(orders.map((order) => [order.id, order]))
    const shipments = new Map<string, { id: string; number: string; status: string; partyId: string; garments: number }>()
    for (const line of lines) {
      const entry = shipments.get(line.shipment.id) ?? { ...line.shipment, garments: 0 }
      entry.garments += line.quantity
      shipments.set(line.shipment.id, entry)
    }
    const partyIds = [...new Set([...shipments.values()].map((shipment) => shipment.partyId))]
    const parties = new Map((partyIds.length > 0 ? await client.party.findMany({ where: { id: { in: partyIds } }, select: PARTY_SELECT }) : []).map((party) => [party.id, partyName(party)]))
    const states = (value: string) => hideStates.find((row) => row.state === value)?._count._all ?? 0
    const receipt = lot.receiptLine?.receipt ?? null
    const order = lot.receiptLine?.purchaseOrderLine?.purchaseOrder ?? null

    return {
      lot: rowOf(lot, figures.get(lot.id)!),
      stock: places.map((place) => {
        const onHand = here?.at.get(place.id) ?? ZERO
        return { location: place, onHand: fixed(onHand), held: fixed(held ? onHand : ZERO), hides: hidesPerPlace.get(place.id) ?? 0 }
      }),
      hides: { inStock: states('FULL') + states('PARTLY_CUT') + states('REMNANT'), consumed: states('CONSUMED'), scrapped: states('SCRAPPED') },
      trace: {
        backward: {
          supplier: partyName(lot.supplier),
          receipt: receipt
            ? { id: receipt.id, number: receipt.number, status: receipt.status, receivedAt: toUtcIso(receipt.receivedAt), supplierDdtNumber: receipt.supplierDdtNumber, supplierDdtDate: receipt.supplierDdtDate ? receipt.supplierDdtDate.toISOString().slice(0, 10) : null }
            : null,
          purchaseOrder: order ? { id: order.id, number: order.number, lineSeq: lot.receiptLine?.purchaseOrderLine?.seq ?? null } : null,
        },
        forward: {
          workOrders: uses.map((use) => {
            const found = orderOf.get(use.workOrderId)
            return { id: use.workOrderId, number: found?.number ?? null, batchNumber: found?.batchNumber ?? null, status: found?.status ?? null, issued: use.issued, returned: use.returned, atWorkOrder: use.atWorkOrder, hides: use.hideIds.length }
          }),
          shipments: [...shipments.values()].map((shipment) => ({ id: shipment.id, number: shipment.number, status: shipment.status, customer: parties.get(shipment.partyId) ?? null, garments: shipment.garments })),
          customers: partyIds.length,
        },
      },
      moves,
    }
  })
}

