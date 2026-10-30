import type { Prisma } from '@nexus/factory-db'
import { chargeVat, freightLine } from '@nexus/factory-domain/invoicing/charges/charges'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { chooseInvoiceType, type ShipInvoiceType, type TypeChoice } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import { planDeductions, type DeductionPlan } from '@nexus/factory-domain/invoicing/from-shipment/deductions'
import { draftGoodsLines, isShippedState, notInvoiced, pickPart, type AskedPart, type DraftSource, type NotInvoicedRow, type OrderLinePrice } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import { computeInvoiceTotals, MAX_CAUSALE, MAX_INVOICE_LINES } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { isItalianVatRate, STANDARD_VAT_RATE } from '@nexus/factory-domain/tax/vat-rates'
import { TaxRuleError } from '@nexus/factory-domain/tax/rules'
import { decideVatTreatment, treatmentKey, type CustomerTaxProfile, type VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { decidedVat, insertDraft, type PaymentInput, type PreparedLine } from '../drafts'
import { partyFacts } from '../facts'
import { assertMay, invoiceDetail, officeContextOf, readInvoice, type InvoiceDetail } from '../store'
import { orderTermsSource } from '../terms'
import { lockInvoicing } from './locks'
import { depositInvoicesOf, freightBilledOf, freightOf, invoicedOf, orderPrices, presetsOf, readDdts, shippedOf, type DdtRow } from './store'

/**
 * The draft invoice of shipped goods (B-W1-51; FIN-054, FIN-055, FIN-059, FIN-078, FIN-098; A2 SCR-080 "Invoice shipped
 * goods"): the office picks DDTs of one customer and company; ONE command, under the DDTs' locks ('ddt', id order):
 *
 *   1. the DDTs again: live (not cancelled), their goods shipped (SHIPPED or DELIVERED), one company and customer;
 *   2. what is left to invoice per DDT, order line and size: shipped less what issued invoices and other drafts bill
 *      (shipped/notInvoiced): nothing left → 409 naming the invoices that hold it (a DDT is billed once). B-W2a-54
 *      (FIN-058, partial invoicing per shipment): `lines` asks for a part only (shipped/pickPart: each at most what is
 *      left); the rest stays shipped, not invoiced, with its deadline;
 *   3. the type and its deadline (deadlines/chooseInvoiceType: TD01 for one DDT within 12 days, else TD24 by the 15th of
 *      the next month; the office may ask for the other while it is in time). B-W2a-54 (FIN-065): the customer's preset
 *      (Party.invoiceTiming: monthly → TD24) is the suggestion whenever the law allows it;
 *   4. the goods lines, priced from the order (the size's price, else the line's; net) and taxed by the VAT rules for the
 *      customer today on the order line's rate (FIN-098); each line names its DDT, order line and size;
 *   5. B-W2a-54 (FIN-060): each shipment's freight (Shipment.freightCharge, B-W2a-48) as a FREIGHT charge line naming its
 *      DDT, once per shipment (not when another invoice or draft bills it; `freight: false` leaves it out), its VAT the
 *      goods' (factory-domain invoicing/charges chargeVat); the ones left out are answered with why;
 *   6. the deposits: every issued TD02 of the orders deducted once (deductions/planDeductions), as DEPOSIT_DEDUCTION lines
 *      the office may only remove;
 *   7. the draft (drafts.ts insertDraft: totals, billTo, the audit row, invoice.draft_saved), its order when it bills one,
 *      the customer's purchase orders (DatiOrdineAcquisto) from the orders, and (B-W2a-54) the payment terms of the order
 *      it bills, else the customer's (../terms.ts), unless the office gives its own.
 * The draft is issued and sent like any invoice (issue.ts, sdi/): the issue checks the DDTs, the freight and the
 * deductions again under their locks. One deferred invoice for a customer's month (deferred.ts) is made the same way.
 */

export interface FromDdtsInput {
  readonly ddtIds: readonly string[]
  readonly docType?: ShipInvoiceType | undefined
  /** B-W2a-54 (FIN-058): only these garments; left out, all that is left of the DDTs. */
  readonly lines?: readonly AskedPart[] | undefined
  /** B-W2a-54 (FIN-060): the shipments' freight as charge lines (default true). */
  readonly freight?: boolean | undefined
  readonly causale?: string | null | undefined
  readonly payment?: PaymentInput | null | undefined
  readonly internalNote?: string | null | undefined
}

export interface FromDdtsAnswer {
  readonly invoice: InvoiceDetail
  readonly choice: Omit<TypeChoice, 'allowed' | 'problems'> & { allowed: ShipInvoiceType[] }
  readonly deductions: DeductionPlan['skipped'][number][]
  /** B-W2a-54: the shipments' freight not billed here, and why. */
  readonly freight: { readonly ddtId: string; readonly number: string; readonly reason: string }[]
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** The VAT of an order line for this customer today: the rules, on the order line's own rate when it is taxed. */
export function vatFor(profile: CustomerTaxProfile | null): (line: OrderLinePrice) => VatTreatment | Issue {
  return (line) => {
    if (profile === null) return { path: 'party/taxIdentity', message: "The customer has no tax identity in force: add it before invoicing." }
    const rate = line.vatRatePct === null ? STANDARD_VAT_RATE : Number.parseInt(line.vatRatePct, 10)
    try {
      return decideVatTreatment({ customer: profile, supply: 'GOODS', rate: isItalianVatRate(rate) ? rate : STANDARD_VAT_RATE, goodsLeaveEu: true }).treatment
    } catch (error) {
      if (error instanceof TaxRuleError) return { path: 'party/taxIdentity', message: error.message }
      throw error
    }
  }
}

const words = (issues: readonly Issue[], fallback: string): string => (issues.length === 1 ? issues[0]!.message : fallback)

/** The customer and company of DDTs read before the command: the caller may see them and make invoices of them. */
export interface DraftScope {
  readonly companyId: string
  readonly partyId: string
}

/** What the draft is made with, read before the command. */
export interface DraftPlan {
  readonly currency: string
  readonly profile: CustomerTaxProfile | null
}

export async function draftPlanOf(caller: CommandCaller, scope: DraftScope): Promise<DraftPlan> {
  return caller.withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: scope.companyId }, select: { currency: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const facts = await partyFacts(client, scope.partyId, businessDate(serverClock.now()), serverClock.now())
    return { currency: company.currency, profile: facts?.profile ?? null }
  })
}

