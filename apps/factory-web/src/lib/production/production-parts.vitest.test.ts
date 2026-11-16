import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../i18n/provider'
import { LOCALES, type Locale } from '../i18n/locales'
import {
  ageOf,
  freshView,
  healthView,
  holdView,
  mostSerious,
  nothingCut,
  pieceCell,
  piecesTotal,
  PLAIN_STAGES,
  progressFigure,
  requestView,
  stageFigures,
  stageSteps,
  waitingView,
  workingDaysSince,
  type HoldInput,
  type PiecesColourway,
  type RequestInput,
} from './model'
import { productionWordsFor } from './words'
import { FreshnessLine } from './view/FreshnessLine'
import { HealthPill } from './view/HealthPill'
import { PiecesGrid } from './view/PiecesGrid'
import { ProductionHoldBanner } from './view/ProductionHoldBanner'
import { RequestCard } from './view/RequestCard'
import { StageStrip } from './view/StageStrip'
import { WaitingOnPill } from './view/WaitingOnPill'

/**
 * F-PR-01 — the shared production parts (lib/production): the rules without a screen, then each part drawn in both
 * languages for the office and for a customer. Made-up data (Brand Alpha's people). The customer face never shows what
 * is the office's: a supplier or workshop, the office's health note, the office's hold reason.
 */

// Tuesday 17 Nov 2026, 10:42 in Rome.
const NOW = Date.parse('2026-11-17T09:42:00Z')
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()

const draw = (locale: Locale, element: ReactElement) => renderToString(createElement(I18nProvider, { locale, messages: {} }, element))

describe('the one rule: a bar shows the figure its words name (R5)', () => {
  it('names the furthest step counted and draws that step’s share — never finished 0 % beside "Sewn 80 of 100"', () => {
    expect(progressFigure({ cut: 100, bundled: 100, sewn: 80, finished: 0 }, 100, true)).toEqual({ step: 'sewn', done: 80, total: 100, percent: 80, words: { key: 'progress.sewn', params: { done: 80, total: 100 } } })
    expect(progressFigure({ cut: 12, bundled: 0, sewn: 0, finished: 0 }, 12, true)).toMatchObject({ step: 'cut', percent: 100 })
    expect(progressFigure({ cut: 50, bundled: 40, sewn: null, finished: 0 }, 50, true)).toMatchObject({ step: 'bundled', percent: 80 })
    expect(progressFigure({ cut: 0, bundled: 0, sewn: 0, finished: 0 }, 40, true)).toMatchObject({ step: 'cut', done: 0, percent: 0, words: { key: 'progress.none' } })
    expect(progressFigure({ cut: null, bundled: null, sewn: null, finished: null }, 40, true)).toMatchObject({ step: null, percent: null })
    expect(progressFigure(null, 40, true)).toMatchObject({ step: null, percent: null, words: { key: 'progress.notFrozen' } })
    expect(progressFigure({ cut: 4, bundled: 4, sewn: 4, finished: 4 }, 4, false)).toMatchObject({ step: null, percent: null })
  })
})

describe('the five plain stages', () => {
  it('done before the stage (with its day), current at it, to come after it (with the expected day)', () => {
    const steps = stageSteps({ stage: 'SEWING', reached: { PREPARING: '2026-11-03', CUTTING: '2026-11-08' }, expected: { SEWING: '2026-11-19', READY: '2026-11-24' }, note: 'Sewn 80 of 100' })
    expect(steps.map((step) => [step.id, step.state])).toEqual([['PREPARING', 'done'], ['CUTTING', 'done'], ['SEWING', 'current'], ['QUALITY', 'todo'], ['READY', 'todo']])
    expect(steps[0]).toMatchObject({ date: '2026-11-03', expected: null })
    expect(steps[2]).toMatchObject({ date: null, expected: '2026-11-19', note: 'Sewn 80 of 100' })
    expect(steps.map((step) => step.label.key)).toEqual(PLAIN_STAGES.map((stage) => `parts.stage.${stage}`))
  })
  it('an unknown stage has no steps ("—", never step 1); blocked says why on the current step; sewing not scanned says so', () => {
    expect(stageSteps({ stage: null })).toEqual([])
    expect(stageSteps({ stage: 'PREPARING', blocked: { why: 'Waiting on you: PP sample' }, note: 'ignored' })[0]!.note).toBe('Waiting on you: PP sample')
    expect(stageSteps({ stage: 'CUTTING', sewingCounted: false })[2]!.note).toEqual({ key: 'parts.stage.sewingNotCounted' })
    expect(stageSteps({ stage: 'QUALITY', sewingCounted: false })[2]!.note).toBeNull()
  })
})

