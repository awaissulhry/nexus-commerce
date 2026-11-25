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
// F-CP-150: the draft order page.
import { LINE_TROUSERS } from './design-data'
import { closedOf, draftBannerOf, draftDiscardHeld, draftSendHeld, draftStateOf, draftTitleOf, linesInOrder, mayOf, reorderHeldKey, SEND_HOLDING, whoMayOrder } from './model'
import { OrderingCase } from './view/OrderingCase'
// F-CP-151: the draft's files.
import { announceDraftFile, completeDraftFile, removeDraftFile } from './api'
import { DRAFT_FILES_MAX, draftFileCount, draftMailName, fileHeldKey, fileKindOf, filesAddHeld, uploadsOpenOf } from './model'
import { designScreen as newOrderScreen, REQUEST_CASES } from './fixtures'
// B-TH-220, B-TH-303: New order as an e-mail.
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { REQUEST_STATE_WORDS } from '@nexus/factory-domain/sales/portal-requests/state'
import type { ApiClient } from '../../../lib/api/client'
import { EMPTY_COMPOSE, sendBodyOf } from '../../../lib/request-compose/model'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { sendRequest, type SendAnswer } from '../requests/api'
// B-TH-282
import { announceFile, attachFiles, completeFile } from '../requests/api'
import { filesOutcome, holdFiles, retryCarry, stateAfterUpload, takesSheetTick, toAttach, toUpload } from '../../../lib/request-compose/files'
import { requestView } from '../requests/design-data'
import { requestBandOf } from './band'
// B-TH-287: the New order draft on the server.
import { discardNewRequestDraft, fetchNewRequestDraft, saveNewRequestDraft } from './api'
import { serverDraftBody } from '../../../lib/request-compose/server-draft'
import { CATALOGUE_DOOR_OPEN, closedRefusal, failedKey, goesToOf, openItems, opensCatalogueDoor, receiptOf, reorderText, shipToChoices, stylesText, withCarried } from './request-model'
// F-CP-152: which page /orders/new opens.
import { newOrderDoorOf, WORDS_WAY, wordsHref } from './request-model'
// B-TH-304: the catalogue door open again.
import { catalogueStartHref } from './request-model'
import { orderLinesLabel, ownOrderRef } from './model'
import { orderingWordsFor } from './words'
import { DRAFT_NS } from '../../../lib/order-draft/words' // od-w1.1
// od-w1.2 (THE SIMPLE ORDER START R1): the mail, the products table, Still open, saved by — the shared part's model.
import { choicesTyped, optionHeld, productRowsOf, rowPiecesWords, savedByWords, stillOpenEntries } from '../../../lib/order-draft/model'
import { piecesModesOf } from '../../../lib/order-draft/view/RowWindows'
import type { OrderingCaseBuilder } from './view/OrderingCase'
// F-CP-154: lines of every kind, the People and sizes roster, "Your price".
import { partnerTemplateOf } from '@nexus/factory-domain/auth/roles/templates'
import { MEASURE_BY as DOMAIN_MEASURES } from '@nexus/factory-domain/sales/portal-ordering/people'
import { addCustomLine, addPeople, changeCustomLine, changeLine, changePerson, removePerson, recordSchema } from './api'
import { describedLine, kindsRecord, mtmLine, personOf, RIDERS, SHEET_ON_MTM } from './design-data'
import {
  customTitleOf,
  EMPTY_PERSON,
  entriesInOrder,
  kindKey,
  MEASURES,
  mtmOf,
  ownPriceOf,
  ownPriceWriteOf,
  ownTotalOf,
  personBody,
  personChanges,
  personDraftOf,
  personProblems,
  personWhat,
  priceRowsOf,
  yourPriceAccess,
} from './model'
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
// od-w1.1: the ONE draft order's words moved to their own catalogue (src/lib/order-draft, `order-draft`): its functions read them there.
const td = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale][DRAFT_NS] ?? {})
const dkit = (locale: 'it' | 'en') => ({ t: td(locale), price: (value: string | null | undefined) => (value ? `€ ${value}` : null) })

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
        const text = problemWords({ code, lineId: lines[0]!.id, size: '62' }, lines, dkit(locale))
        expect(text, `${code} ${locale}`).not.toMatch(/problem\.|\{/)
      }
      for (const code of NOTICE_CODES) {
        const text = noticeWords(code, { style: 'JKT-100', colour: 'Nero', priceNow: '410.00', priceThen: '400.00', dropped: ['58'] }, dkit(locale))
        expect(text, `${code} ${locale}`).not.toMatch(/notice\.|\{/)
      }
      for (const kind of ['conflict', 'invalid', 'forbidden', 'not_found', 'rate_limited', 'unavailable', null]) expect(t(locale)(refusalOf(kind))).not.toMatch(/^refusal\./)
    }
    expect(problemWords({ code: 'SIZE_NOT_OFFERED', lineId: lines[0]!.id, size: '62' }, lines, dkit('en'))).toBe('Size 62 is not offered for JKT-100.')
    expect(noticeWords('PRICE_CHANGED', { priceNow: '410.00', priceThen: '400.00' }, dkit('it'))).toBe('Prezzo ora € 410.00 (era € 400.00)')
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
  const facts = { preview: false, offline: false, busy: false }
  it('is held in order: preview, offline, busy, not a draft, an invalid value — never a missing one (od-w1.2, R1)', () => {
    const record = draftRecord()
    expect(sendHeld(record.request, facts)).toBeNull()
    expect(sendHeld(record.request, { ...facts, preview: true })).toEqual({ key: 'held.preview' })
    expect(sendHeld(record.request, { ...facts, offline: true })).toEqual({ key: 'held.offline' })
    expect(sendHeld({ ...record.request, status: 'SENT' }, facts)).toEqual({ key: 'held.notDraft' })
    const missing = [{ code: 'NO_LINES' as const, lineId: null, size: null }, { code: 'NO_TOTAL' as const, lineId: 'l1', size: null }, { code: 'NO_PEOPLE' as const, lineId: 'l1', size: null }, { code: 'NO_SIZES' as const, lineId: 'l1', size: null }]
    expect(sendHeld({ ...record.request, problems: missing }, facts)).toBeNull()
    const problems = [...missing, { code: 'DATE_PAST' as const, lineId: null, size: null }, { code: 'PRICE_CHANGED' as const, lineId: 'l1', size: null }]
    expect(sendHeld({ ...record.request, problems }, facts)).toEqual({ key: 'held.problems', count: 2 })
    for (const code of missing.map((problem) => problem.code)) expect(SEND_HOLDING.has(code), code).toBe(false)
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

const KEY = /\b(?:draftPage|ref|band|keys|start|head|lines|size|reorder|upload|summary|problem|notice|done|sent|closed|missing|draft|address|picker|discard|catalogue|filters|card|col|type|ppe|detail|sheet|prices|held|refusal|unsaved|offline|dialog|state|noAccess|nav|request|receipt|compose|to|subject|message|kept|files|details|same|send)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

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

// ── B-TH-220, B-TH-303: New order as an e-mail ─────────────────────────────────────────────────────────────────────────
const PREFIX_ALPHA = '/p/BRAND-ALPHA' // F-CP-152: the made-up prefix of the catalogue door's cases
const OFFICE_SERIES = /\b(?:INQ|QT|SO|RQ)-\d{4}-\d{2,}/
const API_UPLOADS_CLOSED = 'Uploads from outside are closed for now: the virus scanner is not running here yet. Please send the file to your contact by e-mail.'
const renderCase = (locale: 'it' | 'en', id: string) => {
  const entry = (newOrderScreen as unknown as DesignScreen<unknown>).cases.find((item) => item.id === id)!
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement((newOrderScreen as unknown as DesignScreen<unknown>).view, { model: entry.model })))
}

