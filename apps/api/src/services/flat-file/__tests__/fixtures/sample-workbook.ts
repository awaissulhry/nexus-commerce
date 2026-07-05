/**
 * FF1.8 — Fixed in-memory fixtures for determinism tests.
 *
 * MODEL uses the full MASTER_FIELDS + CHANNEL_MARKET_FIELDS registries so the
 * determinism gate exercises the real generator surface area.
 *
 * DATA contains exactly 2 product rows and 2 listing rows (one per market).
 * All values are FIXED — no Date.now(), Math.random(), or any other volatile
 * source. This ensures that any non-determinism caught by the byte-identity
 * test is genuinely a generator bug, not a fixture bug.
 */

import type { WorkbookModel } from '../../registry/types'
import type { WorkbookData } from '../../fetch'
import { MASTER_FIELDS } from '../../registry/master-fields'
import { CHANNEL_MARKET_FIELDS } from '../../registry/channel-fields'

// ── Model ─────────────────────────────────────────────────────────────────────

export const MODEL: WorkbookModel = {
  markets: { AMAZON: ['IT', 'DE'], EBAY: [], SHOPIFY: [] },
  sheets: [
    {
      name: 'Products',
      sharedFields: MASTER_FIELDS,
      marketFields: [],
    },
    {
      name: 'Amazon',
      channel: 'AMAZON',
      sharedFields: [],
      marketFields: CHANNEL_MARKET_FIELDS,
    },
  ],
}

// ── Data ──────────────────────────────────────────────────────────────────────

export const DATA: WorkbookData = {
  products: [
    {
      // Parent row — no parent_sku; most optional Product columns are absent
      // (readSource returns '' via the ?? '' fallback).
      sku: 'GALE',
      parent_sku: '',
      name: 'GALE Jacket Family',
      brand: 'Xavia',
      status: 'ACTIVE',
      fulfillmentMethod: 'FBA',
    },
    {
      // Child row — references parent GALE; has EAN + base price for exercises.
      sku: 'GALE-M',
      parent_sku: 'GALE',
      ean: '08054323310123',
      basePrice: 189.9,
      name: 'GALE Jacket Medium',
      brand: 'Xavia',
      status: 'ACTIVE',
      fulfillmentMethod: 'FBA',
    },
  ],

  listings: {
    AMAZON: [
      {
        // IT listing for GALE-M — follows master price.
        sku: 'GALE-M',
        marketplace: 'IT',
        // Governed: price resolves via masterPrice when followMasterPrice is truthy.
        followMasterPrice: true,
        masterPrice: 189.9,
        priceOverride: null,
        // Governed: title
        followMasterTitle: true,
        masterTitle: 'GALE Jacket Medium',
        titleOverride: null,
        // Governed: description
        followMasterDescription: true,
        masterDescription: 'Motorcycle jacket for medium riders.',
        descriptionOverride: null,
        // Governed: quantity
        followMasterQuantity: false,
        masterQuantity: 0,
        quantityOverride: 12,
        // Governed: bullets
        followMasterBulletPoints: true,
        masterBulletPoints: ['CE Level 2', 'Waterproof'],
        bulletPointsOverride: null,
        // Non-governed per-market fields
        listingStatus: 'ACTIVE',
        syncStatus: 'IN_SYNC',
        isPublished: true,
        offerActive: true,
        fulfillmentMethod: 'FBA',
      },
      {
        // DE listing for GALE-M — uses a price override.
        sku: 'GALE-M',
        marketplace: 'DE',
        followMasterPrice: false,
        masterPrice: 189.9,
        priceOverride: 179.9,
        followMasterTitle: true,
        masterTitle: 'GALE Jacket Medium',
        titleOverride: null,
        followMasterDescription: true,
        masterDescription: 'Motorcycle jacket for medium riders.',
        descriptionOverride: null,
        followMasterQuantity: false,
        masterQuantity: 0,
        quantityOverride: 8,
        followMasterBulletPoints: true,
        masterBulletPoints: ['CE Level 2', 'Waterproof'],
        bulletPointsOverride: null,
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
