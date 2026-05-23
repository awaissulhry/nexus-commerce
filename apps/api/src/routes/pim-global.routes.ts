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
      return reply.send({ ok: true, changed: true })
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
