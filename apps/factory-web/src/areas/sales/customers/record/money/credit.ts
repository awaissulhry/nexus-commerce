import type { LimitRow } from '../../../../finance/receivables/credit/api'
import { word, type MoneyWord } from '../../../orders/record/money/word'
import type { CommercialTerms } from '../../terms/api'
import { customerTabHref } from './doors'
import { isFailed, isReading, type MoneyTabInput, type Part } from './model'

/**
 * F-CM-301 (customer page › MONEY tab, cm-w3 W3.1; 10-design §5.5; 18-lead-settles Z8) — section 5, Credit & terms (#credit): may it
 * order on credit, and how it pays. ONE block: the hold in force first (its reason, words, since when and by whom — Release… / Put on
 * hold… are the Terms tab's own window, one state with Terms); for a customer WITH a limit (the S2 row: a customer without one has no
 * row — never "0 held") what waits for credit; then Credit | Terms: Limit · Used · Free (or Over by) with the share of the limit and the
 * overdue part (price grain; without it: Within the limit / Over the credit limit / No limit, in words), and the terms (payment terms,
 * default deposit, invoicing, currency) with "Edit in Terms & requirements ›". Head: Change limit… / Set a limit… (Finance's ONE editor,
 * in place: sales.credit.limits + price; HIDDEN without it).
 */

export interface CreditCell {
  readonly key: 'limit' | 'used' | 'free' | 'over'
  readonly label: MoneyWord
  readonly amount: number
  readonly danger: boolean
}

export interface CreditModel {
  readonly answer: readonly MoneyWord[]
  /** The hold in force (the glance's): its reason and words, since when and by whom; null: none. */
  readonly hold: { readonly reason: MoneyWord; readonly words: string; readonly since: MoneyWord | null; readonly stops: MoneyWord } | null
  /** "Waiting for credit: 2 orders wait for a yes · 1 shipment held · 1 release refused" — only with the S2 row. */
  readonly waiting: readonly MoneyWord[] | null
  /** Limit · Used · Free / Over by (price grain; null without it or without a limit). */
  readonly cells: readonly CreditCell[] | null
  readonly currency: string
  /** The share of the limit used (price grain). */
  readonly usedPct: number | null
  /** "€ 2,440.00 of it is overdue" (price grain). */
  readonly overdue: MoneyWord | null
  /** The terms as facts (each label → value). */
  readonly facts: readonly { readonly key: string; readonly label: MoneyWord; readonly value: MoneyWord }[]
  readonly termsHref: string
  /** Change limit… (a limit) / Set a limit… (none) — Finance's window in place; null: hidden. */
  readonly change: 'change' | 'set' | null
  /** Put on hold… (parties.hold, no hold in force) · Release… (parties.hold, a hold in force). */
  readonly mayHold: boolean
  readonly reading: boolean
  readonly problem: string | null
}

const paysOf = (terms: CommercialTerms | null, party: MoneyTabInput['party']): MoneyWord | null => {
  const text = terms?.paymentTerms?.name ?? terms?.paymentTermsText ?? party.paymentTerms
  return text ? word('cm.text', { params: { text } }) : null
}

