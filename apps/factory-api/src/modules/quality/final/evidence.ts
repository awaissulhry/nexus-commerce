import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { readDocuments, readLabel } from '../../product/compliance/read'
import { processLabResults } from '../lab/results-store'
import { readCells, readHeader, type CellRow, type LabelHeader } from '../../production/serials/store'
import { mayOn, officeOf } from './access'
import { certificateOf, gateWords } from './facts'
import { checklistAnswers, inspectionView } from './inspections'
import { releaseView } from './releases'
import { lotsOfWorkOrder, readDefects, readRelease, readReleases, readWorkOrderInspections, type Reader } from './store'

/**
 * The evidence trail of one garment serial or one batch (Owner answer Q2 (a); design compliance.techfiles evidence
 * trail, quality.inspections qi-evidence; Reg. (EU) 2016/425 arts. 8, 10; QHS-118): every proof W1 keeps, read only, in one
 * answer — the style revision with its DoC and leaflet, the certificates (named by each release, and the gate today),
 * the material lots with their lab results, Cr VI evidence and supplier documents, the cutting (hides), the bundles, the
 * operation scans (who where the site names workers, and when), the inspections with their defects, the releases with
 * why a second person signed and their reversals, the garment label prints, the shipments and the PPE register entries.
 * The PDF pack and the link for authorities are W2b.
 *
 *   GET /quality/evidence?serial=SN-…  or  ?batch=<batch number>   quality.inspections.view (office) over the work
 *   order's company and site and every customer of the garments it covers (a person limited to other customers, or another
 *   company, finds nothing); money only with its grain (the value of each lot issued to the work order: cost).
 */

export interface EvidenceQuery {
  readonly serial?: string | undefined
  readonly batch?: string | undefined
}

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

async function subjectOf(db: Reader, query: EvidenceQuery) {
  if ((query.serial === undefined) === (query.batch === undefined)) {
    throw new ValidationError('Ask for one garment serial or one batch.', [{ path: 'querystring/serial', message: 'Exactly one of serial and batch.' }])
  }
  if (query.serial !== undefined) {
    const serial = await db.garmentSerial.findFirst({ where: { serial: query.serial.trim().toUpperCase() }, select: { id: true, serial: true, status: true, workOrderId: true, workOrderSizeId: true, releaseId: true, bundleId: true, shipmentLineId: true, createdAt: true } })
    if (!serial) return null
    const header = await readHeader(db, serial.workOrderId)
    return header ? { kind: 'SERIAL' as const, header, serial, cellIds: [serial.workOrderSizeId] } : null
  }
  const order = await db.workOrder.findFirst({ where: { batchNumber: query.batch!.trim() }, select: { id: true } })
  const header = order ? await readHeader(db, order.id) : null
  return header ? { kind: 'BATCH' as const, header, serial: null, cellIds: null } : null
}

