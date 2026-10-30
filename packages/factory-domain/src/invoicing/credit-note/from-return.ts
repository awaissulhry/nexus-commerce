import { fromMinorUnits, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { VatTreatment } from '../../tax/vat-treatment'
import type { IssueProblem } from '../checks'
import { amountText, MAX_DESCRIPTION, type CoreLine, type InvoiceDocType } from '../invoices'
import { creditCausale, creditStateProblem } from './credit-note'

/**
 * Credit notes from a customer return (B-W2a-61; FIN-070; DPR 633/1972 art. 26; design sales.returns "Replacement &
 * credit" → "Make credit note", finance.invoices "Credit note for …" from the return inspection), pure.
 *
 * A return's decision (B-W2a-43, SAL-341) gives each received line a credit: `creditAmount`, net, minor units of the
 * invoice's currency (what came back is worth, or less; 0 = no credit). The decision emits `return.credit_due`; the money
 * module drafts the credit notes (TD04) from it — the worker on the event, or a person on the RMA — and a person issues
 * each one like any invoice (invoices.issue + step-up), never the system.
 *
 *   one per invoice   a TD04 credits ONE invoice (creditOfId): the lines of an RMA are grouped by the invoice that billed
 *                     them. A line names the invoice line it returns (the RMA was made from the invoice); a line made
 *                     from a shipment before its invoice is matched to the issued TD01/TD24 line that billed its order
 *                     line and size since (the newest); one never billed has nothing to credit (named, skipped).
 *   the line          GOODS, the pieces received and decided, at the credit per piece (net, 6 decimals: the pieces ×
 *                     the price give back exactly the decided credit), the billed line's own VAT (never decided again:
 *                     the note reverses what the invoice charged), its item code and unit; the description names the
 *                     RMA and its line ("Reso RMA-2026-0001 riga 10: …"); the line names the return line
 *                     (InvoiceLine.returnLineId), so a return line is credited once.
 *   the note          NET basis; causale "Nota di credito: Reso merce - RMA … - rif. fattura n. … del … (art. 26 DPR
 *                     633/1972)"; never above what is still creditable on the invoice (credit-note.ts `creditProblems`).
 *   not credited      not decided yet, no credit (0), nothing received, on a credit note already (draft or issued),
 *                     never invoiced, an invoice that cannot be credited (a draft, rejected by SDI, a credit note), of
 *                     another company or currency: each line said in words, never silently dropped.
 *   restocking fee    NOT applied (SAL-343, W2b; the policy's returnRestockingFeePct): the decision's credit is what the
 *                     person decided. Whether the fee is taken off, and how it shows on the credit note, is the
 *                     accountant's (named in the step's notes).
 *   at issue          the …_money_w2a_guards trigger holds: the RMA of the invoice's company, the credited invoice the one
 *                     whose line the return line names, Σ pieces credited ≤ the pieces authorised; `returnCreditProblems`
 *                     says the same in words first, and also never more money than the line's decided credit.
 */

export const RETURN_CREDIT_SKIPS = ['NOT_DECIDED', 'NO_CREDIT', 'NOT_RECEIVED', 'ON_CREDIT_NOTE', 'NOT_INVOICED', 'INVOICE_STATE', 'OTHER_COMPANY', 'CURRENCY', 'OVER_CREDITABLE', 'NOT_ASKED'] as const
export type ReturnCreditSkip = (typeof RETURN_CREDIT_SKIPS)[number]

/** The invoice line that billed what came back. */
export interface BilledLine {
  readonly invoiceLineId: string
  readonly invoiceId: string
  readonly description: string
  readonly itemCode: string | null
  readonly uom: string | null
  readonly vat: VatTreatment
  readonly salesOrderLineId: string | null
  readonly size: string | null
  /** True when the return line names it; false when it was found by the order line and size. */
  readonly named: boolean
}

/** An invoice a credit note would credit. */
export interface InvoiceToCredit {
  readonly id: string
  readonly companyId: string
  readonly docType: InvoiceDocType
  readonly status: string
  readonly number: string | null
  readonly issueDate: BusinessDate | null
  readonly currency: string
}

/** A line of the RMA, as the decision left it. */
export interface ReturnedLine {
  readonly id: string
  readonly seq: number
  readonly quantity: number
  readonly receivedQuantity: number
  readonly disposition: string | null
  /** The decided credit (net, minor units); null: not decided. */
  readonly creditAmount: MinorUnits | null
  readonly billedBy: BilledLine | null
  /** The credit notes (any status) whose lines already name it. */
  readonly onCreditNotes: readonly { readonly invoiceId: string; readonly number: string | null; readonly status: string }[]
}

export interface ReturnFacts {
  readonly id: string
  readonly number: string
  readonly companyId: string
}

export interface PlannedLine {
  readonly returnLineId: string
  readonly seq: number
  readonly core: CoreLine
  readonly salesOrderLineId: string | null
  readonly size: string | null
  readonly pieces: number
  readonly netAmount: MinorUnits
}

export interface PlannedCreditNote {
  readonly creditOfId: string
  readonly invoiceNumber: string
  readonly currency: string
  readonly causale: string
  readonly lines: readonly PlannedLine[]
  readonly netTotal: MinorUnits
}

export interface SkippedLine {
  readonly lineId: string
  readonly seq: number
  readonly code: ReturnCreditSkip
  readonly message: string
}

export interface ReturnCreditPlan {
  readonly notes: readonly PlannedCreditNote[]
  readonly skipped: readonly SkippedLine[]
}

/** The description of a credit note's line: the RMA, its line, what the invoice billed (FatturaPA Descrizione, ≤ 1000). */
export const returnLineDescription = (rmaNumber: string, seq: number, billed: string): string => `Reso ${rmaNumber} riga ${seq}: ${billed}`.slice(0, MAX_DESCRIPTION)

/** The credit per piece (major units, 6 decimals) that gives back exactly `credit` for `pieces` (to the cent, < 10,000 pieces). */
export function pricePerPiece(credit: MinorUnits, pieces: number, currency: string): string {
  return fromMinorUnits(credit, currency).dividedBy(pieces).toFixed(6)
}

const label = (line: Pick<ReturnedLine, 'seq'>) => `Line ${line.seq}`

/**
 * The credit notes an RMA's decided lines make now, one per credited invoice, and the lines left out with why. `wanted`:
 * only these lines (the others are NOT_ASKED); null: every line. `invoices` holds every invoice the lines' billedBy name.
 */
export function planReturnCredit(rma: ReturnFacts, lines: readonly ReturnedLine[], invoices: ReadonlyMap<string, InvoiceToCredit>, wanted: ReadonlySet<string> | null = null): ReturnCreditPlan {
  const skipped: SkippedLine[] = []
  const skip = (line: ReturnedLine, code: ReturnCreditSkip, message: string) => skipped.push({ lineId: line.id, seq: line.seq, code, message })
  const groups = new Map<string, { invoice: InvoiceToCredit; lines: PlannedLine[] }>()
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    if (wanted && !wanted.has(line.id)) {
      skip(line, 'NOT_ASKED', `${label(line)} was not asked for.`)
      continue
    }
    if (line.creditAmount === null || line.disposition === null) {
      skip(line, 'NOT_DECIDED', `${label(line)} is not decided yet: decide what the customer gets first.`)
      continue
    }
    if (line.creditAmount <= 0) {
      skip(line, 'NO_CREDIT', `${label(line)} was decided without a credit.`)
      continue
    }
    if (line.receivedQuantity <= 0) {
      skip(line, 'NOT_RECEIVED', `Nothing of ${label(line).toLowerCase()} arrived: there is nothing to credit.`)
      continue
    }
    const on = line.onCreditNotes[0]
    if (on) {
      skip(line, 'ON_CREDIT_NOTE', `${label(line)} is on credit note ${on.number ?? '(draft)'} already (${on.status}).`)
      continue
    }
    if (!line.billedBy) {
      skip(line, 'NOT_INVOICED', `${label(line)} was shipped but never invoiced: there is no invoice to credit. Invoice the DDT without these pieces, or credit its invoice once it is issued.`)
      continue
    }
    const invoice = invoices.get(line.billedBy.invoiceId)
    if (!invoice) {
      skip(line, 'NOT_INVOICED', `${label(line)}: the invoice that billed it is not found.`)
      continue
    }
    const state = creditStateProblem(invoice)
    if (state || invoice.number === null || invoice.issueDate === null) {
      skip(line, 'INVOICE_STATE', `${label(line)}: ${state ?? `invoice ${invoice.number ?? '(draft)'} is not issued.`}`)
      continue
    }
    if (invoice.companyId !== rma.companyId) {
      skip(line, 'OTHER_COMPANY', `${label(line)}: invoice ${invoice.number} is of another company than return ${rma.number}.`)
      continue
    }
    const group = groups.get(invoice.id) ?? { invoice, lines: [] }
    const pieces = line.receivedQuantity
    group.lines.push({
      returnLineId: line.id,
      seq: line.seq,
      core: {
        kind: 'GOODS',
        description: returnLineDescription(rma.number, line.seq, line.billedBy.description),
        itemCode: line.billedBy.itemCode,
        quantity: pieces.toFixed(4),
        uom: line.billedBy.uom,
        unitPrice: pricePerPiece(line.creditAmount, pieces, invoice.currency),
        discountPct: null,
        vat: line.billedBy.vat,
      },
      salesOrderLineId: line.billedBy.salesOrderLineId,
      size: line.billedBy.size,
      pieces,
      netAmount: line.creditAmount,
    })
    groups.set(invoice.id, group)
  }
  const notes: PlannedCreditNote[] = [...groups.values()].map(({ invoice, lines: planned }) => ({
    creditOfId: invoice.id,
    invoiceNumber: invoice.number!,
    currency: invoice.currency,
    causale: creditCausale('RETURN', `RMA ${rma.number}`, { number: invoice.number!, issueDate: invoice.issueDate! }),
    lines: planned,
    netTotal: planned.reduce((sum, line) => sum + line.netAmount, 0),
  }))
  return { notes, skipped: skipped.sort((a, b) => a.seq - b.seq) }
}

