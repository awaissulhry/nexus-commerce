/**
 * FF2.5 — previewImport tests (TDD — written before the service).
 *
 * Uses the REAL pipeline:
 *   generateWorkbook → previewImport (parse → validate → scope → fetch → diff)
 *
 * Assertions:
 *   1. Untouched workbook → zero real changes (end-to-end round-trip proof)
 *   2. Result carries validation + scope + meta correctly
 *   3. previewImport writes nothing — mock prisma has no write methods; any
 *      accidental call would throw TypeError, which would fail the test
 */

import { describe, it, expect } from 'vitest'
import { previewImport } from '../import.service.js'
import { generateWorkbook } from '../../workbook-generator.js'
import { MASTER_FIELDS } from '../../registry/master-fields.js'
import { CHANNEL_MARKET_FIELDS } from '../../registry/channel-fields.js'
import type { WorkbookModel } from '../../registry/types.js'
import type { WorkbookData } from '../../fetch.js'
import type { ImportScope } from '../scope.js'

// ── Model: Products + Amazon IT ───────────────────────────────────────────────

const MODEL: WorkbookModel = {
  markets: { AMAZON: ['IT'], EBAY: [], SHOPIFY: [] },
  sheets: [
    { name: 'Products', sharedFields: MASTER_FIELDS, marketFields: [] },
    { name: 'Amazon', channel: 'AMAZON', sharedFields: [], marketFields: CHANNEL_MARKET_FIELDS },
  ],
}

// ── WorkbookData: product P1 + Amazon IT listing (following master) ───────────
//
// All governed fields follow master, except quantity (override = 5).
// fetchCatalog shapes raw DB rows into WorkbookData; the mock prisma below
// returns the raw DB form that fetchCatalog will transform to match this state.

const DATA: WorkbookData = {
  products: [
    {
      sku: 'P1',
      parent_sku: '',
      ean: '08054323310123',
      name: 'P1 Giacca Moto',
      brand: 'Xavia',
      status: 'ACTIVE',
      fulfillmentMethod: 'FBA',
    },
  ],
  listings: {
    AMAZON: [
      {
        sku: 'P1',
        marketplace: 'IT',
        // Governed: price follows master (masterPrice = 189.9)
        followMasterPrice: true,
        masterPrice: 189.9,
        priceOverride: null,
        // Governed: title follows master
        followMasterTitle: true,
        masterTitle: 'P1 Giacca Moto',
        titleOverride: null,
        // Governed: description follows master
        followMasterDescription: true,
        masterDescription: 'Giacca moto per piloti.',
        descriptionOverride: null,
        // Governed: quantity — operator override (follows=false)
        followMasterQuantity: false,
        masterQuantity: 0,
        quantityOverride: 5,
        // Governed: bullet points follow master
        followMasterBulletPoints: true,
        masterBulletPoints: ['CE Level 2'],
        bulletPointsOverride: null,
        // Non-governed scalars
        listingStatus: 'ACTIVE',
        syncStatus: 'IN_SYNC',
        isPublished: true,
        offerActive: true,
        fulfillmentMethod: 'FBA',
      },
    ],
    EBAY: [],
    SHOPIFY: [],
  },
}

// ── Mock prisma: read-only (only findMany exposed) ────────────────────────────
//
// fetchCatalog calls:
//   prisma.product.findMany → raw products with `parent` join (adds parent_sku)
//   prisma.channelListing.findMany → raw listings with `product.sku` join (adds sku)
//
// If previewImport attempted any write method (create/update/delete), the call
// would throw TypeError (method not a function), which would fail the test.

const mockPrisma = {
  product: {
    findMany: async () => [
      {
        sku: 'P1',
        parent: null,               // fetchCatalog maps → parent_sku: ''
        ean: '08054323310123',
        name: 'P1 Giacca Moto',
        brand: 'Xavia',
        status: 'ACTIVE',
        fulfillmentMethod: 'FBA',
      },
    ],
  },
  channelListing: {
    findMany: async () => [
      {
        marketplace: 'IT',
        channel: 'AMAZON',
        product: { sku: 'P1' },     // fetchCatalog maps → sku: 'P1'
        followMasterPrice: true,
        masterPrice: 189.9,
        priceOverride: null,
        followMasterTitle: true,
        masterTitle: 'P1 Giacca Moto',
        titleOverride: null,
        followMasterDescription: true,
        masterDescription: 'Giacca moto per piloti.',
        descriptionOverride: null,
        followMasterQuantity: false,
        masterQuantity: 0,
        quantityOverride: 5,
        followMasterBulletPoints: true,
        masterBulletPoints: ['CE Level 2'],
        bulletPointsOverride: null,
        listingStatus: 'ACTIVE',
        syncStatus: 'IN_SYNC',
        isPublished: true,
        offerActive: true,
        fulfillmentMethod: 'FBA',
      },
    ],
  },
}

// ── Scope ─────────────────────────────────────────────────────────────────────

const DEFAULT_SCOPE: ImportScope = {
  channel: 'AMAZON',
  markets: ['IT'],
  includeMaster: false,
}

// ── Suite 1: Untouched → zero real changes (round-trip proof) ─────────────────

describe('previewImport — round-trip: untouched workbook → zero changes', () => {
  it('stats.adds === 0, stats.updates === 0, changes is empty', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, {
      snapshotId: 'rt-snap-001',
      exportedAt: '2026-07-06',
    })

    const result = await previewImport(mockPrisma, bytes, DEFAULT_SCOPE)

    // Core round-trip invariant: unedited export produces no actionable changes
    expect(result.diff.stats.adds).toBe(0)
    expect(result.diff.stats.updates).toBe(0)
    expect(result.diff.changes).toHaveLength(0)
    expect(result.diff.deletes).toEqual([])
  })
})

