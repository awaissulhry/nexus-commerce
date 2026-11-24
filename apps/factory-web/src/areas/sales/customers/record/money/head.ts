import { AGEING_BUCKETS, type AgeingBucket, type AgeingRow } from '../../../../finance/receivables/api'
import type { Tone } from '../../../orders/model'
import { word, type MoneyWord } from '../../../orders/record/money/word'
import { currenciesOf, daysLateOf, isFailed, isReading, type MoneyTabInput } from './model'

/**
 * F-CM-102 (customer page › MONEY tab, 10-design §4; 18-lead-settles Z3, Z20) — the tab's ONE answer, above the sections (the shared
 * `MoneyAnswer`): where the money with this customer stands, ONE sentence per currency, fixed order, only what is true, at most FOUR
 * parts of six:
 *
 *   1 owes        owes {amount} on {n} invoices                  (the ageing: receivables.view)
 *   2 late        {amount} late, oldest {n} days                 (the ageing: INVOICES only)
 *   3 deposits    {amount} in deposits asked[, {n} late since {day}]   (open items: payments.view) — a late DEPOSIT is said HERE in its
 *                 own words, never inside the late amount, and never dropped
 *   4 on account  {amount} on account                            (open items' credit balance: payments.view)
 *   5 give back   {amount} to give back                          (refunds due + credit notes with money left: payments.view)
 *   6 standing    on hold ({reason})[, over the credit limit by {amount}]   (the glance; "over" needs sales.credit.view)
 *
 * More than four true: the calm ones step back — on account, then to give back, then deposits with none late. Without the price grain
 * the same parts in words (their own keys: never an amount dropped out of a sentence). A part whose read is not in is LEFT OUT (never
 * "0"); a failed read adds the order tab's own line "Part of the money could not be read…". Nothing true: "Nothing open with {customer}."
 * Two currencies: one sentence each (never added); part 6 only in the first. Under it, quiet: "With {company}." when the reader reaches
 * more than one company, and "{customer} also owes {company}: …" with its door (the same customer's rows in the other companies).
 * Tone: danger = a late invoice, a late deposit, on hold or over the limit · warning = something open · info = nothing open.
 *
 * Every word of the customer's own catalogue is a `cm.*` key; a reused word names its catalogue (`orders:…`, `sales-customers-depth:…`).
 */

/** What the customer owes and holds in ONE currency (never added across currencies). Amounts: price grain only, else null. */
export interface CurrencyFigures {
  readonly currency: string
  /** Open invoices (the ageing): their count, and the amount (P). */
  readonly openInvoices: number
  readonly open: number | null
  /** Late invoices: the amount (P), the count (S7, else from the open items' due days; null: not known), the oldest days late. */
  readonly late: number | null
  readonly lateInvoices: number | null
  readonly oldestDays: number
  /** The five age buckets (P). */
  readonly buckets: Readonly<Record<AgeingBucket, number>> | null
  /** Open deposit and before-shipping requests (open items): count, amount (P), how many late and since when (the oldest late due day). */
  readonly requests: number
  readonly deposits: number | null
  readonly requestsLate: number
  readonly lateSince: string | null
  /** Money on account (paid, placed on nothing): is there any, and how much (P). */
  readonly onAccount: boolean
  readonly onAccountAmount: number | null
  /** Refunds to make and credit notes with money left to refund: how many, and the amount (P). */
  readonly toGiveBack: number
  readonly giveBack: number | null
}

const sum = (values: readonly (number | null | undefined)[]): number => values.reduce<number>((total, value) => total + (value ?? 0), 0)

