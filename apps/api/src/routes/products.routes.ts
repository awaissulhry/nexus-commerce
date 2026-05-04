import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import {
  getAvailableFields,
  getFieldDefinition,
} from '../services/pim/field-registry.service.js'
import {
  buildUploadPlan,
  parseUploadBuffer,
  summarisePlan,
  type PlanRow,
} from '../services/products/bulk-upload.service.js'
import { parseZipUpload } from '../services/products/bulk-zip-upload.service.js'
import {
  seedRealisticXavia,
  IMPORT_SOURCE as XAVIA_REALISTIC_IMPORT_SOURCE,
} from '../services/seed-xavia-realistic.service.js'

/**
 * Routes for bulk-operations: optimized fetch + atomic patch.
 * Mounted at /api in index.ts → endpoints are /api/products/bulk-fetch
 * and /api/products/bulk.
 */
const productsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/pim/fields — return field definitions for the column
  // selector. Optional filters:
  //   ?channels=AMAZON,EBAY      — include those channels' fields
  //   ?productTypes=OUTERWEAR    — include category-specific fields
  //   ?marketplace=IT            — pull dynamic Amazon schema fields
  //                                from cached CategorySchema rows
  // Cached 5 min — registry is mostly static; dynamic fields are
  // already DB-backed so the cost of refetching is small.
  fastify.get('/pim/fields', async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    const q = request.query as {
      channels?: string
      productTypes?: string
      marketplace?: string
    }
    const fields = await getAvailableFields({
      channels: q.channels?.split(',').map((s) => s.trim()).filter(Boolean),
      productTypes: q.productTypes
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      marketplace: q.marketplace ?? null,
    })
    return { fields, count: fields.length }
  })

  // GET /api/products — paginated catalog list for the /products page.
  //
  // Distinct from /products/bulk-fetch (bulk-ops, returns everything)
  // and /amazon/products/list (Amazon-only, hard-capped at 50). This
  // is the "browse the master catalog" endpoint:
  //
  //   ?page=1&limit=50&search=airmesh
  //   ?status=ACTIVE,DRAFT&channels=AMAZON,EBAY&stockLevel=low
  //   ?sort=updated|created|sku|name|price-asc|price-desc|stock-asc|stock-desc
  //
  // limit is clamped to 200 to prevent accidental fetch-all calls.
  // parentId=null is enforced so variations don't flood the page;
  // child SKUs live on the variations tab of /products/[id]/edit.
  fastify.get<{
    Querystring: {
      page?: string
      limit?: string
      search?: string
      status?: string
      channels?: string
      stockLevel?: string
      sort?: string
    }
  }>('/products', async (request, reply) => {
    try {
      const q = request.query
      const page = Math.max(parseInt(q.page ?? '1', 10) || 1, 1)
      const limit = Math.max(
        Math.min(parseInt(q.limit ?? '50', 10) || 50, 200),
        1,
      )
      const search = (q.search ?? '').trim()
      const statusList = (q.status ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
      const channelList = (q.channels ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
      const stockLevel = (q.stockLevel ?? 'all').toLowerCase()
      const sort = q.sort ?? 'updated'

      const where: any = { parentId: null }
      if (search) {
        where.OR = [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { brand: { contains: search, mode: 'insensitive' } },
          { gtin: { contains: search } },
        ]
      }
      if (statusList.length > 0) {
        where.status = { in: statusList }
      }
      if (channelList.length > 0) {
        where.syncChannels = { hasSome: channelList }
      }
      if (stockLevel === 'in') {
        where.totalStock = { gt: 0 }
      } else if (stockLevel === 'low') {
        where.totalStock = { gt: 0, lte: 5 }
      } else if (stockLevel === 'out') {
        where.totalStock = 0
      }

      const orderBy: any = (() => {
        switch (sort) {
          case 'created':
            return { createdAt: 'desc' }
          case 'sku':
            return { sku: 'asc' }
          case 'name':
            return { name: 'asc' }
          case 'price-asc':
            return { basePrice: 'asc' }
          case 'price-desc':
            return { basePrice: 'desc' }
          case 'stock-asc':
            return { totalStock: 'asc' }
          case 'stock-desc':
            return { totalStock: 'desc' }
          case 'updated':
          default:
            return { updatedAt: 'desc' }
        }
      })()

      const [rawProducts, total, statsRows] = await Promise.all([
        prisma.product.findMany({
          where,
          orderBy,
          take: limit,
          skip: (page - 1) * limit,
          select: {
            id: true,
            sku: true,
            name: true,
            brand: true,
            basePrice: true,
            totalStock: true,
            status: true,
            syncChannels: true,
            updatedAt: true,
            createdAt: true,
            isParent: true,
            // Use ProductImage (the table that actually exists in
            // Postgres) — the Image model is in schema.prisma but its
            // table was never migrated. Order by createdAt so the
            // oldest upload (typically the MAIN image) wins ties.
            images: {
              select: { url: true, type: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        }),
        prisma.product.count({ where }),
        // Stats reflect the FILTERED set so the header counts match
        // what's actually browsable. Five small aggregates.
        Promise.all([
          prisma.product.count({ where }),
          prisma.product.count({
            where: { ...where, status: 'ACTIVE' },
          }),
          prisma.product.count({
            where: { ...where, status: 'DRAFT' },
          }),
          prisma.product.count({
            where: { ...where, totalStock: { gt: 0 } },
          }),
          prisma.product.count({
            where: { ...where, totalStock: 0 },
          }),
        ]),
      ])

      const products = rawProducts.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        basePrice: Number(p.basePrice),
        totalStock: p.totalStock,
        status: p.status,
        syncChannels: p.syncChannels,
        updatedAt: p.updatedAt,
        createdAt: p.createdAt,
        isParent: p.isParent,
        imageUrl: p.images[0]?.url ?? null,
      }))

      return {
        products,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        stats: {
          total: statsRows[0],
          active: statsRows[1],
          draft: statsRows[2],
          inStock: statsRows[3],
          outOfStock: statsRows[4],
        },
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[products list] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // GET /api/products/bulk-fetch — single optimized SELECT for the
  // bulk-operations table. Plain Decimal coercion to numbers so the
  // client can sort/edit without parseFloat-ing everywhere.
  //
  // D.3d: optional ?channel=AMAZON&marketplace=IT params. When both
  // are set, each product gets a `_channelListing` field with the
  // matching ChannelListing row (or null if none exists). Used by the
  // bulk-ops table to render amazon_*/ebay_* cell values.
  fastify.get<{
    Querystring: { channel?: string; marketplace?: string }
  }>('/products/bulk-fetch', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=10')
      const channelParam = request.query.channel?.toUpperCase()
      const marketplaceParam = request.query.marketplace?.toUpperCase()
      const includeChannelListing =
        !!channelParam && !!marketplaceParam

      const rows = await prisma.product.findMany({
        select: {
          id: true,
          sku: true,
          name: true,
          basePrice: true,
          costPrice: true,
          minMargin: true,
          minPrice: true,
          maxPrice: true,
          totalStock: true,
          lowStockThreshold: true,
          brand: true,
          manufacturer: true,
          upc: true,
          ean: true,
          weightValue: true,
          weightUnit: true,
          // D.3j: dimensions
          dimLength: true,
          dimWidth: true,
          dimHeight: true,
          dimUnit: true,
          status: true,
          fulfillmentChannel: true,
          isParent: true,
          parentId: true,
          amazonAsin: true,
          ebayItemId: true,
          syncChannels: true,
          variantAttributes: true,
          updatedAt: true,
          // ── D.3a additions — verify migration applied ────────────
          gtin: true,
          cascadedFields: true,
          // ── D.3e: needed for category-specific attribute display
          categoryAttributes: true,
          productType: true,
        },
        // Parents first via parentId asc (NULLs first in Postgres asc),
        // then SKU.
        orderBy: [{ parentId: 'asc' }, { sku: 'asc' }],
      })

      // Coerce Decimal → number for JSON safety + cheap client compares
      let products: any[] = rows.map((p) => ({
        ...p,
        basePrice: Number(p.basePrice),
        costPrice: p.costPrice == null ? null : Number(p.costPrice),
        minMargin: p.minMargin == null ? null : Number(p.minMargin),
        minPrice: p.minPrice == null ? null : Number(p.minPrice),
        maxPrice: p.maxPrice == null ? null : Number(p.maxPrice),
        weightValue: p.weightValue == null ? null : Number(p.weightValue),
        dimLength: p.dimLength == null ? null : Number(p.dimLength),
        dimWidth: p.dimWidth == null ? null : Number(p.dimWidth),
        dimHeight: p.dimHeight == null ? null : Number(p.dimHeight),
      }))

      // Attach _channelListing for the requested context so the table
      // can render amazon_*/ebay_* cells from real data.
      if (includeChannelListing) {
        const productIds = products.map((p) => p.id)
        const listings = await prisma.channelListing.findMany({
          where: {
            productId: { in: productIds },
            channel: channelParam!,
            marketplace: marketplaceParam!,
          },
          select: {
            productId: true,
            title: true,
            description: true,
            price: true,
            quantity: true,
            listingStatus: true,
          },
        })
        const byProductId = new Map(
          listings.map((l) => [
            l.productId,
            {
              title: l.title,
              description: l.description,
              price: l.price == null ? null : Number(l.price),
              quantity: l.quantity,
              listingStatus: l.listingStatus,
            },
          ])
        )
        products = products.map((p) => ({
          ...p,
          _channelListing: byProductId.get(p.id) ?? null,
        }))
      }

      return {
        products,
        count: products.length,
        channelContext: includeChannelListing
          ? { channel: channelParam, marketplace: marketplaceParam }
          : null,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[products/bulk-fetch] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // PATCH /api/products/bulk
  //
  // Body: { changes: Array<{ id, field, value, cascade? }> }
  //
  // - Validates against ALLOWED_FIELDS, type-coerces, atomically
  //   applies survivors in a single Prisma transaction.
  // - cascade=true (D.3c): finds children of `id`, applies the same
  //   change to each, and pushes `field` onto each child's
  //   `cascadedFields` array (deduped on read).
  // - cascade=false on a child product: also removes `field` from
  //   that child's `cascadedFields` array — direct edit overrides
  //   any prior parent-cascaded value.
  //
  // Audit row captures:
  //   cascadeCount       — how many cascade fan-outs ran
  //   affectedChildren   — every child id touched by a cascade
  fastify.patch<{
    Body: {
      changes: Array<{
        id: string
        field: string
        value: unknown
        cascade?: boolean
      }>
      marketplaceContext?: {
        channel: 'AMAZON' | 'EBAY'
        marketplace: string
      }
      /** R.1 — multi-target fan-out. When set (and non-empty), every
       *  channel-field upsert runs once per matching context, so a
       *  single edit lands on AMAZON:IT + AMAZON:DE + AMAZON:FR in
       *  one PATCH. Falls back to `marketplaceContext` (singular) for
       *  backwards compat. */
      marketplaceContexts?: Array<{
        channel: 'AMAZON' | 'EBAY'
        marketplace: string
      }>
    }
  }>('/products/bulk', async (request, reply) => {
    const { changes, marketplaceContext, marketplaceContexts } =
      request.body ?? {}
    // Effective context list: prefer the new array, fall back to the
    // singular form, dedupe.
    const rawContexts: Array<{ channel: 'AMAZON' | 'EBAY'; marketplace: string }> =
      Array.isArray(marketplaceContexts) && marketplaceContexts.length > 0
        ? marketplaceContexts
        : marketplaceContext
        ? [marketplaceContext]
        : []
    const effectiveContexts = (() => {
      const seen = new Set<string>()
      const out: typeof rawContexts = []
      for (const c of rawContexts) {
        if (!c?.channel || !c?.marketplace) continue
        const k = `${c.channel}:${c.marketplace}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push(c)
      }
      return out
    })()
    // First context drives schema lookups (registry validation needs ONE
    // marketplace; rule of thumb is the schema is consistent across the
    // selected fan-out targets — selectors that mix incompatible
    // schemas get rejected per change anyway).
    const primaryContext = effectiveContexts[0] ?? null
    if (!Array.isArray(changes) || changes.length === 0) {
      return reply.code(400).send({ error: 'No changes provided' })
    }
    if (changes.length > 1000) {
      return reply.code(400).send({ error: 'Max 1000 changes per request' })
    }

    const ALLOWED_FIELDS = new Set([
      'name',
      'description', // D.5: ZIP upload + grid editing
      'basePrice',
      'costPrice',
      'minMargin',
      'minPrice',
      'maxPrice',
      'totalStock',
      'lowStockThreshold',
      'brand',
      'manufacturer',
      'upc',
      'ean',
      'weightValue',
      // D.3j: weight/dim units + dim values
      'weightUnit',
      'dimLength',
      'dimWidth',
      'dimHeight',
      'dimUnit',
      // D.3k: master-level GTIN
      'gtin',
      'status',
      'fulfillmentChannel',
    ])
    // D.3d: prefixed channel fields write to ChannelListing instead of
    // Product. Only the suffixes in this set are wired today; the rest
    // of amazon_*/ebay_* are still read-only in the registry.
    const CHANNEL_FIELD_MAP: Record<string, string> = {
      amazon_title: 'title',
      amazon_description: 'description',
      ebay_title: 'title',
      ebay_description: 'description',
    }
    const isChannelField = (f: string) =>
      Object.prototype.hasOwnProperty.call(CHANNEL_FIELD_MAP, f)
    const channelOf = (f: string): 'AMAZON' | 'EBAY' | null =>
      f.startsWith('amazon_') ? 'AMAZON' : f.startsWith('ebay_') ? 'EBAY' : null
    const isCategoryAttrField = (f: string) => f.startsWith('attr_')
    const NUMERIC_FIELDS = new Set([
      'basePrice',
      'costPrice',
      'minMargin',
      'minPrice',
      'maxPrice',
      'weightValue',
      // D.3j
      'dimLength',
      'dimWidth',
      'dimHeight',
    ])
    const INTEGER_FIELDS = new Set(['totalStock', 'lowStockThreshold'])
    const STATUS_VALUES = new Set(['ACTIVE', 'DRAFT', 'INACTIVE'])
    const CHANNEL_VALUES = new Set(['FBA', 'FBM'])
    // D.3j: unit enums for the editable weightUnit / dimUnit fields.
    const WEIGHT_UNIT_VALUES = new Set(['kg', 'g', 'lb', 'oz'])
    const DIM_UNIT_VALUES = new Set(['cm', 'mm', 'in'])
    // Locale-tolerant numeric coercion: accept Italian / European
    // decimal commas ("5,5") alongside the canonical period.
    const numericFromLocale = (raw: unknown): number => {
      if (typeof raw === 'number') return raw
      if (raw == null) return NaN
      const s = String(raw).trim()
      if (s === '') return NaN
      // Only swap commas to periods when there's no period already
      // (avoids "1,000.00" → "1.000.00"). For our domain, raw user
      // inputs like "5,5" or "5.5" are the common cases.
      if (s.includes('.') || !s.includes(',')) return Number(s)
      return Number(s.replace(',', '.'))
    }

    interface Validated {
      id: string
      field: string
      value: any
      cascade: boolean
    }
    interface ChangeError {
      id: string
      field: string
      error: string
    }

    const validated: Validated[] = []
    const errors: ChangeError[] = []

    for (const c of changes) {
      if (!c?.id || typeof c.id !== 'string') {
        errors.push({ id: c?.id ?? '', field: c?.field ?? '', error: 'Missing id' })
        continue
      }
      const isCh = isChannelField(c.field ?? '')
      const isAttr = isCategoryAttrField(c.field ?? '')
      if (
        !c.field ||
        (!ALLOWED_FIELDS.has(c.field) && !isCh && !isAttr)
      ) {
        errors.push({ id: c.id, field: c.field ?? '', error: 'Field not editable' })
        continue
      }
      // For attr_* fields, the registry must have it AND be editable.
      // D.3g: getFieldDefinition is now async and falls back to the
      // cached Amazon schemas when the id isn't in the static
      // hardcoded list — so any field exposed by /api/pim/fields with
      // a marketplace context is also acceptable here.
      if (isAttr) {
        const def = await getFieldDefinition(c.field, {
          marketplace: primaryContext?.marketplace ?? null,
        })
        if (!def || !def.editable) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'Unknown or read-only category attribute',
          })
          continue
        }
        // Validate select options
        if (def.type === 'select' && def.options && c.value !== null) {
          if (!def.options.includes(String(c.value))) {
            errors.push({
              id: c.id,
              field: c.field,
              error: `Must be one of: ${def.options.join(', ')}`,
            })
            continue
          }
        }
      }
      // Channel fields require at least one marketplace context whose
      // channel matches the field's prefix (amazon_* → AMAZON, ebay_*
      // → EBAY). With R.1 multi-targets, a request that selects e.g.
      // AMAZON:IT + EBAY:UK can carry both `amazon_title` and
      // `ebay_title` changes — each routes to its matching contexts.
      if (isCh) {
        if (effectiveContexts.length === 0) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'marketplaceContexts required for channel fields',
          })
          continue
        }
        const expectedChannel = channelOf(c.field)
        const matching = expectedChannel
          ? effectiveContexts.filter((ctx) => ctx.channel === expectedChannel)
          : effectiveContexts
        if (matching.length === 0) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Field belongs to ${expectedChannel} but no ${expectedChannel} target was selected`,
          })
          continue
        }
      }

      let value: any = c.value

      // Category attributes (attr_*) — text + select fields. Trim text,
      // pass select values through (validation already gated above).
      if (isAttr) {
        if (typeof value !== 'string' && value !== null && value !== undefined) {
          value = String(value)
        }
        if (typeof value === 'string') {
          const trimmed = value.trim()
          value = trimmed === '' ? null : trimmed
        }
        validated.push({
          id: c.id,
          field: c.field,
          value,
          cascade: !!c.cascade,
        })
        continue
      }

      // Channel fields are all text in D.3d (title, description). Trim,
      // null on empty.
      if (isCh) {
        if (typeof value !== 'string' && value !== null && value !== undefined) {
          value = String(value)
        }
        if (typeof value === 'string') {
          const trimmed = value.trim()
          value = trimmed === '' ? null : trimmed
        }
        // Length validation (lightweight — frontend already enforces)
        if (
          typeof value === 'string' &&
          c.field === 'amazon_title' &&
          value.length > 200
        ) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'Amazon title max 200 characters',
          })
          continue
        }
        if (
          typeof value === 'string' &&
          c.field === 'ebay_title' &&
          value.length > 80
        ) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'eBay title max 80 characters',
          })
          continue
        }
        validated.push({ id: c.id, field: c.field, value, cascade: !!c.cascade })
        continue
      }

      if (NUMERIC_FIELDS.has(c.field)) {
        if (value === '' || value === null || value === undefined) {
          value = null
        } else {
          const n = numericFromLocale(value)
          if (Number.isNaN(n)) {
            errors.push({ id: c.id, field: c.field, error: 'Invalid number' })
            continue
          }
          if (n < 0) {
            errors.push({ id: c.id, field: c.field, error: 'Must be ≥ 0' })
            continue
          }
          value = n
        }
      } else if (c.field === 'weightUnit') {
        const v = String(value ?? '').toLowerCase()
        if (!WEIGHT_UNIT_VALUES.has(v)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Weight unit must be one of ${Array.from(WEIGHT_UNIT_VALUES).join(', ')}`,
          })
          continue
        }
        value = v
      } else if (c.field === 'dimUnit') {
        const v = String(value ?? '').toLowerCase()
        if (!DIM_UNIT_VALUES.has(v)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Dimension unit must be one of ${Array.from(DIM_UNIT_VALUES).join(', ')}`,
          })
          continue
        }
        value = v
      } else if (c.field === 'gtin') {
        // Empty / null clears it.
        if (value === '' || value === null || value === undefined) {
          value = null
        } else {
          const digits = String(value).replace(/\D/g, '')
          if (digits.length < 8 || digits.length > 14) {
            errors.push({
              id: c.id,
              field: c.field,
              error: 'GTIN must be 8–14 digits',
            })
            continue
          }
          value = digits
        }
      } else if (INTEGER_FIELDS.has(c.field)) {
        if (value === '' || value === null || value === undefined) {
          value = 0
        } else {
          const n = parseInt(String(value), 10)
          if (Number.isNaN(n)) {
            errors.push({ id: c.id, field: c.field, error: 'Invalid integer' })
            continue
          }
          if (n < 0) {
            errors.push({ id: c.id, field: c.field, error: 'Must be ≥ 0' })
            continue
          }
          value = n
        }
      } else if (c.field === 'status') {
        const v = String(value ?? '').toUpperCase()
        if (!STATUS_VALUES.has(v)) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Status must be one of ${Array.from(STATUS_VALUES).join(', ')}`,
          })
          continue
        }
        value = v
      } else if (c.field === 'fulfillmentChannel') {
        if (value === '' || value === null || value === undefined) {
          value = null
        } else {
          const v = String(value).toUpperCase()
          if (!CHANNEL_VALUES.has(v)) {
            errors.push({
              id: c.id,
              field: c.field,
              error: `Channel must be one of ${Array.from(CHANNEL_VALUES).join(', ')}`,
            })
            continue
          }
          value = v
        }
      } else {
        // text fields — trim, coerce empty string to null only for
        // optional fields. name is required, leave as-is.
        if (typeof value !== 'string' && value !== null && value !== undefined) {
          value = String(value)
        }
        if (c.field === 'name') {
          if (!value || (typeof value === 'string' && value.trim().length === 0)) {
            errors.push({ id: c.id, field: c.field, error: 'Name cannot be empty' })
            continue
          }
          value = (value as string).trim()
        } else if (typeof value === 'string') {
          const trimmed = value.trim()
          value = trimmed === '' ? null : trimmed
        }
      }

      validated.push({ id: c.id, field: c.field, value, cascade: !!c.cascade })
    }

    // Nothing survived validation — do not open a transaction
    if (validated.length === 0) {
      await prisma.bulkOperation.create({
        data: {
          changeCount: changes.length,
          productCount: new Set(changes.map((c) => c.id)).size,
          changes: changes as any,
          status: 'FAILED',
          errors: errors as any,
        },
      })
      return reply.code(400).send({ errors })
    }

    // Apply survivors atomically. Per-row updates in a single
    // transaction (array form). With serverless max:1 connection and
    // sequential transactions, this is ~13ms per row.
    //
    // D.3c additions:
    //   - cascade=true: pre-fetches children for each cascading parent,
    //     adds extra updates for each child. cascadedFields gets the
    //     field name appended (deduped on read; allowing dups is fine
    //     and avoids an extra round-trip per child).
    //   - cascade=false on a child: removes the field from the child's
    //     cascadedFields array via raw SQL array_remove, so a direct
    //     edit cleanly overrides any prior cascade.
    try {
      const startTs = Date.now()
      const productIds = new Set(validated.map((v) => v.id))

      // Pre-fetch which validated targets are children (parentId set).
      // Used to decide whether to call array_remove on cascadedFields
      // when applying a non-cascade change.
      const targetIds = Array.from(productIds)
      const targetProducts = await prisma.product.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, parentId: true, isParent: true },
      })
      const childIdSet = new Set(
        targetProducts.filter((p) => p.parentId).map((p) => p.id)
      )

      // Pre-fetch children for cascading parents.
      const cascadingParents = validated.filter((v) => v.cascade)
      const childrenByParent = new Map<string, string[]>()
      let totalAffectedChildren = 0
      const allAffectedChildIds = new Set<string>()
      if (cascadingParents.length > 0) {
        const parentIds = Array.from(
          new Set(cascadingParents.map((v) => v.id))
        )
        const kids = await prisma.product.findMany({
          where: { parentId: { in: parentIds } },
          select: { id: true, parentId: true },
        })
        for (const k of kids) {
          if (!k.parentId) continue
          let arr = childrenByParent.get(k.parentId)
          if (!arr) {
            arr = []
            childrenByParent.set(k.parentId, arr)
          }
          arr.push(k.id)
          allAffectedChildIds.add(k.id)
        }
        totalAffectedChildren = allAffectedChildIds.size
      }

      // Build the transaction's update list. One Prisma promise per
      // statement; runs serially in array-form $transaction.
      const updates: any[] = []

      // Helper for ChannelListing upsert by (productId, channel,
      // marketplace). R.1 — fans out to every effectiveContext whose
      // channel matches the field's prefix, so one change targets all
      // selected markets in a single transaction. Returns an array of
      // Prisma promises (possibly empty) rather than a single one.
      const upsertChannelListings = (
        productId: string,
        field: string,
        value: any,
      ) => {
        if (effectiveContexts.length === 0) return []
        const stripped = CHANNEL_FIELD_MAP[field]
        if (!stripped) return []
        const expected = channelOf(field)
        const targets = expected
          ? effectiveContexts.filter((ctx) => ctx.channel === expected)
          : effectiveContexts
        return targets.map((ctx) => {
          const channelMarket = `${ctx.channel}_${ctx.marketplace}`
          return prisma.channelListing.upsert({
            where: {
              productId_channel_marketplace: {
                productId,
                channel: ctx.channel,
                marketplace: ctx.marketplace,
              },
            },
            create: {
              productId,
              channel: ctx.channel,
              channelMarket,
              region: ctx.marketplace,
              marketplace: ctx.marketplace,
              listingStatus: 'DRAFT',
              [stripped]: value,
            } as any,
            update: { [stripped]: value } as any,
          })
        })
      }

      // ── D.3e: pre-group attr_* changes per product ────────────────
      // We MERGE everything for one product into a single jsonb in
      // one UPDATE rather than emitting one statement per attr.
      // Map<productId, Record<strippedKey, value>> — separate maps
      // for direct vs cascade so cascade fan-out can read its own group.
      const attrDirectByProduct = new Map<string, Record<string, any>>()
      const attrCascadeByProduct = new Map<string, Record<string, any>>()
      const attrCascadeFieldNames = new Map<string, string[]>() // for cascadedFields tracking

      for (const v of validated) {
        if (!isCategoryAttrField(v.field)) continue
        const stripped = v.field.replace(/^attr_/, '')
        const target = v.cascade ? attrCascadeByProduct : attrDirectByProduct
        let bag = target.get(v.id)
        if (!bag) {
          bag = {}
          target.set(v.id, bag)
        }
        bag[stripped] = v.value
        if (v.cascade) {
          let names = attrCascadeFieldNames.get(v.id)
          if (!names) {
            names = []
            attrCascadeFieldNames.set(v.id, names)
          }
          names.push(v.field)
        }
      }

      // attr_* writers — use jsonb merge: COALESCE ensures null becomes
      // empty object first; the || operator does shallow merge so
      // existing keys not in the patch are preserved.
      const writeAttrMerge = (productId: string, patch: Record<string, any>) =>
        prisma.$executeRaw`
          UPDATE "Product"
          SET "categoryAttributes" = COALESCE("categoryAttributes", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
          WHERE id = ${productId}
        `

      for (const v of validated) {
        const isCh = isChannelField(v.field)
        const isAttr = isCategoryAttrField(v.field)

        // Skip individual attr_* loop iterations — handled in batched
        // writes below the main loop.
        if (isAttr) continue

        if (v.cascade) {
          // Cascade applies to the parent itself + all its children.
          // For channel fields, each "update" is a ChannelListing
          // upsert in the active marketplace context. cascadedFields
          // tracking still goes on the Product row so children can be
          // visually distinguished as inheriting.
          if (isCh) {
            updates.push(...upsertChannelListings(v.id, v.field, v.value))
            const kids = childrenByParent.get(v.id) ?? []
            for (const childId of kids) {
              updates.push(
                ...upsertChannelListings(childId, v.field, v.value),
              )
              // Track on Product.cascadedFields with the prefixed name
              updates.push(
                prisma.product.update({
                  where: { id: childId },
                  data: { cascadedFields: { push: v.field } } as any,
                })
              )
            }
          } else {
            updates.push(
              prisma.product.update({
                where: { id: v.id },
                data: { [v.field]: v.value } as any,
              })
            )
            const kids = childrenByParent.get(v.id) ?? []
            for (const childId of kids) {
              updates.push(
                prisma.product.update({
                  where: { id: childId },
                  data: {
                    [v.field]: v.value,
                    cascadedFields: { push: v.field },
                  } as any,
                })
              )
            }
          }
        } else if (isCh) {
          // Direct channel-field edit. With R.1 multi-targets this
          // upserts one ChannelListing row per matching context. For
          // children, also remove the prefixed field from
          // cascadedFields so future renders don't show "inherited."
          updates.push(...upsertChannelListings(v.id, v.field, v.value))
          if (childIdSet.has(v.id)) {
            updates.push(
              prisma.$executeRaw`
                UPDATE "Product"
                SET "cascadedFields" = array_remove("cascadedFields", ${v.field})
                WHERE id = ${v.id}
              `
            )
          }
        } else if (childIdSet.has(v.id)) {
          // Direct edit on a child Product field — also remove the
          // field from cascadedFields if it's there (override).
          updates.push(
            prisma.$executeRaw`
              UPDATE "Product"
              SET ${Prisma.raw(`"${v.field}"`)} = ${v.value as any},
                  "cascadedFields" = array_remove("cascadedFields", ${v.field})
              WHERE id = ${v.id}
            `
          )
        } else {
          // Direct edit on a parent or standalone Product field
          updates.push(
            prisma.product.update({
              where: { id: v.id },
              data: { [v.field]: v.value } as any,
            })
          )
        }
      }

      // ── D.3e: emit batched attr_* writes ───────────────────────────
      // Direct attr edits — one merged UPDATE per product. For children
      // we also array_remove the attr_* field names from cascadedFields
      // so a direct override clears the "inherited" marker (matching
      // the non-attr child override semantics above).
      for (const [productId, patch] of attrDirectByProduct) {
        updates.push(writeAttrMerge(productId, patch))
        if (childIdSet.has(productId)) {
          for (const stripped of Object.keys(patch)) {
            const fieldName = `attr_${stripped}`
            updates.push(
              prisma.$executeRaw`
                UPDATE "Product"
                SET "cascadedFields" = array_remove("cascadedFields", ${fieldName})
                WHERE id = ${productId}
              `
            )
          }
        }
      }

      // Cascade attr edits — merge into parent + every child, then
      // push the prefixed field names onto each child's cascadedFields.
      for (const [parentId, patch] of attrCascadeByProduct) {
        updates.push(writeAttrMerge(parentId, patch))
        const kids = childrenByParent.get(parentId) ?? []
        const fieldNames = attrCascadeFieldNames.get(parentId) ?? []
        for (const childId of kids) {
          updates.push(writeAttrMerge(childId, patch))
          for (const fieldName of fieldNames) {
            updates.push(
              prisma.product.update({
                where: { id: childId },
                data: { cascadedFields: { push: fieldName } } as any,
              })
            )
          }
        }
      }

      await prisma.$transaction(updates, {
        isolationLevel: 'ReadCommitted',
      })
      const elapsedMs = Date.now() - startTs

      const overallStatus =
        errors.length === 0 ? 'SUCCESS' : 'PARTIAL'

      await prisma.bulkOperation.create({
        data: {
          changeCount: changes.length,
          productCount: productIds.size,
          changes: validated as any,
          status: overallStatus,
          errors: errors.length ? (errors as any) : undefined,
          cascadeCount: cascadingParents.length,
          affectedChildren: Array.from(allAffectedChildIds),
        },
      })

      return {
        success: true,
        updated: validated.length,
        cascadeCount: cascadingParents.length,
        affectedChildren: totalAffectedChildren,
        errors: errors.length ? errors : undefined,
        elapsedMs,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[products/bulk] transaction failed')
      await prisma.bulkOperation
        .create({
          data: {
            changeCount: changes.length,
            productCount: new Set(changes.map((c) => c.id)).size,
            changes: changes as any,
            status: 'FAILED',
            errors: [{ error: error?.message ?? String(error) }] as any,
          },
        })
        .catch(() => {
          /* don't mask the real error with an audit-log failure */
        })
      return reply.code(500).send({
        error: 'Bulk update failed',
        message: error?.message ?? String(error),
      })
    }
  })

  // ── Performance-test seeding (admin-only — no auth gate but uses
  // ── importSource = 'PERFORMANCE_TEST' so cleanup can wipe them) ──
  //
  // POST /api/admin/seed-bulk-test  body: { target?: number }
  // Inserts batched test rows up to `target` (capped at 20k).
  // Idempotent via skipDuplicates on SKU unique.
  fastify.post<{ Body: { target?: number } }>(
    '/admin/seed-bulk-test',
    async (request, reply) => {
      const target = Math.min(
        Math.max(parseInt(String(request.body?.target ?? 10000), 10) || 10000, 0),
        20000
      )

      const existing = await prisma.product.count()
      const needed = target - existing
      if (needed <= 0) {
        return { ok: true, inserted: 0, total: existing, target }
      }

      const BRANDS = ['Xavia Racing', 'Test Brand A', 'Test Brand B', 'Performance Test']
      const STATUSES = ['ACTIVE', 'DRAFT', 'INACTIVE']
      const CHANNELS: string[][] = [['AMAZON'], ['EBAY'], ['AMAZON', 'EBAY'], []]

      const BATCH = 500
      let totalInserted = 0
      const startTs = Date.now()
      for (let i = 0; i < needed; i += BATCH) {
        const chunk = Math.min(BATCH, needed - i)
        const data = Array.from({ length: chunk }, (_, idx) => {
          const num = existing + i + idx
          return {
            sku: `TEST-${String(num).padStart(6, '0')}`,
            name: `Performance Test Product ${num} - ${BRANDS[num % 4]} Edition`,
            basePrice: parseFloat((10 + (num % 100) * 1.5).toFixed(2)),
            costPrice: parseFloat((5 + (num % 50) * 0.8).toFixed(2)),
            minMargin: 0.2,
            totalStock: num % 200,
            lowStockThreshold: 10,
            brand: BRANDS[num % 4],
            manufacturer: BRANDS[num % 4],
            upc: `${1000000000 + num}`,
            status: STATUSES[num % 3],
            syncChannels: CHANNELS[num % 4],
            isParent: false,
            amazonAsin:
              num % 3 === 0 ? `B0TEST${String(num).padStart(5, '0')}` : null,
            importSource: 'PERFORMANCE_TEST',
          }
        })
        try {
          const r = await prisma.product.createMany({ data, skipDuplicates: true })
          totalInserted += r.count
        } catch (error: any) {
          fastify.log.error(
            { err: error, batchOffset: i },
            '[seed-bulk-test] batch failed'
          )
          return reply.code(500).send({
            error: error?.message ?? String(error),
            partialInserted: totalInserted,
          })
        }
      }

      const elapsedMs = Date.now() - startTs
      const total = await prisma.product.count()
      return { ok: true, inserted: totalInserted, total, target, elapsedMs }
    }
  )

  // Helper: delete a set of Products + every dependent row whose FK
  // doesn't cascade. Five tables in the schema reference Product
  // without `onDelete: Cascade` (ProductImage, MarketplaceSync,
  // Listing, StockLog, FBAShipmentItem) — bare deleteMany on Product
  // hits a FK violation if any of those have rows. This wraps the
  // dependents + the Product delete in a single transaction.
  const cascadeDeleteProducts = async (
    where: Prisma.ProductWhereInput,
  ): Promise<{
    deleted: number
    dependents: {
      productImages: number
      marketplaceSyncs: number
      listings: number
      stockLogs: number
      fbaShipmentItems: number
    }
  }> => {
    const products = await prisma.product.findMany({
      where,
      select: { id: true },
    })
    const ids = products.map((p) => p.id)
    if (ids.length === 0) {
      return {
        deleted: 0,
        dependents: {
          productImages: 0,
          marketplaceSyncs: 0,
          listings: 0,
          stockLogs: 0,
          fbaShipmentItems: 0,
        },
      }
    }
    const productIdFilter = { productId: { in: ids } }
    const result = await prisma.$transaction(async (tx) => {
      const productImages = await tx.productImage.deleteMany({
        where: productIdFilter,
      })
      const marketplaceSyncs = await tx.marketplaceSync.deleteMany({
        where: productIdFilter,
      })
      const listings = await tx.listing.deleteMany({
        where: productIdFilter,
      })
      const stockLogs = await tx.stockLog.deleteMany({
        where: productIdFilter,
      })
      const fbaShipmentItems = await tx.fBAShipmentItem.deleteMany({
        where: productIdFilter,
      })
      const products = await tx.product.deleteMany({
        where: { id: { in: ids } },
      })
      return {
        deleted: products.count,
        dependents: {
          productImages: productImages.count,
          marketplaceSyncs: marketplaceSyncs.count,
          listings: listings.count,
          stockLogs: stockLogs.count,
          fbaShipmentItems: fbaShipmentItems.count,
        },
      }
    })
    return result
  }

  // DELETE /api/admin/cleanup-bulk-test
  // Removes every Product row marked importSource = 'PERFORMANCE_TEST'.
  // Cascades manually to dependents that don't FK-cascade.
  fastify.delete('/admin/cleanup-bulk-test', async (_request, reply) => {
    try {
      const result = await cascadeDeleteProducts({
        importSource: 'PERFORMANCE_TEST',
      })
      return { ok: true, ...result }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/admin/seed-xavia-realistic
  // Generates ~67 parent products + ~1,272 ProductVariation rows
  // covering 6 motorcycle-gear categories with multi-dimensional
  // variations. Idempotent (Product.sku and ProductVariation.sku
  // are unique). See services/seed-xavia-realistic.service.ts for
  // the full template definitions.
  fastify.post('/admin/seed-xavia-realistic', async (_request, reply) => {
    const startTs = Date.now()
    try {
      const summary = await seedRealisticXavia(prisma as any, () => {
        // Quiet — would flood Railway logs at 67 parent rows. The
        // returned summary already has the byCategory counts.
      })
      return {
        ok: true,
        elapsedMs: Date.now() - startTs,
        ...summary,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[seed-xavia-realistic] failed')
      return reply.code(500).send({
        ok: false,
        error: error?.message ?? String(error),
      })
    }
  })

  // DELETE /api/admin/cleanup-xavia-realistic
  // Removes every Product row marked importSource =
  // 'XAVIA_REALISTIC_TEST'. Uses the same cascade helper as
  // cleanup-bulk-test in case a future code path syncs these
  // products into MarketplaceSync / Listing / etc.
  fastify.delete('/admin/cleanup-xavia-realistic', async (_request, reply) => {
    try {
      const result = await cascadeDeleteProducts({
        importSource: XAVIA_REALISTIC_IMPORT_SOURCE,
      })
      return { ok: true, ...result }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── D.4: CSV / XLSX bulk upload ────────────────────────────────
  //
  // POST /api/products/bulk-upload
  //   multipart/form-data with one file. Parses + validates against
  //   the field registry, writes a BulkOperation row with status
  //   PENDING_APPLY holding the validated plan, returns
  //   { uploadId, preview }.
  fastify.post('/products/bulk-upload', async (request, reply) => {
    try {
      const part = await (request as any).file?.()
      if (!part) {
        return reply.code(400).send({ error: 'No file in request' })
      }
      const filename: string = part.filename ?? 'upload'
      const buf: Buffer = await part.toBuffer()
      let parsed
      try {
        parsed = parseUploadBuffer(filename, buf)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'Parse failed' })
      }
      let plan
      try {
        plan = await buildUploadPlan(prisma, filename, parsed.rows)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'Validation failed' })
      }

      // Persist the plan so apply can replay without re-parsing. Only
      // include rows that have at least one change OR at least one
      // error — fully empty rows would just bloat the JSON.
      const planForDb: PlanRow[] = plan.rows.filter(
        (r) => r.changes.length > 0 || r.errors.length > 0,
      )
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000) // 30 min
      const summary = summarisePlan(plan)

      const op = await prisma.bulkOperation.create({
        data: {
          status: 'PENDING_APPLY',
          productCount: summary.toUpdate,
          changeCount: 0, // will be set on apply
          changes: planForDb as any,
          errors:
            summary.errors.length > 0 ? (summary.errors as any) : undefined,
          uploadFilename: filename,
          expiresAt,
        },
      })

      return {
        uploadId: op.id,
        preview: {
          ...summary,
          warnings: parsed.warnings,
          expiresAt: expiresAt.toISOString(),
        },
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[products/bulk-upload] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/products/bulk-upload-zip
  //   D.5: ZIP archive with one folder per SKU. Each folder may
  //   carry a data.json (field updates) and/or description.html.
  //   Images/ subfolders + other files are surfaced as warnings; the
  //   apply path is the same as CSV uploads.
  fastify.post('/products/bulk-upload-zip', async (request, reply) => {
    try {
      const part = await (request as any).file?.()
      if (!part) {
        return reply.code(400).send({ error: 'No file in request' })
      }
      const filename: string = part.filename ?? 'upload.zip'
      if (!/\.zip$/i.test(filename)) {
        return reply
          .code(400)
          .send({ error: 'Expected a .zip file' })
      }
      const buf: Buffer = await part.toBuffer()
      let result
      try {
        result = await parseZipUpload(prisma, filename, buf)
      } catch (e: any) {
        return reply.code(400).send({ error: e?.message ?? 'Parse failed' })
      }

      const planForDb: PlanRow[] = result.rows.filter(
        (r) => r.changes.length > 0 || r.errors.length > 0,
      )
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
      const summary = summarisePlan(result)

      const op = await prisma.bulkOperation.create({
        data: {
          status: 'PENDING_APPLY',
          productCount: summary.toUpdate,
          changeCount: 0,
          changes: planForDb as any,
          errors:
            summary.errors.length > 0 ? (summary.errors as any) : undefined,
          uploadFilename: filename,
          expiresAt,
        },
      })

      return {
        uploadId: op.id,
        preview: {
          ...summary,
          warnings: result.warnings,
          expiresAt: expiresAt.toISOString(),
        },
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[products/bulk-upload-zip] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/products/bulk-apply
  //   body: { uploadId }
  //   Reads the PENDING_APPLY row, applies in chunks of 500, flips
  //   status to SUCCESS / PARTIAL / FAILED with completedAt.
  fastify.post<{ Body: { uploadId?: string } }>(
    '/products/bulk-apply',
    async (request, reply) => {
      const uploadId = request.body?.uploadId
      if (!uploadId) {
        return reply.code(400).send({ error: 'uploadId required' })
      }
      const op = await prisma.bulkOperation.findUnique({
        where: { id: uploadId },
      })
      if (!op) {
        return reply.code(404).send({ error: 'Upload not found' })
      }
      if (op.status !== 'PENDING_APPLY') {
        return reply
          .code(409)
          .send({ error: `Upload already ${op.status.toLowerCase()}` })
      }
      if (op.expiresAt && op.expiresAt.getTime() < Date.now()) {
        return reply.code(410).send({ error: 'Upload preview has expired' })
      }

      const planRows = (op.changes as unknown as PlanRow[]) ?? []
      // D.5: split scalar field changes from category-attribute
      // changes. Scalars become prisma.product.update; attr_* are
      // grouped per-product into a single jsonb merge UPDATE so we
      // don't blow away keys that aren't in this upload.
      const scalarChanges: Array<{
        productId: string
        field: string
        value: unknown
      }> = []
      const attrByProduct = new Map<string, Record<string, unknown>>()
      for (const r of planRows) {
        if (!r.productId) continue
        for (const c of r.changes) {
          if (c.field.startsWith('attr_')) {
            const stripped = c.field.replace(/^attr_/, '')
            let bag = attrByProduct.get(r.productId)
            if (!bag) {
              bag = {}
              attrByProduct.set(r.productId, bag)
            }
            bag[stripped] = c.newValue
          } else {
            scalarChanges.push({
              productId: r.productId,
              field: c.field,
              value: c.newValue,
            })
          }
        }
      }

      const totalUnits = scalarChanges.length + attrByProduct.size
      if (totalUnits === 0) {
        await prisma.bulkOperation.update({
          where: { id: op.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            errors: [{ message: 'No applicable changes' }] as any,
          },
        })
        return reply.code(400).send({ error: 'No applicable changes' })
      }

      const writeAttrMerge = (productId: string, patch: Record<string, unknown>) =>
        prisma.$executeRaw`
          UPDATE "Product"
          SET "categoryAttributes" = COALESCE("categoryAttributes", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
          WHERE id = ${productId}
        `

      const startTs = Date.now()
      const CHUNK = 500
      let applied = 0
      const chunkErrors: Array<{ chunkStart: number; error: string }> = []

      // Build a single ordered list of Prisma promises so chunking is
      // simple. Scalar edges come first, then per-product attr merges
      // — each contributes one slot regardless of how many keys it
      // touches inside the jsonb blob.
      const pendingOps: Array<() => Prisma.PrismaPromise<unknown>> = []
      for (const c of scalarChanges) {
        pendingOps.push(() =>
          prisma.product.update({
            where: { id: c.productId },
            data: { [c.field]: c.value as any } as any,
          }),
        )
      }
      for (const [productId, patch] of attrByProduct) {
        pendingOps.push(() => writeAttrMerge(productId, patch))
      }

      for (let i = 0; i < pendingOps.length; i += CHUNK) {
        const slice = pendingOps.slice(i, i + CHUNK).map((fn) => fn())
        try {
          await prisma.$transaction(slice as any, {
            isolationLevel: 'ReadCommitted',
          })
          applied += slice.length
        } catch (err: any) {
          chunkErrors.push({
            chunkStart: i,
            error: err?.message ?? String(err),
          })
        }
      }

      const elapsedMs = Date.now() - startTs
      const finalStatus =
        applied === pendingOps.length
          ? 'SUCCESS'
          : applied === 0
          ? 'FAILED'
          : 'PARTIAL'

      await prisma.bulkOperation.update({
        where: { id: op.id },
        data: {
          status: finalStatus,
          changeCount: applied,
          completedAt: new Date(),
          errors:
            chunkErrors.length > 0 ? (chunkErrors as any) : op.errors ?? undefined,
        },
      })

      return {
        applied,
        total: pendingOps.length,
        errors: chunkErrors,
        status: finalStatus,
        elapsedMs,
      }
    },
  )

  // GET /api/products/bulk-template?view=catalog
  //   CSV with editable field headers + a single sample row that
  //   demonstrates the format (including weight/dim unit suffixes).
  fastify.get<{ Querystring: { view?: string } }>(
    '/products/bulk-template',
    async (request, reply) => {
      const view = (request.query?.view ?? 'full').toLowerCase()
      const fields = await getAvailableFields({})
      // Always include sku as the join key + every editable field.
      // The view filter just biases the column order so the user
      // sees the most relevant ones first when they open the file.
      const editable = fields.filter((f) => f.editable)
      const headerOrder: string[] = ['sku']
      const sortKey = (id: string): number => {
        if (view === 'pricing') {
          return [
            'name',
            'basePrice',
            'costPrice',
            'minMargin',
            'minPrice',
            'maxPrice',
          ].indexOf(id)
        }
        if (view === 'inventory') {
          return [
            'name',
            'totalStock',
            'lowStockThreshold',
            'fulfillmentChannel',
          ].indexOf(id)
        }
        if (view === 'physical') {
          return [
            'weightValue',
            'weightUnit',
            'dimLength',
            'dimWidth',
            'dimHeight',
            'dimUnit',
          ].indexOf(id)
        }
        return -1
      }
      const sorted = [...editable].sort((a, b) => {
        const ai = sortKey(a.id)
        const bi = sortKey(b.id)
        if (ai === -1 && bi === -1) return a.id.localeCompare(b.id)
        if (ai === -1) return 1
        if (bi === -1) return -1
        return ai - bi
      })
      for (const f of sorted) {
        if (f.id !== 'sku') headerOrder.push(f.id)
      }

      // Sample row — one example value per field showing format.
      const sampleByField: Record<string, string> = {
        sku: 'EXAMPLE-SKU-001',
        name: 'Example product name',
        brand: 'Brand X',
        manufacturer: 'Brand X Mfg',
        status: 'ACTIVE',
        fulfillmentChannel: 'FBA',
        basePrice: '49.95',
        costPrice: '18.50',
        minMargin: '0.20',
        minPrice: '40.00',
        maxPrice: '79.95',
        totalStock: '100',
        lowStockThreshold: '10',
        upc: '123456789012',
        ean: '1234567890123',
        gtin: '12345678901234',
        weightValue: '5kg',
        weightUnit: 'kg',
        dimLength: '60cm',
        dimWidth: '40cm',
        dimHeight: '20cm',
        dimUnit: 'cm',
      }

      const csvEscape = (v: string) =>
        /[\t\n",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v

      const headerRow = headerOrder.map(csvEscape).join(',')
      const sampleRow = headerOrder
        .map((id) => csvEscape(sampleByField[id] ?? ''))
        .join(',')
      const csv = `${headerRow}\n${sampleRow}\n`

      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="nexus-template-${view}.csv"`,
        )
      return csv
    },
  )

  // R.2 — schema-driven bulk attribute update across products ×
  // marketplaces. Synchronous; returns per-tuple success/error so the
  // modal can render a result toast without polling. Same field-id
  // semantics as the per-listing PUT route (item_name → title etc.).
  fastify.post<{
    Body: {
      productIds: string[]
      marketplaceContexts: Array<{
        channel: 'AMAZON' | 'EBAY'
        marketplace: string
      }>
      attributes: Record<string, string | number | boolean | null>
      variantAttributes?: Record<
        string,
        Record<string, string | number | boolean | null>
      >
    }
  }>(
    '/products/bulk-schema-update',
    async (request, reply) => {
      const { productIds, marketplaceContexts, attributes, variantAttributes } =
        request.body ?? {}
      if (!Array.isArray(productIds) || productIds.length === 0) {
        return reply.code(400).send({ error: 'productIds required' })
      }
      if (productIds.length > 1000) {
        return reply.code(400).send({ error: 'Max 1000 productIds per request' })
      }
      if (
        !Array.isArray(marketplaceContexts) ||
        marketplaceContexts.length === 0
      ) {
        return reply
          .code(400)
          .send({ error: 'marketplaceContexts required (one or more)' })
      }
      if (!attributes || typeof attributes !== 'object') {
        return reply.code(400).send({ error: 'attributes required' })
      }

      // Pre-load existing listings for every (product × context) so the
      // shallow-merge into platformAttributes preserves keys we're not
      // touching. One findMany covers all targets.
      const targetKeys = marketplaceContexts.flatMap((ctx) =>
        productIds.map((pid) => ({
          productId: pid,
          channel: ctx.channel,
          marketplace: ctx.marketplace,
        })),
      )
      const existing = await prisma.channelListing.findMany({
        where: {
          OR: marketplaceContexts.map((ctx) => ({
            productId: { in: productIds },
            channel: ctx.channel,
            marketplace: ctx.marketplace,
          })),
        },
        select: {
          id: true,
          productId: true,
          channel: true,
          marketplace: true,
          platformAttributes: true,
        },
      })
      const existingByKey = new Map(
        existing.map((l) => [
          `${l.productId}:${l.channel}:${l.marketplace}`,
          l,
        ]),
      )

      const errors: Array<{
        productId: string
        channel: string
        marketplace: string
        error: string
      }> = []
      let updated = 0

      // Mirror the per-listing PUT logic: split known field ids into
      // their dedicated columns, merge the rest into
      // platformAttributes.attributes (and .variants).
      const ops: any[] = []
      for (const tk of targetKeys) {
        const key = `${tk.productId}:${tk.channel}:${tk.marketplace}`
        const channelMarket = `${tk.channel}_${tk.marketplace}`
        const data: Record<string, any> = {}

        // Split attributes into columns + passthrough
        const passthrough: Record<string, unknown> = {}
        for (const [fieldId, value] of Object.entries(attributes)) {
          if (fieldId === 'item_name' && typeof value === 'string') {
            data.title = value
          } else if (
            fieldId === 'product_description' &&
            typeof value === 'string'
          ) {
            data.description = value
          } else if (fieldId === 'bullet_point') {
            if (typeof value === 'string') {
              try {
                const parsed = JSON.parse(value)
                if (Array.isArray(parsed)) {
                  data.bulletPointsOverride = parsed.filter(
                    (s) => typeof s === 'string' && s.length > 0,
                  )
                } else {
                  data.bulletPointsOverride = [value]
                }
              } catch {
                data.bulletPointsOverride = [value]
              }
            } else if (Array.isArray(value)) {
              data.bulletPointsOverride = (value as unknown[]).filter(
                (s) => typeof s === 'string' && (s as string).length > 0,
              )
            }
          } else {
            passthrough[fieldId] = value
          }
        }

        // platformAttributes shallow merge with existing slice.
        const ex = existingByKey.get(key)
        const exPA = (ex?.platformAttributes as Record<string, any> | null) ?? null
        let nextPA: Record<string, any> | null = null
        if (Object.keys(passthrough).length > 0) {
          const exAttrs =
            exPA && typeof exPA.attributes === 'object'
              ? (exPA.attributes as Record<string, unknown>)
              : {}
          const merged: Record<string, unknown> = { ...exAttrs }
          for (const [k, v] of Object.entries(passthrough)) {
            if (v === null || v === undefined || v === '') {
              delete merged[k]
            } else {
              merged[k] = v
            }
          }
          nextPA = { ...(exPA ?? {}), attributes: merged }
        }
        if (variantAttributes && typeof variantAttributes === 'object') {
          const exVariants =
            exPA && typeof exPA.variants === 'object'
              ? (exPA.variants as Record<string, Record<string, unknown>>)
              : {}
          const mergedVariants: Record<string, Record<string, unknown>> = {
            ...exVariants,
          }
          for (const [variationId, slice] of Object.entries(variantAttributes)) {
            const prev = mergedVariants[variationId] ?? {}
            const next: Record<string, unknown> = { ...prev }
            for (const [fieldId, v] of Object.entries(slice ?? {})) {
              if (v === null || v === undefined || v === '') {
                delete next[fieldId]
              } else {
                next[fieldId] = v
              }
            }
            if (Object.keys(next).length === 0) {
              delete mergedVariants[variationId]
            } else {
              mergedVariants[variationId] = next
            }
          }
          nextPA = {
            ...(exPA ?? {}),
            ...(nextPA ?? {}),
            variants: mergedVariants,
          }
        }
        if (nextPA !== null) data.platformAttributes = nextPA

        ops.push(
          prisma.channelListing
            .upsert({
              where: {
                productId_channel_marketplace: {
                  productId: tk.productId,
                  channel: tk.channel,
                  marketplace: tk.marketplace,
                },
              },
              create: {
                productId: tk.productId,
                channel: tk.channel,
                channelMarket,
                region: tk.marketplace,
                marketplace: tk.marketplace,
                listingStatus: 'DRAFT',
                ...data,
              } as any,
              update: data,
            })
            .then(() => {
              updated++
              return null
            })
            .catch((err: unknown) => {
              errors.push({
                productId: tk.productId,
                channel: tk.channel,
                marketplace: tk.marketplace,
                error: err instanceof Error ? err.message : String(err),
              })
              return null
            }),
        )
      }
      await Promise.all(ops)

      return { updated, skipped: 0, errors }
    },
  )
}

export default productsRoutes
