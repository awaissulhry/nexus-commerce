/**
 * Bid page — the Brain's Stop the brain / Start again (Owner 2026-10-12): which button shows when and why it is held, the
 * confirm's words, the request bodies and the answers in words. Made-up names and numbers only (public repo).
 */
import { describe, expect, it } from 'vitest'
import { BRAIN_ID, type BidRuleRow, type BrainStop } from './bidRulesModel'
import {
  BRAIN_STOP_LEVER, START_WHY, STOP_HELD, STOP_WHY, brainStopView, startBody, startCodeWords, startConfirmWords, startingHeld, startNotice, stopBody,
  stopConfirmWords, stopNotice,
} from './brainStop'

const ref = (id: string) => ({ id, name: `Jacket ${id}`, href: `/marketing/ads/campaigns/${id}` })

function brain(over: Partial<BidRuleRow> = {}): BidRuleRow {
  return {
    id: BRAIN_ID, kind: 'brain', name: 'Brain', sentence: 'Bids to the ACoS goal', market: 'IT',
    mode: { set: 'AUTO', acts: 'AUTO', heldBy: null, also: [], autoLocked: null },
    scope: { portfolios: [], campaigns: [ref('c1'), ref('c2'), ref('c3')], adGroups: [], all: false, product: null, counts: { portfolios: 0, campaigns: 3, adGroups: 0 } },
    changed7d: { portfolios: [], campaigns: [], adGroups: [], bids: 0, keywords: 0 },
    last7d: { runs: 4, asks: 0, applied: 0, written: 0, brainInputs: 0, refused: 0 },
    waiting: 0, lastRunAt: null, nextRunAt: null, effect: null, archived: false,
    stop: null,
    ...over,
  }
}
const stopIT: BrainStop = { market: 'IT', at: '2026-01-10T08:00:00.000Z', reason: STOP_WHY }
const stopAll: BrainStop = { market: null, at: '2026-01-10T08:00:00.000Z', reason: STOP_WHY }
const free = { held: null, canSecurity: true }

describe('which button the Brain detail shows', () => {
  it('the brain runs on Auto and nothing stops it: Stop the brain, ready', () => {
    expect(brainStopView(brain(), free)).toEqual({ action: 'stop', label: 'Stop the brain', variant: 'danger', held: null, hint: null })
  })

  it('a stop stands: Start again, with when and where on hover', () => {
    const v = brainStopView(brain({ stop: stopIT, mode: { set: 'AUTO', acts: 'OFF', heldBy: { kind: 'stopped', label: 'Brain off', reason: 'You stopped the brain\'s bids there, so nothing changes.' }, also: [], autoLocked: null } }), free)
    expect(v).toMatchObject({ action: 'start', label: 'Start again', variant: 'secondary', held: null })
    expect(v?.hint).toMatch(/^Stopped in IT · /)
    expect(brainStopView(brain({ stop: stopAll }), free)?.hint).toMatch(/^Stopped in every market · /)
  })

  it('held with the reason: the page\'s (permission, a market Nexus only reads) first, then the brain\'s own', () => {
    expect(brainStopView(brain(), { held: 'Needs the ads automation permission', canSecurity: true })?.held).toBe('Needs the ads automation permission')
    expect(brainStopView(brain(), { held: 'Amazon FR: Nexus only reads this market', canSecurity: true })?.held).toBe('Amazon FR: Nexus only reads this market')
    expect(brainStopView(brain({ stop: stopIT }), { held: 'Needs the ads automation permission', canSecurity: true })?.held).toBe('Needs the ads automation permission')
    // Watch only: it changes no bids here, so there is nothing to stop.
    expect(brainStopView(brain({ mode: { set: 'WATCH', acts: 'WATCH', heldBy: null, also: [], autoLocked: null } }), free)?.held).toBe(STOP_HELD.watching)
    // Start again takes the code: the security permission.
    expect(brainStopView(brain({ stop: stopIT }), { held: null, canSecurity: false })?.held).toBe(STOP_HELD.security)
    // An approved Start again waiting to run.
    expect(brainStopView(brain({ stop: stopIT }), { ...free, busy: 'Starting: runs in 20 s' })?.held).toBe('Starting: runs in 20 s')
  })

  it('an answer that does not say whether a stop stands holds Stop (never a guess); a rule shows none', () => {
    const { stop: _unused, ...older } = brain()
    expect(brainStopView(older as BidRuleRow, free)).toMatchObject({ action: 'stop', held: STOP_HELD.unread })
    expect(brainStopView(brain({ id: 'r1', kind: 'rule' }), free)).toBeNull()
  })
})

