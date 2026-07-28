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
  WRITE_LAG_GRACE_MS,
} from './drift.js'

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

  it('reports a value we do not hold but Amazon does', () => {
    expect(diffFields({}, { portfolioId: '123' }, ['portfolioId'])).toEqual([
      { field: 'portfolioId', ours: null, theirs: '123' },
    ])
  })
})
