import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_LABOUR_VIEW } from '@nexus/factory-domain/production/labour/permissions'
import { readDisputeMessage, reportOf, type LabourRecord } from '@nexus/factory-domain/production/labour/rules'
import type { CommandCaller } from '../../../core/command'
import { legalGateFor, type GateReader } from '../../people/privacy/gate'
import { officeOf, reaches } from './access'
import { bundlesById, chainsOf, COUNT_KINDS, devicesById, linesById, peopleNames, recordsFor, SCAN, sitesById, stationsById, toLabourScan, workOrdersById, type OperationRow, type Reader } from './store'

/**
 * One labour record (B-W2b-45; MES-201 "a labour record per scan with its minutes"; design production.labour "Correction
 * request": "the original entry (unchanged) · the proposed correcting entry · reason · the scans around it", "nobody edits
 * an old scan, every change is a new row"): a REPORT a bundle got at an operation, what stands of it now (a lead's
 * correction, an undo), its standard minutes earned, where and when, and the disputes and corrections waiting about it.
 *
 * Its worker is named only where the site records workers AND the site's legal gate for one person's work figures is on
 * (PERFORMANCE, Statuto dei Lavoratori art. 4 c.1; GATE-LABOUR): off (the default), the record says a person is on it
 * (`workerHidden`), never who. Office only (production.labour.view).
 */

/** The site's PERFORMANCE legal gate is in force now (B-W2b-27's legalGateFor). Office reads. */
export async function performanceOpen(db: Reader, siteId: string): Promise<boolean> {
  return (await legalGateFor(db as GateReader, siteId, 'PERFORMANCE')).open
}

/** A record's line: its station's, else its station-less tablet's (B-W2b-52). */
export async function recordPlaces(db: Reader, records: readonly Pick<LabourRecord, 'stationId' | 'deviceId'>[]) {
  const stations = await stationsById(db, records.map((record) => record.stationId))
  const devices = await devicesById(db, records.filter((record) => !record.stationId).map((record) => record.deviceId))
  const lines = await linesById(db, [...[...stations.values()].map((row) => row.lineId), ...[...devices.values()].map((row) => row.lineId)])
  const lineIdOf = (record: Pick<LabourRecord, 'stationId' | 'deviceId'>): string | null =>
    record.stationId ? (stations.get(record.stationId)?.lineId ?? null) : record.deviceId ? (devices.get(record.deviceId)?.lineId ?? null) : null
  return {
    stationOf: (record: Pick<LabourRecord, 'stationId'>) => (record.stationId && stations.get(record.stationId) ? { id: record.stationId, code: stations.get(record.stationId)!.code, name: stations.get(record.stationId)!.name } : null),
    lineOf: (record: Pick<LabourRecord, 'stationId' | 'deviceId'>) => {
      const lineId = lineIdOf(record)
      const line = lineId ? lines.get(lineId) : undefined
      return line ? { id: line.id, code: line.code, name: line.name } : null
    },
  }
}

export const operationRefOf = (operation: OperationRow | undefined, id: string) => ({ id, seq: operation?.seq ?? 0, code: operation?.code ?? '', name: operation?.name ?? '' })

export async function recordOf(caller: CommandCaller, scanId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const scan = isUuid(scanId) ? await db.operationScan.findUnique({ where: { id: scanId }, select: SCAN }) : null
    const site = scan ? (await sitesById(db, [scan.siteId])).get(scan.siteId) : undefined
    if (!scan || !site || !(COUNT_KINDS as readonly string[]).includes(scan.kind) || !reaches(context, PRODUCTION_LABOUR_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Labour record not found.')
    const chain = await chainsOf(db, [scan])
    const report = reportOf(toLabourScan(scan), new Map(chain.map((row) => [row.id, toLabourScan(row)])))
    const root = report ? chain.find((row) => row.id === report.id) : undefined
    if (!root) throw new NotFoundError('Labour record not found.')
    const set = await recordsFor(db, [root], site.timezone)
    const record = set.records[0]!
    const operation = set.operations.get(record.workOrderOperationId)
    const bundle = (await bundlesById(db, [record.bundleId])).get(record.bundleId)
    const workOrder = (await workOrdersById(db, [record.workOrderId])).get(record.workOrderId)
    const places = await recordPlaces(db, [record])
    const shown = record.workerId !== null && (await performanceOpen(db, site.id))
    const names = await peopleNames(db, [shown ? record.workerId : null, ...record.steps.map((step) => step.approvedById)])
    const someone = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null)
    const chainIds = [record.scanId, ...record.steps.map((step) => step.scanId)]
    const disputes = await db.labourDispute.findMany({ where: { recordType: 'OperationScan', recordId: { in: chainIds } }, select: { id: true, status: true, message: true, createdAt: true }, orderBy: { createdAt: 'asc' } })
    const correctionsWaiting = await db.scanCorrectionRequest.count({ where: { status: 'PENDING', scanId: { in: chainIds } } })
    return {
      record: {
        scanId: record.scanId,
        standingScanId: record.standingScanId,
        state: record.state,
        siteId: site.id,
        workDate: record.workDate,
        at: toUtcIso(record.at),
        workOrder: { id: record.workOrderId, number: workOrder?.number ?? '' },
        bundle: { id: record.bundleId, code: bundle?.code ?? '' },
        operation: { ...operationRefOf(operation, record.workOrderOperationId), standardMinutes: operation?.standardMinutes ?? '0' },
        line: places.lineOf(record),
        station: places.stationOf(record),
        reported: record.reported,
        counts: record.counts,
        earnedMinutes: record.earnedMinutes,
        steps: record.steps.map((step) => ({ scanId: step.scanId, kind: step.kind, at: toUtcIso(step.at), counts: step.counts, approvedBy: someone(step.approvedById), reason: step.reason })),
        worker: shown ? someone(record.workerId) : null,
        workerHidden: record.workerId !== null && !shown,
        disputes: disputes.map((row) => ({ id: row.id, status: row.status, reason: readDisputeMessage(row.message).reason, raisedAt: toUtcIso(row.createdAt) })),
        correctionsWaiting,
      },
    }
  })
}
