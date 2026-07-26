// apps/api/src/services/ebay-description-staleness.vitest.test.ts
//
// ED v2 Phase 5 — description staleness stamp + evaluation (operator decision
// D8: badge + manual re-push, NEVER an automatic write).
//
//   - galleryHashOfRows: pure, stable, order-insensitive gallery fingerprint
//   - computeDescriptionGalleryHash: DB wrapper (mock prisma)
//   - stampDescriptionPush: MERGE-ONLY write onto platformAttributes
//   - stampDescriptionPushSafe: fire-and-forget — never throws, warns instead
//   - evaluateDescriptionStaleness: every staleness reason branch

import { describe, it, expect, vi } from 'vitest'
import {
  galleryHashOfRows,
  computeDescriptionGalleryHash,
  stampDescriptionPush,
  stampDescriptionPushSafe,
  evaluateDescriptionStaleness,
} from './ebay-description-theme.service.js'

const ROWS = [
  { variantGroupKey: 'Colore', variantGroupValue: 'Nero', url: 'https://cdn/x/nero-1.jpg', position: 0 },
  { variantGroupKey: 'Colore', variantGroupValue: 'Nero', url: 'https://cdn/x/nero-2.jpg', position: 1 },
  { variantGroupKey: 'Colore', variantGroupValue: 'Giallo', url: 'https://cdn/x/giallo-1.jpg', position: 0 },
  { variantGroupKey: null, variantGroupValue: null, url: 'https://cdn/x/shared-1.jpg', position: 0 },
]

// ═══════════════════════════════════════════════════════════════════════════
// 1. galleryHashOfRows — the pure fingerprint
// ═══════════════════════════════════════════════════════════════════════════

