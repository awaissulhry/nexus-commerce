/**
 * W9.6c — Replenishment shared types.
 *
 * Centralizes the wire-shape types the workspace + extracted shared
 * components consume. Pure types — no runtime, no React. Lives next
 * to the components in _shared/ so the workspace and each card pull
 * the same Suggestion shape.
 *
 * Migrated from the inline definitions at the top of
 * ReplenishmentWorkspace.tsx. Not a redesign — exact same shape; just
 * relocated so the workspace doesn't have to be the source of truth
 * for types every extracted card needs.
 */

export type Urgency = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface OpenShipmentRef {
  shipmentId: string
  type: string
  status: string
  expectedAt: string | null
  remainingUnits: number
  reference: string | null
}

export interface Suggestion {
  productId: string
  sku: string
  name: string
  currentStock: number
  inboundWithinLeadTime: number
  totalOpenInbound: number
  effectiveStock: number
  openShipments: OpenShipmentRef[]
  unitsSold30d: number
  velocity: number
  trailingVelocity: number
  forecastedDemand30d: number | null
  forecastedDemandLeadTime: number | null
  forecastedDemandLower80: number | null
  forecastedDemandUpper80: number | null
  forecastSource: 'FORECAST' | 'TRAILING_VELOCITY'
  daysOfStockLeft: number | null
  reorderPoint: number
  reorderQuantity: number
  urgency: Urgency
  needsReorder: boolean
  isManufactured: boolean
  preferredSupplierId: string | null
  fulfillmentChannel: string | null
  leadTimeDays: number
  leadTimeSource: 'SUPPLIER_PRODUCT_OVERRIDE' | 'SUPPLIER_DEFAULT' | 'FALLBACK'
  // R.2 — multi-location stock breakdown
  byLocation?: Array<{
    locationId: string
    locationCode: string
    locationName: string
    locationType: string
    servesMarketplaces: string[]
    quantity: number
    reserved: number
    available: number
  }>
  totalAvailable?: number
  stockSource?: string
  channelCover?: Array<{
    channel: string
    marketplace: string
    velocityPerDay: number
    available: number
    locationCode: string | null
    source: string
    daysOfCover: number | null
  }>
  // R.3 — id of the persisted ReplenishmentRecommendation that
  // produced this suggestion. Sent back in PO creation so the audit
  // trail links rec → PO.
  recommendationId?: string | null
  // R.14 — urgency provenance. globalUrgency = aggregate signal;
  // urgency = max(global, worst-channel). urgencySource flags
  // whether a specific channel-marketplace promoted the headline.
  // R.13 added 'EVENT' for prep-deadline driven promotion.
  globalUrgency?: Urgency
  urgencySource?: 'GLOBAL' | 'CHANNEL' | 'EVENT'
  worstChannelKey?: string | null
  worstChannelDaysOfCover?: number | null
  // R.13 — event-prep recommendation
  prepEvent?: {
    eventId: string
    name: string
    startDate: string
    prepDeadline: string
    daysUntilStart: number
    daysUntilDeadline: number
    expectedLift: number
    extraUnitsRecommended: number
  } | null
  prepEventId?: string | null
  prepExtraUnits?: number | null
  // R.15 — FX context for cost basis
  unitCostCurrency?: string
  fxRateUsed?: number | null
  // R.4 — math snapshot for the drawer's "Reorder math" panel.
  safetyStockUnits?: number
  eoqUnits?: number
  constraintsApplied?: string[]
  unitCostCents?: number | null
  servicePercentEffective?: number
}

/**
 * W9.6e — Detail-drawer wire shape. Pulled by the per-product
 * ForecastDetailDrawer + every nested panel (ReorderMathPanel,
 * SubstitutionPanel, etc). Centralized so each extracted panel
 * imports the same view of the response.
 */
export interface DetailResponse {
  product: { id: string; sku: string; name: string; currentStock: number }
  atp: {
    leadTimeDays: number
    leadTimeSource: string
    inboundWithinLeadTime: number
    totalOpenInbound: number
    openShipments: OpenShipmentRef[]
    // R.2 — multi-location additions
    byLocation?: Array<{
      locationId: string
      locationCode: string
      locationName: string
      locationType: string
      servesMarketplaces: string[]
      quantity: number
      reserved: number
      available: number
    }>
    totalQuantity?: number
    totalAvailable?: number
    stockSource?: string
  } | null
  // R.2 — per-channel cover breakdown
  channelCover?: Array<{
    channel: string
    marketplace: string
    velocityPerDay: number
    available: number
    locationCode: string | null
    source: string
    daysOfCover: number | null
  }>
  // R.4 — math snapshot from the latest ACTIVE recommendation
  recommendation?: {
    id: string
    urgency: string
    reorderPoint: number
    reorderQuantity: number
    safetyStockUnits: number | null
    eoqUnits: number | null
    constraintsApplied: string[]
    unitCostCents: number | null
    velocity: number | string
    generatedAt: string
    // R.14 — urgency provenance
    urgencySource?: string | null
    worstChannelKey?: string | null
    worstChannelDaysOfCover?: number | null
    // R.11 — σ_LT applied
    leadTimeStdDevDays?: number | string | null
    // R.15 — FX context
    unitCostCurrency?: string | null
    fxRateUsed?: number | string | null
    // R.17 — substitution audit
    rawVelocity?: number | string | null
    substitutionAdjustedDelta?: number | string | null
    // R.19 — landed-cost audit
    freightCostPerUnitCents?: number | null
    landedCostPerUnitCents?: number | null
    // R.8 — Amazon FBA Restock cross-check audit
    amazonRecommendedQty?: number | null
    amazonDeltaPct?: number | string | null
    amazonReportAsOf?: string | null
  } | null
  model: string | null
  generationTag: string | null
  signals: unknown
  series: Array<{
    day: string
    actual: number | null
    forecast: number | null
    lower80: number | null
    upper80: number | null
  }>
  // R.17 — substitution links visible from this product (either side).
  substitutions?: Array<{
    id: string
    primaryProductId: string
    substituteProductId: string
    substitutionFraction: number | string
    primary?: { id: string; sku: string; name: string } | null
    substitute?: { id: string; sku: string; name: string } | null
  }>
}