describe('B-TH-220 — New order as an e-mail', () => {
  it('the catalogue door switch: closed, /orders/new is always the e-mail; open (B-TH-304), only its own terms open its page', () => {
    for (const query of ['draft=0194f0e2-1940-7000-8000-000000000901', 'way=pick&styles=abc', 'reorder=0194f0e2-1940-7000-8000-000000000601', '']) expect(opensCatalogueDoor(new URLSearchParams(query), false)).toBe(false)
    expect(opensCatalogueDoor(new URLSearchParams('way=pick'), true)).toBe(true)
    expect(opensCatalogueDoor(new URLSearchParams(''), true)).toBe(false)
  })

  it('the request names no party and no company: the POST body is what was typed (W11)', async () => {
    const sent: { path: string; body: unknown; key?: string }[] = []
    const api = {
      post: async (path: string, options: { body?: unknown; idempotencyKey?: string }) => {
        sent.push({ path, body: options.body, key: options.idempotencyKey })
        return { request: requestView('SENT'), receipt: { number: 'INQ-2026-00147', yourNumber: customerNumberOf('REQUEST', 7), subject: 'S', words: { en: 'x', it: 'x' } } } satisfies SendAnswer
      },
    } as unknown as ApiClient
    await sendRequest(api, sendBodyOf({ ...EMPTY_COMPOSE, subject: 'Rain jackets', message: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef }), 'key-1')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.path).toBe('/portal/inquiries')
    expect(sent[0]!.key).toBe('key-1')
    expect(Object.keys(sent[0]!.body as object).sort()).toEqual(['customerRef', 'message', 'subject'])
    expect(JSON.stringify(sent[0]!.body)).not.toMatch(/party|company|recipient/i)
  })

  it('the fixed "Goes to" line names the session’s own company; never a To field', () => {
    expect(goesToOf('Pelletteria Esempio', t('en'))).toBe('Sales at Pelletteria Esempio')
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'th-220-compose')
      expect(html).toContain(locale === 'en' ? 'Goes to' : 'Va a')
      expect(html).not.toMatch(/<input[^>]*(name|aria-label)="(to|To|A|recipient)"/)
    }
  })

  it('held states say why: no request numbering (the API’s words), no right to order (who can give it), a preview, offline', () => {
    expect(renderCase('en', 'th-220-closed')).toContain('Orders by portal are not open yet for Pelletteria Esempio — please write to your contact.')
    expect(renderCase('en', 'th-220-no-right')).toContain(`Your admin can give you the right: ${BRAND_BETA.portalPerson.name}.`)
    expect(renderCase('en', 'th-220-no-right-alone')).toContain('Ask us to add a buyer for your company.')
    expect(renderCase('en', 'th-220-preview')).toContain('A preview of the portal: nothing is sent.')
    expect(renderCase('en', 'th-220-offline')).toContain('You are offline')
    expect(renderCase('en', 'th-220-problems')).toContain('Write what you need first.')
  })

  it('the files’ place shows the API’s own sentence (no upload until the virus scanner)', () => {
    expect(CATALOGUE.en['request-compose']!['files.closed']).toBe(API_UPLOADS_CLOSED)
    const html = renderCase('en', 'th-220-compose')
    expect(html).toContain(API_UPLOADS_CLOSED)
    expect(html).not.toMatch(/type="file"/)
  })

  it('the receipt says the customer’s own number, what was sent, and promises no answer time', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'th-220-receipt')
      expect(html).toContain(locale === 'en' ? 'Received — your request 7.' : 'Ricevuta — la vostra richiesta 7.')
      expect(html).toContain(locale === 'en' ? 'Open the request' : 'Apri la richiesta')
      expect(html).not.toMatch(/working day|giorno lavorativo|within \d|entro \d|we confirm by|confermiamo entro/i)
      expect(html.match(OFFICE_SERIES)?.[0] ?? null).toBeNull()
    }
    // No answer-time promise anywhere in the ordering words (B-TH-041, PR-18).
    for (const locale of ['it', 'en'] as const) for (const namespace of [NS, DRAFT_NS]) for (const [key, text] of Object.entries(CATALOGUE[locale][namespace] ?? {})) expect(text, `${namespace}.${key} ${locale}`).not.toMatch(/working day|giorno lavorativo/i)
  })

  it('every New order case is Brand Beta’s alone: nothing of Brand Alpha, no office series, no raw key', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of REQUEST_CASES) {
        const html = renderCase(locale, entry.id)
        expect(scanText(html, BRAND_ALPHA), `${entry.id} (${locale})`).toEqual([])
        expect(html.match(OFFICE_SERIES)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
        expect(html.match(KEY)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
      }
    }
  })

  it('the receipt, the side column and the band from the API’s answer: own numbers only', () => {
    const answer: SendAnswer = { request: requestView('SENT'), receipt: { number: 'INQ-2026-00147', yourNumber: customerNumberOf('REQUEST', 7), subject: 'Rain jackets like last spring, 40 pieces', words: { en: 'Received — number INQ-2026-00147 (Your request 7).', it: 'x' } } }
    const receipt = receiptOf(answer, { ...EMPTY_COMPOSE, message: 'Forty jackets\n\n' }, [], '/p/BRAND-BETA', (iso) => iso)
    expect(receipt.seq).toBe(7)
    expect(receipt.message).toBe('Forty jackets')
    expect(receipt.requestHref).toBe(`/p/BRAND-BETA/orders/requests/${answer.request.id}`)
    expect(JSON.stringify(receipt)).not.toMatch(OFFICE_SERIES)
    const items = openItems([...Array.from({ length: 8 }, (_, n) => ({ ...requestView('SENT'), id: `r${n}`, updatedAt: `2026-11-1${n}T09:00:00Z` }))], '/p/X', 'en', (iso) => iso)
    expect(items).toHaveLength(5)
    expect(items[0]!.id).toBe('r7')
    expect(items[0]!.yours).toBe('Your request 7')
    const words = orderingWordsFor(t('en'), 'en')
    expect(requestBandOf({ words, phase: 'compose' })).toMatchObject({ title: 'New order', actions: [] })
    expect(requestBandOf({ words, phase: 'sent', state: { label: REQUEST_STATE_WORDS.SENT.en, code: 'SENT' }, customerRef: BRAND_BETA.customerRef })).toMatchObject({ title: 'Request sent', refs: { theirs: BRAND_BETA.customerRef, ours: null }, status: { label: 'Sent' } })
  })

  it('a catalogue style or a past order is carried into the message (the door closed), never ordered until Send', () => {
    const style = { code: 'BX-200', name: 'Regenjacke', nameI18n: { en: 'Rain jacket Beta' } }
    expect(stylesText([style], 'en', t('en'))).toEqual({ subject: 'BX-200 Rain jacket Beta', lines: ['- BX-200 · Rain jacket Beta: '] })
    expect(stylesText([style, { ...style, code: 'BX-201' }], 'en', t('en'))?.subject).toBe('BX-200 and 1 more style')
    expect(stylesText([], 'en', t('en'))).toBeNull()
    const kept = withCarried({ ...EMPTY_COMPOSE, subject: 'Mine', message: 'Hello' }, { subject: 'Other', lines: ['- a', '- b'] })
    expect(kept).toMatchObject({ subject: 'Mine', message: 'Hello\n\n- a\n- b' })
    const record = { order: { yourNumber: customerNumberOf('ORDER', 12) }, lines: [{ id: 'l1', style: { code: 'BX-200', name: 'Rain jacket' }, colourway: { code: 'NAV', name: 'Navy' }, description: null, quantity: 9, sizes: [{ size: 'S', ordered: 4 }, { size: 'M', ordered: 5 }, { size: 'L', ordered: 0 }] }] } as unknown as Parameters<typeof reorderText>[0]
    expect(reorderText(record, null, 'en', t('en'))).toEqual({ subject: 'Reorder · Your order 12', lines: ['Please make again:', '- BX-200 Rain jacket, Navy: S × 4, M × 5'], yours: 'Your order 12' })
  })

  it('offers the customer’s own delivery addresses: never a refused one; a new one waiting for our check is said', () => {
    const address = (id: string, over: object) => ({ id, name: null, line1: 'Betaweg 5', line2: null, postalCode: '10117', city: 'Berlin', province: null, country: 'DE', contactName: null, phone: null, deliveryNotes: null, isDefault: false, status: 'ACTIVE', approval: null, version: 1, createdAt: '', addedBy: { kind: 'FACTORY', name: null, you: false }, requestedAt: null, decidedAt: null, ...over }) as unknown as Parameters<typeof shipToChoices>[0][number]
    const choices = shipToChoices([address('a', {}), address('b', { isDefault: true }), address('c', { approval: { status: 'REFUSED', words: { it: '', en: '' }, refuseReason: null } }), address('d', { status: 'ARCHIVED' }), address('e', { approval: { status: 'WAITING', words: { it: '', en: '' }, refuseReason: null } })])
    expect(choices.map((choice) => choice.id)).toEqual(['b', 'a', 'e'])
    expect(choices.find((choice) => choice.id === 'e')?.waiting).toBe(true)
  })

  it('a refusal in our words; a closed company re-reads the door', () => {
    for (const kind of ['conflict', 'forbidden', 'invalid', 'unavailable', 'rate_limited', 'internal', null]) for (const locale of ['it', 'en'] as const) expect(t(locale)(failedKey(kind))).not.toMatch(/^request\./)
    expect(closedRefusal([{ path: 'request/closed' }])).toBe(true)
    expect(closedRefusal([{ path: 'request.closed' }])).toBe(true)
    expect(closedRefusal([{ path: 'body/message' }])).toBe(false)
  })
})

