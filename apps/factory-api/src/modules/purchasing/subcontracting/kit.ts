import type { Uom } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { PURCHASING_SUBCONTRACT_KIT } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { sendProblems, sentProblems, statusAfterReturn, type SubcontractOrderStatus } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { MAX_OTHER_GOODS, type SourceDdtRequest } from '@nexus/factory-domain/shipping/ddt/sources'
import { SHIPPING_DDT_ISSUE } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import type { FilesRuntime } from '../../../platform/files/service'
import type { FileView } from '../../../platform/files/contract'
import { postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { issueSourceDdtInCommand, printSourceDdt } from '../../shipping/ddt/sources'
import { quantityText } from '../store'
import { kitGoods, actFacts, detailInCommand } from './orders'
import { KIT_COLUMNS, officeOrder, readLocationRow, readOrder, sizesOf, type OrderRow } from './store'
import type { OrderDetailView } from './views'

/**
 * Kit out (B-W2a-25; SCM-140; design purchasing.subcontracting "Kit sent", floor.kits "Send a kit"): our material goes
 * to the workshop and stays ours (SCM-141: the workshop's stock location is one of our site's), the pieces go out, and
 * the DDT for work on our behalf (conto lavorazione, B-W2a-17's DDT for other reasons) travels with them. The office
 * here; the floor's kit task (B-W2a-76, floor.ts) runs `sendKitAs` after its own checks.
 *
 *   send     ONE command on the order (its version bump holds the row): the order ISSUED, AT_WORKSHOP or
 *            PARTLY_RECEIVED for a released or running work order; each PLANNED kit line named gets its lot and hide
 *            (picked now when the plan had none) and quantity, then ONE postMoves batch of TRANSFER moves from a
 *            location of the site into the workshop's location (same item, colour, lot, hide and base quantity: the
 *            kit line trigger checks it; 409 before anything is written when the place lacks the stock), the lines
 *            SENT with sentAt and their move, the pieces counted out per operation (named, or from the cut bundles
 *            named: their garments for every operation whose sizes hold their cell), the order ISSUED → AT_WORKSHOP,
 *            THEN the DDT with issueSourceDdtInCommand (the lines sent now, and each bundle as a typed line: cut pieces
 *            have no kit line) when the body asks for one (that needs shipping.ddt.issue too). The PDF is stored after
 *            the commit (printSourceDdt); a store failure leaves the DDT issued and says why the file is missing.
 *   return   a SENT kit line that never left: its DDT must be cancelled first (the DDT is the legal record that the
 *            goods travelled), then its transfer is reversed (the same move, locations swapped) and the line is
 *            PLANNED again; the order goes back to ISSUED when nothing else is out.
 */

const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The kit cannot go out as it stands.', problems)

export interface SendLine {
  readonly lineId: string
  readonly fromLocationId: string
  readonly lotId?: string | null | undefined
  readonly hideId?: string | null | undefined
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
}

export interface SendInput {
  readonly version: number
  readonly lines: readonly SendLine[]
  readonly pieces: readonly { readonly operationId: string; readonly pieces: number }[]
  readonly bundles: readonly { readonly bundleId: string }[]
  readonly ddt: (Omit<SourceDdtRequest, 'lineIds'> & { readonly lineIds?: readonly string[] | undefined; readonly internalNote?: string | null | undefined }) | null
  /** B-W2a-F8: the reason a kit sent inside a SOFT-locked month is posted anyway. */
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

export interface SendAnswer {
  readonly order: OrderDetailView
  readonly moveIds: string[]
  readonly ddt: { readonly id: string; readonly number: string; readonly file: FileView | null; readonly pdfProblem: string | null } | null
}

/** A location of the order's site the kit leaves from (not a workshop's: that is a move between workshops). */
async function fromLocation(tools: CommandTools, order: OrderRow, locationId: string, path: string) {
  const location = await readLocationRow(tools.tx, locationId)
  if (!location || location.siteId !== order.siteId) throw refuse([{ path, message: 'Not a location of the order’s site.' }])
  if (location.status !== 'ACTIVE') throw refuse([{ path, message: `Location ${location.code} is archived.` }])
  if (location.kind === 'SUBCONTRACTOR') throw refuse([{ path, message: `Location ${location.code} is a workshop's: the kit leaves from one of our places.` }])
  return location
}

/** purchasing.subcontract.kit (+ shipping.ddt.issue for the DDT): the kit lines and pieces named go out. */
export async function sendKit(files: FilesRuntime, caller: CommandCaller, orderId: string, input: SendInput, idempotencyKey?: string, onPdfError?: (error: unknown) => void): Promise<SendAnswer> {
  const { context, order: seen } = await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_KIT)
  if (input.ddt && !can(actorOf(context), SHIPPING_DDT_ISSUE, { companyId: seen.companyId, siteId: seen.siteId })) {
    throw new ForbiddenError("Issuing the kit's DDT needs the permission to issue DDTs (shipping.ddt.issue); send without one, or ask the warehouse.")
  }
  return sendKitAs(files, { caller, printer: caller }, seen, input, idempotencyKey, onPdfError)
}

/**
 * B-W2a-76: the send itself, once the caller's access is checked (the office above; the floor's kit task, floor.ts, runs
 * it as the tenant's system caller after checking the device's site and the floor permission, and prints with a caller
 * that may store the PDF). `floor` names the tablet and its worker in the audit row (inside the one record).
 */
export async function sendKitAs(
  files: FilesRuntime,
  callers: { readonly caller: CommandCaller; readonly printer: CommandCaller },
  seen: Pick<OrderRow, 'id' | 'companyId'>,
  input: SendInput,
  idempotencyKey?: string,
  onPdfError?: (error: unknown) => void,
  floor?: { readonly deviceId: string; readonly operatorId: string },
): Promise<SendAnswer> {
  const { caller } = callers
  const orderId = seen.id
  if (input.lines.length === 0 && input.pieces.length === 0 && input.bundles.length === 0) throw refuse([{ path: 'body/lines', message: 'Name the kit lines, pieces or bundles that go out.' }])
  const company = input.ddt ? await companyLegalOf(caller, seen.companyId) : null
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.sendKit', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = (await readOrder(tools.tx, orderId))!
      const { operations, kit, facts } = await actFacts(tools.tx, order)
      const problems = sendProblems(facts)
      if (problems.length > 0) throw new InvalidStateError(problems.join(' '))

      // The kit lines: PLANNED, each once, their lot and hide picked now (still PLANNED: the trigger fixes a SENT one).
      const seenLines = new Set<string>()
      const lines = []
      for (const [index, line] of input.lines.entries()) {
        const at = `body/lines/${index}`
        const row = kit.find((entry) => entry.id === line.lineId)
        if (!row) throw refuse([{ path: `${at}/lineId`, message: 'Not a kit line of this order.' }])
        if (seenLines.has(row.id)) throw refuse([{ path: `${at}/lineId`, message: `Kit line ${row.seq} is named twice.` }])
        seenLines.add(row.id)
        if (row.status !== 'PLANNED') throw new InvalidStateError(`Kit line ${row.seq} is ${row.status.toLowerCase()}; only a planned line goes out.`)
        const from = await fromLocation(tools, order, line.fromLocationId, `${at}/fromLocationId`)
        const lotId = line.lotId !== undefined ? line.lotId : row.lotId
        const goods = await kitGoods(
          tools.tx,
          order,
          { itemId: row.itemId, itemColourId: row.itemColourId, lotId, hideId: line.hideId !== undefined ? line.hideId : lotId === row.lotId ? row.hideId : null, quantity: line.quantity ?? quantityText(row.quantity), uom: line.uom ?? row.uom },
          at,
        )
        if (goods.item.tracking !== 'NONE' && goods.lotId === null) throw refuse([{ path: `${at}/lotId`, message: `${goods.item.code} is tracked by ${goods.item.tracking.toLowerCase()}: name the lot that goes out.` }])
        if (goods.item.tracking === 'HIDE' && goods.hideId === null) throw refuse([{ path: `${at}/hideId`, message: `${goods.item.code} is tracked by the hide: name the hide that goes out.` }])
        if (goods.lotId) {
          const lot = await tools.tx.lot.findUnique({ where: { id: goods.lotId }, select: { code: true, qualityStatus: true } })
          if (lot && lot.qualityStatus !== 'RELEASED') throw refuse([{ path: `${at}/lotId`, message: `Lot ${lot.code} is ${lot.qualityStatus.toLowerCase()}; only a released lot goes to a workshop.` }])
        }
        await tools.tx.subcontractKitLine.update({
          where: { id: row.id },
          data: { lotId: goods.lotId, hideId: goods.hideId, itemColourId: goods.itemColourId, quantity: goods.quantity, uom: goods.uom, baseQuantity: goods.baseQuantity },
          select: { id: true },
        })
        lines.push({ row, goods, from })
      }

      // One batch: the TRANSFER of every line into the workshop's location (409 before any insert when a place lacks it).
      const drafts: MoveDraft[] = lines.map(({ goods, from }) => ({
        siteId: order.siteId,
        reason: 'TRANSFER',
        itemId: goods.item.id,
        itemColourId: goods.itemColourId,
        lotId: goods.lotId,
        hideId: goods.hideId,
        fromLocationId: from.id,
        toLocationId: order.locationId,
        quantity: goods.quantity,
        uom: goods.uom,
        baseQuantity: goods.baseQuantity,
        reference: order.number,
        note: `Kit for subcontract order ${order.number}`,
      }))
      const posted =
        drafts.length > 0
          ? await postMoves(tools, drafts, {
              key: `purchasing.subcontract.sendKit:${idempotencyKey ?? newId()}`,
              issuePath: (index) => `body/lines/${index}`,
              periodLockOverride: input.periodLockOverride,
            })
          : []
      for (const [index, { row }] of lines.entries()) {
        await tools.tx.subcontractKitLine.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: tools.now, moveId: posted[index]!.id, version: { increment: 1 } }, select: { id: true } })
      }

      // The bundles that travel: of the order's work order, each once.
      const seenBundles = new Set<string>()
      const bundles = []
      for (const [index, entry] of input.bundles.entries()) {
        const bundle = isUuid(entry.bundleId) ? await tools.tx.bundle.findUnique({ where: { id: entry.bundleId }, select: { id: true, code: true, workOrderId: true, workOrderSizeId: true, quantity: true, part: true, status: true } }) : null
        if (!bundle || bundle.workOrderId !== order.workOrderId) throw refuse([{ path: `body/bundles/${index}/bundleId`, message: 'Not a bundle of the order’s work order.' }])
        if (bundle.status !== 'ACTIVE') throw refuse([{ path: `body/bundles/${index}/bundleId`, message: `Bundle ${bundle.code} is void.` }])
        if (seenBundles.has(bundle.id)) throw refuse([{ path: `body/bundles/${index}/bundleId`, message: `Bundle ${bundle.code} is named twice.` }])
        seenBundles.add(bundle.id)
        bundles.push(bundle)
      }

      // The pieces out per operation: as named, else from the bundles (a garment travels once for every operation).
      const out = new Map<string, number>()
      if (input.pieces.length > 0) {
        for (const [index, entry] of input.pieces.entries()) {
          if (!operations.some((row) => row.id === entry.operationId)) throw refuse([{ path: `body/pieces/${index}/operationId`, message: 'Not an operation of this order.' }])
          if (out.has(entry.operationId)) throw refuse([{ path: `body/pieces/${index}/operationId`, message: 'This operation is named twice.' }])
          out.set(entry.operationId, entry.pieces)
        }
      } else {
        for (const operation of operations) {
          const cells = new Set(sizesOf(operation.sizes).map((size) => size.workOrderSizeId))
          const garments = bundles.filter((bundle) => (cells.size === 0 || cells.has(bundle.workOrderSizeId)) && bundle.part === null).reduce((sum, bundle) => sum + bundle.quantity, 0)
          if (garments > 0) out.set(operation.id, garments)
        }
      }
      for (const operation of operations) {
        const pieces = out.get(operation.id)
        if (pieces === undefined) continue
        const problems = sentProblems(operation, pieces)
        if (problems.length > 0) throw refuse(problems.map((problem) => ({ path: input.pieces.length > 0 ? `body/pieces/${input.pieces.findIndex((entry) => entry.operationId === operation.id)}/pieces` : 'body/bundles', message: `Line ${operation.seq}: ${problem.message}` })))
        await tools.tx.subcontractOperation.update({ where: { id: operation.id }, data: { piecesSent: operation.piecesSent + pieces, version: { increment: 1 } }, select: { id: true } })
      }

      const to: SubcontractOrderStatus = order.status === 'ISSUED' ? 'AT_WORKSHOP' : (order.status as SubcontractOrderStatus)
      if (to !== order.status) await tools.tx.subcontractOrder.update({ where: { id: orderId }, data: { status: to }, select: { id: true } })
      const piecesOut = [...out.values()].reduce((max, value) => Math.max(max, value), 0)
      tools.audit({
        action: 'purchasing.subcontract.sendKit',
        recordType: 'SubcontractOrder',
        recordId: orderId,
        companyId: order.companyId,
        siteId: order.siteId,
        before: { status: order.status },
        after: {
          status: to,
          lines: lines.map(({ row, goods, from }, index) => ({ lineId: row.id, seq: row.seq, itemId: goods.item.id, lotId: goods.lotId, hideId: goods.hideId, quantity: goods.quantity, uom: goods.uom, fromLocationId: from.id, moveId: posted[index]!.id })),
          pieces: [...out.entries()].map(([operationId, pieces]) => ({ operationId, pieces })),
          bundles: bundles.map((bundle) => ({ bundleId: bundle.id, code: bundle.code, quantity: bundle.quantity, part: bundle.part })),
          ...(floor ? { floor } : {}),
        },
      })

      // THEN the DDT (the lines are SENT, the order out): the lines sent now and each bundle as a typed line.
      let ddt: { id: string; number: string } | null = null
      if (input.ddt && company) {
        const style = await tools.tx.workOrder.findUnique({ where: { id: order.workOrderId }, select: { number: true, style: { select: { code: true, name: true } } } })
        const cells = await tools.tx.workOrderSize.findMany({ where: { id: { in: bundles.map((bundle) => bundle.workOrderSizeId) } }, select: { id: true, size: true, colourway: { select: { code: true } } } })
        const cellOf = new Map(cells.map((cell) => [cell.id, cell]))
        const bundleGoods = bundles.map((bundle) => {
          const cell = cellOf.get(bundle.workOrderSizeId)
          return {
            code: bundle.code,
            description: `${style?.style.code ?? ''} ${style?.style.name ?? ''} ${cell?.colourway.code ?? ''} ${cell?.size ?? ''}: cut pieces${bundle.part ? ` (${bundle.part})` : ''} of work order ${style?.number ?? ''}`.replace(/\s+/g, ' ').trim(),
            quantity: String(bundle.quantity),
            uom: 'PCS' as const,
          }
        })
        const otherGoods = [...bundleGoods, ...(input.ddt.otherGoods ?? [])]
        if (otherGoods.length > MAX_OTHER_GOODS) throw refuse([{ path: 'body/bundles', message: `A DDT lists at most ${MAX_OTHER_GOODS} typed lines; send the bundles in more than one DDT.` }])
        const issued = await issueSourceDdtInCommand(tools, company, { type: 'SubcontractOrder', id: orderId }, { ...input.ddt, lineIds: lines.map(({ row }) => row.id), otherGoods })
        ddt = { id: issued.ddtId, number: issued.number }
      }
      tools.emit({
        type: 'subcontract_order.kit_sent',
        subject: orderId,
        companyId: order.companyId,
        siteId: order.siteId,
        payload: { subcontractOrderId: orderId, number: order.number, status: to, kitLineIds: lines.map(({ row }) => row.id), moveIds: posted.map((move) => move.id), pieces: piecesOut, bundles: bundles.length, ddtId: ddt?.id ?? null },
      })
      return { order: await detailInCommand(tools, orderId), moveIds: posted.map((move) => move.id), ddt }
    },
  )
  if (!result.ddt) return { ...result, ddt: null }
  const printed = await printSourceDdt(files, callers.printer, result.ddt.id, onPdfError)
  return { ...result, ddt: { ...result.ddt, file: printed.file, pdfProblem: printed.pdfProblem } }
}

