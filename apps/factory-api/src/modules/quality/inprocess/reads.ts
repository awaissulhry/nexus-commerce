import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { QUALITY_INPROCESS_VIEW } from '@nexus/factory-domain/quality/inprocess/permissions'
import { chargeDisputeWords, chargesByOperation, CHARGE_SOURCE_WORDS, LIMITS, OPERATOR_NOT_NAMED, OUTCOME_WORDS, type Charge, type ChargeSource, type InProcessKind, type InProcessStatus } from '@nexus/factory-domain/quality/inprocess/rules'
import { DISPUTE_REASONS_FOR } from '@nexus/factory-domain/production/labour/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { endOfLineDhu } from '../../production/boards/quality'
import { devicePlaceOf } from '../../production/calls/store'
import { firstPieceCardOf } from '../../production/terminal/first-piece'
import { assertOn, checkerOf, floorOf, mayOn, systemOf, type Checker } from './access'
import { CHECK_COLUMNS, readLine, readOperationsOf, readWorkOrder, type CheckRow, type LineRow, type Reader } from './store'
import { checkRowOf, lookupsOf } from './views'

/**
 * The reads of in-process checks (B-W2b-99): the list (per line and operation), a line's DHU of a day, the roving board of a
 * line, whether a bundle's run waits for its first piece, the defects charged to each operation (MES-127) and the worker's
 * own charges (behind the gate). No list, filter, group or total carries a person (Owner answers W1, F2).
 */

const now = () => serverClock.now()

async function siteZone(db: Pick<Reader, 'site'>, siteId: string): Promise<string> {
  return (await db.site.findUnique({ where: { id: siteId }, select: { timezone: true } }))?.timezone ?? 'Europe/Rome'
}

/** A day's range at the site (a day not given: today there). */
async function dayAt(db: Pick<Reader, 'site'>, siteId: string, date: BusinessDate | undefined) {
  const zone = await siteZone(db, siteId)
  const day = date ?? businessDate(now(), zone)
  return { day, range: businessDayRange(day, zone) }
}

/** The line a read is about: the one named, else the floor device's (400 when neither). */
async function lineFor(caller: CommandCaller, context: Checker, lineId: string | undefined): Promise<LineRow> {
  const id = lineId ?? (context.audience === 'floor' ? await caller.withClient(async (db) => (await devicePlaceOf(db, context.deviceId)).lineId) : null)
  if (!id) throw new ValidationError(context.audience === 'floor' ? 'This tablet shows no line: name the line.' : 'Name the line.', [{ path: 'querystring/lineId', message: 'Name the line.' }])
  const line = await caller.withClient((db) => readLine(db, id))
  if (!line || !mayOn(context, QUALITY_INPROCESS_VIEW, line)) throw new NotFoundError('Line not found.')
  return line
}

// ---- the list -------------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly workOrderOperationId?: string | undefined
  readonly kind?: InProcessKind | undefined
  readonly status?: InProcessStatus | undefined
  readonly date?: BusinessDate | undefined
}

