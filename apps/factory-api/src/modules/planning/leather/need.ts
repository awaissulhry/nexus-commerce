import type { Prisma } from '@nexus/factory-db'
import { businessDate as businessDateOf } from '@nexus/factory-domain/core/time'
import { stockValue } from '@nexus/factory-domain/inventory/ledger/valuation'
import { findHides, type FindHide } from '@nexus/factory-domain/inventory/reservations/find'
import { shadeLotKey, type ShadeFacts } from '@nexus/factory-domain/inventory/reservations/shade'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { hidesFor } from '@nexus/factory-domain/planning/buy'
import { OPEN_WORK_ORDER_STATUSES, type RequirementSource } from '@nexus/factory-domain/planning/explode'
import { shadeFeasibility } from '@nexus/factory-domain/planning/leather/feasibility'
import { lossOfWastage } from '@nexus/factory-domain/planning/leather/loss'
import { protectorState } from '@nexus/factory-domain/planning/leather/protectors'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { colourIn, lineNeed } from '@nexus/factory-domain/product/bom/requirements'
import { partOf } from '@nexus/factory-domain/production/cutting/rules'
import { Dec, HUNDRED, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { availableHides } from '../../inventory/reservations/find'
import { heldShades, shadeRuleFor } from '../../inventory/reservations/shade'
import { readLines, type LineRecord } from '../../product/bom/store'
import { certificateCovering } from '../../quality/lab/store'
import { everyPartySiteFor, officeContextOf, seesCost } from '../access'
import { readStock, readWorkOrders, type Reader, type SiteRow } from '../store'
import { REQUIREMENT_COLUMNS, sourcesOf, type RequirementRow } from '../views'
import type { NeedRowView, ProtectorRowView } from './contract'
import { isLeather, isProtector, LEATHER_ITEM_COLUMNS, latestRunOf, runViewOf, siteViewOf, unitsOfItem, type LeatherItemRow } from './facts'
// B-W2b-GB29 (G226): the accepted cutting loss for planning.
import { planningLossOf, withPlanningLoss } from './planning-loss'

/**
 * Leather need per order and certified protectors (B-W2b-132; PLN-106, PLN-108, PLN-114; design planning.leather "Leather
 * need per order", "Certified protectors", pop-up "Can this order be cut from one shade?"). Office, planning.view at the site.
 * Both read the site's latest finished plan run (the plan What to buy & make shows: its header's "as of"), so the need here is
 * the run's own: per open order line and leather (tracked by the hide), the area its pieces still take with the loss, of it
 * what is issued already, what its work orders (or the line) hold reserved and what is left to find. Then the article's free
 * hides at the site (B-W2b-100's find: on hand, released, not held, reserved for nobody) by shade lot, the lots the order
 * already holds, and whether one shade covers what is left (factory-domain planning/leather/feasibility). Protectors: the
 * part the style's BOM names, its EN 1621 certificate in the register, the released lots at the site, never a substitute.
 * Read only. Money only with the cost grain.
 */

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
const q4 = (value: Decimal): string => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
const dec = (value: { toString(): string } | string): Decimal => new Dec(value.toString())
const dayOf = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)

