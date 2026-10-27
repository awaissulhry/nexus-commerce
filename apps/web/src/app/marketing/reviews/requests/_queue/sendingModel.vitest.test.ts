import { describe, expect, it } from 'vitest'
import type { SendingState } from './queueDatasource'
import { pauseReasonHeld, runConfirm, runResultWords, sendingBannerView, splitWords } from './sendingModel'

const TZ = 'Europe/Rome'
const ON: SendingState = {
  paused: null,
  nextRunAt: '2026-10-26T13:00:00Z',
  hourly: 'Runs every hour',
  lastRun: { at: '2026-10-26T12:00:00Z', by: 'the hourly sender', ok: true, sent: 12, failed: 0, skipped: 3, tooEarly: 3, words: '12 sent, 3 too early (they try again tomorrow), 0 failed' },
  due: { amazon: { total: 12, byMarket: { DE: 3, IT: 7, FR: 2 } }, email: { total: 6, byChannel: { SHOPIFY: 2, EBAY: 4 } } },
  runHeld: null,
}

describe('sending banner', () => {
  it('says sending is on, when it runs next and what the last run did', () => {
    const v = sendingBannerView(ON, TZ)
    expect(v.state).toBe('on')
    expect(v.tone).toBe('info')
    expect(v.title).toBe('Sending is on — next run 14:00')
    expect(v.detail).toBe('Runs every hour. Last run 26 Oct at 13:00 by the hourly sender — 12 sent, 3 too early (they try again tomorrow), 0 failed.')
    expect(v.runHeld).toBeNull()
  })

  it('warns when the hourly sender is not known to run', () => {
    const v = sendingBannerView({ ...ON, nextRunAt: null, hourly: 'The hourly sender has not run in the last 2 hours', lastRun: null }, TZ)
    expect(v).toMatchObject({ tone: 'warning', title: 'Sending is on', detail: 'The hourly sender has not run in the last 2 hours. No run yet.' })
  })

  it('says who paused, when and why, what waits, and holds Run now', () => {
    const v = sendingBannerView({ ...ON, paused: { by: 'A person', at: '2026-10-25T16:40:00Z', reason: 'Checking the new rule' }, runHeld: 'Sending is paused. Resume first, then run.' }, TZ)
    expect(v.state).toBe('paused')
    expect(v.title).toBe('Sending is paused — nothing goes out until you resume')
    expect(v.detail).toBe('Paused by A person on 25 Oct at 17:40 · reason: “Checking the new rule”. Requests keep their place; 18 requests are due and wait. Amazon’s day-30 limit still counts while paused.')
    expect(v.runHeld).toBe('Sending is paused. Resume first, then run.')
  })
})

describe('run now', () => {
  it('lists what it sends, by market and by channel, before anything goes', () => {
    const c = runConfirm(ON, TZ)
    expect(c.title).toBe('Send the due requests now?')
    expect(c.confirmLabel).toBe('Run now — 18 requests')
    expect(c.consequences).toEqual([
      'Asks Amazon to send 12 review requests (Italy 7, Germany 3, France 2)',
      'Sends our review email to 6 buyers (eBay 4, Shopify 2)',
      'Adds orders delivered since the last run to the queue',
      'A sent request cannot be taken back.',
    ])
    expect(c.sideEffects).toEqual(['Amazon may answer “too early” for some — they try again tomorrow', 'The sender also runs on its own every hour — next at 14:00'])
  })

  it('counts the requests whose rule asks “How was it?” first apart: that e-mail goes, not the request (B19)', () => {
    const c = runConfirm({ ...ON, due: { amazon: { ...ON.due.amazon, checkFirst: 2 }, email: { ...ON.due.email, checkFirst: 1 } } }, TZ)
    expect(c.consequences.slice(0, 3)).toEqual([
      'Asks Amazon to send 10 review requests',
      'Sends our review email to 5 buyers',
      'Sends our “How was it?” email first to 3 buyers — their review request follows their answer, or 5 days',
    ])
  })

  it('says when nothing is due', () => {
    const c = runConfirm({ ...ON, nextRunAt: null, due: { amazon: { total: 0, byMarket: {} }, email: { total: 0, byChannel: {} } } })
    expect(c.confirmLabel).toBe('Run now')
    expect(c.consequences[0]).toBe('Nothing is due right now')
    expect(c.sideEffects).toEqual(['The sender also runs on its own every hour'])
  })

  it('orders splits biggest first and words a run’s result', () => {
    expect(splitWords({ b: 1, a: 1, c: 5, d: 0 }, (k) => k.toUpperCase())).toBe('C 5, A 1, B 1')
    expect(runResultWords({ sent: 4, failed: 1, tooEarly: 2 })).toBe('Run finished: 4 sent, 2 too early (they try again tomorrow), 1 failed')
    expect(runResultWords({ paused: true })).toBe('Nothing went out: sending is paused')
  })

  it('asks for a short reason before pausing', () => {
    expect(pauseReasonHeld('  ')).toBe('Say why sending is paused — the reason shows on this page')
    expect(pauseReasonHeld('x'.repeat(301))).toBe('Keep the reason under 300 characters (301 now)')
    expect(pauseReasonHeld('Checking the new rule')).toBeNull()
  })
})
