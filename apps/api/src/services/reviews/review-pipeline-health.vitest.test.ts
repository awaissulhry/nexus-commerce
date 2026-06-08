/**
 * RRL.6 — guards the review-pipeline starvation alerting (the "never silently
 * starve again" safety net). Pure function, no DB/network: given the raw order
 * counts, it must flag a stall and emit the right operator warning. Boundary
 * tests assume the default thresholds (overdue ≥10, backlog ≥15).
 */
import { describe, it, expect } from 'vitest'
import { evaluatePipelineFreshness } from './review-pipeline-health.service.js'

const DAY = 86_400_000
const NOW = new Date('2026-06-09T12:00:00.000Z').getTime()
const base = {
  now: NOW,
  maxDeliveredAt: new Date(NOW - 1 * DAY),
  recentShipped: 40,
  overdueUndelivered: 0,
  schedulingBacklog: 0,
}

describe('evaluatePipelineFreshness', () => {
  it('healthy pipeline → no flags, no warnings', () => {
    const r = evaluatePipelineFreshness(base)
    expect(r.deliveryStale).toBe(false)
    expect(r.schedulingStalled).toBe(false)
    expect(r.warnings).toEqual([])
  })

  it('overdue-undelivered backlog → deliveryStale + a sweep-stall warning', () => {
    const r = evaluatePipelineFreshness({ ...base, overdueUndelivered: 12 })
    expect(r.deliveryStale).toBe(true)
    const msg = r.warnings.join(' ')
    expect(msg).toMatch(/12 Amazon orders shipped/)
    expect(msg).toMatch(/delivery sweep/)
  })

  it('overdue just below threshold (9) → NOT stale (no weekend false-positive)', () => {
    const r = evaluatePipelineFreshness({ ...base, overdueUndelivered: 9 })
    expect(r.deliveryStale).toBe(false)
    expect(r.warnings).toEqual([])
  })

  it('overdue exactly at threshold (10) → stale', () => {
    expect(evaluatePipelineFreshness({ ...base, overdueUndelivered: 10 }).deliveryStale).toBe(true)
  })

  it('scheduling backlog → schedulingStalled + a scheduling warning', () => {
    const r = evaluatePipelineFreshness({ ...base, schedulingBacklog: 20 })
    expect(r.schedulingStalled).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/20 delivered orders/)
  })

  it('both signals tripped → two distinct warnings', () => {
    const r = evaluatePipelineFreshness({ ...base, overdueUndelivered: 30, schedulingBacklog: 30 })
    expect(r.deliveryStale && r.schedulingStalled).toBe(true)
    expect(r.warnings).toHaveLength(2)
  })

  it('maxDeliveredAgeDays is computed for display; null when nothing delivered', () => {
    expect(evaluatePipelineFreshness({ ...base, maxDeliveredAt: new Date(NOW - 2 * DAY) }).maxDeliveredAgeDays).toBe(2)
    expect(evaluatePipelineFreshness({ ...base, maxDeliveredAt: null }).maxDeliveredAgeDays).toBeNull()
  })
})
