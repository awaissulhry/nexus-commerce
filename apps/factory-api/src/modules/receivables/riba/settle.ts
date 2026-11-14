import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { daysBetween } from '@nexus/factory-domain/receivables/ledger'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { PAYMENTS_RECORD } from '@nexus/factory-domain/payments/permissions'
import { RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import type { SettleBody } from '@nexus/factory-domain/receivables/riba/contracts'
import { RECEIVABLES_RIBA_MANAGE } from '@nexus/factory-domain/receivables/riba/permissions'
import { RIBA_REFUSALS, ribaPaymentReference, settleProblem } from '@nexus/factory-domain/receivables/riba/riba'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { allocateInCommand, insertPayment, recordingCommand } from '../../payments/payments'
import { officeContextOf, receivablesCommand, tenantIdOf, today } from '../store'
import { batchAnswerIn } from './batches'
import { dateValue, day, itemsOf, lockBatch, lockRiba, openNowOf, readBatch, refusedRiba } from './store'

/**
 * Settling a Ri.Ba. batch's items (B-W2b-402; FIN-126: "unpaid returns (insoluti) reopen the invoice with the fees"), ONE
 * command for the items named (all or none), under the company's Ri.Ba. lock and the batch at its version:
 *
 *   PAID     the customer's bank paid on its due day: a Payment of the item's amount (bank reference RIBA-<item id>: a receipt
 *            is counted once; received on the day settled) recorded for the customer and placed on the invoice (W1's
 *            allocateInCommand: as much as is still open on it, the rest stays on account); payments.record is needed too
 *   UNPAID   it came back (an insoluto), with the bank's fee: nothing is recorded, the invoice was never closed by the batch,
 *            so it is open again for the reminders, the ageing and a later batch; the fee is the company's to charge to the
 *            customer (a debit note a person makes in Invoicing: the VAT of a re-charged bank fee is the accountant's word)
 * The bank's one credit for the whole batch is matched to these payments by a person in Bank (B-W2b-393): one bank line for
 * many customers cannot be split by the matcher (a gap named in the notes).
 *
 *   POST /receivables/riba/batches/:batchId/settle   riba.manage (+ payments.record for PAID)
 *   GET  /receivables/riba/unpaid                    receivables.view: the tile "Ri.Ba. unpaid" and its list
 */

/** POST /receivables/riba/batches/:batchId/settle. */
export async function settleItems(caller: CommandCaller, batchId: string, body: SettleBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const peek = await caller.withClient((db) => readBatch(db, batchId))
  if (!peek || !can(actor, RECEIVABLES_VIEW, { companyId: peek.companyId })) throw new NotFoundError('Ri.Ba. batch not found.')
  if (!can(actor, RECEIVABLES_RIBA_MANAGE, { companyId: peek.companyId })) throw new ForbiddenError()
  const seen = new Set<string>()
  const duplicates: Issue[] = body.items.flatMap((item, index) => (seen.has(item.itemId) ? [{ path: `body/items/${index}`, message: 'Each item once.' }] : (seen.add(item.itemId), [])))
  if (duplicates.length > 0) throw new ValidationError(duplicates[0]!.message, duplicates)
  return recordingCommand(async () => {
    const { result } = await receivablesCommand(caller, { name: 'receivables.ribaSettle', idempotencyKey, input: { batchId, ...body } }, async (tools) => {
      const { tx } = tools
      await lockRiba(tx, tenantIdOf(tools.context), peek.companyId)
      const batch = await lockBatch(tx, batchId, body.version)
      if (batch.status !== 'ISSUED') throw refusedRiba('NOT_ISSUED')
      const items = new Map((await itemsOf(tx, batch.id)).map((item) => [item.id, item]))
      const onDay = today()
      const problems: Issue[] = []
      for (const [index, asked] of body.items.entries()) {
        const item = items.get(asked.itemId)
        const at = `body/items/${index}`
        if (!item) {
          problems.push({ path: `${at}/NOT_IN_BATCH`, message: RIBA_REFUSALS.NOT_IN_BATCH })
          continue
        }
        if (!can(actor, RECEIVABLES_RIBA_MANAGE, { companyId: item.companyId, partyId: item.partyId })) throw new ForbiddenError('This batch collects from a customer you may not act for.')
        if (asked.status === 'PAID' && !can(actor, PAYMENTS_RECORD, { companyId: item.companyId, partyId: item.partyId })) throw new ForbiddenError('Recording an instalment paid records its payment: it needs payments.record too.')
        const refusal = settleProblem({ status: item.status, dueDate: day(item.dueDate) }, asked, onDay)
        if (refusal) problems.push({ path: `${at}/${refusal}`, message: RIBA_REFUSALS[refusal] })
      }
      if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'None of the instalments was settled: some cannot be.', problems)
      for (const asked of body.items) {
        const item = items.get(asked.itemId)!
        let paymentId: string | null = null
        if (asked.status === 'PAID') {
          const payment = await insertPayment(tools, { companyId: item.companyId, partyId: item.partyId, amount: item.amount, currency: 'EUR', receivedOn: asked.settledOn, externalRef: ribaPaymentReference(item.id), method: 'BANK_TRANSFER', internalNote: `Ri.Ba. ${batch.id.slice(0, 8)}: instalment ${item.instalment}, due ${day(item.dueDate)}` })
          paymentId = payment.id
          const open = (await openNowOf(tx, [item.invoiceId], onDay)).get(item.invoiceId) ?? 0
          const placed = Math.min(open, item.amount)
          if (placed > 0) await allocateInCommand(tools, payment, [{ invoiceId: item.invoiceId, amount: placed }], 'items')
        }
        await tx.ribaItem.update({ where: { id: item.id }, data: { status: asked.status, settledOn: dateValue(asked.settledOn), unpaidFee: asked.status === 'UNPAID' ? asked.unpaidFee! : null, version: item.version + 1, updatedAt: tools.now }, select: { id: true } })
        tools.audit({ action: 'receivables.ribaSettle', recordType: 'RibaItem', recordId: item.id, companyId: item.companyId, before: { status: 'ISSUED' }, after: { status: asked.status, settledOn: asked.settledOn, invoiceId: item.invoiceId, paymentId, ...(asked.status === 'UNPAID' ? { unpaidFee: markMoney('price', asked.unpaidFee!) } : {}) } })
        tools.emit({ type: 'riba_item.settled', subject: item.id, companyId: item.companyId, payload: { batchId: batch.id, itemId: item.id, invoiceId: item.invoiceId, partyId: item.partyId, status: asked.status, paymentId } })
      }
      // An issued batch never changes (the database): its items carry the settlement and their own versions.
      return batchAnswerIn(tx, tools.context, batch.id)
    })
    return result
  })
}