describe('the confirm', () => {
  it('Stop: its campaigns and the market in view, bids stay', () => {
    expect(stopConfirmWords(brain(), 'IT')).toEqual({
      title: 'Stop the brain?',
      line: 'It stops changing bids on its 3 campaigns in IT at once. Bids stay where they are.',
      cancel: 'Keep running', confirm: 'Stop now', busy: 'Stopping…', tone: 'danger',
    })
    expect(stopConfirmWords(brain({ scope: { ...brain().scope, campaigns: [ref('c1')], counts: { portfolios: 0, campaigns: 1, adGroups: 0 } } }), 'all').line)
      .toBe('It stops changing bids on its 1 campaign in every market at once. Bids stay where they are.')
    // The true total, not the list's length (the list stops at 100).
    expect(stopConfirmWords(brain({ scope: { ...brain().scope, counts: { portfolios: 0, campaigns: 120, adGroups: 0 } } }), 'DE').line).toContain('its 120 campaigns in DE')
  })

  it('Start again: the stop\'s own market; a stop of every market seen from one market says so', () => {
    expect(startConfirmWords(brain({ stop: stopIT }), 'IT', stopIT)).toEqual({
      title: 'Start the brain again?',
      line: 'It changes bids on its 3 campaigns in IT again, inside your limits. Next: the code from your authenticator app.',
      cancel: 'Keep stopped', confirm: 'Start again', busy: 'Starting…', tone: 'primary',
    })
    expect(startConfirmWords(brain({ stop: stopAll }), 'IT', stopAll).line).toBe('It changes bids in every market again, inside your limits. Next: the code from your authenticator app.')
    expect(startConfirmWords(brain({ stop: stopAll }), 'all', stopAll).line).toContain('on its 3 campaigns in every market again')
    expect(startCodeWords(stopIT)).toEqual({ title: 'Start the brain again', sentence: 'The brain changes bids in IT again. Approving it takes the code from your authenticator app.', confirm: 'Start again' })
  })
})

describe('the requests', () => {
  it('Stop: the bids lever for every product of the market in view; All markets names no market', () => {
    expect(BRAIN_STOP_LEVER).toBe('bids')
    expect(stopBody('IT')).toEqual({ op: 'kill', lever: 'bids', why: STOP_WHY, market: 'IT' })
    expect(stopBody('all')).toEqual({ op: 'kill', lever: 'bids', why: STOP_WHY })
    // Never a product, never the code: a stop runs at once on the click.
    expect(stopBody('IT')).not.toHaveProperty('productId')
    expect(stopBody('IT')).not.toHaveProperty('code')
  })

  it('Start again: ends the stop the row names, approved in the same click with the code', () => {
    expect(startBody(stopIT, '123456')).toEqual({ op: 'end', lever: 'bids', why: START_WHY, market: 'IT', approve: true, code: '123456' })
    expect(startBody(stopAll, '123456')).toEqual({ op: 'end', lever: 'bids', why: START_WHY, approve: true, code: '123456' })
  })
})

describe('the answers, in words', () => {
  const now = Date.parse('2026-01-10T08:00:00.000Z')
  it('Stop: done at once, waiting, or refused with the server\'s reason', () => {
    expect(stopNotice({ ok: true, body: { approvalId: 'a1', status: 'executed' } })).toEqual({ tone: 'success', title: 'Brain stopped', body: 'Bids stay where they are.' })
    expect(stopNotice({ ok: true, body: { approvalId: 'a1', status: 'pending', approve: { ok: false, error: 'it did not run' } } })).toEqual({ tone: 'warning', title: 'Waiting for approval', body: 'it did not run' })
    expect(stopNotice({ ok: false, words: 'Needs the ads automation permission.' })).toEqual({ tone: 'danger', title: 'Not stopped', body: 'Needs the ads automation permission.' })
  })

  it('Start again: approved and when it runs, or refused', () => {
    expect(startNotice({ ok: true, executeAfter: '2026-01-10T08:00:20.000Z' }, now)).toMatchObject({ tone: 'info', title: 'Starting again' })
    expect(startNotice({ ok: true, executeAfter: '2026-01-10T08:00:20.000Z' }, now).body).toMatch(/^Approved · runs /)
    expect(startNotice({ ok: true }, now)).toEqual({ tone: 'success', title: 'Brain started again', body: 'Approved' })
    expect(startNotice({ ok: false, words: 'no kill switch stops the bids lever of every product in IT: nothing to end' }, now))
      .toEqual({ tone: 'danger', title: 'Not started', body: 'no kill switch stops the bids lever of every product in IT: nothing to end' })
  })

  it('while an approved Start again waits to run, the button says so; after it, nothing', () => {
    expect(startingHeld('2026-01-10T08:00:20.000Z', now)).toMatch(/^Starting: runs /)
    expect(startingHeld('2026-01-10T07:59:00.000Z', now)).toBeNull()
    expect(startingHeld(null, now)).toBeNull()
  })
})
