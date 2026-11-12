import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { binDifferences, finishWrites, passOf, recountByAnotherProblem, recountsToAsk, scannedOf, scanCount, scanQuantityProblem, alreadyScanned, type BinLine, type ScanFacts, type ScanPass } from '@nexus/factory-domain/inventory/counts-depth/scans'
import { INVENTORY_COUNTS_SCAN } from '@nexus/factory-domain/inventory/counts-depth/permissions'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { placeOfScan, type PlaceRef } from '../bin-moves/hand'
import { siteLocations, subtreeOf } from '../counts/ledger-at'
import { LINE_COLUMNS, updateLine, type LineRow } from '../counts/store'
import { stockContextOf, type StockContext } from '../ledger/access'
import type { Reader } from '../issue/store'
import { leftInBase, lengthUom } from '../rolls/facts'
import { asSystem, scansOf, separationFor, tenantOf, type ScanRow } from './store'

/**
 * Counting by scanning every unit (B-W2b-299; SCM-228; design floor.count "What to count", "Scan every unit", "Differences";
 * SCM-229's recount by another person): the office's phone and a floor device at its own site (inventory.counts.scan).
 *
 *   GET  /inventory/stock-counts/to-count                    what to count: the site's running counts' bins with lines to
 *                                                            count or recount (blind: no expected quantity)
 *   GET  /inventory/stock-counts/bin?placeCode&countId       a bin scanned: the counts that count it, its lines and the units
 *                                                            scanned so far (blind)
 *   POST /inventory/stock-counts/:countId/scans              one unit: a hide's tag (its area), a roll's tag (its length), a
 *                                                            remnant's tag (its area), a lot's label or the number pad (the
 *                                                            pieces typed); a unit not expected in the bin adds its line
 *                                                            (ADDED); a tag twice in a pass is "Already counted"
 *   GET  /inventory/stock-counts/:countId/bins/:locationId   "Bin done": what the bin should hold and what was scanned, missing
 *                                                            and extra, and a note when stock moved there since the start
 *   POST …/bins/:locationId/finish                           "Finish bin": each line its sum of scans (0: not found); a line
 *                                                            over the recount rule has its recount asked at once (another
 *                                                            person's: the floor's grant cannot ask it, so a system command
 *                                                            right after asks it, keyed by the finish)
 *
 * The database holds the rest for every login (…_warehouse_depth_w2b_guards): a scan only into a COUNTING count, a floor
 * session only adds ADDED lines and writes the count and recount columns, a RECOUNT scan is another person's while the
 * company's separation switch is on. The floor reads no count's value (StockCount.differenceAmount is hidden from it).
 */

/** The count's columns a floor session may read (the value of the differences is hidden from it). */
const COUNT_FIELDS = { id: true, companyId: true, siteId: true, number: true, kind: true, status: true, locationId: true, itemId: true, lotId: true, itemKind: true, freezeMoves: true, startedAt: true, snapshotAt: true } as const satisfies Prisma.StockCountSelect
type CountFacts = Prisma.StockCountGetPayload<{ select: typeof COUNT_FIELDS }>

const countRef = (count: CountFacts) => ({ id: count.id, number: count.number, kind: count.kind, status: count.status, freezeMoves: count.freezeMoves })
const placeRef = (place: PlaceRef) => ({ id: place.id, code: place.code, name: place.name, labelCode: place.labelCode })

export class CountScanRefusedError extends DomainError {
  override name = 'CountScanRefusedError'
  constructor(readonly refusal: { readonly code: string; readonly message: string }, kind: 'conflict' | 'validation_failed' = 'conflict') {
    super(kind, refusal.message, [{ path: `refusal/${refusal.code}`, message: refusal.message }])
  }
}
const refuse = (code: string, message: string, kind: 'conflict' | 'validation_failed' = 'conflict'): never => {
  throw new CountScanRefusedError({ code, message }, kind)
}

const factsOfLine = (line: LineRow) => ({
  expected: line.expectedQuantity.toString(),
  counted: line.countedQuantity === null ? null : line.countedQuantity.toString(),
  recountRequested: line.recountRequestedAt !== null,
  recount: line.recountQuantity === null ? null : line.recountQuantity.toString(),
})
const binLineOf = (line: LineRow): BinLine => ({ ...factsOfLine(line), id: line.id, seq: line.seq, origin: line.origin, hideId: line.hideId, countedById: line.countedById })
const scanFacts = (scans: readonly ScanRow[]): ScanFacts[] => scans.map((scan) => ({ lineId: scan.lineId, pass: scan.pass as ScanPass, quantity: scan.quantity.toString(), code: scan.code }))

