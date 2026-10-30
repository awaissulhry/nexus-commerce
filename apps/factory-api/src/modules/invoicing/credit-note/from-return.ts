import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { creditProblems } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { overCreditable, planReturnCredit, type BilledLine, type InvoiceToCredit, type PlannedCreditNote, type ReturnCreditPlan, type ReturnedLine, type SkippedLine } from '@nexus/factory-domain/invoicing/credit-note/from-return'
import { computeInvoiceTotals, treatmentOf } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { lockAll } from '../../payments/locks'
import { insertDraft } from '../drafts'
import { creditedInvoiceOf } from '../from-shipment/store'
import { assertMay, invoiceDetail, officeContextOf, readInvoice, type InvoiceDetail, type Reader } from '../store'

/**
 * Credit notes from a customer return (B-W2a-61; FIN-070; design sales.returns "Replacement & credit": "Credit note draft
 * (Finance) and its SDI state", "Make credit note"; finance.invoices "Credit note for …" opened from the return
 * inspection). The rules are factory-domain invoicing/credit-note/from-return: one TD04 per invoice that billed what came
 * back, each line the pieces decided at the decided credit, the billed line's VAT, the return line named on it.
 *
 *   GET  /invoicing/returns/:returnId/credit-notes   invoices.view: the RMA's credit notes (status = their SDI state,
 *                                                    refunds paid), what a new draft would credit now, and each line left
 *                                                    out with why
 *   POST /invoicing/returns/:returnId/credit-notes   invoices.manage: ONE command drafts them ({ lineIds? }: some lines);
 *                                                    409 in words when nothing can be credited
 *   worker invoicing.creditNoteFromReturn            on return.credit_due (B-W2a-43's decision): the same command, as the
 *                                                    system, for the lines the event names — a repeat or a person's draft
 *                                                    first changes nothing (a line on a credit note is skipped)
 *
 * A draft is never issued here: a person checks and issues it (POST /invoicing/invoices/:id/issue, invoices.issue +
 * step-up) and sends it to SDI like any invoice; its refund, when the invoice was paid, is Payments › Refunds.
 *
 * Locks (the …_money_w2a_guards issue order): the invoices to credit ('invoice', id order), then the return lines
 * ('return-line', id order); what is already on a credit note is read under them, so two drafts of one line never race.
 */

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

/** The RMA, as invoicing reads it. */
async function readReturn(db: Reader, returnId: string) {
  if (!isUuid(returnId)) return null
  return db.returnAuthorisation.findUnique({ where: { id: returnId }, select: { id: true, number: true, status: true, companyId: true, partyId: true } })
}
type ReturnRow = NonNullable<Awaited<ReturnType<typeof readReturn>>>

const RETURN_LINE_COLUMNS = { id: true, seq: true, quantity: true, receivedQuantity: true, disposition: true, creditAmount: true, salesOrderLineId: true, size: true, invoiceLineId: true } as const
const BILLED_COLUMNS = { id: true, invoiceId: true, description: true, itemCode: true, uom: true, vatRatePct: true, vatNature: true, vatLegalRef: true, salesOrderLineId: true, size: true } as const

