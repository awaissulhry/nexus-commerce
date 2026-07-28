/**
 * AX-ZD.4 — drift classification.
 *
 * The whole value of this module is not noticing that two values differ — that
 * is trivial — it is refusing to call our own in-flight write "somebody edited
 * this in Seller Central". One false accusation of that kind and an operator
 * stops believing every drift report afterwards.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyDrift, describeDrift, isOurs, normaliseForCompare, diffFields,
  WRITE_LAG_GRACE_MS, holdBackPendingFields } from './drift.js'

const NOW = new Date('2026-07-28T12:00:00Z')
const agoMs = (ms: number) => new Date(NOW.getTime() - ms)

describe('classification', () => {
  it('blames nobody when our own change is still queued', () => {
    expect(classifyDrift({ ours: '20', theirs: '10', hasPendingWrite: true, now: NOW })).toBe('WRITE_PENDING')
  })

  it('calls a just-written difference lag, not an external edit', () => {
    expect(classifyDrift({ ours: '20', theirs: '10', lastWriteAt: agoMs(60_000), now: NOW })).toBe('WRITE_LAG')
    expect(classifyDrift({ ours: '20', theirs: '10', lastWriteAt: agoMs(WRITE_LAG_GRACE_MS - 1000), now: NOW })).toBe('WRITE_LAG')
  })

  it('stops calling it lag once the grace window has passed', () => {
    expect(classifyDrift({ ours: '20', theirs: '10', lastWriteAt: agoMs(WRITE_LAG_GRACE_MS + 1000), now: NOW })).toBe('EXTERNAL_CHANGE')
  })

  it('says a FAILED write is why Amazon still holds the old value', () => {
    // Blaming a human here would send someone hunting for an edit that never happened.
    expect(classifyDrift({ ours: '20', theirs: '10', lastWriteAt: agoMs(3 * 3600_000), lastWriteStatus: 'FAILED', now: NOW })).toBe('WRITE_FAILED')
  })

  it('treats a difference with no write of ours as an external change', () => {
    expect(classifyDrift({ ours: '20', theirs: '10', now: NOW })).toBe('EXTERNAL_CHANGE')
    expect(classifyDrift({ ours: '20', theirs: '10', lastWriteAt: null, now: NOW })).toBe('EXTERNAL_CHANGE')
  })

  it('ignores a write timestamp from the future rather than trusting it', () => {
    // Clock skew between the app and the DB must not silently excuse real drift.
    expect(classifyDrift({ ours: '20', theirs: '10', lastWriteAt: new Date(NOW.getTime() + 60_000), now: NOW })).toBe('EXTERNAL_CHANGE')
  })

  it('separates ours from theirs', () => {
    expect(isOurs('EXTERNAL_CHANGE')).toBe(false)
    for (const c of ['WRITE_LAG', 'WRITE_PENDING', 'WRITE_FAILED'] as const) expect(isOurs(c)).toBe(true)
  })

  it('describes every class in words, and says which one will not self-heal', () => {
    expect(describeDrift('WRITE_LAG', 'Daily budget')).toContain('resolve on its own')
    expect(describeDrift('WRITE_PENDING', 'Bid')).toContain('resolve on its own')
    expect(describeDrift('WRITE_FAILED', 'State')).toContain('will not fix itself')
    expect(describeDrift('EXTERNAL_CHANGE', 'State')).toContain('Seller Central')
  })
})

describe('comparison', () => {
  it('does not report formatting as drift', () => {
    expect(normaliseForCompare(20)).toBe(normaliseForCompare('20.00'))
    expect(normaliseForCompare('ENABLED')).toBe(normaliseForCompare('enabled'))
    expect(normaliseForCompare(' paused ')).toBe('paused')
  })

  it('treats empty and null alike', () => {
    expect(normaliseForCompare(null)).toBeNull()
    expect(normaliseForCompare('')).toBeNull()
    expect(normaliseForCompare('   ')).toBeNull()
  })

  it('finds real differences only', () => {
    const d = diffFields(
      { status: 'ENABLED', dailyBudget: 20, name: 'A' },
      { status: 'paused', dailyBudget: '20.00', name: 'A' },
      ['status', 'dailyBudget', 'name'],
    )
    expect(d).toEqual([{ field: 'status', ours: 'enabled', theirs: 'paused' }])
  })

  it('SKIPS a field Amazon did not report, rather than reading it as cleared', () => {
    // A partial response must never look like somebody blanking a value.
    expect(diffFields({ dailyBudget: 20 }, {}, ['dailyBudget'])).toEqual([])
    expect(diffFields({ dailyBudget: 20 }, { dailyBudget: null }, ['dailyBudget'])).toEqual([])
    expect(diffFields({ dailyBudget: 20 }, { dailyBudget: '' }, ['dailyBudget'])).toEqual([])
  })

  it('SKIPS a field we have never held, rather than calling it an external edit', () => {
    // Caught in production: the first live run flagged 135 campaigns as
    // EXTERNAL_CHANGE on targetingType, which was just a newly-added column
    // filling in. We cannot have drifted from a value we never observed, and a
    // drift report that cries wolf on its first run is one nobody opens again.
    expect(diffFields({}, { portfolioId: '123' }, ['portfolioId'])).toEqual([])
    expect(diffFields({ targetingType: null }, { targetingType: 'MANUAL' }, ['targetingType'])).toEqual([])
  })

  it('still reports a real disagreement between two known values', () => {
    expect(diffFields({ portfolioId: '111' }, { portfolioId: '222' }, ['portfolioId'])).toEqual([
      { field: 'portfolioId', ours: '111', theirs: '222' },
    ])
  })
})

describe('AX-ZD.3 — a read must not clobber an undelivered write', () => {
  it('passes everything through when nothing is pending', () => {
    const incoming = { dailyBudget: 10, status: 'ENABLED' }
    expect(holdBackPendingFields(incoming, new Set())).toEqual(incoming)
  })

  it('holds back only the pending field, not the whole update', () => {
    // The scenario: operator sets budget 12, the poll lands inside the grace
    // window and reports Amazon's old 10. Without this, their change reverts on
    // screen and then flips back when the write lands.
    const out = holdBackPendingFields(
      { dailyBudget: 10, status: 'PAUSED', targetingType: 'MANUAL' },
      new Set(['dailyBudget']),
    )
    expect(out).not.toHaveProperty('dailyBudget')
    expect(out.status).toBe('PAUSED')       // no pending write — Amazon still wins
    expect(out.targetingType).toBe('MANUAL')
  })

  it('does not mutate the caller’s object', () => {
    const incoming = { dailyBudget: 10, status: 'PAUSED' }
    holdBackPendingFields(incoming, new Set(['dailyBudget']))
    expect(incoming.dailyBudget).toBe(10)
  })

  it('protects biddingStrategy inside dynamicBidding, not just the column', () => {
    // biddingStrategy is both a scalar column and a key inside the blob.
    // Holding back only the column would let Amazon's value return through the
    // blob and undo the hold-back with nothing to show for it.
    const out = holdBackPendingFields(
      { biddingStrategy: 'MANUAL', dynamicBidding: { strategy: 'MANUAL', placementBidding: [{ p: 1 }] } },
      new Set(['biddingStrategy']),
      { strategy: 'AUTO_FOR_SALES' },
    )
    expect(out).not.toHaveProperty('biddingStrategy')
    expect((out.dynamicBidding as Record<string, unknown>).strategy).toBe('AUTO_FOR_SALES')
    // Placement bids are a different write path and must still come through.
    expect((out.dynamicBidding as Record<string, unknown>).placementBidding).toEqual([{ p: 1 }])
  })

  it('leaves dynamicBidding alone when biddingStrategy is not pending', () => {
    const out = holdBackPendingFields(
      { dailyBudget: 9, dynamicBidding: { strategy: 'MANUAL' } },
      new Set(['dailyBudget']),
      { strategy: 'AUTO_FOR_SALES' },
    )
    expect((out.dynamicBidding as Record<string, unknown>).strategy).toBe('MANUAL')
  })
})
