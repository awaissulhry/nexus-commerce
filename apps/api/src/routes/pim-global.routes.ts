/**
 * PIM B.1 — Global tab endpoints for /products/[id]/edit.
 *
 * Surfaces the "core truth" of a product as it appears on the new
 * Global tab: per-locale content (en + it), identifiers, physical
 * dimensions, and technical attributes (categoryAttributes JSONB).
 *
 * Reads via the A.1-A.4 attribute-resolver so synthesis from legacy
 * columns happens automatically — operators see real data even on
 * products whose localizedContent JSONB hasn't been populated yet.
 *
 * Writes target the new JSONB columns (localizedContent +
 * categoryAttributes) for content, and the existing direct columns
 * for identifiers/physical (until Phase B+ migrates those too).
 *
 * Routes (all mounted under /api):
 *   GET    /products/:id/global
 *   PATCH  /products/:id/global
 *   DELETE /products/:id/global/technical/:key
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { resolveAttributes } from '../services/pim/attribute-resolver.js'
import { applyCatalogCascade } from '../services/pim/apply-mapping.service.js'
import { getMasterAttributeSchema } from '../services/pim/master-schema.service.js'
import { proposeImportFromChannel, proposeImportFromFlatFile } from '../services/pim/reverse-mapping.service.js'
import { getMasterCompleteness } from '../services/pim/master-completeness.service.js'
import { suggestMasterAttributes } from '../services/pim/master-ai-fill.service.js'

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

interface LocaleSlot {
  title: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
}

interface GlobalView {
  productId: string
  isVariant: boolean
  /** Per-locale resolved content. The shape mirrors what the Global
   *  tab renders directly — no extra parsing on the client. */
  locales: {
    en: LocaleSlot
    it: LocaleSlot
  }
  identifiers: {
    brand: string | null
    manufacturer: string | null
    gtin: string | null
    upc: string | null
    ean: string | null
  }
  physical: {
    weightValue: number | null
    weightUnit: string | null
    dimLength: number | null
    dimWidth: number | null
    dimHeight: number | null
    dimUnit: string | null
  }
  /** categoryAttributes JSONB as-is. The UI renders this as a
   *  key/value list with add/edit/remove actions. */
  technical: Record<string, unknown>
}

