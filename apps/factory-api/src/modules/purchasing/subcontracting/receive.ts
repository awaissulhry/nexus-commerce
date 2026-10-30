import type { Uom } from '@nexus/factory-db'
import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { PURCHASING_SUBCONTRACT_RECEIVE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { backProblems, receiveProblems, statusAfterReceipt, type SubcontractOrderStatus } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { command, type CommandCaller } from '../../../core/command'
import { postCostsInCommand } from '../../costing/actual/post'
import { postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import { kitGoods, actFacts, detailInCommand } from './orders'
import { officeOrder, readLocationRow, readOrder, sizesOf } from './store'
import { RECEIPT_ACTION, receiptViews, storedReceipts, type OrderDetailView } from './views'

/**
 * Receive back (B-W2a-25; SCM-142; design purchasing.subcontracting "Received back", floor.kits "Receive back"): what
 * the workshop returns, operation by operation and bundle by bundle (back good, defective, scrapped there), and the
 * unused material and offcuts it sends back. Office only (the floor's screen, B-W2a-76, needs a floor route of its own:
 * see the step notes). ONE command on the order (its version bump holds the row):
 *
 *   pieces    the order AT_WORKSHOP or PARTLY_RECEIVED; per operation of the order, at least one piece and at most what is
 *             at the workshop (sent less back); a named bundle is of the order's work order, of a cell the operation
 *             sends (when it is split by size), and never comes back more than its garments per operation over every
 *             receipt; the operation's counts move (the trigger holds back ≤ sent ≤ pieces); the order is RECEIVED once
 *             every operation has all its pieces back, else PARTLY_RECEIVED.
 *   material  each line a TRANSFER out of the workshop's location into a location of the site (ONE postMoves batch: 409
 *             before anything is written when the workshop's location lacks it); also once the order is RECEIVED.
 *   record    the receipt is the command's audit row (action purchasing.subcontract.receiveBack: when, lines per
 *             operation and bundle, the moves, the workshop's DDT, the note): the record's "Received back" reads it.
 *   cost      the workshop's fee for the pieces back good is posted to the work order's cost ledger in the same command
 *             (cost-source.ts through costing's postCostsInCommand; it waits in words when it cannot post).
 *
 * The OperationScan REPORTs at the outside operation (so the next operation of the bundle may be scanned) are the floor's
 * (B-W2a-76): an office command takes no scan (the scan subject is a signed-in worker or the station).
 */

const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The receipt is not valid as it stands.', problems)
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export interface ReceiveInput {
  readonly version: number
  readonly receivedAt?: string | undefined
  readonly lines: readonly { readonly operationId: string; readonly bundleId?: string | undefined; readonly good: number; readonly defective: number; readonly scrapped: number; readonly reason?: string | null | undefined }[]
  readonly returns: readonly { readonly itemId: string; readonly itemColourId?: string | null | undefined; readonly lotId?: string | null | undefined; readonly hideId?: string | null | undefined; readonly quantity: string; readonly uom?: Uom | undefined; readonly toLocationId: string }[]
  readonly supplierDdt?: { readonly number: string; readonly date?: string | null | undefined } | null | undefined
  readonly note?: string | null | undefined
}

/** purchasing.subcontract.receive: goods back from the workshop. */
export async function receiveBack(caller: CommandCaller, orderId: string, input: ReceiveInput, idempotencyKey?: string): Promise<{ order: OrderDetailView; receipt: OrderDetailView['receipts'][number]; ledger: { posted: number; waiting: string[] } }> {
  await officeOrder(caller, orderId, PURCHASING_SUBCONTRACT_RECEIVE)
  if (input.lines.length === 0 && input.returns.length === 0) throw refuse([{ path: 'body/lines', message: 'Report the pieces back or the material returned.' }])
  const { result } = await command(
    caller,
    { name: 'purchasing.subcontract.receive', idempotencyKey, input: { orderId, ...input }, record: { type: 'SubcontractOrder', id: orderId, expectedVersion: input.version } },
    async (tools) => {
      const order = (await readOrder(tools.tx, orderId))!
      const { operations, facts } = await actFacts(tools.tx, order)
      const piecesBack = input.lines.length > 0
      const problems = receiveProblems(facts, piecesBack)
      if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
      const receivedAt = input.receivedAt ? parseInstant(input.receivedAt)! : tools.now
      if (receivedAt.getTime() > tools.now.getTime() + 10 * 60_000) throw refuse([{ path: 'body/receivedAt', message: 'The goods came back now or before, not later.' }])
      if (order.issuedAt && receivedAt.getTime() < order.issuedAt.getTime()) throw refuse([{ path: 'body/receivedAt', message: 'The goods came back after the order was issued.' }])

      // What earlier receipts brought back per bundle and operation (a bundle never comes back more than its garments).
      const earlier = new Map<string, number>()
      for (const receipt of await storedReceipts(tools.tx, orderId)) {
        for (const line of receipt.lines) if (line.bundleId) earlier.set(`${line.bundleId}|${line.operationId}`, (earlier.get(`${line.bundleId}|${line.operationId}`) ?? 0) + line.good + line.defective + line.scrapped)
      }

      const perOperation = new Map<string, { good: number; defective: number; scrapped: number }>()
      const recorded = []
      for (const [index, line] of input.lines.entries()) {
        const at = `body/lines/${index}`
        const operation = operations.find((row) => row.id === line.operationId)
        if (!operation) throw refuse([{ path: `${at}/operationId`, message: 'Not an operation of this order.' }])
        if (line.good + line.defective + line.scrapped < 1) throw refuse([{ path: `${at}/good`, message: 'Report at least one piece back (good, defective or scrapped).' }])
        let bundle: { id: string; code: string; quantity: number } | null = null
        if (line.bundleId !== undefined) {
          const row = isUuid(line.bundleId) ? await tools.tx.bundle.findUnique({ where: { id: line.bundleId }, select: { id: true, code: true, workOrderId: true, workOrderSizeId: true, quantity: true } }) : null
          if (!row || row.workOrderId !== order.workOrderId) throw refuse([{ path: `${at}/bundleId`, message: 'Not a bundle of the order’s work order.' }])
          const cells = sizesOf(operation.sizes)
          if (cells.length > 0 && !cells.some((size) => size.workOrderSizeId === row.workOrderSizeId)) throw refuse([{ path: `${at}/bundleId`, message: `Bundle ${row.code} is of a size line ${operation.seq} does not send out.` }])
          const key = `${row.id}|${operation.id}`
          const total = (earlier.get(key) ?? 0) + line.good + line.defective + line.scrapped
          if (total > row.quantity) throw refuse([{ path: `${at}/good`, message: `Bundle ${row.code} holds ${row.quantity} garment(s); ${earlier.get(key) ?? 0} came back already on line ${operation.seq}.` }])
          earlier.set(key, total)
          bundle = { id: row.id, code: row.code, quantity: row.quantity }
        }
        const sum = perOperation.get(operation.id) ?? { good: 0, defective: 0, scrapped: 0 }
        perOperation.set(operation.id, { good: sum.good + line.good, defective: sum.defective + line.defective, scrapped: sum.scrapped + line.scrapped })
        recorded.push({ operationId: operation.id, seq: operation.seq, code: '', bundleId: bundle?.id ?? null, bundleCode: bundle?.code ?? null, good: line.good, defective: line.defective, scrapped: line.scrapped, reason: blankToNull(line.reason) })
      }
      const codes = new Map((await tools.tx.workOrderOperation.findMany({ where: { id: { in: operations.map((row) => row.workOrderOperationId) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
      for (const entry of recorded) entry.code = codes.get(operations.find((row) => row.id === entry.operationId)!.workOrderOperationId) ?? ''

      // The counts per operation (at most what is at the workshop).
      const after = operations.map((operation) => ({ ...operation }))
      for (const operation of after) {
        const back = perOperation.get(operation.id)
        if (!back) continue
        const problems = backProblems(operation, back)
        if (problems.length > 0) throw refuse(problems.map((problem) => ({ path: `body/lines/${input.lines.findIndex((line) => line.operationId === operation.id)}/${problem.path}`, message: `Line ${operation.seq}: ${problem.message}` })))
        operation.piecesBackGood += back.good
        operation.piecesBackDefective += back.defective
        operation.piecesScrapped += back.scrapped
        await tools.tx.subcontractOperation.update({
          where: { id: operation.id },
          data: { piecesBackGood: operation.piecesBackGood, piecesBackDefective: operation.piecesBackDefective, piecesScrapped: operation.piecesScrapped, version: { increment: 1 } },
          select: { id: true },
        })
      }

      // The material back: out of the workshop's location into ours (one batch).
      const returns = []
      for (const [index, line] of input.returns.entries()) {
        const at = `body/returns/${index}`
        const goods = await kitGoods(tools.tx, order, line, at)
        const to = await readLocationRow(tools.tx, line.toLocationId)
        if (!to || to.siteId !== order.siteId) throw refuse([{ path: `${at}/toLocationId`, message: 'Not a location of the order’s site.' }])
        if (to.status !== 'ACTIVE') throw refuse([{ path: `${at}/toLocationId`, message: `Location ${to.code} is archived.` }])
        if (to.kind === 'SUBCONTRACTOR') throw refuse([{ path: `${at}/toLocationId`, message: `Location ${to.code} is a workshop's: material comes back into one of our places.` }])
        returns.push({ goods, to })
      }
      const drafts: MoveDraft[] = returns.map(({ goods, to }) => ({
        siteId: order.siteId,
        reason: 'TRANSFER',
        itemId: goods.item.id,
        itemColourId: goods.itemColourId,
        lotId: goods.lotId,
        hideId: goods.hideId,
        fromLocationId: order.locationId,
        toLocationId: to.id,
        quantity: goods.quantity,
        uom: goods.uom,
        baseQuantity: goods.baseQuantity,
        reference: order.number,
        note: `Back from the workshop of subcontract order ${order.number}`,
      }))
      const posted = drafts.length > 0 ? await postMoves(tools, drafts, { key: `purchasing.subcontract.receive:${idempotencyKey ?? newId()}`, issuePath: (index) => `body/returns/${index}` }) : []

      const to: SubcontractOrderStatus = piecesBack ? statusAfterReceipt(after) : (order.status as SubcontractOrderStatus)
      if (to !== order.status) await tools.tx.subcontractOrder.update({ where: { id: orderId }, data: { status: to }, select: { id: true } })

      const receiptId = newId()
      const totals = [...perOperation.values()].reduce((sum, back) => ({ good: sum.good + back.good, defective: sum.defective + back.defective, scrapped: sum.scrapped + back.scrapped }), { good: 0, defective: 0, scrapped: 0 })
      tools.audit({
        action: RECEIPT_ACTION,
        recordType: 'SubcontractOrder',
        recordId: orderId,
        companyId: order.companyId,
        siteId: order.siteId,
        before: { status: order.status },
        after: {
          receiptId,
          receivedAt: toUtcIso(receivedAt),
          status: to,
          lines: recorded,
          returns: returns.map(({ goods, to: place }, index) => ({ moveId: posted[index]!.id, itemId: goods.item.id, itemColourId: goods.itemColourId, lotId: goods.lotId, hideId: goods.hideId, quantity: goods.quantity, uom: goods.uom, toLocationId: place.id })),
          supplierDdt: input.supplierDdt ? { number: input.supplierDdt.number.trim(), date: input.supplierDdt.date ?? null } : null,
          note: blankToNull(input.note),
        },
      })

      // The workshop's fee for the pieces back good, onto the work order's cost ledger (in this command).
      const cost = totals.good > 0 ? await postCostsInCommand(tools, order.workOrderId, { subcontractOrderIds: [orderId] }) : { posted: [], waiting: [] }
      tools.emit({
        type: 'subcontract_order.received',
        subject: orderId,
        companyId: order.companyId,
        siteId: order.siteId,
        payload: { subcontractOrderId: orderId, number: order.number, status: to, receiptId, good: totals.good, defective: totals.defective, scrapped: totals.scrapped, bundles: recorded.filter((line) => line.bundleId !== null).length, returnedLines: posted.length },
      })
      // The audit row is written when the command ends: the answer shows this receipt from what it recorded.
      const [receipt] = await receiptViews(tools.tx, [
        {
          receiptId,
          receivedAt: toUtcIso(receivedAt),
          lines: recorded,
          returns: returns.map(({ goods, to: place }, index) => ({ moveId: posted[index]!.id, itemId: goods.item.id, itemColourId: goods.itemColourId, lotId: goods.lotId, hideId: goods.hideId, quantity: goods.quantity, uom: goods.uom, toLocationId: place.id })),
          supplierDdt: input.supplierDdt ? { number: input.supplierDdt.number.trim(), date: input.supplierDdt.date ?? null } : null,
          note: blankToNull(input.note),
          recordedAt: tools.now,
          byId: tools.context.audience === 'office' ? tools.context.actorId : null,
        },
      ])
      const detail = await detailInCommand(tools, orderId)
      return {
        order: { ...detail, receipts: [...detail.receipts, receipt!] },
        receipt: receipt!,
        ledger: { posted: cost.posted.filter((entry) => entry.kind === 'SUBCONTRACT').length, waiting: cost.waiting.filter((entry) => entry.sourceType === 'SubcontractOrder').map((entry) => entry.words) },
      }
    },
  )
  return result
}
