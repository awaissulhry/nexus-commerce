// FF1.1 — Channel field registry.
// Source: FF0-FIELD-CENSUS §3 (schema.prisma:1413-1626 ChannelListing).
//
// CHANNEL_SHARED_FIELDS — ChannelListing fields that appear without @MKT suffix
//   (scope: 'SHARED'). Currently empty: every ChannelListing scalar is keyed by
//   (productId × channel × marketplace), making all fields effectively MARKET_SCOPED.
//   The Products sheet (MASTER_FIELDS) covers all truly-shared product data.
//
// CHANNEL_MARKET_FIELDS — per-market fields, expanded to field@MKT per discovered
//   market at workbook generation time (scope: 'MARKET_SCOPED').
//   source.model: 'ChannelListing' throughout.
//
// Exclusions:
//   flatFileSnapshot   — §3.4 / §6: opaque Amazon-row snapshot; NEVER regenerate
//   overrideData       — §3.4 / §6: raw resolver JSON; authored via override columns
//   variationMapping   — §3.4 / §6: flatten or exclude
//   platformAttributes — §3.4 / §6: channel-native JSON; exclude from scalar cells
//   channelMarket      — F15: legacy composite key superseded by channel+marketplace
//   region             — F15: legacy; superseded by marketplace
//   currentPrice       — VariantChannelListing (deprecated chain); never on ChannelListing

import type { FieldDefinition } from './types.js'

// ─── CHANNEL_SHARED_FIELDS ────────────────────────────────────────────────────
// All ChannelListing scalars are MARKET_SCOPED (one row per productId×channel×marketplace).
// No truly shared (non-@MKT) channel-sheet columns exist at this schema version.
export const CHANNEL_SHARED_FIELDS: FieldDefinition[] = []

