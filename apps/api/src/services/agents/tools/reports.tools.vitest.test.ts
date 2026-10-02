/**
 * MCP full control P6 — insights-report, run through the one door (call-tool.ts) against a real PostgreSQL with the
 * production schema and business-isolation policies (PGlite). No mocked query.
 *
 * Proven here: the tool is refused without insights.view and for a wrongly made call; every report answers; the
 * window is held to 365 days; the reports that are money from top to bottom (profit, fiscal, Amazon economics) are
 * refused to a person who may not see all money, and the customers report to a person who may not see customers; for
 * every other report a person without money permissions gets the same answer minus exactly the money (no money key,
 * no money value anywhere, money in sentences included); buyers are masked; the brief never calls an AI model; lists
 * hold to the limit. The suite runs with business profiles off and on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { RESTRICTED_FIELDS } from '../../../lib/auth/financial-fields.js'
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
// The brief must never reach a model: every generate() call is counted (and fails).
const providerCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../ai/providers/anthropic.provider.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    AnthropicProvider: class {
      isConfigured() { return true }
      async generate() {
        providerCalls.count++
        throw new Error('the brief must not call a model')
      }
    },
  }
})

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const ON = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

const ALL_FEATURES = Object.values(FEATURES)
function principal(permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-p6-reports',
    label: 'P6 reports',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    ...(ON ? { workspace: business(A) } : {}),
    via: 'claude',
  }
}
const cleared = () => principal([...ALL_FEATURES, ...Object.values(FIELDS)])
const operator = () => principal(ALL_FEATURES)
const without = (permission: string) => principal([...ALL_FEATURES, ...Object.values(FIELDS)].filter((p) => p !== permission))

type Answer = { ok: boolean; error?: string; data?: any }
async function report(name: string, args: Record<string, unknown> = {}, who: UserPrincipal = cleared()): Promise<Answer> {
  return (await callTool(who, 'insights-report', { report: name, ...args })).visible as Answer
}
async function refusal(args: Record<string, unknown>, who: UserPrincipal = cleared()) {
  try {
    await callTool(who, 'insights-report', args)
    return null
  } catch (error) {
    if (error instanceof ToolAccessError) return error.code
    throw error
  }
}

const REPORTS = ['summary', 'sales', 'profit', 'advertising', 'products', 'customers', 'inventory', 'fiscal', 'brief', 'forecast',
  'what-changed', 'top-skus', 'breakdown', 'amazon-economics', 'snapshot'] as const
const ALL_MONEY = new Set(['profit', 'fiscal', 'amazon-economics'])

/** Is this key money for this tool: the shared registry, or the tool's own restricted keys. */
const restricted = (key: string) => {
  const tool = getTool('insights-report')!
  return Object.prototype.hasOwnProperty.call(RESTRICTED_FIELDS, key) || Object.prototype.hasOwnProperty.call(tool.restrictedFields ?? {}, key)
}
/** Every key in a value, and every primitive under a money key. */
function walk(value: unknown) {
  const keys = new Set<string>()
  const money: string[] = []
  const visit = (v: unknown, underMoney: boolean) => {
    if (v == null) return
    if (typeof v !== 'object') {
      if (underMoney) money.push(String(v))
      return
    }
    for (const [key, child] of Object.entries(v)) {
      keys.add(key)
      visit(child, underMoney || restricted(key))
    }
  }
  visit(value, false)
  return { keys, money }
}

const DAY = 86_400_000
const now = Date.now()

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(A, async () => {
    for (const [channel, code] of [['AMAZON', 'IT'], ['EBAY', 'IT']] as const) {
      await db.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: `TEST_${channel}_${code}` } })
    }
    const p1 = await db.product.create({ data: { sku: 'TEST-SKU-R1', name: 'Report jacket', brand: 'TESTBRAND', basePrice: '19.90', costPrice: '4.20', totalStock: 6 } })
    await db.product.create({ data: { sku: 'TEST-SKU-R2', name: 'Report gloves', brand: 'TESTBRAND', basePrice: '9.90', costPrice: '2.10', totalStock: 0 } })
    const recent = new Date(now - DAY)
    await db.order.create({
      data: {
        channel: 'AMAZON', channelOrderId: 'TEST-ORDER-R1', marketplace: 'IT', currencyCode: 'EUR', totalPrice: '3000.03', status: 'SHIPPED',
        customerName: 'Maria Rossi', customerEmail: 'buyer-one@example.test', shippingAddress: { city: 'Milano', country: 'IT' }, purchaseDate: recent,
        items: { create: [{ sku: p1.sku, productId: p1.id, quantity: 3, price: '1000.01' }] },
      },
    })
    await db.order.create({
      data: {
        channel: 'EBAY', channelOrderId: 'TEST-ORDER-R2', marketplace: 'IT', currencyCode: 'EUR', totalPrice: '7.77', status: 'SHIPPED',
        customerName: 'Luca Bianchi', customerEmail: 'buyer-two@example.test', shippingAddress: { city: 'Roma', country: 'IT' }, purchaseDate: recent,
        items: { create: [{ sku: p1.sku, productId: p1.id, quantity: 1, price: '7.77' }] },
      },
    })
    const day = (at: number) => new Date(new Date(at).toISOString().slice(0, 10))
    await db.dailySalesAggregate.create({ data: { sku: p1.sku, channel: 'AMAZON', marketplace: 'IT', day: day(now - DAY), unitsSold: 3, grossRevenue: '3000.03', ordersCount: 1 } })
    await db.dailySalesAggregate.create({ data: { sku: p1.sku, channel: 'EBAY', marketplace: 'IT', day: day(now - DAY), unitsSold: 1, grossRevenue: '7.77', ordersCount: 1 } })
    await db.dailySalesAggregate.create({ data: { sku: p1.sku, channel: 'AMAZON', marketplace: 'IT', day: day(now - 40 * DAY), unitsSold: 1, grossRevenue: '1500.15', ordersCount: 1 } })
  })
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('P6 — insights-report: the door', () => {
  it('is refused without insights.view, and for a wrongly made call', async () => {
    expect(await refusal({ report: 'summary' }, without(FEATURES.insightsView))).toBe('forbidden')
    expect(await refusal({ report: 'nonsense' })).toBe('invalid_arguments')
    expect(await refusal({})).toBe('invalid_arguments')
    expect(await refusal({ report: 'summary', limit: 21 })).toBe('invalid_arguments')
    expect(await refusal({ report: 'summary', from: '15/09/2026' })).toBe('invalid_arguments')
  })

  it('holds the window to 365 days', async () => {
    const tooLong = await report('summary', { from: '2025-01-01', to: '2026-06-30' })
    expect(tooLong).toMatchObject({ ok: false, error: expect.stringContaining('365 days') })
    const backwards = await report('summary', { from: '2026-06-30', to: '2026-06-01' })
    expect(backwards).toMatchObject({ ok: false })
    const year = await report('summary', { from: '2025-10-01', to: '2026-09-30' })
    expect(year.ok, year.error).toBe(true)
  })
})

