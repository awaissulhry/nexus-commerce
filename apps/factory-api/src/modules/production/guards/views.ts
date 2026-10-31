import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import {
  componentsAsked,
  guardFindings,
  OVERRIDABLE_REFUSALS,
  OVERRIDE_REASONS,
  passedTo,
  type GuardKind,
} from '@nexus/factory-domain/production/guards/rules'
import { PRODUCTION_SCAN, PRODUCTION_SCAN_CORRECT } from '@nexus/factory-domain/production/scans/permissions'
import { operationFor, operationLabel, standingKey, standingScans, type ScanOperation, type ScanRefusalCode } from '@nexus/factory-domain/production/scans/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { bundleFlowOf } from '../bundles/flow'
import { readBundleByCode } from '../bundles/store'
import { floorOrOffice, mayScan, officeOf, scanWorkOrder } from '../scans/access'
import { deviceStationOf, readBundleScans, readHeader, readOperations, readScan, readStations, workerNames } from '../scans/store'
import { componentFacts, FLAGGED_ACTION, guardRows, guardRowsOfScan, guardSettingsFor, lineFacts, OVERRIDDEN_ACTION, tracedOfLot, tracedOfWorkOrder, TRACED_ACTION, type GuardAuditRow } from './store'

/**
 * The checks' reads (B-W2b-46):
 *   check       a bundle at an operation as the operation screen opens it (floor and office): the site's rules, what
 *               reached the operation, the skipped operations, what holds it or warns already (the line, a late report
 *               of a skipped operation), the components it asks and the override's reason tiles.
 *   flags       the reports of a site's day that met a check (WARN: told; or a team leader's override), per bundle and
 *               operation, the station, never a person; a skipped operation reported since counts as settled.
 *   flag        one report's checks: the words, the override (the team leader by name, the reason), the scan's worker
 *               by name where the site names workers (one record).
 *   components  the lots traced on a work order's scans; and where one lot went (EN 1621 recall).
 */

type Json = Prisma.JsonValue
const objectOf = (value: Json): Record<string, Json> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Json>) : {})
const arrayOf = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : [])
const text = (value: Json | undefined): string | null => (typeof value === 'string' ? value : null)
const count = (value: Json | undefined): number => (typeof value === 'number' ? value : 0)

const overridable = (code: ScanRefusalCode): boolean => (OVERRIDABLE_REFUSALS as readonly string[]).includes(code)

// ---- the check of a bundle at an operation ----------------------------------------------------------------------------------------

