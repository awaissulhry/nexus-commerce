import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { PORTAL_AREAS } from '../../shell/nav/portal-nav'
import { productionOrderSchema, type ProductionOrder } from '../production/api'
import { holdsOf, stageNoteOf, waitingHrefOf } from '../production/model'
import type { OrderRecord } from './api'
import { at, dayAt, documentsRead, ORDER_ID, orderRecord, progressRead, requestsOf, shipmentsRead } from './design-data'
import type { OrderRecordActions, OrderRecordViewModel } from './view/OrderRecordView'
import { StatusTab } from './view/StatusTab'

/**
 * F-PR-12a — the portal order › Status & progress, part 1 (production plan §4, §5; 06-tree B.2; wall PW-P02): while the order is
 * in production and the person sees production, "We are waiting for you on this order" (to Waiting for you, until it exists Home),
 * the hold banner in our curated words at every level (the most serious, the rest counted; "Ask a question"), where it is — the
 * plain stage as the note of the "In production" step with the count from + Progress, the health chip with its reason code and who
 * acts next (You / Us) — and its requests in their true states. Not in production, not its order, or not part of its access: no
 * production section is drawn. Brand Beta's tab holds nothing of Brand Alpha and never the office's SO- series. Made-up data.
 */

const PREFIX = `/p/${BRAND_BETA.code}`
const w = (en: string, it = en) => ({ it, en })

function production(over: Partial<ProductionOrder> = {}): ProductionOrder {
  return {
    asOf: at(0),
    level: 'PROGRESS',
    levelWords: w('+ Progress', '+ Avanzamento'),
    progressShared: true,
    urgencyOn: true,
    urgentUse: null,
    order: { id: ORDER_ID, customerRef: BRAND_BETA.customerRef, number: BRAND_BETA.numbers.order, yourNumber: customerNumberOf('ORDER', 4), orderedOn: dayAt(-20), promiseDate: dayAt(10), originalPromiseDate: dayAt(8), promiseMoved: true },
    inProduction: true,
    stage: { code: 'SEWING', words: w('Sewing', 'Confezione'), since: dayAt(-3), next: { code: 'QUALITY', words: w('Quality check', 'Controllo qualità') }, ahead: 1, aheadWords: w('1 line ahead', '1 riga avanti'), sewingNotCounted: false, sewingNotCountedWords: null },
    health: { code: 'AT_RISK', words: w('At risk', 'A rischio'), reason: { code: 'MATERIAL_LATE', words: w('Material delivery late', 'Consegna dei materiali in ritardo') } },
    waiting: { code: 'YOU', words: w('Waiting on you', 'Tocca a te'), since: dayAt(-2) },
    marks: { onHold: true, paused: true, partlyShipped: false, changePending: false, words: [] },
    holds: [
      { kind: 'BRAND', since: dayAt(-1), words: w('Paused at your request', 'In pausa su tua richiesta') },
      { kind: 'PRODUCTION', since: dayAt(-4), words: w('Material on its way', 'Materiale in arrivo') },
    ],
    urgency: null,
    promiseHistory: [],
    progress: { asOf: at(0), refreshSeconds: 60, lines: [], whole: { ordered: 40, cut: 40, sewn: 32, inspected: 0, packed: 0 }, percent: 80 },
    live: { events: ['brand_production.stage_changed'] },
    ...over,
  }
}

function betaRecord(over: Partial<OrderRecord['order']> = {}): OrderRecord {
  return orderRecord({ number: BRAND_BETA.numbers.order, yourNumber: customerNumberOf('ORDER', 4), customerRef: BRAND_BETA.customerRef, status: 'IN_PRODUCTION', shipTo: { name: `${BRAND_BETA.legalName} — Lager`, line1: BRAND_BETA.address.line1, postalCode: BRAND_BETA.address.postalCode, city: BRAND_BETA.address.city, country: BRAND_BETA.address.country }, ...over })
}

function model(record: OrderRecord, over: Partial<OrderRecordViewModel> = {}): OrderRecordViewModel {
  return {
    state: 'ready',
    record,
    tab: 'status',
    prefix: PREFIX,
    offlineSince: null,
    notice: null,
    revision: { state: 'ready', page: null },
    reconfirmHeld: null,
    progress: { state: 'ready', read: progressRead() },
    requests: { state: 'ready', items: requestsOf().map((item) => ({ ...item, orderNumber: BRAND_BETA.numbers.order, customerRef: BRAND_BETA.customerRef })) },
    withdrawHeld: null,
    changeHeld: null,
    pay: {},
    shipments: { state: 'ready', read: shipmentsRead() },
    documents: { state: 'ready', read: documentsRead() },
    fileHeld: null,
    openLine: null,
    copied: null,
    historyOpen: false,
    dialog: null,
    production: { state: 'ready', read: production() },
    waitingHref: waitingHrefOf(PREFIX),
    ...over,
  }
}

const ACTIONS: OrderRecordActions = { onAsk: () => undefined, onRetryProduction: () => undefined }
const draw = (over: Partial<OrderRecordViewModel> = {}, locale: Locale = 'en', record = betaRecord()) => render(createElement(StatusTab, { model: model(record, over), record, actions: ACTIONS }), locale)