describe('P6 — insights-report: every report', () => {
  it('each report answers for a person who may see everything', async () => {
    const failed: string[] = []
    for (const name of REPORTS) {
      const answer = await report(name)
      if (!answer.ok) failed.push(`${name}: ${answer.error}`)
    }
    expect(failed).toEqual([])
  })

  it('summary: the headline numbers and the best-selling SKUs', async () => {
    const answer = await report('summary')
    expect(answer.data.report).toBe('summary')
    expect(answer.data.totals.orders.current).toBe(2)
    expect(answer.data.totals.revenue.current).toBeCloseTo(3007.8)
    expect(answer.data.topSkus.map((row: any) => row.sku)).toEqual(['TEST-SKU-R1'])
    expect(answer.data.topSkus[0]).toMatchObject({ productName: 'Report jacket', units: 4 })
  })

  it('the brief gives the facts to write from and never calls an AI model', async () => {
    const answer = await report('brief')
    expect(Object.keys(answer.data).sort()).toEqual(expect.arrayContaining(['advertising', 'anomalies', 'breakdown', 'summary', 'whatChanged']))
    expect(JSON.stringify(answer)).not.toMatch(/modelUsed|costUsd/)
    expect(providerCalls.count).toBe(0)
  })

  it('the snapshot reads today, 7, 30 or 90 days, and never says "now"', async () => {
    const answer = await report('snapshot', { window: '7d' })
    expect(answer.ok, answer.error).toBe(true)
    expect(JSON.stringify(answer)).not.toMatch(/lastUpdatedAt/)
    expect(answer.data.openOrders).toBeDefined()
    expect(await report('snapshot', { window: 'ytd' })).toMatchObject({ ok: false, error: expect.stringContaining('snapshot') })
  })

  it('lists hold to the limit', async () => {
    const answer = await report('top-skus', { limit: 1 })
    expect(answer.data.rows).toHaveLength(1)
  })
})

describe('P6 — insights-report: money and buyers', () => {
  it('profit, fiscal and Amazon economics are refused to a person who may not see all money', async () => {
    for (const name of ALL_MONEY) {
      const answer = await report(name, {}, operator())
      expect(answer, name).toMatchObject({ ok: false, error: expect.stringContaining('money') })
      expect((await report(name)).ok, name).toBe(true)
    }
  })

  it('the customers report needs customers.view, and masks buyers', async () => {
    expect(await report('customers', {}, without(FEATURES.customersView))).toMatchObject({ ok: false, error: expect.stringContaining('customers') })
    const text = JSON.stringify(await report('customers'))
    expect(text).not.toContain('buyer-one@example.test')
    expect(text).not.toContain('Rossi')
  })

  it('every other report: the same answer minus exactly the money', async () => {
    const problems: string[] = []
    for (const name of REPORTS.filter((r) => !ALL_MONEY.has(r))) {
      const full = await report(name)
      const partial = await report(name, {}, operator())
      if (!partial.ok) {
        problems.push(`${name}: refused (${partial.error})`)
        continue
      }
      const seen = walk(partial)
      const leakedKeys = [...seen.keys].filter(restricted)
      if (leakedKeys.length) problems.push(`${name}: returned ${leakedKeys.join(', ')}`)
      const text = JSON.stringify(partial)
      const leakedValues = walk(full).money.filter((v) => v.length >= 4 && v !== 'null' && text.includes(v))
      if (leakedValues.length) problems.push(`${name}: returned money value ${leakedValues.join(', ')}`)
      const stripped = JSON.stringify(JSON.parse(JSON.stringify(full, (key, value) => (key && restricted(key) ? undefined : value))))
      if (stripped !== text) problems.push(`${name}: differs beyond the money`)
    }
    expect(problems).toEqual([])
    // Control: the money is really there for a person who may see it.
    expect(JSON.stringify(await report('summary'))).toContain('3000.03')
    expect(JSON.stringify(await report('summary', {}, operator()))).not.toContain('3000.03')
  })
})
