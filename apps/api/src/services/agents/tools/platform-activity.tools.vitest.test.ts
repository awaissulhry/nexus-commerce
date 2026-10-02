/**
 * MCP full control P6 — the platform activity reads (alerts-inbox, audit-trail, sync-activity, ai-usage), run through
 * the one door (call-tool.ts) against a real PostgreSQL with the production schema and business-isolation policies
 * (PGlite). No mocked query.
 *
 * Proven here: each tool is refused without its permission and for a wrongly made call; every source and kind reads
 * the seeded rows; lists page with nextCursor and refuse a changed cursor; the audit trail never shows an IP address,
 * a secret, a person's e-mail or a security row (sign-in, user, session, password reset, invitation, API keys), and a
 * money key INSIDE an audit row's before/after is stripped by the door for a person who may not see money and kept for
 * one who may; sync activity never hands out a payload or a credential; AI usage shows calls and tokens, and its cost
 * only to a person who may see ad spend. The suite runs with business profiles off and on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})

// No Redis in this suite: the registry's other tools import the queue module.
vi.mock('../../../lib/queue.js', () => ({
  redis: null, outboundSyncQueue: null, channelSyncQueue: null, readCacheQueue: null, readinessQueue: null, searchIndexQueue: null,
  bulkJobQueue: null, adsSyncQueue: null, queueEvents: null, channelSyncQueueEvents: null, addJobSafely: vi.fn(),
  getRedisRuntimeStatus: () => ({ configured: false, status: 'off' }),
}))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'

const A = LEGACY_WORKSPACE_ID
const B = 'ws_p6_activity_bravo'
const ON = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

const ALL_FEATURES = Object.values(FEATURES)
function principal(permissions: string[], workspaceId = A): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-p6',
    label: 'P6 test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    // Profiles off: no business on the principal, as the door gets it then.
    ...(ON || workspaceId !== A ? { workspace: business(workspaceId) } : {}),
    via: 'claude',
  }
}
const cleared = (workspaceId = A) => principal([...ALL_FEATURES, ...Object.values(FIELDS)], workspaceId)
const operator = () => principal(ALL_FEATURES)
const without = (permission: string) => principal([...ALL_FEATURES, ...Object.values(FIELDS)].filter((p) => p !== permission))

type Answer = { ok: boolean; error?: string; data?: any }
async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = cleared()): Promise<Answer> {
  return (await callTool(who, tool, args)).visible as Answer
}
async function refusal(tool: string, args: Record<string, unknown>, who: UserPrincipal = cleared()) {
  try {
    await callTool(who, tool, args)
    return null
  } catch (error) {
    if (error instanceof ToolAccessError) return error.code
    throw error
  }
}

const NOW = Date.now()
const ago = (minutes: number) => new Date(NOW - minutes * 60_000)

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  const owner = await db.userProfile.create({ data: { email: 'p6-owner@example.test', status: 'active', displayName: 'Audit Person' } })
  await db.workspace.create({ data: { id: B, name: 'P6 bravo', createdByUserId: owner.id, creationKey: 'p6-bravo' } })
  await inside(A, async () => {
    const product = await db.product.create({ data: { sku: 'TEST-SKU-P6', name: 'P6 jacket', basePrice: '19.90', costPrice: '4.20', totalStock: 3 } })
    // Sync activity: a failed and a dead queue row whose payload must never come back.
    await db.outboundSyncQueue.create({ data: { productId: product.id, targetChannel: 'EBAY', syncStatus: 'FAILED', syncType: 'PRICE_UPDATE', retryCount: 2, payload: { price: 10, note: 'PAYLOAD-MARK' }, errorMessage: 'refused: Bearer abcdefgh.ijklmnop', createdAt: ago(30) } })
    await db.outboundSyncQueue.create({ data: { productId: product.id, targetChannel: 'AMAZON', syncStatus: 'FAILED', syncType: 'QUANTITY_UPDATE', isDead: true, payload: { note: 'PAYLOAD-MARK' }, createdAt: ago(60) } })
    for (const [i, op] of ['getItem', 'reviseItem', 'getOrders'].entries()) {
      await db.outboundApiCallLog.create({
        data: {
          channel: 'EBAY', operation: op, success: false, statusCode: 500, latencyMs: 300 + i, errorType: 'SERVER',
          errorMessage: `failed with token v^1.1#i^1#SECRETTOKEN${i}`, requestPayload: { token: 'REQ-PAYLOAD-MARK' },
          responsePayload: { body: 'RES-PAYLOAD-MARK' }, traceId: `trace-${i}`, productId: product.id, createdAt: ago(10 + i),
        },
      })
    }
    await db.outboundApiCallLog.create({ data: { channel: 'EBAY', operation: 'okCall', success: true, statusCode: 200, latencyMs: 90, createdAt: ago(5) } })
    await db.webhookEvent.create({ data: { channel: 'SHOPIFY', eventType: 'products/update', externalId: 'p6-hook-1', payload: { note: 'PAYLOAD-MARK' }, signature: 'SIGNATURE-MARK', error: 'handler failed', status: 'failed', createdAt: ago(20) } })
    await db.syncLogErrorGroup.create({ data: { fingerprint: 'p6-fp', channel: 'EBAY', operation: 'reviseItem', errorType: 'SERVER', sampleMessage: 'Server error for P6', count: 4, lastSeen: ago(3) } })
    // Alerts inbox: a triggered alert, an unread notification.
    const rule = await db.alertRule.create({ data: { name: 'P6 queue rule', metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: [] } })
    await db.alertEvent.create({ data: { ruleId: rule.id, value: 250, triggeredAt: ago(15) } })
    await db.notification.create({ data: { userId: owner.id, type: 'order', severity: 'danger', title: 'P6 order stuck', createdAt: ago(12) } })
    // Audit trail: a product change with money and secrets inside, security rows that must stay hidden, and an old row.
    await db.auditLog.create({
      data: {
        userId: owner.id, ip: '10.9.8.7', entityType: 'Product', entityId: product.id, action: 'update',
        before: { name: 'P6 jacket', basePrice: 19.9, costPrice: 4.2, pricing: { landedCostPerUnitCents: 333 } },
        after: { name: 'P6 jacket v2', basePrice: 21.5, costPrice: 5.1, pricing: { landedCostPerUnitCents: 444 } },
        metadata: { refreshToken: 'TOKEN-MARK', contactEmail: 'buyer-mark@example.test', note: 'mail me at someone@example.test' },
        createdAt: ago(40),
      },
    })
    for (let i = 0; i < 3; i++) {
      await db.auditLog.create({ data: { entityType: 'ChannelListing', entityId: `listing-${i}`, action: 'publish', after: { title: `Title ${i}` }, createdAt: ago(50 + i) } })
    }
    await db.auditLog.create({ data: { userId: owner.id, ip: '10.9.8.7', entityType: 'Auth', entityId: owner.id, action: 'login.success', metadata: { source: 'auth', userAgent: 'AGENT-MARK' }, createdAt: ago(41) } })
    await db.auditLog.create({ data: { entityType: 'Settings', entityId: 'api-keys', action: 'create', after: { label: 'APIKEY-MARK' }, createdAt: ago(42) } })
    await db.auditLog.create({ data: { entityType: 'Settings', entityId: 'company', action: 'update', before: { companyName: 'Old Co' }, after: { companyName: 'New Co' }, createdAt: ago(43) } })
    await db.auditLog.create({ data: { entityType: 'Product', entityId: product.id, action: 'create', createdAt: new Date(NOW - 60 * 86_400_000) } })
    // AI usage: two calls of one feature, one failed.
    await db.aiUsageLog.create({ data: { provider: 'anthropic', model: 'model-a', feature: 'listing-content', inputTokens: 1000, outputTokens: 200, costUSD: '0.123456', createdAt: ago(100) } })
    await db.aiUsageLog.create({ data: { provider: 'anthropic', model: 'model-a', feature: 'listing-content', inputTokens: 500, outputTokens: 0, costUSD: '0.010000', ok: false, errorMessage: 'rate limited', createdAt: ago(90) } })
    await db.aiUsageLog.create({ data: { provider: 'gemini', model: 'model-b', feature: 'alt-text', inputTokens: 10, outputTokens: 5, costUSD: '0.000500', createdAt: new Date(NOW - 45 * 86_400_000) } })
  })
  // Business B: rows that must never reach A.
  await inside(B, async () => {
    const rule = await db.alertRule.create({ data: { name: 'BRAVO rule', metric: 'queueDepth', operator: 'gt', threshold: 1, notificationChannels: [] } })
    await db.alertEvent.create({ data: { ruleId: rule.id, value: 9 } })
    await db.auditLog.create({ data: { entityType: 'Product', entityId: 'bravo-product', action: 'update', after: { name: 'BRAVO name' } } })
    await db.outboundApiCallLog.create({ data: { channel: 'EBAY', operation: 'BRAVO-op', success: false, latencyMs: 1 } })
    await db.aiUsageLog.create({ data: { provider: 'anthropic', model: 'model-a', feature: 'BRAVO-feature', costUSD: '1' } })
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('P6 — the door holds for every activity read', () => {
  it('each tool is refused without its permission', async () => {
    expect(await refusal('alerts-inbox', {}, without(FEATURES.adminView))).toBe('forbidden')
    expect(await refusal('audit-trail', {}, without(FEATURES.auditView))).toBe('forbidden')
    expect(await refusal('sync-activity', { kind: 'queue' }, without(FEATURES.adminView))).toBe('forbidden')
    expect(await refusal('ai-usage', {}, without(FEATURES.aiUsageView))).toBe('forbidden')
  })

  it('a wrongly made call is refused before the tool runs', async () => {
    expect(await refusal('alerts-inbox', { source: 'email' })).toBe('invalid_arguments')
    expect(await refusal('audit-trail', { days: 400 })).toBe('invalid_arguments')
    expect(await refusal('sync-activity', { kind: 'payloads' })).toBe('invalid_arguments')
    expect(await refusal('sync-activity', {})).toBe('invalid_arguments')
    expect(await refusal('ai-usage', { days: 91 })).toBe('invalid_arguments')
    expect(await refusal('audit-trail', { limit: 101 })).toBe('invalid_arguments')
  })
})

describe('P6 — alerts-inbox', () => {
  it('reads every source, newest-worst first, with counts by severity', async () => {
    const answer = await call('alerts-inbox', {})
    expect(answer.ok, answer.error).toBe(true)
    const sources = new Set(answer.data.items.map((item: any) => item.source))
    expect([...sources].sort()).toEqual(['alert', 'notification', 'sync', 'webhook'])
    expect(answer.data.counts).toMatchObject({ total: expect.any(Number), bySeverity: { critical: expect.any(Number) } })
    expect(JSON.stringify(answer)).toContain('P6 queue rule')
    expect(JSON.stringify(answer)).not.toContain('BRAVO')
    expect(answer.data.alertRules.map((rule: any) => rule.name)).toEqual(['P6 queue rule'])
  })

  it('one source and one severity; pages follow nextCursor; a changed cursor is refused', async () => {
    const alerts = await call('alerts-inbox', { source: 'alert' })
    expect(alerts.data.items.every((item: any) => item.source === 'alert')).toBe(true)
    const first = await call('alerts-inbox', { limit: 2 })
    expect(first.data.items).toHaveLength(2)
    expect(first.data.nextCursor).toEqual(expect.any(String))
    const second = await call('alerts-inbox', { limit: 2, cursor: first.data.nextCursor })
    expect(second.ok).toBe(true)
    const keys = [...first.data.items, ...second.data.items].map((item: any) => item.key)
    expect(new Set(keys).size).toBe(keys.length)
    const other = await call('alerts-inbox', { limit: 2, source: 'sync', cursor: first.data.nextCursor })
    expect(other).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
    const critical = await call('alerts-inbox', { severity: 'critical' })
    expect(critical.data.items.every((item: any) => item.severity === 'critical')).toBe(true)
  })

  it('never hands out a credential from an error message', async () => {
    const text = JSON.stringify(await call('alerts-inbox', { source: 'sync' }))
    expect(text).not.toContain('abcdefgh.ijklmnop')
    expect(text).not.toContain('PAYLOAD-MARK')
  })
})

describe('P6 — audit-trail', () => {
  it('shows who did what, without IP addresses, secrets, e-mails or security rows', async () => {
    const answer = await call('audit-trail', {})
    expect(answer.ok, answer.error).toBe(true)
    const text = JSON.stringify(answer)
    expect(text).toContain('Audit Person')
    expect(text).toContain('New Co')
    for (const mark of ['10.9.8.7', 'TOKEN-MARK', 'buyer-mark', 'someone@example.test', 'AGENT-MARK', 'APIKEY-MARK', 'login.success', 'BRAVO', 'p6-owner@example.test']) {
      expect(text, mark).not.toContain(mark)
    }
    const product = answer.data.items.find((item: any) => item.entityType === 'Product' && item.action === 'update')
    expect(product.who).toBe('Audit Person')
    expect(product.metadata.refreshToken).toBe('[hidden]')
    expect(product.metadata.note).toBe('mail me at s***@example.test')
    // The old row is outside the default 30 days; a 365-day window reaches it.
    expect(answer.data.items.some((item: any) => item.action === 'create' && item.entityType === 'Product')).toBe(false)
    const year = await call('audit-trail', { days: 365, entityType: 'Product' })
    expect(year.data.items.map((item: any) => item.action).sort()).toEqual(['create', 'update'])
  })

  it('money inside before/after: stripped by the door for a person without money, kept with it', async () => {
    const full = await call('audit-trail', { entityType: 'Product', action: 'update' })
    expect(full.data.items[0].before).toMatchObject({ basePrice: 19.9, costPrice: 4.2, pricing: { landedCostPerUnitCents: 333 } })
    const partial = await call('audit-trail', { entityType: 'Product', action: 'update' }, operator())
    const row = partial.data.items[0]
    expect(row.before).toEqual({ name: 'P6 jacket', basePrice: 19.9, pricing: {} })
    expect(row.after).toEqual({ name: 'P6 jacket v2', basePrice: 21.5, pricing: {} })
    expect(JSON.stringify(partial)).not.toContain('444')
  })

  it('filters by entity id; pages follow nextCursor', async () => {
    const one = await call('audit-trail', { entityId: 'listing-1' })
    expect(one.data.items).toHaveLength(1)
    const first = await call('audit-trail', { entityType: 'ChannelListing', limit: 2 })
    expect(first.data.items).toHaveLength(2)
    const second = await call('audit-trail', { entityType: 'ChannelListing', limit: 2, cursor: first.data.nextCursor })
    expect(second.data.items).toHaveLength(1)
    expect(second.data.nextCursor).toBeNull()
    expect(await call('audit-trail', { entityType: 'Product', limit: 2, cursor: first.data.nextCursor })).toMatchObject({ ok: false })
  })

  it('a hidden row is not reachable by naming it', async () => {
    const auth = await call('audit-trail', { entityType: 'Auth' })
    expect(auth.data.items).toEqual([])
    const keys = await call('audit-trail', { entityType: 'Settings' })
    expect(keys.data.items.map((item: any) => item.entityId)).toEqual(['company'])
  })
})

describe('P6 — sync-activity', () => {
  it('queue: the waiting and failed rows, with stats; dead rows on their own tab; never a payload', async () => {
    const queue = await call('sync-activity', { kind: 'queue' })
    expect(queue.ok, queue.error).toBe(true)
    expect(queue.data.items.map((item: any) => item.sku)).toEqual(['TEST-SKU-P6'])
    expect(queue.data.totals).toMatchObject({ failed: 1, dead: 1 })
    const dead = await call('sync-activity', { kind: 'queue', tab: 'dead' })
    expect(dead.data.items.map((item: any) => item.channel)).toEqual(['AMAZON'])
    const text = JSON.stringify([queue, dead])
    expect(text).not.toContain('PAYLOAD-MARK')
    expect(text).not.toContain('abcdefgh.ijklmnop')
  })

  it('failed-calls: failed channel calls only, newest first, paged, without payloads or tokens', async () => {
    const first = await call('sync-activity', { kind: 'failed-calls', limit: 2 })
    expect(first.data.items.map((item: any) => item.operation)).toEqual(['getItem', 'reviseItem'])
    const second = await call('sync-activity', { kind: 'failed-calls', limit: 2, cursor: first.data.nextCursor })
    expect(second.data.items.map((item: any) => item.operation)).toEqual(['getOrders'])
    const text = JSON.stringify([first, second])
    for (const mark of ['REQ-PAYLOAD-MARK', 'RES-PAYLOAD-MARK', 'SECRETTOKEN', 'okCall', 'BRAVO']) expect(text, mark).not.toContain(mark)
    expect(first.data.items[0].traceId).toBe('trace-0')
  })

  it('webhooks and error groups', async () => {
    const hooks = await call('sync-activity', { kind: 'webhooks', channel: 'SHOPIFY' })
    expect(hooks.data.items.map((item: any) => item.eventType)).toEqual(['products/update'])
    expect(JSON.stringify(hooks)).not.toMatch(/PAYLOAD-MARK|SIGNATURE-MARK/)
    const groups = await call('sync-activity', { kind: 'error-groups' })
    expect(groups.data.items).toMatchObject([{ operation: 'reviseItem', count: 4, sampleMessage: 'Server error for P6' }])
  })
})

describe('P6 — ai-usage', () => {
  it('calls, tokens and failures by feature and model; cost only for a person who may see it', async () => {
    const full = await call('ai-usage', {})
    expect(full.ok, full.error).toBe(true)
    expect(full.data.byFeature).toEqual([
      expect.objectContaining({ name: 'listing-content', calls: 2, inputTokens: 1500, outputTokens: 200, costUSD: 0.133456 }),
    ])
    expect(full.data.byModel).toEqual([expect.objectContaining({ provider: 'anthropic', model: 'model-a', calls: 2, failed: 1 })])
    expect(full.data.totals).toMatchObject({ calls: 2, failed: 1 })
    expect(JSON.stringify(full)).not.toContain('BRAVO')
    const partial = await call('ai-usage', {}, operator())
    expect(JSON.stringify(partial)).not.toContain('costUSD')
    expect(partial.data.byFeature[0]).toMatchObject({ name: 'listing-content', calls: 2 })
    const wider = await call('ai-usage', { days: 60 })
    expect(wider.data.byFeature.map((row: any) => row.name).sort()).toEqual(['alt-text', 'listing-content'])
  })
})

describe('P6 — business isolation (profiles on)', () => {
  it.runIf(ON)('business B reads its own rows and none of A', async () => {
    const inbox = JSON.stringify(await call('alerts-inbox', {}, cleared(B)))
    expect(inbox).toContain('BRAVO rule')
    expect(inbox).not.toContain('P6 queue rule')
    const audit = JSON.stringify(await call('audit-trail', {}, cleared(B)))
    expect(audit).toContain('BRAVO name')
    expect(audit).not.toContain('Audit Person')
  })
})
