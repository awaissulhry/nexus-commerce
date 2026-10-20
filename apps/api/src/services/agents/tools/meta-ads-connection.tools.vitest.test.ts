/**
 * meta-connection (step 1): the business's Meta connection, read only. summary answers from what Nexus keeps, with no
 * Meta call; the live views read Meta and keep nothing; a business without Meta is told who connects it (a person, in
 * Settings) — the tool never takes an app secret or a token. No network: the services are stubbed. Made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ connections: [] as Array<Record<string, unknown>>, live: [] as string[] }))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../meta/meta-connection-live.js', () => ({
  MetaLiveError: class MetaLiveError extends Error {},
  liveConnectionCheck: vi.fn(async (connectionId: string, adAccountId: string | null) => { h.live.push(`check:${connectionId}:${adAccountId}`); return { token: { isValid: true }, tokenError: null, usage: { tier: 'development_access' }, usageReadOn: 'the chosen ad account', usageError: null, apiVersion: 'v26.0' } }),
  livePermissions: vi.fn(async () => { h.live.push('permissions'); return [{ permission: 'ads_read', status: 'granted' }, { permission: 'pages_show_list', status: 'declined' }] }),
  liveApp: vi.fn(async (_c: string, businessId: string | null) => { h.live.push(`app:${businessId}`); return { appId: '1234567', roles: { items: [], error: null }, authorizedAdAccounts: { items: [], error: null }, clientBusinesses: { items: [], error: null } } }),
  liveAssignedApps: vi.fn(async (_c: string, userId: string) => { h.live.push(`assigned:${userId}`); return [{ appId: '1234567', name: 'Nexus app', tasks: null }] }),
}))

import { META_ADS_CONNECTION_TOOLS } from './meta-ads-connection.tools.js'

const tool = META_ADS_CONNECTION_TOOLS.find((t) => t.name === 'meta-connection')!
const ctx = { can: () => true, via: 'claude' as const }
const run = (args: Record<string, unknown>) => tool.handler(tool.input.parse(args), ctx)
const META = {
  connectionId: 'conn-1', label: 'Meta', state: 'ok', stateText: 'Nexus reads “Shop A”.', authStatus: 'connected',
  systemUser: { id: '120000000000001', name: 'Nexus system user' }, appId: '1234567', token: { neverExpires: true },
  adAccount: { adAccountId: '1234567890', name: 'Shop A', businessId: '9876543210' }, page: null, instagram: null, lastError: null,
}

beforeEach(() => { h.connections = [META]; h.live = [] })

describe('meta-connection', () => {
  it('is a read: no change, no secret argument, reads Meta live in some views (open world)', () => {
    expect(tool).toMatchObject({ readOnly: true, openWorld: true, riskTier: 'low' })
    expect(tool.execute).toBeUndefined()
    expect(Object.keys(tool.input.shape).sort()).toEqual(['connectionId', 'view'])
    expect(tool.description).toMatch(/never takes an app secret or a token/)
  })
  it('summary answers from what Nexus keeps, with no Meta call', async () => {
    const res = await run({})
    expect(res).toMatchObject({ ok: true, data: { connected: true, apiVersion: 'v26.0', connection: { connectionId: 'conn-1', appId: '1234567' } } })
    expect(h.live).toEqual([])
  })
  it('a business without Meta is told a person connects it in Settings', async () => {
    h.connections = []
    const res = await run({ view: 'check' })
    expect(res).toMatchObject({ ok: true, data: { connected: false, sentence: expect.stringMatching(/Settings › Channels › Meta/) } })
    expect(h.live).toEqual([])
    expect((await run({ connectionId: 'nope' })).ok).toBe(false)
  })
  it('the live views read Meta for the chosen ad account and its business portfolio', async () => {
    await run({ view: 'check' })
    const perms = await run({ view: 'permissions' })
    await run({ view: 'app' })
    await run({ view: 'assigned-apps' })
    expect(h.live).toEqual(['check:conn-1:1234567890', 'permissions', 'app:9876543210', 'assigned:120000000000001'])
    expect(perms).toMatchObject({ ok: true, data: { granted: ['ads_read'], declined: [{ permission: 'pages_show_list', status: 'declined' }] } })
  })
})
