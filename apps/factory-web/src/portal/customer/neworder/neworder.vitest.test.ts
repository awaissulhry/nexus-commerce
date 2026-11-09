import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PROBLEM_CODES as DOMAIN_PROBLEMS, REQUEST_STATUSES as DOMAIN_STATUSES, SOURCES as DOMAIN_SOURCES } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { REORDER_NOTICES as DOMAIN_NOTICES } from '@nexus/factory-domain/sales/portal-ordering/reorder'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { catalogueHref, filterCount, filtersOf, NO_FILTERS, orderHeld, ppeKey, sizeMatrix, styleName, typeKey } from '../catalogue/model'
import { designScreen as catalogueScreen } from '../catalogue/fixtures'
import { pickerLineCount, pickerStyles } from './view/Dialogs'
import { LIMITS, NOTICE_CODES, PROBLEM_CODES, SOURCES, STATUSES } from './api'
import { ADDRESSES, catalogueRead, draftRecord, lineOf, pastOrder, styleDetail, STYLES } from './design-data'
import { designScreen as newOrderScreen } from './fixtures'
import {
  cellsOf,
  columnsOf,
  droppedOf,
  headerChanges,
  headerDraftOf,
  headerProblem,
  lineChanged,
  lineHeld,
  mergeWords,
  newOrderHref,
  noticeWords,
  NS,
  piecesOfCells,
  problemPlace,
  problemWords,
  refusalOf,
  reorderBody,
  reorderLineHeld,
  reorderStart,
  sendHeld,
  shipToOptions,
  sizesBody,
  stylesOf,
  verdictReason,
  writeHeld,
} from './model'

/**
 * SCR-185 and SCR-226 (B-W2b-194): New order & reorder and the Catalogue, pure — the addresses, the header's autosave (only
 * what changed, by the API's limits), the delivery addresses offered, a line's grid and what its save sends, every
 * problem and reorder difference in both languages from codes and figures, the send's held reasons, the reorder's choice,
 * the sheet's reasons, the catalogue's filters — and every design case drawn in Italian and English with no raw key and
 * no price for a role without the grain.
 */

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const kit = (locale: 'it' | 'en') => ({ t: t(locale), price: (value: string | null | undefined) => (value ? `€ ${value}` : null) })

