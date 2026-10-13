/**
 * The lab's frozen campaign rows (`featureFixture.ts` builds the enterprise-feature rows from them).
 *
 * WHY A FIXTURE AND NOT REAL DATA
 * The ads console is unverifiable locally: every data region 401s with no CORS, so a local page
 * renders chrome and empty grids. So the rows are frozen here and the lab needs no API at all.
 *
 * WHY THE NULLS ARE THE POINT
 * `acos` and `ctr` are null on rows that genuinely have no measurement — a campaign that spent
 * nothing has no ACoS, and that is NOT an ACoS of zero. A fixture with no nulls in it would let a
 * blank-handling regression through silently.
 */
export interface LabRow {
  id: string
  name: string
  kind: 'SP' | 'SB' | 'SD'
  live: boolean
  spend: number
  sales: number
  /** null = never measured. NOT zero. */
  acos: number | null
  impressions: number
  clicks: number
  /** null = no impressions, so a click-through rate does not exist. */
  ctr: number | null
  orders: number
  budget: number
}

export const LAB_ROWS: LabRow[] = [
  { id: 'c1',  name: 'SP | Brand Defense | Exact',        kind: 'SP', live: true,  spend: 412.55, sales: 2104.30, acos: 19.60, impressions: 84210, clicks: 1204, ctr: 1.43, orders: 96, budget: 60 },
  { id: 'c2',  name: 'SP | Category | Broad',             kind: 'SP', live: true,  spend: 988.12, sales: 3410.88, acos: 28.97, impressions: 210433, clicks: 2988, ctr: 1.42, orders: 141, budget: 120 },
  { id: 'c3',  name: 'SB | Headline | Top of Search',     kind: 'SB', live: true,  spend: 220.00, sales: 640.10,  acos: 34.37, impressions: 41022, clicks: 604,  ctr: 1.47, orders: 24, budget: 40 },
  { id: 'c4',  name: 'SD | Retargeting | Views',          kind: 'SD', live: false, spend: 0,      sales: 0,       acos: null,  impressions: 0,     clicks: 0,    ctr: null, orders: 0,  budget: 25 },
  { id: 'c5',  name: 'SP | Competitor ASINs',             kind: 'SP', live: true,  spend: 640.71, sales: 1188.02, acos: 53.93, impressions: 96440, clicks: 1811, ctr: 1.88, orders: 47, budget: 80 },
  { id: 'c6',  name: 'SP | Long Tail | Phrase',           kind: 'SP', live: true,  spend: 74.20,  sales: 512.44,  acos: 14.48, impressions: 18220, clicks: 244,  ctr: 1.34, orders: 22, budget: 20 },
  { id: 'c7',  name: 'SB | Video | Category',             kind: 'SB', live: false, spend: 0,      sales: 0,       acos: null,  impressions: 0,     clicks: 0,    ctr: null, orders: 0,  budget: 35 },
  { id: 'c8',  name: 'SD | Product Targeting | Similar',  kind: 'SD', live: true,  spend: 155.90, sales: 289.77,  acos: 53.80, impressions: 60110, clicks: 402,  ctr: 0.67, orders: 11, budget: 30 },
  { id: 'c9',  name: 'SP | Auto | Discovery',             kind: 'SP', live: true,  spend: 301.44, sales: 1502.10, acos: 20.07, impressions: 72900, clicks: 981,  ctr: 1.35, orders: 63, budget: 45 },
  { id: 'c10', name: 'SP | Seasonal | Exact',             kind: 'SP', live: false, spend: 12.05,  sales: 0,       acos: null,  impressions: 3110,  clicks: 40,   ctr: 1.29, orders: 0,  budget: 15 },
  { id: 'c11', name: 'SB | Store Spotlight',              kind: 'SB', live: true,  spend: 480.33, sales: 2290.14, acos: 20.97, impressions: 130400, clicks: 1502, ctr: 1.15, orders: 88, budget: 70 },
  { id: 'c12', name: 'SD | Audiences | In-Market',        kind: 'SD', live: true,  spend: 96.18,  sales: 144.20,  acos: 66.70, impressions: 44300, clicks: 288,  ctr: 0.65, orders: 6,  budget: 20 },
]
