/**
 * Reviews PR I (+ Okendo, Yotpo, Loox 2026-10-28) — the review app connections: a secret is stored encrypted and NEVER
 * comes back (not in a connect answer, a list, a disconnect, a state's words or a log line); connect validates each
 * app's fields in words; disconnect wipes the secret; a read stores every connected app's reviews and marks a refused
 * key; a reply goes to Judge.me or Okendo with the decrypted key only, never to Yotpo or Loox.
 * The database and the cipher are stubbed in memory; every app is a fake fetch (nothing leaves the machine).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOKEN = 'jm-private-token-0123456789'
const db = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, logs: [] as unknown[], ingested: [] as unknown[], ingestSources: [] as string[], stored: [] as unknown[] }))

vi.mock('../../db.js', () => {
  const pick = (row: Record<string, unknown>, select?: Record<string, unknown>) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row)
  const match = (row: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([k, v]) => row[k] === v)
  return {
    default: {
      reviewAppConnection: {
        findMany: async ({ select }: { select?: Record<string, unknown> } = {}) => db.rows.map((r) => pick(r, select)),
        findFirst: async ({ where, select }: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
          const row = db.rows.find((r) => match(r, where))
          return row ? pick(row, select) : null
        },
        create: async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, unknown> }) => {
          const row = { id: `conn-${db.rows.length + 1}`, state: 'CONNECTED', lastReadAt: null, lastReadCount: null, lastError: null, lastErrorAt: null, createdAt: new Date('2026-10-27T08:00:00Z'), ...data }
          db.rows.push(row)
          return pick(row, select)
        },
        update: async ({ where, data, select }: { where: { id: string }; data: Record<string, unknown>; select?: Record<string, unknown> }) => {
          const row = db.rows.find((r) => r.id === where.id)!
          Object.assign(row, data)
          return pick(row, select)
        },
      },
      review: { findMany: async () => db.stored, update: async () => ({}) },
      product: { findMany: async () => [] },
    },
  }
})
vi.mock('../../lib/crypto.js', () => ({
  encryptCredentials: async (obj: Record<string, unknown>) => ({ blob: `v1:sealed:${Buffer.from(JSON.stringify(obj)).toString('base64url')}`, keyId: 'env', mode: 'env' }),
  decryptCredentials: async (blob: string) => JSON.parse(Buffer.from(blob.slice('v1:sealed:'.length), 'base64url').toString('utf8')),
}))
vi.mock('../../utils/logger.js', () => {
  const push = (...args: unknown[]) => { db.logs.push(args) }
  return { logger: { info: push, warn: push, error: push, debug: push } }
})
vi.mock('./review-ingest.service.js', () => ({
  ingestRawReviews: async (raws: unknown[], opts: { ingestSource: string }) => {
    db.ingested.push(...raws)
    db.ingestSources.push(opts.ingestSource)
    return { reviewsInserted: raws.length, errors: [] }
  },
  // The photos of an edited review (real SQL: shop-review-media.vitest.test.ts).
  replaceReviewMedia: async () => false,
}))

const svc = await import('./review-app-connection.service.js')
const NOW = new Date('2026-10-27T12:00:00Z')

beforeEach(() => {
  // Nothing may reach Judge.me from a test: every fetch is refused unless a test fakes the answers.
  vi.stubGlobal('fetch', async () => { throw new Error('network disabled in tests') })
  db.rows = []
  db.logs = []
  db.ingested = []
  db.ingestSources = []
  db.stored = []
  delete process.env.NEXUS_ENABLE_REVIEW_APP_READ
})

const leaks = (value: unknown) => {
  const text = JSON.stringify(value)
  return text.includes(TOKEN) || text.includes('v1:sealed:')
}
const connectJudgeme = (body: Record<string, unknown>, actor: string, now: Date) => svc.connectReviewApp('judgeme', body, actor, now)
const OKENDO_USER = '0f9d5e1a-1111-4a2b-9c3d-2e4f6a8b0c1d'

describe('connecting', () => {
  it('validates in words, and never echoes the token', () => {
    expect(svc.validateReviewAppConnect('JUDGEME', { shopDomain: 'shop.example.com', apiToken: TOKEN })).toMatchObject({ ok: false, error: 'invalid_shop_domain' })
    const bad = svc.validateReviewAppConnect('JUDGEME', { shopDomain: 'a-store.myshopify.com', apiToken: 'x y' })
    expect(bad).toMatchObject({ ok: false, error: 'invalid_token' })
    expect(leaks(svc.validateReviewAppConnect('JUDGEME', { shopDomain: 'nope', apiToken: TOKEN }))).toBe(false)
  })

  it('stores the token encrypted and answers without it; the list and the logs never carry it', async () => {
    const res = await connectJudgeme({ shopDomain: 'A-Store.myshopify.com', apiToken: ` ${TOKEN} ` }, 'user-1', NOW)
    expect(res.ok).toBe(true)
    expect(leaks(res)).toBe(false)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ app: 'JUDGEME', shopDomain: 'a-store.myshopify.com', state: 'CONNECTED', createdBy: 'user-1', credentialsKeyId: 'env' })
    expect(String(db.rows[0].credentials)).not.toContain(TOKEN)
    const list = await svc.listReviewApps(NOW)
    expect(leaks(list)).toBe(false)
    expect(list.apps.map((a) => [a.app, a.state])).toEqual([['JUDGEME', 'waiting'], ['OKENDO', 'not_connected'], ['YOTPO', 'not_connected'], ['LOOX', 'not_connected']])
    expect(JSON.stringify(db.logs)).not.toContain(TOKEN)
  })

  it('a second connect replaces the token on the same row', async () => {
    await connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    await connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: `${TOKEN}-2` }, 'user-2', NOW)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ updatedBy: 'user-2', state: 'CONNECTED' })
  })

  it('Okendo, Yotpo and Loox: each app’s fields, checked in words; the secret stored encrypted, the store id kept plain', async () => {
    expect(svc.validateReviewAppConnect('OKENDO', { userId: 'not-a-uuid', apiKey: TOKEN })).toMatchObject({ ok: false, error: 'invalid_store_id' })
    expect(svc.validateReviewAppConnect('OKENDO', { userId: OKENDO_USER, apiKey: 'short' })).toMatchObject({ ok: false, error: 'invalid_token' })
    expect(svc.validateReviewAppConnect('YOTPO', { storeId: 'bad id/../x', apiSecret: TOKEN })).toMatchObject({ ok: false, error: 'invalid_store_id' })
    expect(leaks(svc.validateReviewAppConnect('LOOX', { storeId: '??', apiKey: TOKEN }))).toBe(false)
    expect(await svc.connectReviewApp('okendo', { userId: OKENDO_USER.toUpperCase(), apiKey: TOKEN }, 'user-1', NOW)).toMatchObject({ ok: true, app: { app: 'OKENDO', state: 'waiting', storeId: OKENDO_USER } })
    expect(await svc.connectReviewApp('YOTPO', { storeId: 'AbCdEf0123456789', apiSecret: TOKEN }, 'user-1', NOW)).toMatchObject({ ok: true, app: { app: 'YOTPO' } })
    expect(await svc.connectReviewApp('loox', { storeId: '4JG3Fn92E.37d12ab29', apiKey: TOKEN }, 'user-1', NOW)).toMatchObject({ ok: true, app: { app: 'LOOX' } })
    expect(await svc.connectReviewApp('stamped', { storeId: 'x', apiKey: TOKEN }, 'user-1', NOW)).toMatchObject({ ok: false, status: 404 })
    expect(db.rows.map((r) => [r.app, r.shopDomain])).toEqual([['OKENDO', OKENDO_USER], ['YOTPO', 'AbCdEf0123456789'], ['LOOX', '4JG3Fn92E.37d12ab29']])
    for (const r of db.rows) expect(String(r.credentials)).not.toContain(TOKEN)
    const list = await svc.listReviewApps(NOW)
    expect(leaks(list)).toBe(false)
    expect(JSON.stringify(db.logs)).not.toContain(TOKEN)
  })

  it('disconnect wipes the token; the state says so; replies are held', async () => {
    await connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    const res = await svc.disconnectReviewApp('judgeme', 'user-1', NOW)
    expect(res).toMatchObject({ ok: true, app: { state: 'disconnected' } })
    expect(db.rows[0]).toMatchObject({ credentials: null, credentialsKeyId: null, state: 'DISCONNECTED' })
    expect(await svc.reviewAppConnected('JUDGEME')).toBe(false)
    expect(await svc.disconnectReviewApp('nope', 'user-1', NOW)).toMatchObject({ ok: false, status: 404 })
  })
})

describe('the state in words', () => {
  const row = (over: Partial<import('./review-app-connection.service.js').ReviewAppRow> = {}) => ({
    app: 'JUDGEME', shopDomain: 'a-store.myshopify.com', state: 'CONNECTED', hasCredentials: true, lastReadAt: new Date('2026-10-27T11:48:00Z'),
    lastReadCount: 318, lastError: null, lastErrorAt: null, createdAt: new Date('2026-10-20T08:00:00Z'), ...over,
  })
  it('connected and read: last read 12 min ago', () => {
    expect(svc.reviewAppView('JUDGEME', row(), { readOn: true, now: NOW })).toMatchObject({ state: 'connected', tone: 'success', canReply: true, words: 'Read every 30 min · last read 12 min ago (318 reviews).' })
  })
  it('a refused token needs a fix; reading switched off says so without naming a setting', () => {
    expect(svc.reviewAppView('JUDGEME', row({ state: 'NEEDS_FIX', lastError: 'Judge.me refused the API token or the shop domain (HTTP 401).' }), { readOn: true, now: NOW }))
      .toMatchObject({ state: 'needs_fix', tone: 'danger', canReply: false })
    const off = svc.reviewAppView('JUDGEME', row(), { readOn: false, now: NOW })
    expect(off).toMatchObject({ state: 'waiting', canReply: true })
    expect(off.words).not.toMatch(/[A-Z]+_[A-Z_]+/)
  })
  it('no app is "coming later": each asks for what it needs and says which plan its API needs', () => {
    const views = (['JUDGEME', 'OKENDO', 'YOTPO', 'LOOX'] as const).map((app) => svc.reviewAppView(app, null, { readOn: true, now: NOW }))
    expect(views.map((v) => v.state)).toEqual(['not_connected', 'not_connected', 'not_connected', 'not_connected'])
    expect(JSON.stringify(views)).not.toMatch(/later/i)
    expect(views.map((v) => v.fields.map((f) => [f.key, f.secret]))).toEqual([
      [['shopDomain', false], ['apiToken', true]],
      [['userId', false], ['apiKey', true]],
      [['storeId', false], ['apiSecret', true]],
      [['storeId', false], ['apiKey', true]],
    ])
    expect(views.map((v) => v.replies)).toEqual([true, true, false, false])
    expect(views[2].planWords).toMatch(/Premium plan.*export the reviews as a CSV file in Yotpo and import the file here/)
    expect(views[3].planWords).toMatch(/Convert and Unlimited plans/)
    expect(views[2].replyHref).toBe('https://reviews.yotpo.com/#/moderation/reviews')
    expect(views[0].replyHref).toBeNull()
  })
  it('a read-only app connected never offers a reply from Nexus', () => {
    expect(svc.reviewAppView('LOOX', row({ app: 'LOOX', shopDomain: 'aBcDeF123.4567' }), { readOn: true, now: NOW })).toMatchObject({ state: 'connected', canReply: false, storeWords: 'Store ID aBcDeF123.4567' })
  })
})

describe('reading and replying', () => {
  const jm = (id: number) => ({ id, rating: 4, body: 'Good', created_at: '2026-10-25T10:00:00Z', reviewer: { name: 'A. Buyer', email: 'b@example.com' } })
  /** Judge.me, faked: the global fetch answers from the list (nothing leaves the machine). */
  const fetchOf = (answers: Array<{ status: number; body?: unknown }>, sent: Array<{ url: string; init: RequestInit }> = []) =>
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url, init })
      const a = answers.shift()
      if (!a) throw new Error('no answer configured')
      return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status })
    })

  it('off: nothing is read', async () => {
    await connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    const sent: Array<{ url: string; init: RequestInit }> = []
    fetchOf([], sent)
    expect(await svc.readReviewAppsOnce()).toMatchObject({ enabled: false, apps: 0 })
    expect(sent).toHaveLength(0)
  })

  it('on: reads with the decrypted token, stores new reviews, stamps the read', async () => {
    process.env.NEXUS_ENABLE_REVIEW_APP_READ = '1'
    await connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    const sent: Array<{ url: string; init: RequestInit }> = []
    fetchOf([{ status: 200, body: { per_page: 100, reviews: [jm(1), jm(2)] } }], sent)
    const summary = await svc.readReviewAppsOnce({ now: () => NOW })
    expect(summary).toMatchObject({ enabled: true, apps: 1, seen: 2, inserted: 2 })
    expect((sent[0].init.headers as Record<string, string>)['X-Api-Token']).toBe(TOKEN)
    expect(db.ingested).toHaveLength(2)
    expect(JSON.stringify(db.ingested)).not.toContain('b@example.com')
    expect(db.rows[0]).toMatchObject({ lastReadAt: NOW, lastReadCount: 2, lastError: null, state: 'CONNECTED' })
  })

  it('on: a refused token marks the connection as needing a fix, in words without the token', async () => {
    process.env.NEXUS_ENABLE_REVIEW_APP_READ = '1'
    await connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    fetchOf([{ status: 401 }])
    await svc.readReviewAppsOnce({ now: () => NOW })
    expect(db.rows[0]).toMatchObject({ state: 'NEEDS_FIX' })
    expect(String(db.rows[0].lastError)).toMatch(/refused the API token/)
    expect(String(db.rows[0].lastError)).not.toContain(TOKEN)
  })

  it('a reply goes to Judge.me for that review; without a connection nothing is sent', async () => {
    expect(await svc.sendReviewAppReply('JUDGEME', '77001', 'Thanks')).toMatchObject({ ok: false, code: 'JUDGEME_NOT_CONNECTED' })
    await connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    const sent: Array<{ url: string; init: RequestInit }> = []
    fetchOf([{ status: 200 }], sent)
    expect(await svc.sendReviewAppReply('JUDGEME', '77001', 'Thanks')).toEqual({ ok: true, code: 'JUDGEME_200' })
    expect(sent[0].url).toBe('https://api.judge.me/api/v1/replies?shop_domain=a-store.myshopify.com')
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ review_id: 77001, reply: { content: 'Thanks' } })
    expect(JSON.stringify(db.logs)).not.toContain(TOKEN)
  })

  it('every connected app is read in turn, each with its own key; one failing app does not stop the others', async () => {
    process.env.NEXUS_ENABLE_REVIEW_APP_READ = '1'
    await connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    await svc.connectReviewApp('OKENDO', { userId: OKENDO_USER, apiKey: `${TOKEN}-ok` }, 'user-1', NOW)
    await svc.connectReviewApp('LOOX', { storeId: '4JG3Fn92E.37d12ab29', apiKey: `${TOKEN}-lx` }, 'user-1', NOW)
    const sent: Array<{ url: string; init: RequestInit }> = []
    fetchOf([
      { status: 200, body: { per_page: 100, reviews: [jm(1)] } },
      { status: 401, body: { error: 'nope' } },
      { status: 200, body: { reviews: [{ id: '64a1f2b3c4d5e6f7a8b9c0d1', rating: 5, body: 'Great', createdAt: '2026-10-20T08:30:00.000Z', status: 'published', reviewer: { name: 'J. D.', email: 'j@example.com' } }], pagination: { hasMore: false } } },
      { status: 200, body: { reviews: [], pagination: { hasMore: false } } },
    ], sent)
    const summary = await svc.readReviewAppsOnce({ now: () => NOW })
    expect(summary).toMatchObject({ enabled: true, apps: 3, seen: 2, inserted: 2 })
    expect(summary.results.map((r) => [r.app, r.error == null])).toEqual([['JUDGEME', true], ['OKENDO', false], ['LOOX', true]])
    expect(db.ingestSources).toEqual(['JUDGEME_API', 'LOOX_API'])
    expect(db.ingested.map((r) => (r as { externalReviewId: string }).externalReviewId)).toEqual(['1', 'loox:64a1f2b3c4d5e6f7a8b9c0d1'])
    expect(JSON.stringify(db.ingested)).not.toContain('j@example.com')
    expect(sent[1].url).toBe('https://api.okendo.io/enterprise/reviews?limit=100&orderBy=date+desc&status=approved')
    expect((sent[1].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${OKENDO_USER}:${TOKEN}-ok`).toString('base64')}`)
    expect((sent[2].init.headers as Record<string, string>)['X-Api-Secret-Key']).toBe(`${TOKEN}-lx`)
    expect(db.rows.find((r) => r.app === 'OKENDO')).toMatchObject({ state: 'NEEDS_FIX' })
    expect(String(db.rows.find((r) => r.app === 'OKENDO')!.lastError)).toMatch(/^Okendo refused the User ID or the API key \(HTTP 401\)/)
    expect(svc.summarizeReviewAppRead(summary)).toMatch(/^Judge\.me: 1 read, 1 new, 0 updated; Okendo: not read \(Okendo refused/)
    expect(JSON.stringify(db.logs)).not.toContain(TOKEN)
  })

  it('a reply goes to Okendo for its review (Okendo’s own id); Yotpo and Loox are never sent one', async () => {
    await svc.connectReviewApp('OKENDO', { userId: OKENDO_USER, apiKey: TOKEN }, 'user-1', NOW)
    await svc.connectReviewApp('YOTPO', { storeId: 'AbCdEf0123456789', apiSecret: TOKEN }, 'user-1', NOW)
    const sent: Array<{ url: string; init: RequestInit }> = []
    fetchOf([{ status: 200, body: {} }], sent)
    const reviewId = '3f2c9a8e-5b1d-4c7e-9a6f-1d2e3f4a5b6c'
    expect(await svc.sendReviewAppReply('OKENDO', `okendo:${reviewId}`, 'Thank you!')).toEqual({ ok: true, code: 'OKENDO_200' })
    expect(sent[0].url).toBe(`https://api.okendo.io/enterprise/reviews/${reviewId}/reply`)
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ reply: { body: 'Thank you!', isPrivate: false }, shouldEmailReply: true })
    expect(await svc.sendReviewAppReply('OKENDO', '77001', 'Thanks')).toMatchObject({ ok: false, code: 'OKENDO_NOT_SENT' })
    expect(await svc.sendReviewAppReply('YOTPO', 'yotpo:1', 'Thanks')).toMatchObject({ ok: false, code: 'YOTPO_NO_REPLY' })
    expect(sent).toHaveLength(1)
    fetchOf([{ status: 401 }])
    expect(await svc.sendReviewAppReply('OKENDO', `okendo:${reviewId}`, 'Again')).toMatchObject({ ok: false, code: 'OKENDO_401', refusedKey: true })
    expect(db.rows.find((r) => r.app === 'OKENDO')).toMatchObject({ state: 'NEEDS_FIX' })
  })
})

