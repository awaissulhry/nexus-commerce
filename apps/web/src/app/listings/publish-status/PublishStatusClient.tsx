'use client'

// M.7 — Phase B publish-status client.
//
// Live-renders the same data the V.1 verification CLI prints. Eight
// blocks (env reminder + 7 data sections), 30-second polling, all
// computed server-side via $queryRawUnsafe so shape parity with the
// script is exact.
//
// Why a separate page rather than another lens: the operator runs
// this during rollout, not during day-to-day catalog work. Nesting
// it in /listings as a sibling page keeps the data close to the
// surface that consumes the publish gate (the wizard + outbound
// sync + bulk publish flows) without crowding the main grid.

import { useMemo } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  XCircle,
  Activity,
  ShieldAlert,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { usePolledList } from '@/lib/sync/use-polled-list'

interface PublishStatusResponse {
  last24h: Array<{ channel: string; mode: string; outcome: string; attempts: number; distinct_skus: number }>
  last7d: Array<{ channel: string; mode: string; outcome: string; attempts: number; distinct_skus: number }>
  rollup30d: Array<{
    channel: string
    attempts: number
    succeeded: number
    gated: number
    failed: number
    rate_limited: number
    circuit_open: number
    timed_out: number
    success_pct: number | null
  }>
  recentFailures: Array<{
    at: string
    channel: string
    marketplace: string | null
    mode: string
    outcome: string
    sku: string | null
    error_excerpt: string | null
  }>
  trippedCircuits: Array<{
    channel: string
    marketplace: string | null
    sellerId: string | null
    recent_failures: number
    last_failure: string
  }>
  skuCoverage: Array<{
    channel: string
    mode: string
    distinct_skus: number
    first_seen: string
    last_seen: string
  }>
  repeatAttempts: Array<{
    sku: string | null
    channel: string
    marketplace: string | null
    attempts: number
    succeeded: number
    unhappy: number
  }>
  env: {
    AMAZON_PUBLISH_ENABLED: boolean
    AMAZON_PUBLISH_MODE: string
    EBAY_PUBLISH_ENABLED: boolean
    EBAY_PUBLISH_MODE: string
  }
  fetchedAt: string
}

const OUTCOME_TONE: Record<string, { bg: string; text: string; icon: any }> = {
  success: { bg: 'bg-emerald-50', text: 'text-emerald-700', icon: CheckCircle2 },
  gated: { bg: 'bg-slate-50', text: 'text-slate-600', icon: ShieldAlert },
  failed: { bg: 'bg-rose-50', text: 'text-rose-700', icon: XCircle },
  timeout: { bg: 'bg-rose-50', text: 'text-rose-700', icon: Clock },
  'rate-limited': { bg: 'bg-amber-50', text: 'text-amber-700', icon: AlertTriangle },
  'circuit-open': { bg: 'bg-rose-50', text: 'text-rose-700', icon: XCircle },
}

interface Breadcrumb {
  label: string
  href?: string
}

