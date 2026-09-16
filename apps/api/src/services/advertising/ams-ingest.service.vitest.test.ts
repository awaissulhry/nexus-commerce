/**
 * The forwarder's AMS POST with business profiles on.
 *
 * Production 2026-09-16: from 13:00 UTC the route answered 200 and saved 0 new hourly rows, because
 * every consumer write needs a business profile and the PUBLIC route had none. These mocks refuse to
 * write without a profile, as the real client does, and record which profile each write ran in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  perf: vi.fn(), change: vi.fn(), budget: vi.fn(), flush: vi.fn(), owner: vi.fn(), log: vi.fn(),
  writes: [] as Array<{ kind: string; workspaceId: string; count: number }>,
}))
vi.mock('./ads-marketing-stream.service.js', () => ({ ingestMarketingStream: h.perf }))
vi.mock('./ads-stream-change.service.js', () => ({ ingestEntityChanges: h.change, ingestBudgetUsage: h.budget }))
vi.mock('./ads-cache.js', () => ({ flushAdsCache: h.flush }))
vi.mock('../../lib/workspace-ingress.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/workspace-ingress.js')>()), verifiedChannelWorkspace: h.owner }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: h.log, info: vi.fn(), error: vi.fn() } }))

import { ingestAmsBatch } from './ams-ingest.service.js'
import { WorkspaceError, workspaceContext } from '../../lib/workspace-context.js'

const inProfile = (kind: string, count: number) => {
  const scope = workspaceContext()
  if (!scope) throw new WorkspaceError('workspace_required', 'Select a business profile.', 400)
  h.writes.push({ kind, workspaceId: scope.workspaceId, count })
}
const traffic = (advertiser: string | undefined, campaign: string) => ({ dataset_id: 'sp-traffic', ...(advertiser ? { advertiser_id: advertiser } : {}), campaign_id: campaign, impressions: 1 })

describe('AMS ingest routes every record to the profile that owns its Amazon Ads account', () => {
  beforeEach(() => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    h.writes.length = 0
    h.perf.mockImplementation(async (records: unknown[]) => { inProfile('performance', records.length); return { received: records.length, upserted: records.length, skipped: 0 } })
    h.change.mockImplementation(async (records: unknown[]) => { inProfile('change', records.length); return { received: records.length, campaigns: records.length, adGroups: 0, targets: 0, skipped: 0, unmatched: 0 } })
    h.budget.mockImplementation(async (records: unknown[]) => { inProfile('budget', records.length); return { received: records.length, exhausted: 0, warning: records.length, skipped: 0, stored: records.length, undatable: 0, unmatched: 0 } })
    h.flush.mockImplementation(async () => { inProfile('flush', 0) })
    h.owner.mockImplementation(async (_channel: string, account: string) => {
      if (account === 'A1VRHKTGYO1JNU') return { workspaceId: 'xavia-racing' }
      if (account === 'MOTOVENTO-ADS') return { workspaceId: 'motovento' }
      throw new WorkspaceError('ingress_account_ambiguous', 'The verified notification does not identify one connected seller.', 503)
    })
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

  it('writes each account’s records inside its own profile and sums the answer', async () => {
    const result = await ingestAmsBatch([
      traffic('A1VRHKTGYO1JNU', 'c1'),
      traffic('MOTOVENTO-ADS', 'c2'),
      traffic('A1VRHKTGYO1JNU', 'c3'),
      { dataset_id: 'campaigns', advertiser_id: 'MOTOVENTO-ADS', campaignId: 'c2' },
    ])
    expect(h.writes).toEqual(expect.arrayContaining([
      { kind: 'performance', workspaceId: 'xavia-racing', count: 2 },
      { kind: 'performance', workspaceId: 'motovento', count: 1 },
      { kind: 'change', workspaceId: 'motovento', count: 1 },
      { kind: 'flush', workspaceId: 'xavia-racing', count: 0 },
      { kind: 'flush', workspaceId: 'motovento', count: 0 },
    ]))
    expect(h.owner).toHaveBeenCalledTimes(2) // one lookup per account, not per record
    expect(result).toMatchObject({ received: 4, upserted: 3, skipped: 0, unrouted: 0, routed: { performance: 3, change: 1, budget: 0, unknownDataset: 0 } })
    expect(result.change).toMatchObject({ received: 1, campaigns: 1 })
  })

  it('counts and logs records no profile owns, and never writes them into a guessed profile', async () => {
    const result = await ingestAmsBatch([traffic('UNKNOWN-ADS', 'c9'), traffic(undefined, 'c8'), traffic('A1VRHKTGYO1JNU', 'c1')])
    expect(result).toMatchObject({ received: 3, upserted: 1, unrouted: 2 })
    expect(h.writes.filter((w) => w.kind === 'performance')).toEqual([{ kind: 'performance', workspaceId: 'xavia-racing', count: 1 }])
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('records not saved'), expect.objectContaining({ unrouted: 2, accounts: expect.arrayContaining(['UNKNOWN-ADS', '(none)']) }))
  })

  it('lets a real outage fail the request, so the forwarder can retry', async () => {
    h.owner.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(ingestAmsBatch([traffic('A1VRHKTGYO1JNU', 'c1')])).rejects.toThrow('database unavailable')
    expect(h.perf).not.toHaveBeenCalled()
  })

  it('with profiles off, ingests the batch once as before', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
    h.perf.mockImplementation(async (records: unknown[]) => ({ received: records.length, upserted: records.length, skipped: 0 }))
    h.flush.mockResolvedValue(undefined)
    const result = await ingestAmsBatch([traffic(undefined, 'c1'), traffic('A1VRHKTGYO1JNU', 'c2')])
    expect(result).toMatchObject({ received: 2, upserted: 2, unrouted: 0 })
    expect(h.owner).not.toHaveBeenCalled()
  })
})
