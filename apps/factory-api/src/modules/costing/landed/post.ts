import { businessDate } from '@nexus/factory-domain/core/time'
import { ACCOUNTANT_WAITS } from '@nexus/factory-domain/costing/ppv/settings'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { actualSettingsOf, hardLockWords, refusalOf } from '../ppv/settings'
import { allocationFor, refused } from './allocate'
import { allocationView } from './reads'

/**
 * Posting and reversing a landed cost (B-W2b-407; FIN-044; GATE-ACCOUNTANT), costing.landed.manage over the invoice's
 * company and supplier. The version is checked and moved in the status change's own statement (not by command()'s record
 * guard: the database lets a POSTED allocation change only into REVERSED, never by its version alone):
 *   post     a DRAFT whose shares add up to its amount, only while the company's figures for the accountant are on and
 *            today is outside a HARD lock; one POSTED per charge line. From now on each lot's cost carries its share
 *            (costing/landed/lot-cost.ts: the stock leaving the lot, the stock valuation).
 *   reverse  a POSTED one, once, with why (no switch needed): the shares stop counting from now (what left the lots
 *            meanwhile keeps the cost it left at); a new DRAFT may then be prepared.
 */

/** The status change, at the version the person read (a stale one is the usual 409 naming the current version). */
async function moveAt(tx: CommandTx, allocationId: string, version: number, data: Parameters<CommandTx['landedCostAllocation']['updateMany']>[0]['data']): Promise<void> {
  const { count } = await tx.landedCostAllocation.updateMany({ where: { id: allocationId, version }, data: { ...data, version: { increment: 1 } } })
  if (count === 0) {
    const current = await tx.landedCostAllocation.findUniqueOrThrow({ where: { id: allocationId }, select: { version: true } })
    throw new StaleVersionError('LandedCostAllocation', allocationId, current.version, version)
  }
}

/** POST /costing/landed/:allocationId/post */
export async function postLanded(caller: CommandCaller, allocationId: string, version: number, idempotencyKey?: string) {
  await allocationFor(caller, allocationId)
  const { result, replayed } = await command(caller, { name: 'costing.postLandedCost', idempotencyKey, input: { allocationId, version } }, async (tools) => {
    const { tx, now } = tools
    const allocation = await tx.landedCostAllocation.findUniqueOrThrow({ where: { id: allocationId }, select: { status: true, companyId: true, supplierInvoiceLineId: true, amount: true, version: true } })
    if (allocation.version !== version) throw new StaleVersionError('LandedCostAllocation', allocationId, allocation.version, version)
    if (allocation.status !== 'DRAFT') throw refused('NOT_DRAFT', `This landed cost is ${allocation.status}: only a draft is posted.`)
    if (!(await actualSettingsOf(tx, allocation.companyId)).postingsOn) throw refused('WAITS_FOR_ACCOUNTANT', ACCOUNTANT_WAITS)
    const locked = await hardLockWords(tx, allocation.companyId, businessDate(now))
    if (locked) throw refused('LOCKED', locked)
    if (await tx.landedCostAllocation.findFirst({ where: { supplierInvoiceLineId: allocation.supplierInvoiceLineId, status: 'POSTED' }, select: { id: true } })) {
      throw refused('POSTED_ALREADY', 'This charge is landed already: reverse that landed cost first.')
    }
    const shares = await tx.landedCostShare.findMany({ where: { allocationId }, select: { lotId: true, amount: true } })
    if (shares.length === 0) throw refused('NO_LOTS', 'This landed cost lands on no lot yet: change it to name the receipts.')
    if (tools.context.audience !== 'office') throw refused('NOT_DRAFT', 'A landed cost is posted by a person.')
    try {
      await moveAt(tx, allocationId, version, { status: 'POSTED', postedAt: now, postedById: tools.context.actorId, updatedAt: now })
    } catch (error) {
      throw refusalOf(error)
    }
    tools.audit({ action: 'costing.postLandedCost', recordType: 'LandedCostAllocation', recordId: allocationId, companyId: allocation.companyId, before: { status: 'DRAFT' }, after: { status: 'POSTED', amount: markMoney('cost', allocation.amount), shares: shares.map((share) => ({ lotId: share.lotId, amount: markMoney('cost', share.amount) })) } })
    tools.emit({ type: 'landed_cost.changed', subject: allocationId, companyId: allocation.companyId, payload: { allocationId, supplierInvoiceLineId: allocation.supplierInvoiceLineId, status: 'POSTED', change: 'posted', lotIds: shares.map((share) => share.lotId) } })
    return allocationView(tx, tools.context, allocationId)
  })
  return { allocation: result, replayed }
}

/** POST /costing/landed/:allocationId/reverse */
export async function reverseLanded(caller: CommandCaller, allocationId: string, version: number, reason: string, idempotencyKey?: string) {
  await allocationFor(caller, allocationId)
  const { result, replayed } = await command(caller, { name: 'costing.reverseLandedCost', idempotencyKey, input: { allocationId, version, reason } }, async (tools) => {
    const { tx, now } = tools
    const allocation = await tx.landedCostAllocation.findUniqueOrThrow({ where: { id: allocationId }, select: { status: true, companyId: true, supplierInvoiceLineId: true, version: true } })
    if (allocation.version !== version) throw new StaleVersionError('LandedCostAllocation', allocationId, allocation.version, version)
    if (allocation.status !== 'POSTED') throw refused('NOT_POSTED', allocation.status === 'DRAFT' ? 'This landed cost is a draft: remove it instead.' : 'This landed cost is reversed already: a landed cost is reversed once.')
    if (tools.context.audience !== 'office') throw refused('NOT_POSTED', 'A landed cost is reversed by a person.')
    const lots = (await tx.landedCostShare.findMany({ where: { allocationId }, select: { lotId: true } })).map((row) => row.lotId)
    try {
      await moveAt(tx, allocationId, version, { status: 'REVERSED', reversedAt: now, reversedById: tools.context.actorId, reverseReason: reason, updatedAt: now })
    } catch (error) {
      throw refusalOf(error)
    }
    tools.audit({ action: 'costing.reverseLandedCost', recordType: 'LandedCostAllocation', recordId: allocationId, companyId: allocation.companyId, before: { status: 'POSTED' }, after: { status: 'REVERSED' }, reason })
    tools.emit({ type: 'landed_cost.changed', subject: allocationId, companyId: allocation.companyId, payload: { allocationId, supplierInvoiceLineId: allocation.supplierInvoiceLineId, status: 'REVERSED', change: 'reversed', lotIds: lots } })
    return allocationView(tx, tools.context, allocationId)
  })
  return { allocation: result, replayed }
}