describe('waiting on', () => {
  it('counts working days in the company’s zone (a weekend does not count)', () => {
    expect(workingDaysSince('2026-11-13T15:00:00Z', NOW)).toBe(2) // Friday → Monday, Tuesday
    expect(workingDaysSince('2026-11-17T07:00:00Z', NOW)).toBe(0)
    expect(workingDaysSince(null, NOW)).toBe(0)
    expect(ageOf(ago(4), NOW)).toEqual({ key: 'parts.age.hours', params: { count: 4 } })
    expect(ageOf(ago(50), NOW)).toEqual({ key: 'parts.age.days', params: { count: 2 } })
    expect(ageOf(ago(0.2), NOW)).toEqual({ key: 'parts.age.minutes', params: { count: 12 } })
    expect(ageOf(ago(-1), NOW)).toBeNull()
  })
  it('the office reads who and since; amber after 1 working day for a request and 3 for anything else', () => {
    expect(waitingView('office', { who: 'US', since: ago(4), kind: 'request' }, NOW)).toMatchObject({ words: { key: 'parts.waiting.office.US' }, tone: 'neutral' })
    expect(waitingView('office', { who: 'US', since: ago(26), kind: 'request' }, NOW)).toMatchObject({ tone: 'warning' })
    expect(waitingView('office', { who: 'SUPPLIER', since: ago(26) }, NOW)).toMatchObject({ tone: 'neutral' })
    expect(waitingView('office', { who: 'WORKSHOP', since: ago(100) }, NOW)).toMatchObject({ words: { key: 'parts.waiting.office.WORKSHOP' }, tone: 'neutral' }) // Friday: 2 working days
    expect(waitingView('office', { who: 'WORKSHOP', since: ago(150) }, NOW)).toMatchObject({ tone: 'warning' }) // Wednesday: 4
    expect(waitingView('office', { who: 'BRAND', since: ago(200), dueAt: ago(-2), what: 'PP sample' }, NOW)).toMatchObject({ tone: 'neutral', what: 'PP sample' })
    expect(waitingView('office', { who: 'BRAND', since: ago(200), dueAt: ago(2) }, NOW)).toMatchObject({ tone: 'warning' })
  })
  it('a customer reads only "Waiting on you" or "Waiting on us": supplier and workshop are ours, and the office’s detail stays home', () => {
    expect(waitingView('customer', { who: 'BRAND', since: ago(3) }, NOW)).toMatchObject({ words: { key: 'parts.waiting.customer.you' } })
    for (const who of ['US', 'SUPPLIER', 'WORKSHOP'] as const) expect(waitingView('customer', { who, since: ago(3), what: 'Leather from the tannery' }, NOW)).toMatchObject({ words: { key: 'parts.waiting.customer.us' }, what: null })
  })
  it('nobody waiting draws nothing; not known draws "—"', () => {
    expect(waitingView('office', { who: null }, NOW)).toBeNull()
    expect(waitingView('customer', { who: undefined }, NOW)).toBe('unknown')
  })
})

describe('health: two signals, one chip', () => {
  it('shows the worse of the dates and a person’s raise; late says by how many days', () => {
    expect(healthView('office', { computed: 'ON_TIME' })).toMatchObject({ state: 'ON_TIME', tone: 'success' })
    expect(healthView('office', { computed: 'ON_TIME', raised: { reason: 'QUALITY', note: 'Lab re-run' } })).toMatchObject({ state: 'AT_RISK', tone: 'warning', reason: 'QUALITY' })
    expect(healthView('office', { computed: 'LATE', daysLate: 3, raised: { reason: 'QUALITY' } })).toMatchObject({ state: 'LATE', words: { key: 'parts.health.lateBy', params: { count: 3 } } })
    expect(healthView('office', { computed: 'NOT_PROMISED' })).toMatchObject({ state: 'NOT_PROMISED', words: { key: 'parts.health.NOT_PROMISED' } })
    expect(healthView('office', { computed: null })).toMatchObject({ state: null })
    expect(healthView('office', { computed: undefined })).toBe('unknown')
  })
  it('the office gets the person’s note; the customer never does — only the curated reason', () => {
    const raised = { reason: 'MATERIAL_LATE', note: 'Tannery batch 12 late', by: 'Bea Esempio', at: '2026-11-14' } as const
    expect(healthView('office', { computed: 'ON_TIME', raised })).toMatchObject({ note: { text: 'Tannery batch 12 late', by: 'Bea Esempio' } })
    expect(healthView('customer', { computed: 'ON_TIME', raised })).toMatchObject({ note: null, reason: 'MATERIAL_LATE' })
  })
})

