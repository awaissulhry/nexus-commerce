import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_NAV, OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { approveQuote, decisionProblem, fetchFlow, fetchPanel, fetchQuoteReview, fetchToday, readProblem, rejectQuote } from './api'
import { designScreen } from './fixtures'
import { designScreen as printScreen } from './print/fixtures'
import { panelRow, queueItem } from './links'
import {
  decideKey,
  dueWords,
  freshCount,
  groupItems,
  newVerbsFor,
  nextAfter,
  queueKey,
  rejectReasonProblem,
  tileCount,
  type TodayItem,
} from './model'
import { PANELS, panelPage, panelsFor, PanelShapeError } from './panels'
import { phraseText, sentenceText } from './words'
import { todayKeys } from './view/TodayView'
import { CODE_WORDS, EN_TEMPLATES, invoiceToIssueWords, mailToSortWords, orderPromiseWords, phrase, registerDutyWords, workOrderHeldWords } from '@nexus/factory-domain/insights/words'
import { createTranslator } from '../../../lib/i18n/messages'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(...answers: Array<() => Response>) {
  let index = 0
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => (answers[Math.min(index++, answers.length - 1)] ?? (() => json(500, {})))())
  const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
  const sent = (call = 0) => {
    const [url, init] = fetch.mock.calls[call]!
    return { url, method: init.method, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined }
  }
  return { api, fetch, sent }
}

