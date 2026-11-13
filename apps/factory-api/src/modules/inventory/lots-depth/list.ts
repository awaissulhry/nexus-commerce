import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { DEFAULT_LIST_LIFECYCLES, LOT_LIFECYCLES, type LotLifecycle } from '@nexus/factory-domain/inventory/lots-depth/lifecycle'
import { addDays, EXPIRING_DAYS } from '@nexus/factory-domain/inventory/lots-depth/page'
import { workOrderUses } from '@nexus/factory-domain/quality/lab/trace'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../ledger/access'
import { decimalText, fixed, locatedBy, PARTY_SELECT, partyName, SCOPE } from '../stock/read-kit'
import type { DepthRow } from './contract'

/**
 * Warehouse › Lots & traceability with its W2b columns (B-W2b-313; SCM-236 "depleted lots hidden by default but
 * searchable", SCM-185 "searchable"; design warehouse.lots lt-grid "Rows ▾ … Depleted (W2b)", "Lifecycle (W2b)", lt-metrics
 * "Documents expiring in 30 days (W2b)"). GET /inventory/lots-depth, office, inventory.stock.view, read only: W1's lot row
 * (GET /inventory/lots, stock/lots.ts) with the lifecycle, the parent lot, the child lots, the attributes and the documents
 * ending within 30 days; filtered by lifecycle (by default every lot but the depleted ones), the family, the attributes and
 * W1's filters; newest first. The tiles count the caller's lots at the site asked per lifecycle, and those with a document
 * ending within 30 days (a child counts its parent's documents).
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
  lifecycle: true,
  parentLotId: true,
  attributes: true,
  site: { select: { code: true } },
  item: { select: { id: true, code: true, name: true, baseUom: true, tracking: true } },
  itemColour: { select: { id: true, code: true, name: true } },
  supplier: { select: PARTY_SELECT },
  receiptLine: { select: { receipt: { select: { id: true, number: true } } } },
  parentLot: { select: { id: true, code: true } },
  _count: { select: { childLots: true } },
} as const satisfies Prisma.LotSelect
type LotData = Prisma.LotGetPayload<{ select: typeof LOT_SELECT }>

export interface DepthListQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly supplierId?: string | undefined
  readonly quality?: 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED' | undefined
  readonly lifecycle?: LotLifecycle | undefined
  readonly view?: 'ACTIVE' | 'DEPLETED' | 'ALL' | undefined
  readonly parentLotId?: string | undefined
  readonly documentsExpiring?: boolean | undefined
  readonly tannage?: string | undefined
  readonly finish?: string | undefined
  readonly origin?: string | undefined
  readonly q?: string | undefined
  /** B-W2b-320: only these lots (the rows of a W1 view, for their W2b columns). */
  readonly ids?: readonly string[] | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The lots (of these) with an ACTIVE document ending by `until` (their own, or their parent's): lot id → how many. */
async function expiringOf(client: FactoryClient, lots: readonly { readonly id: string; readonly parentLotId: string | null }[], until: Date): Promise<Map<string, number>> {
  const ids = [...new Set(lots.flatMap((lot) => (lot.parentLotId ? [lot.id, lot.parentLotId] : [lot.id])))]
  if (ids.length === 0) return new Map()
  const rows = await client.lotDocument.groupBy({ by: ['lotId'], where: { lotId: { in: ids }, status: 'ACTIVE', validTo: { lte: until } }, _count: { _all: true } })
  const own = new Map(rows.map((row) => [row.lotId, row._count._all]))
  return new Map(lots.map((lot) => [lot.id, (own.get(lot.id) ?? 0) + (lot.parentLotId ? (own.get(lot.parentLotId) ?? 0) : 0)]))
}

/** W1's figures of each lot: stock, hides in stock, documents, work orders it went to. */
async function figuresOf(client: FactoryClient, lotIds: readonly string[]) {
  const ids = [...lotIds]
  if (ids.length === 0) return new Map<string, { onHand: string; hides: number; documents: number; issuedTo: number }>()
  const [located, byHide, documents, issues] = await Promise.all([
    locatedBy(client, 'lotId', { lotId: { in: ids } }),
    locatedBy(client, 'hideId', { lotId: { in: ids }, hideId: { not: null } }),
    client.lotDocument.groupBy({ by: ['lotId'], where: { lotId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } }),
    client.stockMove.findMany({ where: { lotId: { in: ids }, reason: { in: ['ISSUE', 'RETURN', 'REMNANT'] } }, select: { id: true, lotId: true, reason: true, workOrderId: true, baseQuantity: true, reversalOfId: true, hideId: true } }),
  ])
  const inStock = [...byHide].filter(([, entry]) => entry.onHand.greaterThan(0)).map(([hideId]) => hideId)
  const hideLots = inStock.length > 0 ? await client.hide.findMany({ where: { id: { in: inStock } }, select: { lotId: true } }) : []
  const hides = new Map<string, number>()
  for (const row of hideLots) hides.set(row.lotId, (hides.get(row.lotId) ?? 0) + 1)
  const documentsOf = new Map(documents.map((row) => [row.lotId, row._count._all]))
  return new Map(
    ids.map((lotId) => [
      lotId,
      {
        onHand: fixed(located.get(lotId)?.onHand),
        hides: hides.get(lotId) ?? 0,
        documents: documentsOf.get(lotId) ?? 0,
        issuedTo: workOrderUses(issues.filter((move) => move.lotId === lotId).map((move) => ({ ...move, baseQuantity: move.baseQuantity.toString() }))).length,
      },
    ]),
  )
}

function rowOf(lot: LotData, figures: { onHand: string; hides: number; documents: number; issuedTo: number }, expiring: number): DepthRow {
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
    onHand: figures.onHand,
    hides: figures.hides,
    issuedTo: figures.issuedTo,
    lifecycle: lot.lifecycle as LotLifecycle,
    parentLot: lot.parentLot,
    childLots: lot._count.childLots,
    attributes: (lot.attributes ?? {}) as DepthRow['attributes'],
    documentsExpiring: expiring,
  }
}