// ---- B-TH-304 (threads plan P-CUS-NEW.details, PR-18; W11, W37): the catalogue door opens again ---------------------------------
describe('B-TH-304 — the catalogue door is open again: New order offers it, with no answer-time promise and own numbers only', () => {
  const OFFICE = /\b(?:INQ|QT|SO|RQ)-\d{4}-\d{2,}/
  const PROMISE = /working day|business day|within \d|in \d+ (?:hours?|days?)|\b24 ?h\b|we confirm by|giorno lavorativo|giorni lavorativi|entro \d|confermiamo entro|in \d+ (?:ore|giorni)/i
  const leaves = (tree: unknown, prefix = ''): [string, string][] =>
    typeof tree === 'string' ? [[prefix, tree]] : tree && typeof tree === 'object' ? Object.entries(tree).flatMap(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key)) : []

  it('the door is open: catalogue orders land in Incoming (B-TH-039/040), so its own terms open its page again', () => {
    expect(CATALOGUE_DOOR_OPEN).toBe(true)
    for (const query of ['draft=0194f0e2-1940-7000-8000-000000000901', 'way=pick&styles=abc', 'way=reorder', 'way=upload', 'reorder=0194f0e2-1940-7000-8000-000000000601']) expect(opensCatalogueDoor(new URLSearchParams(query)), query).toBe(true)
    // Plain /orders/new stays the request like an e-mail (the door is offered beside it).
    expect(opensCatalogueDoor(new URLSearchParams(''))).toBe(false)
    expect(opensCatalogueDoor(new URLSearchParams('styles=abc'))).toBe(false)
    // The catalogue's "Start an order" opens the door's style picker while it is open.
    expect(catalogueStartHref('/p/BRAND-BETA')).toBe('/p/BRAND-BETA/orders/new?way=pick')
    expect(catalogueStartHref('/p/BRAND-BETA', false)).toBe('/p/BRAND-BETA/orders/new')
  })

  it('od-w1.2 (S1-B6): the request like an e-mail offers no way back to the draft — the two doors no longer link in a loop (it, en)', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'th-220-compose')
      expect(html).not.toContain(locale === 'en' ? 'Order from the catalogue' : 'Ordina dal catalogo')
      for (const way of ['pick', 'reorder', 'upload']) expect(html).not.toContain(`href="/p/BRAND-BETA/orders/new?way=${way}"`)
      expect(html).not.toMatch(PROMISE)
    }
  })

  it('no answer-time promise anywhere: every word of New order, the catalogue door and the compose, in it and en', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const namespace of [NS, DRAFT_NS, 'request-compose', 'portal-requests']) {
        for (const [key, text] of leaves(CATALOGUE[locale][namespace] ?? {})) expect(text, `${namespace}.${key} (${locale})`).not.toMatch(PROMISE)
      }
    }
    for (const id of ['th-304-draft', 'th-304-sent', 'th-304-accepted', 'start', 'sent']) for (const locale of ['it', 'en'] as const) expect(renderCase(locale, id), `${id} (${locale})`).not.toMatch(PROMISE)
  })

  it('W37 (pick A): the catalogue door read by Brand Beta names its own order numbers and its PO — never an office series, nothing of Brand Alpha', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['th-304-draft', 'th-304-reorder', 'th-304-reorder-order', 'th-304-sent', 'th-304-accepted']) {
        const html = renderCase(locale, id)
        expect(html.match(OFFICE)?.[0] ?? null, `${id} (${locale})`).toBeNull()
        expect(scanText(html, BRAND_ALPHA), `${id} (${locale})`).toEqual([])
      }
    }
    expect(renderCase('en', 'th-304-draft')).toContain(`from your order 12 (your PO ${BRAND_BETA.customerRef})`)
    expect(renderCase('it', 'th-304-draft')).toContain(`dal vostro ordine 12 (vostro numero ${BRAND_BETA.customerRef})`)
    expect(renderCase('en', 'th-304-reorder-order')).toContain('Lines of your order 12')
    const reorder = renderCase('en', 'th-304-reorder')
    expect(reorder).toContain('id="reorder"')
    // The past orders are a grid: its rows draw in the browser only. The Order cell's RefPair says each row's own number
    // (ownOrderRef: "Your order" · 12) beside their PO, from the rows this case hands the grid — never the office's series.
    const reorderCase = ((newOrderScreen as unknown as DesignScreen<unknown>).cases.find((item) => item.id === 'th-304-reorder')!.model as OrderingCaseBuilder)('en')
    const pastRows = reorderCase.body.kind === 'neworder' ? (reorderCase.body.model.reorder?.orders.rows ?? []) : []
    expect(pastRows.length).toBeGreaterThan(0)
    expect(pastRows.map((row) => ownOrderRef(row.yourNumber, 'en')?.label ?? null)).toContain('Your order')
    expect(pastRows.map((row) => row.customerRef)).toContain(BRAND_BETA.customerRef)
    expect(JSON.stringify(pastRows.map((row) => [row.customerRef, row.yourNumber]))).not.toMatch(OFFICE)
    expect(scanText(JSON.stringify(pastRows.map((row) => [row.customerRef, row.yourNumber])), BRAND_ALPHA)).toEqual([])
    const sent = renderCase('en', 'th-304-sent')
    expect(sent).toContain(`Your PO ${BRAND_BETA.customerRef}: you find it under Orders &amp; requests as a catalogue order.`)
    expect(renderCase('en', 'th-304-accepted')).toContain('We confirmed this request as an order: open it to follow it.')
    // The old catalogue cases (read by Brand Alpha) draw no office series either.
    for (const id of ['reorder', 'reorder-order', 'sent', 'closed']) expect(renderCase('en', id).match(OFFICE)?.[0] ?? null, id).toBeNull()
  })

  it('an order named in words: its own number, else its day; RefPair’s side is "Your order" · 12', () => {
    const words = t('en')
    const day = (date: string) => `day ${date}`
    expect(orderLinesLabel({ yourNumber: null, orderDate: '2026-09-01' }, words, day)).toBe('Lines of your order of day 2026-09-01')
    expect(ownOrderRef(customerNumberOf('ORDER', 12), 'en')).toEqual({ label: 'Your order', value: '12' })
    expect(ownOrderRef(customerNumberOf('ORDER', 12), 'it')).toEqual({ label: 'Il vostro ordine', value: '12' })
    expect(ownOrderRef(null, 'en')).toBeNull()
  })
})
// ---- end B-TH-304

// ---- B-TH-282 (B-TH-083/084/085): customers attach files — held until Send, uploaded right after it onto the new request,
// behind the virus scan; the measurement tick; design files download-only; the closed sentence; Retry.
describe('B-TH-282 — New order takes files: held until Send, then onto the request', () => {
  let n = 0
  const keyOf = () => `k${++n}`

  it('each file is checked as the API will: kinds by type, SVG refused naming the way out, sizes, at most 20 at once', () => {
    const { held, leftOut } = holdFiles([], [
      { name: 'sizes.pdf', type: 'application/pdf', size: 90_000 },
      { name: 'front.jpg', type: 'image/jpeg', size: 3_000_000 },
      { name: 'logo.ai', type: 'application/illustrator', size: 900_000 },
      { name: 'pack.zip', type: 'application/zip', size: 900_000 },
      { name: 'logo.svg', type: 'image/svg+xml', size: 9_000 },
      { name: 'huge.jpg', type: 'image/jpeg', size: 16 * 1_048_576 },
      { name: 'empty.pdf', type: 'application/pdf', size: 0 },
    ], keyOf)
    expect(leftOut).toBe(0)
    expect(held.map((file) => [file.name, file.kind, file.problem?.key ?? null, file.design])).toEqual([
      ['sizes.pdf', 'ATTACHMENT', null, false],
      ['front.jpg', 'PHOTO', null, false],
      ['logo.ai', 'ATTACHMENT', null, true],
      ['pack.zip', 'DOCUMENT', null, true],
      ['logo.svg', 'PHOTO', 'files.problem.page', false],
      ['huge.jpg', 'PHOTO', 'files.problem.size', false],
      ['empty.pdf', 'ATTACHMENT', 'files.problem.empty', false],
    ])
    expect(held.find((file) => file.name === 'huge.jpg')!.problem!.params).toEqual({ max: 15 })
    const many = holdFiles([], Array.from({ length: 23 }, (_, i) => ({ name: `p${i}.jpg`, type: 'image/jpeg', size: 10 })), keyOf)
    expect(many.held).toHaveLength(20)
    expect(many.leftOut).toBe(3)
    // The same file twice is held once.
    expect(holdFiles(held, [{ name: 'sizes.pdf', type: 'application/pdf', size: 90_000 }], keyOf).held).toHaveLength(held.length)
  })

  it('the measurement tick on a PDF or a photo only (body data); a design file never', () => {
    const { held } = holdFiles([], [{ name: 'a.pdf', type: 'application/pdf', size: 9 }, { name: 'b.png', type: 'image/png', size: 9 }, { name: 'c.ai', type: 'application/illustrator', size: 9 }, { name: 'd.svg', type: 'image/svg+xml', size: 9 }], keyOf)
    expect(held.map((file) => takesSheetTick(file))).toEqual([true, true, false, false])
  })

  it('after Send: what waits goes, a sent or scanning file never twice; Retry carries again what arrived but was not carried', () => {
    const base = holdFiles([], [{ name: 'a.pdf', type: 'application/pdf', size: 9 }, { name: 'b.pdf', type: 'application/pdf', size: 9 }, { name: 'c.svg', type: 'image/svg+xml', size: 9 }], keyOf).held
    expect(toUpload(base).map((file) => file.name)).toEqual(['a.pdf', 'b.pdf'])
    const after = [{ ...base[0]!, state: 'sent' as const, fileId: 'f-a', uploaded: true }, { ...base[1]!, state: 'scanning' as const, fileId: 'f-b', uploaded: true }, base[2]!]
    expect(toUpload(after)).toEqual([])
    expect(toAttach(after, new Set())).toEqual(['f-a'])
    expect(toAttach(after, new Set(['f-a']))).toEqual([])
    expect(stateAfterUpload('AVAILABLE')).toBe('sent')
    expect(stateAfterUpload('QUARANTINED')).toBe('scanning')
    const carryFailed = [{ ...after[0]!, state: 'failed' as const, failure: 'x' }]
    expect(toUpload(carryFailed)).toEqual([])
    expect(retryCarry(carryFailed)[0]!.state).toBe('sent')
    expect(filesOutcome([...after, { ...base[0]!, key: 'z', state: 'failed' as const }])).toMatchObject({ sent: 1, scanning: 1, failed: 1, refused: 1 })
  })

  it('W25 W37: the file goes onto the session’s own request by its id only — never a party or a company; the thread door after a decision', async () => {
    const calls: { path: string; body: unknown }[] = []
    const api = { post: async (path: string, options: { body?: unknown }) => {
      calls.push({ path, body: options.body })
      return path.endsWith('/complete') ? { file: { id: 'f1', originalName: 'a.pdf', kind: 'ATTACHMENT', sizeBytes: 9, status: 'AVAILABLE', measurementSheet: true } } : { file: { id: 'f1', originalName: 'a.pdf', kind: 'ATTACHMENT', sizeBytes: 9, status: 'PENDING_UPLOAD', measurementSheet: true }, upload: { method: 'PUT', url: '/store/x', headers: {}, expiresAt: '2026-11-17T10:05:00Z' } }
    } } as unknown as ApiClient
    await announceFile(api, 'request', 'inq-1', { originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 9, sha256: 'a'.repeat(64), measurementSheet: true })
    await completeFile(api, 'request', 'inq-1', 'f1')
    await attachFiles(api, 'request', 'inq-1', ['f1'])
    await attachFiles(api, 'thread', 'inq-1', ['f1'])
    expect(calls.map((call) => call.path)).toEqual(['/portal/inquiries/inq-1/files', '/portal/inquiries/inq-1/files/f1/complete', '/portal/inquiries/inq-1/files/attach', '/portal/threads/Inquiry/inq-1/messages'])
    expect(calls[0]!.body).toEqual({ originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 9, sha256: 'a'.repeat(64), measurementSheet: true })
    expect(calls[2]!.body).toEqual({ fileIds: ['f1'] })
    expect(calls[3]!.body).toEqual({ body: '', attachments: ['f1'] })
    expect(JSON.stringify(calls)).not.toMatch(/party|company/i)
  })

  it('the design cases: the tick and the design word, the closed sentence, the receipt’s outcome with Retry — Brand Beta only', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['th-282-files', 'th-282-files-closed', 'th-282-receipt-files']) {
        const html = renderCase(locale, id)
        expect(html.match(KEY)?.[0] ?? null, `${id} (${locale})`).toBeNull()
        expect(scanText(html, BRAND_ALPHA), `${id} (${locale})`).toEqual([])
      }
    }
    const files = renderCase('en', 'th-282-files')
    expect(files).toContain('This is a measurement sheet')
    expect(files).toContain('Kept as it is: download only')
    expect(files).toContain('an SVG, HTML or script file is never accepted: send a PDF or PNG')
    expect(files).toContain('They go right after Send, through the virus scan.')
    expect(renderCase('en', 'th-282-files-closed')).toContain('Uploads from outside are closed for now')
    const receipt = renderCase('en', 'th-282-receipt-files')
    expect(receipt).toContain('1 file sent · 1 held for the virus scan · 1 file did not go')
    expect(receipt).toContain('Retry the file')
    expect(renderCase('it', 'th-282-receipt-files')).toContain('trattenuto per il controllo antivirus')
  })
})
// ---- end B-TH-282

