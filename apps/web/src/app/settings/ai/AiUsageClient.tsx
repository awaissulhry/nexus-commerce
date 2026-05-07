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
} from 'lucide-react'
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
  summary7: initialSummary7,
  summary30: initialSummary30,
  recent: initialRecent,
}: {
  providers: Provider[]
  summary7: UsageSummary | null
  summary30: UsageSummary | null
  recent: RecentCall[]
}) {
  const [summary7, setSummary7] = useState(initialSummary7)
  const [summary30, setSummary30] = useState(initialSummary30)
  const [recent, setRecent] = useState(initialRecent)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const backend = getBackendUrl()
      const [s7, s30, rec] = await Promise.all([
        fetch(`${backend}/api/ai/usage/summary?days=7`, { cache: 'no-store' }),
        fetch(`${backend}/api/ai/usage/summary?days=30`, { cache: 'no-store' }),
        fetch(`${backend}/api/ai/usage/recent?limit=50`, { cache: 'no-store' }),
      ])
      if (s7.ok) setSummary7(await s7.json())
      if (s30.ok) setSummary30(await s30.json())
      if (rec.ok) setRecent((await rec.json()).rows ?? [])
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
          <h1 className="text-2xl font-semibold text-slate-900 inline-flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" />
            AI providers + spend
          </h1>
          <p className="text-base text-slate-500 mt-1 max-w-2xl">
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
          className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
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
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800">
          {error}
        </div>
      )}

      {/* Providers */}
      <section className="space-y-2">
        <h2 className="text-md font-semibold text-slate-700 uppercase tracking-wider">
          Providers
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {providers.map((p) => (
            <div
              key={p.name}
              className="border border-slate-200 rounded-md p-3 bg-white"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-lg font-medium text-slate-900">
                    {PROVIDER_LABEL[p.name] ?? p.name}
                  </div>
                  <div className="text-sm text-slate-500 font-mono mt-0.5">
                    {p.defaultModel}
                  </div>
                </div>
                {p.configured ? (
                  <span className="inline-flex items-center gap-1 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                    <CheckCircle2 className="w-3 h-3" />
                    Configured
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
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
        <div className="text-sm text-slate-500">
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
        <h2 className="text-md font-semibold text-slate-700 uppercase tracking-wider inline-flex items-center gap-1.5">
          <Activity className="w-3 h-3" />
          Recent calls
        </h2>
        <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 uppercase tracking-wider w-24">
                  When
                </th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 uppercase tracking-wider w-28">
                  Provider
                </th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 uppercase tracking-wider">
                  Feature
                </th>
                <th className="px-3 py-2 text-left font-semibold text-slate-700 uppercase tracking-wider w-40">
                  Model
                </th>
                <th className="px-3 py-2 text-right font-semibold text-slate-700 uppercase tracking-wider w-20">
                  In
                </th>
                <th className="px-3 py-2 text-right font-semibold text-slate-700 uppercase tracking-wider w-20">
                  Out
                </th>
                <th className="px-3 py-2 text-right font-semibold text-slate-700 uppercase tracking-wider w-20">
                  Cost
                </th>
                <th className="px-3 py-2 text-right font-semibold text-slate-700 uppercase tracking-wider w-16">
                  ms
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-8 text-center text-slate-400 italic"
                  >
                    No AI calls yet. Trigger a bulk fill on /products and
                    refresh.
                  </td>
                </tr>
              )}
              {recent.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-slate-100 ${
                    r.ok ? '' : 'bg-rose-50/40'
                  }`}
                  title={r.errorMessage ?? undefined}
                >
                  <td className="px-3 py-1.5 text-slate-600">
                    {fmtRelative(r.createdAt)}
                  </td>
                  <td className="px-3 py-1.5 text-slate-700">
                    {PROVIDER_LABEL[r.provider] ?? r.provider}
                  </td>
                  <td className="px-3 py-1.5 text-slate-700">
                    {r.feature ?? <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500 font-mono truncate">
                    {r.model}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">
                    {fmtTokens(r.inputTokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">
                    {fmtTokens(r.outputTokens)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-900 font-medium">
                    {fmtUSD(r.costUSD)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                    {r.latencyMs ?? ''}
                    {!r.ok && (
                      <XCircle className="w-3 h-3 text-rose-600 inline ml-1" />
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
      <div className="border border-slate-200 rounded-md p-3 bg-white">
        <div className="text-md font-semibold text-slate-700">{title}</div>
        <div className="text-base text-slate-500 mt-2 italic">
          No data
        </div>
      </div>
    )
  }
  return (
    <div className="border border-slate-200 rounded-md bg-white">
      <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between gap-2">
        <div className="text-md font-semibold text-slate-700">{title}</div>
        <div className="text-2xl font-semibold tabular-nums text-slate-900">
          {fmtUSD(summary.totals.costUSD)}
        </div>
      </div>
      <div className="px-3 py-2 grid grid-cols-3 gap-2 text-sm text-slate-600 border-b border-slate-100">
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-xs">
            Calls
          </div>
          <div className="text-lg font-medium text-slate-900 tabular-nums">
            {summary.totals.calls.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-xs">
            Input
          </div>
          <div className="text-lg font-medium text-slate-900 tabular-nums">
            {fmtTokens(summary.totals.inputTokens)}
          </div>
        </div>
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-xs">
            Output
          </div>
          <div className="text-lg font-medium text-slate-900 tabular-nums">
            {fmtTokens(summary.totals.outputTokens)}
          </div>
        </div>
      </div>

      {summary.byProvider.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-100">
          <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">
            By provider
          </div>
          <div className="space-y-1">
            {summary.byProvider.map((p) => (
              <div key={p.name} className="flex items-center justify-between text-base">
                <span className="text-slate-700">
                  {PROVIDER_LABEL[p.name] ?? p.name}
                </span>
                <span className="text-slate-500 tabular-nums">
                  {p.calls} call{p.calls === 1 ? '' : 's'} ·{' '}
                  <span className="text-slate-900 font-medium">
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
          <div className="text-xs text-slate-400 uppercase tracking-wider mb-1">
            By feature
          </div>
          <div className="space-y-1">
            {summary.byFeature.map((f) => (
              <div key={f.name} className="flex items-center justify-between text-base">
                <span className="text-slate-700 truncate">{f.name}</span>
                <span className="text-slate-500 tabular-nums">
                  {f.calls} call{f.calls === 1 ? '' : 's'} ·{' '}
                  <span className="text-slate-900 font-medium">
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
