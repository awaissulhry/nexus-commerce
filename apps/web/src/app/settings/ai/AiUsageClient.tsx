'use client'

/**
 * H.7 — AI usage dashboard client.
 *
 * Two top-level rollup cards (7-day + 30-day): byProvider + byFeature
 * + totals. Below them a live-tail of recent calls so the user can
 * see attribution as it happens.
 *
 * Polls /api/ai/usage/* every 30s. ETag-cached on the server (30s
 * Cache-Control + provider/usage tables don't change second-to-second)
 * so the polling cost is sub-cent per user-day.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Sparkles,
  Activity,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  ShieldAlert,
  Wallet,
  TrendingUp,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface Provider {
  name: string
  configured: boolean
  defaultModel: string
}

interface RollupRow {
  name: string
  calls: number
  inputTokens: number
  outputTokens: number
  costUSD: number
}

interface UsageSummary {
  range: { days: number; since: string }
  byProvider: RollupRow[]
  byFeature: RollupRow[]
  totals: {
    calls: number
    inputTokens: number
    outputTokens: number
    costUSD: number
  }
}

// AI-1.7 — budget posture from /api/ai/usage/budget-posture. Shape
// matches the route response 1:1 so the client renders without
// shoehorning data into a UI-shaped projection.
interface BudgetPosture {
  killSwitch: boolean
  limits: {
    perCallUSD: number
    perWizardUSD: number
    perDayUSD: number
    perMonthUSD: number
  }
  current: {
    perDay: number
    perDayCalls: number
    perMonth: number
    perMonthCalls: number
  }
  hitWarn: 'per_day' | 'per_month' | null
  asOf: string
}

// AI-1.8 — per-wizard ROI rollup from /api/ai/usage/top-wizards.
interface TopWizardRow {
  wizardId: string | null
  productId: string | null
  productSku: string | null
  productName: string | null
  channels: number
  status: string
  currentStep: number | null
  createdAt: string | null
  updatedAt: string | null
  completedAt: string | null
  aiCalls: number
  inputTokens: number
  outputTokens: number
  aiCostUSD: number
  minutesSaved: number
  timeSavedUSD: number
  roi: number | null
}

interface TopWizards {
  range: { days: number; since: string }
  rates: { hourlyUSD: number; minutesPerChannel: number }
  rows: TopWizardRow[]
  totals: {
    aiCostUSD: number
    minutesSaved: number
    timeSavedUSD: number
  }
}

interface RecentCall {
  id: string
  provider: string
  model: string
  feature: string | null
  entityType: string | null
  entityId: string | null
  inputTokens: number
  outputTokens: number
  costUSD: number
  latencyMs: number | null
  ok: boolean
  errorMessage: string | null
  createdAt: string
}

const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Google Gemini',
  anthropic: 'Anthropic Claude',
}

const fmtUSD = (n: number) =>
  n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`

const fmtTokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : String(n)

const fmtRelative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export default function AiUsageClient({
  providers,
  killSwitch: initialKillSwitch,
  summary7: initialSummary7,
  summary30: initialSummary30,
  recent: initialRecent,
  posture: initialPosture,
  topWizards: initialTopWizards,
}: {
  providers: Provider[]
  killSwitch: boolean
  summary7: UsageSummary | null
  summary30: UsageSummary | null
  recent: RecentCall[]
  posture: BudgetPosture | null
  topWizards: TopWizards | null
}) {
  const [killSwitch, setKillSwitch] = useState(initialKillSwitch)
  const [summary7, setSummary7] = useState(initialSummary7)
  const [summary30, setSummary30] = useState(initialSummary30)
  const [recent, setRecent] = useState(initialRecent)
  const [posture, setPosture] = useState(initialPosture)
  const [topWizards, setTopWizards] = useState(initialTopWizards)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const backend = getBackendUrl()
      const [s7, s30, rec, post, prov, tw] = await Promise.all([
        fetch(`${backend}/api/ai/usage/summary?days=7`, { cache: 'no-store' }),
        fetch(`${backend}/api/ai/usage/summary?days=30`, { cache: 'no-store' }),
        fetch(`${backend}/api/ai/usage/recent?limit=50`, { cache: 'no-store' }),
        fetch(`${backend}/api/ai/usage/budget-posture`, { cache: 'no-store' }),
        fetch(`${backend}/api/ai/providers`, { cache: 'no-store' }),
        fetch(`${backend}/api/ai/usage/top-wizards?days=30&limit=10`, {
          cache: 'no-store',
        }),
      ])
      if (s7.ok) setSummary7(await s7.json())
      if (s30.ok) setSummary30(await s30.json())
      if (rec.ok) setRecent((await rec.json()).rows ?? [])
      if (post.ok) setPosture(await post.json())
      // AI-1.7 — re-pick the kill-switch flag on each poll so an
      // operator who flips NEXUS_AI_KILL_SWITCH on (without a
      // redeploy) sees the banner appear within one poll tick.
      if (prov.ok) {
        const j = await prov.json()
        if (typeof j?.killSwitch === 'boolean') setKillSwitch(j.killSwitch)
      }
      if (tw.ok) setTopWizards(await tw.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [])

  // Poll every 30s — server caches the rollups so this is cheap.
  useEffect(() => {
    const id = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            AI providers + spend
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            Per-provider configuration and token + cost telemetry across
            every server-side AI call. Costs are computed at the moment
            each call ran against the provider&apos;s rate card —
            historical rows reflect what was billable then, not today.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh
        </button>
      </header>

      {error && (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800">
          {error}
        </div>
      )}

      {/* AI-1.7 — kill-switch banner. Reflects NEXUS_AI_KILL_SWITCH
          state. Sticky so it stays visible while the operator scrolls
          through the page checking other surfaces. */}
      {killSwitch && (
        <div
          role="alert"
          className="border-2 border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 rounded-md px-4 py-3 flex items-start gap-3"
        >
          <ShieldAlert className="w-5 h-5 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-md font-semibold text-rose-900 dark:text-rose-100">
              AI is disabled — kill switch is on
            </div>
            <div className="text-base text-rose-800 dark:text-rose-200 mt-0.5">
              Every server-side AI call is being refused.{' '}
              <span className="font-mono text-sm">
                NEXUS_AI_KILL_SWITCH
              </span>{' '}
              is set to a truthy value in the runtime environment. Unset it
              (or set to{' '}
              <span className="font-mono text-sm">0</span>) on the API host
              to re-enable. Existing telemetry continues to render.
            </div>
          </div>
        </div>
      )}

      {/* AI-1.7 — budget posture. Always shown so operators don't have
          to dig to find their cost ceilings; surfaces hitWarn as an
          amber tone on whichever horizon is at ≥90%. */}
      {posture && <BudgetPostureCard posture={posture} />}

      {/* AI-1.8 — per-wizard ROI. Operators see "AI cost vs operator
          time saved" per wizard, sorted by AI spend desc. Time saved
          counts only for SUBMITTED / LIVE wizards. */}
      {topWizards && topWizards.rows.length > 0 && (
        <TopWizardsCard topWizards={topWizards} />
      )}

      {/* Providers */}
      <section className="space-y-2">
        <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
          Providers
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {providers.map((p) => (
            <div
              key={p.name}
              className="border border-slate-200 dark:border-slate-700 rounded-md p-3 bg-white dark:bg-slate-900"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-lg font-medium text-slate-900 dark:text-slate-100">
                    {PROVIDER_LABEL[p.name] ?? p.name}
                  </div>
                  <div className="text-sm text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                    {p.defaultModel}
                  </div>
                </div>
                {p.configured ? (
                  <span className="inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded px-1.5 py-0.5">
                    <CheckCircle2 className="w-3 h-3" />
                    Configured
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded px-1.5 py-0.5">
                    Set{' '}
                    <span className="font-mono">
                      {p.name === 'gemini'
                        ? 'GEMINI_API_KEY'
                        : 'ANTHROPIC_API_KEY'}
                    </span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400">
          Default provider: <span className="font-mono">AI_PROVIDER</span> env
          var (currently{' '}
          <span className="font-mono">
            {summary7?.byProvider[0]?.name ?? 'gemini'}
          </span>{' '}
          based on most recent calls). Per-call override via{' '}
          <span className="font-mono">?provider=</span> on AI endpoints.
        </div>
      </section>

      {/* 7-day + 30-day rollups */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RollupCard
          title="Last 7 days"
          summary={summary7}
        />
        <RollupCard
          title="Last 30 days"
          summary={summary30}
        />
      </section>

      {/* Recent calls live tail */}
      <section className="space-y-2">
        <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
          <Activity className="w-3 h-3" />
          Recent calls
        </h2>
        <div className="border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden bg-white dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-24">
                  When
                </th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-28">
                  Provider
                </th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                  Feature
                </th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-40">
                  Model
                </th>
                <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-20">
                  In
                </th>
                <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-20">
                  Out
                </th>
                <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-20">
                  Cost
                </th>
                <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-16">
                  ms
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-8 text-center text-slate-400 dark:text-slate-500 italic"
                  >
                    No AI calls yet. Trigger a bulk fill on /products and
                    refresh.
                  </td>
                </tr>
              )}
              {recent.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-slate-100 dark:border-slate-800 ${
                    r.ok ? '' : 'bg-rose-50/40'
                  }`}
                  title={r.errorMessage ?? undefined}
                >
                  <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400">
                    {fmtRelative(r.createdAt)}
                  </td>
                  <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">
                    {PROVIDER_LABEL[r.provider] ?? r.provider}
                  </td>
                  <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">
                    {r.feature ?? <span className="text-slate-400 dark:text-slate-500">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500 dark:text-slate-400 font-mono truncate">
                    {r.model}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {fmtTokens(r.inputTokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {fmtTokens(r.outputTokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-900 dark:text-slate-100 font-medium">
                    {fmtUSD(r.costUSD)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {r.latencyMs ?? ''}
                    {!r.ok && (
                      <XCircle className="w-3 h-3 text-rose-600 dark:text-rose-400 inline ml-1" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function RollupCard({
  title,
  summary,
}: {
  title: string
  summary: UsageSummary | null
}) {
  if (!summary) {
    return (
      <div className="border border-slate-200 dark:border-slate-700 rounded-md p-3 bg-white dark:bg-slate-900">
        <div className="text-md font-semibold text-slate-700 dark:text-slate-300">{title}</div>
        <div className="text-base text-slate-500 dark:text-slate-400 mt-2 italic">
          No data
        </div>
      </div>
    )
  }
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900">
      <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
        <div className="text-md font-semibold text-slate-700 dark:text-slate-300">{title}</div>
        <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
          {fmtUSD(summary.totals.costUSD)}
        </div>
      </div>
      <div className="px-3 py-2 grid grid-cols-3 gap-2 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
        <div>
          <div className="text-slate-400 dark:text-slate-500 uppercase tracking-wider text-xs">
            Calls
          </div>
          <div className="text-lg font-medium text-slate-900 dark:text-slate-100 tabular-nums">
            {summary.totals.calls.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-slate-400 dark:text-slate-500 uppercase tracking-wider text-xs">
            Input
          </div>
          <div className="text-lg font-medium text-slate-900 dark:text-slate-100 tabular-nums">
            {fmtTokens(summary.totals.inputTokens)}
          </div>
        </div>
        <div>
          <div className="text-slate-400 dark:text-slate-500 uppercase tracking-wider text-xs">
            Output
          </div>
          <div className="text-lg font-medium text-slate-900 dark:text-slate-100 tabular-nums">
            {fmtTokens(summary.totals.outputTokens)}
          </div>
        </div>
      </div>

      {summary.byProvider.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800">
          <div className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
            By provider
          </div>
          <div className="space-y-1">
            {summary.byProvider.map((p) => (
              <div key={p.name} className="flex items-center justify-between text-base">
                <span className="text-slate-700 dark:text-slate-300">
                  {PROVIDER_LABEL[p.name] ?? p.name}
                </span>
                <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                  {p.calls} call{p.calls === 1 ? '' : 's'} ·{' '}
                  <span className="text-slate-900 dark:text-slate-100 font-medium">
                    {fmtUSD(p.costUSD)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {summary.byFeature.length > 0 && (
        <div className="px-3 py-2">
          <div className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
            By feature
          </div>
          <div className="space-y-1">
            {summary.byFeature.map((f) => (
              <div key={f.name} className="flex items-center justify-between text-base">
                <span className="text-slate-700 dark:text-slate-300 truncate">{f.name}</span>
                <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                  {f.calls} call{f.calls === 1 ? '' : 's'} ·{' '}
                  <span className="text-slate-900 dark:text-slate-100 font-medium">
                    {fmtUSD(f.costUSD)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// AI-1.7 — budget posture surface. Two horizons (per-day rolling 24h
// + per-month rolling 30d) with progress bars. Tone tracks the same
// thresholds AiBudgetService uses: emerald < 90%, amber 90-100%,
// rose > 100% (post-refuse). Limit value of 0 → "disabled" pill so
// the operator can tell at a glance which horizons are active.
function BudgetPostureCard({ posture }: { posture: BudgetPosture }) {
  const limits = posture.limits
  return (
    <section className="space-y-2">
      <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
        <Wallet className="w-3 h-3" />
        Budget posture
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <BudgetHorizonCard
          label="Today (rolling 24h)"
          spent={posture.current.perDay}
          limit={limits.perDayUSD}
          calls={posture.current.perDayCalls}
          envName="NEXUS_AI_PER_DAY_USD_MAX"
          warned={posture.hitWarn === 'per_day'}
        />
        <BudgetHorizonCard
          label="This month (rolling 30d)"
          spent={posture.current.perMonth}
          limit={limits.perMonthUSD}
          calls={posture.current.perMonthCalls}
          envName="NEXUS_AI_PER_MONTH_USD_MAX"
          warned={posture.hitWarn === 'per_month'}
        />
      </div>
      <div className="text-sm text-slate-500 dark:text-slate-400 px-1">
        Per-call cap{' '}
        {limits.perCallUSD > 0 ? (
          <span className="font-mono text-slate-700 dark:text-slate-300">
            {fmtUSD(limits.perCallUSD)}
          </span>
        ) : (
          <span className="italic">disabled</span>
        )}{' '}
        ·{' '}
        Per-wizard cap{' '}
        {limits.perWizardUSD > 0 ? (
          <span className="font-mono text-slate-700 dark:text-slate-300">
            {fmtUSD(limits.perWizardUSD)}
          </span>
        ) : (
          <span className="italic">disabled</span>
        )}
        . Override via{' '}
        <span className="font-mono">NEXUS_AI_PER_CALL_USD_MAX</span> /{' '}
        <span className="font-mono">NEXUS_AI_PER_WIZARD_USD_MAX</span>;
        set to 0 to disable.
      </div>
    </section>
  )
}

function BudgetHorizonCard({
  label,
  spent,
  limit,
  calls,
  envName,
  warned,
}: {
  label: string
  spent: number
  limit: number
  calls: number
  envName: string
  warned: boolean
}) {
  const disabled = limit <= 0
  const pct = disabled ? 0 : Math.min(100, (spent / limit) * 100)
  const over = !disabled && spent > limit
  const tone = disabled
    ? {
        border: 'border-slate-200 dark:border-slate-700',
        bg: 'bg-white dark:bg-slate-900',
        bar: 'bg-slate-300 dark:bg-slate-700',
        text: 'text-slate-500 dark:text-slate-400',
      }
    : over
      ? {
          border: 'border-rose-300 dark:border-rose-800',
          bg: 'bg-rose-50/50 dark:bg-rose-950/30',
          bar: 'bg-rose-500',
          text: 'text-rose-700 dark:text-rose-300',
        }
      : warned
        ? {
            border: 'border-amber-300 dark:border-amber-800',
            bg: 'bg-amber-50/50 dark:bg-amber-950/30',
            bar: 'bg-amber-500',
            text: 'text-amber-700 dark:text-amber-300',
          }
        : {
            border: 'border-slate-200 dark:border-slate-700',
            bg: 'bg-white dark:bg-slate-900',
            bar: 'bg-emerald-500',
            text: 'text-slate-500 dark:text-slate-400',
          }
  return (
    <div
      className={cn('border rounded-md p-3', tone.border, tone.bg)}
      title={`${envName}=${disabled ? '0 (disabled)' : fmtUSD(limit)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-md font-medium text-slate-700 dark:text-slate-300">
            {label}
          </div>
          <div className={cn('text-sm tabular-nums mt-0.5', tone.text)}>
            {calls.toLocaleString()} call{calls === 1 ? '' : 's'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {fmtUSD(spent)}
          </div>
          {!disabled && (
            <div className="text-sm text-slate-500 dark:text-slate-400 tabular-nums mt-0.5">
              of {fmtUSD(limit)}
            </div>
          )}
          {disabled && (
            <div className="text-sm text-slate-400 dark:text-slate-500 italic mt-0.5">
              cap disabled
            </div>
          )}
        </div>
      </div>
      {!disabled && (
        <div className="mt-2 h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
          <div
            className={cn('h-full transition-all', tone.bar)}
            style={{ width: `${pct.toFixed(1)}%` }}
          />
        </div>
      )}
      {warned && !over && (
        <div className="mt-2 text-sm text-amber-700 dark:text-amber-300">
          ≥90% of cap — calls still allowed but the next big burst
          will refuse.
        </div>
      )}
      {over && (
        <div className="mt-2 text-sm text-rose-700 dark:text-rose-300">
          Over cap — every new AI call is refused with HTTP 402 until
          the window rolls over.
        </div>
      )}
    </div>
  )
}

// AI-1.8 — per-wizard ROI surface. Sortable would be nice but the
// backend already returns rows cost-desc, which is the "where's my
// money going?" sort 99% of operators want. Status pill + ROI ratio
// + deep-link to the wizard for the few wizards burning the most AI.
function TopWizardsCard({ topWizards }: { topWizards: TopWizards }) {
  const { rows, totals, rates, range } = topWizards
  const overallRoi =
    totals.aiCostUSD > 0 ? totals.timeSavedUSD / totals.aiCostUSD : null
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
          <TrendingUp className="w-3 h-3" />
          Top wizards by AI cost · last {range.days}d
        </h2>
        <div className="text-sm text-slate-500 dark:text-slate-400 tabular-nums">
          {fmtUSD(totals.aiCostUSD)} spent · {fmtUSD(totals.timeSavedUSD)}{' '}
          time saved
          {overallRoi != null && (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300 tabular-nums">
              {overallRoi >= 100
                ? `${overallRoi.toFixed(0)}×`
                : `${overallRoi.toFixed(1)}×`}{' '}
              ROI
            </span>
          )}
        </div>
      </div>
      <div className="border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden bg-white dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                Product
              </th>
              <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-24">
                Status
              </th>
              <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-16">
                Channels
              </th>
              <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-16">
                Calls
              </th>
              <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-20">
                AI cost
              </th>
              <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-20">
                Time saved
              </th>
              <th className="px-3 py-2 text-right font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider w-16">
                ROI
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <TopWizardRowView key={r.wizardId ?? Math.random()} row={r} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-sm text-slate-500 dark:text-slate-400 px-1">
        Time saved assumes{' '}
        <span className="font-mono">
          {rates.minutesPerChannel} min/channel
        </span>{' '}
        of manual publishing avoided · operator hourly{' '}
        <span className="font-mono">{fmtUSD(rates.hourlyUSD)}/hr</span>.
        Counts only SUBMITTED / LIVE wizards. Override via{' '}
        <span className="font-mono">NEXUS_OPERATOR_HOURLY_USD</span> +{' '}
        <span className="font-mono">NEXUS_PUBLISH_MINUTES_PER_CHANNEL</span>.
      </div>
    </section>
  )
}

function TopWizardRowView({ row }: { row: TopWizardRow }) {
  const statusTone =
    row.status === 'LIVE'
      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300'
      : row.status === 'SUBMITTED'
        ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900 text-blue-800 dark:text-blue-300'
        : row.status === 'FAILED'
          ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300'
          : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
  const isPublished = row.status === 'LIVE' || row.status === 'SUBMITTED'
  const productHref = row.productId
    ? `/products/${row.productId}/list-wizard`
    : null
  return (
    <tr
      className="border-b border-slate-100 dark:border-slate-800 last:border-b-0"
    >
      <td className="px-3 py-1.5">
        {productHref ? (
          <Link
            href={productHref}
            className="text-blue-700 dark:text-blue-300 hover:underline"
          >
            <span className="font-mono text-slate-900 dark:text-slate-100">
              {row.productSku ?? 'unknown'}
            </span>
            {row.productName && (
              <span className="ml-2 text-slate-600 dark:text-slate-400 truncate">
                {row.productName}
              </span>
            )}
          </Link>
        ) : (
          <span className="text-slate-500 dark:text-slate-400 italic">
            wizard {row.wizardId?.slice(0, 8) ?? 'unknown'}…
          </span>
        )}
      </td>
      <td className="px-3 py-1.5">
        <span
          className={cn(
            'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border',
            statusTone,
          )}
        >
          {row.status}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
        {row.channels}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
        {row.aiCalls}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-slate-900 dark:text-slate-100 font-medium">
        {fmtUSD(row.aiCostUSD)}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        {isPublished && row.minutesSaved > 0 ? (
          <span className="text-slate-700 dark:text-slate-300">
            {fmtUSD(row.timeSavedUSD)}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500 italic">
            —
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        {row.roi != null ? (
          <span
            className={cn(
              'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium tabular-nums',
              row.roi >= 1
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300',
            )}
            title={`AI cost ${fmtUSD(row.aiCostUSD)} vs time saved ${fmtUSD(row.timeSavedUSD)}`}
          >
            {row.roi >= 100 ? `${row.roi.toFixed(0)}×` : `${row.roi.toFixed(1)}×`}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500 italic">
            —
          </span>
        )}
      </td>
    </tr>
  )
}
