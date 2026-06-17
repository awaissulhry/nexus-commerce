'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useInsightsLiveRefresh } from '../../_components/useInsightsLiveRefresh'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Plus, Save, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  InsightsHeader,
  KPICard,
  formatCurrency,
  formatNum,
  formatPct,
  readFilterState,
  type InsightsFilterState,
} from '@/components/insights'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface SalesAnchor {
  revenue: number
  orders: number
  units: number
  aov: number
  refundsValue: number
}

interface AdAnchor {
  spend: number
  sales: number
  acos: number | null
  roas: number | null
  orders: number
}

interface ProfitAnchor {
  revenue: number
  cogs: number
  fees: number
  adSpend: number
  refunds: number
  netProfit: number
  marginPct: number | null
}

interface SavedScenario {
  id: string
  name: string
  createdAt: string
  pricingDeltaPct: number
  demandElasticity: number
  adSpendDeltaPct: number
  adRoasAssumption: number
  cogsDeltaPct: number
  notes: string
}

const STORAGE_KEY = 'insights.scenarios.v1'

function buildQuery(state: InsightsFilterState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.window) p.set('window', state.window)
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  if (state.compare) p.set('compare', state.compare)
  if (state.channels.length) p.set('channels', state.channels.join(','))
  if (state.markets.length) p.set('markets', state.markets.join(','))
  if (state.brands.length) p.set('brands', state.brands.join(','))
  return p
}

function loadSaved(): SavedScenario[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as SavedScenario[]
    return []
  } catch {
    return []
  }
}

