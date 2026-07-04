/**
 * ER2 — the ONE CampaignPlan object every wizard step reads and writes
 * (SPEC-campaign-builder §4). Serializable (drafts), versioned, per-type.
 */

export type WizardType = 'general' | 'priority-manual' | 'priority-smart'

export interface SelectionRule { brands: string[]; categoryIds: string[]; minPrice: string; maxPrice: string }
export interface Seed { text: string; source: string; matchType: 'PHRASE' | 'EXACT' | 'BROAD'; bidEur: string; on: boolean }
export interface PlanAdGroup { name: string; defaultBidEur: string; seeds: Seed[]; negativesText: string; negMatch: 'EXACT' | 'PHRASE' }

export interface CampaignPlan {
  v: 1
  type: WizardType
  marketplace: string
  template: string | null
  // ① setup
  name: string
  endDate: string
  // ② targeting (GEN) / structure (PRI-manual) / max cpc (PRI-smart)
  targetingMode: 'key' | 'rules'
  criterion: { autoSelectFutureInventory: boolean; rules: SelectionRule[] }
  adRateStrategy: 'FIXED' | 'DYNAMIC'
  campaignRatePct: string
  dynamicCapPct: string
  adGroups: PlanAdGroup[]
  maxCpcEur: string
  // ③ listings
  selected: string[]
  resolutions: Record<string, 'include' | 'skip' | 'move'>
  // ④ rates / budget
  perRate: Record<string, string>
  globalRate: string
  rateDiscovery: { on: boolean; floorPct: string; capPct: string; stepPct: string; dwellDays: string }
  budgetEur: string
  // packs + review acknowledgements
  rulePacks: string[]
  acks: string[]
}

export const emptyGroup = (): PlanAdGroup => ({ name: 'Default', defaultBidEur: '0.30', seeds: [], negativesText: '', negMatch: 'EXACT' })

export function newPlan(type: WizardType, marketplace: string, template: string | null): CampaignPlan {
  return {
    v: 1, type, marketplace, template,
    name: '', endDate: template === 'clearance' ? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) : '',
    targetingMode: template === 'catch_all' ? 'rules' : 'key',
    criterion: { autoSelectFutureInventory: template === 'catch_all', rules: [] },
    adRateStrategy: 'FIXED', campaignRatePct: '', dynamicCapPct: '10',
    adGroups: [emptyGroup()],
    maxCpcEur: '0.40',
    selected: [], resolutions: {},
    perRate: {}, globalRate: '',
    rateDiscovery: { on: false, floorPct: '2', capPct: '8', stepPct: '1', dwellDays: '7' },
    budgetEur: '5.00',
    rulePacks: [], acks: [],
  }
}

/** The template registry mirror the chooser fetches from the API. */
export interface BuilderTemplate { key: string; label: string; strategy: 'CPS' | 'CPC'; goalFactor: number; fallbackRatePct: number; endDays: number | null; rulePacks: string[] }

/** Server listing-plan rows (POST /builder/listings). */
export interface PlanListing {
  itemId: string; title: string | null; priceCents: number | null; quantity: number | null
  // EV2 — picker thumbnails + family grouping
  imageUrl: string | null; productId: string | null; productName: string | null
  breakEvenPct: number | null; economicsStatus: string | null
  computedRatePct: number | null; rateSource: string
  trailingSales30dCents: number; forecastMonthlyFeeCents: number | null
  conflict: { campaignId: string; campaignName: string; currentRatePct: number | null } | null
}
export interface ListingsPayload {
  listings: PlanListing[]
  totals: { listings: number; conflicts: number; missingCost: number; forecastMonthlyFeeCents: number; trailingSales30dCents: number }
  activeCampaigns: number
  suggestedName: string
}

export const effRate = (plan: CampaignPlan, l: PlanListing): number | null => {
  const o = plan.perRate[l.itemId]
  if (o != null && o !== '') return Number(o)
  if (plan.globalRate !== '') return Number(plan.globalRate)
  return l.computedRatePct
}

export const includedListings = (plan: CampaignPlan, listings: PlanListing[]): PlanListing[] =>
  listings.filter((l) => plan.selected.includes(l.itemId) && (plan.resolutions[l.itemId] ?? 'include') !== 'skip')
