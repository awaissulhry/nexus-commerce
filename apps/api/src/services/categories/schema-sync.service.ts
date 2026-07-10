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
import { extractEnumLabels } from './enum-labels.js'

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

  // VL.1 — in-memory wire→English enum-label cache per (marketplace, productType).
  private static enLabelCache = new Map<string, { at: number; labels: Record<string, Record<string, string>> }>()

  /**
   * VL.1 — wire→English enum-label map per field, fetched from the en_US schema.
   * Amazon enum WIRE values are canonical (identical across markets); only the
   * display (`enumNames`) localizes. So the en_US enumNames give the
   * operator-facing English label for each canonical wire value. In-memory
   * cached (24h); returns {} when SP-API is unavailable (caller falls back to
   * the wire value).
   */
  async getEnglishEnumLabels(
    marketplace: string,
    productType: string,
  ): Promise<Record<string, Record<string, string>>> {
    const key = `${marketplace}:${productType}`
    const hit = CategorySchemaService.enLabelCache.get(key)
    if (hit && Date.now() - hit.at < TWENTY_FOUR_HOURS_MS) return hit.labels

    let labels: Record<string, Record<string, string>> = {}
    if (this.amazon.isConfigured()) {
      try {
        const sp = await (this.amazon as any).getClient()
        const envelope = (await sp.callAPI({
          operation: 'getDefinitionsProductType',
          endpoint: 'productTypeDefinitions',
          version: '2020-09-01',
          path: { productType },
          query: { marketplaceIds: [amazonMarketplaceId(marketplace)], requirements: 'LISTING', locale: 'en_US' },
        })) as AmazonProductTypeMeta
        const link = envelope?.schema?.link?.resource
        if (link) {
          const res = await fetch(link)
          if (res.ok) labels = extractEnumLabels((await res.json()) as Record<string, unknown>)
        }
      } catch {
        labels = {}
      }
    }
    CategorySchemaService.enLabelCache.set(key, { at: Date.now(), labels })
    return labels
  }

  /** VL.2 — wire→localized enum-label map per field, from the CACHED market
   *  schema (no SP-API fetch). Powers the per-market display preview
   *  ("IT → Impermeabile"). Returns {} when the market schema isn't cached. */
  async getLocalizedEnumLabels(
    marketplace: string,
    productType: string,
  ): Promise<Record<string, Record<string, string>>> {
    const row = await this.findLatestCache({ channel: 'AMAZON', marketplace, productType })
    const def = (row?.schemaDefinition ?? null) as Record<string, unknown> | null
    return def ? extractEnumLabels(def) : {}
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
      // Also write schemaDefinition when __propertyGroups is now available
      // but wasn't stored yet (schemas cached before FF.10 won't have it).
      const needsDefinitionUpdate =
        envelope.propertyGroups &&
        !(existing.schemaDefinition as any)?.__propertyGroups

      return this.prisma.categorySchema.update({
        where: { id: existing.id },
        data: {
          fetchedAt: new Date(),
          expiresAt: new Date(Date.now() + TWENTY_FOUR_HOURS_MS),
          isActive: true,
          ...(needsDefinitionUpdate ? { schemaDefinition: schemaDefinition as any } : {}),
        },
      })
    }

    // New version — diff against the most recent cached row (if any),
    // log changes, then insert.
    const previous = await this.findLatestCache(query)
    if (previous) {
      await this.detectAndLogChanges(previous, schemaDefinition, query)
    }

    // UFX P6c — visibility: a NEW schema version landing in the cache is what
    // invalidates every manifest built on the old one (the manifest's
    // schemaVersion fingerprint changes with it), so make the rotation
    // greppable in the server logs.
    console.info(
      `[schema-sync] NEW schema cached: ${query.channel} ${query.marketplace ?? '-'} ${query.productType} ` +
      `version ${previous?.schemaVersion ?? '(first fetch)'} → ${schemaVersion}`,
    )

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

    // ALA Phase 5 — deprecation awareness. Amazon's custom vocabulary flags
    // retiring fields/values via `replacedBy` (field replacement) and
    // `enumDeprecated` (value retirement). We log a change row only when a
    // deprecation NEWLY appears (diff old vs new), so operators get warned to
    // migrate off a field/enum BEFORE Amazon removes it and submits start failing.
    const oldDep = extractDeprecations(oldProps)
    const newDep = extractDeprecations(newProps)
    for (const [fieldId, replacement] of newDep.replacedBy) {
      if (!oldDep.replacedBy.has(fieldId)) {
        writes.push(
          this.prisma.schemaChange.create({
            data: { ...baseFacets, changeType: 'FIELD_DEPRECATED', fieldId, newValue: { replacedBy: replacement } },
          }),
        )
      }
    }
    for (const [fieldId, values] of newDep.deprecatedEnums) {
      const old = oldDep.deprecatedEnums.get(fieldId) ?? new Set<string>()
      const newlyDeprecated = [...values].filter((v) => !old.has(v))
      if (newlyDeprecated.length > 0) {
        writes.push(
          this.prisma.schemaChange.create({
            data: { ...baseFacets, changeType: 'ENUM_DEPRECATED', fieldId, newValue: { deprecatedValues: newlyDeprecated } },
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

/** Recursively collect every value found for `key` anywhere in a subtree. */
function collectKey(node: any, key: string, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const x of node) collectKey(x, key, out)
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v)
    collectKey(v, key, out)
  }
  return out
}

/**
 * ALA Phase 5 — pull Amazon deprecation signals from a properties map.
 *   - `replacedBy` (string) anywhere in a property subtree → the FIELD is being
 *     replaced (deprecated).
 *   - `enumDeprecated` (array of values) → those ENUM values are retiring.
 * Conservative: only these unambiguous custom-vocab keywords; `$lifecycle` on its
 * own (which also describes non-deprecation changes) is not treated as deprecation.
 */
export function extractDeprecations(props: Record<string, any>): {
  replacedBy: Map<string, string>
  deprecatedEnums: Map<string, Set<string>>
} {
  const replacedBy = new Map<string, string>()
  const deprecatedEnums = new Map<string, Set<string>>()
  for (const [fieldId, prop] of Object.entries(props ?? {})) {
    const rep = collectKey(prop, 'replacedBy').find((v) => typeof v === 'string' && v)
    if (typeof rep === 'string') replacedBy.set(fieldId, rep)
    const enumDep = collectKey(prop, 'enumDeprecated').flat().map(String).filter(Boolean)
    if (enumDep.length) deprecatedEnums.set(fieldId, new Set(enumDep))
  }
  return { replacedBy, deprecatedEnums }
}
