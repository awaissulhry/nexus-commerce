import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { LandedChangeBody, LandedCreateBody } from '@nexus/factory-domain/costing/landed/contracts'
import { COSTING_LANDED_MANAGE } from '@nexus/factory-domain/costing/landed/permissions'
import { allocateShares, kilogramsOf, landedShareKey, type LandedBasis, type LandedRefusal } from '@nexus/factory-domain/costing/landed/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/materials/store'
import { unique, type Reader } from '../actual/store'
import { ownedLots } from '../valuation/customer-owned'
import { refusalOf } from '../ppv/settings'
import { allocationView } from './reads'

/**
 * Preparing a landed cost (B-W2b-407; FIN-044; SCM-126, SCM-127): a supplier invoice's CHARGE line (freight, duty, a
 * broker's fee) as a DRAFT spread over the lots its goods came in, finance's work (costing.landed.manage over the
 * invoice's company and supplier). The lots are those received on the goods receipts named, or by default on the receipts
 * the same invoice's goods lines were matched to (a carrier's or a broker's own invoice names them). A lot's figure is its
 * receipt's value (VALUE), its received quantity (QUANTITY: leather by its area) or its kilograms (WEIGHT: the received
 * quantity of a material counted in KG or G, else typed per lot); the shares add up to the line's net amount
 * (factory-domain costing/landed allocateShares). A customer's own lot never takes a share (FIN-045). A DRAFT changes
 * (basis, receipts, weights, note: the shares are made again) or is removed; posting and reversing are ./post.ts.
 */