describe('the order’s production on Status & progress, part 1 (every level)', () => {
  it('waiting for you on this order, with the way to what waits (Home until Waiting for you exists)', () => {
    const html = draw()
    const text = textOf(html)
    expect(text).toContain('We are waiting for you on this order')
    expect(text).toContain('Since ')
    expect(text).toContain('See what waits for you')
    expect(html).toContain(`href="${PREFIX}/"`)
    // Our turn: no banner of the customer's turn.
    expect(textOf(draw({ production: { state: 'ready', read: production({ waiting: { code: 'US', words: w('Waiting on us'), since: null } }) } }))).not.toContain('We are waiting for you on this order')
  })

  it('a revised order to re-confirm says it already: no second banner of the customer’s turn', () => {
    const record = betaRecord({ reconfirmNeeded: true })
    expect(textOf(draw({ revision: { state: 'ready', page: null } }, 'en', record))).not.toContain('We are waiting for you on this order')
  })

  it('the hold banner: the most serious in our curated words, the rest counted, "Ask a question"; no hold, no banner', () => {
    const text = textOf(draw())
    expect(text).toContain('On hold since')
    expect(text).toContain(': Material on its way')
    expect(text).toContain('We tell you when it continues.')
    expect(text).toContain('1 more hold')
    expect(text).toContain('Ask a question')
    expect(textOf(draw({ production: { state: 'ready', read: production({ holds: [] }) } }))).not.toContain('On hold since')
    // Only its own pause: "Paused at your request since …".
    expect(textOf(draw({ production: { state: 'ready', read: production({ holds: [{ kind: 'BRAND', since: dayAt(-1), words: w('Paused at your request') }] }) } }))).toContain('Paused at your request since')
  })

  it('where it is: the stage is the note of "In production" with the count from + Progress; health with its reason; who acts next', () => {
    const text = textOf(draw())
    expect(text).toContain('Sewing · 32 of 40 sewn · 1 line ahead')
    expect(text).toContain('At risk')
    expect(text).toContain('Waiting on you')
    // In Italian, the same facts in Italian words.
    const it = textOf(draw({}, 'it'))
    expect(it).toContain('Confezione · 32 di 40 cuciti · 1 riga avanti')
    expect(it).toContain('Su questo ordine aspettiamo una tua risposta')
  })

  it('a section not shared is not drawn: no production section when hidden (not in production, not its order, no access)', () => {
    const text = textOf(draw({ production: { state: 'hidden', read: null } }))
    for (const words of ['We are waiting for you on this order', 'On hold since', 'Sewing ·', 'Waiting on you', 'Could not load the production']) expect(text).not.toContain(words)
    // Absent (an older caller): the same.
    expect(textOf(draw({ production: undefined }))).not.toContain('On hold since')
  })

  it('a failed read says so with Try again, only in its own place; the rest of the tab works', () => {
    const text = textOf(draw({ production: { state: 'error', read: null } }))
    expect(text).toContain('Could not load the production of this order')
    // The rest of the tab works: where it is (the order's steps) is still drawn.
    expect(text).toContain(CATALOGUE.en['portal-orders']!['tracker.title']!)
  })

  it('PW-P02 (screen): Brand Beta’s tab holds nothing of Brand Alpha, never the office’s SO- series, never a supplier or a workshop', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = draw({}, locale)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html.match(/\bSO-\d{4}-\d+/)?.[0] ?? null, locale).toBeNull()
      // The office's waiting words (a supplier, a workshop) never reach a customer: only You / Us.
      expect(textOf(html), locale).not.toMatch(/Waiting on (supplier|workshop|customer)|Tocca al (fornitore|terzista|cliente)/i)
    }
  })
})

describe('the rules behind it (production/model, F-PR-12a block)', () => {
  it('the stage note: the count only from + Progress, "sewing not counted" said, never 0 for an uncounted step', () => {
    expect(stageNoteOf(production(), 'en')).toBe('Sewing · 32 of 40 sewn · 1 line ahead')
    expect(stageNoteOf(production({ progress: null }), 'en')).toBe('Sewing · 1 line ahead')
    const cutting = production({ stage: { ...production().stage!, code: 'CUTTING', words: w('Cutting'), ahead: 0, aheadWords: null, sewingNotCounted: true, sewingNotCountedWords: w('Sewing not counted here') } })
    expect(stageNoteOf(cutting, 'en')).toBe('Cutting · 40 of 40 cut · Sewing not counted here')
    expect(stageNoteOf(production({ stage: null }), 'en')).toBeNull()
  })

  it('holds keep only our curated words; Waiting for you once built, else Home', () => {
    expect(holdsOf(production().holds, 'it').map((hold) => [hold.kind, hold.customerWords])).toEqual([
      ['BRAND', 'In pausa su tua richiesta'],
      ['PRODUCTION', 'Materiale in arrivo'],
    ])
    expect(waitingHrefOf(PREFIX)).toBe(`${PREFIX}/`)
    const built = PORTAL_AREAS.map((area) => (area.id === 'home' ? { ...area, pages: area.pages!.map((page) => ({ ...page, built: true })) } : area))
    expect(waitingHrefOf(PREFIX, built)).toBe(`${PREFIX}/waiting`)
  })

  it('the API’s answer parses (a field the API adds never breaks the tab)', () => {
    const read = production()
    const parsed = productionOrderSchema.parse({ ...read, gates: null, problem: null, progress: { ...read.progress!, stages: [] } })
    expect(parsed.stage?.code).toBe('SEWING')
    expect('gates' in parsed).toBe(false)
  })

  it('the words exist in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['portal-orders']!
      for (const key of ['production.label', 'production.waitingTitle', 'production.waitingSince', 'production.waitingLink', 'production.ask', 'production.health', 'production.waitingOn', 'production.failed']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
