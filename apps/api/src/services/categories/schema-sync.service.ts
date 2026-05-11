// CategorySchemaService — fetch + cache live category schemas from
// Amazon (and eventually eBay). Used by the dynamic field registry to
// build editable bulk-grid columns without hardcoding category fields.
//
// Lifecycle:
//   getSchema(params)
//     ├─ cache hit (active, expiresAt > now)         → return cached
//     ├─ cache miss → fetchFromAmazon(params)
//     │     ├─ same schemaVersion as latest cached  → bump expiresAt
//     │     └─ new schemaVersion                    → write new row
//     │           + detectAndLogChanges(previous, new)
//     └─ Amazon not configured                       → throw
//
// The SP-API response for getDefinitionsProductType returns a metadata
// envelope with an S3 link to the actual JSON Schema. We fetch that
// link, validate the checksum, and store the JSON Schema as the
// `schemaDefinition`.

import type { PrismaClient } from '@prisma/client'
import { AmazonService } from '../marketplaces/amazon.service.js'
import { amazonMarketplaceId, amazonLocale } from './marketplace-ids.js'

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

export type SupportedChannel = 'AMAZON' | 'EBAY'

export interface SchemaQuery {
  channel: SupportedChannel
  marketplace?: string | null
  productType: string
}

interface AmazonProductTypeMeta {
  productType: string
  /** Version identifier — flips when Amazon revises the type. Path is
   * `productTypeVersion.version` (e.g. "RELEASE_18.1"). */
  productTypeVersion?: {
    version: string
    latest?: boolean
    releaseCandidate?: boolean
  }
  /** Pointer to the full JSON Schema (S3 presigned URL + checksum). */
  schema: {
    link: { resource: string; verb: 'GET' }
    checksum: string
  }
  /** Pointer to the meta-schema (we ignore — describes how to read schema). */
  metaSchema?: unknown
  /** Locale of returned labels/descriptions. */
  locale?: string
  /** Optional requirements descriptor. */
  requirements?: string
  requirementsEnforced?: string
  /**
   * Amazon's property grouping metadata — maps group IDs to their
   * localized title and the list of property names they contain.
   * This drives the exact flat-file column grouping per marketplace.
   */
  propertyGroups?: Record<string, {
    title: string
    propertyNames: string[]
  }>
}

