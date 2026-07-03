'use client'

/**
 * E3 — shared client lib for the eBay Ads console pages (/marketing/ads/ebay).
 * Types mirror apps/api/src/routes/ebay-ads.routes.ts payloads. Every page
 * shows a freshness line ("as of …") and labels attribution as any-click.
 */
import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { ago } from '../_canvas/format'

// ── Types (API mirrors) ──────────────────────────────────────────────────────
export interface Derived {
  impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number
  ctrPct: number | null; acosPct: number | null; avgCpcCents: number | null
}
export interface Freshness { factsReportedAt: string | null; entitySyncAt: string | null; listingSeenAt: string | null }

export interface SummaryPayload {
  window: { preset: string; since: string; until: string; days: number; includesToday: boolean }
  currency: string
  current: Derived
  prior: Derived
  deltas: { adFeesPct: number | null; salesPct: number | null; clicksPct: number | null; impressionsPct: number | null }
  campaignCounts: Record<string, number>
  economicsStatus: Record<string, number>
  attributionModel: string
  coverage?: { liveListings: number; promoted: number; pct: number | null }
  freshness: Freshness
}
export interface TrendPayload {
  window: { since: string; until: string; bucket: string }
  points: Array<Derived & { date: string }>
  freshness: Freshness
}
export interface CampaignRow {
  id: string; externalCampaignId: string; name: string; marketplace: string
  fundingModel: string; targetingType: string | null; channels: string[]; status: string
  adRateStrategy: string | null; bidPercentage: number | null; dailyBudgetCents: number | null
  budgetCurrency: string; isRulesBased: boolean; nexusManaged: boolean
  startDate: string; endDate: string | null; lastEntitySyncAt: string | null
  ads: { total: number; stale: number }
  metrics: Derived
}
export interface AdRow {
  id: string; listingId: string | null; inventoryReference: string | null; status: string
  bidPercentage: number | null; createdVia: string; title: string | null; priceCents: number | null
  quantity: number | null; listingEnded: boolean | null
  breakEvenAdRatePct: number | null; economicsStatus: string | null
  metrics: Derived
}
export interface KeywordRow {
  id: string; adGroupId: string; adGroupName: string | null; externalKeywordId: string
  text: string; matchType: string; bidCents: number | null; status: string; metrics: Derived
}
export interface CampaignDetailPayload {
  window: { preset: string; since: string; until: string }
  currency: string
  campaign: CampaignRow & { dynamicAdRatePrefs: Record<string, unknown> | null; campaignCriterion: Record<string, unknown> | null; budgetUpdatesToday: number }
  ads: AdRow[]
  adGroups: Array<{ id: string; externalAdGroupId: string; name: string; status: string; defaultBidCents: number | null }>
  keywords: KeywordRow[]
  negativeKeywords: Array<{ id: string; text: string; matchType: string; status: string }>
  freshness: Freshness
}
export interface ProductListingRow {
  itemId: string; marketplace: string; title: string | null; priceCents: number | null; currency: string
  quantity: number | null; matchStatus: string; breakEvenAdRatePct: number | null; economicsStatus: string | null
  metrics: Derived
}
export interface ProductsPayload {
  window: { preset: string; since: string; until: string }
  currency: string
  products: Array<{ productId: string; sku: string | null; name: string | null; hasCost: boolean; costPriceCents: number | null; listings: ProductListingRow[]; metrics: Derived }>
  unmatchedListings: ProductListingRow[]
  freshness: Freshness
}

// ── Window/marketplace state + fetch ─────────────────────────────────────────
export const EBAY_MARKETS = [
  { id: 'all', label: 'All marketplaces' },
  { id: 'EBAY_IT', label: 'Italy (EBAY_IT)' },
  { id: 'EBAY_DE', label: 'Germany (EBAY_DE)' },
  { id: 'EBAY_FR', label: 'France (EBAY_FR)' },
  { id: 'EBAY_ES', label: 'Spain (EBAY_ES)' },
]
export const PRESETS = [
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last14', label: 'Last 14 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'mtd', label: 'Month to date' },
  { id: 'last90', label: 'Last 90 days' },
]

export function useEbayAdsFetch<T>(path: string, market: string, preset: string): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const sep = path.includes('?') ? '&' : '?'
      const r = await fetch(`${getBackendUrl()}/api/ebay-ads${path}${sep}marketplace=${market}&preset=${preset}`, { credentials: 'include' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData((await r.json()) as T)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [path, market, preset])
  useEffect(() => { void load() }, [load])
  return { data, error, loading, reload: load }
}

// ── Formatters (cents-based; _canvas/format eur takes EUR units) ────────────
export const eurC = (cents?: number | null): string =>
  cents == null ? '—' : (cents / 100).toLocaleString('en-IE', { style: 'currency', currency: 'EUR' })