describe('pieces by stage and size', () => {
  const colourway: PiecesColourway = { id: 'red', label: 'Red', sizes: [{ size: 'M', ordered: 20, cut: 20, sewn: null, inspected: 0, packed: 0 }, { size: 'L', ordered: 20, cut: 12, sewn: null, inspected: 0, packed: 0 }] }
  it('sums each stage over the sizes; a stage no size counts stays unknown, never 0', () => {
    expect(piecesTotal(colourway)).toEqual({ ordered: 40, cut: 32, sewn: null, inspected: 0, packed: 0 })
    expect(stageFigures(piecesTotal(colourway)).map((figure) => [figure.stage, figure.done, figure.percent])).toEqual([['CUT', 32, 80], ['SEWN', null, null], ['INSPECTED', 0, 0], ['PACKED', 0, 0]])
    expect(pieceCell(colourway.sizes[0]!, 'SEWN')).toBe('—')
    expect(pieceCell(colourway.sizes[0]!, 'ORDERED')).toBe('20')
    expect(nothingCut([colourway])).toBe(false)
    expect(nothingCut([{ ...colourway, sizes: [{ size: 'M', ordered: 4, cut: 0, sewn: null, inspected: null, packed: null }] }])).toBe(true)
  })
})

describe('requests, holds and freshness', () => {
  const open: RequestInput = { id: 'r1', kind: 'RUSH', state: 'OPEN', askedAt: ago(30), askedBy: 'Alex Demo' }
  it('a request’s head: the office sees how long it waits on us; the customer reads only true states', () => {
    expect(requestView('office', open, NOW, '16/11/2026')).toMatchObject({ kind: { key: 'parts.request.kind.RUSH' }, asked: { key: 'parts.request.askedBy', params: { name: 'Alex Demo' } }, waiting: { tone: 'warning' } })
    expect(requestView('customer', { ...open, mine: true }, NOW, '16/11/2026')).toMatchObject({ state: { key: 'parts.request.customer.OPEN' }, asked: { key: 'parts.request.askedByYou' }, waiting: null, tone: 'info' })
    expect(requestView('office', { ...open, state: 'ACCEPTED' }, NOW, '16/11/2026')).toMatchObject({ waiting: null, tone: 'success' })
  })
  it('one banner, the most serious; the customer reads curated words, never the office’s reason', () => {
    const holds: HoldInput[] = [
      { id: 'b', kind: 'BRAND', since: '2026-11-10' },
      { id: 'q', kind: 'QUALITY', since: '2026-11-14', reason: 'Shade difference', customerWords: 'Extra quality checks' },
    ]
    expect(mostSerious(holds)).toMatchObject({ hold: { id: 'q' }, more: 1 })
    expect(mostSerious([])).toEqual({ hold: null, more: 0 })
    expect(holdView('office', holds[1]!, '14/11/2026')).toMatchObject({ tone: 'danger', title: { key: 'parts.hold.office.titleWhy', params: { reason: 'Shade difference' } } })
    const customer = holdView('customer', holds[1]!, '14/11/2026')
    expect(customer).toMatchObject({ title: { key: 'parts.hold.customer.titleWhy', params: { words: 'Extra quality checks' } }, body: { key: 'parts.hold.customer.next' } })
    expect(JSON.stringify(customer)).not.toContain('Shade difference')
    expect(holdView('customer', holds[0]!, '10/11/2026')).toMatchObject({ tone: 'warning', title: { key: 'parts.hold.customer.paused' } })
  })
  it('"Live" only when pushed; a timer says how often; offline and not read say so', () => {
    expect(freshView('live', '10:42')).toEqual({ words: { key: 'parts.fresh.live', params: { time: '10:42' } }, dot: 'success' })
    expect(freshView('polling', '10:42')).toEqual({ words: { key: 'parts.fresh.everyMinute', params: { time: '10:42' } }, dot: null })
    expect(freshView('polling', '10:42', 30).words).toEqual({ key: 'parts.fresh.everySeconds', params: { time: '10:42', count: 30 } })
    expect(freshView('offline', '10:44').dot).toBe('neutral')
    expect(freshView('live', null).words.key).toBe('parts.fresh.never')
    expect(freshView('connecting', null).words.key).toBe('parts.fresh.connecting')
  })
})

