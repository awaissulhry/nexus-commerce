/**
 * Reviews PR I — the review app connection: the API token is stored encrypted and NEVER comes back (not in a connect
 * answer, a list, a disconnect, a state's words or a log line); connect validates in words; disconnect wipes the token;
 * a read stores the reviews and marks a refused token; a reply goes to Judge.me with the decrypted token only.
 * The database and the cipher are stubbed in memory; Judge.me is a fake fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOKEN = 'jm-private-token-0123456789'
const db = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, logs: [] as unknown[], ingested: [] as unknown[] }))

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
      review: { findMany: async () => [], update: async () => ({}) },
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
  ingestRawReviews: async (raws: unknown[]) => {
    db.ingested.push(...raws)
    return { reviewsInserted: raws.length, errors: [] }
  },
}))

const svc = await import('./review-app-connection.service.js')
const NOW = new Date('2026-10-27T12:00:00Z')

beforeEach(() => {
  // Nothing may reach Judge.me from a test: every fetch is refused unless a test fakes the answers.
  vi.stubGlobal('fetch', async () => { throw new Error('network disabled in tests') })
  db.rows = []
  db.logs = []
  db.ingested = []
  delete process.env.NEXUS_ENABLE_REVIEW_APP_READ
})

const leaks = (value: unknown) => {
  const text = JSON.stringify(value)
  return text.includes(TOKEN) || text.includes('v1:sealed:')
}

describe('connecting', () => {
  it('validates in words, and never echoes the token', () => {
    expect(svc.validateJudgemeConnect({ shopDomain: 'shop.example.com', apiToken: TOKEN })).toMatchObject({ ok: false, error: 'invalid_shop_domain' })
    const bad = svc.validateJudgemeConnect({ shopDomain: 'a-store.myshopify.com', apiToken: 'x y' })
    expect(bad).toMatchObject({ ok: false, error: 'invalid_token' })
    expect(leaks(svc.validateJudgemeConnect({ shopDomain: 'nope', apiToken: TOKEN }))).toBe(false)
  })

  it('stores the token encrypted and answers without it; the list and the logs never carry it', async () => {
    const res = await svc.connectJudgeme({ shopDomain: 'A-Store.myshopify.com', apiToken: ` ${TOKEN} ` }, 'user-1', NOW)
    expect(res.ok).toBe(true)
    expect(leaks(res)).toBe(false)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ app: 'JUDGEME', shopDomain: 'a-store.myshopify.com', state: 'CONNECTED', createdBy: 'user-1', credentialsKeyId: 'env' })
    expect(String(db.rows[0].credentials)).not.toContain(TOKEN)
    const list = await svc.listReviewApps(NOW)
    expect(leaks(list)).toBe(false)
    expect(list.apps.map((a) => [a.app, a.state])).toEqual([['JUDGEME', 'waiting'], ['OKENDO', 'later'], ['YOTPO', 'later'], ['LOOX', 'later']])
    expect(JSON.stringify(db.logs)).not.toContain(TOKEN)
  })

  it('a second connect replaces the token on the same row', async () => {
    await svc.connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    await svc.connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: `${TOKEN}-2` }, 'user-2', NOW)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ updatedBy: 'user-2', state: 'CONNECTED' })
  })

  it('disconnect wipes the token; the state says so; replies are held', async () => {
    await svc.connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    const res = await svc.disconnectReviewApp('judgeme', 'user-1', NOW)
    expect(res).toMatchObject({ ok: true, app: { state: 'disconnected' } })
    expect(db.rows[0]).toMatchObject({ credentials: null, credentialsKeyId: null, state: 'DISCONNECTED' })
    expect(await svc.judgemeConnected()).toBe(false)
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
  it('the other apps are coming later', () => {
    expect(svc.reviewAppView('YOTPO', null, { readOn: true, now: NOW })).toMatchObject({ state: 'later', stateWords: 'Coming later', connectable: false })
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
    await svc.connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    const sent: Array<{ url: string; init: RequestInit }> = []
    fetchOf([], sent)
    expect(await svc.readReviewAppsOnce()).toMatchObject({ enabled: false, apps: 0 })
    expect(sent).toHaveLength(0)
  })

  it('on: reads with the decrypted token, stores new reviews, stamps the read', async () => {
    process.env.NEXUS_ENABLE_REVIEW_APP_READ = '1'
    await svc.connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
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
    await svc.connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    fetchOf([{ status: 401 }])
    await svc.readReviewAppsOnce({ now: () => NOW })
    expect(db.rows[0]).toMatchObject({ state: 'NEEDS_FIX' })
    expect(String(db.rows[0].lastError)).toMatch(/refused the API token/)
    expect(String(db.rows[0].lastError)).not.toContain(TOKEN)
  })

  it('a reply goes to Judge.me for that review; without a connection nothing is sent', async () => {
    expect(await svc.sendJudgemeReply('77001', 'Thanks')).toMatchObject({ ok: false, code: 'JUDGEME_NOT_CONNECTED' })
    await svc.connectJudgeme({ shopDomain: 'a-store.myshopify.com', apiToken: TOKEN }, 'user-1', NOW)
    const sent: Array<{ url: string; init: RequestInit }> = []
    fetchOf([{ status: 200 }], sent)
    expect(await svc.sendJudgemeReply('77001', 'Thanks')).toEqual({ ok: true, code: 'JUDGEME_200' })
    expect(sent[0].url).toBe('https://api.judge.me/api/v1/replies?shop_domain=a-store.myshopify.com')
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ review_id: 77001, reply: { content: 'Thanks' } })
    expect(JSON.stringify(db.logs)).not.toContain(TOKEN)
  })
})
