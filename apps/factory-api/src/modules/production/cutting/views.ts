import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { issueDecision } from '@nexus/factory-domain/inventory/issue/rules'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { usabilityOf } from '@nexus/factory-domain/planning/usable'
import { PRODUCTION_CUT } from '@nexus/factory-domain/production/cutting/permissions'
import {
  CUTTABLE_STATUSES,
  cellProgress,
  cuttableRefusal,
  entryPattern,
  hideArea,
  lotWords,
  partsOf,
  perGarmentOf,
  piecesOf,
  setsCut,
  type CutRefusal,
  type Material,
  type PlannedPart,
} from '@nexus/factory-domain/production/cutting/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { cuttingWorkOrder, entryView, mayCut } from './cut'
import {
  CUT_HEADER,
  latestEntryOf,
  liveOf,
  readCells,
  readCutTotals,
  readEntries,
  readHideAtWorkOrders,
  readHideByCode,
  readHideLedger,
  readHideOnHand,
  readItem,
  readLocations,
  readLot,
  readPieces,
  readPlannedParts,
  readStations,
  type CellRow,
  type CutHeader,
  type Reader,
} from './store'

/**
 * The cutting screens' reads (B-W1-40; A2 SCR-094 floor cutting, SCR-071 the work order's cutting; MES-051, MES-056,
 * MES-057): the work orders a site cuts for, a work order as the cutting table sees it (its cells with what is cut and
 * still to cut per material, its hides with the area left, the cutter's own last entry it may still undo), a scanned
 * hide (area, grade, thickness, shade, lot and its quality, state, where it is, what it can still cut for which work
 * order), and for the office a work order's cut log (every entry, each hide's area bar, the cut count per cell). The
 * floor sees no worker's name; nothing here carries money.
 */

const text = (value: { toString(): string }) => quantityText(value.toString())
const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)

/** A cell's cut state for one material: its parts, the BOM need per garment, the sets cut and still to cut. */
function materialCell(planned: readonly PlannedPart[], pieces: ReturnType<typeof piecesOf>, cell: CellRow, material: Material) {
  const parts = partsOf(planned, cell.id, material)
  if (parts.length === 0) return null
  const cut = setsCut(parts, pieces) ?? 0
  return { parts, perGarment: text((perGarmentOf(planned, cell, material) ?? ZERO).toDecimalPlaces(4, Dec.ROUND_HALF_UP)), cut, toCut: Math.max(0, cell.quantity - cut) }
}

/** The hide-cut materials of a work order (item and colour), in the order of their rows. */
function materialsOf(planned: readonly PlannedPart[]): Material[] {
  const seen = new Map<string, Material>()
  for (const row of planned) seen.set(`${row.itemId}|${row.itemColourId ?? '-'}`, { itemId: row.itemId, itemColourId: row.itemColourId })
  return [...seen.values()]
}

async function colourCodes(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  const rows = wanted.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true } })
  return new Map(rows.map((row) => [row.id, row.code]))
}

// ---- the work orders to cut for -------------------------------------------------------------------------------------------------

export interface CuttingQuery {
  readonly number?: string | undefined
  readonly limit: number
}

