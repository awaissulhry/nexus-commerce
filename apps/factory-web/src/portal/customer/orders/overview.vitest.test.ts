import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { MONEY_NAME } from '@nexus/factory-domain/money/marked'
import { forbiddenKeysIn } from '@nexus/factory-domain/production-brand/portal-read'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import type { ChangeRequest, OrderRecord } from './api'
import { approvalPage, at, dayAt, documentsRead, orderRecord, orderWords, PREFIX, productionReadOf, progressRead, requestsOf, shipmentsRead, withoutPrices } from './design-data'
import { datesOf, factsOf, overviewOf, pairsOf, payOf, progressOf, requestsOf as requestsModelOf, whereOf, type OverviewInput } from './overview/model'
import { designScreen } from './record/fixtures'
import type { CustomerCaseModel } from './view/CustomerCase'
import type { OrderRecordViewModel } from './view/OrderRecordView'
import { OverviewTab } from './view/OverviewTab'

/**
 * pp-w2 (w2.1–w2.4; lane pp-, the customer's order page on shared parts, round 1; 10-design § 5) — the Overview's rules and wall
 * PW-O01. The cards come in the office's reading order on the SHARED kit (lib/record-overview); each fact once (L6: the promise and
 * its moves only in Where, the requested date only in Next dates, one Pay door); a card without its right or level is left out;
 * Designer and Finance read no production (L7) and keep "Progress by line" from their old read in the same grid; ONE Withdraw for
 * every kind (O1-B6); a part payment shows (O1-B5); the delivery address only as its lines (O3-W4). PW-O01: every Overview view model
 * of every design case, in both languages, holds no office-only key (`forbiddenKeysIn`), no key of money without the price grain, no
 * office series in its markup, and Brand Beta's holds nothing of Brand Alpha. Made-up data only.
 */

const NOW = Date.parse(at(0))
const PREFIX_BETA = `/p/${BRAND_BETA.code}`

function modelOf(record: OrderRecord, over: Partial<OrderRecordViewModel> = {}): OrderRecordViewModel {
  return {
    state: 'ready',
    record,
    tab: 'overview',
    prefix: PREFIX,
    offlineSince: null,
    notice: null,
    revision: { state: 'ready', page: null },
    reconfirmHeld: null,
    progress: { state: 'ready', read: progressRead() },
    requests: { state: 'ready', items: requestsOf() },
    withdrawHeld: null,
    changeHeld: null,
    pay: {},
    shipments: { state: 'ready', read: shipmentsRead() },
    documents: { state: 'ready', read: documentsRead() },
    fileHeld: null,
    openLine: null,
    copied: null,
    dialog: null,
    production: { state: 'ready', read: productionReadOf() },
    waitingHref: `${PREFIX}/waiting`,
    ...over,
  }
}
const inputOf = (record: OrderRecord, over: Partial<OrderRecordViewModel> = {}, locale: Locale = 'en'): OverviewInput => ({ ...modelOf(record, over), record, words: orderWords(locale) })
const IN_PRODUCTION = () => orderRecord({ status: 'IN_PRODUCTION', words: { en: 'In production', it: 'In produzione' } })
const draw = (record: OrderRecord, over: Partial<OrderRecordViewModel> = {}, locale: Locale = 'en') => render(createElement(OverviewTab, { model: modelOf(record, over), record, actions: {} }), locale)