export class CategorySchemaService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly amazon: AmazonService,
  ) {}

  /**
   * Return the freshest non-expired schema for the given (channel,
   * marketplace, productType). On cache miss or expiry, hits the
   * provider and caches the result. Throws if the provider isn't
   * configured (e.g. local dev without SP-API creds).
   */
  async getSchema(query: SchemaQuery, opts: { force?: boolean } = {}) {
    if (!opts.force) {
      const cached = await this.findFreshCache(query)
      if (cached) return cached
    }

    if (query.channel === 'AMAZON') {
      return this.fetchAndCacheAmazon(query)
    }
    if (query.channel === 'EBAY') {
      throw new Error('eBay schema sync is not implemented yet')
    }
    throw new Error(`Unsupported channel: ${query.channel}`)
  }

  /** Force-refresh — bypasses cache, always hits the provider. */
  async refreshSchema(query: SchemaQuery) {
    return this.getSchema(query, { force: true })
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async findFreshCache(query: SchemaQuery) {
    return this.prisma.categorySchema.findFirst({
      where: {
        channel: query.channel,
        marketplace: query.marketplace ?? null,
        productType: query.productType,
        isActive: true,
        expiresAt: { gt: new Date() },
      },
      orderBy: { fetchedAt: 'desc' },
    })
  }

  private async findLatestCache(query: SchemaQuery) {
    // Latest regardless of expiry — used for diffing previous version.
    return this.prisma.categorySchema.findFirst({
      where: {
        channel: query.channel,
        marketplace: query.marketplace ?? null,
        productType: query.productType,
      },
      orderBy: { fetchedAt: 'desc' },
    })
  }

  private async fetchAndCacheAmazon(query: SchemaQuery) {
    if (!this.amazon.isConfigured()) {
      throw new Error(
        'Amazon SP-API not configured — set AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ROLE_ARN',
      )
    }

    const sp = await (this.amazon as any).getClient()
    const marketplaceId = amazonMarketplaceId(query.marketplace)

    const envelope = (await sp.callAPI({
      operation: 'getDefinitionsProductType',
      endpoint: 'productTypeDefinitions',
      version: '2020-09-01',
      path: { productType: query.productType },
      query: {
        marketplaceIds: [marketplaceId],
        requirements: 'LISTING',
        locale: amazonLocale(query.marketplace),
      },
    })) as AmazonProductTypeMeta

    if (!envelope?.schema?.link?.resource) {
      throw new Error(
        `Amazon getDefinitionsProductType returned no schema link for ${query.productType}`,
      )
    }

    // Step 2 — fetch the actual JSON Schema from the S3 link.
    const schemaRes = await fetch(envelope.schema.link.resource)
    if (!schemaRes.ok) {
      throw new Error(
        `Failed to fetch schema body for ${query.productType}: HTTP ${schemaRes.status}`,
      )
    }
    const schemaDefinition = (await schemaRes.json()) as Record<string, unknown>

    // Embed Amazon's group metadata into the schema so the flat-file
    // service can reproduce the exact grouping per marketplace without
    // an extra API call. Using a private key (__propertyGroups) to
    // avoid colliding with JSON Schema keywords.
    if (envelope.propertyGroups) {
      schemaDefinition.__propertyGroups = envelope.propertyGroups
    }

    const schemaVersion = envelope.productTypeVersion?.version ?? 'unknown'
    const variationThemes = extractVariationThemes(schemaDefinition)

    // If we already have this exact version cached, just bump the
    // expiry — no new row, no change detection.
    const existing = await this.prisma.categorySchema.findUnique({
      where: {
        channel_marketplace_productType_schemaVersion: {
          channel: 'AMAZON',
          marketplace: query.marketplace ?? null,
          productType: query.productType,
          schemaVersion,
        },
      },
    })
    if (existing) {
      return this.prisma.categorySchema.update({
        where: { id: existing.id },
        data: {
          fetchedAt: new Date(),
          expiresAt: new Date(Date.now() + TWENTY_FOUR_HOURS_MS),
          isActive: true,
        },
      })
    }

    // New version — diff against the most recent cached row (if any),
    // log changes, then insert.
    const previous = await this.findLatestCache(query)
    if (previous) {
      await this.detectAndLogChanges(previous, schemaDefinition, query)
    }

    return this.prisma.categorySchema.create({
      data: {
        channel: 'AMAZON',
        marketplace: query.marketplace ?? null,
        productType: query.productType,
        schemaVersion,
        schemaDefinition: schemaDefinition as any,
        variationThemes: variationThemes as any,
        expiresAt: new Date(Date.now() + TWENTY_FOUR_HOURS_MS),
      },
    })
  }

  private async detectAndLogChanges(
    previous: { schemaDefinition: any },
    nextDef: Record<string, unknown>,
    query: SchemaQuery,
  ) {
    const prevDef = (previous.schemaDefinition ?? {}) as Record<string, any>
    const oldProps = (prevDef.properties ?? {}) as Record<string, any>
    const newProps = ((nextDef as any).properties ?? {}) as Record<string, any>
    const oldRequired = new Set<string>(
      Array.isArray(prevDef.required) ? prevDef.required : [],
    )
    const newRequired = new Set<string>(
      Array.isArray((nextDef as any).required) ? (nextDef as any).required : [],
    )

    const writes: any[] = []
    const baseFacets = {
      channel: query.channel,
      marketplace: query.marketplace ?? null,
      productType: query.productType,
    }

    for (const fieldId of Object.keys(newProps)) {
      if (!(fieldId in oldProps)) {
        writes.push(
          this.prisma.schemaChange.create({
            data: {
              ...baseFacets,
              changeType: 'FIELD_ADDED',
              fieldId,
              newValue: newProps[fieldId],
            },
          }),
        )
      } else if (
        normalizeType(oldProps[fieldId]) !== normalizeType(newProps[fieldId])
      ) {
        writes.push(
          this.prisma.schemaChange.create({
            data: {
              ...baseFacets,
              changeType: 'FIELD_TYPE_CHANGED',
              fieldId,
              oldValue: oldProps[fieldId],
              newValue: newProps[fieldId],
            },
          }),
        )
      }
    }

    for (const fieldId of Object.keys(oldProps)) {
      if (!(fieldId in newProps)) {
        writes.push(
          this.prisma.schemaChange.create({
            data: {
              ...baseFacets,
              changeType: 'FIELD_REMOVED',
              fieldId,
              oldValue: oldProps[fieldId],
            },
          }),
        )
      }
    }

    for (const fieldId of newRequired) {
      if (!oldRequired.has(fieldId)) {
        writes.push(
          this.prisma.schemaChange.create({
            data: {
              ...baseFacets,
              changeType: 'REQUIRED_CHANGED',
              fieldId,
              oldValue: { required: false },
              newValue: { required: true },
            },
          }),
        )
      }
    }
    for (const fieldId of oldRequired) {
      if (!newRequired.has(fieldId)) {
        writes.push(
          this.prisma.schemaChange.create({
            data: {
              ...baseFacets,
              changeType: 'REQUIRED_CHANGED',
              fieldId,
              oldValue: { required: true },
              newValue: { required: false },
            },
          }),
        )
      }
    }

    if (writes.length > 0) {
      await this.prisma.$transaction(writes)
    }
  }
}

/** Pull the variation_theme allowed values out of an Amazon schema.
 * Amazon nests this under `properties.variation_theme.items.properties.name.enum`
 * — but the exact path varies across product types. We look for the
 * common shapes and return null when nothing's found. */
function extractVariationThemes(
  schema: Record<string, unknown>,
): unknown | null {
  const props = (schema as any)?.properties
  if (!props || typeof props !== 'object') return null
  const vt = props.variation_theme
  if (!vt) return null
  // Common Amazon shape: array of objects with `name` enum.
  const enumPath =
    vt?.items?.properties?.name?.enum ??
    vt?.items?.properties?.name?.['enum'] ??
    null
  if (Array.isArray(enumPath)) return { themes: enumPath }
  return vt
}

/** Normalize a JSON Schema field for type comparison — we compare
 * just the `type` key (string|number|array|object) plus, for arrays,
 * the inner `items.type`. Field reorderings or unrelated description
 * tweaks don't trigger a FIELD_TYPE_CHANGED row. */
function normalizeType(field: any): string {
  if (!field || typeof field !== 'object') return ''
  const t = field.type ?? ''
  if (t === 'array') {
    const inner = field.items?.type ?? ''
    return `array<${inner}>`
  }
  return String(t)
}