interface PatchBody {
  patch?: {
    en?: Partial<LocaleSlot>
    it?: Partial<LocaleSlot>
    identifiers?: Partial<GlobalView['identifiers']>
    physical?: Partial<GlobalView['physical']>
    technical?: Record<string, unknown>
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Pull one locale slot out of the resolver result. Each key is
 *  resolved independently so synthesis fills gaps without us having
 *  to read individual columns. */
function pickLocaleSlot(
  product: Parameters<typeof resolveAttributes>[0]['product'],
  parent: Parameters<typeof resolveAttributes>[0]['parent'],
  locale: string,
): LocaleSlot {
  const r = resolveAttributes({ product, parent, locale })
  return {
    title: (r.title?.value as string) ?? null,
    description: (r.description?.value as string) ?? null,
    bulletPoints: (r.bulletPoints?.value as string[]) ?? [],
    keywords: (r.keywords?.value as string[]) ?? [],
  }
}

/** Validate inbound patch shape. Returns array of human-readable
 *  errors (empty = valid). */
function validatePatch(body: unknown): string[] {
  const errors: string[] = []
  if (typeof body !== 'object' || body === null) return ['body must be an object']
  const b = body as Record<string, unknown>
  if (b.patch === undefined) return ['patch field is required']
  if (typeof b.patch !== 'object' || b.patch === null) return ['patch must be an object']

  const p = b.patch as Record<string, unknown>
  for (const locale of ['en', 'it']) {
    const slot = p[locale]
    if (slot === undefined) continue
    if (typeof slot !== 'object' || slot === null) {
      errors.push(`patch.${locale} must be an object`)
      continue
    }
    const s = slot as Record<string, unknown>
    if (s.title !== undefined && s.title !== null && typeof s.title !== 'string') {
      errors.push(`patch.${locale}.title must be string|null`)
    }
    if (s.description !== undefined && s.description !== null && typeof s.description !== 'string') {
      errors.push(`patch.${locale}.description must be string|null`)
    }
    if (s.bulletPoints !== undefined && !Array.isArray(s.bulletPoints)) {
      errors.push(`patch.${locale}.bulletPoints must be an array`)
    }
    if (s.keywords !== undefined && !Array.isArray(s.keywords)) {
      errors.push(`patch.${locale}.keywords must be an array`)
    }
  }

  if (p.technical !== undefined && (typeof p.technical !== 'object' || p.technical === null || Array.isArray(p.technical))) {
    errors.push('patch.technical must be an object')
  }
  return errors
}

/** Merge incoming locale-slot patches into existing localizedContent
 *  preserving other locale keys. Strips undefined; passes null
 *  through (explicit clear). */
function mergeLocalizedContent(
  current: unknown,
  patch: PatchBody['patch'] | undefined,
): Record<string, Record<string, unknown>> {
  const base = (typeof current === 'object' && current !== null && !Array.isArray(current))
    ? (current as Record<string, Record<string, unknown>>)
    : {}
  const merged: Record<string, Record<string, unknown>> = { ...base }

  for (const locale of ['en', 'it'] as const) {
    const slotPatch = patch?.[locale]
    if (!slotPatch) continue
    const existing = merged[locale] ?? {}
    const next: Record<string, unknown> = { ...existing }
    if (slotPatch.title !== undefined) next.title = slotPatch.title
    if (slotPatch.description !== undefined) next.description = slotPatch.description
    if (slotPatch.bulletPoints !== undefined) next.bulletPoints = slotPatch.bulletPoints
    if (slotPatch.keywords !== undefined) next.keywords = slotPatch.keywords
    merged[locale] = next
  }
  return merged
}

/** Merge incoming technical-attrs patch into existing categoryAttributes.
 *  Keys present in patch replace; keys absent are preserved; explicit
 *  null clears (matches existing override-data semantics). */
function mergeTechnical(
  current: unknown,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = (typeof current === 'object' && current !== null && !Array.isArray(current))
    ? (current as Record<string, unknown>)
    : {}
  if (!patch) return base
  return { ...base, ...patch }
}

// ────────────────────────────────────────────────────────────────────
// Route plugin
// ────────────────────────────────────────────────────────────────────

const pimGlobalRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /products/:id/global ────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/global',
    async (request, reply) => {
      const { id } = request.params

      const product = await prisma.product.findUnique({ where: { id } })
      if (!product) {
        return reply.status(404).send({ error: 'Product not found' })
      }

      const parent = product.parentId
        ? await prisma.product.findUnique({ where: { id: product.parentId } })
        : null

      const view: GlobalView = {
        productId: product.id,
        isVariant: product.parentId !== null,
        locales: {
          en: pickLocaleSlot(product as any, parent as any, 'en'),
          it: pickLocaleSlot(product as any, parent as any, 'it'),
        },
        identifiers: {
          brand: product.brand ?? null,
          manufacturer: product.manufacturer ?? null,
          gtin: product.gtin ?? null,
          upc: product.upc ?? null,
          ean: product.ean ?? null,
        },
        physical: {
          weightValue: product.weightValue == null ? null : Number(product.weightValue),
          weightUnit: product.weightUnit ?? null,
          dimLength: product.dimLength == null ? null : Number(product.dimLength),
          dimWidth: product.dimWidth == null ? null : Number(product.dimWidth),
          dimHeight: product.dimHeight == null ? null : Number(product.dimHeight),
          dimUnit: product.dimUnit ?? null,
        },
        technical: (product.categoryAttributes as Record<string, unknown> | null) ?? {},
      }

      return reply.send(view)
    },
  )

