import { z } from 'zod'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { fromMinorUnits, type MinorUnits } from '@nexus/factory-domain/core/money'
import { businessDate } from '@nexus/factory-domain/core/time'
import { chargeVat } from '@nexus/factory-domain/invoicing/charges/charges'
import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { documentCurrencyProblem } from '@nexus/factory-domain/invoicing/language-currency/language-currency'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { FEE_WORDS } from '@nexus/factory-domain/sales/price-waterfall/rules'
import type { SalesFeeKind } from '@nexus/factory-domain/sales/quotes/quotes'
import type { VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { tenantOf } from '../../payments/locks'
import { feeLinesFor, feesBilledOf, lockFees } from '../../sales/price-waterfall/fee-invoicing'
import { creditNoteInCommand } from '../credit-note/credit-note'
import { decidedVat, insertDraft, type PreparedLine } from '../drafts'
import { partyFacts } from '../facts'
import { assertMay, invoiceDetail, officeContextOf, readInvoice, type InvoiceRow, type LineRow } from '../store'
import { orderTermsSource } from '../terms'
import { vatFor } from './draft'
import { invoiceView } from '../contract'

/**
 * Charges that are invoiced once (B-W2b-396; follow-ups VI1:01 – VI1:03 of B-W2b-309, -330, -284; Rule 1: three notes found
 * charges that were never invoiced):
 *
 *   A priced change's fee (B-W2b-309: SalesOrderAmendment.feeAmount, the customer accepted the change's price) goes on its
 *   order's next invoice of shipped goods (draft.ts, after the order's FEE lines), or on an invoice of the order's fees of
 *   its own, as a CHARGE line chargeKind FEE whose CodiceArticolo is "<order number>/R<revision>": the key that keeps it
 *   from any other invoice (no column links an invoice line to an amendment: schema need). Taxed as the goods (chargeVat).
 *
 *   An order's FEE line (B-W2b-330: invoiced once, with the order's first invoice of shipped goods) may also be invoiced on
 *   its own: POST /invoicing/orders/:orderId/fees/invoice makes a TD01 of the order's fees and accepted change fees that
 *   nothing bills yet (an order of fees only, a sample order, never ships goods). On a draft of several DDTs every fee or
 *   charge without a DDT is placed on the first DDT (FatturaPA: with several DDTs each line names one).
 *
 *   A FEE line is credited against the customer's bulk order (SalesOrderLine.feeCreditOrderId, B-W2b-363):
 *   POST /invoicing/fee-lines/:lineId/credit {bulkOrderId} names the bulk order and, when an issued invoice bills the fee,
 *   drafts the credit note (TD04) of that line; the credit is given (feeCreditedAt) when that credit note is issued
 *   (issue.ts → `feeCreditsAtIssue`). A fee no invoice billed yet is credited at once and is never invoiced (draft.ts and
 *   the route above leave it out). Order close and the backorder never wait for a credited fee (settlement.ts; the
 *   backorder never held a fee). What the credit note leaves due to the customer is offset in Finance › Payments.
 *
 *   A sample round's charge (B-W2b-246: SampleRound.chargeAmountMinor + chargeCurrency) is invoiced on a TD01 of its own:
 *   POST /invoicing/invoices/from-sample-round {sampleRoundId}, one CHARGE line chargeKind SAMPLES whose CodiceArticolo is
 *   the round's number (the key that keeps it from any other invoice: schema need), in the charge's currency.
 *
 * At the issue (issue.ts → `chargesBilledTwice`) a change fee or a round's charge another ISSUED invoice of the company
 * bills already is refused in words; each key takes its advisory lock (after the DDTs' and the fees', before the money
 * locks), so two drafts or issues at once never bill it twice. The fees' VAT and the bulk credit wait for the accountant
 * (GATE-ACCOUNTANT): a fee is taxed as the goods it goes with; the bulk credit is a credit note of the fee's invoice.
 */

const CHANGE_FEE_LOCK = 'factory.invoicing.changefee'
const SAMPLE_CHARGE_LOCK = 'factory.invoicing.samplecharge'

async function lockKeys(tx: CommandTx, context: RequestContext, namespace: string, ids: Iterable<string>): Promise<void> {
  for (const key of [...new Set(ids)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', ${namespace}::text, ${tenantOf(context)}::uuid, ${key}::text), 0))`
  }
}

/** The CodiceArticolo of a priced change's fee: "<order number>/R<revision>" (at most 35 characters). */
export const changeFeeKey = (orderNumber: string, revision: number): string => `${orderNumber}/R${revision}`.slice(0, 35)

const unitOf = (amount: MinorUnits, currency: string): string => fromMinorUnits(amount, currency).toFixed(6)
const words = (issues: readonly Issue[], fallback: string): string => (issues.length === 1 ? issues[0]!.message : fallback)

interface ChangeFee {
  readonly amendmentId: string
  readonly orderId: string
  readonly orderNumber: string
  readonly companyId: string
  readonly revision: number
  readonly feeAmount: number
  readonly currency: string
  readonly key: string
}

/** The priced changes of these orders whose fee the customer accepted (the newest REVISED_ORDER request APPROVED). */
async function acceptedChangeFees(db: CommandTx, orderIds: readonly string[]): Promise<ChangeFee[]> {
  if (orderIds.length === 0) return []
  const rows = await db.salesOrderAmendment.findMany({
    where: { orderId: { in: [...orderIds] }, feeAmount: { gt: 0 } },
    select: { id: true, orderId: true, companyId: true, revision: true, feeAmount: true, reacceptanceNeeded: true, order: { select: { number: true, currency: true } } },
    orderBy: [{ orderId: 'asc' }, { revision: 'asc' }],
  })
  if (rows.length === 0) return []
  const requests = await db.approvalRequest.findMany({ where: { recordType: 'SalesOrderAmendment', recordId: { in: rows.map((row) => row.id) }, kind: 'REVISED_ORDER' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { recordId: true, status: true } })
  return rows
    .filter((row) => {
      const newest = requests.find((request) => request.recordId === row.id)
      return !row.reacceptanceNeeded || newest?.status === 'APPROVED' || newest?.status === 'APPROVED_WITH_CHANGES'
    })
    .map((row) => ({ amendmentId: row.id, orderId: row.orderId, orderNumber: row.order.number, companyId: row.companyId, revision: row.revision, feeAmount: row.feeAmount!, currency: row.order.currency, key: changeFeeKey(row.order.number, row.revision) }))
}

interface ChargeHolder {
  readonly key: string
  readonly invoiceId: string
  readonly number: string | null
  readonly draft: boolean
}

/** The TD01/TD24 lines of a company that bill these keys (CHARGE of `chargeKind`), drafts too, but invoice `except`. */
async function chargesBilledOf(db: CommandTx, companyId: string, chargeKind: 'FEE' | 'SAMPLES', keys: readonly string[], except: string | null = null): Promise<ChargeHolder[]> {
  if (keys.length === 0) return []
  const rows = await db.invoiceLine.findMany({
    where: { kind: 'CHARGE', chargeKind, itemCode: { in: [...keys] }, invoice: { companyId, docType: { in: ['TD01', 'TD24'] }, ...(except ? { id: { not: except } } : {}) } },
    select: { itemCode: true, invoiceId: true, invoice: { select: { number: true, status: true } } },
    orderBy: [{ invoiceId: 'asc' }],
  })
  return rows.map((row) => ({ key: row.itemCode!, invoiceId: row.invoiceId, number: row.invoice.number, draft: row.invoice.status === 'DRAFT' }))
}

/**
 * Inside a draft's command, after the DDTs' and the fees' locks: the accepted change fees of these orders that nothing bills
 * yet, as CHARGE lines (FEE) taxed by `vat`, and the ones left out with why. Only fees in the invoice's currency.
 */
export async function changeFeeLinesFor(tx: CommandTx, context: RequestContext, orderIds: readonly string[], vat: VatTreatment | Issue, currency: string): Promise<{ lines: PreparedLine[]; left: { amendmentId: string; reason: string }[]; problems: Issue[] }> {
  const fees = (await acceptedChangeFees(tx, orderIds)).filter((fee) => fee.currency === currency)
  if (fees.length === 0) return { lines: [], left: [], problems: [] }
  await lockKeys(tx, context, CHANGE_FEE_LOCK, fees.map((fee) => `${fee.companyId}|${fee.key}`))
  const lines: PreparedLine[] = []
  const left: { amendmentId: string; reason: string }[] = []
  for (const fee of fees) {
    const holder = (await chargesBilledOf(tx, fee.companyId, 'FEE', [fee.key]))[0]
    if (holder) {
      left.push({ amendmentId: fee.amendmentId, reason: `The fee of change ${fee.revision} of order ${fee.orderNumber} is on ${holder.draft ? 'a draft invoice' : `invoice ${holder.number}`} already: it is invoiced once.` })
      continue
    }
    if ('path' in vat) return { lines: [], left: [], problems: [vat] }
    lines.push({
      core: { kind: 'CHARGE', description: `Spese per la modifica dell'ordine ${fee.orderNumber} (revisione ${fee.revision})`, itemCode: fee.key, quantity: '1.0000', uom: null, unitPrice: unitOf(fee.feeAmount, fee.currency), discountPct: null, vat },
      salesOrderLineId: null,
      size: null,
      ddtId: null,
      chargeKind: 'FEE',
    })
  }
  return { lines, left, problems: [] }
}

/** On a draft of several DDTs, a fee or charge line that names none takes the first DDT (FatturaPA: each line names one). */
export function onFirstDdt(lines: readonly PreparedLine[], ddtIds: readonly string[]): PreparedLine[] {
  if (ddtIds.length < 2) return [...lines]
  return lines.map((line) => (line.ddtId === null && (line.core.kind === 'SERVICE' || line.core.kind === 'CHARGE') ? { ...line, ddtId: ddtIds[0]! } : line))
}

/**
 * At the issue, inside its command after the DDTs' and the fees' locks: a change fee or a sample round's charge this
 * invoice bills that another ISSUED invoice of the company bills already, as problems in words.
 */
export async function chargesBilledTwice(tx: CommandTx, context: RequestContext, invoice: Pick<InvoiceRow, 'id' | 'companyId'>, lines: readonly Pick<LineRow, 'kind' | 'chargeKind' | 'itemCode'>[]): Promise<IssueProblem[]> {
  const problems: IssueProblem[] = []
  for (const [chargeKind, namespace, what] of [['FEE', CHANGE_FEE_LOCK, 'change fee'], ['SAMPLES', SAMPLE_CHARGE_LOCK, 'sample round charge']] as const) {
    const keys = lines.filter((line) => line.kind === 'CHARGE' && line.chargeKind === chargeKind && line.itemCode !== null).map((line) => line.itemCode!)
    if (keys.length === 0) continue
    await lockKeys(tx, context, namespace, keys.map((key) => `${invoice.companyId}|${key}`))
    for (const holder of (await chargesBilledOf(tx, invoice.companyId, chargeKind, keys, invoice.id)).filter((row) => !row.draft)) {
      problems.push({ code: 'CHARGE_INVOICED', path: 'lines', message: `The ${what} ${holder.key} is on invoice ${holder.number} already: it is invoiced once (remove it from this draft).` })
    }
  }
  return problems
}

// ---- an order's fees on an invoice of their own -----------------------------------------------------------------------------

export const orderFeesInvoiceContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    201: output({
      invoice: invoiceView,
      /** The order's fees and change fees not billed here, and why. */
      fees: z.array(output({ salesOrderLineId: id(), reason: z.string() })),
      changeFees: z.array(output({ amendmentId: id(), reason: z.string() })),
    }),
  },
})