// ---- B-TH-287 (threads plan TH-9, N6; P-CUS-NEW.message-F02; wall W08, W37): the New order draft on the server -----------------------
describe('B-TH-287 — the New order draft saves itself on the server', () => {
  it('reads, saves and discards the person’s ONE New order draft; the body names no person, party or company', async () => {
    const calls: { method: string; path: string; body?: unknown; key?: string }[] = []
    const draft = { recordType: null, recordId: null, audience: null, body: BRAND_BETA.message, fields: { subject: 'Rain jackets' }, attachments: [], savedAt: '2026-11-17T09:42:00.000Z', version: 2 }
    const api = {
      get: async (path: string) => {
        calls.push({ method: 'GET', path })
        return { draft }
      },
      request: async (method: string, path: string, options: { body?: unknown; idempotencyKey?: string }) => {
        calls.push({ method, path, body: options.body, key: options.idempotencyKey })
        return method === 'PUT' ? { draft, replacedNewer: false } : { draft: null }
      },
    } as unknown as ApiClient
    expect(await fetchNewRequestDraft(api)).toEqual(draft)
    await saveNewRequestDraft(api, serverDraftBody({ ...EMPTY_COMPOSE, subject: 'Rain jackets', message: BRAND_BETA.message }, 2), 'key-1')
    await discardNewRequestDraft(api, 'key-2')
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /portal/drafts/new-request', 'PUT /portal/drafts/new-request', 'DELETE /portal/drafts/new-request'])
    expect(calls[1]!.key).toBe('key-1')
    expect(JSON.stringify(calls[1]!.body)).not.toMatch(/partyId|userId|companyId|BRAND-ALPHA|Brand Alpha/)
    expect(calls[1]!.body).toMatchObject({ audience: null, body: BRAND_BETA.message, version: 2 })
  })

  it('the compose says where the draft is: saved on the server, a newer one replaced, not saved · Retry — in Italian and English', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['th9-287-saved', 'th9-287-replaced', 'th9-287-not-saved']) {
        const html = renderCase(locale, id)
        expect(html.match(KEY)?.[0] ?? null, `${id} (${locale})`).toBeNull()
        expect(scanText(html, BRAND_ALPHA), `${id} (${locale})`).toEqual([])
      }
    }
    expect(renderCase('en', 'th9-287-saved')).toMatch(/Draft saved \d{2}:\d{2}/)
    expect(renderCase('it', 'th9-287-saved')).toMatch(/Bozza salvata alle \d{2}[.:]\d{2}/)
    expect(renderCase('en', 'th9-287-replaced')).toContain('A newer draft from another tab or computer was replaced.')
    const notSaved = renderCase('en', 'th9-287-not-saved')
    expect(notSaved).toContain('Not saved — your text stays on this device')
    expect(notSaved).not.toContain('Draft saved')
  })
})
// ---- end B-TH-287