/** The lines of a planned note left out because the invoice has not enough left to credit (the cap of credit-note.ts). */
export function overCreditable(note: PlannedCreditNote, message: string): SkippedLine[] {
  return note.lines.map((line) => ({ lineId: line.returnLineId, seq: line.seq, code: 'OVER_CREDITABLE' as const, message: `Line ${line.seq}: ${message}` }))
}

/** A return line a credit note's lines name, with what credits it elsewhere, for the checks at issue. */
export interface CreditedReturnLine {
  readonly id: string
  readonly seq: number
  readonly rmaNumber: string
  readonly rmaCompanyId: string
  /** Pieces authorised to come back. */
  readonly quantity: number
  readonly creditAmount: MinorUnits | null
  /** The invoice whose line the return line names, when it names one. */
  readonly billedOnInvoiceId: string | null
  /** On OTHER credit notes that are not drafts (issued, at SDI, rejected): pieces (decimal string) and net. */
  readonly otherPieces: string
  readonly otherNet: MinorUnits
  /** On this credit note. */
  readonly thisPieces: string
  readonly thisNet: MinorUnits
}

/**
 * The problems of a TD04 that credits return lines, at issue (codes RETURN_OF, RETURN_OVER, RETURN_CREDIT_OVER): the
 * RMA of the note's company, the credited invoice the one the return line names, never more pieces than came back,
 * never more money than the line's decided credit.
 */
