import type { Prisma } from '@nexus/factory-db'
import { PRINT_LABELS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { cartonMarks, DEFAULT_MARK_FIELDS, type CartonMarks, type MarkAddress } from '@nexus/factory-domain/shipping/cartons/marks'
import { marksCurrent } from '@nexus/factory-domain/shipping/cartons/rules'
import { netWeightKg, templateFor, type ShippingMarkField } from '@nexus/factory-domain/shipping/packaging/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { marksPdf, marksStockProblems, marksZpl } from '../../../platform/print/layouts/shipping-marks'
import { readPrinter } from '../../../platform/print/printers'
import { tenantOf } from '../cells'
import { readShipment, type ShipmentHeader } from '../store'
import { benchShipment } from './garments'
import { contentsOf, numberedOf, readBench, renumberCartons, type Bench } from './store'

/**
 * A carton's shipping marks printed (B-W2b-384; LOG-013; design floor.pack "Close carton … prints its marks"): the
 * customer's template (else the company's default, else DEFAULT_MARK_FIELDS in the order's language) worded in
 * factory-domain shipping/cartons/marks.ts and laid out in platform/print/layouts/shipping-marks.ts.
 *
 *   printMarks   ZPL on a label printer of the shipment's site (shipping.pack + print.labels there): one print job per carton
 *                (recordType Parcel, label kind CARTON, the marks' code as its scan id); the relay sends it
 *   marksPdfOf   the same marks as one PDF for any printer (shipping.pack)
 *
 * Both take the closed cartons named, else those whose marks are not current (a carton closed since, or "n of N" moved by
 * a carton added or removed); while the shipment is a DRAFT they first give every closed carton its place and the count
 * ("n of N"), then record the marks printed (Parcel.marksPrintedAt) in one command on the Shipment. The order, the
 * customer, the ship-to and the sender are read as the tenant's system for a floor device (the floor reads none of them);
 * what the floor receives is the label itself.
 */

/** What decides a carton's marks, compared again inside the command (a carton changed meanwhile is printed again). */
const fingerprint = (bench: Bench, parcelId: string): string => {
  const parcel = bench.parcels.find((entry) => entry.id === parcelId)!
  return JSON.stringify({ seq: parcel.seq, closed: parcel.cartonNumber !== null, count: bench.parcels.length, gross: parcel.grossWeightKg?.toFixed(4) ?? null, type: parcel.packagingTypeId, contents: contentsOf(bench, parcelId).map((content) => [content.id, content.quantity, content.serials.length]) })
}

/** The cartons whose marks are asked: those named (each closed), else the closed ones whose marks are not current. */
function chosenCartons(bench: Bench, parcelIds: readonly string[] | undefined): Bench['parcels'] {
  const count = bench.parcels.length
  if (parcelIds !== undefined) {
    const chosen = parcelIds.map((id) => bench.parcels.find((parcel) => parcel.id === id))
    if (chosen.some((parcel) => parcel === undefined)) throw new NotFoundError('Carton not found in this shipment.')
    const open = chosen.filter((parcel) => parcel!.cartonNumber === null).map((parcel) => parcel!.seq)
    if (open.length > 0) throw new InvalidStateError(`Carton ${open.join(', ')} is not closed: close it first (its contents and number make its marks).`)
    return chosen as Bench['parcels']
  }
  const due = bench.parcels.filter((parcel) => parcel.cartonNumber !== null && !marksCurrent(numberedOf(parcel), count))
  if (due.length === 0) throw new InvalidStateError("No carton's marks are due: close a carton first, or name the cartons to print again.")
  return due
}

const address = (value: unknown): MarkAddress => (value && typeof value === 'object' ? (value as MarkAddress) : {})

/** The marks of the cartons, read as `reader` (the caller in the office, the tenant's system for a floor device). */
async function marksOf(reader: CommandCaller, shipment: ShipmentHeader, bench: Bench, cartons: Bench['parcels']): Promise<{ parcelId: string; marks: CartonMarks }[]> {
  return reader.withClient(async (client) => {
    const order = await client.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, customerRef: true, language: true } })
    const company = await client.company.findUnique({ where: { id: shipment.companyId }, select: { legalName: true, tradeName: true } })
    const settings = await client.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { senderAddress: true } })
    const templates = await client.shippingMarkTemplate.findMany({ where: { companyId: shipment.companyId, active: true, OR: [{ partyId: shipment.partyId }, { partyId: null }] }, select: { partyId: true, fields: true, language: true, active: true } })
    const header = await client.shipment.findUnique({ where: { id: shipment.id }, select: { shipTo: true } })
    const typeIds = [...new Set(cartons.flatMap((parcel) => (parcel.packagingTypeId ? [parcel.packagingTypeId] : [])))]
    const types = typeIds.length === 0 ? [] : await client.packagingType.findMany({ where: { id: { in: typeIds } }, select: { id: true, tareKg: true } })
    const template = templateFor(templates, shipment.partyId)
    const fields: readonly ShippingMarkField[] = template?.fields ?? DEFAULT_MARK_FIELDS
    const language = template?.language ?? order?.language ?? 'it'
    // A DRAFT's cartons take their place and the count when the marks are recorded; once PACKED their numbers are kept.
    const count = bench.parcels.length
    const draft = shipment.status === 'DRAFT'
    return cartons.map((parcel) => {
      const gross = parcel.grossWeightKg?.toFixed(4) ?? null
      const tare = types.find((type) => type.id === parcel.packagingTypeId)?.tareKg?.toFixed(4) ?? null
      const dimensions = parcel.lengthCm && parcel.widthCm && parcel.heightCm ? { length: parcel.lengthCm.toFixed(2), width: parcel.widthCm.toFixed(2), height: parcel.heightCm.toFixed(2) } : null
      const marks = cartonMarks(fields, language, {
        maker: company?.tradeName || company?.legalName || null,
        sender: settings ? address(settings.senderAddress) : null,
        shipTo: address(header?.shipTo),
        customerOrder: order?.customerRef ?? null,
        orderNumber: order?.number ?? '',
        shipmentNumber: shipment.number,
        cartonNumber: draft ? parcel.seq : (parcel.cartonNumber ?? parcel.seq),
        cartonCount: draft ? count : (parcel.cartonCount ?? count),
        contents: contentsOf(bench, parcel.id),
        grossWeightKg: gross,
        netWeightKg: netWeightKg(gross, tare),
        dimensionsCm: dimensions,
      })
      return { parcelId: parcel.id, marks }
    })
  })
}

