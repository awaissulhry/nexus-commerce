import { translationCoverage } from '../services/translation-completeness.service.js'
import { availableContentLanguages } from '../services/pim/market-languages.js'
import { contentLanguages } from '../services/pim/content-read.js'
/**
 * W2.5 — ProductFamily CRUD.
 *
 * Endpoints (all under /api):
 *   GET    /families                       — list all families
 *   GET    /families/:id                   — single family detail
 *   GET    /families/:id/effective         — resolver result (uses W2.4)
 *   POST   /families                       — create
 *   PATCH  /families/:id                   — update label/desc/parent
 *   DELETE /families/:id                   — delete (cascades:
 *                                              child families → parent SET NULL,
 *                                              attached products → familyId SET NULL,
 *                                              FamilyAttribute rows → CASCADE)
 *
 * FamilyAttribute attach/detach is a separate concern; lives in
 * W2.7 (likely under /families/:id/attributes).
 *
 * Validation:
 *   - code: required, lowercase snake_case (Akeneo convention)
 *   - label: required, non-empty
 *   - parentFamilyId (when set): must exist; setting it must NOT
 *     create a cycle (walk the candidate's chain looking for self)
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import {
  FamilyAdminError, createFamilyAttribute, createProductFamily, deleteFamilyAttribute, deleteProductFamily, updateFamilyAttribute,
  updateProductFamily, type FamilyAttributeCreateInput, type FamilyAttributeUpdateInput, type FamilyCreateInput, type FamilyUpdateInput,
} from '../services/pim/family-admin.service.js'
import { invalidateAttributeSchemasAfterWrites } from '../services/pim/attribute-schema-invalidation.js'
import prisma from '../db.js'
import { familyHierarchyService } from '../services/family-hierarchy.service.js'
import { familyCompletenessService } from '../services/family-completeness.service.js'
import { channelReadinessService } from '../services/channel-readiness.service.js'
import { auditLogService } from '../services/audit-log.service.js'
import { productReadCacheService } from '../services/product-read-cache.service.js'
import { MISSING_REQUIRED_MAX_TAKE, productsMissingRequired } from '../services/pim/readiness-query.service.js'

/** MCP full control P8 — a write refused by family-admin.service.ts: its status, sentence and extra fields, as before. */
async function adminReply<T>(reply: FastifyReply, work: () => Promise<T>) {
  try { return await work() }
  catch (error) {
    if (error instanceof FamilyAdminError) return reply.code(error.status).send({ error: error.message, ...error.extra })
    throw error
  }
}

