/**
 * CE.1 — Channel Schema service.
 *
 * Manages the ChannelSchema table: per-channel field definitions used
 * to validate transform output and power the rule builder field picker.
 *
 * Built-in schemas (Amazon IT, eBay, Shopify) are seeded via
 * POST /api/feed-transform/seed-schemas. Custom fields can be added by
 * operators. Validation runs after evaluateRules() and returns a map of
 * field → error string for any violations.
 */

import type { PrismaClient, ChannelSchema } from '@nexus/database'

export interface ValidationError {
  field: string
  message: string
}

// ── Validation ─────────────────────────────────────────────────────────────

export async function validatePackage(
  prisma: PrismaClient,
  channel: string,
  marketplace: string | null,
  resolved: Record<string, string>,
): Promise<ValidationError[]> {
  const channelUp = channel.toUpperCase()
  const marketUp = marketplace?.toUpperCase() ?? null

  // Load schema for this channel/marketplace combo (also null-marketplace rows)
  const schemas = await prisma.channelSchema.findMany({
    where: {
      channel: channelUp,
      OR: [{ marketplace: marketUp }, { marketplace: null }],
    },
  })

  // Prefer specific marketplace schema over null
  const schemaMap = new Map<string, ChannelSchema>()
  for (const s of schemas) {
    const existing = schemaMap.get(s.fieldKey)
    if (!existing || (s.marketplace && !existing.marketplace)) {
      schemaMap.set(s.fieldKey, s)
    }
  }

  const errors: ValidationError[] = []

  for (const [fieldKey, schema] of schemaMap) {
    const value = resolved[fieldKey]

    if (schema.required && (value == null || value.trim() === '')) {
      errors.push({ field: fieldKey, message: `${schema.label} is required` })
      continue
    }

    if (value == null) continue

    if (schema.maxLength && value.length > schema.maxLength) {
      errors.push({
        field: fieldKey,
        message: `${schema.label} exceeds ${schema.maxLength} character limit (${value.length} chars)`,
      })
    }

    if (schema.allowedValues) {
      const allowed = schema.allowedValues as string[]
      if (!allowed.includes(value)) {
        errors.push({
          field: fieldKey,
          message: `${schema.label} must be one of: ${allowed.join(', ')}`,
        })
      }
    }
  }

  return errors
}

// ── Schema CRUD ────────────────────────────────────────────────────────────

export async function getSchemaForChannel(
  prisma: PrismaClient,
  channel: string,
  marketplace?: string | null,
) {
  return prisma.channelSchema.findMany({
    where: {
      channel: channel.toUpperCase(),
      OR: [
        { marketplace: marketplace?.toUpperCase() ?? null },
        { marketplace: null },
      ],
    },
    orderBy: [{ required: 'desc' }, { fieldKey: 'asc' }],
  })
}

// ── Seed built-in schemas ──────────────────────────────────────────────────

type SeedEntry = {
  channel: string
  marketplace: string | null
  fieldKey: string
  label: string
  maxLength?: number
  required?: boolean
  allowedValues?: string[]
  notes?: string
}

const BUILT_IN_SCHEMAS: SeedEntry[] = [
  // ── Amazon (applies to all marketplaces unless overridden) ──
  { channel: 'AMAZON', marketplace: null, fieldKey: 'title',          label: 'Title',            maxLength: 200,  required: true  },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'bullet_1',       label: 'Bullet Point 1',   maxLength: 500,  required: true  },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'bullet_2',       label: 'Bullet Point 2',   maxLength: 500,  required: true  },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'bullet_3',       label: 'Bullet Point 3',   maxLength: 500,  required: false },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'bullet_4',       label: 'Bullet Point 4',   maxLength: 500,  required: false },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'bullet_5',       label: 'Bullet Point 5',   maxLength: 500,  required: false },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'description',    label: 'Product Description', maxLength: 2000, required: false },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'brand',          label: 'Brand',            required: true  },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'browse_node_id', label: 'Browse Node ID',   required: true, notes: 'Amazon category node ID — use CE.2 AI predictor to auto-fill' },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'item_type_keyword', label: 'Item Type Keyword', required: false },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'color',          label: 'Color',            required: false },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'size',           label: 'Size',             required: false },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'material',       label: 'Material',         required: false },
  { channel: 'AMAZON', marketplace: null, fieldKey: 'country_of_origin', label: 'Country of Origin', required: false },

  // ── eBay ──
  { channel: 'EBAY', marketplace: null, fieldKey: 'title',         label: 'Title',             maxLength: 80,   required: true  },
  { channel: 'EBAY', marketplace: null, fieldKey: 'description',   label: 'Description (HTML)', required: true  },
  { channel: 'EBAY', marketplace: null, fieldKey: 'condition',     label: 'Condition',          required: true, allowedValues: ['New', 'Used', 'Manufacturer refurbished', 'For parts or not working'] },
  { channel: 'EBAY', marketplace: null, fieldKey: 'category_id',  label: 'Category ID',        required: false, notes: 'eBay leaf category ID' },
  { channel: 'EBAY', marketplace: null, fieldKey: 'item_specifics', label: 'Item Specifics (JSON)', required: false },
  { channel: 'EBAY', marketplace: null, fieldKey: 'brand',        label: 'Brand',              required: false },
  { channel: 'EBAY', marketplace: null, fieldKey: 'mpn',          label: 'MPN',                required: false },

  // ── Shopify ──
  { channel: 'SHOPIFY', marketplace: null, fieldKey: 'title',        label: 'Title',        required: true  },
  { channel: 'SHOPIFY', marketplace: null, fieldKey: 'body_html',    label: 'Description (HTML)', required: false },
  { channel: 'SHOPIFY', marketplace: null, fieldKey: 'vendor',       label: 'Vendor / Brand', required: false },
  { channel: 'SHOPIFY', marketplace: null, fieldKey: 'product_type', label: 'Product Type', required: false },
  { channel: 'SHOPIFY', marketplace: null, fieldKey: 'tags',         label: 'Tags',         required: false, notes: 'Comma-separated' },
  { channel: 'SHOPIFY', marketplace: null, fieldKey: 'handle',       label: 'URL Handle',   required: false },
  { channel: 'SHOPIFY', marketplace: null, fieldKey: 'seo_title',    label: 'SEO Title',    maxLength: 70,   required: false },
  { channel: 'SHOPIFY', marketplace: null, fieldKey: 'seo_description', label: 'SEO Description', maxLength: 320, required: false },
]

export async function seedBuiltInSchemas(prisma: PrismaClient): Promise<{ upserted: number }> {
  let upserted = 0
  for (const entry of BUILT_IN_SCHEMAS) {
    await prisma.channelSchema.upsert({
      where: {
        channel_marketplace_fieldKey: {
          channel: entry.channel,
          marketplace: entry.marketplace ?? '',
          fieldKey: entry.fieldKey,
        },
      },
      create: {
        channel: entry.channel,
        marketplace: entry.marketplace,
        fieldKey: entry.fieldKey,
        label: entry.label,
        maxLength: entry.maxLength ?? null,
        required: entry.required ?? false,
        allowedValues: entry.allowedValues ?? null,
        notes: entry.notes ?? null,
      },
      update: {
        label: entry.label,
        maxLength: entry.maxLength ?? null,
        required: entry.required ?? false,
        notes: entry.notes ?? null,
      },
    })
    upserted++
  }
  return { upserted }
}
