import { PRINT_LABELS } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Identification, RenderedLabel } from '@nexus/factory-domain/compliance/labels/render'
import { hundredthsOf, mmText } from '@nexus/factory-domain/compliance/labels/rules'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { MAX_SCAN_REF, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { finalOperationOf } from '@nexus/factory-domain/production/scans/rules'
import {
  finishedBundles,
  labelState,
  labelsReadyRefusal,
  printedPerCell,
  serialText,
  type FinishedBundle,
  type LabelCell,
  type LabelRefusal,
  type LabelWorkOrder,
} from '@nexus/factory-domain/production/serials/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { systemContext } from '../../../platform/outbox/system'
import { floorReadinessFor } from '../../../platform/privacy/read'
import { readPrinter } from '../../../platform/print/printers'
import { garmentLabelFor } from '../../compliance/labels/preview'
import { scanProgressOf } from '../scans/progress'
import { readOperations, readWorkOrderBundles, readWorkOrderScans } from '../scans/store'
import { readLabelLog, type LabelLogEntry } from './label-log'
import { buyerLanguages, liveSerialsPerCell, readCells, readHeader, readLabelPrinters, readStyle, readTemplateSize, type CellRow, type LabelHeader, type LabelPrinterRow, type Reader, type SerialRow, type StyleFacts } from './store'

/**
 * What the garment label step knows about a work order (B-W1-44), read the same way by its commands (inside their
 * transaction, after the cells' label locks) and its screens: who may work on it, its cells' finished, labelled and
 * still-to-label garments, the bundles finished garments came in, the label of a cell rendered with the certificate gate
 * on the day (compliance/labels garmentLabelFor), the label printer, the buyers' languages, and the refusal error. Every
 * read runs as the caller (row-level security keeps a floor device to its own site); only the readiness gate and the
 * buyers' languages are read in the tenant's system context.
 */

export type Worker = FloorContext | OfficeContext

/** A label refused by its rule (factory-domain production/serials/rules): a 409 with `refusal/<CODE>`, the fix, and the other cells' refusals. */
export class LabelRefusedError extends ConflictError {
  override name = 'LabelRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly refusal: LabelRefusal,
    readonly others: readonly LabelRefusal[] = [],
  ) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
      ...others.map((other) => ({ path: `cells/${other.cellId ?? 'all'}/${other.code}`, message: other.message })),
    ]
  }
}

export const refuse = (refusal: LabelRefusal, others: readonly LabelRefusal[] = []): never => {
  throw new LabelRefusedError(refusal, others)
}

export function workerOf(caller: Pick<CommandCaller, 'factoryContext'>): Worker {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** May the caller work on this work order with the permission? (A floor device: only at its own site.) */
export function mayLabel(context: Worker, permission: Permission, workOrder: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'floor' && context.siteId !== workOrder.siteId) return false
  return can(actorOf(context), permission, { companyId: workOrder.companyId, siteId: workOrder.siteId })
}

/** The work order the caller labels or reads: one it may reach with the permission (else not found). */
export async function labelWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission): Promise<LabelHeader> {
  const context = workerOf(caller)
  const workOrder = await caller.withClient((client) => readHeader(client, workOrderId))
  if (!workOrder || !mayLabel(context, permission, workOrder)) throw new NotFoundError('Work order not found.')
  return workOrder
}

/** The request in the tenant's system context: the reads the floor role may not make (readiness, the buyers' languages). */
export function asTenantSystem(caller: CommandCaller): CommandCaller {
  const context = caller.factoryContext
  if (!context || !('tenantId' in context) || !context.tenantId) throw new ForbiddenError()
  const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  view.factoryContext = systemContext(context.tenantId, context.requestId)
  return view
}

/**
 * The site's floor is ready for real work (B-W1-36, B-W1-37), or a 409 in the gate's words. The gate reads the DPIA and
 * the legal basis, which the floor role may not: it runs in the tenant's system context.
 */
export async function floorReadyRefusal(caller: CommandCaller, siteId: string): Promise<LabelRefusal | null> {
  return labelsReadyRefusal(await asTenantSystem(caller).withClient((client) => floorReadinessFor(client, siteId, serverClock.now())))
}

export async function assertFloorReady(caller: CommandCaller, siteId: string): Promise<void> {
  const refusal = await floorReadyRefusal(caller, siteId)
  if (refusal) refuse(refusal)
}

/** The day of a print (Europe/Rome): the certificate gate's day. */
export const printDay = (now: Date): BusinessDate => businessDate(now)

// ---- the cells' facts ---------------------------------------------------------------------------------------------------------

