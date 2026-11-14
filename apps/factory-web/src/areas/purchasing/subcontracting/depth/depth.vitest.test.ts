import { describe, expect, it } from 'vitest'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { ApiError } from '../../../../lib/api/errors'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { STOCK } from '../demo/fixtures'
import { stockKey } from '../list/view/StockSection'
import { say } from '../model'
import { adjustBalance, BUCKETS, declareBalance, FLAGS, KINDS, openBalances, orderBalance, orderCost, orderTerms, reverseCost, bookCost, subcontractorAgeing } from './api'
import { AGEING, BALANCE_BACK, BALANCE_NOTHING_SENT, BALANCE_PARTLY, BALANCES, COST, COST_DRAFT, COST_NONE, COST_OTHER_CURRENCY, costWithoutMoney, depthFor, termsOf } from './fixtures'
import {
  adjustAfter,
  adjustBody,
  adjustHeld,
  adjustHeldDraft,
  amountOf,
  ageingKey,
  balanceRefusal,
  balanceRowsOf,
  balanceRungs,
  bookBody,
  bookDraftOf,
  bookedWords,
  bookHeld,
  bookHeldDraft,
  bookPreview,
  costRefusal,
  costRungs,
  daysOutBy,
  declareBody,
  declareDraftOf,
  declareHeld,
  declareHeldDraft,
  declareMoves,
  DEPTH,
  downloadHeld,
  entryWords,
  flagWords,
  ledgerWords,
  lockReasonHeld,
  movesOf,
  noCostYet,
  openByOrder,
  openText,
  plain,
  reverseHeld,
  termsGap,
  typedPrice,
  typedQuantity,
  workshopAgeing,
  softLocked,
} from './model'

/**
 * Subcontracting in depth on screen (B-W2b-344): the pure rules of the written terms link, the Material balance and Cost
 * tabs, days out and the Balance open view — every held act and flag in this app's words from the facts, the drafts and
 * the bodies they send, what a booking moves — the calls as B-W2b-331's API takes them, and every word in both languages.
 */

const invalid = (path: string, message = 'refused') => new ApiError('invalid', 400, 'validation', message, null, [{ path, message }])
const conflict = (message: string) => new ApiError('conflict', 409, 'conflict', message, null, [])

describe('the written terms link (SCM-049)', () => {
  it('says why no terms cover the order from the revisions, and when Download is held', () => {
    expect(termsGap(termsOf('covered'))).toBeNull()
    expect(termsGap(termsOf('draft'))).toEqual({ kind: 'draft', revision: 1 })
    expect(termsGap(termsOf('none'))).toEqual({ kind: 'none' })
    expect(termsGap(termsOf('otherDays'))).toEqual({ kind: 'otherDays' })
    expect(downloadHeld(termsOf('covered'), { files: true })).toBeNull()
    expect(downloadHeld(termsOf('covered'), { files: false })).toEqual({ key: 'held.permission', params: { permission: 'files.read' } })
    expect(downloadHeld(termsOf('noFile'), { files: true })?.key).toBe('terms.held.noFile')
    const quarantined = termsOf('covered')
    expect(downloadHeld({ covering: { ...quarantined.covering!, file: { ...quarantined.covering!.file!, status: 'QUARANTINED' } } }, { files: true })?.key).toBe('terms.held.notReady')
  })
})