export const refused = (code: LandedRefusal, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

/** The charge line, its invoice and the company's currency. */
export async function chargeOf(db: Reader, lineId: string) {
  const line = isUuid(lineId) ? await db.supplierInvoiceLine.findUnique({ where: { id: lineId }, select: { id: true, partyId: true, invoiceId: true, seq: true, kind: true, description: true, netAmount: true } }) : null
  if (!line) return null
  const invoice = await db.supplierInvoice.findUnique({ where: { id: line.invoiceId }, select: { id: true, companyId: true, partyId: true, number: true, issueDate: true, status: true, currency: true } })
  if (!invoice) return null
  const companyCurrency = costingCurrency((await db.company.findUnique({ where: { id: invoice.companyId }, select: { currency: true } }))?.currency ?? null)
  return { line, invoice, companyCurrency }
}
type Charge = NonNullable<Awaited<ReturnType<typeof chargeOf>>>

/** The goods receipts the invoice's goods lines were matched to (the default lots of its charges). */
async function matchedReceipts(db: Reader, invoiceId: string): Promise<string[]> {
  const matches = await db.supplierInvoiceMatch.findMany({ where: { invoiceId, goodsReceiptLineId: { not: null } }, select: { goodsReceiptLineId: true } })
  const lines = await db.goodsReceiptLine.findMany({ where: { id: { in: unique(matches.map((row) => row.goodsReceiptLineId)) } }, select: { receiptId: true } })
  return unique(lines.map((row) => row.receiptId))
}

export interface PlannedShare {
  readonly lotId: string
  readonly siteId: string
  readonly itemId: string
  readonly basisAmount: string
  readonly amount: number
}

/** The shares of a charge over the lots of these receipts, on the basis (refused in words when it cannot be). */
async function sharesOf(db: Reader, charge: Charge, basis: LandedBasis, receiptIds: readonly string[], weights: ReadonlyMap<string, string>): Promise<PlannedShare[]> {
  const receipts = await db.goodsReceipt.findMany({ where: { id: { in: [...receiptIds] } }, select: { id: true, number: true, companyId: true, status: true, kind: true } })
  for (const receiptId of receiptIds) if (!receipts.some((row) => row.id === receiptId)) throw new NotFoundError('Goods receipt not found.')
  for (const receipt of receipts) {
    if (receipt.companyId !== charge.invoice.companyId) throw refused('OTHER_COMPANY', `Receipt ${receipt.number} is another company's: a charge lands only on lots of the invoice's company.`)
    if (receipt.kind === 'CUSTOMER_SUPPLIED') throw refused('CUSTOMER_OWNED', `Receipt ${receipt.number} brought a customer's own goods: they are never valued, so no charge lands on them.`)
    if (receipt.status !== 'POSTED') throw refused('NOT_RECEIVED', `Receipt ${receipt.number} is ${receipt.status}: a charge lands on lots of a POSTED receipt.`)
  }
  const lines = await db.goodsReceiptLine.findMany({ where: { receiptId: { in: [...receiptIds] } }, select: { id: true } })
  const lots = await db.lot.findMany({ where: { receiptLineId: { in: lines.map((row) => row.id) } }, select: { id: true, code: true, siteId: true, itemId: true, receiptLineId: true }, orderBy: { code: 'asc' } })
  const owned = await ownedLots(db, lots.map((row) => row.id))
  const ours = lots.filter((row) => !owned.has(row.id))
  if (ours.length === 0) throw refused('NO_LOTS', 'The receipts named brought no lots of ours: nothing for the charge to land on (an untracked material has no lot).')
  const moves = await db.stockMove.findMany({ where: { lotId: { in: ours.map((row) => row.id) }, reason: 'RECEIPT', reversalOfId: null, receiptLineId: { not: null } }, select: { id: true, lotId: true, baseQuantity: true } })
  const values = new Map((await db.stockValuation.findMany({ where: { moveId: { in: moves.map((row) => row.id) } }, select: { moveId: true, valueAmount: true, currency: true } })).map((row) => [row.moveId, row]))
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(ours.map((row) => row.itemId)) } }, select: { id: true, baseUom: true } })).map((row) => [row.id, row.baseUom as Uom]))
  const figures = ours.map((lot) => {
    const mine = moves.filter((move) => move.lotId === lot.id)
    const quantity = mine.reduce((sum, move) => sum.plus(move.baseQuantity.toString()), new Dec(0))
    if (basis === 'QUANTITY') return { lot, figure: quantity.toFixed(4) }
    if (basis === 'WEIGHT') {
      const kilograms = kilogramsOf(quantity.toFixed(4), items.get(lot.itemId) ?? 'PCS') ?? weights.get(lot.id) ?? null
      if (kilograms === null || !new Dec(kilograms).greaterThan(0)) throw refused('NO_WEIGHT', `Lot ${lot.code}: nothing records its weight; type its kilograms to land the charge by weight.`)
      return { lot, figure: new Dec(kilograms).toFixed(4) }
    }
    const valued = mine.map((move) => values.get(move.id))
    if (valued.some((value) => !value || value.currency !== charge.companyCurrency)) throw refused('NO_VALUE', `Lot ${lot.code} has no purchase value yet: land the charge by quantity or weight, or once its receipt is valued.`)
    return { lot, figure: String(valued.reduce((sum, value) => sum + value!.valueAmount, 0)) }
  })
  const usable = figures.filter((row) => new Dec(row.figure).greaterThan(0))
  if (usable.length === 0) throw refused('NO_LOTS', 'None of the lots has a figure above 0 on this basis: nothing for the charge to land on.')
  const amounts = allocateShares(charge.line.netAmount, usable.map((row) => ({ lotId: row.lot.id, basisAmount: row.figure })))
  return usable.map((row, index) => ({ lotId: row.lot.id, siteId: row.lot.siteId, itemId: row.lot.itemId, basisAmount: row.figure, amount: amounts[index]!.amount }))
}

/** A charge line that can be landed (CHARGE, above 0, not voided, in the company's currency), else refused in words. */
function assertLandable(charge: Charge): void {
  if (charge.line.kind !== 'CHARGE' || charge.line.netAmount <= 0) {
    throw refused('NOT_A_CHARGE', charge.line.kind !== 'CHARGE' ? `Line ${charge.line.seq} is a ${charge.line.kind.toLowerCase()} line: only a charge (freight, duty, a broker's fee) is landed.` : `Line ${charge.line.seq} is a discount or a rebate (below or at 0): only a cost is landed.`)
  }
  if (charge.invoice.status === 'VOIDED') throw refused('INVOICE_VOIDED', `Invoice ${charge.invoice.number} is voided: its charges land nowhere.`)
  if (charge.invoice.currency !== charge.companyCurrency) {
    throw refused('CURRENCY', `Invoice ${charge.invoice.number} is in ${charge.invoice.currency}: a landed cost keeps the line's own amount and the lots are valued in ${charge.companyCurrency}, so a charge in another currency is not landed yet.`)
  }
}