/** The figures of every currency the customer's money is in (the party's own currency first). Pure. */
export function figuresOf(input: MoneyTabInput): CurrencyFigures[] {
  const price = input.can.price
  const ageing = input.ageing?.value ?? null
  const items = input.openItems?.value?.items ?? null
  const balance = input.openItems?.value?.creditBalance ?? null
  const refunds = input.refunds?.value ?? null
  const found: string[] = []
  for (const row of ageing ?? []) if (row.invoices > 0) found.push(row.currency)
  for (const item of items ?? []) found.push(item.currency)
  for (const entry of balance ?? []) if (entry.amount === undefined || entry.amount > 0) found.push(entry.currency)
  for (const refund of refunds?.refundsDue ?? []) found.push(refund.currency)
  for (const note of refunds?.creditNotesToRefund ?? []) found.push(note.currency)
  return currenciesOf(found, input.party.currency).map((currency) => {
    const rows = (ageing ?? []).filter((row) => row.currency === currency)
    const lateRows = rows.filter((row) => (row.daysLate ?? 0) > 0 || (row.overdue ?? 0) > 0)
    const invoicesHere = (items ?? []).filter((item) => item.target === 'INVOICE' && item.currency === currency)
    const requestsHere = (items ?? []).filter((item) => item.target === 'DEPOSIT_REQUEST' && item.currency === currency)
    const late = requestsHere.filter((item) => daysLateOf(item.dueDate, input.today) > 0).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
    // The late-invoice COUNT: the server's (S7) when every row has it, else the open items' own due days (an invoice's first instalment).
    const counted = rows.length > 0 && rows.every((row) => typeof row.lateInvoices === 'number') ? sum(rows.map((row) => row.lateInvoices)) : items ? invoicesHere.filter((item) => daysLateOf(item.dueDate, input.today) > 0).length : null
    const credit = (balance ?? []).find((entry) => entry.currency === currency)
    const dueRefunds = (refunds?.refundsDue ?? []).filter((refund) => refund.currency === currency)
    const notes = (refunds?.creditNotesToRefund ?? []).filter((note) => note.currency === currency)
    const buckets = price && rows.length > 0 ? (Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, sum(rows.map((row) => row.buckets?.[bucket]))])) as Record<AgeingBucket, number>) : null
    return {
      currency,
      openInvoices: sum(rows.map((row) => row.invoices)),
      open: price ? sum(rows.map((row) => row.open)) : null,
      late: price && lateRows.length > 0 ? sum(lateRows.map((row) => row.overdue)) : null,
      lateInvoices: lateRows.length === 0 ? 0 : counted,
      oldestDays: Math.max(0, ...rows.map((row) => row.daysLate ?? 0)),
      buckets,
      requests: requestsHere.length,
      deposits: price ? sum(requestsHere.map((item) => item.openAmount)) : null,
      requestsLate: late.length,
      lateSince: late[0]?.dueDate ?? null,
      onAccount: !!credit && (credit.amount === undefined || credit.amount > 0),
      onAccountAmount: price && credit && typeof credit.amount === 'number' ? credit.amount : null,
      toGiveBack: dueRefunds.length + notes.length,
      giveBack: price ? sum(dueRefunds.map((refund) => refund.amount)) + sum(notes.map((note) => note.refundableAmount)) : null,
    }
  })
}

/** Something late in these figures (a late invoice, a late deposit request). */
export const anyLate = (figures: CurrencyFigures): boolean => figures.oldestDays > 0 || (figures.lateInvoices ?? 0) > 0 || figures.requestsLate > 0
/** Something open in these figures (to collect, held for the customer, or to give back). */
export const anyOpen = (figures: CurrencyFigures): boolean => figures.openInvoices > 0 || figures.requests > 0 || figures.onAccount || figures.toGiveBack > 0

/** The credit standing (part 6): on hold (the glance's hold, every reader of the page), over the limit (sales.credit.view). */
export interface Standing {
  /** The reason code of the first hold in force (said with `sales-customers-depth:reason.*`). */
  readonly holdReason: string | null
  readonly holdSince: string | null
  readonly over: boolean
  /** By how much (P), in the credit's currency. */
  readonly overBy: number | null
  readonly currency: string | null
}

export function standingOf(input: MoneyTabInput): Standing | null {
  const glance = input.glance?.status === 'ready' ? input.glance.value : null
  if (!glance) return null
  const hold = glance.hold.onHold ? (glance.hold.holds[0] ?? null) : null
  const credit = input.can.credit ? glance.credit : null
  const over = credit?.state === 'OVER'
  if (!hold && !over) return null
  return { holdReason: hold?.reason ?? null, holdSince: hold?.placedAt ?? null, over, overBy: over && input.can.price && typeof credit?.overLimitBy === 'number' ? credit.overLimitBy : null, currency: credit?.currency ?? null }
}