export interface CellFacts extends LabelCell {
  readonly colourwayId: string
  readonly colourwayName: string
  readonly partyId: string
  /** Labels printed again (reprints), from the label log. */
  readonly reprinted: number
  readonly toLabel: number
  readonly overLabelled: number
}

export interface LabelFacts {
  readonly header: LabelHeader
  readonly style: StyleFacts
  readonly workOrder: LabelWorkOrder
  readonly cells: CellFacts[]
  readonly finalOperation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string } | null
  /** Whole ACTIVE bundles' finished garments, per cell, oldest bundle first. */
  readonly bundles: ReadonlyMap<string, readonly FinishedBundle[]>
  /** The label log of the work order's cells, oldest first. */
  readonly log: readonly LabelLogEntry[]
}

/** Everything the label rules need, read with `db` (a request's client, or a command's transaction after its locks). */
export async function labelFacts(db: Reader, header: LabelHeader): Promise<LabelFacts> {
  const style = await readStyle(db, header.styleId)
  if (!style) throw new NotFoundError('Work order not found.')
  const rows = await readCells(db, header.id)
  const operations = await readOperations(db, header.id)
  const final = finalOperationOf(operations)
  const progress = await scanProgressOf(db, header)
  const log = await readLabelLog(db, header.id)
  const printed = printedPerCell(log)
  const live = style.tracking === 'SERIAL' ? await liveSerialsPerCell(db, header.id) : new Map<string, number>()
  const bundles = new Map<string, FinishedBundle[]>()
  if (final) {
    const finished = finishedBundles({ operations, bundles: await readWorkOrderBundles(db, header.id), scans: await readWorkOrderScans(db, header.id) })
    for (const bundle of finished) bundles.set(bundle.cellId, [...(bundles.get(bundle.cellId) ?? []), bundle])
  }
  const cells = rows.map((row): CellFacts => {
    const finished = final ? (progress.get(row.id)?.finished ?? 0) : null
    const labelled = style.tracking === 'SERIAL' ? (live.get(row.id) ?? 0) : (printed.get(row.id)?.printed ?? 0)
    return {
      cellId: row.id,
      colourwayId: row.colourwayId,
      colourwayCode: row.colourwayCode,
      colourwayName: row.colourwayName,
      size: row.size,
      quantity: row.quantity,
      partyId: row.partyId,
      finished,
      labelled,
      reprinted: printed.get(row.id)?.reprinted ?? 0,
      ...labelState({ finished, labelled }),
    }
  })
  return {
    header,
    style,
    workOrder: {
      number: header.number,
      status: header.status,
      batchNumber: header.batchNumber,
      labelTemplateId: header.labelTemplateId,
      finalOperation: final ? `Op ${final.seq} ${final.code}` : null,
    },
    cells,
    finalOperation: final ? { id: final.id, seq: final.seq, code: final.code, name: final.name } : null,
    bundles,
    log,
  }
}

/** The live (not VOID) serials each bundle holds (GarmentSerial.bundleId). */
export function serialsPerBundle(serials: readonly Pick<SerialRow, 'status' | 'bundleId'>[]): Map<string, number> {
  const held = new Map<string, number>()
  for (const serial of serials) if (serial.status !== 'VOID' && serial.bundleId) held.set(serial.bundleId, (held.get(serial.bundleId) ?? 0) + 1)
  return held
}

// ---- the label of a cell ---------------------------------------------------------------------------------------------------------

export const batchIdentification = (header: Pick<LabelHeader, 'id' | 'number' | 'batchNumber'>): Identification => ({ kind: 'BATCH', value: header.batchNumber, recordType: 'WorkOrder', recordId: header.id, reference: header.number })

export const serialIdentification = (header: Pick<LabelHeader, 'number'>, serial: { readonly id: string; readonly serial: string }): Identification => ({
  kind: 'SERIAL',
  value: serial.serial,
  recordType: 'GarmentSerial',
  recordId: serial.id,
  reference: header.number,
})

/** Before a serial is taken, the cell's label is checked with the longest serial text (the label's fit holds for every serial). */
export const probeIdentification = (header: Pick<LabelHeader, 'number'>, tenantId: string): Identification => ({
  kind: 'SERIAL',
  value: serialText(tenantTag(tenantId), MAX_SCAN_REF),
  recordType: 'GarmentSerial',
  recordId: null,
  reference: header.number,
})