// ---- F-CP-150 (customer page plan C5, D9–D11; 12 §2; picture 22): the draft order page v1 ------------------------------------
describe('F-CP-150 — the draft order page: checklist, held Send, one banner, rows by seq, every state', () => {
  const FACTS = { preview: false, offline: false, busy: false }

  it('od-w1.2 (R1): Still open is information — per row what is not decided yet, and the date; a kind it does not know is left out', () => {
    const record = kindsRecord()
    const rows = productRowsOf(record.request)
    const [first, second] = rows
    const stillOpen = {
      openCount: 4,
      confirmHeld: true,
      items: [
        { kind: 'SIZING', lineId: first!.id, seq: first!.seq, topic: null, state: 'NOT_DECIDED', confirmNeeds: false },
        { kind: 'CHOICE', lineId: first!.id, seq: first!.seq, topic: 'Leather', state: 'NOT_DECIDED', confirmNeeds: false },
        { kind: 'PIECES', lineId: second!.id, seq: second!.seq, topic: null, state: 'NOT_DECIDED', confirmNeeds: true },
        { kind: 'COLOUR', lineId: second!.id, seq: second!.seq, topic: null, state: 'DECIDED', confirmNeeds: true },
        { kind: 'SOMETHING_NEW', lineId: second!.id, seq: second!.seq, topic: null, state: 'NOT_DECIDED', confirmNeeds: false },
        { kind: 'DATE', lineId: null, seq: null, topic: null, state: 'NOT_DECIDED', confirmNeeds: false },
      ],
    }
    const entries = stillOpenEntries(stillOpen, rows, td('en'))
    expect(entries.map((entry) => entry.what)).toEqual(['Sizing · Leather', 'Pieces', null])
    expect(entries.map((entry) => entry.rowId)).toEqual([first!.id, second!.id, null])
    expect(entries[2]!.label).toBe(td('en')('row.date'))
    expect(stillOpenEntries(undefined, rows, td('en'))).toEqual([])
  })

  it('M-CP-2 (R1): a reader without prices gets no price card and no money fact; the shared table has no price for anyone', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['cp150-designer', 'cp150-discard-held', 'cp150-accepted-designer']) expect(renderCase(locale, id), `${id} (${locale})`).not.toMatch(/€|EUR/)
    }
    expect(renderCase('en', 'cp150-designer')).not.toContain(td('en')('price.title'))
    // The row model is price-free: no price key on any row, whoever reads it.
    for (const row of productRowsOf(draftRecord().request)) expect(Object.keys(row).filter((key) => /price|amount|net/i.test(key)), row.id).toEqual([])
  })

  it('the states: empty, partly filled, held (problems, or no right to send), sent, refused, withdrawn, accepted', () => {
    expect(draftStateOf(draftRecord({ lines: [] }).request)).toBe('empty')
    expect(draftStateOf(draftRecord().request)).toBe('partly')
    expect(draftStateOf(draftRecord({ request: { problems: [{ code: 'DATE_PAST', lineId: null, size: null }] } }).request)).toBe('held')
    expect(draftStateOf(draftRecord({ request: { may: { send: false, withdraw: false, discard: true } } }).request)).toBe('held')
    for (const [status, state] of [['SENT', 'sent'], ['REFUSED', 'refused'], ['WITHDRAWN', 'withdrawn'], ['ACCEPTED', 'accepted']] as const) expect(draftStateOf(draftRecord({ request: { status } }).request)).toBe(state)
  })

  it('Send is held, never hidden: a Designer reads who may order; then an invalid value (never a missing one); a preview, offline or saving first', () => {
    const designer = draftRecord({ request: { may: { send: false, withdraw: false, discard: true } } }).request
    expect(draftSendHeld(designer, FACTS, ['Dora Esempio', 'Marta Esempio'])).toEqual({ key: 'draftPage.sendHeld', names: 'Dora Esempio, Marta Esempio' })
    expect(draftSendHeld(designer, FACTS, [])).toEqual({ key: 'draftPage.sendHeldNone' })
    expect(draftSendHeld(designer, { ...FACTS, preview: true }, ['Marta Esempio'])).toEqual({ key: 'held.preview' })
    expect(draftSendHeld(designer, { ...FACTS, offline: true }, [])).toEqual({ key: 'held.offline' })
    const problems = draftRecord({ request: { problems: [{ code: 'DATE_PAST', lineId: null, size: null }, { code: 'NO_SIZES', lineId: null, size: null }] } }).request
    expect(draftSendHeld(problems, FACTS, [])).toEqual({ key: 'held.problems', count: 1 })
    // od-w1.2 (R1): a draft with nothing in it may go — no line, no pieces.
    expect(draftSendHeld(draftRecord({ lines: [], request: { problems: [{ code: 'NO_LINES', lineId: null, size: null }] } }).request, FACTS, [])).toBeNull()
    expect(draftSendHeld(draftRecord({ request: { status: 'SENT' } }).request, FACTS, [])).toEqual({ key: 'held.notDraft' })
    // An answer from before B-CP-070 (no `may`): the Buyer's page as before.
    expect(draftSendHeld(draftRecord().request, FACTS, [])).toBeNull()
    expect(mayOf({})).toEqual({ send: true, withdraw: false, discard: true })
    for (const locale of ['it', 'en'] as const) {
      expect(t(locale)('draftPage.sendHeld', { names: 'Marta Esempio' })).toContain('Marta Esempio')
      expect(td(locale)('head.shared'), `head.shared ${locale}`).not.toMatch(/^head\.|\{/)
      for (const key of ['draftPage.sendHeldNone', 'draftPage.discardHeld', 'draftPage.reorderHeld']) expect(t(locale)(key), `${key} ${locale}`).not.toMatch(/^draftPage\.|\{/)
    }
    // od-w1.2 (S1-B3): the factory reads it from the first save — never "work starts only when you send it".
    expect(td('en')('head.shared')).toBe('The factory reads this draft from the first save.')
    expect(td('it')('head.shared')).toBe('La fabbrica legge questa bozza dal primo salvataggio.')
  })

  it('who may send it: the active buyers and admins of the reader’s own organisation, never the reader; else its admins', () => {
    const people = [
      { id: 'u1', displayName: 'Marta Esempio', status: 'ACTIVE', roleKey: 'customer-admin', admin: true },
      { id: 'u2', displayName: 'Dora Esempio', status: 'ACTIVE', roleKey: 'customer-buyer', admin: false },
      { id: 'u3', displayName: 'Luca Esempio', status: 'ACTIVE', roleKey: 'customer-designer', admin: false },
      { id: 'u4', displayName: 'Ugo Esempio', status: 'SUSPENDED', roleKey: 'customer-buyer', admin: false },
      { id: 'me', displayName: 'Io Esempio', status: 'ACTIVE', roleKey: 'customer-buyer', admin: false },
    ]
    expect(whoMayOrder(people, 'me', ['Marta Esempio'])).toEqual(['Dora Esempio', 'Marta Esempio'])
    expect(whoMayOrder(null, 'me', ['Marta Esempio'])).toEqual(['Marta Esempio'])
    expect(whoMayOrder([], 'me', [])).toEqual([])
  })

  it('Discard… is held for one who neither orders nor started the draft, and in a preview; Reorder for an access without orders', () => {
    expect(draftDiscardHeld(draftRecord({ request: { may: { send: false, withdraw: false, discard: false } } }).request, FACTS)).toBe('draftPage.discardHeld')
    expect(draftDiscardHeld(draftRecord({ request: { may: { send: false, withdraw: false, discard: true } } }).request, FACTS)).toBeNull()
    expect(draftDiscardHeld(draftRecord().request, { ...FACTS, preview: true })).toBe('held.preview')
    expect(reorderHeldKey(false)).toBe('draftPage.reorderHeld')
    expect(reorderHeldKey(true)).toBeNull()
  })

  it('a 409 keeps what was typed: ONE banner says the draft changed and who changed it (once the API names them)', () => {
    expect(draftBannerOf({ offline: false, stale: true, refused: true, notice: true, problems: 2 })).toBe('stale')
    expect(draftBannerOf({ offline: true, stale: true, refused: true, notice: true, problems: 2 })).toBe('offline')
    expect(draftBannerOf({ offline: false, stale: false, refused: true, notice: true, problems: 2 })).toBe('refused')
    expect(draftBannerOf({ offline: false, stale: false, refused: false, notice: true, problems: 2 })).toBe('notice')
    expect(draftBannerOf({ offline: false, stale: false, refused: false, notice: false, problems: 2 })).toBe('problems')
    expect(draftBannerOf({ offline: false, stale: false, refused: false, notice: false, problems: 0 })).toBeNull()
    const html = renderCase('en', 'cp150-stale')
    expect(html).toContain('This draft changed elsewhere')
    expect(html).toContain('Changed by Marta Esempio a moment ago.')
    // One banner: the refusal words of the same 409 are not drawn beside it.
    expect(renderCase('en', 'draft-stale')).not.toContain(t('en')('refusal.conflict'))
  })

  it('rows keep their seq: lines are drawn and named by seq, never by the order they were read in', () => {
    const one = lineOf(1)
    const two = { ...LINE_TROUSERS(), seq: 2 }
    expect(linesInOrder([two, one]).map((line) => line.seq)).toEqual([1, 2])
    expect(draftTitleOf({ lines: [two, one] }, td('en'))).toBe(`${one.style.code} ${one.style.name}`)
    // od-w1.2 (R2): the subject names the draft first; nothing names it: "Draft order {date}".
    expect(draftTitleOf({ lines: [two, one], subject: ' Race team kit ' }, td('en'))).toBe('Race team kit')
    expect(draftTitleOf({ lines: [], createdAt: '2026-11-18T10:00:00Z' }, td('en'), 'en', () => '18/11/2026')).toBe('Draft order 18/11/2026')
    expect(draftTitleOf({ lines: [], createdAt: '2026-11-18T10:00:00Z' }, td('it'), 'it', () => '18/11/2026')).toBe('Bozza d’ordine del 18/11/2026')
    // Drawn: the draft's case with its lines read in the other order — line 1 is still above line 2.
    const build = newOrderScreen.cases.find((entry) => entry.id === 'draft')!.model as OrderingCaseBuilder
    const swapped: OrderingCaseBuilder = (locale) => {
      const built = build(locale)
      return built.body.kind === 'neworder' ? { ...built, body: { ...built.body, model: { ...built.body.model, record: draftRecord({ lines: [two, one] }) } } } : built
    }
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'portal']) }, createElement(OrderingCase, { model: swapped })))
    expect(html.indexOf(`row-${one.id}`)).toBeGreaterThan(-1)
    expect(html.indexOf(`row-${one.id}`)).toBeLessThan(html.indexOf(`row-${two.id}`))
  })

  it('saved (R1): your own save "Draft saved 10:42", a colleague by name, any office save "by the factory" — never a worker’s name', () => {
    const time = () => '10:42'
    const at = { updatedAt: '2026-11-19T09:42:00Z', lastEditedAt: null }
    expect(savedByWords({ ...at, lastEditedBy: null }, td('en'), time)).toBe('Draft saved 10:42')
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'YOU', name: 'Bea Esempio' } }, td('en'), time)).toBe('Draft saved 10:42')
    expect(savedByWords({ ...at, lastEditedBy: 'Marta Esempio' }, td('en'), time)).toBe('Saved 10:42 by Marta Esempio')
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'COLLEAGUE', name: 'Marta Esempio' } }, td('it'), time)).toBe('Salvata alle 10:42 da Marta Esempio')
    // W2: an office save reads "the factory" (own Italian form "dalla fabbrica"), even if a name came along.
    expect(savedByWords({ ...at, lastEditedBy: 'Sam Example', savedBy: { who: 'FACTORY', name: 'Sam Example' } }, td('en'), time)).toBe('Saved 10:42 by the factory')
    expect(savedByWords({ ...at, lastEditedBy: null, savedBy: { who: 'FACTORY', name: null } }, td('it'), time)).toBe('Salvata alle 10:42 dalla fabbrica')
  })

  it('a draft no longer a draft leads where the reader may go: its order or Orders, or — no orders in the access — who follows it', () => {
    expect(closedOf('ACCEPTED', true)).toEqual({ body: 'closed.ACCEPTED', open: 'order', startNew: false })
    expect(closedOf('ACCEPTED', false)).toEqual({ body: 'draftPage.acceptedNoOrders', open: null, startNew: false })
    expect(closedOf('REFUSED', true)).toEqual({ body: 'closed.REFUSED', open: 'orders', startNew: true })
    expect(closedOf('REFUSED', false)).toEqual({ body: 'draftPage.refusedNoOrders', open: null, startNew: true })
    expect(closedOf('SENT', false)).toEqual({ body: 'draftPage.sentNoOrders', open: null, startNew: false })
    expect(closedOf('WITHDRAWN', true)).toEqual({ body: 'closed.WITHDRAWN', open: null, startNew: true })
    const designer = renderCase('en', 'cp150-accepted-designer')
    expect(designer).toContain('The factory made it an order: your buyer follows it.')
    expect(designer).not.toContain('/orders/0194f0e2-1940-7000-8000-000000000777')
    expect(renderCase('en', 'cp150-refused')).toContain('Start a new draft')
  })

  it('the page: the factory reads the draft (said), its conversation docked, keys in one information icon, every case in it and en', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['draft', 'cp150-designer', 'cp150-saved-by', 'cp150-later', 'cp150-narrow', 'cp150-offline', 'cp150-sent', 'cp150-refused', 'cp150-withdrawn']) {
        const html = renderCase(locale, id)
        expect(html.match(KEY)?.[0] ?? null, `${id} (${locale})`).toBeNull()
        expect(html, `${id} (${locale})`).toContain('id="messages"')
      }
      const draft = renderCase(locale, 'draft')
      expect(draft).toContain(td(locale)('head.shared'))
      // od-w1.2 (R1): the mail, the products table, Date and delivery, Still open, the portal's own cards (a price holder's Your price).
      for (const key of ['mail.subject', 'mail.message', 'mail.attachments', 'tbl.title', 'date.title', 'still.title', 'send.title', 'price.title']) expect(draft, `${key} (${locale})`).toContain(td(locale)(key))
      expect(draft).not.toContain('fw-od-chiptop')
      expect(draft).toContain('fw-list-keys-trigger')
    }
    expect(renderCase('en', 'cp150-saved-by')).toContain('by Marta Esempio')
    // The start draws no conversation.
    expect(renderCase('en', 'start')).not.toContain('id="messages"')
  })
})
// ---- end F-CP-150