/** invoices.manage: a TD01 draft of an order's FEE lines and accepted change fees that nothing bills yet. */
export async function invoiceOrderFees(caller: CommandCaller, orderId: string, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = isUuid(orderId) ? await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: orderId }, select: { id: true, number: true, companyId: true, partyId: true, currency: true, status: true } })) : null
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, order ? { companyId: order.companyId, partyId: order.partyId } : null, 'Order')
  if (order!.status === 'CANCELLED') throw new ConflictError(`Order ${order!.number} is cancelled: its fees are not invoiced (a fee already invoiced is corrected with a credit note).`)
  const currencyProblem = documentCurrencyProblem(order!.currency)
  if (currencyProblem) throw new ConflictError(currencyProblem)
  const { result } = await command(caller, { name: 'invoices.fromOrderFees', idempotencyKey, input: { orderId } }, async (tools) => {
    const { tx } = tools
    const profile = (await partyFacts(tx, order!.partyId, businessDate(tools.now), tools.now))?.profile ?? null
    const fees = await feeLinesFor(tx, tools.context, [order!.id], vatFor(profile))
    if (fees.problems.length > 0) throw new ConflictError(words(fees.problems, "The order's fees cannot be invoiced now."))
    const vat = chargeVat(fees.lines.map((line) => line.core.vat), decidedVat(profile, 'GOODS', 'party/taxIdentity'))
    const changes = await changeFeeLinesFor(tx, tools.context, [order!.id], vat, order!.currency)
    if (changes.problems.length > 0) throw new ConflictError(words(changes.problems, "The order's change fees cannot be invoiced now."))
    const lines: PreparedLine[] = [...fees.lines, ...changes.lines]
    if (lines.length === 0) {
      const why = [...fees.left.map((entry) => entry.reason), ...changes.left.map((entry) => entry.reason)]
      throw new ConflictError(why.length > 0 ? `Nothing of order ${order!.number} waits for an invoice: ${why.join(' ')}` : `Order ${order!.number} has no fee and no accepted change fee to invoice.`)
    }
    const id = newId()
    await insertDraft(
      tools,
      {
        id,
        companyId: order!.companyId,
        buyerPartyId: order!.partyId,
        docType: 'TD01',
        priceBasis: 'NET',
        currency: order!.currency,
        salesOrderId: order!.id,
        depositRequestId: null,
        causale: null,
        documentRefs: null,
        payment: null,
        termsSource: await orderTermsSource(tx, { salesOrderId: order!.id, partyId: order!.partyId }),
        internalNote: null,
      },
      lines,
    )
    tools.audit({ action: 'invoices.fromOrderFees', recordType: 'Invoice', recordId: id, companyId: order!.companyId, after: { orderId: order!.id, fees: fees.lines.map((line) => line.salesOrderLineId), changeFees: changes.lines.map((line) => line.core.itemCode) } })
    return { invoice: await invoiceDetail(tx, (await readInvoice(tx, id))!), fees: fees.left, changeFees: changes.left }
  })
  return result
}