export function returnCreditProblems(note: { readonly companyId: string; readonly creditOfId: string | null; readonly currency: string }, lines: readonly CreditedReturnLine[]): IssueProblem[] {
  const problems: IssueProblem[] = []
  for (const line of lines) {
    const what = `Return ${line.rmaNumber} line ${line.seq}`
    if (line.rmaCompanyId !== note.companyId) {
      problems.push({ code: 'RETURN_OF', path: `returnLines/${line.id}`, message: `${what} is a return of another company: a credit note credits its own company's returns.` })
      continue
    }
    if (line.billedOnInvoiceId !== null && line.billedOnInvoiceId !== note.creditOfId) {
      problems.push({ code: 'RETURN_OF', path: `returnLines/${line.id}`, message: `${what} returns a line of another invoice than the one this credit note credits.` })
      continue
    }
    const pieces = Number(line.otherPieces) + Number(line.thisPieces)
    if (pieces > line.quantity) {
      problems.push({ code: 'RETURN_OVER', path: `returnLines/${line.id}`, message: `${what} brings back ${line.quantity} piece(s); with this credit note ${pieces} would be credited (${Number(line.otherPieces)} on other credit notes).` })
      continue
    }
    if (line.creditAmount === null) {
      problems.push({ code: 'RETURN_CREDIT_OVER', path: `returnLines/${line.id}`, message: `${what} is not decided yet: its credit is decided on the return first.` })
      continue
    }
    if (line.otherNet + line.thisNet > line.creditAmount) {
      problems.push({
        code: 'RETURN_CREDIT_OVER',
        path: `returnLines/${line.id}`,
        message: `${what} was decided a credit of ${amountText(line.creditAmount, note.currency)}; this credit note credits ${amountText(line.thisNet, note.currency)} of it${line.otherNet > 0 ? ` and other credit notes ${amountText(line.otherNet, note.currency)}` : ''}.`,
      })
    }
  }
  return problems
}