/**
 * Inside a command: the draft of the shipped goods of these DDTs (steps 1–7 above), under their locks. `action` names the
 * audit row (invoices.fromDdts, invoices.deferred).
 */
export async function draftFromDdtsInCommand(tools: CommandTools, scope: DraftScope, ids: readonly string[], body: FromDdtsInput, plan: DraftPlan, action: string): Promise<FromDdtsAnswer> {
  const { tx } = tools
  await lockInvoicing(tx, tools.context, 'ddt', ids)
  // 1. The DDTs, under their locks.
  const ddts = await readDdts(tx, { id: { in: [...ids] } })
  const problems: Issue[] = []
  ddts.forEach((ddt) => {
    const at = `body/ddtIds/${ids.indexOf(ddt.id)}`
    if (ddt.companyId !== scope.companyId || ddt.partyId !== scope.partyId) problems.push({ path: at, message: `DDT ${ddt.number} is of another customer or company.` })
    else if (ddt.cancelled) problems.push({ path: at, message: `DDT ${ddt.number} was cancelled: invoice the DDT that replaced it.` })
    else if (!isShippedState(ddt.shipmentStatus)) problems.push({ path: at, message: `The goods of DDT ${ddt.number} have not left yet (shipment ${ddt.shipmentNumber} is ${ddt.shipmentStatus}).` })
  })
  if (problems.length > 0) throw new ConflictError(words(problems, 'These DDTs cannot be invoiced now.'))

  // 2. What is left to invoice (all of it, or the part asked).
  const rows = notInvoiced(await shippedOf(tx, ddts), await invoicedOf(tx, ids))
  let left: NotInvoicedRow[] = rows.filter((row) => row.toInvoice.gt(0))
  if (body.lines !== undefined) {
    const part = pickPart(rows, body.lines, new Map(ddts.map((ddt) => [ddt.id, ddt.number])))
    if (part.problems.length > 0) throw new DomainError('conflict', words(part.problems, 'These garments cannot be invoiced now.'), part.problems)
    left = part.rows
  }
  if (left.length === 0) {
    const holders = [...new Map(rows.flatMap((row) => row.invoices).map((invoice) => [invoice.invoiceId, invoice])).values()]
    const issued = holders.filter((invoice) => !invoice.draft).map((invoice) => invoice.number)
    const drafts = holders.filter((invoice) => invoice.draft)
    const named = ddts.map((ddt) => ddt.number).join(', ')
    throw new ConflictError(
      issued.length > 0 && drafts.length > 0
        ? `DDT ${named} is invoiced already (${issued.join(', ')}) and the rest is in a draft invoice already (${drafts.map((invoice) => invoice.invoiceId).join(', ')}): issue or delete the draft.`
        : issued.length > 0
        ? `DDT ${named} is invoiced already (${issued.join(', ')}): shipped goods are invoiced once; a correction is a credit note.`
        : drafts.length > 0
          ? `The goods of DDT ${named} are in a draft invoice already (${drafts.map((invoice) => invoice.invoiceId).join(', ')}): issue or delete it.`
          : `DDT ${named} carried nothing to invoice.`,
    )
  }

  // 3. The type and its deadline (only the DDTs with something left count), the customer's preset suggested.
  const billed = ddts.filter((ddt) => left.some((row) => row.ddtId === ddt.id))
  const preset = (await presetsOf(tx, [scope.partyId])).get(scope.partyId)?.preset
  const choice = chooseInvoiceType(billed.map((ddt) => ({ number: ddt.number, date: ddt.date })), businessDate(tools.now), body.docType, 'body/docType', preset)
  if (choice.docType === null) throw new ConflictError(words(choice.problems, choice.words))

  // 4. The goods lines.
  const prices = await orderPrices(tx, left.map((row) => row.salesOrderLineId))
  const sources: DraftSource[] = left.map((row) => {
    const ddt = billed.find((entry) => entry.id === row.ddtId)!
    return { ddtId: row.ddtId, ddtNumber: ddt.number, ddtDate: ddt.date, salesOrderLineId: row.salesOrderLineId, size: row.size, quantity: row.toInvoice }
  })
  const goods = draftGoodsLines(sources, prices, vatFor(plan.profile))
  if (goods.problems.length > 0) throw new ConflictError(words(goods.problems, 'The shipped goods cannot be priced from their orders.'))

  // 5. The shipments' freight, once each.
  const freightLines: PreparedLine[] = []
  const freightLeft: FromDdtsAnswer['freight'] = []
  if (body.freight !== false) {
    const taken = await freightBilledOf(tx, billed.map((ddt) => ddt.id))
    const vat = chargeVat(goods.lines.map((line) => line.core.vat), decidedVat(plan.profile, 'GOODS', 'party/taxIdentity'))
    for (const ddt of billed) {
      const holder = taken.find((row) => row.ddtId === ddt.id)
      if (holder) {
        freightLeft.push({ ddtId: ddt.id, number: ddt.number, reason: `The freight of DDT ${ddt.number} is on ${holder.draft ? 'a draft invoice' : `invoice ${holder.invoiceNumber}`} already.` })
        continue
      }
      if ('path' in vat) {
        freightLeft.push({ ddtId: ddt.id, number: ddt.number, reason: vat.message })
        continue
      }
      const made = freightLine(freightOf(ddt), plan.currency, vat)
      if ('skipped' in made) freightLeft.push({ ddtId: ddt.id, number: ddt.number, reason: made.skipped })
      else freightLines.push({ core: made.line, salesOrderLineId: null, size: null, ddtId: ddt.id, chargeKind: 'FREIGHT' })
    }
  }

  // 6. The deposits of the orders, each deducted once.
  const orderIds = [...new Set([...prices.values()].map((price) => price.orderId))]
  const goodsTotals = computeInvoiceTotals(goods.lines.map((line) => line.core), 'NET', plan.currency)
  const goodsNet = new Map<string, number>()
  goods.lines.forEach((line, index) => {
    const key = treatmentKey(line.core.vat)
    goodsNet.set(key, (goodsNet.get(key) ?? 0) + goodsTotals.lines[index]!.netAmount)
  })
  const deposits = await depositInvoicesOf(tx, { orderIds }, { deductions: 'all', except: null })
  const deductions = planDeductions(deposits.filter((deposit) => deposit.companyId === scope.companyId), goodsNet, plan.currency)

  // 7. The draft.
  const lines: PreparedLine[] = [
    ...goods.lines.map((line) => ({ core: line.core, salesOrderLineId: line.salesOrderLineId, size: line.size, ddtId: line.ddtId })),
    ...freightLines,
    ...deductions.lines.map((line) => ({ core: line.core, salesOrderLineId: null, size: null, ddtId: null, depositInvoiceId: line.depositInvoiceId })),
  ]
  if (lines.length > MAX_INVOICE_LINES) {
    throw new ConflictError(`These DDTs make ${lines.length} invoice lines; one invoice holds at most ${MAX_INVOICE_LINES}. Invoice them in parts (choose fewer DDTs or garments).`)
  }
  const refs = [...new Set([...prices.values()].flatMap((price) => (price.customerRef ? [price.customerRef.trim().slice(0, 20)] : [])))].slice(0, 20)
  const id = newId()
  const salesOrderId = orderIds.length === 1 ? orderIds[0]! : null
  const defaultCausale = choice.docType === 'TD24' ? 'Fattura differita (art. 21 c.4 lett. a DPR 633/1972)' : null
  await insertDraft(
    tools,
    {
      id,
      companyId: scope.companyId,
      buyerPartyId: scope.partyId,
      docType: choice.docType,
      priceBasis: 'NET',
      currency: plan.currency,
      salesOrderId,
      depositRequestId: null,
      causale: (body.causale === undefined ? defaultCausale : blankToNull(body.causale))?.slice(0, MAX_CAUSALE) ?? null,
      documentRefs: refs.length > 0 ? (refs.map((number) => ({ kind: 'PURCHASE_ORDER', number })) as Prisma.InputJsonValue) : null,
      payment: body.payment ?? null,
      termsSource: body.payment ? null : await orderTermsSource(tx, { salesOrderId, partyId: scope.partyId }),
      internalNote: blankToNull(body.internalNote),
    },
    lines,
  )
  tools.audit({
    action,
    recordType: 'Invoice',
    recordId: id,
    companyId: scope.companyId,
    after: {
      ddts: billed.map((ddt) => ddt.number),
      docType: choice.docType,
      suggested: choice.suggested,
      preset: preset ?? null,
      dueBy: choice.deadline?.dueBy ?? null,
      pieces: left.reduce((sum, row) => sum.plus(row.toInvoice), new Dec(0)).toString(),
      part: body.lines !== undefined,
      freight: freightLines.map((line) => line.ddtId),
      deducted: deductions.lines.map((line) => line.depositInvoiceId),
      notDeducted: deductions.skipped.map((entry) => entry.depositInvoiceId),
    },
  })
  const { problems: _problems, ...shown } = choice
  return { invoice: await invoiceDetail(tx, (await readInvoice(tx, id))!), choice: { ...shown, allowed: [...choice.allowed] }, deductions: [...deductions.skipped], freight: freightLeft }
}