const familiesRoutes: FastifyPluginAsync = async (fastify) => {
  invalidateAttributeSchemasAfterWrites(fastify)
  // GET /api/families — list with attribute counts.
  fastify.get('/families', async (request, reply) => {
    const q = request.query as { includeAttributes?: string }
    const includeAttrs =
      q.includeAttributes === '1' || q.includeAttributes === 'true'
    const families = await prisma.productFamily.findMany({
      orderBy: [{ label: 'asc' }],
      include: {
        _count: {
          select: { products: true, familyAttributes: true, childFamilies: true },
        },
        ...(includeAttrs
          ? {
              familyAttributes: {
                select: {
                  attributeId: true,
                  required: true,
                  channels: true,
                  sortOrder: true,
                },
              },
            }
          : {}),
      },
    })
    return { families }
  })

  // GET /api/families/:id — single family + counts.
  fastify.get('/families/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const family = await prisma.productFamily.findUnique({
      where: { id },
      include: {
        parentFamily: { select: { id: true, code: true, label: true } },
        childFamilies: { select: { id: true, code: true, label: true } },
        familyAttributes: {
          orderBy: [{ sortOrder: 'asc' }],
          include: {
            attribute: {
              select: { id: true, code: true, label: true, type: true, groupId: true },
            },
          },
        },
        _count: { select: { products: true } },
      },
    })
    if (!family) return reply.code(404).send({ error: 'family not found' })
    return { family }
  })

  // GET /api/families/:id/effective — resolved attribute set walking
  // the parent chain (W2.4 service). Used by the editor + completeness
  // recompute paths.
  fastify.get('/families/:id/effective', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const effective =
        await familyHierarchyService.resolveEffectiveAttributes(id)
      return { familyId: id, attributes: effective }
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg })
      if (/cycle|depth exceeded/i.test(msg))
        return reply.code(409).send({ error: msg })
      throw err
    }
  })

  // POST /api/families — create (family-admin.service.ts checks and writes).
  fastify.post('/families', async (request, reply) => {
    const body = request.body as FamilyCreateInput
    return adminReply(reply, async () => {
      const family = await createProductFamily(body)
      return reply.code(201).send({ family })
    })
  })

  // PATCH /api/families/:id — update mutable fields. Cycle-detect on parentFamilyId changes (family-admin.service.ts).
  fastify.patch('/families/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as FamilyUpdateInput
    return adminReply(reply, async () => ({ family: await updateProductFamily(id, body) }))
  })

  // DELETE /api/families/:id — drop the family. FK cascades:
  //   childFamilies.parentFamilyId → SET NULL (children become roots)
  //   Product.familyId → SET NULL (products keep their data; family
  //                                 detached, falls back to legacy
  //                                 categoryAttributes JSON path)
  //   FamilyAttribute → CASCADE (rows deleted alongside the family)
  fastify.delete('/families/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    return adminReply(reply, () => deleteProductFamily(id))
  })

  // ── W2.14 — Completeness ──────────────────────────────────────────
  //
  // GET /api/products/:id/family-completeness
  //
  // Lives in families.routes.ts (W2-scope) but uses /products/:id
  // path so the /products grid can fetch it from the natural per-
  // row URL. Returns the same shape as FamilyCompletenessService.compute.
  fastify.get('/products/:id/family-completeness', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const result = await familyCompletenessService.compute(id)
      return result
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg })
      if (/cycle|depth exceeded/i.test(msg))
        return reply.code(409).send({ error: msg })
      throw err
    }
  })

  // ── W3.10 — Channel readiness ─────────────────────────────────
  //
  // GET /api/products/:id/channel-readiness
  //
  // Per-channel "ready to publish?" score + missing-fields list.
  // Uses the W2.14 family path when familyId is set; falls back to
  // hard-coded per-channel minimum-fields list otherwise.
  fastify.get('/products/:id/channel-readiness', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const result = await channelReadinessService.compute(id)
      return result
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg })
      throw err
    }
  })

  // POST /api/products/channel-readiness/bulk { productIds: [...] }
  //
  // Bulk readiness for the lens (W3.11). Capped at 200 ids per call.
  // Sequential per-product so each gets its own resolver call —
  // running these in parallel would multiply Prisma connections;
  // 50 products × ~30ms each is well under a second.
  fastify.post('/products/channel-readiness/bulk', async (request, reply) => {
    const body = request.body as { productIds?: string[] }
    if (!Array.isArray(body.productIds) || body.productIds.length === 0)
      return reply
        .code(400)
        .send({ error: 'productIds must be a non-empty array' })
    if (body.productIds.length > 200)
      return reply
        .code(400)
        .send({ error: 'productIds cannot exceed 200 per call' })

    // P3 — one batched computation (fixed query count) instead of several queries per product in sequence.
    const computed = await channelReadinessService.computeMany(body.productIds)
    const results: Record<string, unknown> = {}
    for (const id of body.productIds) results[id] = computed.get(id)
    return { results }
  })

  // GET /api/products/readiness/missing-required?channel=EBAY&market=DE[&language=de][&accountId=][&field=color]
  //     [&requiredBy=Family: Jackets][&take=200][&after=<productId>]
  //
  // P7 (docs/attributes/PLAN.md §4.6) — the products that miss a required field at ONE coordinate, read from the
  // stored readiness index (one query, never a rebuild). Omit channel and market for the shared product. The reply
  // says how many products were checked there and how many are pending a rebuild, so "none missing" is never
  // confused with "not checked".
  fastify.get('/products/readiness/missing-required', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const channel = q.channel ? q.channel.toUpperCase() : null
    const market = q.market ? q.market.toUpperCase() : null
    if ((channel === null) !== (market === null))
      return reply.code(400).send({ error: 'Send channel and market together, or neither for the shared product.' })
    const take = q.take === undefined ? undefined : Number(q.take)
    if (take !== undefined && (!Number.isInteger(take) || take < 1 || take > MISSING_REQUIRED_MAX_TAKE))
      return reply.code(400).send({ error: `take must be a whole number from 1 to ${MISSING_REQUIRED_MAX_TAKE}.` })
    return productsMissingRequired({
      channel, market, take,
      ...(q.accountId !== undefined ? { accountId: q.accountId || null } : {}),
      language: q.language ? q.language.toLowerCase() : null,
      field: q.field || null,
      requiredBy: q.requiredBy || null,
      after: q.after || null,
    })
  })

  // POST /api/products/translation-coverage/bulk { productIds: [...] }
  //
  // W5.6 — Bulk per-locale translation coverage for the
  // Translations lens. Returns, per productId, a map of language →
  // { hasContent, fieldCount } where:
  //   hasContent = at least one ProductTranslation field is non-empty
  //   fieldCount = number of fields with content (0..4: name/desc/
  //                bullets/keywords)
  //
  // Cap 200 ids per call. Single Prisma query batched across all
  // productIds — much cheaper than per-product evaluators.
  fastify.post(
    '/products/translation-coverage/bulk',
    async (request, reply) => {
      const body = request.body as { productIds?: string[] }
      if (!Array.isArray(body.productIds) || body.productIds.length === 0)
        return reply
          .code(400)
          .send({ error: 'productIds must be a non-empty array' })
      if (body.productIds.length > 200)
        return reply
          .code(400)
          .send({ error: 'productIds cannot exceed 200 per call' })

      const [products, configured] = await Promise.all([
        prisma.product.findMany({ where: { id: { in: body.productIds } }, include: { translations: true, parent: { include: { translations: true } } } }),
        availableContentLanguages(),
      ])
      const results: Record<string, Record<string, ReturnType<typeof translationCoverage>>> = Object.fromEntries(body.productIds.map(id => [id, {}]))
      for (const product of products) for (const requested of new Set([...configured, ...contentLanguages(product, product.parent)])) {
        results[product.id][requested] = translationCoverage(product as any, requested)
      }
      return { results }
    },
  )

  // POST /api/products/family-completeness/bulk { productIds: [...] }
  //
  // W5.1 — Bulk family-completeness for the /products grid column.
  // Returns a slim shape (just score + filled/total) so the grid can
  // render per-row chips without the full missing[] payload. Same
  // 200-cap + sequential-per-product policy as the readiness bulk.
  fastify.post(
    '/products/family-completeness/bulk',
    async (request, reply) => {
      const body = request.body as { productIds?: string[] }
      if (!Array.isArray(body.productIds) || body.productIds.length === 0)
        return reply
          .code(400)
          .send({ error: 'productIds must be a non-empty array' })
      if (body.productIds.length > 200)
        return reply
          .code(400)
          .send({ error: 'productIds cannot exceed 200 per call' })

      const results: Record<
        string,
        | { score: number; filled: number; totalRequired: number; familyId: string | null }
        | { error: string }
      > = {}
      // P3 — one batched computation (fixed query count) instead of one per product.
      const computed = await familyCompletenessService.computeMany(body.productIds)
      for (const id of body.productIds) {
        const r = computed.get(id)!
        results[id] = 'error' in r ? r : {
          score: r.score,
          filled: r.filled,
          totalRequired: r.totalRequired,
          familyId: r.familyId,
        }
      }
      return { results }
    },
  )

  // ── W2.7 — FamilyAttribute attach/detach ────────────────────────
  //
  // The cornerstone parent-wins write-time enforcement. POST refuses
  // any attribute that already appears (directly or by inheritance)
  // in the family's effective set — that's the Akeneo-strict
  // additive invariant the resolver assumes.

  // POST /api/families/:id/attributes — attach attribute to family.
  //
  // Refuses with 409 if the attribute is already declared by this
  // family OR by any ancestor. The ancestor case is what makes
  // inheritance work: a child can never re-declare (and thereby
  // attempt to override) what a parent has already locked in.
  fastify.post('/families/:id/attributes', async (request, reply) => {
    const { id: familyId } = request.params as { id: string }
    const body = request.body as FamilyAttributeCreateInput
    return adminReply(reply, async () => {
      const created = await createFamilyAttribute(familyId, body)
      return reply.code(201).send({ familyAttribute: created })
    })
  })

  // PATCH /api/family-attributes/:id — update required/channels/order.
  // attributeId + familyId are immutable (would invalidate the
  // ancestor-conflict check that gated the original create).
  fastify.patch('/family-attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as FamilyAttributeUpdateInput
    return adminReply(reply, async () => ({ familyAttribute: await updateFamilyAttribute(id, body) }))
  })

  // DELETE /api/family-attributes/:id — detach attribute from family.
  // Note: removing a parent's attribute means children stop
  // inheriting it. Stored values on Products are NOT touched (the
  // attribute itself still exists; only the family→attribute link
  // breaks). Callers who want to wipe values must call into a
  // separate "purge values" service which doesn't exist yet (W2.x).
  fastify.delete('/family-attributes/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    return adminReply(reply, () => deleteFamilyAttribute(id))
  })

  // ── W2.8 — bulk attach/detach family on N products ─────────────
  //
  // Lives in families.routes.ts (not products.routes.ts, which is
  // already 2k+ LOC) but uses the /products/bulk-* path family for
  // discoverability — every other bulk product mutation is at
  // /api/products/bulk-*, so co-locating the path matters more
  // than co-locating the file.
  //
  // Single endpoint with dual semantics:
  //   familyId = '<id>'  → attach this family to all productIds
  //   familyId = null    → detach (clear familyId on all productIds)
  //
  // Per-product audit row written. updates run inside one
  // $transaction so a partial failure rolls back cleanly.
  //
  // Hard cap at 500 productIds per call (matches bulk-status etc.)
  // — operator can always call again. Larger jobs should go through
  // the BulkOperation queue, but at 280-product catalogs this cap
  // never bites in practice.
  fastify.post('/products/bulk-attach-family', async (request, reply) => {
    const body = request.body as {
      productIds?: string[]
      familyId?: string | null
    }
    if (!Array.isArray(body.productIds) || body.productIds.length === 0)
      return reply
        .code(400)
        .send({ error: 'productIds must be a non-empty array' })
    if (body.productIds.length > 500)
      return reply
        .code(400)
        .send({ error: 'productIds cannot exceed 500 per call' })

    const targetFamilyId = body.familyId ?? null
    if (targetFamilyId !== null) {
      const family = await prisma.productFamily.findUnique({
        where: { id: targetFamilyId },
        select: { id: true },
      })
      if (!family)
        return reply.code(400).send({ error: 'familyId does not exist' })
    }

    // Read current state for the audit before/after diff. Skips
    // soft-deleted products (deletedAt IS NOT NULL) — operators
    // shouldn't be able to attach a family to a row that's in
    // the trash.
    const products = await prisma.product.findMany({
      where: { id: { in: body.productIds }, deletedAt: null },
      select: { id: true, familyId: true },
    })
    if (products.length === 0)
      return reply
        .code(404)
        .send({ error: 'no matching active products found' })

    const startTs = Date.now()

    await prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { id: { in: products.map((p) => p.id) } },
        data: { familyId: targetFamilyId },
      })
    })

    // Fail-open audit: never throws, so a Redis blip can't roll back
    // the attach operation. Each row diffs only the changed field.
    const auditRows = products
      .filter((p) => p.familyId !== targetFamilyId) // no-op rows skipped
      .map((p) => ({
        userId: null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: p.id,
        action: 'update',
        before: { familyId: p.familyId },
        after: { familyId: targetFamilyId },
        metadata: {
          source: 'bulk-attach-family',
          attachOrDetach: targetFamilyId === null ? 'detach' : 'attach',
        },
      }))
    if (auditRows.length > 0) {
      void auditLogService.writeMany(auditRows)
    }

    // ProductReadCache mirrors familyId; refresh so the /products grid
    // reflects the new family pill without waiting for the polled list.
    await Promise.all(
      products.map((p) =>
        productReadCacheService.refresh(p.id).catch(() => undefined),
      ),
    )

    const skipped = body.productIds.length - products.length
    const noOpCount = products.length - auditRows.length
    return {
      ok: true,
      familyId: targetFamilyId,
      requested: body.productIds.length,
      updated: products.length,
      changed: auditRows.length,
      noOp: noOpCount,
      skipped,
      elapsedMs: Date.now() - startTs,
    }
  })
}

export default familiesRoutes