// ─── CHANNEL_MARKET_FIELDS ────────────────────────────────────────────────────
export const CHANNEL_MARKET_FIELDS: FieldDefinition[] = [
  // ─── §3.1 Identity (per row) ───────────────────────────────────────────────

  {
    // ASIN (Amazon) / ItemID (eBay) / ProductID (Shopify)
    id: 'listing_id',
    label: 'Listing ID',
    kind: 'text',
    cls: 'IDENTITY',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'externalListingId' },
    forcedText: true,
    width: 16,
  },
  {
    // Parent ASIN for Amazon; readonly after creation
    id: 'parent_listing_id',
    label: 'Parent Listing ID',
    kind: 'text',
    cls: 'IDENTITY',
    scope: 'MARKET_SCOPED',
    channel: 'AMAZON',
    source: { model: 'ChannelListing', column: 'externalParentId' },
    forcedText: true,
    width: 16,
  },
  {
    // Analytics grouping key (ASIN / ItemID / ProductID); readonly
    id: 'platform_product_id',
    label: 'Platform Product ID',
    kind: 'text',
    cls: 'READONLY_SYNCED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'platformProductId' },
    forcedText: true,
    width: 18,
  },

  // ─── §3.2 Governed per-market content (FFD10-A follow-master toggles) ──────
  // Each governed field has a follow flag (followMasterXxx), an override column
  // that stores the operator value when not following master, and a masterXxx
  // cache column for quick display without a Products join.

  {
    id: 'title',
    label: 'Title',
    kind: 'text',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'title' },
    followMaster: {
      followColumn: 'followMasterTitle',
      overrideColumn: 'titleOverride',
      masterCacheColumn: 'masterTitle',
    },
    width: 32,
  },
  {
    id: 'description',
    label: 'Description',
    kind: 'longtext',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'description' },
    followMaster: {
      followColumn: 'followMasterDescription',
      overrideColumn: 'descriptionOverride',
      masterCacheColumn: 'masterDescription',
    },
    width: 40,
  },
  {
    id: 'price',
    label: 'Price',
    kind: 'decimal',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'price' },
    decimals: 2,
    followMaster: {
      followColumn: 'followMasterPrice',
      overrideColumn: 'priceOverride',
      masterCacheColumn: 'masterPrice',
    },
    width: 11,
  },
  {
    id: 'quantity',
    label: 'Quantity',
    kind: 'number',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'quantity' },
    followMaster: {
      followColumn: 'followMasterQuantity',
      overrideColumn: 'quantityOverride',
      masterCacheColumn: 'masterQuantity',
    },
    width: 10,
  },
  // bullets has no plain base column on ChannelListing: the resolver returns masterBulletPoints
  // when following master, else bulletPointsOverride. source.column === followMaster.overrideColumn
  // (both 'bulletPointsOverride') is intentional — there is no separate base 'bulletPoints' column.
  {
    // bulletPointsOverride[] is the per-market override; masterBulletPoints[] is the cache
    id: 'bullets',
    label: 'Bullet Points',
    kind: 'array',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'bulletPointsOverride' },
    arrayDelimiter: ' | ',
    followMaster: {
      followColumn: 'followMasterBulletPoints',
      overrideColumn: 'bulletPointsOverride',
      masterCacheColumn: 'masterBulletPoints',
    },
    width: 34,
  },

  // ─── Master cache columns (DERIVED; greyed readonly in workbook) ───────────

  {
    id: 'master_title',
    label: 'Master Title (cache)',
    kind: 'text',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'masterTitle' },
    width: 30,
  },
  {
    id: 'master_description',
    label: 'Master Description (cache)',
    kind: 'longtext',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'masterDescription' },
    width: 38,
  },
  {
    id: 'master_price',
    label: 'Master Price (cache)',
    kind: 'decimal',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'masterPrice' },
    decimals: 2,
    width: 14,
  },
  {
    id: 'master_quantity',
    label: 'Master Quantity (cache)',
    kind: 'number',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'masterQuantity' },
    width: 16,
  },
  {
    id: 'master_bullets',
    label: 'Master Bullets (cache)',
    kind: 'array',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'masterBulletPoints' },
    arrayDelimiter: ' | ',
    width: 32,
  },

  // ─── §3.2 Additional per-market editable ─────────────────────────────────

  {
    id: 'sale_price',
    label: 'Sale Price',
    kind: 'decimal',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'salePrice' },
    decimals: 2,
    width: 10,
  },
  {
    id: 'pricing_rule',
    label: 'Pricing Rule',
    kind: 'enum',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'pricingRule' },
    enumOptions: ['FIXED', 'MATCH_AMAZON', 'PERCENT_OF_MASTER'],
    enumMode: 'strict',
    width: 18,
  },
  {
    id: 'price_adj_pct',
    label: 'Price Adj %',
    kind: 'decimal',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'priceAdjustmentPercent' },
    decimals: 2,
    width: 12,
  },
  {
    // FCF.1 — per channel×marketplace fulfillment override
    id: 'fulfillment',
    label: 'Fulfillment',
    kind: 'enum',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'fulfillmentMethod' },
    enumOptions: ['FBA', 'FBM'],
    enumMode: 'strict',
    width: 12,
  },
  {
    // Phase 23.2 — overselling protection buffer
    id: 'stock_buffer',
    label: 'Stock Buffer',
    kind: 'number',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'stockBuffer' },
    width: 12,
  },
  {
    // eBay Best Offer auto-accept floor
    id: 'best_offer_floor',
    label: 'Best Offer Floor',
    kind: 'decimal',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    channel: 'EBAY',
    source: { model: 'ChannelListing', column: 'bestOfferFloor' },
    decimals: 2,
    width: 14,
  },
  {
    // Platform-specific variation theme override
    id: 'variation_theme',
    label: 'Variation Theme',
    kind: 'text',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'variationTheme' },
    width: 18,
  },
  {
    id: 'sync_from_master',
    label: 'Sync From Master',
    kind: 'boolean',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'syncFromMaster' },
    width: 16,
  },
  {
    id: 'sync_locked',
    label: 'Sync Locked',
    kind: 'boolean',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'syncLocked' },
    width: 12,
  },
  {
    id: 'is_published',
    label: 'Is Published',
    kind: 'boolean',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'isPublished' },
    width: 12,
  },
  {
    // MA.1 — offer pause control
    id: 'offer_active',
    label: 'Offer Active',
    kind: 'boolean',
    cls: 'EDITABLE',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'offerActive' },
    width: 12,
  },

  // ─── §3.3 Per-market READONLY_SYNCED / DERIVED ────────────────────────────

  {
    // Listing status mirrored from channel; ignored on import (Contract §7)
    id: 'status',
    label: 'Listing Status',
    kind: 'enum',
    cls: 'READONLY_SYNCED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'listingStatus' },
    enumOptions: ['DRAFT', 'ACTIVE', 'INACTIVE', 'ENDED', 'ERROR'],
    enumMode: 'strict',
    width: 12,
  },
  {
    id: 'sync_status',
    label: 'Sync Status',
    kind: 'enum',
    cls: 'READONLY_SYNCED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'syncStatus' },
    enumOptions: ['IDLE', 'PENDING', 'SYNCING', 'IN_SYNC', 'FAILED'],
    enumMode: 'strict',
    width: 12,
  },
  {
    id: 'last_sync_status',
    label: 'Last Sync Status',
    kind: 'text',
    cls: 'READONLY_SYNCED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'lastSyncStatus' },
    width: 14,
  },
  {
    id: 'last_sync_error',
    label: 'Last Sync Error',
    kind: 'text',
    cls: 'READONLY_SYNCED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'lastSyncError' },
    width: 24,
  },
  {
    id: 'last_synced_at',
    label: 'Last Synced At',
    kind: 'date',
    cls: 'READONLY_SYNCED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'lastSyncedAt' },
    width: 18,
  },
  {
    // G.3 — per-unit FBA fee from SP-API GetMyFeesEstimate
    id: 'fba_fee',
    label: 'Est. FBA Fee',
    kind: 'decimal',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    channel: 'AMAZON',
    source: { model: 'ChannelListing', column: 'estimatedFbaFee' },
    decimals: 2,
    width: 12,
  },
  {
    // G.3 — referral fee % from SP-API
    id: 'referral_pct',
    label: 'Referral Fee %',
    kind: 'decimal',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    channel: 'AMAZON',
    source: { model: 'ChannelListing', column: 'referralFeePercent' },
    decimals: 2,
    width: 13,
  },
  {
    // G.3 — lowest competitor price for this listing; readonly
    id: 'competitor_price',
    label: 'Competitor Price',
    kind: 'decimal',
    cls: 'READONLY_SYNCED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'lowestCompetitorPrice' },
    decimals: 2,
    width: 14,
  },
  {
    // Per-channel listing validation state; DERIVED; readonly
    id: 'ch_validation_status',
    label: 'Validation Status',
    kind: 'enum',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'validationStatus' },
    enumOptions: ['VALID', 'WARNING', 'ERROR'],
    enumMode: 'strict',
    width: 16,
  },
  {
    // Per-channel listing validation errors; DERIVED; readonly
    id: 'ch_validation_errors',
    label: 'Validation Errors',
    kind: 'array',
    cls: 'DERIVED',
    scope: 'MARKET_SCOPED',
    source: { model: 'ChannelListing', column: 'validationErrors' },
    arrayDelimiter: ' | ',
    width: 24,
  },
]