/** RELEASED and IN_PROGRESS work orders with parts cut from hides, at the caller's sites: the most urgent first. */
export async function cuttingWorkOrders(caller: CommandCaller, query: CuttingQuery) {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new NotFoundError('Work order not found.')
  const where: Prisma.WorkOrderWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PRODUCTION_CUT, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
      { status: { in: [...CUTTABLE_STATUSES] } },
      context.audience === 'floor' ? { siteId: context.siteId } : {},
      query.number ? { number: query.number.trim() } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await db.workOrder.findMany({ where, orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { number: 'asc' }], take: query.limit, select: CUT_HEADER })
    const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.styleId))] } }, select: { id: true, code: true, name: true } })).map((style) => [style.id, style]))
    const workOrders = []
    for (const row of rows) {
      const planned = await readPlannedParts(db, row.id)
      if (planned.length === 0) continue
      const cells = await readCells(db, row.id, row.styleId)
      const progress = cellProgress(cells, planned, await readPieces(db, liveOf(await readEntries(db, row.id)).map((entry) => entry.id)))
      const left = cells.filter((_cell, index) => (progress[index]!.toCut ?? 0) > 0)
      workOrders.push({
        id: row.id,
        number: row.number,
        batchNumber: row.batchNumber,
        status: row.status,
        siteId: row.siteId,
        dueDate: day(row.dueDate),
        priority: row.priority,
        style: styles.get(row.styleId) ?? { id: row.styleId, code: '', name: '' },
        colourways: [...new Set(cells.map((cell) => cell.colourwayCode))].sort(),
        pieces: cells.reduce((sum, cell) => sum + cell.quantity, 0),
        toCut: progress.reduce((sum, cell) => sum + (cell.toCut ?? 0), 0),
        sizesLeft: left.map((cell) => `${cell.colourwayCode} ${cell.size}`),
      })
    }
    return { workOrders }
  })
}

// ---- a work order at the cutting table ----------------------------------------------------------------------------------------

/** The cutting view of a work order: its cells per material, the hides it holds, the caller's own last entry to undo. */
export async function cuttingView(caller: CommandCaller, workOrderId: string) {
  const workOrder = await cuttingWorkOrder(caller, workOrderId, PRODUCTION_CUT)
  const context = caller.factoryContext!
  return caller.withClient(async (db) => {
    const style = await db.style.findUnique({ where: { id: workOrder.styleId }, select: { id: true, code: true, name: true } })
    const planned = await readPlannedParts(db, workOrder.id)
    const cells = await readCells(db, workOrder.id, workOrder.styleId)
    const all = await readEntries(db, workOrder.id)
    const live = liveOf(all)
    const pieces = await readPieces(db, live.map((entry) => entry.id))
    const materials = materialsOf(planned)
    const colours = await colourCodes(db, materials.map((material) => material.itemColourId))
    const progress = cellProgress(cells, planned, pieces)
    const hideIds = await heldHides(db, workOrder)
    const ledger = await readHideLedger(db, workOrder.siteId, workOrder.id, hideIds)
    const cut = await readCutTotals(db, workOrder.siteId, workOrder.id, hideIds)
    const hides = hideIds.length === 0 ? [] : await db.hide.findMany({ where: { id: { in: hideIds } }, select: { id: true, code: true, lotId: true, state: true, grade: true } })
    const lots = new Map((await db.lot.findMany({ where: { id: { in: [...new Set(hides.map((hide) => hide.lotId))] } }, select: { id: true, code: true, dyeBatch: true } })).map((lot) => [lot.id, lot]))
    // The cutter's own last entry, while it is the device's newest and still live (the Undo strip).
    let undo: ReturnType<typeof entryView> | null = null
    if (context.audience === 'floor') {
      const latest = await latestEntryOf(db, workOrder.siteId, context.deviceId)
      const entry = live.find((row) => row.id === latest && row.workOrderId === workOrder.id && (row.createdById === null || row.createdById === context.actorId))
      if (entry) undo = entryView(entry, pieces)
    }
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, batchNumber: workOrder.batchNumber, status: workOrder.status, companyId: workOrder.companyId, siteId: workOrder.siteId, dueDate: day(workOrder.dueDate), priority: workOrder.priority, cuttable: CUTTABLE_STATUSES.includes(workOrder.status), style },
      cells: cells.map((cell, index) => ({
        id: cell.id,
        colourwayCode: cell.colourwayCode,
        size: cell.size,
        quantity: cell.quantity,
        cut: progress[index]!.cut,
        toCut: progress[index]!.toCut,
        materials: materials.flatMap((material) => {
          const state = materialCell(planned, piecesOf(pieces, cell.id), cell, material)
          return state ? [{ itemId: material.itemId, itemColourId: material.itemColourId, colourCode: material.itemColourId ? (colours.get(material.itemColourId) ?? null) : null, ...state }] : []
        }),
        parts: progress[index]!.parts.map((part) => ({ ...part })),
      })),
      hides: hides
        .map((hide) => {
          const facts = ledger.get(hide.id)!
          const done = cut.get(hide.id) ?? ZERO
          return { hideId: hide.id, code: hide.code, lotId: hide.lotId, lotCode: lots.get(hide.lotId)?.code ?? '', dyeBatch: lots.get(hide.lotId)?.dyeBatch ?? null, grade: hide.grade, state: hide.state, atWorkOrder: text(facts.at), cut: text(done), left: text(Dec.max(ZERO, facts.at.minus(done))) }
        })
        .sort((a, b) => (a.code < b.code ? -1 : 1)),
      undo,
    }
  })
}

