import { cachedSchemasOnly } from '../cached-schema-context.js'
import { WorkspaceCache } from '../../../lib/workspace-cache.js'
import { outsideDatabaseTransaction } from '../../../lib/database-context.js'
import { workspaceKey } from '../../../lib/workspace-context.js'
import { shopifyAdmin } from '../../shopify/admin-client.js'
import { readLinkedStoreSchema, invalidateShopifyDefinitionConstraints } from '../../shopify/linked-products-gateway.js'
import { shopifyProductSpec } from './store.js'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'

/**
 * A connected store's field list (metafield and metaobject definitions, native capabilities) lives in
 * three layers: this process's memory, one `CategorySchema` row, and Shopify itself.
 *
 * 2026-09-24 — sheet reads are cache-only (R-LX-10) and memory was the only cache. It is empty after
 * every deploy and it was blanked whenever a new read started, so the Shopify sheet silently lost every
 * store metafield (Xavia Racing: 35 columns instead of 74). The row survives restarts, and a new read
 * never discards the last good copy.
 *
 * The row carries its own channel value, so no category reader (pickers, catalog transfer, refresh jobs)
 * lists it: channel `SHOPIFY_STORE` · marketplace = the account id · product type `*`.
 */
export const SHOPIFY_STORE_SCHEMA_CHANNEL = 'SHOPIFY_STORE'
const STORE_PRODUCT_TYPE = '*'
const FRESH_MS = 30_000
const ROW_EXPIRY_MS = 24 * 60 * 60 * 1000

/** `generation` moves on every invalidation; `sequence` orders reads, so an older read never replaces a newer answer. */
type Entry = { value?: ShopifyStoreSchema; expires: number; pending?: Promise<ShopifyStoreSchema>; pendingGeneration: number; generation: number; sequence: number; applied: number }
const schemas = new WorkspaceCache<string, Entry>()

function entryFor(accountId: string): Entry {
  let entry = schemas.get(accountId)
  if (!entry) { entry = { expires: 0, pendingGeneration: 0, generation: 0, sequence: 0, applied: 0 }; schemas.set(accountId, entry) }
  return entry
}

/** What a restart or a deploy does to this process's copies; the stored rows stay. For tests. */
export function forgetShopifyMappingSchemasInProcess() { schemas.clear() }

/** The next interactive read goes to Shopify; readers keep the last good copy until it lands. */
export function invalidateShopifyMappingSchema(accountId: string) {
  const entry = schemas.get(accountId)
  if (entry) { entry.expires = 0; entry.generation++ }
  invalidateShopifyDefinitionConstraints()
}

function isStoreSchema(value: unknown): value is ShopifyStoreSchema {
  const v = value as Partial<ShopifyStoreSchema> | null
  return !!v && Array.isArray(v.definitions) && Array.isArray(v.metaobjectDefinitions) && Array.isArray(v.locales) && Array.isArray(v.types) && typeof v.revision === 'string'
}

/**
 * The test runner keeps the stored copy in memory (`vitest.setup.ts` sets `NEXUS_SHOPIFY_STORE_SCHEMA_ROWS=memory`):
 * a unit test with a mocked store must never write a cache row into a shared database, and a row left by an
 * earlier run must never decide whether a later run finds the store "cached". Same code path, other storage.
 */
const memoryRows = new WorkspaceCache<string, ShopifyStoreSchema>()
const rowsInMemory = () => process.env.NEXUS_SHOPIFY_STORE_SCHEMA_ROWS === 'memory'

async function readStoredSchema(accountId: string): Promise<ShopifyStoreSchema | null> {
  if (rowsInMemory()) return memoryRows.get(accountId) ?? null
  const { default: prisma } = await import('../../../db.js')
  const row = await prisma.categorySchema.findFirst({
    where: { channel: SHOPIFY_STORE_SCHEMA_CHANNEL, marketplace: accountId, productType: STORE_PRODUCT_TYPE, isActive: true },
    orderBy: { fetchedAt: 'desc' }, select: { schemaDefinition: true },
  })
  return row && isStoreSchema(row.schemaDefinition) ? row.schemaDefinition : null
}

/** A cache write. It never joins the caller's transaction and never fails the caller's read. */
async function storeSchema(accountId: string, value: ShopifyStoreSchema): Promise<void> {
  if (rowsInMemory()) { memoryRows.set(accountId, value); return }
  try {
    await outsideDatabaseTransaction(async () => {
      const { default: prisma } = await import('../../../db.js')
      const coordinate = { channel: SHOPIFY_STORE_SCHEMA_CHANNEL, marketplace: accountId, productType: STORE_PRODUCT_TYPE }
      const data = { schemaDefinition: value as any, isActive: true, fetchedAt: new Date(), expiresAt: new Date(Date.now() + ROW_EXPIRY_MS) }
      await prisma.categorySchema.upsert({
        where: { channel_marketplace_productType_schemaVersion: workspaceKey({ ...coordinate, schemaVersion: value.revision }) },
        create: { ...coordinate, schemaVersion: value.revision, ...data }, update: data,
      })
      // One row per store: an older revision is superseded, never a second answer.
      await prisma.categorySchema.deleteMany({ where: { ...coordinate, schemaVersion: { not: value.revision } } })
    })
  } catch (error) {
    console.warn('[shopify-schema] the store field list could not be stored:', error instanceof Error ? error.message : error)
  }
}

