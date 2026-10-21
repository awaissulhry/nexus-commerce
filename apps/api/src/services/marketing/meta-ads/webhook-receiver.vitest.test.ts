/**
 * Meta ads step 30 — the receiver's decisions: which businesses' own app secret signed a delivery (each checked inside
 * its own business), which ONE of them each change belongs to (a link it chose through that connection, its app, its
 * system user — else ignored), what one ledger row per change holds, that Meta's retries are no-ops, and what the
 * handler does (ownership again, the re-read, the notice) in the row's business. The ledger, claims, token service and
 * database are doubles that keep each business's rows apart; the ledger and claims themselves are proven on PostgreSQL
 * in services/cx/ingress. Made-up ids, names and secrets (public repo).
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { id: string; ws: string; channel: string; eventType: string; externalId: string; payload: any; status: string; connectionId: string | null; signatureOk: boolean | null; verifiedBy: string; lastError?: string | null; rawBody?: Buffer | null; deliveries: number }
const h = vi.hoisted(() => ({
  ws: null as string | null,
  routes: [] as Array<{ workspaceId: string; connectionId: string; externalAccountId: string | null }>,
  apps: {} as Record<string, { appId: string; secret: string; ws: string }>,
  links: [] as Array<{ ws: string; connectionId: string; product: string; externalId: string }>,
  connections: [] as Array<{ ws: string; id: string; externalAccountId: string }>,
  checks: [] as Array<{ connectionId: string; ws: string | null }>,
  rows: [] as Row[],
  ledgerDown: false,
  notices: [] as Array<{ ws: string | null; alert: any }>,
  rereads: [] as Array<{ ws: string | null; adAccountId: string }>,
  reread: { queued: true, reason: null as string | null, retry: false },
}))

vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../lib/workspace-ingress.js', () => {
  const inWs = async <T>(ws: string, work: () => T) => { const before = h.ws; h.ws = ws; try { return await work() } finally { h.ws = before } }
  return {
    activeChannelRoutes: async (channel: string) => (channel === 'META' ? h.routes : []),
    withIngressWorkspace: inWs,
    legacyIngress: <T>(work: () => T) => inWs('legacy', work),
  }
})
vi.mock('../../cx/token.service.js', async () => {
  const { metaWebhookSignatureOk } = await import('../../cx/connectors/meta/webhook-signature.js')
  return {
    metaWebhookSignatureCheck: async (connectionId: string, appId: string, raw: Buffer, header: string | undefined) => {
      h.checks.push({ connectionId, ws: h.ws })
      const app = h.apps[connectionId]
      if (!app || app.ws !== h.ws) return 'no_app'
      if (app.appId !== appId) return 'other_app'
      return metaWebhookSignatureOk(raw, header, app.secret) ? 'match' : 'mismatch'
    },
    metaAppIdOf: async (connectionId: string) => (h.apps[connectionId]?.ws === h.ws ? h.apps[connectionId].appId : null),
  }
})
vi.mock('../../../db.js', () => ({
  default: {
    metaAccountLink: {
      findMany: async ({ where }: any) => h.links.filter((l) => l.ws === h.ws && l.product === where.product && where.externalId.in.includes(l.externalId) && l.connectionId === where.connectionId).map((l) => ({ externalId: l.externalId })),
      findFirst: async ({ where }: any) => h.links.find((l) => l.ws === h.ws && l.product === where.product && l.externalId === where.externalId && l.connectionId === where.connectionId) ?? null,
    },
    channelConnection: {
      findFirst: async ({ where }: any) => h.connections.find((c) => c.ws === h.ws && c.id === where.id && c.externalAccountId === where.externalAccountId) ?? null,
    },
  },
}))
vi.mock('../../cx/ingress/ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../cx/ingress/ledger.js')>()),
  recordInbound: async (rec: any) => {
    if (h.ledgerDown) return { id: null, duplicate: false }
    const ws = h.ws as string
    const externalId = rec.externalId ?? `sha256:${rec.rawBody?.length}`
    const found = h.rows.find((r) => r.ws === ws && r.channel === rec.channel && r.externalId === externalId)
    if (found) { found.deliveries++; return { id: found.id, duplicate: true, existingStatus: found.status } }
    const row: Row = { id: `row-${h.rows.length + 1}`, ws, channel: rec.channel, eventType: rec.eventType, externalId, payload: rec.payload, status: rec.status ?? 'pending', connectionId: rec.connectionId ?? null, signatureOk: rec.signatureOk, verifiedBy: rec.verifiedBy, lastError: rec.lastError ?? null, rawBody: rec.rawBody ?? null, deliveries: 1 }
    h.rows.push(row)
    return { id: row.id, duplicate: false }
  },
}))
vi.mock('../../cx/ingress/claims.js', () => ({
  claimInbound: async (id: string) => {
    const row = h.rows.find((r) => r.id === id && r.ws === h.ws)
    if (!row || row.status !== 'pending') return null
    return { id, token: 't', attempt: 1, payload: row.payload, connectionId: row.connectionId, eventType: row.eventType, channel: row.channel }
  },
  runWithInboundClaim: async (claim: any, work: any) => {
    const row = h.rows.find((r) => r.id === claim.id)!
    try { const out = await work(claim, new AbortController().signal); row.status = 'done'; return out } catch (err) { row.status = 'failed'; throw err }
  },
}))
vi.mock('../../cx/channel-alerts.service.js', () => ({ raiseChannelAlertInTx: async (_tx: unknown, alert: unknown) => { h.notices.push({ ws: h.ws, alert }); return { created: 1, deduped: 0, recipients: 1 } } }))
vi.mock('./enqueue.js', () => ({ enqueueMetaWebhookReread: async (adAccountId: string) => { h.rereads.push({ ws: h.ws, adAccountId }); return h.reread } }))

const { metaSigningBusinesses, receiveMetaWebhook, handleMetaWebhookEvent, metaAppConnected, recordMetaRejection, routeMetaChanges } = await import('./webhook-receiver.js')
const { metaWebhookChanges } = await import('./webhook-topics.js')

const APP = '1234567890123'
const OTHER_APP = '1234567890999'
const SECRET = 'a-made-up-app-secret-for-tests-01'
const ACT_A = '1234567890'
const ACT_B = '1234567891'
const ACT_NOBODY = '1234567892'
const PAGE_A = '120000000000001'
const USER_A = '120000000000011'
const sign = (raw: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
const issue = (act: string, id = '120000000000301') => ({ id: act, time: 1782862117, changes: [{ field: 'with_issues_ad_objects', value: { id, level: 'AD', error_code: '567', error_summary: 'Rejected', error_message: 'Your ad was rejected' } }] })
const A = { workspaceId: 'ws-a', connectionId: 'conn-a', systemUserId: USER_A }
const B = { workspaceId: 'ws-b', connectionId: 'conn-b', systemUserId: '120000000000012' }

beforeEach(() => {
  h.ws = null
  h.routes = [{ workspaceId: 'ws-a', connectionId: 'conn-a', externalAccountId: USER_A }, { workspaceId: 'ws-b', connectionId: 'conn-b', externalAccountId: '120000000000012' }, { workspaceId: 'ws-c', connectionId: 'conn-c', externalAccountId: '120000000000013' }]
  h.apps = { 'conn-a': { appId: APP, secret: SECRET, ws: 'ws-a' }, 'conn-b': { appId: APP, secret: SECRET, ws: 'ws-b' }, 'conn-c': { appId: OTHER_APP, secret: 'the-secret-of-another-app-000000', ws: 'ws-c' } }
  h.links = [
    { ws: 'ws-a', connectionId: 'conn-a', product: 'AD_ACCOUNT', externalId: ACT_A },
    { ws: 'ws-a', connectionId: 'conn-a', product: 'PAGE', externalId: PAGE_A },
    { ws: 'ws-b', connectionId: 'conn-b', product: 'AD_ACCOUNT', externalId: ACT_B },
  ]
  h.connections = [{ ws: 'ws-a', id: 'conn-a', externalAccountId: USER_A }]
  h.checks.length = 0; h.rows.length = 0; h.notices.length = 0; h.rereads.length = 0
  h.ledgerDown = false
  h.reread = { queued: true, reason: null, retry: false }
})

describe('trust: whose own app secret signed these bytes', () => {
  it('each connection checks with its own secret inside its own business; only the matching ones are candidates', async () => {
    const raw = Buffer.from(JSON.stringify({ object: 'ad_account', entry: [issue(ACT_A)] }))
    h.apps['conn-b'].secret = 'a-stale-secret-business-b-kept-00'
    const signed = await metaSigningBusinesses(APP, raw, sign(raw))
    expect(signed).toEqual({ businesses: [A], appKnown: true })
    expect(h.checks).toEqual([{ connectionId: 'conn-a', ws: 'ws-a' }, { connectionId: 'conn-b', ws: 'ws-b' }, { connectionId: 'conn-c', ws: 'ws-c' }])
    expect(await metaSigningBusinesses(APP, raw, sign(raw, 'a-forged-secret-00000000000000000'))).toEqual({ businesses: [], appKnown: true })
    expect(await metaSigningBusinesses('5550000000000', raw, sign(raw))).toEqual({ businesses: [], appKnown: false })
    expect(await metaSigningBusinesses('not-an-app', raw, sign(raw))).toEqual({ businesses: [], appKnown: false })
  })

  it('verification knows only apps a connected business uses', async () => {
    expect(await metaAppConnected(APP)).toBe(true)
    expect(await metaAppConnected(OTHER_APP)).toBe(true)
    expect(await metaAppConnected('5550000000000')).toBe(false)
    expect(await metaAppConnected('x')).toBe(false)
  })

  it('a rejected delivery is one legacy row: the raw bytes and the signature header, nothing parsed', async () => {
    const raw = Buffer.from('not json at all')
    await recordMetaRejection(raw, { 'x-hub-signature-256': 'sha256=00' }, 'X-Hub-Signature-256 does not match.')
    expect(h.rows).toEqual([expect.objectContaining({ ws: 'legacy', channel: 'META', eventType: 'unverified', payload: {}, signatureOk: false, verifiedBy: 'none', status: 'failed', rawBody: raw })])
  })
})

describe('routing: one business per change, never another', () => {
  it('an app two businesses share: each ad account goes to the business that chose it; one nobody chose is ignored', async () => {
    const body = { object: 'ad_account', entry: [issue(ACT_A), issue(ACT_B, '120000000000302'), issue(ACT_NOBODY, '120000000000303')] }
    const out = await receiveMetaWebhook({ appId: APP, businesses: [A, B], body })
    expect(out).toMatchObject({ changes: 3, recorded: 2, ignored: 1, handled: 2, notRecorded: 0 })
    expect(h.rows.map((r) => [r.ws, r.connectionId, r.eventType, r.payload.entryId])).toEqual([
      ['ws-a', 'conn-a', 'ad_account.with_issues_ad_objects', ACT_A],
      ['ws-b', 'conn-b', 'ad_account.with_issues_ad_objects', ACT_B],
    ])
    expect(h.rows.every((r) => r.signatureOk === true && r.verifiedBy === 'meta_hmac')).toBe(true)
    // The handler ran in each row's own business: the re-read and the notice too.
    expect(h.rereads).toEqual([{ ws: 'ws-a', adAccountId: ACT_A }, { ws: 'ws-b', adAccountId: ACT_B }])
    expect(h.notices.map((n) => [n.ws, n.alert.entityId])).toEqual([['ws-a', `${ACT_A}~120000000000301`], ['ws-b', `${ACT_B}~120000000000302`]])
    expect(JSON.stringify(h.rows.filter((r) => r.ws === 'ws-a'))).not.toContain(ACT_B)
  })

  it('a link the business chose through ANOTHER connection than the one whose secret signed is not routed', async () => {
    h.links = [{ ws: 'ws-a', connectionId: 'conn-a-second', product: 'AD_ACCOUNT', externalId: ACT_A }]
    const out = await receiveMetaWebhook({ appId: APP, businesses: [A], body: { object: 'ad_account', entry: [issue(ACT_A)] } })
    expect(out).toMatchObject({ recorded: 0, ignored: 1 })
    expect(h.rows).toEqual([])
  })

  it('app-level and catalog changes go only to the ONE business using the app; with two, nobody gets them', async () => {
    const devAlert = { object: 'application', entry: [{ id: APP, time: 1, changes: [{ field: 'dev_alerts', value: { notification_id: '1', header: 'Rate limit', subtitle: 'Your app is close to its limit' } }] }] }
    expect(await receiveMetaWebhook({ appId: APP, businesses: [A, B], body: devAlert })).toMatchObject({ recorded: 0, ignored: 1 })
    expect(await receiveMetaWebhook({ appId: APP, businesses: [A], body: devAlert })).toMatchObject({ recorded: 1, handled: 1 })
    expect(h.notices).toEqual([{ ws: 'ws-a', alert: expect.objectContaining({ kind: 'meta-app-notice', title: 'Meta app alert: Rate limit' }) }])
    const batch = { object: 'catalog', entry: [{ id: '120000000000777', time: 1, changes: [{ field: 'items_batch', value: { catalog_id: '120000000000777', handle: 'h1', status: 'Finished' } }] }] }
    expect(await receiveMetaWebhook({ appId: APP, businesses: [A, B], body: batch })).toMatchObject({ ignored: 1 })
  })

  it('an application ad_account change by the account it names; permissions only for the business\'s own system user', async () => {
    const status = { object: 'application', entry: [{ id: APP, time: 1, changes: [{ field: 'ad_account', value: { id: ACT_B, account_status: 2, disable_reason: 1 } }] }] }
    await receiveMetaWebhook({ appId: APP, businesses: [A, B], body: status })
    expect(h.rows.map((r) => r.ws)).toEqual(['ws-b'])
    expect(h.notices[0]).toMatchObject({ ws: 'ws-b', alert: { kind: 'meta-ads-account-status', severity: 'danger' } })
    expect(h.rereads).toEqual([{ ws: 'ws-b', adAccountId: ACT_B }])
    const revoked = (user: string) => ({ object: 'permissions', entry: [{ id: user, time: 2, changes: [{ field: 'connected', value: { verb: 'disconnected' } }] }] })
    expect(await receiveMetaWebhook({ appId: APP, businesses: [A, B], body: revoked(USER_A) })).toMatchObject({ recorded: 1 })
    expect(await receiveMetaWebhook({ appId: APP, businesses: [A, B], body: revoked('120000000000099') })).toMatchObject({ recorded: 0, ignored: 1 })
  })

  it('an object Nexus does not route is ignored, never stored', async () => {
    const owners = await routeMetaChanges([A], metaWebhookChanges({ object: 'user', entry: [{ id: USER_A, time: 1, changes: [{ field: 'photos', value: {} }] }] })!)
    expect(owners).toEqual([null])
    expect(await receiveMetaWebhook({ appId: APP, businesses: [A], body: { hello: 'world' } })).toBeNull()
  })
})

describe('recording: one row per change, retries are no-ops', () => {
  it('Meta resending the same delivery adds a delivery and does nothing again', async () => {
    const body = { object: 'ad_account', entry: [issue(ACT_A)] }
    await receiveMetaWebhook({ appId: APP, businesses: [A], body })
    const again = await receiveMetaWebhook({ appId: APP, businesses: [A], body })
    expect(again).toMatchObject({ recorded: 0, duplicates: 1, handled: 0 })
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0].deliveries).toBe(2)
    expect(h.notices).toHaveLength(1)
    expect(h.rereads).toHaveLength(1)
  })

  it('topics Nexus only records are written done, keep no message text and run nothing', async () => {
    const body = { object: 'page', entry: [{ id: PAGE_A, time: 1458692752478, messaging: [{ sender: { id: '7000000000000001' }, recipient: { id: PAGE_A }, timestamp: 1, message: { mid: 'm1', text: 'my phone is …' } }] }] }
    const out = await receiveMetaWebhook({ appId: APP, businesses: [A], body })
    expect(out).toMatchObject({ recorded: 1, handled: 0 })
    expect(h.rows[0]).toMatchObject({ eventType: 'page.messages', status: 'done', payload: { value: { timestamp: 1, message: { mid: 'm1' } } } })
    expect(JSON.stringify(h.rows[0])).not.toMatch(/phone|7000000000000001/)
  })

  it('a change the ledger cannot take is counted, so the delivery is answered 503 and Meta sends it again', async () => {
    h.ledgerDown = true
    expect(await receiveMetaWebhook({ appId: APP, businesses: [A], body: { object: 'ad_account', entry: [issue(ACT_A)] } })).toMatchObject({ notRecorded: 1, recorded: 0 })
  })

  it('past the answer budget, recorded changes stay due for the retry sweep instead of running inline', async () => {
    const out = await receiveMetaWebhook({ appId: APP, businesses: [A], body: { object: 'ad_account', entry: [issue(ACT_A)] }, startedAt: Date.now() - 60_000 })
    expect(out).toMatchObject({ recorded: 1, handled: 0, later: 1 })
    expect(h.rows[0].status).toBe('pending')
    expect(h.notices).toHaveLength(0)
  })
})

describe('the handler (receiver, retry sweep, replay)', () => {
  it('the replay registry loads this handler for every topic it acts on', async () => {
    const { inboundHandlerFor } = await import('../../cx/ingress/handlers.js')
    const { META_HANDLED_TOPICS } = await import('./webhook-topics.js')
    expect(META_HANDLED_TOPICS.length).toBeGreaterThan(20)
    for (const topic of META_HANDLED_TOPICS) expect(await inboundHandlerFor('META', topic)).toBe(handleMetaWebhookEvent)
  })

  const stored = (over: Record<string, unknown> = {}) => ({ appId: APP, object: 'ad_account', entryId: ACT_A, field: 'with_issues_ad_objects', time: 1, value: { id: '120000000000301', level: 'AD' }, ...over })
  const inA = <T>(work: () => Promise<T>) => { h.ws = 'ws-a'; return work().finally(() => { h.ws = null }) }

  it('does nothing for a change no longer this business\'s (the link was let go before a replay)', async () => {
    h.links = []
    await inA(() => handleMetaWebhookEvent(stored(), { connectionId: 'conn-a', eventType: 'ad_account.with_issues_ad_objects', channel: 'META' }))
    expect(h.notices).toEqual([])
    expect(h.rereads).toEqual([])
  })

  it('asks for the re-read; a queue that did not answer fails the attempt (the ledger retries), a queue switched off does not', async () => {
    h.reread = { queued: false, reason: 'The read queue did not answer.', retry: true }
    await expect(inA(() => handleMetaWebhookEvent(stored({ field: 'in_process_ad_objects', value: { id: '1', level: 'AD', status_name: 'Active' } }), { connectionId: 'conn-a', eventType: 'ad_account.in_process_ad_objects', channel: 'META' }))).rejects.toThrow(/not queued/)
    h.reread = { queued: false, reason: 'Queue workers are off in this process; the next daily read shows the change.', retry: false }
    await expect(inA(() => handleMetaWebhookEvent(stored({ field: 'in_process_ad_objects', value: { id: '1', level: 'AD', status_name: 'Active' } }), { connectionId: 'conn-a', eventType: 'ad_account.in_process_ad_objects', channel: 'META' }))).resolves.toBeUndefined()
    expect(h.notices).toEqual([])
  })

  it('refuses a row with no connection or no readable change; a record-only topic does nothing', async () => {
    await expect(inA(() => handleMetaWebhookEvent(stored(), { connectionId: null, eventType: 'x', channel: 'META' }))).rejects.toThrow(/no connected account/)
    await expect(inA(() => handleMetaWebhookEvent({ nope: true }, { connectionId: 'conn-a', eventType: 'x', channel: 'META' }))).rejects.toThrow(/no readable change/)
    await inA(() => handleMetaWebhookEvent(stored({ object: 'page', entryId: PAGE_A, field: 'feed' }), { connectionId: 'conn-a', eventType: 'page.feed', channel: 'META' }))
    expect(h.notices).toEqual([])
  })

  it('an app-level change runs only while the connection still uses that app', async () => {
    const devAlert = stored({ object: 'application', entryId: APP, field: 'dev_alerts', value: { notification_id: '1', header: 'Rate limit' } })
    await inA(() => handleMetaWebhookEvent(devAlert, { connectionId: 'conn-a', eventType: 'application.dev_alerts', channel: 'META' }))
    expect(h.notices).toHaveLength(1)
    h.apps['conn-a'].appId = '5550000000000'
    await inA(() => handleMetaWebhookEvent(devAlert, { connectionId: 'conn-a', eventType: 'application.dev_alerts', channel: 'META' }))
    expect(h.notices).toHaveLength(1)
  })
})
