/**
 * AX-ZD.1 — the typed mutation state machine, and the defect it removes.
 *
 * The first block is the one that matters: it reproduces the campaign-wide
 * lookup and shows it misclassifies, then shows the field-scoped one does not.
 * Without that, the rest is testing a vocabulary nobody disputed.
 */
import { describe, it, expect } from 'vitest'
import {
  AD_MUTATION_STATES, IN_FLIGHT_STATES, TERMINAL_STATES,
  PENDING_TRUST_WINDOW_MS, isBelievablyPending, isTerminal, stateForQueueStatus,
} from './ad-mutation-state.js'

describe('the defect: a campaign-wide pending lookup hides real external edits', () => {
  // One operator write in flight: the budget. Someone then renames the campaign
  // in Seller Central and changes its bidding strategy.
  const inFlight = [{ entityId: 'camp_1', field: 'dailyBudget' }]
  const driftingFields = ['dailyBudget', 'name', 'biddingStrategy']

  it('OLD — one queued budget write marks EVERY drifting field as WRITE_PENDING', () => {
    // Exactly the old shape: count rows for the campaign, once, then reuse it.
    const campaignWideCount = inFlight.filter((m) => m.entityId === 'camp_1').length
    const classified = driftingFields.map((f) => ({ f, hasPendingWrite: campaignWideCount > 0 }))

    // The name change and the strategy change are real external edits, and both
    // are explained away as our own pending write. This is the live bug.
    expect(classified.every((c) => c.hasPendingWrite)).toBe(true)
    expect(classified.find((c) => c.f === 'name')!.hasPendingWrite).toBe(true)
  })

  it('NEW — field-scoped, only the budget is explained; the edits surface', () => {
    const pending = new Set(inFlight.map((m) => m.field))
    const classified = driftingFields.map((f) => ({ f, hasPendingWrite: pending.has(f) }))

    expect(classified.find((c) => c.f === 'dailyBudget')!.hasPendingWrite).toBe(true)
    expect(classified.find((c) => c.f === 'name')!.hasPendingWrite).toBe(false)
    expect(classified.find((c) => c.f === 'biddingStrategy')!.hasPendingWrite).toBe(false)
  })
})

describe('state vocabulary', () => {
  it('every state is either in-flight or terminal — no state is both or neither', () => {
    for (const s of AD_MUTATION_STATES) {
      const inflight = (IN_FLIGHT_STATES as readonly string[]).includes(s)
      const terminal = (TERMINAL_STATES as readonly string[]).includes(s)
      expect(inflight !== terminal, `${s} is ${inflight && terminal ? 'both' : 'neither'}`).toBe(true)
    }
  })

  it('isTerminal agrees with the terminal list', () => {
    expect(isTerminal('APPLIED')).toBe(true)
    expect(isTerminal('CANCELLED')).toBe(true)
    expect(isTerminal('PENDING')).toBe(false)
    expect(isTerminal('IN_FLIGHT')).toBe(false)
  })
})

describe('stateForQueueStatus — the projection from the dispatch path', () => {
  it('maps the queue lifecycle', () => {
    expect(stateForQueueStatus('PENDING')).toBe('PENDING')
    expect(stateForQueueStatus('IN_PROGRESS')).toBe('IN_FLIGHT')
    expect(stateForQueueStatus('SUCCESS')).toBe('APPLIED')
    expect(stateForQueueStatus('CANCELLED')).toBe('CANCELLED')
  })

  it('a retryable failure stays in flight — only a dead row is terminal', () => {
    // The queue row returns to PENDING between retries. Calling that FAILED
    // would let drift re-open on a field we are still actively writing.
    expect(isTerminal(stateForQueueStatus('PENDING', false))).toBe(false)
    expect(stateForQueueStatus('FAILED', true)).toBe('FAILED')
    expect(isTerminal(stateForQueueStatus('FAILED', true))).toBe(true)
  })

  it('a gate denial is CANCELLED, not FAILED — nothing reached Amazon', () => {
    expect(stateForQueueStatus('SKIPPED')).toBe('CANCELLED')
  })

  it('an unknown status is treated as still in flight, never as applied', () => {
    // Guessing APPLIED on an unrecognised status would suppress drift on a
    // write that may never have landed.
    expect(stateForQueueStatus('SOMETHING_NEW')).toBe('PENDING')
    expect(isTerminal(stateForQueueStatus('SOMETHING_NEW'))).toBe(false)
  })
})

describe('the trust window bounds a missed settlement', () => {
  const now = new Date('2026-07-28T12:00:00Z')
  const at = (msAgo: number) => new Date(now.getTime() - msAgo)

  it('a fresh pending row is believed', () => {
    expect(isBelievablyPending({ state: 'PENDING', createdAt: at(60_000) }, now)).toBe(true)
  })

  it('a terminal row is never pending regardless of age', () => {
    expect(isBelievablyPending({ state: 'APPLIED', createdAt: at(1000) }, now)).toBe(false)
  })

  it('a stuck row stops suppressing drift once the window passes', () => {
    // The failure this guards: a settlement write missed after a crash leaves
    // the row PENDING forever, silently hiding drift on that field for good.
    expect(isBelievablyPending({ state: 'PENDING', createdAt: at(PENDING_TRUST_WINDOW_MS - 1) }, now)).toBe(true)
    expect(isBelievablyPending({ state: 'PENDING', createdAt: at(PENDING_TRUST_WINDOW_MS + 1) }, now)).toBe(false)
  })

  it('the window comfortably exceeds the full retry ladder', () => {
    // Grace period + sum of 2^n minute backoffs to maxRetries (5). If this ever
    // stops holding, a healthy write would be declared stale mid-flight.
    const grace = 5 * 60 * 1000
    const ladder = [1, 2, 3, 4, 5].reduce((a, n) => a + Math.pow(2, n) * 60 * 1000, 0)
    expect(PENDING_TRUST_WINDOW_MS).toBeGreaterThan((grace + ladder) * 10)
  })
})
