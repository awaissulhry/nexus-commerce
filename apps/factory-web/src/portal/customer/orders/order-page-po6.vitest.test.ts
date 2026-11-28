import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { QUIET_LINE_KEYS } from '@nexus/factory-domain/threads/quiet-lines'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { quietLineOf } from '../../../lib/record-thread/partner/quiet'
import { orderTabsOf } from './band'
import { orderRecord, orderWords, PREFIX } from './design-data'
import { dueStepOf, minorOf, moneySchema, noticeBodyOf, noticeProblem, stepOpen, toldOn, type PlanStep } from './money'
import { askNoteOf, askTyped, linesModeOf, NO_ASKS, orderLinePricesOf, orderLineRowsOf, undoAsk } from './order-lines'
import { ORDER_PAGE_NS } from './page-words'
import { pictureChoicesOf } from './picture'
import { designScreen as recordScreen } from './record/fixtures'

/**
 * owb-po6 — the order page, part 2 (plan § 5j Lines, § 5m Money, § 5n Shipments, § 5o Files, § 5zi F quiet lines; lead decisions: the
 * order page's chat is the panel, the SH- wall). Written, not run (Owner rule: checks at the end).
 */

const draw = (id: string, locale: 'en' | 'it' = 'en') => render(createElement(recordScreen.view, { model: recordScreen.cases.find((item) => item.id === id)!.model }), locale)
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