/** purchasing.subcontract.kit: a SENT kit line that never left comes back (its DDT cancelled first; its transfer reversed). */
export async function returnKitLine(caller: CommandCaller, orderId: string, lineId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ order: OrderDetailView }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_KIT)
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.returnKitLine', idempotencyKey, input: { orderId, lineId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = (await readOrder(tools.tx, orderId))!
      const line = isUuid(lineId) ? await tools.tx.subcontractKitLine.findUnique({ where: { id: lineId }, select: KIT_COLUMNS }) : null
      if (!line || line.subcontractOrderId !== orderId) throw new NotFoundError('Kit line not found on this order.')
      if (line.status !== 'SENT' || !line.moveId) throw new InvalidStateError(`Kit line ${line.seq} is ${line.status.toLowerCase()}; only a sent line comes back unsent.`)
      if (line.ddtId) {
        const ddt = await tools.tx.ddt.findUnique({ where: { id: line.ddtId }, select: { number: true, cancellations: { select: { id: true }, take: 1 } } })
        if (ddt && ddt.cancellations.length === 0) throw new InvalidStateError(`DDT ${ddt.number} is live for kit line ${line.seq}: the goods travelled with it. Cancel the DDT first when they never left.`)
      }
      const move = await tools.tx.stockMove.findUnique({ where: { id: line.moveId }, select: { reason: true, itemId: true, itemColourId: true, lotId: true, hideId: true, fromLocationId: true, toLocationId: true, baseQuantity: true, quantity: true, uom: true } })
      if (!move) throw new NotFoundError('The kit line’s move was not found.')
      const [reversal] = await postMoves(
        tools,
        [
          {
            siteId: order.siteId,
            reason: move.reason,
            itemId: move.itemId,
            itemColourId: move.itemColourId,
            lotId: move.lotId,
            hideId: move.hideId,
            fromLocationId: move.toLocationId,
            toLocationId: move.fromLocationId,
            quantity: move.quantity.toString(),
            uom: move.uom,
            baseQuantity: move.baseQuantity.toString(),
            reversalOfId: line.moveId,
            reference: order.number,
            note: `Kit line ${line.seq} of ${order.number} never left: ${input.reason.trim()}`,
          },
        ],
        { key: `purchasing.subcontract.returnKitLine:${idempotencyKey ?? newId()}`, issuePath: () => 'body' },
      )
      await tools.tx.subcontractKitLine.update({ where: { id: lineId }, data: { status: 'PLANNED', sentAt: null, moveId: null, ddtId: null, version: { increment: 1 } }, select: { id: true } })
      const { facts } = await actFacts(tools.tx, order)
      const to = statusAfterReturn(order.status as SubcontractOrderStatus, facts)
      if (to !== order.status) await tools.tx.subcontractOrder.update({ where: { id: orderId }, data: { status: to }, select: { id: true } })
      tools.audit({
        action: 'purchasing.subcontract.returnKitLine',
        recordType: 'SubcontractKitLine',
        recordId: lineId,
        companyId: order.companyId,
        siteId: order.siteId,
        reason: input.reason.trim(),
        before: { status: 'SENT', moveId: line.moveId, ddtId: line.ddtId, orderStatus: order.status },
        after: { status: 'PLANNED', reversalMoveId: reversal!.id, orderStatus: to },
      })
      tools.emit({ type: 'subcontract_order.kit_returned', subject: orderId, companyId: order.companyId, siteId: order.siteId, payload: { subcontractOrderId: orderId, number: order.number, status: to, kitLineId: lineId, moveId: reversal!.id } })
      return { order: await detailInCommand(tools, orderId) }
    },
  )
  return result
}
