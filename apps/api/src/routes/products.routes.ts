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
    }
  }>('/products/bulk', async (request, reply) => {
    const { changes, marketplaceContext } = request.body ?? {}
    if (!Array.isArray(changes) || changes.length === 0) {
      return reply.code(400).send({ error: 'No changes provided' })
    }
    if (changes.length > 1000) {
      return reply.code(400).send({ error: 'Max 1000 changes per request' })
    }

    const ALLOWED_FIELDS = new Set([
      'name',
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
          marketplace: marketplaceContext?.marketplace ?? null,
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
      // Channel fields require marketplaceContext to know which
      // ChannelListing to upsert.
      if (isCh) {
        if (!marketplaceContext?.channel || !marketplaceContext?.marketplace) {
          errors.push({
            id: c.id,
            field: c.field,
            error: 'marketplaceContext required for channel fields',
          })
          continue
        }
        const expectedChannel = channelOf(c.field)
        if (expectedChannel && expectedChannel !== marketplaceContext.channel) {
          errors.push({
            id: c.id,
            field: c.field,
            error: `Field belongs to ${expectedChannel} but context is ${marketplaceContext.channel}`,
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

      // Helper for ChannelListing upsert by (productId, channel, marketplace)
      const upsertChannelListing = (
        productId: string,
        field: string,
        value: any
      ) => {
        if (!marketplaceContext) return null
        const stripped = CHANNEL_FIELD_MAP[field]
        if (!stripped) return null
        const channelMarket = `${marketplaceContext.channel}_${marketplaceContext.marketplace}`
        return prisma.channelListing.upsert({
          where: {
            productId_channel_marketplace: {
              productId,
              channel: marketplaceContext.channel,
              marketplace: marketplaceContext.marketplace,
            },
          },
          create: {
            productId,
            channel: marketplaceContext.channel,
            channelMarket,
            region: marketplaceContext.marketplace,
            marketplace: marketplaceContext.marketplace,
            listingStatus: 'DRAFT',
            [stripped]: value,
          } as any,
          update: { [stripped]: value } as any,
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
            const parentUpsert = upsertChannelListing(v.id, v.field, v.value)
            if (parentUpsert) updates.push(parentUpsert)
            const kids = childrenByParent.get(v.id) ?? []
            for (const childId of kids) {
              const kidUpsert = upsertChannelListing(childId, v.field, v.value)
              if (kidUpsert) updates.push(kidUpsert)
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
          // Direct channel-field edit (works for parents, children, and
          // standalone — they all map to a single ChannelListing row).
          // For children, also remove the prefixed field from
          // cascadedFields so future renders don't show "inherited."
          const upsert = upsertChannelListing(v.id, v.field, v.value)
          if (upsert) updates.push(upsert)
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

  // DELETE /api/admin/cleanup-bulk-test
  // Removes every Product row marked importSource = 'PERFORMANCE_TEST'.
  fastify.delete('/admin/cleanup-bulk-test', async (_request, reply) => {
    try {
      const r = await prisma.product.deleteMany({
        where: { importSource: 'PERFORMANCE_TEST' },
      })
      return { ok: true, deleted: r.count }
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
      const flatChanges: Array<{
        productId: string
        field: string
        value: unknown
      }> = []
      for (const r of planRows) {
        if (!r.productId) continue
        for (const c of r.changes) {
          flatChanges.push({
            productId: r.productId,
            field: c.field,
            value: c.newValue,
          })
        }
      }

      if (flatChanges.length === 0) {
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

      const startTs = Date.now()
      const CHUNK = 500
      let applied = 0
      const chunkErrors: Array<{ chunkStart: number; error: string }> = []

      for (let i = 0; i < flatChanges.length; i += CHUNK) {
        const slice = flatChanges.slice(i, i + CHUNK)
        try {
          await prisma.$transaction(
            slice.map((c) =>
              prisma.product.update({
                where: { id: c.productId },
                data: { [c.field]: c.value as any } as any,
              }),
            ),
            { isolationLevel: 'ReadCommitted' },
          )
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
        applied === flatChanges.length
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
        total: flatChanges.length,
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
}

export default productsRoutes
