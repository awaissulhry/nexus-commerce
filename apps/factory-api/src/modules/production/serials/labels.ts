import type { RenderedLabel } from '@nexus/factory-domain/compliance/labels/render'
import { garmentLabelZpl } from '@nexus/factory-domain/compliance/labels/zpl'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_SERIALS } from '@nexus/factory-domain/production/serials/permissions'
import {
  assignBundles,
  batchReprintRefusal,
  gateRefusal,
  planLabels,
  serialReprintRefusal,
  voidRefusal,
  type GarmentSerialStatus,
  type GarmentTracking,
  type LabelRefusal,
} from '@nexus/factory-domain/production/serials/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { PrintJobView } from '../../../platform/print/contract'
import { queueModuleLabel } from '../../../platform/print/jobs'
import { deviceStationOf, scanWorkOrderLock } from '../scans/store'
import { floorRecordSubjectFor } from '../settings/subject'
import {
  assertFloorReady,
  batchIdentification,
  floorOf,
  labelFacts,
  labelPrinter,
  labelSize,
  labelWorkOrder,
  languagesOf,
  mayLabel,
  printDay,
  probeIdentification,
  refuse,
  renderCell,
  serialIdentification,
  serialsPerBundle,
  stockHolds,
  workerOf,
  type CellFacts,
  type Worker,
} from './facts'
import { recordLabelLog } from './label-log'
import { takeSerials } from './numbers'
import { lockLabelCells, lockSerial, readCells, readHeader, readSerial, readSerials, type LabelHeader, type LabelPrinterRow, type SerialRow } from './store'
import { cellStateView, serialView } from './views'

/**
 * Batch or serial at the final operation, and the garment labels behind the certificate gate (B-W1-44; MES-076,
 * PRD-348, QHS-051, PRD-331; PLAN §4.7 stage 13a-labels "batch number and garment label; refused with an expired
 * certificate"; Q31; A2 SCR-096 floor.labels). Each write is ONE command() with its audit rows and events; the rules
 * are factory-domain production/serials/rules; a refusal is a 409 with `refusal/<CODE>` and its fix; the GarmentSerial
 * trigger (…_quality_shipping_guards) stays the last word.
 *
 *   print    the floor (production.serials at its own site, an Idempotency-Key): per cell (or "Print all"), the
 *            finished garments without a label. Lock order: the work order's issue lock SHARED (scans'
 *            scanWorkOrderLock: a complete, close or cancel waits) → the cells' label locks (sorted) → the trigger's
 *            serial-cell lock at the insert. Then: who it names (production/settings floorRecordSubjectFor: at a station
 *            site nobody) → the facts (finished from the scans, labelled from the serials or the label log) → planLabels
 *            (never more than finished) → each cell's label rendered on the day with the work order's FROZEN label
 *            template and revision (garmentLabelFor, the certificate gate inside): a cell the gate refuses is refused in
 *            its words and the others print; none prints → 409 with every refusal. A BATCH style: one GarmentLabelPrint
 *            entry per cell (the batch number). A SERIAL style: the tenant's GARMENT_SERIAL scan ids (numbers.ts,
 *            platform/numbering allocateScanIds: its counter's lock last), the GarmentSerial rows MADE with their bundle
 *            (assignBundles → GarmentSerial.bundleId), then an entry per cell naming them (its trigger checks them).
 *   reprint  floor or office: a BATCH cell's labels (at most those printed) or one serial's label, the same batch or
 *            serial, a reason, the certificate gate again; an entry REPRINT (the floor: named by the site's rules).
 *   void     floor or office: a MADE serial with a reason (the row locked FOR UPDATE first); a RELEASED one only through
 *            its release's reversal (B-W1-45), never a SHIPPED one.
 * After the command each label is rendered again (the gate on the day) and queued on the label printer (platform/print
 * queueModuleLabel, label kind GARMENT): a BATCH cell as one job of `count` copies (record WorkOrderSize, id = the batch
 * number), a serial as one job each (record GarmentSerial, id = the serial), under a key made of the log entry, so a
 * resent request queues no label twice. Floor print and reprint first need the site's floor to be ready (platform/privacy
 * floorReadinessFor, read as the tenant's system caller). Printing PPE labels is NOT a signing act (the release is,
 * B-W1-45): no floor step-up is asked, so a size prints in 2 taps.
 */

const postedBy = (context: Worker) => (context.audience === 'floor' ? 'FLOOR' : 'OFFICE')
const scopeOf = (header: LabelHeader) => ({ companyId: header.companyId, siteId: header.siteId })
const deviceOf = (context: Worker): string | null => (context.audience === 'floor' ? context.deviceId : null)