/** The real garment label of a cell on the day, the certificate gate included (B-W1-19's garmentLabelFor; no permission checked there). */
export async function renderCell(db: Reader, header: LabelHeader, cell: Pick<CellFacts, 'colourwayId' | 'size' | 'partyId'>, identification: Identification, date: BusinessDate, languages: ReadonlyMap<string, string>): Promise<RenderedLabel> {
  const language = languages.get(cell.partyId)
  return garmentLabelFor(db, {
    labelTemplateId: header.labelTemplateId!,
    styleId: header.styleId,
    styleRevisionId: header.styleRevisionId,
    colourwayId: cell.colourwayId,
    size: cell.size,
    identification,
    manufactured: header.releasedAt ? { date: businessDate(header.releasedAt), recordType: 'WorkOrder', recordId: header.id, reference: header.number } : null,
    date,
    marketLanguages: language ? [language] : [],
  })
}

/** The cells' buyers' languages (partyId → language): the office reads them, the floor through the tenant's system context. */
export async function languagesOf(caller: CommandCaller, cells: readonly Pick<CellRow, 'partyId'>[]): Promise<Map<string, string>> {
  const context = workerOf(caller)
  const reader = context.audience === 'office' ? caller : asTenantSystem(caller)
  return reader.withClient((client) => buyerLanguages(client, cells.map((cell) => cell.partyId)))
}

// ---- the label printer ---------------------------------------------------------------------------------------------------------

const NO_PRINTER: LabelRefusal = {
  code: 'NO_PRINTER',
  message: 'This site has no active label printer: garment labels print only on a label printer, so that every label is logged.',
  fix: "Ask the office to add or resume the site's label printer.",
  cellId: null,
}

/** The label's size in hundredths of a millimetre, or null when it is not readable. */
export function labelSize(template: { readonly widthMm: string; readonly heightMm: string }): { width: number; height: number } | null {
  const width = hundredthsOf(template.widthMm)
  const height = hundredthsOf(template.heightMm)
  return width === null || height === null ? null : { width, height }
}

export const stockHolds = (printer: { readonly labelWidthMm: number | null; readonly labelHeightMm: number | null }, size: { width: number; height: number }): boolean =>
  printer.labelWidthMm !== null && printer.labelHeightMm !== null && printer.labelWidthMm * 100 >= size.width && printer.labelHeightMm * 100 >= size.height

/**
 * The label printer the garment labels go to, checked BEFORE anything is written: the one asked (an ACTIVE label printer
 * of the work order's site whose stock holds the label, where the caller prints labels), or, when none is named, the
 * site's only ACTIVE label printer whose stock holds the label (several: the caller chooses). No printer: 409 NO_PRINTER
 * (no PDF fallback: every garment label is a logged print job).
 */
export async function labelPrinter(caller: CommandCaller, header: LabelHeader, printerId: string | undefined): Promise<LabelPrinterRow> {
  const context = workerOf(caller)
  const template = header.labelTemplateId ? await caller.withClient((client) => readTemplateSize(client, header.labelTemplateId!)) : null
  const size = template ? labelSize(template) : null
  const words = template && size ? `label ${template.code} r${template.revision} is ${mmText(size.width)} × ${mmText(size.height)} mm` : 'the label has no readable size'
  const printers = await caller.withClient((client) => readLabelPrinters(client, header.siteId))
  let printer: LabelPrinterRow | undefined
  if (printerId === undefined) {
    if (printers.length === 0) refuse(NO_PRINTER)
    const fitting = size ? printers.filter((row) => stockHolds(row, size)) : []
    if (fitting.length === 1) printer = fitting[0]
    else if (fitting.length === 0) throw new ValidationError(`No label printer of this site holds the garment label: ${words}.`, [{ path: 'body/printerId', message: 'Load a wider label stock, or ask the office to change the label size.' }])
    else throw new ValidationError(`This site has ${fitting.length} label printers that hold the garment label: choose one.`, [{ path: 'body/printerId', message: 'Name the label printer.' }])
  } else {
    printer = printers.find((row) => row.id === printerId)
    if (!printer) {
      const row = await readPrinter(caller, printerId)
      if (row.siteId !== header.siteId || row.kind !== 'LABEL_ZPL') throw new ValidationError('Garment labels print on a label printer of the work order’s site.', [{ path: 'body/printerId', message: 'Pick a label printer of this site.' }])
      throw new InvalidStateError(`Printer ${row.code} is ${row.status.toLowerCase()}; it takes no labels now. Pick another.`)
    }
    if (!size || !stockHolds(printer, size)) {
      throw new ValidationError(`Printer ${printer.code} holds ${printer.labelWidthMm} × ${printer.labelHeightMm} mm labels; ${words}.`, [{ path: 'body/printerId', message: 'Pick a printer whose label stock holds the garment label.' }])
    }
  }
  if (!can(actorOf(context), PRINT_LABELS, { companyId: printer!.companyId, siteId: printer!.siteId })) throw new ForbiddenError()
  return printer!
}
