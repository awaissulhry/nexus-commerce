import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { computeInvoiceTotals, storedVatOf, type CoreLine } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_ISSUE } from '@nexus/factory-domain/invoicing/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import type { ChargeKind } from '@nexus/factory-domain/invoicing/charges/charges'
import { checkSources, prepareLines, type LineInput, type PaymentInput, type PreparedLine } from '../drafts'
import { sourceOfPayment, storedSourceOf, termsJsonOf } from '../terms'
import { coreLineOf, partyFacts, reviewIssue } from '../facts'
import { invoiceDetail, officeInvoice, readInvoice, readLines, type InvoiceDetail, type InvoiceRow, type LineRow } from '../store'
import { lockInvoice, readSends } from './store'

/**
 * Correcting a rejected invoice (FIN-087; Provv. AdE 89757/2018, circolare AdE 13/E/2018: a file SDI rejected counts as
 * never issued; it is corrected and sent again within five working days under the SAME number and date). ONE command on
 * the invoice (its version guards the edit; the row stays locked): only while REJECTED and no send of it is on its way,
 *
 *   lines         replaced when sent (the goods and services lines; the deposit deductions stay as they are), with their
 *                 VAT decided as for a draft and their order lines and DDTs checked;
 *   text          causale, the customer's purchase orders, the payment terms (rebuilt for the new total);
 *   totals        recomputed from the lines (factory-domain computeInvoiceTotals); never below what is paid and credited
 *                 on it (the …_money_guards trigger refuses it too);
 *   seller, buyer taken again from the company's and the customer's data in force on the invoice's date, so a fixed VAT
 *                 number, SDI code or address goes into the corrected file (NS 00305, 00311 …).
 * The number, series, year, date, type, company, customer and links never change (the trigger). The answer carries the
 * checks the resend runs (the issue's, without the customer's blocked or warning state: the invoice exists already).
 * Sending it again (send.ts) runs this command with no change first, then makes the corrected XML and PDF.
 */

export interface CorrectionInput {
  readonly version?: number | undefined
  /** The goods and services lines; left out: the lines stay. */
  readonly lines?: readonly LineInput[] | undefined
  readonly causale?: string | null | undefined
  readonly documentRefs?: readonly { readonly number: string; readonly date?: string | null | undefined }[] | null | undefined
  readonly payment?: PaymentInput | null | undefined
}

/** The issue's codes that do not stop a resend: the customer's standing (the invoice exists, its number is taken). */
const NOT_FOR_RESEND = new Set(['PARTY_BLOCKED', 'PARTY_ARCHIVED', 'PARTY_WARNING'])
export const resendProblems = (problems: readonly IssueProblem[]): IssueProblem[] => problems.filter((problem) => !NOT_FOR_RESEND.has(problem.code))

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const dayOf = (value: Date): string => value.toISOString().slice(0, 10)

const refsJson = (refs: CorrectionInput['documentRefs']): Prisma.InputJsonValue | null =>
  refs && refs.length > 0 ? refs.map((ref) => ({ kind: 'PURCHASE_ORDER', number: ref.number.trim(), ...(ref.date ? { date: ref.date } : {}) })) : null

/** The kept deduction lines and the new lines, as the totals see them, with what each row writes. */
interface LineToWrite {
  readonly core: CoreLine
  readonly salesOrderLineId: string | null
  readonly size: string | null
  readonly ddtId: string | null
  readonly depositInvoiceId: string | null
  /** B-W2a-54: a charge's kind, and the payment schedule step a line bills. */
  readonly chargeKind?: ChargeKind | null
  readonly milestoneId?: string | null
  /** B-W2a-61: a credit note's line crediting a return line. */
  readonly returnLineId?: string | null
}

