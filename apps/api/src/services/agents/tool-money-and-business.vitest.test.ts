/**
 * MCP.2 — every agent tool, run for real, against a real PostgreSQL with the
 * production schema and the business-isolation policies (PGlite). No mocked
 * tool, no mocked query.
 *
 * Two promises the one door (call-tool.ts) makes to the in-app assistant and
 * to the MCP endpoint, proven on real rows:
 *
 *   MONEY — a person who may act but may not see money gets the same answer as
 *   a money-cleared person, minus exactly the money: no restricted key, and no
 *   value that sat under one. A revenue-only grant reveals revenue and nothing
 *   else.
 *
 *   BUSINESS — a tool run for business A never returns a row of business B,
 *   not when handed B's ids and not when it lists or searches.
 *
 * Every registered tool is covered: a new tool fails the coverage test until
 * it is given arguments here (or is listed as an AI draft, whose output is
 * text the model wrote).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { RESTRICTED_FIELDS } from '../../lib/auth/financial-fields.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { callTool, ToolAccessError, type ToolPrincipal, type UserPrincipal } from './call-tool.js'
import { listTools } from './tool-registry.js'
import type { AgentTool, ToolResult } from './tool-types.js'

const A = LEGACY_WORKSPACE_ID
const B = 'mcp_money_business_bravo'
/** Written into every business-B row a tool could return. It must never come back for A. */
const B_MARK = 'BRAVO'

interface Seeded { productId: string; orderId: string; approvalId: string }
const seeded: Record<string, Seeded> = {}

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-money',
    label: 'Money test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'app',
  }
}

const EVERY_ACTION = Object.values(FEATURES)
/** Can do everything, sees every money field. */
const cleared = (workspaceId: string) => principal(workspaceId, [...EVERY_ACTION, ...Object.values(FIELDS)])
/** Can do everything, sees no money field. */
const operator = (workspaceId: string) => principal(workspaceId, EVERY_ACTION)

/** Output is AI-written text: nothing structured to filter, and it calls a model. */
const AI_DRAFTS = new Set([
  'draft-alt-text',
  'draft-listing-content',
  'draft-seo',
  'translate-content',
  'draft-customer-message',
])

/** Arguments per tool, for the business whose rows it should read. */
const ARGS: Record<string, (ids: Seeded) => Record<string, unknown>> = {
  'product-snapshot': (ids) => ({ productId: ids.productId }),
  'product-search': () => ({ query: 'MONEY' }),
  'order-search': () => ({}),
  'order-detail': (ids) => ({ orderId: ids.orderId }),
  'stock-levels': (ids) => ({ productId: ids.productId }),
  'price-status': (ids) => ({ productId: ids.productId }),
  'listing-health': (ids) => ({ productId: ids.productId }),
  'product-analytics': (ids) => ({ productId: ids.productId, days: 30 }),
  'channel-stock-drift': () => ({}),
  'replenishment-forecast': (ids) => ({ productId: ids.productId }),
  'insights-metric': () => ({ days: 30 }),
  'detect-anomalies': () => ({}),
  'set-price': (ids) => ({ productId: ids.productId, price: 25 }),
  'publish-listing': (ids) => ({ productId: ids.productId, channel: 'EBAY' }),
  'send-customer-message': (ids) => ({ orderId: ids.orderId, message: 'Your parcel ships today.' }),
  'apply-content': (ids) => ({ productId: ids.productId, title: 'A better title' }),
  'create-negative-keyword': () => ({ externalCampaignId: 'none', keywordText: 'free', matchType: 'NEGATIVE_EXACT' }),
  'graduate-keyword': () => ({ query: 'jacket', sourceExternalCampaignId: 'none', destExternalCampaignId: 'none' }),
  'set-target-bid': () => ({ targetId: 'none', proposedBidCents: 55 }),
  'approval-status': (ids) => ({ approvalId: ids.approvalId }),
}