/** GET /quality/inprocess/checks: newest first, at most 500; a floor device its own site only. */
export async function listChecks(caller: CommandCaller, query: ListQuery) {
  const context = checkerOf(caller)
  const siteId = context.audience === 'floor' ? context.siteId : query.siteId
  if (!siteId && !query.lineId && !query.workOrderId) throw new ValidationError('Name the site, the line or the work order.', [{ path: 'querystring/siteId', message: 'Name the site, the line or the work order.' }])
  return caller.withClient(async (db) => {
    let range: { start: Date; end: Date } | null = null
    if (query.date) {
      const anchor = siteId ?? (query.lineId ? (await readLine(db, query.lineId))?.siteId : query.workOrderId ? (await readWorkOrder(db, query.workOrderId))?.siteId : null)
      if (anchor) range = (await dayAt(db, anchor, query.date)).range
    }
    const where: Prisma.InProcessCheckWhereInput = {
      AND: [
        context.audience === 'office' ? (scopeWhere(actorOf(context), QUALITY_INPROCESS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.InProcessCheckWhereInput) : { siteId: context.siteId },
        ...(siteId ? [{ siteId }] : []),
        ...(query.lineId ? [{ lineId: query.lineId }] : []),
        ...(query.workOrderId ? [{ workOrderId: query.workOrderId }] : []),
        ...(query.workOrderOperationId ? [{ workOrderOperationId: query.workOrderOperationId }] : []),
        ...(query.kind ? [{ kind: query.kind }] : []),
        ...(query.status ? [{ status: query.status }] : []),
        ...(range ? [{ createdAt: { gte: range.start, lt: range.end } }] : []),
      ],
    }
    const rows = await db.inProcessCheck.findMany({ where, select: CHECK_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: LIMITS.list + 1 })
    const shown = rows.slice(0, LIMITS.list).filter((row) => mayOn(context, QUALITY_INPROCESS_VIEW, row))
    const look = await lookupsOf(db, shown)
    const counts = { open: shown.filter((row) => row.status === 'OPEN').length, decided: shown.filter((row) => row.status === 'DECIDED').length, firstPiecesOpen: shown.filter((row) => row.kind === 'FIRST_PIECE' && row.status === 'OPEN').length }
    return { checks: shown.map((row) => checkRowOf(row, look)), counts, capped: rows.length > LIMITS.list }
  })
}

// ---- the line's DHU -------------------------------------------------------------------------------------------------------------

/** GET /quality/inprocess/dhu: the line's DHU of a day from its end-of-line checks, and the defects charged per operation. */
export async function lineDhuRead(caller: CommandCaller, query: { readonly lineId?: string | undefined; readonly date?: BusinessDate | undefined }) {
  const context = checkerOf(caller)
  const line = await lineFor(caller, context, query.lineId)
  return caller.withClient(async (db) => {
    const { day, range } = await dayAt(db, line.siteId, query.date)
    const measured = await endOfLineDhu(db, line.id, range)
    const failed = await db.inProcessCheck.findMany({ where: { lineId: line.id, kind: 'END_OF_LINE', status: 'DECIDED', outcome: 'FAIL', decidedAt: { gte: range.start, lt: range.end }, workOrderOperationId: { not: null } }, select: { workOrderOperationId: true, defects: true } })
    const operations = new Map((await db.workOrderOperation.findMany({ where: { id: { in: [...new Set(failed.map((row) => row.workOrderOperationId!))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    // Per operation CODE across the line's work orders: "Op 30 Collar: 4 defects" (the line's operations, never a person).
    const byCode = new Map<string, { code: string; name: string; defects: number }>()
    for (const row of failed) {
      const operation = operations.get(row.workOrderOperationId!)
      if (!operation) continue
      const entry = byCode.get(operation.code) ?? { code: operation.code, name: operation.name, defects: 0 }
      entry.defects += row.defects
      byCode.set(operation.code, entry)
    }
    return {
      line: { id: line.id, code: line.code, name: line.name },
      day,
      dhu: measured.dhu,
      defects: measured.defects,
      pieces: measured.pieces,
      checks: measured.checks,
      byOperation: [...byCode.values()].sort((a, b) => b.defects - a.defects || a.code.localeCompare(b.code)),
      asOf: toUtcIso(now()),
    }
  })
}

// ---- the roving board -----------------------------------------------------------------------------------------------------------

/**
 * GET /quality/inprocess/roving: the line's operations as tiles (design floor.inline "Roving check"): the operations of the
 * work orders the line runs (allocated to it, released or in progress) at its stations' work centres, each with its latest
 * roving light of the day and the day's count. Per operation, never per person.
 */
export async function rovingBoard(caller: CommandCaller, query: { readonly lineId?: string | undefined; readonly date?: BusinessDate | undefined }) {
  const context = checkerOf(caller)
  const line = await lineFor(caller, context, query.lineId)
  return caller.withClient(async (db) => {
    const { day, range } = await dayAt(db, line.siteId, query.date)
    const stations = await db.station.findMany({ where: { lineId: line.id }, select: { id: true, workCentreId: true } })
    const centres = new Set(stations.map((row) => row.workCentreId))
    const checks = await db.inProcessCheck.findMany({
      where: { lineId: line.id, kind: 'ROVING', status: 'DECIDED', decidedAt: { gte: range.start, lt: range.end } },
      select: { id: true, workOrderId: true, workOrderOperationId: true, outcome: true, pieces: true, defectivePieces: true, decidedAt: true },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
    })
    // The work orders the line runs: allocated to it (released or in progress), worked at its stations today, or checked on it today.
    const scanned = stations.length ? await db.operationScan.findMany({ where: { stationId: { in: stations.map((row) => row.id) }, serverTime: { gte: range.start, lt: range.end } }, select: { workOrderId: true }, distinct: ['workOrderId'], take: 50 }) : []
    const orders = await db.workOrder.findMany({
      where: { OR: [{ lineId: line.id, status: { in: ['RELEASED', 'IN_PROGRESS'] } }, { id: { in: [...new Set([...scanned.map((row) => row.workOrderId), ...checks.map((row) => row.workOrderId).filter((id): id is string => id !== null)])] } }] },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
      take: 50,
    })
    const checkedOperations = new Set(checks.map((row) => row.workOrderOperationId).filter((id): id is string => id !== null))
    const operations = (await readOperationsOf(db, orders.map((order) => order.id))).filter((operation) => checkedOperations.has(operation.id) || centres.size === 0 || centres.has(operation.workCentreId))
    const number = new Map(orders.map((order) => [order.id, order.number]))
    return {
      line: { id: line.id, code: line.code, name: line.name },
      day,
      tiles: operations.map((operation) => {
        const mine = checks.filter((check) => check.workOrderOperationId === operation.id)
        const latest = mine[0] ?? null
        const outcome = (latest?.outcome as 'GREEN' | 'AMBER' | 'RED' | null | undefined) ?? null
        return {
          workOrder: { id: operation.workOrderId, number: number.get(operation.workOrderId) ?? '' },
          operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name },
          latest: latest ? { checkId: latest.id, outcome: outcome!, outcomeWords: OUTCOME_WORDS[outcome!], pieces: latest.pieces, defectivePieces: latest.defectivePieces, at: toUtcIso(latest.decidedAt!) } : null,
          checksToday: mine.length,
        }
      }),
      /** Roving checks of the day naming no operation (a check of the line as a whole). */
      lineChecksToday: checks.filter((check) => check.workOrderOperationId === null).length,
      asOf: toUtcIso(now()),
    }
  })
}

// ---- the first-piece hold of a bundle -------------------------------------------------------------------------------------------

/** GET /quality/inprocess/first-piece?bundleId: the operation screen's flag (the same as the bundle card's). */
export async function firstPieceRead(caller: CommandCaller, query: { readonly bundleId: string }) {
  const context = checkerOf(caller)
  return caller.withClient(async (db) => {
    const bundle = await db.bundle.findUnique({ where: { id: query.bundleId }, select: { id: true, code: true, workOrderId: true, siteId: true } })
    if (!bundle || (context.audience === 'floor' && bundle.siteId !== context.siteId)) throw new NotFoundError('Bundle not found.')
    const order = await readWorkOrder(db, bundle.workOrderId)
    if (!order || !mayOn(context, PRODUCTION_SCAN, order)) throw new NotFoundError('Bundle not found.')
    const operations = await readOperationsOf(db, [order.id])
    return { bundle: { id: bundle.id, code: bundle.code }, workOrder: { id: order.id, number: order.number }, firstPiece: await firstPieceCardOf(db, bundle, operations.map((operation) => operation.id), order.number) }
  })
}

// ---- defects charged to an operation (MES-127) ---------------------------------------------------------------------------------

interface ChargeRow extends Charge {
  readonly at: Date
  readonly siteId: string
  readonly bundleId: string | null
  readonly defect: string
  readonly checkId: string | null
  readonly scanDefectId: string | null
}

/** The charges of a range at a site: end-of-line defects and roving findings naming an operation, and scan lines charged. */
async function chargesIn(db: Reader, where: { readonly siteId: string; readonly start: Date; readonly end: Date; readonly lineId?: string | undefined; readonly workOrderId?: string | undefined; readonly workerId?: string | undefined }): Promise<ChargeRow[]> {
  const checks = await db.inProcessCheck.findMany({
    where: {
      siteId: where.siteId,
      status: 'DECIDED',
      decidedAt: { gte: where.start, lt: where.end },
      workOrderOperationId: { not: null },
      defects: { gt: 0 },
      OR: [{ kind: 'END_OF_LINE', outcome: 'FAIL' }, { kind: 'ROVING' }],
      ...(where.lineId ? { lineId: where.lineId } : {}),
      ...(where.workOrderId ? { workOrderId: where.workOrderId } : {}),
      ...(where.workerId ? { workerId: where.workerId } : {}),
    },
    select: { id: true, kind: true, siteId: true, bundleId: true, workOrderOperationId: true, defects: true, defectCodeId: true, decidedAt: true },
  })
  const codes = new Map((await db.defectCode.findMany({ where: { id: { in: [...new Set(checks.map((row) => row.defectCodeId).filter((id): id is string => id !== null))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const rows: ChargeRow[] = checks.map((row) => ({ source: row.kind as ChargeSource, workOrderOperationId: row.workOrderOperationId!, defects: row.defects, at: row.decidedAt!, siteId: row.siteId, bundleId: row.bundleId, defect: (row.defectCodeId && codes.get(row.defectCodeId)) || '?', checkId: row.id, scanDefectId: null }))
  if (where.workerId) return rows
  const lines = await db.operationScanDefect.findMany({
    where: { siteId: where.siteId, causedAtOperationId: { not: null }, serverTime: { gte: where.start, lt: where.end }, scanId: { not: null }, ...(where.workOrderId ? { causedAtOperation: { workOrderId: where.workOrderId } } : {}) },
    select: { id: true, siteId: true, causedAtOperationId: true, quantity: true, reasonCode: true, serverTime: true, scan: { select: { bundleId: true, stationId: true } } },
  })
  let kept = lines
  if (where.lineId) {
    const stations = new Set((await db.station.findMany({ where: { lineId: where.lineId }, select: { id: true } })).map((row) => row.id))
    kept = lines.filter((line) => line.scan?.stationId && stations.has(line.scan.stationId))
  }
  return [...rows, ...kept.map((line) => ({ source: 'SCAN' as const, workOrderOperationId: line.causedAtOperationId!, defects: line.quantity, at: line.serverTime, siteId: line.siteId, bundleId: line.scan?.bundleId ?? null, defect: line.reasonCode, checkId: null, scanDefectId: line.id }))]
}

/** GET /quality/inprocess/charges: the defects charged to each operation in a range (per operation, never per person). */
export async function chargesRead(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly lineId?: string | undefined; readonly workOrderId?: string | undefined; readonly from?: BusinessDate | undefined; readonly to?: BusinessDate | undefined }) {
  const context = checkerOf(caller)
  return caller.withClient(async (db) => {
    let siteId = query.siteId
    let companyId: string | null = null
    if (query.lineId) {
      const line = await readLine(db, query.lineId)
      if (!line) throw new NotFoundError('Line not found.')
      siteId = line.siteId
      companyId = line.companyId
    }
    if (query.workOrderId) {
      const order = await readWorkOrder(db, query.workOrderId)
      if (!order) throw new NotFoundError('Work order not found.')
      siteId = order.siteId
      companyId = order.companyId
    }
    if (!siteId) throw new ValidationError('Name the site, the line or the work order.', [{ path: 'querystring/siteId', message: 'Name the site, the line or the work order.' }])
    const site = await db.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, timezone: true } })
    if (!site) throw new NotFoundError('Site not found.')
    assertOn(context, QUALITY_INPROCESS_VIEW, QUALITY_INPROCESS_VIEW, { companyId: companyId ?? site.companyId, siteId: site.id }, 'Site')
    const today = businessDate(now(), site.timezone)
    const from = query.from ?? today
    const to = query.to ?? from
    if (to < from) throw new ValidationError('The range ends before it starts.', [{ path: 'querystring/to', message: 'On or after the first day.' }])
    const start = businessDayRange(from, site.timezone).start
    const end = businessDayRange(to, site.timezone).end
    const charges = await chargesIn(db, { siteId: site.id, start, end, lineId: query.lineId, workOrderId: query.workOrderId })
    const grouped = chargesByOperation(charges)
    const operations = new Map((await db.workOrderOperation.findMany({ where: { id: { in: grouped.map((row) => row.workOrderOperationId) } }, select: { id: true, seq: true, code: true, name: true, workOrderId: true } })).map((row) => [row.id, row]))
    const numbers = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set([...operations.values()].map((row) => row.workOrderId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
    return {
      from,
      to,
      operations: grouped.map((row) => {
        const operation = operations.get(row.workOrderOperationId)
        return {
          operation: { id: row.workOrderOperationId, seq: operation?.seq ?? 0, code: operation?.code ?? '?', name: operation?.name ?? '?' },
          workOrder: { id: operation?.workOrderId ?? '', number: numbers.get(operation?.workOrderId ?? '') ?? '' },
          defects: row.defects,
          bySource: row.bySource,
        }
      }),
      sources: CHARGE_SOURCE_WORDS,
      defects: grouped.reduce((sum, row) => sum + row.defects, 0),
    }
  })
}

// ---- the worker's own charges (My day) -----------------------------------------------------------------------------------------

/**
 * GET /quality/inprocess/floor/mine?date: the defects charged to the signed-in worker's operations (MES-127; design
 * floor.myday "defects charged to your operation"; floor.reasons "the worker sees and may dispute it on My day"). Per worker
 * only behind the site's PERFORMANCE gate (read in the tenant's system view): closed, the answer says so and lists nothing.
 * A charge is theirs when it names them (a check named behind the gate), or when it is a scan line charged to an operation
 * of a bundle whose standing report there is theirs. Each charge says which of their own reports a dispute goes on
 * (POST /production/labour/floor/disputes: recordType OperationScan, a reason tile, these words) and the open dispute.
 */
export async function mineRead(caller: CommandCaller, query: { readonly date?: BusinessDate | undefined }) {
  const context = floorOf(caller)
  return systemOf(caller).withClient(async (db) => {
    if (!(await workerGateFor(db, context.siteId)).open) return { open: false, words: OPERATOR_NOT_NAMED, day: query.date ?? null, charges: [] }
    const { day, range } = await dayAt(db, context.siteId, query.date)
    const named = await chargesIn(db, { siteId: context.siteId, start: range.start, end: range.end, workerId: context.actorId })
    const all = (await chargesIn(db, { siteId: context.siteId, start: range.start, end: range.end })).filter((row) => row.source === 'SCAN')
    // My standing reports at the bundles and operations charged: whose operation it was.
    const pairs = [...named, ...all].filter((row) => row.bundleId !== null)
    const reports = pairs.length
      ? await db.operationScan.findMany({
          where: { workerId: context.actorId, kind: { in: ['REPORT', 'CORRECTION'] }, correctedBy: { none: {} }, OR: pairs.map((row) => ({ bundleId: row.bundleId!, workOrderOperationId: row.workOrderOperationId })) },
          select: { id: true, bundleId: true, workOrderOperationId: true },
        })
      : []
    const reportOf = (row: ChargeRow) => reports.find((report) => report.bundleId === row.bundleId && report.workOrderOperationId === row.workOrderOperationId) ?? null
    const mine = [...named, ...all.filter((row) => reportOf(row) !== null)].sort((a, b) => b.at.getTime() - a.at.getTime())
    const operations = new Map((await db.workOrderOperation.findMany({ where: { id: { in: [...new Set(mine.map((row) => row.workOrderOperationId))] } }, select: { id: true, seq: true, code: true, name: true } })).map((row) => [row.id, row]))
    const bundles = new Map((await db.bundle.findMany({ where: { id: { in: [...new Set(mine.map((row) => row.bundleId).filter((id): id is string => id !== null))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const reportIds = mine.map((row) => reportOf(row)?.id).filter((id): id is string => typeof id === 'string')
    const disputes = reportIds.length ? await db.labourDispute.findMany({ where: { workerId: context.actorId, recordType: 'OperationScan', recordId: { in: reportIds } }, select: { id: true, recordId: true, status: true, answer: true }, orderBy: { createdAt: 'desc' } }) : []
    return {
      open: true,
      words: null,
      day,
      charges: mine.map((row) => {
        const operation = operations.get(row.workOrderOperationId)
        const report = reportOf(row)
        const dispute = report ? (disputes.find((entry) => entry.recordId === report.id) ?? null) : null
        const bundleCode = row.bundleId ? (bundles.get(row.bundleId) ?? null) : null
        const operationText = operation ? `Op ${operation.seq} ${operation.name}` : '?'
        return {
          source: row.source,
          sourceWords: CHARGE_SOURCE_WORDS[row.source],
          checkId: row.checkId,
          scanDefectId: row.scanDefectId,
          at: toUtcIso(row.at),
          operation: { id: row.workOrderOperationId, seq: operation?.seq ?? 0, code: operation?.code ?? '?', name: operation?.name ?? '?' },
          bundle: row.bundleId ? { id: row.bundleId, code: bundleCode ?? '' } : null,
          defect: row.defect,
          defects: row.defects,
          dispute: {
            recordType: 'OperationScan' as const,
            recordId: report?.id ?? null,
            reasons: [...DISPUTE_REASONS_FOR.OperationScan],
            words: chargeDisputeWords({ defect: row.defect, operation: operationText, bundleCode, source: row.source }),
            open: dispute ? { id: dispute.id, status: dispute.status as 'OPEN' | 'UPHELD' | 'REJECTED' | 'WITHDRAWN', answer: dispute.answer } : null,
          },
        }
      }),
    }
  })
}

export type { CheckRow }
