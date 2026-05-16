/**
 * Trading Desk landing.
 *
 * Five-card executive overview: one card per sub-workspace
 * (Campagne / Stock invecchiato / Margine reale / Automazione /
 * Budget pool). Each card is a deep-link to the relevant tab with a
 * single headline number + tone.
 *
 * Aged-stock critical banner promotes the highest-priority signal
 * (SKUs ≤14d from LTS fees) above the cards so it's not lost.
 *
 * Sandbox/Live chip in the header surfaces NEXUS_AMAZON_ADS_MODE.
 */

import Link from 'next/link'
import {
  Target,
  Warehouse,
  TrendingUp,
  Activity,
  AlertTriangle,
  Bot,
  Wallet,
  ChevronRight,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AdvertisingNav } from './_shared/AdvertisingNav'

export const dynamic = 'force-dynamic'

interface SummaryPayload {
  campaignCount: number
  adSpend30dCents: number
  grossRevenue30dCents: number
  trueProfit30dCents: number
  trueProfitMargin30dPct: number | null
  agedSkusFlagged: number
  mode: 'sandbox' | 'live'
}

interface AgedRow {
  sku: string
  marketplace: string
  daysToLtsThreshold: number | null
}

interface AutomationRule {
  id: string
  enabled: boolean
  dryRun: boolean
}

