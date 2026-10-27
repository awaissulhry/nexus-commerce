/**
 * Negative Targeting page, step 4 — "Did it work?", pure: the windows of a stop (min(days, 30) days before
 * the stop day, the days after it to 3 days ago, never older than Nexus keeps), too early under 14 days with no money,
 * the saving (before per day × the days counted − after), still spends elsewhere, and words with no money in them.
 * Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { EFFECT_MIN_DAYS, effectWindows, stopEffect } from './effect.js'
import { dayIndex } from './pure.js'

const NOW = new Date('2026-10-25T10:00:00Z')
const TODAY = dayIndex(NOW)
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()

describe('effectWindows', () => {
  it('40 days ago: the 30 days before the stop day, the days after it to 3 days ago (the stop day in neither)', () => {
    const w = effectWindows(ago(40), NOW)
    expect(w).toEqual({
      stopDay: TODAY - 40, days: 40,
      before: { from: TODAY - 70, to: TODAY - 41, days: 30 },
      after: { from: TODAY - 39, to: TODAY - 3, days: 37 },
    })
  })

  it('20 days ago: as many days before as since; 80 days ago: only the days Nexus keeps; 89 days ago: too few, no before', () => {
    expect(effectWindows(ago(20), NOW).before).toEqual({ from: TODAY - 40, to: TODAY - 21, days: 20 })
    expect(effectWindows(ago(80), NOW).before).toEqual({ from: TODAY - 92, to: TODAY - 81, days: 12 })
    expect(effectWindows(ago(89), NOW).before).toBeNull()
  })
})

describe('stopEffect', () => {
  it(`too early under ${EFFECT_MIN_DAYS} days: no money claim, whatever was spent`, () => {
    expect(stopEffect({ since: ago(9), now: NOW, spend: { before: 9000, after: 0 }, stillIn: 0 })).toEqual({
      since: ago(9), days: 9, verdict: 'TOO_EARLY', beforePerDayCents: null, afterCents: null, savedCents: null, words: 'Stopped 9 days ago, checked from 14 days',
    })
    expect(stopEffect({ since: ago(13), now: NOW, spend: null, stillIn: 2 })!.verdict).toBe('TOO_EARLY')
  })

  it('saved: before per day × the days counted after − after', () => {
    // 9000 over the 30 days before = 300 a day; 37 days counted after; 500 spent after.
    expect(stopEffect({ since: ago(40), now: NOW, spend: { before: 9000, after: 500 }, stillIn: 0 })).toEqual({
      since: ago(40), days: 40, verdict: 'SAVED', beforePerDayCents: 300, afterCents: 500, savedCents: 300 * 37 - 500, words: 'Spends less here in the 37 days since the stop',
    })
    expect(stopEffect({ since: ago(30), now: NOW, spend: { before: 4500, after: 0 }, stillIn: 0 })).toMatchObject({ verdict: 'SAVED', beforePerDayCents: 150, savedCents: 150 * 27, words: 'No spend here in the 27 days since the stop' })
  })

  it('it spends more than before (HONEST 14: a saving below 0 is said as more, never "as much"); as much; nothing before nor since', () => {
    expect(stopEffect({ since: ago(20), now: NOW, spend: { before: 2000, after: 2500 }, stillIn: 0 })).toMatchObject({ verdict: 'SAVED', savedCents: 100 * 17 - 2500, words: 'Spends more here in the 17 days since the stop than before it' })
    // 1700 over the 20 days before = 85 a day × 17 days = 1445: spent exactly that since, so it saved 0.
    expect(stopEffect({ since: ago(20), now: NOW, spend: { before: 1700, after: 1445 }, stillIn: 0 })).toMatchObject({ savedCents: 0, words: 'Spends as much here as before, in the 17 days since the stop' })
    // Nothing before, something since: more, never "as much".
    expect(stopEffect({ since: ago(20), now: NOW, spend: { before: 0, after: 300 }, stillIn: 0 })!.words).toBe('Spends more here in the 17 days since the stop than before it')
    expect(stopEffect({ since: ago(20), now: NOW, spend: { before: 0, after: 0 }, stillIn: 0 })).toMatchObject({ savedCents: 0, words: 'It spent nothing in the 20 days before the stop, nor in the 17 days since' })
  })

  it('still spends: its words spent in another place since the stop (HONEST 18b); the saving here is still said', () => {
    expect(stopEffect({ since: ago(40), now: NOW, spend: { before: 9000, after: 0 }, stillIn: 2 })).toMatchObject({ verdict: 'STILL_SPENDS', savedCents: 300 * 37, words: 'Stopped here, but its words spent in 2 other ad groups since the stop' })
  })

  it('no before held by Nexus, or no spend read: no effect (never a guess)', () => {
    expect(stopEffect({ since: ago(89), now: NOW, spend: { before: 100, after: 0 }, stillIn: 0 })).toBeNull()
    expect(stopEffect({ since: ago(40), now: NOW, spend: null, stillIn: 0 })).toBeNull()
  })

  it('words never carry money (the money sits under its keys)', () => {
    for (const e of [stopEffect({ since: ago(40), now: NOW, spend: { before: 9000, after: 500 }, stillIn: 0 }), stopEffect({ since: ago(40), now: NOW, spend: { before: 9000, after: 0 }, stillIn: 1 })]) {
      expect(e!.words).not.toMatch(/[€£$]|\d+[.,]\d{2}/)
    }
  })
})