/** Inside the command: the cartons as they were when their marks were made, numbered "n of N" (a DRAFT), marks recorded. */
async function recordMarks(
  caller: CommandCaller,
  shipment: ShipmentHeader,
  marked: readonly { parcelId: string; marks: CartonMarks }[],
  fingerprints: ReadonlyMap<string, string>,
  spec: { name: 'shipping.printMarks' | 'shipping.marksPdf'; idempotencyKey: string | undefined; input: object },
  jobsFor: (tools: CommandTools) => Promise<{ jobId: string; parcelId: string }[]>,
): Promise<{ jobs: { jobId: string; parcelId: string }[] }> {
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: { shipmentId: shipment.id, ...spec.input }, record: { type: 'Shipment', id: shipment.id } }, async (tools) => {
    const current = (await readShipment(tools.tx, shipment.id))!
    if (current.status !== 'DRAFT' && current.status !== 'PACKED') throw new InvalidStateError(`The shipment is ${current.status}: its cartons' marks are printed while it is a DRAFT or PACKED.`)
    const now = await readBench(tools.tx, shipment.id)
    if (marked.some((entry) => !now.parcels.some((parcel) => parcel.id === entry.parcelId) || fingerprint(now, entry.parcelId) !== fingerprints.get(entry.parcelId))) {
      throw new ConflictError('A carton changed while its marks were made: print them again.')
    }
    if (current.status === 'DRAFT') await renumberCartons(tools, shipment.id)
    const jobs = await jobsFor(tools)
    for (const entry of marked) {
      await tools.tx.parcel.update({ where: { id: entry.parcelId }, data: { marksPrintedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    }
    tools.audit({ action: spec.name, recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { cartons: marked.map((entry) => ({ parcelId: entry.parcelId, code: entry.marks.code })), jobs: jobs.map((job) => job.jobId) } })
    tools.emit({ type: 'shipment.packing_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, status: current.status, change: 'parcels' } })
    return { jobs }
  })
  return result
}

/** The reader of the marks' facts: the caller in the office, the tenant's system for a floor device. */
const readerOf = (caller: CommandCaller, system: (tenantId: string) => CommandCaller): CommandCaller => {
  const context = caller.factoryContext!
  return context.audience === 'office' ? caller : system(tenantOf(context))
}

export interface PrintMarksBody {
  readonly parcelIds?: readonly string[] | undefined
  readonly printerId?: string | undefined
  readonly copies?: number | undefined
}

/** shipping.pack + print.labels: the cartons' marks as ZPL on a label printer of the shipment's site. */
export async function printMarks(callers: { caller: CommandCaller; system: (tenantId: string) => CommandCaller }, shipmentId: string, body: PrintMarksBody, idempotencyKey?: string) {
  const caller = callers.caller
  const { context, shipment } = await benchShipment(caller, shipmentId)
  const settings = await caller.withClient((client) => client.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { labelPrinterId: true } }))
  const printerId = body.printerId ?? settings?.labelPrinterId ?? null
  if (!printerId) throw new ValidationError('No label printer.', [{ path: 'body/printerId', message: "Choose a label printer, or set the site's (shipping settings); the marks also print as a PDF." }])
  const printer = await readPrinter(caller, printerId)
  if (!can(actorOf(context), PRINT_LABELS, { companyId: printer.companyId, siteId: printer.siteId })) throw new ForbiddenError()
  if (printer.siteId !== shipment.siteId) throw new ValidationError('Not a printer of this site.', [{ path: 'body/printerId', message: "Choose a label printer of the shipment's site." }])
  if (printer.kind !== 'LABEL_ZPL' || printer.dpi === null || printer.labelWidthMm === null || printer.labelHeightMm === null) {
    throw new ValidationError('This printer prints PDFs.', [{ path: 'body/printerId', message: 'Choose a label printer (ZPL); the marks also print as a PDF.' }])
  }
  if (printer.status !== 'ACTIVE') throw new InvalidStateError(`This printer is ${printer.status.toLowerCase()}; it takes no jobs now.`)
  const stock = { dpi: printer.dpi, widthMm: printer.labelWidthMm, heightMm: printer.labelHeightMm }
  const copies = body.copies ?? 1

  const bench = await caller.withClient((client) => readBench(client, shipment.id))
  const cartons = chosenCartons(bench, body.parcelIds)
  const marked = await marksOf(readerOf(caller, callers.system), shipment, bench, cartons)
  const problems = marked.flatMap((entry) => marksStockProblems(entry.marks, stock))
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.slice(0, 1))
  const zpl = new Map(marked.map((entry) => [entry.parcelId, marksZpl(entry.marks, stock, copies)]))
  const fingerprints = new Map(marked.map((entry) => [entry.parcelId, fingerprint(bench, entry.parcelId)]))

  return recordMarks(caller, shipment, marked, fingerprints, { name: 'shipping.printMarks', idempotencyKey, input: body }, async ({ tx, audit, emit, now, context: inside }) => {
    const current = await tx.printer.findUnique({ where: { id: printer.id }, select: { status: true } })
    if (current?.status !== 'ACTIVE') throw new InvalidStateError('This printer takes no jobs now.')
    const requester =
      inside.audience === 'floor'
        ? { requestedById: inside.actorId, deviceId: inside.deviceId, createdById: inside.actorId }
        : inside.audience === 'office'
          ? { requestedById: inside.actorId, deviceId: null, createdById: inside.actorId }
          : { requestedById: null, deviceId: null, createdById: null }
    const jobs: { jobId: string; parcelId: string }[] = []
    for (const entry of marked) {
      const id = newId()
      const data: Prisma.PrintJobUncheckedCreateInput = {
        id,
        companyId: printer.companyId,
        siteId: printer.siteId,
        printerId: printer.id,
        recordType: 'Parcel',
        recordId: entry.parcelId,
        payloadKind: 'ZPL',
        labelKind: 'CARTON',
        scanId: entry.marks.code,
        zpl: zpl.get(entry.parcelId)!,
        copies,
        ...requester,
        createdAt: now,
        updatedAt: now,
      }
      await tx.printJob.create({ data, select: { id: true } })
      audit({ recordType: 'PrintJob', recordId: id, companyId: printer.companyId, siteId: printer.siteId, after: { printerId: printer.id, recordType: 'Parcel', recordId: entry.parcelId, payloadKind: 'ZPL', labelKind: 'CARTON', scanId: entry.marks.code, copies, shipmentId: shipment.id } })
      emit({ type: 'print.job_queued', subject: id, companyId: printer.companyId, siteId: printer.siteId, payload: { jobId: id, printerId: printer.id, payloadKind: 'ZPL' } })
      jobs.push({ jobId: id, parcelId: entry.parcelId })
    }
    return jobs
  })
}

