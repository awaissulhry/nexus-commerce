import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { scanSubjectFor } from '../../production/settings/subject'
import { mayAt, officeContextOf } from '../ledger/access'
import { viewsOf } from '../reservations/read'
import { RESERVATION_COLUMNS } from '../reservations/store'
import { decimalText, fixed, locatedBy, mainPlace, PARTY_SELECT, partyName, perUnit, SCOPE, type Located } from './read-kit'
import type { HideRow, HideState } from './reads-contract'

/**
 * Warehouse › Hides (design warehouse.hides; SCM-233, SCM-253, SCM-258): every hide one by one — its measured area,
 * grade, shade, lot, state and where its stock lies — and one hide's record with what happened to its area (the cut
 * log) and its cuts. Office reads, inventory.stock.view; a hide's scope is its lot's company and site. B-W2a-64: each
 * hide says which ACTIVE reservation holds it whole (`reservedFor`, its demand; stale when that demand is done), the
 * Reserved view filters to them and the Reserved tile counts them.
 */

const IN_STOCK: HideState[] = ['FULL', 'PARTLY_CUT', 'REMNANT']

const HIDE_SELECT = {
  id: true,
  code: true,
  supplierCode: true,
  siteId: true,
  area: true,
  areaUom: true,
  baseArea: true,
  grade: true,
  shade: true,
  thicknessMm: true,
  defects: true,
  state: true,
  createdAt: true,
  lot: {
    select: {
      id: true,
      code: true,
      companyId: true,
      qualityStatus: true,
      crViStatus: true,
      dyeBatch: true,
      shade: true,
      receivedAt: true,
      item: { select: { id: true, code: true, name: true, baseUom: true, tracking: true } },
      itemColour: { select: { id: true, code: true, name: true } },
    },
  },
} as const satisfies Prisma.HideSelect
type HideData = Prisma.HideGetPayload<{ select: typeof HIDE_SELECT }>

/** The area the cut log took from each hide (used by cuts and set aside as remnants), net of reversed entries. */
async function cutAreaOf(client: Pick<FactoryClient, 'cutLog'>, hideIds: readonly string[]): Promise<Map<string, Decimal>> {
  if (hideIds.length === 0) return new Map()
  const rows = await client.cutLog.groupBy({ by: ['hideId', 'reversalOfId'], where: { hideId: { in: [...hideIds] } }, _sum: { baseAreaUsed: true, baseRemnantArea: true } })
  const result = new Map<string, Decimal>()
  for (const row of rows) {
    const taken = new Dec(row._sum.baseAreaUsed?.toString() ?? '0').plus(row._sum.baseRemnantArea?.toString() ?? '0')
    result.set(row.hideId, (result.get(row.hideId) ?? ZERO)[row.reversalOfId ? 'minus' : 'plus'](taken))
  }
  return result
}

/** What is left of a hide (the contract's `left`): its stock, or at the cutting table its measured area less its cuts. */
function leftOf(state: string, baseArea: Prisma.Decimal, onHand: Decimal, cut: Decimal | undefined): Decimal {
  if (state === 'CONSUMED' || state === 'SCRAPPED') return ZERO
  if (state === 'PARTLY_CUT' && onHand.isZero()) {
    const rest = new Dec(baseArea.toString()).minus(cut ?? ZERO)
    return rest.isNegative() ? ZERO : rest
  }
  return onHand
}

type ReservedFor = NonNullable<HideRow['reservedFor']>

/** The ACTIVE reservation holding each of these hides whole (a hide has at most one: the reserve refuses a second). */
async function reservedFor(client: FactoryClient, hideIds: readonly string[]): Promise<Map<string, ReservedFor>> {
  if (hideIds.length === 0) return new Map()
  const rows = await client.reservation.findMany({ where: { status: 'ACTIVE', hideId: { in: [...hideIds] } }, select: RESERVATION_COLUMNS, orderBy: { id: 'asc' } })
  const views = await viewsOf(client, rows, { withOrders: true })
  const result = new Map<string, ReservedFor>()
  for (const view of views) if (view.hide && !result.has(view.hide.id)) result.set(view.hide.id, { reservationId: view.id, version: view.version, demand: view.demand, stale: view.stale })
  return result
}