/** The DDTs of a request, read before the command, and their customer: one customer and company, else 400. */
export function scopeOfDdts(ddts: readonly DdtRow[], asked: number): DraftScope | null {
  const first = ddts[0]
  if (!first || ddts.length !== asked) return null
  if (ddts.some((ddt) => ddt.companyId !== first.companyId || ddt.partyId !== first.partyId)) {
    throw new ValidationError('One invoice bills one customer of one company: these DDTs are of several.', [{ path: 'body/ddtIds', message: 'DDTs of one customer and company.' }])
  }
  return { companyId: first.companyId, partyId: first.partyId }
}

/** invoices.manage: a TD01/TD24 draft of the shipped goods of these DDTs (or a part of them), freight and deposits included. */
export async function createFromDdts(caller: CommandCaller, body: FromDdtsInput, idempotencyKey?: string): Promise<FromDdtsAnswer> {
  const context = officeContextOf(caller)
  const ids = [...new Set(body.ddtIds)]
  if (ids.length === 0 || ids.some((id) => !isUuid(id))) throw new ValidationError('Choose the DDTs to invoice.', [{ path: 'body/ddtIds', message: 'Expected one or more DDT ids.' }])
  const first = await caller.withClient((client) => readDdts(client, { id: { in: ids } }))
  const scope = first.length === ids.length && first[0] ? { companyId: first[0].companyId, partyId: first[0].partyId } : null
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, scope, 'DDT')
  scopeOfDdts(first, ids.length)
  const plan = await draftPlanOf(caller, scope!)
  const { result } = await command(caller, { name: 'invoices.createFromDdts', idempotencyKey, input: body }, (tools) => draftFromDdtsInCommand(tools, scope!, ids, body, plan, 'invoices.fromDdts'))
  return result
}