/** The facts the plan needs: the lines, the invoice lines that billed them, the invoices, what credit notes name them. */
async function factsOf(db: Reader, rma: ReturnRow, lock?: CommandTools) {
  const rows = await db.returnLine.findMany({ where: { returnId: rma.id }, select: RETURN_LINE_COLUMNS, orderBy: { seq: 'asc' } })
  const named = rows.flatMap((row) => (row.invoiceLineId ? [row.invoiceLineId] : []))
  const billedRows = named.length > 0 ? await db.invoiceLine.findMany({ where: { id: { in: named } }, select: BILLED_COLUMNS }) : []
  // A line made from a shipment before its invoice: the newest issued TD01/TD24 line that billed its order line and size.
  const unnamed = rows.filter((row) => !row.invoiceLineId && row.salesOrderLineId)
  const later = unnamed.length > 0
    ? await db.invoiceLine.findMany({
        where: { kind: 'GOODS', salesOrderLineId: { in: unnamed.map((row) => row.salesOrderLineId!) }, invoice: { companyId: rma.companyId, buyerPartyId: rma.partyId, docType: { in: ['TD01', 'TD24'] }, status: { notIn: ['DRAFT', 'REJECTED'] } } },
        select: { ...BILLED_COLUMNS, invoice: { select: { issueDate: true, number: true } } },
      })
    : []
  const billedOf = new Map<string, BilledLine>()
  const asBilled = (row: (typeof billedRows)[number], isNamed: boolean): BilledLine | null => {
    const vat = treatmentOf({ vatRatePct: row.vatRatePct.toFixed(2), vatNature: row.vatNature, vatLegalRef: row.vatLegalRef })
    return vat ? { invoiceLineId: row.id, invoiceId: row.invoiceId, description: row.description, itemCode: row.itemCode, uom: row.uom, vat, salesOrderLineId: row.salesOrderLineId, size: row.size, named: isNamed } : null
  }
  for (const row of rows) {
    if (row.invoiceLineId) {
      const found = billedRows.find((billed) => billed.id === row.invoiceLineId)
      const billed = found ? asBilled(found, true) : null
      if (billed) billedOf.set(row.id, billed)
      continue
    }
    const candidates = later
      .filter((billed) => billed.salesOrderLineId === row.salesOrderLineId && (row.size === null || billed.size === row.size))
      .sort((a, b) => (b.invoice.issueDate?.getTime() ?? 0) - (a.invoice.issueDate?.getTime() ?? 0) || (b.invoice.number ?? '').localeCompare(a.invoice.number ?? ''))
    const billed = candidates[0] ? asBilled(candidates[0], false) : null
    if (billed) billedOf.set(row.id, billed)
  }
  const invoiceIds = [...new Set([...billedOf.values()].map((billed) => billed.invoiceId))].sort()
  if (lock) {
    await lockAll(lock.tx, lock.context, 'invoice', invoiceIds)
    await lockAll(lock.tx, lock.context, 'return-line', rows.map((row) => row.id))
  }
  const invoiceRows = invoiceIds.length > 0 ? await db.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, companyId: true, docType: true, status: true, number: true, issueDate: true, currency: true } }) : []
  const invoices = new Map<string, InvoiceToCredit>(invoiceRows.map((row) => [row.id, { ...row, issueDate: day(row.issueDate) }]))
  const onNotes = rows.length > 0
    ? await db.invoiceLine.findMany({ where: { returnLineId: { in: rows.map((row) => row.id) }, invoice: { docType: 'TD04' } }, select: { returnLineId: true, quantity: true, netAmount: true, invoice: { select: { id: true, number: true, status: true } } } })
    : []
  const lines: ReturnedLine[] = rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    quantity: row.quantity,
    receivedQuantity: row.receivedQuantity,
    disposition: row.disposition,
    creditAmount: row.creditAmount,
    billedBy: billedOf.get(row.id) ?? null,
    onCreditNotes: onNotes.filter((note) => note.returnLineId === row.id).map((note) => ({ invoiceId: note.invoice.id, number: note.invoice.number, status: note.invoice.status })),
  }))
  return { lines, invoices, onNotes }
}

/** The plan, with each note checked against what its invoice still has to credit (a note that passes it is left out). */
async function checkedPlan(db: Reader, rma: ReturnRow, lines: readonly ReturnedLine[], invoices: ReadonlyMap<string, InvoiceToCredit>, wanted: ReadonlySet<string> | null): Promise<ReturnCreditPlan> {
  const plan = planReturnCredit({ id: rma.id, number: rma.number, companyId: rma.companyId }, lines, invoices, wanted)
  const notes: PlannedCreditNote[] = []
  const skipped: SkippedLine[] = [...plan.skipped]
  for (const note of plan.notes) {
    const credited = await creditedInvoiceOf(db, note.creditOfId, null)
    const totals = computeInvoiceTotals(note.lines.map((line) => line.core), 'NET', note.currency)
    const over = creditProblems({ causale: note.causale, netTotal: totals.netTotal, grossTotal: totals.grossTotal }, credited)
    if (over.length > 0) skipped.push(...overCreditable(note, over[0]!.message))
    else notes.push(note)
  }
  return { notes, skipped: skipped.sort((a, b) => a.seq - b.seq) }
}