async function seedBusiness(workspaceId: string, mark: string): Promise<Seeded> {
  return inside(workspaceId, async () => {
    const db = database.client
    const product = await db.product.create({
      data: {
        sku: `${mark}-MONEY-SKU`,
        name: `${mark} MONEY jacket`,
        basePrice: '19.90',
        costPrice: '4242.42',
        totalStock: 7,
      },
    })
    const order = await db.order.create({
      data: {
        channel: 'EBAY',
        channelOrderId: `${mark}-ORDER-1`,
        marketplace: 'IT',
        currencyCode: 'EUR',
        totalPrice: '3000.03',
        customerName: `${mark} Buyer`,
        customerEmail: `${mark.toLowerCase()}.buyer@example.test`,
        shippingAddress: { city: 'Milano' },
        purchaseDate: new Date(),
        items: { create: [{ sku: product.sku, productId: product.id, quantity: 3, price: '1000.01' }] },
      },
    })
    await db.order.create({
      data: {
        channel: 'AMAZON',
        channelOrderId: `${mark}-ORDER-2`,
        marketplace: 'DE',
        currencyCode: 'EUR',
        totalPrice: '7.77',
        customerName: `${mark} Second`,
        customerEmail: `${mark.toLowerCase()}.second@example.test`,
        shippingAddress: { city: 'Berlin' },
        purchaseDate: new Date(),
      },
    })
    await db.channelListing.create({
      data: {
        productId: product.id,
        channelMarket: 'EBAY_IT',
        channel: 'EBAY',
        region: 'IT',
        marketplace: 'IT',
        title: `${mark} listing`,
        price: '21.50',
        quantity: 5,
      },
    })
    await db.channelStockEvent.create({
      data: {
        channel: 'EBAY',
        channelEventId: `${mark}-EVT-1`,
        sku: product.sku,
        productId: product.id,
        channelReportedQty: 4,
        localQtyAtObservation: 7,
        drift: -3,
      },
    })
    await db.replenishmentRecommendation.create({
      data: {
        productId: product.id,
        sku: product.sku,
        velocity: '0.5',
        velocitySource: 'test',
        leadTimeDays: 10,
        leadTimeSource: 'test',
        safetyDays: 3,
        totalAvailable: 7,
        inboundWithinLeadTime: 0,
        effectiveStock: 7,
        reorderPoint: 9,
        reorderQuantity: 20,
        urgency: 'HIGH',
        needsReorder: true,
      },
    })
    const rule = await db.alertRule.create({
      data: { name: `${mark} queue rule`, metric: 'queueDepth', operator: 'gt', threshold: 100, notificationChannels: [] },
    })
    await db.alertEvent.create({ data: { ruleId: rule.id, value: 250 } })
    // A queued change whose stored preview carries money the reader may not see.
    const run = await db.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } })
    const approval = await db.agentApproval.create({
      data: {
        agentRunId: run.id,
        toolName: 'apply-content',
        riskTier: 'medium',
        args: { productId: product.id, title: `${mark} title` },
        preview: { action: 'apply-content', changes: { title: { from: product.name, to: `${mark} title` } }, costPrice: '4242.42' },
        status: 'pending',
      },
    })
    return { productId: product.id, orderId: order.id, approvalId: approval.id }
  })
}

async function run(who: ToolPrincipal, tool: string, args: Record<string, unknown>) {
  try {
    const call = await callTool(who, tool, args)
    return { raw: call.raw, visible: call.visible, refused: null as ToolAccessError | null }
  } catch (error) {
    if (error instanceof ToolAccessError) return { raw: null, visible: null, refused: error }
    throw error
  }
}

/** Every key anywhere in a value, and every primitive that sits under a money key. */
function walk(value: unknown, restricted: (key: string) => boolean) {
  const keys = new Set<string>()
  const money: string[] = []
  const visit = (v: unknown, underMoney: boolean) => {
    if (v == null) return
    if (typeof v !== 'object' || (v as object).constructor?.name === 'Decimal') {
      if (underMoney) money.push(String(v))
      return
    }
    if (v instanceof Date) return
    for (const [key, child] of Object.entries(v)) {
      keys.add(key)
      visit(child, underMoney || restricted(key))
    }
  }
  visit(value, false)
  return { keys, money }
}

const restrictedFor = (tool: AgentTool) => (key: string) =>
  Object.prototype.hasOwnProperty.call(RESTRICTED_FIELDS, key) ||
  Object.prototype.hasOwnProperty.call(tool.restrictedFields ?? {}, key)

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  const owner = await database.client.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active' },
  })
  await database.client.workspace.create({
    data: { id: B, name: 'Bravo money business', createdByUserId: owner.id, creationKey: randomUUID() },
  })
  seeded[A] = await seedBusiness(A, 'ALPHA')
  seeded[B] = await seedBusiness(B, B_MARK)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('MCP.2 — coverage', () => {
  it('every registered tool is exercised here or is an AI draft', () => {
    const missing = listTools()
      .map((tool) => tool.name)
      .filter((name) => !ARGS[name] && !AI_DRAFTS.has(name))
    expect(missing).toEqual([])
  })
})

