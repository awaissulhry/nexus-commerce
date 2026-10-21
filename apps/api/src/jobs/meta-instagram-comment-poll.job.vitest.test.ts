/**
 * Meta step 37 — the Instagram comment poll's cron: scheduled only through lib/cron/clustered.ts, every 15 minutes (UTC),
 * never when its brake (or Meta's read switch) is off; a business without a chosen Instagram account makes no call and gets
 * no run record; one with one gets one run record per poll. The poll itself is proven in instagram-comment-poll.vitest.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  scheduled: [] as Array<{ expr: string; options: Record<string, unknown> }>,
  runs: [] as string[],
  target: null as null | Record<string, unknown>,
  poll: vi.fn(async () => ({ status: 'done', line: '2 Instagram media read; 0 new comments on 0 of them; 0 notices' })),
}))
vi.mock('../lib/cron/clustered.js', () => ({ default: { schedule: (expr: string, _fn: unknown, options: Record<string, unknown>) => { h.scheduled.push({ expr, options }); return { stop: () => undefined } } } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (name: string, work: () => Promise<string>) => { h.runs.push(name); return work() } }))
vi.mock('../services/marketing/meta-ads/instagram-comment-poll.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/marketing/meta-ads/instagram-comment-poll.js')>()),
  igCommentPollTarget: vi.fn(async () => h.target),
  pollInstagramComments: h.poll,
}))

import { runMetaInstagramCommentPollTick, startMetaInstagramCommentPollCron } from './meta-instagram-comment-poll.job.js'

beforeEach(() => { vi.unstubAllEnvs(); h.scheduled = []; h.runs = []; h.target = null; h.poll.mockClear() })

describe('the Instagram comment poll cron', () => {
  it('a business without a chosen Instagram account: no call, no run record; with one: one run record', async () => {
    expect(await runMetaInstagramCommentPollTick()).toBeNull()
    expect(h.runs).toEqual([])
    expect(h.poll).not.toHaveBeenCalled()
    h.target = { connectionId: 'm-1', instagramId: '170000000000010', label: 'Shop A' }
    expect(await runMetaInstagramCommentPollTick()).toMatch(/Instagram media read/)
    expect(h.runs).toEqual(['meta-instagram-comment-poll'])
  })
  it('the brake: nothing runs, nothing is scheduled', async () => {
    vi.stubEnv('NEXUS_META_IG_COMMENT_POLL', 'off')
    h.target = { connectionId: 'm-1', instagramId: '170000000000010', label: 'Shop A' }
    expect(await runMetaInstagramCommentPollTick()).toBeNull()
    startMetaInstagramCommentPollCron()
    expect(h.scheduled).toEqual([])
    expect(h.poll).not.toHaveBeenCalled()
  })
  it('scheduled through the clustered cron every 15 minutes, in UTC', () => {
    startMetaInstagramCommentPollCron()
    expect(h.scheduled).toEqual([{ expr: '7,22,37,52 * * * *', options: { timezone: 'Etc/UTC', lockTtlMs: 600_000 } }])
  })
})