/** GET /receivables/riba/unpaid (receivables.view): returned instalments whose invoice is still open and not presented again. */
export async function listUnpaid(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), RECEIVABLES_VIEW, { company: 'companyId', party: 'partyId' })
  return caller.withClient(async (db) => {
    const rows = await db.ribaItem.findMany({ where: { AND: [scope as object, { status: 'UNPAID' }, query.companyId ? { companyId: query.companyId } : {}] }, orderBy: [{ settledOn: 'desc' }, { id: 'asc' }], take: 1000, select: { id: true, batchId: true, companyId: true, partyId: true, invoiceId: true, instalment: true, dueDate: true, settledOn: true, amount: true, unpaidFee: true } })
    // Presented again since (a live item of the same instalment in a later batch): no longer waiting.
    const again = rows.length === 0 ? [] : await db.ribaItem.findMany({ where: { invoiceId: { in: [...new Set(rows.map((row) => row.invoiceId))] }, OR: [{ batch: { status: 'DRAFT' } }, { batch: { status: 'ISSUED' }, status: { in: ['ISSUED', 'PAID'] } }] }, select: { invoiceId: true, instalment: true } })
    const presented = new Set(again.map((item) => `${item.invoiceId}|${item.instalment}`))
    const open = await openNowOf(db, rows.map((row) => row.invoiceId), today())
    const waiting = rows.filter((row) => !presented.has(`${row.invoiceId}|${row.instalment}`) && (open.get(row.invoiceId) ?? 0) > 0)
    const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(waiting.map((row) => row.companyId))] } }, select: { id: true, code: true, legalName: true, currency: true } })).map((row) => [row.id, row]))
    const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(waiting.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
    const invoices = new Map((await db.invoice.findMany({ where: { id: { in: [...new Set(waiting.map((row) => row.invoiceId))] } }, select: { id: true, number: true, currency: true } })).map((row) => [row.id, row]))
    const onDay = today()
    const items = waiting.map((row) => ({
      itemId: row.id,
      batchId: row.batchId,
      company: { id: row.companyId, code: companies.get(row.companyId)?.code ?? '', name: companies.get(row.companyId)?.legalName ?? '' },
      customer: { id: row.partyId, code: parties.get(row.partyId)?.code ?? '', name: parties.get(row.partyId)?.legalName ?? '' },
      invoice: { id: row.invoiceId, number: invoices.get(row.invoiceId)?.number ?? null },
      instalment: row.instalment,
      dueDate: day(row.dueDate),
      settledOn: day(row.settledOn!),
      amount: asMoney('price', row.amount),
      unpaidFee: asMoney('price', row.unpaidFee ?? 0),
      invoiceOpen: asMoney('price', open.get(row.invoiceId) ?? 0),
      currency: invoices.get(row.invoiceId)?.currency ?? 'EUR',
      daysSince: daysBetween(day(row.settledOn!), onDay),
    }))
    const tiles = new Map<string, { currency: string; count: number; open: number; fees: number }>()
    for (const item of items) {
      const tile = tiles.get(item.currency) ?? { currency: item.currency, count: 0, open: 0, fees: 0 }
      tile.count++
      tile.open += Math.min(item.amount, item.invoiceOpen)
      tile.fees += item.unpaidFee
      tiles.set(item.currency, tile)
    }
    return { tiles: [...tiles.values()].map((tile) => ({ ...tile, open: asMoney('price', tile.open), fees: asMoney('price', tile.fees) })), items }
  })
}
