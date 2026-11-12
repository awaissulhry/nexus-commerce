import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { SALES_RETURNS_MANAGE, SALES_RETURNS_RECEIVE, SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { OPEN_RETURN_STATUSES, RECEIVING_STATUSES } from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { asTenantSystem } from '../../production/bundles/codes'
import { dockReturn, officeReturn } from '../returns/access'
import { lockReturn, touchReturn } from '../returns/rma'
import { FLOOR_LINE_COLUMNS, LINE_RECORD, lineKeyOf, soldFactsOf, type FloorLineRow, type Reader } from '../returns/store'

/**
 * Serial, size and lot on every return line (B-W2b-341; SAL-336 "batch traceability exists through the work order"; design
 * rma.lines "Serial or lot", floor.returnsin "Scan each garment's serial or batch label to match a line"): the garment of
 * ours a line takes back, from what shipped. A line's lot is the batch of the work order that made the garments shipped on
 * its order line and size (ReturnLine.garmentBatch → WorkOrder.batchNumber); its serial a GarmentSerial that shipped on
 * them (garmentSerial; a serial names one garment, so only a one-piece line takes one). The size is the line's own (W2a).
 * W2a's typed `serial` / `batchNumber` stay as the customer or the dock read them.
 *
 *   GET  …/:returnId/lines/:lineId/garments  (sales.returns.view) the batches and serials that shipped on the line's order
 *                                            line and size to this customer; the one to name when only one shipped
 *   PUT  …/:returnId/lines/:lineId/garment   (sales.returns.manage) the serial and lot named (or cleared) while the RMA is
 *                                            open: a serial that shipped on the line, its own batch
 *   POST …/:returnId/garments/fill           (sales.returns.manage) every line without a lot gets it where only one batch
 *                                            shipped on it (and its serial where one garment came of one serial)
 *   POST …/:returnId/garments/scan           (sales.returns.receive: office, and the dock at its own site) a garment's
 *                                            serial label scanned: its line gets the lot (and the serial, a one-piece line)
 */

export interface Shipped {
  readonly batches: { readonly batchNumber: string; readonly workOrderId: string; readonly pieces: number }[]
  readonly serials: { readonly serial: string; readonly batchNumber: string | null; readonly status: string }[]
}

type LineKey = Pick<FloorLineRow, 'salesOrderLineId' | 'invoiceLineId' | 'size'>

/** The order line and size a line takes back (an invoice line's own when it names no order line). */
async function orderLineOf(db: Reader, line: LineKey): Promise<{ orderLineId: string; size: string | null } | null> {
  if (line.salesOrderLineId) return { orderLineId: line.salesOrderLineId, size: line.size }
  if (!line.invoiceLineId) return null
  const billed = await db.invoiceLine.findUnique({ where: { id: line.invoiceLineId }, select: { salesOrderLineId: true, size: true } })
  return billed?.salesOrderLineId ? { orderLineId: billed.salesOrderLineId, size: billed.size } : null
}

/** What shipped of a line's order line and size to the customer: the batches with their pieces, the serials. */
export async function shippedOf(db: Reader, rma: { readonly companyId: string; readonly partyId: string }, line: LineKey): Promise<Shipped> {
  const sold = await orderLineOf(db, line)
  if (!sold) return { batches: [], serials: [] }
  const rows = await db.shipmentLine.findMany({
    where: { salesOrderLineId: sold.orderLineId, partyId: rma.partyId, ...(sold.size ? { size: sold.size } : {}), shipment: { companyId: rma.companyId, status: { in: ['SHIPPED', 'DELIVERED'] } } },
    select: { id: true, workOrderId: true, quantity: true },
  })
  if (rows.length === 0) return { batches: [], serials: [] }
  const orders = await db.workOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workOrderId))] } }, select: { id: true, batchNumber: true } })
  const batchOf = new Map(orders.map((order) => [order.id, order.batchNumber]))
  const pieces = new Map<string, number>()
  for (const row of rows) pieces.set(row.workOrderId, (pieces.get(row.workOrderId) ?? 0) + row.quantity)
  const serials = await db.garmentSerial.findMany({ where: { shipmentLineId: { in: rows.map((row) => row.id) } }, select: { serial: true, workOrderId: true, status: true }, orderBy: [{ serial: 'asc' }] })
  return {
    batches: [...pieces.entries()].flatMap(([workOrderId, count]) => {
      const batchNumber = batchOf.get(workOrderId)
      return batchNumber ? [{ batchNumber, workOrderId, pieces: count }] : []
    }).sort((a, b) => a.batchNumber.localeCompare(b.batchNumber)),
    serials: serials.map((row) => ({ serial: row.serial, batchNumber: batchOf.get(row.workOrderId) ?? null, status: row.status })),
  }
}

/** The serial and lot to name when the shipment says it alone (one batch; one serial for a one-piece line). */
export function suggestedOf(shipped: Shipped, quantity: number): { garmentBatch: string | null; garmentSerial: string | null } {
  const serial = quantity === 1 && shipped.serials.length === 1 ? shipped.serials[0]! : null
  return { garmentBatch: serial?.batchNumber ?? (shipped.batches.length === 1 ? shipped.batches[0]!.batchNumber : null), garmentSerial: serial?.serial ?? null }
}

