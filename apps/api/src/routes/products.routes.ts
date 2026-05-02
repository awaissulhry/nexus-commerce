import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { getAvailableFields } from '../services/pim/field-registry.service.js'

/**
 * Routes for bulk-operations: optimized fetch + atomic patch.
 * Mounted at /api in index.ts → endpoints are /api/products/bulk-fetch
 * and /api/products/bulk.
 */
const productsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/pim/fields — return field definitions for the column
  // selector. Optional filters:
  //   ?channels=AMAZON,EBAY     — include those channels' fields
  //   ?productTypes=OUTERWEAR   — include category-specific fields
  // Cached 5 min since registry is static at runtime.
  fastify.get('/pim/fields', async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    const q = request.query as { channels?: string; productTypes?: string }
    const fields = getAvailableFields({
      channels: q.channels?.split(',').map((s) => s.trim()).filter(Boolean),
      productTypes: q.productTypes
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })
    return { fields, count: fields.length }
  })

  // GET /api/products/bulk-fetch — single optimized SELECT for the
  // bulk-operations table. Plain Decimal coercion to numbers so the
  // client can sort/edit without parseFloat-ing everywhere.
  fastify.get('/products/bulk-fetch', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=10')

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
        },
        // Parents first via parentId asc (NULLs first in Postgres asc),
        // then SKU.
        orderBy: [{ parentId: 'asc' }, { sku: 'asc' }],
      })

      // Coerce Decimal → number for JSON safety + cheap client compares
      const products = rows.map((p) => ({
        ...p,
        basePrice: Number(p.basePrice),
        costPrice: p.costPrice == null ? null : Number(p.costPrice),
        minMargin: p.minMargin == null ? null : Number(p.minMargin),
        minPrice: p.minPrice == null ? null : Number(p.minPrice),
        maxPrice: p.maxPrice == null ? null : Number(p.maxPrice),
        weightValue: p.weightValue == null ? null : Number(p.weightValue),
      }))

      return { products, count: products.length }
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
    }
  }>('/products/bulk', async (request, reply) => {
    const { changes } = request.body ?? {}
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
      'status',
      'fulfillmentChannel',
    ])
    const NUMERIC_FIELDS = new Set([
      'basePrice',
      'costPrice',
      'minMargin',
      'minPrice',
      'maxPrice',
      'weightValue',
    ])
    const INTEGER_FIELDS = new Set(['totalStock', 'lowStockThreshold'])
    const STATUS_VALUES = new Set(['ACTIVE', 'DRAFT', 'INACTIVE'])
    const CHANNEL_VALUES = new Set(['FBA', 'FBM'])

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
      if (!c.field || !ALLOWED_FIELDS.has(c.field)) {
        errors.push({ id: c.id, field: c.field ?? '', error: 'Field not editable' })
        continue
      }

      let value: any = c.value

      if (NUMERIC_FIELDS.has(c.field)) {
        if (value === '' || value === null || value === undefined) {
          value = null
        } else {
          const n = Number(value)
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

      for (const v of validated) {
        if (v.cascade) {
          // Update parent itself
          updates.push(
            prisma.product.update({
              where: { id: v.id },
              data: { [v.field]: v.value } as any,
            })
          )
          // Update each child + push field onto cascadedFields
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
        } else if (childIdSet.has(v.id)) {
          // Direct edit on a child — also remove the field from
          // cascadedFields if it's there (override semantics).
          // Using $executeRaw because Prisma doesn't have an
          // array_remove operation in the standard data API.
          updates.push(
            prisma.$executeRaw`
              UPDATE "Product"
              SET ${Prisma.raw(`"${v.field}"`)} = ${v.value as any},
                  "cascadedFields" = array_remove("cascadedFields", ${v.field})
              WHERE id = ${v.id}
            `
          )
        } else {
          // Direct edit on a parent or standalone — plain update
          updates.push(
            prisma.product.update({
              where: { id: v.id },
              data: { [v.field]: v.value } as any,
            })
          )
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
}

export default productsRoutes