describe('galleryHashOfRows', () => {
  it('is stable: same rows → same hash, every time', () => {
    expect(galleryHashOfRows(ROWS)).toBe(galleryHashOfRows(ROWS.map((r) => ({ ...r }))))
  })

  it('is ORDER-INSENSITIVE: DB return order can never fake a change', () => {
    const shuffled = [ROWS[2], ROWS[0], ROWS[3], ROWS[1]]
    expect(galleryHashOfRows(shuffled)).toBe(galleryHashOfRows(ROWS))
  })

  it('changes when an image is added or removed', () => {
    expect(galleryHashOfRows(ROWS.slice(0, 3))).not.toBe(galleryHashOfRows(ROWS))
    expect(
      galleryHashOfRows([...ROWS, { variantGroupKey: null, variantGroupValue: null, url: 'https://cdn/x/new.jpg', position: 1 }]),
    ).not.toBe(galleryHashOfRows(ROWS))
  })

  it('changes on a REORDER (position is part of the identity)', () => {
    const reordered = ROWS.map((r) =>
      r.url.endsWith('nero-1.jpg') ? { ...r, position: 1 } : r.url.endsWith('nero-2.jpg') ? { ...r, position: 0 } : r,
    )
    expect(galleryHashOfRows(reordered)).not.toBe(galleryHashOfRows(ROWS))
  })

  it('changes when a row moves to another group bucket', () => {
    const rebucketed = ROWS.map((r) =>
      r.url.endsWith('nero-2.jpg') ? { ...r, variantGroupValue: 'Giallo' } : r,
    )
    expect(galleryHashOfRows(rebucketed)).not.toBe(galleryHashOfRows(ROWS))
  })

  it('empty gallery hashes deterministically', () => {
    expect(galleryHashOfRows([])).toBe(galleryHashOfRows([]))
    expect(galleryHashOfRows([])).not.toBe(galleryHashOfRows(ROWS))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. computeDescriptionGalleryHash — DB wrapper
// ═══════════════════════════════════════════════════════════════════════════

describe('computeDescriptionGalleryHash', () => {
  const prismaWith = (rows: typeof ROWS) => ({
    listingImage: { findMany: vi.fn(async () => rows) },
  })

  it('queries the product\'s curated eBay rows and hashes them', async () => {
    const prisma = prismaWith(ROWS)
    const hash = await computeDescriptionGalleryHash(prisma as never, 'prod-1')
    expect(hash).toBe(galleryHashOfRows(ROWS))
    expect(prisma.listingImage.findMany).toHaveBeenCalledWith({
      where: { productId: 'prod-1', platform: 'EBAY', mediaType: 'IMAGE' },
      select: { variantGroupKey: true, variantGroupValue: true, url: true, position: true },
    })
  })

  it('two DB return orders produce the SAME hash', async () => {
    const a = await computeDescriptionGalleryHash(prismaWith(ROWS) as never, 'p')
    const b = await computeDescriptionGalleryHash(prismaWith([...ROWS].reverse()) as never, 'p')
    expect(a).toBe(b)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. stampDescriptionPush — MERGE-ONLY write
// ═══════════════════════════════════════════════════════════════════════════

describe('stampDescriptionPush', () => {
  it('merges the stamp WITHOUT clobbering other platformAttributes keys', async () => {
    const existingAttrs = {
      __offerIds: { EBAY_IT: 'offer-1' },
      descriptionThemeId: 'theme-9',
      subtitle: 'Sub',
    }
    const update = vi.fn(async () => ({}))
    const prisma = {
      channelListing: {
        findFirst: vi.fn(async () => ({ id: 'cl-1', platformAttributes: existingAttrs })),
        update,
      },
    }

    const ok = await stampDescriptionPush(prisma as never, {
      productId: 'p1',
      marketplace: 'IT',
      themeId: 'theme-9',
      themeVersion: 4,
      galleryHash: 'abc123',
    })

    expect(ok).toBe(true)
    expect(prisma.channelListing.findFirst).toHaveBeenCalledWith({
      where: { productId: 'p1', channel: 'EBAY', region: 'IT' },
      select: { id: true, platformAttributes: true },
    })
    const written = update.mock.calls[0][0] as unknown as {
      where: { id: string }
      data: { platformAttributes: Record<string, unknown> }
    }
    expect(written.where).toEqual({ id: 'cl-1' })
    // every pre-existing key survives verbatim
    expect(written.data.platformAttributes.__offerIds).toEqual({ EBAY_IT: 'offer-1' })
    expect(written.data.platformAttributes.descriptionThemeId).toBe('theme-9')
    expect(written.data.platformAttributes.subtitle).toBe('Sub')
    // and the stamp is complete
    const stamp = written.data.platformAttributes.descriptionPush as Record<string, unknown>
    expect(stamp.themeId).toBe('theme-9')
    expect(stamp.themeVersion).toBe(4)
    expect(stamp.galleryHash).toBe('abc123')
    expect(typeof stamp.at).toBe('string')
    expect(Number.isNaN(Date.parse(stamp.at as string))).toBe(false)
  })

  it('maps UK to region GB and returns false when the market has no listing row', async () => {
    const prisma = {
      channelListing: { findFirst: vi.fn(async () => null), update: vi.fn() },
    }
    const ok = await stampDescriptionPush(prisma as never, {
      productId: 'p1',
      marketplace: 'UK',
      galleryHash: 'h',
    })
    expect(ok).toBe(false)
    expect(prisma.channelListing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 'p1', channel: 'EBAY', region: 'GB' } }),
    )
    expect(prisma.channelListing.update).not.toHaveBeenCalled()
  })

  it('a raw-body delivery stamps themeId/themeVersion as null', async () => {
    const update = vi.fn(async () => ({}))
    const prisma = {
      channelListing: {
        findFirst: vi.fn(async () => ({ id: 'cl-1', platformAttributes: null })),
        update,
      },
    }
    await stampDescriptionPush(prisma as never, { productId: 'p1', marketplace: 'DE', galleryHash: 'h' })
    const written = update.mock.calls[0][0] as unknown as { data: { platformAttributes: { descriptionPush: Record<string, unknown> } } }
    expect(written.data.platformAttributes.descriptionPush.themeId).toBeNull()
    expect(written.data.platformAttributes.descriptionPush.themeVersion).toBeNull()
  })
})

describe('stampDescriptionPushSafe (fire-and-forget)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('stamps in the background using the CURRENT gallery hash', async () => {
    const update = vi.fn(async () => ({}))
    const prisma = {
      listingImage: { findMany: vi.fn(async () => ROWS) },
      channelListing: {
        findFirst: vi.fn(async () => ({ id: 'cl-1', platformAttributes: {} })),
        update,
      },
    }
    const warn = vi.fn()
    stampDescriptionPushSafe(prisma as never, { productId: 'p1', marketplace: 'IT', themeId: 't1', themeVersion: 2 }, warn)
    await flush()
    const written = update.mock.calls[0][0] as unknown as { data: { platformAttributes: { descriptionPush: Record<string, unknown> } } }
    expect(written.data.platformAttributes.descriptionPush.galleryHash).toBe(galleryHashOfRows(ROWS))
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns (never throws) when there is no listing row to stamp', async () => {
    const prisma = {
      listingImage: { findMany: vi.fn(async () => []) },
      channelListing: { findFirst: vi.fn(async () => null), update: vi.fn() },
    }
    const warn = vi.fn()
    stampDescriptionPushSafe(prisma as never, { productId: 'p1', marketplace: 'IT' }, warn)
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stamp skipped'))
  })

  it('warns (never throws) when the DB write blows up', async () => {
    const prisma = {
      listingImage: { findMany: vi.fn(async () => { throw new Error('db down') }) },
      channelListing: { findFirst: vi.fn(), update: vi.fn() },
    }
    const warn = vi.fn()
    expect(() => stampDescriptionPushSafe(prisma as never, { productId: 'p1', marketplace: 'IT' }, warn)).not.toThrow()
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. evaluateDescriptionStaleness — every reason branch (D8)
// ═══════════════════════════════════════════════════════════════════════════

describe('evaluateDescriptionStaleness', () => {
  const THEME = { id: 't1', name: 'Xavia Pro Clean', version: 3 }
  const freshStamp = { at: '2026-07-27T10:00:00.000Z', themeId: 't1', themeVersion: 3, galleryHash: 'HASH' }
  const base = {
    hasListing: true,
    stamp: freshStamp,
    currentGalleryHash: 'HASH',
    currentTheme: THEME,
    hasDraftImageRows: false,
  }

  it('everything matching → fresh, with the stamp timestamp', () => {
    const res = evaluateDescriptionStaleness(base)
    expect(res.stale).toBe(false)
    expect(res.reasons).toEqual([])
    expect(res.stampedAt).toBe('2026-07-27T10:00:00.000Z')
  })

  it('no listing row for the market → stale (never pushed here)', () => {
    const res = evaluateDescriptionStaleness({ ...base, hasListing: false })
    expect(res.stale).toBe(true)
    expect(res.reasons.join(' ')).toMatch(/never been pushed/)
  })

  it('no stamp (or a malformed one) → stale, freshness unknown', () => {
    for (const stamp of [undefined, null, 'junk', { at: 'x' }, { galleryHash: 42 }]) {
      const res = evaluateDescriptionStaleness({ ...base, stamp })
      expect(res.stale).toBe(true)
      expect(res.reasons.join(' ')).toMatch(/never pushed since staleness tracking began/)
      expect(res.stampedAt).toBeUndefined()
    }
  })

  it('curated gallery changed since the stamp → stale with the images reason', () => {
    const res = evaluateDescriptionStaleness({ ...base, currentGalleryHash: 'DIFFERENT' })
    expect(res.stale).toBe(true)
    expect(res.reasons.join(' ')).toMatch(/images changed since last push/)
  })

  it('theme re-assigned since the stamp → stale, naming the new theme', () => {
    const res = evaluateDescriptionStaleness({ ...base, currentTheme: { id: 't2', name: 'Bold', version: 1 } })
    expect(res.stale).toBe(true)
    expect(res.reasons.join(' ')).toMatch(/theme assignment changed.*"Bold"/)
  })

  it('theme removed (now raw body) since the stamp → stale', () => {
    const res = evaluateDescriptionStaleness({ ...base, currentTheme: null })
    expect(res.stale).toBe(true)
    expect(res.reasons.join(' ')).toMatch(/now raw body/)
  })

  it('same theme EDITED since the stamp (version bump) → stale with v→v detail', () => {
    const res = evaluateDescriptionStaleness({ ...base, currentTheme: { ...THEME, version: 4 } })
    expect(res.stale).toBe(true)
    expect(res.reasons.join(' ')).toContain('edited since last push (v3 → v4)')
  })

  it('raw-body stamp with no theme assigned now → fresh (raw → raw is in sync)', () => {
    const res = evaluateDescriptionStaleness({
      ...base,
      stamp: { ...freshStamp, themeId: null, themeVersion: null },
      currentTheme: null,
    })
    expect(res.stale).toBe(false)
  })

  it('DRAFT curated rows pending publish → stale, even when the stamp matches', () => {
    const res = evaluateDescriptionStaleness({ ...base, hasDraftImageRows: true })
    expect(res.stale).toBe(true)
    expect(res.reasons.join(' ')).toMatch(/DRAFT rows pending/)
  })

  it('multiple divergences report EVERY reason, not just the first', () => {
    const res = evaluateDescriptionStaleness({
      ...base,
      currentGalleryHash: 'DIFFERENT',
      currentTheme: { ...THEME, version: 9 },
      hasDraftImageRows: true,
    })
    expect(res.stale).toBe(true)
    expect(res.reasons).toHaveLength(3)
  })
})