export async function checkBundle(caller: CommandCaller, query: { readonly code: string; readonly workOrderOperationId?: string | undefined; readonly good?: number | undefined; readonly scrap?: number | undefined; readonly rework?: number | undefined }) {
  const context = floorOrOffice(caller)
  const typed = query.code.trim().toUpperCase()
  const scan = parseScanId(typed, { tenantTag: tenantTag(context.tenantId), types: ['BUNDLE'] })
  if (!scan.ok && scan.problem !== 'format') throw new ValidationError(scan.message, [{ path: 'querystring/code', message: scan.message }])
  return caller.withClient(async (db) => {
    const bundle = await readBundleByCode(db, scan.ok ? scan.text : typed)
    const workOrder = bundle ? await readHeader(db, bundle.workOrderId) : null
    if (!bundle || !workOrder || !mayScan(context, PRODUCTION_SCAN, workOrder)) throw new NotFoundError('Not a bundle ticket of this site: scan the bundle’s ticket.')
    const operations = await readOperations(db, workOrder.id)
    const scans = await readBundleScans(db, bundle.id)
    const flow = await bundleFlowOf(db, bundle, operations, standingScans(scans))
    const stationId = context.audience === 'floor' ? await deviceStationOf(db, context.deviceId) : null
    const station = stationId ? ((await readStations(db, [stationId])).get(stationId) ?? null) : null
    const settings = await guardSettingsFor(db, workOrder.siteId)
    const base = { bundle: { id: bundle.id, code: bundle.code, quantity: flow.quantity }, modes: settings, overrideReasons: OVERRIDE_REASONS.map((reason) => ({ code: reason.code, label: { ...reason.label }, needsNote: reason.needsNote })) }

    let operation: ScanOperation | undefined = query.workOrderOperationId ? operations.find((candidate) => candidate.id === query.workOrderOperationId) : undefined
    if (query.workOrderOperationId && !operation) throw new NotFoundError('Not an operation of this bundle’s work order.')
    if (!operation) {
      const next = operationFor({ operations, station: station ? { code: station.code, kind: station.kind } : null, standing: flow.standing, bundleId: bundle.id, bundle: { ...bundle, quantity: flow.quantity } })
      if (!next.ok) return { ...base, operation: null, hint: { code: next.refusal.code, message: next.refusal.message, fix: next.refusal.fix }, expected: null, beyondBundle: false, skipped: [], findings: [], components: { asked: [], traceable: [] } }
      operation = next.operation
    }
    const reported = flow.standing.has(standingKey(bundle.id, operation.id))
    const lines = await lineFacts(db, { stationId, workOrderId: workOrder.id, kind: operation.workCentreKind })
    // The counts typed, or the usual report (all good of what reached it): what holds or warns before Finish.
    const reached = passedTo(operations, operation, flow.quantity, flow.standing, bundle.id)
    const padded = query.good !== undefined || query.scrap !== undefined || query.rework !== undefined
    const counts = padded ? { good: query.good ?? 0, scrap: query.scrap ?? 0, rework: query.rework ?? 0 } : { good: reached.passed, scrap: 0, rework: 0 }
    const result = guardFindings({ operations, operation, bundleId: bundle.id, bundle: { code: bundle.code, quantity: flow.quantity }, workOrder, standing: flow.standing, counts, settings, lines })
    const beyondBundle = counts.good + counts.scrap + counts.rework > flow.quantity
    const facts = await componentFacts(db, { styleId: workOrder.styleId, workOrderId: workOrder.id, workOrderSizeId: bundle.workOrderSizeId })
    const asked = componentsAsked({ operations, operation, garmentTracking: facts.garmentTracking, materials: facts.materials })
    return {
      ...base,
      operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, reported },
      hint: null,
      expected: result.cap,
      beyondBundle,
      skipped: result.passed.skipped.map((entry) => ({ id: entry.id, seq: entry.seq, name: entry.name })),
      findings: result.findings.map((finding) => ({ kind: finding.kind, mode: finding.mode, code: finding.refusal.code, message: finding.refusal.message, fix: finding.refusal.fix, overridable: !beyondBundle && finding.mode === 'STRICT' && overridable(finding.refusal.code) })),
      components: {
        asked: asked.map((material) => ({ itemId: material.itemId, code: material.code, name: material.name })),
        traceable: facts.materials.filter((material) => material.tracking === 'LOT').map((material) => ({ itemId: material.itemId, code: material.code, name: material.name, asked: asked.some((entry) => entry.itemId === material.itemId) })),
      },
    }
  })
}

// ---- the flags of a site's day -------------------------------------------------------------------------------------------------------

interface FlagFacts {
  readonly bundleId: string
  readonly workOrderId: string
  readonly operationId: string
  readonly stationId: string | null
  readonly guards: readonly { readonly kind: GuardKind; readonly code: string; readonly message: string; readonly mode: string; readonly detail: Record<string, Json> }[]
}

function flagFacts(row: GuardAuditRow): FlagFacts {
  const after = objectOf(row.after)
  return {
    bundleId: text(after.bundleId) ?? '',
    workOrderId: text(after.workOrderId) ?? '',
    operationId: text(after.operationId) ?? '',
    stationId: text(after.stationId),
    guards: arrayOf(after.guards).map((entry) => {
      const guard = objectOf(entry)
      return { kind: (text(guard.kind) ?? 'QUANTITY') as GuardKind, code: text(guard.code) ?? '', message: text(guard.message) ?? '', mode: text(guard.mode) ?? '', detail: objectOf(guard.detail ?? null) }
    }),
  }
}

/** How many of the skipped operations a flag named still have no standing report for its bundle (0: settled by itself). */
function stillSkipped(facts: FlagFacts, standing: ReadonlyMap<string, unknown>): number {
  const skipped = facts.guards.filter((guard) => guard.kind === 'SKIPPED_OPERATION').flatMap((guard) => arrayOf(guard.detail.skippedOperationIds).map((value) => String(value)))
  return skipped.filter((operationId) => !standing.has(standingKey(facts.bundleId, operationId))).length
}

