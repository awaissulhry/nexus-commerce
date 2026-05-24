/**
 * PIM D.1 — Bridge from live SP-API schema → ChannelSchema rows.
 *
 * The existing CategorySchemaService (services/categories/schema-sync)
 * fetches and caches the full JSON Schema for one (channel, marketplace,
 * productType) — that's the data engine. This bridge consumes that
 * JSON Schema and lifts the per-field definitions into ChannelSchema
 * rows so the D.2 mapping editor can render them.
 *
 * Why a bridge instead of folding into CategorySchemaService:
 *   - CategorySchemaService is the source of truth for the JSON Schema
 *     blob (cached as CategorySchema rows with schemaDefinition).
 *   - ChannelSchema is the flat-list registry the mapping canvas reads.
 *   - Keeping these separate means the JSON Schema cache + UI registry
 *     evolve independently; the bridge just translates.
 *
 * Out of scope for D.1: eBay / Shopify schema fetch (the underlying
 * client exists for eBay but the property extraction is different;
 * Shopify metafield schema is its own API).
 */

import prisma from '../../db.js'
import { recordSchemaSync } from './schema-mapping.service.js'

interface JsonSchemaProperty {
  type?: string | string[]
  title?: string
  description?: string
  maxLength?: number
  enum?: unknown[]
  // Amazon often wraps the operator-edit field inside an array of
  // objects with a `value` sub-property. We don't expand that here —
  // the field key is enough for the mapping editor; D.3 transforms
  // can later handle nested shapes.
}

interface JsonSchemaRoot {
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchemaProperty>
  // Amazon-specific envelope:
  __propertyGroups?: Record<string, { title: string; propertyNames: string[] }>
}

export interface SchemaSyncResult {
  channel: string
  marketplace: string
  productType: string
  schemaSnapshotVersion: string
  upserted: number
  skipped: number
  totalProperties: number
}

/**
 * Run a sync: load cached CategorySchema for the given productType,
 * walk its properties, upsert one ChannelSchema row per top-level
 * property, then record the snapshot version on Marketplace.schemaMapping.
 *
 * Caller is responsible for ensuring CategorySchema is populated
 * (CategorySchemaService.getSchema(...) does that on demand). This
 * function reads the cache table directly so it stays sync-only —
 * no SP-API calls.
 *
 * If the requested category is absent from the cache, throws so the
 * route can return 404 with an actionable message.
 */
export async function syncSchemaToChannelSchema(input: {
  channel: 'AMAZON' | 'EBAY'
  marketplace: string
  productType: string
}): Promise<SchemaSyncResult> {
  const { channel, marketplace, productType } = input

  // Read the freshest cached schema for this triple. We sort by
  // fetchedAt DESC + filter to active schemas so a stale row doesn't
  // override a recent re-fetch.
  const cached = await prisma.categorySchema.findFirst({
    where: {
      channel,
      marketplace,
      productType,
      isActive: true,
    },
    orderBy: { fetchedAt: 'desc' },
  })

  if (!cached) {
    throw new Error(
      `No cached schema for ${channel}/${marketplace}/${productType}. ` +
        `Hit the CategorySchemaService.getSchema endpoint first to populate the cache.`,
    )
  }

  const schema = (cached.schemaDefinition as unknown) as JsonSchemaRoot | null
  if (!schema || !schema.properties) {
    throw new Error('Cached schema has no properties — cannot extract fields.')
  }

  const requiredSet = new Set(schema.required ?? [])
  const propEntries = Object.entries(schema.properties)
  let upserted = 0
  let skipped = 0

  for (const [propName, propDef] of propEntries) {
    // Skip Amazon's envelope keys (anything starting with __).
    if (propName.startsWith('__')) {
      skipped++
      continue
    }

    const label = propDef.title ?? humanizeKey(propName)
    const maxLength = typeof propDef.maxLength === 'number' ? propDef.maxLength : null
    const required = requiredSet.has(propName)
    const allowedValues = Array.isArray(propDef.enum) && propDef.enum.length > 0
      ? propDef.enum
      : null
    const notes = propDef.description ?? null

    await prisma.channelSchema.upsert({
      where: {
        channel_marketplace_fieldKey: {
          channel,
          marketplace,
          fieldKey: propName,
        },
      },
      create: {
        channel,
        marketplace,
        fieldKey: propName,
        label,
        maxLength,
        required,
        allowedValues: allowedValues as object | null,
        notes,
      },
      update: {
        label,
        maxLength,
        required,
        allowedValues: allowedValues as object | null,
        notes,
      },
    })
    upserted++
  }

  // Record the snapshot version on Marketplace.schemaMapping so the
  // mapping editor can show "synced N hours ago, snapshot v=X".
  const snapshotVersion = `${productType}:${cached.schemaVersion ?? 'unknown'}:${cached.fetchedAt.toISOString()}`
  await recordSchemaSync(channel, marketplace, snapshotVersion)

  return {
    channel,
    marketplace,
    productType,
    schemaSnapshotVersion: snapshotVersion,
    upserted,
    skipped,
    totalProperties: propEntries.length,
  }
}

/** Friendly default label for properties that don't ship with `title`. */
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}