/**
 * Who a label log entry names: the office user; on the floor the worker where the site names workers and the worker
 * acknowledged the notice (production/settings floorRecordSubjectFor: 409 in words otherwise), nobody at a station site.
 */
async function namedBy(tools: CommandTools, siteId: string): Promise<string | null> {
  const context = tools.context as Worker
  if (context.audience === 'office') return context.actorId
  const subject = await floorRecordSubjectFor(tools.tx, { siteId, workerId: context.actorId, stationId: await deviceStationOf(tools.tx, context.deviceId) })
  return subject.workerId ? context.actorId : null
}

// ---- printing after the command ------------------------------------------------------------------------------------------------

export interface PrintedSerial {
  readonly id: string
  readonly serial: string
  readonly bundleId: string | null
}

/** One cell's labels as the command decided them (kept in the receipt: a resend queues the same jobs). */
export interface PrintedLine {
  readonly entryId: string
  readonly workOrderSizeId: string
  readonly colourwayCode: string
  readonly size: string
  readonly count: number
  readonly batchNumber: string
  /** SERIAL: one label each. */
  readonly serials: readonly PrintedSerial[]
}

export interface QueuedLabel {
  readonly job: PrintJobView | null
  /** Why no job was queued (the gate refused on the day, the printer refused …). */
  readonly problem: string | null
}

async function queueLabel(caller: CommandCaller, printer: LabelPrinterRow, label: RenderedLabel, job: { recordType: string; recordId: string; copies: number; scanId: string }, key: string): Promise<QueuedLabel> {
  const size = label.fit ? labelSize(label.fit) : null
  try {
    const queued = await queueModuleLabel(
      caller,
      {
        printerId: printer.id,
        recordType: job.recordType,
        recordId: job.recordId,
        copies: job.copies,
        labelKind: 'GARMENT',
        scanId: job.scanId,
        zplFor: (stock) => {
          if (!size || !stockHolds({ labelWidthMm: stock.widthMm, labelHeightMm: stock.heightMm }, size)) {
            throw new ValidationError(`This printer holds ${stock.widthMm} × ${stock.heightMm} mm labels; the garment label is ${label.fit?.widthMm ?? '?'} × ${label.fit?.heightMm ?? '?'} mm.`, [{ path: 'body/printerId', message: 'Pick a printer whose label stock holds the garment label.' }])
          }
          return garmentLabelZpl(label, stock.dpi, job.copies)
        },
      },
      key,
    )
    return { job: queued, problem: null }
  } catch (error) {
    // The labels stand in the log; they are printed again later (reprint). Only the print module's refusals are words.
    if (!(error instanceof DomainError)) throw error
    return { job: null, problem: error.message }
  }
}

/**
 * Queues the labels of the lines: each label rendered again with the caller's client on today's date (the certificate
 * gate on the day: a label the gate now refuses is not queued, its words are the problem), a serial no longer live is
 * never printed.
 */
async function printLines(caller: CommandCaller, header: LabelHeader, printer: LabelPrinterRow, lines: readonly PrintedLine[]) {
  const cells = new Map((await caller.withClient((client) => readCells(client, header.id))).map((cell) => [cell.id, cell]))
  const languages = await languagesOf(caller, [...cells.values()])
  const date = printDay(serverClock.now())
  const statusOf = new Map<string, GarmentSerialStatus>()
  const serialIds = lines.flatMap((line) => line.serials.map((serial) => serial.id))
  if (serialIds.length > 0) {
    for (const row of await caller.withClient((client) => client.garmentSerial.findMany({ where: { id: { in: serialIds } }, select: { id: true, status: true } }))) statusOf.set(row.id, row.status as GarmentSerialStatus)
  }
  const answers = []
  for (const line of lines) {
    const cell = cells.get(line.workOrderSizeId)!
    if (line.serials.length === 0) {
      const label = await caller.withClient((client) => renderCell(client, header, cell, batchIdentification(header), date, languages))
      const refusal = gateRefusal({ cellId: cell.id, colourwayCode: line.colourwayCode, size: line.size }, label)
      const queued = refusal ? { job: null, problem: refusal.message } : await queueLabel(caller, printer, label, { recordType: 'WorkOrderSize', recordId: cell.id, copies: line.count, scanId: line.batchNumber }, `garment-labels:${line.entryId}`)
      answers.push({ ...line, serials: [], ...queued })
      continue
    }
    const serials = []
    for (const serial of line.serials) {
      const status = statusOf.get(serial.id)
      if (status === undefined || status === 'VOID' || status === 'SHIPPED') {
        serials.push({ ...serial, job: null, problem: `Serial ${serial.serial} is ${status === undefined ? 'not found' : status.toLowerCase()}: its label is not printed.` })
        continue
      }
      const label = await caller.withClient((client) => renderCell(client, header, cell, serialIdentification(header, serial), date, languages))
      const refusal = gateRefusal({ cellId: cell.id, colourwayCode: line.colourwayCode, size: line.size }, label)
      const queued = refusal ? { job: null, problem: refusal.message } : await queueLabel(caller, printer, label, { recordType: 'GarmentSerial', recordId: serial.id, copies: 1, scanId: serial.serial }, `garment-label:${serial.id}:${line.entryId}`)
      serials.push({ ...serial, ...queued })
    }
    answers.push({ ...line, serials, job: null, problem: serials.every((serial) => serial.problem === null) ? null : 'Some labels were not queued: see each serial.' })
  }
  return answers
}

