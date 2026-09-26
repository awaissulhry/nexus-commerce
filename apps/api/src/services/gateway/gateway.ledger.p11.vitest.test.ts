/**
 * P1.1 "done when": the call ledger shows account, operation, time and headroom.
 *
 * Real disposable PostgreSQL (the generated schema + the real profile policies) and the real gateway,
 * account lookup and ledger writer. Only the channel (`fetch`) and the token are stand-ins. The rows are
 * read back from the table, not from what the writer was handed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'tok') }))

const LEGACY = 'nexus_legacy_workspace'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inLegacy = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe('P1.1 — the ledger row, read back from the table', () => {
  let gateway: typeof import('./gateway.js')

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    ;(await import('./rate.js')).__rateTest.useMemory()
    gateway = await import('./gateway.js')
    await database.db.query(`INSERT INTO "ChannelConnection" ("workspaceId", id, "channelType", "externalAccountId", "isActive", "authStatus", "displayName", "updatedAt")
      VALUES ($1, 'shop-live', 'SHOPIFY', 'fixture-shop-live', true, 'connected', 'Shop', CURRENT_TIMESTAMP), ($1, 'shop-stale', 'SHOPIFY', 'fixture-shop-stale', true, 'needs_reauth', 'Old shop', CURRENT_TIMESTAMP)`, [LEGACY])
  }, 120_000)
  afterAll(async () => {
    vi.unstubAllGlobals()
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  const rows = () => database.db.query<Record<string, any>>(`SELECT * FROM "OutboundApiCallLog" ORDER BY "createdAt", id`).then((r) => r.rows)

  it('a sent call: account, operation, time, status, headroom, attempts, version, profile — no body on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { shop: { name: 'x' } }, extensions: { cost: { throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1950, restoreRate: 100 } } } }), { status: 200 })))
    const res = await inLegacy(() => gateway.gatewayCall({ channel: 'SHOPIFY', operation: 'shop.read', kind: 'read', connectionId: 'shop-live', url: 'https://x.myshopify.com/admin/api/2026-07/graphql.json?secret=1', method: 'POST', body: '{"query":"{shop{name}}"}' }))
    expect(res.ok).toBe(true)
    const [row] = await rows()
    expect(row).toMatchObject({
      workspaceId: LEGACY, channel: 'SHOPIFY', connectionId: 'shop-live', operation: 'shop.read', method: 'POST',
      endpoint: 'x.myshopify.com/admin/api/2026-07/graphql.json', statusCode: 200, success: true, outcome: 'sent',
      rateLimitRemaining: 1950, rateLimitLimit: 2000, attempts: 1, apiVersion: '2026-07', errorClass: null,
      requestPayload: null, responsePayload: null,
    })
    expect(row.latencyMs).toBeGreaterThanOrEqual(0)
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  it('a held call (account needs sign-in): a row with outcome held, and the channel was never called', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(inLegacy(() => gateway.gatewayCall({ channel: 'SHOPIFY', operation: 'shop.read', kind: 'read', connectionId: 'shop-stale', url: 'https://x.myshopify.com/admin/api/2026-07/graphql.json', method: 'POST', body: '{}' })))
      .rejects.toMatchObject({ outcome: 'held', code: 'ACCOUNT_NEEDS_SIGNIN' })
    expect(fetchSpy).not.toHaveBeenCalled()
    const held = (await rows()).at(-1)
    expect(held).toMatchObject({ connectionId: 'shop-stale', outcome: 'held', success: false, statusCode: null, errorCode: 'ACCOUNT_NEEDS_SIGNIN', workspaceId: LEGACY })
  })

  it('P1.2 — a gateway call inside an old recordApiCall wrapper: ONE row, with the wrapper\'s name and order link', async () => {
    const { recordApiCall } = await import('../outbound-api-call-log.service.js')
    const before = (await rows()).length
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { shop: { name: 'x' } } }), { status: 200 })))
    await inLegacy(() => recordApiCall({ channel: 'SHOPIFY', operation: 'orders.fetchOne', orderId: 'order-77' }, () =>
      gateway.gatewayCall({ channel: 'SHOPIFY', operation: 'POST /admin/api/2026-07/graphql', kind: 'read', connectionId: 'shop-live', url: 'https://x.myshopify.com/admin/api/2026-07/graphql.json', method: 'POST', body: '{}' })))
    const added = (await rows()).slice(before)
    expect(added).toEqual([expect.objectContaining({ operation: 'orders.fetchOne', orderId: 'order-77', outcome: 'sent', connectionId: 'shop-live' })])
    // control: the wrapper alone (no gateway call inside) still writes its own row
    await inLegacy(() => recordApiCall({ channel: 'SHOPIFY', operation: 'orders.noSend' }, async () => 'no send'))
    expect((await rows()).slice(before + 1)).toEqual([expect.objectContaining({ operation: 'orders.noSend', outcome: null })])
  })

  it('a failed call keeps its class and a SAFE body (no personal data, no secret)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }], customer: { email: 'a@b.c' } }), { status: 200 })))
    const res = await inLegacy(() => gateway.gatewayCall({ channel: 'SHOPIFY', operation: 'orders.read', kind: 'read', connectionId: 'shop-live', url: 'https://x.myshopify.com/admin/api/2026-07/graphql.json', method: 'POST', body: JSON.stringify({ query: 'q', variables: { email: 'buyer@example.com' }, access_token: 'shpat_x' }) }))
    expect(res.ok).toBe(false)
    const failed = (await rows()).at(-1)!
    expect(failed).toMatchObject({ success: false, statusCode: 200, errorClass: 'forbidden', errorType: 'AUTHENTICATION', errorCode: 'ACCESS_DENIED' })
    const stored = JSON.stringify([failed.requestPayload, failed.responsePayload])
    expect(stored).not.toMatch(/buyer@example\.com|a@b\.c|shpat_x/)
    expect(stored).toMatch(/Access denied/)
  })
})
