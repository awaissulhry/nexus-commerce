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
