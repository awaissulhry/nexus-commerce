import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { productionListSchema, type ProductionList, type ProductionRow, type Urgency, type UrgencyAnswer } from './api'
import {
  chipOf,
  groupOf,
  groupsOf,
  healthInputOf,
  keepMine,
  listQuery,
  markActionOf,
  markedNotice,
  markRefusal,
  NS,
  orderChanged,
  orderHeld,
  orderRefusal,
  rowHref,
  rowName,
  rowRef,
  stylesText,
  toTop,
  undoneNotice,
  undoRefusal,
  urgencyCell,
  urgentRowsOf,
  waitingInputOf,
  type MarkFacts,
} from './model'
import { ProductionListView, type ProductionListModel } from './view/ProductionListView'

/**
 * F-PR-11 — the customer's My production (production plan §3, §4, §5; 17-web-r2 §1.4; wall PW-P01, PW-11, PW-15): its own orders
 * in its own order, Urgent and Regular, the urgency cell in the API's words, Mark urgent / Mark regular at once inside the quota
 * and before Cutting (held with the words otherwise, held by our lock with our reason), Undo, the Urgent order dialog's order and
 * its conflict words ("Changed by us at 10:42", never a name), urgency off (nothing of urgency drawn), and Brand Beta's page holds
 * nothing of Brand Alpha and never the office's SO- series. Every name and number is made up.
 */

const t = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const en = t('en')
const w = (text: string) => ({ it: text, en: text })

function urgency(over: Partial<Urgency> = {}): Urgency {
  return { code: 'REGULAR', words: { it: 'Normale', en: 'Regular' }, urgentRank: null, asked: false, askedWords: null, byUs: false, byUsWords: null, locked: false, lockWords: null, ...over }
}
const URGENT = (rank: number, over: Partial<Urgency> = {}) => urgency({ code: 'URGENT', words: { it: 'Urgente', en: 'Urgent' }, urgentRank: rank, ...over })

function row(id: string, over: Partial<ProductionRow> = {}): ProductionRow {
  return {
    id,
    customerRef: `${BRAND_BETA.customerRef}-${id}`,
    // The office's own number: in the read, never drawn.
    number: BRAND_BETA.numbers.order,
    yourNumber: customerNumberOf('ORDER', 4),
    orderedOn: '2026-10-05',
    styles: [{ code: BRAND_BETA.numbers.style, name: 'Rider jacket' }],
    pieces: 120,
    promiseDate: '2026-12-02',
    originalPromiseDate: '2026-11-28',
    promiseMoved: true,
    stage: { code: 'PREPARING', words: { it: 'In preparazione', en: 'Preparing' }, since: '2026-11-10', next: { code: 'CUTTING', words: { it: 'Taglio', en: 'Cutting' } } },
    health: { code: 'AT_RISK', words: { it: 'A rischio', en: 'At risk' }, reason: { code: 'MATERIAL_LATE', words: { it: 'Materiale in ritardo', en: 'Material late' } } },
    waiting: { code: 'US', words: { it: 'Tocca a noi', en: 'Waiting on us' }, since: '2026-11-12' },
    marks: { onHold: false, paused: false, partlyShipped: false, changePending: false, words: [] },
    urgency: urgency(),
    next: { kind: 'STAGE', stage: 'CUTTING', gate: null, date: null, words: { it: 'Taglio', en: 'Cutting' } },
    count: null,
    ...over,
  }
}

const USE = { used: 2, max: 3, agreed: 0, left: 1, over: false, words: { it: '2 urgenti su 3', en: '2 of 3 urgent used' } }

function list(over: Partial<ProductionList> = {}): ProductionList {
  const items = [row('b2', { urgency: URGENT(1) }), row('b3', { urgency: URGENT(2) }), row('b4'), row('b5', { urgency: urgency({ locked: true, lockWords: { it: 'Riportato a normale da noi: materiale non arrivato', en: 'Set to Regular by us: material not in' } }) })]
  return {
    asOf: '2026-11-17T09:42:00.000Z',
    level: 'STATUS',
    levelWords: { it: 'Solo lo stato', en: 'Status only' },
    urgencyOn: true,
    urgentUse: USE,
    chip: 'ALL',
    chips: [
      { chip: 'ALL', count: 4, words: { it: 'Tutti', en: 'All in production' } },
      { chip: 'URGENT', count: 2, words: { it: 'Urgenti', en: 'Urgent' } },
      { chip: 'WAITING_ON_YOU', count: 0, words: { it: 'Tocca a te', en: 'Waiting on you' } },
    ],
    count: items.length,
    items,
    live: { events: ['brand_production.urgency_changed'] },
    ...over,
  }
}