// ---- a sample round's charge ------------------------------------------------------------------------------------------------

export const sampleRoundInvoiceContract = defineContract({
  body: input({ sampleRoundId: id() }),
  response: { 201: output({ invoice: invoiceView }) },
})

const SAMPLE_KIND_IT: Readonly<Record<string, string>> = { PROTO: 'prototipo', FIT: 'prova taglia', SALESMAN: 'campionario venditori', PRE_PRODUCTION: 'preserie', CERTIFICATION: 'certificazione', BRAND: 'campione del marchio' }

/** invoices.manage: the TD01 draft of a sample round's charge (once). */
export async function invoiceSampleRound(caller: CommandCaller, body: { sampleRoundId: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const round = await caller.withClient((client) =>
    client.sampleRound.findUnique({ where: { id: body.sampleRoundId }, select: { id: true, number: true, companyId: true, partyId: true, kind: true, roundNo: true, stage: true, chargeAmountMinor: true, chargeCurrency: true, style: { select: { code: true } } } }),
  )
  if (round && round.partyId === null) {
    if (!can(actorOf(context), INVOICES_VIEW, { companyId: round.companyId })) throw new NotFoundError('Sample round not found.')
    throw new ConflictError(`Sample round ${round.number} is internal: it has no customer to charge.`)
  }
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, round ? { companyId: round.companyId, partyId: round.partyId! } : null, 'Sample round')
  const found = round!
  if (found.chargeAmountMinor === null || found.chargeCurrency === null || found.chargeAmountMinor <= 0) throw new ConflictError(`Sample round ${found.number} charges nothing: give it a charge on the round first.`)
  if (found.stage === 'CANCELLED') throw new ConflictError(`Sample round ${found.number} was cancelled: its charge is not invoiced.`)
  const currencyProblem = documentCurrencyProblem(found.chargeCurrency)
  if (currencyProblem) throw new ConflictError(currencyProblem)
  const { result } = await command(caller, { name: 'invoices.fromSampleRound', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    await lockKeys(tx, tools.context, SAMPLE_CHARGE_LOCK, [`${found.companyId}|${found.number}`])
    const holder = (await chargesBilledOf(tx, found.companyId, 'SAMPLES', [found.number]))[0]
    if (holder) throw new ConflictError(`The charge of sample round ${found.number} is on ${holder.draft ? 'a draft invoice' : `invoice ${holder.number}`} already: it is invoiced once.`)
    const profile = (await partyFacts(tx, found.partyId!, businessDate(tools.now), tools.now))?.profile ?? null
    const vat = decidedVat(profile, 'GOODS', 'party/taxIdentity')
    if ('path' in vat) throw new ConflictError(vat.message)
    const id = newId()
    await insertDraft(
      tools,
      {
        id,
        companyId: found.companyId,
        buyerPartyId: found.partyId!,
        docType: 'TD01',
        priceBasis: 'NET',
        currency: found.chargeCurrency!,
        salesOrderId: null,
        depositRequestId: null,
        causale: null,
        documentRefs: null,
        payment: null,
        termsSource: await orderTermsSource(tx, { salesOrderId: null, partyId: found.partyId! }),
        internalNote: null,
      },
      [
        {
          core: { kind: 'CHARGE', description: `Campionatura ${found.number}: ${SAMPLE_KIND_IT[found.kind] ?? found.kind} n. ${found.roundNo}, modello ${found.style.code}`.slice(0, 1000), itemCode: found.number, quantity: '1.0000', uom: null, unitPrice: unitOf(found.chargeAmountMinor!, found.chargeCurrency!), discountPct: null, vat },
          salesOrderLineId: null,
          size: null,
          ddtId: null,
          chargeKind: 'SAMPLES',
        },
      ],
    )
    tools.audit({ action: 'invoices.fromSampleRound', recordType: 'Invoice', recordId: id, companyId: found.companyId, after: { sampleRoundId: found.id, number: found.number } })
    return { invoice: await invoiceDetail(tx, (await readInvoice(tx, id))!) }
  })
  return result
}