/** The hides the work order's ledger names (ISSUE and RETURN moves). */
async function heldHides(db: Reader, workOrder: CutHeader): Promise<string[]> {
  const rows = await db.stockMove.groupBy({ by: ['hideId'], where: { siteId: workOrder.siteId, workOrderId: workOrder.id, hideId: { not: null }, reason: { in: ['ISSUE', 'RETURN'] } } })
  return rows.flatMap((row) => (row.hideId ? [row.hideId] : []))
}

// ---- a scanned hide -------------------------------------------------------------------------------------------------------------

/** A scanned hide at the cutting table (MES-051): what it is, where it is, and what it can still cut for which work order. */
export async function scanHide(caller: CommandCaller, query: { readonly code: string; readonly workOrderId?: string | undefined }) {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new NotFoundError('Hide not found.')
  return caller.withClient(async (db) => {
    const hide = await readHideByCode(db, query.code)
    if (!hide || (context.audience === 'floor' && hide.siteId !== context.siteId)) throw new NotFoundError("Not a hide of this site: scan the hide's tag.")
    const lot = (await readLot(db, hide.lotId))!
    const item = (await readItem(db, hide.itemId))!
    const site = await db.site.findUnique({ where: { id: hide.siteId }, select: { id: true, companyId: true } })
    if (!site || !mayCut(context, PRODUCTION_CUT, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError("Not a hide of this site: scan the hide's tag.")
    const colour = lot.itemColourId ? await db.itemColour.findUnique({ where: { id: lot.itemColourId }, select: { code: true, name: true } }) : null
    const usability = usabilityOf(lot)
    const onHand = await readHideOnHand(db, hide.siteId, hide.id)
    const locations = await readLocations(db, onHand.map((row) => row.locationId))
    const atOrders = await readHideAtWorkOrders(db, hide.siteId, hide.id)
    const total = onHand.reduce((sum, row) => sum.plus(row.onHand), ZERO)

    // The open work orders of the site that cut this leather in this colour, or hold the hide.
    const holding = [...atOrders.entries()].filter(([, facts]) => facts.at.gt(0)).map(([id]) => id)
    const planning = await db.workOrderMaterial.findMany({ where: { itemId: hide.itemId, itemColourId: lot.itemColourId }, select: { workOrderId: true }, distinct: ['workOrderId'] })
    const candidateIds = [...new Set([...holding, ...planning.map((row) => row.workOrderId)])].filter((id) => !query.workOrderId || id === query.workOrderId)
    const orders = candidateIds.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: candidateIds }, siteId: hide.siteId, status: { in: [...CUTTABLE_STATUSES] } }, orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { number: 'asc' }], take: 20, select: CUT_HEADER })
    const material: Material = { itemId: hide.itemId, itemColourId: lot.itemColourId }
    const workOrders = []
    for (const workOrder of orders) {
      if (!mayCut(context, PRODUCTION_CUT, workOrder)) continue
      const facts = atOrders.get(workOrder.id)
      const holds = facts !== undefined && facts.at.gt(0)
      const left = holds ? Dec.max(ZERO, facts.at.minus(facts.cut)) : total
      const planned = await readPlannedParts(db, workOrder.id)
      const cells = await readCells(db, workOrder.id, workOrder.styleId)
      const pieces = await readPieces(db, liveOf(await readEntries(db, workOrder.id)).map((entry) => entry.id))
      let refusal: CutRefusal | null = cuttableRefusal({ workOrder, hide, lot })
      if (!refusal && !holds) {
        // Not at the work order yet: the cut would issue it first (B-W1-39's rules, the same words).
        const rows = await db.workOrderMaterial.findMany({ where: { workOrderId: workOrder.id, itemId: hide.itemId }, select: { itemColourId: true, baseQuantity: true } })
        const plannedQty = rows.filter((row) => row.itemColourId === lot.itemColourId).reduce((sum, row) => sum.plus(row.baseQuantity.toString()), ZERO)
        const issued = await issuedOf(db, workOrder, material)
        const decision = issueDecision({
          workOrder,
          label: `${item.code}${colour ? ` ${colour.code}` : ''}`,
          baseUom: item.baseUom,
          line: rows.some((row) => row.itemColourId === lot.itemColourId) ? { planned: plannedQty.toFixed(4), issued: issued.toFixed(4) } : null,
          materialPlanned: rows.length > 0,
          lot,
          hide,
          onHand: total.toFixed(4),
          requested: null,
          overIssueReason: null,
        })
        if (!decision.ok) refusal = { code: 'NOT_AT_WORK_ORDER', message: decision.refusal.message }
      } else if (!refusal && left.lte(0)) {
        refusal = { code: 'NOTHING_LEFT', message: `Hide ${hide.code} has nothing left for work order ${workOrder.number}: all of it was cut.` }
      }
      workOrders.push({
        id: workOrder.id,
        number: workOrder.number,
        status: workOrder.status,
        holdsHide: holds,
        left: text(left),
        cuttable: refusal === null,
        refusal,
        cells: cells.flatMap((cell) => {
          const state = materialCell(planned, piecesOf(pieces, cell.id), cell, material)
          return state ? [{ id: cell.id, colourwayCode: cell.colourwayCode, size: cell.size, quantity: cell.quantity, ...state }] : []
        }),
      })
    }
    // The last cut of the hide: when, for which work order, at which table (never who: MES-051, Statuto art. 4).
    const last = await db.cutLog.findFirst({ where: { hideId: hide.id, reversalOfId: null }, orderBy: [{ serverTime: 'desc' }, { id: 'desc' }], select: { serverTime: true, workOrderId: true, stationId: true } })
    const lastOrder = last ? await db.workOrder.findUnique({ where: { id: last.workOrderId }, select: { number: true } }) : null
    const stations = await readStations(db, last?.stationId ? [last.stationId] : [])
    return {
      hide: {
        id: hide.id,
        code: hide.code,
        supplierCode: hide.supplierCode,
        itemId: hide.itemId,
        itemCode: item.code,
        itemName: item.name,
        itemColourId: lot.itemColourId,
        colourCode: colour?.code ?? null,
        area: text(hide.area),
        areaUom: hide.areaUom,
        baseArea: text(hide.baseArea),
        baseUom: item.baseUom,
        grade: hide.grade,
        shade: hide.shade,
        thicknessMm: hide.thicknessMm ? hide.thicknessMm.toFixed(2) : null,
        defects: hide.defects,
        state: hide.state,
        lot: {
          id: lot.id,
          code: lot.code,
          supplierLotRef: lot.supplierLotRef,
          dyeBatch: lot.dyeBatch,
          shade: lot.shade,
          qualityStatus: lot.qualityStatus,
          crViStatus: lot.crViStatus,
          usable: usability.usable,
          words: usability.usable ? null : lotWords(lot.code, usability.reason),
        },
      },
      onHand: onHand.map((row) => ({ locationId: row.locationId, locationCode: locations.get(row.locationId)?.code ?? '', onHand: text(row.onHand) })),
      lastCut: last ? { at: toUtcIso(last.serverTime), workOrderNumber: lastOrder?.number ?? '', station: last.stationId ? (stations.get(last.stationId) ?? null) : null } : null,
      workOrders,
    }
  })
}