/** Tests with a mocked store keep the categories in memory too (see `memoryRows`). */
const memoryCategories = new WorkspaceCache<string, string[]>()
export function rememberShopifyStoreCategoriesInMemory(accountId: string, categories: string[]) { memoryCategories.set(accountId, categories) }

/**
 * The Shopify categories this store's Nexus products use: the Shopify category mappings and each listing's own category.
 * The schema answers category-field questions exactly for these (`readLinkedStoreSchema`); any other category is left to
 * Shopify's check before a write. A failed read never fails the schema read: it only makes the answers less exact.
 */
async function storeCategoriesInUse(accountId: string): Promise<string[]> {
  if (rowsInMemory()) return memoryCategories.get(accountId) ?? []
  try {
    const { default: prisma } = await import('../../../db.js')
    const [mappings, listings] = await Promise.all([
      prisma.categoryChannelMapping.findMany({ where: { channel: 'SHOPIFY' }, select: { channelCategoryId: true }, distinct: ['channelCategoryId'] }),
      prisma.$queryRaw<{ category: string }[]>`SELECT DISTINCT "platformAttributes"->>'category' AS category FROM "ChannelListing"
        WHERE "channel" = 'SHOPIFY' AND "channelConnectionId" = ${accountId} AND jsonb_typeof("platformAttributes"->'category') = 'string'`,
    ])
    return [...new Set([...mappings.map(m => m.channelCategoryId), ...listings.map(l => l.category)].filter(Boolean))]
  } catch (error) {
    console.warn('[shopify-schema] the store\'s categories could not be read:', error instanceof Error ? error.message : error)
    return []
  }
}

function fetchSchema(accountId: string, entry: Entry): Promise<ShopifyStoreSchema> {
  const sequence = ++entry.sequence, generation = entry.generation
  const categories = storeCategoriesInUse(accountId)
  const pending = shopifyAdmin(accountId).then(async ({ graphql }) => readLinkedStoreSchema(graphql, { categories: await categories })).then(value => {
    // A slower, older read never replaces a newer answer.
    if (sequence > entry.applied) {
      entry.value = value; entry.applied = sequence
      // A read that started before an invalidation is kept as the last known copy, never as fresh.
      entry.expires = generation === entry.generation ? Date.now() + FRESH_MS : 0
      void storeSchema(accountId, value)
    }
    return value
  })
  entry.pending = pending; entry.pendingGeneration = generation
  // A failed read leaves the last good copy in place; the caller still receives the error.
  const settle = () => { if (entry.pending === pending) entry.pending = undefined }
  pending.then(settle, settle)
  return pending
}

/**
 * Workspace/store isolation and single-flight reads. Failures never become an empty schema.
 * Cache-only callers (a sheet read) get memory, then the stored row, and never start provider work.
 */
export async function readShopifyMappingSchema(accountId: string, fresh = false): Promise<ShopifyStoreSchema> {
  const entry = entryFor(accountId)
  if (cachedSchemasOnly()) {
    if (entry.value) return entry.value
    const stored = await readStoredSchema(accountId)
    if (!stored) throw new Error('Shopify requirements are not cached for this account.')
    // `expires` stays as it is, so the next interactive read still refreshes it.
    entry.value ??= stored
    return entry.value
  }
  // A read already under way and started after the last invalidation is as fresh as a new one.
  if (entry.pending && entry.pendingGeneration === entry.generation) return entry.pending
  if (!fresh && entry.value && entry.expires > Date.now()) return entry.value
  return fetchSchema(accountId, entry)
}

/**
 * For display: the last known field list now, a refresh behind it. Only a store never read before
 * waits for Shopify — a page load no longer waits up to 34 s on the definitions.
 */
export async function readShopifyDisplaySchema(accountId: string): Promise<ShopifyStoreSchema> {
  const entry = entryFor(accountId)
  const known = entry.value ?? await readStoredSchema(accountId)
  if (!known) return readShopifyMappingSchema(accountId)
  entry.value ??= known
  if (entry.expires <= Date.now() && !entry.pending) {
    fetchSchema(accountId, entry).catch(error => console.warn('[shopify-schema] background refresh failed:', error instanceof Error ? error.message : error))
  }
  return entry.value
}

/** `categoryIds`: the family's Shopify categories, when the caller knows them (the sheet's Shopify scope). */
export async function loadShopifyProductSpec(accountId?: string | null, locale?: string, categoryIds?: string[]) {
  return shopifyProductSpec(accountId ? await readShopifyMappingSchema(accountId) : null, accountId, locale, categoryIds)
}
