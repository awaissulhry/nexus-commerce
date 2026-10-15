/**
 * Google Ads programme 2, G8a (2026-10-15) — what an upload of sales reads from Nexus besides the orders: whether another
 * upload is in flight in this business (its approval executing, or executed without its record yet; an upload step of
 * another plan executing). The database client is a stand-in that records the queries asked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ approval: vi.fn(), step: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { agentApproval: { findFirst: h.approval }, agentPlanStep: { findFirst: h.step } } }))

import { UPLOAD_CLAIM_MS, UPLOAD_TOOL, uploadInFlight } from './conversion-orders.js'

const NOW = new Date('2026-10-15T12:00:00Z')

beforeEach(() => {
  h.approval.mockReset().mockResolvedValue(null)
  h.step.mockReset().mockResolvedValue(null)
})

describe('uploadInFlight', () => {
  it('asks for OTHER upload approvals executing, or executed without their record, claimed in the last 30 minutes', async () => {
    expect(await uploadInFlight('ap-1', NOW)).toBeNull()
    expect(h.approval.mock.calls[0][0].where).toEqual({
      toolName: UPLOAD_TOOL,
      id: { not: 'ap-1' },
      decidedAt: { gte: new Date(NOW.getTime() - UPLOAD_CLAIM_MS) },
      OR: [{ status: 'executing' }, { status: 'executed', changes: { none: {} } }],
    })
    expect(h.step.mock.calls[0][0].where).toEqual({ toolName: UPLOAD_TOOL, status: 'executing', approvalId: { not: 'ap-1' }, startedAt: { gte: new Date(NOW.getTime() - UPLOAD_CLAIM_MS) } })
  })

  it('names what is in flight: an approval sending now, one whose record is being written, a plan step', async () => {
    h.approval.mockResolvedValueOnce({ id: 'ap-2', status: 'executing' })
    expect(await uploadInFlight('ap-1', NOW)).toBe('approval ap-2 is sending sales now')
    h.approval.mockResolvedValueOnce({ id: 'ap-3', status: 'executed' })
    expect(await uploadInFlight('ap-1', NOW)).toBe('approval ap-3 has just sent sales and its record is being written')
    h.step.mockResolvedValueOnce({ approvalId: 'plan-1', position: 2 })
    expect(await uploadInFlight('ap-1', NOW)).toBe('step 2 of change plan plan-1 is sending sales now')
  })
})
