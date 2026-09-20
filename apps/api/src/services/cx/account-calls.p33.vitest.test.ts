/**
 * P3.3 — one account's calls, headroom and last error, on a real PostgreSQL with the
 * generated schema and the real profile policies.
 *
 * The rows are shaped on what is actually in `OutboundApiCallLog`: Shopify carries a
 * real `rateLimitRemaining` (48 of 48 stored Shopify calls do), eBay carries none
 * (0 of 345), and P3.1's `errorClass` / `errorCode` / `errorMessage` are what a failure
 * leaves behind.
 *
 * Three of these tests are about NOT lying:
 *  - a success rate over zero calls is null, never 100%;
 *  - unknown headroom says WHY, in the channel's terms, never a blank;
 *  - a window is never another account's.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const LEGACY = 'nexus_legacy_workspace'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inLegacy = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY, actorUserId: null, membershipId: null, roleKeys: [] }, work)

const NOW = new Date('2026-09-20T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

describe('P3.3 — one account’s calls, headroom and last error', () => {
  let svc: typeof import('./account-calls.service.js')
  const q = (sql: string, params: unknown[] = []) => database.db.query(sql, params)

  const call = async (o: {
    id: string; conn: string; channel: string; op: string; ok: boolean; at: Date
    status?: number | null; cls?: string | null; code?: string | null; msg?: string | null
    remaining?: number | null; limit?: number | null
  }) => q(
    `INSERT INTO "OutboundApiCallLog"
       ("workspaceId", id, channel, operation, method, endpoint, success, "statusCode",
        "connectionId", "errorClass", "errorCode", "errorMessage",
        "rateLimitRemaining", "rateLimitLimit", "latencyMs", "createdAt")
     VALUES ($1,$2,$3,$4,'POST','https://example.test/x',$5,$6,$7,$8,$9,$10,$11,$12,120,$13)`,
    [LEGACY, o.id, o.channel, o.op, o.ok, o.status ?? (o.ok ? 200 : 400), o.conn,
     o.cls ?? null, o.code ?? null, o.msg ?? null, o.remaining ?? null, o.limit ?? null, o.at],
  )

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    svc = await import('./account-calls.service.js')
    await q(`INSERT INTO "ChannelConnection" ("workspaceId", id, "channelType", "isActive", "isPrimary", "authStatus", "updatedAt") VALUES
      ($1,'shop-A','SHOPIFY',true,true,'connected',CURRENT_TIMESTAMP),
      ($1,'ebay-A','EBAY',true,true,'connected',CURRENT_TIMESTAMP),
      ($1,'ebay-B','EBAY',true,false,'connected',CURRENT_TIMESTAMP),
      ($1,'quiet-A','ETSY',true,true,'connected',CURRENT_TIMESTAMP)`, [LEGACY])

    // Shopify: three good calls, the newest carrying a real headroom reading.
    await call({ id: 'c1', conn: 'shop-A', channel: 'SHOPIFY', op: 'graphql.node', ok: true, at: ago(30), remaining: 1990, limit: 2000 })
    await call({ id: 'c2', conn: 'shop-A', channel: 'SHOPIFY', op: 'graphql.node', ok: true, at: ago(20), remaining: 1963, limit: 2000 })
    // The newest Shopify call is an operation that reports nothing — headroom must fall
    // back to the last call that DID report, not go blank.
    await call({ id: 'c3', conn: 'shop-A', channel: 'SHOPIFY', op: 'rest.shop', ok: true, at: ago(5) })

    // eBay A: two failures, the newer one the "last error".
    await call({ id: 'e1', conn: 'ebay-A', channel: 'EBAY', op: 'trading.ReviseFixedPriceItem', ok: false, at: ago(90), status: 400, cls: 'validation', code: '21916584', msg: 'Invalid value for the aspect Brand.' })
    await call({ id: 'e2', conn: 'ebay-A', channel: 'EBAY', op: 'trading.AddFixedPriceItem', ok: true, at: ago(60) })
    await call({ id: 'e3', conn: 'ebay-A', channel: 'EBAY', op: 'trading.AddFixedPriceItem', ok: false, at: ago(10), status: 500, cls: 'transient', code: '21916', msg: 'Internal error. Please try again.' })

    // eBay B: a different account, so none of its rows may appear under A.
    await call({ id: 'b1', conn: 'ebay-B', channel: 'EBAY', op: 'trading.AddFixedPriceItem', ok: false, at: ago(15), status: 400, cls: 'validation', code: '99999', msg: 'B’s own error.' })

    // Outside the window.
    await call({ id: 'old', conn: 'shop-A', channel: 'SHOPIFY', op: 'graphql.node', ok: false, at: ago(60 * 40), status: 500, cls: 'transient', msg: 'Ancient.' })
  }, 120_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  const view = (connectionId: string, channel: string, hours = 24) =>
    inLegacy(() => svc.accountCallsView({
      connectionId, channel, until: NOW, since: new Date(NOW.getTime() - hours * 3_600_000),
    }))

  describe('the call ledger, per account', () => {
    it('counts only this account’s calls', async () => {
      const v = await view('ebay-A', 'EBAY')
      expect(v.summary.total).toBe(3)
      expect(v.summary.failed).toBe(2)
      expect(v.recent.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'e3'])
    })

    it('never shows another account’s error', async () => {
      const v = await view('ebay-A', 'EBAY')
      expect(v.recent.some((r) => r.id === 'b1')).toBe(false)
      expect(v.lastError?.errorCode).not.toBe('99999')
    })

    it('leaves out calls older than the window', async () => {
      const v = await view('shop-A', 'SHOPIFY')
      expect(v.recent.some((r) => r.id === 'old')).toBe(false)
      expect(v.summary.total).toBe(3)
    })

    it('widens with the window', async () => {
      const v = await view('shop-A', 'SHOPIFY', 24 * 7)
      expect(v.summary.total).toBe(4)
      expect(v.summary.failed).toBe(1)
    })
  })

  describe('the last error, in the channel’s own words', () => {
    it('is the most recent failure, with P3.1’s fields', async () => {
      const v = await view('ebay-A', 'EBAY')
      expect(v.lastError?.id).toBe('e3')
      expect(v.lastError?.errorClass).toBe('transient')
      expect(v.lastError?.errorCode).toBe('21916')
      expect(v.lastError?.errorMessage).toBe('Internal error. Please try again.')
      expect(v.lastError?.operation).toBe('trading.AddFixedPriceItem')
    })

    it('is null — not an empty object — when the account has had none', async () => {
      const v = await view('quiet-A', 'ETSY')
      expect(v.lastError).toBeNull()
    })
  })

  describe('rate headroom — and saying why when there is none', () => {
    it('reads Shopify’s real numbers', async () => {
      const v = await view('shop-A', 'SHOPIFY')
      expect(v.rateHeadroom.state).toBe('known')
      expect(v.rateHeadroom.remaining).toBe(1963)
      expect(v.rateHeadroom.limit).toBe(2000)
      expect(v.rateHeadroom.note).toContain('1963 of 2000')
    })

    it('falls back to the last call that REPORTED, not the last call', async () => {
      // c3 is newer than c2 and carries no reading. Reading "the latest call" would
      // show unknown for an account Shopify is answering perfectly.
      const v = await view('shop-A', 'SHOPIFY')
      expect(v.rateHeadroom.asOf?.toISOString()).toBe(ago(20).toISOString())
    })

    it('tells the operator WHY eBay has no number, rather than showing a blank', async () => {
      const v = await view('ebay-A', 'EBAY')
      expect(v.rateHeadroom.state).toBe('not_reported_per_call')
      expect(v.rateHeadroom.remaining).toBeNull()
      expect(v.rateHeadroom.note).toMatch(/does not report its quota on a call/i)
    })

    it('distinguishes "no calls yet" from "the channel does not say"', async () => {
      // Etsy IS in the not-reported list, so it must give that reason even when quiet —
      // the reason is a property of the channel, not of how busy the account is.
      const v = await view('quiet-A', 'ETSY')
      expect(v.rateHeadroom.state).toBe('not_reported_per_call')
      expect(v.rateHeadroom.note).toMatch(/429/)
    })

    it('every state carries a sentence', async () => {
      for (const [id, ch] of [['shop-A', 'SHOPIFY'], ['ebay-A', 'EBAY'], ['quiet-A', 'ETSY']] as const) {
        const v = await view(id, ch)
        expect(v.rateHeadroom.note.length).toBeGreaterThan(10)
      }
    })
  })

  describe('the honesty rules', () => {
    it('a success rate over zero calls is null, not 100%', async () => {
      const v = await view('quiet-A', 'ETSY')
      expect(v.summary.total).toBe(0)
      expect(v.summary.successRate).toBeNull()
    })

    it('a real success rate is a real percentage', async () => {
      const v = await view('ebay-A', 'EBAY')
      expect(v.summary.successRate).toBeCloseTo(33.3, 1)
    })

    it('reportsHeadroomPerCall is derived from the same list the note is', async () => {
      expect(svc.reportsHeadroomPerCall('SHOPIFY')).toBe(true)
      expect(svc.reportsHeadroomPerCall('EBAY')).toBe(false)
      expect(svc.reportsHeadroomPerCall('ETSY')).toBe(false)
    })
  })

  describe('the window a caller asked for', () => {
    it('takes a good number', () => {
      expect(svc.windowHours('6')).toBe(6)
      expect(svc.windowHours(48)).toBe(48)
    })

    it('falls back to the default rather than ZERO', () => {
      // A zero-hour window answers "no calls, no errors" for an account failing every
      // minute. Every one of these means "the caller did not say".
      for (const bad of [undefined, null, '', 'abc', '0', 0, -3, NaN]) {
        expect(svc.windowHours(bad)).toBe(svc.DEFAULT_WINDOW_HOURS)
      }
    })

    it('caps a silly window instead of scanning the whole table', () => {
      expect(svc.windowHours(99999)).toBe(svc.MAX_WINDOW_HOURS)
    })
  })

  describe('accountCallsById — the shape a route needs', () => {
    it('finds the connection and answers for it', async () => {
      const v = await inLegacy(() => svc.accountCallsById('ebay-A', { hours: 24 }))
      expect(v?.channel).toBe('EBAY')
      expect(v?.connectionId).toBe('ebay-A')
      expect(v?.summary.total).toBe(3)
    })

    it('returns null for a connection that does not exist, so the route can 404', async () => {
      expect(await inLegacy(() => svc.accountCallsById('no-such-account'))).toBeNull()
    })

    it('applies the window rule to a bad ?hours= rather than answering over zero hours', async () => {
      const v = await inLegacy(() => svc.accountCallsById('ebay-A', { hours: 'abc' }))
      // 24h back from NOW-ish still contains all three of ebay-A's calls.
      expect(v?.summary.total).toBe(3)
    })
  })
})
