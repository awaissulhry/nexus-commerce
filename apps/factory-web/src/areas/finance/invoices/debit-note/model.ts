import { MAX_DESCRIPTION } from '@nexus/factory-domain/invoicing/invoices'
import { TYPED_CHARGE_KINDS, type ChargeKind, type InvoiceRow, type LineInput } from '../../_shared/api'
import { parsePrice, parseQuantity, type FinanceAbilities, type Phrase, type Tone } from '../../_shared/model'
import type { DebitNotes, VatLimit, VatLimitState } from './api'

/**
 * The debit note and the VAT time limit, pure (B-W2b-417; design finance.invoices page.h "New ▾ (credit note · debit note
 * W2b · deposit invoice)" and pop:credit-note "VAT time-limit warning on decreases"): which invoice a debit note or a credit
 * note may follow, the debit note's lines (what is added: a service, goods or a charge; VAT by the rules), what holds the
 * draft, and the verdict on a VAT decrease in words (`finance-invoices-depth`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** What New ▾ starts: a credit note (the invoice's own dialog), a debit note (this step's), a deposit invoice (Payments). */
export type NewKind = 'credit' | 'debit'

/** The invoices each may follow: a debit note adds to a TD01/TD24; a credit note takes back from a TD01/TD24/TD02. */
export const FOLLOWS: Readonly<Record<NewKind, ReadonlyArray<'TD01' | 'TD24' | 'TD02'>>> = { debit: ['TD01', 'TD24'], credit: ['TD01', 'TD24', 'TD02'] }

export const DEBIT_LINE_KINDS = ['SERVICE', 'GOODS', 'CHARGE'] as const
export type DebitLineKind = (typeof DEBIT_LINE_KINDS)[number]

export interface DebitLineDraft {
  kind: DebitLineKind
  chargeKind: (typeof TYPED_CHARGE_KINDS)[number]
  description: string
  quantity: string
  unitPrice: string
}

export const emptyDebitLine = (): DebitLineDraft => ({ kind: 'SERVICE', chargeKind: 'FREIGHT', description: '', quantity: '1', unitPrice: '' })

export interface DebitProblems {
  invoice?: string
  lines: Record<number, { description?: string; quantity?: string; unitPrice?: string }>
}

/** The draft's problems as message keys: an invoice picked, each line with words, a quantity above 0 and a price above 0. */
export function debitProblems(invoiceId: string | null, lines: readonly DebitLineDraft[]): DebitProblems {
  const problems: DebitProblems = { lines: {} }
  if (!invoiceId) problems.invoice = 'debit.problem.invoice'
  lines.forEach((line, index) => {
    const entry: DebitProblems['lines'][number] = {}
    if (line.description.trim() === '') entry.description = 'debit.problem.description'
    else if (line.description.trim().length > MAX_DESCRIPTION) entry.description = 'debit.problem.descriptionLong'
    if (parseQuantity(line.quantity) === null) entry.quantity = 'debit.problem.quantity'
    const price = parsePrice(line.unitPrice)
    if (price === null || Number(price) <= 0) entry.unitPrice = 'debit.problem.unitPrice'
    if (Object.keys(entry).length > 0) problems.lines[index] = entry
  })
  return problems
}

export const hasDebitProblems = (problems: DebitProblems): boolean => !!problems.invoice || Object.keys(problems.lines).length > 0

/** The lines as the API takes them (VAT left to the rules: it follows the customer and the invoice debited). */
export function debitInputsOf(lines: readonly DebitLineDraft[]): LineInput[] {
  return lines.map((line) => ({
    kind: line.kind,
    ...(line.kind === 'CHARGE' ? { chargeKind: line.chargeKind as ChargeKind } : {}),
    description: line.description.trim(),
    quantity: parseQuantity(line.quantity) ?? '1',
    unitPrice: parsePrice(line.unitPrice) ?? '0',
  }))
}

/** Why the invoice cannot take a debit note (the API's code), in words; null when it may. */
export function debitableWords(answer: Pick<DebitNotes, 'debitable'> | null): Phrase | null {
  if (!answer || answer.debitable.ok) return null
  return phrase(`debit.refusal.${answer.debitable.code ?? 'NOT_DEBITABLE'}`)
}

/** Why "Create draft debit note" is held. */
export function debitHeld(input: { can: FinanceAbilities; busy: boolean; problems: DebitProblems; debitable: Phrase | null; reading: boolean }): Phrase | null {
  if (!input.can.manageInvoices) return phrase('held.noManage')
  // The lines' prices are the price grain: the API refuses them without it.
  if (!input.can.price) return phrase('debit.held.noPrice')
  if (input.busy) return phrase('held.busy')
  if (input.problems.invoice) return phrase(input.problems.invoice)
  if (input.reading) return phrase('debit.held.reading')
  if (input.debitable) return input.debitable
  if (hasDebitProblems(input.problems)) return phrase('debit.held.fix')
  return null
}

/** Why a New ▾ item waits: the right to make drafts. */
export const newHeld = (can: FinanceAbilities): Phrase | null => (can.manageInvoices ? null : phrase('held.noManage'))

/** An invoice in the picker: its number, customer and date. */
export const pickLabel = (row: Pick<InvoiceRow, 'number' | 'partyName' | 'docType'>): string => `${row.number ?? '—'} · ${row.partyName} · ${row.docType}`

// ---- the VAT time limit ------------------------------------------------------------------------------------------------------

export const VAT_LIMIT_TONE: Record<VatLimitState, Tone> = { WITHIN: 'info', BEYOND: 'warning', NO_LIMIT: 'success', ASK: 'warning', WAITS: 'info' }

/** The verdict in words: within the year (until when), beyond it, no limit for this reason, ask, or waiting for the accountant. */
export function vatLimitWords(answer: Pick<VatLimit, 'verdict' | 'operationDate'>, day: (value: string) => string): Phrase {
  const state = answer.verdict.state
  if (state === 'WITHIN') return phrase('vatLimit.WITHIN', { until: answer.verdict.limitDate ? day(answer.verdict.limitDate) : '—', operation: day(answer.operationDate) })
  if (state === 'BEYOND') return phrase('vatLimit.BEYOND', { until: answer.verdict.limitDate ? day(answer.verdict.limitDate) : '—', operation: day(answer.operationDate) })
  return phrase(`vatLimit.${state}`)
}
