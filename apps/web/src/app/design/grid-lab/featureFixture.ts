/**
 * AG.4 — the FEATURE fixture. Separate from `fixture.ts` on purpose.
 *
 * `LAB_ROWS` is the parity baseline: both engines are measured against it, and the numbers in the
 * parity table are only comparable across sessions while it stays frozen. Grouping, pivot, tree
 * data, master/detail and sparklines all need shape that fixture does not have — a child level, a
 * path, a time series — so they get their own rows here rather than mutating the baseline.
 *
 * Derived FROM `LAB_ROWS` so the two labs describe the same campaigns and a reader moving between
 * tabs is not re-learning the data.
 */
import { LAB_ROWS, type LabRow } from './fixture'

/** One ad group under a campaign — the detail level for master/detail. */
export interface AdGroupRow {
  id: string
  campaignId: string
  name: string
  spend: number
  sales: number
  clicks: number
}

export interface FeatureRow extends LabRow {
  /** Marketplace — a second grouping dimension, so pivot has rows AND columns to work with. */
  market: 'DE' | 'IT' | 'FR'
  /** Status as a string, for the Set Filter and the rich-select editor. */
  status: 'Enabled' | 'Paused' | 'Archived'
  /** 12 points of daily spend — the sparkline series. */
  history: number[]
  /** Tree path: Marketplace → Type → Campaign. Drives Tree Data. */
  path: string[]
  adGroups: AdGroupRow[]
}

const MARKETS = ['DE', 'IT', 'FR'] as const

/** Deterministic, so a screenshot taken today matches one taken tomorrow. No Math.random. */
const series = (seed: number, n = 12) =>
  Array.from({ length: n }, (_, i) => Math.round((Math.sin(seed + i / 1.7) * 0.5 + 0.75) * seed * 12) / 10)

export const FEATURE_ROWS: FeatureRow[] = LAB_ROWS.map((r, i) => {
  const market = MARKETS[i % MARKETS.length]
  const status: FeatureRow['status'] = r.live ? 'Enabled' : i % 4 === 3 ? 'Archived' : 'Paused'
  return {
    ...r,
    market,
    status,
    history: series(Math.max(r.spend, 8) / 10 + i),
    path: [market, r.kind, r.name],
    adGroups: Array.from({ length: (i % 3) + 1 }, (_, g) => ({
      id: `${r.id}-ag${g + 1}`,
      campaignId: r.id,
      name: `${r.kind} · Ad group ${g + 1}`,
      spend: Math.round((r.spend / ((i % 3) + 1)) * 100) / 100,
      sales: Math.round((r.sales / ((i % 3) + 1)) * 100) / 100,
      clicks: Math.round(r.clicks / ((i % 3) + 1)),
    })),
  }
})

/** A bigger set, for the row-model demos where 12 rows would prove nothing about virtualisation. */
export const BIG_ROWS: FeatureRow[] = Array.from({ length: 5000 }, (_, i) => {
  const base = FEATURE_ROWS[i % FEATURE_ROWS.length]
  return {
    ...base,
    id: `big-${i}`,
    name: `${base.name} #${i + 1}`,
    spend: Math.round((base.spend * (1 + (i % 17) / 20)) * 100) / 100,
    sales: Math.round((base.sales * (1 + (i % 13) / 20)) * 100) / 100,
    path: [base.market, base.kind, `${base.name} #${i + 1}`],
  }
})
