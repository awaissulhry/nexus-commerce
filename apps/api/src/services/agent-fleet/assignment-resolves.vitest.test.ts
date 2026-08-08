/**
 * NAF.SB.AS-S1R / S1.f — the list's "is this target still there?" must answer
 * the same question the executor answers, and it is easy to get subtly wrong in
 * the direction nobody notices.
 *
 * The failure this guards: the read path says GONE while a run would proceed
 * happily. `resolveAssignmentScope` stops with `target_gone` only when NONE of
 * the named campaigns survive — a partially-archived target still runs, on what
 * is left. So the list must use `some`, not `every`. Get that backwards and the
 * page reddens rows that are fine, which is a new lie replacing an old silence.
 *
 * The mirror failure is just as bad and is also asserted: an EMPTIED portfolio
 * must read as gone, because the executor refuses one (`target_gone: that
 * portfolio has no campaigns`). An existence check on the portfolio record
 * alone would have disagreed with the run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

let campaignRows: Array<{ externalCampaignId?: string | null; portfolioId?: string | null }> = []

vi.mock('../../db.js', () => ({
  default: {
    campaign: { findMany: vi.fn(async () => campaignRows) },
  },
}))

const { targetsThatStillResolve } = await import('./assignment.service.js')

beforeEach(() => {
  campaignRows = []
})

describe('targetsThatStillResolve — AS-S1R S1.f', () => {
  it('a campaign target resolves when at least ONE named campaign survives', async () => {
    // '111' is gone, '222' is alive. The executor would run on '222'.
    campaignRows = [{ externalCampaignId: '222' }]
    const out = await targetsThatStillResolve([
      { id: 'a', targetKind: 'CAMPAIGN', targetIds: ['111', '222'] },
    ])
    expect(out.get('a')).toBe(true)
  })

  it('a campaign target is gone only when NONE survive', async () => {
    campaignRows = []
    const out = await targetsThatStillResolve([
      { id: 'a', targetKind: 'CAMPAIGN', targetIds: ['111', '222'] },
    ])
    expect(out.get('a')).toBe(false)
  })

  it('a portfolio that still holds campaigns resolves', async () => {
    campaignRows = [{ portfolioId: 'p1' }]
    const out = await targetsThatStillResolve([
      { id: 'a', targetKind: 'PORTFOLIO', targetIds: ['p1'] },
    ])
    expect(out.get('a')).toBe(true)
  })

  it('an EMPTIED portfolio is gone — matching the executor, not the portfolio row', async () => {
    campaignRows = []
    const out = await targetsThatStillResolve([
      { id: 'a', targetKind: 'PORTFOLIO', targetIds: ['p1'] },
    ])
    expect(out.get('a')).toBe(false)
  })

  it('a marketplace and a whole-account target always resolve', async () => {
    const out = await targetsThatStillResolve([
      { id: 'm', targetKind: 'MARKETPLACE', targetIds: ['IT'] },
      { id: 'w', targetKind: null, targetIds: [] },
    ])
    expect(out.get('m')).toBe(true)
    expect(out.get('w')).toBe(true)
  })

  it('asks the database at most twice, whatever the row count', async () => {
    const db = (await import('../../db.js')).default as unknown as {
      campaign: { findMany: ReturnType<typeof vi.fn> }
    }
    db.campaign.findMany.mockClear()
    campaignRows = [{ externalCampaignId: '1', portfolioId: 'p1' }]
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      targetKind: i % 2 ? 'CAMPAIGN' : 'PORTFOLIO',
      targetIds: [i % 2 ? String(i) : `p${i}`],
    }))
    await targetsThatStillResolve(rows)
    // One indexed IN for campaigns, one for portfolios. Never per row.
    expect(db.campaign.findMany.mock.calls.length).toBeLessThanOrEqual(2)
  })
})
