/**
 * MCP.12 — a deleted product (soft delete, `Product.deletedAt`) is not found by any tool, read or change, and is never
 * a result. Driven from the registry: every tool whose input names a product (`productId`, or `products` for the bulk
 * tools) is called with a deleted product, its arguments sampled from the same JSON Schema the model is given, so a
 * product tool added later is covered without editing this file. Run on a real PostgreSQL with the production schema
 * and business-isolation policies (PGlite).
 *
 * Before this, product-search listed deleted products, and stock-levels, price-status, listing-health,
 * product-analytics, replenishment-forecast, channel-stock-drift, the AI drafts and the preview and execute of
 * set-price, publish-listing and apply-content all read one by id.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// I10 — wrapped as db.ts wraps it (as tool-money-and-business does): inside a transaction, `prisma.x` is that
// transaction's client. The identity fix tools' preview runs the product writer's dry run, which opens one and queries
// through `prisma` inside it; on the raw client those queries waited for the pool's only connection.
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { listTools } from '../tool-registry.js'
import { inputJsonSchema } from '../tool-loop.service.js'
import type { AgentTool } from '../tool-types.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'

const A = LEGACY_WORKSPACE_ID
const business = { workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
/** In the app, so the AI drafts (not offered to Claude) are covered too. */
const everyone: UserPrincipal = {
  kind: 'user',
  userId: 'u-mcp12-deleted',
  label: 'MCP.12 deleted-product test',
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business,
  via: 'app',
}

const ids = { deleted: '', live: '' }
const DELETED_SKU = 'MCP12-GONE'

type Json = Record<string, any>
/** A value of the right shape for one JSON Schema property: enough to pass the tool's own argument check. */
function sample(schema: Json): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0]
  if (schema.const !== undefined) return schema.const
  // A union samples its simplest option (L10: a photo edit's `axis` op needs only its name).
  if (schema.anyOf) return sample([...schema.anyOf].sort((a: Json, b: Json) => (a.required?.length ?? 0) - (b.required?.length ?? 0))[0])
  if (schema.oneOf) return sample([...schema.oneOf].sort((a: Json, b: Json) => (a.required?.length ?? 0) - (b.required?.length ?? 0))[0])
  switch (schema.type) {
    // L11 — a web address (a photo link) must parse as one.
    case 'string': return schema.format === 'uri' ? 'https://photos.example.test/test.png' : 'test'
    case 'number': case 'integer': return Math.max(1, schema.minimum ?? 1)
    case 'boolean': return true
    case 'array': return [sample(schema.items ?? { type: 'string' })]
    // An object samples its required properties (L8: Matrix targets); a record its own value shape (L7: value lists per axis).
    case 'object': return schema.properties
      ? Object.fromEntries(((schema.required ?? []) as string[]).map((name) => [name, sample(schema.properties[name])]))
      : { test_attribute: schema.additionalProperties && typeof schema.additionalProperties === 'object' ? sample(schema.additionalProperties) : 'x' }
    default: return 'test'
  }
}

interface ProductTool { tool: AgentTool; key: 'productId' | 'products' | 'product'; required: boolean }
/**
 * Tools whose productId is optional only because an EDIT names its own row instead (save-price-rule: priceRuleId).
 * Not lists: given a product they are about that product, so they are checked as if it were required.
 */
const CREATE_OR_EDIT = new Set([
  'save-price-rule',
  // Ads autonomy W1-3 — a strategy row's scope: given a product, the change is about that product's row.
  'set-ads-strategy',
  // Ads playbook PB-3 — a playbook row's scope: given a product, the change is about that product's row.
  'set-ads-playbook',
])
/** The tools whose input names a product, and how (`product`: one product by Nexus id or SKU). */
function productTools(): ProductTool[] {
  return listTools().flatMap((tool): ProductTool[] => {
    const schema = inputJsonSchema(tool) as Json
    const props = (schema.properties ?? {}) as Json
    const required = new Set<string>(schema.required ?? [])
    if ('productId' in props) return [{ tool, key: 'productId', required: required.has('productId') || CREATE_OR_EDIT.has(tool.name) }]
    if ('products' in props) return [{ tool, key: 'products', required: required.has('products') }]
    if ('product' in props && props.product.type === 'string') return [{ tool, key: 'product', required: required.has('product') }]
    return []
  })
}

/** Every required argument sampled; the product named as `ref`. */
function argsFor(tool: AgentTool, key: ProductTool['key'], ref: string): Record<string, unknown> {
  const schema = inputJsonSchema(tool) as Json
  const args: Record<string, unknown> = {}
  for (const name of (schema.required ?? []) as string[]) args[name] = sample(schema.properties[name])
  args[key] = key === 'products' ? [ref] : ref
  return args
}