const item = (key: string, extra: Partial<TodayItem> = {}): TodayItem => ({
  key,
  kind: 'ORDER_PROMISE',
  state: 'LATE',
  category: 'ALERT',
  severity: 'HIGH',
  severityWord: 'Urgent',
  group: 'NOW',
  record: { type: 'SalesOrder', id: `id-${key}`, label: `SO-${key}` },
  companyId: 'c1',
  siteId: null,
  partyId: 'p1',
  sentence: 'Order is late.',
  why: 'You manage it.',
  blocks: null,
  words: { sentence: { key: 'ORDER_PROMISE.LATE', params: { number: 'SO-1', customer: 'Shop', count: 2, promiseDate: '2026-10-27' } }, why: { key: 'why.ORDER_PROMISE.orders_manage', params: {} }, blocks: null },
  sentenceFigure: null,
  due: null,
  since: '2026-10-27T09:00:00.000Z',
  ageDays: 2,
  decide: 'OPEN',
  figures: null,
  condition: 'c'.repeat(32),
  actions: { version: 0, verbs: ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'], assigned: null, acknowledged: null },
  ...extra,
})

const TODAY_ANSWER = {
  asOf: '2026-10-29T09:00:00.000Z',
  today: '2026-10-29',
  counts: {
    total: 1,
    now: 1,
    tiles: [
      { tile: 'ALL', count: 1, complete: true },
      { tile: 'APPROVAL', count: 0, complete: true },
      { tile: 'ALERT', count: 1, complete: true },
    ],
    byKind: [{ kind: 'ORDER_PROMISE', label: 'Orders', count: 1, complete: true }],
  },
  total: 1,
  items: [item('a')],
  nextCursor: 'cursor-2',
  handled: { today: 0 },
  live: { events: ['sales_order.promise_changed'] },
}

describe('Today calls the API through its one client (SCR-029)', () => {
  it('reads the list with the pressed tile, the cursor and the limit, and the flow strip', async () => {
    const today = client(() => json(200, TODAY_ANSWER))
    const answer = await fetchToday(today.api, { kind: 'ORDER_PROMISE', cursor: 'abc' })
    expect(today.sent().url).toBe('/api/home/today?kind=ORDER_PROMISE&cursor=abc&limit=50')
    await fetchToday(today.api, { category: 'APPROVAL' })
    expect(today.sent(1).url).toBe('/api/home/today?category=APPROVAL&limit=50')
    expect(today.sent().headers.get('x-factory-company')).toBe('DEMO')
    expect(answer.items[0]!.key).toBe('a')
    const flow = client(() => json(200, { asOf: TODAY_ANSWER.asOf, today: TODAY_ANSWER.today, lenses: [{ lens: 'ORDERS', label: 'Sales orders', list: '/sales/orders', stages: [], complete: true, live: { events: [] } }] }))
    expect((await fetchFlow(flow.api)).lenses[0]!.lens).toBe('ORDERS')
    expect(flow.sent().url).toBe('/api/home/flow')
  })

  it('a quote approval: the quote as its review shows it; approve and reject with its version, the CSRF token and an idempotency key', async () => {
    const quote = {
      quote: {
        id: 'q1',
        number: 'Q-1',
        status: 'PENDING_APPROVAL',
        version: 7,
        party: { legalName: 'Demo Club' },
        current: { revision: 2, currency: 'EUR', validUntil: '2026-11-28', netAmount: 1000, marginPct: '18.2' },
        approval: {
          marginFloorPct: '25',
          rules: [
            { reason: 'MARGIN_FLOOR', broken: true, message: 'Under the floor.' },
            { reason: 'DISCOUNT_LIMIT', broken: false, message: 'Within the limit.' },
          ],
          requests: [
            { status: 'REJECTED', reasons: ['MARGIN_FLOOR'], requestNote: null, createdAt: '2026-10-20T09:00:00.000Z' },
            { status: 'PENDING', reasons: ['MARGIN_FLOOR'], requestNote: 'Launch', createdAt: '2026-10-28T16:00:00.000Z' },
          ],
        },
      },
    }
    const read = client(() => json(200, quote))
    const review = await fetchQuoteReview(read.api, 'q1')
    expect(review).toMatchObject({ quoteId: 'q1', version: 7, customer: 'Demo Club', netAmount: 1000, marginPct: '18.2', marginFloorPct: '25', decidable: true, request: { note: 'Launch' } })
    expect(review.rules).toEqual([{ reason: 'MARGIN_FLOOR', message: 'Under the floor.' }])
    // Without the grains the API drops the money: the review shows none (never a 0).
    const noMoney = client(() => json(200, { quote: { ...quote.quote, current: { revision: 2, currency: 'EUR', validUntil: null }, approval: { ...quote.quote.approval, marginFloorPct: undefined } } }))
    expect(await fetchQuoteReview(noMoney.api, 'q1')).toMatchObject({ netAmount: null, marginPct: null, marginFloorPct: null })

    const write = client(() => json(200, {}))
    await approveQuote(write.api, review, null)
    expect(write.sent()).toMatchObject({ url: '/api/sales/quotes/q1/approval/approve', method: 'POST', body: { version: 7, note: null } })
    expect(write.sent().headers.get('x-csrf-token')).toBe('csrf-1')
    expect(write.sent().headers.get('idempotency-key')).toBeTruthy()
    await rejectQuote(write.api, review, '  Margin too low  ')
    expect(write.sent(1)).toMatchObject({ url: '/api/sales/quotes/q1/approval/reject', body: { version: 7, reason: 'Margin too low' } })
  })

  it('problems are this app’s words: a moved quote is read again, a refusal says why', () => {
    expect(decisionProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'today.decide.problem.changed', tone: 'warning', reload: true })
    expect(decisionProblem(new ApiError('forbidden', 403, 'forbidden', 'x')).key).toBe('today.decide.problem.forbidden')
    expect(decisionProblem(new ApiError('step_up', 403, 'forbidden', 'x')).key).toBe('today.decide.problem.stepUp')
    expect(readProblem(new ApiError('unavailable', 503, 'unavailable', 'x'))).toBe('today.problem.offline')
    expect(readProblem(new PanelShapeError('x'))).toBe('today.problem.shape')
    expect(readProblem(new Error('x'))).toBe('today.problem.read')
  })
})

