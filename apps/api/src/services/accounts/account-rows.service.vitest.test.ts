/**
 * MCP full control P3 — the account rows moved from accounts.routes.ts into account-rows.service.ts. GET /api/accounts
 * (and the account a PATCH /api/accounts/:id answers with) give byte for byte what they gave before (goldens recorded
 * on the route as it was), with business profiles off and on.
 *
 * The fixtures walk every health branch (inactive, needs re-auth, revoked, disconnected, degraded with and without an
 * error, sync success / partial / failed / never), every label source, markets from connection metadata, scopes in
 * kind order, two accounts on one channel (the chip becomes a switcher), an account outside OAuth/env management (not
 * listed), a disconnected account (listed only when asked for, with profiles on) and an account another business
 * owns (never this business's primary).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness, profilesOn } from '../../test-support/route-golden.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import accountsRoutes from '../../routes/accounts.routes.js'

const GOLDEN = './__golden__'
const at = (minutesAgo: number) => new Date(GOLDEN_NOW.getTime() - minutesAgo * 60_000)
const OTHER = 'golden-other-business'

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  const owner = await db.userProfile.create({ data: { id: 'golden-owner', email: 'golden-owner@example.test', displayName: 'Golden Owner' } })
  await db.workspace.create({ data: { id: OTHER, name: 'Other business', createdByUserId: owner.id, creationKey: 'golden-other-key' } })
  // One active account per (channel, market, account id) in the whole database: each fixture names its own account id.
  const connection = (data: Record<string, unknown>) => db.channelConnection.create({ data: { lastSyncAt: at(60), externalAccountId: `ext-${data.id}`, ...data } })
  await inGoldenBusiness(async () => {
    await connection({
      id: 'golden-amazon', channelType: 'AMAZON', managedBy: 'env', isActive: true, isPrimary: true, displayName: 'AFXSELLER8BC38',
      externalAccountId: 'AFXSELLER8BC38', lastSyncStatus: 'SUCCESS', authStatus: 'connected', region: 'EU',
      grantedScopes: ['sellingpartnerapi::notifications'], tokenExpiresAt: at(-60), accessTokenExpiresAt: at(-50),
      refreshTokenExpiresAt: at(-5000), lastRefreshAt: at(70), lastHeartbeatAt: at(3), lastInboundAt: at(4), lastOutboundAt: at(5),
      identity: { sellerName: 'Golden seller' },
    })
    await db.connectionScope.create({ data: { id: 'golden-scope-2', connectionId: 'golden-amazon', kind: 'marketplace', externalId: 'ZZ_MARKET_B', label: 'Market B', isActive: false } })
    await db.connectionScope.create({ data: { id: 'golden-scope-1', connectionId: 'golden-amazon', kind: 'marketplace', externalId: 'ZZ_MARKET_A', label: 'Market A' } })
    await db.connectionScope.create({ data: { id: 'golden-scope-0', connectionId: 'golden-amazon', kind: 'account', externalId: 'ZZ_ACCOUNT', label: null } })
    await connection({
      id: 'golden-ebay-main', channelType: 'EBAY', managedBy: 'oauth', isActive: true, isPrimary: true, ebayStoreName: 'Golden Store',
      ebaySignInName: 'golden_seller', authStatus: 'needs_reauth', lastError: 'Token rejected', lastErrorAt: at(10), consecutiveFailures: 4,
      lastSyncStatus: 'SUCCESS', ebayTokenExpiresAt: at(-30), connectionMetadata: { activeMarketplaces: ['IT', 'DE', 5] }, sortOrder: 0,
    })
    await connection({
      id: 'golden-ebay-second', channelType: 'EBAY', managedBy: 'oauth', isActive: true, accountLabel: 'Second eBay', accountColor: '#112233',
      displayName: 'eBay seller (verified)', authStatus: 'degraded', consecutiveFailures: 2, sortOrder: 1,
    })
    await connection({
      id: 'golden-ebay-third', channelType: 'EBAY', managedBy: 'oauth', isActive: true, ebaySignInName: 'golden_third',
      authStatus: 'degraded', lastError: 'Slow answers', sortOrder: 2,
    })
    await connection({ id: 'golden-ebay-revoked', channelType: 'EBAY', managedBy: 'oauth', isActive: true, authStatus: 'revoked', displayName: 'Revoked shop', sortOrder: 3 })
    await connection({ id: 'golden-ebay-gone', channelType: 'EBAY', managedBy: 'oauth', isActive: false, authStatus: 'revoked', displayName: 'Old shop', sortOrder: 4 })
    await connection({ id: 'golden-shopify', channelType: 'SHOPIFY', managedBy: 'oauth', isActive: true, displayName: 'golden-shop', authStatus: 'connected', lastSyncStatus: 'PARTIAL', lastSyncError: 'Two products skipped' })
    await connection({ id: 'golden-etsy', channelType: 'ETSY', managedBy: 'oauth', isActive: true, displayName: 'Golden Etsy', authStatus: 'disconnected' })
    await connection({ id: 'golden-etsy-2', channelType: 'ETSY', managedBy: 'oauth', isActive: true, displayName: 'Golden Etsy Two', lastSyncStatus: 'FAILED', sortOrder: 1 })
    await connection({ id: 'golden-etsy-3', channelType: 'ETSY', managedBy: 'oauth', isActive: true, displayName: 'Golden Etsy Three', lastSyncStatus: 'PARTIAL', sortOrder: 2 })
    await connection({ id: 'golden-etsy-4', channelType: 'ETSY', managedBy: 'oauth', isActive: true, displayName: 'Golden Etsy Four', lastSyncStatus: 'FAILED', lastSyncError: 'Shop closed', sortOrder: 3 })
    await connection({ id: 'golden-ads', channelType: 'AMAZON_ADS', managedBy: 'oauth', isActive: true, displayName: '1234567890' })
    await connection({ id: 'golden-woo-manual', channelType: 'WOOCOMMERCE', managedBy: 'manual', isActive: true, displayName: 'Manual Woo' })
  })
  // Another business's account: listed wherever the database lets this business read it, and never its primary.
  await withWorkspace({ workspaceId: OTHER, actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    connection({ id: 'golden-shared-shopify', channelType: 'SHOPIFY', managedBy: 'oauth', isActive: true, isPrimary: true, displayName: 'Shared shop', authStatus: 'connected', lastSyncStatus: 'SUCCESS', workspaceId: OTHER }),
  )
  // Shared with the fixtures' business (BP.S1c), by its owner: the database shows the guest the owner's account.
  await withWorkspace({ workspaceId: OTHER, actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    db.channelAccountGrant.create({ data: { connectionId: 'golden-shared-shopify', workspaceId: 'nexus_legacy_workspace', ownerWorkspaceId: OTHER, grantedByUserId: owner.id, grantedAt: at(500) } }),
  )
  app = await goldenApp([{ plugin: accountsRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P3 — account rows: the routes answer exactly as before', () => {
  it('GET /api/accounts, and with the disconnected ones asked for', async () => {
    await expectGolden(app, 'accounts', '/api/accounts', GOLDEN)
    await expectGolden(app, 'accounts-with-disconnected', '/api/accounts?includeDisconnected=1', GOLDEN)
  })

  it('PATCH /api/accounts/:id answers with the account row', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/api/accounts/golden-ebay-second', payload: { accountLabel: '  Renamed eBay  ', sortOrder: 5 } })
    const mode = profilesOn() ? 'on' : 'off'
    await expect(`${response.statusCode}\n${response.body}\n`).toMatchFileSnapshot(`${GOLDEN}/accounts-patch.${mode}.txt`)
  })

  it('a channel with no live account is named as not connected', async () => {
    await inGoldenBusiness(() => state.db.client.channelConnection.update({ where: { id: 'golden-amazon' }, data: { isActive: false, isPrimary: false } }))
    await expectGolden(app, 'accounts-amazon-off', '/api/accounts', GOLDEN)
  })
})
