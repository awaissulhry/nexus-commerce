import type { Prisma } from '@nexus/factory-db'
import { PRINT_LABELS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { marksCurrent } from '@nexus/factory-domain/shipping/cartons/rules'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import { isTestLabelJob, labelJobKind, reprintReasonOf, reprintRefusal, type LabelJobKind } from '@nexus/factory-domain/shipping/reprint/rules'
import type { ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { assertMay, shippingContextOf, type ShippingContext } from '../access'
import { readShipment, type ShipmentHeader } from '../store'

/**
 * Reprint a label with a reason (B-W2b-391; LOG-027; factory-domain shipping/reprint/rules.ts). Office and a floor device at
 * the shipment's site (shipping.pack, as printing the labels; print.labels on the printer's site):
 *
 *   GET  /shipping/shipments/:shipmentId/label-jobs           every label job of the shipment's parcels (the carrier labels,
 *                                                             the cartons' marks, their reprints): who (an office user by
 *                                                             name; on the floor the device, the worker only behind the site's
 *                                                             gate, never to a floor reader), when, why; may it be printed
 *                                                             again, or why not
 *   POST /shipping/shipments/:shipmentId/label-jobs/reprint   ONE command: per job a new PrintJob copying its ZPL exactly,
 *                                                             naming it and the reason (reprintOfId, reprintReason: fixed once
 *                                                             queued), on its own printer, the named one or the site's label
 *                                                             printer (a label printer of the shipment's site with the same
 *                                                             print head: the ZPL is in its dots); audit rows on each job and
 *                                                             on the shipment; print.job_queued (a DIRECT printer's job waits
 *                                                             for its station) and shipping.label_reprinted
 *
 * Nothing is bought again and nothing is laid out again. Refusals are 409 in words with the issue path `refusal/<CODE>`.
 */

// B-W2b-391 + B-W2b-390: carrierParcelId says a TEST label of test mode (`test:`).
const PARCEL = { id: true, seq: true, trackingNumber: true, carrierParcelId: true, labelledAt: true, cartonNumber: true, cartonCount: true, marksPrintedAt: true } as const satisfies Prisma.ParcelSelect
type ParcelRow = Prisma.ParcelGetPayload<{ select: typeof PARCEL }>

const JOB = {
  id: true,
  companyId: true,
  siteId: true,
  printerId: true,
  recordId: true,
  payloadKind: true,
  labelKind: true,
  scanId: true,
  copies: true,
  status: true,
  reprintOfId: true,
  reprintReason: true,
  requestedById: true,
  deviceId: true,
  createdAt: true,
} as const satisfies Prisma.PrintJobSelect
type JobRow = Prisma.PrintJobGetPayload<{ select: typeof JOB }>

const PRINTER = { id: true, companyId: true, siteId: true, code: true, name: true, kind: true, mode: true, status: true, dpi: true } as const satisfies Prisma.PrinterSelect
type PrinterRow = Prisma.PrinterGetPayload<{ select: typeof PRINTER }>

/** The shipment a packer may see (office within its grants, a floor device at its own site), else 404. */
async function packerShipment(caller: CommandCaller, shipmentId: string): Promise<{ context: ShippingContext; shipment: ShipmentHeader }> {
  const context = shippingContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_PACK, SHIPPING_PACK, shipment)
  return { context, shipment: shipment! }
}

async function readParcelsAndJobs(db: CommandTx, shipmentId: string): Promise<{ parcels: ParcelRow[]; jobs: JobRow[] }> {
  const parcels = await db.parcel.findMany({ where: { shipmentId }, select: PARCEL, orderBy: { seq: 'asc' } })
  const jobs = parcels.length === 0 ? [] : await db.printJob.findMany({ where: { recordType: 'Parcel', recordId: { in: parcels.map((parcel) => parcel.id) } }, select: JOB, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return { parcels, jobs }
}

/** Whether (and why not) a job may be printed again now. */
function refusalOf(shipment: Pick<ShipmentHeader, 'number' | 'status'>, parcel: ParcelRow, count: number, job: JobRow) {
  const kind = labelJobKind(job, shipment.number)
  const refusal = reprintRefusal({
    shipmentStatus: shipment.status as ShipmentStatus,
    payloadKind: job.payloadKind,
    kind,
    job: { scanId: job.scanId, createdAt: job.createdAt },
    parcel: {
      seq: parcel.seq,
      trackingNumber: parcel.trackingNumber,
      labelledAt: parcel.labelledAt,
      cartonNumber: parcel.cartonNumber,
      marksPrintedAt: parcel.marksPrintedAt,
      marksCurrent: marksCurrent({ id: parcel.id, seq: parcel.seq, cartonNumber: parcel.cartonNumber, cartonCount: parcel.cartonCount, marksPrinted: parcel.marksPrintedAt !== null }, count),
    },
  })
  return { kind, refusal, test: isTestLabelJob(kind, job, { trackingNumber: parcel.trackingNumber, providerId: parcel.carrierParcelId }) }
}

/** GET /shipping/shipments/:shipmentId/label-jobs. */
export async function labelJobs(caller: CommandCaller, shipmentId: string) {
  const { context, shipment } = await packerShipment(caller, shipmentId)
  return caller.withClient(async (db) => {
    const { parcels, jobs } = await readParcelsAndJobs(db, shipment.id)
    const printerIds = [...new Set(jobs.map((job) => job.printerId))]
    const printers = new Map((printerIds.length === 0 ? [] : await db.printer.findMany({ where: { id: { in: printerIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    // Names for the office only: an office user by name; a device by name; a worker behind the site's gate. A floor reader gets none.
    const office = context.audience === 'office'
    const userIds = office ? [...new Set(jobs.filter((job) => job.deviceId === null && job.requestedById !== null).map((job) => job.requestedById!))] : []
    const users = new Map((userIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
    const deviceIds = office ? [...new Set(jobs.flatMap((job) => (job.deviceId ? [job.deviceId] : [])))] : []
    const devices = new Map((deviceIds.length === 0 ? [] : await db.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))
    const gate = office && deviceIds.length > 0 ? await workerGateFor(db, shipment.siteId) : null
    const workerIds = gate ? gate.lookup(jobs.filter((job) => job.deviceId !== null).map((job) => job.requestedById)) : []
    const workers = new Map((workerIds.length === 0 ? [] : await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
    const requesterOf = (job: JobRow) => {
      if (job.deviceId !== null) {
        return { by: 'FLOOR' as const, name: gate ? gate.name(job.requestedById, workers) : null, device: devices.get(job.deviceId) ?? null, hidden: gate ? gate.hidden(job.requestedById) : job.requestedById !== null }
      }
      if (job.requestedById !== null) return { by: 'OFFICE' as const, name: users.get(job.requestedById) ?? null, device: null, hidden: !office }
      return { by: 'SYSTEM' as const, name: null, device: null, hidden: false }
    }
    return {
      shipmentId: shipment.id,
      number: shipment.number,
      status: shipment.status,
      parcels: parcels.map((parcel) => ({
        parcelId: parcel.id,
        seq: parcel.seq,
        trackingNumber: parcel.trackingNumber,
        jobs: jobs
          .filter((job) => job.recordId === parcel.id)
          .map((job) => {
            const { kind, refusal, test } = refusalOf(shipment, parcel, parcels.length, job)
            const printer = printers.get(job.printerId)
            return {
              jobId: job.id,
              kind,
              test,
              scanId: job.scanId,
              status: job.status,
              printer: { id: job.printerId, code: printer?.code ?? '', name: printer?.name ?? '' },
              copies: job.copies,
              createdAt: toUtcIso(job.createdAt),
              reprintOfId: job.reprintOfId,
              reason: job.reprintReason,
              requestedBy: requesterOf(job),
              reprintable: refusal === null,
              refusal,
            }
          }),
      })),
    }
  })
}

export interface ReprintBody {
  readonly jobIds: readonly string[]
  readonly reason: string
  readonly printerId?: string | undefined
  readonly copies?: number | undefined
}

const refused = (code: string, message: string) => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

/** The printer a reprint goes to: a label printer of the shipment's site that takes jobs, with the original's print head. */
function printerProblem(printer: PrinterRow | undefined, shipment: Pick<ShipmentHeader, 'siteId'>, original: PrinterRow | undefined): { code: string; message: string } | null {
  if (!printer || printer.siteId !== shipment.siteId) return { code: 'PRINTER', message: "Choose a label printer of the shipment's site." }
  if (printer.kind !== 'LABEL_ZPL') return { code: 'PRINTER', message: 'This printer prints PDFs: choose a label printer (ZPL).' }
  if (printer.status !== 'ACTIVE') return { code: 'PRINTER', message: `The printer ${printer.code} is ${printer.status.toLowerCase()}; it takes no jobs now.` }
  if (printer.mode === 'PDF') return { code: 'PRINTER', message: `The printer ${printer.code} prints from the browser as a PDF: print the shipment's one PDF instead.` }
  if (original && original.dpi !== null && printer.dpi !== original.dpi) return { code: 'PRINTER', message: `This label was made for a ${original.dpi} dpi print head: choose a printer with one (${printer.code} has ${printer.dpi ?? 'none'}).` }
  return null
}

/** POST /shipping/shipments/:shipmentId/label-jobs/reprint. */
export async function reprintLabels(caller: CommandCaller, shipmentId: string, body: ReprintBody, idempotencyKey?: string) {
  const { context, shipment } = await packerShipment(caller, shipmentId)
  const reason = reprintReasonOf(body.reason)
  if ('problem' in reason) throw refused('REASON', reason.problem)
  const wanted = [...new Set(body.jobIds)]
  // Read what the checks need; the command reads it all again under its transaction.
  const { parcels, jobs, printers, settings } = await caller.withClient(async (db) => {
    const read = await readParcelsAndJobs(db, shipment.id)
    const ids = [...new Set([...read.jobs.map((job) => job.printerId), ...(body.printerId ? [body.printerId] : [])])]
    const rows = ids.length === 0 ? [] : await db.printer.findMany({ where: { id: { in: ids } }, select: PRINTER })
    const site = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { labelPrinterId: true } })
    const fallback = site?.labelPrinterId && !rows.some((row) => row.id === site.labelPrinterId) ? await db.printer.findUnique({ where: { id: site.labelPrinterId }, select: PRINTER }) : null
    return { ...read, printers: new Map([...rows, ...(fallback ? [fallback] : [])].map((row) => [row.id, row])), settings: site }
  })
  const plan = wanted.map((jobId) => {
    const job = jobs.find((row) => row.id === jobId)
    if (!job) throw new NotFoundError('Label not found on this shipment.')
    const parcel = parcels.find((row) => row.id === job.recordId)!
    const { kind, refusal } = refusalOf(shipment, parcel, parcels.length, job)
    if (refusal) throw refused(refusal.code, refusal.message)
    const original = printers.get(job.printerId)
    const own = original && printerProblem(original, shipment, original) === null ? original : undefined
    const chosenId = body.printerId ?? own?.id ?? settings?.labelPrinterId ?? null
    if (!chosenId) throw refused('PRINTER', "No label printer: choose one, or set the site's label printer (shipping settings).")
    const printer = printers.get(chosenId)
    const problem = printerProblem(printer, shipment, original)
    if (problem) throw refused(problem.code, problem.message)
    if (!can(actorOf(context), PRINT_LABELS, { companyId: printer!.companyId, siteId: printer!.siteId })) throw new ForbiddenError()
    return { job, parcel, kind, printer: printer! }
  })

  const { result } = await command(caller, { name: 'shipping.reprintLabels', idempotencyKey, input: { shipmentId, ...body, reason: reason.reason } }, async ({ tx, audit, emit, now, context: inside }) => {
    // Under the transaction: a label voided or marks renumbered since the checks are refused, never printed.
    const current = await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true, number: true } })
    const now_ = await readParcelsAndJobs(tx, shipment.id)
    const requester =
      inside.audience === 'floor'
        ? { requestedById: inside.actorId, deviceId: inside.deviceId, createdById: inside.actorId }
        : inside.audience === 'office'
          ? { requestedById: inside.actorId, deviceId: null, createdById: inside.actorId }
          : { requestedById: null, deviceId: null, createdById: null }
    const made: { jobId: string; reprintOfId: string; parcelId: string; seq: number; kind: LabelJobKind; test: boolean; printerId: string; status: 'QUEUED' }[] = []
    for (const step of plan) {
      const parcel = now_.parcels.find((row) => row.id === step.parcel.id)
      const job = now_.jobs.find((row) => row.id === step.job.id)
      if (!parcel || !job) throw new ConflictError('The shipment changed while the labels were being printed again: look again.')
      const { refusal, test } = refusalOf(current, parcel, now_.parcels.length, job)
      if (refusal) throw refused(refusal.code, refusal.message)
      const printer = await tx.printer.findUnique({ where: { id: step.printer.id }, select: { status: true } })
      if (printer?.status !== 'ACTIVE') throw refused('PRINTER', `The printer ${step.printer.code} takes no jobs now.`)
      const zpl = await tx.printJob.findUniqueOrThrow({ where: { id: job.id }, select: { zpl: true } })
      const id = newId()
      const copies = body.copies ?? job.copies
      await tx.printJob.create({
        data: {
          id,
          companyId: step.printer.companyId,
          siteId: step.printer.siteId,
          printerId: step.printer.id,
          recordType: 'Parcel',
          recordId: parcel.id,
          payloadKind: 'ZPL',
          labelKind: job.labelKind,
          scanId: job.scanId,
          zpl: zpl.zpl,
          copies,
          reprintOfId: job.id,
          reprintReason: reason.reason,
          ...requester,
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      })
      audit({
        recordType: 'PrintJob',
        recordId: id,
        companyId: step.printer.companyId,
        siteId: step.printer.siteId,
        after: { printerId: step.printer.id, recordType: 'Parcel', recordId: parcel.id, payloadKind: 'ZPL', labelKind: job.labelKind, scanId: job.scanId, copies, reprintOfId: job.id, reprintReason: reason.reason, shipmentId: shipment.id, test },
      })
      emit({ type: 'print.job_queued', subject: id, companyId: step.printer.companyId, siteId: step.printer.siteId, payload: { jobId: id, printerId: step.printer.id, payloadKind: 'ZPL' } })
      made.push({ jobId: id, reprintOfId: job.id, parcelId: parcel.id, seq: parcel.seq, kind: step.kind, test, printerId: step.printer.id, status: 'QUEUED' })
    }
    // The shipment's own record of it (its timeline): which labels, why.
    audit({
      action: 'shipping.reprintLabels',
      recordType: 'Shipment',
      recordId: shipment.id,
      companyId: shipment.companyId,
      siteId: shipment.siteId,
      after: { reason: reason.reason, jobs: made.map((entry) => ({ jobId: entry.jobId, reprintOfId: entry.reprintOfId, parcelSeq: entry.seq, kind: entry.kind, test: entry.test })), ...(inside.audience === 'floor' ? { deviceId: inside.deviceId } : {}) },
    })
    emit({ type: 'shipping.label_reprinted', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: current.number, jobs: made.length } })
    return { shipmentId: shipment.id, number: current.number, reason: reason.reason, jobs: made }
  })
  return result
}