describe('the material balance (SCM-143, SCM-144)', () => {
  const buyer = depthFor('buyer')
  const warehouse = depthFor('warehouse')
  const planner = depthFor('planner')
  const lining = BALANCE_BACK.lines[0]!

  it('reads the roles: the buyer and the warehouse book the balance, only the buyer books charges, the planner reads', () => {
    expect(buyer).toMatchObject({ balance: true, costBook: true, cost: true })
    expect(warehouse).toMatchObject({ balance: true, costBook: false, cost: false })
    expect(planner).toMatchObject({ balance: false, costBook: false, cost: false })
  })

  it('draws the bridge sent → used → returned → scrapped → open, the open rest an alarm only once every piece is back', () => {
    expect(balanceRungs(lining, BALANCE_BACK.order).map((rung) => [rung.key, rung.quantity, !!rung.alarm])).toEqual([
      ['sent', '42.6000', false],
      ['used', '35.9000', false],
      ['returned', '3.4000', false],
      ['scrapped', '0.6000', false],
      ['open', '2.7000', true],
    ])
    expect(balanceRungs(BALANCE_PARTLY.lines[0]!, BALANCE_PARTLY.order).at(-1)?.alarm).toBe(false)
  })

  it('words each flag from the line’s own facts (never the API’s English)', () => {
    const partly = BALANCE_PARTLY.lines[0]!
    expect(flagWords('SHORT_AT_WORKSHOP', partly)).toEqual({ key: 'balance.flag.SHORT_AT_WORKSHOP', params: { checked: '40', sent: '42.6', short: '2.6', uom: '@uom.M' } })
    expect(flagWords('BACK_NOT_DECLARED', partly).params).toMatchObject({ back: '3.4', returned: '0' })
    expect(flagWords('OPEN_AFTER_BACK', lining).params).toMatchObject({ open: '2.7' })
  })

  it('holds the declaration and the adjustment with why: the permission, nothing sent, nothing open, not declared yet', () => {
    expect(declareHeld(BALANCE_PARTLY, planner)).toEqual({ key: 'held.permission', params: { permission: 'purchasing.subcontract.balance' } })
    expect(declareHeld(BALANCE_NOTHING_SENT, warehouse)?.key).toBe('balance.held.nothingSent')
    expect(declareHeld(BALANCE_PARTLY, warehouse)).toBeNull()
    expect(declareHeld({ ...BALANCE_BACK, lines: BALANCE_BACK.lines.map((line) => ({ ...line, open: '0.0000' })) }, warehouse)?.key).toBe('balance.held.nothingOpen')
    expect(adjustHeld(BALANCE_PARTLY, BALANCE_PARTLY.lines[0]!, warehouse)?.key).toBe('balance.held.notDeclared')
    expect(adjustHeld(BALANCE_BACK, lining, buyer)).toBeNull()
  })

  it('prefills the declaration from the suggestion with the newest receipt, sends only lines with a quantity, says what moves', () => {
    const draft = declareDraftOf(BALANCE_PARTLY)
    expect(draft.receiptId).toBe(BALANCE_PARTLY.receipts[0]!.id)
    expect(draft.lines).toEqual([
      { kitLineId: BALANCE_PARTLY.lines[0]!.kitLineId, used: '15.15', returned: '3.4', scrapped: '0' },
      { kitLineId: BALANCE_PARTLY.lines[1]!.kitLineId, used: '0', returned: '0', scrapped: '0' },
    ])
    expect(declareHeldDraft(draft, BALANCE_PARTLY)).toBeNull()
    expect(declareBody({ ...draft, note: ' DDT LCD-95 ' }, 7)).toEqual({
      version: 7,
      receiptId: BALANCE_PARTLY.receipts[0]!.id,
      lines: [{ kitLineId: BALANCE_PARTLY.lines[0]!.kitLineId, used: '15.15', returned: '3.4', scrapped: '0', reason: 'DDT LCD-95' }],
    })
    expect(declareMoves(draft, BALANCE_PARTLY, 'WO-1').map((entry) => entry.key)).toEqual(['balance.move.issue', 'balance.move.returned'])
    expect(declareHeldDraft({ ...draft, lines: [{ ...draft.lines[0]!, used: '45' }] }, BALANCE_PARTLY)?.key).toBe('balance.declare.held.open')
    expect(declareHeldDraft({ ...draft, lines: [{ ...draft.lines[0]!, used: 'x' }] }, BALANCE_PARTLY)?.key).toBe('balance.declare.held.number')
    expect(declareHeldDraft({ ...draft, lines: draft.lines.map((entry) => ({ ...entry, used: '0', returned: '', scrapped: '0' })) }, BALANCE_PARTLY)?.key).toBe('balance.declare.held.nothing')
  })

  it('adjusts with signed changes and a reason, the line before and after, within what was sent', () => {
    const draft = { kitLineId: lining.kitLineId, used: '+2,2', returned: '', scrapped: '0.5', reason: 'ritagli', lockReason: null }
    expect(adjustAfter(draft, lining)).toEqual({ used: '38.1000', returned: '3.4000', scrapped: '1.1000', open: '0.0000' })
    expect(adjustHeldDraft(draft, lining)).toBeNull()
    expect(adjustBody(draft, 9)).toEqual({ version: 9, kitLineId: lining.kitLineId, used: '2.2', scrapped: '0.5', reason: 'ritagli' })
    expect(adjustHeldDraft({ ...draft, reason: ' ' }, lining)?.key).toBe('balance.adjust.held.reason')
    expect(adjustHeldDraft({ ...draft, used: '', scrapped: '' }, lining)?.key).toBe('balance.adjust.held.nothing')
    expect(adjustHeldDraft({ ...draft, used: '3' }, lining)?.key).toBe('balance.adjust.held.moreThanSent')
    expect(adjustHeldDraft({ ...draft, scrapped: '-1', used: '' }, lining)?.key).toBe('balance.adjust.held.belowZero')
    expect(movesOf(lining, { used: '-0.1', returned: '0', scrapped: '0.1' }, 'WO-1').map((entry) => entry.key)).toEqual(['balance.move.giveBack', 'balance.move.scrap'])
  })

  it('B-W2b-408 (GL1:01): once the month is soft-locked the declaration and the adjustment go with the reason, 3 to 500 characters', () => {
    const draft = declareDraftOf(BALANCE_PARTLY)
    expect(draft.lockReason).toBeNull()
    expect(declareBody(draft, 7)).not.toHaveProperty('periodLockOverride')
    expect(declareHeldDraft({ ...draft, lockReason: '' }, BALANCE_PARTLY)?.key).toBe('balance.held.lockReason')
    expect(declareHeldDraft({ ...draft, lockReason: 'x'.repeat(501) }, BALANCE_PARTLY)?.key).toBe('balance.held.lockReasonLong')
    expect(declareBody({ ...draft, lockReason: ' Bolla arrivata tardi ' }, 7)).toMatchObject({ version: 7, periodLockOverride: { reason: 'Bolla arrivata tardi' } })
    const adjust = { kitLineId: lining.kitLineId, used: '', returned: '', scrapped: '0.5', reason: 'ritagli', lockReason: '' }
    expect(lockReasonHeld(adjust.lockReason)?.key).toBe('balance.held.lockReason')
    expect(adjustHeldDraft(adjust, lining)?.key).toBe('balance.held.lockReason')
    expect(adjustBody({ ...adjust, lockReason: 'Inventario di ottobre' }, 9)).toEqual({ version: 9, kitLineId: lining.kitLineId, scrapped: '0.5', reason: 'ritagli', periodLockOverride: { reason: 'Inventario di ottobre' } })
  })

  it('says a refusal by the field it names, and the booking in words', () => {
    expect(balanceRefusal(invalid('body/lines/0/used', 'Only 2.7 m is still open')).key).toBe('balance.refused.open')
    expect(balanceRefusal(invalid('body/used', 'The used quantity would go below 0')).key).toBe('balance.refused.belowZero')
    expect(balanceRefusal(invalid('body/kitLineId')).key).toBe('balance.refused.notDeclared')
    expect(balanceRefusal(invalid('body/periodLockOverride')).key).toBe('balance.refused.period')
    expect(balanceRefusal(conflict('stale')).key).toBe('problem.changed')
    // B-W2b-408 (follow-up GL1:01): a soft-locked month asks why; a month closed for good refuses (ask the accountant).
    const lockedConflict = (path: string) => new ApiError('conflict', 409, 'conflict', 'October 2026 is soft-locked', null, [{ path, message: 'locked' }])
    expect(balanceRefusal(lockedConflict('period/SOFT_LOCKED')).key).toBe('balance.refused.periodSoft')
    expect(balanceRefusal(lockedConflict('period/HARD_LOCKED')).key).toBe('balance.refused.period')
    expect([softLocked(lockedConflict('period/SOFT_LOCKED')), softLocked(lockedConflict('period/HARD_LOCKED'))]).toEqual([true, false])
    expect(bookedWords({ rowIds: ['r'], moveIds: ['a', 'b'], ledger: { posted: 1, waiting: [] } }, buyer)).toEqual({ key: 'balance.booked', params: { count: 2 } })
    expect(bookedWords({ rowIds: ['r'], moveIds: [], ledger: { posted: 0, waiting: ['currency'] } }, buyer).key).toBe('balance.bookedWaiting')
  })
})

