import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { order } from '../../_demo/fixtures'
import { LINE_BLK, LINE_RED } from '../../_demo/fixtures'
import { HEADLINE, LINES, PRODUCTION_READ } from '../overview/fixtures'
import type { Headline } from '../overview/api'
import { readFileSync } from 'node:fs'
import { markActsOf } from '../../../../../lib/production/health/model'
import { daysBetween, healthViewOf, healthWhyOf, lineLabelOf, nextStepOf, nowStateOf, piecesOf, placeAnchorOf, urgencyOf } from './now'

// F-PT-102 (order PRODUCTION tab, W1): Production now — the pieces per step, the ONE sentence that agrees with the stored health,
// one door per blocker, the urgency line.

const w = (en: string, it: string) => ({ en, it })
const so = order('IN_PRODUCTION')
const dates = PRODUCTION_READ.dates!
const withHealth = (health: Headline['health'], over: Partial<Headline> = {}): Headline => ({ ...HEADLINE, health, ...over })

describe('F-PT-102: pieces of this order per step (the same lines part as Overview’s Progress by line)', () => {
  it('Cut · Sewn · Checked · Packed · Shipped of the ordered pieces; a step not counted on a line is not counted in the sum', () => {
    const view = piecesOf(so, LINES)
    expect(view?.of).toBe(14)
    expect(view?.steps.map((entry) => entry.step)).toEqual(['cut', 'sewn', 'checked', 'packed', 'shipped'])
    expect(view?.steps.find((entry) => entry.step === 'cut')?.value).toBe(11)
    expect(piecesOf(so, null)).toBeNull()
  })
})

describe('F-PT-102: the health sentence agrees with the stored word (S5 §3.2)', () => {
  it('At risk: the worst line planned after its promise, by name and days', () => {
    const why = healthWhyOf({ order: so, headline: withHealth({ code: 'AT_RISK', words: w('At risk', 'A rischio'), computed: 'AT_RISK', raise: null }), dates, lines: LINES })
    expect(why).toMatchObject({ kind: 'lineLate', finish: '2026-12-29' })
    expect(why && why.kind === 'lineLate' ? why.line : '').toBe(lineLabelOf(so, LINE_RED))
    expect(why && why.kind === 'lineLate' ? why.days : 0).toBeGreaterThan(0)
  })

  it('At risk with the forecast withheld (no planning.promise.view): the dates’ own fallback line, never a guess', () => {
    const why = healthWhyOf({ order: so, headline: withHealth({ code: 'AT_RISK', words: w('At risk', 'A rischio'), computed: 'AT_RISK', raise: null }), dates: { ...dates, forecast: null, milestones: [] }, lines: LINES })
    expect(why).toEqual({ kind: 'fromDates', plan: '2026-12-10', promise: '2026-12-15' })
  })

  it('a person’s mark while the dates alone say On track: the mark is the why (who, when, the reason the customer reads)', () => {
    const raise = { reasonCode: 'MATERIAL_LATE', words: w('Material delivery late', 'Materiale in ritardo'), until: '2026-11-21', note: 'Lab re-run', by: { id: 'u1', name: 'Bea Esempio', active: true }, at: '2026-11-14T09:00:00Z' }
    const why = healthWhyOf({ order: so, headline: withHealth({ code: 'AT_RISK', words: w('At risk', 'A rischio'), computed: 'ON_TRACK', raise }), dates, lines: LINES })
    expect(why).toEqual({ kind: 'marked', by: 'Bea Esempio', at: '2026-11-14T09:00:00Z', reason: raise.words, computed: 'ON_TRACK' })
  })

  it('Late: the promise and the pieces still to ship; On track: planned ready N days before; no date: says so', () => {
    expect(healthWhyOf({ order: so, headline: withHealth({ code: 'LATE', words: w('Late', 'In ritardo'), computed: 'LATE', raise: null }), dates, lines: LINES })).toEqual({ kind: 'late', promise: '2026-12-15', open: 14 })
    expect(healthWhyOf({ order: so, headline: withHealth({ code: 'ON_TRACK', words: w('On track', 'In linea'), computed: 'ON_TRACK', raise: null }), dates, lines: LINES })).toEqual({ kind: 'onTrack', finish: '2026-12-10', days: 5, promise: '2026-12-15' })
    expect(healthWhyOf({ order: so, headline: withHealth({ code: 'NO_DATE', words: w('No date yet', 'Data da definire'), computed: 'NO_DATE', raise: null }), dates, lines: LINES })).toEqual({ kind: 'noDate' })
    expect(healthWhyOf({ order: so, headline: withHealth(null), dates, lines: LINES })).toBeNull()
  })

  it('days between two days, whole days', () => {
    expect(daysBetween('2026-12-07', '2026-12-11')).toBe(4)
    expect(daysBetween('2026-12-11', '2026-12-07')).toBe(-4)
    expect(lineLabelOf(so, LINE_BLK)).toMatch(/·/)
    expect(lineLabelOf(so, 'nope')).toBeNull()
  })
})