/** The site the caller counts at: a floor device's own; the office's named one it may count at. */
function mayCount(context: StockContext, row: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'system') return true
  if (context.audience === 'floor' && context.siteId !== row.siteId) return false
  return can(actorOf(context), INVENTORY_COUNTS_SCAN, { companyId: row.companyId, siteId: row.siteId })
}

async function countFor(db: Reader, context: StockContext, countId: string): Promise<CountFacts> {
  const count = isUuid(countId) ? await db.stockCount.findUnique({ where: { id: countId }, select: COUNT_FIELDS }) : null
  if (!count || !mayCount(context, count)) throw new NotFoundError('Stock count not found.')
  return count
}

/** The places a count counts at its site (its location and everything inside it; null: every place of the site). */
async function countPlaces(db: Reader, count: CountFacts): Promise<Set<string> | null> {
  return count.locationId ? subtreeOf(await siteLocations(db, count.siteId), count.locationId) : null
}

async function linesAt(db: Reader, countId: string, locationId: string): Promise<LineRow[]> {
  return db.stockCountLine.findMany({ where: { countId, locationId }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
}

/** The bin's lines as the scanner sees them: what, the pass, the units scanned so far; the expected only once the bin is done. */
async function binLineViews(db: Reader, lines: readonly LineRow[], scans: readonly ScanFacts[], withExpected: boolean) {
  if (lines.length === 0) return []
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } })).map((row) => [row.id, row]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: lines.flatMap((line) => (line.lotId ? [line.lotId] : [])) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: lines.flatMap((line) => (line.hideId ? [line.hideId] : [])) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  return lines.map((line) => {
    const item = items.get(line.itemId)
    const pass = passOf(factsOfLine(line))
    const shown = pass ?? (line.recountQuantity !== null ? 'RECOUNT' : 'COUNT')
    return {
      lineId: line.id,
      seq: line.seq,
      origin: line.origin,
      item: { id: line.itemId, code: item?.code ?? '', name: item?.name ?? '', uom: (item?.baseUom as string | undefined) ?? 'PCS', tracking: (item?.tracking as string | undefined) ?? 'NONE' },
      lot: line.lotId ? { id: line.lotId, code: lots.get(line.lotId)?.code ?? '' } : null,
      hide: line.hideId ? { id: line.hideId, code: hides.get(line.hideId)?.code ?? '' } : null,
      pass,
      scans: scanCount(scans, line.id, shown),
      scanned: quantityText(scannedOf(scans, line.id, shown)),
      ...(withExpected ? { expected: quantityText(line.expectedQuantity.toString()) } : {}),
    }
  })
}

// ---- what to count -----------------------------------------------------------------------------------------------------------

