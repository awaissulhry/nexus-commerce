// Shared types for the /insights hub (IH.0 — Foundation).
//
// Mirrors the dashboard overview's window/compare vocabulary so the
// existing /api/dashboard/overview endpoint can back IH.1 widgets
// without translation, while leaving room for IH-specific extensions
// (multi-channel + multi-market filters that the overview header
// does not yet expose).

export type WindowKey =
  | 'today'
  | '7d'
  | '30d'
  | '90d'
  | 'ytd'
  | 'mtd'
  | 'qtd'
  | 'custom'

export type CompareKey = 'prev' | 'dod' | 'wow' | 'mom' | 'yoy' | 'none'

export type ChannelCode = 'AMAZON' | 'EBAY' | 'SHOPIFY'

export interface InsightsFilterState {
  window: WindowKey
  from: string | null
  to: string | null
  compare: CompareKey
  channels: ChannelCode[]
  markets: string[]
  brands: string[]
}

export interface SeriesPoint {
  date: string
  value: number
}

export interface MultiSeriesPoint {
  date: string
  [key: string]: number | string
}

export interface BreakdownEntry {
  key: string
  label: string
  value: number
  share?: number
  delta?: number | null
  color?: string
}

export interface KPIValue {
  current: number
  previous?: number
  deltaPct?: number | null
  series?: number[]
}

export interface WaterfallStep {
  key: string
  label: string
  value: number
  kind: 'start' | 'add' | 'sub' | 'total'
}