// ---- print ----------------------------------------------------------------------------------------------------------------------

export interface PrintInput {
  /** Per cell, with a count (default: all the cell's finished garments without a label); absent: "Print all". */
  readonly cells?: readonly { readonly workOrderSizeId: string; readonly count?: number | undefined }[] | undefined
  /** The label printer; absent: the site's only ACTIVE label printer that holds the label. */
  readonly printerId?: string | undefined
}

interface PrintResult {
  readonly workOrder: { readonly id: string; readonly number: string; readonly status: LabelHeader['status']; readonly batchNumber: string }
  readonly tracking: GarmentTracking
  readonly printed: PrintedLine[]
  readonly refused: LabelRefusal[]
}

async function printInCommand(tools: CommandTools, workOrderId: string, body: PrintInput, languages: ReadonlyMap<string, string>): Promise<PrintResult> {
  const context = tools.context as FloorContext
  const { tx } = tools
  await scanWorkOrderLock(tx, context.tenantId, workOrderId)
  const header = await readHeader(tx, workOrderId)
  if (!header || !mayLabel(context, PRODUCTION_SERIALS, header)) throw new NotFoundError('Work order not found.')
  const cellIds = (await readCells(tx, header.id)).map((cell) => cell.id)
  await lockLabelCells(tx, context.tenantId, header.siteId, body.cells ? body.cells.map((cell) => cell.workOrderSizeId).filter((id) => cellIds.includes(id)) : cellIds)
  // Who the serials name: the site's floor rules (409 in words; at a station site nobody).
  const subject = await floorRecordSubjectFor(tx, { siteId: header.siteId, workerId: context.actorId, stationId: await deviceStationOf(tx, context.deviceId) })
  const createdById = subject.workerId ? context.actorId : null

  const facts = await labelFacts(tx, header)
  const tracking = facts.style.tracking
  const plan = planLabels({ workOrder: facts.workOrder, tracking, cells: facts.cells, asks: body.cells ? body.cells.map((cell) => ({ cellId: cell.workOrderSizeId, count: cell.count })) : null })
  if (!plan.ok) return refuse(plan.refusal)

  // The certificate gate per cell, on the day, with the work order's frozen label: a refused size does not stop the others.
  const date = printDay(tools.now)
  const byId = new Map(facts.cells.map((cell) => [cell.cellId, cell]))
  const printable: { cell: CellFacts; count: number }[] = []
  const refused: LabelRefusal[] = []
  for (const line of plan.lines) {
    const cell = byId.get(line.cellId)!
    const identification = tracking === 'BATCH' ? batchIdentification(header) : probeIdentification(header, context.tenantId)
    const refusal = gateRefusal(cell, await renderCell(tx, header, cell, identification, date, languages))
    if (refusal) refused.push(refusal)
    else printable.push({ cell, count: line.count })
  }
  if (printable.length === 0) return refuse(refused[0]!, refused.slice(1))

  const scope = scopeOf(header)
  const printed: PrintedLine[] = []
  if (tracking === 'SERIAL') {
    const total = printable.reduce((sum, { count }) => sum + count, 0)
    const codes = await takeSerials(tools, total)
    const held = serialsPerBundle(await readSerials(tx, header.id))
    let next = 0
    for (const { cell, count } of printable) {
      const bundles = assignBundles(facts.bundles.get(cell.cellId) ?? [], held, count)
      const serials: PrintedSerial[] = bundles.map((bundleId) => {
        const index = next++
        if (bundleId) held.set(bundleId, (held.get(bundleId) ?? 0) + 1)
        return { id: newId(), serial: codes[index]!, bundleId }
      })
      await tx.garmentSerial.createMany({
        data: serials.map((serial) => ({ id: serial.id, siteId: header.siteId, workOrderId: header.id, workOrderSizeId: cell.cellId, serial: serial.serial, bundleId: serial.bundleId, createdAt: tools.now, updatedAt: tools.now, createdById })),
      })
      for (const serial of serials) {
        tools.audit({ recordType: 'GarmentSerial', recordId: serial.id, ...scope, after: { serial: serial.serial, status: 'MADE', workOrderId: header.id, workOrderSizeId: cell.cellId, bundleId: serial.bundleId } })
      }
      printed.push({ entryId: newId(), workOrderSizeId: cell.cellId, colourwayCode: cell.colourwayCode, size: cell.size, count, batchNumber: header.batchNumber!, serials })
    }
  } else {
    for (const { cell, count } of printable) printed.push({ entryId: newId(), workOrderSizeId: cell.cellId, colourwayCode: cell.colourwayCode, size: cell.size, count, batchNumber: header.batchNumber!, serials: [] })
  }

  for (const line of printed) {
    await recordLabelLog(tools, {
      id: line.entryId,
      kind: 'PRINT',
      tracking,
      ...scope,
      workOrderId: header.id,
      cellId: line.workOrderSizeId,
      quantity: line.count,
      batchNumber: line.batchNumber,
      serialIds: line.serials.map((serial) => serial.id),
      printerId: body.printerId ?? null,
      deviceId: context.deviceId,
      createdById,
      reason: null,
    })
    tools.emit({
      type: 'production.garment_labels_printed',
      subject: header.id,
      ...scope,
      payload: { workOrderId: header.id, number: header.number, workOrderSizeId: line.workOrderSizeId, tracking, quantity: line.count, batchNumber: line.batchNumber, serialIds: line.serials.map((serial) => serial.id), postedBy: 'FLOOR' },
    })
  }
  tools.audit({
    recordType: 'WorkOrder',
    recordId: header.id,
    ...scope,
    after: { garmentLabels: printed.map((line) => ({ entryId: line.entryId, workOrderSizeId: line.workOrderSizeId, count: line.count, serials: line.serials.map((serial) => serial.serial) })), refused: refused.map((entry) => ({ workOrderSizeId: entry.cellId, code: entry.code })) },
  })
  return { workOrder: { id: header.id, number: header.number, status: header.status, batchNumber: header.batchNumber! }, tracking, printed, refused }
}

