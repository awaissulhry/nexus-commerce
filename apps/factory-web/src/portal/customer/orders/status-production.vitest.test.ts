import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { PORTAL_AREAS } from '../../shell/nav/portal-nav'
import { productionOrderSchema, type ProductionGates, type ProductionOrder } from '../production/api'
import { holdsOf, stageNoteOf, waitingHrefOf } from '../production/model'
import { gatesEmpty, gatesWaitOnYou, piecesOf, productionOwnsProgress } from '../production/model' // F-PR-12b
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
    // F-PR-12b reads the gates: a level that does not share them answers null.
    expect(parsed.gates).toBeNull()
    expect('problem' in parsed).toBe(false)
  })

  it('the words exist in both languages', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['portal-orders']!
      for (const key of ['production.label', 'production.waitingTitle', 'production.waitingSince', 'production.waitingLink', 'production.ask', 'production.health', 'production.waitingOn', 'production.failed']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})

// ---- F-PR-12b ------------------------------------------------------------------------------------------------------------------
/**
 * F-PR-12b — part 2 (06-tree B.2 P-ORD-gates, P-ORD-progress; walls PW-P02, PW-P03): + Progress draws the pieces of its own cells
 * per line and size from the order's production read (Cut and bundled · Sewn · Checked · Packed; "—" where a stage is not counted,
 * never 0), read again every `refreshSeconds` and said so; + Gates & dates draws its real gates, its swatch answers as approvals and
 * its own work's days from our published plan. A level that does not share a section draws none of it, and today's progress card is
 * never drawn beside the production read's. Italian portal words speak to the customer as "voi". Made-up data.
 */
/** Today's progress fixture as the production read writes it (no `stages`: the web draws the lib's stage words). */
function piecesRead(): NonNullable<ProductionOrder['progress']> {
  const read = progressRead()
  return { asOf: read.asOf, refreshSeconds: read.refreshSeconds, lines: read.lines, whole: read.whole, percent: read.percent }
}
const pieces = piecesRead()

function withPieces(): NonNullable<ProductionOrder['progress']> {
  const [first, second] = pieces.lines
  // Line 2's site does not scan sewing: its Sewn is not counted ("—"), never 0.
  const notCounted = { ...second!, sewn: null, sizes: second!.sizes.map((size) => ({ ...size, sewn: null })) }
  return { ...pieces, lines: [first!, notCounted] }
}

function gatesOf(over: Partial<ProductionGates> = {}): ProductionGates {
  return {
    gates: [
      { kind: 'PP_SAMPLE', words: w('PP sample', 'Campione di pre-produzione'), state: 'WAITING_YOU', targetDate: dayAt(3), doneOn: null },
      { kind: 'SIZE_SET', words: w('Size set', 'Set taglie'), state: 'PASSED', targetDate: dayAt(-6), doneOn: dayAt(-5) },
      { kind: 'TRIMS_IN', words: w('Trims in', 'Accessori arrivati'), state: 'WAITING_US', targetDate: null, doneOn: null },
      { kind: 'LEATHER_APPROVED', words: w('Leather approved', 'Pelle approvata'), state: 'STARTED_BEFORE', targetDate: dayAt(-2), doneOn: dayAt(-1) },
    ],
    approvals: [
      { kind: 'COLOUR', words: w('Colour', 'Colore'), state: 'APPROVED', sentOn: dayAt(-12), answeredOn: dayAt(-10) },
      { kind: 'FABRIC', words: w('Fabric', 'Tessuto'), state: 'WAITING_YOU', sentOn: dayAt(-1), answeredOn: null },
    ],
    planned: { cutStart: dayAt(4), sewStart: dayAt(6), finish: dayAt(9) },
    ...over,
  }
}

const atGates = (over: Partial<ProductionOrder> = {}) => production({ level: 'GATES', levelWords: w('+ Gates & dates', '+ Tappe e date'), progress: withPieces(), gates: gatesOf(), ...over })
const ready = (read: ProductionOrder): Partial<OrderRecordViewModel> => ({ production: { state: 'ready', read } })
const TU_FORM = /\b(tu|tuo|tua|tuoi|tue|te|ti)\b/i

