import type { FactoryClient } from '@nexus/factory-db'
import { headcountOf, operationKeyOf } from '@nexus/factory-domain/quality/reports/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The records the quality reports count (B-W2b-138), read one query after another, each the narrowest select it needs.
 * The reads never select a worker's name, and a worker id is read only to COUNT the people behind a group (ANA-075): it is
 * turned into a headcount here and never leaves this file. Nothing here writes.
 *
 * Signed records only: final inspections PASSED or FAILED, incoming inspections and in-process checks DECIDED, each with the
 * values it was signed with (an amendment never changes a verdict, a class, a quantity or a count: B-W2b-123).
 */

export type Reader = FactoryClient | CommandTx

export interface Span {
  readonly start: Date
  readonly end: Date
}

const within = (span: Span) => ({ gte: span.start, lt: span.end })
const ids = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string'))]

// ---- the site's lines and stations --------------------------------------------------------------------------------------------

export interface SitePlaces {
  readonly lines: readonly { readonly id: string; readonly code: string; readonly name: string }[]
  /** station → its line (a station that stands alone has none). */
  readonly lineOfStation: ReadonlyMap<string, string>
}

export async function sitePlaces(db: Reader, siteId: string): Promise<SitePlaces> {
  const lines = await db.line.findMany({ where: { siteId }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const stations = await db.station.findMany({ where: { siteId, lineId: { not: null } }, select: { id: true, lineId: true } })
  return { lines, lineOfStation: new Map(stations.map((row) => [row.id, row.lineId!])) }
}

// ---- in-process checks (B-W2b-99) -----------------------------------------------------------------------------------------------

export interface EndOfLine {
  readonly lineId: string | null
  readonly workOrderId: string | null
  readonly pieces: number
  readonly defectivePieces: number
  readonly defects: number
  readonly decidedAt: Date
}

/** The decided end-of-line checks of a span (the FPY and DHU of a line). */
export async function endOfLineChecks(db: Reader, siteId: string, span: Span, lineId?: string | null): Promise<EndOfLine[]> {
  const rows = await db.inProcessCheck.findMany({
    where: { siteId, kind: 'END_OF_LINE', status: 'DECIDED', decidedAt: within(span), ...(lineId ? { lineId } : {}) },
    select: { lineId: true, workOrderId: true, pieces: true, defectivePieces: true, defects: true, decidedAt: true },
  })
  return rows.map((row) => ({ ...row, decidedAt: row.decidedAt! }))
}

export interface Charge {
  readonly workOrderOperationId: string
  readonly defects: number
}

/**
 * The defects charged to operations in a span, as B-W2b-99's `GET /quality/inprocess/charges` counts them (its reader is not
 * exported: the same three sources, read here): end-of-line FAILs and roving findings naming an operation, and scrap or
 * rework scan lines charged to the operation that caused them (`causedAtOperationId`). Per operation, never per person.
 */
export async function chargesIn(db: Reader, siteId: string, span: Span): Promise<Charge[]> {
  const checks = await db.inProcessCheck.findMany({
    where: { siteId, status: 'DECIDED', decidedAt: within(span), workOrderOperationId: { not: null }, defects: { gt: 0 }, OR: [{ kind: 'END_OF_LINE', outcome: 'FAIL' }, { kind: 'ROVING' }] },
    select: { workOrderOperationId: true, defects: true },
  })
  const lines = await db.operationScanDefect.findMany({
    where: { siteId, causedAtOperationId: { not: null }, serverTime: within(span), scanId: { not: null } },
    select: { causedAtOperationId: true, quantity: true },
  })
  return [...checks.map((row) => ({ workOrderOperationId: row.workOrderOperationId!, defects: row.defects })), ...lines.map((row) => ({ workOrderOperationId: row.causedAtOperationId!, defects: row.quantity }))]
}

// ---- the floor's scans: pieces per operation, and the people behind a group ---------------------------------------------------

/**
 * The pieces reported at each work-order operation in a span: good + scrap + rework of the count scans that stand (a REPORT or
 * CORRECTION no later scan voids; UNDO rows carry none). A correction counts on its own day.
 */
export async function piecesByOperation(db: Reader, siteId: string, span: Span): Promise<Map<string, number>> {
  const rows = await db.operationScan.groupBy({
    by: ['workOrderOperationId'],
    where: { siteId, kind: { in: ['REPORT', 'CORRECTION'] }, serverTime: within(span), correctedBy: { none: {} } },
    _sum: { goodQuantity: true, scrapQuantity: true, reworkQuantity: true },
  })
  return new Map(rows.map((row) => [row.workOrderOperationId, (row._sum.goodQuantity ?? 0) + (row._sum.scrapQuantity ?? 0) + (row._sum.reworkQuantity ?? 0)]))
}

/** Headcounts of a span: the whole site, and each line (by the stations the scans were made at). */
export interface PlacePeople {
  readonly site: number
  readonly byLine: ReadonlyMap<string, number>
  /** Who worked at stations on no line (or at none). */
  readonly alone: number
}

/** Who worked at the site and on each line in a span, as headcounts (every scan that names a worker; none: no one). */
export async function peopleOfPlaces(db: Reader, siteId: string, span: Span, places: SitePlaces): Promise<PlacePeople> {
  const rows = await db.operationScan.groupBy({ by: ['stationId', 'workerId'], where: { siteId, serverTime: within(span), workerId: { not: null } } })
  const byLine = new Map<string, Set<string>>()
  const alone = new Set<string>()
  for (const row of rows) {
    if (!row.workerId) continue
    const line = row.stationId ? places.lineOfStation.get(row.stationId) : undefined
    if (!line) alone.add(row.workerId)
    else byLine.set(line, (byLine.get(line) ?? new Set<string>()).add(row.workerId))
  }
  return { site: headcountOf(rows.map((row) => row.workerId)), byLine: new Map([...byLine].map(([line, workers]) => [line, workers.size])), alone: alone.size }
}

/** The headcounts of each week of a period (one grouped read per week). */
export async function weeklyPeople(db: Reader, siteId: string, weeks: readonly { readonly key: string; readonly span: Span }[], places: SitePlaces): Promise<Map<string, PlacePeople>> {
  const out = new Map<string, PlacePeople>()
  for (const week of weeks) out.set(week.key, await peopleOfPlaces(db, siteId, week.span, places))
  return out
}

/** Who worked each operation (by the report's operation key) in a span, as headcounts. */
export async function peopleOfOperations(db: Reader, siteId: string, span: Span, keyOf: ReadonlyMap<string, string>): Promise<Map<string, number>> {
  const rows = await db.operationScan.groupBy({ by: ['workOrderOperationId', 'workerId'], where: { siteId, serverTime: within(span), workerId: { not: null } } })
  const byKey = new Map<string, Set<string>>()
  for (const row of rows) {
    const key = keyOf.get(row.workOrderOperationId)
    if (!key || !row.workerId) continue
    byKey.set(key, (byKey.get(key) ?? new Set<string>()).add(row.workerId))
  }
  return new Map([...byKey].map(([key, workers]) => [key, workers.size]))
}

/** The makers of some work orders (every scan of theirs that names a worker, whenever it was made), per work order. */
export async function makersOf(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, ReadonlySet<string>>> {
  if (workOrderIds.length === 0) return new Map()
  const rows = await db.operationScan.groupBy({ by: ['workOrderId', 'workerId'], where: { workOrderId: { in: [...workOrderIds] }, workerId: { not: null } } })
  const out = new Map<string, Set<string>>()
  for (const row of rows) if (row.workerId) out.set(row.workOrderId, (out.get(row.workOrderId) ?? new Set<string>()).add(row.workerId))
  return out
}

/** How many people made a set of work orders (each person once). */
export function makersCount(makers: ReadonlyMap<string, ReadonlySet<string>>, workOrderIds: Iterable<string>): number {
  const all = new Set<string>()
  for (const id of workOrderIds) for (const worker of makers.get(id) ?? []) all.add(worker)
  return all.size
}

/** The work-order operations of some ids → their report key (library operation, else code), code and name. */
export async function operationsOf(db: Reader, operationIds: readonly string[]) {
  const rows = operationIds.length ? await db.workOrderOperation.findMany({ where: { id: { in: [...operationIds] } }, select: { id: true, operationId: true, code: true, name: true } }) : []
  return new Map(rows.map((row) => [row.id, { key: operationKeyOf(row), operationId: row.operationId, code: row.code, name: row.name }]))
}

// ---- final inspections (W1, B-W2b-97) -------------------------------------------------------------------------------------------

export interface FinalRow {
  readonly id: string
  readonly workOrderId: string
  readonly passed: boolean
  readonly sampleSize: number
  readonly planVersionId: string | null
  readonly checklist: unknown
  readonly decidedAt: Date
  readonly defects: number
}

/** The final inspections signed in a span (PASSED or FAILED), with their defect quantities. */
export async function finalInspections(db: Reader, siteId: string, span: Span): Promise<FinalRow[]> {
  const rows = await db.inspection.findMany({
    where: { siteId, status: { in: ['PASSED', 'FAILED'] }, decidedAt: within(span) },
    select: { id: true, workOrderId: true, status: true, sampleSize: true, planVersionId: true, checklist: true, decidedAt: true },
  })
  const sums = rows.length
    ? await db.inspectionDefect.groupBy({ by: ['inspectionId'], where: { inspectionId: { in: rows.map((row) => row.id) } }, _sum: { quantity: true } })
    : []
  const defects = new Map(sums.map((row) => [row.inspectionId, row._sum.quantity ?? 0]))
  return rows.map((row) => ({ id: row.id, workOrderId: row.workOrderId, passed: row.status === 'PASSED', sampleSize: row.sampleSize, planVersionId: row.planVersionId, checklist: row.checklist, decidedAt: row.decidedAt!, defects: defects.get(row.id) ?? 0 }))
}

/** Some work orders' style and line. */
export async function workOrdersOf(db: Reader, workOrderIds: readonly string[]) {
  const rows = workOrderIds.length ? await db.workOrder.findMany({ where: { id: { in: [...workOrderIds] } }, select: { id: true, styleId: true, lineId: true } }) : []
  return new Map(rows.map((row) => [row.id, row]))
}

export async function stylesOf(db: Reader, styleIds: readonly string[]) {
  const rows = styleIds.length ? await db.style.findMany({ where: { id: { in: [...styleIds] } }, select: { id: true, code: true, name: true } }) : []
  return new Map(rows.map((row) => [row.id, row]))
}

// ---- nonconformances (B-W2a-47) -------------------------------------------------------------------------------------------------

/** The NCRs found in a span and not cancelled: what each names (style, supplier, work order, lot). */
export async function ncrsFound(db: Reader, siteId: string, span: Span) {
  return db.nonconformance.findMany({ where: { siteId, foundOn: within(span), stage: { not: 'CANCELLED' } }, select: { styleId: true, supplierId: true, workOrderId: true, lotId: true } })
}

/** The NCRs that may stand open at a moment (found by then, not closed or cancelled before it): their dates. */
export async function ncrsAround(db: Reader, siteId: string, at: Date) {
  return db.nonconformance.findMany({
    where: { siteId, foundOn: { lte: at }, AND: [{ OR: [{ closedAt: null }, { closedAt: { gt: at } }] }, { OR: [{ cancelledAt: null }, { cancelledAt: { gt: at } }] }] },
    select: { foundOn: true, closedAt: true, cancelledAt: true },
  })
}

// ---- corrective actions (B-W2b-108; company-wide) -------------------------------------------------------------------------------

/** The CAPA actions of a company done in a span (with what can() needs and who owns them: counted, never named). */
export async function capaActionsDone(db: Reader, companyId: string, span: Span) {
  return db.capaAction.findMany({
    where: { status: 'DONE', doneAt: within(span), capa: { companyId } },
    select: { dueOn: true, doneAt: true, ownerId: true, capa: { select: { companyId: true, customerId: true } } },
  })
}

/** The CAPAs of a company closed in a span (the trend's markers). */
export async function capasClosed(db: Reader, companyId: string, span: Span) {
  return db.capa.findMany({ where: { companyId, status: 'CLOSED', closedAt: within(span) }, select: { id: true, number: true, closedAt: true, companyId: true, customerId: true }, orderBy: [{ closedAt: 'asc' }, { id: 'asc' }] })
}

// ---- holds (B-W2a-67, B-W2b-114) ------------------------------------------------------------------------------------------------

/** The holds that may stand at a moment and were placed before `placedBefore`. */
export async function holdsAround(db: Reader, siteId: string, at: Date, placedBefore: Date) {
  return db.qualityHold.findMany({
    where: { siteId, placedAt: { lt: placedBefore }, AND: [{ OR: [{ releasedAt: null }, { releasedAt: { gt: at } }] }, { OR: [{ closedAt: null }, { closedAt: { gt: at } }] }] },
    select: { placedAt: true, releasedAt: true, closedAt: true },
  })
}

// ---- incoming quality (B-W2b-98, B-W2b-111; the lab, B-W1-34) -----------------------------------------------------------------

/** The incoming inspections signed in a span: what they sampled and found, and whose goods they were. */
export async function incomingDecided(db: Reader, siteId: string, span: Span) {
  return db.incomingInspection.findMany({
    where: { siteId, status: 'DECIDED', decidedAt: within(span) },
    select: { lotId: true, subcontractReceiptId: true, sampleSize: true, foundCritical: true, foundMajor: true, foundMinor: true, computedResult: true },
  })
}

/** The lots received in a span with their supplier, quality status and when the lab decided. */
export async function lotsReceived(db: Reader, siteId: string, span: Span) {
  return db.lot.findMany({ where: { siteId, receivedAt: within(span) }, select: { id: true, supplierId: true, qualityStatus: true, receivedAt: true, qualityDecidedAt: true } })
}

/** The lots (of some) with a Cr VI FAIL result recorded. */
export async function crViFailed(db: Reader, lotIds: readonly string[]): Promise<Set<string>> {
  if (lotIds.length === 0) return new Set()
  const rows = await db.labResult.findMany({ where: { lotId: { in: [...lotIds] }, test: 'CR_VI', verdict: 'FAIL' }, select: { lotId: true } })
  return new Set(rows.map((row) => row.lotId))
}

/** Lots' suppliers. */
export async function lotSuppliers(db: Reader, lotIds: readonly string[]): Promise<Map<string, string | null>> {
  const rows = lotIds.length ? await db.lot.findMany({ where: { id: { in: [...lotIds] } }, select: { id: true, supplierId: true } }) : []
  return new Map(rows.map((row) => [row.id, row.supplierId]))
}

/** Workshop receipts' workshops (the subcontract order's party). */
export async function receiptWorkshops(db: Reader, receiptIds: readonly string[]): Promise<Map<string, string>> {
  if (receiptIds.length === 0) return new Map()
  const receipts = await db.subcontractReceipt.findMany({ where: { id: { in: [...receiptIds] } }, select: { id: true, subcontractOrderId: true } })
  const orders = new Map((await db.subcontractOrder.findMany({ where: { id: { in: ids(receipts.map((row) => row.subcontractOrderId)) } }, select: { id: true, partyId: true } })).map((row) => [row.id, row.partyId]))
  return new Map(receipts.flatMap((row) => (orders.has(row.subcontractOrderId) ? [[row.id, orders.get(row.subcontractOrderId)!] as const] : [])))
}

export async function partiesOf(db: Reader, partyIds: readonly string[]) {
  const rows = partyIds.length ? await db.party.findMany({ where: { id: { in: [...partyIds] } }, select: { id: true, code: true, legalName: true, tradeName: true } }) : []
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }]))
}

// ---- amendments (B-W2b-123) -----------------------------------------------------------------------------------------------------

/** Corrections countersigned in a span (SIGNED rows; who signed is never read). */
export async function amendmentsSigned(db: Reader, siteId: string, span: Span): Promise<number> {
  return db.inspectionAmendment.count({ where: { siteId, kind: 'SIGNED', signedAt: within(span) } })
}

export { ids }