/** The section's model (pure). The glance (the credit, the hold) is the page's; the S2 row and the terms are the section's reads. */
export function creditOf(input: MoneyTabInput, creditRow: Part<LimitRow | null> | null, terms: Part<CommercialTerms> | null, prefix: string): CreditModel {
  const can = input.can
  const price = can.price
  const glance = input.glance?.status === 'ready' ? input.glance.value : null
  const credit = can.credit ? (glance?.credit ?? null) : null
  const row = creditRow?.value ?? null
  const currency = credit?.currency ?? row?.currency ?? input.party.currency ?? 'EUR'
  const holdRow = glance?.hold.onHold ? (glance.hold.holds[0] ?? null) : null
  const hold = holdRow
    ? {
        reason: word(`sales-customers-depth:reason.${holdRow.reason}`),
        words: holdRow.words,
        since: holdRow.placedBy
          ? word('sales-customers-depth:hold.placedBy', { instants: { date: holdRow.placedAt }, params: { by: holdRow.placedBy } })
          : word('sales-customers-depth:hold.placedSystem', { instants: { date: holdRow.placedAt } }),
        stops: word('sales-customers-depth:hold.stops'),
      }
    : null
  // What waits for credit: only with the S2 row (a customer WITH a limit), and only what is there (never "0 held").
  const waiting: MoneyWord[] | null = row
    ? [
        ...(row.held.orders > 0 ? [word('cm.credit.waitOrders', { params: { count: row.held.orders } })] : []),
        ...(row.held.shipments > 0 ? [word('cm.credit.waitShipments', { params: { count: row.held.shipments } })] : []),
        ...(row.held.releases > 0 ? [word('cm.credit.waitReleases', { params: { count: row.held.releases } })] : []),
      ]
    : null
  const amount = (value: number | null | undefined): number | null => (price && typeof value === 'number' ? value : null)
  const limit = amount(credit?.limit ?? row?.limit)
  const used = amount(credit?.used ?? row?.used)
  const free = amount(credit?.available ?? row?.available)
  const over = amount(credit?.overLimitBy ?? row?.overLimitBy)
  const isOver = credit?.state === 'OVER' || (row?.overLimitBy ?? 0) > 0
  const cells: CreditCell[] | null =
    limit !== null && used !== null
      ? [
          { key: 'limit', label: word('sales-credit:col.limit'), amount: limit, danger: false },
          { key: 'used', label: word('sales-credit:col.used'), amount: used, danger: false },
          ...(isOver && over !== null ? [{ key: 'over' as const, label: word('cm.credit.overBy'), amount: over, danger: true }] : free !== null ? [{ key: 'free' as const, label: word('cm.credit.free'), amount: free, danger: false }] : []),
        ]
      : null
  const usedPct = price && limit !== null && limit > 0 && used !== null ? Math.round((used / limit) * 100) : null
  const overdueAmount = amount(credit?.overdue ?? row?.overdue)
  const overdue = overdueAmount !== null && overdueAmount > 0 ? word('cm.credit.overdue', { money: { amount: overdueAmount } }) : null
  // The answer: the standing (in words without prices), the hold's day, how it pays.
  const answer: MoneyWord[] = []
  if (credit) {
    if (credit.state === 'NONE') answer.push(price && input.company ? word('cm.credit.noneWith', { params: { company: input.company.name } }) : word('sales-customers-depth:credit.noLimit'))
    else if (isOver) answer.push(over !== null ? word('cm.needs.overBy', { money: { amount: over } }) : word('sales-customers-depth:credit.over'))
    else answer.push(free !== null && limit !== null ? word('cm.credit.within', { money: { free, limit } }) : word('sales-customers-depth:credit.within'))
  }
  if (holdRow) answer.push(word('cm.credit.holdSince', { instants: { date: holdRow.placedAt } }))
  const pays = paysOf(terms?.value ?? null, input.party)
  if (pays) answer.push(word('cm.credit.pays', { words: { terms: pays } }))
  const t = terms?.value ?? null
  const facts = [
    { key: 'paymentTerms', label: word('tab.paymentTerms'), value: pays ?? word('cm.balance.noTerms') },
    ...(t ? [{ key: 'deposit', label: word('cm.credit.deposit'), value: t.defaultDepositPct ? word('cm.credit.pct', { pcts: { pct: t.defaultDepositPct } }) : word('cm.credit.noDeposit') }] : []),
    ...(t ? [{ key: 'invoicing', label: word('customer-terms:termsField.invoicing'), value: word(`customer-terms:invoicing.${t.invoiceTiming}`) }] : []),
    { key: 'currency', label: word('customer-terms:termsField.currency'), value: word('cm.text', { params: { text: t?.currency ?? input.party.currency ?? 'EUR' } }) },
  ]
  return {
    answer,
    hold,
    waiting: waiting && waiting.length > 0 ? waiting : null,
    cells,
    currency,
    usedPct,
    overdue,
    facts,
    termsHref: customerTabHref(prefix, input.party.id, 'terms', 'party-commercial'),
    change: can.creditLimits && price && credit ? (credit.state === 'NONE' ? 'set' : 'change') : null,
    mayHold: can.hold,
    reading: isReading(terms) || (input.glance?.status === 'loading' && can.credit),
    problem: isFailed(terms) ? terms!.problem : isFailed(creditRow) ? creditRow!.problem : null,
  }
}