async function rewriteLines(tools: CommandTools, invoice: InvoiceRow, lines: readonly LineToWrite[], amounts: readonly { netAmount: number; grossAmount: number | null }[]): Promise<void> {
  await tools.tx.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } })
  for (const [index, line] of lines.entries()) {
    const vat = storedVatOf(line.core.vat)
    await tools.tx.invoiceLine.create({
      data: {
        id: newId(),
        invoiceId: invoice.id,
        buyerPartyId: invoice.buyerPartyId,
        partyId: invoice.partyId,
        seq: index + 1,
        kind: line.core.kind,
        description: line.core.description,
        itemCode: line.core.itemCode ?? null,
        quantity: line.core.quantity,
        uom: line.core.uom ?? null,
        unitPrice: line.core.unitPrice,
        discountPct: line.core.discountPct ?? null,
        netAmount: amounts[index]!.netAmount,
        grossAmount: amounts[index]!.grossAmount,
        vatRatePct: vat.vatRatePct,
        vatNature: vat.vatNature,
        vatLegalRef: vat.vatLegalRef,
        salesOrderLineId: line.salesOrderLineId,
        size: line.size,
        ddtId: line.ddtId,
        depositInvoiceId: line.depositInvoiceId,
        chargeKind: line.core.kind === 'CHARGE' ? (line.chargeKind ?? null) : null,
        milestoneId: line.milestoneId ?? null,
        returnLineId: line.returnLineId ?? null,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: { id: true },
    })
  }
}

const kept = (row: LineRow): LineToWrite | null => {
  const core = coreLineOf(row)
  return core ? { core, salesOrderLineId: row.salesOrderLineId, size: row.size, ddtId: row.ddtId, depositInvoiceId: row.depositInvoiceId } : null
}

/**
 * Inside a command that holds the invoice's row: applies the correction (see the module comment). `prepared` are the
 * new lines (prepareLines), or null to keep them. Returns what the resend's checks say now.
 */
