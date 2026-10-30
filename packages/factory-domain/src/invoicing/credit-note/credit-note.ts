import type { Issue } from '../../core/errors'
import { fromMinorUnits, isMinorUnits, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { Dec, parseDecimal, ZERO } from '../../tax/decimal'
import type { PriceBasis } from '../../tax/vat-summary'
import { treatmentKey, type VatTreatment } from '../../tax/vat-treatment'
import type { IssueProblem } from '../checks'
import { formatDateIt } from '../fatturapa/format'
import { amountText, DOC_TYPE_WORDS, lineProblems, MAX_CAUSALE, MAX_DESCRIPTION, type CoreLine, type InvoiceDocType } from '../invoices'

/**
 * Credit notes (TD04; B-W1-51; FIN-069; DPR 633/1972 art. 26: an issued invoice never changes, a correction is a credit
 * note that cites it, with positive amounts and why), pure.
 *
 *   what it credits   an issued invoice that is not a credit note: TD01, TD24 or a TD02 (a deposit given back). Not a
 *                     DRAFT (delete or edit it), not one SDI REJECTED (it counts as never issued: correct it and send it
 *                     again, same number and date; B-W1-50).
 *   how much          FULL: the whole invoice, per VAT treatment of its summary (only while nothing of it is credited);
 *                     LINES: some of its goods and services lines, each at most its quantity, at its price or a lower
 *                     one; AMOUNT: an amount (net or VAT included) at one of its VAT treatments (an abbuono).
 *   never more        than is still creditable: its gross less its issued credit notes; on a TD02 also its net less what
 *                     invoices deduct from it and its credit notes (the …_money_guards trigger holds both at issue).
 *   why               a reason (a code, in Italian words on the causale), with free words.
 *   money back        when the invoice is paid beyond what it is worth after the credit, a refund is due: computed and
 *                     recorded (audit and the invoice.refund_due event); refunds themselves are W2b.
 * VAT: the credited lines' own treatments (never decided again: the note reverses what the invoice charged).
 */

export const CREDIT_REASONS = ['RETURN', 'PRICE_REDUCTION', 'DEFECT', 'BILLING_ERROR', 'DEPOSIT_REFUND', 'OTHER'] as const
export type CreditReason = (typeof CREDIT_REASONS)[number]

/** The reason as the causale prints it (Italian) and as the office reads it. */
export const CREDIT_REASON_WORDS: Readonly<Record<CreditReason, { readonly it: string; readonly en: string }>> = Object.freeze({
  RETURN: { it: 'Reso merce', en: 'Goods returned' },
  PRICE_REDUCTION: { it: 'Riduzione di prezzo (abbuono)', en: 'Price reduction' },
  DEFECT: { it: 'Merce difettosa', en: 'Defective goods' },
  BILLING_ERROR: { it: 'Errore di fatturazione', en: 'Billing error' },
  DEPOSIT_REFUND: { it: 'Restituzione acconto', en: 'Deposit given back' },
  OTHER: { it: 'Altro', en: 'Other' },
})

/** A line of the invoice being credited. */
export interface CreditedLine {
  readonly id: string
  readonly seq: number
  readonly kind: 'GOODS' | 'SERVICE' | 'DEPOSIT_DEDUCTION' | 'CHARGE'
  readonly description: string
  readonly itemCode: string | null
  /** Decimal strings. */
  readonly quantity: string
  readonly uom: string | null
  readonly unitPrice: string
  readonly discountPct: string | null
  readonly vat: VatTreatment
  readonly salesOrderLineId: string | null
  readonly size: string | null
}

export interface CreditedInvoice {
  readonly id: string
  readonly docType: InvoiceDocType
  readonly status: string
  readonly number: string | null
  readonly issueDate: BusinessDate | null
  readonly currency: string
  readonly priceBasis: PriceBasis
  readonly netTotal: MinorUnits
  readonly grossTotal: MinorUnits
  /** Its VAT summary: per treatment, the taxable and the VAT. */
  readonly summary: readonly { readonly treatment: VatTreatment; readonly taxable: MinorUnits; readonly vat: MinorUnits }[]
  readonly lines: readonly CreditedLine[]
  /** Its issued credit notes (not the one being made or issued). */
  readonly creditedNet: MinorUnits
  readonly creditedGross: MinorUnits
  /** TD02: what issued invoices deduct from it (net, positive). */
  readonly deductedNet: MinorUnits
  /** What is paid on it: TD01/TD24 its allocations; TD02 its share of the deposit request's payments. */
  readonly paid: MinorUnits
}

export type CreditAsk =
  | { readonly mode: 'FULL' }
  | { readonly mode: 'LINES'; readonly lines: readonly { readonly lineId: string; readonly quantity?: string | undefined; readonly unitPrice?: string | undefined }[] }
  | { readonly mode: 'AMOUNT'; readonly amount: MinorUnits; readonly basis: PriceBasis; readonly vat?: VatTreatment | undefined; readonly description?: string | undefined }

export interface CreditLine {
  readonly core: CoreLine
  readonly salesOrderLineId: string | null
  readonly size: string | null
}

export interface CreditNoteDraft {
  readonly priceBasis: PriceBasis
  readonly lines: readonly CreditLine[]
  readonly causale: string
}

/** What may still be credited on an invoice: gross; and on a TD02 its net. */
export function creditable(invoice: Pick<CreditedInvoice, 'docType' | 'netTotal' | 'grossTotal' | 'creditedNet' | 'creditedGross' | 'deductedNet'>): { readonly gross: MinorUnits; readonly net: MinorUnits | null } {
  return {
    gross: Math.max(0, invoice.grossTotal - invoice.creditedGross),
    net: invoice.docType === 'TD02' ? Math.max(0, invoice.netTotal - invoice.creditedNet - invoice.deductedNet) : null,
  }
}

/** The causale: the reason, the words, the invoice it cites (art. 26). */
export function creditCausale(reason: CreditReason, text: string | null | undefined, credited: { readonly number: string; readonly issueDate: BusinessDate }): string {
  const words = text && text.trim() !== '' ? ` - ${text.trim()}` : ''
  return `Nota di credito: ${CREDIT_REASON_WORDS[reason].it}${words} - rif. fattura n. ${credited.number} del ${formatDateIt(credited.issueDate)} (art. 26 DPR 633/1972)`.slice(0, MAX_CAUSALE)
}

/** Whether this invoice may be credited at all (else the problem, in words). */
export function creditStateProblem(invoice: Pick<CreditedInvoice, 'docType' | 'status' | 'number'>): string | null {
  if (invoice.docType === 'TD04') return 'A credit note is not credited: a debit note corrects it (TD05, not built in W1).'
  if (invoice.status === 'DRAFT') return 'The invoice is a draft: change or delete it instead of crediting it.'
  if (invoice.status === 'REJECTED') return `Invoice ${invoice.number} was rejected by SDI and counts as never issued: correct it and send it again (same number and date) instead of crediting it.`
  return null
}

const money = (amount: MinorUnits, currency: string): string => fromMinorUnits(amount, currency).toFixed(6)

/** The credit note's lines and causale for an ask, or the problems (paths under `body/`). */
export function creditNoteDraft(invoice: CreditedInvoice, ask: CreditAsk, reason: CreditReason, reasonText?: string | null): { readonly draft: CreditNoteDraft | null; readonly problems: readonly Issue[] } {
  const problems: Issue[] = []
  const state = creditStateProblem(invoice)
  if (state) return { draft: null, problems: [{ path: 'invoice', message: state }] }
  const causale = creditCausale(reason, reasonText, { number: invoice.number!, issueDate: invoice.issueDate! })
  const lines: CreditLine[] = []
  if (ask.mode === 'FULL') {
    if (invoice.creditedGross > 0) return { draft: null, problems: [{ path: 'body/full', message: `Part of invoice ${invoice.number} is credited already: credit the rest by an amount or by lines.` }] }
    for (const entry of invoice.summary) {
      const amount = invoice.priceBasis === 'GROSS' ? entry.taxable + entry.vat : entry.taxable
      if (amount <= 0) continue
      lines.push({ core: { kind: 'GOODS', description: `Storno totale fattura n. ${invoice.number} del ${formatDateIt(invoice.issueDate!)}`, quantity: '1', unitPrice: money(amount, invoice.currency), vat: entry.treatment }, salesOrderLineId: null, size: null })
    }
    return { draft: { priceBasis: invoice.priceBasis, lines, causale }, problems }
  }
  if (ask.mode === 'LINES') {
    if (ask.lines.length === 0) return { draft: null, problems: [{ path: 'body/lines', message: 'Choose at least one line to credit.' }] }
    const seen = new Set<string>()
    ask.lines.forEach((wanted, index) => {
      const at = `body/lines/${index}`
      const source = invoice.lines.find((line) => line.id === wanted.lineId)
      if (!source) return void problems.push({ path: `${at}/lineId`, message: 'Not a line of this invoice.' })
      if (source.kind === 'DEPOSIT_DEDUCTION') return void problems.push({ path: `${at}/lineId`, message: 'A deposit deducted is not credited on its own: credit the goods, or credit by an amount.' })
      if (seen.has(source.id)) return void problems.push({ path: `${at}/lineId`, message: 'This line is chosen twice.' })
      seen.add(source.id)
      const quantity = wanted.quantity === undefined ? parseDecimal(source.quantity) : parseDecimal(wanted.quantity)
      if (quantity === null || quantity.lte(ZERO) || quantity.gt(new Dec(source.quantity))) {
        return void problems.push({ path: `${at}/quantity`, message: `A quantity above 0 and at most the line's ${new Dec(source.quantity).toString()}.` })
      }
      const price = wanted.unitPrice === undefined ? parseDecimal(source.unitPrice) : parseDecimal(wanted.unitPrice)
      if (price === null || price.lte(ZERO) || price.gt(new Dec(source.unitPrice))) {
        return void problems.push({ path: `${at}/unitPrice`, message: `A unit price above 0 and at most the line's ${new Dec(source.unitPrice).toFixed(2)}.` })
      }
      const core: CoreLine = {
        kind: source.kind,
        description: source.description,
        itemCode: source.itemCode,
        quantity: quantity.toFixed(4),
        uom: source.uom,
        unitPrice: price.toFixed(6),
        discountPct: source.discountPct,
        vat: source.vat,
      }
      problems.push(...lineProblems(core, at))
      lines.push({ core, salesOrderLineId: source.salesOrderLineId, size: source.size })
    })
    return problems.length > 0 ? { draft: null, problems } : { draft: { priceBasis: invoice.priceBasis, lines, causale }, problems }
  }
  // AMOUNT
  if (!isMinorUnits(ask.amount) || ask.amount <= 0) return { draft: null, problems: [{ path: 'body/amount', message: 'An amount above 0, in minor units (cents).' }] }
  const treatments = invoice.summary.map((entry) => entry.treatment)
  let vat: VatTreatment | undefined = ask.vat
  if (vat === undefined) {
    if (treatments.length !== 1) return { draft: null, problems: [{ path: 'body/vatRatePct', message: `Invoice ${invoice.number} has ${treatments.length} VAT treatments: say which one the amount is credited at.` }] }
    vat = treatments[0]!
  } else if (!treatments.some((entry) => treatmentKey(entry) === treatmentKey(vat!))) {
    return { draft: null, problems: [{ path: 'body/vatRatePct', message: `Invoice ${invoice.number} charged no line at this VAT: credit at one of its own treatments.` }] }
  }
  const description = (ask.description?.trim() || `${CREDIT_REASON_WORDS[reason].it} su fattura n. ${invoice.number} del ${formatDateIt(invoice.issueDate!)}`).slice(0, MAX_DESCRIPTION)
  lines.push({ core: { kind: 'SERVICE', description, quantity: '1', unitPrice: money(ask.amount, invoice.currency), vat }, salesOrderLineId: null, size: null })
  return { draft: { priceBasis: ask.basis, lines, causale }, problems }
}

/** The credit note's own facts at issue. */
export interface CreditNoteFacts {
  readonly causale: string | null
  readonly netTotal: MinorUnits
  readonly grossTotal: MinorUnits
}

/** The problems of a TD04 at issue (paths `creditOf`, `causale`, `totals`): its credited invoice and the caps. */
export function creditProblems(note: CreditNoteFacts, credited: CreditedInvoice | null): IssueProblem[] {
  const problems: IssueProblem[] = []
  if (!note.causale || note.causale.trim() === '') problems.push({ code: 'CREDIT_REASON', path: 'causale', message: 'A credit note says why it credits (causale; DPR 633/1972 art. 26).' })
  if (!credited) {
    problems.push({ code: 'CREDIT_OF', path: 'creditOf', message: 'The credit note names no invoice it credits.' })
    return problems
  }
  const state = creditStateProblem(credited)
  if (state) {
    problems.push({ code: 'CREDIT_OF', path: 'creditOf', message: state })
    return problems
  }
  const left = creditable(credited)
  const words = DOC_TYPE_WORDS[credited.docType].toLowerCase()
  if (note.grossTotal > left.gross) {
    problems.push({
      code: 'CREDIT_OVER',
      path: 'totals',
      message: `The ${words} ${credited.number} totals ${amountText(credited.grossTotal, credited.currency)} and ${amountText(credited.creditedGross, credited.currency)} of it is credited already: this credit note of ${amountText(note.grossTotal, credited.currency)} passes the ${amountText(left.gross, credited.currency)} still creditable (DPR 633/1972 art. 26).`,
    })
  } else if (left.net !== null && note.netTotal > left.net) {
    problems.push({
      code: 'CREDIT_OVER',
      path: 'totals',
      message: `Deposit invoice ${credited.number} has a net of ${amountText(credited.netTotal, credited.currency)}, ${amountText(credited.deductedNet, credited.currency)} of it deducted on invoices and ${amountText(credited.creditedNet, credited.currency)} credited: this credit note's net of ${amountText(note.netTotal, credited.currency)} passes the ${amountText(left.net, credited.currency)} left.`,
    })
  }
  return problems
}

/** The refund due once this credit note is issued: what is paid beyond the invoice's gross less all its credits. */
export function refundDueAfter(credited: Pick<CreditedInvoice, 'grossTotal' | 'creditedGross' | 'paid'>, creditGross: MinorUnits): MinorUnits {
  return Math.max(0, credited.paid - (credited.grossTotal - credited.creditedGross - creditGross))
}
