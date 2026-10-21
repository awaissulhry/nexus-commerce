/**
 * Meta step 1, review 2 — one Meta id in ONE business, on a REAL PostgreSQL: the throwaway PostgreSQL 17 of
 * scripts/run-real-postgres-tests.mjs, the production schema and policies, the app connected as the restricted runtime
 * login (NOBYPASSRLS), so row-level security and the global unique index hold exactly as in production.
 *
 * Two businesses, ALPHA and BRAVO, each with a Meta connection of the same system user (one system user may be
 * connected in many businesses). BRAVO already reads ad account X and uses Page P.
 *
 *   1. nexus_meta_links_taken (SECURITY DEFINER): ALPHA learns which of the ids it asks about another business uses (and,
 *      step 10, which business portfolio another business's chosen ad account belongs to) —
 *      never an id it did not ask about, never its own picks, never which business; it needs a business and a product;
 *      only the runtime role may execute it. Control: row security hides BRAVO's link from ALPHA's own queries.
 *   2. The choices as answered: an asset BRAVO uses is its id only (no name, currency, business portfolio).
 *   3. set-meta-connection in ALPHA: X is refused in the preview, and by the unique index on save when the preview is
 *      skipped; another account is saved as the approving person, and undo puts the previous choice back. BRAVO's links
 *      never move.
 *   4. A7: a Meta token's expiry warning is recorded once per level and expiry date (the ledger's JSON path filter), and
 *      a renewed token (another expiry date) warns afresh.
 *   5. Step 17 (write base): the gateway's chosen-account check under row security — BRAVO's stored campaign is invisible
 *      to ALPHA, a connection's chosen ad account is read only in its own business, and a change of BRAVO's campaign asked
 *      in ALPHA (a forged id) is refused after ONE live read of its account_id: nothing is sent to change it.
 * Meta's discovery and the token service are stubbed (no Meta call); made-up ids only.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))

const RUN = randomBytes(5).toString('hex')
const digits = (seed: string, length: number) => `${seed}${RUN.replace(/\D/g, '7')}`.padEnd(length, '7').slice(0, length)
const ID = {
  x: digits('51', 12), y: digits('52', 12), z: digits('53', 12),
  pageBravo: digits('61', 15), pageAlpha: digits('62', 15), igOfBravoPage: digits('71', 15),
  systemUser: digits('12', 15),
}
const h = vi.hoisted(() => ({ alerts: 0 }))

vi.mock('../cx/token.service.js', () => ({
  metaAppIdOf: vi.fn(async () => '1234567'),
  // Step 17: the gateway's live read of an object's account_id (fetch is a stand-in; no Meta call).
  getAccessToken: vi.fn(async () => 'meta-system-user-token'),
  metaRequestProof: vi.fn(async () => ({ appsecret_proof: 'proof', appsecret_time: '1760000000' })),
}))
vi.mock('../gateway/ledger.js', () => ({ writeLedgerRow: vi.fn(async () => undefined) }))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))
// Step 2: a choice queues the first read; here it is only recorded (no queue, no read, no Meta).
vi.mock('../marketing/meta-ads/enqueue.js', () => ({ enqueueMetaAdsSync: vi.fn(async () => ({ queued: true, reason: null })) }))
vi.mock('../monitoring/alert.service.js', () => ({ AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' }, alertService: { createAlert: vi.fn(async () => { h.alerts++ }) } }))
vi.mock('../cx/connectors/meta/discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cx/connectors/meta/discovery.js')>()),
  discoverMetaChoices: vi.fn(async () => ({
    systemUser: { id: ID.systemUser, name: 'Nexus system user' },
    adAccounts: {
      items: [ID.x, ID.y, ID.z].map((adAccountId, i) => ({ adAccountId, name: `Account ${i + 1}`, currency: 'EUR', timeZone: 'Europe/Rome', accountStatus: 1, statusText: 'Active', businessId: '9876543210', businessName: 'Portfolio' })),
      total: 3, error: null,
    },
    pages: { items: [{ pageId: ID.pageBravo, name: 'Bravo Page', instagram: null }, { pageId: ID.pageAlpha, name: 'Alpha Page', instagram: null }], total: 2, error: null },
    instagram: { items: [{ instagramId: ID.igOfBravoPage, username: 'bravo_ig', pageId: ID.pageBravo }], total: 1, error: null },
  })),
}))

import { __clearMetaChoicesCache, getMetaChoices, metaChoicesAnswer, saveMetaSelection } from './meta-accounts.service.js'
import { META_ADS_CONNECTION_TOOLS } from '../agents/tools/meta-ads-connection.tools.js'
import { metaExpiryAlerts } from '../../jobs/cx-heartbeat.job.js'
import { metaChosenAdAccountOf, metaStoredObject } from '../gateway/account.js'
import { metaWriteCall } from '../gateway/meta.js'

const ALPHA = `meta_alpha_${RUN}`
const BRAVO = `meta_bravo_${RUN}`
const conn = { alpha: '', bravo: '' }
const as = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const taken = (workspaceId: string, product: string | null, ids: string[] | null) =>
  as(workspaceId, () => database.client.$queryRaw<Array<{ id: string }>>`SELECT t.id FROM nexus_meta_links_taken(${product}, ${ids}::text[]) AS t(id)`)
const tool = META_ADS_CONNECTION_TOOLS.find((t) => t.name === 'set-meta-connection')!
const ctx = { can: () => true, via: 'claude' as const, userId: 'u-alpha-approver' }
const links = (workspaceId: string) => as(workspaceId, () => database.client.metaAccountLink.findMany({ orderBy: { product: 'asc' }, select: { product: true, externalId: true, selectedByUserId: true } }))

async function metaConnection(workspaceId: string): Promise<string> {
  return as(workspaceId, async () => (await database.client.channelConnection.create({
    data: {
      channelType: 'META', managedBy: 'oauth', isActive: true, authStatus: 'connected', identity: { userId: ID.systemUser, username: 'Nexus system user' },
      grantedScopes: ['ads_read', 'pages_show_list'],
      connectionMetadata: { environment: 'production', metaToken: { checkedAt: new Date().toISOString(), isValid: true, appId: '1234567', appMatches: true, type: 'SYSTEM_USER', userId: ID.systemUser, expiresAt: null, neverExpires: true, dataAccessExpiresAt: null, scopes: ['ads_read', 'pages_show_list'], missing: [], problem: null } },
    },
  })).id)
}

describe.skipIf(!concurrentDatabaseUrl())('Meta: one Meta id in one business (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase()
    const db = database.client
    const owner = await db.userProfile.create({ data: { email: `meta-${RUN}@example.test`, status: 'active', displayName: 'Meta owner' } })
    for (const id of [ALPHA, BRAVO]) await db.workspace.create({ data: { id, name: id === ALPHA ? 'Alpha business' : 'Bravo business', createdByUserId: owner.id, creationKey: randomUUID() } })
    conn.alpha = await metaConnection(ALPHA)
    conn.bravo = await metaConnection(BRAVO)
    await as(BRAVO, () => saveMetaSelection(conn.bravo, { adAccountId: ID.x, pageId: ID.pageBravo }, { userId: 'u-bravo' }))
    __clearMetaChoicesCache()
  }, 240_000)

  afterAll(async () => {
    await database?.close()
    vi.unstubAllEnvs()
  }, 120_000)

  it('the same system user is connected in both businesses (one login per business)', async () => {
    expect(await links(BRAVO)).toEqual([{ product: 'AD_ACCOUNT', externalId: ID.x, selectedByUserId: 'u-bravo' }, { product: 'PAGE', externalId: ID.pageBravo, selectedByUserId: 'u-bravo' }])
  })

  it('nexus_meta_links_taken answers only ids asked about that ANOTHER business uses — never which, never its own', async () => {
    expect(await taken(ALPHA, 'AD_ACCOUNT', [ID.x, ID.y])).toEqual([{ id: ID.x }])
    expect(await taken(ALPHA, 'AD_ACCOUNT', [ID.y, ID.z])).toEqual([])
    expect(await taken(ALPHA, 'PAGE', [ID.pageBravo, ID.pageAlpha])).toEqual([{ id: ID.pageBravo }])
    // The product matters: X is an ad account, not a Page.
    expect(await taken(ALPHA, 'PAGE', [ID.x])).toEqual([])
    // BRAVO's own picks are not "taken by another business" for BRAVO.
    expect(await taken(BRAVO, 'AD_ACCOUNT', [ID.x])).toEqual([])
    expect(await taken(ALPHA, 'AD_ACCOUNT', [])).toEqual([])
    expect(await taken(ALPHA, 'AD_ACCOUNT', null)).toEqual([])
    // Step 10 (20261021r10): a business portfolio is taken when ANOTHER business's chosen ad account belongs to it (the
    // portfolio stored with BRAVO's pick of X): ALPHA never reads that portfolio's media library; BRAVO's own is not taken.
    expect(await taken(ALPHA, 'PORTFOLIO', ['9876543210', '9876543211'])).toEqual([{ id: '9876543210' }])
    expect(await taken(BRAVO, 'PORTFOLIO', ['9876543210'])).toEqual([])
    expect(await taken(ALPHA, 'PORTFOLIO', [ID.x])).toEqual([])
  })

  it('it needs a business and a product; only the runtime role may execute it, as its owner', async () => {
    await expect(database.pool.query(`SELECT * FROM nexus_meta_links_taken('AD_ACCOUNT', ARRAY['1'])`)).rejects.toThrow(/needs a business/)
    await expect(taken(ALPHA, 'CATALOG', [ID.x])).rejects.toThrow(/AD_ACCOUNT, PAGE, INSTAGRAM or PORTFOLIO/)
    await expect(taken(ALPHA, null, [ID.x])).rejects.toThrow(/AD_ACCOUNT, PAGE, INSTAGRAM or PORTFOLIO/)
    const [grant] = (await database.pool.query(`SELECT
      has_function_privilege('nexus_workspace_runtime', 'nexus_meta_links_taken(text, text[])', 'EXECUTE') AS runtime,
      EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'nexus_meta_links_taken' AND a.grantee = 0) AS public,
      (SELECT prosecdef FROM pg_proc WHERE proname = 'nexus_meta_links_taken') AS definer,
      (SELECT proconfig FROM pg_proc WHERE proname = 'nexus_meta_links_taken') AS config`)).rows
    expect(grant).toMatchObject({ runtime: true, public: false, definer: true })
    expect(String(grant.config)).toMatch(/search_path=public, ?pg_temp/)
  })

  it('control: row security hides BRAVO\'s links from ALPHA\'s own queries', async () => {
    expect(await links(ALPHA)).toEqual([])
    expect(await as(ALPHA, () => database.client.metaAccountLink.count({ where: { externalId: ID.x } }))).toBe(0)
  })

  it('the choices: an asset BRAVO uses is answered by its id only', async () => {
    const answer = await as(ALPHA, async () => metaChoicesAnswer(await getMetaChoices(conn.alpha)))
    expect(answer.adAccounts.items[0]).toEqual({ adAccountId: ID.x, takenByAnotherBusiness: true })
    expect(answer.adAccounts.items[1]).toMatchObject({ adAccountId: ID.y, name: 'Account 2', takenByAnotherBusiness: false })
    expect(answer.pages.items[0]).toEqual({ pageId: ID.pageBravo, takenByAnotherBusiness: true })
    expect(JSON.stringify(answer.pages.items)).not.toMatch(/Bravo Page/)
    // The Instagram account linked to BRAVO's Page says so (the Page is id only).
    expect(answer.instagram.items[0]).toMatchObject({ instagramId: ID.igOfBravoPage, pageId: ID.pageBravo, pageTakenByAnotherBusiness: true, takenByAnotherBusiness: false })
  })
  it('an Instagram account linked to BRAVO\'s Page is refused in the preview and on save', async () => {
    expect(await as(ALPHA, () => tool.handler(tool.input.parse({ adAccountId: ID.y, instagramId: ID.igOfBravoPage }), ctx as never))).toMatchObject({ ok: false, error: expect.stringMatching(/linked to a Facebook Page another business/) })
    const err = await as(ALPHA, () => saveMetaSelection(conn.alpha, { adAccountId: ID.y, instagramId: ID.igOfBravoPage })).catch((e) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'taken_by_other_business', product: 'INSTAGRAM' })
    expect(await links(ALPHA)).toEqual([])
  })

  it('set-meta-connection: BRAVO\'s ad account is refused in the preview, and by the unique index when the preview is skipped', async () => {
    expect(await as(ALPHA, () => tool.handler(tool.input.parse({ adAccountId: ID.x }), ctx as never))).toMatchObject({ ok: false, error: expect.stringMatching(/one business only/) })
    const err = await as(ALPHA, () => saveMetaSelection(conn.alpha, { adAccountId: ID.x })).catch((e) => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'taken_by_other_business', product: 'AD_ACCOUNT' })
    expect(err.message).not.toMatch(/Bravo/)
    expect(await links(ALPHA)).toEqual([])
  })

  it('set-meta-connection saves as the approving person; undo puts the previous choice back; BRAVO never moves', async () => {
    const first = await as(ALPHA, () => tool.execute!(tool.input.parse({ adAccountId: ID.y, pageId: ID.pageAlpha }), ctx as never))
    expect(first).toMatchObject({ ok: true, data: { changed: true } })
    const second = await as(ALPHA, () => tool.execute!(tool.input.parse({ adAccountId: ID.z }), ctx as never))
    expect(second.change).toEqual({
      before: { connectionId: conn.alpha, adAccountId: ID.y, pageId: ID.pageAlpha, instagramId: null },
      after: { connectionId: conn.alpha, adAccountId: ID.z, pageId: ID.pageAlpha, instagramId: null },
    })
    expect(await as(ALPHA, () => tool.undo!.current(second.change!))).toEqual(second.change!.after)
    const back = tool.undo!.request(second.change!) as { tool: string; args: Record<string, unknown> }
    expect(back.tool).toBe('set-meta-connection')
    expect(await as(ALPHA, () => tool.execute!(tool.input.parse(back.args), ctx as never))).toMatchObject({ ok: true, data: { changed: true } })
    expect(await links(ALPHA)).toEqual([
      { product: 'AD_ACCOUNT', externalId: ID.y, selectedByUserId: 'u-alpha-approver' },
      { product: 'PAGE', externalId: ID.pageAlpha, selectedByUserId: 'u-alpha-approver' },
    ])
    expect(await links(BRAVO)).toEqual([{ product: 'AD_ACCOUNT', externalId: ID.x, selectedByUserId: 'u-bravo' }, { product: 'PAGE', externalId: ID.pageBravo, selectedByUserId: 'u-bravo' }])
    // Now ALPHA uses Y: BRAVO's view of it says so, by id only.
    expect(await taken(BRAVO, 'AD_ACCOUNT', [ID.y, ID.z])).toEqual([{ id: ID.y }])
  })

  it('step 17: the chosen-account check under row security — BRAVO\'s campaign, forged in ALPHA, is refused after ONE live read; nothing sent to change it', async () => {
    const campaignOfBravo = digits('81', 15)
    await as(BRAVO, () => database.client.metaAdsCampaign.create({ data: { adAccountId: ID.x, campaignId: campaignOfBravo, name: 'Bravo campaign', status: 'PAUSED', currencyCode: 'EUR', lastSeenAt: new Date() } }))
    // Control: BRAVO sees its own row and its own pick; ALPHA sees neither.
    expect(await as(BRAVO, () => metaStoredObject(campaignOfBravo))).toEqual({ adAccountId: ID.x, kind: 'campaign' })
    expect(await as(BRAVO, () => metaChosenAdAccountOf(conn.bravo))).toBe(ID.x)
    expect(await as(ALPHA, () => metaStoredObject(campaignOfBravo))).toBeNull()
    expect(await as(ALPHA, () => metaChosenAdAccountOf(conn.bravo))).toBeNull()
    expect(await as(ALPHA, () => metaChosenAdAccountOf(conn.alpha))).toBe(ID.y)
    // The shared system user can see BRAVO's campaign, so Meta answers its account: X, not ALPHA's Y.
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method) })
      return new Response(JSON.stringify({ id: campaignOfBravo, account_id: ID.x }), { status: 200 })
    }))
    try {
      const err = await as(ALPHA, () => metaWriteCall({ connectionId: conn.alpha, operation: 'campaign.status', objectId: campaignOfBravo, objectKind: 'campaign', params: { status: 'ACTIVE' }, check: false })).catch((e) => e)
      expect(err).toMatchObject({ code: 'META_ACCOUNT_NOT_CHOSEN', outcome: 'refused' })
      expect(String(err.message)).not.toContain(ID.x)
      expect(calls.map((c) => [c.method, new URL(c.url).pathname, new URL(c.url).searchParams.get('fields')])).toEqual([['GET', `/v26.0/${campaignOfBravo}`, 'account_id,objective,effective_status']])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('A7: an expiry warning once per level and expiry date; a renewed token warns afresh', async () => {
    const day = 86_400_000
    const row = { id: conn.alpha, displayName: 'Meta', accessTokenExpiresAt: new Date(Date.now() + 7 * day + 3_600_000) }
    h.alerts = 0
    await as(ALPHA, () => metaExpiryAlerts(row))
    await as(ALPHA, () => metaExpiryAlerts(row))
    expect(h.alerts).toBe(1)
    const renewed = { ...row, accessTokenExpiresAt: new Date(row.accessTokenExpiresAt.getTime() + 60_000) }
    await as(ALPHA, () => metaExpiryAlerts(renewed))
    expect(h.alerts).toBe(2)
    const events = await as(ALPHA, () => database.client.connectionEvent.findMany({ where: { connectionId: conn.alpha, type: 'status_change' }, select: { detail: true } }))
    expect(events.map((e) => (e.detail as { metaTokenExpiryWarnDays?: number }).metaTokenExpiryWarnDays)).toEqual([7, 7])
    // Another business never sees ALPHA's warnings.
    expect(await as(BRAVO, () => database.client.connectionEvent.count({ where: { connectionId: conn.alpha } }))).toBe(0)
  })
})