/** GET /inventory/lots-depth. */
export async function listLotsDepth(caller: CommandCaller, query: DepthListQuery) {
  const context = officeContextOf(caller)
  const scope: Prisma.LotWhereInput = { AND: [scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.LotWhereInput, query.siteId ? { siteId: query.siteId } : {}] }
  const until = new Date(`${addDays(businessDate(serverClock.now()), EXPIRING_DAYS)}T00:00:00Z`)
  const text = query.q?.trim()
  const lifecycles: readonly LotLifecycle[] = query.lifecycle ? [query.lifecycle] : query.view === 'DEPLETED' ? ['DEPLETED'] : query.view === 'ALL' ? LOT_LIFECYCLES : DEFAULT_LIST_LIFECYCLES
  return caller.withClient(async (client) => {
    // The documents ending within 30 days: their lots, and the children of those lots (a child carries its parent's).
    let expiringIds: string[] | null = null
    if (query.documentsExpiring) {
      const documents = await client.lotDocument.findMany({ where: { status: 'ACTIVE', validTo: { lte: until } }, select: { lotId: true } })
      const direct = [...new Set(documents.map((row) => row.lotId))]
      const children = direct.length > 0 ? await client.lot.findMany({ where: { parentLotId: { in: direct } }, select: { id: true } }) : []
      expiringIds = [...direct, ...children.map((row) => row.id)]
    }
    const filters: Prisma.LotWhereInput = {
      AND: [
        scope,
        { lifecycle: { in: [...lifecycles] } },
        query.itemId ? { itemId: query.itemId } : {},
        query.supplierId ? { supplierId: query.supplierId } : {},
        query.quality ? { qualityStatus: query.quality } : {},
        query.parentLotId ? { parentLotId: query.parentLotId } : {},
        query.tannage ? { attributes: { path: ['tannage'], equals: query.tannage } } : {},
        query.finish ? { attributes: { path: ['finish'], string_contains: query.finish } } : {},
        query.origin ? { attributes: { path: ['origin'], string_contains: query.origin } } : {},
        expiringIds ? { id: { in: expiringIds } } : {},
        query.ids ? { id: { in: [...query.ids] } } : {},
        text
          ? { OR: [{ code: { contains: text, mode: 'insensitive' } }, { supplierLotRef: { contains: text, mode: 'insensitive' } }, { dyeBatch: { contains: text, mode: 'insensitive' } }, { shade: { contains: text, mode: 'insensitive' } }] }
          : {},
        query.cursor ? { id: { lt: query.cursor } } : {},
      ],
    }
    const page = await client.lot.findMany({ where: filters, select: LOT_SELECT, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const shown = page.slice(0, query.limit)
    const [figures, expiring, byLifecycle, scoped] = await Promise.all([
      figuresOf(client, shown.map((lot) => lot.id)),
      expiringOf(client, shown, until),
      client.lot.groupBy({ by: ['lifecycle'], where: scope, _count: { _all: true } }),
      client.lot.findMany({ where: scope, select: { id: true, parentLotId: true } }),
    ])
    const allExpiring = await expiringOf(client, scoped, until)
    return {
      lots: shown.map((lot) => rowOf(lot, figures.get(lot.id)!, expiring.get(lot.id) ?? 0)),
      nextCursor: page.length > query.limit ? shown[shown.length - 1]!.id : null,
      counts: {
        lifecycle: Object.fromEntries(LOT_LIFECYCLES.map((value) => [value, byLifecycle.find((row) => row.lifecycle === value)?._count._all ?? 0])) as Record<LotLifecycle, number>,
        documentsExpiring: [...allExpiring.values()].filter((count) => count > 0).length,
      },
    }
  })
}
