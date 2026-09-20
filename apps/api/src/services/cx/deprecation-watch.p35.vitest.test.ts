/**
 * P3.5 — *a fixture with the header raises one alert.*
 *
 * 🔶 Every fixture here is **SHAPE**, and deliberately labelled. `OutboundApiCallLog`
 * stores no response headers, so this installation holds no observed deprecation
 * notice from any channel. The values come from RFC 8594 (`Sunset`), RFC 9745
 * (`Deprecation`) and Shopify's own documentation
 * (`X-Shopify-API-Deprecated-Reason`).
 *
 * A fixture that looks measured and is not is how a wrong belief survives, so this is
 * said here rather than left for a reader to work out.
 *
 * The tests that matter most are the ones about NOT crying wolf:
 *  - `Deprecation`'s date is when it BECAME deprecated, usually in the past, and must
 *    never be shown as the shutdown date;
 *  - `Deprecation: false` is the channel saying the opposite of a notice;
 *  - one deprecated endpoint answering 26,838 times is ONE alert.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { deprecationOf } from './deprecation-readings.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const WS = 'nexus_legacy_workspace'
const OWNER = 'user-owner-p35'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inWs = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)

const h = (entries: Record<string, string>) => new Headers(entries)

describe('P3.5 — reading the headers (pure)', () => {
  it('returns null when the channel said nothing — the common case', () => {
    expect(deprecationOf(h({}))).toBeNull()
    expect(deprecationOf(h({ 'content-type': 'application/json' }))).toBeNull()
  })

  describe('Sunset — RFC 8594 (🔶 SHAPE)', () => {
    it('reads the shutdown date', () => {
      const n = deprecationOf(h({ sunset: 'Sat, 31 Dec 2026 23:59:59 GMT' }))
      expect(n?.deprecated).toBe(true)
      expect(n?.sunsetAt).toBe('2026-12-31T23:59:59.000Z')
      expect(n?.via).toBe('sunset')
    })

    it('counts on its own — RFC 8594 does not require a Deprecation header', () => {
      expect(deprecationOf(h({ sunset: 'Sat, 31 Dec 2026 23:59:59 GMT' }))).not.toBeNull()
    })

    it('keeps an unparseable date as the channel wrote it rather than dropping it', () => {
      // Showing nothing would be worse than showing the channel's own odd string: the
      // operator can still act on "whatever eBay said", and cannot act on a blank.
      const n = deprecationOf(h({ sunset: 'next Tuesday-ish' }))
      expect(n?.sunsetAt).toBe('next Tuesday-ish')
    })
  })

  describe('Deprecation — RFC 9745 (🔶 SHAPE)', () => {
    it('reads the bare true', () => {
      const n = deprecationOf(h({ deprecation: 'true' }))
      expect(n?.deprecated).toBe(true)
      expect(n?.sunsetAt).toBeNull()
      expect(n?.via).toBe('deprecation')
    })

    it('reads the structured-field ?1', () => {
      expect(deprecationOf(h({ deprecation: '?1' }))?.deprecated).toBe(true)
    })

    it('🔴 does NOT use its date as the shutdown date', () => {
      // @1688169599 is 2023-07-01 — the day it BECAME deprecated. Reading it as the
      // sunset would tell an operator their integration died three years ago.
      const n = deprecationOf(h({ deprecation: '@1688169599' }))
      expect(n?.deprecated).toBe(true)
      expect(n?.sunsetAt).toBeNull()
    })

    it('🔴 believes an explicit false and raises nothing', () => {
      expect(deprecationOf(h({ deprecation: 'false' }))).toBeNull()
      expect(deprecationOf(h({ deprecation: '?0' }))).toBeNull()
    })

    it('still reports a Sunset that arrives beside a false Deprecation', () => {
      // Contradictory, and the shutdown date is the one that costs money.
      const n = deprecationOf(h({ deprecation: 'false', sunset: 'Sat, 31 Dec 2026 23:59:59 GMT' }))
      expect(n?.sunsetAt).toBe('2026-12-31T23:59:59.000Z')
      expect(n?.via).toBe('sunset')
    })
  })

  describe('Shopify — X-Shopify-API-Deprecated-Reason (🔶 SHAPE, vendor-documented)', () => {
    it('reads the reason and carries the channel’s own words', () => {
      const n = deprecationOf(h({ 'x-shopify-api-deprecated-reason': 'https://shopify.dev/api/usage/versioning' }))
      expect(n?.deprecated).toBe(true)
      expect(n?.reason).toBe('https://shopify.dev/api/usage/versioning')
      expect(n?.via).toBe('shopify')
    })
  })

  it('reports both headers together when both arrive', () => {
    const n = deprecationOf(h({ deprecation: 'true', sunset: 'Sat, 31 Dec 2026 23:59:59 GMT' }))
    expect(n?.via).toBe('sunset+deprecation')
    expect(n?.sunsetAt).toBe('2026-12-31T23:59:59.000Z')
  })
})

describe('P3.5 — the watch raises ONE alert', () => {
  let watch: typeof import('./deprecation-watch.service.js')
  const q = (sql: string, params: unknown[] = []) => database.db.query(sql, params)

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    watch = await import('./deprecation-watch.service.js')
    await q(`INSERT INTO "UserProfile" (id, email, "displayName", status, "updatedAt")
             VALUES ($1,'owner-p35@test.local','Owner','active',CURRENT_TIMESTAMP)`, [OWNER])
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt")
             VALUES ($1,'This business','active',$2,'p35',CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [WS, OWNER])
    await q(`INSERT INTO "Role" (id, key, name, permissions, "updatedAt")
             VALUES ('role-owner-p35','OWNER','Owner',ARRAY[]::text[],CURRENT_TIMESTAMP) ON CONFLICT (key) DO NOTHING`)
    const roleId = (await q<{ id: string }>(`SELECT id FROM "Role" WHERE key = 'OWNER' LIMIT 1`)).rows[0].id
    await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt")
             VALUES ('m-owner-p35',$1,$2,'active',CURRENT_TIMESTAMP)`, [WS, OWNER])
    await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId", "roleId") VALUES ('m-owner-p35',$1)`, [roleId])
  }, 120_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  beforeEach(async () => {
    await q(`DELETE FROM "Notification"`)
    watch.resetDeprecationWatch()
  })

  const notices = async () =>
    (await q<{ title: string; body: string; severity: string; entityId: string; meta: Record<string, unknown> }>(
      `SELECT title, body, severity, "entityId", meta FROM "Notification" WHERE type = 'channel-deprecation'`)).rows

  it('the done-when: a fixture with the header raises one alert', async () => {
    const r = await inWs(() => watch.watchForDeprecation({
      channel: 'EBAY',
      endpoint: 'api.ebay.com/sell/inventory/v1/offer',
      headers: h({ sunset: 'Sat, 31 Dec 2026 23:59:59 GMT' }),
    }))
    expect(r.raised).toBe(true)
    const rows = await notices()
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toContain('stops working on 2026-12-31T23:59:59.000Z')
    expect(rows[0].body).toContain('Nexus still calls it')
    // The date is part of the identity — see the comment on deprecationAlert.
    expect(rows[0].entityId).toBe('EBAY:api.ebay.com/sell/inventory/v1/offer:2026-12-31T23:59:59.000Z')
  })

  it('raises nothing at all when no header is present', async () => {
    const r = await inWs(() => watch.watchForDeprecation({
      channel: 'EBAY', endpoint: '/sell/inventory/v1/offer', headers: h({ 'content-type': 'application/json' }),
    }))
    expect(r).toEqual({ notice: null, raised: false, quiet: false })
    expect(await notices()).toHaveLength(0)
  })

  it('🔴 one deprecated endpoint answering many times is ONE alert', async () => {
    const call = () => inWs(() => watch.watchForDeprecation({
      channel: 'AMAZON_ADS', endpoint: 'ads PUT /sp/keywords', headers: h({ deprecation: 'true' }),
    }))
    const results = []
    for (let i = 0; i < 51; i++) results.push(await call())

    // TWO guards, and they are not the same guard.
    //
    // The DATABASE dedupe (P3.4) is what makes this ONE notice, and it would hold even
    // with the in-process set removed — that is why a mutation that deletes the quiet
    // period does not fail this assertion.
    expect(await notices()).toHaveLength(1)

    // The in-process quiet period is what stops 51 calls doing 51 `Notification`
    // lookups per owner. It is an efficiency guard, and the honest way to assert an
    // efficiency guard is to count the WORK, not the outcome.
    expect(results.filter((r) => r.raised)).toHaveLength(1)
    expect(results.filter((r) => r.quiet)).toHaveLength(50)
  })

  it('reports the quiet period rather than pretending it raised one', async () => {
    const args = { channel: 'AMAZON_ADS', endpoint: 'ads PUT /sp/keywords', headers: h({ deprecation: 'true' }) }
    await inWs(() => watch.watchForDeprecation(args))
    const second = await inWs(() => watch.watchForDeprecation(args))
    expect(second).toMatchObject({ raised: false, quiet: true })
    expect(second.notice?.deprecated).toBe(true)
  })

  it('🔴 a MOVED sunset date is news, and gets through the quiet period', async () => {
    await inWs(() => watch.watchForDeprecation({
      channel: 'EBAY', endpoint: '/x', headers: h({ sunset: 'Sat, 31 Dec 2026 23:59:59 GMT' }),
    }))
    const moved = await inWs(() => watch.watchForDeprecation({
      channel: 'EBAY', endpoint: '/x', headers: h({ sunset: 'Wed, 30 Jun 2026 23:59:59 GMT' }),
    }))
    expect(moved.raised).toBe(true)
    const rows = await notices()
    expect(rows).toHaveLength(2)
    // Both dates are readable; the operator can see it moved EARLIER, which is the news.
    expect(rows.map((r) => r.body).join(' ')).toContain('2026-06-30')
    expect(rows.map((r) => r.body).join(' ')).toContain('2026-12-31')
  })

  it('keeps two endpoints on one channel apart', async () => {
    await inWs(() => watch.watchForDeprecation({ channel: 'EBAY', endpoint: '/a', headers: h({ deprecation: 'true' }) }))
    await inWs(() => watch.watchForDeprecation({ channel: 'EBAY', endpoint: '/b', headers: h({ deprecation: 'true' }) }))
    expect(await notices()).toHaveLength(2)
  })

  it('carries Shopify’s own explanation rather than replacing it with ours', async () => {
    await inWs(() => watch.watchForDeprecation({
      channel: 'SHOPIFY',
      endpoint: 'graphql.node',
      headers: h({ 'x-shopify-api-deprecated-reason': 'https://shopify.dev/api/usage/versioning' }),
    }))
    const rows = await notices()
    expect(rows[0].body).toContain('SHOPIFY says: https://shopify.dev/api/usage/versioning')
    expect(rows[0].meta).toMatchObject({ reason: 'https://shopify.dev/api/usage/versioning', via: 'shopify' })
  })

  it('says it has no date when the channel gave none, instead of inventing one', async () => {
    await inWs(() => watch.watchForDeprecation({ channel: 'EBAY', endpoint: '/y', headers: h({ deprecation: 'true' }) }))
    const rows = await notices()
    expect(rows[0].body).toContain('has not said when it stops working')
    expect(rows[0].severity).toBe('info')
  })

  it('escalates to warn once there IS a date', async () => {
    await inWs(() => watch.watchForDeprecation({
      channel: 'EBAY', endpoint: '/z', headers: h({ sunset: 'Sat, 31 Dec 2026 23:59:59 GMT' }),
    }))
    expect((await notices())[0].severity).toBe('warn')
  })

  it('does not grow its memory without limit', async () => {
    // Deliberately run OUTSIDE a business profile. `raiseChannelAlert` needs one, fails
    // fast without it and is swallowed by the watch — so the map is still filled 520
    // times while the database is touched zero times.
    //
    // The first version of this test ran all 520 inside a profile: ~1,040 queries for
    // an assertion about an in-memory Map. It passed alone and flaked under the full
    // profiles-ON suite, which is how the pre-push gate first saw this package. A test
    // should not need a database to prove a bound on a Map.
    for (let i = 0; i < 520; i++) {
      await watch.watchForDeprecation({ channel: 'EBAY', endpoint: `/p${i}`, headers: h({ deprecation: 'true' }) })
    }
    expect(watch.deprecationWatchSize()).toBeLessThanOrEqual(500)
    expect(watch.deprecationWatchSize()).toBeGreaterThan(0) // control: it did fill
  })

  it('a malformed header fails the watch, never the call', async () => {
    const broken = { get: () => { throw new Error('boom') } } as unknown as Headers
    const r = await inWs(() => watch.watchForDeprecation({ channel: 'EBAY', endpoint: '/q', headers: broken }))
    expect(r).toEqual({ notice: null, raised: false, quiet: false })
  })
})
