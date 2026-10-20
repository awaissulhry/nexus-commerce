/**
 * set-meta-connection (Meta step 1, Owner 2026-10-20 "yes 1") — Claude asks to choose the business's Meta ad account,
 * Facebook Page and Instagram account from what its system user can see. The preview shows each choice from → to with
 * name and id and changes nothing; an id another business uses, or one the system user cannot see, is refused; the
 * approved preview goes stale when the choice it stands on moves; execute runs as the approving person through the
 * Settings card's own save (whose unique index refuses a taken id too); undo puts the previous choice back. No answer
 * carries a secret or a token. The real service runs on an in-memory prisma; Meta's discovery is stubbed; made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  links: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
  takenRows: [] as Array<{ product: string; id: string }>,
  failUpsert: null as null | ((product: string) => unknown),
  discoveries: 0,
}))

vi.mock('../../../db.js', () => {
  const tx = {
    metaAccountLink: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        const err = h.failUpsert?.(String(args.create.product))
        if (err) throw err
        h.upserts.push(args.create)
        h.links = [...h.links.filter((l) => l.product !== args.create.product), { ...args.create }]
        return args.create
      }),
      deleteMany: vi.fn(async ({ where }: { where: { product: string } }) => {
        const count = h.links.filter((l) => l.product === where.product).length
        h.links = h.links.filter((l) => l.product !== where.product)
        return { count }
      }),
    },
  }
  return {
    default: {
      channelConnection: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => h.connections.find((c) => c.id === where.id) ?? null) },
      metaAccountLink: { findMany: vi.fn(async () => h.links.map((l) => ({ ...l, connection: { isActive: true } }))) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      $queryRaw: vi.fn(async () => h.takenRows),
    },
  }
})
vi.mock('../../connection-resolver.service.js', () => ({
  CONNECTION_PUBLIC_SELECT: {},
  isOwnConnection: () => true,
  listManagedConnections: vi.fn(async () => h.connections),
}))
vi.mock('../../cx/events.service.js', () => ({ recordConnectionEventInTx: vi.fn(async () => undefined) }))
vi.mock('../../cx/token.service.js', () => ({ metaAppIdOf: vi.fn(async () => '1234567') }))
vi.mock('../../cx/connectors/meta/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../cx/connectors/meta/discovery.js')>()),
  discoverMetaChoices: vi.fn(async () => {
    h.discoveries++
    return {
      systemUser: { id: '120000000000001', name: 'Nexus system user' },
      adAccounts: {
        items: [
          { adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', accountStatus: 1, statusText: 'Active', businessId: '9876543210', businessName: 'Shop A portfolio' },
          { adAccountId: '1234567891', name: 'Shop A outlet ads', currency: 'EUR', timeZone: 'Europe/Rome', accountStatus: 1, statusText: 'Active', businessId: '9876543210', businessName: 'Shop A portfolio' },
        ],
        total: 2, error: null,
      },
      pages: { items: [{ pageId: '120000000000010', name: 'Shop A Page', instagram: { id: '170000000000001', username: 'shop_a' } }], total: 1, error: null },
      instagram: { items: [{ instagramId: '170000000000001', username: 'shop_a', pageId: '120000000000010' }], total: 1, error: null },
    }
  }),
}))
vi.mock('../../meta/meta-connection-live.js', () => ({ MetaLiveError: class MetaLiveError extends Error {}, liveConnectionCheck: vi.fn(), livePermissions: vi.fn(), liveApp: vi.fn() }))

import { META_ADS_CONNECTION_TOOLS } from './meta-ads-connection.tools.js'
import { __clearMetaChoicesCache } from '../../meta/meta-accounts.service.js'
import { MATERIAL_PREVIEW_FIELDS, movedFieldNames } from '../../agent-fleet/approval-inbox.service.js'

const tool = META_ADS_CONNECTION_TOOLS.find((t) => t.name === 'set-meta-connection')!
const read = META_ADS_CONNECTION_TOOLS.find((t) => t.name === 'meta-connection')!
const ctx = { can: () => true, via: 'claude' as const, userId: 'u-approver' }
const preview = (args: Record<string, unknown>) => tool.handler(tool.input.parse(args), ctx as never)
const execute = (args: Record<string, unknown>) => tool.execute!(tool.input.parse(args), ctx as never)
// Never in an answer: what the connection row carries next to the public fields.
const SECRETS = /fixture-app-secret|fixture-system-user-token/
const connection = (over: Record<string, unknown> = {}) => ({
  id: 'conn-1', channelType: 'META', isActive: true, authStatus: 'connected', displayName: null, accountLabel: null,
  identity: { userId: '120000000000001', username: 'Nexus system user' }, grantedScopes: ['ads_read', 'pages_show_list', 'instagram_basic'],
  connectionMetadata: { metaToken: { checkedAt: new Date().toISOString(), isValid: true, appId: '1234567', appMatches: true, type: 'SYSTEM_USER', userId: '120000000000001', expiresAt: null, neverExpires: true, dataAccessExpiresAt: null, scopes: ['ads_read', 'pages_show_list', 'instagram_basic'], missing: [], problem: null } },
  accessTokenExpiresAt: null, lastRefreshAt: null, lastError: null, workspaceId: 'w-1',
  credentialsEnc: 'fixture-app-secret fixture-system-user-token', ...over,
})
const link = (product: string, externalId: string, metadata: Record<string, unknown>) => ({ connectionId: 'conn-1', product, externalId, label: 'x', metadata, selectedByUserId: 'u-0' })

beforeEach(() => {
  h.connections = [connection()]
  h.links = [link('AD_ACCOUNT', '1234567890', { name: 'Shop A ads', businessId: '9876543210' })]
  h.upserts = []; h.takenRows = []; h.failUpsert = null; h.discoveries = 0
  __clearMetaChoicesCache()
})

describe('the contract', () => {
  it('a Nexus-only change a person always approves, needing ads.connect only, with no secret argument', () => {
    expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, reversibility: 'partial', requires: ['ads.connect'] })
    expect(Object.keys(tool.input.shape).sort()).toEqual(['adAccountId', 'connectionId', 'instagramId', 'pageId'])
    expect(MATERIAL_PREVIEW_FIELDS['set-meta-connection']).toEqual(['basis', 'plan', 'reach'])
  })
})

describe('the preview', () => {
  it('shows each choice from → to with name and id, and saves nothing', async () => {
    const res = await preview({ adAccountId: 'act_1234567891', pageId: '120000000000010', instagramId: '170000000000001' })
    expect(res).toMatchObject({
      ok: true,
      preview: {
        changes: {
          adAccount: { from: '“Shop A ads” (1234567890)', to: '“Shop A outlet ads” (1234567891)' },
          page: { from: 'none', to: '“Shop A Page” (120000000000010)' },
          instagram: { from: 'none', to: '“@shop_a” (170000000000001)' },
        },
        basis: { connectionId: 'conn-1', adAccountId: '1234567890', pageId: null, instagramId: null },
        plan: { connectionId: 'conn-1', adAccountId: '1234567891', pageId: '120000000000010', instagramId: '170000000000001' },
        reach: { mode: 'nexus', connectionId: 'conn-1' },
      },
    })
    expect(h.upserts).toEqual([])
  })
  it('a field left out keeps the current choice; null takes a Page away; the same choice is nothing to change', async () => {
    h.links.push(link('PAGE', '120000000000010', { name: 'Shop A Page' }))
    const kept = await preview({ adAccountId: '1234567891' })
    expect((kept.preview as { plan: unknown }).plan).toMatchObject({ adAccountId: '1234567891', pageId: '120000000000010' })
    expect(Object.keys((kept.preview as { changes: object }).changes)).toEqual(['adAccount'])
    const cleared = await preview({ pageId: null })
    expect((cleared.preview as { changes: unknown }).changes).toEqual({ page: { from: '“Shop A Page” (120000000000010)', to: 'none' } })
    expect((await preview({ adAccountId: '1234567890' })).error).toMatch(/Nothing to change/)
    expect((await preview({})).error).toMatch(/Nothing to change/)
  })
  it('refuses an id another business uses (never naming it) and one the system user cannot see', async () => {
    h.takenRows = [{ product: 'AD_ACCOUNT', id: '1234567891' }]
    const taken = await preview({ adAccountId: '1234567891' })
    expect(taken).toMatchObject({ ok: false, error: expect.stringMatching(/one business only/) })
    expect(taken.error).not.toMatch(/portfolio|w-2/)
    expect(await preview({ adAccountId: '5550001112' })).toMatchObject({ ok: false, error: expect.stringMatching(/does not show this ad account to the business's system user/) })
    expect(await preview({ pageId: '120000000000099' })).toMatchObject({ ok: false, error: expect.stringMatching(/does not show this Facebook Page/) })
  })
  it('a business without Meta, or whose token is dead, is told a person fixes it in Settings', async () => {
    h.connections = []
    expect((await preview({ adAccountId: '1234567891' })).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [connection({ authStatus: 'needs_reauth' })]
    expect((await preview({ adAccountId: '1234567891' })).error).toMatch(/new system-user token.*Settings › Channels › Meta/)
  })
  it('goes stale when the choice it stands on moves (basis), not when Meta renames something', async () => {
    const approved = (await preview({ adAccountId: '1234567891' })).preview
    h.links = [link('AD_ACCOUNT', '1234567890', { name: 'Shop A ads (renamed)', businessId: '9876543210' })]
    expect(movedFieldNames('set-meta-connection', approved, (await preview({ adAccountId: '1234567891' })).preview)).toEqual([])
    h.links.push(link('PAGE', '120000000000010', { name: 'Shop A Page' }))
    expect(movedFieldNames('set-meta-connection', approved, (await preview({ adAccountId: '1234567891' })).preview)).toEqual(['basis', 'plan'])
  })
})

describe('the run and its undo', () => {
  it('saves as the approving person and records the choice by id; undo puts the previous one back', async () => {
    const ran = await execute({ adAccountId: '1234567891', pageId: '120000000000010' })
    expect(ran).toMatchObject({ ok: true, data: { changed: true }, change: {
      before: { connectionId: 'conn-1', adAccountId: '1234567890', pageId: null, instagramId: null },
      after: { connectionId: 'conn-1', adAccountId: '1234567891', pageId: '120000000000010', instagramId: null },
    } })
    expect(h.upserts.map((u) => [u.product, u.externalId, u.selectedByUserId])).toEqual([['AD_ACCOUNT', '1234567891', 'u-approver'], ['PAGE', '120000000000010', 'u-approver']])

    // Undo: only while what is stored is what the change wrote; it asks this tool for the previous choice.
    const change = ran.change!
    expect(await tool.undo!.current(change)).toEqual(change.after)
    const back = tool.undo!.request(change)
    expect(back).toEqual({ tool: 'set-meta-connection', args: { connectionId: 'conn-1', adAccountId: '1234567890', pageId: null, instagramId: null } })
    const args = (back as { args: Record<string, unknown> }).args
    expect((await preview(args)).preview).toMatchObject({ changes: { adAccount: { to: '“Shop A ads” (1234567890)' }, page: { to: 'none' } } })
    await execute(args)
    expect(h.links.map((l) => [l.product, l.externalId])).toEqual([['AD_ACCOUNT', '1234567890']])
    // A first choice cannot be taken away by undo.
    expect(tool.undo!.request({ before: { connectionId: 'conn-1', adAccountId: null, pageId: null, instagramId: null }, after: change.after })).toMatchObject({ refusal: expect.stringMatching(/no Meta ad account chosen/) })
  })
  it('an id another business took after the preview is refused by the save (the unique index), naming no business', async () => {
    h.failUpsert = (product) => (product === 'AD_ACCOUNT' ? Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['product', 'externalId'] } }) : null)
    expect(await execute({ adAccountId: '1234567891' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Not changed: .*one business only/) })
    expect(h.links.map((l) => l.externalId)).toEqual(['1234567890'])
  })
})

describe('no secret in any answer', () => {
  it('previews, runs, refusals and the choices view carry neither the app secret nor the token', async () => {
    const answers = [
      await preview({ adAccountId: '1234567891' }),
      await preview({ adAccountId: '5550001112' }),
      await execute({ adAccountId: '1234567891' }),
      await read.handler(read.input.parse({ view: 'choices' }), ctx as never),
      await read.handler(read.input.parse({}), ctx as never),
    ]
    for (const answer of answers) expect(JSON.stringify(answer)).not.toMatch(SECRETS)
    expect(answers[3]).toMatchObject({ ok: true, data: { chosen: { adAccountId: '1234567891' }, adAccounts: { total: 2, items: expect.arrayContaining([expect.objectContaining({ adAccountId: '1234567891', takenByAnotherBusiness: false })]) } } })
  })
})