describe('the rules of the screen', () => {
  it('groups keep the API’s rank, empty groups are left out', () => {
    const rows = [item('1', { group: 'TODAY' }), item('2', { group: 'NOW' }), item('3', { group: 'LATER' }), item('4', { group: 'NOW' })]
    expect(groupItems(rows).map((entry) => [entry.group, entry.items.map((row) => row.key)])).toEqual([
      ['NOW', ['2', '4']],
      ['TODAY', ['1']],
      ['LATER', ['3']],
    ])
  })

  it('due words, tile counts, fresh rows, the next row after a decision', () => {
    expect(dueWords({ date: '2026-10-27', days: -2, word: 'OVERDUE' })).toEqual({ key: 'today.due.overdue', count: 2, date: '2026-10-27' })
    expect(dueWords({ date: '2026-10-29', days: 0, word: 'TODAY' })?.key).toBe('today.due.today')
    expect(dueWords({ date: '2026-11-01', days: 3, word: 'SOON' })?.key).toBe('today.due.soon')
    expect(dueWords({ date: '2026-11-20', days: 22, word: null })?.key).toBe('today.due.on')
    expect(dueWords(null)).toBeNull()
    expect(tileCount({ count: 200, complete: false })).toEqual({ key: 'today.tiles.atLeast', count: 200 })
    expect(tileCount({ count: 3, complete: true })).toEqual({ key: 'today.tiles.count', count: 3 })
    expect(freshCount([{ key: 'a' }, { key: 'b' }], [{ key: 'c' }, { key: 'a' }, { key: 'd' }])).toBe(2)
    expect(nextAfter(['a', 'b', 'c'], 'b')).toBe('c')
    expect(nextAfter(['a', 'b', 'c'], 'c')).toBe('b')
    expect(nextAfter(['a'], 'a')).toBeNull()
  })

  it('keys: j / k / Enter in the list, a / r in the decide modal — never with a modifier or in a text field', () => {
    const none = { alt: false, ctrl: false, meta: false }
    expect([queueKey('j', none), queueKey('k', none), queueKey('Enter', none), queueKey('ArrowDown', none), queueKey('x', none)]).toEqual(['next', 'previous', 'open', 'next', null])
    expect(queueKey('j', { ...none, meta: true })).toBeNull()
    expect(decideKey('a', { ...none, inField: false })).toBe('approve')
    expect(decideKey('r', { ...none, inField: false })).toBe('reject')
    expect(decideKey('a', { ...none, inField: true })).toBeNull()
    expect(decideKey('r', { ...none, ctrl: true, inField: false })).toBeNull()
  })

  it('a reject needs a reason', () => {
    expect(rejectReasonProblem('')).toBe('today.decide.reject.reasonNeeded')
    expect(rejectReasonProblem(' no ')).toBe('today.decide.reject.reasonShort')
    expect(rejectReasonProblem('x'.repeat(1001))).toBe('today.decide.reject.reasonLong')
    expect(rejectReasonProblem('Margin too low for a first order')).toBeNull()
  })

  it('New ▾ offers the verbs the person may do; a verb whose page is not built is held', () => {
    const verbs = newVerbsFor(new Set(['quotes.manage', 'purchasing.manage', 'orders.view']), new Set(['/sales/quotes']), '/w/DEMO')
    expect(verbs).toEqual([
      { id: 'quote', labelKey: 'today.new.quote', href: '/w/DEMO/sales/quotes?new=1' },
      { id: 'purchaseOrder', labelKey: 'today.new.purchaseOrder', href: null },
    ])
    expect(newVerbsFor(new Set(['home.view']), OFFICE_PAGES, '/w/DEMO')).toEqual([])
  })
})

