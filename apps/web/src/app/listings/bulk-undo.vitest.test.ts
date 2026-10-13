/**
 * The listings bulk bar's Undo (2026-10-13).
 *
 * 🔴 The Undo of a bulk "Unfollow master" ran "Follow master" on EVERY selected listing, the ones that failed and the
 * ones already unfollowed included: their own price and quantity were wiped and the master's sent. The Undo now
 * offers, counts and sends only the listings the job's answer says the action changed.
 */
import { describe, expect, it } from 'vitest'
import { bulkUndoBody, bulkUndoTargets } from './bulk-undo'

describe('bulkUndoTargets — which listings the Undo puts back', () => {
  it('🔴 a finished Unfollow master: exactly the listings its answer says it changed, not the selection', () => {
    expect(bulkUndoTargets('unfollow-master', { status: 'PARTIALLY_COMPLETED', changed: ['listing-a', 'listing-c'] })).toEqual(['listing-a', 'listing-c'])
    expect(bulkUndoTargets('unfollow-master', { status: 'COMPLETED', changed: ['listing-a'] })).toEqual(['listing-a'])
  })

  it('🔴 nothing changed (every listing failed, or all were already unfollowed): no Undo', () => {
    expect(bulkUndoTargets('unfollow-master', { status: 'FAILED', changed: [] })).toBeNull()
    expect(bulkUndoTargets('unfollow-master', { status: 'COMPLETED', changed: [] })).toBeNull()
  })

  it('an answer without `changed` (an older API) offers no Undo rather than one over the whole selection', () => {
    expect(bulkUndoTargets('unfollow-master', { status: 'COMPLETED' })).toBeNull()
    expect(bulkUndoTargets('unfollow-master', { status: 'COMPLETED', changed: 'listing-a' })).toBeNull()
    expect(bulkUndoTargets('unfollow-master', { status: 'COMPLETED', changed: [7, 'listing-a', null] })).toEqual(['listing-a'])
  })

  it('a job still running, or no answer at all: no Undo', () => {
    expect(bulkUndoTargets('unfollow-master', { status: 'IN_PROGRESS', changed: ['listing-a'] })).toBeNull()
    expect(bulkUndoTargets('unfollow-master', null)).toBeNull()
  })

  it('Follow master, Set price, a pricing rule and Resync offer no Undo', () => {
    for (const action of ['follow-master', 'set-price', 'set-pricing-rule', 'resync']) {
      expect(bulkUndoTargets(action, { status: 'COMPLETED', changed: ['listing-a'] })).toBeNull()
    }
  })
})

describe('bulkUndoBody — the Undo request', () => {
  it('names the job it puts back and the listings that job changed', () => {
    expect(bulkUndoBody('job-1', ['listing-a', 'listing-c'])).toEqual({ action: 'undo', listingIds: ['listing-a', 'listing-c'], payload: { jobId: 'job-1' } })
  })
})