/** What both sections read from one run: its lines, their items, the order lines behind them, revisions, BOM lines, work orders. */
async function readRunFacts(db: Reader, site: SiteRow, runId: string, which: 'leather' | 'protector', withCost: boolean) {
  const requirements = await db.materialRequirement.findMany({ where: { runId }, select: REQUIREMENT_COLUMNS, orderBy: { seq: 'asc' } })
  const items = new Map(
    (await db.item.findMany({ where: { id: { in: unique(requirements.map((row) => row.itemId)) } }, select: { ...LEATHER_ITEM_COLUMNS, ...(withCost ? { standardCost: true } : {}) } })).map((row) => [row.id, row as LeatherItemRow & { standardCost?: Prisma.Decimal | null }]),
  )
  const mine = requirements.filter((row) => {
    const item = items.get(row.itemId)
    return item && (which === 'leather' ? isLeather(item) : isProtector(item))
  })
  const sources = new Map(mine.map((row) => [row.id, sourcesOf(row.sources)]))
  const lineIds = unique([...sources.values()].flatMap((list) => list.map((source) => source.orderLineId)))
  const lines = lineIds.length
    ? await db.salesOrderLine.findMany({
        where: { id: { in: lineIds } },
        select: { id: true, orderId: true, seq: true, styleId: true, styleRevisionId: true, colourwayId: true, promiseDate: true, requestedDate: true, order: { select: { number: true, promiseDate: true, requestedDate: true } } },
      })
    : []
  // B-W2b-GB29 (G222 × B-W2b-132): a sample work order of no order line is a row of its own: the run's stand-in line (its
  // source names the work order and its round), its style, revision, colourway and due day the work order's.
  const samples = await sampleLinesOf(db, [...sources.values()].flat())
  const allLines: NeedLine[] = [...lines.map((line) => ({ ...line, sample: null })), ...samples.lines]
  const lineById = new Map(allLines.map((line) => [line.id, line]))
  const styleIds = unique(allLines.map((line) => line.styleId))
  const styles = new Map((styleIds.length ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  const released = styleIds.length ? await db.styleRevision.findMany({ where: { styleId: { in: styleIds }, status: 'RELEASED' }, select: { id: true, styleId: true }, orderBy: { revision: 'desc' } }) : []
  const releasedOf = new Map<string, string>()
  for (const row of released) if (!releasedOf.has(row.styleId)) releasedOf.set(row.styleId, row.id)
  const revisionOf = (line: Pick<NeedLine, 'styleRevisionId' | 'styleId'>) => line.styleRevisionId ?? releasedOf.get(line.styleId) ?? null
  const revisionIds = unique(allLines.map(revisionOf))
  const revisions = new Map((revisionIds.length ? await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true, status: true, plannedHideYieldPct: true } }) : []).map((row) => [row.id, row]))
  const bomLines = new Map<string, LineRecord[]>()
  for (const revisionId of revisionIds.sort()) bomLines.set(revisionId, await readLines(db, revisionId))
  // B-W2b-GB29 (G226): the loss the plan carries is the accepted one when it overrides a released revision (as the run reads it).
  const planningLoss = await planningLossOf(db, revisionIds, [...bomLines.values()].flat().map((bomLine) => bomLine.itemId))
  for (const [revisionId, lines] of bomLines) bomLines.set(revisionId, withPlanningLoss(planningLoss, revisionId, lines))
  const colourways = new Map((allLines.length ? await db.colourway.findMany({ where: { id: { in: unique(allLines.map((line) => line.colourwayId)) } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  const colours = new Map((mine.some((row) => row.itemColourId) ? await db.itemColour.findMany({ where: { id: { in: unique(mine.map((row) => row.itemColourId)) } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  const { cells: orderCells } = await readWorkOrders(db, site.id, lineIds)
  const cells = [...orderCells, ...samples.cells] // B-W2b-GB29: + the sample work orders' cells, on their stand-in lines
  return { requirements: mine, items, sources, lineById, styles, revisionOf, revisions, bomLines, colourways, colours, cells }
}
type RunFacts = Awaited<ReturnType<typeof readRunFacts>>

/** B-W2b-GB29: a row's line: an order line, or the stand-in line of a sample work order of no order line (`sample` says which). */
interface NeedLine {
  readonly id: string
  readonly orderId: string
  readonly seq: number
  readonly styleId: string
  readonly styleRevisionId: string | null
  readonly colourwayId: string
  readonly promiseDate: Date | null
  readonly requestedDate: Date | null
  readonly order: { readonly number: string; readonly promiseDate: Date | null; readonly requestedDate: Date | null }
  readonly sample: { readonly workOrderId: string; readonly workOrderNumber: string; readonly roundId: string | null; readonly roundNumber: string | null } | null
}

/**
 * B-W2b-GB29 (G222 × B-W2b-132): the stand-in lines of the run's sample sources (explode's `sampleOrderLines`: one per sample
 * work order and colourway, its id the first cell of that colourway) and the work orders' cells on them, as the order lines'.
 */
async function sampleLinesOf(db: Reader, sources: readonly RequirementSource[]) {
  const ofSample = sources.filter((source) => source.sample)
  const workOrderIds = unique(ofSample.map((source) => source.sample!.workOrderId))
  if (workOrderIds.length === 0) return { lines: [] as NeedLine[], cells: [] as Awaited<ReturnType<typeof readWorkOrders>>['cells'] }
  const workOrders = new Map((await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true, styleId: true, styleRevisionId: true, dueDate: true, sizes: { select: { id: true, colourwayId: true, size: true, quantity: true } } } })).map((row) => [row.id, row]))
  const lines: NeedLine[] = []
  const cells: Awaited<ReturnType<typeof readWorkOrders>>['cells'] = []
  for (const source of ofSample) {
    if (lines.some((line) => line.id === source.orderLineId)) continue
    const workOrder = workOrders.get(source.sample!.workOrderId)
    const standIn = workOrder?.sizes.find((cell) => cell.id === source.orderLineId)
    if (!workOrder || !standIn) continue
    lines.push({
      id: source.orderLineId,
      orderId: source.sample!.roundId ?? workOrder.id,
      seq: source.lineSeq,
      styleId: workOrder.styleId,
      styleRevisionId: workOrder.styleRevisionId,
      colourwayId: standIn.colourwayId,
      promiseDate: workOrder.dueDate,
      requestedDate: null,
      order: { number: workOrder.number, promiseDate: workOrder.dueDate, requestedDate: null },
      sample: { workOrderId: workOrder.id, workOrderNumber: workOrder.number, roundId: source.sample!.roundId, roundNumber: source.sample!.roundNumber },
    })
    for (const cell of workOrder.sizes.filter((entry) => entry.colourwayId === standIn.colourwayId)) {
      cells.push({ workOrderId: workOrder.id, workOrderNumber: workOrder.number, status: workOrder.status, orderLineId: source.orderLineId, size: cell.size, pieces: cell.quantity })
    }
  }
  return { lines, cells }
}

/** The order line's rows of one run line: sources grouped per order line (the run keeps one per size). */
function perOrderLine(sources: readonly RequirementSource[]): Map<string, RequirementSource[]> {
  const out = new Map<string, RequirementSource[]>()
  for (const source of sources) out.set(source.orderLineId, [...(out.get(source.orderLineId) ?? []), source])
  return out
}

const dueOf = (line: { promiseDate: Date | null; requestedDate: Date | null; order: { promiseDate: Date | null; requestedDate: Date | null } }): string | null =>
  dayOf(line.promiseDate ?? line.requestedDate ?? line.order.promiseDate ?? line.order.requestedDate)

const byDue = <Row extends { orderLine: { dueDate: string | null; seq: number }; order: { number: string } }>(a: Row, b: Row): number =>
  (a.orderLine.dueDate ?? '9999-12-31').localeCompare(b.orderLine.dueDate ?? '9999-12-31') || a.order.number.localeCompare(b.order.number) || a.orderLine.seq - b.orderLine.seq

/** GET /planning/leather/need?siteId: per open order line and leather, the need, what is left to find and one shade's answer. */
export async function leatherNeed(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeContextOf(caller)
  const withCost = seesCost(context)
  return caller.withClient(async (client) => {
    const db = client as Reader
    const site = await everyPartySiteFor(caller, query.siteId, PLANNING_VIEW, db) // B-PR-10: every customer's leather need
    const rule = await shadeRuleFor(db, site.id)
    const run = await latestRunOf(db, site.id)
    if (!run) return { site: siteViewOf(site), run: null, rule, rows: [] }
    const facts = await readRunFacts(db, site, run.id, 'leather', withCost)
    const hidesCache = new Map<string, FindHide[]>()
    const hidesOf = async (itemId: string, itemColourId: string | null) => {
      const key = `${itemId}|${itemColourId ?? '-'}`
      if (!hidesCache.has(key)) hidesCache.set(key, await availableHides(client, { siteId: site.id, itemId, itemColourId }))
      return hidesCache.get(key)!
    }
    const rows: NeedRowView[] = []
    for (const requirement of facts.requirements) {
      const item = facts.items.get(requirement.itemId)!
      const units = unitsOfItem(item)
      for (const [orderLineId, sources] of perOrderLine(facts.sources.get(requirement.id) ?? [])) {
        const line = facts.lineById.get(orderLineId)
        if (!line) continue
        rows.push(await needRowOf({ db, client, site, rule, requirement, item, units, line, sources, facts, hides: await hidesOf(item.id, requirement.itemColourId), withCost }))
      }
    }
    return { site: siteViewOf(site), run: runViewOf(run), rule, rows: rows.sort(byDue) }
  })
}

interface NeedInput {
  readonly db: Reader
  readonly client: Parameters<Parameters<CommandCaller['withClient']>[0]>[0]
  readonly site: SiteRow
  readonly rule: Awaited<ReturnType<typeof shadeRuleFor>>
  readonly requirement: RequirementRow
  readonly item: LeatherItemRow & { standardCost?: Prisma.Decimal | null }
  readonly units: ReturnType<typeof unitsOfItem>
  readonly line: NeedLine
  readonly sources: readonly RequirementSource[]
  readonly facts: RunFacts
  readonly hides: readonly FindHide[]
  readonly withCost: boolean
}

async function needRowOf(input: NeedInput): Promise<NeedRowView> {
  const { db, client, site, rule, requirement, item, units, line, sources, facts, hides, withCost } = input
  const itemColourId = requirement.itemColourId
  const style = facts.styles.get(line.styleId)
  const revisionId = facts.revisionOf(line)
  const revision = revisionId ? (facts.revisions.get(revisionId) ?? null) : null
  const bom = (revisionId ? (facts.bomLines.get(revisionId) ?? []) : []).filter((bomLine) => bomLine.itemId === item.id && colourIn(bomLine, line.colourwayId) === itemColourId)

  // Sizes: the run's pieces still to make, the area with the loss, of it what is issued.
  const sizeMap = new Map<string, { size: string; pieces: number; area: Decimal; issued: Decimal }>()
  for (const source of sources) {
    const entry = sizeMap.get(source.size) ?? { size: source.size, pieces: 0, area: ZERO, issued: ZERO }
    sizeMap.set(source.size, { size: source.size, pieces: entry.pieces + source.pieces, area: entry.area.plus(source.quantity), issued: entry.issued.plus(source.issued) })
  }
  const sizes = [...sizeMap.values()]
  const area = sizes.reduce((sum, size) => sum.plus(size.area), ZERO)
  const issued = sizes.reduce((sum, size) => sum.plus(size.issued), ZERO)

  // The order's open work orders and what they (or the line) hold reserved of this leather.
  const workOrders = unique(facts.cells.filter((cell) => cell.orderLineId === line.id && OPEN_WORK_ORDER_STATUSES.includes(cell.status)).map((cell) => `${cell.workOrderId}|${cell.workOrderNumber}`)).map((pair) => {
    const [id, number] = pair.split('|') as [string, string]
    return { id, number }
  })
  const reservations = await db.reservation.findMany({
    where: { status: 'ACTIVE', itemId: item.id, itemColourId, OR: [{ salesOrderLineId: line.id }, ...(workOrders.length ? [{ workOrderId: { in: workOrders.map((order) => order.id) } }] : [])] },
    select: { quantity: true, issuedQuantity: true },
  })
  const reserved = reservations.reduce((sum, row) => sum.plus(Dec.max(ZERO, dec(row.quantity).minus(row.issuedQuantity.toString()))), ZERO)
  const toFind = Dec.max(ZERO, area.minus(issued).minus(reserved))

  // The loss the plan carries: the leather lines' wastage (the plan run's math).
  const wastages = unique(bom.map((bomLine) => dec(bomLine.wastagePct).toFixed(4)))
  const lossPct = wastages.length === 1 ? lossOfWastage(wastages[0]!) : null
  const netArea = wastages.length === 1 ? q4(area.div(dec(wastages[0]!).div(HUNDRED).plus(1))) : null

  // Per part (placement) and size: what its pieces take, loss included.
  const parts = new Map<string, Map<string, Decimal>>()
  for (const bomLine of bom) {
    const part = partOf(bomLine.placement, item.code)
    const perSize = parts.get(part) ?? new Map<string, Decimal>()
    for (const size of sizes) {
      const need = lineNeed(bomLine, size.size, units)
      if (need) perSize.set(size.size, (perSize.get(size.size) ?? ZERO).plus(need.base.times(size.pieces)))
    }
    parts.set(part, perSize)
  }

  // The shade lots: what the order holds, the free lots (own first), the answer.
  const held: ShadeFacts[] = []
  for (const order of workOrders) held.push(...(await heldShades(client, { siteId: site.id, workOrderId: order.id, salesOrderLineId: null, itemId: item.id, itemColourId })))
  held.push(...(await heldShades(client, { siteId: site.id, workOrderId: null, salesOrderLineId: line.id, itemId: item.id, itemColourId })))
  const heldKeys = new Map(held.map((hide) => [shadeLotKey(hide), { lotCode: hide.lotCode, shadeLabel: hide.shadeLabel }]))
  const found = findHides({ need: q4(toFind), baseUom: item.baseUom, rule, held, hides })
  const lots = found.lots.map((lot) => ({ key: lot.key, lotId: lot.lotId, lotCode: lot.lotCode, shadeLabel: lot.shadeLabel, free: lot.total, count: lot.count, ordersOwn: lot.ordersOwn }))
  const answer = shadeFeasibility({
    rule,
    toFind: q4(toFind),
    reserved: q4(reserved),
    sizes: sizes.map((size) => ({ size: size.size, area: q4(Dec.max(ZERO, size.area.minus(size.issued))) })),
    lots: found.lots.map((lot) => ({ key: lot.key, lotId: lot.lotId, lotCode: lot.lotCode, shadeLabel: lot.shadeLabel, total: lot.total, count: lot.count, ordersOwn: lot.ordersOwn })),
    held: heldKeys.size,
  })
  // The order's own lot names the best even when it has no free hide left (0 free), so the column says where it is cut from.
  const heldFirst = held[0]
  const ownEmpty = heldKeys.size === 1 && heldFirst && !lots.some((lot) => lot.ordersOwn) ? { key: shadeLotKey(heldFirst), lotId: heldFirst.lotId, lotCode: heldFirst.lotCode, shadeLabel: heldFirst.shadeLabel, free: '0.0000', count: 0, ordersOwn: true } : null
  const best = answer.best ? (lots.find((lot) => lot.key === answer.best!.key) ?? null) : ownEmpty
  const proposal = answer.status === 'FITS' && found.proposal && best && found.proposal.lotKey === best.key ? { hideIds: found.proposal.hideIds, count: found.proposal.count, area: found.proposal.area } : null

  // Grade mix of the free hides (percent of their area).
  const free = hides.filter((hide) => !hide.outOfShade || rule === 'OFF')
  const freeArea = free.reduce((sum, hide) => sum.plus(hide.left.toString()), ZERO)
  const grades = new Map<string, Decimal>()
  for (const hide of free) grades.set(hide.gradeCode ?? '', (grades.get(hide.gradeCode ?? '') ?? ZERO).plus(hide.left.toString()))
  const gradeMix = freeArea.isZero()
    ? []
    : [...grades.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b))).map(([code, gradeArea]) => ({ code: code || null, pct: gradeArea.times(HUNDRED).div(freeArea).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2), area: q4(gradeArea) }))

  // The split reserves what is left to find, no more: the sizes' areas count what the order's reservations already hold too.
  let left = toFind
  // B-W2b-GB29 (G226): with one work order, each part's sizes are its cells: the reserve holds each size's share of the part
  // for its cell (Reservation.workOrderSizeId), so the split by garment is data, not words. Shares by the sizes' area, the
  // last size taking what rounding left.
  // B-W2b-GB29 (G222): a sample work order's cells are those of the stand-in line's colourway (they name no order line).
  const cellOf = answer.split && workOrders.length === 1 ? new Map((await client.workOrderSize.findMany({ where: line.sample ? { workOrderId: workOrders[0]!.id, colourwayId: line.colourwayId } : { workOrderId: workOrders[0]!.id, salesOrderLineId: line.id }, select: { id: true, size: true }, orderBy: { id: 'asc' } })).reverse().map((cell) => [cell.size, cell.id])) : null
  const cellsOf = (partSizes: readonly string[], take: Decimal) => {
    if (!cellOf) return null
    const of = partSizes.map((size) => ({ size, area: sizes.find((entry) => entry.size === size)?.area ?? ZERO }))
    const whole = of.reduce((sum, entry) => sum.plus(entry.area), ZERO)
    let given = ZERO
    return of.map((entry, index) => {
      const share = index === of.length - 1 ? take.minus(given) : whole.isZero() ? ZERO : take.times(entry.area).div(whole).toDecimalPlaces(4, Dec.ROUND_DOWN)
      given = given.plus(share)
      return { size: entry.size, workOrderSizeId: cellOf.get(entry.size) ?? null, area: q4(share) }
    })
  }
  const splitParts = answer.split
    ? answer.split.map((part) => {
        const take = Dec.min(left, new Dec(part.area))
        left = left.minus(take)
        return { lotKey: part.lotKey, lotId: lots.find((lot) => lot.key === part.lotKey)?.lotId ?? part.lotKey, lotCode: part.lotCode, shadeLabel: part.shadeLabel, sizes: [...part.sizes], area: q4(take), cells: cellsOf(part.sizes, take) }
      })
    : null
  const colourway = facts.colourways.get(line.colourwayId) ?? null
  const colour = itemColourId ? (facts.colours.get(itemColourId) ?? null) : null
  const standardCost = withCost ? (item.standardCost ?? null) : null
  return {
    id: `${line.id}:${item.id}:${itemColourId ?? '-'}`,
    order: { id: line.orderId, number: line.order.number },
    orderLine: { id: line.id, seq: line.seq, dueDate: dueOf(line) },
    // B-W2b-GB29 (G222): the sample work order of no order line this row is (its order is its round), or null.
    sample: line.sample,
    style: { id: line.styleId, code: style?.code ?? '', name: style?.name ?? '' },
    revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
    colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
    item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, thicknessMinMm: item.thicknessMinMm?.toString() ?? null, thicknessMaxMm: item.thicknessMaxMm?.toString() ?? null },
    colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
    requirement: { id: requirement.id, version: requirement.version, decision: requirement.decision, suggestedQuantity: q4(dec(requirement.suggestedQuantity)), suggestedUom: requirement.suggestedUom },
    sizes: sizes.map((size) => ({ size: size.size, pieces: size.pieces, area: q4(size.area), issued: q4(size.issued) })),
    parts: [...parts.entries()].map(([part, perSize]) => ({ part, sizes: sizes.filter((size) => perSize.has(size.size)).map((size) => ({ size: size.size, area: q4(perSize.get(size.size)!) })) })),
    pieces: sizes.reduce((sum, size) => sum + size.pieces, 0),
    area: q4(area),
    issued: q4(issued),
    reserved: q4(reserved),
    toFind: q4(toFind),
    netArea,
    lossPct,
    lossSource: lossPct === null ? null : 'BOM',
    hides: toFind.isZero() ? 0 : hidesFor(q4(toFind), units),
    gradeMix,
    workOrders,
    heldLots: [...heldKeys.values()],
    feasibility: answer.status,
    best,
    split: splitParts,
    buy: answer.buy ? { area: answer.buy.area, hides: hidesFor(answer.buy.area, units), lotCode: answer.buy.lotCode ?? ownEmpty?.lotCode ?? null, shadeLabel: answer.buy.shadeLabel ?? ownEmpty?.shadeLabel ?? null } : null,
    proposal,
    lots: lots.slice(0, 8),
    demand: workOrders.length === 1 ? { workOrderId: workOrders[0]!.id, salesOrderLineId: null } : { workOrderId: null, salesOrderLineId: line.id },
    ...(withCost ? { value: asMoney('cost', standardCost === null ? null : stockValue(q4(toFind), standardCost.toString(), item.currency)) } : {}),
    currency: item.currency,
  }
}

/** GET /planning/leather/protectors?siteId: per open order line and protector, the certified part, its certificate and lots. */
export async function certifiedProtectors(caller: CommandCaller, query: { readonly siteId: string }) {
  return caller.withClient(async (client) => {
    const db = client as Reader
    const site = await everyPartySiteFor(caller, query.siteId, PLANNING_VIEW, db) // B-PR-10: every customer's protectors
    const run = await latestRunOf(db, site.id)
    if (!run) return { site: siteViewOf(site), run: null, rows: [] }
    const facts = await readRunFacts(db, site, run.id, 'protector', false)
    const today = businessDateOf(new Date(), site.timezone)
    // Every protector the site holds in released lots (the substitutes a row names, never offers).
    const protectorItems = await db.item.findMany({ where: { OR: [{ kind: 'PROTECTOR' }, { isPpeComponent: true }] }, select: { id: true, code: true, name: true } })
    const stock = await readStock(db, site.id, protectorItems.map((row) => row.id))
    const lots = new Map((await db.lot.findMany({ where: { id: { in: unique(stock.map((row) => row.lotId)) } }, select: { id: true, qualityStatus: true } })).map((row) => [row.id, row]))
    const released = stock.filter((row) => row.lotId && lots.get(row.lotId)?.qualityStatus === 'RELEASED' && dec(row.quantity).gt(0))
    const documents = await db.lotDocument.findMany({ where: { lotId: { in: unique(released.map((row) => row.lotId)) }, kind: 'PPE_CERTIFICATE', status: 'ACTIVE' }, select: { lotId: true, validTo: true } })
    const certifiedLots = new Set(documents.filter((row) => !row.validTo || dayOf(row.validTo)! >= today).map((row) => row.lotId))
    const inStock = new Set(released.map((row) => row.itemId))
    const certificates = new Map<string, Awaited<ReturnType<typeof certificateCovering>>>()
    const rows: ProtectorRowView[] = []
    for (const requirement of facts.requirements) {
      const item = facts.items.get(requirement.itemId)!
      if (!certificates.has(item.id)) certificates.set(item.id, await certificateCovering(db, { itemId: item.id, companyId: site.companyId }, today))
      const certificate = certificates.get(item.id) ?? null
      const mineLots = released.filter((row) => row.itemId === item.id && (requirement.itemColourId === null || row.itemColourId === requirement.itemColourId))
      const available = mineLots.reduce((sum, row) => sum.plus(row.quantity), ZERO)
      for (const [orderLineId, sources] of perOrderLine(facts.sources.get(requirement.id) ?? [])) {
        const line = facts.lineById.get(orderLineId)
        if (!line) continue
        const revisionId = facts.revisionOf(line)
        const placements = unique((revisionId ? (facts.bomLines.get(revisionId) ?? []) : []).filter((bomLine) => bomLine.itemId === item.id).map((bomLine) => bomLine.placement?.trim() || null))
        const needed = sources.reduce((sum, source) => sum.plus(Dec.max(ZERO, dec(source.quantity).minus(source.issued))), ZERO)
        const style = facts.styles.get(line.styleId)
        const colourway = facts.colourways.get(line.colourwayId) ?? null
        const dueDate = dueOf(line)
        const sizes = new Map<string, number>()
        for (const source of sources) sizes.set(source.size, (sizes.get(source.size) ?? 0) + source.pieces)
        rows.push({
          id: `${line.id}:${item.id}:${requirement.itemColourId ?? '-'}`,
          order: { id: line.orderId, number: line.order.number },
          orderLine: { id: line.id, seq: line.seq, dueDate },
          style: { id: line.styleId, code: style?.code ?? '', name: style?.name ?? '' },
          colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
          placement: placements.length ? placements.join(', ') : null,
          sizes: [...sizes.entries()].map(([size, pieces]) => ({ size, pieces })),
          item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom },
          needed: q4(needed),
          certificate,
          lots: { count: mineLots.length, available: q4(available), withCertificate: mineLots.filter((row) => row.lotId && certifiedLots.has(row.lotId)).length },
          state: protectorState({ certificate, dueDate, needed: q4(needed), available: q4(available) }),
          substitutes: protectorItems.filter((other) => other.id !== item.id && inStock.has(other.id)).slice(0, 5),
        })
      }
    }
    return { site: siteViewOf(site), run: runViewOf(run), rows: rows.sort(byDue) }
  })
}