describe('the codes the page words match the domain', () => {
  it('statuses, sources, problems and reorder notices are the domain’s', () => {
    expect([...STATUSES]).toEqual([...DOMAIN_STATUSES])
    expect([...SOURCES]).toEqual([...DOMAIN_SOURCES])
    expect([...PROBLEM_CODES]).toEqual([...DOMAIN_PROBLEMS])
    expect([...NOTICE_CODES]).toEqual([...DOMAIN_NOTICES])
  })

  it('every problem and notice has words in it and en, with its figures', () => {
    const lines = draftRecord().request.lines
    for (const locale of ['it', 'en'] as const) {
      for (const code of PROBLEM_CODES) {
        const text = problemWords({ code, lineId: lines[0]!.id, size: '62' }, lines, kit(locale))
        expect(text, `${code} ${locale}`).not.toMatch(/problem\.|\{/)
      }
      for (const code of NOTICE_CODES) {
        const text = noticeWords(code, { style: 'JKT-100', colour: 'Nero', priceNow: '410.00', priceThen: '400.00', dropped: ['58'] }, kit(locale))
        expect(text, `${code} ${locale}`).not.toMatch(/notice\.|\{/)
      }
      for (const kind of ['conflict', 'invalid', 'forbidden', 'not_found', 'rate_limited', 'unavailable', null]) expect(t(locale)(refusalOf(kind))).not.toMatch(/^refusal\./)
    }
    expect(problemWords({ code: 'SIZE_NOT_OFFERED', lineId: lines[0]!.id, size: '62' }, lines, kit('en'))).toBe('Size 62 is not offered for JKT-100.')
    expect(noticeWords('PRICE_CHANGED', { priceNow: '410.00', priceThen: '400.00' }, kit('it'))).toBe('Prezzo ora € 410.00 (era € 400.00)')
  })
})

describe('the address and the way in', () => {
  it('builds and reads the page’s address', () => {
    expect(newOrderHref('/p/X')).toBe('/p/X/orders/new')
    expect(newOrderHref('/p/X', { draft: 'd1', way: 'reorder', reorder: 'o1', line: 'l1' })).toBe('/p/X/orders/new?draft=d1&way=reorder&reorder=o1&line=l1')
    expect(newOrderHref('/p/X', { styles: ['a', 'b'] })).toBe('/p/X/orders/new?styles=a%2Cb')
    expect(stylesOf(`${STYLES[0]!.id},${STYLES[0]!.id},<script>,${STYLES[1]!.id}`)).toEqual([STYLES[0]!.id, STYLES[1]!.id])
    expect(stylesOf(null)).toEqual([])
  })
})

describe('the header', () => {
  it('sends only what changed, a blank as null', () => {
    const saved = headerDraftOf(draftRecord().request)
    expect(headerChanges(saved, saved)).toEqual({})
    expect(headerChanges(saved, { ...saved, customerRef: '  BA-PO-9 ' })).toEqual({ customerRef: 'BA-PO-9' })
    expect(headerChanges(saved, { ...saved, note: '', customerRef: '' })).toEqual({ customerRef: null })
    expect(headerChanges(saved, { ...saved, note: 'x', customerRef: 'y' }, 'note')).toEqual({ note: 'x' })
  })

  it('holds a field by the API’s limits', () => {
    const draft = headerDraftOf(null)
    expect(headerProblem('customerRef', { ...draft, customerRef: 'x'.repeat(LIMITS.customerRef + 1) }, '2026-11-09')).toBe('head.problem.refLong')
    expect(headerProblem('requestedDate', { ...draft, requestedDate: '2026-11-08' }, '2026-11-09')).toBe('head.problem.datePast')
    expect(headerProblem('requestedDate', { ...draft, requestedDate: '2026-11-09' }, '2026-11-09')).toBeNull()
  })

  it('offers addresses of ours or checked; a waiting or archived one only when it is the draft’s own', () => {
    const refused = { ...ADDRESSES[1]!, id: 'refused', approval: { status: 'REFUSED' as const }, status: 'ARCHIVED' as const }
    const all = [...ADDRESSES, refused]
    expect(shipToOptions(all, null).map((option) => [option.id, option.state])).toEqual([
      [ADDRESSES[0]!.id, 'OK'],
      [ADDRESSES[1]!.id, 'OK'],
    ])
    expect(shipToOptions(all, ADDRESSES[2]!.id).find((option) => option.id === ADDRESSES[2]!.id)?.state).toBe('WAITING')
    expect(shipToOptions(all, 'refused').find((option) => option.id === 'refused')?.state).toBe('ARCHIVED')
  })
})

describe('a line’s size grid', () => {
  const line = lineOf(1, { sizes: [{ size: '48', quantity: 4, offered: true }, { size: '62', quantity: 2, offered: false }] })
  it('draws the offered sizes, then a size asked that is no longer offered', () => {
    expect(columnsOf(line)).toEqual(['46', '48', '50', '52', '54', '56', '62'])
    expect(cellsOf(line)).toEqual({ '48': 4, '62': 2 })
  })
  it('sends every size with pieces in the grid’s order', () => {
    expect(sizesBody(columnsOf(line), { '50': 3, '48': 4, '62': 0, '46': -1 })).toEqual([
      { size: '48', quantity: 4 },
      { size: '50', quantity: 3 },
    ])
    expect(sizesBody(['48'], { '48': 200_000 })).toEqual([{ size: '48', quantity: LIMITS.quantity }])
    expect(piecesOfCells({ '48': 4, '50': 3, x: -2 })).toBe(7)
  })
  it('knows a change and holds an empty line', () => {
    expect(lineChanged(line, { '48': 4, '62': 2 })).toBe(false)
    expect(lineChanged(line, { '48': 5, '62': 2 })).toBe(true)
    expect(lineHeld({ '48': 0 })).toBe('lines.held.empty')
    expect(lineHeld({ '48': 1 })).toBeNull()
  })
})

describe('the send', () => {
  const facts = { preview: false, offline: false, busy: false, emptyLine: false }
  it('is held in order: preview, offline, busy, not a draft, an empty line, the problems', () => {
    const record = draftRecord()
    expect(sendHeld(record.request, facts)).toBeNull()
    expect(sendHeld(record.request, { ...facts, preview: true })).toEqual({ key: 'held.preview' })
    expect(sendHeld(record.request, { ...facts, offline: true })).toEqual({ key: 'held.offline' })
    expect(sendHeld({ ...record.request, status: 'SENT' }, facts)).toEqual({ key: 'held.notDraft' })
    expect(sendHeld(record.request, { ...facts, emptyLine: true })).toEqual({ key: 'lines.held.empty' })
    const problems = [{ code: 'NO_LINES' as const, lineId: null, size: null }, { code: 'DATE_PAST' as const, lineId: null, size: null }]
    expect(sendHeld({ ...record.request, problems }, facts)).toEqual({ key: 'held.problems', count: 2 })
    expect(t('en')('held.problems', { count: 2 })).toBe('2 problems to fix — Show me')
    expect(writeHeld({ preview: false, offline: false, busy: true })).toBe('held.busy')
  })
  it('“Show me” goes to the line, the lines or the order details', () => {
    expect(problemPlace({ code: 'SIZE_NOT_OFFERED', lineId: 'l1', size: '62' })).toBe('line-l1')
    expect(problemPlace({ code: 'NO_LINES', lineId: null, size: null })).toBe('lines')
    expect(problemPlace({ code: 'DATE_PAST', lineId: null, size: null })).toBe('order-head')
  })
})

describe('reorder', () => {
  const order = pastOrder()
  it('chooses what can go, a discontinued colour once replaced, never a line that cannot', () => {
    expect(reorderStart(order.lines, null)).toEqual([order.lines[0]!.orderLineId])
    expect(reorderStart(order.lines, order.lines[1]!.orderLineId)).toEqual([])
    expect(reorderLineHeld(order.lines[1]!, null)).toBe('reorder.held.colour')
    expect(reorderLineHeld(order.lines[1]!, 'c')).toBeNull()
    expect(reorderLineHeld(order.lines[2]!, null)).toBe('reorder.held.notAddable')
    const all = order.lines.map((line) => line.orderLineId)
    expect(reorderBody(order.lines, all, {})).toEqual([{ orderLineId: order.lines[0]!.orderLineId }])
    expect(reorderBody(order.lines, all, { [order.lines[1]!.orderLineId]: 'black' })).toEqual([{ orderLineId: order.lines[0]!.orderLineId }, { orderLineId: order.lines[1]!.orderLineId, colourwayId: 'black' }])
    expect(droppedOf(order.lines[0]!)).toEqual(['58'])
  })
  it('names what joined a line the draft had', () => {
    const record = draftRecord()
    const lineId = record.request.lines[0]!.id
    expect(mergeWords({ added: 1, merged: [{ lineId, size: '54' }], kept: [{ lineId, size: '50' }] }, record, t('en'))).toEqual([
      '1 line added to the draft.',
      'Size 54 added to the JKT-100 line you had.',
      'Size 50 of JKT-100 was on the draft already: your quantity was kept.',
    ])
  })
})

describe('the sheet', () => {
  it('a domain reason in the page’s language; an engine’s English cell problem in our words', () => {
    expect(verdictReason({ it: 'Taglia 62 non offerta.', en: 'Size 62 not offered.' }, 'it', t('it'))).toBe('Taglia 62 non offerta.')
    expect(verdictReason({ it: 'Quantity: must be a whole number', en: 'Quantity: must be a whole number' }, 'it', t('it'))).toBe('Non è stato possibile leggere la cella Quantità.')
    expect(verdictReason({ it: 'Something odd', en: 'Something odd' }, 'en', t('en'))).toBe('A cell of this row could not be read.')
  })
})

describe('the catalogue', () => {
  it('reads and writes its filters in the address', () => {
    const search = new URLSearchParams('q=jkt&category=JACKET&range=OWN_LABEL&ppe=CATEGORY_II&view=list')
    const filters = filtersOf(search)
    expect(filters).toEqual({ q: 'jkt', category: 'JACKET', season: null, ppe: 'CATEGORY_II', range: 'OWN_LABEL' })
    expect(filterCount(filters)).toBe(3)
    expect(catalogueHref('/p/X', filters, { view: 'list', style: 's1' })).toBe('/p/X/catalogue?q=jkt&category=JACKET&ppe=CATEGORY_II&range=OWN_LABEL&view=list&style=s1')
    expect(catalogueHref('/p/X', NO_FILTERS)).toBe('/p/X/catalogue')
    expect(filtersOf(new URLSearchParams('range=EVERYTHING')).range).toBe('ALL')
  })
  it('says a PPE category and a type from their codes, in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const code of ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III', 'NONE', 'CAT_III', 'ODD']) expect(t(locale)(ppeKey(code))).not.toMatch(/^ppe\./)
      for (const type of ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER', 'ODD']) expect(t(locale)(typeKey(type))).not.toMatch(/^type\./)
    }
    expect(styleName(STYLES[0]!, 'en')).toBe('Example Race Jacket')
    expect(styleName(STYLES[2]!, 'en')).toBe(STYLES[2]!.name)
  })
  it('holds Add to order for a person who may not order, a preview, no connection', () => {
    expect(orderHeld({ mayOrder: true, preview: false, offline: false })).toBeNull()
    expect(orderHeld({ mayOrder: false, preview: false, offline: false })).toBe('held.mayNotOrder')
    expect(orderHeld({ mayOrder: true, preview: true, offline: false })).toBe('held.preview')
  })
  it('the detail’s size table marks what each colour offers', () => {
    const matrix = sizeMatrix(styleDetail().style)
    expect(matrix.sizes).toEqual(['46', '48', '50', '52', '54', '56'])
    expect(matrix.rows[1]!.offered).toEqual([false, true, true, true, true, false])
  })
  it('the picker narrows on the page and counts the lines it would add', () => {
    expect(pickerStyles(catalogueRead(), 'touring', null, null, 'en').map((style) => style.code)).toEqual(['TRS-200'])
    expect(pickerStyles(catalogueRead(), '', 'GLOVES', null, 'it').map((style) => style.code)).toEqual(['GLV-300'])
    const styleId = STYLES[0]!.id
    expect(pickerLineCount({ selected: [styleId], cells: { [styleId]: { a: { '48': 2 }, b: { '50': 0 }, c: { '50': 1 } } }, onDraft: { [`${styleId}|c`]: 1 } })).toBe(1)
  })
})

const KEY = /\b(?:ref|band|keys|start|head|lines|size|reorder|upload|summary|problem|notice|done|sent|closed|missing|draft|address|picker|discard|catalogue|filters|card|col|type|ppe|detail|sheet|prices|held|refusal|unsaved|offline|dialog|state|noAccess|nav)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-185 and SCR-226 design cases', () => {
  for (const screen of [newOrderScreen, catalogueScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: every case draws in Italian and English with no raw key`, () => {
      for (const locale of ['it', 'en'] as const) {
        for (const entry of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: entry.model })))
          expect(html, `${screen.screen}/${entry.id} (${locale})`).toContain('main-content')
          expect(html.match(KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        }
      }
    })
  }

  it('a role without prices sees no amount anywhere', () => {
    for (const [screen, ids] of [
      [newOrderScreen, ['draft-no-prices']],
      [catalogueScreen, ['no-prices', 'may-not-order', 'detail-no-prices']],
    ] as const) {
      for (const id of ids) {
        const entry = (screen as unknown as DesignScreen<unknown>).cases.find((item) => item.id === id)!
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement((screen as unknown as DesignScreen<unknown>).view, { model: entry.model })))
        expect(html, id).not.toMatch(/€|EUR/)
      }
    }
  })
})