const FACTS: MarkFacts = { urgencyOn: true, mayMark: true, preview: false, offline: false, busy: false, use: USE }
const conflict = (path: string, kind: 'conflict' | 'not_found' = 'conflict') => new ApiError(kind, kind === 'conflict' ? 409 : 404, kind, 'refused', null, [{ path, message: 'English for the logs' }])

describe('the address and the order’s own name (B-TH-303: never the office’s series)', () => {
  it('ALL is the default and left out; a chip and a search are kept; a word not a chip is no chip', () => {
    expect(listQuery(null, '')).toBe('')
    expect(listQuery('ALL', '')).toBe('')
    expect(listQuery('URGENT', ' PO-1 ')).toBe('?chip=URGENT&q=PO-1')
    expect(chipOf('LATE')).toBe('LATE')
    expect(chipOf('ALL')).toBeNull()
    expect(chipOf('constructor')).toBeNull()
    expect(rowHref('/p/X', { id: 'o 1' })).toBe('/p/X/orders/o%201?tab=status')
  })

  it('their PO first, then "Your order 4"; the SO- number is never in the name', () => {
    const one = row('b2')
    expect(rowRef(one, 'en')).toEqual({ theirs: `${BRAND_BETA.customerRef}-b2`, ours: { label: 'Your order', value: '4' } })
    expect(rowName(one, 'en', en)).toBe(`${BRAND_BETA.customerRef}-b2 · Your order 4`)
    expect(rowName({ customerRef: null, yourNumber: null }, 'en', en)).toBe('your order')
    expect(rowName(one, 'en', en)).not.toContain(BRAND_BETA.numbers.order)
    expect(stylesText(row('b2', { styles: [{ code: 'BX-200', name: 'Rider' }, { code: 'BX-201', name: 'Pant' }, { code: 'BX-202', name: 'Vest' }] }), en)).toBe('BX-200 Rider +2')
    expect(stylesText(row('b2', { styles: [] }), en)).toBe('—')
  })

  it('the API’s answer parses; a field the API adds never breaks the page', () => {
    const read = list()
    const parsed = productionListSchema.parse({ ...read, extra: 1, items: read.items.map((item) => ({ ...item, problem: null, later: 'x' })) })
    expect(parsed.items).toHaveLength(4)
    expect('later' in parsed.items[0]!).toBe(false)
  })
})

describe('Urgent / Regular and the urgency cell (the API’s words)', () => {
  it('Urgent rows in their own order, then Regular; urgency off: no group at all', () => {
    const read = list()
    expect(read.items.map(groupOf)).toEqual(['URGENT', 'URGENT', 'REGULAR', 'REGULAR'])
    expect(groupsOf(read)).toEqual(['URGENT', 'REGULAR'])
    expect(groupsOf(list({ urgencyOn: false }))).toEqual([])
    expect(urgentRowsOf([row('b3', { urgency: URGENT(2) }), row('b4'), row('b2', { urgency: URGENT(1) })]).map((item) => item.id)).toEqual(['b2', 'b3'])
  })

  it('"Urgent 2", "Urgent – asked", "Regular", "Changed by us" (never who), the lock with our reason', () => {
    expect(urgencyCell(URGENT(2), 'en')).toMatchObject({ text: 'Urgent 2', tone: 'warning', locked: false, note: null })
    expect(urgencyCell(urgency({ asked: true, askedWords: { it: 'Urgente – richiesto', en: 'Urgent – asked' } }), 'it')).toMatchObject({ text: 'Urgente – richiesto', tone: 'info' })
    expect(urgencyCell(urgency({ byUs: true, byUsWords: { it: 'Modificato da noi', en: 'Changed by us' } }), 'en')).toMatchObject({ text: 'Regular', note: 'Changed by us' })
    expect(urgencyCell(urgency({ locked: true, lockWords: { it: 'Riportato a normale da noi: x', en: 'Set to Regular by us: material not in' } }), 'en')).toEqual({ text: 'Regular', tone: 'neutral', locked: true, note: 'Set to Regular by us: material not in' })
  })
})