describe('w2.1 Where your order is: the headline, the strips (ONE door each, most blocking first), the steps, the promise once', () => {
  it('the headline says the status and the stage in production; cancelled says when; waiting for our yes says so', () => {
    expect(whereOf(inputOf(IN_PRODUCTION())).headline).toBe('In production · Sewing')
    expect(whereOf(inputOf(IN_PRODUCTION(), { production: { state: 'hidden', read: null } })).headline).toBe('In production')
    const cancelled = whereOf(inputOf(orderRecord({ status: 'CANCELLED', words: { en: 'Cancelled', it: 'Annullato' }, cancelledOn: dayAt(-3) })))
    expect(cancelled.headline).toContain('Cancelled on ')
    expect(cancelled.promise).toBeNull()
    expect(cancelled.moves).toBeNull()
    expect(whereOf(inputOf(orderRecord({ status: 'REQUESTED' }), { production: { state: 'hidden', read: null } })).quiet).toBe('We received your order: it waits for our approval.')
    expect(whereOf(inputOf(orderRecord({ status: 'CONFIRMED' }), { production: { state: 'hidden', read: null } })).quiet).toBe('Your order is confirmed.')
  })

  it('the strips: re-confirm (it says the turn, never a second "we wait for you"), waiting, deposit, hold, problem — each ONE door', () => {
    const problem = { chip: { tone: 'warning' as const, text: 'Problem reported · Waiting on us since 24/11/2026' }, report: null }
    const strips = whereOf(inputOf(IN_PRODUCTION(), { problem, production: { state: 'ready', read: productionReadOf({ holds: [{ kind: 'PRODUCTION', since: dayAt(-2), words: { en: 'Material on its way', it: 'Materiale in arrivo' } }] }) } })).strips
    expect(strips.map((strip) => strip.id)).toEqual(['waiting', 'hold', 'problem'])
    expect(strips.map((strip) => strip.door?.kind ?? null)).toEqual(['waiting', 'ask', null])
    const revised = whereOf(inputOf(orderRecord({ status: 'IN_PRODUCTION', reconfirmNeeded: true }), { problem, revision: { state: 'ready', page: approvalPage() } })).strips
    expect(revised.map((strip) => strip.id)).toEqual(['reconfirm', 'problem'])
    expect(revised[0]!.door).toEqual({ kind: 'reconfirm', held: null })
    // A deposit to pay: the page's ONE Pay door (a price holder's), held with its words.
    const mtm = orderRecord({ status: 'CONFIRMED', depositRequired: true }, { deposits: [{ id: 'd1', kind: 'ACCONTO', status: 'OPEN', amount: 50000, currency: 'EUR', dueDate: dayAt(5), paidAt: null, paidAmount: 0 }] })
    const deposit = whereOf(inputOf(mtm, { production: { state: 'hidden', read: null }, pay: { d1: { held: 'Paying is not part of your access.' } } })).strips
    expect(deposit.map((strip) => [strip.id, strip.door])).toEqual([['deposit', { kind: 'pay', depositId: 'd1', held: 'Paying is not part of your access.' }]])
    expect(deposit[0]!.title).toContain('Deposit to pay by ')
    expect(whereOf(inputOf(withoutPrices(mtm), { production: { state: 'hidden', read: null }, pay: { d1: { held: null } } })).strips).toEqual([])
  })

  it('L7: without the production read (Designer, Finance) no stage, no strips, no "Live"; its failure says so in its row', () => {
    const hidden = whereOf(inputOf(IN_PRODUCTION(), { production: { state: 'hidden', read: null } }))
    expect([hidden.strips, hidden.fresh, hidden.stageNote, hidden.failed]).toEqual([[], null, null, null])
    expect(whereOf(inputOf(IN_PRODUCTION(), { production: { state: 'error', read: null } })).failed).toBe('Could not load the production of this order')
    expect(whereOf(inputOf(IN_PRODUCTION(), { production: { state: 'loading', read: null } })).reading).toBe(true)
  })

  it('the promise once (L6): in Where with its first day and "Date moved"; never in Next dates or Order facts', () => {
    const input = inputOf(IN_PRODUCTION())
    const where = whereOf(input)
    expect(where.promise?.date).toBe(orderWords('en').day(input.record.order.promiseDate!))
    const day = where.promise!.date
    expect(JSON.stringify(datesOf(input))).not.toContain(day)
    expect(JSON.stringify(factsOf(input))).not.toContain(day)
    expect(JSON.stringify(datesOf(input))).toContain('Requested date')
    expect(JSON.stringify(factsOf(input))).not.toContain('Requested date')
  })
})