function rowOf(hide: HideData, located: Located | undefined, locations: ReadonlyMap<string, { id: string; code: string; name: string }>, cut: Decimal | undefined, reserved: ReservedFor | null): HideRow {
  const place = mainPlace(located)
  return {
    id: hide.id,
    code: hide.code,
    supplierCode: hide.supplierCode,
    siteId: hide.siteId,
    companyId: hide.lot.companyId,
    item: hide.lot.item,
    colour: hide.lot.itemColour,
    lot: { id: hide.lot.id, code: hide.lot.code, qualityStatus: hide.lot.qualityStatus, crViStatus: hide.lot.crViStatus, dyeBatch: hide.lot.dyeBatch, shade: hide.lot.shade },
    grade: hide.grade,
    shade: hide.shade,
    thicknessMm: decimalText(hide.thicknessMm, 2),
    defects: hide.defects,
    area: fixed(new Dec(hide.area.toString())),
    areaUom: hide.areaUom,
    baseArea: fixed(new Dec(hide.baseArea.toString())),
    onHand: fixed(located?.onHand),
    left: fixed(leftOf(hide.state, hide.baseArea, located?.onHand ?? ZERO, cut)),
    state: hide.state,
    location: place ? (locations.get(place) ?? null) : null,
    receivedAt: hide.lot.receivedAt ? toUtcIso(hide.lot.receivedAt) : null,
    createdAt: toUtcIso(hide.createdAt),
    reservedFor: reserved,
  }
}