describe('where a row opens (one detail rule; lib/records/record-links.ts)', () => {
  it('its own page when built, else its panels with what they show; real addresses for ⌘-click', () => {
    expect(recordAddress({ type: 'SalesOrder', id: 'o1', label: 'SO-1', companyId: 'c1' }, OFFICE_PAGES)).toBe('/sales/orders/o1')
    expect(recordAddress({ type: 'Shipment', id: 's1', label: 'SH-1', companyId: 'c1' }, OFFICE_PAGES)).toBe('/records/Shipment/s1?label=SH-1&company=c1')
    expect(recordAddress({ type: 'InboundEmail', id: 'm1' }, OFFICE_PAGES)).toBe('/home/mail-to-sort?open=m1')
    expect(recordAddress({ type: 'InboundEmail', id: 'm1' }, new Set())).toBe('/records/InboundEmail/m1')
    expect(OFFICE_PAGES.has('/records/[type]/[id]')).toBe(true)
    expect(listAddress('/email/inbound', {}, OFFICE_PAGES)).toBe('/home/mail-to-sort')
    expect(listAddress('/sales/orders', { late: 'true' }, OFFICE_PAGES)).toBe('/sales/orders?late=true')
    expect(listAddress('/purchasing/orders', { status: 'SENT' }, OFFICE_PAGES)).toBe('/purchasing/orders?status=SENT')
    expect(listAddress(null, null, OFFICE_PAGES)).toBeNull()
    expect(recordAddress({ type: 'Quote', id: 'q1', label: 'Q-1', companyId: 'c1' }, OFFICE_PAGES)).toBe('/sales/quotes/q1')
    expect(listAddress('/sales/quotes', { status: 'PENDING_APPROVAL' }, OFFICE_PAGES)).toBe('/sales/quotes?status=PENDING_APPROVAL')
    expect(listAddress('/sales/quote-approvals', { view: 'waiting' }, OFFICE_PAGES)).toBe('/home/approvals?view=waiting')
    expect(newVerbsFor(new Set(['quotes.manage']), OFFICE_PAGES, '/w/DEMO')).toEqual([{ id: 'quote', labelKey: 'today.new.quote', href: '/w/DEMO/sales/quotes?new=1' }])
  })

  it('a mail row opens Mail to sort’s review; a quote approval is decided here; other rows open their record', () => {
    const mail = queueItem(item('m', { kind: 'MAIL_TO_SORT', decide: 'REVIEW', record: { type: 'InboundEmail', id: 'm1', label: 'Hello' } }), '/w/DEMO')
    expect(mail).toMatchObject({ href: '/w/DEMO/home/mail-to-sort?open=m1', reviewHref: '/w/DEMO/home/mail-to-sort?open=m1' })
    const quote = queueItem(item('q', { kind: 'QUOTE_APPROVAL', decide: 'REVIEW', record: { type: 'Quote', id: 'q1', label: 'Q-1' } }), '/w/DEMO')
    expect(quote).toMatchObject({ href: '/w/DEMO/sales/quotes/q1', reviewHref: null })
    const proposal = queueItem(item('p', { kind: 'PO_PROPOSAL', decide: 'REVIEW', siteId: 's1', record: { type: 'PurchaseOrder', id: 'po1', label: 'PO-1' } }), '/w/DEMO')
    // The PO studio is built (SCR-059): a supplier's proposal opens there, and is reviewed there by the buyer.
    expect(proposal).toMatchObject({ href: '/w/DEMO/purchasing/orders/po1', reviewHref: '/w/DEMO/purchasing/orders/po1' })
  })
})