const mentions = (value: unknown, ...needles: string[]) => {
  const text = JSON.stringify(value)
  return needles.some((needle) => text.includes(needle))
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  await inside(async () => {
    const db = database.client
    ids.live = (await db.product.create({ data: { sku: 'MCP12-HERE', name: 'Live jacket', basePrice: '10.00' } })).id
    ids.deleted = (await db.product.create({ data: { sku: DELETED_SKU, name: 'Deleted jacket', basePrice: '10.00', deletedAt: new Date() } })).id
    // Rows a tool could read by productId: a listing (with an issue source: an error status), a replenishment
    // recommendation, stock drift — for the deleted product, and drift for the live one and for an unmatched SKU.
    await db.channelListing.create({
      data: { productId: ids.deleted, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', listingStatus: 'ERROR', externalListingId: 'EXT-MCP12-GONE' } as never,
    })
    const drift = (productId: string | null, sku: string, n: number) =>
      db.channelStockEvent.create({ data: { channel: 'EBAY', channelEventId: `MCP12-${n}`, productId, sku, channelReportedQty: 3, localQtyAtObservation: 5, drift: -2 } })
    await drift(ids.deleted, DELETED_SKU, 1)
    await drift(ids.live, 'MCP12-HERE', 2)
    await drift(null, 'MCP12-UNMATCHED', 3)
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('MCP.12 — which tools name a product (read from the registry)', () => {
  it('finds every one of them, so the checks below are not vacuous', () => {
    const names = productTools().map((t) => t.tool.name).sort()
    expect(names).toEqual(expect.arrayContaining([
      'apply-content', 'bulk-attribute-change', 'bulk-price-change', 'channel-price-stock', 'channel-stock-drift',
      'draft-alt-text', 'draft-listing-content', 'draft-seo', 'listing-health', 'listing-issues', 'out-of-sync-listings',
      'price-status', 'product-analytics', 'product-content', 'product-snapshot', 'publish-listing', 'replenishment-forecast',
      'set-content', 'set-listing-content', 'set-price', 'stock-levels', 'translate-content', 'translation-status',
      'shopify-content', 'set-shopify-content', 'listing-live-content',
    ]))
  })
})

/** The bulk tools run the product writer's dry run (the bulk suite's own 30 s); the control runs every tool once. */
describe('MCP.12 — a deleted product is not found, by any tool', { timeout: 60_000 }, () => {
  it.each(productTools().map((t) => [t.tool.name, t] as const))('%s', async (_name, { tool, key, required }) => {
    const out = (await inside(() => callTool(everyone, tool.name, argsFor(tool, key, ids.deleted)))).visible as Json
    if (required) {
      // A tool that is about one product (or names products): refused, and says why.
      expect(out.ok, JSON.stringify(out)).toBe(false)
      expect(out.error).toMatch(/not found/i)
    } else {
      // A list with an optional product filter: either "not found", or a list that does not contain it.
      if (out.ok === false) expect(out.error).toBe(PRODUCT_NOT_FOUND)
      else expect(mentions(out, ids.deleted, DELETED_SKU), JSON.stringify(out)).toBe(false)
    }
  })

  it.each(productTools().filter((t) => t.tool.execute).map((t) => [t.tool.name, t] as const))(
    '%s — run after a person approved it, the product having been deleted meanwhile',
    async (_name, { tool, key }) => {
      const before = await inside(() => database.client.outboundSyncQueue.count())
      const out = await inside(() => tool.execute!(argsFor(tool, key, ids.deleted), { userId: null }))
      expect(out.ok, JSON.stringify(out)).toBe(false)
      expect(out.error).toMatch(/not found/i)
      expect(await inside(() => database.client.outboundSyncQueue.count())).toBe(before)
      expect(Number((await inside(() => database.client.product.findUniqueOrThrow({ where: { id: ids.deleted } }))).basePrice)).toBe(10)
    },
  )

  it('a list with no product filter never shows it either', async () => {
    const lists = productTools().filter((t) => !t.required)
    expect(lists.map((t) => t.tool.name).sort()).toEqual(expect.arrayContaining(['channel-stock-drift', 'listing-issues']))
    for (const { tool } of lists) {
      const out = (await inside(() => callTool(everyone, tool.name, {}))).visible as Json
      expect(out.ok, `${tool.name}: ${JSON.stringify(out)}`).toBe(true)
      expect(mentions(out, ids.deleted, DELETED_SKU), `${tool.name}: ${JSON.stringify(out)}`).toBe(false)
    }
    // Control: the live product's drift and an unmatched SKU's drift are still rows.
    const drift = (await inside(() => callTool(everyone, 'channel-stock-drift', {}))).visible as Json
    expect((drift.data.drifts as Json[]).map((d) => d.sku).sort()).toEqual(['MCP12-HERE', 'MCP12-UNMATCHED'])
  })

  it('control: the same arguments name a live product without "not found"', async () => {
    // The AI drafts are left out here: for a live product they would call the model.
    for (const { tool, key } of productTools().filter((t) => !t.tool.surfaces)) {
      const out = (await inside(() => callTool(everyone, tool.name, argsFor(tool, key, ids.live)))).visible as Json
      expect(`${tool.name}: ${out.error ?? ''}`).not.toMatch(/not found/i)
    }
  })
})
