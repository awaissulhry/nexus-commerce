/**
 * 1f — no automation pauses a campaign: a marketing rule's `mkt_pause_campaign` is refused in a dry run
 * and in a live run, and queues nothing. Resume is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findUnique = vi.fn()
vi.mock('../../db.js', () => ({ default: { marketingCampaign: { findUnique: (...a: unknown[]) => findUnique(...a) } } }))
const enqueue = vi.fn(async () => ({ queueId: 'q-1' }))
vi.mock('./marketing-mutation.service.js', () => ({ enqueueCampaignMutation: (...a: unknown[]) => enqueue(...(a as [])) }))

const handlers = async () => {
  const { ACTION_HANDLERS } = await import('../automation-rule.service.js')
  await import('./marketing-action-handlers.js')
  return ACTION_HANDLERS
}

describe('mkt_pause_campaign is refused (1f)', () => {
  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue({ id: 'mc-1', status: 'ACTIVE', budgetCents: 1000, channel: 'AMAZON', name: 'Spring' })
    enqueue.mockClear()
  })

  for (const dryRun of [true, false]) {
    it(`${dryRun ? 'dry run' : 'live run'}: refused with a plain sentence, nothing queued`, async () => {
      const H = await handlers()
      const r = await H.mkt_pause_campaign({ type: 'mkt_pause_campaign', campaignId: 'mc-1' }, {}, { dryRun, ruleId: 'r-1' })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/no automation may pause a campaign/)
      expect(enqueue).not.toHaveBeenCalled()
    })
  }

  it('resume still queues', async () => {
    findUnique.mockResolvedValue({ id: 'mc-1', status: 'PAUSED', budgetCents: 1000, channel: 'AMAZON', name: 'Spring' })
    const H = await handlers()
    const r = await H.mkt_resume_campaign({ type: 'mkt_resume_campaign', campaignId: 'mc-1' }, {}, { dryRun: false, ruleId: 'r-1' })
    expect(r.ok).toBe(true)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})