/** GET /inventory/stock-counts/to-count */
export async function toCount(caller: CommandCaller, query: { readonly siteId?: string | undefined }, now: Date = new Date()) {
  const context = stockContextOf(caller)
  const siteId = context.audience === 'floor' ? context.siteId : query.siteId
  if (!siteId) throw new ValidationError('Name the site.', [{ path: 'siteId', message: 'Name the site.' }])
  return caller.withClient(async (db) => {
    const counts = (await db.stockCount.findMany({ where: { siteId, status: 'COUNTING' }, select: COUNT_FIELDS, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] })).filter((count) => mayCount(context, count))
    const me = context.audience === 'floor' ? { userId: null, workerId: context.actorId } : context.audience === 'office' ? { userId: context.actorId, workerId: null } : { userId: null, workerId: null }
    const bins: Array<{ count: ReturnType<typeof countRef>; location: ReturnType<typeof placeRef>; kind: ScanPass; lines: number; since: string; yours: boolean }> = []
    for (const count of counts) {
      const lines = await db.stockCountLine.findMany({ where: { countId: count.id, OR: [{ countedAt: null }, { recountRequestedAt: { not: null }, recountedAt: null }] }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
      if (lines.length === 0) continue
      const scans = await scansOf(db, count.id, lines.map((line) => line.id))
      const places = new Map((await db.location.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.locationId))] } }, select: { id: true, code: true, name: true, labelCode: true, kind: true, status: true, siteId: true, companyId: true } })).map((row) => [row.id, row]))
      const groups = new Map<string, { kind: ScanPass; lines: LineRow[] }>()
      for (const line of lines) {
        const pass = passOf(factsOfLine(line))
        if (!pass) continue
        const key = `${line.locationId}|${pass}`
        const group = groups.get(key) ?? { kind: pass, lines: [] }
        group.lines.push(line)
        groups.set(key, group)
      }
      for (const [key, group] of groups) {
        const place = places.get(key.split('|')[0]!)
        if (!place) continue
        const counted = (line: LineRow) => (me.userId !== null && line.countedById === me.userId) || scans.some((scan) => scan.lineId === line.id && scan.pass === 'COUNT' && ((me.userId !== null && scan.scannedById === me.userId) || (me.workerId !== null && scan.scannedByWorkerId === me.workerId)))
        const since = group.kind === 'RECOUNT' ? group.lines.reduce<Date>((latest, line) => (line.recountRequestedAt && line.recountRequestedAt > latest ? line.recountRequestedAt : latest), new Date(0)) : (count.startedAt ?? now)
        bins.push({ count: countRef(count), location: placeRef({ ...place, kind: place.kind as string, status: place.status as string }), kind: group.kind, lines: group.lines.length, since: toUtcIso(since), yours: group.kind === 'RECOUNT' && group.lines.some(counted) })
      }
    }
    bins.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'RECOUNT' ? -1 : 1) : a.location.code < b.location.code ? -1 : a.location.code > b.location.code ? 1 : 0))
    return { asOf: toUtcIso(now), bins }
  })
}

// ---- a bin scanned -------------------------------------------------------------------------------------------------------------

/** The running counts of the site that count this place (its location's subtree holds it, or the whole site). */
async function countsOfPlace(db: Reader, context: StockContext, place: PlaceRef & { readonly siteId: string }): Promise<CountFacts[]> {
  const running = (await db.stockCount.findMany({ where: { siteId: place.siteId, status: 'COUNTING' }, select: COUNT_FIELDS, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] })).filter((count) => mayCount(context, count))
  const out: CountFacts[] = []
  for (const count of running) {
    const places = await countPlaces(db, count)
    if (!places || places.has(place.id)) out.push(count)
  }
  return out
}

async function siteOfCaller(caller: CommandCaller, context: StockContext): Promise<string | null> {
  return context.audience === 'floor' ? context.siteId : null
}

/** GET /inventory/stock-counts/bin */
export async function binOf(caller: CommandCaller, query: { readonly placeCode: string; readonly countId?: string | undefined }) {
  const context = stockContextOf(caller)
  return caller.withClient(async (db) => {
    const named = query.countId ? await countFor(db, context, query.countId) : null
    const siteId = named?.siteId ?? (await siteOfCaller(caller, context))
    if (!siteId) throw new ValidationError('Name the count (countId): a bin label is read at a count\'s site.', [{ path: 'countId', message: 'Name the count.' }])
    const place = await placeOfScan(db, siteId, query.placeCode, 'placeCode')
    const located = { ...place, siteId }
    const counts = named ? [named] : await countsOfPlace(db, context, located)
    if (named) {
      const places = await countPlaces(db, named)
      if (named.status !== 'COUNTING') refuse('NOT_COUNTING', `Count ${named.number} is ${named.status}: its bins are counted while it is COUNTING.`)
      if (places && !places.has(place.id)) refuse('OUTSIDE_COUNT', `Count ${named.number} does not count ${place.code}.`)
    }
    const count = counts.length === 1 ? counts[0]! : null
    if (!count) return { location: placeRef(place), counts: counts.map(countRef), count: null, lines: [] }
    const lines = await linesAt(db, count.id, place.id)
    const scans = scanFacts(await scansOf(db, count.id, lines.map((line) => line.id)))
    return { location: placeRef(place), counts: counts.map(countRef), count: countRef(count), lines: await binLineViews(db, lines, scans, false) }
  })
}

// ---- one unit --------------------------------------------------------------------------------------------------------------