describe('owb-po6.1 — Lines on the ONE table: typing after Confirm makes an ask, never a save', () => {
  const rows = orderLineRowsOf(orderRecord())

  it('the rows never hold a price; the Your price column only for a price holder', () => {
    expect(JSON.stringify(rows)).not.toMatch(/unitPrice|netAmount|vatAmount/)
    expect(orderLinePricesOf({ ...orderRecord(), seesPrices: false })).toBeNull()
    expect(orderLinePricesOf(orderRecord())).toMatchObject({ edit: false, currency: orderRecord().order.currency })
  })

  it('the table\'s mode: confirmed (asks) until it left the factory; shipped reads', () => {
    for (const status of ['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const) expect(linesModeOf(status), status).toBe('confirmed')
    for (const status of ['SHIPPED', 'DELIVERED', 'CANCELLED'] as const) expect(linesModeOf(status), status).toBe('shipped')
  })

  it('type-then-click on a confirmed line builds an ask (kept by the page), the save bar counts, Undo and Discard take them back', () => {
    const first = rows[0]!
    const typed = askTyped(NO_ASKS, rows, first.id, String((first.pieces.count ?? 0) + 2))
    expect(typed.order).toEqual([first.id])
    expect(typed.pieces[first.id]).toBe((first.pieces.count ?? 0) + 2)
    // Its own number again: no ask any more; not a number: nothing changes.
    expect(askTyped(typed, rows, first.id, String(first.pieces.count ?? 0))).toEqual(NO_ASKS)
    expect(askTyped(typed, rows, first.id, 'x')).toBe(typed)
    expect(undoAsk(typed)).toEqual(NO_ASKS)
    expect(askNoteOf(typed, rows, ({ seq, pieces, now }) => `${seq}:${pieces}:${now}`)).toBe(`${first.seq}:${(first.pieces.count ?? 0) + 2}:${first.pieces.count ?? 0}`)
    // The page keeps the ask (no save call on typing); Review opens the Ask window at its change step; the ask goes with today's change request.
    const page = read('./OrderPage.tsx')
    expect(page).toContain('onLineAsk: (lineId, text) => setLineAsks((current) => askTyped(current, lineRows, lineId, text))')
    expect(page).toContain("setDialog({ kind: 'change', draft: { ...EMPTY_CHANGE, cells, note, focusLine: lineAsks.order[0] ?? null }")
    expect(read('./view/LinesTab.tsx')).toContain("onAsk: (rowId, field, value) => (field === 'pieces' ? actions?.onLineAsk?.(rowId, value) : undefined)")
  })

  it('the save bar says how many asks wait, with Undo and "Review and ask…" (en + it)', () => {
    const en = textOf(draw('po6-lines-asked'))
    expect(en).toContain('1 change not asked yet')
    expect(en).toContain('Review and ask…')
    expect(textOf(draw('po6-lines-asked', 'it'))).toContain(CATALOGUE.it[ORDER_PAGE_NS]!['lines.review']!)
    // Own columns apply at once: PUT /portal/own-values on the ORDER line.
    expect(read('./OrderPage.tsx')).toContain(".putValue({ line: { kind: 'ORDER_LINE', id: lineId }, columnId, value")
  })
})

describe('owb-po6.2 — Money: the plan, "I paid: tell the factory…" (a notice: nothing owed changes)', () => {
  const step = (over: Partial<PlanStep>): PlanStep => ({ id: 's', kind: 'DEPOSIT', percent: 30, amount: 32400, due: '2026-12-01', state: 'DUE', paid: 0, noticeOpen: false, ...over })

  it('no Money tab for a person without the price grain (the customer\'s Designer)', () => {
    expect(orderTabsOf({ words: orderWords('en'), record: orderRecord(), prefix: PREFIX, toConfirm: false, files: 0, money: false }).map((tab) => tab.id)).not.toContain('money')
  })

  it('ONE due step carries the button: late first, then due, then part paid; what is open never goes below 0', () => {
    expect(dueStepOf([step({ id: 'a', state: 'PAID' }), step({ id: 'b', state: 'DUE' }), step({ id: 'c', state: 'LATE' })])?.id).toBe('c')
    expect(dueStepOf([step({ id: 'a', state: 'PART_PAID' }), step({ id: 'b', state: 'DUE' })])?.id).toBe('b')
    expect(dueStepOf([step({ state: 'PAID' }), step({ state: 'LATER' })])).toBeNull()
    expect(stepOpen(step({ amount: 100, paid: 150 }))).toBe(0)
  })

  it('the window: an amount in the reader\'s writing, a day not in the future, never more than is open; the body names nothing empty', () => {
    expect([minorOf('1.234,50'), minorOf('1234.5'), minorOf('€ 80'), minorOf('1,234'), minorOf('abc')]).toEqual([123450, 123450, 8000, 123400, null])
    const draft = { amount: '324', paidOn: '2026-11-27', method: '', note: '' }
    expect(noticeProblem(draft, step({}), '2026-11-28')).toBeNull()
    expect(noticeProblem({ ...draft, amount: '0' }, step({}), '2026-11-28')).toBe('money.problem.amount')
    expect(noticeProblem({ ...draft, amount: '400' }, step({}), '2026-11-28')).toBe('money.problem.tooMuch')
    expect(noticeProblem({ ...draft, paidOn: '2026-11-29' }, step({}), '2026-11-28')).toBe('money.problem.day')
    expect(noticeBodyOf({ ...draft, method: ' Bank transfer ' }, 's')).toEqual({ stepId: 's', amount: 32400, paidOn: '2026-11-27', method: 'Bank transfer' })
  })

  it('the view changes nothing owed: the one money write is the notice; the step then says when the factory was told', () => {
    const page = read('./OrderPage.tsx')
    expect(page).toContain('sendPaymentNotice(api, id, body, keyFor(body))')
    expect(read('./money.ts')).toContain('/payment-notices')
    expect(toldOn({ notices: [{ id: 'n', stepId: 's', amount: 1, paidOn: '2026-11-20', state: 'OPEN' }, { id: 'm', stepId: 's', amount: 1, paidOn: '2026-11-25', state: 'OPEN' }, { id: 'x', stepId: 's', amount: 1, paidOn: '2026-11-26', state: 'RECORDED' }] }, 's')).toBe('2026-11-25')
    expect(textOf(draw('po6-money'))).toContain('I paid: tell the factory…')
    const told = textOf(draw('po6-money-told'))
    expect(told).not.toContain('I paid: tell the factory…')
    expect(told).toContain('You told the factory on')
  })

  it('the money read parses the Shape (the rest step\'s id is REST) and never a margin or a cost', () => {
    const parsed = moneySchema.parse({ currency: 'EUR', totals: { order: 1, invoiced: 0, paid: 0, stillToPay: 1 }, addsUp: [], plan: [{ id: 'REST', kind: 'REST', percent: 70, amount: 1, due: null, state: 'LATER', paid: 0, noticeOpen: false }], invoices: [], notices: [], may: { notify: true }, margin: 5, cost: 3 })
    expect(JSON.stringify(parsed)).not.toMatch(/margin|cost/)
  })
})

describe('owb-po6.3 — Shipments: the label card only at the warehouse; never an office series', () => {
  it('"At the factory’s warehouse" with Send the shipping label only on the shipment that waits there', () => {
    const html = textOf(draw('po6-warehouse'))
    expect(html).toContain('At the factory’s warehouse')
    expect(html).toContain('Send the shipping label')
    expect(textOf(draw('shipments'))).not.toContain('Send the shipping label')
  })

  it('no SH- anywhere on the tab (the customer\'s own count), and the report door with the order', () => {
    for (const id of ['shipments', 'po6-warehouse']) expect(draw(id), id).not.toMatch(/SH-\d|SEED-SH/)
    expect(read('./view/ShipmentsTab.tsx')).not.toContain('shipment.number')
    expect(read('./OrderPage.tsx')).toContain('/returns?start=CHOOSE&order=')
  })
})

describe('owb-po6.4 — Files: a file becomes the picture; quiet lines; the chat is the panel', () => {
  it('"Use as the picture" offers an image or PDF the customer can open — never a size file', () => {
    const file = (id: string, contentType: string, category: string | null) => ({ id, name: id, kind: 'ATTACHMENT', category, contentType }) as never
    const choices = pictureChoicesOf({ groups: [{ files: [file('mockup', 'image/png', 'ARTWORK'), file('sizes', 'application/pdf', 'MEASUREMENTS'), file('sheet', 'text/csv', null)] } as never] })
    expect(choices.map((choice) => choice.fileId)).toEqual(['mockup'])
  })

  it('a quiet row draws for every key in en + it, by side ("The factory" / "Your team"), with the grouped count; an unknown key draws nothing', () => {
    for (const locale of ['en', 'it'] as const) {
      const t = createTranslator(locale, CATALOGUE[locale]['record-thread-partner'] ?? {})
      for (const key of QUIET_LINE_KEYS) {
        for (const by of ['FACTORY', 'CUSTOMER']) {
          const said = quietLineOf({ key, args: { by }, count: 1 }, t)
          expect(said, `${locale} ${key} ${by}`).toBeTruthy()
          expect(said!, `${locale} ${key} ${by}`).not.toMatch(/quiet\./)
        }
      }
    }
    const en = createTranslator('en', CATALOGUE.en['record-thread-partner'] ?? {})
    expect(quietLineOf({ key: 'quiet.lineAdded', args: { by: 'FACTORY', words: 'a new jacket', pieces: 3 }, count: 1 }, en)).toBe('The factory added a line: a new jacket, 3 pieces')
    expect(quietLineOf({ key: 'quiet.lineChanged', args: { by: 'CUSTOMER' }, count: 3 }, en)).toBe('Your team changed a line · 3 changes')
    expect(quietLineOf({ key: 'quiet.somethingElse', args: { by: 'FACTORY' }, count: 1 }, en)).toBeNull()
    expect(quietLineOf(null, en)).toBeNull()
  })

  it('no bubble, no face, never new: the quiet row is drawn before the message row and the count skips it', () => {
    const column = read('../../../lib/record-thread/partner/view/PartnerColumn.tsx')
    expect(column).toContain('className="fw-rt-feed-item fw-rtp-quiet" role="note"')
    expect(column.indexOf('fw-rtp-quiet')).toBeLessThan(column.indexOf('<MessageRow'))
    expect(column).toContain('partnerUnreadOf(model.messages.filter((message) => !message.event), model.reading)')
  })

  it('the order page has no docked conversation: the band\'s Chat opens the panel at the order (other record pages keep their dock)', () => {
    expect(read('./OrderPage.tsx')).not.toContain('<PortalThread')
    expect(read('./band.ts')).toContain("chat: { type: 'SalesOrder', id: order.id, label: name }")
    expect(read('../../shell/view/PortalShellView.tsx')).toContain("aria-pressed={model.chat?.open ?? false} onClick={() => onOpen?.('chat')}")
    expect(read('../returns/repair/RepairPage.tsx')).toContain('PortalThread')
  })
})
