import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { barOf, NO_BAR_CAN } from '../../orders/list/sheet/bar'
import { askedLines } from '../../../warehouse/shipments/model'
import { designScreen } from './fixtures'

/**
 * cw T.1 (customer Work tab plan; 10-design §8, §9) — the gallery cases for every state the seed lacks: a busy customer with orders
 * in all seven groups, the customer's urgency in every state, our own priority, the switch off, no order, drafts only, everything
 * done, a band door, an extra deposit, a new yes, the row ticked per reader, and each window the bar and the row open. Made-up data
 * only (SEED-SO-0001 … 0014, SEED-SH-0011 / 0012); no amount for a reader without the price grain.
 */

const CW = designScreen.cases.filter((item) => item.id.startsWith('cw-'))
const find = (id: string) => designScreen.cases.find((item) => item.id === id)!
const View = designScreen.view as (props: { model: unknown }) => ReturnType<typeof createElement>
const html = (id: string, locale: (typeof LOCALES)[number] = 'en'): string => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: find(id).model })))

describe('cw T.1: the cases the design asks for', () => {
  it('every state of 15-steps T.1 has its case, each one the live Work tab', () => {
    expect(CW.map((item) => item.id)).toEqual([
      'cw-busy',
      'cw-busy-widest',
      'cw-switch-off',
      'cw-two-companies',
      'cw-drafts-only',
      'cw-no-order',
      'cw-all-done',
      'cw-door-not-sent',
      'cw-extra-deposit',
      'cw-ticked-owner',
      'cw-ticked-sales',
      'cw-ticked-warehouse',
      'cw-ticked-manager',
      'cw-ticked-reader',
      'cw-ship-step1',
      'cw-ship-step2',
      'cw-ship-notice',
      'cw-ask-production',
      'cw-ask-production-receipt',
      'cw-ask-customer',
      'cw-ask-customer-receipt',
      'cw-urgency-regular',
      'cw-urgency-lock',
      'cw-urgency-unlock',
      'cw-urgency-many',
      'cw-urgency-outcome',
      'cw-urgency-as-sales',
      'cw-customise',
      'cw-dock-shipment-line',
    ])
    for (const item of CW) expect(item.model.work?.live, item.id).toBe(true)
    expect(new Set(designScreen.cases.map((item) => item.id)).size).toBe(designScreen.cases.length) // no id twice
  })

  it('the busy customer: 14 made-up orders in the seven groups (2 · 1 · 4 · 1 · 2 · 3 · 1), every urgency state, our Top, High and Low', () => {
    const work = find('cw-busy').model.work!
    const rows = work.rows!
    expect(rows.map((row) => row.number)).toEqual(Array.from({ length: 14 }, (_, index) => `SEED-SO-${String(index + 1).padStart(4, '0')}`))
    expect(work.reads.board.status === 'ready' && work.reads.board.value.byPhase?.map((entry) => entry.count)).toEqual([2, 1, 4, 1, 2, 3, 1])
    expect(work.reads.board.status === 'ready' && work.reads.board.value.byStatus.reduce((sum, entry) => sum + entry.count, 0)).toBe(14)
    const states = rows.map((row) => row.customerUrgencyState)
    expect(states.filter((state) => state?.state === 'URGENT').map((state) => state!.urgentRank)).toEqual([1, 2, 3])
    expect(states.filter((state) => state?.state === 'ASKED').map((state) => state!.requestId !== null)).toEqual([true])
    expect(states.filter((state) => state?.state === 'SET_BACK').map((state) => state!.locked)).toEqual([true])
    expect(rows.map((row) => row.priority?.level).filter((level) => level !== 'NORMAL')).toEqual(['LOW', 'URGENT', 'HIGH'])
    // Late, at risk, on hold, a request to answer, an ask of production, garments ready now; an order after production has no stage.
    expect(rows.some((row) => row.production?.health === 'LATE') && rows.some((row) => row.production?.health === 'AT_RISK') && rows.some((row) => row.production?.held)).toBe(true)
    expect(rows.some((row) => (row.production?.openRequests ?? 0) > 0) && rows.some((row) => (row.production?.openIssues ?? 0) > 0) && rows.some((row) => (row.production?.readyNow ?? 0) > 0)).toBe(true)
    for (const row of rows.filter((entry) => ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'].includes(entry.status))) expect(row.production?.stage ?? null, row.number).toBeNull()
  })

  it('made-up data only, and no amount for a reader without the price grain', () => {
    for (const item of CW) {
      for (const row of item.model.work?.rows ?? []) expect(row.number, item.id).toMatch(/^SEED-SO-\d{4}$/)
      if (item.model.work?.price === false) for (const row of item.model.work.rows ?? []) expect([row.netAmount, row.grossAmount, row.paid, row.balance, row.invoiced], `${item.id} ${row.number}`).toEqual([undefined, undefined, undefined, undefined, null])
    }
    const source = readFileSync(new URL('./fixtures.ts', import.meta.url), 'utf8')
    const block = source.slice(source.indexOf('// ---- cw T.1 (customer Work tab plan'), source.indexOf('// ---- cp-walk (review walk'))
    expect(block.length).toBeGreaterThan(2000)
    expect(block).not.toMatch(/@(?!example\.com)[a-z0-9-]+\.[a-z]{2,}/i) // an address, if any, is example.com's
  })
})

describe('cw T.1: what each case shows (the parts that draw on the server)', () => {
  it('the foot line: the order the rows stand in and the customer\'s urgency — on, off (with the door), two companies', () => {
    expect(html('cw-busy')).toContain('Customer urgency: 3 of at most 3 urgent now.')
    expect(html('cw-busy', 'it')).toContain('Urgenza cliente: 3 di al massimo 3 urgenti ora.')
    const off = html('cw-switch-off')
    expect(off).toContain('Customer urgency is off for ')
    expect(off).toContain('(our priority, then promise date)')
    expect(off).toContain('?tab=portal#production-limits')
    expect(off).not.toContain('urgent now.')
    expect(html('cw-two-companies')).toContain('Customer urgency: Seed A 2 of at most 3 · Seed B 1 of at most 3 urgent now.')
    // Not read (no order at all): the sort only — never "0 of …", never "off".
    const none = html('cw-no-order')
    expect(none).not.toContain('urgent now.')
    expect(none).not.toContain('Customer urgency is off')
  })

  it('the switch off: no row carries a customer chip', () => {
    for (const row of find('cw-switch-off').model.work!.rows!) expect([row.customerUrgency, row.customerUrgencyState], row.number).toEqual([null, null])
  })

  it('after Create: ONE notice — the draft, its four orders, "is not told"; after an urgency act: the outcome per order', () => {
    const notice = html('cw-ship-notice')
    expect(notice).toContain('Shipment SEED-SH-0012 created with 4 orders:')
    expect(notice).toContain('is not told.')
    for (const number of ['SEED-SO-0008', 'SEED-SO-0009', 'SEED-SO-0006', 'SEED-SO-0004']) expect(notice, number).toContain(number)
    const outcome = html('cw-urgency-outcome')
    expect(outcome).toContain('Set back to Regular: SEED-SO-0004, SEED-SO-0005.')
    expect(outcome).toContain('SEED-SO-0006 not changed: It changed meanwhile: read it again.')
    expect(html('cw-urgency-outcome', 'it')).toContain('È cambiato nel frattempo: rileggilo.')
  })

  it('the docked order\'s thread carries the draft shipment\'s office line, in the API\'s own words — a system note, never a person\'s', () => {
    const source = readFileSync(new URL('./fixtures.ts', import.meta.url), 'utf8')
    expect(source).toContain("kind: 'note', channel: 'APP', author: null, authorKind: 'SYSTEM'")
    expect(source).toContain('body: `On draft shipment SEED-SH-0012 with ${SEED_NUMBER(3)}, ${SEED_NUMBER(4)}.`')
    // The words are the API's (apps/factory-api shipping/shipments/order-notes.ts): "On draft shipment SH-0012 with SO-0003, SO-0004."
    const api = readFileSync(new URL('../../../../../../factory-api/src/modules/shipping/shipments/order-notes.ts', import.meta.url), 'utf8')
    expect(api).toContain('"On draft shipment SH-0012 with SO-0003, SO-0004."')
    expect(find('cw-dock-shipment-line').model.shipmentLine).toBe(true)
  })

  it('every case draws in both languages', () => {
    for (const item of CW) for (const locale of LOCALES) expect(html(item.id, locale).length, `${item.id} ${locale}`).toBeGreaterThan(500)
  })
})

describe('cw T.1: the made-up windows say what their labels say (the rules, on the cases\' own data)', () => {
  it('Ship 6 together…: runs on 4, not on 2 — another delivery address, nothing released to ship', () => {
    const source = readFileSync(new URL('./fixtures.ts', import.meta.url), 'utf8')
    // The window's model is built by the fixtures from the same six ticked orders: the Warehouse rule reads it.
    expect(source).toContain('const SHIP_TICKED = [8, 9, 6, 4, 5, 7].map(SEED_ID)')
    expect(source).toContain("readyOf(pick(5), 6, { allowed: false, code: 'SHIP_TO', why: null })")
    const id = (n: number) => `d0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`
    const order = (n: number, shippable: number, shipsWith: { allowed: boolean; code?: 'SHIP_TO'; why: null } | null) => ({ salesOrderId: id(n), shipsWith, cells: [{ shippable }] })
    const lines = askedLines({
      orders: [order(8, 40, null), order(9, 12, { allowed: true, why: null }), order(6, 24, { allowed: true, why: null }), order(4, 10, { allowed: true, why: null }), order(5, 6, { allowed: false, code: 'SHIP_TO', why: null })] as never,
      salesOrderId: id(8),
      others: [9, 6, 4].map(id),
      asked: [8, 9, 6, 4, 5, 7].map(id),
    })
    expect(lines.filter((line) => line.on)).toHaveLength(4)
    expect(lines.filter((line) => !line.on).map((line) => line.why?.kind)).toEqual(['held', 'nothing'])
  })

  it('the row ticked per reader: each act by its own right (the bar\'s rule over the cases\' three orders)', () => {
    const rows = find('cw-ticked-owner').model.work!.rows!.filter((row) => find('cw-ticked-owner').model.work!.tickedIds!.includes(row.id))
    expect(rows.map((row) => row.number)).toEqual(['SEED-SO-0003', 'SEED-SO-0004', 'SEED-SO-0005'])
    const ids = (can: Parameters<typeof barOf>[0]) => {
      const bar = barOf(can, rows, { locked: rows[0]!.partyId })
      return { promoted: bar.promoted.map((act) => act.id), none: bar.none }
    }
    // As the fixtures give each reader its rights (the Work design: `reader`).
    expect(ids({ ...NO_BAR_CAN, ship: true, urgency: true, manage: true, close: true, decide: true, post: true, supervisor: true, task: true, todo: true, invoices: true }).promoted).toEqual(['ship', 'ask', 'priority'])
    expect(ids({ ...NO_BAR_CAN, manage: true, close: true, decide: true, post: true, task: true, todo: true }).promoted).toEqual(['ask', 'priority', 'reply'])
    expect(ids({ ...NO_BAR_CAN, ship: true, decide: true, post: true, task: true }).promoted).toEqual(['ship', 'ask', 'reply'])
    expect(ids({ ...NO_BAR_CAN, urgency: true, post: true, supervisor: true, task: true }).promoted).toEqual(['ask', 'reply', 'assign'])
    expect(ids(NO_BAR_CAN)).toEqual({ promoted: [], none: true })
    for (const reader of ['sales', 'warehouse', 'manager', 'reader'] as const) expect(find(`cw-ticked-${reader}`).model.work!.reader, reader).toBe(reader)
  })

  it('the fixtures mount the real parts: the sheet, the band, the foot, the thread — never a drawing of their own', () => {
    const source = readFileSync(new URL('./fixtures.ts', import.meta.url), 'utf8')
    expect(source).toContain('createElement(WithMessages, { namespaces: [SHEET_NS] }, createElement(WorkFoot, { line: foot }))')
    expect(source).toContain('actions: work.live ? liveDoors(work, can.price) /* cw T.1 */ : workDoors(work, can.price)')
    expect(source).toContain('...live, // cw T.1: the live tab\'s own options, over the earlier cases\' ones')
    expect(source).toContain('return createElement(ThreadCase, {')
  })
})
