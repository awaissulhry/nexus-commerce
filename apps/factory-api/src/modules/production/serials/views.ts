import { PRINT_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { PRODUCTION_SERIALS } from '@nexus/factory-domain/production/serials/permissions'
import { gateRefusal, workOrderRefusal, type LabelRefusal } from '@nexus/factory-domain/production/serials/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { certificateGateFor } from '../../compliance/certificates/gate'
import { labelView } from '../../compliance/labels/preview'
import {
  batchIdentification,
  floorReadyRefusal,
  labelFacts,
  labelSize,
  labelWorkOrder,
  languagesOf,
  mayLabel,
  officeOf,
  printDay,
  probeIdentification,
  renderCell,
  stockHolds,
  workerOf,
  type CellFacts,
} from './facts'
import { bundleCodes, LABEL_HEADER, readBundleByCode, readCells, readLabelJobs, readLabelPrinters, readSerialByText, readSerials, readTemplateSize, type LabelHeader, type SerialRow } from './store'

/**
 * The garment label step's reads (B-W1-44; A2 SCR-096 floor.labels, SCR-072 the work order's labels): a work order at the
 * final operation (the floor and the office with production.serials: per cell finished, labelled and still to label,
 * the certificate gate's answer on the day, whether its label prints, the label printers, a preview of one cell's
 * label), what a scanned code names (a bundle ticket, a serial, a work order number), and for the office a work order's
 * serials with their bundles, the label log (every print and reprint with its reason) and the print jobs (with
 * print.view). Nothing here names a person or carries money (Statuto dei Lavoratori art. 4: the log says FLOOR or
 * OFFICE and the device, never who).
 */

const at = (value: Date | null) => (value ? toUtcIso(value) : null)

type Job = { id: string; recordType: string; recordId: string; printerId: string; scanId: string | null; copies: number; status: string; lastError: string | null; createdAt: Date }
const jobView = (job: Job) => ({ jobId: job.id, printerId: job.printerId, scanId: job.scanId, copies: job.copies, status: job.status as 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED', lastError: job.lastError, createdAt: toUtcIso(job.createdAt) })

export function serialView(row: SerialRow, bundle: { readonly id: string; readonly code: string } | null, jobs: readonly Job[] | null) {
  return {
    id: row.id,
    serial: row.serial,
    status: row.status,
    workOrderId: row.workOrderId,
    workOrderSizeId: row.workOrderSizeId,
    releaseId: row.releaseId,
    shipmentLineId: row.shipmentLineId,
    voidedAt: at(row.voidedAt),
    voidReason: row.voidReason,
    bundle: bundle ? { ...bundle } : null,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    jobs: jobs ? jobs.map(jobView) : null,
  }
}

const cellView = (cell: CellFacts) => ({
  workOrderSizeId: cell.cellId,
  colourwayId: cell.colourwayId,
  colourwayCode: cell.colourwayCode,
  colourwayName: cell.colourwayName,
  size: cell.size,
  quantity: cell.quantity,
  finished: cell.finished,
  labelled: cell.labelled,
  reprinted: cell.reprinted,
  toLabel: cell.toLabel,
  overLabelled: cell.overLabelled,
})

const refusalView = (refusal: LabelRefusal) => ({ code: refusal.code, message: refusal.message, fix: refusal.fix, workOrderSizeId: refusal.cellId })

/** Each cell's finished, labelled and still-to-label garments (the commands' answers after the write). */
export async function cellStateView(caller: CommandCaller, header: LabelHeader) {
  const facts = await caller.withClient((db) => labelFacts(db, header))
  return facts.cells.map(cellView)
}

// ---- the label screen ------------------------------------------------------------------------------------------------------------

/**
 * GET /production/serials/work-orders/:workOrderId: the work order at the final operation (floor.labels): its tracking,
 * frozen label, batch number, each cell with what is still to label and the certificate gate on the day, the label
 * printers, what stops the whole work order (in words), and the label of `cellId` as it will print.
 */
export async function labelsOfWorkOrder(caller: CommandCaller, workOrderId: string, query: { readonly cellId?: string | undefined }) {
  const context = workerOf(caller)
  const header = await labelWorkOrder(caller, workOrderId, PRODUCTION_SERIALS)
  const languages = await languagesOf(caller, await caller.withClient((client) => readCells(client, header.id)))
  const floorReady = context.audience === 'floor' ? await floorReadyRefusal(caller, header.siteId) : null
  const date = printDay(serverClock.now())
  return caller.withClient(async (db) => {
    const facts = await labelFacts(db, header)
    if (query.cellId !== undefined && !facts.cells.some((cell) => cell.cellId === query.cellId)) throw new ValidationError('Not a cell of this work order.', [{ path: 'querystring/cellId', message: 'Pick a cell of this work order.' }])
    const template = header.labelTemplateId ? await readTemplateSize(db, header.labelTemplateId) : null
    const blocked = workOrderRefusal(facts.workOrder)
    const identification = facts.style.tracking === 'BATCH' ? batchIdentification(header) : probeIdentification(header, context.tenantId)
    const cells = []
    let preview = null
    for (const cell of facts.cells) {
      const gate = await certificateGateFor(db, { styleId: header.styleId, colourwayId: cell.colourwayId, size: cell.size }, date)
      const words =
        gate.outcome === 'covered' && gate.certificate
          ? `${gate.certificate.standard}${gate.certificate.ppeClass ? ` class ${gate.certificate.ppeClass}` : ''} · certificate ${gate.certificate.number} valid until ${gate.certificate.validTo}.`
          : gate.outcome === 'not_required'
            ? (gate.message ?? 'No certificate is needed for this style.')
            : gate.reasons.map((reason) => reason.message).join(' ')
      const label = blocked || !header.labelTemplateId ? null : await renderCell(db, header, cell, identification, date, languages)
      const refusal = label ? gateRefusal(cell, label) : null
      if (label && cell.cellId === query.cellId) preview = labelView(label)
      cells.push({
        ...cellView(cell),
        gate: {
          outcome: gate.outcome,
          certificate: gate.certificate ? { id: gate.certificate.id, number: gate.certificate.number, standard: gate.certificate.standard, ppeClass: gate.certificate.ppeClass, validTo: gate.certificate.validTo } : null,
          words,
        },
        printable: label?.printable ?? false,
        refusal: refusal ? refusalView(refusal) : null,
      })
    }
    const size = template ? labelSize(template) : null
    const printers = (await readLabelPrinters(db, header.siteId)).map((printer) => ({ id: printer.id, code: printer.code, name: printer.name, labelWidthMm: printer.labelWidthMm, labelHeightMm: printer.labelHeightMm, holdsLabel: size ? stockHolds(printer, size) : false }))
    return {
      workOrder: {
        id: header.id,
        number: header.number,
        batchNumber: header.batchNumber,
        status: header.status,
        siteId: header.siteId,
        releasedAt: at(header.releasedAt),
        style: { id: facts.style.id, code: facts.style.code, name: facts.style.name },
      },
      tracking: facts.style.tracking,
      label: template && header.labelTemplateId ? { id: header.labelTemplateId, code: template.code, revision: template.revision, status: template.status, widthMm: template.widthMm, heightMm: template.heightMm } : null,
      finalOperation: facts.finalOperation,
      date,
      /** What stops every label of the work order now (null: each cell answers for itself). */
      blocked: blocked ? refusalView(blocked) : floorReady ? refusalView(floorReady) : null,
      cells,
      printers,
      preview,
    }
  })
}

// ---- a scanned code -------------------------------------------------------------------------------------------------------------

/**
 * GET /production/serials/scan?code=: what the scanned or typed code names for the labels screen: a bundle ticket (its
 * work order and cell), a garment's serial, or a work order number (the traveller). Another site's (a floor device) or
 * another tenant's: not found.
 */
export async function scanForLabels(caller: CommandCaller, code: string) {
  const context = workerOf(caller)
  const parsed = parseScanId(code, { tenantTag: tenantTag(context.tenantId), types: ['BUNDLE', 'SERIAL'] })
  return caller.withClient(async (db) => {
    const visible = (header: LabelHeader | null): header is LabelHeader => header !== null && mayLabel(context, PRODUCTION_SERIALS, header)
    const headerOf = (id: string) => db.workOrder.findUnique({ where: { id }, select: LABEL_HEADER })
    if (parsed.ok && parsed.type === 'BUNDLE') {
      const bundle = await readBundleByCode(db, parsed.text)
      const header = bundle ? await headerOf(bundle.workOrderId) : null
      if (!bundle || !visible(header)) throw new NotFoundError('No bundle of this factory has this code.')
      return { scanned: parsed.text, kind: 'BUNDLE' as const, workOrderId: header.id, number: header.number, workOrderSizeId: bundle.workOrderSizeId, bundle: { id: bundle.id, code: bundle.code, status: bundle.status }, serial: null }
    }
    if (parsed.ok && parsed.type === 'SERIAL') {
      const serial = await readSerialByText(db, parsed.text)
      const header = serial ? await headerOf(serial.workOrderId) : null
      if (!serial || !visible(header)) throw new NotFoundError('No garment of this factory has this serial.')
      const codes = await bundleCodes(db, serial.bundleId ? [serial.bundleId] : [])
      return { scanned: parsed.text, kind: 'SERIAL' as const, workOrderId: header.id, number: header.number, workOrderSizeId: serial.workOrderSizeId, bundle: null, serial: serialView(serial, serial.bundleId ? { id: serial.bundleId, code: codes.get(serial.bundleId) ?? '' } : null, null) }
    }
    // Not a bundle or serial label: a work order number (the traveller), typed or scanned.
    const number = code.trim()
    const rows = (await db.workOrder.findMany({ where: { number }, select: LABEL_HEADER, take: 5 })).filter(visible)
    if (rows.length === 1) return { scanned: number, kind: 'WORK_ORDER' as const, workOrderId: rows[0]!.id, number: rows[0]!.number, workOrderSizeId: null, bundle: null, serial: null }
    if (rows.length > 1) throw new ValidationError('Several work orders have this number.', [{ path: 'querystring/code', message: 'Scan a bundle ticket of the work order instead.' }])
    if (!parsed.ok && parsed.problem !== 'format') throw new NotFoundError(parsed.message)
    throw new NotFoundError('No work order, bundle or serial has this code.')
  })
}

// ---- the office's serials and label log ----------------------------------------------------------------------------------------

/**
 * GET /production/serials/work-orders/:workOrderId/serials (office, workorders.view): the work order's cells with what is
 * labelled, its serials (status, bundle, release, shipment line, void reason), the label log (every print and reprint,
 * with its reason, FLOOR or OFFICE and the device, never who) and the labels' print jobs (with print.view, else null).
 */
export async function workOrderSerials(caller: CommandCaller, workOrderId: string) {
  const context = officeOf(caller)
  const header = await labelWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  return caller.withClient(async (db) => {
    const facts = await labelFacts(db, header)
    const serials = await readSerials(db, header.id)
    const serialText = new Map(serials.map((serial) => [serial.id, serial.serial]))
    const codes = await bundleCodes(db, serials.flatMap((serial) => (serial.bundleId ? [serial.bundleId] : [])))
    const seesJobs = can(actorOf(context), PRINT_VIEW, { companyId: header.companyId, siteId: header.siteId })
    const jobs = seesJobs ? await readLabelJobs(db, [...facts.cells.map((cell) => cell.cellId), ...serials.map((serial) => serial.id)]) : []
    const jobsOf = (recordId: string) => (seesJobs ? jobs.filter((job) => job.recordId === recordId) : null)
    const cells = new Map(facts.cells.map((cell) => [cell.cellId, cell]))
    return {
      workOrder: { id: header.id, number: header.number, batchNumber: header.batchNumber, status: header.status, siteId: header.siteId },
      tracking: facts.style.tracking,
      cells: facts.cells.map((cell) => ({ ...cellView(cell), jobs: facts.style.tracking === 'BATCH' ? (jobsOf(cell.cellId)?.map(jobView) ?? null) : seesJobs ? [] : null })),
      serials: serials.map((serial) => serialView(serial, serial.bundleId ? { id: serial.bundleId, code: codes.get(serial.bundleId) ?? '' } : null, jobsOf(serial.id))),
      log: [...facts.log].reverse().map((entry) => ({
        entryId: entry.id,
        kind: entry.kind,
        tracking: entry.tracking,
        workOrderSizeId: entry.cellId,
        colourwayCode: cells.get(entry.cellId)?.colourwayCode ?? '',
        size: cells.get(entry.cellId)?.size ?? '',
        quantity: entry.quantity,
        batchNumber: entry.batchNumber,
        serials: entry.serialIds.map((serialId) => serialText.get(serialId) ?? ''),
        reason: entry.reason,
        printerId: entry.printerId,
        postedBy: entry.postedBy,
        deviceId: entry.deviceId,
        at: toUtcIso(entry.at),
      })),
    }
  })
}