describe('My lists: existing list routes only, five rows, a sixth says there are more', () => {
  const BODIES: Record<string, unknown> = {
    quotesToApprove: { quotes: [{ id: 'q1', number: 'Q-1', companyId: 'c1', partyName: 'Club', validUntil: '2026-11-28' }] },
    lateOrders: { orders: [{ id: 'o1', number: 'SO-1', companyId: 'c1', partyName: 'Shop', promiseDate: '2026-10-27', daysLate: 2, deposit: { state: 'PAID', dueDate: null } }] },
    ordersWaitingDeposit: { orders: [{ id: 'o2', number: 'SO-2', companyId: 'c1', partyName: 'Shop', promiseDate: null, daysLate: null, deposit: { state: 'OPEN', dueDate: '2026-11-02' } }] },
    draftWorkOrders: { workOrders: [{ id: 'w1', number: 'WO-1', companyId: 'c1', siteId: 's1', styleCode: 'JKT', dueDate: '2026-10-30', daysLate: 0 }] },
    lateWorkOrders: { workOrders: [{ id: 'w2', number: 'WO-2', companyId: 'c1', siteId: 's1', styleCode: 'JKT', dueDate: '2026-10-20', daysLate: 9 }] },
    scanCorrections: { requests: [{ id: 'r1', companyId: 'c1', siteId: 's1', serverTime: '2026-10-28T09:00:00.000Z', bundleCode: 'BN-1', workOrder: { number: 'WO-1' }, operation: { name: 'Sewing' } }] },
    posAwaitingSupplier: { orders: [{ id: 'p1', number: 'PO-1', companyId: 'c1', siteId: 's1', supplierName: 'Tannery', sentAt: '2026-10-26T09:00:00.000Z', requestedDate: null }] },
    supplierChanges: { orders: [{ id: 'p2', number: 'PO-2', companyId: 'c1', siteId: 's1', supplierName: 'Tannery', sentAt: null, requestedDate: '2026-11-05' }] },
    sdiRefused: { invoices: [{ id: 'i1', number: 'FT-1', companyId: 'c1', partyName: 'Shop', issueDate: '2026-10-27' }] },
    registerOpen: { entries: [{ id: 'e1', companyId: 'c1', reference: 'REG-1', reportedAt: '2026-10-21T09:00:00.000Z', style: { code: 'JKT' } }] },
    certificatesExpiring: { certificates: [{ id: 'c1', companyId: null, number: 'CE-1', standard: 'EN 17092-3', validTo: '2026-12-31', daysToExpiry: 63 }] },
    mailToSort: { mails: [{ id: 'm1', companyId: 'c1', subject: null, from: { address: 'a@example.com', name: null }, receivedAt: '2026-10-28T09:00:00.000Z', status: 'HELD' }] },
  }

  it('every panel reads its list’s answer into rows that open their record; a wrong shape is an error, never "nothing"', () => {
    for (const panel of PANELS) {
      const rows = panel.rows(BODIES[panel.id])
      expect(rows, panel.id).toHaveLength(1)
      expect(panelRow(rows[0]!, '/w/DEMO').href.startsWith('/w/DEMO/'), panel.id).toBe(true)
      expect(() => panel.rows({ nothing: [] }), panel.id).toThrow(PanelShapeError)
    }
    expect(panelRow(PANELS.find((panel) => panel.id === 'mailToSort')!.rows(BODIES.mailToSort)[0]!, '/w/DEMO').href).toBe('/w/DEMO/home/mail-to-sort?open=m1')
  })

  it('asks six rows of its list with its filter; shows five and says there are more', async () => {
    const late = PANELS.find((panel) => panel.id === 'lateOrders')!
    const orders = Array.from({ length: 6 }, (_, n) => ({ id: `o${n}`, number: `SO-${n}`, companyId: 'c1', partyName: 'Shop', promiseDate: null, daysLate: 1, deposit: { state: 'PAID', dueDate: null } }))
    const api = client(() => json(200, { orders }))
    const page = await fetchPanel(api.api, late)
    expect(api.sent().url).toBe('/api/sales/orders?late=true&limit=6')
    expect(page.rows).toHaveLength(5)
    expect(page.more).toBe(true)
    expect(panelPage([1, 2])).toEqual({ rows: [1, 2], more: false })
  })

  it('a panel shows with its route’s permission and its lens; mail shows with any lens', () => {
    const sales = new Set(['orders.view', 'email.triage', 'quotes.view'])
    expect(panelsFor(sales, 'ORDERS').map((panel) => panel.id)).toEqual(['lateOrders', 'ordersWaitingDeposit', 'mailToSort'])
    expect(panelsFor(sales, 'WORK_ORDERS').map((panel) => panel.id)).toEqual(['mailToSort'])
    expect(panelsFor(new Set(['home.view']), 'ORDERS')).toEqual([])
  })
})