// ---- F-CP-151 (customer page plan C5; 12 §2 parts 2–4; D14): the draft's files cards --------------------------------------------
describe('F-CP-151 — the draft’s files: logos, references, measurement sheets; the e-mail way while uploads are closed', () => {
  const file = (over: Record<string, unknown> = {}) => ({ id: 'f1', lineId: null, originalName: 'logo-front.ai', kind: 'DOCUMENT', contentType: 'application/postscript', sizeBytes: 9, status: 'AVAILABLE', version: 1, createdAt: '2026-11-19T09:00:00Z', ...over })
  const FACTS = { preview: false, offline: false, busy: false }

  it('closed-gate words: files go up only where the API says so; on live the cards say to e-mail them, naming the draft (it, en)', () => {
    expect(uploadsOpenOf({})).toBe(false)
    expect(uploadsOpenOf({ uploads: { open: false, words: 'closed' } })).toBe(false)
    expect(uploadsOpenOf({ uploads: { open: true, words: null } })).toBe(true)
    expect(draftMailName({ customerRef: 'BA-PO-4521', lines: [] }, td('en'))).toBe('BA-PO-4521')
    expect(draftMailName({ customerRef: null, lines: [] }, td('en'))).toBe('Draft order')
    expect(draftMailName({ customerRef: null, lines: [], subject: 'Race team kit' }, td('en'))).toBe('Race team kit')
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'cp151-closed')
      expect(html, locale).toContain(td(locale)('draftPage.files.closed', { draft: 'BA-PO-4521' }))
      // The API's English sentence is never drawn; no drop area while closed.
      expect(html, locale).not.toContain('Uploads from outside are closed for now.')
      expect(html, locale).not.toContain('nds-dropzone')
      expect(html.match(KEY)?.[0] ?? null, locale).toBeNull()
    }
  })

  it('cap 50: the 51st file is held with words; a preview or offline holds every file first', () => {
    expect(DRAFT_FILES_MAX).toBe(50)
    const files = (count: number) => ({ logos: [], references: Array.from({ length: count }, (_, index) => file({ id: `r${index}` })), sheets: [] })
    expect(draftFileCount({ files: files(49) })).toBe(49)
    expect(filesAddHeld({ files: files(49) }, FACTS)).toBeNull()
    expect(filesAddHeld({ files: files(50) }, FACTS)).toBe('draftPage.files.full')
    expect(filesAddHeld({ files: files(0) }, { ...FACTS, preview: true })).toBe('held.preview')
    expect(filesAddHeld({}, { ...FACTS, offline: true })).toBe('held.offline')
    expect(renderCase('en', 'cp151-full')).toContain('This draft already holds 50 files')
  })

  it('od-w1.2 (R1): nothing is required, so nothing needs a "later" — no "Sending later" toggle, whatever the draft keeps', () => {
    for (const id of ['cp151-later', 'cp151-files']) {
      expect(renderCase('en', id), id).not.toContain('We send these later')
      expect(renderCase('en', id), id).not.toContain('Sending later')
    }
  })

  it('each file says what it is; a file waiting for the virus scan says so; a locked sheet without its name still reads', () => {
    expect(fileKindOf(file())).toBe('vector')
    expect(fileKindOf(file({ originalName: null, locked: true }))).toBe('vector')
    expect(fileKindOf(file({ originalName: 'stripes.pdf', contentType: 'application/pdf' }))).toBe('vector')
    expect(fileKindOf(file({ originalName: 'sponsor.png', contentType: 'image/png', kind: 'PHOTO' }))).toBe('picture')
    expect(fileKindOf(file({ originalName: 'brief.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))).toBe('document')
    expect(fileHeldKey(file())).toBeNull()
    expect(fileHeldKey(file({ status: 'QUARANTINED' }))).toBe('draftPage.files.scanning')
    // od-w1.2 (R2): the mail's ONE Attachments box — the draft's own files, each saying what it is; a logo carries the Logo mark.
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'cp151-files')
      expect(html, locale).toContain(td(locale)('mail.attachments'))
      expect(html, locale).toContain(td(locale)('draftPage.files.kind.vector'))
      expect(html, locale).toContain(td(locale)('mail.logo'))
      expect(html.match(KEY)?.[0] ?? null, locale).toBeNull()
    }
    const uploading = renderCase('en', 'cp151-uploading')
    expect(uploading).toContain('Uploading…')
    expect(uploading).toContain('Not uploaded:')
  })

  it('W-CP-1 / W-CP-3: a file goes onto the session’s own draft by its id (and its line’s) only — never a party or a company', async () => {
    const calls: { method: string; path: string; body?: unknown; query?: unknown }[] = []
    const answer = { file: file({ status: 'PENDING_UPLOAD' }), upload: { method: 'PUT', url: '/store/x', headers: {}, expiresAt: '2026-11-19T10:05:00Z' } }
    const api = {
      post: async (path: string, options: { body?: unknown }) => {
        calls.push({ method: 'POST', path, body: options.body })
        return path.endsWith('/complete') ? { file: file() } : answer
      },
      request: async (method: string, path: string, options: { query?: unknown }) => {
        calls.push({ method, path, query: options.query })
        return draftRecord()
      },
    } as unknown as ApiClient
    await announceDraftFile(api, 'd1', { part: 'LOGO', lineId: 'l2', originalName: 'logo-front.ai', contentType: 'application/postscript', sizeBytes: 9, sha256: 'a'.repeat(64) })
    await completeDraftFile(api, 'd1', 'f1')
    await removeDraftFile(api, 'd1', 'f1', 3)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /portal/order-requests/d1/files', 'POST /portal/order-requests/d1/files/f1/complete', 'DELETE /portal/order-requests/d1/files/f1'])
    expect(calls[0]!.body).toEqual({ part: 'LOGO', lineId: 'l2', originalName: 'logo-front.ai', contentType: 'application/postscript', sizeBytes: 9, sha256: 'a'.repeat(64) })
    expect(calls[2]!.query).toEqual({ version: 3 })
    expect(JSON.stringify(calls)).not.toMatch(/party|company/i)
  })
})
// ---- end F-CP-151