/** shipping.pack: the cartons' marks as one PDF (any printer); recorded as printed. */
export async function marksPdfOf(callers: { caller: CommandCaller; system: (tenantId: string) => CommandCaller }, shipmentId: string, body: { readonly parcelIds?: readonly string[] | undefined; readonly copies?: number | undefined }, idempotencyKey?: string): Promise<{ pdf: Buffer; fileName: string }> {
  const caller = callers.caller
  const { shipment } = await benchShipment(caller, shipmentId)
  const bench = await caller.withClient((client) => readBench(client, shipment.id))
  const cartons = chosenCartons(bench, body.parcelIds)
  const marked = await marksOf(readerOf(caller, callers.system), shipment, bench, cartons)
  const fingerprints = new Map(marked.map((entry) => [entry.parcelId, fingerprint(bench, entry.parcelId)]))
  await recordMarks(caller, shipment, marked, fingerprints, { name: 'shipping.marksPdf', idempotencyKey, input: body }, async () => [])
  const pdf = await marksPdf(marked.map((entry) => entry.marks), body.copies ?? 1)
  const fileName = marked.length === 1 ? `${marked[0]!.marks.code.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` : `${shipment.number.replace(/[^A-Za-z0-9._-]/g, '_')}-marks.pdf`
  return { pdf, fileName }
}