export const pctP = (p?: number | null, dp = 1): string => (p == null ? '—' : `${p.toFixed(dp)}%`)
export const intlN = (n?: number | null): string => (n == null ? '—' : Math.round(n).toLocaleString('en-IE'))

// ── E4 write helpers ─────────────────────────────────────────────────────────
export async function postEbayAds<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${getBackendUrl()}/api/ebay-ads${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string }
  if (!r.ok) throw new Error(j.error ?? j.message ?? `HTTP ${r.status}`)
  return j
}

export interface WriteItemOutcome { key: string; ok: boolean; mode: string; id?: string | null; error?: string | null; warning?: string | null; blocked?: string | null }

export function useWriteMode(): 'sandbox' | 'live' | null {
  const [mode, setMode] = useState<'sandbox' | 'live' | null>(null)
  useEffect(() => {
    fetch(`${getBackendUrl()}/api/ebay-ads/write-mode`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => setMode(j.mode ?? null))
      .catch(() => setMode(null))
  }, [])
  return mode
}

export function SandboxBanner({ mode }: { mode: 'sandbox' | 'live' | null }) {
  if (mode !== 'sandbox') return null
  return (
    <div className="eb-sandbox" role="status">
      <b>Sandbox mode</b> — changes are validated, guardrail-checked, mirrored locally and audited, but <b>not pushed to eBay</b> until
      <code> NEXUS_MARKETING_WRITES_EBAY=1</code> is set (the E4 acceptance flip).
    </div>
  )
}

export function ResultsList({ results }: { results: WriteItemOutcome[] }) {
  return (
    <ul className="eb-results">
      {results.map((r, i) => (
        <li key={`${r.key}-${i}`} className={r.blocked ? 'blocked' : r.ok ? (r.warning ? 'warn' : 'ok') : 'err'}>
          <code>{r.key}</code> — {r.blocked ?? r.error ?? r.warning ?? (r.ok ? `done (${r.mode})` : 'failed')}
        </li>
      ))}
    </ul>
  )
}

// ── E6.1 — h10 grid idiom helpers (visual parity with the Amazon console) ────
/** eBay statuses → the console's .h10-pill classes (ok=blue, warn=amber, arch=grey). */
export const EBAY_STATUS_PILL: Record<string, { label: string; cls: string }> = {
  RUNNING: { label: 'Enabled', cls: 'ok' },
  ACTIVE: { label: 'Enabled', cls: 'ok' },
  PAUSED: { label: 'Paused', cls: 'warn' },
  DRAFT: { label: 'Draft', cls: 'arch' },
  ENDED: { label: 'Ended', cls: 'arch' },
  SUSPENDED: { label: 'Suspended', cls: 'warn' },
  STALE: { label: 'Stale', cls: 'warn' },
  SANDBOX: { label: 'Sandbox', cls: 'arch' },
}

// ── Small shared UI atoms ────────────────────────────────────────────────────
export function FreshnessLine({ f }: { f: Freshness | undefined }) {
  if (!f) return null
  return (
    <div className="eb-fresh" title="Sales/fee figures inside eBay's 72h Reconciliation Period are provisional.">
      Data as of: facts {ago(f.factsReportedAt)} · entities {ago(f.entitySyncAt)} · listings {ago(f.listingSeenAt)} · attribution: any-click (30d)
    </div>
  )
}

export function StrategyChip({ fundingModel, targetingType, channels }: { fundingModel: string; targetingType?: string | null; channels?: string[] }) {
  const offsite = (channels ?? []).includes('OFF_SITE')
  const label = offsite ? 'Offsite' : fundingModel === 'COST_PER_CLICK' ? (targetingType === 'SMART' ? 'Priority · Smart' : 'Priority') : 'General'
  const cls = offsite ? 'eb-chip--offsite' : fundingModel === 'COST_PER_CLICK' ? 'eb-chip--cpc' : 'eb-chip--cps'
  return <span className={`eb-chip ${cls}`}>{label}</span>
}

export function StatusChip({ status }: { status: string }) {
  const cls =
    status === 'RUNNING' || status === 'ACTIVE' ? 'eb-chip--run'
    : status === 'PAUSED' ? 'eb-chip--pause'
    : status === 'STALE' ? 'eb-chip--stale'
    : 'eb-chip--end'
  return <span className={`eb-chip ${cls}`}>{status}</span>
}

export function BreakEvenCell({ pct, status }: { pct: number | null; status: string | null }) {
  if (pct != null) return <span>{pctP(pct)}</span>
  if (status === 'MISSING_COGS') return <span className="eb-chip eb-chip--warn" title="No product cost on file — break-even can't be computed. This listing is manual-only for automations.">add cost</span>
  if (status === 'MISSING_PRICE') return <span className="eb-chip eb-chip--warn">no price</span>
  return <span>—</span>
}