describe('the cost on the work order (SCM-146)', () => {
  const buyer = depthFor('buyer')
  const warehouse = depthFor('warehouse')

  it('draws the bridge only with the cost grain, kinds with nothing booked left out', () => {
    expect(costRungs(COST)?.map((rung) => [rung.key, rung.amount])).toEqual([
      ['earnedFee', 22720],
      ['feeAtWorkshopPrice', 1300],
      ['transport', 3500],
      ['orderCost', 27520],
    ])
    expect(costRungs(costWithoutMoney(COST))).toBeNull()
    expect(noCostYet(COST_NONE)).toBe(true)
    expect(noCostYet(COST)).toBe(false)
    expect(ledgerWords(COST)).toBeNull()
    expect(ledgerWords(COST_OTHER_CURRENCY)?.params).toMatchObject({ currency: 'CHF', woCurrency: 'EUR' })
  })

  it('holds a charge and a take-back with why: the permission, the grain, a draft, taken back, a reversal', () => {
    expect(bookHeld(COST, buyer)).toBeNull()
    expect(bookHeld(COST, warehouse)).toEqual({ key: 'held.permission', params: { permission: 'purchasing.subcontract.cost' } })
    expect(bookHeld(COST, { costBook: true, cost: false })).toEqual({ key: 'held.permission', params: { permission: 'money.cost' } })
    expect(bookHeld(COST_DRAFT, buyer)?.key).toBe('cost.held.draft')
    expect(reverseHeld(COST, COST.entries[1]!, buyer)).toBeNull()
    expect(reverseHeld(COST, COST.entries[2]!, buyer)?.key).toBe('cost.held.takenBack')
    expect(reverseHeld(COST, COST.entries[3]!, buyer)?.key).toBe('cost.held.isReversal')
  })

  it('books a fee for whole pieces at most what is bookable, another charge with its quantity, OTHER with what it is for', () => {
    const fee = bookDraftOf(COST, 'FEE')
    expect(fee).toMatchObject({ kind: 'FEE', operationId: COST.operations[0]!.id, quantity: '28', unitPrice: '7.00' })
    expect(bookHeldDraft(fee, COST)).toBeNull()
    expect(bookHeldDraft({ ...fee, quantity: '29' }, COST)).toEqual({ key: 'cost.book.held.bookable', params: { line: 10, count: 28 } })
    expect(bookHeldDraft({ ...fee, quantity: '1.5' }, COST)?.key).toBe('cost.book.held.pieces')
    expect(bookBody({ ...fee, quantity: '3', unitPrice: '6,50' }, 4)).toEqual({ version: 4, kind: 'FEE', subcontractOperationId: fee.operationId, quantity: '3', unitPrice: '6.50' })
    const other = { ...bookDraftOf(COST, 'OTHER'), unitPrice: '12' }
    expect(bookHeldDraft(other, COST)?.key).toBe('cost.book.held.what')
    expect(bookBody({ ...bookDraftOf(COST), unitPrice: '35', receiptId: 'r2' }, 4)).toEqual({ version: 4, kind: 'TRANSPORT', receiptId: 'r2', quantity: '1', unitPrice: '35' })
    expect(bookPreview({ ...fee, quantity: '3', unitPrice: '6.505' }, COST)).toEqual({ quantity: '3', price: '6.505', amount: 1952, workOrder: COST.order.workOrder.number, feeLine: 10 })
    expect(amountOf('2.5', '0.333333')).toBe(83)
  })

  it('words the entries and the refusals', () => {
    expect(entryWords(COST.entries[0]!, COST.entries)).toEqual({ key: 'cost.entry.fee', params: { line: 10, count: 2 } })
    expect(entryWords(COST.entries[1]!, COST.entries)).toEqual({ key: 'cost.entry.one', params: { kind: '@cost.kind.TRANSPORT' } })
    expect(entryWords(COST.entries[3]!, COST.entries)).toEqual({ key: 'cost.entry.reversal', params: { kind: '@cost.kind.TRANSPORT' } })
    expect(costRefusal(invalid('body/quantity', 'Line 10 has 2 piece(s) back good whose fee is not booked yet')).key).toBe('cost.refused.bookable')
    expect(costRefusal(invalid('params/entryId')).key).toBe('cost.refused.entry')
    expect(costRefusal(invalid('body/unitPrice')).key).toBe('cost.book.held.price')
  })
})