/** Net issued to the work order of one material and colour (ISSUE out less returns and reversals, as the pick list says). */
async function issuedOf(db: Reader, workOrder: CutHeader, material: Material): Promise<Decimal> {
  const where = { siteId: workOrder.siteId, workOrderId: workOrder.id, itemId: material.itemId, itemColourId: material.itemColourId }
  const [out, back] = await Promise.all([
    db.stockMove.aggregate({ where: { ...where, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } }),
    db.stockMove.aggregate({ where: { ...where, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } }),
  ])
  return new Dec((out._sum.baseQuantity ?? 0).toString()).minus((back._sum.baseQuantity ?? 0).toString())
}

// ---- the office's cut log of a work order --------------------------------------------------------------------------------------

/** A work order's cut log for the office (SCR-071): every entry, each hide's area bar, the cut count of each cell. */
export async function cutLog(caller: CommandCaller, workOrderId: string) {
  const workOrder = await cuttingWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  return caller.withClient(async (db) => {
    const planned = await readPlannedParts(db, workOrder.id)
    const cells = await readCells(db, workOrder.id, workOrder.styleId)
    const all = await readEntries(db, workOrder.id)
    const live = liveOf(all)
    const pieces = await readPieces(db, all.entries.map((entry) => entry.id))
    const livePieces = pieces.filter((piece) => live.some((entry) => entry.id === piece.cutLogId))
    const hideIds = [...new Set([...(await heldHides(db, workOrder)), ...all.entries.map((entry) => entry.hideId)])]
    const hides = hideIds.length === 0 ? [] : await db.hide.findMany({ where: { id: { in: hideIds } }, select: { id: true, code: true, lotId: true, itemId: true, state: true } })
    const lots = new Map((await db.lot.findMany({ where: { id: { in: [...new Set(hides.map((hide) => hide.lotId))] } }, select: { id: true, code: true, itemColourId: true } })).map((lot) => [lot.id, lot]))
    const hideOf = new Map(hides.map((hide) => [hide.id, hide]))
    const ledger = await readHideLedger(db, workOrder.siteId, workOrder.id, hideIds)
    // The office sees who cut an entry where the site names workers (an agreement on record, B-W1-37); the floor never.
    const workers = new Map(
      (await db.worker.findMany({ where: { id: { in: [...new Set(all.entries.flatMap((entry) => (entry.workerId ? [entry.workerId] : [])))] } }, select: { id: true, displayName: true } })).map((worker) => [worker.id, { id: worker.id, name: worker.displayName }]),
    )
    const stations = await readStations(db, [...new Set(all.entries.flatMap((entry) => (entry.stationId ? [entry.stationId] : [])))])
    const cellLabels = new Map(cells.map((cell) => [cell.id, cell]))
    const patternOf = (entryId: string, hideId: string) => {
      const hide = hideOf.get(hideId)
      const material: Material = { itemId: hide?.itemId ?? '', itemColourId: (hide && lots.get(hide.lotId)?.itemColourId) ?? null }
      const cellsOf = new Map(cells.map((cell) => [cell.id, { parts: partsOf(planned, cell.id, material), need: planned.filter((row) => row.cellId === cell.id && row.itemId === material.itemId && row.itemColourId === material.itemColourId).reduce((sum, row) => sum.plus(row.baseQuantity), ZERO).toFixed(4), quantity: cell.quantity }]))
      return entryPattern(pieces.filter((piece) => piece.cutLogId === entryId), cellsOf)
    }
    const progress = cellProgress(cells, planned, livePieces)
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, siteId: workOrder.siteId },
      entries: [...all.entries].reverse().map((entry) => {
        const pattern = entry.reversalOfId ? null : patternOf(entry.id, entry.hideId)
        return {
          ...entryView(entry, pieces),
          hideCode: hideOf.get(entry.hideId)?.code ?? '',
          lotCode: lots.get(entry.lotId)?.code ?? '',
          pattern: pattern === null ? null : text(Dec.min(pattern, new Dec(entry.baseAreaUsed.toString()))),
          reversedById: all.entries.find((row) => row.reversalOfId === entry.id)?.id ?? null,
          live: live.some((row) => row.id === entry.id),
          worker: entry.workerId ? (workers.get(entry.workerId) ?? null) : null,
          station: entry.stationId ? (stations.get(entry.stationId) ?? null) : null,
          cells: [...new Set(pieces.filter((piece) => piece.cutLogId === entry.id).map((piece) => piece.cellId))].map((cellId) => ({
            workOrderSizeId: cellId,
            colourwayCode: cellLabels.get(cellId)?.colourwayCode ?? '',
            size: cellLabels.get(cellId)?.size ?? '',
          })),
        }
      }),
      hides: hideIds
        .map((hideId) => {
          const hide = hideOf.get(hideId)
          const facts = ledger.get(hideId)!
          const bar = hideArea({
            issued: facts.issued.toFixed(4),
            returned: facts.returned.toFixed(4),
            entries: live.filter((entry) => entry.hideId === hideId).map((entry) => ({ areaUsed: entry.baseAreaUsed.toString(), pattern: patternOf(entry.id, hideId)?.toFixed(4) ?? null })),
          })
          return { hideId, code: hide?.code ?? '', lotCode: (hide && lots.get(hide.lotId)?.code) ?? '', state: hide?.state ?? 'FULL', ...bar }
        })
        .sort((a, b) => (a.code < b.code ? -1 : 1)),
      cells: cells.map((cell, index) => ({ id: cell.id, colourwayCode: cell.colourwayCode, size: cell.size, quantity: cell.quantity, cut: progress[index]!.cut, toCut: progress[index]!.toCut, parts: progress[index]!.parts.map((part) => ({ ...part })) })),
    }
  })
}