describe('the parts drawn, in both languages', () => {
  const colourways: PiecesColourway[] = [
    { id: 'blk', label: 'JK-210 · Black', sizes: [{ size: 'S', ordered: 10, cut: 10, sewn: 9, inspected: 6, packed: 0 }, { size: 'M', ordered: 20, cut: 20, sewn: null, inspected: 8, packed: 0 }] },
    { id: 'red', label: 'JK-210 · Red', sizes: [{ size: 'M', ordered: 12, cut: 12, sewn: null, inspected: 0, packed: 0 }] },
  ]
  const request: RequestInput = {
    id: 'r1',
    kind: 'CHANGE',
    state: 'OPEN',
    askedAt: ago(4),
    askedBy: 'Alex Demo',
    changes: [{ id: 'c1', label: 'Line 10 · M', from: '20', to: '24' }],
    impact: { frozen: [], earliest: { best: '2026-11-25', likely: '2026-11-27', worst: '2026-12-02' }, price: 'MAY_APPLY' },
  }
  const holds: HoldInput[] = [{ id: 'q', kind: 'QUALITY', since: '2026-11-14', reason: 'Shade difference on panel 3', customerWords: 'Extra quality checks' }]
  const every = (face: 'office' | 'customer') =>
    createElement(
      'div',
      null,
      createElement(StageStrip, { face, stage: 'SEWING', reached: { PREPARING: '2026-11-03' }, expected: { READY: '2026-11-24' }, promise: { date: '2026-11-24', history: [{ on: '2026-11-10', from: '2026-11-18', to: '2026-11-24', reason: 'MATERIAL_LATE' }] } }),
      createElement(StageStrip, { face, stage: 'CUTTING', layout: 'compact', blocked: { why: 'PP sample' } }),
      createElement(WaitingOnPill, { face, who: 'SUPPLIER', since: ago(30), now: NOW, what: 'Tannery delivery' }),
      createElement(HealthPill, { face, computed: 'ON_TIME', plan: '2026-11-22', promise: '2026-11-24', raised: { reason: 'QUALITY', note: 'Lab re-run on Saturday', by: 'Bea Esempio', at: '2026-11-14' } }),
      createElement(PiecesGrid, { colourways }),
      createElement(RequestCard, { face, request, now: NOW }),
      createElement(ProductionHoldBanner, { face, holds }),
      createElement(FreshnessLine, { mode: 'polling', asOf: ago(0) }),
    )

  it('draws every part without a catalogue key on screen', () => {
    for (const locale of LOCALES) {
      for (const face of ['office', 'customer'] as const) {
        const html = draw(locale, every(face))
        expect(html, `${locale}/${face}`).not.toMatch(/(?:parts|progress)\.[a-zA-Z]+(?:\.[A-Za-z_]+)*/)
      }
    }
  })

  it('the Italian page speaks Italian', () => {
    const html = draw('it', every('office'))
    for (const word of ['In preparazione', 'Confezione', 'Pronto per la spedizione', 'Tocca al fornitore', 'Tagliati e in fasci', 'Non contato qui', 'Potrebbe esserci un costo', 'In sospeso dal', 'si aggiorna ogni minuto', 'Bloccato: PP sample']) expect(html).toContain(word)
    expect(html).not.toMatch(/Preparing|Ready to ship|Waiting on supplier|Cut and bundled|Not counted here|A price may apply|On hold since|refreshes every minute/)
  })

  it('the office reads the office’s words; the customer never does (the brand wall)', () => {
    const office = draw('en', every('office'))
    for (const text of ['Waiting on supplier · Tannery delivery · 1 d', 'At risk, with a note', 'Shade difference on panel 3', 'Asked by Alex Demo', 'Planned', 'Ex-factory']) expect(office).toContain(text)
    const customer = draw('en', every('customer'))
    for (const text of ['Waiting on us · 1 d', 'At risk · Extra quality checks', 'On hold since 14/11/2026: Extra quality checks', 'We tell you when it continues.', 'Being reviewed', 'Expected']) expect(customer).toContain(text)
    for (const text of ['supplier', 'Tannery', 'Lab re-run', 'Bea Esempio', 'Shade difference', 'Office only', 'Alex Demo', 'Ex-factory', 'Planned']) expect(customer).not.toContain(text)
  })

  it('unknown is "—", nothing waiting draws nothing, no hold draws no banner, and a failed read says so with Try again', () => {
    expect(draw('en', createElement(StageStrip, { face: 'office', stage: null }))).toContain('Stage not known yet')
    expect(draw('en', createElement(WaitingOnPill, { face: 'office', who: null }))).toBe('')
    expect(draw('en', createElement(ProductionHoldBanner, { face: 'customer', holds: [] }))).toBe('')
    expect(draw('en', createElement(HealthPill, { face: 'office', computed: null }))).toContain('No plan yet')
    const failed = draw('it', createElement(PiecesGrid, { colourways: [], problem: true, onRetry: () => undefined }))
    expect(failed).toContain('Impossibile caricare i pezzi')
    expect(failed).toContain('Riprova')
    expect(draw('en', createElement(StageStrip, { face: 'customer', stage: 'SEWING', loading: true }))).toContain('Reading the stages…')
  })

  it('the words come straight from the production catalogue, in each language', () => {
    expect(productionWordsFor('en')('parts.stage.QUALITY')).toBe('Quality check')
    expect(productionWordsFor('it')('parts.waiting.customer.you')).toBe('Tocca a voi')
    expect(productionWordsFor('it')('parts.health.lateDays', { count: 2 })).toBe('in ritardo di 2 giorni')
  })
})