describe('w2.1 the other cards: progress (L7), dates, requests (ONE Withdraw), what you pay (O1-B5), facts (O3-W4)', () => {
  it('Progress by line: the production read’s; Finance / Designer: the old read in the same grid; below + Progress or cancelled: left out', () => {
    expect(progressOf(inputOf(IN_PRODUCTION()))).toMatchObject({ from: 'production', state: 'ready' })
    const finance = progressOf(inputOf(IN_PRODUCTION(), { production: { state: 'hidden', read: null } }))
    expect(finance).toMatchObject({ from: 'progress', state: 'ready' })
    expect(finance!.colourways.map((line) => line.label)).toEqual(progressOf(inputOf(IN_PRODUCTION()))!.colourways.map((line) => line.label))
    expect(progressOf(inputOf(orderRecord({ status: 'IN_PRODUCTION' }, { productionLevel: 'STATUS' }), { production: { state: 'hidden', read: null } }))).toBeNull()
    expect(progressOf(inputOf(orderRecord({ status: 'CANCELLED' })))).toBeNull()
  })

  it('Next dates: the requested date, our published plan, gates and approvals with ONE door on what waits for you; cancelled: left out', () => {
    const dates = datesOf(inputOf(IN_PRODUCTION()))!
    expect(dates.rows.map((row) => row.id)).toEqual(['requested', 'planned', 'gate-PP_SAMPLE-0', 'gate-SIZE_SET-1', 'approval-LEATHER-0'])
    expect(dates.rows.filter((row) => row.door).map((row) => row.id)).toEqual(['gate-PP_SAMPLE-0', 'approval-LEATHER-0'])
    expect(datesOf(inputOf(IN_PRODUCTION(), { production: { state: 'hidden', read: null } }))!.rows.map((row) => row.id)).toEqual(['requested'])
    expect(datesOf(inputOf(orderRecord({ status: 'CANCELLED' })))).toBeNull()
  })

  it('Requests & changes: by who waits; ONE Withdraw for EVERY kind while it waits on us (O1-B6), held with the words', () => {
    const rush: ChangeRequest = { ...requestsOf()[0]!, id: 'r-rush', kind: 'RUSH', status: 'OPEN' }
    const hold: ChangeRequest = { ...requestsOf()[0]!, id: 'r-hold', kind: 'HOLD', status: 'OPEN' }
    const countered: ChangeRequest = { ...requestsOf()[0]!, id: 'r-counter', status: 'COUNTERED' }
    const model = requestsModelOf(inputOf(IN_PRODUCTION(), { requests: { state: 'ready', items: [rush, hold, countered, requestsOf()[1]!] }, withdrawHeld: 'Asking is not part of your access.' }), NOW)!
    expect(model.groups.map((group) => [group.id, group.rows.length])).toEqual([['you', 1], ['us', 2], ['answered', 1]])
    expect(model.groups[1]!.rows.every((row) => row.withdraw?.held === 'Asking is not part of your access.')).toBe(true)
    expect(model.groups[0]!.rows[0]!.door?.href).toBe(`${PREFIX}/waiting`)
    expect(model.groups[2]!.rows[0]!.withdraw).toBeNull()
    expect(requestsModelOf(inputOf(IN_PRODUCTION(), { requests: { state: 'ready', items: [] } }), NOW)!.groups).toEqual([])
    expect(requestsModelOf(inputOf(IN_PRODUCTION(), { requests: { state: 'noAccess', items: [] } }), NOW)).toBeNull()
    expect(textOf(draw(IN_PRODUCTION(), { requests: { state: 'ready', items: [rush] } }))).toContain('Withdraw')
  })

  it('What you pay: price holders only; the order total, a deposit’s part payment (O1-B5), paid, still to pay; cancelled: still to pay 0', () => {
    const record = orderRecord({ status: 'IN_PRODUCTION', grossAmount: 184464, stillToPay: 104464 }, { deposits: [{ id: 'd1', kind: 'ACCONTO', status: 'OPEN', amount: 184464, currency: 'EUR', dueDate: dayAt(5), paidAt: null, paidAmount: 80000 }] })
    const pay = payOf(inputOf(record))!
    expect(pay.rows.map((row) => row.id)).toEqual(['total', 'deposit-d1', 'paid', 'still'])
    expect(pay.rows[1]!.hint).toBe(`${orderWords('en').money(80000, 'EUR')} of ${orderWords('en').money(184464, 'EUR')} paid`)
    expect(pay.rows[3]!.value).toBe(orderWords('en').money(104464, 'EUR'))
    expect(payOf(inputOf(withoutPrices(record)))).toBeNull()
    const cancelled = payOf(inputOf({ ...record, order: { ...record.order, status: 'CANCELLED' } }))!
    expect(cancelled.rows.map((row) => row.id)).toEqual(['deposit-d1', 'still'])
    expect(cancelled.rows.at(-1)!.value).toBe(orderWords('en').money(0, 'EUR'))
    // ONE Pay door: the card says the facts only.
    expect(JSON.stringify(pay)).not.toContain('door')
  })

  // pp-fx4 (walk W-10): "Your order 7" (shipped) said €488 total and €288 still to pay with no Paid row: €200 unexplained.
  it('W-10: Paid is what the read says was paid (the total less still to pay), with or without deposits; a missing figure is said', () => {
    const words = orderWords('en')
    const shipped = payOf(inputOf(orderRecord({ status: 'SHIPPED', grossAmount: 48800, stillToPay: 28800 }, { deposits: [] })))!
    expect(shipped.rows.map((row) => row.id)).toEqual(['total', 'paid', 'still'])
    expect(shipped.rows.map((row) => row.value)).toEqual([words.money(48800, 'EUR'), words.money(20000, 'EUR'), words.money(28800, 'EUR')])
    const unread = payOf(inputOf(orderRecord({ status: 'IN_PRODUCTION', grossAmount: 48800, stillToPay: null }, { deposits: [] })))!
    expect(unread.rows.map((row) => [row.id, row.value, row.hint ?? null])).toEqual([
      ['total', words.money(48800, 'EUR'), null],
      ['paid', '—', 'Not known yet'],
      ['still', '—', 'Not known yet'],
    ])
  })

  // pp-fx4 (walk W-16): one fact, one word — the Overview's total and what is left to pay are Lines › Totals' own words.
  it('W-16: What you pay says the total and what is left to pay with the words of Lines › Totals', () => {
    for (const locale of ['en', 'it'] as const) {
      const pay = payOf(inputOf(orderRecord({ status: 'IN_PRODUCTION', grossAmount: 48800, stillToPay: 28800 }), {}, locale))!
      const catalogue = CATALOGUE[locale]['portal-orders']!
      expect(pay.rows.find((row) => row.id === 'total')!.label, locale).toBe(catalogue['totals.gross'])
      expect(pay.rows.find((row) => row.id === 'still')!.label, locale).toBe(catalogue['totals.toPay'])
      expect(catalogue['overview.total'], locale).toBeUndefined()
      expect(catalogue['overview.still'], locale).toBeUndefined()
    }
  })

  // pp-fx4 (walk W-08): a card whose partner was left out took a whole row ("What you pay" ≈430 px of content in 749–1620 px), and Order
  // facts stood alone below it. The pairs are built from the cards that are present, in the picture's order.
  it('W-08: the pairs come from the cards that are present, in the picture’s order — a left-out card’s partner pairs with the next', () => {
    expect(pairsOf(['dates', 'requests', null, 'pay', 'facts'])).toEqual([['dates', 'requests'], ['pay', 'facts']])
    expect(pairsOf([null, 'requests', 'quality', 'pay', 'facts'])).toEqual([['requests', 'quality'], ['pay', 'facts']])
    expect(pairsOf(['dates', 'requests', null, null, 'facts'])).toEqual([['dates', 'requests'], ['facts']])
    // Seed-like order: Next dates, Requests & changes, What you pay, Order facts (no Quality) — two full pairs, no lone card.
    const html = draw(IN_PRODUCTION(), { requests: { state: 'ready', items: [] } })
    expect(html.match(/class="fw-so-ov-pair"/g)?.length).toBe(2)
    const view = readFileSync(new URL('./view/OverviewTab.tsx', import.meta.url), 'utf8')
    expect(view).toContain('{pairsOf([dates, requests, quality, pay, <FactsCard key="facts" model={cards.facts} />]).map((pair, index) => (')
  })

  // pp-fx4 (walk W-12): "Next dates" held only "Requested date —" (orders 5 and 7): a card that says nothing is left out.
  it('W-12: Next dates with nothing to say (no requested date, no plan, no gate, no line in words) is left out', () => {
    const bare = orderRecord({ status: 'CONFIRMED', requestedDate: null })
    expect(datesOf(inputOf(bare, { production: { state: 'hidden', read: null } }))).toBeNull()
    expect(overviewOf(inputOf(bare, { production: { state: 'hidden', read: null } })).dates).toBeNull()
    expect(datesOf(inputOf(orderRecord({ status: 'CONFIRMED' }), { production: { state: 'hidden', read: null } }))!.rows.map((row) => row.id)).toEqual(['requested'])
  })

  it('Order facts: PO, ordered on, the delivery address as its lines only (a stray key of the free ship-to never reaches it), terms, currency', () => {
    const record = orderRecord({ shipTo: { name: 'Bea Esempio', line1: 'Via Esempio 12', city: 'Seedville', country: 'IT', internalNote: 'office words only', priority: 'TOP' } })
    const facts = factsOf(inputOf(record))
    expect(facts.facts.map((fact) => fact.id)).toEqual(['po', 'ordered', 'shipTo', 'terms', 'currency'])
    expect(JSON.stringify(facts)).not.toMatch(/office words only|TOP|internalNote|priority/)
    expect(facts.facts.find((fact) => fact.id === 'shipTo')!.lines).toContain('Via Esempio 12')
  })

  it('the tab: the kit’s Overview with its cards in the office’s order; Quality only at its level for a reader who sees production', () => {
    const html = draw(IN_PRODUCTION())
    expect(html).toContain('fw-so-overview')
    const order = ['Where your order is', 'Progress by line', 'Next dates', 'Requests &amp; changes', 'What you pay', 'Order facts'].map((title) => html.indexOf(title))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(overviewOf(inputOf(IN_PRODUCTION(), { quality: { state: 'ready', read: null } })).quality).toBe(true)
    expect(overviewOf(inputOf(IN_PRODUCTION(), { production: { state: 'hidden', read: null }, quality: { state: 'ready', read: null } })).quality).toBe(false)
    // The band holds "Made from" and the health chip (L6, lead 11-25): never the Overview.
    const made = textOf(draw(IN_PRODUCTION(), { madeFrom: { kind: 'request', href: `${PREFIX}/orders/requests/r7`, label: '#7' } }))
    expect(made).not.toContain('Made from your request')
    expect(made).not.toContain('Late')
    expect(readFileSync(new URL('./view/OverviewTab.tsx', import.meta.url), 'utf8')).toContain("from '../../../../lib/record-overview/Overview'")
  })

  it('the new words exist in both languages with the same placeholders; the Italian speaks "voi"', () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    const keys = Object.keys(CATALOGUE.en['portal-orders']!).filter((key) => key.startsWith('overview.') || key.startsWith('strip.'))
    expect(keys.length).toBeGreaterThanOrEqual(15)
    for (const key of keys) {
      expect(CATALOGUE.it['portal-orders']![key], key).toBeTruthy()
      expect(holes(CATALOGUE.it['portal-orders']![key]!), key).toEqual(holes(CATALOGUE.en['portal-orders']![key]!))
      expect(CATALOGUE.it['portal-orders']![key], key).not.toMatch(/\b(tu|tuo|tua|tuoi|tue|ti|hai|puoi|vuoi)\b/i)
    }
  })
})