/** The floor's "print the labels" at the final operation: one command, then the labels on the printer. */
export async function printLabels(caller: CommandCaller, workOrderId: string, body: PrintInput, idempotencyKey?: string) {
  floorOf(caller)
  const header = await labelWorkOrder(caller, workOrderId, PRODUCTION_SERIALS)
  await assertFloorReady(caller, header.siteId)
  const printer = await labelPrinter(caller, header, body.printerId)
  const languages = await languagesOf(caller, await caller.withClient((client) => readCells(client, header.id)))
  const outcome = await command(caller, { name: 'production.printGarmentLabels', idempotencyKey, input: { workOrderId, ...body, printerId: printer.id } }, (tools) =>
    printInCommand(tools, workOrderId, { ...body, printerId: printer.id }, languages),
  )
  const { printed, refused, ...rest } = outcome.result
  return {
    ...rest,
    refused: refused.map((entry) => ({ code: entry.code, message: entry.message, fix: entry.fix, workOrderSizeId: entry.cellId })),
    printerId: printer.id,
    printed: await printLines(caller, header, printer, printed),
    cells: await cellStateView(caller, header),
    replayed: outcome.replayed,
  }
}

// ---- reprint --------------------------------------------------------------------------------------------------------------------

export interface ReprintCellInput {
  readonly workOrderSizeId: string
  readonly count: number
  readonly reason: string
  readonly printerId?: string | undefined
}

