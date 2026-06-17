'use client'

/**
 * ACP.5a — Agent Control Center.
 *
 * The operator's cockpit for the autonomous agents: each agent with its
 * scheduled-run on/off toggle, last run, and how many proposals it has
 * waiting in the approval inbox — plus a "Run now" button and a recent
 * activity feed across every agent + the copilot. Self-fetching over
 * GET /api/agent/agents, GET /api/agent/runs, PUT /api/agent/agents/:key,
 * POST /api/agent/agents/:key/run.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Bot,
  Play,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Activity,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface AgentRow {
  key: string
  name: string
  description: string
  schedule: string | null
  enabled: boolean
  lastRun: {
    status: string
    ok: boolean
    trigger: string
    at: string
    summary: string | null
  } | null
  pendingCount: number
}

interface RunRow {
  id: string
  agentKey: string
  trigger: string
  status: string
  ok: boolean
  costUSD: string | number
  model: string | null
  latencyMs: number | null
  errorMessage: string | null
  createdAt: string
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function StatusDot({ status, ok }: { status: string; ok: boolean }) {
  if (status === 'running')
    return <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
  if (status === 'done' && ok)
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
  if (status === 'failed' || !ok)
    return <XCircle className="w-3.5 h-3.5 text-rose-500" />
  return <Clock className="w-3.5 h-3.5 text-tertiary" />
}

export default function AiAgentsClient() {
  const backend = getBackendUrl()
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([
        fetch(`${backend}/api/agent/agents`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/runs?limit=15`, { cache: 'no-store' }),
      ])
      const aj = await a.json().catch(() => null)
      const rj = await r.json().catch(() => null)
      setAgents(aj?.agents ?? [])
      setRuns(rj?.rows ?? [])
    } catch {
      setError('Could not load agents.')
    } finally {
      setLoading(false)
    }
  }, [backend])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(
    async (key: string, enabled: boolean) => {
      setBusy(key)
      setError(null)
      try {
        const r = await fetch(`${backend}/api/agent/agents/${key}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        const d = await r.json().catch(() => null)
        if (d?.agents) setAgents(d.agents)
        else await load()
      } catch {
        setError('Toggle failed.')
      } finally {
        setBusy(null)
      }
    },
    [backend, load],
  )

  const runNow = useCallback(
    async (key: string) => {
      setBusy(key)
      setError(null)
      try {
        const r = await fetch(`${backend}/api/agent/agents/${key}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maxItems: 5 }),
        })
        const d = await r.json().catch(() => null)
        if (!r.ok || !d?.ok) setError(d?.error ?? 'Run failed.')
        await load()
      } catch {
        setError('Run failed.')
      } finally {
        setBusy(null)
      }
    },
    [backend, load],
  )

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
          <Bot className="w-4 h-4" />
          Autonomous agents
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="h-8 px-3 text-base border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-2xl">
        Agents work on a schedule and queue proposals into the approval inbox
        above — they never apply anything on their own. Toggle a schedule off,
        or run one now.
      </p>

      {error && (
        <div
          role="alert"
          className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-200"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-base text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> loading…
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {agents.map((a) => (
            <div
              key={a.key}
              className="border border-default dark:border-slate-700 rounded-md p-3 bg-white dark:bg-slate-900"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {a.name}
                  </div>
                  {a.schedule && (
                    <div className="text-sm text-tertiary dark:text-slate-500 inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {a.schedule}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={a.enabled}
                  disabled={busy === a.key}
                  onClick={() => void toggle(a.key, !a.enabled)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    a.enabled
                      ? 'bg-emerald-500'
                      : 'bg-slate-300 dark:bg-slate-600'
                  } disabled:opacity-50`}
                  title={a.enabled ? 'Scheduled runs ON' : 'Scheduled runs OFF'}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      a.enabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
                {a.description}
              </p>

              <div className="mt-2 flex items-center gap-3 text-sm">
                {a.lastRun ? (
                  <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
                    <StatusDot status={a.lastRun.status} ok={a.lastRun.ok} />
                    {a.lastRun.summary ?? a.lastRun.status} ·{' '}
                    {ago(a.lastRun.at)}
                  </span>
                ) : (
                  <span className="text-tertiary">no runs yet</span>
                )}
              </div>

              <div className="mt-2 flex items-center justify-between">
                {a.pendingCount > 0 ? (
                  <a
                    href="#agent-approvals"
                    className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-full px-2 py-0.5"
                  >
                    {a.pendingCount} awaiting approval
                  </a>
                ) : (
                  <span className="text-sm text-tertiary">
                    no pending proposals
                  </span>
                )}
                <button
                  type="button"
                  disabled={busy === a.key}
                  onClick={() => void runNow(a.key)}
                  className="h-8 px-3 text-base rounded border border-default dark:border-slate-700 inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  {busy === a.key ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                  Run now
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent activity feed */}
      <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider inline-flex items-center gap-1.5 pt-2">
        <Activity className="w-3.5 h-3.5" /> Recent activity
      </h3>
      {runs.length === 0 ? (
        <div className="text-sm text-tertiary">No agent runs yet.</div>
      ) : (
        <div className="border border-default dark:border-slate-700 rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="text-left font-medium px-3 py-1.5">Agent</th>
                <th className="text-left font-medium px-3 py-1.5">Trigger</th>
                <th className="text-left font-medium px-3 py-1.5">Status</th>
                <th className="text-right font-medium px-3 py-1.5">Cost</th>
                <th className="text-right font-medium px-3 py-1.5">When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-subtle dark:border-slate-800"
                >
                  <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-slate-300">
                    {r.agentKey}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{r.trigger}</td>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
                      <StatusDot status={r.status} ok={r.ok} />
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                    ${Number(r.costUSD ?? 0).toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-tertiary">
                    {ago(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