describe('navigation, pages, words and the design fixtures', () => {
  it('Today is Home’s first page for whoever holds home.view, and its pages are built', () => {
    const home = officeNavFor((permission) => permission === 'home.view' || permission === 'email.triage', OFFICE_NAV).areas.find((area) => area.id === 'home')!
    expect(home.sections![0]!.items.map((row) => row.href)).toEqual(['/home/today', '/home/mail-to-sort'])
    expect(['/home/today', '/home/today/print'].every((page) => OFFICE_PAGES.has(page))).toBe(true)
  })

  it('every message key the screen uses is in both languages', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const files = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(folder, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [join(folder, entry.name)] : []))
    const used = new Set<string>()
    for (const file of files(dir)) for (const match of readFileSync(file, 'utf8').matchAll(/'(today\.[a-zA-Z.]+[a-zA-Z])'/g)) used.add(match[1]!)
    // Keys built from codes: every kind, severity, group, lens and stage the API names.
    const KINDS = ['ORDER_PROMISE', 'WORK_ORDER_HELD', 'LOT_HOLD', 'INVOICE_SDI', 'QUOTE_APPROVAL', 'PO_PROPOSAL', 'PO_NOT_CONFIRMED', 'SCAN_CORRECTION', 'SCAN_REFUSAL', 'INVOICE_TO_ISSUE', 'REGISTER_DUTY', 'PRIVACY_DUTY', 'STYLE_COMPLIANCE', 'MAIL_TO_SORT']
    for (const kind of KINDS) used.add(`today.kind.${kind}`)
    for (const severity of ['HIGH', 'MEDIUM', 'LOW']) used.add(`today.severity.${severity}`)
    for (const group of ['NOW', 'TODAY', 'THIS_WEEK', 'LATER']) used.add(`today.group.${group}`)
    for (const panel of PANELS) {
      used.add(`today.panels.${panel.id}.title`)
      used.add(`today.panels.${panel.id}.empty`)
    }
    for (const status of ['TRIAGE', 'HELD', 'FAILED']) used.add(`today.panels.word.mail.${status}`)
    for (const [lens, stages] of Object.entries({
      ORDERS: ['WAITING_FOR_DEPOSIT', 'PLANNED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'],
      WORK_ORDERS: ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED'],
      PURCHASE_ORDERS: ['DRAFT', 'SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED', 'RECEIVED'],
      INVOICES: ['DRAFT', 'TO_SEND', 'AT_SDI', 'DELIVERED', 'PAID'],
      LOTS: ['QUARANTINE', 'BLOCKED', 'RELEASED', 'REJECTED'],
    })) {
      used.add(`today.flow.lens.${lens}`)
      for (const stage of stages) used.add(`today.flow.stage.${lens}.${stage}`)
    }
    for (const locale of ['en', 'it'] as const) {
      const home = CATALOGUE[locale].home!
      const missing = [...used].filter((key) => home[key] === undefined && home[`${key}_other`] === undefined && !Object.keys(home).some((known) => known.startsWith(`${key}.`)))
      expect(missing, locale).toEqual([])
    }
  })

  it('the design fixtures: the role switch and every state, made-up data only', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const wanted of ['owner', 'owner-decide', 'owner-tile', 'owner-alerts', 'sales', 'buyer', 'inspector', 'finance', 'empty', 'loading', 'error', 'no-permission']) expect(ids).toContain(wanted)
    // Always the design's three tiles.
    for (const entry of designScreen.cases) {
      if (entry.model.queue.status === 'ready') expect(entry.model.queue.data.tiles.map((tile) => tile.tile), entry.id).toEqual(['ALL', 'APPROVAL', 'ALERT'])
    }
    const text = JSON.stringify(designScreen.cases)
    expect(text).not.toMatch(/@(?!example\.)[a-z0-9-]+\.(com|it|net)/i)
  })
})

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const screen of [designScreen, printScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(/today\.[a-zA-Z]+\.[a-zA-Z.]+/)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('money only as the API sent it: the inspector case shows no amount, the sales case no purchase value', () => {
    const html = (id: string) => render(designScreen as DesignScreen<unknown>, designScreen.cases.find((entry) => entry.id === id)!.model, 'en')
    expect(html('inspector')).not.toMatch(/EUR|€/)
    expect(html('sales')).not.toContain('Purchase value')
  })
})