export async function listFlags(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly date?: string | undefined; readonly kind?: 'WARNED' | 'OVERRIDDEN' | undefined; readonly guard?: GuardKind | undefined; readonly limit: number }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const sites = await db.site.findMany({ where: { AND: [scopeWhere(actorOf(context), PRODUCTION_SCAN_CORRECT, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.siteId ? { id: query.siteId } : {}] }, select: { id: true, timezone: true } })
    if (sites.length === 0) return { date: query.date ?? null, flags: [] }
    const actions = query.kind === 'WARNED' ? [FLAGGED_ACTION] : query.kind === 'OVERRIDDEN' ? [OVERRIDDEN_ACTION] : [FLAGGED_ACTION, OVERRIDDEN_ACTION]
    const rows: GuardAuditRow[] = []
    // A site's day on its own wall clock.
    for (const site of sites) {
      const day = (query.date ?? businessDate(serverClock.now(), site.timezone)) as BusinessDate
      const { start, end } = businessDayRange(day, site.timezone)
      rows.push(...(await guardRows(db, { siteIds: [site.id], from: start, to: end, actions }, query.limit)))
    }
    rows.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
    const facts = rows.map((row) => ({ row, facts: flagFacts(row) })).filter((entry) => !query.guard || entry.facts.guards.some((guard) => guard.kind === query.guard)).slice(0, query.limit)
    const bundleIds = [...new Set(facts.map((entry) => entry.facts.bundleId).filter(isUuid))]
    const workOrderIds = [...new Set(facts.map((entry) => entry.facts.workOrderId).filter(isUuid))]
    const bundles = new Map((bundleIds.length > 0 ? await db.bundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
    const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
    const operations = new Map((workOrderIds.length > 0 ? await db.workOrderOperation.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, seq: true, name: true } }) : []).map((row) => [row.id, row]))
    const stations = await readStations(db, facts.map((entry) => entry.facts.stationId))
    const standing = standingScans(bundleIds.length > 0 ? ((await db.operationScan.findMany({ where: { bundleId: { in: bundleIds }, kind: { in: ['REPORT', 'UNDO', 'CORRECTION'] } }, select: { id: true, kind: true, bundleId: true, workOrderOperationId: true, correctsId: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true, workerId: true, stationId: true, deviceId: true, clientScanId: true, deviceTime: true, serverTime: true }, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })) as Parameters<typeof standingScans>[0]) : [])
    return {
      date: query.date ?? null,
      flags: facts.map(({ row, facts: flag }) => {
        const operation = operations.get(flag.operationId)
        const station = flag.stationId ? stations.get(flag.stationId) : undefined
        return {
          scanId: row.recordId,
          at: toUtcIso(row.at),
          siteId: row.siteId,
          kind: row.action === OVERRIDDEN_ACTION ? ('OVERRIDDEN' as const) : ('WARNED' as const),
          guards: [...new Set(flag.guards.map((guard) => guard.kind))].sort(),
          workOrder: { id: flag.workOrderId, number: workOrders.get(flag.workOrderId) ?? '' },
          bundle: { id: flag.bundleId, code: bundles.get(flag.bundleId) ?? '' },
          operation: { id: flag.operationId, seq: operation?.seq ?? 0, name: operation?.name ?? '' },
          station: station ? { id: station.id, code: station.code } : null,
          stillSkipped: stillSkipped(flag, standing),
        }
      }),
    }
  })
}

/** One report's checks (one record: the team leader who overrode and the scan's worker, by name where the site names workers). */
export async function flagOf(caller: CommandCaller, scanId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const scan = await readScan(db, scanId)
    const workOrder = scan ? await readHeader(db, scan.workOrderId) : null
    if (!scan || !workOrder || !mayScan(context, PRODUCTION_SCAN_CORRECT, workOrder)) throw new NotFoundError('Scan not found.')
    const rows = await guardRowsOfScan(db, scan.id)
    const flagged = rows.find((row) => row.action === FLAGGED_ACTION) ?? null
    const overridden = rows.find((row) => row.action === OVERRIDDEN_ACTION) ?? null
    const traced = rows.find((row) => row.action === TRACED_ACTION) ?? null
    if (!flagged && !overridden && !traced) throw new NotFoundError('This scan met no check.')
    const lead = overridden ? text(objectOf(overridden.after).leadWorkerId) : null
    const names = await workerNames(db, [scan.workerId, lead])
    const operations = await readOperations(db, workOrder.id)
    const operation = operations.find((row) => row.id === scan.workOrderOperationId)
    const bundle = await db.bundle.findUnique({ where: { id: scan.bundleId }, select: { code: true } })
    const station = scan.stationId ? (await readStations(db, [scan.stationId])).get(scan.stationId) : undefined
    const guards = (row: GuardAuditRow | null) => (row ? flagFacts(row).guards.map((guard) => ({ kind: guard.kind, mode: guard.mode, code: guard.code, message: guard.message })) : [])
    return {
      flag: {
        scanId: scan.id,
        at: toUtcIso(scan.serverTime),
        workOrder: { id: workOrder.id, number: workOrder.number },
        bundle: { id: scan.bundleId, code: bundle?.code ?? '' },
        operation: { id: scan.workOrderOperationId, seq: operation?.seq ?? 0, name: operation ? operationLabel(operation) : '' },
        counts: { good: scan.goodQuantity, scrap: scan.scrapQuantity, rework: scan.reworkQuantity },
        station: station ? { id: station.id, code: station.code } : null,
        worker: scan.workerId ? { id: scan.workerId, name: names.get(scan.workerId) ?? '' } : null,
        warned: guards(flagged),
        overridden: overridden
          ? { guards: guards(overridden), lead: lead ? { id: lead, name: names.get(lead) ?? '' } : null, reasonCode: text(objectOf(overridden.after).reasonCode) ?? '', reason: overridden.reason ?? '', note: text(objectOf(overridden.after).note) }
          : null,
        components: traced ? componentLines(traced) : [],
      },
    }
  })
}