// ---- F-CP-152 (customer page plan C5, 12 §2 Doors): /orders/new opens the draft start; "Just write it in words" → door A ---------
describe('F-CP-152 — the doors: /orders/new is the draft order for who keeps drafts; ?way=words is the request like an e-mail', () => {
  const q = (text: string) => new URLSearchParams(text)

  it('which page /orders/new opens', () => {
    expect(WORDS_WAY).toBe('words')
    expect(wordsHref('/p/X')).toBe('/p/X/orders/new?way=words')
    // Who keeps drafts: the draft start with no term; a draft, a way, a past order: the draft order.
    expect(newOrderDoorOf(q(''), { mayDraft: true })).toBe('draft')
    for (const text of ['draft=d1', 'way=pick', 'way=reorder', 'way=upload', 'reorder=o1', 'way=pick&styles=abc']) expect(newOrderDoorOf(q(text), { mayDraft: true }), text).toBe('draft')
    // "Just write it in words", and who may order but keeps no drafts: the request like an e-mail.
    expect(newOrderDoorOf(q('way=words'), { mayDraft: true })).toBe('words')
    expect(newOrderDoorOf(q(''), { mayDraft: false })).toBe('words')
    expect(opensCatalogueDoor(q('way=words'))).toBe(false)
    // The catalogue door closed: always the e-mail.
    expect(newOrderDoorOf(q('draft=d1'), { mayDraft: true }, false)).toBe('words')
  })

  it('od-w1.2 (R1): the start is a mail — nothing required, no Start button, "Add from" the three ways; no words door from it; a Designer reads Reorder held with why', () => {
    for (const locale of ['it', 'en'] as const) {
      const buyer = renderCase(locale, 'start')
      expect(buyer).not.toContain('way=words')
      for (const key of ['mail.nothing', 'mail.subject', 'mail.message', 'mail.attachments', 'tbl.title', 'add.product', 'add.from', 'add.catalogue', 'add.pastOrder', 'add.sheet', 'save.notYet']) expect(buyer, `${key} (${locale})`).toContain(td(locale)(key).replace(/’/g, '&#x27;').replace(/'/g, '&#x27;'))
      expect(buyer).not.toContain(locale === 'en' ? 'How do you want to order?' : 'Come volete ordinare?') // the old start's title (the way cards) is gone
      expect(buyer).not.toContain('id="messages"')
      const designer = renderCase(locale, 'cp152-start-designer')
      expect(designer).not.toContain('way=words')
      expect(designer).toContain(t(locale)('draftPage.reorderHeld'))
      expect(designer.match(KEY)?.[0] ?? null, locale).toBeNull()
    }
  })
})
// ---- end F-CP-152

// ---- F-CP-154 (customer page plan C5; 12 §2 parts 1, 4, 6; review A5, E4, G6; 11 §1.3 D3): lines of every kind, the People and
// sizes roster, "Your price" ---------------------------------------------------------------------------------------------------------
describe('F-CP-154 — lines of every kind, the People and sizes roster, Your price', () => {
  const FACTS = { preview: false, offline: false, busy: false }

  it('follow-up 7: a draft holding described and made-to-measure lines parses — the new problem codes, their part and person', () => {
    expect([...PROBLEM_CODES]).toEqual([...DOMAIN_PROBLEMS])
    for (const code of ['NO_TOTAL', 'SIZES_NOT_TOTAL', 'NO_PEOPLE', 'MTM_CLOSED', 'GARMENT_TYPE_GONE']) expect(PROBLEM_CODES, code).toContain(code)
    const record = kindsRecord({ request: { problems: [{ code: 'SIZE_NOT_OFFERED', lineId: mtmLine().id, size: '62', part: 'PEOPLE', personId: RIDERS()[1]!.id }] } })
    const parsed = recordSchema.parse({ ...record, request: { ...record.request, customLines: [...(record.request.customLines ?? [])] } })
    expect(parsed.request.customLines?.map((line) => line.kind)).toEqual(['DESCRIBED', 'MADE_TO_MEASURE'])
    expect(parsed.request.problems[0]).toMatchObject({ part: 'PEOPLE', personId: RIDERS()[1]!.id })
    // An answer from before B-CP-075 (no part, no person, no custom lines) still parses.
    expect(recordSchema.parse(draftRecord()).request.customLines).toBeUndefined()
  })

  it('kinds: one list by seq, each kind in words (it, en); the title from the first line of any kind; one table row each (R1)', () => {
    const record = kindsRecord()
    expect(entriesInOrder(record.request).map((entry) => [entry.line.seq, entry.kind])).toEqual([
      [1, 'CATALOGUE'],
      [2, 'DESCRIBED'],
      [3, 'MADE_TO_MEASURE'],
    ])
    // Read in another order: still by seq (a row never jumps).
    const swapped = { lines: record.request.lines, customLines: [mtmLine(), describedLine()] }
    expect(entriesInOrder(swapped).map((entry) => entry.line.seq)).toEqual([1, 2, 3])
    expect(td('en')(kindKey('CATALOGUE'))).toBe('From the catalogue')
    expect(td('en')(kindKey('DESCRIBED'))).toBe('Described by you')
    expect(td('en')(kindKey('MADE_TO_MEASURE'))).toBe('Made to measure')
    expect(td('it')(kindKey('DESCRIBED'))).toBe('Descritto da voi')
    expect(td('it')(kindKey('MADE_TO_MEASURE'))).toBe('Su misura')
    expect(draftTitleOf({ lines: [], customLines: [describedLine({ seq: 1 })] }, td('en'))).toBe('Maglietta box a maniche corte, rossa e bianca come il rifer…')
    expect(draftTitleOf({ lines: [], customLines: [mtmLine({ seq: 1 })] }, td('en'), 'en')).toBe('One-piece race suit')
    // od-w1.2 (R1): a row whose product is not decided yet says so; one table row per line of any kind, its pieces in words.
    expect(customTitleOf({ style: null, description: null, garmentType: null }, td('it'))).toBe('Non ancora deciso')
    const rows = productRowsOf(record.request, 'en')
    expect(rows.map((row) => [row.seq, row.catalogue, row.sizing])).toEqual([
      [1, true, null],
      [2, false, null],
      [3, false, 'MADE_TO_MEASURE'],
    ])
    expect(rowPiecesWords(rows[1]!.pieces, td('en'), String)).toEqual({ main: '30 pieces', sizes: null })
    expect(rowPiecesWords(rows[2]!.pieces, td('en'), String)).toEqual({ main: '4 people', sizes: null })
    expect(rowPiecesWords({ mode: 'NONE' }, td('en'), String)).toBeNull()
    expect(rowPiecesWords({ mode: 'SIZES', total: 30, sizes: [{ size: 'S', quantity: 10 }, { size: 'M', quantity: 20 }] }, td('en'), String)).toEqual({ main: '30 pieces', sizes: 'S × 10 · M × 20' })
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'cp154-kinds')
      for (const key of ['cell.catalogue', 'siz.MADE_TO_MEASURE']) expect(html, `${key} ${locale}`).toContain(td(locale)(key))
      expect(html.match(KEY)?.[0] ?? null, locale).toBeNull()
      expect(html).toContain(`id="row-${describedLine().id}"`)
      expect(html).toContain(`id="row-${mtmLine().id}"`)
    }
  })

  it('made to measure is open by default; “not open for you yet” only where the office switched it off — held, never hidden', () => {
    expect(mtmOf({ status: 'DRAFT' }).open).toBe(true)
    expect(mtmOf({ status: 'DRAFT', madeToMeasure: { open: true, words: null, garmentTypes: [] } }).open).toBe(true)
    expect(mtmOf({ status: 'DRAFT', madeToMeasure: { open: false, words: { it: 'x', en: 'x' }, garmentTypes: [] } }).open).toBe(false)
    expect(mtmOf({ status: 'SENT', madeToMeasure: null }).open).toBe(false)
    expect(td('en')('draftPage.mtmOff')).toBe('Made to measure is not open for you yet: ask us in the messages.')
    expect(td('it')('draftPage.mtmOff')).toBe('Il su misura non è ancora aperto per voi: chiedeteci nei messaggi.')
    // The problem of an existing made-to-measure line says the same words; the open draft never says them.
    const closed = kindsRecord({ request: { madeToMeasure: { open: false, words: null, garmentTypes: [] } } })
    expect(problemWords({ code: 'MTM_CLOSED', lineId: mtmLine().id, size: null }, closed.request.lines, dkit('en'), closed.request.customLines)).toBe(td('en')('draftPage.mtmOff'))
    expect(renderCase('en', 'cp154-mtm-off')).toContain(td('en')('draftPage.mtmOff'))
    expect(renderCase('en', 'cp154-kinds')).not.toContain(td('en')('draftPage.mtmOff'))
  })

  it('a custom line’s problems in our words, from codes and figures; “Show me” goes to the line, its roster or the person', () => {
    const custom = [describedLine({ quantity: 30, sizes: [{ size: 'S', quantity: 10 }, { size: 'M', quantity: 12 }] }), mtmLine()]
    expect(problemWords({ code: 'SIZES_NOT_TOTAL', lineId: describedLine().id, size: null }, [], dkit('en'), custom)).toBe('The sizes add up to 22 pieces, the total says 30.')
    expect(problemWords({ code: 'GARMENT_TYPE_GONE', lineId: mtmLine().id, size: null }, [], { ...dkit('it'), locale: 'it' }, custom)).toBe('Il su misura Tuta intera da corsa non è più offerto: scegliete un altro tipo di capo.')
    expect(problemWords({ code: 'NO_PEOPLE', lineId: mtmLine().id, size: null }, [], dkit('en'), custom)).toBe('Name the people, or attach their measurement sheet.')
    for (const locale of ['it', 'en'] as const) for (const code of ['NO_TOTAL', 'SIZES_NOT_TOTAL', 'NO_PEOPLE', 'MTM_CLOSED', 'GARMENT_TYPE_GONE'] as const) expect(problemWords({ code, lineId: null, size: null }, [], dkit(locale)), `${code} ${locale}`).not.toMatch(/draftPage\.|\{/)
    expect(problemPlace({ code: 'SIZE_NOT_OFFERED', lineId: 'l3', size: '62', personId: 'p2' })).toBe('person-p2')
    expect(problemPlace({ code: 'NO_PEOPLE', lineId: 'l3', size: null })).toBe('people-l3')
    expect(problemPlace({ code: 'NO_TOTAL', lineId: 'l2', size: null })).toBe('line-l2')
  })

  it('the roster: Size · Measurement sheet · Sending later only (no saved measurements in v1), rows by seq, what is there in words', () => {
    expect([...MEASURES]).toEqual([...DOMAIN_MEASURES])
    expect(MEASURES).not.toContain('PROFILE')
    expect(MEASURES.map((measure) => td('en')(`draftPage.measure.${measure}`))).toEqual(['Size', 'Measurement sheet', 'Sending later'])
    expect(MEASURES.map((measure) => td('it')(`draftPage.measure.${measure}`))).toEqual(['Taglia', 'Scheda misure', 'Le mandiamo dopo'])
    const [andrea, luca, tommaso] = RIDERS()
    expect(personWhat(andrea!, td('en'))).toBe(SHEET_ON_MTM.originalName)
    expect(personWhat(luca!, td('en'))).toBe('50')
    expect(personWhat(tommaso!, td('en'))).toBe('Sending later')
    expect(personWhat({ measureBy: 'SHEET', size: null, sheet: null }, td('en'))).toBe('a sheet no longer on the draft')
    // od-w1.2 (R3): the roster lives in the row's Pieces window (a custom size is by person).
    const html = renderCase('en', 'od-pieces')
    for (const rider of RIDERS()) expect(html).toContain(rider.name)
    expect(html.indexOf('Andrea Esempio')).toBeLessThan(html.indexOf('Nico Esempio'))
    expect(html).toContain(`id="person-${andrea!.id}"`)
    expect(html).toContain(`id="people-${mtmLine().id}"`)
    expect(html).toContain('Add a person')
    expect(html).not.toMatch(/Saved measurements|Misure salvate/)
  })

  it('a person’s window: held at its fields by the API’s limits; the body sends only the field of its way; a change clears the other', () => {
    expect(personProblems(EMPTY_PERSON, [])).toEqual({ name: 'draftPage.person.problem.name', size: 'draftPage.person.problem.size' })
    expect(personProblems({ ...EMPTY_PERSON, name: 'Ada Esempio', measureBy: 'SHEET', sheetId: 'nope' }, [SHEET_ON_MTM])).toEqual({ sheet: 'draftPage.person.problem.sheet' })
    expect(personProblems({ ...EMPTY_PERSON, name: 'Ada Esempio', measureBy: 'SHEET', sheetId: SHEET_ON_MTM.id }, [SHEET_ON_MTM])).toEqual({})
    expect(personProblems({ ...EMPTY_PERSON, name: 'Ada Esempio', number: '12345678901', measureBy: 'LATER' }, [])).toEqual({ number: 'draftPage.person.problem.number' })
    expect(personBody({ ...EMPTY_PERSON, name: ' Ada Esempio ', number: '', measureBy: 'SIZE', size: ' 52 ', sheetId: SHEET_ON_MTM.id })).toEqual({ name: 'Ada Esempio', measureBy: 'SIZE', size: '52' })
    expect(personBody({ ...EMPTY_PERSON, name: 'Ada Esempio', number: '7', measureBy: 'SHEET', size: '52', sheetId: SHEET_ON_MTM.id })).toEqual({ name: 'Ada Esempio', number: '7', measureBy: 'SHEET', measurementFileId: SHEET_ON_MTM.id })
    expect(personBody({ ...EMPTY_PERSON, name: 'Ada Esempio', measureBy: 'LATER', size: '52' })).toEqual({ name: 'Ada Esempio', measureBy: 'LATER' })
    const luca = RIDERS()[1]!
    expect(personChanges(luca, personDraftOf(luca))).toEqual({})
    expect(personChanges(luca, { ...personDraftOf(luca), size: '52' })).toEqual({ size: '52' })
    expect(personChanges(luca, { ...personDraftOf(luca), measureBy: 'LATER' })).toEqual({ measureBy: 'LATER', size: null, measurementFileId: null })
    expect(personChanges(luca, { ...personDraftOf(luca), measureBy: 'SHEET', sheetId: SHEET_ON_MTM.id })).toEqual({ measureBy: 'SHEET', size: null, measurementFileId: SHEET_ON_MTM.id })
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['cp154-person', 'cp154-person-change']) expect(renderCase(locale, id).match(KEY)?.[0] ?? null, `${id} ${locale}`).toBeNull()
    }
    // The window's words (the DS Modal draws only once hydrated, so its words are checked here, not in the static page).
    expect(td('en')(personProblems({ ...EMPTY_PERSON, name: 'Luca Esempio' }, []).size!)).toBe('Give the size (up to 40 characters).')
    expect(td('it')('draftPage.person.titleAdd', { seq: 3 })).toBe('Aggiungete una persona alla riga 3')
  })

  it('review A5: a by-person line whose people are in the measurement sheet on it counts — “People: in the attached sheet”', () => {
    const sheetOnly = kindsRecord({ custom: [describedLine(), mtmLine({ people: [], peopleInSheet: true, pieces: 0 })] })
    const row = productRowsOf(sheetOnly.request).find((entry) => entry.id === mtmLine().id)!
    expect(row.pieces).toEqual({ mode: 'PEOPLE', people: 0, inSheet: true })
    expect(rowPiecesWords(row.pieces, td('en'), String)).toEqual({ main: td('en')('draftPage.line.inSheet'), sizes: null })
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'cp154-sheet-only')
      expect(html, locale).toContain(td(locale)('draftPage.line.inSheet'))
      expect(html.match(KEY)?.[0] ?? null, locale).toBeNull()
    }
    // No one named and no sheet (od-w1.2, R1): said on the row, never a hold on Send — a missing piece is not an invalid one.
    const empty = kindsRecord({ custom: [describedLine(), mtmLine({ people: [], pieces: 0, problems: [{ code: 'NO_PEOPLE', lineId: mtmLine().id, size: null, personId: null }] })], request: { files: { logos: [], references: [], sheets: [] }, problems: [{ code: 'NO_PEOPLE', lineId: mtmLine().id, size: null, personId: null }] } })
    expect(draftSendHeld(empty.request, FACTS, [])).toBeNull()
    expect(renderCase('en', 'cp154-no-people')).toContain(td('en')('draftPage.problem.NO_PEOPLE'))
    // A described line with no total yet: its pieces are "Not decided yet".
    expect(productRowsOf(kindsRecord({ custom: [describedLine({ quantity: null, pieces: 0 })] }).request).find((entry) => entry.id === describedLine().id)!.pieces).toEqual({ mode: 'NONE' })
  })

  it('review G6: the People card says the riders’ names and measures are personal data — in it and en, for every reader', () => {
    expect(td('en')('draftPage.roster.privacy')).toContain('personal data')
    expect(td('it')('draftPage.roster.privacy')).toContain('dati personali')
    // od-w1.2 (R3): said in the row's Pieces window, where the people are typed.
    for (const locale of ['it', 'en'] as const) expect(renderCase(locale, 'od-pieces'), locale).toContain(td(locale)('draftPage.roster.privacy'))
  })

  it('Your price by role: the customer’s Buyer, Finance and Admin type it; Designer, Production and Viewer never see a price (M-CP-2)', () => {
    const seesOf = (key: string) => partnerTemplateOf(key)!.grains.includes('price')
    const roles = { 'customer-buyer': 'edit', 'customer-finance': 'edit', 'customer-admin': 'edit', 'customer-designer': 'none', 'customer-production': 'none', 'customer-viewer': 'none' } as const
    for (const [key, access] of Object.entries(roles)) {
      expect(yourPriceAccess(seesOf(key), null), key).toBe(access)
      const record = kindsRecord({ seesPrices: seesOf(key) })
      // A reader without the grain never sends the key (the grain filter would refuse the body).
      expect(ownPriceWriteOf(record, describedLine().id, '20'), key).toEqual(access === 'edit' ? { lineKind: 'CUSTOM', value: '20' } : null)
    }
    // A price holder in a preview, offline or on a sent draft reads it.
    expect(yourPriceAccess(true, 'Offline')).toBe('read')
    for (const locale of ['it', 'en'] as const) {
      const admin = renderCase(locale, 'cp154-kinds')
      expect(admin, locale).toContain(td(locale)('price.yours'))
      expect(admin, locale).toContain(t(locale)('draftPage.price.cell', { seq: 2 }))
      const designer = renderCase(locale, 'cp154-designer')
      expect(designer, locale).not.toMatch(/€|EUR/)
      expect(designer, locale).not.toContain(td(locale)('price.yours'))
      expect(designer, locale).not.toContain(td(locale)('price.title'))
      expect(designer.match(KEY)?.[0] ?? null, locale).toBeNull()
    }
    expect(td('en')('price.yours')).toBe('Your price (without VAT)')
    expect(td('it')('price.yours')).toBe('Il vostro prezzo (IVA esclusa)')
  })

  it('Your price: typed the customer’s way, the API’s decimal; our list price beside it on catalogue lines only; the total', () => {
    expect(ownPriceOf('18,50')).toEqual({ value: '18.50' })
    expect(ownPriceOf(' € 18.5 ')).toEqual({ value: '18.5' })
    expect(ownPriceOf('1.250,00')).toEqual({ value: '1250.00' })
    expect(ownPriceOf('1,250.00')).toEqual({ value: '1250.00' })
    expect(ownPriceOf('')).toEqual({ value: null })
    for (const bad of ['abc', '-1', '1.1234567', '12,3,4']) expect(ownPriceOf(bad), bad).toEqual({ problem: 'draftPage.price.problem' })
    const record = kindsRecord()
    expect(ownPriceWriteOf(record, describedLine().id, '18,50')).toBeNull() // the price it holds: nothing to write
    expect(ownPriceWriteOf(record, record.request.lines[0]!.id, '400')).toEqual({ lineKind: 'CATALOGUE', value: '400' })
    expect(ownPriceWriteOf(record, mtmLine().id, '')).toEqual({ lineKind: 'CUSTOM', value: null })
    expect(ownPriceWriteOf(record, mtmLine().id, 'abc')).toEqual({ problem: 'draftPage.price.problem' })
    const rows = priceRowsOf(record.request, t('en'), 'en')
    expect(rows.map((row) => [row.seq, row.kind, row.ours, row.yours])).toEqual([
      [1, 'CATALOGUE', '410.00', '410.00'],
      [2, 'DESCRIBED', null, '18.50'],
      [3, 'MADE_TO_MEASURE', null, '640.00'],
    ])
    // 18 × 410 + 30 × 18.50 + 4 × 640 = 7380 + 555 + 2560.
    expect(ownTotalOf(rows)).toEqual({ total: '10495.00', missing: 0 })
    expect(ownTotalOf(rows, { [describedLine().id]: '19,90' })).toEqual({ total: '10537.00', missing: 0 })
    expect(ownTotalOf(rows, { [mtmLine().id]: '' })).toEqual({ total: null, missing: 1 })
    const typed = renderCase('en', 'cp154-price-typed')
    expect(typed).toContain('A price of 0 or more, with up to 6 decimals.')
    expect(typed).toContain('1 line still without your price')
  })

  it('od-w1.2 (R3): a row’s windows — Pieces by the row’s sizing; Options held at their fields, names only, "Not decided yet" an answer', () => {
    const rows = productRowsOf(kindsRecord().request)
    expect(piecesModesOf(rows[0]!)).toEqual(['SIZES', 'NONE'])
    expect(piecesModesOf(rows[1]!)).toEqual(['TOTAL', 'PEOPLE', 'NONE'])
    expect(piecesModesOf(rows[2]!)).toEqual(['PEOPLE'])
    expect(choicesTyped(' Cowhide \n\nKangaroo\nCowhide\n')).toEqual(['Cowhide', 'Kangaroo'])
    expect(choicesTyped('a\nb\nc\nd\ne\nf\ng')).toHaveLength(6)
    const leather = { topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null }
    expect(optionHeld([], '', 'Cowhide\nKangaroo')).toBe('opt.needTopic')
    expect(optionHeld([], 'Leather', 'Cowhide')).toBe('opt.needChoices')
    expect(optionHeld([leather], ' leather ', 'A\nB')).toBe('opt.twice')
    expect(optionHeld(Array.from({ length: 10 }, (_, index) => ({ ...leather, topic: `T${index}` })), 'Protection class', 'AA\nAAA')).toBe('opt.full')
    expect(optionHeld([leather], 'Protection class', 'AA\nAAA')).toBeNull()
    for (const locale of ['it', 'en'] as const) {
      for (const key of ['opt.needTopic', 'opt.needChoices', 'opt.twice', 'opt.full']) expect(td(locale)(key), `${key} ${locale}`).not.toMatch(/^opt\.|\{/)
      for (const id of ['od-pieces', 'od-pieces-sizes', 'od-options']) expect(renderCase(locale, id).match(KEY)?.[0] ?? null, `${id} (${locale})`).toBeNull()
      // "Not decided yet" is always the last choice of an option (a pick saves at once).
      expect(renderCase(locale, 'od-options'), locale).toContain(td(locale)('state.OPEN'))
    }
  })

  it('W-CP-1 / W-CP-3: lines, people and Your price go onto the session’s own draft by ids only, at the draft’s version — never a party or a company', async () => {
    const calls: { method: string; path: string; body?: unknown; query?: unknown }[] = []
    const api = {
      post: async (path: string, options: { body?: unknown }) => {
        calls.push({ method: 'POST', path, body: options.body })
        return kindsRecord()
      },
      request: async (method: string, path: string, options: { body?: unknown; query?: unknown }) => {
        calls.push({ method, path, body: options.body, query: options.query })
        return kindsRecord()
      },
    } as unknown as ApiClient
    await addCustomLine(api, 'd1', { version: 7, line: { kind: 'DESCRIBED', description: 'Felpe', quantity: 40 } })
    await changeCustomLine(api, 'd1', 'l2', { version: 8, brandUnitPrice: '18.50' })
    await addPeople(api, 'd1', 'l3', { version: 9, people: [{ name: 'Ada Esempio', measureBy: 'SIZE', size: '52' }] })
    await changePerson(api, 'd1', 'l3', 'p1', { version: 10, measureBy: 'LATER', size: null })
    await removePerson(api, 'd1', 'l3', 'p1', 11)
    await changeLine(api, 'd1', 'l1', { version: 12, brandUnitPrice: null })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /portal/order-requests/d1/custom-lines',
      'PUT /portal/order-requests/d1/custom-lines/l2',
      'POST /portal/order-requests/d1/lines/l3/people',
      'PUT /portal/order-requests/d1/lines/l3/people/p1',
      'DELETE /portal/order-requests/d1/lines/l3/people/p1',
      'PUT /portal/order-requests/d1/lines/l1',
    ])
    expect(calls[0]!.body).toEqual({ version: 7, line: { kind: 'DESCRIBED', description: 'Felpe', quantity: 40 } })
    expect(calls[4]!.query).toEqual({ version: 11 })
    expect(calls[5]!.body).toEqual({ version: 12, brandUnitPrice: null })
    expect(JSON.stringify(calls)).not.toMatch(/party|company/i)
  })

  it('every new case draws in Italian and English, Brand Alpha’s own riders only, no raw key, no e-mail outside example.com', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const id of ['cp154-kinds', 'cp154-sheet-only', 'cp154-no-people', 'cp154-designer', 'cp154-mtm-off', 'cp154-price-typed', 'od-pieces', 'od-pieces-sizes', 'od-options', 'cp154-person', 'cp154-person-change']) {
        const html = renderCase(locale, id)
        expect(html.match(KEY)?.[0] ?? null, `${id} (${locale})`).toBeNull()
        expect(html, `${id} (${locale})`).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
        expect(scanText(html, BRAND_BETA), `${id} (${locale})`).toEqual([])
      }
    }
    expect(personOf(9).name).toMatch(/Esempio$/)
  })
})
// ---- end F-CP-154