describe('Mark urgent / Mark regular (L18: at once inside the quota and before Cutting; held with the words otherwise)', () => {
  it('a Regular order before Cutting inside the quota: Mark urgent at once; an Urgent order: Mark regular, always free', () => {
    expect(markActionOf(row('b4'), FACTS, 'en', en)).toEqual({ urgency: 'URGENT', held: null })
    expect(markActionOf(row('b2', { urgency: URGENT(1), stage: { ...row('x').stage!, code: 'SEWING' } }), { ...FACTS, use: { ...USE, left: 0 } }, 'en', en)).toEqual({ urgency: 'REGULAR', held: null })
  })

  it('over the quota, from Cutting, already asked: held with the words (Ask us comes with F-PR-23)', () => {
    expect(markActionOf(row('b4'), { ...FACTS, use: { ...USE, used: 3, left: 0 } }, 'en', en)?.held).toBe('3 of 3 urgent used. Set one back to Regular first.')
    expect(markActionOf(row('b4'), { ...FACTS, use: { ...USE, used: 0, max: 0, left: 0 } }, 'en', en)?.held).toBe('Urgent marks on your orders are asked of us.')
    expect(markActionOf(row('b4', { stage: { ...row('x').stage!, code: 'CUTTING' } }), FACTS, 'en', en)?.held).toBe('Cutting has started on this order.')
    expect(markActionOf(row('b4', { urgency: urgency({ asked: true }) }), FACTS, 'en', en)?.held).toBe('You asked us to make it urgent: we answer you soon.')
  })

  it('a lock from us holds both marks with our reason; a preview and no connection hold every mark', () => {
    const locked = urgency({ locked: true, lockWords: { it: 'Riportato a normale da noi: x', en: 'Set to Regular by us: material not in' } })
    expect(markActionOf(row('b5', { urgency: locked }), FACTS, 'en', en)).toEqual({ urgency: 'URGENT', held: 'Set to Regular by us: material not in' })
    expect(markActionOf(row('b2', { urgency: URGENT(1) }), { ...FACTS, preview: true }, 'en', en)?.held).toBe('A preview reads only.')
    expect(markActionOf(row('b2', { urgency: URGENT(1) }), { ...FACTS, offline: true }, 'it', t('it'))?.held).toBe('Nessuna connessione: riprova quando torni online.')
  })

  it('urgency off for this customer, a role that reads, no urgency read: no mark is drawn at all', () => {
    expect(markActionOf(row('b4'), { ...FACTS, urgencyOn: false }, 'en', en)).toBeNull()
    expect(markActionOf(row('b4'), { ...FACTS, mayMark: false }, 'en', en)).toBeNull()
    expect(markActionOf(row('b4', { urgency: null }), FACTS, 'en', en)).toBeNull()
  })

  it('the refusals in the person’s words (409 at body/orderIds/<i>/<OUTCOME>; 404 an order not its own: read again)', () => {
    expect(markRefusal(conflict('body/orderIds/0/ASK_CUT'), en)).toEqual({ words: 'Cutting has started on this order.', reread: true })
    expect(markRefusal(conflict('body/orderIds/0/ASK_OVER_QUOTA'), t('it')).words).toBe('Hai usato tutte le tue urgenze. Riporta prima un ordine a normale.')
    expect(markRefusal(conflict('body/orderIds/0/LOCKED'), en).words).toBe('We set this order to Regular: it stays Regular for now.')
    expect(markRefusal(conflict('body/orderIds', 'not_found'), en)).toEqual({ words: 'This order is not one of your orders in production.', reread: true })
    expect(markRefusal(new Error('boom'), en)).toEqual({ words: 'Could not save. Try again in a moment.', reread: false })
  })

  it('a done mark names the order and its own place, with Undo of its batch; an Undo says what it left', () => {
    const answer: UrgencyAnswer = { batchId: 'batch-1', results: [{ orderId: 'b4', number: BRAND_BETA.numbers.order, customerRef: null, outcome: 'DONE', done: true, words: null, ask: null, urgency: 'URGENT', urgentRank: 3 }], notFound: 0, use: USE, replayed: false }
    const notice = markedNotice(answer, row('b4'), 'en', en)
    expect(notice).toEqual({ tone: 'success', words: `${BRAND_BETA.customerRef}-b4 · Your order 4 is urgent now: Urgent 3.`, undo: 'batch-1' })
    expect(notice.words).not.toContain(BRAND_BETA.numbers.order)
    expect(undoneNotice({ skipped: [] }, en).words).toBe('Put back as it was.')
    expect(undoneNotice({ skipped: [{}] }, en).words).toBe('Put back; 1 order had changed since and is left as it is.')
    expect(undoRefusal(conflict('body/batchId/SKIPPED'), en)).toBe('Nothing was undone: every order changed since.')
    expect(undoRefusal(conflict('body/batchId', 'not_found'), en)).toBe('This change is not found: nothing to undo.')
  })
})