export default function PublishStatusClient({ breadcrumbs }: { breadcrumbs?: Breadcrumb[] }) {
  const { data, loading, error, lastFetchedAt, refetch } = usePolledList<PublishStatusResponse>({
    url: '/api/listings/publish-status',
    intervalMs: 30_000,
  })

  const status = data as PublishStatusResponse | undefined

  // Derive a single-pane health summary from the 30-day rollup so the
  // operator gets a one-glance read of every channel's posture.
  const healthByChannel = useMemo(() => {
    if (!status) return []
    return status.rollup30d.map((r) => {
      const successPct = r.success_pct ?? 0
      const tone =
        r.circuit_open > 0 ? 'critical'
        : r.failed > 5 || successPct < 80 ? 'warning'
        : 'healthy'
      return { ...r, tone }
    })
  }, [status])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Publish status"
        description="Live audit of every channel-write attempt. Same data the V.1 CLI script (audit-channel-publish-attempts.mjs) produces, polled every 30s."
        breadcrumbs={breadcrumbs}
      />

      {/* Env block — what the API thinks the publish gate is set to */}
      <Card>
        <div className="space-y-1.5">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
            Publish gate · env (live from this API instance)
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <EnvCell label="Amazon publish" enabled={status?.env.AMAZON_PUBLISH_ENABLED} mode={status?.env.AMAZON_PUBLISH_MODE} />
            <EnvCell label="eBay publish" enabled={status?.env.EBAY_PUBLISH_ENABLED} mode={status?.env.EBAY_PUBLISH_MODE} />
          </div>
          <div className="text-xs text-slate-400">
            Defaults: gated + dry-run. Flip via Railway env vars
            (NEXUS_ENABLE_&lt;CH&gt;_PUBLISH, &lt;CH&gt;_PUBLISH_MODE) — see PHASE_B_VERIFICATION.md.
          </div>
        </div>
      </Card>

      {/* Tripped circuits — critical alert, surfaces first when present */}
      {status && status.trippedCircuits.length > 0 && (
        <Card className="border-rose-300 bg-rose-50/50">
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-rose-700 font-semibold inline-flex items-center gap-1.5">
              <AlertTriangle size={12} /> Likely-tripped circuits — 3+ failures in last 5 min
            </div>
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <thead className="text-xs uppercase tracking-wider text-rose-700">
                  <tr>
                    <th className="text-left px-2 py-1">Channel</th>
                    <th className="text-left px-2 py-1">Marketplace</th>
                    <th className="text-left px-2 py-1">Seller</th>
                    <th className="text-right px-2 py-1">Recent failures</th>
                    <th className="text-right px-2 py-1">Last failure</th>
                  </tr>
                </thead>
                <tbody>
                  {status.trippedCircuits.map((c, i) => (
                    <tr key={i} className="border-t border-rose-200">
                      <td className="px-2 py-1 font-mono">{c.channel}</td>
                      <td className="px-2 py-1 font-mono">{c.marketplace ?? '—'}</td>
                      <td className="px-2 py-1 font-mono text-xs">{c.sellerId ?? '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-semibold text-rose-700">{c.recent_failures}</td>
                      <td className="px-2 py-1 text-right text-xs text-slate-600">{new Date(c.last_failure).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}

      {/* 30-day per-channel rollup */}
      <Card>
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1.5">
            <Activity size={12} /> 30-day per-channel health
          </div>
          {loading && !status ? (
            <Skeleton variant="block" height={80} />
          ) : healthByChannel.length === 0 ? (
            <EmptyText text="No publish attempts in the last 30 days. Either the master flag is off, or no wizard / outbound-sync run has touched a publishable channel yet." />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {healthByChannel.map((c) => (
                <div
                  key={c.channel}
                  className={`border rounded p-3 ${
                    c.tone === 'critical' ? 'border-rose-300 bg-rose-50/50'
                    : c.tone === 'warning' ? 'border-amber-300 bg-amber-50/50'
                    : 'border-emerald-200 bg-emerald-50/30'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-mono font-semibold text-slate-900">{c.channel}</span>
                    <span className="text-xs tabular-nums text-slate-600">
                      {c.success_pct != null ? `${c.success_pct.toFixed(1)}% success` : 'no data'}
                    </span>
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center">
                    <Stat label="attempts" value={c.attempts} />
                    <Stat label="ok" value={c.succeeded} tone="emerald" />
                    <Stat label="gated" value={c.gated} tone="slate" />
                    <Stat label="failed" value={c.failed} tone="rose" />
                    <Stat label="rate-lim" value={c.rate_limited} tone="amber" />
                    <Stat label="circuit" value={c.circuit_open} tone="rose" />
                    <Stat label="timeout" value={c.timed_out} tone="rose" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Last-24h activity table */}
      <Card>
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1.5">
            <Clock size={12} /> Last 24 hours · activity by (channel, mode, outcome)
          </div>
          {loading && !status ? (
            <Skeleton variant="block" height={80} />
          ) : status && status.last24h.length === 0 ? (
            <EmptyText text="No activity in the last 24 hours." />
          ) : (
            <ActivityTable rows={status?.last24h ?? []} />
          )}
        </div>
      </Card>

      {/* Last-7d activity table */}
      <Card>
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1.5">
            <Clock size={12} /> Last 7 days · activity by (channel, mode, outcome)
          </div>
          {loading && !status ? (
            <Skeleton variant="block" height={80} />
          ) : status && status.last7d.length === 0 ? (
            <EmptyText text="No activity in the last 7 days." />
          ) : (
            <ActivityTable rows={status?.last7d ?? []} />
          )}
        </div>
      </Card>

      {/* Recent failures — the operator's daily triage queue */}
      <Card>
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1.5">
            <XCircle size={12} /> Recent failures · top 20 in last 7 days
          </div>
          {loading && !status ? (
            <Skeleton variant="block" height={120} />
          ) : status && status.recentFailures.length === 0 ? (
            <EmptyText text="No failures in the last 7 days. Either nothing has been pushed for real yet, or every push has succeeded." />
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <thead className="text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="text-left px-2 py-1">When</th>
                    <th className="text-left px-2 py-1">Channel</th>
                    <th className="text-left px-2 py-1">Mode</th>
                    <th className="text-left px-2 py-1">Outcome</th>
                    <th className="text-left px-2 py-1">SKU</th>
                    <th className="text-left px-2 py-1">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {status?.recentFailures.map((r, i) => {
                    const tone = OUTCOME_TONE[r.outcome] ?? { bg: 'bg-slate-50', text: 'text-slate-600', icon: AlertTriangle }
                    const Icon = tone.icon
                    return (
                      <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/50">
                        <td className="px-2 py-1 text-xs text-slate-600 whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
                        <td className="px-2 py-1 font-mono text-xs">{r.channel}</td>
                        <td className="px-2 py-1 font-mono text-xs">{r.mode}</td>
                        <td className="px-2 py-1">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded ${tone.bg} ${tone.text}`}>
                            <Icon size={10} /> {r.outcome}
                          </span>
                        </td>
                        <td className="px-2 py-1 font-mono text-xs">{r.sku ?? '—'}</td>
                        <td className="px-2 py-1 text-xs text-slate-700 max-w-md truncate" title={r.error_excerpt ?? ''}>
                          {r.error_excerpt ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* SKU coverage — how many distinct SKUs the gate has seen, per (channel, mode) */}
      <Card>
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
            SKU coverage · last 30 days
          </div>
          {loading && !status ? (
            <Skeleton variant="block" height={60} />
          ) : status && status.skuCoverage.length === 0 ? (
            <EmptyText text="No SKUs have been touched by the publish gate in the last 30 days." />
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <thead className="text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="text-left px-2 py-1">Channel</th>
                    <th className="text-left px-2 py-1">Mode</th>
                    <th className="text-right px-2 py-1">Distinct SKUs</th>
                    <th className="text-right px-2 py-1">First seen</th>
                    <th className="text-right px-2 py-1">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {status?.skuCoverage.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-mono text-xs">{r.channel}</td>
                      <td className="px-2 py-1 font-mono text-xs">{r.mode}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.distinct_skus}</td>
                      <td className="px-2 py-1 text-right text-xs text-slate-600">{new Date(r.first_seen).toLocaleString()}</td>
                      <td className="px-2 py-1 text-right text-xs text-slate-600">{new Date(r.last_seen).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* Repeat-attempt SKUs — potential drift / loop */}
      <Card>
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
            Repeat attempts · top 10 SKUs in last 7 days
          </div>
          {loading && !status ? (
            <Skeleton variant="block" height={60} />
          ) : status && status.repeatAttempts.length === 0 ? (
            <EmptyText text="No SKU has been pushed more than once in the last 7 days." />
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <thead className="text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="text-left px-2 py-1">SKU</th>
                    <th className="text-left px-2 py-1">Channel</th>
                    <th className="text-left px-2 py-1">Marketplace</th>
                    <th className="text-right px-2 py-1">Attempts</th>
                    <th className="text-right px-2 py-1">Succeeded</th>
                    <th className="text-right px-2 py-1">Unhappy</th>
                  </tr>
                </thead>
                <tbody>
                  {status?.repeatAttempts.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-mono text-xs">{r.sku ?? '—'}</td>
                      <td className="px-2 py-1 font-mono text-xs">{r.channel}</td>
                      <td className="px-2 py-1 font-mono text-xs">{r.marketplace ?? '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-semibold">{r.attempts}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-emerald-700">{r.succeeded}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-rose-700">{r.unhappy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {error && (
        <Card className="border-rose-300 bg-rose-50">
          <div className="text-sm text-rose-700">Failed to load: {error}</div>
        </Card>
      )}

      <div className="text-xs text-slate-400 text-right">
        Last fetched {lastFetchedAt ? new Date(lastFetchedAt).toLocaleTimeString() : '—'} ·{' '}
        polls every 30s ·{' '}
        <button onClick={() => refetch()} className="underline hover:text-slate-600">
          Refresh now
        </button>
      </div>
    </div>
  )
}

function EnvCell({
  label,
  enabled,
  mode,
}: {
  label: string
  enabled?: boolean
  mode?: string
}) {
  if (enabled == null) {
    return (
      <div className="border border-slate-200 rounded p-2">
        <div className="text-xs text-slate-500">{label}</div>
        <div className="text-sm text-slate-400">loading…</div>
      </div>
    )
  }
  const tone =
    !enabled ? 'border-slate-200 bg-slate-50'
    : mode === 'live' ? 'border-emerald-300 bg-emerald-50'
    : mode === 'sandbox' ? 'border-amber-300 bg-amber-50'
    : 'border-slate-300 bg-slate-50'
  return (
    <div className={`border rounded p-2 ${tone}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm">
        <span className={enabled ? 'font-semibold text-slate-900' : 'text-slate-500'}>
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
        {' · '}
        <span className="font-mono text-slate-700">{mode ?? 'dry-run'}</span>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'emerald' | 'rose' | 'amber' | 'slate'
}) {
  const cls =
    value === 0
      ? 'text-slate-400'
      : tone === 'emerald' ? 'text-emerald-700 font-semibold'
      : tone === 'rose' ? 'text-rose-700 font-semibold'
      : tone === 'amber' ? 'text-amber-700 font-semibold'
      : tone === 'slate' ? 'text-slate-700'
      : 'text-slate-900 font-semibold'
  return (
    <div>
      <div className={`text-sm tabular-nums ${cls}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
    </div>
  )
}

function ActivityTable({ rows }: { rows: Array<{ channel: string; mode: string; outcome: string; attempts: number; distinct_skus: number }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="text-sm w-full">
        <thead className="text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="text-left px-2 py-1">Channel</th>
            <th className="text-left px-2 py-1">Mode</th>
            <th className="text-left px-2 py-1">Outcome</th>
            <th className="text-right px-2 py-1">Attempts</th>
            <th className="text-right px-2 py-1">Distinct SKUs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const tone = OUTCOME_TONE[r.outcome] ?? { bg: 'bg-slate-50', text: 'text-slate-600', icon: AlertTriangle }
            const Icon = tone.icon
            return (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-2 py-1 font-mono text-xs">{r.channel}</td>
                <td className="px-2 py-1 font-mono text-xs">{r.mode}</td>
                <td className="px-2 py-1">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded ${tone.bg} ${tone.text}`}>
                    <Icon size={10} /> {r.outcome}
                  </span>
                </td>
                <td className="px-2 py-1 text-right tabular-nums font-semibold">{r.attempts}</td>
                <td className="px-2 py-1 text-right tabular-nums text-slate-600">{r.distinct_skus}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function EmptyText({ text }: { text: string }) {
  return <div className="text-sm text-slate-500 py-3">{text}</div>
}