async function lineOf(db: Reader, returnId: string, lineId: string): Promise<FloorLineRow> {
  const line = isUuid(lineId) ? await db.returnLine.findFirst({ where: { id: lineId, returnId }, select: FLOOR_LINE_COLUMNS }) : null
  if (!line) throw new NotFoundError('Return line not found.')
  return line
}

/** GET /sales/returns/:returnId/lines/:lineId/garments */
export async function lineGarments(caller: CommandCaller, returnId: string, lineId: string) {
  const { rma } = await officeReturn(caller, returnId, SALES_RETURNS_VIEW)
  return caller.withClient(async (client) => {
    const line = await lineOf(client, rma.id, lineId)
    const shipped = await shippedOf(client, rma, line)
    return {
      line: { id: line.id, seq: line.seq, size: line.size, quantity: line.quantity, serial: line.serial, batchNumber: line.batchNumber, garmentSerial: line.garmentSerial, garmentBatch: line.garmentBatch },
      shipped,
      suggested: suggestedOf(shipped, line.quantity),
    }
  })
}

/** The problems of naming `serial` and `batch` on a line, from what shipped (each at its field). */
export function garmentProblems(line: Pick<FloorLineRow, 'seq' | 'quantity'>, shipped: Shipped, serial: string | null, batch: string | null): Issue[] {
  const problems: Issue[] = []
  const found = serial ? shipped.serials.find((entry) => entry.serial === serial) : undefined
  if (serial) {
    if (!found) problems.push({ path: 'body/garmentSerial', message: `Serial ${serial} did not ship to this customer on line ${line.seq}'s order line and size.` })
    else if (line.quantity !== 1) problems.push({ path: 'body/garmentSerial', message: `A serial names one garment: line ${line.seq} takes back ${line.quantity} pieces. Name its lot.` })
  }
  if (batch) {
    if (!shipped.batches.some((entry) => entry.batchNumber === batch)) problems.push({ path: 'body/garmentBatch', message: `Batch ${batch} did not ship to this customer on line ${line.seq}'s order line and size${shipped.batches.length > 0 ? ` (shipped: ${shipped.batches.map((entry) => entry.batchNumber).join(', ')})` : ''}.` })
    else if (found && found.batchNumber !== batch) problems.push({ path: 'body/garmentBatch', message: `Serial ${serial} is of batch ${found.batchNumber ?? '(none)'}, not of batch ${batch}.` })
  }
  return problems
}

async function writeGarment(tools: CommandTools, rma: { readonly id: string; readonly companyId: string; readonly siteId: string }, line: FloorLineRow, next: { garmentSerial: string | null; garmentBatch: string | null }, via: 'OFFICE' | 'DOCK'): Promise<boolean> {
  if (next.garmentSerial === line.garmentSerial && next.garmentBatch === line.garmentBatch) return false
  await tools.tx.returnLine.update({ where: { id: line.id }, data: { garmentSerial: next.garmentSerial, garmentBatch: next.garmentBatch, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: via === 'DOCK' ? 'returnsDepth.scanGarment' : 'returnsDepth.nameGarment', recordType: LINE_RECORD, recordId: line.id, companyId: rma.companyId, siteId: rma.siteId, before: { garmentSerial: line.garmentSerial, garmentBatch: line.garmentBatch }, after: next })
  return true
}

/** PUT /sales/returns/:returnId/lines/:lineId/garment */
export async function nameGarment(caller: CommandCaller, returnId: string, lineId: string, body: { readonly version: number; readonly garmentSerial?: string | null | undefined; readonly garmentBatch?: string | null | undefined }, idempotencyKey?: string) {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  const { result } = await command(caller, { name: 'returnsDepth.nameGarment', idempotencyKey, input: { returnId, lineId, ...body } }, async (tools) => {
    const rma = await lockReturn(tools, seen.id, body.version, OPEN_RETURN_STATUSES, 'the garment of a line is named')
    const line = await lineOf(tools.tx, rma.id, lineId)
    const shipped = await shippedOf(tools.tx, rma, line)
    const serial = body.garmentSerial === undefined ? line.garmentSerial : body.garmentSerial?.trim() || null
    const named = serial ? shipped.serials.find((entry) => entry.serial === serial) : undefined
    // The serial's own batch when the lot is not named with it.
    const batch = body.garmentBatch === undefined ? (body.garmentSerial !== undefined && named ? named.batchNumber : line.garmentBatch) : body.garmentBatch?.trim() || null
    const problems = garmentProblems(line, shipped, serial, batch)
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The garment cannot be named like this.', problems)
    const changed = await writeGarment(tools, rma, line, { garmentSerial: serial, garmentBatch: batch }, 'OFFICE')
    if (changed) {
      await touchReturn(tools, rma)
      tools.emit({ type: 'return.garment_named', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineIds: [line.id], via: 'OFFICE' } })
    }
    return { line: { id: line.id, seq: line.seq, garmentSerial: serial, garmentBatch: batch }, changed }
  })
  return result
}

