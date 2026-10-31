import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { daysOf } from '@nexus/factory-domain/calendars/working-time'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import {
  bunchedAtShiftEnd,
  findingKey,
  gapBelowStandard,
  movedNotScanned,
  newFindings,
  PATTERN_RULES,
  reviewProblems,
  summarise,
  whoRefusal,
  type FindingStatus,
  type FoundPattern,
  type PatternScan,
  type ScanPatternKind,
  type WhoPurpose,
} from '@nexus/factory-domain/production/bundles/patterns'
import { PRODUCTION_BUNDLES_FINDINGS, PRODUCTION_BUNDLES_VIEW, PRODUCTION_BUNDLES_WHO } from '@nexus/factory-domain/production/bundles/permissions'
import { callerFor, COMMAND_SETTINGS, command, runCommand, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { workingCalendarFor } from '../../../platform/calendars/service'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import type { Reader } from './store'
import { operationsOf, stationsOf } from './track'

/**
 * Scan-pattern checks (B-W2b-41; MES-075; design production.bundles "Scan-pattern checks", "Show who (one finding)").
 * Statuto dei Lavoratori (L. 300/1970) art. 4: patterns ABOUT BUNDLES, to talk about, never a score or a ranking of
 * workers. The rules are factory-domain production/bundles/patterns.ts (grouped by the place a scan came from, never by
 * a person); a finding (ScanPatternFinding) has no person column.
 *
 *   job      the scheduler's clustered cron `production.scanFindings` (hourly): per ACTIVE tenant, in its system context,
 *            per site whose checks are ON (the site names workers, its legal basis is on record and its PERFORMANCE
 *            purpose is switched on), the last `lookbackHours` of reports read, the patterns found, the new ones written
 *            in ONE command per site (the site's advisory lock: two runs never write one finding twice) with the event
 *            production.scan_findings_found. A site with its checks OFF is never read.
 *   reads    office, production.bundles.view: the panel's counts per line, operation and kind for the last 7 days (a
 *            count opens the bundles, never the people), the findings as a list (bundle, work order, operation, kind,
 *            window, what was seen) and the checks' state per site.
 *   review   production.bundles.findings: OPEN → REVIEWED or DISMISSED (a dismissal says why), with the row's version.
 *   who      production.bundles.who: the scans behind ONE finding with the workers' names, only where the checks are
 *            ON, with a purpose; ONE command writes the audit row (who looked, at which finding, why, whom it showed)
 *            and answers the names. No Idempotency-Key is kept for it (a receipt would store the names).
 *
 * The PERFORMANCE gate is read here through ONE function, `performanceOpen`, over PeopleLegalGate (a row in force:
 * switched on, not off). B-W2b-27 brings the one legal gate (modules/people/privacy/gate.ts legalGateFor /
 * requireLegalGate): at its merge `performanceOpen` becomes that call, and the review asks its assertPersonDecides.
 */

export const FINDINGS_CRON = 'production.scanFindings'
export const LEGAL_NOTE = 'Used after informing workers (L. 300/1970 art. 4). Reviewed in aggregate first. These are patterns to talk about, not scores.'

const COUNT_KINDS = ['REPORT', 'UNDO', 'CORRECTION'] as const
const MINUTE = 60_000

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

// ---- the checks' state per site -------------------------------------------------------------------------------------------

/**
 * The site's PERFORMANCE purpose is switched on now (a PeopleLegalGate row in force). The ONE place this step reads the
 * gate: B-W2b-27's legalGateFor(db, siteId, 'PERFORMANCE') replaces the body at its merge (office and system reads; the
 * floor role has no grant on the table).
 */
export async function performanceOpen(db: Reader, siteId: string, now: Date): Promise<boolean> {
  const gate = await db.peopleLegalGate.findFirst({ where: { siteId, purpose: 'PERFORMANCE', switchedOffAt: null, switchedOnAt: { lte: now } }, select: { id: true } })
  return gate !== null
}

export type ChecksState = 'ON' | 'STATION_SITE' | 'NO_BASIS' | 'GATE_CLOSED'

/** Whether a site's scan-pattern checks run, and why not (the panel's state). */
export async function checksStateOf(db: Reader, siteId: string, now: Date): Promise<{ state: ChecksState; words: string | null }> {
  const settings = await db.productionSettings.findUnique({ where: { id: siteId }, select: { scanSubject: true, monitoringBasis: true } })
  const refusal = whoRefusal({ scanSubject: settings?.scanSubject ?? 'WORKER', basisRecorded: !!settings?.monitoringBasis, performanceOpen: await performanceOpen(db, siteId, now) })
  return refusal ? { state: refusal.code, words: refusal.message } : { state: 'ON', words: null }
}

// ---- the job ----------------------------------------------------------------------------------------------------------------

export interface FindingsOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface FindingsRun {
  readonly tenants: number
  readonly sites: number
  readonly written: number
  readonly failed: number
}

/** What one site's pass found: the patterns over the look-back window that are not stored yet. */
export async function detectFindings(db: Reader, siteId: string, now: Date): Promise<FoundPattern[]> {
  const from = new Date(now.getTime() - PATTERN_RULES.lookbackHours * 60 * MINUTE)
  const window = await db.operationScan.findMany({
    where: { siteId, kind: 'REPORT', serverTime: { gte: from, lte: now } },
    select: { bundleId: true },
    distinct: ['bundleId'],
  })
  const bundleIds = window.map((row) => row.bundleId)
  if (bundleIds.length === 0) return []
  // Every count row of those bundles (all time): the standing reports, and which reports were undone or corrected.
  const counts = await db.operationScan.findMany({
    where: { bundleId: { in: bundleIds }, kind: { in: [...COUNT_KINDS] } },
    select: { id: true, bundleId: true, workOrderId: true, workOrderOperationId: true, kind: true, correctsId: true, stationId: true, deviceId: true, serverTime: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true },
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })
  const voided = new Set(counts.flatMap((scan) => (scan.correctsId ? [scan.correctsId] : [])))
  const standing = counts.filter((scan) => scan.kind !== 'UNDO' && !voided.has(scan.id))
  const stations = await stationsOf(db, counts.map((scan) => scan.stationId))
  const reports: PatternScan[] = standing
    .filter((scan) => scan.kind === 'REPORT' && scan.serverTime >= from)
    .map((scan) => ({
      id: scan.id,
      bundleId: scan.bundleId,
      workOrderId: scan.workOrderId,
      operationId: scan.workOrderOperationId,
      placeKey: scan.stationId ? `station:${scan.stationId}` : `device:${scan.deviceId ?? 'none'}`,
      lineId: scan.stationId ? (stations.get(scan.stationId)?.lineId ?? null) : null,
      at: scan.serverTime,
      pieces: scan.goodQuantity + scan.scrapQuantity + scan.reworkQuantity,
    }))
  const bundles = await db.bundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, workOrderId: true, quantity: true, createdAt: true } })
  const operations = await operationsOf(db, [...new Set(bundles.map((bundle) => bundle.workOrderId))])
  const operationById = new Map(operations.map((operation) => [operation.id, operation]))
  const quantity = new Map(bundles.map((bundle) => [bundle.id, bundle.quantity]))
  // The ends of the site's shifts in the window whose bunching window is over.
  const calendar = (await workingCalendarFor(db as Prisma.TransactionClient, { scope: 'SITE', id: siteId }, { from: plusDays(businessDate(from, 'UTC'), -2), to: plusDays(businessDate(now, 'UTC'), 1) })).calendar
  const ends = daysOf(calendar, plusDays(businessDate(from, calendar.timeZone), -1), businessDate(now, calendar.timeZone))
    .flatMap((day) => day.shifts.map((shift) => shift.end))
    .filter((end) => end >= from && end.getTime() + PATTERN_RULES.shiftEndMinutes * MINUTE <= now.getTime())
  const found = [
    ...bunchedAtShiftEnd(reports, ends),
    ...movedNotScanned(
      bundles.map((bundle) => ({
        bundleId: bundle.id,
        workOrderId: bundle.workOrderId,
        createdAt: bundle.createdAt,
        standing: standing.filter((scan) => scan.bundleId === bundle.id).map((scan) => ({ operationId: scan.workOrderOperationId, at: scan.serverTime, lineId: scan.stationId ? (stations.get(scan.stationId)?.lineId ?? null) : null })),
      })),
      (workOrderId) => operations.filter((operation) => operation.workOrderId === workOrderId),
    ),
    ...gapBelowStandard(reports, (id) => operationById.get(id), (id) => quantity.get(id) ?? 0),
  ]
  const stored = await db.scanPatternFinding.findMany({ where: { bundleId: { in: bundleIds } }, select: { kind: true, bundleId: true, workOrderOperationId: true, windowStart: true } })
  return newFindings(found, new Set(stored.map((row) => findingKey({ kind: row.kind, bundleId: row.bundleId, operationId: row.workOrderOperationId, windowStart: row.windowStart }))))
}