describe('days out and the open balances (SCM-150)', () => {
  it('joins the days out to the stock lines by place, material, colour, lot and hide', () => {
    const days = daysOutBy(AGEING)
    expect(STOCK.rows.map((row) => days.get(stockKey(row))?.daysOut ?? null)).toEqual([8, 8, 76])
    expect(STOCK.rows.map(stockKey)).toEqual(AGEING.rows.map(ageingKey))
    expect(workshopAgeing(AGEING, AGEING.workshops[1]!.location.id)).toEqual({ oldest: 76, longOut: 1 })
    expect(daysOutBy(null).size).toBe(0)
  })

  it('words the open rest per unit, searches what was read, keys the grid by order', () => {
    expect(openText(BALANCES.items[0]!.open, (uom) => uom.toLowerCase(), plain)).toBe('0.5 m · 2 pcs')
    expect(balanceRowsOf(BALANCES.items, 'ricami').map((row) => row.order.number)).toEqual(['SC-2026-0004'])
    expect(openByOrder(BALANCES).get(BALANCES.items[1]!.order.id)?.balanceOpen).toBe(true)
    expect(typedQuantity('1,25')).toBe('1.25')
    expect(typedQuantity('-1', true)).toBe('-1')
    expect(typedQuantity('-1')).toBeNull()
    expect(typedPrice('6.5000001')).toBeNull()
  })
})