type PartId = 'owes' | 'late' | 'deposits' | 'onAccount' | 'giveBack' | 'standing'

/** One currency's sentence: its code (said only when there are two or more) and its parts in order. */
export interface AnswerLine {
  readonly currency: string | null
  readonly parts: readonly MoneyWord[]
}

/** "Seed Customer One also owes Seed Company B: 2 invoices, 1 late" and its door (that company's own page of this customer). */
export interface AlsoOwes {
  readonly company: { readonly id: string; readonly code: string; readonly name: string }
  readonly words: MoneyWord
  readonly door: MoneyWord
}

export interface CustomerAnswer {
  readonly tone: Tone
  /** The page's reads are not in yet: one line "Reading the money…", no answer. */
  readonly reading: boolean
  readonly lines: readonly AnswerLine[]
  /** "Nothing open with {customer}." (when nothing is true). */
  readonly nothing: MoneyWord | null
  /** "With {company}." — the reader reaches more than one company. */
  readonly company: MoneyWord | null
  /** The same customer owes another company the reader reaches. */
  readonly elsewhere: readonly AlsoOwes[]
  /** A read failed: the order tab's own line (each section says which, with Try again). */
  readonly failed: MoneyWord | null
  /** The money wall, said ONCE for the tab. */
  readonly wall: readonly MoneyWord[]
}

/** Calm parts step back in this order when more than four are true (never owes, late, a late deposit, the standing). */
const STEP_BACK: readonly PartId[] = ['onAccount', 'giveBack', 'deposits']

function partsOf(figures: CurrencyFigures, standing: Standing | null, input: MoneyTabInput): MoneyWord[] {
  const price = input.can.price
  const parts: { id: PartId; said: MoneyWord; late?: boolean }[] = []
  if (input.ageing?.value && figures.openInvoices > 0)
    parts.push({ id: 'owes', said: price && figures.open !== null ? word('cm.answer.owes', { params: { count: figures.openInvoices }, money: { amount: figures.open } }) : word('cm.answer.owesWords', { params: { count: figures.openInvoices } }) })
  if (input.ageing?.value && figures.oldestDays > 0) {
    const days = { count: figures.oldestDays }
    parts.push({
      id: 'late',
      said:
        price && figures.late !== null
          ? word('cm.answer.late', { params: days, money: { amount: figures.late } })
          : figures.lateInvoices !== null && figures.lateInvoices > 0
            ? word('cm.answer.lateWords', { params: days, words: { invoices: word('cm.answer.invoicesLate', { params: { count: figures.lateInvoices } }) } })
            : word('cm.answer.lateSome', { params: days }),
    })
  }
  if (input.can.payments && input.openItems?.value && figures.requests > 0) {
    const asked = price && figures.deposits !== null ? word('cm.answer.deposits', { money: { amount: figures.deposits } }) : word('cm.answer.depositsWords', { params: { count: figures.requests } })
    const late = figures.requestsLate > 0 && figures.lateSince ? word('cm.answer.lateSince', { params: { count: figures.requestsLate }, days: { date: figures.lateSince } }) : null
    parts.push({ id: 'deposits', said: late ? word('cm.answer.pair', { words: { first: asked, second: late } }) : asked, late: !!late })
  }
  if (input.can.payments && input.openItems?.value && figures.onAccount)
    parts.push({ id: 'onAccount', said: price && figures.onAccountAmount !== null ? word('cm.answer.onAccount', { money: { amount: figures.onAccountAmount } }) : word('cm.answer.onAccountWords') })
  if (input.can.payments && input.refunds?.value && figures.toGiveBack > 0)
    parts.push({ id: 'giveBack', said: price && figures.giveBack !== null ? word('cm.answer.giveBack', { money: { amount: figures.giveBack } }) : word('cm.answer.refundsWords', { params: { count: figures.toGiveBack } }) })
  if (standing) {
    const hold = standing.holdReason ? word('cm.answer.onHold', { words: { reason: word(`sales-customers-depth:reason.${standing.holdReason}`) } }) : null
    const over = standing.over ? (standing.overBy !== null ? word('cm.answer.overBy', { money: { amount: standing.overBy } }) : word('cm.answer.over')) : null
    const said = hold && over ? word('cm.answer.pair', { words: { first: hold, second: over } }) : (hold ?? over)
    if (said) parts.push({ id: 'standing', said })
  }
  let kept = parts
  for (const id of STEP_BACK) if (kept.length > 4) kept = kept.filter((part) => part.id !== id || (id === 'deposits' && part.late))
  return kept.map((part) => part.said)
}

