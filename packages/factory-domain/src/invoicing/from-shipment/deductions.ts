import { fromMinorUnits, toMinorUnits, type MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { treatmentKey, type VatTreatment } from '../../tax/vat-treatment'
import { vatOn } from '../../tax/vat-summary'
import type { IssueProblem } from '../checks'
import { formatDateIt } from '../fatturapa/format'
import { amountText, type CoreLine } from '../invoices'

/**
 * The deposit deducted on the final invoice (B-W1-51; FIN-078; SAL-246; FatturaPA "storno acconto", DatiFattureCollegate
 * to the TD02), pure. Every issued TD02 of the orders an invoice bills is deducted once, automatically, on the first
 * invoice of their goods: a DEPOSIT_DEDUCTION line per TD02, with the TD02's VAT treatment and its net and gross taken
 * off (negative). What one TD02 gives is never more than its net less its credit notes less what other invoices deduct
 * (issued ones, and drafts, so two drafts never deduct it twice), nor more than the goods of the same treatment on this
 * invoice (the total never goes below 0); the rest is deducted on the next invoice of the order. A TD02 SDI rejected
 * counts as never issued (circolare AdE 13/E/2018): it is not deducted until it is sent again. The issue checks the
 * caps again under the TD02s' locks (deductionProblems), as the …_money_guards trigger does.
 */

/** One VAT treatment of a TD02: what it charged. */
export interface DepositEntry {
  readonly treatment: VatTreatment
  readonly taxable: MinorUnits
  readonly vat: MinorUnits
}

export interface DepositInvoiceFacts {
  readonly id: string
  readonly companyId: string
  readonly docType: string
  readonly status: string
  readonly number: string | null
  readonly issueDate: BusinessDate | null
  readonly netTotal: MinorUnits
  readonly grossTotal: MinorUnits
  readonly entries: readonly DepositEntry[]
  /** Its issued credit notes: net and gross. */
  readonly creditedNet: MinorUnits
  readonly creditedGross: MinorUnits
  /** What other invoices deduct from it (net, positive): issued ones, plus drafts when planning a new draft. */
  readonly deductedNet: MinorUnits
  /** The invoices that deduct it (numbers; "draft" for a draft). */
  readonly deductedBy: readonly string[]
}

/** A deduction line to write: the core line and the TD02 it deducts. */
export interface DeductionLine {
  readonly core: CoreLine
  readonly depositInvoiceId: string
}

export interface DeductionPlan {
  readonly lines: readonly DeductionLine[]
  /** The TD02s not deducted here, and why. */
  readonly skipped: readonly { readonly depositInvoiceId: string; readonly number: string | null; readonly reason: string }[]
}

/** What is left to deduct from a TD02: its net less its credits less what others deduct. */
export const deductibleNet = (deposit: Pick<DepositInvoiceFacts, 'netTotal' | 'creditedNet' | 'deductedNet'>): MinorUnits => Math.max(0, deposit.netTotal - deposit.creditedNet - deposit.deductedNet)

export const deductionDescription = (deposit: { readonly number: string; readonly issueDate: BusinessDate }): string => `Storno acconto fattura n. ${deposit.number} del ${formatDateIt(deposit.issueDate)}`

/**
 * The deduction lines of a new draft: `goodsNet` is the net of its goods lines per treatment (treatmentKey → minor
 * units). TD02s in date and number order.
 */
export function planDeductions(deposits: readonly DepositInvoiceFacts[], goodsNet: ReadonlyMap<string, MinorUnits>, currency: string): DeductionPlan {
  const room = new Map(goodsNet)
  const lines: DeductionLine[] = []
  const skipped: { depositInvoiceId: string; number: string | null; reason: string }[] = []
  const ordered = [...deposits].sort((a, b) => (a.issueDate ?? '').localeCompare(b.issueDate ?? '') || (a.number ?? '').localeCompare(b.number ?? '', undefined, { numeric: true }))
  for (const deposit of ordered) {
    const skip = (reason: string) => skipped.push({ depositInvoiceId: deposit.id, number: deposit.number, reason })
    if (deposit.docType !== 'TD02' || deposit.status === 'DRAFT' || deposit.number === null || deposit.issueDate === null) {
      skip('Not an issued deposit invoice.')
      continue
    }
    if (deposit.status === 'REJECTED') {
      skip(`Deposit invoice ${deposit.number} was rejected by SDI and counts as not issued: fix and send it again, then deduct it.`)
      continue
    }
    const left = deductibleNet(deposit)
    if (left <= 0) {
      skip(deposit.deductedBy.length > 0 ? `Deposit invoice ${deposit.number} is deducted already (${deposit.deductedBy.join(', ')}).` : `Deposit invoice ${deposit.number} is credited in full: nothing to deduct.`)
      continue
    }
    if (deposit.entries.length !== 1) {
      skip(`Deposit invoice ${deposit.number} has ${deposit.entries.length} VAT treatments: deduct it by hand (not built in W1).`)
      continue
    }
    const entry = deposit.entries[0]!
    const key = treatmentKey(entry.treatment)
    const available = room.get(key) ?? 0
    if (available <= 0) {
      skip(goodsNet.has(key) ? `Nothing is left on this invoice to deduct deposit invoice ${deposit.number} from: it is deducted on the next invoice of the order.` : `Deposit invoice ${deposit.number} was taxed otherwise than the goods of this invoice: deduct it on an invoice with goods of its VAT treatment.`)
      continue
    }
    const net = Math.min(left, available)
    // The whole TD02 at once: its own gross (no cent lost); a part: the VAT of that part.
    const whole = net === deposit.netTotal && deposit.creditedNet === 0 && deposit.deductedNet === 0
    const vat = whole ? deposit.grossTotal - deposit.netTotal : toMinorUnits(vatOn(fromMinorUnits(net, currency), entry.treatment), currency)
    room.set(key, available - net)
    lines.push({
      depositInvoiceId: deposit.id,
      core: {
        kind: 'DEPOSIT_DEDUCTION',
        description: deductionDescription({ number: deposit.number, issueDate: deposit.issueDate }),
        itemCode: null,
        quantity: '1',
        uom: null,
        unitPrice: fromMinorUnits(-net, currency).toFixed(6),
        discountPct: null,
        vat: entry.treatment,
        deduction: { netAmount: -net, grossAmount: -(net + vat) },
      },
    })
  }
  return { lines, skipped }
}

/** A deduction line of an invoice being issued. */
export interface DeductedLine {
  readonly index: number
  readonly depositInvoiceId: string
  /** Negative minor units. */
  readonly netAmount: MinorUnits
}

/**
 * The deduction problems at issue (paths `lines/<i>`): a deducted invoice that is not an issued TD02 of the company, or
 * one SDI rejected; and what all issued invoices deduct from a TD02 (`deposits[].deductedNet`: OTHER issued invoices
 * only) plus this one passing its net less its credit notes.
 */
export function deductionProblems(companyId: string, lines: readonly DeductedLine[], deposits: ReadonlyMap<string, DepositInvoiceFacts>, currency: string): IssueProblem[] {
  const problems: IssueProblem[] = []
  const byDeposit = new Map<string, { index: number; net: number }>()
  for (const line of lines) {
    const entry = byDeposit.get(line.depositInvoiceId) ?? { index: line.index, net: 0 }
    entry.net += -line.netAmount
    byDeposit.set(line.depositInvoiceId, entry)
  }
  for (const [id, entry] of byDeposit) {
    const deposit = deposits.get(id)
    const path = `lines/${entry.index}`
    if (!deposit || deposit.docType !== 'TD02' || deposit.status === 'DRAFT' || deposit.companyId !== companyId) {
      problems.push({ code: 'DEDUCTION_STATE', path, message: `Line ${entry.index + 1} deducts a document that is not an issued deposit invoice (TD02) of this company: remove it.` })
      continue
    }
    if (deposit.status === 'REJECTED') {
      problems.push({ code: 'DEDUCTION_STATE', path, message: `Deposit invoice ${deposit.number} was rejected by SDI and counts as not issued: fix and send it again first, or remove the deduction.` })
      continue
    }
    if (deposit.deductedNet + deposit.creditedNet + entry.net > deposit.netTotal) {
      problems.push({
        code: 'DEDUCTION_OVER',
        path,
        message: `Deposit invoice ${deposit.number} has a net of ${amountText(deposit.netTotal, currency)}; ${amountText(deposit.creditedNet, currency)} of it is credited and ${amountText(deposit.deductedNet, currency)} deducted already${deposit.deductedBy.length > 0 ? ` (${deposit.deductedBy.join(', ')})` : ''}: this invoice would deduct ${amountText(entry.net, currency)} more. Remove the deduction, or delete the draft and make it again from its DDTs.`,
      })
    }
  }
  return problems
}