  // ── GET /products/:id/master-schema ─────────────────────────────
  // MA.1 — the attribute set the master SHOULD hold for its productType
  // (category attrs from the Amazon schema + mapping-rule sources), so the
  // Master tab can render typed fields instead of a blank key/value bag.
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/master-schema',
    async (request, reply) => {
      try {
        const result = await getMasterAttributeSchema(request.params.id)
        return reply.send(result)
      } catch (err: any) {
        if (/not found/i.test(err?.message ?? '')) return reply.status(404).send({ error: err.message })
        request.log.error({ err }, 'master-schema failed')
        return reply.status(500).send({ error: err?.message ?? 'master-schema failed' })
      }
    },
  )

  // ── POST /products/:id/master/import-from-channel ────────────────
  // MA.3 — propose master values reverse-mapped from a channel listing (the
  // Amazon parent). Read-only; the caller applies accepted proposals via
  // PATCH /global.
  fastify.post<{ Params: { id: string }; Body: { channel?: string; marketplace?: string } }>(
    '/products/:id/master/import-from-channel',
    async (request, reply) => {
      const channel = (request.body?.channel ?? 'AMAZON').toUpperCase()
      const marketplace = request.body?.marketplace?.trim()
      if (!marketplace) return reply.status(400).send({ error: 'marketplace is required' })
      try {
        const result = await proposeImportFromChannel({ productId: request.params.id, channel, marketplace })
        return reply.send(result)
      } catch (err: any) {
        if (/not found|no .* listing/i.test(err?.message ?? '')) return reply.status(404).send({ error: err.message })
        request.log.error({ err }, 'import-from-channel failed')
        return reply.status(500).send({ error: err?.message ?? 'import-from-channel failed' })
      }
    },
  )

  // ── POST /products/:id/master/import-from-flat-file ─────────────
  // MA.7 — propose master values from the flat-file data (READ-ONLY; identity-
  // match against the master schema). Zero flat-file writes/code touched.
  fastify.post<{ Params: { id: string }; Body: { marketplace?: string } }>(
    '/products/:id/master/import-from-flat-file',
    async (request, reply) => {
      const marketplace = request.body?.marketplace?.trim()
      if (!marketplace) return reply.status(400).send({ error: 'marketplace is required' })
      try {
        const result = await proposeImportFromFlatFile({ productId: request.params.id, marketplace })
        return reply.send(result)
      } catch (err: any) {
        if (/not found|no .* flat-file/i.test(err?.message ?? '')) return reply.status(404).send({ error: err.message })
        request.log.error({ err }, 'import-from-flat-file failed')
        return reply.status(500).send({ error: err?.message ?? 'import-from-flat-file failed' })
      }
    },
  )

  // ── GET /products/:id/master/completeness ───────────────────────
  // MA.4 — overall + required-attribute completeness for governance.
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/master/completeness',
    async (request, reply) => {
      try {
        return reply.send(await getMasterCompleteness(request.params.id))
      } catch (err: any) {
        if (/not found/i.test(err?.message ?? '')) return reply.status(404).send({ error: err.message })
        request.log.error({ err }, 'master completeness failed')
        return reply.status(500).send({ error: err?.message ?? 'completeness failed' })
      }
    },
  )

  // ── POST /products/:id/master/ai-fill ───────────────────────────
  // MA.5 — AI-infer empty master attributes from the product context.
  // Review-gated; caller applies accepted values via PATCH /global.
  fastify.post<{ Params: { id: string } }>(
    '/products/:id/master/ai-fill',
    async (request, reply) => {
      try {
        return reply.send(await suggestMasterAttributes(request.params.id))
      } catch (err: any) {
        if (/not found/i.test(err?.message ?? '')) return reply.status(404).send({ error: err.message })
        request.log.error({ err }, 'master ai-fill failed')
        return reply.status(500).send({ error: err?.message ?? 'ai-fill failed' })
      }
    },
  )

  // ── PATCH /products/:id/global ──────────────────────────────────
  // Atomic: reads current JSONB columns, merges patch in app code,
  // writes back in a single update. Prisma's nullable Json field
  // doesn't expose deep-merge so we do it explicitly + preserve other
  // locale slots / unrelated keys.
  fastify.patch<{ Params: { id: string }; Body: PatchBody }>(
    '/products/:id/global',
    async (request, reply) => {
      const { id } = request.params
      const body = request.body

      const errors = validatePatch(body)
      if (errors.length > 0) {
        return reply.status(400).send({ error: 'invalid_patch', details: errors })
      }
      const patch = body.patch!

      // Read current — needed for the merge. We could go straight to
      // a JSON_PATCH on Postgres but that complicates audit (we want
      // before+after for ProductEvent) and the row is small.
      const current = await prisma.product.findUnique({
        where: { id },
        select: {
          localizedContent: true,
          categoryAttributes: true,
        },
      })
      if (!current) return reply.status(404).send({ error: 'Product not found' })

      const data: Record<string, unknown> = {}

      // Locale content
      if (patch.en || patch.it) {
        data.localizedContent = mergeLocalizedContent(current.localizedContent, patch)
      }

      // Technical attributes (categoryAttributes JSONB)
      if (patch.technical) {
        data.categoryAttributes = mergeTechnical(current.categoryAttributes, patch.technical)
      }

      // Identifiers (direct columns for now — Phase B+ migrates these)
      if (patch.identifiers) {
        const idn = patch.identifiers
        if (idn.brand !== undefined) data.brand = idn.brand
        if (idn.manufacturer !== undefined) data.manufacturer = idn.manufacturer
        if (idn.gtin !== undefined) data.gtin = idn.gtin
        if (idn.upc !== undefined) data.upc = idn.upc
        if (idn.ean !== undefined) data.ean = idn.ean
      }

      // Physical (direct columns)
      if (patch.physical) {
        const ph = patch.physical
        if (ph.weightValue !== undefined) data.weightValue = ph.weightValue
        if (ph.weightUnit !== undefined) data.weightUnit = ph.weightUnit
        if (ph.dimLength !== undefined) data.dimLength = ph.dimLength
        if (ph.dimWidth !== undefined) data.dimWidth = ph.dimWidth
        if (ph.dimHeight !== undefined) data.dimHeight = ph.dimHeight
        if (ph.dimUnit !== undefined) data.dimUnit = ph.dimUnit
      }

      if (Object.keys(data).length === 0) {
        return reply.send({ ok: true, changed: false })
      }

      await prisma.product.update({ where: { id }, data })

      // FM.8 — flag-gated auto-cascade: when master content/attributes
      // change, fan out to mapped channel coordinates via the catalog
      // mapping (translate + enqueue on the undo window). Default OFF
      // (FM_CASCADE_ON_SAVE !== 'on') → no behaviour change. Fire-and-
      // forget: the PATCH returns immediately; applyCatalogCascade enqueues
      // durably (OutboundSyncQueue) on its own.
      if (process.env.FM_CASCADE_ON_SAVE === 'on') {
        const changes: Record<string, unknown> = {}
        if (patch.technical) Object.assign(changes, patch.technical)
        const loc = (patch.en ?? patch.it) as { title?: string; description?: string } | undefined
        if (loc?.title != null) changes.title = loc.title
        if (loc?.description != null) changes.description = loc.description
        if (Object.keys(changes).length > 0) {
          void applyCatalogCascade({ productId: id, changes }, { reason: 'global-tab-save' }).catch(
            (err: unknown) => {
              request.log.warn(
                { err, productId: id },
                '[fm-cascade] auto-cascade after global save failed (non-blocking)',
              )
            },
          )
        }
      }

      return reply.send({ ok: true, changed: true })
    },
  )

  // ── GET /products/:id/channel-listing/:clId/inheritance ─────────
  // PIM B.2 — Per-SSOT-field inheritance state for one channel
  // listing. Surfaces to the operator: what value is currently
  // effective on this marketplace, what value would be inherited if
  // they reset, and whether an override is active.
  fastify.get<{ Params: { id: string; clId: string } }>(
    '/products/:id/channel-listing/:clId/inheritance',
    async (request, reply) => {
      const { id, clId } = request.params

      const [product, channelListing] = await Promise.all([
        prisma.product.findUnique({ where: { id } }),
        prisma.channelListing.findUnique({ where: { id: clId } }),
      ])
      if (!product) return reply.status(404).send({ error: 'Product not found' })
      if (!channelListing || channelListing.productId !== id) {
        return reply.status(404).send({ error: 'Channel listing not found for product' })
      }

      const parent = product.parentId
        ? await prisma.product.findUnique({ where: { id: product.parentId } })
        : null

      // Master (no channel context) gives the "what would I inherit
      // if I reset the override" value per SSOT field.
      const masterResolved = resolveAttributes({
        product: product as any,
        parent: parent as any,
      })
      // Effective with channel applied gives the current value.
      const effectiveResolved = resolveAttributes({
        product: product as any,
        parent: parent as any,
        channelListing: channelListing as any,
      })

      const ssot = ['title', 'description', 'price', 'quantity', 'bulletPoints'] as const
      const followFlagMap = {
        title: 'followMasterTitle',
        description: 'followMasterDescription',
        price: 'followMasterPrice',
        quantity: 'followMasterQuantity',
        bulletPoints: 'followMasterBulletPoints',
      } as const

      const fields: Record<string, {
        effective: unknown
        master: unknown
        isOverridden: boolean
        source: string | null
      }> = {}
      for (const key of ssot) {
        const followFlag = followFlagMap[key]
        const flagValue = (channelListing as unknown as Record<string, unknown>)[followFlag]
        const isOverridden = flagValue === false
        fields[key] = {
          effective: effectiveResolved[key]?.value ?? null,
          master: masterResolved[key]?.value ?? null,
          isOverridden,
          source: effectiveResolved[key]?.source ?? null,
        }
      }

      return reply.send({
        productId: id,
        channelListingId: clId,
        channel: channelListing.channel,
        marketplace: channelListing.marketplace,
        fields,
      })
    },
  )

  // ── POST /products/:id/channel-listing/:clId/reset ──────────────
  // PIM B.2 — Reset one (or all) SSOT fields to inherit from master.
  // Sets followMasterX=true + nulls xOverride. Idempotent: a field
  // already inheriting returns ok without a write.
  fastify.post<{
    Params: { id: string; clId: string }
    Body: { field: 'title' | 'description' | 'price' | 'quantity' | 'bulletPoints' | 'all' }
  }>(
    '/products/:id/channel-listing/:clId/reset',
    async (request, reply) => {
      const { id, clId } = request.params
      const { field } = request.body

      const VALID = new Set([
        'title',
        'description',
        'price',
        'quantity',
        'bulletPoints',
        'all',
      ])
      if (!field || !VALID.has(field)) {
        return reply
          .status(400)
          .send({ error: 'field must be one of title|description|price|quantity|bulletPoints|all' })
      }

      const cl = await prisma.channelListing.findUnique({ where: { id: clId } })
      if (!cl || cl.productId !== id) {
        return reply.status(404).send({ error: 'Channel listing not found for product' })
      }

      const data: Record<string, unknown> = {}
      const apply = (key: 'title' | 'description' | 'price' | 'quantity' | 'bulletPoints') => {
        switch (key) {
          case 'title':
            data.followMasterTitle = true
            data.titleOverride = null
            break
          case 'description':
            data.followMasterDescription = true
            data.descriptionOverride = null
            break
          case 'price':
            data.followMasterPrice = true
            data.priceOverride = null
            break
          case 'quantity':
            data.followMasterQuantity = true
            data.quantityOverride = null
            break
          case 'bulletPoints':
            data.followMasterBulletPoints = true
            data.bulletPointsOverride = []
            break
        }
      }
      if (field === 'all') {
        apply('title')
        apply('description')
        apply('price')
        apply('quantity')
        apply('bulletPoints')
      } else {
        apply(field)
      }

      await prisma.channelListing.update({ where: { id: clId }, data })
      return reply.send({ ok: true, field })
    },
  )

  // ── GET /products/:id/cascade-preview ───────────────────────────
  // PIM E.4 — Surface the fan-out of a master-field change. Returns
  // per-channel × per-marketplace listing counts that would inherit
  // (followMasterX=true) versus override (followMasterX=false), plus
  // the variant-child count for the product.
  //
  // The mapping is field-aware but not field-required: callers ask
  // "what does a master-level change touch?" and we return the
  // summary for each tracked SSOT field (title, description, price,
  // quantity, bulletPoints) so the UI can show "if you change title,
  // N listings inherit + M override; if you change price, …".
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/cascade-preview',
    async (request, reply) => {
      const { id } = request.params

      const product = await prisma.product.findUnique({
        where: { id },
        select: {
          id: true,
          sku: true,
          parentId: true,
        },
      })
      if (!product) return reply.status(404).send({ error: 'Product not found' })

      // Variant children — direct count.
      const variantCount = await prisma.product.count({
        where: { parentId: id, deletedAt: null },
      })

      // Channel listings for this product.
      const listings = await prisma.channelListing.findMany({
        where: { productId: id },
        select: {
          id: true,
          channel: true,
          marketplace: true,
          listingStatus: true,
          followMasterTitle: true,
          followMasterDescription: true,
          followMasterPrice: true,
          followMasterQuantity: true,
          followMasterBulletPoints: true,
        },
      })

      // Per-(channel, marketplace) breakdown: counts of listings whose
      // followMasterX is true for each tracked SSOT field. Operator
      // sees "title: 7 listings inherit, 3 override" at a glance.
      type CellKey = string
      const cells = new Map<
        CellKey,
        {
          channel: string
          marketplace: string
          total: number
          inheritByField: Record<string, number>
          overrideByField: Record<string, number>
        }
      >()
      const trackedFields = [
        'title',
        'description',
        'price',
        'quantity',
        'bulletPoints',
      ] as const
      const followFlagMap: Record<(typeof trackedFields)[number], string> = {
        title: 'followMasterTitle',
        description: 'followMasterDescription',
        price: 'followMasterPrice',
        quantity: 'followMasterQuantity',
        bulletPoints: 'followMasterBulletPoints',
      }

      for (const l of listings) {
        const key = `${l.channel}::${l.marketplace}`
        const cell = cells.get(key) ?? {
          channel: l.channel,
          marketplace: l.marketplace,
          total: 0,
          inheritByField: Object.fromEntries(trackedFields.map((f) => [f, 0])),
          overrideByField: Object.fromEntries(trackedFields.map((f) => [f, 0])),
        }
        cell.total++
        for (const f of trackedFields) {
          const flagValue = (l as unknown as Record<string, unknown>)[followFlagMap[f]]
          // Default (undefined) === follow master (matches resolver convention).
          const follows = flagValue === undefined ? true : Boolean(flagValue)
          if (follows) cell.inheritByField[f]++
          else cell.overrideByField[f]++
        }
        cells.set(key, cell)
      }

      // Aggregate totals across all marketplaces.
      const totals: Record<string, { inherit: number; override: number }> = {}
      for (const f of trackedFields) totals[f] = { inherit: 0, override: 0 }
      for (const cell of cells.values()) {
        for (const f of trackedFields) {
          totals[f].inherit += cell.inheritByField[f]
          totals[f].override += cell.overrideByField[f]
        }
      }

      return reply.send({
        productId: id,
        productSku: product.sku,
        isVariant: product.parentId !== null,
        variantCount,
        totalListings: listings.length,
        marketplaceCount: cells.size,
        cells: Array.from(cells.values()).sort((a, b) => {
          if (a.channel !== b.channel) return a.channel.localeCompare(b.channel)
          return a.marketplace.localeCompare(b.marketplace)
        }),
        totals,
      })
    },
  )

  // ── DELETE /products/:id/global/technical/:key ──────────────────
  // Remove one key from categoryAttributes. Returns 200 with no
  // change when the key wasn't present (idempotent).
  fastify.delete<{ Params: { id: string; key: string } }>(
    '/products/:id/global/technical/:key',
    async (request, reply) => {
      const { id, key } = request.params

      const current = await prisma.product.findUnique({
        where: { id },
        select: { categoryAttributes: true },
      })
      if (!current) return reply.status(404).send({ error: 'Product not found' })

      const base = (typeof current.categoryAttributes === 'object'
        && current.categoryAttributes !== null
        && !Array.isArray(current.categoryAttributes))
        ? (current.categoryAttributes as Record<string, unknown>)
        : {}

      if (!(key in base)) {
        return reply.send({ ok: true, changed: false })
      }

      const next = { ...base }
      delete next[key]
      await prisma.product.update({
        where: { id },
        data: { categoryAttributes: next as unknown as object },
      })
      return reply.send({ ok: true, changed: true })
    },
  )
}

export default pimGlobalRoutes
