import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { PpvPostBody, PpvRowView, PpvSkipView } from '@nexus/factory-domain/costing/ppv/contracts'
import { ppvKeys, type PpvRefusal } from '@nexus/factory-domain/costing/ppv/rules'
import { ACCOUNTANT_WAITS } from '@nexus/factory-domain/costing/ppv/settings'
import { COSTING_LEDGER_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/materials/store'
import type { Reader } from '../actual/store'
import { planInvoice, planReceipt, writeVariances, type PpvPlan } from './post'
import { ppvViews, VARIANCE_COLUMNS } from './reads'
import { actualSettingsOf, hardLockWords, refusalOf } from './settings'

/**
 * The writes of the purchase price variance (B-W2b-407; FIN-031): post a receipt's or an invoice's variances now (the
 * catch-up of what the worker does after its event: costing.ledger.manage over the document's company and supplier) and
 * reverse one variance with a reason; and the worker's two moves (./handlers.ts): take a document's variances after its
 * event, take back a document's live variances when it is reversed or voided. Every refusal in words.
 */

const refused = (code: PpvRefusal, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

const planOf = (db: Reader, body: PpvPostBody, ids?: () => string) => (body.receiptId ? planReceipt(db, body.receiptId, ids) : planInvoice(db, body.supplierInvoiceId!, ids))

/** Why a plan cannot be written now (the company's switch, its place, the document's state, a HARD lock), or null. */
async function blockOf(db: Reader, plan: PpvPlan, now: Date): Promise<DomainError | null> {
  const settings = await actualSettingsOf(db, plan.companyId)
  if (!settings.postingsOn) return refused('WAITS_FOR_ACCOUNTANT', ACCOUNTANT_WAITS)
  if (settings.ppvAt !== plan.at) {
    return refused('OTHER_PLACE', `The company takes its purchase price variance at the ${settings.ppvAt === 'RECEIPT' ? 'goods receipt' : "supplier's invoice"}, not at the ${plan.at === 'RECEIPT' ? 'receipt' : 'invoice'}: nothing to take here.`)
  }
  if (!plan.ready) {
    return refused(
      'NOT_READY',
      plan.at === 'RECEIPT'
        ? `Receipt ${plan.number} is ${plan.status}: a variance is taken at a POSTED receipt.`
        : plan.status === 'CREDIT_NOTE'
          ? `${plan.number} is a credit note: it is not a purchase price, so it takes no variance.`
          : `Invoice ${plan.number} is ${plan.status}: a variance is taken once it is approved.`,
    )
  }
  const locked = await hardLockWords(db, plan.companyId, businessDate(now))
  return locked ? refused('LOCKED', locked) : null
}

/** POST /costing/ppv/post */
export async function postDocument(caller: CommandCaller, body: PpvPostBody, idempotencyKey?: string): Promise<{ posted: PpvRowView[]; skipped: PpvSkipView[]; replayed: boolean }> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const id = body.receiptId ?? body.supplierInvoiceId!
  const seen = isUuid(id) ? await caller.withClient((db) => planOf(db, body)) : null
  const party = seen ? await caller.withClient((db) => partyOf(db, body)) : null
  if (!seen || !party || !can(actor, COSTING_VIEW, { companyId: seen.companyId, partyId: party })) throw new NotFoundError(body.receiptId ? 'Goods receipt not found.' : 'Supplier invoice not found.')
  if (!can(actor, COSTING_LEDGER_MANAGE, { companyId: seen.companyId, partyId: party })) throw new ForbiddenError()
  const { result, replayed } = await command(caller, { name: 'costing.postPurchasePriceVariance', idempotencyKey, input: body }, async (tools) => {
    const plan = (await planOf(tools.tx, body))!
    const block = await blockOf(tools.tx, plan, tools.now)
    if (block) throw block
    let ids: string[]
    try {
      ids = await writeVariances(tools, plan)
    } catch (error) {
      throw refusalOf(error)
    }
    if (ids.length === 0) tools.audit({ action: 'costing.postPurchasePriceVariance', recordType: plan.at === 'RECEIPT' ? 'GoodsReceipt' : 'SupplierInvoice', recordId: plan.documentId, companyId: plan.companyId, after: { posted: 0, skipped: plan.skipped.map((row) => row.code) } })
    const rows = await tools.tx.purchasePriceVariance.findMany({ where: { id: { in: ids } }, select: VARIANCE_COLUMNS, orderBy: { id: 'asc' } })
    return { posted: await ppvViews(tools.tx, rows), skipped: plan.skipped }
  })
  return { ...result, replayed }
}

async function partyOf(db: Reader, body: PpvPostBody): Promise<string | null> {
  if (body.receiptId) return (await db.goodsReceipt.findUnique({ where: { id: body.receiptId }, select: { supplierId: true } }))?.supplierId ?? null
  return (await db.supplierInvoice.findUnique({ where: { id: body.supplierInvoiceId! }, select: { partyId: true } }))?.partyId ?? null
}

/** The reversal rows of live variances, inside the caller's command (a reversal waits for no switch). */
async function reverseInCommand(tools: CommandTools, ids: readonly string[], reason: string): Promise<{ reversalIds: string[]; originals: string[] }> {
  const { tx, now } = tools
  const rows = await tx.purchasePriceVariance.findMany({ where: { id: { in: [...ids] } }, select: { ...VARIANCE_COLUMNS, siteId: true } })
  const taken = new Set((await tx.purchasePriceVariance.findMany({ where: { reversalOfId: { in: [...ids] } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId!))
  const live = rows.filter((row) => row.reversalOfId === null && !taken.has(row.id))
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const reversals = live.map((row) => ({
    id: newId(),
    companyId: row.companyId,
    partyId: row.partyId,
    at: row.at,
    siteId: row.siteId,
    receiptLineId: row.receiptLineId,
    supplierInvoiceLineId: row.supplierInvoiceLineId,
    itemId: row.itemId,
    quantity: row.quantity.negated().toFixed(4),
    standardUnitCost: row.standardUnitCost.toFixed(6),
    standardCostId: row.standardCostId,
    paidUnitCost: row.paidUnitCost.toFixed(6),
    differenceAmount: -row.differenceAmount,
    currency: row.currency,
    postedAt: now,
    reversalOfId: row.id,
    reason,
    idempotencyKey: ppvKeys.reversal(row.id),
    createdAt: now,
    createdById,
  }))
  if (reversals.length > 0) {
    try {
      await tx.purchasePriceVariance.createMany({ data: reversals })
    } catch (error) {
      throw refusalOf(error)
    }
  }
  return { reversalIds: reversals.map((row) => row.id), originals: live.map((row) => row.id) }
}

/** POST /costing/ppv/:varianceId/reverse */
export async function reverseVariance(caller: CommandCaller, varianceId: string, reason: string, idempotencyKey?: string): Promise<{ variance: PpvRowView; reversal: PpvRowView; replayed: boolean }> {
  const actor = actorOf(contextOf(caller))
  const seen = isUuid(varianceId) ? await caller.withClient((db) => db.purchasePriceVariance.findUnique({ where: { id: varianceId }, select: { companyId: true, partyId: true } })) : null
  if (!seen || !can(actor, COSTING_VIEW, { companyId: seen.companyId, partyId: seen.partyId })) throw new NotFoundError('Purchase price variance not found.')
  if (!can(actor, COSTING_LEDGER_MANAGE, { companyId: seen.companyId, partyId: seen.partyId })) throw new ForbiddenError()
  const { result, replayed } = await command(caller, { name: 'costing.reversePurchasePriceVariance', idempotencyKey, input: { varianceId, reason } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.purchasePriceVariance.findUniqueOrThrow({ where: { id: varianceId }, select: { ...VARIANCE_COLUMNS } })
    if (row.reversalOfId) throw refused('IS_REVERSAL', 'This row takes back another variance: it is not reversed in turn (post the document again).')
    const taken = await tx.purchasePriceVariance.findFirst({ where: { reversalOfId: varianceId }, select: { postedAt: true, reason: true } })
    if (taken) throw refused('REVERSED_ALREADY', `This variance was taken back on ${businessDate(taken.postedAt)}${taken.reason ? ` (${taken.reason})` : ''}: a variance is reversed once.`)
    const locked = await hardLockWords(tx, row.companyId, businessDate(now))
    if (locked) throw refused('LOCKED', locked)
    const { reversalIds } = await reverseInCommand(tools, [varianceId], reason)
    tools.audit({ action: 'costing.reversePurchasePriceVariance', recordType: 'PurchasePriceVariance', recordId: varianceId, companyId: row.companyId, after: { reversalId: reversalIds[0], differenceAmount: markMoney('cost', -row.differenceAmount) }, reason })
    tools.emit({ type: 'purchase_price_variance.posted', subject: varianceId, companyId: row.companyId, payload: { at: row.at, documentId: await documentOf(tx, row), varianceIds: reversalIds, reversals: reversalIds.length } })
    const views = await ppvViews(tx, await tx.purchasePriceVariance.findMany({ where: { id: { in: [varianceId, ...reversalIds] } }, select: VARIANCE_COLUMNS }))
    return { variance: views.find((view) => view.id === varianceId)!, reversal: views.find((view) => view.id === reversalIds[0])! }
  })
  return { ...result, replayed }
}

async function documentOf(db: Reader, row: { receiptLineId: string | null; supplierInvoiceLineId: string | null }): Promise<string> {
  if (row.receiptLineId) return (await db.goodsReceiptLine.findUniqueOrThrow({ where: { id: row.receiptLineId }, select: { receiptId: true } })).receiptId
  return (await db.supplierInvoiceLine.findUniqueOrThrow({ where: { id: row.supplierInvoiceLineId! }, select: { invoiceId: true } })).invoiceId
}

/**
 * The worker after a receipt posted or an invoice approved: its variances, when the company takes them there and its
 * figures are on (nothing else is a mistake: the event is simply not one that takes a variance). A dry plan first, so an
 * event with nothing to take writes no command.
 */
export async function postForEvent(caller: CommandCaller, document: { readonly receiptId?: string; readonly supplierInvoiceId?: string }, eventId: string): Promise<number> {
  const body = document.receiptId ? { receiptId: document.receiptId } : { supplierInvoiceId: document.supplierInvoiceId! }
  const dry = await caller.withClient(async (db) => {
    const plan = await planOf(db, body)
    return plan && plan.drafts.length > 0 && !(await blockOf(db, plan, new Date())) ? plan : null
  })
  if (!dry) return 0
  const { result } = await command(caller, { name: 'costing.postPurchasePriceVariance', idempotencyKey: `ppv-post:${eventId}`, input: body, causationId: eventId }, async (tools) => {
    const plan = (await planOf(tools.tx, body))!
    const block = await blockOf(tools.tx, plan, tools.now)
    const written = block ? [] : await writeVariances(tools, plan)
    if (written.length === 0) tools.audit({ action: 'costing.postPurchasePriceVariance', recordType: plan.at === 'RECEIPT' ? 'GoodsReceipt' : 'SupplierInvoice', recordId: plan.documentId, companyId: plan.companyId, after: { posted: 0, waits: block?.message ?? null } })
    return written.length
  })
  return result
}

/** The worker after a receipt reversed or an invoice voided: its live variances taken back (no switch needed). */
export async function reverseForEvent(caller: CommandCaller, document: { readonly receiptId?: string; readonly supplierInvoiceId?: string }, eventId: string, reason: string): Promise<number> {
  const where = document.receiptId
    ? { receiptLine: { receiptId: document.receiptId } }
    : { supplierInvoiceLine: { invoiceId: document.supplierInvoiceId! } }
  const live = await caller.withClient(async (db) => {
    const rows = await db.purchasePriceVariance.findMany({ where: { ...where, reversalOfId: null }, select: { id: true, companyId: true, at: true } })
    const taken = new Set((await db.purchasePriceVariance.findMany({ where: { reversalOfId: { in: rows.map((row) => row.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId!))
    return rows.filter((row) => !taken.has(row.id))
  })
  if (live.length === 0) return 0
  const { result } = await command(caller, { name: 'costing.reversePurchasePriceVariance', idempotencyKey: `ppv-reverse:${eventId}`, input: { ...document, reason }, causationId: eventId }, async (tools) => {
    const { reversalIds, originals } = await reverseInCommand(tools, live.map((row) => row.id), reason)
    const documentId = document.receiptId ?? document.supplierInvoiceId!
    tools.audit({ action: 'costing.reversePurchasePriceVariance', recordType: document.receiptId ? 'GoodsReceipt' : 'SupplierInvoice', recordId: documentId, companyId: live[0]!.companyId, after: { reversed: originals, reversalIds }, reason })
    if (reversalIds.length > 0) tools.emit({ type: 'purchase_price_variance.posted', subject: documentId, companyId: live[0]!.companyId, payload: { at: live[0]!.at, documentId, varianceIds: reversalIds, reversals: reversalIds.length } })
    return reversalIds.length
  })
  return result
}
