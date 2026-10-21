/**
 * Meta ads step 30 — the receiver's decisions: which connections use an app (no secret read for anything else), whose
 * own secret signed a delivery (each checked inside its own business), what a signature that matches nobody leaves
 * behind (one row and one notice per business using the app, never the bytes, never the platform's business), which
 * ONE business each change belongs to, the batch it is recorded in, that Meta's retries are no-ops, that each distinct
 * action runs once inside the answer budget, and what the handler checks again on a replay. The ledger, claims, token
 * service and database are doubles that keep each business's rows apart; the batch ledger itself is proven on
 * PostgreSQL in services/cx/ingress/ledger-batch-postgres. Made-up ids, names and secrets (public repo).
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { id: string; ws: string; channel: string; eventType: string; externalId: string; payload: any; status: string; connectionId: string | null; signatureOk: boolean | null; verifiedBy: string; lastError?: string | null; rawBody?: unknown; headers?: unknown; deliveries: number; token?: string | null }
const h = vi.hoisted(() => ({
  ws: null as string | null,
  routes: [] as Array<{ workspaceId: string; connectionId: string; externalAccountId: string | null }>,
  apps: {} as Record<string, { appId: string; secret: string; ws: string }>,
  appIdReads: 0,
  appReadFails: new Set<string>(),
  checkFails: new Set<string>(),
  conflictOn: null as string | null,
  occurrences: [] as Array<string | undefined>,
  links: [] as Array<{ ws: string; connectionId: string; product: string; externalId: string }>,
  connections: [] as Array<{ ws: string; id: string; externalAccountId: string }>,
  checks: [] as Array<{ connectionId: string; ws: string | null }>,
  rows: [] as Row[],
  batches: [] as Array<{ ws: string | null; size: number }>,
  ledgerDown: false,
  notices: [] as Array<{ ws: string | null; alert: any }>,
  unread: new Set<string>(),
  rereads: [] as Array<{ ws: string | null; adAccountId: string }>,
  reread: { queued: true, reason: null as string | null, retry: false },
}))

vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../lib/workspace-context.js', () => ({ workspaceIdForQuery: () => h.ws }))
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
      if (h.checkFails.has(connectionId)) return 'error'
      const app = h.apps[connectionId]
      if (!app || app.ws !== h.ws) return 'no_app'
      if (app.appId !== appId) return 'other_app'
      return metaWebhookSignatureOk(raw, header, app.secret) ? 'match' : 'mismatch'
    },
    metaAppIdOf: async (connectionId: string) => (h.apps[connectionId]?.ws === h.ws ? h.apps[connectionId].appId : null),
    metaStoredAppId: async (connectionId: string) => {
      h.appIdReads++
      if (h.appReadFails.has(connectionId)) throw new Error('KMS unavailable')
      return h.apps[connectionId]?.ws === h.ws ? h.apps[connectionId].appId : null
    },
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
const write = (rec: any) => {
  const ws = h.ws as string
  const found = h.rows.find((r) => r.ws === ws && r.channel === rec.channel && r.externalId === rec.externalId)
  if (found) { found.deliveries++; return { id: found.id, duplicate: true, existingStatus: found.status } }
  const row: Row = { id: `row-${h.rows.length + 1}`, ws, channel: rec.channel, eventType: rec.eventType, externalId: rec.externalId, payload: rec.payload, status: rec.status ?? 'pending', connectionId: rec.connectionId ?? null, signatureOk: rec.signatureOk, verifiedBy: rec.verifiedBy, lastError: rec.lastError ?? null, rawBody: rec.rawBody ?? null, headers: rec.headers, deliveries: 1 }
  h.rows.push(row)
  return { id: row.id, duplicate: false }
}
vi.mock('../../cx/ingress/ledger.js', () => ({
  recordInbound: async (rec: any) => (h.ledgerDown ? { id: null, duplicate: false } : write(rec)),
  recordInboundBatch: async (recs: any[]) => {
    h.batches.push({ ws: h.ws, size: recs.length })
    return recs.map((rec) => (h.ledgerDown ? { id: null, duplicate: false } : rec.eventType === h.conflictOn ? { id: null, duplicate: true, conflict: 'identity_mismatch' } : write(rec)))
  },
}))
vi.mock('../../cx/ingress/claims.js', () => ({
  claimInboundMany: async (ids: string[]) => {
    const claims = h.rows.filter((r) => ids.includes(r.id) && r.ws === h.ws && r.status === 'pending' && !r.token)
      .map((r) => { r.token = 'batch'; return { id: r.id, token: 'batch', attempt: 1, payload: r.payload, connectionId: r.connectionId, eventType: r.eventType, channel: r.channel } })
    return { token: 'batch', claims }
  },
  finishInboundClaimMany: async (_claims: unknown, outcome: { done: string[]; release: string[]; failed: Array<{ id: string }> }) => {
    for (const r of h.rows) {
      if (outcome.done.includes(r.id)) { r.status = 'done'; r.token = null }
      if (outcome.release.includes(r.id)) r.token = null
      if (outcome.failed.some((f) => f.id === r.id)) { r.status = 'failed'; r.token = null }
    }
  },
}))
// One unread notice per (business, kind, subject), as channel-alerts does.
vi.mock('../../cx/channel-alerts.service.js', () => ({ raiseChannelAlertInTx: async (_tx: unknown, alert: any, options?: { occurrenceId?: string }) => {
  if (alert.kind === 'meta-webhook-signature') h.occurrences.push(options?.occurrenceId)
  const key = `${h.ws}|${alert.kind}|${alert.entityType}|${alert.entityId}|${options?.occurrenceId ?? ''}`
  if (h.unread.has(key)) return { created: 0, deduped: 1, recipients: 1 }
  h.unread.add(key)
  h.notices.push({ ws: h.ws, alert })
  return { created: 1, deduped: 0, recipients: 1 }
} }))
vi.mock('./enqueue.js', () => ({ enqueueMetaWebhookReread: async (adAccountId: string) => { h.rereads.push({ ws: h.ws, adAccountId }); return h.reread } }))

const { metaSignatureVerdicts, receiveMetaWebhook, handleMetaWebhookEvent, metaAppConnected, metaAppKnown, metaAppUsers, recordMetaSignatureMismatch, routeMetaChanges, forgetMetaAppIds } = await import('./webhook-receiver.js')
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
  forgetMetaAppIds()
  h.ws = null
  h.routes = [{ workspaceId: 'ws-a', connectionId: 'conn-a', externalAccountId: USER_A }, { workspaceId: 'ws-b', connectionId: 'conn-b', externalAccountId: '120000000000012' }, { workspaceId: 'ws-c', connectionId: 'conn-c', externalAccountId: '120000000000013' }]
  h.apps = { 'conn-a': { appId: APP, secret: SECRET, ws: 'ws-a' }, 'conn-b': { appId: APP, secret: SECRET, ws: 'ws-b' }, 'conn-c': { appId: OTHER_APP, secret: 'the-secret-of-another-app-000000', ws: 'ws-c' } }
  h.appIdReads = 0
  h.appReadFails.clear(); h.checkFails.clear(); h.conflictOn = null; h.occurrences.length = 0
  h.links = [
    { ws: 'ws-a', connectionId: 'conn-a', product: 'AD_ACCOUNT', externalId: ACT_A },
    { ws: 'ws-a', connectionId: 'conn-a', product: 'PAGE', externalId: PAGE_A },
    { ws: 'ws-b', connectionId: 'conn-b', product: 'AD_ACCOUNT', externalId: ACT_B },
  ]
  h.connections = [{ ws: 'ws-a', id: 'conn-a', externalAccountId: USER_A }]
  h.checks.length = 0; h.rows.length = 0; h.notices.length = 0; h.rereads.length = 0; h.batches.length = 0
  h.unread.clear()
  h.ledgerDown = false
  h.reread = { queued: true, reason: null, retry: false }
})

describe('trust: who uses the app, whose own secret signed these bytes', () => {
  it('only the connections of the path\'s app check a signature, each inside its own business; app ids are read once per TTL', async () => {
    const raw = Buffer.from(JSON.stringify({ object: 'ad_account', entry: [issue(ACT_A)] }))
    h.apps['conn-b'].secret = 'a-stale-secret-business-b-kept-00'
    const verdicts = await metaSignatureVerdicts(APP, raw, sign(raw))
    expect(verdicts).toEqual({ users: [A, B], signers: [A], mismatched: [B], unsure: false })
    // conn-c uses another app: its secret is never touched.
    expect(h.checks).toEqual([{ connectionId: 'conn-a', ws: 'ws-a' }, { connectionId: 'conn-b', ws: 'ws-b' }])
    const reads = h.appIdReads
    await metaSignatureVerdicts(APP, raw, sign(raw))
    await metaSignatureVerdicts('5550000000000', raw, sign(raw))
    expect(h.appIdReads).toBe(reads)
  })

  it('an app no business uses has no users (refused before its body is read); verification knows only used apps', async () => {
    expect(await metaAppUsers('5550000000000')).toEqual({ users: [], unsure: false })
    expect(await metaAppUsers('not-an-app')).toEqual({ users: [], unsure: false })
    expect(await metaAppConnected(APP)).toBe(true)
    expect(await metaAppConnected(OTHER_APP)).toBe(true)
    expect(await metaAppConnected('5550000000000')).toBe(false)
  })

  it('review N3 — a connection whose app id could not be read is "unsure" (503), and the failed read is never kept', async () => {
    h.appReadFails.add('conn-c')
    expect(await metaAppKnown(OTHER_APP)).toBe('unsure')
    expect(await metaAppKnown(APP)).toBe('known')
    const reads = h.appIdReads
    h.appReadFails.clear()
    expect(await metaAppKnown(OTHER_APP)).toBe('known')
    expect(h.appIdReads).toBe(reads + 1)
    // A candidate whose secret could not be checked makes the verdicts unsure.
    const raw = Buffer.from('{}')
    h.checkFails.add('conn-b')
    expect(await metaSignatureVerdicts(APP, raw, sign(raw))).toMatchObject({ signers: [A], unsure: true })
  })

  it('a signature nobody\'s secret matches: one row per business per hour (digest + header, never the bytes) and one notice each; never the platform\'s business', async () => {
    const raw = Buffer.from('{"object":"page","entry":[{"id":"120000000000001","messaging":[{"message":{"text":"another business\'s customer wrote this"}}]}]}')
    const at = new Date('2026-10-21T09:10:00Z')
    await recordMetaSignatureMismatch(APP, raw, { 'x-hub-signature-256': 'sha256=00' }, [A, B], at)
    await recordMetaSignatureMismatch(APP, Buffer.from('{"other":1}'), { 'x-hub-signature-256': 'sha256=11' }, [A, B], new Date('2026-10-21T09:40:00Z'))
    expect(h.rows.map((r) => [r.ws, r.eventType, r.signatureOk, r.status, r.deliveries])).toEqual([['ws-a', 'unverified', false, 'failed', 2], ['ws-b', 'unverified', false, 'failed', 2]])
    expect(h.rows.every((r) => r.rawBody === null && !JSON.stringify(r).includes('customer wrote'))).toBe(true)
    expect(h.rows[0].payload).toEqual({ appId: APP, firstDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(h.notices.map((n) => [n.ws, n.alert.kind, n.alert.entityId])).toEqual([['ws-a', 'meta-webhook-signature', `${APP}~signature`], ['ws-b', 'meta-webhook-signature', `${APP}~signature`]])
    expect(h.rows.some((r) => r.ws === 'legacy')).toBe(false)
    // Review N5 — at most one per business per 24 hours: the day is the notice's occurrence; the text names both causes.
    expect(h.occurrences).toEqual(['day-20747', 'day-20747', 'day-20747', 'day-20747'])
    expect(h.notices[0].alert.body).toMatch(/Either the app secret was changed in Meta .* or someone other than Meta sent them/)
    expect(h.rows[0].headers).toEqual({ 'x-hub-signature-256': 'sha256=00' })
  })
})

describe('routing: one business per change, never another', () => {
  it('an app two businesses share: each ad account goes to the business that chose it; one nobody chose is ignored', async () => {
    const body = { object: 'ad_account', entry: [issue(ACT_A), issue(ACT_B, '120000000000302'), issue(ACT_NOBODY, '120000000000303')] }
    const out = await receiveMetaWebhook({ appId: APP, signers: [A, B], users: [A, B], body })
    expect(out).toMatchObject({ changes: 3, recorded: 2, ignored: 1, handled: 2, notRecorded: 0 })
    expect(h.rows.map((r) => [r.ws, r.connectionId, r.eventType, r.payload.entryId, r.status])).toEqual([
      ['ws-a', 'conn-a', 'ad_account.with_issues_ad_objects', ACT_A, 'done'],
      ['ws-b', 'conn-b', 'ad_account.with_issues_ad_objects', ACT_B, 'done'],
    ])
    expect(h.rows.every((r) => r.signatureOk === true && r.verifiedBy === 'meta_hmac')).toBe(true)
    expect(h.rereads).toEqual([{ ws: 'ws-a', adAccountId: ACT_A }, { ws: 'ws-b', adAccountId: ACT_B }])
    expect(h.notices.map((n) => n.ws)).toEqual(['ws-a', 'ws-b'])
    expect(JSON.stringify(h.rows.filter((r) => r.ws === 'ws-a'))).not.toContain(ACT_B)
  })

  it('review F3 — two businesses on one app, one secret stale: nothing lands in the other, and app-level changes land nowhere', async () => {
    const devAlert = { object: 'application', entry: [{ id: APP, time: 1, changes: [{ field: 'dev_alerts', value: { notification_id: '1', header: 'Rate limit' } }] }] }
    // B's secret is stale: only A signed; B still USES the app, so nobody gets the app-level alert.
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A, B], body: devAlert })).toMatchObject({ recorded: 0, ignored: 1 })
    // B's own ad account in a delivery only A's secret signed: never A's, never recorded.
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A, B], body: { object: 'ad_account', entry: [issue(ACT_B)] } })).toMatchObject({ recorded: 0, ignored: 1 })
    expect(h.rows).toEqual([])
    // With A the only business on the app (B disconnected), the alert is A's.
    h.routes = h.routes.filter((r) => r.connectionId !== 'conn-b')
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: devAlert })).toMatchObject({ recorded: 1, handled: 1 })
    expect(h.notices).toEqual([{ ws: 'ws-a', alert: expect.objectContaining({ kind: 'meta-app-notice', title: 'Meta app alert: Rate limit' }) }])
  })

  it('review N4 — an app-level change is decided on app ids read again now: a business that joined the app inside the TTL counts', async () => {
    const devAlert = { object: 'application', entry: [{ id: APP, time: 1, changes: [{ field: 'dev_alerts', value: { notification_id: '7', header: 'Rate limit' } }] }] }
    h.apps['conn-b'].appId = OTHER_APP
    expect((await metaAppUsers(APP)).users).toEqual([A]) // kept: B uses another app
    h.apps['conn-b'].appId = APP // B switched to this app inside the TTL
    expect((await metaAppUsers(APP)).users).toEqual([A]) // the kept ids still say A alone…
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: devAlert })).toMatchObject({ recorded: 0, ignored: 1, unsure: false })
    // A read that fails then: undecided, answered 503 (unsure), nothing recorded.
    h.appReadFails.add('conn-b')
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: devAlert })).toMatchObject({ recorded: 0, unsure: true })
    expect(h.rows).toEqual([])
  })

  it('review N1 — a business on a NEW connection row records anew; a delivery id bound to another account row is ignored, never 503', async () => {
    const body = { object: 'ad_account', entry: [issue(ACT_A)] }
    await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body })
    h.links.push({ ws: 'ws-a', connectionId: 'conn-a2', product: 'AD_ACCOUNT', externalId: ACT_A })
    const moved = { workspaceId: 'ws-a', connectionId: 'conn-a2', systemUserId: USER_A }
    expect(await receiveMetaWebhook({ appId: APP, signers: [moved], users: [moved], body })).toMatchObject({ recorded: 1, duplicates: 0, notRecorded: 0 })
    expect(new Set(h.rows.map((r) => r.externalId)).size).toBe(2)
    h.conflictOn = 'ad_account.with_issues_ad_objects'
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: { object: 'ad_account', entry: [issue(ACT_A, '120000000000777')] } })).toMatchObject({ ignored: 1, notRecorded: 0, recorded: 0 })
  })

  it('a link the business chose through ANOTHER connection than the one whose secret signed is not routed', async () => {
    h.links = [{ ws: 'ws-a', connectionId: 'conn-a-second', product: 'AD_ACCOUNT', externalId: ACT_A }]
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: { object: 'ad_account', entry: [issue(ACT_A)] } })).toMatchObject({ recorded: 0, ignored: 1 })
  })

  it('an application ad_account change by the account it names; permissions only for the business\'s own system user', async () => {
    const status = { object: 'application', entry: [{ id: APP, time: 1, changes: [{ field: 'ad_account', value: { id: ACT_B, account_status: 2, disable_reason: 1 } }] }] }
    await receiveMetaWebhook({ appId: APP, signers: [A, B], users: [A, B], body: status })
    expect(h.rows.map((r) => r.ws)).toEqual(['ws-b'])
    expect(h.notices[0]).toMatchObject({ ws: 'ws-b', alert: { kind: 'meta-ads-account-status', severity: 'danger' } })
    const revoked = (user: string) => ({ object: 'permissions', entry: [{ id: user, time: 2, changes: [{ field: 'connected', value: { verb: 'disconnected' } }] }] })
    expect(await receiveMetaWebhook({ appId: APP, signers: [A, B], users: [A, B], body: revoked(USER_A) })).toMatchObject({ recorded: 1 })
    expect(await receiveMetaWebhook({ appId: APP, signers: [A, B], users: [A, B], body: revoked('120000000000099') })).toMatchObject({ recorded: 0, ignored: 1 })
  })

  it('an object Nexus does not route is ignored; a body that is not Meta\'s envelope is null', async () => {
    expect(await routeMetaChanges([A], [A], metaWebhookChanges({ object: 'user', entry: [{ id: USER_A, time: 1, changes: [{ field: 'photos', value: {} }] }] })!)).toEqual([null])
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: { hello: 'world' } })).toBeNull()
  })
})

describe('review F1 — notices of opposite states never hide each other', () => {
  it('an unread "active again" does not hide a later "disabled"', async () => {
    const status = (s: number, time: number) => ({ object: 'application', entry: [{ id: APP, time, changes: [{ field: 'ad_account', value: { id: ACT_A, account_status: s } }] }] })
    await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: status(1, 1) })
    await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: status(2, 2) })
    await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: status(2, 3) })
    expect(h.notices.map((n) => [n.alert.severity, n.alert.entityId])).toEqual([['info', `${ACT_A}~status~1`], ['danger', `${ACT_A}~status~2`]])
  })
})

describe('recording and settling', () => {
  it('Meta resending the same delivery adds a delivery and does nothing again', async () => {
    const body = { object: 'ad_account', entry: [issue(ACT_A)] }
    await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body })
    const again = await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body })
    expect(again).toMatchObject({ recorded: 0, duplicates: 1, handled: 0 })
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0].deliveries).toBe(2)
    expect(h.notices).toHaveLength(1)
    expect(h.rereads).toHaveLength(1)
  })

  it('review F5 — a 1000-update delivery: one batch per business, each distinct action once, answered well inside 4 s', async () => {
    const changes = Array.from({ length: 1000 }, (_, i) => ({ field: 'field_changed', value: { object_id: `1200000000${String(i).padStart(5, '0')}`, object_type: 'ad', changed_fields: ['effective_status'] } }))
    const started = Date.now()
    const out = await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: { object: 'ad_account', entry: [{ id: ACT_A, time: 1782862117, changes }] }, startedAt: started })
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(out).toMatchObject({ changes: 1000, recorded: 1000, handled: 1000, notRecorded: 0 })
    expect(h.batches).toEqual([{ ws: 'ws-a', size: 1000 }])
    expect(h.rereads).toEqual([{ ws: 'ws-a', adAccountId: ACT_A }])
    expect(h.rows.every((r) => r.status === 'done')).toBe(true)
  })

  it('topics Nexus only records are written done, keep no message text and run nothing', async () => {
    const body = { object: 'page', entry: [{ id: PAGE_A, time: 1458692752478, messaging: [{ sender: { id: '7000000000000001' }, recipient: { id: PAGE_A }, timestamp: 1, message: { mid: 'm1', text: 'my phone is …' } }] }] }
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body })).toMatchObject({ recorded: 1, handled: 0 })
    expect(h.rows[0]).toMatchObject({ eventType: 'page.messages', status: 'done', payload: { value: { timestamp: 1, message: { mid: 'm1' } } } })
    expect(JSON.stringify(h.rows[0])).not.toMatch(/phone|7000000000000001/)
  })

  it('a change the ledger cannot take is counted, so the delivery is answered 503', async () => {
    h.ledgerDown = true
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: { object: 'ad_account', entry: [issue(ACT_A)] } })).toMatchObject({ notRecorded: 1, recorded: 0 })
  })

  it('past the answer budget, recorded changes stay due for the retry sweep; a re-read the queue refused is a failure to retry', async () => {
    expect(await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: { object: 'ad_account', entry: [issue(ACT_A)] }, startedAt: Date.now() - 60_000 })).toMatchObject({ recorded: 1, handled: 0, later: 1 })
    expect(h.rows[0].status).toBe('pending')
    h.reread = { queued: false, reason: 'The read queue did not answer.', retry: true }
    const out = await receiveMetaWebhook({ appId: APP, signers: [A], users: [A], body: { object: 'ad_account', entry: [issue(ACT_A, '120000000000999')] } })
    expect(out).toMatchObject({ failed: 1, handled: 0 })
    expect(h.rows[1].status).toBe('failed')
  })
})

describe('the handler (retry sweep, replay)', () => {
  const stored = (over: Record<string, unknown> = {}) => ({ appId: APP, object: 'ad_account', entryId: ACT_A, field: 'with_issues_ad_objects', time: 1, value: { id: '120000000000301', level: 'AD' }, ...over })
  const inA = <T>(work: () => Promise<T>) => { h.ws = 'ws-a'; return work().finally(() => { h.ws = null }) }

  it('the replay registry loads this handler for every topic it acts on', async () => {
    const { inboundHandlerFor } = await import('../../cx/ingress/handlers.js')
    const { META_HANDLED_TOPICS } = await import('./webhook-topics.js')
    expect(META_HANDLED_TOPICS.length).toBeGreaterThan(20)
    for (const topic of META_HANDLED_TOPICS) expect(await inboundHandlerFor('META', topic)).toBe(handleMetaWebhookEvent)
  })

  it('does nothing for a change no longer this business\'s (the link was let go before a replay)', async () => {
    h.links = []
    await inA(() => handleMetaWebhookEvent(stored(), { connectionId: 'conn-a', eventType: 'ad_account.with_issues_ad_objects', channel: 'META' }))
    expect(h.notices).toEqual([])
    expect(h.rereads).toEqual([])
  })

  it('a queue that did not answer fails the attempt (the ledger retries); a queue switched off does not', async () => {
    const inProcess = stored({ field: 'in_process_ad_objects', value: { id: '1', level: 'AD', status_name: 'Active' } })
    h.reread = { queued: false, reason: 'The read queue did not answer.', retry: true }
    await expect(inA(() => handleMetaWebhookEvent(inProcess, { connectionId: 'conn-a', eventType: 'ad_account.in_process_ad_objects', channel: 'META' }))).rejects.toThrow(/not queued/)
    h.reread = { queued: false, reason: 'Queue workers are off in this process.', retry: false }
    await expect(inA(() => handleMetaWebhookEvent(inProcess, { connectionId: 'conn-a', eventType: 'ad_account.in_process_ad_objects', channel: 'META' }))).resolves.toBeUndefined()
  })

  it('refuses a row with no connection or no readable change; a record-only topic does nothing', async () => {
    await expect(inA(() => handleMetaWebhookEvent(stored(), { connectionId: null, eventType: 'x', channel: 'META' }))).rejects.toThrow(/no connected account/)
    await expect(inA(() => handleMetaWebhookEvent({ nope: true }, { connectionId: 'conn-a', eventType: 'x', channel: 'META' }))).rejects.toThrow(/no readable change/)
    await inA(() => handleMetaWebhookEvent(stored({ object: 'page', entryId: PAGE_A, field: 'feed' }), { connectionId: 'conn-a', eventType: 'page.feed', channel: 'META' }))
    expect(h.notices).toEqual([])
  })

  it('review F3 on replay — an app-level change runs only while the connection uses the app AND it is the one business using it', async () => {
    const devAlert = stored({ object: 'application', entryId: APP, field: 'dev_alerts', value: { notification_id: '1', header: 'Rate limit' } })
    // conn-a and conn-b both use APP: nothing.
    await inA(() => handleMetaWebhookEvent(devAlert, { connectionId: 'conn-a', eventType: 'application.dev_alerts', channel: 'META' }))
    expect(h.notices).toHaveLength(0)
    h.routes = h.routes.filter((r) => r.connectionId !== 'conn-b')
    forgetMetaAppIds()
    await inA(() => handleMetaWebhookEvent(devAlert, { connectionId: 'conn-a', eventType: 'application.dev_alerts', channel: 'META' }))
    expect(h.notices).toHaveLength(1)
    h.unread.clear()
    h.apps['conn-a'].appId = '5550000000000'
    forgetMetaAppIds()
    await inA(() => handleMetaWebhookEvent(devAlert, { connectionId: 'conn-a', eventType: 'application.dev_alerts', channel: 'META' }))
    expect(h.notices).toHaveLength(1)
  })
})