export interface HideQuery {
  readonly siteId?: string | undefined
  readonly lotId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly state?: HideState | undefined
  readonly inStock?: boolean | undefined
  readonly reserved?: boolean | undefined
  readonly quality?: 'QUARANTINE' | 'RELEASED' | 'REJECTED' | 'BLOCKED' | undefined
  readonly locationId?: string | undefined
  readonly grade?: string | undefined
  readonly shade?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The hides the caller may see, newest first (UUIDv7 ids: the receiving order), with the tiles and the matching sums. */
export async function listHides(caller: CommandCaller, query: HideQuery) {
  const context = officeContextOf(caller)
  const lotScope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.LotWhereInput
  const scope: Prisma.HideWhereInput = { AND: [{ lot: lotScope }, query.siteId ? { siteId: query.siteId } : {}] }
  const text = query.q?.trim()
  return caller.withClient(async (client) => {
    let atLocation: string[] | null = null
    if (query.locationId) {
      const here = await locatedBy(client, 'hideId', { OR: [{ toLocationId: query.locationId }, { fromLocationId: query.locationId }] })
      atLocation = [...here].filter(([, located]) => (located.at.get(query.locationId!) ?? ZERO).greaterThan(0)).map(([hideId]) => hideId)
    }
    // The Reserved view: the hides of the scope an ACTIVE reservation holds whole.
    const reservedIds = query.reserved
      ? [...new Set((await client.reservation.findMany({ where: { status: 'ACTIVE', hideId: { not: null }, ...(query.siteId ? { siteId: query.siteId } : {}) }, select: { hideId: true } })).map((row) => row.hideId!))]
      : null
    const filters: Prisma.HideWhereInput = {
      AND: [
        scope,
        query.lotId ? { lotId: query.lotId } : {},
        query.itemId ? { itemId: query.itemId } : {},
        query.itemColourId ? { lot: { itemColourId: query.itemColourId } } : {},
        query.state ? { state: query.state } : query.inStock ? { state: { in: IN_STOCK } } : {},
        query.quality ? { lot: { qualityStatus: query.quality } } : {},
        query.grade ? { grade: { equals: query.grade, mode: 'insensitive' } } : {},
        query.shade ? { shade: { equals: query.shade, mode: 'insensitive' } } : {},
        text
          ? { OR: [{ code: { contains: text, mode: 'insensitive' } }, { supplierCode: { contains: text, mode: 'insensitive' } }, { lot: { code: { contains: text, mode: 'insensitive' } } }] }
          : {},
        atLocation ? { id: { in: atLocation } } : {},
        reservedIds ? { id: { in: reservedIds } } : {},
      ],
    }
    const page = await client.hide.findMany({ where: { AND: [filters, query.cursor ? { id: { lt: query.cursor } } : {}] }, select: HIDE_SELECT, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const shown = page.slice(0, query.limit)

    // Every hide of the scope (the tiles) and of the filters (the matching sums): their state, lot, unit and stock.
    const [all, matchingIds] = await Promise.all([
      client.hide.findMany({ where: scope, select: { id: true, state: true, baseArea: true, lot: { select: { qualityStatus: true, item: { select: { baseUom: true } } } } } }),
      client.hide.findMany({ where: filters, select: { id: true } }),
    ])
    const ids = all.map((hide) => hide.id)
    const [located, cutArea, reservations] = await Promise.all([
      ids.length > 0 ? locatedBy(client, 'hideId', { hideId: { in: ids } }) : Promise.resolve(new Map<string, Located>()),
      cutAreaOf(client, ids),
      reservedFor(client, ids),
    ])
    const locationIds = [...new Set(shown.flatMap((hide) => (mainPlace(located.get(hide.id)) ? [mainPlace(located.get(hide.id))!] : [])))]
    const locations = new Map(
      (locationIds.length > 0 ? await client.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]),
    )

    const left = (hide: (typeof all)[number]) => ({ uom: hide.lot.item.baseUom, quantity: leftOf(hide.state, hide.baseArea, located.get(hide.id)?.onHand ?? ZERO, cutArea.get(hide.id)) })
    const count = (rows: typeof all, area: (hide: (typeof all)[number]) => { uom: (typeof all)[number]['lot']['item']['baseUom']; quantity: Decimal } = left) => ({ hides: rows.length, area: perUnit(rows.map(area)) })
    const inStock = all.filter((hide) => IN_STOCK.includes(hide.state as HideState))
    const matching = new Set(matchingIds.map((hide) => hide.id))
    return {
      hides: shown.map((hide) => rowOf(hide, located.get(hide.id), locations, cutArea.get(hide.id), reservations.get(hide.id) ?? null)),
      nextCursor: page.length > query.limit ? shown[shown.length - 1]!.id : null,
      counts: {
        full: count(inStock.filter((hide) => hide.state === 'FULL')),
        partlyCut: count(inStock.filter((hide) => hide.state === 'PARTLY_CUT')),
        remnant: count(inStock.filter((hide) => hide.state === 'REMNANT')),
        quarantine: count(inStock.filter((hide) => hide.lot.qualityStatus === 'QUARANTINE')),
        // A consumed hide has nothing left: its measured area says how much leather it was.
        consumed: count(
          all.filter((hide) => hide.state === 'CONSUMED'),
          (hide) => ({ uom: hide.lot.item.baseUom, quantity: new Dec(hide.baseArea.toString()) }),
        ),
        reserved: count(inStock.filter((hide) => reservations.has(hide.id))),
      },
      matching: count(all.filter((hide) => matching.has(hide.id))),
    }
  })
}

/** One hide: its facts, its lot's quality, what happened to its area and every cut of it (the cut log, append-only). */
export async function hideRecord(caller: CommandCaller, hideId: string) {
  const context = officeContextOf(caller)
  const hide = isUuid(hideId) ? await caller.withClient((client) => client.hide.findUnique({ where: { id: hideId }, select: HIDE_SELECT })) : null
  if (!hide || !mayAt(context, INVENTORY_STOCK_VIEW, { companyId: hide.lot.companyId, siteId: hide.siteId })) throw new NotFoundError('Hide not found.')
  return caller.withClient(async (client) => {
    const [located, lot, cuts, subject, cutArea, reservations] = await Promise.all([
      locatedBy(client, 'hideId', { hideId: hide.id }),
      client.lot.findUnique({
        where: { id: hide.lot.id },
        select: {
          qualityNote: true,
          crViMgKg: true,
          crViLimitMgKg: true,
          crViTestedAt: true,
          supplierLotRef: true,
          supplier: { select: PARTY_SELECT },
          receiptLine: { select: { receipt: { select: { id: true, number: true } } } },
        },
      }),
      client.cutLog.findMany({
        where: { hideId: hide.id },
        orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          serverTime: true,
          deviceTime: true,
          uom: true,
          areaUsed: true,
          remnantArea: true,
          baseAreaUsed: true,
          baseRemnantArea: true,
          note: true,
          workerId: true,
          reversalOfId: true,
          workOrder: { select: { id: true, number: true } },
          station: { select: { id: true, code: true, name: true } },
          device: { select: { id: true, name: true } },
          pieces: { select: { pieces: true } },
          reversals: { select: { id: true } },
        },
      }),
      scanSubjectFor(client, hide.siteId),
      cutAreaOf(client, [hide.id]),
      reservedFor(client, [hide.id]),
    ])
    const stationOnly = subject === 'STATION'
    const workerIds = stationOnly ? [] : [...new Set(cuts.flatMap((cut) => (cut.workerId ? [cut.workerId] : [])))]
    const workers = new Map((workerIds.length > 0 ? await client.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } }) : []).map((worker) => [worker.id, worker.displayName]))
    const located1 = located.get(hide.id)
    const place = mainPlace(located1)
    const locations = new Map((place ? await client.location.findMany({ where: { id: place }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
    // A reversal entry mirrors its original (same areas): the net of the log.
    const net = (pick: (cut: (typeof cuts)[number]) => Prisma.Decimal) => cuts.reduce<Decimal>((sum, cut) => (cut.reversalOfId ? sum.minus(pick(cut).toString()) : sum.plus(pick(cut).toString())), ZERO)
    return {
      hide: rowOf(hide, located1, locations, cutArea.get(hide.id), reservations.get(hide.id) ?? null),
      lot: {
        id: hide.lot.id,
        code: hide.lot.code,
        qualityStatus: hide.lot.qualityStatus,
        qualityNote: lot?.qualityNote ?? null,
        crVi: { status: hide.lot.crViStatus, valueMgKg: decimalText(lot?.crViMgKg, 3), limitMgKg: decimalText(lot?.crViLimitMgKg, 3), testedOn: lot?.crViTestedAt ? lot.crViTestedAt.toISOString().slice(0, 10) : null },
        supplier: partyName(lot?.supplier),
        supplierLotRef: lot?.supplierLotRef ?? null,
        receipt: lot?.receiptLine?.receipt ?? null,
      },
      area: {
        measured: fixed(new Dec(hide.baseArea.toString())),
        cut: fixed(net((cut) => cut.baseAreaUsed)),
        remnant: fixed(net((cut) => cut.baseRemnantArea)),
        onHand: fixed(located1?.onHand),
        uom: hide.lot.item.baseUom,
      },
      cuts: cuts.map((cut) => ({
        id: cut.id,
        at: toUtcIso(cut.serverTime),
        deviceTime: cut.deviceTime ? toUtcIso(cut.deviceTime) : null,
        workOrder: cut.workOrder,
        areaUsed: fixed(new Dec(cut.areaUsed.toString())),
        remnantArea: fixed(new Dec(cut.remnantArea.toString())),
        uom: cut.uom,
        baseAreaUsed: fixed(new Dec(cut.baseAreaUsed.toString())),
        baseRemnantArea: fixed(new Dec(cut.baseRemnantArea.toString())),
        pieces: cut.pieces.reduce((sum, piece) => sum + piece.pieces, 0),
        station: cut.station,
        device: cut.device,
        cutBy: !stationOnly && cut.workerId ? (workers.get(cut.workerId) ?? null) : null,
        note: cut.note,
        reversalOfId: cut.reversalOfId,
        reversedById: cut.reversals[0]?.id ?? null,
      })),
      stationOnly,
    }
  })
}
