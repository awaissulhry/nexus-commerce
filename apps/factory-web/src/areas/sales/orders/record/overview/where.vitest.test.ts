import { describe, expect, it } from 'vitest'
import { order } from '../../_demo/fixtures'
import { CONFIRMED_READ, HEADLINE, PRODUCTION_READ } from './fixtures'
import { exFactoryOf, headlineOf, inWorkOf, preparingNote, stageStripOf } from './where'
import { bandHealthOf, healthInputOf, waitingOf, whoActsNextOf } from './model'

/**
 * F-OO-100 (order overview lane: one file per section) — "Where it is now"'s rules, moved with where.ts out of overview.vitest.test.ts
 * unchanged (F-SA-232: the headline sentence per state, the five stages, who acts next, the health only from the reads).
 */

describe('"Where it is now": one sentence per state', () => {
  it('in production: the plain stage and "1 line ahead"; before: the commercial words; after: shipped and delivered', () => {
    expect(headlineOf(order('IN_PRODUCTION'), HEADLINE)).toEqual({ kind: 'stage', stage: 'SEWING', ahead: { key: 'overview.ahead', params: { count: 1 } } })
    expect(headlineOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: { ...HEADLINE.stage!, ahead: 0 } })).toEqual({ kind: 'stage', stage: 'SEWING', ahead: null })
    expect(headlineOf(order('PENDING_APPROVAL'), HEADLINE)).toEqual({ kind: 'phrase', phrase: { key: 'status.PENDING_APPROVAL' } })
    expect(headlineOf(order('CONFIRMED'), CONFIRMED_READ.headline)).toEqual({ kind: 'phrase', phrase: { key: 'overview.headline.waitingDeposit' } })
    const shipped = order('SHIPPED')
    const words = headlineOf(shipped, HEADLINE)
    expect(words.kind).toBe('phrase')
    if (words.kind === 'phrase') expect(words.phrase.key).toMatch(/^overview\.headline\.(shipped|delivered)$|^status\.SHIPPED$/)
    expect(headlineOf(order('CANCELLED'), HEADLINE)).toEqual({ kind: 'phrase', phrase: { key: 'status.CANCELLED' } })
    // In production with no stage read: "Stage not known yet", never step 1.
    expect(headlineOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: null })).toEqual({ kind: 'unknown' })
  })

  it('the stages: the stage now with its day, the working plan, blocked with why; before any work order Preparing after the deposit', () => {
    const strip = stageStripOf(order('IN_PRODUCTION'), HEADLINE, PRODUCTION_READ.dates, 'en')
    expect(strip).toMatchObject({ stage: 'SEWING', reached: { SEWING: '2026-11-13' }, sewingCounted: true, blocked: null, expected: { CUTTING: '2026-11-10', SEWING: '2026-11-13', QUALITY: '2026-12-10' } })
    const held = stageStripOf(order('IN_PRODUCTION'), { ...HEADLINE, held: true, holds: [{ kind: 'QUALITY', words: { en: 'Quality hold', it: 'Sospensione qualità' }, since: '2026-11-14' }] }, null, 'it')
    expect(held.blocked).toEqual({ why: 'Sospensione qualità' })
    expect(stageStripOf(order('CONFIRMED'), CONFIRMED_READ.headline, null, 'en').stage).toBe('PREPARING')
    expect(preparingNote(order('CONFIRMED'), CONFIRMED_READ.headline)).toEqual({ key: 'overview.afterDeposit' })
    expect(stageStripOf(order('IN_PRODUCTION'), { ...HEADLINE, stage: null }, null, 'en').stage).toBeNull()
  })

  it('who acts next, the ex-factory slip, the bundles as counts only (OW-6), the health from the keeper else the order’s lateness', () => {
    // F-OP-103: who acts next is the ONE waiting list's first row.
    const rows = waitingOf({ headline: HEADLINE }, { requests: [], approvals: [], recordPayment: false, locale: 'it' })
    expect(whoActsNextOf(rows, HEADLINE)).toMatchObject({ who: 'US', since: '2026-11-17T09:05:00Z', kind: 'request' })
    expect(whoActsNextOf([], null)).toEqual({ who: undefined, since: null, kind: 'record', row: null, still: null })
    expect(exFactoryOf(order('IN_PRODUCTION'), HEADLINE)).toEqual({ key: 'overview.exFactoryMoved', params: { date: '2026-12-15', count: 2, days: '+6' } })
    expect(inWorkOf(HEADLINE)).toEqual({ count: 3, stage: 'SEWING' })
    expect(inWorkOf(CONFIRMED_READ.headline)).toBeNull()
    const atRisk = healthInputOf(order('IN_PRODUCTION'), HEADLINE)
    expect(atRisk.computed).toBe('AT_RISK')
    expect(bandHealthOf(atRisk)).toBe(true)
    expect(bandHealthOf(healthInputOf(order('IN_PRODUCTION'), { ...HEADLINE, health: { ...HEADLINE.health!, code: 'ON_TRACK', computed: 'ON_TRACK' } }))).toBe(false)
    // No state kept yet: the order read's own lateness, in the same words.
    const late = healthInputOf({ ...order('IN_PRODUCTION'), daysLate: 3 }, { ...HEADLINE, health: null })
    expect(late).toMatchObject({ computed: 'LATE', daysLate: 3 })
    expect(healthInputOf(order('IN_PRODUCTION'), null).computed).toBeUndefined()
  })
})