interface Unit {
  readonly kind: 'HIDE' | 'REMNANT' | 'ROLL' | 'LOT' | 'TYPED'
  readonly code: string | null
  readonly itemId: string
  readonly lotId: string | null
  readonly hideId: string | null
  readonly itemColourId: string | null
  /** What it holds by itself (a hide's or remnant's area, a roll's length), in the item's base unit; null: typed. */
  readonly holds: Decimal | null
  /** A hide's measured area (a hide is counted by it, at most). */
  readonly hideArea: Decimal | null
  /** Its own tag (a hide, a remnant, a roll): scanned once per pass. */
  readonly tagged: boolean
}

async function unitOfCode(db: Reader, code: string, siteId: string): Promise<Unit> {
  const codes = [...new Set([code, code.toUpperCase()])]
  const hide = await db.hide.findFirst({ where: { siteId, code: { in: codes } }, select: { id: true, lotId: true, itemId: true, baseArea: true, code: true, lot: { select: { itemColourId: true } } } })
  if (hide) return { kind: 'HIDE', code: hide.code, itemId: hide.itemId, lotId: hide.lotId, hideId: hide.id, itemColourId: hide.lot.itemColourId, holds: null, hideArea: new Dec(hide.baseArea.toString()), tagged: true }
  const remnant = await db.remnant.findFirst({ where: { siteId, code: { in: codes } }, select: { code: true, baseArea: true, hideId: true, lotId: true, hide: { select: { itemId: true, baseArea: true, lot: { select: { itemColourId: true } } } } } })
  if (remnant) {
    return { kind: 'REMNANT', code: remnant.code, itemId: remnant.hide.itemId, lotId: remnant.lotId, hideId: remnant.hideId, itemColourId: remnant.hide.lot.itemColourId, holds: new Dec(remnant.baseArea.toString()), hideArea: new Dec(remnant.hide.baseArea.toString()), tagged: true }
  }
  const roll = await db.fabricRoll.findFirst({ where: { siteId, code: { in: codes } }, select: { code: true, lotId: true, itemId: true, lengthLeft: true, uom: true, lot: { select: { itemColourId: true } } } })
  if (roll) {
    const item = await db.item.findUniqueOrThrow({ where: { id: roll.itemId }, select: { baseUom: true } })
    return { kind: 'ROLL', code: roll.code, itemId: roll.itemId, lotId: roll.lotId, hideId: null, itemColourId: roll.lot.itemColourId, holds: leftInBase(roll, lengthUom(item.baseUom as string)), hideArea: null, tagged: true }
  }
  const lot = await db.lot.findFirst({ where: { siteId, code: { in: codes } }, select: { id: true, code: true, itemId: true, itemColourId: true } })
  if (lot) return { kind: 'LOT', code: lot.code, itemId: lot.itemId, lotId: lot.id, hideId: null, itemColourId: lot.itemColourId, holds: null, hideArea: null, tagged: false }
  return refuse('UNKNOWN_LABEL', `Nothing at this site carries the label ${code}: scan a hide, a roll, a remnant or a lot's label, or type the pieces on the number pad.`, 'validation_failed')
}

export interface ScanBody {
  readonly placeCode: string
  readonly code?: string | undefined
  readonly lineId?: string | undefined
  readonly quantity?: string | undefined
  readonly scannedAt?: string | undefined
}