export async function evidenceTrail(caller: CommandCaller, query: EvidenceQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const subject = await subjectOf(db, query)
    const notFound = () => new NotFoundError(query.serial !== undefined ? 'Serial not found.' : 'Batch not found.')
    if (!subject) throw notFound()
    const header: LabelHeader = subject.header
    const allCells = await readCells(db, header.id)
    const cells: CellRow[] = subject.cellIds ? allCells.filter((cell) => subject.cellIds!.includes(cell.id)) : allCells
    // The walls: the work order's company and site, and every customer of the garments it covers.
    if (!cells.every((cell) => mayOn(context, QUALITY_INSPECTIONS_VIEW, { companyId: header.companyId, siteId: header.siteId, partyId: cell.partyId }))) throw notFound()
    const cellIds = cells.map((cell) => cell.id)

    const style = await db.style.findUnique({ where: { id: header.styleId }, select: { id: true, code: true, name: true, ppeCategory: true, ppeStandard: true, ppeClass: true, garmentTracking: true } })
    const revision = header.styleRevisionId ? await db.styleRevision.findUnique({ where: { id: header.styleRevisionId }, select: { id: true, revision: true, status: true, releasedAt: true } }) : null
    const label = await readLabel(db, header.labelTemplateId)
    const documents = revision ? (await readDocuments(db, header.styleId)).facts.filter((document) => document.revision === revision.revision) : []

    const today = businessDate(serverClock.now())
    const gateToday = []
    for (const cell of cells) gateToday.push({ workOrderSizeId: cell.id, cell: `${cell.colourwayCode} ${cell.size}`, words: gateWords(await certificateOf(db, header, cell, today), cell) })

    // The material lots, their results, documents, and the value issued to the work order (cost).
    const lots = []
    for (const lot of await lotsOfWorkOrder(db, header.id)) {
      const item = await db.item.findUnique({ where: { id: lot.itemId }, select: { code: true, name: true, isPpeComponent: true } })
      const results = await processLabResults().list(db, lot.id)
      const lotDocuments = await db.lotDocument.findMany({ where: { lotId: lot.id }, select: { id: true, kind: true, fileId: true, validTo: true, status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const issues = await db.stockMove.findMany({ where: { lotId: lot.id, workOrderId: header.id, reason: 'ISSUE' }, select: { id: true } })
      const valuations = issues.length ? await db.stockValuation.findMany({ where: { moveId: { in: issues.map((move) => move.id) } }, select: { valueAmount: true, currency: true } }) : []
      lots.push({
        id: lot.id,
        code: lot.code,
        item: item ? { code: item.code, name: item.name, isPpeComponent: item.isPpeComponent } : null,
        qualityStatus: lot.qualityStatus,
        crVi: { required: lot.requiresCrViTest, status: lot.crViStatus, valueMgKg: lot.crViMgKg?.toString() ?? null, limitMgKg: lot.crViLimitMgKg?.toString() ?? null, evidence: lot.crViEvidence, testedOn: day(lot.crViTestedAt) },
        results: results.map((row) => ({ id: row.id, test: row.test, method: row.method, valueMgKg: row.valueMgKg, belowDetectionLimit: row.belowDetectionLimit, limitMgKg: row.limitMgKg, verdict: row.verdict, lab: row.lab, reportNumber: row.reportNumber, testedOn: row.testedOn, evidence: row.evidence, fileId: row.fileId, supersedesId: row.supersedesId })),
        documents: lotDocuments.map((row) => ({ id: row.id, kind: row.kind, fileId: row.fileId, validTo: day(row.validTo), status: row.status })),
        issuedCostMinor: asMoney('cost', valuations.length ? valuations.reduce((sum, row) => sum + row.valueAmount, 0) : null),
        currency: valuations[0]?.currency ?? null,
      })
    }

    // The cutting, the bundles and the operation scans (the serial's own bundle and its cut log entries; a batch: all).
    const bundles = await db.bundle.findMany({
      where: subject.serial ? { id: subject.serial.bundleId ?? '00000000-0000-0000-0000-000000000000' } : { workOrderId: header.id },
      select: { id: true, code: true, workOrderSizeId: true, quantity: true, part: true, status: true, cutLogIds: true, deviceId: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const cutIds = subject.serial ? [...new Set(bundles.flatMap((bundle) => bundle.cutLogIds))] : null
    const cuts = await db.cutLog.findMany({
      where: { workOrderId: header.id, ...(cutIds ? { id: { in: cutIds } } : {}) },
      select: { id: true, hideId: true, lotId: true, uom: true, areaUsed: true, reversalOfId: true, workerId: true, stationId: true, deviceId: true, serverTime: true },
      orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
    })
    const hides = new Map((await db.hide.findMany({ where: { id: { in: [...new Set(cuts.map((cut) => cut.hideId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const scans = await db.operationScan.findMany({
      where: { workOrderId: header.id, ...(subject.serial ? { bundleId: { in: bundles.map((bundle) => bundle.id) } } : {}) },
      select: { id: true, bundleId: true, workOrderOperationId: true, kind: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true, workerId: true, stationId: true, deviceId: true, serverTime: true, correctsId: true },
      orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
    })
    const operations = new Map((await db.workOrderOperation.findMany({ where: { workOrderId: header.id }, select: { id: true, seq: true, code: true, name: true } })).map((row) => [row.id, row]))
    const workerIds = [...new Set([...cuts.map((cut) => cut.workerId), ...scans.map((scan) => scan.workerId)].filter((value): value is string => value !== null))]
    const workers = new Map((await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
    const stationIds = [...new Set([...cuts.map((cut) => cut.stationId), ...scans.map((scan) => scan.stationId)].filter((value): value is string => value !== null))]
    const stations = new Map((await db.station.findMany({ where: { id: { in: stationIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const bundleCodes = new Map(bundles.map((bundle) => [bundle.id, bundle.code]))

    const inspectionRows = await readWorkOrderInspections(db, header.id)
    const defects = await readDefects(db, inspectionRows.map((row) => row.id))
    // A serial: the release that released it last (kept when a reversal took it back); a batch: every release of it.
    const releases = subject.serial ? (subject.serial.releaseId ? [await readRelease(db, subject.serial.releaseId)].filter((row) => row !== null) : []) : await readReleases(db, { workOrderId: header.id }, 1000)
    const releaseViews = []
    for (const row of releases) releaseViews.push(await releaseView(db, row, header.number))
    const prints = await db.garmentLabelPrint.findMany({
      where: { workOrderId: header.id, workOrderSizeId: { in: cellIds }, ...(subject.serial ? { serialIds: { has: subject.serial.id } } : {}) },
      select: { id: true, kind: true, tracking: true, workOrderSizeId: true, quantity: true, batchNumber: true, reason: true, deviceId: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const lines = await db.shipmentLine.findMany({ where: subject.serial?.shipmentLineId ? { id: subject.serial.shipmentLineId } : { workOrderSizeId: { in: cellIds } }, select: { shipmentId: true, workOrderSizeId: true, quantity: true } })
    const shipmentRows = lines.length ? await db.shipment.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.shipmentId))] } }, select: { id: true, number: true, status: true, shippedAt: true } }) : []
    const ddts = shipmentRows.length ? await db.ddt.findMany({ where: { shipmentId: { in: shipmentRows.map((row) => row.id) }, cancellations: { none: {} } }, select: { shipmentId: true, number: true } }) : []
    const register = await db.ppeRegisterEntry.findMany({
      where: { OR: [{ workOrderIds: { has: header.id } }, ...(header.batchNumber ? [{ batchNumbers: { has: header.batchNumber } }] : []), ...(subject.serial ? [{ serials: { has: subject.serial.serial } }] : [])] },
      select: { id: true, reference: true, kind: true, status: true, risk: true, reportedAt: true },
      orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
    })

    return {
      subject: {
        kind: subject.kind,
        serial: subject.serial ? { id: subject.serial.id, serial: subject.serial.serial, status: subject.serial.status, bundleId: subject.serial.bundleId, releaseId: subject.serial.releaseId } : null,
        batchNumber: header.batchNumber,
        workOrder: { id: header.id, number: header.number, status: header.status, companyId: header.companyId, siteId: header.siteId, releasedAt: header.releasedAt ? toUtcIso(header.releasedAt) : null },
        cells: cells.map((cell) => ({ workOrderSizeId: cell.id, colourwayCode: cell.colourwayCode, size: cell.size, pieces: cell.quantity })),
      },
      style: style ? { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass, tracking: style.garmentTracking } : null,
      revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status, releasedAt: revision.releasedAt ? toUtcIso(revision.releasedAt) : null } : null,
      labelTemplate: label ? { id: label.id, code: label.code, revision: label.revision, status: label.status, languages: label.languages } : null,
      documents: documents.map((document) => ({ id: document.id, kind: document.kind, language: document.language, revision: document.revision, status: document.status, number: document.number, issuedAt: document.issuedAt, file: document.currentFile ? { id: document.currentFile.id, sha256: document.currentFile.sha256 } : null })),
      certificates: { today: gateToday, date: today },
      lots,
      cutting: cuts.map((cut) => ({ id: cut.id, hideCode: hides.get(cut.hideId) ?? null, lotId: cut.lotId, areaUsed: cut.areaUsed.toString(), uom: cut.uom, reversal: cut.reversalOfId !== null, worker: cut.workerId ? workers.get(cut.workerId) ?? null : null, station: cut.stationId ? stations.get(cut.stationId) ?? null : null, at: toUtcIso(cut.serverTime) })),
      bundles: bundles.map((bundle) => ({ id: bundle.id, code: bundle.code, workOrderSizeId: bundle.workOrderSizeId, quantity: bundle.quantity, part: bundle.part, status: bundle.status, cutLogIds: bundle.cutLogIds, madeOn: bundle.deviceId ? ('FLOOR' as const) : ('OFFICE' as const), at: toUtcIso(bundle.createdAt) })),
      scans: scans.map((scan) => {
        const operation = operations.get(scan.workOrderOperationId)
        return {
          id: scan.id,
          bundleCode: bundleCodes.get(scan.bundleId) ?? null,
          operation: operation ? { seq: operation.seq, code: operation.code, name: operation.name } : null,
          kind: scan.kind,
          good: scan.goodQuantity,
          scrap: scan.scrapQuantity,
          rework: scan.reworkQuantity,
          corrects: scan.correctsId,
          worker: scan.workerId ? workers.get(scan.workerId) ?? null : null,
          station: scan.stationId ? stations.get(scan.stationId) ?? null : null,
          at: toUtcIso(scan.serverTime),
        }
      }),
      inspections: inspectionRows.map((row, index) => ({ ...inspectionView(row, defects, { number: header.number, seq: index + 1 }), checklistAnswered: checklistAnswers(row.checklist).length })),
      releases: releaseViews,
      labelPrints: prints.map((row) => ({ id: row.id, kind: row.kind, tracking: row.tracking, workOrderSizeId: row.workOrderSizeId, quantity: row.quantity, batchNumber: row.batchNumber, reason: row.reason, postedBy: row.deviceId ? ('FLOOR' as const) : ('OFFICE' as const), at: toUtcIso(row.createdAt) })),
      shipments: shipmentRows.map((row) => ({ id: row.id, number: row.number, status: row.status, shippedAt: row.shippedAt ? toUtcIso(row.shippedAt) : null, garments: lines.filter((line) => line.shipmentId === row.id).reduce((sum, line) => sum + line.quantity, 0), ddtNumbers: ddts.filter((ddt) => ddt.shipmentId === row.id).map((ddt) => ddt.number) })),
      registerEntries: register.map((entry) => ({ id: entry.id, reference: entry.reference, kind: entry.kind, status: entry.status, risk: entry.risk, reportedAt: toUtcIso(entry.reportedAt) })),
    }
  })
}