// ---- components ------------------------------------------------------------------------------------------------------------------------

function componentLines(row: GuardAuditRow) {
  return arrayOf(objectOf(row.after).components).map((entry) => {
    const line = objectOf(entry)
    return { itemId: text(line.itemId) ?? '', itemCode: text(line.itemCode) ?? '', lotId: text(line.lotId) ?? '', lotCode: text(line.lotCode) ?? '', garments: count(line.garments) }
  })
}

/** The lots traced on a work order's scans, per scan (bundle and operation), oldest first. */
export async function workOrderComponents(caller: CommandCaller, workOrderId: string) {
  const workOrder = await scanWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  return caller.withClient(async (db) => {
    const rows = await tracedOfWorkOrder(db, workOrder.id)
    const operations = new Map((await readOperations(db, workOrder.id)).map((row) => [row.id, row]))
    const bundleIds = [...new Set(rows.map((row) => text(objectOf(row.after).bundleId)).filter((value): value is string => !!value && isUuid(value)))]
    const bundles = new Map((bundleIds.length > 0 ? await db.bundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
    return {
      workOrder: { id: workOrder.id, number: workOrder.number },
      traced: rows.map((row) => {
        const after = objectOf(row.after)
        const operation = operations.get(text(after.operationId) ?? '')
        return { scanId: text(after.scanId) ?? '', at: toUtcIso(row.at), bundle: { id: text(after.bundleId) ?? '', code: bundles.get(text(after.bundleId) ?? '') ?? '' }, operation: { id: operation?.id ?? '', seq: operation?.seq ?? 0, name: operation?.name ?? '' }, garments: count(after.garments), components: componentLines(row) }
      }),
    }
  })
}

/** Where one lot went (a recall, EN 1621): the work orders, bundles and operations whose garments carry it, and how many. */
export async function lotGarments(caller: CommandCaller, lotId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const lot = isUuid(lotId) ? await db.lot.findUnique({ where: { id: lotId }, select: { id: true, code: true, companyId: true, siteId: true, itemId: true } }) : null
    if (!lot || !mayScan(context, WORKORDERS_VIEW, { companyId: lot.companyId, siteId: lot.siteId })) throw new NotFoundError('Lot not found.')
    const rows = await tracedOfLot(db, lot.id)
    const workOrderIds = [...new Set(rows.map((row) => row.recordId))]
    const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, companyId: true, siteId: true } }) : []).map((row) => [row.id, row]))
    const bundleIds = [...new Set(rows.map((row) => text(objectOf(row.after).bundleId)).filter((value): value is string => !!value && isUuid(value)))]
    const bundles = new Map((bundleIds.length > 0 ? await db.bundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
    const operations = new Map((workOrderIds.length > 0 ? await db.workOrderOperation.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, seq: true, name: true } }) : []).map((row) => [row.id, row]))
    const uses = rows.flatMap((row) => {
      const workOrder = workOrders.get(row.recordId)
      if (!workOrder || !mayScan(context, WORKORDERS_VIEW, workOrder)) return []
      const after = objectOf(row.after)
      const operation = operations.get(text(after.operationId) ?? '')
      const garments = componentLines(row).filter((line) => line.lotId === lot.id).reduce((sum, line) => sum + line.garments, 0)
      return [{ at: toUtcIso(row.at), workOrder: { id: workOrder.id, number: workOrder.number }, bundle: { id: text(after.bundleId) ?? '', code: bundles.get(text(after.bundleId) ?? '') ?? '' }, operation: { id: operation?.id ?? '', seq: operation?.seq ?? 0, name: operation?.name ?? '' }, scanId: text(after.scanId) ?? '', garments }]
    })
    return { lot: { id: lot.id, code: lot.code, itemId: lot.itemId }, garments: uses.reduce((sum, use) => sum + use.garments, 0), uses }
  })
}