const scanLock = (tx: CommandTx, tenantId: string, countId: string, code: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.count-scan', ${tenantId}::uuid, ${countId}::uuid, ${code}), 0))`

/** POST /inventory/stock-counts/:countId/scans */
export async function scanUnit(caller: CommandCaller, countId: string, body: ScanBody, idempotencyKey?: string) {
  const context = stockContextOf(caller)
  if (context.audience !== 'office' && context.audience !== 'floor') throw new ForbiddenError()
  if (!body.code && !body.lineId) throw new ValidationError('Scan a unit, or name the line its pieces are typed for.', [{ path: 'body/code', message: 'Scan a label, or send lineId with the quantity.' }])
  const scannedAt = body.scannedAt ? parseInstant(body.scannedAt) : null
  const deviceTime = context.audience === 'floor' && scannedAt ? { deviceTime: scannedAt } : {}
  const { result } = await command(caller, { name: 'inventory.counts.scan', idempotencyKey, input: { countId, ...body }, ...deviceTime }, async (tools) => {
    const { tx, now } = tools
    const count = await countFor(tx, context, countId)
    if (count.status !== 'COUNTING') refuse('NOT_COUNTING', `Count ${count.number} is ${count.status}: units are scanned while it is COUNTING.`)
    const place = await placeOfScan(tx, count.siteId, body.placeCode)
    const places = await countPlaces(tx, count)
    if (places && !places.has(place.id)) refuse('OUTSIDE_COUNT', `Count ${count.number} does not count ${place.code}: scan a bin of the count.`)
    const unit: Unit = body.code ? await unitOfCode(tx, body.code.trim(), count.siteId) : await typedUnit(tx, count.id, body.lineId!, place)
    const item = await tx.item.findUniqueOrThrow({ where: { id: unit.itemId }, select: { id: true, code: true, kind: true, tracking: true } })
    if (count.itemId && count.itemId !== item.id) refuse('OUTSIDE_COUNT', `Count ${count.number} counts another material, not ${item.code}.`)
    if (count.itemKind && count.itemKind !== item.kind) refuse('OUTSIDE_COUNT', `Count ${count.number} counts ${count.itemKind}; ${item.code} is ${item.kind}.`)
    if (count.lotId && count.lotId !== unit.lotId) refuse('OUTSIDE_COUNT', `Count ${count.number} counts another lot.`)
    const tenantId = tenantOf(tools.context)
    if (unit.code) await scanLock(tx, tenantId, count.id, unit.code.toUpperCase())

    // The line of the unit at this bin: its stock key (a lot's line for a roll or a lot label, a hide's own line for a hide or its remnant).
    const key = { locationId: place.id, itemId: unit.itemId, lotId: item.tracking === 'NONE' ? null : unit.lotId, hideId: item.tracking === 'HIDE' ? unit.hideId : null }
    let line = body.lineId && !body.code
      ? await tx.stockCountLine.findFirst({ where: { id: body.lineId, countId: count.id }, select: LINE_COLUMNS })
      : await tx.stockCountLine.findFirst({ where: { countId: count.id, ...key, ...(key.lotId === null && unit.itemColourId ? { itemColourId: unit.itemColourId } : {}) }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    let added = false
    if (!line) {
      if (item.tracking === 'HIDE' && !unit.hideId) refuse('NAME_THE_HIDE', `${item.code} is counted hide by hide: scan each hide's tag.`, 'validation_failed')
      const last = await tx.stockCountLine.findFirst({ where: { countId: count.id }, orderBy: { seq: 'desc' }, select: { seq: true } })
      const id = newId()
      await tx.stockCountLine.create({
        data: {
          id,
          siteId: count.siteId,
          countId: count.id,
          seq: (last?.seq ?? 0) + 10,
          locationId: place.id,
          itemId: unit.itemId,
          itemColourId: unit.itemColourId,
          lotId: key.lotId,
          hideId: key.hideId,
          origin: 'ADDED',
          expectedQuantity: quantityText('0'),
          ...(count.freezeMoves ? { frozenAt: now } : {}),
          createdAt: now,
          updatedAt: now,
          createdById: context.audience === 'office' ? context.actorId : null,
        },
      })
      line = (await tx.stockCountLine.findUniqueOrThrow({ where: { id }, select: LINE_COLUMNS }))
      added = true
      tools.audit({ action: 'inventory.counts.addLine', recordType: 'StockCountLine', recordId: id, siteId: count.siteId, after: { countId: count.id, seq: line.seq, locationId: place.id, itemId: unit.itemId, lotId: key.lotId, hideId: key.hideId, origin: 'ADDED', frozen: count.freezeMoves } })
    }
    const facts = factsOfLine(line)
    const pass = passOf(facts)
    if (pass === null) refuse('LINE_COUNTED', `Line ${line.seq} at ${place.code} is counted: the office asks a recount to count it again.`)
    const scans = await scansOf(tx, count.id)
    if (unit.tagged && alreadyScanned(scanFacts(scans), unit.code, pass!)) refuse('ALREADY_COUNTED', `${unit.code} is counted already in this ${pass === 'RECOUNT' ? 'recount' : 'count'}.`)
    const me = context.audience === 'floor' ? { userId: null, workerId: context.actorId } : { userId: context.actorId, workerId: null }
    if (pass === 'RECOUNT') {
      const separation = await separationFor(tx, tenantId, count.companyId)
      const counters = [{ userId: line.countedById, workerId: null }, ...scans.filter((scan) => scan.lineId === line!.id && scan.pass === 'COUNT').map((scan) => ({ userId: scan.scannedById, workerId: scan.scannedByWorkerId }))]
      const own = recountByAnotherProblem({ switchOn: separation.COUNTER_NOT_APPROVER.on, seq: line.seq, scanner: me, counters })
      if (own) refuse(own.code, own.message)
    }
    const typed = body.quantity !== undefined ? new Dec(body.quantity) : null
    const holds = typed ?? unit.holds ?? (unit.kind === 'HIDE' ? await hideHolds(tx, line, unit) : null)
    const problem = scanQuantityProblem(holds, unit.hideArea)
    if (problem) refuse('QUANTITY', problem, 'validation_failed')
    const scanId = newId()
    await tx.stockCountScan.create({
      data: {
        id: scanId,
        siteId: count.siteId,
        countId: count.id,
        lineId: line.id,
        pass: pass!,
        code: unit.code,
        quantity: holds!.toFixed(4),
        scannedAt: scannedAt && scannedAt.getTime() <= now.getTime() ? scannedAt : now,
        scannedById: me.userId,
        scannedByWorkerId: me.workerId,
        deviceId: context.audience === 'floor' ? context.deviceId : null,
        createdAt: now,
        createdById: context.audience === 'office' ? context.actorId : null,
      },
    })
    tools.audit({ action: 'inventory.counts.scan', recordType: 'StockCountScan', recordId: scanId, siteId: count.siteId, after: { countId: count.id, lineId: line.id, pass, code: unit.code, kind: unit.kind, quantity: holds!.toFixed(4) } })
    const after = scanFacts([...scans, { id: scanId, lineId: line.id, pass: pass!, code: unit.code, quantity: holds!, scannedById: me.userId, scannedByWorkerId: me.workerId, scannedAt: now } as unknown as ScanRow])
    const lineScans = scanCount(after, line.id, pass!)
    tools.emit({ type: 'inventory.count_scanned', subject: count.id, companyId: count.companyId, siteId: count.siteId, payload: { countId: count.id, number: count.number, lineId: line.id, locationId: place.id, pass: pass!, scans: lineScans, added } })
    const [view] = await binLineViews(tx, [line], after, false)
    return { scanId, count: countRef(count), line: view!, added, quantity: holds!.toFixed(4) }
  })
  return result
}

/** The number pad: the line named (an item without a label), of this count and bin. */
async function typedUnit(db: Reader, countId: string, lineId: string, place: PlaceRef): Promise<Unit> {
  const line = isUuid(lineId) ? await db.stockCountLine.findFirst({ where: { id: lineId, countId }, select: { itemId: true, lotId: true, hideId: true, itemColourId: true, locationId: true } }) : null
  if (!line || line.locationId !== place.id) return refuse('NOT_IN_BIN', `That line is not one of ${place.code}: scan the bin of the line.`, 'validation_failed')
  if (line.hideId) return refuse('SCAN_THE_HIDE', 'A hide is counted by its tag: scan it.', 'validation_failed')
  return { kind: 'TYPED', code: null, itemId: line.itemId, lotId: line.lotId, hideId: null, itemColourId: line.itemColourId, holds: null, hideArea: null, tagged: false }
}

/** A hide found holds what the books said of it at the snapshot (its line's expected), else what it holds at the site now, else its area. */
async function hideHolds(db: Reader, line: LineRow, unit: Unit): Promise<Decimal> {
  const expected = new Dec(line.expectedQuantity.toString())
  if (expected.greaterThan(0)) return expected
  const into = await db.stockMove.aggregate({ where: { hideId: unit.hideId, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const outOf = await db.stockMove.aggregate({ where: { hideId: unit.hideId, fromLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const onHand = new Dec(into._sum.baseQuantity?.toString() ?? '0').minus(outOf._sum.baseQuantity?.toString() ?? '0')
  return onHand.greaterThan(0) ? onHand : (unit.hideArea ?? ZERO)
}

// ---- Bin done, Finish bin --------------------------------------------------------------------------------------------------

async function binFacts(db: Reader, context: StockContext, countId: string, locationId: string) {
  const count = await countFor(db, context, countId)
  if (!isUuid(locationId)) throw new NotFoundError('Location not found.')
  const place = await db.location.findUnique({ where: { id: locationId }, select: { id: true, code: true, name: true, labelCode: true, kind: true, status: true, siteId: true } })
  if (!place || place.siteId !== count.siteId) throw new NotFoundError('Location not found.')
  const lines = await linesAt(db, count.id, place.id)
  const scans = scanFacts(await scansOf(db, count.id, lines.map((line) => line.id)))
  return { count, place: { ...place, kind: place.kind as string, status: place.status as string }, lines, scans }
}

async function differenceViews(db: Reader, lines: readonly LineRow[], scans: readonly ScanFacts[]) {
  const differences = binDifferences(lines.map(binLineOf), scans)
  const views = await binLineViews(db, lines, scans, false)
  const byLine = new Map(views.map((view) => [view.lineId, view]))
  return differences.map((entry) => {
    const view = byLine.get(entry.lineId)!
    return { lineId: entry.lineId, seq: entry.seq, item: { id: view.item.id, code: view.item.code, name: view.item.name, uom: view.item.uom }, lot: view.lot, hide: view.hide, pass: entry.pass, expected: entry.expected, scanned: entry.scanned, scans: entry.scans, difference: entry.difference, kind: entry.kind }
  })
}

const MOVED_WORDS = (moves: number) => ({
  en: `${moves} move${moves === 1 ? '' : 's'} into or out of this bin since the count started: look again before you finish it.`,
  it: `${moves} moviment${moves === 1 ? 'o' : 'i'} in entrata o in uscita da questo contenitore da quando è iniziato il conteggio: ricontrolla prima di chiuderlo.`,
})

/** GET /inventory/stock-counts/:countId/bins/:locationId ("Bin done") */
export async function binDone(caller: CommandCaller, countId: string, locationId: string) {
  const context = stockContextOf(caller)
  return caller.withClient(async (db) => {
    const { count, place, lines, scans } = await binFacts(db, context, countId, locationId)
    const differences = await differenceViews(db, lines, scans)
    const moved = count.snapshotAt ? await db.stockMove.count({ where: { siteId: count.siteId, reason: { not: 'COUNT' }, occurredAt: { gt: count.snapshotAt }, OR: [{ fromLocationId: place.id }, { toLocationId: place.id }] } }) : 0
    return { count: countRef(count), location: placeRef(place), differences, none: differences.every((entry) => entry.kind === 'MATCH'), movedSinceStart: moved, note: moved > 0 ? MOVED_WORDS(moved) : null }
  })
}

/** POST …/bins/:locationId/finish ("Finish bin") */
export async function finishBin(caller: CommandCaller, countId: string, locationId: string, body: { readonly occurredAt?: string | undefined }, idempotencyKey?: string) {
  const context = stockContextOf(caller)
  if (context.audience !== 'office' && context.audience !== 'floor') throw new ForbiddenError()
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) : null
  const deviceTime = context.audience === 'floor' && occurredAt ? { deviceTime: occurredAt } : {}
  const { result } = await command(caller, { name: 'inventory.counts.finishBin', idempotencyKey, input: { countId, locationId, ...body }, ...deviceTime }, async (tools) => {
    const { tx, now } = tools
    const { count, place, lines, scans } = await binFacts(tx, context, countId, locationId)
    if (count.status !== 'COUNTING') refuse('NOT_COUNTING', `Count ${count.number} is ${count.status}: its bins are finished while it is COUNTING.`)
    const writes = finishWrites(lines.map(binLineOf), scans)
    if (writes.length === 0) refuse('NOTHING_TO_FINISH', `Every line of ${place.code} is counted already.`)
    const byId = new Map(lines.map((line) => [line.id, line]))
    const officeUser = context.audience === 'office' ? context.actorId : null
    const written: LineRow[] = []
    for (const write of writes) {
      const line = byId.get(write.lineId)!
      const changes = write.pass === 'COUNT' ? { countedQuantity: write.quantity, countedAt: now, countedById: officeUser } : { recountQuantity: write.quantity, recountedAt: now, recountedById: officeUser }
      written.push(await updateLine(tools, line, changes, undefined, { action: 'inventory.counts.finishBin' }))
    }
    const finishedCounts = written.filter((line) => writes.find((write) => write.lineId === line.id)?.pass === 'COUNT')
    const ask = recountsToAsk(finishedCounts.map((line) => ({ ...factsOfLine(line), id: line.id, hideId: line.hideId })))
    let asked: LineRow[] = []
    if (context.audience === 'office' && ask.length > 0) asked = await askRuleRecounts(tools, written.filter((line) => ask.includes(line.id)), officeUser)
    const totals = await lineTotalsOf(tx, count.id)
    emitRecorded(tools, count, 'COUNTED', written.map((line) => line.id), totals)
    if (asked.length > 0) emitRecorded(tools, count, 'RECOUNT_ASKED', asked.map((line) => line.id), totals)
    // The bin's differences as they were finished (what it should hold, what was scanned), from the lines before the write.
    const differences = await differenceViews(tx, lines, scans)
    return { count: countRef(count), location: placeRef(place), lines: totals.lines, counted: totals.counted, pending: context.audience === 'floor' ? ask : [], recountsAsked: asked.map((line) => ({ lineId: line.id, seq: line.seq })), differences }
  })
  // The floor's grant cannot ask a recount: the system asks the rule's recounts right after, keyed by the finish.
  const { pending, ...answer } = result
  const recountsAsked = pending.length > 0 ? await askRecountsAsSystem(caller, result.count.id, pending, idempotencyKey) : result.recountsAsked
  return { ...answer, recountsAsked }
}

async function lineTotalsOf(tx: CommandTx, countId: string) {
  const lines = await tx.stockCountLine.count({ where: { countId } })
  const counted = await tx.stockCountLine.count({ where: { countId, countedQuantity: { not: null } } })
  return { lines, counted }
}

function emitRecorded(tools: Pick<CommandTools, 'emit'>, count: CountFacts, change: 'COUNTED' | 'RECOUNT_ASKED', lineIds: readonly string[], totals: { lines: number; counted: number }): void {
  if (lineIds.length === 0) return
  tools.emit({ type: 'inventory.count_recorded', subject: count.id, companyId: count.companyId, siteId: count.siteId, payload: { countId: count.id, number: count.number, change, lineIds: [...lineIds], lines: totals.lines, counted: totals.counted } })
}

/** The rule's recounts asked in the caller's command (office, or the system): asked by the office user, or by nobody (the rule). */
async function askRuleRecounts(tools: CommandTools, lines: readonly LineRow[], askedBy: string | null): Promise<LineRow[]> {
  const asked: LineRow[] = []
  for (const line of lines) {
    if (line.recountRequestedAt !== null) continue
    asked.push(await updateLine(tools, line, { recountRequestedAt: tools.now, recountRequestedById: askedBy, recountQuantity: null, recountedAt: null, recountedById: null }, undefined, { action: 'inventory.counts.recount', reason: 'The difference is over the recount rule: another person recounts it.' }))
  }
  return asked
}

/** After a floor's finish: the system asks the rule's recounts (one command keyed by the finish's key). */
async function askRecountsAsSystem(caller: CommandCaller, countId: string, lineIds: readonly string[], idempotencyKey: string | undefined): Promise<{ lineId: string; seq: number }[]> {
  const system = asSystem(caller)
  const { result } = await command(system, { name: 'inventory.counts.ruleRecounts', idempotencyKey: idempotencyKey ? `${idempotencyKey}:recounts`.slice(0, 128) : undefined, input: { countId, lineIds } }, async (tools) => {
    const count = await tools.tx.stockCount.findUniqueOrThrow({ where: { id: countId }, select: COUNT_FIELDS })
    if (count.status !== 'COUNTING') return { asked: [] as { lineId: string; seq: number }[] }
    const lines = await tools.tx.stockCountLine.findMany({ where: { countId, id: { in: [...lineIds] } }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const asked = await askRuleRecounts(tools, lines, null)
    emitRecorded(tools, count, 'RECOUNT_ASKED', asked.map((line) => line.id), await lineTotalsOf(tools.tx, countId))
    if (asked.length === 0) tools.audit({ action: 'inventory.counts.ruleRecounts', recordType: 'StockCount', recordId: countId, siteId: count.siteId, after: { recounts: 'unchanged' } })
    return { asked: asked.map((line) => ({ lineId: line.id, seq: line.seq })) }
  })
  return result.asked
}
