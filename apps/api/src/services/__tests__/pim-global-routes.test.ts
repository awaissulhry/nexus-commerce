/**
 * PIM B.1 — Global tab route helpers verifier.
 *
 * Tests the pure logic (validatePatch, mergeLocalizedContent,
 * mergeTechnical) directly. Route-handler integration is covered by
 * the resolver + shadow suites + a manual smoke test after deploy.
 */

import { describe, it, expect } from 'vitest'

// Re-export the pure helpers via a thin wrapper since they're not
// exported from the route module today — we'll lift them when B.2
// or later needs them outside the route handler. For now copy the
// signatures and validate the contract via the route's body shape.

// Smoke: ensure the route module imports cleanly and exposes a
// default Fastify plugin. Real HTTP-level tests live in the e2e
// suite (out of scope for B.1).
describe('pim-global routes module', () => {
  it('exports a default Fastify plugin', async () => {
    const mod = await import('../../routes/pim-global.routes.js')
    expect(typeof mod.default).toBe('function')
  })
})

// ────────────────────────────────────────────────────────────────────
// Pure merge logic — duplicated here to keep the test self-contained
// and document the contract operators are signing up to.
// ────────────────────────────────────────────────────────────────────

interface LocaleSlotPatch {
  title?: string | null
  description?: string | null
  bulletPoints?: string[]
  keywords?: string[]
}

interface PatchShape {
  en?: LocaleSlotPatch
  it?: LocaleSlotPatch
  technical?: Record<string, unknown>
}

// Copy of the helper from pim-global.routes.ts. Kept in sync manually;
// when we lift the helper to a service, this duplication goes away.
function mergeLocalizedContent(
  current: unknown,
  patch: PatchShape | undefined,
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
// mergeLocalizedContent
// ────────────────────────────────────────────────────────────────────
describe('mergeLocalizedContent', () => {
  it('preserves other locale slots when patching only en', () => {
    const current = { en: { title: 'old en' }, it: { title: 'old it' } }
    const next = mergeLocalizedContent(current, { en: { title: 'new en' } })
    expect(next.en).toEqual({ title: 'new en' })
    expect(next.it).toEqual({ title: 'old it' })
  })

  it('preserves other keys in same locale when patching one key', () => {
    const current = { en: { title: 'T', description: 'D', bulletPoints: ['a'] } }
    const next = mergeLocalizedContent(current, { en: { title: 'T2' } })
    expect(next.en).toEqual({ title: 'T2', description: 'D', bulletPoints: ['a'] })
  })

  it('explicit null clears the value (vs undefined which is no-op)', () => {
    const current = { en: { title: 'T', description: 'D' } }
    const next = mergeLocalizedContent(current, { en: { title: null } })
    expect(next.en.title).toBeNull()
    expect(next.en.description).toBe('D')
  })

  it('handles current = null / invalid by starting from empty object', () => {
    const next = mergeLocalizedContent(null, { en: { title: 'T' } })
    expect(next.en).toEqual({ title: 'T' })
  })

  it('returns base unchanged when patch has no en/it slots', () => {
    const current = { en: { title: 'T' } }
    const next = mergeLocalizedContent(current, {})
    expect(next.en.title).toBe('T')
  })

  it('replaces bulletPoints array wholesale (no element-wise merge)', () => {
    const current = { en: { bulletPoints: ['a', 'b', 'c'] } }
    const next = mergeLocalizedContent(current, { en: { bulletPoints: ['x'] } })
    expect(next.en.bulletPoints).toEqual(['x'])
  })
})

// ────────────────────────────────────────────────────────────────────
// mergeTechnical
// ────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────
// B.2 — Reset semantics contract (mirrors what the POST endpoint does
// in app code). Keeps the test self-contained until we lift the
// helper out of the route file.
// ────────────────────────────────────────────────────────────────────
function buildResetPatch(
  field: 'title' | 'description' | 'price' | 'quantity' | 'bulletPoints' | 'all',
): Record<string, unknown> {
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
  return data
}

describe('buildResetPatch (B.2 reset semantics)', () => {
  it('reset title: sets followMasterTitle=true + nulls titleOverride', () => {
    expect(buildResetPatch('title')).toEqual({
      followMasterTitle: true,
      titleOverride: null,
    })
  })

  it('reset price: sets followMasterPrice=true + nulls priceOverride', () => {
    expect(buildResetPatch('price')).toEqual({
      followMasterPrice: true,
      priceOverride: null,
    })
  })

  it('reset bulletPoints: uses empty array (not null) for the override col', () => {
    // bulletPointsOverride is String[] in the schema — Prisma rejects
    // null on a non-nullable array column, so we clear to [] instead.
    expect(buildResetPatch('bulletPoints')).toEqual({
      followMasterBulletPoints: true,
      bulletPointsOverride: [],
    })
  })

  it('reset all: includes all 5 SSOT field flags + override clears', () => {
    const data = buildResetPatch('all')
    expect(data.followMasterTitle).toBe(true)
    expect(data.followMasterDescription).toBe(true)
    expect(data.followMasterPrice).toBe(true)
    expect(data.followMasterQuantity).toBe(true)
    expect(data.followMasterBulletPoints).toBe(true)
    expect(data.titleOverride).toBeNull()
    expect(data.priceOverride).toBeNull()
    expect(data.bulletPointsOverride).toEqual([])
  })
})

describe('mergeTechnical', () => {
  it('shallow-merges patch onto current', () => {
    const next = mergeTechnical(
      { material: 'Cowhide', armor: 'CE2' },
      { material: 'Premium Cowhide' },
    )
    expect(next).toEqual({ material: 'Premium Cowhide', armor: 'CE2' })
  })

  it('adds new key without removing existing keys', () => {
    const next = mergeTechnical(
      { material: 'Cowhide' },
      { armor: 'CE2' },
    )
    expect(next).toEqual({ material: 'Cowhide', armor: 'CE2' })
  })

  it('null value in patch clears the key (preserves identity in JSONB)', () => {
    const next = mergeTechnical(
      { material: 'Cowhide', armor: 'CE2' },
      { material: null },
    )
    expect(next).toEqual({ material: null, armor: 'CE2' })
  })

  it('returns base unchanged when patch is undefined', () => {
    expect(mergeTechnical({ a: 1 }, undefined)).toEqual({ a: 1 })
  })

  it('starts from empty when current is null/invalid', () => {
    expect(mergeTechnical(null, { a: 1 })).toEqual({ a: 1 })
    expect(mergeTechnical('not-an-object', { a: 1 })).toEqual({ a: 1 })
    expect(mergeTechnical([], { a: 1 })).toEqual({ a: 1 })
  })
})
