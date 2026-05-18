/**
 * Phase 8 — Advertising AI Insights.
 *
 * Rule-based insight engine: four types derived from live aggregates.
 *   NEGATIVE_KW     — search terms burning budget with zero orders
 *   HIGH_ACOS       — campaigns above ACOS target (default 35%)
 *   STALE_CAMPAIGN  — ENABLED campaigns with zero impressions
 *   LOW_ACOS        — campaigns below 8% ACOS with room to scale
 *
 * Server-rendered — no client state needed. Refresh the page to re-run.
 */

import {
  AlertTriangle, AlertCircle, Info, TrendingDown, TrendingUp,
  Search, Activity, Lightbulb, CheckCircle2,
} from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

// ── Types ────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'warning' | 'info'
type InsightType = 'NEGATIVE_KW' | 'HIGH_ACOS' | 'LOW_ACOS' | 'STALE_CAMPAIGN'

interface NegKwItem {
  query: string; matchType: string | null; adProduct: string
  marketplace: string; clicks: number; costEur: number
}
interface CampItem {
  name: string; adProduct: string; marketplace: string; acos: number; spendEur: number
}
interface StaleItem { name: string; adProduct: string; marketplace: string }

interface Insight {
  type: InsightType
  severity: Severity
  title: string
  description: string
  count: number
  totalSpendCents: number
  items: NegKwItem[] | CampItem[] | StaleItem[]
}

interface InsightsResponse {
  windowDays: number
  generatedAt: string
  params: { minSpendEur: number; acosTarget: number; lowAcosTarget: number }
  count: number
  insights: Insight[]
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

// ── Severity config ──────────────────────────────────────────────────────────

const SEV: Record<Severity, {
  border: string; bg: string; badge: string; Icon: React.ElementType
}> = {
  critical: {
    border: 'border-red-200 dark:border-red-800',
    bg:     'bg-red-50 dark:bg-red-900/10',
    badge:  'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
    Icon:   AlertCircle,
  },
  warning: {
    border: 'border-amber-200 dark:border-amber-800',
    bg:     'bg-amber-50 dark:bg-amber-900/10',
    badge:  'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    Icon:   AlertTriangle,
  },
  info: {
    border: 'border-blue-200 dark:border-blue-800',
    bg:     'bg-blue-50 dark:bg-blue-900/10',
    badge:  'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    Icon:   Info,
  },
}

const TYPE_ICON: Record<InsightType, React.ElementType> = {
  NEGATIVE_KW:    Search,
  HIGH_ACOS:      TrendingDown,
  LOW_ACOS:       TrendingUp,
  STALE_CAMPAIGN: Activity,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtEur(cents: number) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'EUR',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(cents / 100)
}

function fmtEurDec(eur: number) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'EUR',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(eur)
}

// ── Insight card ─────────────────────────────────────────────────────────────