describe('the order’s production on Status & progress, part 2 (by level)', () => {
  it('+ Progress: per line and size of its own cells — Cut and bundled, "—" where sewing is not counted, never 0; updated on a timer', () => {
    const html = draw(ready(production({ progress: withPieces() })))
    const text = textOf(html)
    expect(text).toContain('Production progress')
    expect(text).toContain('Line 1 · JKT-DEMO-01 Nero')
    expect(text).toContain('Line 2 · PNT-DEMO-02 Sabbia')
    expect(text).toContain('Cut and bundled')
    expect(text).toContain('Checked')
    // Line 1: 44 of the line's ordered cut and bundled, per size under the bars.
    expect(text).toContain(`${pieces.lines[0]!.cut} of ${pieces.lines[0]!.ordered}`)
    // Line 2's sewing is not counted here: said under its bar (and "—" in its size grid, the lib's pieceCell), never "0 of".
    expect(text).toContain('Not counted here')
    // Read again on a timer, said as such (not "Live": no scan is pushed).
    expect(text).toContain('refreshes every minute')
    expect(text).not.toContain('Live ·')
    // Offline: the time of the last good read.
    expect(textOf(draw({ ...ready(production({ progress: withPieces() })), offlineSince: at(0) }))).toContain('Offline · as of')
  })

  it('today’s progress card is never drawn beside the production read’s; without the production read it stays as it was (C1)', () => {
    const one = textOf(draw(ready(production({ progress: withPieces() }))))
    expect(one.split('Production progress').length - 1).toBe(1)
    expect(one).not.toContain('Counted from the floor scans')
    // Being read: neither card yet (no second card that disappears).
    expect(textOf(draw({ production: { state: 'loading', read: null } }))).not.toContain('Counted from the floor scans')
    // No production right, not in production, or its read failed: today's card, as before.
    expect(textOf(draw({ production: { state: 'hidden', read: null } }))).toContain('Counted from the floor scans')
    expect(textOf(draw({ production: { state: 'error', read: null } }))).toContain('Counted from the floor scans')
  })

  it('a level without + Progress draws no pieces; one without + Gates & dates draws no gates (a section not shared is not drawn)', () => {
    const status = textOf(draw(ready(production({ level: 'STATUS', levelWords: w('Status only'), progressShared: false, progress: null, gates: null }))))
    for (const words of ['Production progress', 'Cut and bundled', 'Gates and dates', 'Cutting starts']) expect(status).not.toContain(words)
    const progress = textOf(draw(ready(production({ progress: withPieces(), gates: null }))))
    expect(progress).toContain('Cut and bundled')
    expect(progress).not.toContain('Gates and dates')
  })

  it('+ Gates & dates: its real gates with our state words and their days, its swatch answers as approvals, our published days', () => {
    const html = draw(ready(atGates()))
    const text = textOf(html)
    expect(text).toContain('Gates and dates')
    for (const words of ['PP sample', 'Size set', 'Trims in', 'Leather approved']) expect(text).toContain(words)
    for (const words of ['Waiting on you', 'Waiting on us', 'Passed', 'Started before approval']) expect(text).toContain(words)
    // Swatch answers are approvals, not gates: their own table.
    expect(text).toContain('Your material approvals')
    expect(text).toContain('Colour')
    expect(text).toContain('Fabric')
    expect(text).toContain('Approved')
    // The published plan's days, said as such.
    for (const words of ['Cutting starts', 'Sewing starts', 'Production ends', 'From our published production plan']) expect(text).toContain(words)
    // Something waits on the customer: the way to what waits.
    expect(text).toContain('See what waits for you')
    expect(html).toContain(`href="${PREFIX}/"`)
  })

  it('nothing waits on the customer: no way to what waits; nothing planned: said in one line; no days in the plan: said', () => {
    const ours = gatesOf({ gates: gatesOf().gates.map((gate) => ({ ...gate, state: 'PASSED' as const })), approvals: [] })
    expect(textOf(draw(ready(atGates({ gates: ours })))).match(/See what waits for you/g)?.length ?? 0).toBe(1) // only the top banner (waiting on YOU)
    expect(textOf(draw(ready(atGates({ gates: ours, waiting: { code: 'US', words: w('Waiting on us'), since: null } }))))).not.toContain('See what waits for you')
    const none = gatesOf({ gates: [], approvals: [], planned: { cutStart: null, sewStart: null, finish: null } })
    expect(textOf(draw(ready(atGates({ gates: none }))))).toContain('No gates or dates planned for this order yet.')
    const noDays = gatesOf({ planned: { cutStart: null, sewStart: null, finish: null } })
    const text = textOf(draw(ready(atGates({ gates: noDays }))))
    expect(text).toContain('No production days in our plan yet.')
    expect(text).not.toContain('Cutting starts')
  })

  it('Italian: the same sections in Italian words, and the customer is "voi" (never "tu")', () => {
    const text = textOf(draw(ready(atGates()), 'it'))
    for (const words of ['Tappe e date', 'Tocca a voi', 'Tocca a noi', 'Superata', 'Le vostre approvazioni dei materiali', 'Inizio del taglio', 'Tagliati e in fasci', 'Vedete cosa vi aspetta']) expect(text).toContain(words)
    const words = CATALOGUE.it['portal-orders']!
    const mine = Object.entries(words).filter(([key]) => /^production\.(gates|approvals|planned|pieces)\./.test(key))
    expect(mine.length).toBeGreaterThan(20)
    for (const [key, value] of mine) expect(value, key).not.toMatch(TU_FORM)
  })

  it('PW-P02 / PW-P03 (screen): Brand Beta’s pieces and gates hold nothing of Brand Alpha, no line, lane, load or capacity, no SO- series', () => {
    for (const locale of ['it', 'en'] as const) {
      const html = draw(ready(atGates()), locale)
      expect(scanText(html, BRAND_ALPHA), locale).toEqual([])
      expect(html.match(/\bSO-\d{4}-\d+/)?.[0] ?? null, locale).toBeNull()
      expect(textOf(html), locale).not.toMatch(/\b(capacity|capacità|load|carico|lane|corsia|workshop|terzista|production line|linea di produzione)\b/i)
    }
  })

  it('PW-P03 (web): a key the API never sends — a line, a lane, a load, a working-plan day — is never kept by the web', () => {
    const read = atGates()
    const answer = {
      ...read,
      gates: { ...read.gates!, gates: read.gates!.gates.map((gate) => ({ ...gate, stateWords: w('x'), productionLineId: 'line-1', overrideReason: 'office words' })), planned: { ...read.gates!.planned, lane: 'L2', load: 0.8, workingFinish: dayAt(2) } },
      progress: { ...read.progress!, lines: read.progress!.lines.map((line) => ({ ...line, lotSize: 400, workOrderId: 'wo-1' })) },
    }
    const parsed = productionOrderSchema.parse(answer)
    const keys = JSON.stringify(parsed)
    for (const key of ['productionLineId', 'overrideReason', 'stateWords', '"lane"', '"load"', 'workingFinish', 'lotSize', 'workOrderId']) expect(keys, key).not.toContain(key)
    expect(parsed.gates?.planned).toEqual(read.gates!.planned)
  })
})