/** A BATCH cell's labels printed again with the batch number (at most those printed), with a reason. */
export async function reprintCellLabels(caller: CommandCaller, workOrderId: string, body: ReprintCellInput, idempotencyKey?: string) {
  const context = workerOf(caller)
  const header = await labelWorkOrder(caller, workOrderId, PRODUCTION_SERIALS)
  if (context.audience === 'floor') await assertFloorReady(caller, header.siteId)
  const printer = await labelPrinter(caller, header, body.printerId)
  const languages = await languagesOf(caller, await caller.withClient((client) => readCells(client, header.id)))
  const reason = body.reason.trim()
  const outcome = await command(caller, { name: 'production.reprintGarmentLabels', idempotencyKey, input: { workOrderId, ...body, reason, printerId: printer.id } }, async (tools) => {
    const { tx } = tools
    await scanWorkOrderLock(tx, context.tenantId, workOrderId)
    const current = await readHeader(tx, workOrderId)
    if (!current || !mayLabel(context, PRODUCTION_SERIALS, current)) throw new NotFoundError('Work order not found.')
    await lockLabelCells(tx, context.tenantId, current.siteId, [body.workOrderSizeId])
    const createdById = await namedBy(tools, current.siteId)
    const facts = await labelFacts(tx, current)
    const cell = facts.cells.find((row) => row.cellId === body.workOrderSizeId)
    const refusal = batchReprintRefusal({ workOrder: current, tracking: facts.style.tracking, cell, cellId: body.workOrderSizeId, count: body.count })
    if (refusal) refuse(refusal)
    const gate = gateRefusal(cell!, await renderCell(tx, current, cell!, batchIdentification(current), printDay(tools.now), languages))
    if (gate) refuse(gate)
    const scope = scopeOf(current)
    const entryId = newId()
    await recordLabelLog(tools, { id: entryId, kind: 'REPRINT', tracking: 'BATCH', ...scope, workOrderId: current.id, cellId: cell!.cellId, quantity: body.count, batchNumber: current.batchNumber!, serialIds: [], printerId: printer.id, deviceId: deviceOf(context), createdById, reason })
    tools.audit({ recordType: 'WorkOrder', recordId: current.id, ...scope, after: { garmentLabelsReprinted: { entryId, workOrderSizeId: cell!.cellId, count: body.count } }, reason })
    tools.emit({
      type: 'production.garment_labels_reprinted',
      subject: current.id,
      ...scope,
      payload: { workOrderId: current.id, number: current.number, workOrderSizeId: cell!.cellId, tracking: 'BATCH', quantity: body.count, serialIds: [], postedBy: postedBy(context) },
    })
    const line: PrintedLine = { entryId, workOrderSizeId: cell!.cellId, colourwayCode: cell!.colourwayCode, size: cell!.size, count: body.count, batchNumber: current.batchNumber!, serials: [] }
    return { workOrder: { id: current.id, number: current.number, status: current.status, batchNumber: current.batchNumber! }, reprinted: line }
  })
  const [answer] = await printLines(caller, header, printer, [outcome.result.reprinted])
  return { workOrder: outcome.result.workOrder, printerId: printer.id, reprinted: answer!, cells: await cellStateView(caller, header), replayed: outcome.replayed }
}

/** The serial a reprint or void names, visible to the caller with the permission (else not found). */
async function namedSerial(caller: CommandCaller, serialId: string): Promise<{ serial: SerialRow; header: LabelHeader }> {
  const context = workerOf(caller)
  const serial = await caller.withClient((client) => readSerial(client, serialId))
  const header = serial ? await caller.withClient((client) => readHeader(client, serial.workOrderId)) : null
  if (!serial || !header || !mayLabel(context, PRODUCTION_SERIALS, header)) throw new NotFoundError('Serial not found.')
  return { serial, header }
}

