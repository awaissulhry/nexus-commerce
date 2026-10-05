/**
 * Ads wave 4d — Settings → Channels → Accounts showed every Amazon Ads profile as active (the heartbeat rewrote each
 * scope `isActive: true`), while only some were used. Each Ads profile now carries its real state from the row every ads
 * job reads: "Live · writes on", "Reading only", or "Not read" (no row, or a row nobody reads).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const connections: Array<Record<string, unknown>> = []
const scopeRows: Array<Record<string, unknown>> = []
const adsRows: Array<Record<string, unknown>> = []
const adsReads = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    connectionScope: { findMany: vi.fn(async () => scopeRows) },
    amazonAdsConnection: { findMany: vi.fn(async () => { adsReads(); return adsRows }) },
  },
}))
vi.mock('../connection-resolver.service.js', () => ({
  listManagedConnections: vi.fn(async () => connections),
  isOwnConnection: (row: { workspaceId?: string | null }) => !row.workspaceId || row.workspaceId === 'mine',
}))

const { listAccountRows } = await import('./account-rows.service.js')

const conn = (id: string, channelType: string, workspaceId: string | null = 'mine') => ({
  id, channelType, workspaceId, managedBy: 'oauth', isActive: true, isPrimary: true, sortOrder: 0, displayName: id,
  authStatus: 'connected', grantedScopes: [], identity: null, connectionMetadata: null, region: 'EU',
  externalAccountId: null, accountColor: null, accountLabel: null, lastSyncStatus: 'SUCCESS', consecutiveFailures: 0,
})
const scope = (connectionId: string, kind: string, externalId: string, label: string) => ({ connectionId, kind, externalId, label, isActive: true })
const WRITES_ON = new Date('2026-08-29T00:00:00Z')

beforeEach(() => {
  connections.length = 0
  scopeRows.length = 0
  adsRows.length = 0
  adsReads.mockClear()
})

describe('the Accounts tab: each Amazon Ads profile shows what Nexus does with it', () => {
  it('maps live / reading / not read / no row, and leaves the scope flag and other channels alone', async () => {
    connections.push(conn('ads', 'AMAZON_ADS'), conn('sp', 'AMAZON'))
    scopeRows.push(
      scope('ads', 'profile', 'p-it', 'Ads · IT'),
      scope('ads', 'profile', 'p-uk', 'Ads · UK'),
      scope('ads', 'profile', 'p-us', 'Ads · US'),
      scope('ads', 'profile', 'p-jp', 'Ads · JP'), // the reconcile has not recorded a row for it
      scope('sp', 'marketplace', 'MP_IT', 'Amazon.it'),
    )
    adsRows.push(
      { profileId: 'p-it', isActive: true, mode: 'production', writesEnabledAt: WRITES_ON },
      { profileId: 'p-uk', isActive: true, mode: 'sandbox', writesEnabledAt: null },
      { profileId: 'p-us', isActive: false, mode: 'sandbox', writesEnabledAt: null },
    )
    const { accounts } = await listAccountRows({ includeDisconnected: false })
    const ads = accounts.find((a) => a.id === 'ads')!
    expect(ads.scopes.map((s) => [s.externalId, s.state, s.isActive])).toEqual([
      ['p-it', 'Live · writes on', true],
      ['p-uk', 'Reading only', true],
      ['p-us', 'Not read', true],
      ['p-jp', 'Not read', true],
    ])
    expect(accounts.find((a) => a.id === 'sp')!.scopes).toEqual([{ kind: 'marketplace', externalId: 'MP_IT', label: 'Amazon.it', isActive: true }])
  })

  it('reads the Ads rows only when an own Ads account lists profiles', async () => {
    connections.push(conn('sp', 'AMAZON'), conn('ads-empty', 'AMAZON_ADS'))
    scopeRows.push(scope('sp', 'marketplace', 'MP_IT', 'Amazon.it'))
    await listAccountRows({ includeDisconnected: false })
    expect(adsReads).not.toHaveBeenCalled()
  })

  it('a borrowed Ads account (another business\'s) gets no state: its rows are not this business\'s to read', async () => {
    connections.push(conn('ads-borrowed', 'AMAZON_ADS', 'theirs'))
    scopeRows.push(scope('ads-borrowed', 'profile', 'p-x', 'Ads · IT'))
    const { accounts } = await listAccountRows({ includeDisconnected: false })
    expect(accounts[0].scopes[0]).not.toHaveProperty('state')
    expect(adsReads).not.toHaveBeenCalled()
  })
})