/** The caller may manage the charge's landed cost (404 when it may not even see it). */
async function chargeFor(caller: CommandCaller, lineId: string): Promise<Charge> {
  const actor = actorOf(contextOf(caller))
  const charge = await caller.withClient((db) => chargeOf(db, lineId))
  if (!charge || !can(actor, COSTING_VIEW, { companyId: charge.invoice.companyId, partyId: charge.invoice.partyId })) throw new NotFoundError('Supplier invoice line not found.')
  if (!can(actor, COSTING_LANDED_MANAGE, { companyId: charge.invoice.companyId, partyId: charge.invoice.partyId })) throw new ForbiddenError()
  return charge
}

/** The allocation the caller may manage, with its charge. */
export async function allocationFor(caller: CommandCaller, allocationId: string) {
  const row = isUuid(allocationId) ? await caller.withClient((db) => db.landedCostAllocation.findUnique({ where: { id: allocationId }, select: { id: true, supplierInvoiceLineId: true, companyId: true, partyId: true } })) : null
  const actor = actorOf(contextOf(caller))
  if (!row || !can(actor, COSTING_VIEW, { companyId: row.companyId, partyId: row.partyId })) throw new NotFoundError('Landed cost not found.')
  if (!can(actor, COSTING_LANDED_MANAGE, { companyId: row.companyId, partyId: row.partyId })) throw new ForbiddenError()
  return row
}

async function writeShares(tools: CommandTools, allocationId: string, shares: readonly PlannedShare[]): Promise<void> {
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tools.tx.landedCostShare.createMany({
    data: shares.map((share) => ({ id: newId(), allocationId, ...share, key: landedShareKey(allocationId, share.lotId), createdAt: tools.now, updatedAt: tools.now, createdById })),
  })
}

const weightsOf = (body: { readonly weights?: readonly { readonly lotId: string; readonly kilograms: string }[] | undefined }): Map<string, string> => new Map((body.weights ?? []).map((row) => [row.lotId, row.kilograms]))

/** POST /costing/landed: a DRAFT with its shares. */
export async function prepareLanded(caller: CommandCaller, body: LandedCreateBody, idempotencyKey?: string) {
  await chargeFor(caller, body.supplierInvoiceLineId)
  const { result, replayed } = await command(caller, { name: 'costing.prepareLandedCost', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const charge = (await chargeOf(tx, body.supplierInvoiceLineId))!
    assertLandable(charge)
    const live = await tx.landedCostAllocation.findFirst({ where: { supplierInvoiceLineId: charge.line.id, status: { in: ['DRAFT', 'POSTED'] } }, select: { id: true, status: true } })
    if (live) throw refused(live.status === 'POSTED' ? 'POSTED_ALREADY' : 'DRAFT_EXISTS', live.status === 'POSTED' ? 'This charge is landed already: reverse that landed cost first to land it again.' : 'This charge has a draft landed cost already: change that one.')
    const receiptIds = body.receiptIds ?? (await matchedReceipts(tx, charge.invoice.id))
    if (receiptIds.length === 0) throw refused('NO_LOTS', "The invoice's goods were matched to no receipt: name the goods receipts whose lots the charge lands on.")
    const shares = await sharesOf(tx, charge, body.basis, receiptIds, weightsOf(body))
    const id = newId()
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    try {
      await tx.landedCostAllocation.create({
        data: { id, companyId: charge.invoice.companyId, partyId: charge.line.partyId, supplierInvoiceLineId: charge.line.id, basis: body.basis, amount: charge.line.netAmount, currency: charge.invoice.currency, note: body.note ?? null, createdAt: now, updatedAt: now, createdById },
        select: { id: true },
      })
      await writeShares(tools, id, shares)
    } catch (error) {
      throw refusalOf(error)
    }
    tools.audit({ action: 'costing.prepareLandedCost', recordType: 'LandedCostAllocation', recordId: id, companyId: charge.invoice.companyId, after: { line: charge.line.id, basis: body.basis, receipts: receiptIds, shares: shares.map((share) => ({ lotId: share.lotId, amount: markMoney('cost', share.amount) })) } })
    tools.emit({ type: 'landed_cost.changed', subject: id, companyId: charge.invoice.companyId, payload: { allocationId: id, supplierInvoiceLineId: charge.line.id, status: 'DRAFT', change: 'prepared', lotIds: shares.map((share) => share.lotId) } })
    return allocationView(tx, tools.context, id)
  })
  return { allocation: result, replayed }
}