/** One serial's label printed again (the same serial), with a reason. */
export async function reprintSerial(caller: CommandCaller, serialId: string, body: { readonly reason: string; readonly printerId?: string | undefined }, idempotencyKey?: string) {
  const context = workerOf(caller)
  const { header } = await namedSerial(caller, serialId)
  if (context.audience === 'floor') await assertFloorReady(caller, header.siteId)
  const printer = await labelPrinter(caller, header, body.printerId)
  const languages = await languagesOf(caller, await caller.withClient((client) => readCells(client, header.id)))
  const reason = body.reason.trim()
  const outcome = await command(caller, { name: 'production.reprintGarmentSerial', idempotencyKey, input: { serialId, ...body, reason, printerId: printer.id } }, async (tools) => {
    const { tx } = tools
    const serial = await lockSerial(tx, serialId)
    if (!serial) throw new NotFoundError('Serial not found.')
    const current = (await readHeader(tx, serial.workOrderId))!
    const refusal = serialReprintRefusal({ workOrder: current, serial: { serial: serial.serial, status: serial.status as GarmentSerialStatus, workOrderSizeId: serial.workOrderSizeId } })
    if (refusal) refuse(refusal)
    const createdById = await namedBy(tools, current.siteId)
    const facts = await labelFacts(tx, current)
    const cell = facts.cells.find((row) => row.cellId === serial.workOrderSizeId)!
    const gate = gateRefusal(cell, await renderCell(tx, current, cell, serialIdentification(current, serial), printDay(tools.now), languages))
    if (gate) refuse(gate)
    const scope = scopeOf(current)
    const entryId = newId()
    const printedSerial: PrintedSerial = { id: serial.id, serial: serial.serial, bundleId: serial.bundleId }
    await recordLabelLog(tools, { id: entryId, kind: 'REPRINT', tracking: 'SERIAL', ...scope, workOrderId: current.id, cellId: cell.cellId, quantity: 1, batchNumber: current.batchNumber!, serialIds: [serial.id], printerId: printer.id, deviceId: deviceOf(context), createdById, reason })
    tools.audit({ recordType: 'GarmentSerial', recordId: serial.id, ...scope, after: { labelReprinted: { entryId, serial: serial.serial } }, reason })
    tools.emit({
      type: 'production.garment_labels_reprinted',
      subject: current.id,
      ...scope,
      payload: { workOrderId: current.id, number: current.number, workOrderSizeId: cell.cellId, tracking: 'SERIAL', quantity: 1, serialIds: [serial.id], postedBy: postedBy(context) },
    })
    const line: PrintedLine = { entryId, workOrderSizeId: cell.cellId, colourwayCode: cell.colourwayCode, size: cell.size, count: 1, batchNumber: current.batchNumber!, serials: [printedSerial] }
    return { reprinted: line }
  })
  const [answer] = await printLines(caller, header, printer, [outcome.result.reprinted])
  const serial = (await caller.withClient((client) => readSerial(client, serialId)))!
  return { serial: serialView(serial, null, null), printerId: printer.id, reprinted: answer!, replayed: outcome.replayed }
}

// ---- void -------------------------------------------------------------------------------------------------------------------------

/** A MADE serial voided (a spoilt label, a garment scrapped), with a reason: its cell has one more garment to label. */
export async function voidSerial(caller: CommandCaller, serialId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  const context = workerOf(caller)
  const { header } = await namedSerial(caller, serialId)
  const reason = body.reason.trim()
  const { result, replayed } = await command(caller, { name: 'production.voidGarmentSerial', idempotencyKey, input: { serialId, reason } }, async (tools) => {
    const { tx } = tools
    // The row locked first: a release, packing or reprint of it that locked it before is committed, and seen here.
    const serial = await lockSerial(tx, serialId)
    if (!serial) throw new NotFoundError('Serial not found.')
    const current = (await readHeader(tx, serial.workOrderId))!
    const refusal = voidRefusal({ serial: serial.serial, status: serial.status as GarmentSerialStatus, workOrderSizeId: serial.workOrderSizeId })
    if (refusal) refuse(refusal)
    await tx.garmentSerial.update({ where: { id: serial.id }, data: { status: 'VOID', voidedAt: tools.now, voidReason: reason, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    const scope = scopeOf(current)
    tools.audit({ recordType: 'GarmentSerial', recordId: serial.id, ...scope, before: { status: serial.status }, after: { status: 'VOID', serial: serial.serial, workOrderSizeId: serial.workOrderSizeId }, reason })
    tools.audit({ recordType: 'WorkOrder', recordId: current.id, ...scope, after: { serialVoided: { serialId: serial.id, serial: serial.serial, workOrderSizeId: serial.workOrderSizeId } }, reason })
    tools.emit({
      type: 'production.garment_serial_voided',
      subject: current.id,
      ...scope,
      payload: { workOrderId: current.id, number: current.number, workOrderSizeId: serial.workOrderSizeId, serialId: serial.id, serial: serial.serial, postedBy: postedBy(context) },
    })
    const after = (await readSerial(tx, serial.id))!
    return { serial: { id: after.id, serial: after.serial, status: after.status, workOrderSizeId: after.workOrderSizeId, voidedAt: after.voidedAt ? toUtcIso(after.voidedAt) : null, voidReason: after.voidReason } }
  })
  const serial = (await caller.withClient((client) => readSerial(client, result.serial.id)))!
  const cells = await cellStateView(caller, header)
  return { serial: serialView(serial, null, null), cell: cells.find((cell) => cell.workOrderSizeId === serial.workOrderSizeId)!, replayed }
}