/** POST /sales/returns/:returnId/garments/fill */
export async function fillGarments(caller: CommandCaller, returnId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  const { result } = await command(caller, { name: 'returnsDepth.fillGarments', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const rma = await lockReturn(tools, seen.id, body.version, OPEN_RETURN_STATUSES, 'the garments of its lines are named')
    const lines = await tools.tx.returnLine.findMany({ where: { returnId: rma.id }, select: FLOOR_LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const filled: { lineId: string; seq: number; garmentBatch: string | null; garmentSerial: string | null }[] = []
    const toPick: { lineId: string; seq: number; batches: number; serials: number }[] = []
    for (const line of lines) {
      if (line.garmentBatch !== null) continue
      const shipped = await shippedOf(tools.tx, rma, line)
      const suggested = suggestedOf(shipped, line.quantity)
      if (suggested.garmentBatch === null) {
        toPick.push({ lineId: line.id, seq: line.seq, batches: shipped.batches.length, serials: shipped.serials.length })
        continue
      }
      const next = { garmentBatch: suggested.garmentBatch, garmentSerial: line.garmentSerial ?? suggested.garmentSerial }
      if (garmentProblems(line, shipped, next.garmentSerial, next.garmentBatch).length > 0) {
        toPick.push({ lineId: line.id, seq: line.seq, batches: shipped.batches.length, serials: shipped.serials.length })
        continue
      }
      if (await writeGarment(tools, rma, line, next, 'OFFICE')) filled.push({ lineId: line.id, seq: line.seq, ...next })
    }
    if (filled.length > 0) {
      await touchReturn(tools, rma)
      tools.emit({ type: 'return.garment_named', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineIds: filled.map((entry) => entry.lineId), via: 'OFFICE' } })
    }
    return { filled, toPick }
  })
  return result
}

/** POST /sales/returns/:returnId/garments/scan */
export async function scanGarment(caller: CommandCaller, returnId: string, body: { readonly version: number; readonly code: string }, idempotencyKey?: string) {
  const { context, rma: seen } = await dockReturn(caller, returnId, SALES_RETURNS_RECEIVE)
  const code = body.code.trim()
  if (code === '' || code.length > 100) throw new ValidationError("Scan the garment's serial label.", [{ path: 'body/code', message: "The serial on the garment's label." }])
  // The garment and its line, read in the tenant's system scope for the floor (it reads no sales order, shipment or
  // serial): only this RMA's lines are matched, and nothing but their ids, the serial and its batch leaves this read.
  const reader = context.audience === 'floor' ? asTenantSystem(caller, context) : caller
  const match = await reader.withClient(async (client) => {
    const lines = await client.returnLine.findMany({ where: { returnId: seen.id }, select: FLOOR_LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const rma = await client.returnAuthorisation.findUnique({ where: { id: seen.id }, select: { companyId: true, partyId: true } })
    if (!rma) return null
    const sold = await soldFactsOf(client, lines)
    for (const line of lines) {
      if (!sold.get(lineKeyOf(line))?.orderLine && !line.salesOrderLineId) continue
      const shipped = await shippedOf(client, rma, line)
      const found = shipped.serials.find((entry) => entry.serial === code)
      if (found) return { lineId: line.id, serial: found.serial, batchNumber: found.batchNumber }
    }
    return null
  })
  if (!match) throw new NotFoundError(`Serial ${code} is not a garment of this return: put it aside and tell customer service.`)
  const { result } = await command(caller, { name: 'returnsDepth.scanGarment', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const rma = await lockReturn(tools, seen.id, body.version, RECEIVING_STATUSES, 'a garment is scanned')
    const line = await lineOf(tools.tx, rma.id, match.lineId)
    if (line.garmentSerial !== null && line.garmentSerial !== match.serial) throw new DomainError('conflict', `Line ${line.seq} names serial ${line.garmentSerial} already: this garment (${match.serial}) is not the one it takes back.`)
    const next = { garmentBatch: match.batchNumber ?? line.garmentBatch, garmentSerial: line.quantity === 1 ? match.serial : line.garmentSerial }
    const changed = await writeGarment(tools, rma, line, next, 'DOCK')
    let version = rma.version
    if (changed) {
      version = (await touchReturn(tools, rma)).version
      tools.emit({ type: 'return.garment_named', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineIds: [line.id], via: 'DOCK' } })
    }
    return {
      line: { id: line.id, seq: line.seq, garmentSerial: next.garmentSerial, garmentBatch: next.garmentBatch },
      named: line.quantity === 1 ? ('SERIAL_AND_LOT' as const) : ('LOT_ONLY' as const),
      words: line.quantity === 1 ? `Line ${line.seq}: serial ${match.serial}, batch ${next.garmentBatch ?? '-'}.` : `Line ${line.seq} takes back ${line.quantity} pieces: its lot is ${next.garmentBatch ?? '-'}; the serials stay on the garments' labels.`,
      changed,
      version,
    }
  })
  return result
}
