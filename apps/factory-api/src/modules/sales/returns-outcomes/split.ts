import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { restOf, splitHeld, splitSeqOf } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { SALES_RETURNS_RECEIVE } from '@nexus/factory-domain/sales/returns/permissions'
import { OPEN_RETURN_STATUSES, type ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller } from '../../../core/command'
import { asTenantSystem } from '../../production/bundles/codes'
import { dockReturn } from '../returns/access'
import { getDock, type DockView } from '../returns/dock'
import { lockReturn, touchReturn } from '../returns/rma'
import { readLines } from '../returns/store'

/**
 * Split lines on a partial receipt (B-W2b-346; SAL-350; design floor.returnsin "a partial receipt splits the line and the
 * rest stays expected", the office's rma.lines). `POST /sales/returns/:returnId/lines/:lineId/split` {version}: the office,
 * or the dock's tablet at its own site (sales.returns.receive). ONE command: the RMA row locked at the version read
 * (W2a's lockReturn), the line of which only part arrived CUT down to its received pieces FIRST (W2a's sold check counts
 * line by line), then a NEW line split from it (parentLineId) taking the rest: the same order and invoice line, size,
 * reason and words, price and discount, the lot (never the serial: one serial is one garment), nothing received and no
 * decision, numbered right after its parent. The deferred `ReturnLine_split_kept` checks at commit that the rest is
 * covered. The RMA's version bumps; audit rows on both lines; event return.line_split. The floor has no INSERT on
 * ReturnLine: a tablet's split runs as the tenant's system, its worker named on the audit row (inside the one record).
 * The answer is the dock's view (no price), for the office and the tablet alike; the parent may be graded and decided
 * as W2a's steps do, the new line received when the rest comes.
 */

export async function splitLine(caller: CommandCaller, returnId: string, lineId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ return: DockView; line: { id: string; seq: number; quantity: number }; newLine: { id: string; seq: number; quantity: number } }> {
  const { context, rma: seen } = await dockReturn(caller, returnId, SALES_RETURNS_RECEIVE)
  const acting = context.audience === 'floor' ? asTenantSystem(caller, context) : caller
  const { result } = await command(acting, { name: 'returnsOutcomes.splitLine', idempotencyKey, input: { returnId, lineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const rma = await lockReturn(tools, seen.id, body.version, OPEN_RETURN_STATUSES, 'a line is split')
    const lines = await readLines(tx, rma.id)
    const line = lines.find((entry) => entry.id === lineId)
    if (!line) throw new NotFoundError('Not a line of this return.')
    const held = splitHeld({ status: rma.status as ReturnStatus, seq: line.seq, quantity: line.quantity, received: line.receivedQuantity, creditWithoutReturn: line.creditWithoutReturn })
    if (held) throw new InvalidStateError(held)
    const rest = restOf({ quantity: line.quantity, received: line.receivedQuantity })
    const seq = splitSeqOf(lines.map((entry) => entry.seq), line.seq)
    const newLineId = newId()
    // The cut first: the guard counts what live returns take back line by line, so the rest fits once the parent is cut.
    await tx.returnLine.update({ where: { id: line.id }, data: { quantity: line.receivedQuantity, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    await tx.returnLine.create({
      data: {
        id: newLineId,
        siteId: line.siteId,
        partyId: line.partyId,
        returnId: rma.id,
        seq,
        salesOrderLineId: line.salesOrderLineId,
        size: line.size,
        invoiceLineId: line.invoiceLineId,
        description: line.description,
        batchNumber: line.batchNumber,
        quantity: rest,
        reasonCode: line.reasonCode,
        reasonNote: line.reasonNote,
        unitPrice: line.unitPrice,
        discountPct: line.discountPct,
        garmentBatch: line.garmentBatch,
        parentLineId: line.id,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    await touchReturn(tools, rma)
    const by = { audience: context.audience, actorId: context.actorId }
    tools.audit({ action: 'returnsOutcomes.splitLine', recordType: 'ReturnLine', recordId: line.id, companyId: rma.companyId, siteId: rma.siteId, before: { quantity: line.quantity, receivedQuantity: line.receivedQuantity }, after: { quantity: line.receivedQuantity, newLineId, newSeq: seq, rest, by } })
    tools.audit({ action: 'returnsOutcomes.splitOff', recordType: 'ReturnLine', recordId: newLineId, companyId: rma.companyId, siteId: rma.siteId, after: { seq, parentLineId: line.id, quantity: rest, reasonCode: line.reasonCode, by } })
    tools.emit({ type: 'return.line_split', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineId: line.id, newLineId, kept: line.receivedQuantity, rest } })
    return { line: { id: line.id, seq: line.seq, quantity: line.receivedQuantity }, newLine: { id: newLineId, seq, quantity: rest } }
  })
  return { ...(await getDock(caller, seen.id)), line: result.line, newLine: result.newLine }
}