describe('MCP.2 — money a person may not see never comes back', () => {
  const tools = () => listTools().filter((tool) => !AI_DRAFTS.has(tool.name))

  it('the money-cleared run really reads the seeded money (positive control)', async () => {
    const analytics = await run(cleared(A), 'product-analytics', ARGS['product-analytics'](seeded[A]))
    expect(analytics.visible?.data).toMatchObject({ unitsSold: 3, revenue: 3000.03 })
    const insights = await run(cleared(A), 'insights-metric', ARGS['insights-metric'](seeded[A]))
    expect(insights.visible?.data).toMatchObject({ revenueByCurrency: { EUR: 3007.8 } })
  })

  it('for every tool: the same answer minus exactly the money', async () => {
    const problems: string[] = []
    for (const tool of tools()) {
      const args = ARGS[tool.name](seeded[A])
      const full = await run(cleared(A), tool.name, args)
      const partial = await run(operator(A), tool.name, args)
      if (full.refused) {
        problems.push(`${tool.name}: refused a fully cleared person (${full.refused.message})`)
        continue
      }
      const needsMoney = tool.requires.some((permission) => permission.startsWith('financials.'))
      // A tool that returned nothing proves nothing: each one must read the seeded rows. The ads
      // tools need ads data this seed does not have; they are covered by the refusal below.
      if (!needsMoney && !full.raw?.ok) problems.push(`${tool.name}: read nothing (${full.raw?.error})`)
      if (needsMoney) {
        // A tool that cannot be judged without money refuses the person outright.
        if (partial.refused?.code !== 'forbidden') problems.push(`${tool.name}: ran for a person without money`)
        continue
      }
      if (partial.refused) {
        problems.push(`${tool.name}: refused (${partial.refused.message})`)
        continue
      }
      const restricted = restrictedFor(tool)
      const seen = walk(partial.visible, restricted)
      const leakedKeys = [...seen.keys].filter(restricted)
      if (leakedKeys.length) problems.push(`${tool.name}: returned ${leakedKeys.join(', ')}`)
      const text = JSON.stringify(partial.visible)
      const leakedValues = walk(full.visible, restricted).money.filter((v) => v.length >= 4 && text.includes(v))
      if (leakedValues.length) problems.push(`${tool.name}: returned money value ${leakedValues.join(', ')}`)
      // Nothing else changed: the partial answer is the full one with money keys removed.
      const stripped = JSON.parse(
        JSON.stringify(full.visible, (key, value) => (key && restricted(key) ? undefined : value)),
      )
      if (JSON.stringify(stripped) !== text) problems.push(`${tool.name}: differs beyond the money`)
    }
    expect(problems).toEqual([])
  })

  it('a revenue grant reveals revenue, and only revenue', async () => {
    const revenueOnly = principal(A, [...EVERY_ACTION, FIELDS.financialsRevenueView])
    const out = await run(revenueOnly, 'product-analytics', ARGS['product-analytics'](seeded[A]))
    expect(out.visible?.data).toMatchObject({ revenue: 3000.03 })
    const operatorOut = await run(operator(A), 'product-analytics', ARGS['product-analytics'](seeded[A]))
    expect(operatorOut.visible?.data).not.toHaveProperty('revenue')
    expect(operatorOut.visible?.data).toMatchObject({ unitsSold: 3 })
  })
})

describe('MCP.2 — a tool reads only the business it runs in', () => {
  it('the other business’s rows are real and findable from inside it (positive control)', async () => {
    const out = await run(operator(B), 'product-search', ARGS['product-search'](seeded[B]))
    expect(JSON.stringify(out.visible)).toContain(B_MARK)
  })

  it('for every tool: business A never returns a row of business B', async () => {
    const leaks: string[] = []
    for (const tool of listTools().filter((t) => !AI_DRAFTS.has(t.name))) {
      // Handed its own ids, and handed business B's ids.
      for (const ids of [seeded[A], seeded[B]]) {
        const out = await run(cleared(A), tool.name, ARGS[tool.name](ids))
        const result: ToolResult | null = out.raw
        if (JSON.stringify(result ?? {}).includes(B_MARK)) leaks.push(`${tool.name} (${ids === seeded[B] ? "B's ids" : 'own ids'})`)
      }
    }
    expect(leaks).toEqual([])
  })

  it('business B’s ids are simply not found from business A', async () => {
    const out = await run(cleared(A), 'order-detail', ARGS['order-detail'](seeded[B]))
    expect(out.raw).toEqual({ ok: false, error: 'Order not found' })
  })
})