describe('the Urgent order dialog (drag, keyboard grip, buttons; only urgent orders move)', () => {
  it('Move to top, whether it changed, and "Keep my order" over a list that moved', () => {
    const rows = list().items
    expect(toTop(['b2', 'b3'], 'b3')).toEqual(['b3', 'b2'])
    expect(toTop(['b2', 'b3'], 'zz')).toEqual(['b2', 'b3'])
    expect(orderChanged(['b2', 'b3'], rows)).toBe(false)
    expect(orderChanged(['b3', 'b2'], rows)).toBe(true)
    // b3 left Urgent, b6 joined: mine keeps its order where it still holds, the new one after.
    const moved = [row('b2', { urgency: URGENT(1) }), row('b6', { urgency: URGENT(2) })]
    expect(keepMine(['b3', 'b2'], moved)).toEqual(['b2', 'b6'])
  })

  it('opens with two urgent orders or more; a preview and no connection hold it', () => {
    expect(orderHeld(2, { preview: false, offline: false }, en)).toBeNull()
    expect(orderHeld(1, { preview: false, offline: false }, en)).toBe('Mark two orders urgent to put them in order.')
    expect(orderHeld(3, { preview: true, offline: false }, en)).toBe('A preview reads only.')
  })

  it('a version conflict reads "Changed by us at 10:42" when we changed it — never a name; its own side "Changed at 10:42"', () => {
    expect(orderRefusal(conflict('body/orderIds/CHANGED_SINCE/US/10:42'), en)).toEqual({ words: 'Changed by us at 10:42.', conflict: true })
    expect(orderRefusal(conflict('body/orderIds/CHANGED_SINCE/US/10:42'), t('it'))).toEqual({ words: 'Modificato da noi alle 10:42.', conflict: true })
    expect(orderRefusal(conflict('body/orderIds/CHANGED_SINCE/YOU/09:05'), en)).toEqual({ words: 'Changed at 09:05.', conflict: true })
    expect(orderRefusal(conflict('body/orderIds/CHANGED_SINCE'), en)).toEqual({ words: 'Changed since you opened it.', conflict: true })
    expect(orderRefusal(conflict('body/orderIds'), en)).toEqual({ words: 'Nothing to change: your urgent orders are in this order already.', conflict: false })
    expect(orderRefusal(conflict('body/orderIds/2'), en)).toEqual({ words: 'Your urgent orders changed: read the list again.', conflict: true })
  })

  it('the dialog’s words promise nothing about dates and name no queue place', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale][NS]!
      expect(words['dialog.promise']).toBeTruthy()
      for (const value of Object.values(words)) expect(value, locale).not.toMatch(/position|queue|posizione|coda|supervisor|supervisore/i)
    }
    expect(CATALOGUE.en[NS]!['dialog.promise']).toBe('Your urgent orders go first among your orders when we next plan. Dates change only when we tell you.')
  })
})