// ---- follow-up 22 (cp-fx12; design 12 §2 Doors): the start's four ways are actions — the design system's Card that is a button,
// never a radio (an arrow key moved AND picked there: ArrowDown from "Describe it" started a "Pick styles" draft by mistake) -------
describe('follow-up 22 / od-w1.2 — the start acts only on a press: no radios; the products table is a grid read cell by cell', () => {
  it('the start makes nothing by an arrow key: "Add from" are buttons, never radio cards; no way card is left', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'start')
      expect(html, locale).not.toContain('type="radio"')
      expect(html, locale).not.toContain('nds-radiocard')
      expect(html, locale).not.toContain('fw-pno-way"')
      expect(html, locale).not.toContain('start-way-')
    }
  })

  it('the table: role grid with column headers, each row headed "Row N", an empty cell reads "Not decided yet"; the windows say they open one', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = renderCase(locale, 'cp154-kinds')
      expect(html, locale).toContain('role="grid"')
      for (const key of ['col.product', 'col.sizing', 'col.colour', 'col.pieces', 'col.options', 'col.files']) expect(html, `${key} (${locale})`).toContain(td(locale)(key))
      expect(html, locale).toContain(`aria-label="${td(locale)('row.label', { seq: 1 })}"`)
      expect(html, locale).toContain(td(locale)('state.OPEN'))
      expect(html, locale).toContain('aria-haspopup="dialog"')
    }
  })
})