// ---- a fee credited against the bulk order ----------------------------------------------------------------------------------

export const feeCreditContract = defineContract({
  params: input({ lineId: id() }),
  body: input({ bulkOrderId: id() }),
  response: {
    200: output({
      salesOrderLineId: id(),
      bulkOrderId: id(),
      /** NAMED: the credit note of the fee's invoice is drafted (credited when it is issued); CREDITED: no invoice billed the fee. */
      state: z.enum(['NAMED', 'CREDITED']),
      creditNote: invoiceView.nullable(),
      words: z.string(),
    }),
  },
})

/** invoices.manage: names the bulk order a FEE line is credited against and drafts its credit note (or credits it at once). */
export async function creditFee(caller: CommandCaller, lineId: string, body: { bulkOrderId: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const line = isUuid(lineId)
    ? await caller.withClient((client) => client.salesOrderLine.findUnique({ where: { id: lineId }, select: { id: true, kind: true, feeKind: true, seq: true, orderId: true, companyId: true, partyId: true, order: { select: { number: true } } } }))
    : null
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, line ? { companyId: line.companyId, partyId: line.partyId } : null, 'Order line')
  if (line!.kind !== 'FEE') throw new ConflictError(`Line ${line!.seq} of order ${line!.order.number} is not a fee: only a fee is credited against a bulk order.`)
  const { result } = await command(caller, { name: 'invoices.creditFee', idempotencyKey, input: { lineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockFees(tx, tools.context, [line!.id])
    const fresh = (await tx.salesOrderLine.findUnique({ where: { id: line!.id }, select: { feeCreditOrderId: true, feeCreditedAt: true } }))!
    if (fresh.feeCreditedAt) throw new ConflictError(`The fee of order ${line!.order.number} (line ${line!.seq}) was credited already.`)
    const bulk = await tx.salesOrder.findUnique({ where: { id: body.bulkOrderId }, select: { id: true, number: true, companyId: true, partyId: true, status: true, lines: { where: { kind: { not: 'FEE' } }, select: { id: true }, take: 1 } } })
    if (!bulk || bulk.companyId !== line!.companyId || bulk.partyId !== line!.partyId) throw new ValidationError("Not an order of this customer and company.", [{ path: 'body/bulkOrderId', message: "The customer's bulk order, of the same company." }])
    if (bulk.id === line!.orderId) throw new ValidationError('A fee is credited against another order than its own.', [{ path: 'body/bulkOrderId', message: 'Another order.' }])
    if (bulk.status === 'CANCELLED' || bulk.lines.length === 0) throw new ConflictError(`Order ${bulk.number} ${bulk.status === 'CANCELLED' ? 'is cancelled' : 'has no goods'}: a fee is credited against a bulk order of goods.`)
    const holders = await feesBilledOf(tx, [line!.id])
    if (holders.some((holder) => holder.draft)) throw new ConflictError(`The fee of order ${line!.order.number} is on a draft invoice: issue or delete it before crediting it.`)
    const pending = await tx.invoiceLine.findFirst({ where: { salesOrderLineId: line!.id, kind: 'SERVICE', invoice: { docType: 'TD04', status: 'DRAFT' } }, select: { invoiceId: true } })
    if (pending) throw new ConflictError(`A credit note of this fee is a draft already: issue or delete it first.`)
    const issued = holders.find((holder) => !holder.draft)
    const fee = FEE_WORDS[(line!.feeKind ?? 'DEVELOPMENT') as SalesFeeKind].toLowerCase()
    let creditNoteId: string | null = null
    if (issued) {
      const billed = (await tx.invoiceLine.findFirst({ where: { invoiceId: issued.invoiceId, salesOrderLineId: line!.id, kind: 'SERVICE' }, select: { id: true } }))!
      creditNoteId = (await creditNoteInCommand(tools, issued.invoiceId, { mode: 'LINES', lines: [{ lineId: billed.id }] }, 'OTHER', `addebito accreditato sull'ordine ${bulk.number}`, null, 'invoices.creditFeeNote')).id
      await tx.salesOrderLine.update({ where: { id: line!.id }, data: { feeCreditOrderId: bulk.id, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    } else {
      await tx.salesOrderLine.update({ where: { id: line!.id }, data: { feeCreditOrderId: bulk.id, feeCreditedAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    }
    const state = issued ? ('NAMED' as const) : ('CREDITED' as const)
    tools.audit({ action: 'invoices.creditFee', recordType: 'SalesOrderLine', recordId: line!.id, companyId: line!.companyId, before: { feeCreditOrderId: fresh.feeCreditOrderId }, after: { feeCreditOrderId: bulk.id, state, creditNoteId, invoiceId: issued?.invoiceId ?? null } })
    tools.emit({ type: 'fee_credit.changed', subject: line!.id, companyId: line!.companyId, payload: { salesOrderLineId: line!.id, orderId: line!.orderId, bulkOrderId: bulk.id, action: state, creditNoteId } })
    return {
      salesOrderLineId: line!.id,
      bulkOrderId: bulk.id,
      state,
      creditNote: creditNoteId ? await invoiceDetail(tx, (await readInvoice(tx, creditNoteId))!) : null,
      words: issued
        ? `The ${fee} of order ${line!.order.number} is credited against order ${bulk.number} by a credit note of invoice ${issued.number}: issue it to give the credit.`
        : `The ${fee} of order ${line!.order.number} was never invoiced: it is credited against order ${bulk.number} and will not be invoiced.`,
    }
  })
  return result
}

/**
 * At a credit note's issue, inside its command: the fees it credits that are named against a bulk order get their credit's
 * time (once; the database keeps it).
 */
export async function feeCreditsAtIssue(tools: CommandTools, invoice: Pick<InvoiceRow, 'id' | 'docType' | 'companyId'>, lines: readonly Pick<LineRow, 'kind' | 'salesOrderLineId'>[]): Promise<void> {
  if (invoice.docType !== 'TD04') return
  const ids = lines.filter((line) => line.kind === 'SERVICE' && line.salesOrderLineId !== null).map((line) => line.salesOrderLineId!)
  if (ids.length === 0) return
  const fees = await tools.tx.salesOrderLine.findMany({ where: { id: { in: ids }, kind: 'FEE', feeCreditOrderId: { not: null }, feeCreditedAt: null }, select: { id: true, orderId: true, feeCreditOrderId: true } })
  for (const fee of fees) {
    await tools.tx.salesOrderLine.update({ where: { id: fee.id }, data: { feeCreditedAt: tools.now, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'invoices.feeCredited', recordType: 'SalesOrderLine', recordId: fee.id, companyId: invoice.companyId, after: { feeCreditOrderId: fee.feeCreditOrderId, creditNoteId: invoice.id } })
    tools.emit({ type: 'fee_credit.changed', subject: fee.id, companyId: invoice.companyId, payload: { salesOrderLineId: fee.id, orderId: fee.orderId, bulkOrderId: fee.feeCreditOrderId!, action: 'CREDITED', creditNoteId: invoice.id } })
  }
}