export async function correctInCommand(tools: CommandTools, invoiceId: string, input: CorrectionInput, prepared: readonly PreparedLine[] | null): Promise<{ problems: IssueProblem[]; linesReplaced: boolean }> {
  const { tx } = tools
  await lockInvoice(tx, invoiceId)
  const current = (await readInvoice(tx, invoiceId))!
  if (current.status !== 'REJECTED') {
    throw new InvalidStateError(`The invoice is ${current.status}: only an invoice SDI rejected is corrected (an invoice SDI took is corrected by a credit note, DPR 633/1972 art. 26).`)
  }
  const latest = (await readSends(tx, invoiceId)).at(-1)
  if (latest?.status === 'SENDING') throw new ConflictError('A send of this invoice to SDI is on its way: wait for it before correcting it.')
  const existing = await readLines(tx, invoiceId)

  let totals = null as ReturnType<typeof computeInvoiceTotals> | null
  if (prepared !== null) {
    // B-W2a-61: the lines of a credit note from a return are the return's decided credit (their link stays).
    if (existing.some((row) => row.returnLineId !== null)) {
      throw new ConflictError("This credit note credits a customer return: its lines are the return's decided credit and are not replaced. Correct its other data, or credit the difference with a credit note of its own.")
    }
    await checkSources(tx, current, prepared)
    const deductions = existing.filter((row) => row.kind === 'DEPOSIT_DEDUCTION').map(kept)
    const lines: LineToWrite[] = [...prepared.map((line) => ({ ...line, depositInvoiceId: null })), ...(deductions.filter((line) => line !== null) as LineToWrite[])]
    totals = computeInvoiceTotals(
      lines.map((line) => line.core),
      current.priceBasis,
      current.currency,
    )
    await rewriteLines(tools, current, lines, totals.lines)
  } else {
    const cores = existing.map(kept)
    if (cores.every((line) => line !== null)) totals = computeInvoiceTotals((cores as LineToWrite[]).map((line) => line.core), current.priceBasis, current.currency)
  }

  const gross = totals?.grossTotal ?? current.grossTotal
  const paid = (await tx.paymentAllocation.aggregate({ where: { invoiceId }, _sum: { amount: true } }))._sum.amount ?? 0
  const credited = (await tx.invoice.aggregate({ where: { creditOfId: invoiceId, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }))._sum.grossTotal ?? 0
  if (gross < paid + credited) {
    throw new ConflictError('The corrected total would be below what is already paid and credited on this invoice: reverse the payment first, or correct the lines differently.')
  }
  // B-W2a-54: the terms are made again from where they came from (terms.ts), on the invoice's own date.
  const source = input.payment === undefined ? storedSourceOf(current.paymentTerms) : sourceOfPayment(input.payment)
  const terms = await termsJsonOf(tx, current.companyId, source, gross, dayOf(current.issueDate!))
  const data: Prisma.InvoiceUncheckedUpdateInput = {
    ...(totals
      ? { netTotal: totals.netTotal, vatTotal: totals.vatTotal, grossTotal: totals.grossTotal, vatSummary: totals.vatSummary as unknown as Prisma.InputJsonValue, stampDutyAmount: totals.stampDutyAmount }
      : {}),
    ...(terms === null ? {} : { paymentTerms: terms }),
    ...(input.causale !== undefined ? { causale: blankToNull(input.causale) } : {}),
    ...(input.documentRefs !== undefined && refsJson(input.documentRefs) !== null ? { documentRefs: refsJson(input.documentRefs)! } : {}),
  }
  if (Object.keys(data).length > 0) await tx.invoice.update({ where: { id: invoiceId }, data, select: { id: true } })
  // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
  if (terms === null && current.paymentTerms !== null) await tx.$executeRaw`UPDATE "Invoice" SET "paymentTerms" = NULL WHERE "id" = ${invoiceId}::uuid`
  if (input.documentRefs !== undefined && refsJson(input.documentRefs) === null && current.documentRefs !== null) await tx.$executeRaw`UPDATE "Invoice" SET "documentRefs" = NULL WHERE "id" = ${invoiceId}::uuid`

  // The seller and the buyer as they are now, in force on the invoice's date (a fixed VAT number, SDI code, address).
  const after = (await readInvoice(tx, invoiceId))!
  const issueDate = dayOf(after.issueDate!)
  const review = await reviewIssue(tx, after, await readLines(tx, invoiceId), issueDate, tools.now)
  if (review.seller && review.billTo) {
    await tx.invoice.update({ where: { id: invoiceId }, data: { seller: review.seller as unknown as Prisma.InputJsonValue, billTo: review.billTo as unknown as Prisma.InputJsonValue }, select: { id: true } })
  }
  const problems = resendProblems(review.problems)
  tools.audit({
    action: 'invoices.sdiCorrect',
    recordType: 'Invoice',
    recordId: invoiceId,
    companyId: current.companyId,
    before: { status: 'REJECTED', netTotal: markMoney('price', current.netTotal), vatTotal: markMoney('price', current.vatTotal), grossTotal: markMoney('price', current.grossTotal), causale: current.causale },
    after: { lines: prepared === null ? 'kept' : prepared.length, netTotal: markMoney('price', after.netTotal), vatTotal: markMoney('price', after.vatTotal), grossTotal: markMoney('price', after.grossTotal), causale: after.causale, problems: problems.map((problem) => problem.code) },
  })
  tools.emit({ type: 'invoice.sdi_corrected', subject: invoiceId, companyId: current.companyId, payload: { invoiceId, linesReplaced: prepared !== null } })
  return { problems, linesReplaced: prepared !== null }
}

/** The new lines of a correction, prepared (VAT decided as for a draft) before the command; null when none are sent. */
export async function preparedLinesOf(caller: CommandCaller, invoice: InvoiceRow, lines: readonly LineInput[] | undefined): Promise<PreparedLine[] | null> {
  if (lines === undefined) return null
  const date = dayOf(invoice.issueDate ?? serverClock.now())
  const profile = await caller.withClient(async (client) => (await partyFacts(client, invoice.buyerPartyId, date, serverClock.now()))?.profile ?? null)
  return prepareLines(lines, profile)
}

/**
 * invoices.issue (step-up; PUT /invoicing/invoices/:invoiceId/sdi/correction): corrects a rejected invoice. Answers the
 * invoice and the resend's checks (each problem with where to fix it).
 */
export async function correctInvoice(caller: CommandCaller, invoiceId: string, body: CorrectionInput, idempotencyKey: string | undefined, stepUp: () => void): Promise<{ invoice: InvoiceDetail; resend: { ready: boolean; problems: IssueProblem[] } }> {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_ISSUE)
  stepUp()
  if (invoice.status !== 'REJECTED') throw new InvalidStateError(`The invoice is ${invoice.status}: only an invoice SDI rejected is corrected.`)
  const prepared = await preparedLinesOf(caller, invoice, body.lines)
  const { result } = await command(
    caller,
    { name: 'invoices.sdiCorrect', idempotencyKey, input: { invoiceId, ...body }, record: { type: 'Invoice', id: invoiceId, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } },
    async (tools) => {
      const { problems } = await correctInCommand(tools, invoiceId, body, prepared)
      return { invoice: await invoiceDetail(tools.tx, (await readInvoice(tools.tx, invoiceId))!), resend: { ready: problems.length === 0, problems } }
    },
  )
  return result
}