describe('F-PT-102: one door per blocker, the state, the urgency', () => {
  it('the first blocker → its ONE place (a request → Changes; a hold → #holds; a material → #dates); none and at risk → Ask', () => {
    expect(nextStepOf(HEADLINE)).toEqual({ kind: 'blocker', words: HEADLINE.waiting.blockers[0]!.words, place: 'REQUEST' })
    expect(placeAnchorOf('REQUEST')).toEqual({ tab: 'changes', anchor: null })
    expect(placeAnchorOf('HOLD')).toEqual({ tab: 'production', anchor: 'holds' })
    expect(placeAnchorOf('DATE')).toEqual({ tab: 'production', anchor: 'dates' })
    const free = { ...HEADLINE, waiting: { ...HEADLINE.waiting, blockers: [] } }
    expect(nextStepOf(free)).toEqual({ kind: 'ask' })
    expect(nextStepOf({ ...free, health: { code: 'ON_TRACK', words: w('On track', 'In linea'), computed: 'ON_TRACK', raise: null } })).toBeNull()
    // A kind this page does not know yet is a request (it stays visible, never hidden).
    expect(nextStepOf({ ...HEADLINE, waiting: { ...HEADLINE.waiting, blockers: [{ kind: 'SOMETHING_NEW', on: 'US', words: w('x', 'x'), since: null }] } })).toMatchObject({ place: 'REQUEST' })
  })

  it('followed now / not yet / no more', () => {
    expect(nowStateOf(so, HEADLINE)).toBe('kept')
    expect(nowStateOf(so, withHealth(null))).toBe('notKept')
    expect(nowStateOf(order('SHIPPED'), HEADLINE)).toBe('after')
  })

  it('Urgent (customer) · Rush (factory) · the office priority — three things, never one word (B3)', () => {
    expect(urgencyOf(HEADLINE, null)).toEqual({ customer: true, rush: false, priority: null })
    expect(urgencyOf({ ...HEADLINE, urgency: { customer: null, factoryRush: true, officePriority: { level: 'TOP', words: w('Top', 'Massima'), reason: null } } }, null)).toEqual({ customer: false, rush: true, priority: w('Top', 'Massima') })
    expect(urgencyOf(null, null)).toBeNull()
  })

  it('the words in it + en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['productionTab.now.title', 'productionTab.now.stageLabel', 'productionTab.now.piecesLabel', 'productionTab.now.of', 'productionTab.now.healthLabel', 'productionTab.now.peopleLabel', 'productionTab.now.why.lineLate', 'productionTab.now.why.lineNoDate', 'productionTab.now.why.gateLate', 'productionTab.now.why.late', 'productionTab.now.why.onTrack', 'productionTab.now.why.noDate', 'productionTab.now.why.marked', 'productionTab.now.next', 'productionTab.now.nextAsk', 'productionTab.now.urgentCustomer', 'productionTab.now.rush', 'productionTab.now.markAtRisk', 'productionTab.now.removeMark', 'productionTab.now.byHand', 'productionTab.now.notKept'])
        expect(t(key, { line: 'L', finish: 'f', days: 3, count: 3, promise: 'p', gate: 'g', target: 't', name: 'n', day: 'd', reason: 'r', health: 'h', of: 4, words: 'w', stage: 's' }), `${locale} ${key}`).not.toMatch(/^productionTab\.|\{/)
    }
  })
})

// ---- F-PT-404 (B-PT-007): the health mark through the page's ONE read --------------------------------------------------------------
describe('F-PT-404: the mark reads the headline (no second GET) and re-reads it after a write', () => {
  const so = order('IN_PRODUCTION')
  const w = (en: string, it: string) => ({ en, it })
  const at = (over: Partial<NonNullable<Headline['health']>>): Headline => ({ ...HEADLINE, health: { ...HEADLINE.health!, version: 7, ...over } })

  it('the headline as the mark rule reads it: kept, the stored and computed words, a standing raise, the version', () => {
    const view = healthViewOf(so, at({ code: 'AT_RISK', computed: 'ON_TRACK', raise: { reasonCode: 'MATERIAL_LATE', words: w('Material late', 'Materiale in ritardo'), until: '2026-11-30', note: 'Pelle in ritardo.', by: { id: 'u1', name: 'Sara Prova', active: true }, at: '2026-11-20T09:00:00Z' } }))
    expect(view).toMatchObject({ orderId: so.id, kept: true, health: 'AT_RISK', computed: 'ON_TRACK', version: 7, raise: { reasonCode: 'MATERIAL_LATE', stands: true, until: '2026-11-30', setBy: { name: 'Sara Prova' } } })
    // A standing mark over dates that say On track: Change… and Remove the mark (the one rule of both pages).
    expect(markActsOf(view, true)).toEqual({ mark: 'change', remove: true })
    expect(markActsOf(healthViewOf(so, at({ code: 'ON_TRACK', computed: 'ON_TRACK', raise: null })), true)).toEqual({ mark: 'raise', remove: false })
    expect(markActsOf(healthViewOf(so, at({ code: 'LATE', computed: 'LATE', raise: null })), true)).toEqual({ mark: null, remove: false })
  })

  it('an older answer (no version), no health or after production: null — the page reads the health itself, as before', () => {
    expect(healthViewOf(so, { ...HEADLINE, health: { ...HEADLINE.health!, version: undefined } })).toBeNull()
    expect(healthViewOf(so, { ...HEADLINE, health: null })).toBeNull()
    expect(healthViewOf(order('SHIPPED'), at({}))).toBeNull()
  })

  it('the wiring: the container hands the headline\'s view and a headline re-read; the hook skips its GET with it', () => {
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("health: { view: ready && production.state?.status === 'ready' ? healthViewOf(ready, production.state.read.headline) : null, reread: () => production.again(['headline']) }")
    const hook = readFileSync(new URL('../../../../../lib/production/health/use-health.ts', import.meta.url), 'utf8')
    expect(hook).toContain('if (!fromPage) read()')
    expect(hook).toContain('if (knownRef.current) knownRef.current.reread()')
  })
})
// ---- end F-PT-404