function persistSaved(list: SavedScenario[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

export default function ScenariosClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [salesAnchor, setSalesAnchor] = useState<SalesAnchor | null>(null)
  const [adAnchor, setAdAnchor] = useState<AdAnchor | null>(null)
  const [profitAnchor, setProfitAnchor] = useState<ProfitAnchor | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // AL.1 — live refresh on order events (debounced 2s)
  const bumpNonce = useCallback(() => setNonce((n) => n + 1), [])
  useInsightsLiveRefresh(bumpNonce)

  const [pricingDeltaPct, setPricingDeltaPct] = useState(0)
  const [demandElasticity, setDemandElasticity] = useState(-1.2)
  const [adSpendDeltaPct, setAdSpendDeltaPct] = useState(0)
  const [adRoasAssumption, setAdRoasAssumption] = useState(3)
  const [cogsDeltaPct, setCogsDeltaPct] = useState(0)
  const [scenarioName, setScenarioName] = useState('')
  const [notes, setNotes] = useState('')
  const [saved, setSaved] = useState<SavedScenario[]>([])

  useEffect(() => {
    setSaved(loadSaved())
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (salesAnchor) setRefreshing(true)
      try {
        const qs = buildQuery(filterState).toString()
        const base = getBackendUrl()
        const [salesRes, adRes, profitRes] = await Promise.all([
          fetch(`${base}/api/insights/sales?${qs}`, { credentials: 'include' }),
          fetch(`${base}/api/insights/advertising?${qs}`, { credentials: 'include' }),
          fetch(`${base}/api/insights/profit?${qs}`, { credentials: 'include' }),
        ])
        if (!salesRes.ok || !adRes.ok || !profitRes.ok) {
          throw new Error('Failed to load anchor data')
        }
        const sales = await salesRes.json()
        const ad = await adRes.json()
        const profit = await profitRes.json()
        if (!cancelled) {
          setSalesAnchor({
            revenue: sales.totals.revenue ?? 0,
            orders: sales.totals.orders ?? 0,
            units: sales.totals.units ?? 0,
            aov: sales.totals.aov ?? 0,
            refundsValue: sales.totals.refundsValue ?? 0,
          })
          setAdAnchor({
            spend: ad.totals.spend ?? 0,
            sales: ad.totals.sales ?? 0,
            acos: ad.totals.acos ?? null,
            roas: ad.totals.roas ?? null,
            orders: ad.totals.orders ?? 0,
          })
          setProfitAnchor({
            revenue: profit.totals.revenue ?? 0,
            cogs: profit.totals.cogs ?? 0,
            fees: profit.totals.fees ?? 0,
            adSpend: profit.totals.adSpend ?? 0,
            refunds: profit.totals.refunds ?? 0,
            netProfit: profit.totals.netProfit ?? 0,
            marginPct: profit.totals.marginPct ?? null,
          })
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed')
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterState.window,
    filterState.from,
    filterState.to,
    filterState.compare,
    filterState.channels.join(','),
    filterState.markets.join(','),
    filterState.brands.join(','),
    nonce,
  ])

  const projection = useMemo(() => {
    if (!salesAnchor || !adAnchor || !profitAnchor) return null
    const priceMultiplier = 1 + pricingDeltaPct / 100
    const unitMultiplier = 1 + (demandElasticity * pricingDeltaPct) / 100
    const projectedUnits = salesAnchor.units * unitMultiplier
    const projectedRevenue = salesAnchor.revenue * priceMultiplier * unitMultiplier
    const projectedCogs = profitAnchor.cogs * unitMultiplier * (1 + cogsDeltaPct / 100)
    const projectedFees = profitAnchor.fees * priceMultiplier * unitMultiplier
    const projectedAdSpend = adAnchor.spend * (1 + adSpendDeltaPct / 100)
    const projectedAdSales = projectedAdSpend * adRoasAssumption
    const projectedNet =
      projectedRevenue - projectedCogs - projectedFees - projectedAdSpend - profitAnchor.refunds
    const projectedMargin =
      projectedRevenue > 0 ? (projectedNet / projectedRevenue) * 100 : null
    return {
      projectedUnits,
      projectedRevenue,
      projectedCogs,
      projectedFees,
      projectedAdSpend,
      projectedAdSales,
      projectedNet,
      projectedMargin,
      revenueDelta: projectedRevenue - salesAnchor.revenue,
      unitsDelta: projectedUnits - salesAnchor.units,
      netDelta: projectedNet - profitAnchor.netProfit,
      marginDelta:
        projectedMargin != null && profitAnchor.marginPct != null
          ? projectedMargin - profitAnchor.marginPct
          : null,
    }
  }, [
    salesAnchor,
    adAnchor,
    profitAnchor,
    pricingDeltaPct,
    demandElasticity,
    adSpendDeltaPct,
    adRoasAssumption,
    cogsDeltaPct,
  ])

  function saveScenario() {
    if (!scenarioName.trim()) return
    const scenario: SavedScenario = {
      id: crypto.randomUUID(),
      name: scenarioName.trim(),
      createdAt: new Date().toISOString(),
      pricingDeltaPct,
      demandElasticity,
      adSpendDeltaPct,
      adRoasAssumption,
      cogsDeltaPct,
      notes: notes.trim(),
    }
    const next = [scenario, ...saved].slice(0, 50)
    setSaved(next)
    persistSaved(next)
    setScenarioName('')
    setNotes('')
  }

  function loadScenario(s: SavedScenario) {
    setPricingDeltaPct(s.pricingDeltaPct)
    setDemandElasticity(s.demandElasticity)
    setAdSpendDeltaPct(s.adSpendDeltaPct)
    setAdRoasAssumption(s.adRoasAssumption)
    setCogsDeltaPct(s.cogsDeltaPct)
    setNotes(s.notes)
    setScenarioName(s.name)
  }

  function deleteScenario(id: string) {
    const next = saved.filter((s) => s.id !== id)
    setSaved(next)
    persistSaved(next)
  }

  function resetSliders() {
    setPricingDeltaPct(0)
    setDemandElasticity(-1.2)
    setAdSpendDeltaPct(0)
    setAdRoasAssumption(3)
    setCogsDeltaPct(0)
  }

  const currency = 'EUR'

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-2">
        <Link
          href="/insights"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ChevronLeft className="w-3 h-3" />
          Insights
        </Link>
      </div>
      <InsightsHeader
        title="Scenarios — what-if"
        description="Project revenue, profit and margin under pricing / ad-spend / COGS changes. Anchors are the current window's actuals."
        filterState={filterState}
        refreshing={refreshing}
        onRefresh={() => setNonce((n) => n + 1)}
      />

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <Card title="Anchor — current window" description="Actuals driving the projection">
          {salesAnchor && profitAnchor ? (
            <dl className="space-y-1.5 text-xs">
              <Row label="Revenue" value={formatCurrency(salesAnchor.revenue, currency)} />
              <Row label="Units" value={formatNum(salesAnchor.units)} />
              <Row label="AOV" value={formatCurrency(salesAnchor.aov, currency)} />
              <Row label="COGS" value={formatCurrency(profitAnchor.cogs, currency)} />
              <Row label="Fees" value={formatCurrency(profitAnchor.fees, currency)} />
              <Row label="Ad spend" value={formatCurrency(profitAnchor.adSpend, currency)} />
              <Row label="Refunds" value={formatCurrency(profitAnchor.refunds, currency)} />
              <Row
                label="Net profit"
                value={formatCurrency(profitAnchor.netProfit, currency)}
                bold
              />
              <Row
                label="Margin"
                value={
                  profitAnchor.marginPct != null
                    ? formatPct(profitAnchor.marginPct)
                    : '—'
                }
                bold
              />
            </dl>
          ) : (
            <div className="text-sm text-tertiary py-6 text-center">
              {loading ? 'Loading…' : 'No anchor data'}
            </div>
          )}
        </Card>

        <Card
          title="Levers"
          description="Adjust assumptions; projection updates instantly"
          className="lg:col-span-2"
        >
          <div className="space-y-3">
            <Lever
              label="Price change"
              suffix="%"
              value={pricingDeltaPct}
              min={-50}
              max={50}
              step={1}
              onChange={setPricingDeltaPct}
            />
            <Lever
              label="Demand elasticity"
              tooltip="Unit-volume response to price change. -1.2 means a 10% price cut → 12% volume increase. Negative for typical goods."
              suffix=""
              value={demandElasticity}
              min={-3}
              max={0}
              step={0.1}
              onChange={setDemandElasticity}
            />
            <Lever
              label="Ad spend change"
              suffix="%"
              value={adSpendDeltaPct}
              min={-100}
              max={200}
              step={5}
              onChange={setAdSpendDeltaPct}
            />
            <Lever
              label="Assumed ROAS on incremental spend"
              suffix="x"
              tooltip="How many € of attributed sales per € of new ad spend. Default 3x. Diminishing returns not modelled."
              value={adRoasAssumption}
              min={0.5}
              max={10}
              step={0.5}
              onChange={setAdRoasAssumption}
            />
            <Lever
              label="COGS change"
              suffix="%"
              value={cogsDeltaPct}
              min={-30}
              max={50}
              step={1}
              onChange={setCogsDeltaPct}
            />
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={resetSliders}
                className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
              >
                Reset
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <KPICard
          label="Projected revenue"
          value={
            projection ? formatCurrency(projection.projectedRevenue, currency) : '—'
          }
          deltaPct={
            projection && salesAnchor && salesAnchor.revenue > 0
              ? (projection.revenueDelta / salesAnchor.revenue) * 100
              : null
          }
          accent="emerald"
        />
        <KPICard
          label="Projected units"
          value={projection ? formatNum(Math.round(projection.projectedUnits)) : '—'}
          deltaPct={
            projection && salesAnchor && salesAnchor.units > 0
              ? (projection.unitsDelta / salesAnchor.units) * 100
              : null
          }
          accent="blue"
        />
        <KPICard
          label="Projected net profit"
          value={projection ? formatCurrency(projection.projectedNet, currency) : '—'}
          deltaPct={
            projection && profitAnchor && profitAnchor.netProfit !== 0
              ? (projection.netDelta / Math.abs(profitAnchor.netProfit)) * 100
              : null
          }
          accent="emerald"
        />
        <KPICard
          label="Projected margin"
          value={
            projection?.projectedMargin != null
              ? formatPct(projection.projectedMargin)
              : '—'
          }
          deltaPct={
            projection?.marginDelta != null ? projection.marginDelta : null
          }
          accent="amber"
          secondary={
            projection?.marginDelta != null
              ? `${projection.marginDelta > 0 ? '+' : ''}${projection.marginDelta.toFixed(1)} pp`
              : undefined
          }
        />
      </div>

      <Card title="Save this scenario" className="mb-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            placeholder="Scenario name (e.g. 'Cut Amazon ads 30%, raise jacket 5%')"
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            className="flex-1 h-8 px-2 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          />
          <input
            type="text"
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="flex-1 h-8 px-2 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          />
          <button
            type="button"
            onClick={saveScenario}
            disabled={!scenarioName.trim()}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>
        </div>
      </Card>

      {saved.length > 0 && (
        <Card title="Saved scenarios" description="Stored in browser localStorage">
          <ul className="space-y-2">
            {saved.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-md border border-default dark:border-slate-700 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                    {s.name}
                  </div>
                  <div className="text-[11px] text-slate-500 tabular-nums">
                    price {s.pricingDeltaPct > 0 ? '+' : ''}{s.pricingDeltaPct}% · elasticity {s.demandElasticity} · ads {s.adSpendDeltaPct > 0 ? '+' : ''}{s.adSpendDeltaPct}% @ {s.adRoasAssumption}x · COGS {s.cogsDeltaPct > 0 ? '+' : ''}{s.cogsDeltaPct}%
                  </div>
                  {s.notes && (
                    <div className="text-[11px] text-slate-500 mt-0.5 italic truncate">
                      {s.notes}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => loadScenario(s)}
                  className="inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Plus className="w-3 h-3" />
                  Load
                </button>
                <button
                  type="button"
                  onClick={() => deleteScenario(s.id)}
                  className="inline-flex items-center justify-center w-6 h-6 rounded-md text-tertiary hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                  aria-label="Delete scenario"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  bold,
}: {
  label: string
  value: string
  bold?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd
        className={cn(
          'tabular-nums',
          bold ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-200',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function Lever({
  label,
  suffix,
  value,
  min,
  max,
  step,
  onChange,
  tooltip,
}: {
  label: string
  suffix: string
  value: number
  min: number
  max: number
  step: number
  onChange: (n: number) => void
  tooltip?: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <label
          className="text-xs font-medium text-slate-700 dark:text-slate-200"
          title={tooltip}
        >
          {label}
        </label>
        <span className="text-xs tabular-nums text-slate-900 dark:text-slate-100 font-semibold">
          {value > 0 ? '+' : ''}{value}{suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-600"
      />
    </div>
  )
}