/** PATCH /costing/landed/:allocationId: a DRAFT's basis, receipts, weights or note; the shares made again. */
export async function changeLanded(caller: CommandCaller, allocationId: string, body: LandedChangeBody, idempotencyKey?: string) {
  await allocationFor(caller, allocationId)
  const { result, replayed } = await command(caller, { name: 'costing.changeLandedCost', idempotencyKey, input: { allocationId, ...body }, record: { type: 'LandedCostAllocation', id: allocationId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const allocation = await tx.landedCostAllocation.findUniqueOrThrow({ where: { id: allocationId }, select: { id: true, status: true, basis: true, note: true, supplierInvoiceLineId: true, companyId: true } })
    if (allocation.status !== 'DRAFT') throw refused('NOT_DRAFT', `This landed cost is ${allocation.status}: only a draft changes (reverse a posted one and prepare it again).`)
    const charge = (await chargeOf(tx, allocation.supplierInvoiceLineId))!
    assertLandable(charge)
    const current = await tx.landedCostShare.findMany({ where: { allocationId }, select: { lotId: true } })
    const receiptIds =
      body.receiptIds ??
      unique((await tx.goodsReceiptLine.findMany({ where: { id: { in: unique((await tx.lot.findMany({ where: { id: { in: current.map((row) => row.lotId) } }, select: { receiptLineId: true } })).map((row) => row.receiptLineId)) } }, select: { receiptId: true } })).map((row) => row.receiptId))
    const basis = (body.basis ?? allocation.basis) as LandedBasis
    const shares = await sharesOf(tx, charge, basis, receiptIds, weightsOf(body))
    try {
      await tx.landedCostShare.deleteMany({ where: { allocationId } })
      await tx.landedCostAllocation.update({ where: { id: allocationId }, data: { basis, amount: charge.line.netAmount, ...(body.note === undefined ? {} : { note: body.note }), updatedAt: now }, select: { id: true } })
      await writeShares(tools, allocationId, shares)
    } catch (error) {
      throw refusalOf(error)
    }
    tools.audit({ action: 'costing.changeLandedCost', recordType: 'LandedCostAllocation', recordId: allocationId, companyId: allocation.companyId, before: { basis: allocation.basis, lots: current.map((row) => row.lotId) }, after: { basis, receipts: receiptIds, shares: shares.map((share) => ({ lotId: share.lotId, amount: markMoney('cost', share.amount) })) } })
    tools.emit({ type: 'landed_cost.changed', subject: allocationId, companyId: allocation.companyId, payload: { allocationId, supplierInvoiceLineId: allocation.supplierInvoiceLineId, status: 'DRAFT', change: 'changed', lotIds: shares.map((share) => share.lotId) } })
    return allocationView(tx, tools.context, allocationId)
  })
  return { allocation: result, replayed }
}

/** DELETE /costing/landed/:allocationId?version: a DRAFT and its shares removed. */
export async function removeLanded(caller: CommandCaller, allocationId: string, version: number, idempotencyKey?: string): Promise<{ replayed: boolean }> {
  await allocationFor(caller, allocationId)
  const { replayed } = await command(caller, { name: 'costing.removeLandedCost', idempotencyKey, input: { allocationId, version }, record: { type: 'LandedCostAllocation', id: allocationId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const allocation = await tx.landedCostAllocation.findUniqueOrThrow({ where: { id: allocationId }, select: { status: true, supplierInvoiceLineId: true, companyId: true } })
    if (allocation.status !== 'DRAFT') throw refused('NOT_DRAFT', `This landed cost is ${allocation.status}: only a draft is removed (a posted one is reversed).`)
    const lots = (await tx.landedCostShare.findMany({ where: { allocationId }, select: { lotId: true } })).map((row) => row.lotId)
    try {
      await tx.landedCostShare.deleteMany({ where: { allocationId } })
      await tx.landedCostAllocation.delete({ where: { id: allocationId }, select: { id: true } })
    } catch (error) {
      throw refusalOf(error)
    }
    tools.audit({ action: 'costing.removeLandedCost', recordType: 'LandedCostAllocation', recordId: allocationId, companyId: allocation.companyId, before: { status: 'DRAFT', lots } })
    tools.emit({ type: 'landed_cost.changed', subject: allocationId, companyId: allocation.companyId, payload: { allocationId, supplierInvoiceLineId: allocation.supplierInvoiceLineId, status: 'DRAFT', change: 'removed', lotIds: lots } })
    return null
  })
  return { replayed }
}