/**
 * The cut count of each cell of a work order (garments with every hide-cut part cut; null: the cell has none), for the
 * work order record (modules/production/work-orders views.ts) and the bundles (B-W1-41): one reader, no permission
 * checked (the caller checked the work order).
 */
export async function cutCountsOf(db: Reader, workOrderId: string, styleId: string): Promise<Map<string, number | null>> {
  const planned = await readPlannedParts(db, workOrderId)
  const cells = await readCells(db, workOrderId, styleId)
  const progress = cellProgress(cells, planned, await readPieces(db, liveOf(await readEntries(db, workOrderId)).map((entry) => entry.id)))
  return new Map(progress.map((cell) => [cell.cellId, cell.cut]))
}

/**
 * What B-W1-41 (bundles) makes bundles from: per cell, the garments cut and the live entries whose pieces they are
 * (genealogy: hide, lot). Bundles name entries of their work order that are no reversal (the Bundle trigger).
 */
export async function cutForBundles(db: Reader, workOrderId: string, styleId: string) {
  const planned = await readPlannedParts(db, workOrderId)
  const cells = await readCells(db, workOrderId, styleId)
  const live = liveOf(await readEntries(db, workOrderId))
  const pieces = await readPieces(db, live.map((entry) => entry.id))
  const progress = cellProgress(cells, planned, pieces)
  return cells.map((cell, index) => ({
    workOrderSizeId: cell.id,
    quantity: cell.quantity,
    cut: progress[index]!.cut,
    parts: progress[index]!.parts,
    cutLogIds: [...new Set(pieces.filter((piece) => piece.cellId === cell.id).map((piece) => piece.cutLogId))],
  }))
}