interface BudgetPool {
  id: string
  enabled: boolean
  totalDailyBudgetCents: number
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

function formatEur(cents: number): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

function formatPct(value: number | null): string {
  if (value == null) return '—'
  return `${value.toFixed(1)}%`
}

export default async function AdvertisingLandingPage() {
  const backend = getBackendUrl()
  const [summary, criticalAged, automationRules, budgetPools] = await Promise.all([
    fetchJson<SummaryPayload>(`${backend}/api/advertising/summary`, {
      campaignCount: 0,
      adSpend30dCents: 0,
      grossRevenue30dCents: 0,
      trueProfit30dCents: 0,
      trueProfitMargin30dPct: null,
      agedSkusFlagged: 0,
      mode: 'sandbox',
    }),
    fetchJson<{ items: AgedRow[]; count: number }>(
      `${backend}/api/advertising/fba-storage-age?bucket=critical&limit=10`,
      { items: [], count: 0 },
    ),
    fetchJson<{ items: AutomationRule[] }>(
      `${backend}/api/advertising/automation-rules`,
      { items: [] },
    ),
    fetchJson<{ items: BudgetPool[] }>(`${backend}/api/advertising/budget-pools`, {
      items: [],
    }),
  ])

  const liveRules = automationRules.items.filter((r) => r.enabled && !r.dryRun).length
  const dryRunRules = automationRules.items.filter((r) => r.enabled && r.dryRun).length
  const activePools = budgetPools.items.filter((p) => p.enabled).length
  const totalPoolBudgetCents = budgetPools.items.reduce(
    (a, p) => (p.enabled ? a + p.totalDailyBudgetCents : a),
    0,
  )

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Target className="h-6 w-6 text-blue-600 dark:text-blue-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Trading Desk
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Pubblicità Amazon basata sul vero profitto (Ricavi − COGS − Commissioni −
            Spesa pubblicitaria). Trigger automatici su stock invecchiato FBA, pool budget
            cross-marketplace, audit completo + rollback 24h.
          </p>
        </div>
        <span
          className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded ring-1 ring-inset ${
            summary.mode === 'live'
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
              : 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
          }`}
        >
          {summary.mode === 'live' ? 'Live' : 'Sandbox'}
        </span>
      </div>

      <AdvertisingNav />

      {/* Critical aged-stock banner */}
      {summary.agedSkusFlagged > 0 && (
        <Link
          href="/marketing/advertising/storage-age"
          className="block bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-md px-3 py-2 hover:bg-rose-100 dark:hover:bg-rose-950/60"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle
              className="h-4 w-4 text-rose-600 dark:text-rose-400"
              aria-hidden="true"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-rose-900 dark:text-rose-100">
                {summary.agedSkusFlagged} SKU verso commissioni LTS entro 30 giorni
              </div>
              {criticalAged.count > 0 && (
                <div className="text-xs text-rose-700 dark:text-rose-300 mt-0.5">
                  {criticalAged.count} critici (≤14 giorni):{' '}
                  {criticalAged.items
                    .slice(0, 3)
                    .map((r) => `${r.sku} (${r.marketplace})`)
                    .join(', ')}
                  {criticalAged.count > 3 && ` + ${criticalAged.count - 3} altri`}
                </div>
              )}
            </div>
            <span className="text-xs text-rose-600 dark:text-rose-400">Vedi →</span>
          </div>
        </Link>
      )}

      {/* Five-card overview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <Card
          href="/marketing/advertising/campaigns"
          icon={Activity}
          label="Campagne"
          value={summary.campaignCount}
          sublabel={
            summary.campaignCount === 0
              ? 'Esegui ads-sync per importare'
              : `${formatEur(summary.adSpend30dCents)} spesa 30g`
          }
        />
        <Card
          href="/marketing/advertising/storage-age"
          icon={Warehouse}
          label="Stock invecchiato"
          value={summary.agedSkusFlagged}
          sublabel="SKU sotto soglia LTS 30g"
          tone={summary.agedSkusFlagged > 0 ? 'rose' : null}
        />
        <Card
          href="/marketing/advertising/profit"
          icon={TrendingUp}
          label="Margine reale 30g"
          value={formatPct(summary.trueProfitMargin30dPct)}
          sublabel={
            summary.grossRevenue30dCents > 0
              ? `${formatEur(summary.trueProfit30dCents)} su ${formatEur(summary.grossRevenue30dCents)}`
              : 'Nessun dato P&L'
          }
          tone={
            summary.trueProfitMargin30dPct == null
              ? null
              : summary.trueProfitMargin30dPct >= 15
                ? 'emerald'
                : summary.trueProfitMargin30dPct >= 5
                  ? 'amber'
                  : 'rose'
          }
        />
        <Card
          href="/marketing/advertising/automation"
          icon={Bot}
          label="Automazione"
          value={automationRules.items.length}
          sublabel={
            automationRules.items.length === 0
              ? 'Carica i template per iniziare'
              : `${liveRules} live · ${dryRunRules} dry-run`
          }
          tone={liveRules > 0 ? 'emerald' : dryRunRules > 0 ? 'amber' : null}
        />
        <Card
          href="/marketing/advertising/budget-pools"
          icon={Wallet}
          label="Budget pool"
          value={budgetPools.items.length}
          sublabel={
            budgetPools.items.length === 0
              ? 'Nessun pool configurato'
              : `${activePools} attivi · ${formatEur(totalPoolBudgetCents)}/g totali`
          }
        />
      </div>

      {/* Status footer */}
      <div className="bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-3">
        <div className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
          Pillar 2 · Inventory-Aware Advertising · 5 wave shipped
        </div>
        <ul className="text-xs text-slate-500 dark:text-slate-400 space-y-1 list-disc pl-4">
          <li>
            <strong>AD.1</strong> substrate: Campaign + AdGroup + AdTarget + FbaStorageAge +
            ProductProfitDaily + Amazon Ads API sandbox client
          </li>
          <li>
            <strong>AD.2</strong> workspace: campaigns / storage-age / profit con bid history
            via OutboundSyncQueue
          </li>
          <li>
            <strong>AD.3</strong> automation: 4 trigger context builders + 8 action handler +
            5 template Italian
          </li>
          <li>
            <strong>AD.4</strong> live mode: two-key write gate + AdvertisingActionLog +
            liquidate_aged_stock composite + rollback 24h
          </li>
          <li>
            <strong>AD.5</strong> budget pool: 3 strategie (STATIC / PROFIT_WEIGHTED /
            URGENCY_WEIGHTED) + cross-marketplace rebalancer
          </li>
        </ul>
        <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-2">
          {summary.mode === 'sandbox'
            ? 'Modalità sandbox · imposta NEXUS_AMAZON_ADS_MODE=live + AmazonAdsConnection.writesEnabledAt per produzione.'
            : 'Modalità live · le scritture passano per ads-write-gate e finestra di annullamento di 5 min.'}
        </div>
      </div>
    </div>
  )
}

function Card({
  href,
  icon: Icon,
  label,
  value,
  sublabel,
  tone,
}: {
  href: string
  icon: typeof Activity
  label: string
  value: number | string
  sublabel: string
  tone?: 'emerald' | 'amber' | 'rose' | null
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'rose'
          ? 'text-rose-700 dark:text-rose-300'
          : 'text-slate-900 dark:text-slate-100'
  return (
    <Link
      href={href}
      className="group block bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md p-4 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-slate-500 dark:text-slate-400" />
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600 ml-auto group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors" />
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate" title={sublabel}>
        {sublabel}
      </div>
    </Link>
  )
}