// ── Suite 2: Result shape (validation + scope + meta) ─────────────────────────

describe('previewImport — result shape', () => {
  it('meta.snapshotId is populated from the workbook _meta sheet', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, {
      snapshotId: 'shape-snap-abc',
      exportedAt: '2026-07-06',
    })

    const result = await previewImport(mockPrisma, bytes, DEFAULT_SCOPE)

    expect(result.meta.snapshotId).toBe('shape-snap-abc')
  })

  it('scope is passed through verbatim (channel + markets + includeMaster)', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, {
      snapshotId: 'scope-snap',
      exportedAt: '2026-07-06',
    })

    const result = await previewImport(mockPrisma, bytes, DEFAULT_SCOPE)

    expect(result.scope.channel).toBe('AMAZON')
    expect(result.scope.markets).toContain('IT')
    expect(result.scope.includeMaster).toBe(false)
  })

  it('validation is returned as an array (may contain readonly-column warnings)', async () => {
    const bytes = await generateWorkbook(MODEL, DATA, {
      snapshotId: 'val-snap',
      exportedAt: '2026-07-06',
    })

    const result = await previewImport(mockPrisma, bytes, DEFAULT_SCOPE)

    expect(Array.isArray(result.validation)).toBe(true)
  })
})

// ── Suite 4: Conflict detection (FF2.7) ──────────────────────────────────────

describe('previewImport — conflict detection (FF2.7)', () => {
  it('DB quantity changed since export → diff contains kind:conflict for quantity@IT', async () => {
    // Generate workbook from state A (quantityOverride = 5 for P1)
    const bytes = await generateWorkbook(MODEL, DATA, {
      snapshotId: 'conflict-snap-001',
      exportedAt: '2026-07-06',
    })

    // Mock prisma returning state B: DB has quantity changed to 10 after export
    const mockPrismaStateB = {
      product: {
        findMany: async () => [
          {
            sku: 'P1',
            parent: null,
            ean: '08054323310123',
            name: 'P1 Giacca Moto',
            brand: 'Xavia',
            status: 'ACTIVE',
            fulfillmentMethod: 'FBA',
          },
        ],
      },
      channelListing: {
        findMany: async () => [
          {
            marketplace: 'IT',
            channel: 'AMAZON',
            product: { sku: 'P1' },
            followMasterPrice: true,
            masterPrice: 189.9,
            priceOverride: null,
            followMasterTitle: true,
            masterTitle: 'P1 Giacca Moto',
            titleOverride: null,
            followMasterDescription: true,
            masterDescription: 'Giacca moto per piloti.',
            descriptionOverride: null,
            followMasterQuantity: false,
            masterQuantity: 0,
            quantityOverride: 10, // CHANGED from 5 → 10 in DB after export
            followMasterBulletPoints: true,
            masterBulletPoints: ['CE Level 2'],
            bulletPointsOverride: null,
            listingStatus: 'ACTIVE',
            syncStatus: 'IN_SYNC',
            isPublished: true,
            offerActive: true,
            fulfillmentMethod: 'FBA',
          },
        ],
      },
    }

    const result = await previewImport(mockPrismaStateB, bytes, DEFAULT_SCOPE)

    // quantity@IT in workbook = 5 (state A); quantity@IT in DB = 10 (state B)
    // Snapshot fingerprint (state A) ≠ current DB fingerprint (state B) → conflict
    expect(result.diff.stats.conflicts).toBeGreaterThan(0)
    const conflictChange = result.diff.changes.find(c => c.kind === 'conflict')
    expect(conflictChange).toBeDefined()
    expect(conflictChange!.sku).toBe('P1')
    expect(conflictChange!.note).toBe('Row changed in DB since export')
  })
})

// ── Suite 3: Read-only guard ──────────────────────────────────────────────────

describe('previewImport — read-only guard', () => {
  it('resolves without error when prisma exposes only findMany (no write methods)', async () => {
    // mockPrisma has no create/update/delete methods.
    // If previewImport called any write method, JavaScript would throw
    //   TypeError: ... is not a function — which would reject this promise.
    const bytes = await generateWorkbook(MODEL, DATA, {
      snapshotId: 'readonly-snap',
      exportedAt: '2026-07-06',
    })

    await expect(
      previewImport(mockPrisma, bytes, DEFAULT_SCOPE),
    ).resolves.toBeDefined()
  })

  it('empty workbook (no data rows) returns a valid empty-diff result', async () => {
    const emptyData: WorkbookData = {
      products: [],
      listings: { AMAZON: [], EBAY: [], SHOPIFY: [] },
    }
    const bytes = await generateWorkbook(MODEL, emptyData, {
      snapshotId: 'empty-snap',
      exportedAt: '2026-07-06',
    })

    const emptyPrisma = {
      product: { findMany: async () => [] },
      channelListing: { findMany: async () => [] },
    }

    const result = await previewImport(emptyPrisma, bytes, DEFAULT_SCOPE)

    expect(result.diff.stats.adds).toBe(0)
    expect(result.diff.stats.updates).toBe(0)
    expect(result.diff.changes).toHaveLength(0)
    expect(result.diff.deletes).toEqual([])
    expect(result.meta.snapshotId).toBe('empty-snap')
  })
})