describe('the rows in the person’s language: the API’s phrases drawn with today.w.* (it, en)', () => {
  const en = createTranslator('en', CATALOGUE.en.home!)
  const it_ = createTranslator('it', CATALOGUE.it.home!)
  const ref = (value: { key: string; params: Readonly<Record<string, string | number | readonly string[]>> }) => ({ key: value.key, params: value.params })

  it('every phrase the domain can send has its words in both languages; the English is the domain’s own', () => {
    for (const [key, template] of Object.entries(EN_TEMPLATES)) {
      expect(CATALOGUE.en.home![`today.w.${key}`], key).toBe(template)
      expect(CATALOGUE.it.home![`today.w.${key}`], key).toBeTruthy()
    }
    for (const [param, codes] of Object.entries(CODE_WORDS)) {
      for (const [code, words] of Object.entries(codes)) {
        expect(CATALOGUE.en.home![`today.w.code.${param}.${code}`], `${param}.${code}`).toBe(words)
        expect(CATALOGUE.it.home![`today.w.code.${param}.${code}`], `${param}.${code}`).toBeTruthy()
      }
    }
  })

  it('English drawn by the web is the API’s English; Italian is Italian, dates and codes and lists included', () => {
    const late = orderPromiseWords({ number: 'SO-1', customer: 'Officina Demo', state: 'LATE', days: 2, promiseDate: '2026-10-27', toShip: 1 })
    expect(phraseText(ref(late.sentence), en, 'en')).toBe('Order SO-1 for Officina Demo is 2 days late: it was promised for 27/10/2026.')
    expect(phraseText(ref(late.sentence), it_, 'it')).toBe("L'ordine SO-1 per Officina Demo è in ritardo di 2 giorni: era promesso per il 27/10/2026.")
    expect(phraseText(ref(late.blocks!), it_, 'it')).toBe('Officina Demo aspetta 1 pezzo.')
    const held = workOrderHeldWords({ number: 'WO-1', style: 'JKT', checks: ['DEPOSIT', 'MATERIAL'], orders: ['SO-1', 'SO-2', 'SO-3', 'SO-4', 'SO-5', 'SO-6', 'SO-7'] })
    expect(phraseText(ref(held.sentence), en, 'en')).toBe(held.sentence.text)
    expect(phraseText(ref(held.sentence), it_, 'it')).toBe("L'ordine di lavoro WO-1 (JKT) non può essere rilasciato: 2 controlli aperti (acconto, materiale).")
    expect(phraseText(ref(held.blocks!), it_, 'it')).toBe('La produzione di SO-1, SO-2, SO-3, SO-4, SO-5 e altri 2 lo aspetta.')
    const ddts = invoiceToIssueWords({ customer: 'Shop', month: '2026-10', ddts: ['144/2026'], docType: 'TD24', dueBy: '2026-11-15', daysLeft: 17 })
    expect(phraseText(ref(ddts.sentence), it_, 'it')).toBe('Shop: 1 DDT di ottobre 2026 non ancora fatturato (144/2026).')
    expect(phraseText(ref(registerDutyWords({ reference: 'REG-1', kind: 'COMPLAINT', style: 'JKT', duties: ['AUTHORITY'] }).sentence), it_, 'it')).toBe("Registro DPI, reclamo REG-1 (JKT): l'autorità da notificare.")
    expect(phraseText(ref(mailToSortWords({ sender: 'Anna', subject: null, state: 'HELD', heldReason: 'SPAM' }).sentence), it_, 'it')).toBe('La posta da Anna è trattenuta: sembra spam.')
    expect(phraseText(ref(phrase('why.QUOTE_APPROVAL.quotes_approve')), it_, 'it')).toBe("Approvi i preventivi di questo cliente, e l'ha chiesto qualcun altro.")
  })

  it('the figure beside the sentence only when the API named it (the reader holds its grain), in the reader’s format', () => {
    const quote = { words: { sentence: { key: 'QUOTE_APPROVAL.PENDING', params: { number: 'Q-1', customer: 'Club', reasons: ['MARGIN_FLOOR'] } } }, figures: { currency: 'EUR', netAmount: 624000, marginPct: '18.25' } }
    expect(sentenceText({ ...quote, sentenceFigure: 'marginPct' }, it_, 'it')).toBe("Il preventivo Q-1 per Club aspetta un'approvazione: margine sotto il minimo (margine 18,3 %).")
    expect(sentenceText({ ...quote, sentenceFigure: null }, en, 'en')).toBe('Quote Q-1 for Club waits for an approval: margin under the floor.')
    const po = { words: { sentence: { key: 'PO_NOT_CONFIRMED.DAYS', params: { number: 'PO-1', supplier: 'Tannery', count: 3 } } }, figures: { currency: 'EUR', purchaseAmount: 482000 } }
    expect(sentenceText({ ...po, sentenceFigure: 'purchaseAmount' }, en, 'en')).toBe('Purchase order PO-1 to Tannery is not confirmed 3 days after it was sent (€4,820.00).')
    // The API names no figure without the grain, and sends no figures: nothing is drawn.
    expect(sentenceText({ ...po, sentenceFigure: null, figures: null }, it_, 'it')).toBe("L'ordine d'acquisto PO-1 a Tannery non è confermato 3 giorni dopo l'invio.")
  })

  it('the Italian design cases show no English sentence', () => {
    const html = renderToString(
      createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: designScreen.cases.find((entry) => entry.id === 'owner')!.model })),
    )
    expect(html).toContain('è in ritardo di 2 giorni')
    expect(html).not.toMatch(/is 2 days late|waits in quarantine|You manage this customer/)
  })
})

describe('the keys live in ONE info icon in the list footer (Owner rule 2026-10-29: no key hints above a list)', () => {
  it('Today’s own keys: j / k, Enter, e for an alert, and a / r for a quote approval’s review — no grid keys', () => {
    const en = createTranslator('en', CATALOGUE.en.home!)
    expect(todayKeys(en)).toEqual([
      { keys: ['j', 'k'], does: 'keys.rows' },
      { keys: ['↵'], does: 'keys.open' },
      { keys: ['e'], does: 'Acknowledge the alert (in the list or its review)' },
      { keys: ['a'], does: 'Approve the quote (in its review)' },
      { keys: ['r'], does: 'Reject the quote, with a reason (in its review)' },
    ])
  })

  it('the queue draws no key hint in its header, and its footer holds the keys icon', () => {
    const html = renderToString(
      createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: designScreen.cases.find((entry) => entry.id === 'owner')!.model })),
    )
    const head = html.slice(html.indexOf('id="fw-today-needs"'), html.indexOf('fw-today-group'))
    expect(head).not.toMatch(/<kbd/i)
    expect(html).toContain('fw-today-queue-foot')
    expect(html.slice(html.indexOf('fw-today-queue-foot'))).toContain('Keyboard keys of this list')
  })
})