export interface DraftedFromReturn {
  readonly made: readonly { readonly invoiceId: string; readonly creditOfId: string; readonly returnLineIds: readonly string[] }[]
  readonly skipped: readonly SkippedLine[]
}

/**
 * Inside a command: the credit note drafts of a return's decided lines (`wanted`: only these; null: every line), under the
 * invoices' and the return lines' locks. A line already on a credit note (a draft or issued) is skipped, so a repeat makes
 * nothing. Audited per draft (and once when nothing was made: why).
 */
export async function draftFromReturnInCommand(tools: CommandTools, returnId: string, wanted: ReadonlySet<string> | null): Promise<DraftedFromReturn> {
  const rma = await readReturn(tools.tx, returnId)
  if (!rma) throw new NotFoundError('Return not found.')
  const { lines, invoices } = await factsOf(tools.tx, rma, tools)
  const plan = await checkedPlan(tools.tx, rma, lines, invoices, wanted)
  const made: { invoiceId: string; creditOfId: string; returnLineIds: string[] }[] = []
  for (const note of plan.notes) {
    const credited = (await creditedInvoiceOf(tools.tx, note.creditOfId, null))!
    const id = newId()
    const totals = await insertDraft(
      tools,
      {
        id,
        companyId: credited.companyId,
        buyerPartyId: credited.buyerPartyId,
        docType: 'TD04',
        priceBasis: 'NET',
        currency: credited.currency,
        salesOrderId: credited.salesOrderId,
        depositRequestId: null,
        creditOfId: credited.id,
        causale: note.causale,
        documentRefs: null,
        payment: null,
        internalNote: `Credit note of return ${rma.number}.`,
      },
      note.lines.map((line) => ({ core: line.core, salesOrderLineId: line.salesOrderLineId, size: line.size, ddtId: null, returnLineId: line.returnLineId })),
    )
    const returnLineIds = note.lines.map((line) => line.returnLineId)
    tools.audit({
      action: 'invoices.creditNoteFromReturn',
      recordType: 'Invoice',
      recordId: id,
      companyId: credited.companyId,
      after: { creditOfId: credited.id, returnId: rma.id, returnNumber: rma.number, reason: 'RETURN', returnLineIds, netTotal: markMoney('price', totals.netTotal), grossTotal: markMoney('price', totals.grossTotal) },
    })
    tools.emit({ type: 'invoice.return_credit_drafted', subject: id, companyId: credited.companyId, payload: { invoiceId: id, returnId: rma.id, creditOfId: credited.id, partyId: rma.partyId, returnLineIds } })
    made.push({ invoiceId: id, creditOfId: credited.id, returnLineIds })
  }
  const skipped = plan.skipped.filter((line) => line.code !== 'NOT_ASKED')
  if (made.length === 0) {
    tools.audit({ action: 'invoices.creditNoteFromReturn', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, after: { made: 0, skipped: skipped.map((line) => ({ seq: line.seq, code: line.code })) } })
  }
  return { made, skipped }
}

const skippedView = (line: SkippedLine) => ({ lineId: line.lineId, seq: line.seq, code: line.code, message: line.message })

/** invoices.manage: drafts the credit notes of a return's decided lines (one per invoice). 409 in words when none can be. */
export async function draftReturnCreditNotes(caller: CommandCaller, returnId: string, body: { lineIds?: readonly string[] | undefined }, idempotencyKey?: string): Promise<{ creditNotes: InvoiceDetail[]; notCredited: ReturnType<typeof skippedView>[] }> {
  const context = officeContextOf(caller)
  const rma = await caller.withClient((client) => readReturn(client, returnId))
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, rma ? { companyId: rma.companyId, partyId: rma.partyId } : null, 'Return')
  const wanted = body.lineIds && body.lineIds.length > 0 ? new Set(body.lineIds) : null
  const { result } = await command(caller, { name: 'invoices.creditNotesFromReturn', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const drafted = await draftFromReturnInCommand(tools, rma!.id, wanted)
    if (drafted.made.length === 0) {
      const issues = drafted.skipped.map((line) => ({ path: `returnLines/${line.lineId}`, message: line.message }))
      throw new DomainError('conflict', issues.length === 1 ? issues[0]!.message : issues.length === 0 ? `Return ${rma!.number} has no line to credit.` : `Nothing of return ${rma!.number} can be credited now.`, issues)
    }
    const creditNotes: InvoiceDetail[] = []
    for (const entry of drafted.made) creditNotes.push(await invoiceDetail(tools.tx, (await readInvoice(tools.tx, entry.invoiceId))!))
    return { creditNotes, notCredited: drafted.skipped.map(skippedView) }
  })
  return result
}

