import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { canOf, deposit, order, PAID, SETTLEMENT_OPEN, SETTLEMENT_SHIPPED, TODAY } from '../../_demo/fixtures'
import type { Order, Settlement } from '../../api'
import { depositWordsOf, gapDoorOf, stillToPayOf, totalsOf } from './totals'
import { amountsOf } from './word'

/**
 * F-OM-102 (order MONEY tab, 10-design §4) — Totals: the four tiles by the server's figures only (the ONE still-to-pay rule, never the
 * web's gross − deposits), what is left with each gap's door, How it adds up, the facts (the deposit in paid words, M1-B11) and Close
 * unsettled…; a cancelled order owes nothing more; without the price grain no tile and no amount. Every name and number is made up.
 */

const totals = (value: Order, over: { settlement?: Settlement | null; role?: Parameters<typeof canOf>[0]; marginNow?: string | null } = {}) =>
  totalsOf({ order: value, settlement: over.settlement === undefined ? null : over.settlement, can: canOf(over.role ?? 'finance'), marginNow: over.marginNow ?? null, today: TODAY })
const tile = (model: ReturnType<typeof totalsOf>, id: string) => model.tiles?.find((entry) => entry.id === id) ?? null

describe('F-OM-102: what is left — every gap with its door', () => {
  it('not settled: "2 things left" — Not everything has shipped (Shipments ›), No invoice yet (Invoices ↓ with invoices.view)', () => {
    const model = totals(order('CONFIRMED'), { settlement: SETTLEMENT_OPEN })
    expect(model.answer).toEqual({ key: 'moneyTab.totals.left', params: { count: 2 } })
    expect(model.gaps.map((gap) => [gap.code, gap.door])).toEqual([['NOT_SHIPPED', 'shipments'], ['NO_INVOICE', 'invoices']])
    // Without invoices.view the invoice gap says its words, without a door (the section is not drawn).
    expect(totals(order('CONFIRMED'), { role: 'manager' }).gaps.map((gap) => gap.door)).toEqual(['shipments', null])
    expect(gapDoorOf('DEPOSIT_NOT_INVOICED', { viewInvoices: true })).toBe('payments')
    expect(gapDoorOf('OTHER', { viewInvoices: true })).toBeNull()
    // An unknown code is "Something else is missing", said once.
    const odd = order('CONFIRMED', { settlement: { settled: false, missing: [{ code: 'NEW_RULE' }, { code: 'NEW_RULE' }], source: 'invoicing' } })
    expect(totals(odd).gaps.map((gap) => gap.words.key)).toEqual(['settlement.OTHER'])
  })

  it('a balance still due names the invoice and what is open on it (price grain); without the grain only its words', () => {
    const shipped = order('SHIPPED')
    const gap = totals(shipped, { settlement: SETTLEMENT_SHIPPED }).gaps.find((entry) => entry.code === 'BALANCE_DUE')!
    expect(gap.extra).toEqual({ key: 'moneyTab.totals.openOn', params: { number: 'FA-2026-00052' }, money: { amount: 532896 } })
    expect(totals(shipped, { settlement: SETTLEMENT_SHIPPED, role: 'sales' }).gaps.find((entry) => entry.code === 'BALANCE_DUE')!.extra).toBeNull()
  })

  it('settled: one row of what is done and its day; cancelled: nothing more is owed, no gap', () => {
    const settled = totals(order('CLOSED', { settled: true }))
    expect(settled.settled).toBe(true)
    expect(settled.answer.key).toBe('moneyTab.totals.settledOn')
    expect(settled.settledRow).toEqual({ key: 'moneyTab.totals.settledRow' })
    expect(settled.gaps).toEqual([])
    const cancelled = totals(order('CANCELLED'), { settlement: SETTLEMENT_OPEN })
    expect(cancelled.answer).toEqual({ key: 'moneyTab.totals.cancelled' })
    expect(cancelled.gaps).toEqual([])
    expect(cancelled.close).toBeNull()
    // F-OM-fx3 (W-05): an older answer that still names money due — Still to pay 0, no How it adds up (it would not add up).
    const older = totals(order('CANCELLED', { money: { stillToPay: 532896, paid: 228384 } }), { settlement: SETTLEMENT_OPEN })
    expect(older.tiles?.find((tile) => tile.id === 'still')).toMatchObject({ amount: 0, hint: { key: 'moneyTab.totals.hint.cancelled' } })
    expect(older.adds).toBeNull()
  })
})