describe('an edited review', () => {
  const stored = { rating: 4, title: null, body: 'Good', rawPayload: { source: 'yotpo', photos: [{ url: 'https://p/1.jpg', thumb: 'https://p/1s.jpg' }], hasVideo: false, updatedAt: '2026-10-20T00:00:00.000Z', storeReply: null } }
  const raw = (over: Record<string, unknown>) => ({ raw: { externalReviewId: 'yotpo:1', channel: 'SHOPIFY', body: 'Good', rating: 4, postedAt: '2026-10-19T00:00:00.000Z', rawPayload: { ...stored.rawPayload, ...over } } })
  it('nothing changed: nothing written; a reply that appeared in the app is a change', () => {
    expect(svc.appReviewChanges(stored, raw({}))).toBeNull()
    expect(svc.appReviewChanges(stored, raw({ storeReply: 'Thanks!' }))).toMatchObject({ rawPayload: { storeReply: 'Thanks!' } })
  })
  it('a read that did not look at the photos keeps the ones Nexus holds', () => {
    expect(svc.appReviewChanges(stored, raw({ photos: [], mediaKnown: false }))).toBeNull()
    const edited = svc.appReviewChanges(stored, raw({ photos: [], mediaKnown: false, updatedAt: '2026-10-27T00:00:00.000Z' }))
    expect(edited?.rawPayload).toEqual({ ...stored.rawPayload, updatedAt: '2026-10-27T00:00:00.000Z' })
  })
})
