import { describe, it, expect } from 'vitest'
import { RETENTION_DAYS } from './ads-retention.job.js'

/**
 * The policy is the dangerous part of this job, not the code. These pin the invariants that make
 * the windows safe, so shortening one is a failing test rather than a silent loss of history.
 */
describe('HX.11 retention policy', () => {
  it('keeps the audit trail far longer than any undo horizon we offer', () => {
    // AdvertisingActionLog.payloadBefore is the rollback anchor; anything pruned can never be
    // undone. Our longest undo horizon is 24h (target bids), Google's is 30 days.
    const UNDO_HORIZON_DAYS = 30
    expect(RETENTION_DAYS.actionLog).toBeGreaterThan(UNDO_HORIZON_DAYS * 12)
    expect(RETENTION_DAYS.bidHistory).toBeGreaterThan(UNDO_HORIZON_DAYS * 12)
  })

  it('keeps the audit trail longer than the delivery record, which is longer than the work queue', () => {
    // The ordering IS the policy: a queue row is residue, a mutation is evidence a change landed,
    // and the audit trail is the account's history.
    expect(RETENTION_DAYS.actionLog).toBeGreaterThan(RETENTION_DAYS.mutationSettled)
    expect(RETENTION_DAYS.mutationSettled).toBeGreaterThan(RETENTION_DAYS.outboundSettled)
  })

  it('keeps failures longer than successes, in both tables', () => {
    // A failure is diagnostic — the six-day routing bug was found entirely in FAILED rows.
    expect(RETENTION_DAYS.outboundFailed).toBeGreaterThan(RETENTION_DAYS.outboundSettled)
    expect(RETENTION_DAYS.mutationFailed).toBeGreaterThan(RETENTION_DAYS.mutationSettled)
  })

  it('matches Google Ads on the audit window, the longest any comparable product offers', () => {
    expect(RETENTION_DAYS.actionLog).toBe(730)
  })

  it('never sets a window short enough to prune inside a month', () => {
    for (const [k, v] of Object.entries(RETENTION_DAYS)) {
      expect(v, `${k} is too aggressive`).toBeGreaterThanOrEqual(30)
    }
  })
})