describe('F-OM-102: the tiles — the server\'s figures only', () => {
  const settlement = (over: Partial<Settlement> = {}): Settlement => ({ ...SETTLEMENT_OPEN, invoicedAmount: 0, paidAmount: 0, thisOrder: { paid: 228384, stillToPay: 532896, invoicedShare: 0, depositsPaid: 228384 }, ...over })

  it('Order total · Invoiced › (#invoices) · Paid › of which deposits (#payments) · Still to pay — by this order\'s share', () => {
    const model = totals(order('IN_PRODUCTION'), { settlement: settlement() })
    expect(model.tiles!.map((entry) => entry.id)).toEqual(['total', 'invoiced', 'paid', 'still'])
    expect(tile(model, 'total')).toMatchObject({ amount: 761280, hint: { key: 'moneyTab.totals.hint.netVat', money: { net: 624000, vat: 137280 } }, door: null })
    expect(tile(model, 'invoiced')).toMatchObject({ amount: 0, hint: { key: 'moneyTab.totals.hint.nothingYet' }, door: 'invoices' })
    expect(tile(model, 'paid')).toMatchObject({ amount: 228384, hint: { key: 'moneyTab.totals.hint.ofWhichDeposits', money: { amount: 228384 } }, door: 'payments' })
    expect(tile(model, 'still')!.amount).toBe(532896)
  })

  it('still to pay is the ONE rule: the order\'s own money (B-OM-002) first, else the settlement\'s thisOrder; never gross − deposits', () => {
    const value = order('IN_PRODUCTION', { money: { stillToPay: 500000, paid: 261280, depositsPaid: 228384 } })
    expect(stillToPayOf(value, settlement())).toBe(500000)
    expect(stillToPayOf(order('IN_PRODUCTION'), settlement())).toBe(532896)
    // A price holder without invoices.view and before the order's money comes: the order total only (no made-up figure).
    const alone = totals(order('IN_PRODUCTION'), { settlement: null })
    expect(alone.tiles!.map((entry) => entry.id)).toEqual(['total'])
    expect(alone.adds).toBeNull()
    expect(totals(value, { settlement: null }).tiles!.map((entry) => entry.id)).toEqual(['total', 'paid', 'still'])
  })

  it('the hints: deposit invoices beside the goods, a credit note, nothing received, written off (the write-off counts, B-OM-001)', () => {
    const withTd02 = settlement({ depositInvoices: [{ id: 'td02', number: 'FT-2026-00007', status: 'DELIVERED', issueDate: '2026-11-21', gross: 364500, depositRequestId: 'd1' }] })
    expect(tile(totals(order('IN_PRODUCTION'), { settlement: withTd02 }), 'invoiced')!.hint).toEqual({ key: 'moneyTab.totals.hint.goodsOnly', money: { amount: 364500 } })
    const credited = settlement({ invoicedAmount: 1207800, creditedAmount: 12200, thisOrder: { paid: 966000, stillToPay: 241800, invoicedShare: 1207800, depositsPaid: 366000 } })
    expect(tile(totals(order('SHIPPED'), { settlement: credited }), 'invoiced')!.hint).toEqual({ key: 'moneyTab.totals.hint.afterCredit', money: { amount: 12200 } })
    const nothing = settlement({ thisOrder: { paid: 0, stillToPay: 761280, invoicedShare: 0, depositsPaid: 0 } })
    expect(tile(totals(order('CONFIRMED'), { settlement: nothing }), 'paid')!.hint).toEqual({ key: 'moneyTab.totals.hint.nothingReceived' })
    const written = settlement({ invoices: [{ id: 'i1', docType: 'TD24', number: 'FT-2026-00012', status: 'DELIVERED', grossTotal: 1220000, paidAmount: 1218500, openAmount: 0, writtenOffAmount: 1500 }], thisOrder: { paid: 1218500, stillToPay: 0, invoicedShare: 1220000, depositsPaid: 366000, writtenOff: 1500 } })
    expect(tile(totals(order('SHIPPED'), { settlement: written }), 'still')!.hint).toEqual({ key: 'moneyTab.totals.hint.writtenOff', money: { amount: 1500 } })
    // The next step's day: the open deposit (25 Nov … here the fixture's 4 Nov).
    expect(tile(totals(order('CONFIRMED'), { settlement: nothing }), 'still')!.hint).toEqual({ key: 'moneyTab.totals.hint.next', words: { what: { key: 'moneyTab.plan.next.DEPOSIT' } }, days: { date: '2026-11-04' } })
  })

  it('How it adds up: Order total − never billed − credit notes − paid − written off = still to pay; rows only when not zero', () => {
    const value = order('SHIPPED', { money: { stillToPay: 0, paid: 1218500, neverBilled: 0, credited: 12200, writtenOff: 1500, depositsPaid: 366000 } })
    const written = settlement({ invoices: [{ id: 'i1', docType: 'TD24', number: 'FT-2026-00012', status: 'DELIVERED', grossTotal: 1220000, openAmount: 0, writtenOffAmount: 1500, freight: 4000 }] })
    const adds = totals(value, { settlement: written }).adds!
    expect(adds.map((row) => [row.words.key.replace('moneyTab.totals.adds.', ''), row.sign])).toEqual([['total', 'plus'], ['credited', 'minus'], ['paid', 'minus'], ['writtenOff', 'minus'], ['still', 'sum'], ['freight', 'aside']])
    expect(adds.find((row) => row.sign === 'sum')!.amount).toBe(0)
  })

  it('without the price grain: no tile, no adds, no amount in any word (the head says the money wall once)', () => {
    const model = totals(order('IN_PRODUCTION'), { settlement: settlement(), role: 'sales' })
    expect(model.tiles).toBeNull()
    expect(model.adds).toBeNull()
    expect([model.answer, ...model.gaps.flatMap((gap) => [gap.words, ...(gap.extra ? [gap.extra] : [])]), ...model.facts.flatMap((fact) => [fact.label, fact.value])].flatMap(amountsOf)).toEqual([])
  })
})