describe('the rules behind it (production/model, F-PR-12b block)', () => {
  const t = (key: string, params?: Readonly<Record<string, string | number>>) => {
    const text = CATALOGUE.en['portal-orders']![key] ?? key
    return Object.entries(params ?? {}).reduce((out, [name, value]) => out.replace(`{${name}}`, String(value)), text)
  }

  it('piecesOf: one block per line, its sizes in order, a size-less piece under its own word, null kept null', () => {
    const blocks = piecesOf(withPieces(), t)
    expect(blocks.map((block) => block.label)).toEqual(['Line 1 · JKT-DEMO-01 Nero', 'Line 2 · PNT-DEMO-02 Sabbia'])
    expect(blocks[0]!.sizes.map((size) => size.size)).toEqual(pieces.lines[0]!.sizes.map((size) => size.size))
    expect(blocks[1]!.sizes.every((size) => size.sewn === null)).toBe(true)
    const mtm = piecesOf({ ...pieces, lines: [{ ...pieces.lines[0]!, style: null, colourway: null, sizes: [{ size: null, ordered: 1, cut: 1, sewn: null, inspected: 0, packed: 0 }] }] }, t)
    expect(mtm[0]!.label).toBe('Line 1 · —')
    expect(mtm[0]!.sizes[0]!.size).toBe('Made to measure')
  })

  it('gatesEmpty, gatesWaitOnYou, productionOwnsProgress', () => {
    expect(gatesEmpty(gatesOf())).toBe(false)
    expect(gatesEmpty(gatesOf({ gates: [], approvals: [], planned: { cutStart: null, sewStart: null, finish: null } }))).toBe(true)
    expect(gatesEmpty(gatesOf({ gates: [], approvals: [], planned: { cutStart: null, sewStart: null, finish: dayAt(9) } }))).toBe(false)
    expect(gatesWaitOnYou(gatesOf())).toBe(true)
    expect(gatesWaitOnYou(gatesOf({ gates: [], approvals: [{ kind: 'TRIM', words: w('Trims'), state: 'WAITING_YOU', sentOn: null, answeredOn: null }] }))).toBe(true)
    expect(gatesWaitOnYou(gatesOf({ gates: [], approvals: [] }))).toBe(false)
    expect(productionOwnsProgress({ state: 'ready' })).toBe(true)
    expect(productionOwnsProgress({ state: 'loading' })).toBe(true)
    for (const state of ['hidden', 'error'] as const) expect(productionOwnsProgress({ state })).toBe(false)
    expect(productionOwnsProgress(undefined)).toBe(false)
  })

  it('the F-PR-12b words exist in both languages, with the same keys', () => {
    const keys = (locale: 'it' | 'en') => Object.keys(CATALOGUE[locale]['portal-orders']!).filter((key) => /^production\.(gates|approvals|planned|pieces)\./.test(key)).sort()
    expect(keys('it')).toEqual(keys('en'))
    for (const key of ['production.gates.title', 'production.gates.states.WAITING_YOU', 'production.approvals.states.REFUSED', 'production.planned.hint', 'production.pieces.oneSize']) expect(keys('en')).toContain(key)
  })
})