/** The tab's answer line (pure). */
export function moneyAnswerOf(input: MoneyTabInput): CustomerAnswer {
  const wall = input.can.price ? [] : [word('orders:moneyTab.head.wallPrice')]
  const core = [input.ageing, input.openItems]
  const failed = [...core, input.refunds, input.ageingElsewhere].some((part) => isFailed(part)) || input.glance?.status === 'error' ? word('orders:moneyTab.head.partFailed') : null
  const company = input.companies > 1 && input.company ? word('cm.answer.with', { params: { company: input.company.name } }) : null
  if (core.some((part) => isReading(part))) return { tone: 'info', reading: true, lines: [], nothing: null, company: null, elsewhere: [], failed: null, wall }
  const figures = figuresOf(input)
  // A late invoice's amount needs the ageing; its credit standing the glance — both said once, on the first sentence.
  const standing = standingOf(input)
  const all = figures.length > 0 ? figures : []
  const lines: AnswerLine[] = []
  all.forEach((entry, index) => {
    const parts = partsOf(entry, index === 0 ? standing : null, input)
    if (parts.length > 0) lines.push({ currency: all.length > 1 ? entry.currency : null, parts })
  })
  // The standing alone (nothing owed in any currency): its own sentence.
  if (lines.length === 0 && standing) {
    const parts = partsOf({ ...EMPTY_FIGURES, currency: standing.currency ?? input.party.currency ?? 'EUR' }, standing, input)
    if (parts.length > 0) lines.push({ currency: null, parts })
  }
  const late = figures.some(anyLate)
  const bad = !!standing
  const open = figures.some(anyOpen)
  return {
    tone: late || bad ? 'danger' : open ? 'warning' : 'info',
    reading: false,
    lines,
    nothing: lines.length === 0 ? word('cm.answer.nothing', { params: { customer: input.party.name } }) : null,
    company,
    elsewhere: alsoOwesOf(input),
    failed,
    wall,
  }
}

const EMPTY_FIGURES: CurrencyFigures = { currency: '', openInvoices: 0, open: null, late: null, lateInvoices: 0, oldestDays: 0, buckets: null, requests: 0, deposits: null, requestsLate: 0, lateSince: null, onAccount: false, onAccountAmount: null, toGiveBack: 0, giveBack: null }

/**
 * "Also owes another company": the ageing of THIS customer in the other companies the reader reaches (the page's ageing read without
 * the company term, split by company — one customer's own rows, never a filter over customers). Counts only: no amount crosses a company.
 */
export function alsoOwesOf(input: MoneyTabInput): AlsoOwes[] {
  const rows = input.ageingElsewhere?.value ?? []
  const byCompany = new Map<string, AgeingRow[]>()
  for (const row of rows) if (row.invoices > 0 && row.company.id !== input.company?.id) byCompany.set(row.company.id, [...(byCompany.get(row.company.id) ?? []), row])
  return [...byCompany.values()]
    .map((own) => {
      const company = own[0]!.company
      const invoices = sum(own.map((row) => row.invoices))
      const lateKnown = own.every((row) => typeof row.lateInvoices === 'number')
      const late = lateKnown ? sum(own.map((row) => row.lateInvoices)) : own.some((row) => (row.daysLate ?? 0) > 0) ? null : 0
      const count = word('cell.invoices', { params: { count: invoices } })
      const what = late === 0 ? count : word('cm.answer.pair', { words: { first: count, second: late === null ? word('cm.answer.someLate') : word('cm.answer.lateOfThem', { params: { count: late } }) } })
      return {
        company,
        words: word('cm.answer.alsoOwes', { params: { customer: input.party.name, company: company.name }, words: { invoices: what } }),
        door: word('cm.answer.openWith', { params: { company: company.name } }),
      }
    })
    .sort((a, b) => a.company.name.localeCompare(b.company.name))
}