// ---- PW-O01 (plan § 5, O3-W3 / O3-W4): every Overview view model of every design case, EN + IT ---------------------------------
const OFFICE_SERIES = /\b[A-Z]+-\d{4}-\d+/

describe('PW-O01 — every Overview view model of every design case: no office key, no money without the price grain, no office series', () => {
  const cases = designScreen.cases.map((entry) => ({ id: entry.id, build: entry.model }))

  it('walks them all, in both languages', () => {
    let walked = 0
    for (const locale of ['en', 'it'] as const) {
      for (const entry of cases) {
        const built: CustomerCaseModel = entry.build(locale)
        if (built.body.kind !== 'record' || built.body.model.state !== 'ready' || !built.body.model.record) continue
        const model = built.body.model
        const record = model.record!
        const models = overviewOf({ ...model, record, words: orderWords(locale) }, NOW)
        expect(forbiddenKeysIn(models), `${entry.id} ${locale}`).toEqual([])
        if (!record.seesPrices) {
          const keys: string[] = []
          JSON.parse(JSON.stringify(models), (name, value) => (name ? keys.push(name) : undefined, value))
          expect(keys.filter((name) => MONEY_NAME.test(name)), `${entry.id} ${locale}`).toEqual([])
          expect(models.pay, `${entry.id} ${locale}`).toBeNull()
        }
        const html = render(createElement(OverviewTab, { model, record, actions: {} }), locale)
        expect(html.match(OFFICE_SERIES)?.[0] ?? null, `${entry.id} ${locale}`).toBeNull()
        walked += 1
      }
    }
    // The picture's eight cases and the roles are among them.
    expect(walked).toBeGreaterThan(40)
    for (const id of ['ov-prod', 'ov-prod-viewer', 'ov-prod-finance', 'ov-prod-designer', 'ov-reconfirm', 'ov-hold', 'ov-shipped', 'ov-delivered', 'ov-cancelled', 'ov-noprice', 'ov-early']) expect(cases.map((entry) => entry.id), id).toContain(id)
  })

  it('Brand Beta’s Overview holds nothing of Brand Alpha (its own order, its own production read), in both languages', () => {
    const beta = orderRecord({ yourNumber: customerNumberOf('ORDER', 4), customerRef: BRAND_BETA.customerRef, status: 'IN_PRODUCTION', shipTo: { name: `${BRAND_BETA.legalName} — Lager`, line1: BRAND_BETA.address.line1, postalCode: BRAND_BETA.address.postalCode, city: BRAND_BETA.address.city, country: BRAND_BETA.address.country } })
    const read = productionReadOf({ order: { ...productionReadOf().order, customerRef: BRAND_BETA.customerRef, number: BRAND_BETA.numbers.order, yourNumber: customerNumberOf('ORDER', 4) } })
    // pp-fx1: Brand Beta's page has Brand Beta's own address (the live page: waitingHrefOf(frame.prefix), OrderPage) — the case once
    // borrowed the Alpha design prefix and drew `/p/BRAND-ALPHA/waiting`: a fixture's leak, caught here.
    const own = { prefix: PREFIX_BETA, waitingHref: `${PREFIX_BETA}/waiting` }
    for (const locale of ['en', 'it'] as const) {
      const html = draw(beta, { ...own, production: { state: 'ready', read }, requests: { state: 'ready', items: requestsOf().map((item) => ({ ...item, customerRef: BRAND_BETA.customerRef })) } }, locale)
      expect(html, locale).toContain(`href="${PREFIX_BETA}/waiting"`)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html).not.toContain(BRAND_BETA.numbers.order)
      expect(html.match(OFFICE_SERIES)?.[0] ?? null, locale).toBeNull()
      const models = overviewOf(inputOf(beta, { ...own, production: { state: 'ready', read } }, locale), NOW)
      expect(forbiddenKeysIn(models), locale).toEqual([])
      expect(scanText(JSON.stringify(models), BRAND_ALPHA), locale).toEqual([])
    }
  })
})
