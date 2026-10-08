/**
 * ONE BRAIN AB-14 — the product cycle's switch (brain/cycle-switch.ts): off by default and for anything unrecognised; off,
 * nothing is read and every cron's list comes back as it went in (no behaviour change); on, every enrolled product × market
 * is the cycle's — the crons leave them, and the bid brain's full run leaves their own campaigns (a shared one stays).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enrolled: [] as Array<{ productId: string; marketplace: string }>,
  reads: 0,
  owned: new Map<string, string[]>(),
}))
vi.mock('../../../db.js', () => ({
  default: { adsBrainEnrollment: { findMany: vi.fn(async () => { h.reads++; return h.enrolled }) } },
}))
vi.mock('./ownership.js', () => ({
  productCampaigns: vi.fn(async (productId: string, market: string) => ({ root: productId, owned: (h.owned.get(`${market}|${productId}`) ?? []).map((campaignId) => ({ campaignId })), shared: [{ campaignId: 'shared-1' }] })),
}))

import { cycleKey, cycleMode, orchestratedCampaignIds, orchestratedKeys, withoutOrchestrated } from './cycle-switch.js'

afterEach(() => { vi.unstubAllEnvs(); h.reads = 0; h.enrolled = []; h.owned = new Map() })

const LIST = [{ productId: 'jacket', market: 'IT', level: 'OBSERVE' }, { productId: 'helmet', market: 'IT', level: 'AUTO' }, { productId: 'jacket', market: 'DE', level: 'OBSERVE' }]

describe('AB-14 — the product cycle\'s switch', () => {
  it('off by default and for anything unrecognised; on only when said', () => {
    expect(cycleMode(undefined)).toBe('off')
    for (const v of ['', 'off', '0', 'false', 'shadow', 'yes please']) expect(cycleMode(v), v).toBe('off')
    for (const v of ['on', 'ON', ' 1 ', 'true', 'live']) expect(cycleMode(v), v).toBe('on')
  })

  it('off: every list as it went in, the bid brain skips nothing, and nothing is read', async () => {
    h.enrolled = [{ productId: 'jacket', marketplace: 'IT' }]
    expect(await withoutOrchestrated(LIST)).toEqual({ kept: LIST, skipped: [] })
    expect(await orchestratedKeys()).toEqual(new Set())
    expect(await orchestratedCampaignIds()).toEqual(new Set())
    expect(h.reads).toBe(0)
  })

  it('on: every enrolled product × market is the cycle\'s — the crons leave exactly those', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    h.enrolled = [{ productId: 'jacket', marketplace: 'IT' }, { productId: 'jacket', marketplace: 'DE' }]
    expect(await orchestratedKeys()).toEqual(new Set([cycleKey('jacket', 'IT'), cycleKey('jacket', 'DE')]))
    expect(await withoutOrchestrated(LIST)).toEqual({ kept: [LIST[1]], skipped: [LIST[0], LIST[2]] })
    // Keys handed in: no read.
    const before = h.reads
    expect(await withoutOrchestrated(LIST, new Set([cycleKey('helmet', 'IT')]))).toEqual({ kept: [LIST[0], LIST[2]], skipped: [LIST[1]] })
    expect(h.reads).toBe(before)
  })

  it('on: the bid brain\'s full run leaves the own campaigns of every product the cycle runs — never a shared one', async () => {
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    h.enrolled = [{ productId: 'jacket', marketplace: 'IT' }, { productId: 'helmet', marketplace: 'IT' }]
    h.owned = new Map([['IT|jacket', ['c-j1', 'c-j2']], ['IT|helmet', ['c-h1']]])
    expect([...(await orchestratedCampaignIds())].sort()).toEqual(['c-h1', 'c-j1', 'c-j2'])
  })
})