describe('the calls (B-W2b-331)', () => {
  function recorder(answers: Record<string, unknown>) {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: headers.get('idempotency-key') })
      const path = new URL(url, 'http://x').pathname
      const answer = Object.entries(answers).find(([suffix]) => path.endsWith(suffix))?.[1] ?? {}
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, calls }
  }

  it('reads the terms, the balance, the cost, the days out and the open balances', async () => {
    const { api, calls } = recorder({ '/terms': termsOf('covered'), '/balance': BALANCE_PARTLY, '/cost': COST, '/ageing': AGEING, '/balances': BALANCES })
    expect((await orderTerms(api, 'o1')).covering?.revision).toBe(2)
    expect((await orderBalance(api, 'o1')).lines).toHaveLength(2)
    expect((await orderCost(api, 'o1')).bridge.orderCost).toBe(27520)
    expect((await subcontractorAgeing(api, { partyId: 'p1' })).rows).toHaveLength(3)
    expect((await openBalances(api, { open: true })).counts.balanceOpen).toBe(2)
    expect(calls.map((call) => call.url)).toEqual([
      '/api/purchasing/subcontracting/orders/o1/terms',
      '/api/purchasing/subcontracting/orders/o1/balance',
      '/api/purchasing/subcontracting/orders/o1/cost',
      '/api/purchasing/subcontracting/ageing?partyId=p1',
      '/api/purchasing/subcontracting/balances?open=true',
    ])
  })

  it('books with the order’s version and an Idempotency-Key', async () => {
    const booked = { rowIds: ['r1'], moveIds: ['m1'], ledger: { posted: 1, waiting: [] }, balance: BALANCE_PARTLY }
    const costed = { entryId: 'e1', ledger: { posted: 1, waiting: [] }, view: COST }
    const { api, calls } = recorder({ '/balance/declare': booked, '/balance/adjust': booked, '/costs': costed, '/reverse': costed })
    await declareBalance(api, 'o1', { version: 6, lines: [{ kitLineId: 'k1', used: '1', returned: '0', scrapped: '0' }] }, 'key-1')
    await adjustBalance(api, 'o1', { version: 7, kitLineId: 'k1', used: '-0.1', reason: 'why' }, 'key-2')
    await bookCost(api, 'o1', { version: 8, kind: 'TRANSPORT', quantity: '1', unitPrice: '35' }, 'key-3')
    await reverseCost(api, 'o1', 'e1', { version: 9, reason: 'twice' }, 'key-4')
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://x').pathname, call.key, (call.body as { version: number }).version])).toEqual([
      ['POST', '/api/purchasing/subcontracting/orders/o1/balance/declare', 'key-1', 6],
      ['POST', '/api/purchasing/subcontracting/orders/o1/balance/adjust', 'key-2', 7],
      ['POST', '/api/purchasing/subcontracting/orders/o1/costs', 'key-3', 8],
      ['POST', '/api/purchasing/subcontracting/orders/o1/costs/e1/reverse', 'key-4', 9],
    ])
  })
})

describe('every word in both languages', () => {
  it('has words for every flag, kind, rung, bucket, unit, match and refusal', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [DEPTH])[DEPTH] ?? {})
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const flag of FLAGS) {
        has(`balance.flagName.${flag}`)
        has(`balance.flag.${flag}`)
      }
      for (const kind of KINDS) {
        has(`cost.kind.${kind}`)
        has(`cost.book.kindHint.${kind}`)
      }
      for (const rung of ['sent', 'used', 'returned', 'scrapped', 'open']) has(`balance.rung.${rung}`)
      for (const rung of ['earnedFee', 'feeAtWorkshopPrice', 'transport', 'material', 'other', 'orderCost']) has(`cost.rung.${rung}`)
      for (const unit of UOMS) has(`uom.${unit}`)
      for (const match of ['PENDING', 'MATCHED', 'DIFFERENCES', 'NO_PO', 'WAITING_GOODS', 'OTHER']) has(`cost.invoice.matchStatus.${match}`)
      for (const kind of ['DECLARED', 'ADJUSTMENT']) has(`balance.kind.${kind}`)
      for (const gap of ['none', 'otherDays']) has(`terms.none.${gap}`)
      expect(BUCKETS).toHaveLength(4)
      expect(say(t, flagWords('SHORT_AT_WORKSHOP', BALANCE_PARTLY.lines[0]!))).not.toMatch(/\{|@uom/)
    }
  })
})