describe('the order’s production as the lib parts read it', () => {
  it('health: the chip and the curated reason, never a note; waiting: You or Us only', () => {
    expect(healthInputOf(row('b2').health)).toEqual({ computed: 'AT_RISK', raised: { reason: 'MATERIAL_LATE' } })
    expect(healthInputOf({ code: 'NO_DATE', words: w('No date yet'), reason: null })).toEqual({ computed: 'NOT_PROMISED', raised: null })
    expect(healthInputOf(null)).toEqual({ computed: null })
    expect(waitingInputOf({ code: 'YOU', words: w('Waiting on you'), since: '2026-11-15' })).toEqual({ who: 'BRAND', since: '2026-11-15', kind: 'record' })
    expect(waitingInputOf({ code: 'US', words: w('Waiting on us'), since: null }).who).toBe('US')
  })
})

// ---- the page as Brand Beta reads it (PW-P01, PW-15) --------------------------------------------------------------------------
function model(over: Partial<ProductionListModel> = {}): ProductionListModel {
  return { state: 'ready', read: list(), chip: null, q: '', prefix: `/p/${BRAND_BETA.code}`, updates: 0, offlineSince: null, mayMark: true, preview: false, busy: [], notice: null, collapsed: [], dialog: null, now: Date.parse('2026-11-17T10:00:00.000Z'), ...over }
}
const draw = (over: Partial<ProductionListModel> = {}, locale: Locale = 'en') => render(createElement(ProductionListView, { model: model(over) }), locale)

describe('Brand Beta’s My production (PW-P01, PW-15): its own orders, numbers and counts only', () => {
  it('in both languages, with a notice and Undo: no Brand Alpha marker, no office SO- series (the page words name no place: above)', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = draw({ notice: { tone: 'success', words: 'BETA-PO-0077-b4 · Your order 4 is urgent now: Urgent 3.', undo: 'batch-1' } }, locale)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html.match(/\bSO-\d{4}-\d+/)?.[0] ?? null, locale).toBeNull()
      expect(html).not.toContain(BRAND_BETA.numbers.order)
    }
  })

  it('"2 of 3 urgent used" and the chips with their counts (a chip at 0 still says 0); Undo beside a done mark', () => {
    const text = textOf(draw({ notice: { tone: 'success', words: 'Marked.', undo: 'batch-1' } }))
    expect(text).toContain('2 of 3 urgent used')
    expect(text).toContain('Urgent orders go first among your orders when we next plan.')
    expect(text).toContain('Waiting on you 0')
    expect(text).toContain('Undo')
    expect(textOf(draw({ read: list({ urgentUse: { ...USE, used: 4, agreed: 1, left: 0, over: true, words: { it: '4 urgenti su 3 · 1 concordato con noi', en: '4 of 3 · 1 agreed with us' } } }) }))).toContain('4 of 3 · 1 agreed with us')
  })

  it('urgency off for this customer: no "n of max used", no urgency words drawn (its marks are kept, not used)', () => {
    const off = list({ urgencyOn: false, urgentUse: null, chips: [{ chip: 'ALL', count: 4, words: { it: 'Tutti', en: 'All in production' } }], items: list().items.map((item) => ({ ...item, urgency: null })) })
    const text = textOf(draw({ read: off }))
    expect(text).not.toContain('urgent used')
    expect(text).not.toContain('Urgent orders go first')
  })

  it('nothing in production: says so and leads to every order; a failed read says so with Try again', () => {
    const empty = textOf(draw({ read: list({ items: [], count: 0 }) }))
    expect(empty).toContain('No orders in production right now.')
    expect(empty).toContain('See all orders')
    expect(textOf(draw({ state: 'error', read: null }))).toContain('Could not load your orders in production')
  })
})

describe('the words exist in both languages with the same placeholders', () => {
  it('portal-production', () => {
    const it = CATALOGUE.it[NS]!
    const enWords = CATALOGUE.en[NS]!
    expect(Object.keys(it).sort()).toEqual(Object.keys(enWords).sort())
    for (const key of Object.keys(enWords)) expect((it[key]!.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((enWords[key]!.match(/\{\w+\}/g) ?? []).sort())
  })
})