/** invoices.view: the RMA's credit notes, what a draft would credit now, and what is left out (with why). */
export async function returnCreditNotes(caller: CommandCaller, returnId: string) {
  const context = officeContextOf(caller)
  const rma = await caller.withClient((client) => readReturn(client, returnId))
  assertMay(context, INVOICES_VIEW, INVOICES_VIEW, rma ? { companyId: rma.companyId, partyId: rma.partyId } : null, 'Return')
  return caller.withClient(async (client) => {
    const { lines, invoices, onNotes } = await factsOf(client, rma!)
    const plan = await checkedPlan(client, rma!, lines, invoices, null)
    const noteIds = [...new Set(onNotes.map((note) => note.invoice.id))]
    const notes = noteIds.length > 0 ? await client.invoice.findMany({ where: { id: { in: noteIds } }, select: { id: true, number: true, status: true, issueDate: true, currency: true, netTotal: true, grossTotal: true, creditOfId: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : []
    const creditedIds = [...new Set(notes.flatMap((note) => (note.creditOfId ? [note.creditOfId] : [])))]
    const creditedRows = creditedIds.length > 0 ? await client.invoice.findMany({ where: { id: { in: creditedIds } }, select: { id: true, number: true, docType: true } }) : []
    const refunds = noteIds.length > 0 ? await client.refund.findMany({ where: { creditNoteId: { in: noteIds } }, select: { id: true, creditNoteId: true, status: true, amount: true } }) : []
    const seqOf = new Map(lines.map((line) => [line.id, line.seq]))
    return {
      return: { id: rma!.id, number: rma!.number, status: rma!.status, companyId: rma!.companyId, partyId: rma!.partyId },
      /** What the decision credits (net) and what credit notes (drafts included) credit of it. */
      creditDecidedAmount: asMoney('price', lines.reduce((sum, line) => sum + (line.creditAmount ?? 0), 0)),
      creditNotedAmount: asMoney('price', onNotes.reduce((sum, note) => sum + note.netAmount, 0)),
      creditNotes: notes.map((note) => {
        const credited = creditedRows.find((row) => row.id === note.creditOfId)
        const own = refunds.filter((refund) => refund.creditNoteId === note.id)
        return {
          id: note.id,
          number: note.number,
          status: note.status,
          issueDate: day(note.issueDate),
          currency: note.currency,
          netTotal: asMoney('price', note.netTotal),
          grossTotal: asMoney('price', note.grossTotal),
          creditOfId: note.creditOfId,
          creditOfNumber: credited?.number ?? null,
          lines: onNotes.filter((line) => line.invoice.id === note.id).map((line) => ({ returnLineId: line.returnLineId!, seq: seqOf.get(line.returnLineId!) ?? 0, quantity: line.quantity.toFixed(4), netAmount: asMoney('price', line.netAmount) })),
          refunds: own.map((refund) => ({ id: refund.id, status: refund.status, amount: asMoney('price', refund.amount) })),
        }
      }),
      toCredit: plan.notes.map((note) => ({
        creditOfId: note.creditOfId,
        invoiceNumber: note.invoiceNumber,
        currency: note.currency,
        netTotal: asMoney('price', note.netTotal),
        lines: note.lines.map((line) => ({ returnLineId: line.returnLineId, seq: line.seq, pieces: line.pieces, description: line.core.description, netAmount: asMoney('price', line.netAmount) })),
      })),
      notCredited: plan.skipped.map(skippedView),
    }
  })
}