describe('F-OM-102: the facts and Close unsettled…', () => {
  it('the deposit in paid words — the amount PAID (M1-B11), an extra one open, part paid, due; in words without the price grain', () => {
    const paid = deposit({ status: 'PAID', paidAt: '2026-10-29T09:12:00Z', paidAmount: 200000, amount: 228384 })
    const value = order('IN_PRODUCTION', { chain: { ...order('IN_PRODUCTION').chain, depositRequests: [paid] } })
    expect(depositWordsOf(value, true)).toEqual({ key: 'moneyTab.totals.fact.depositPaidOn', money: { amount: 200000 }, instants: { date: '2026-10-29T09:12:00Z' } })
    expect(depositWordsOf(value, false)).toEqual({ key: 'deposit.PAID' })
    const extra = deposit({ id: 'extra', amount: 4392, paidAmount: 0, dueDate: '2026-11-25' })
    const both = order('IN_PRODUCTION', { chain: { ...order('IN_PRODUCTION').chain, depositRequests: [PAID, extra] } })
    expect(depositWordsOf(both, true)).toEqual({ key: 'moneyTab.totals.fact.paidExtra', money: { paid: 228384, extra: 4392 } })
    expect(depositWordsOf(both, false)).toEqual({ key: 'moneyTab.totals.fact.paidExtraWords' })
    const part = order('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [deposit({ paidAmount: 100000 })] } })
    expect(depositWordsOf(part, true)).toEqual({ key: 'moneyTab.totals.fact.partPaid', money: { paid: 100000, amount: 228384 } })
    expect(depositWordsOf(order('CONFIRMED'), false)).toEqual({ key: 'moneyTab.totals.fact.depositDueWords', days: { date: '2026-11-04' } })
    expect(depositWordsOf(order('CONFIRMED', { depositRequired: false }), true)).toEqual({ key: 'summary.depositNotNeeded' })
  })

  it('Margin now › (#margin) with the margin grain — the margin read\'s now, else the order\'s; Cost now with the cost grain', () => {
    const facts = totals(order('IN_PRODUCTION'), { marginNow: '40.2000' }).facts
    expect(facts.map((fact) => fact.label.key)).toEqual(['summary.deposit', 'newOrder.terms', 'moneyTab.totals.fact.marginNow', 'moneyTab.totals.fact.costNow'])
    expect(facts[2]).toEqual({ label: { key: 'moneyTab.totals.fact.marginNow' }, value: { key: 'moneyTab.totals.fact.marginValue', pcts: { pct: '40.2000' } }, door: 'margin' })
    expect(totals(order('IN_PRODUCTION')).facts[2]!.value).toEqual({ key: 'moneyTab.totals.fact.marginValue', pcts: { pct: '35.1282' } })
    expect(totals(order('IN_PRODUCTION'), { role: 'sales' }).facts.map((fact) => fact.label.key)).toEqual(['summary.deposit', 'newOrder.terms'])
  })

  it('Close unsettled… (orders.close: the band\'s dialog) — held until everything has shipped; not offered when settled or without the right', () => {
    expect(totals(order('IN_PRODUCTION')).close).toEqual({ held: { key: 'moneyTab.totals.closeHeld.notShipped' } })
    expect(totals(order('SHIPPED')).close).toEqual({ held: null })
    expect(totals(order('SHIPPED', { settled: true })).close).toBeNull()
    expect(totals(order('SHIPPED'), { role: 'sales' }).close).toBeNull()
    expect(totals(order('CLOSED')).close).toEqual({ held: { key: 'moneyTab.totals.closeHeld.closed' } })
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['title', 'info', 'keys', 'more', 'part', 'cancelled', 'settled', 'settledRow', 'nothingLeft', 'close', 'closeHeld.closed', 'closeHeld.notShipped', 'door.shipments', 'door.invoices', 'door.payments', 'tile.total', 'tile.invoiced', 'tile.paid', 'tile.still', 'adds.title', 'adds.hint', 'fact.noTerms', 'fact.marginNow', 'fact.costNow'])
        expect(t(`moneyTab.totals.${key}`), `${locale} ${key}`).not.toBe(`moneyTab.totals.${key}`)
      for (const count of [1, 2]) expect(t('moneyTab.totals.left', { count }), `${locale} left ${count}`).toContain(String(count))
    }
  })
})