function NegKwTable({ items }: { items: NegKwItem[] }) {
  return (
    <table className="w-full text-xs mt-2">
      <thead>
        <tr className="border-b border-slate-200 dark:border-slate-700">
          {['Query', 'Match', 'Ad Product', 'Market', 'Clicks', 'Spend'].map((h) => (
            <th key={h} className="pb-1 text-left font-medium text-slate-500 pr-3">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((it, i) => (
          <tr key={i}>
            <td className="py-1 pr-3 font-mono text-slate-700 dark:text-slate-300 max-w-[180px] truncate">{it.query}</td>
            <td className="py-1 pr-3 text-slate-500">{it.matchType ?? '—'}</td>
            <td className="py-1 pr-3 text-slate-500">{it.adProduct}</td>
            <td className="py-1 pr-3 text-slate-500">{it.marketplace}</td>
            <td className="py-1 pr-3 tabular-nums text-slate-600 dark:text-slate-400">{it.clicks}</td>
            <td className="py-1 tabular-nums text-red-600 dark:text-red-400 font-medium">{fmtEurDec(it.costEur)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CampTable({ items, showAcos }: { items: CampItem[]; showAcos: boolean }) {
  return (
    <table className="w-full text-xs mt-2">
      <thead>
        <tr className="border-b border-slate-200 dark:border-slate-700">
          {['Campaign', 'Ad Product', 'Market', 'ACOS', 'Spend'].map((h) => (
            <th key={h} className="pb-1 text-left font-medium text-slate-500 pr-3">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((it, i) => (
          <tr key={i}>
            <td className="py-1 pr-3 text-slate-700 dark:text-slate-300 max-w-[220px] truncate">{it.name}</td>
            <td className="py-1 pr-3 text-slate-500">{it.adProduct}</td>
            <td className="py-1 pr-3 text-slate-500">{it.marketplace}</td>
            <td className={`py-1 pr-3 tabular-nums font-medium ${
              showAcos
                ? (it.acos > 35 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')
                : 'text-emerald-600 dark:text-emerald-400'
            }`}>{it.acos.toFixed(1)}%</td>
            <td className="py-1 tabular-nums text-slate-600 dark:text-slate-400">{fmtEurDec(it.spendEur)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StaleTable({ items }: { items: StaleItem[] }) {
  return (
    <table className="w-full text-xs mt-2">
      <thead>
        <tr className="border-b border-slate-200 dark:border-slate-700">
          {['Campaign', 'Ad Product', 'Market'].map((h) => (
            <th key={h} className="pb-1 text-left font-medium text-slate-500 pr-3">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((it, i) => (
          <tr key={i}>
            <td className="py-1 pr-3 text-slate-700 dark:text-slate-300">{it.name}</td>
            <td className="py-1 pr-3 text-slate-500">{it.adProduct}</td>
            <td className="py-1 text-slate-500">{it.marketplace}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function InsightCard({ insight }: { insight: Insight }) {
  const sev = SEV[insight.severity]
  const SevIcon = sev.Icon
  const TypeIcon = TYPE_ICON[insight.type]

  const actionHref =
    insight.type === 'NEGATIVE_KW' ? '/marketing/advertising/search-terms?isCandidate=true'
    : insight.type === 'HIGH_ACOS'  ? '/marketing/advertising/campaigns'
    : insight.type === 'LOW_ACOS'   ? '/marketing/advertising/campaigns'
    : '/marketing/advertising/campaigns'

  return (
    <div className={`rounded-lg border ${sev.border} ${sev.bg} p-4`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <TypeIcon className="h-5 w-5 text-slate-500 dark:text-slate-400 shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${sev.badge}`}>
                <SevIcon className="inline h-3 w-3 mr-0.5 -mt-px" aria-hidden />
                {insight.severity}
              </span>
              <span className="text-[10px] text-slate-400 uppercase tracking-wider">{insight.type.replace('_', ' ')}</span>
            </div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mt-1">{insight.title}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{insight.description}</p>
          </div>
        </div>
        {insight.totalSpendCents > 0 && (
          <div className="shrink-0 text-right">
            <p className="text-xs text-slate-400">Impact</p>
            <p className="text-sm font-bold text-slate-700 dark:text-slate-200 tabular-nums">
              {fmtEur(insight.totalSpendCents)}
            </p>
          </div>
        )}
      </div>

      {/* Items table */}
      <div className="mt-3 overflow-x-auto">
        {insight.type === 'NEGATIVE_KW' && (
          <NegKwTable items={insight.items as NegKwItem[]} />
        )}
        {insight.type === 'HIGH_ACOS' && (
          <CampTable items={insight.items as CampItem[]} showAcos />
        )}
        {insight.type === 'LOW_ACOS' && (
          <CampTable items={insight.items as CampItem[]} showAcos={false} />
        )}
        {insight.type === 'STALE_CAMPAIGN' && (
          <StaleTable items={insight.items as StaleItem[]} />
        )}
        {insight.count > 5 && (
          <p className="text-xs text-slate-400 mt-1.5">
            + {insight.count - 5} more
          </p>
        )}
      </div>

      {/* Action link */}
      <div className="mt-3">
        <a
          href={actionHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
        >
          View in {insight.type === 'NEGATIVE_KW' ? 'Search Terms' : 'Campaigns'} →
        </a>
      </div>
    </div>
  )
}

// ── Window + params pickers ───────────────────────────────────────────────────

function WindowPicker({ current, acosTarget, lowAcosTarget }: {
  current: number; acosTarget: number; lowAcosTarget: number
}) {
  const options = [7, 14, 30]
  return (
    <div className="flex items-center gap-1">
      {options.map((d) => (
        <a
          key={d}
          href={`?windowDays=${d}&acosTarget=${acosTarget}&lowAcosTarget=${lowAcosTarget}`}
          className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
            current === d
              ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 border-slate-800 dark:border-slate-200'
              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700'
          }`}
        >
          {d}d
        </a>
      ))}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

interface PageProps {
  searchParams: Promise<{
    windowDays?: string
    acosTarget?: string
    lowAcosTarget?: string
    minSpendEur?: string
    marketplace?: string
  }>
}

export default async function InsightsPage({ searchParams }: PageProps) {
  const params = await searchParams
  const windowDays    = Number(params.windowDays    ?? 14)
  const acosTarget    = Number(params.acosTarget    ?? 35)
  const lowAcosTarget = Number(params.lowAcosTarget ?? 8)
  const minSpendEur   = Number(params.minSpendEur   ?? 1)

  const backend = getBackendUrl()
  const qs = new URLSearchParams({
    windowDays:    String(windowDays),
    acosTarget:    String(acosTarget),
    lowAcosTarget: String(lowAcosTarget),
    minSpendEur:   String(minSpendEur),
    ...(params.marketplace ? { marketplace: params.marketplace } : {}),
  })

  const data = await fetchJson<InsightsResponse>(
    `${backend}/api/advertising/insights?${qs.toString()}`,
    { windowDays, generatedAt: new Date().toISOString(), params: { minSpendEur, acosTarget, lowAcosTarget }, count: 0, insights: [] },
  )

  const criticalCount = data.insights.filter((i) => i.severity === 'critical').length
  const warningCount  = data.insights.filter((i) => i.severity === 'warning').length

  return (
    <div className="px-4 py-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-amber-500" aria-hidden />
            Advertising Insights
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Rule-based recommendations from live data — last {data.windowDays} days.
            Generated {new Date(data.generatedAt).toLocaleTimeString('en-GB')}.
          </p>
        </div>
        <WindowPicker current={windowDays} acosTarget={acosTarget} lowAcosTarget={lowAcosTarget} />
      </div>

      <AdvertisingNav />

      {/* Summary bar */}
      {data.count > 0 && (
        <div className="flex items-center gap-3 mb-4 py-2.5 px-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-sm">
          {criticalCount > 0 && (
            <span className="flex items-center gap-1 text-red-600 dark:text-red-400 font-medium">
              <AlertCircle className="h-4 w-4" />
              {criticalCount} critical
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
              <AlertTriangle className="h-4 w-4" />
              {warningCount} warning
            </span>
          )}
          <span className="text-slate-500 ml-auto text-xs">
            ACOS target: {acosTarget}% · min spend: €{minSpendEur} · window: {windowDays}d
          </span>
        </div>
      )}

      {/* Insight cards */}
      {data.count === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-400 mb-3" />
          <p className="text-slate-600 dark:text-slate-300 font-medium">No insights right now</p>
          <p className="text-sm text-slate-400 mt-1">
            {data.insights.length === 0
              ? 'No ad performance data in this window yet — run a report cycle first.'
              : 'All campaigns look healthy within the configured thresholds.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.insights.map((insight, i) => (
            <InsightCard key={i} insight={insight} />
          ))}
        </div>
      )}

      {/* Config note */}
      <div className="mt-6 text-xs text-slate-400 space-y-0.5">
        <p>Thresholds: ACOS &gt; {acosTarget}% = HIGH · ACOS &lt; {lowAcosTarget}% with ≥ €5 spend = LOW · min spend filter: €{minSpendEur}</p>
        <p>
          Override via URL: <span className="font-mono">?acosTarget=40&lowAcosTarget=10&windowDays=7</span>
        </p>
      </div>
    </div>
  )
}
