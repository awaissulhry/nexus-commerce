/**
 * Meta (step 1) — the business's Meta connection as Nexus shows it (C1), what its system user can see (C2) and the
 * asset choice (C3): the token's health in words (valid, expiry and renewal, permissions, a type Meta did not report),
 * the state's sentence, only ids Meta offered, and one Meta ad account / Page / Instagram id in ONE business (the
 * global unique index, read as a 409 that names no other business). No network, no DB: prisma and discovery stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  links: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  failUpsert: null as null | ((product: string) => unknown),
  takenRows: [] as Array<{ product: string; id: string }>,
}))

vi.mock('../../db.js', () => {
  const tx = {
    metaAccountLink: {
      upsert: vi.fn(async (args: { create: { product: string } }) => {
        const err = h.failUpsert?.(args.create.product)
        if (err) throw err
        h.upserts.push(args.create)
        return args.create
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  }
  return {
    default: {
      channelConnection: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => h.connections.find((c) => c.id === where.id) ?? null) },
      metaAccountLink: { findMany: vi.fn(async () => h.links) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      $queryRaw: vi.fn(async () => h.takenRows),
    },
  }
})
vi.mock('../connection-resolver.service.js', () => ({
  CONNECTION_PUBLIC_SELECT: {},
  isOwnConnection: () => true,
  listManagedConnections: vi.fn(async () => h.connections),
}))
vi.mock('../cx/events.service.js', () => ({ recordConnectionEventInTx: vi.fn(async (_tx: unknown, e: Record<string, unknown>) => { h.events.push(e) }) }))
vi.mock('../cx/token.service.js', () => ({ metaAppIdOf: vi.fn(async () => '1234567') }))
vi.mock('../cx/connectors/meta/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cx/connectors/meta/discovery.js')>()),
  discoverMetaChoices: vi.fn(async () => ({
    systemUser: { id: '120000000000001', name: 'Nexus system user' },
    adAccounts: { items: [{ adAccountId: '1234567890', name: 'Shop A', currency: 'EUR', timeZone: 'Europe/Rome', accountStatus: 1, statusText: 'Active', businessId: '9876543210', businessName: 'Shop A portfolio' }], error: null },
    pages: { items: [{ pageId: '120000000000010', name: 'Shop A Page', instagram: { id: '170000000000001', username: 'shop_a' } }], error: null },
    instagram: { items: [{ instagramId: '170000000000001', username: 'shop_a', pageId: '120000000000010' }], error: null },
  })),
}))

import {
  __clearMetaChoicesCache, getMetaChoices, listMetaConnections, metaChoicesAnswer, metaConnectionState, metaTokenView, parseMetaSelection, saveMetaSelection,
} from './meta-accounts.service.js'

const DAY = 86_400_000
const health = (over: Record<string, unknown> = {}) => ({
  checkedAt: new Date().toISOString(), isValid: true, appId: '1234567', appMatches: true, type: 'SYSTEM_USER', userId: '120000000000001',
  expiresAt: null, neverExpires: true, dataAccessExpiresAt: null, scopes: ['ads_read', 'ads_management'], missing: [], problem: null, ...over,
})
const connection = (over: Record<string, unknown> = {}) => ({
  id: 'conn-1', channelType: 'META', isActive: true, authStatus: 'connected', displayName: null, accountLabel: null, identity: { userId: '120000000000001', username: 'Nexus system user' },
  connectionMetadata: { metaToken: health() }, accessTokenExpiresAt: null, lastRefreshAt: null, grantedScopes: ['ads_read'], lastError: null, workspaceId: 'w-1', ...over,
})

beforeEach(() => {
  h.connections = [connection()]; h.links = []; h.upserts = []; h.events = []; h.failUpsert = null; h.takenRows = []
  __clearMetaChoicesCache()
})

describe('the token as a person reads it', () => {
  it('a never-expiring token; a 60-day one with when Nexus renews it; a type Meta did not report', () => {
    expect(metaTokenView(health() as never, {})).toMatchObject({ neverExpires: true, expiresAt: null, renewsFrom: null, typeText: 'System-user token' })
    const exp = new Date(Date.now() + 50 * DAY)
    const view = metaTokenView(health({ type: null, neverExpires: false }) as never, { accessTokenExpiresAt: exp })
    expect(view.expiresAt).toBe(exp.toISOString())
    expect(Date.parse(view.renewsFrom!)).toBe(exp.getTime() - 30 * DAY)
    expect(view.typeText).toBe('Token type not reported by Meta')
  })
  it('the state: not connected, token dead or expired, a required permission missing, no account chosen, ok', () => {
    const token = metaTokenView(health() as never, {})
    expect(metaConnectionState({ isActive: false, authStatus: 'disconnected', token, adAccountLinked: false, accountName: null }).state).toBe('sign_in_needed')
    expect(metaConnectionState({ isActive: true, authStatus: 'needs_reauth', token, adAccountLinked: true, accountName: null }).state).toBe('sign_in_needed')
    expect(metaConnectionState({ isActive: true, authStatus: 'connected', token: metaTokenView(health({ isValid: false, problem: 'Meta says the token is not valid.' }) as never, {}), adAccountLinked: true, accountName: null }).state).toBe('token_problem')
    expect(metaConnectionState({ isActive: true, authStatus: 'connected', token: metaTokenView(health({ neverExpires: false }) as never, { accessTokenExpiresAt: new Date(Date.now() - DAY) }), adAccountLinked: true, accountName: null })).toMatchObject({ state: 'token_problem', stateText: expect.stringMatching(/expired on/) })
    expect(metaConnectionState({ isActive: true, authStatus: 'connected', token: metaTokenView(health({ scopes: ['pages_show_list'] }) as never, {}), adAccountLinked: true, accountName: null })).toMatchObject({ state: 'permission_missing', stateText: expect.stringMatching(/ads_read/) })
    // ads_management covers reading.
    expect(metaConnectionState({ isActive: true, authStatus: 'connected', token: metaTokenView(health({ scopes: ['ads_management'] }) as never, {}), adAccountLinked: true, accountName: null }).state).toBe('ok')
    expect(metaConnectionState({ isActive: true, authStatus: 'connected', token, adAccountLinked: false, accountName: null }).state).toBe('choose_account')
    expect(metaConnectionState({ isActive: true, authStatus: 'connected', token, adAccountLinked: true, accountName: 'Shop A' })).toMatchObject({ state: 'ok', stateText: expect.stringMatching(/“Shop A”.*does not expire by date/) })
  })
  it('C1 shows the system user, the app id (never the secret) and the picks', async () => {
    h.links = [{ connectionId: 'conn-1', product: 'AD_ACCOUNT', externalId: '1234567890', metadata: { name: 'Shop A', currency: 'EUR', businessId: '9876543210' } }]
    const [c] = await listMetaConnections()
    expect(c).toMatchObject({ connectionId: 'conn-1', state: 'ok', appId: '1234567', systemUser: { id: '120000000000001' }, adAccount: { adAccountId: '1234567890', name: 'Shop A', businessId: '9876543210' } })
    expect(JSON.stringify(c)).not.toMatch(/secret/i)
  })
})

describe('the choice', () => {
  it('takes digits only (act_ dropped); Page and Instagram are optional', () => {
    expect(parseMetaSelection({ adAccountId: 'act_1234567890' })).toEqual({ adAccountId: '1234567890', pageId: null, instagramId: null })
    expect(() => parseMetaSelection({})).toThrow(/Choose the Meta ad account/)
    expect(() => parseMetaSelection({ adAccountId: '1', pageId: 'x' })).toThrow(/Facebook Page/)
  })
  it('C2 marks an asset another business already picked, by its id only, never naming it', async () => {
    h.takenRows = [{ product: 'PAGE', id: '120000000000010' }]
    const answer = await metaChoicesAnswer(await getMetaChoices('conn-1'))
    expect(answer.adAccounts.items[0]).toMatchObject({ adAccountId: '1234567890', name: 'Shop A', takenByAnotherBusiness: false })
    // Review 2: an asset another business uses is its id only — its name and Instagram account are that business's.
    expect(answer.pages.items[0]).toEqual({ pageId: '120000000000010', takenByAnotherBusiness: true })
  })
  it('saves only what Meta offered, records accounts_linked, and the same choice twice changes nothing', async () => {
    const first = await saveMetaSelection('conn-1', { adAccountId: '1234567890', pageId: '120000000000010', instagramId: '170000000000001' }, { userId: 'u-1' })
    expect(first.changed).toBe(true)
    expect(h.upserts.map((u) => [u.product, u.externalId])).toEqual([['AD_ACCOUNT', '1234567890'], ['PAGE', '120000000000010'], ['INSTAGRAM', '170000000000001']])
    expect(h.events).toEqual([expect.objectContaining({ type: 'accounts_linked', channelKey: 'META' })])
    h.links = h.upserts.map((u) => ({ ...u, connectionId: 'conn-1', connection: { isActive: true } }))
    const again = await saveMetaSelection('conn-1', { adAccountId: '1234567890', pageId: '120000000000010', instagramId: '170000000000001' })
    expect(again.changed).toBe(false)
    expect(h.events).toHaveLength(1)
    await expect(saveMetaSelection('conn-1', { adAccountId: '9999999999' })).rejects.toMatchObject({ statusCode: 409, code: 'not_offered' })
  })
  it('an id another business holds is refused 409 taken_by_other_business (the unique index), naming no business', async () => {
    h.failUpsert = (product) => (product === 'AD_ACCOUNT' ? Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['product', 'externalId'] } }) : null)
    const err = await saveMetaSelection('conn-1', { adAccountId: '1234567890' }).catch((e) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'taken_by_other_business', product: 'AD_ACCOUNT' })
    expect(err.message).toMatch(/one business only/)
  })
  it('a connection that needs a new token cannot choose', async () => {
    h.connections = [connection({ authStatus: 'needs_reauth' })]
    await expect(saveMetaSelection('conn-1', { adAccountId: '1234567890' })).rejects.toMatchObject({ code: 'not_offered' })
  })
})