async function writeSite(caller: CommandCaller, tenantId: string, siteId: string, clock: Clock): Promise<number> {
  const { result } = await runCommand(
    caller,
    { name: 'production.findScanPatterns', input: { siteId } },
    async (tools) => {
      // One pass per site at a time: the second one waits and finds nothing left to write.
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-findings', ${tenantId}::uuid, ${siteId}::uuid), 0))`
      const site = await tools.tx.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })
      if (!site || (await checksStateOf(tools.tx, siteId, tools.now)).state !== 'ON') return []
      const found = await detectFindings(tools.tx, siteId, tools.now)
      if (found.length === 0) return []
      const rows = found.map((finding) => ({
        id: newId(),
        siteId,
        workOrderId: finding.workOrderId,
        bundleId: finding.bundleId,
        workOrderOperationId: finding.operationId,
        kind: finding.kind,
        windowStart: finding.windowStart,
        windowEnd: finding.windowEnd,
        detail: finding.detail as Prisma.InputJsonValue,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: null,
      }))
      await tools.tx.scanPatternFinding.createMany({ data: rows })
      const kindCount = (kind: ScanPatternKind) => rows.filter((row) => row.kind === kind).length
      const counts = { bunched: kindCount('BUNCHED_AT_SHIFT_END'), movedNotScanned: kindCount('MOVED_NOT_SCANNED'), gapBelowStandard: kindCount('GAP_BELOW_STANDARD') }
      tools.audit({ recordType: 'Site', recordId: siteId, companyId: site.companyId, siteId, after: { findings: rows.length, ...counts } })
      tools.emit({ type: 'production.scan_findings_found', subject: siteId, companyId: site.companyId, siteId, payload: { siteId, findingIds: rows.map((row) => row.id), ...counts } })
      return rows.map((row) => row.id)
    },
    { ...COMMAND_SETTINGS, clock },
  )
  return result.length
}

/** One pass over every active tenant and its sites (the cron's tick; tests call it directly). */
export async function runScanFindings(options: FindingsOptions): Promise<FindingsRun> {
  const clock = options.clock ?? serverClock
  const requestId = `scan-findings-${newId()}`
  const totals = { sites: 0, written: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const now = clock.now()
    // Only the sites whose checks are ON are read at all (named workers, the basis on record, PERFORMANCE switched on).
    const sites = await caller.withClient(async (db) => {
      const all = await db.productionSettings.findMany({ where: { scanSubject: 'WORKER', monitoringBasis: { not: null } }, select: { id: true } })
      const on: string[] = []
      for (const row of all) if (await performanceOpen(db, row.id, now)) on.push(row.id)
      return on
    })
    for (const siteId of sites) {
      totals.sites += 1
      try {
        totals.written += await writeSite(caller, tenantId, siteId, clock)
      } catch (error) {
        totals.failed += 1
        options.log.error({ err: error, tenantId, siteId }, 'the scan-pattern checks of a site failed')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.written > 0 || run.failed > 0) options.log.info({ ...run }, 'scan-pattern checks')
  return run
}

// ---- reads ------------------------------------------------------------------------------------------------------------------

/** The findings the caller may read with `permission`, through their bundle's work order's company and site. */
function findingScope(context: OfficeContext, permission: Permission = PRODUCTION_BUNDLES_VIEW): Prisma.ScanPatternFindingWhereInput {
  return { bundle: { is: { workOrder: { is: scopeWhere(actorOf(context), permission, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput } } } }
}

const FINDING_COLUMNS = { id: true, siteId: true, workOrderId: true, bundleId: true, workOrderOperationId: true, kind: true, windowStart: true, windowEnd: true, detail: true, status: true, reviewedAt: true, reviewNote: true, version: true, createdAt: true } as const
type FindingRow = Prisma.ScanPatternFindingGetPayload<{ select: typeof FINDING_COLUMNS }>

const lineOf = (row: Pick<FindingRow, 'detail'>): string | null => {
  const detail = row.detail as Record<string, unknown> | null
  return detail && typeof detail.lineId === 'string' ? detail.lineId : null
}

async function findingViews(db: Reader, rows: readonly FindingRow[]) {
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.bundleId))] } }, select: { id: true, code: true, quantity: true, part: true } })).map((row) => [row.id, row]))
  const workOrders = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workOrderId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
  const operationIds = [...new Set(rows.flatMap((row) => (row.workOrderOperationId ? [row.workOrderOperationId] : [])))]
  const operations = new Map((operationIds.length ? await db.workOrderOperation.findMany({ where: { id: { in: operationIds } }, select: { id: true, seq: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  const lineIds = [...new Set(rows.flatMap((row) => (lineOf(row) ? [lineOf(row)!] : [])))]
  const lines = new Map((lineIds.length ? await db.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  return rows.map((row) => {
    const { lineId: _line, ...seen } = (row.detail ?? {}) as Record<string, unknown>
    return {
      id: row.id,
      siteId: row.siteId,
      kind: row.kind,
      status: row.status,
      bundle: { id: row.bundleId, code: bundles.get(row.bundleId)?.code ?? '', quantity: bundles.get(row.bundleId)?.quantity ?? 0, part: bundles.get(row.bundleId)?.part ?? null },
      workOrder: { id: row.workOrderId, number: workOrders.get(row.workOrderId)?.number ?? '' },
      operation: row.workOrderOperationId && operations.get(row.workOrderOperationId) ? operations.get(row.workOrderOperationId)! : null,
      line: lineOf(row) && lines.get(lineOf(row)!) ? lines.get(lineOf(row)!)! : null,
      windowStart: toUtcIso(row.windowStart),
      windowEnd: toUtcIso(row.windowEnd),
      /** What was seen: counts and times only. */
      seen: seen as Record<string, number | string | null>,
      reviewedAt: row.reviewedAt ? toUtcIso(row.reviewedAt) : null,
      reviewNote: row.reviewNote,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}

/** GET /production/bundles/findings/summary: the checks' state per site and the counts per line, operation and kind (7 days). */
export async function findingsSummary(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly days?: number | undefined }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const days = query.days ?? PATTERN_RULES.summaryDays
  return caller.withClient(async (db) => {
    const sites = await db.site.findMany({
      where: { AND: [scopeWhere(actorOf(context), PRODUCTION_BUNDLES_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.siteId ? { id: query.siteId } : {}] },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    })
    const states = []
    for (const site of sites) states.push({ site, ...(await checksStateOf(db, site.id, now)) })
    const rows = await db.scanPatternFinding.findMany({
      where: { AND: [findingScope(context), query.siteId ? { siteId: query.siteId } : {}, { createdAt: { gte: new Date(now.getTime() - days * 24 * 60 * MINUTE) } }] },
      select: { kind: true, status: true, detail: true, workOrderOperationId: true },
    })
    const operationIds = [...new Set(rows.flatMap((row) => (row.workOrderOperationId ? [row.workOrderOperationId] : [])))]
    const codes = new Map((operationIds.length ? await db.workOrderOperation.findMany({ where: { id: { in: operationIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
    const summary = summarise(rows.map((row) => ({ kind: row.kind, status: row.status, lineId: lineOf(row), operationCode: row.workOrderOperationId ? (codes.get(row.workOrderOperationId)?.code ?? null) : null })))
    const lineIds = [...new Set(summary.flatMap((row) => (row.lineId ? [row.lineId] : [])))]
    const lines = new Map((lineIds.length ? await db.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
    const names = new Map([...codes.values()].map((row) => [row.code, row.name]))
    return {
      legalNote: LEGAL_NOTE,
      days,
      sites: states.map((state) => ({ id: state.site.id, code: state.site.code, name: state.site.name, checks: state.state, words: state.words })),
      rows: summary.map((row) => ({ line: row.lineId ? (lines.get(row.lineId) ?? null) : null, operation: row.operationCode ? { code: row.operationCode, name: names.get(row.operationCode) ?? '' } : null, kind: row.kind, open: row.open, reviewed: row.reviewed, dismissed: row.dismissed })),
      asOf: toUtcIso(now),
    }
  })
}

export interface FindingsQuery {
  readonly siteId?: string | undefined
  readonly bundleId?: string | undefined
  readonly kind?: ScanPatternKind | undefined
  readonly status?: FindingStatus | undefined
  readonly lineId?: string | undefined
  readonly operationCode?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** GET /production/bundles/findings: the findings (the bundles behind a count), newest first, in pages; never a person. */
export async function listFindings(caller: CommandCaller, query: FindingsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const where: Prisma.ScanPatternFindingWhereInput = {
      AND: [
        findingScope(context),
        query.siteId ? { siteId: query.siteId } : {},
        query.bundleId ? { bundleId: query.bundleId } : {},
        query.kind ? { kind: query.kind } : {},
        query.status ? { status: query.status } : {},
        query.lineId ? { detail: { path: ['lineId'], equals: query.lineId } } : {},
        query.operationCode ? { operation: { is: { code: query.operationCode } } } : {},
        query.cursor ? { id: { lt: query.cursor } } : {},
      ],
    }
    const rows = await db.scanPatternFinding.findMany({ where, select: FINDING_COLUMNS, orderBy: { id: 'desc' }, take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    return { findings: await findingViews(db, page), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

async function namedFinding(caller: CommandCaller, findingId: string, permission: Permission = PRODUCTION_BUNDLES_VIEW) {
  const context = officeOf(caller)
  const row = isUuid(findingId) ? await caller.withClient((db) => db.scanPatternFinding.findFirst({ where: { AND: [{ id: findingId }, findingScope(context)] }, select: FINDING_COLUMNS })) : null
  if (!row) throw new NotFoundError('Finding not found.')
  const workOrder = (await caller.withClient((db) => db.workOrder.findUnique({ where: { id: row.workOrderId }, select: { companyId: true, siteId: true } })))!
  if (!can(actorOf(context), permission, { companyId: workOrder.companyId, siteId: workOrder.siteId })) throw new ForbiddenError()
  return { context, row, scope: workOrder }
}

// ---- review -----------------------------------------------------------------------------------------------------------------

/** POST /production/bundles/findings/:findingId/review: OPEN → REVIEWED or DISMISSED (a dismissal says why). */
export async function reviewFinding(caller: CommandCaller, findingId: string, body: { readonly status: 'REVIEWED' | 'DISMISSED'; readonly note?: string | undefined; readonly version?: number | undefined }, idempotencyKey?: string) {
  const { context, row, scope } = await namedFinding(caller, findingId, PRODUCTION_BUNDLES_FINDINGS)
  const problems = reviewProblems(body.status, body.note)
  if (problems.length > 0) throw new ValidationError(problems[0]!, [{ path: 'body/note', message: problems[0]! }])
  if (row.status !== 'OPEN') throw new InvalidStateError(`This finding was ${row.status.toLowerCase()} already; it is final.`)
  const note = body.note?.trim() || null
  const { result } = await command(caller, { name: 'production.reviewScanFinding', idempotencyKey, input: { findingId, ...body }, record: { type: 'ScanPatternFinding' as const, id: row.id, expectedVersion: body.version } }, async (tools) => {
    // B-W2b-27 at its merge: assertPersonDecides(tools.context, …) — a person, never a rule, reviews a finding.
    const fresh = (await tools.tx.scanPatternFinding.findUnique({ where: { id: row.id }, select: { status: true } }))!
    if (fresh.status !== 'OPEN') throw new InvalidStateError(`This finding was ${fresh.status.toLowerCase()} already; it is final.`)
    await tools.tx.scanPatternFinding.update({ where: { id: row.id }, data: { status: body.status, reviewedAt: tools.now, reviewedById: context.actorId, reviewNote: note }, select: { id: true } })
    tools.audit({ recordType: 'ScanPatternFinding', recordId: row.id, companyId: scope.companyId, siteId: scope.siteId, before: { status: 'OPEN' }, after: { status: body.status }, ...(note ? { reason: note } : {}) })
    tools.emit({ type: 'production.scan_finding_reviewed', subject: row.id, companyId: scope.companyId, siteId: scope.siteId, payload: { findingId: row.id, siteId: row.siteId, bundleId: row.bundleId, status: body.status } })
    const [view] = await findingViews(tools.tx, [(await tools.tx.scanPatternFinding.findUnique({ where: { id: row.id }, select: FINDING_COLUMNS }))!])
    return { finding: view! }
  })
  return result
}

// ---- "Show who" (one finding) ---------------------------------------------------------------------------------------------

/** The refusal of "Show who" as a 409 whose issue path names the state (`gate/PERFORMANCE` for a closed purpose). */
class WhoHeldError extends InvalidStateError {
  override readonly issues
  constructor(code: string, message: string) {
    super(message)
    this.issues = [{ path: code === 'GATE_CLOSED' ? 'gate/PERFORMANCE' : `who/${code}`, message }]
  }
}

/**
 * POST /production/bundles/findings/:findingId/who: the scans of the finding's bundle (at its operation) in its window,
 * with the workers' names, for ONE finding, with a purpose; the audit row says who looked, why and whom it showed.
 */
export async function showWho(caller: CommandCaller, findingId: string, body: { readonly purpose: WhoPurpose; readonly note?: string | undefined }) {
  const { row, scope } = await namedFinding(caller, findingId, PRODUCTION_BUNDLES_WHO)
  const now = serverClock.now()
  const state = await caller.withClient((db) => checksStateOf(db, row.siteId, now))
  if (state.state !== 'ON') throw new WhoHeldError(state.state, state.words!)
  const note = body.note?.trim() || null
  const { result } = await command(caller, { name: 'production.showFindingWho', input: { findingId, purpose: body.purpose, note } }, async (tools) => {
    const again = await checksStateOf(tools.tx, row.siteId, tools.now)
    if (again.state !== 'ON') throw new WhoHeldError(again.state, again.words!)
    const scans = await readWindowScans(tools.tx, row)
    const workers = new Map((await tools.tx.worker.findMany({ where: { id: { in: [...new Set(scans.flatMap((scan) => (scan.workerId ? [scan.workerId] : [])))] } }, select: { id: true, displayName: true } })).map((worker) => [worker.id, worker.displayName]))
    const stations = await stationsOf(tools.tx, scans.map((scan) => scan.stationId))
    const operations = new Map((await tools.tx.workOrderOperation.findMany({ where: { workOrderId: row.workOrderId }, select: { id: true, seq: true, code: true, name: true } })).map((operation) => [operation.id, operation]))
    tools.audit({
      recordType: 'ScanPatternFinding',
      recordId: row.id,
      companyId: scope.companyId,
      siteId: scope.siteId,
      after: { purpose: body.purpose, shown: scans.length, workerIds: [...workers.keys()].sort() },
      reason: note ? `${body.purpose}: ${note}` : body.purpose,
    })
    return {
      finding: { id: row.id, kind: row.kind, windowStart: toUtcIso(row.windowStart), windowEnd: toUtcIso(row.windowEnd) },
      purpose: body.purpose,
      logged: true as const,
      scans: scans.map((scan) => ({
        id: scan.id,
        kind: scan.kind,
        at: toUtcIso(scan.serverTime),
        operation: operations.get(scan.workOrderOperationId) ?? null,
        good: scan.goodQuantity,
        scrap: scan.scrapQuantity,
        rework: scan.reworkQuantity,
        worker: scan.workerId ? { id: scan.workerId, name: workers.get(scan.workerId) ?? '' } : null,
        station: scan.stationId && stations.get(scan.stationId) ? { id: scan.stationId, code: stations.get(scan.stationId)!.code, name: stations.get(scan.stationId)!.name } : null,
      })),
    }
  })
  return result
}

/** The finding's bundle's count scans in its window (at its operation when it names one), oldest first. */
async function readWindowScans(tx: CommandTx, row: FindingRow) {
  return tx.operationScan.findMany({
    where: { bundleId: row.bundleId, kind: { in: [...COUNT_KINDS] }, serverTime: { gte: row.windowStart, lte: row.windowEnd }, ...(row.workOrderOperationId ? { workOrderOperationId: row.workOrderOperationId } : {}) },
    select: { id: true, kind: true, workOrderOperationId: true, workerId: true, stationId: true, serverTime: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true },
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })
}
