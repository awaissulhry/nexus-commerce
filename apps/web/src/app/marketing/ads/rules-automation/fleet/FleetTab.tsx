'use client'

/**
 * NAF.D — the Agent Fleet surface: the six Part-8.2 panels in the
 * Control Room's visual family (light-only, acr-* classes, plain fetch;
 * this world deliberately avoids the DS DataGrid — see GuardrailGrid).
 * Promoted from a Control Room tab to its own page under Rules &
 * Automation (operator call 2026-08-06). The fleet map is xyflow per
 * decision D-D2, in FleetMapCanvas.
 *
 * Money/verdict honesty rules carried from Today: no € where there isn't
 * one, empty states say "nothing" credibly, and the brief panel says
 * plainly what arrives in a later stage rather than faking a narrative.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { FleetMapCanvas } from './FleetMapCanvas'

/* ── types mirroring the fleet API ─────────────────────────────────── */

interface CharterRow {
  key: string
  name: string
  tier: string
  domain: string
  description?: string
  enabled: boolean
  autonomyLevel: string
  autonomyCap: string
  dailyBudgetUSD: number
  maxTokensPerRun: number
  degraded: boolean
}
interface GraphNode {
  key: string
  tier: string
  enabled: boolean
  autonomyLevel: string
  degraded: boolean
}
interface GraphEdge {
  from: string
  to: string
  artifact: string
}
interface FleetState {
  halted: boolean
  haltReason: string | null
  dailyCeilingUSD: number
  degraded: boolean
}
interface RunRow {
  id: string
  agentKey: string
  mode: string | null
  trigger: string
  status: string
  ok: boolean
  findingCount: number
  costUSD: string
  latencyMs: number | null
  haltedReason: string | null
  errorMessage: string | null
  createdAt: string
}
interface FindingRow {
  id: string
  runId: string
  charterKey: string
  kind: string
  entityType: string
  entityId: string
  severity: string
  confidence: string
  rationale: string
  status: string
  createdAt: string
}
interface PlanRow {
  id: string
  charterKey: string
  headline: string
  narrative: string
  status: string
  criticVerdict: string | null
  criticNotes: { summary?: string; blockedItems?: string[] } | null
  items: Array<{ findingId: string; rank: number; tool: string }>
  droppedItems: Array<{ findingId: string; reason: string }>
  approvalIds: string[]
  createdAt: string
}
interface ApprovalRow {
  id: string
  toolName: string
  charterKey: string | null
  status: string
  args: Record<string, unknown>
  preview: { effect?: string } | null
  requestedAt: string
}
interface SweepRow {
  orchestrationId: string
  startedAt: string
  runs: { total: number; ok: number; failed: number }
  validationFailures: number
  findings: number
  costUSD: number
  clean: boolean
}
interface StepRow {
  seq: number
  type: string
  name: string
  ok: boolean
  latencyMs: number | null
  costUSD?: string
  errorMessage?: string | null
}

const LEVELS = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const
const usd = (n: number) => `$${n.toFixed(4)}`
const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/* ── the tab ───────────────────────────────────────────────────────── */

export function FleetTab() {
  const backend = getBackendUrl()
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)
  const [fleetState, setFleetState] = useState<FleetState | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [plans, setPlans] = useState<PlanRow[]>([])
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [sweeps, setSweeps] = useState<SweepRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawer, setDrawer] = useState<string | null>(null)
  const [openPlan, setOpenPlan] = useState<string | null>(null)
  const [stepsByRun, setStepsByRun] = useState<Record<string, StepRow[]>>({})
  const [rejectFor, setRejectFor] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectAllFor, setRejectAllFor] = useState<string | null>(null)
  const [rejectAllReason, setRejectAllReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, g, s, r, f, p, a, sw] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/graph`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/state`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/runs?limit=60`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/findings?limit=60`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/plans`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/approvals?status=pending`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/sweeps?limit=8`, { cache: 'no-store' }),
      ])
      if (!c.ok) throw new Error(`charters: ${c.status}`)
      setCharters(((await c.json()) as { charters: CharterRow[] }).charters)
      if (g.ok) setGraph((await g.json()) as { nodes: GraphNode[]; edges: GraphEdge[] })
      if (s.ok) setFleetState((await s.json()) as FleetState)
      if (r.ok) setRuns(((await r.json()) as { runs: RunRow[] }).runs)
      if (f.ok) setFindings(((await f.json()) as { findings: FindingRow[] }).findings)
      if (p.ok) setPlans(((await p.json()) as { plans: PlanRow[] }).plans)
      if (a.ok) setApprovals(((await a.json()) as { approvals: ApprovalRow[] }).approvals)
      if (sw.ok) setSweeps(((await sw.json()) as { sweeps: SweepRow[] }).sweeps)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [backend])

  useEffect(() => {
    void load()
  }, [load])

  const patchCharter = useCallback(
    async (key: string, body: { enabled?: boolean; autonomyLevel?: string }) => {
      setBusy(true)
      try {
        const r = await fetch(`${backend}/api/agent/fleet/charters/${key}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!r.ok) {
          const d = (await r.json().catch(() => null)) as { error?: string } | null
          setErr(d?.error ?? `charter update: ${r.status}`)
        } else {
          setErr(null)
        }
        await load()
      } finally {
        setBusy(false)
      }
    },
    [backend, load],
  )

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'reject', reason?: string) => {
      setBusy(true)
      try {
        const r = await fetch(`${backend}/api/agent/fleet/approvals/${id}/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision, reason }),
        })
        if (!r.ok) {
          const d = (await r.json().catch(() => null)) as { error?: string } | null
          setErr(d?.error ?? `decide: ${r.status}`)
        }
        setRejectFor(null)
        setRejectReason('')
        await load()
      } finally {
        setBusy(false)
      }
    },
    [backend, load],
  )

  const rejectAll = useCallback(
    async (charterKey: string, reason: string) => {
      setBusy(true)
      try {
        const r = await fetch(`${backend}/api/agent/fleet/approvals/reject-all`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ charterKey, reason }),
        })
        if (!r.ok) {
          const d = (await r.json().catch(() => null)) as { error?: string } | null
          setErr(d?.error ?? `reject-all: ${r.status}`)
        }
        setRejectAllFor(null)
        setRejectAllReason('')
        await load()
      } finally {
        setBusy(false)
      }
    },
    [backend, load],
  )

  const toggleSteps = useCallback(
    async (runId: string) => {
      if (stepsByRun[runId]) {
        setStepsByRun((prev) => {
          const next = { ...prev }
          delete next[runId]
          return next
        })
        return
      }
      const r = await fetch(`${backend}/api/agent/fleet/runs/${runId}/steps`, {
        cache: 'no-store',
      })
      if (r.ok) {
        const d = (await r.json()) as { steps: StepRow[] }
        setStepsByRun((prev) => ({ ...prev, [runId]: d.steps }))
      }
    },
    [backend, stepsByRun],
  )

  /* derived */
  const openFindingsByCharter = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of findings) {
      if (f.status === 'open') m.set(f.charterKey, (m.get(f.charterKey) ?? 0) + 1)
    }
    return m
  }, [findings])

  const cost7dByCharter = useMemo(() => {
    const since = Date.now() - 7 * 24 * 3600_000
    const m = new Map<string, number>()
    for (const r of runs) {
      if (new Date(r.createdAt).getTime() < since) continue
      m.set(r.agentKey, (m.get(r.agentKey) ?? 0) + Number(r.costUSD))
    }
    return m
  }, [runs])

  const costToday = useMemo(() => {
    const dayStart = new Date()
    dayStart.setUTCHours(0, 0, 0, 0)
    return runs
      .filter((r) => new Date(r.createdAt) >= dayStart)
      .reduce((s, r) => s + Number(r.costUSD), 0)
  }, [runs])

  const charterByKey = useMemo(() => new Map(charters.map((c) => [c.key, c])), [charters])
  const nameByKey = useMemo(() => new Map(charters.map((c) => [c.key, c.name])), [charters])
  const drawerCharter = drawer ? charterByKey.get(drawer) : null
  const drawerRuns = useMemo(
    () => runs.filter((r) => r.agentKey === drawer).slice(0, 5),
    [runs, drawer],
  )
  const pendingByCharter = useMemo(() => {
    const m = new Map<string, ApprovalRow[]>()
    for (const a of approvals) {
      const k = a.charterKey ?? 'unknown'
      m.set(k, [...(m.get(k) ?? []), a])
    }
    return m
  }, [approvals])

  if (loading && charters.length === 0) {
    return <div className="acr-card acr-fl-loading">Loading the fleet…</div>
  }

  return (
    <div className="acr-fleet">
      {err ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} /> {err}
        </div>
      ) : null}

      {/* 1 — fleet map */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>
            <Bot size={15} /> Fleet map
          </h3>
          <div className="acr-fl-headright">
            {fleetState?.halted ? (
              <span className="acr-fl-pill acr-fl-pill-halt">
                HALTED{fleetState.haltReason ? ` — ${fleetState.haltReason}` : ''}
              </span>
            ) : (
              <span className="acr-fl-pill acr-fl-pill-ok">running</span>
            )}
            <button className="acr-btn" onClick={() => void load()} disabled={busy}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </header>
        {graph ? (
          <FleetMapCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            nameByKey={nameByKey}
            openByKey={openFindingsByCharter}
            selected={drawer}
            onSelect={(key) => setDrawer(drawer === key ? null : key)}
          />
        ) : (
          <p className="acr-fl-empty">The graph endpoint returned nothing.</p>
        )}
      </section>

      {/* 2 — agent drawer */}
      {drawerCharter ? (
        <section className="acr-card acr-fl-drawer">
          <header className="acr-fl-head">
            <h3>{drawerCharter.name}</h3>
            <button className="acr-btn" onClick={() => setDrawer(null)}>
              <X size={13} /> Close
            </button>
          </header>
          <p className="acr-fl-desc">{drawerCharter.description}</p>
          <div className="acr-fl-dialrow">
            <span className="acr-fl-lbl">Autonomy (cap {drawerCharter.autonomyCap})</span>
            <div className="acr-dial">
              {LEVELS.map((lv) => {
                const overCap =
                  LEVELS.indexOf(lv) > LEVELS.indexOf(drawerCharter.autonomyCap as (typeof LEVELS)[number])
                return (
                  <button
                    key={lv}
                    className={`acr-btn ${drawerCharter.autonomyLevel === lv ? 'on' : ''}`}
                    disabled={busy || overCap}
                    title={overCap ? `above this charter's cap (${drawerCharter.autonomyCap})` : undefined}
                    onClick={() => void patchCharter(drawerCharter.key, { autonomyLevel: lv })}
                  >
                    {lv}
                  </button>
                )
              })}
            </div>
            <label className="acr-fl-toggle">
              <input
                type="checkbox"
                checked={drawerCharter.enabled}
                disabled={busy}
                onChange={(e) =>
                  void patchCharter(drawerCharter.key, { enabled: e.target.checked })
                }
              />
              enabled
            </label>
          </div>
          <div className="acr-fl-facts">
            <span>budget {usd(drawerCharter.dailyBudgetUSD)}/day</span>
            <span>{drawerCharter.maxTokensPerRun.toLocaleString()} tokens/run</span>
            <span>cost 7d {usd(cost7dByCharter.get(drawerCharter.key) ?? 0)}</span>
            {drawerCharter.degraded ? <span className="acr-fl-degraded">policy unreadable — fail-safe OFF</span> : null}
          </div>
          <div className="acr-fl-runs">
            {drawerRuns.length === 0 ? (
              <p className="acr-fl-empty">No runs yet.</p>
            ) : (
              drawerRuns.map((r) => (
                <div key={r.id} className="acr-fl-run">
                  <button className="acr-fl-runhead" onClick={() => void toggleSteps(r.id)}>
                    {stepsByRun[r.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className={`acr-dot ${r.ok ? 'ok' : 'bad'}`} />
                    {r.status}
                    {r.findingCount > 0 ? ` · ${r.findingCount} findings` : ''} · {usd(Number(r.costUSD))} ·{' '}
                    {ago(r.createdAt)}
                    {r.haltedReason ? ` · ${r.haltedReason}` : ''}
                    {r.errorMessage ? ` · ${r.errorMessage.slice(0, 80)}` : ''}
                  </button>
                  {stepsByRun[r.id] ? (
                    <ol className="acr-fl-steps">
                      {stepsByRun[r.id]!.map((s) => (
                        <li key={s.seq} className={s.ok ? '' : 'bad'}>
                          {s.seq}. {s.type}:{s.name}
                          {s.latencyMs != null ? ` (${s.latencyMs}ms)` : ''}
                          {s.errorMessage ? ` — ${s.errorMessage.slice(0, 100)}` : ''}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}

      {/* 3 — decision timeline */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Decision timeline</h3>
          <span className="acr-fl-sub">finding → plan → critic → approval</span>
        </header>
        {plans.length === 0 ? (
          <p className="acr-fl-empty">
            No plans yet — the council runs weekly once the director is enabled.
          </p>
        ) : (
          plans.slice(0, 5).map((p) => (
            <div key={p.id} className="acr-fl-plan">
              <button
                className="acr-fl-planhead"
                onClick={() => setOpenPlan(openPlan === p.id ? null : p.id)}
              >
                {openPlan === p.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <strong>{p.headline}</strong>
                <span className={`acr-fl-pill verdict-${p.criticVerdict ?? 'none'}`}>
                  {p.criticVerdict ?? 'uncritiqued'}
                </span>
                <span className="acr-fl-pill">{p.status}</span>
                <span className="acr-fl-sub">
                  {p.items.length} items · {p.droppedItems.length} dropped · {ago(p.createdAt)}
                </span>
              </button>
              {openPlan === p.id ? (
                <div className="acr-fl-planbody">
                  <p>{p.narrative}</p>
                  {p.criticNotes?.summary ? (
                    <p className="acr-fl-critic">Critic: {p.criticNotes.summary}</p>
                  ) : null}
                  <ul>
                    {p.items.map((it) => (
                      <li key={it.findingId}>
                        #{it.rank} {it.tool} — finding {it.findingId}
                        {p.criticNotes?.blockedItems?.includes(it.findingId) ? (
                          <span className="acr-fl-pill verdict-block">blocked</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {p.droppedItems.length > 0 ? (
                    <details>
                      <summary>{p.droppedItems.length} dropped, with reasons</summary>
                      <ul>
                        {p.droppedItems.map((d) => (
                          <li key={d.findingId}>
                            {d.findingId}: {d.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))
        )}
      </section>

      {/* 4 — approval inbox */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Approval inbox</h3>
          <span className="acr-fl-sub">
            {approvals.length === 0 ? 'nothing waiting' : `${approvals.length} pending`}
          </span>
        </header>
        {[...pendingByCharter.entries()].map(([charterKey, rows]) => (
          <div key={charterKey} className="acr-fl-inboxgroup">
            <div className="acr-fl-inboxhead">
              <strong>{charterKey}</strong>
              {rejectAllFor === charterKey ? (
                <span className="acr-fl-rejectrow">
                  <input
                    autoFocus
                    placeholder="one-line reason (required)"
                    value={rejectAllReason}
                    onChange={(e) => setRejectAllReason(e.target.value)}
                  />
                  <button
                    className="acr-btn"
                    disabled={busy || !rejectAllReason.trim()}
                    onClick={() => void rejectAll(charterKey, rejectAllReason.trim())}
                  >
                    Confirm reject all ({rows.length})
                  </button>
                  <button className="acr-btn" disabled={busy} onClick={() => setRejectAllFor(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="acr-btn"
                  disabled={busy}
                  onClick={() => {
                    setRejectAllFor(charterKey)
                    setRejectAllReason('')
                  }}
                >
                  Reject all ({rows.length})
                </button>
              )}
            </div>
            {rows.map((a) => (
              <div key={a.id} className="acr-fl-approval">
                <div className="acr-fl-apbody">
                  <span className="acr-fl-pill">{a.toolName}</span>
                  <span>{a.preview?.effect ?? JSON.stringify(a.args).slice(0, 140)}</span>
                  <span className="acr-fl-sub">{ago(a.requestedAt)}</span>
                </div>
                <div className="acr-fl-apactions">
                  <button
                    className="acr-btn"
                    disabled={busy}
                    onClick={() => void decide(a.id, 'approve')}
                  >
                    <Check size={13} /> Approve
                  </button>
                  {rejectFor === a.id ? (
                    <span className="acr-fl-rejectrow">
                      <input
                        autoFocus
                        placeholder="one-line reason (required)"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                      />
                      <button
                        className="acr-btn"
                        disabled={busy || !rejectReason.trim()}
                        onClick={() => void decide(a.id, 'reject', rejectReason.trim())}
                      >
                        Confirm reject
                      </button>
                    </span>
                  ) : (
                    <button className="acr-btn" disabled={busy} onClick={() => setRejectFor(a.id)}>
                      <X size={13} /> Reject
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
        {approvals.length === 0 ? (
          <p className="acr-fl-empty">Approved and rejected items feed the exemplar store (Stage E).</p>
        ) : null}
      </section>

      {/* 5 — cost ledger */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Cost ledger</h3>
          <span className="acr-fl-sub">
            today {usd(costToday)} of ${fleetState?.dailyCeilingUSD?.toFixed(2) ?? '—'} ceiling
          </span>
        </header>
        <table className="acr-fl-table">
          <thead>
            <tr>
              <th>Charter</th>
              <th>7d cost</th>
              <th>Runs shown</th>
            </tr>
          </thead>
          <tbody>
            {charters.map((c) => (
              <tr key={c.key}>
                <td>{c.name}</td>
                <td>{usd(cost7dByCharter.get(c.key) ?? 0)}</td>
                <td>{runs.filter((r) => r.agentKey === c.key).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="acr-fl-sub">
          Sums are over the {runs.length} most recent runs loaded — the full ledger lives on
          AgentStep and reconciles in the sweep report.
        </p>
      </section>

      {/* 6 — brief */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Brief</h3>
        </header>
        {sweeps.length === 0 ? (
          <p className="acr-fl-empty">No sweeps recorded yet.</p>
        ) : (
          <ul className="acr-fl-sweeps">
            {sweeps.map((s) => (
              <li key={s.orchestrationId}>
                <span className={`acr-dot ${s.clean ? 'ok' : 'bad'}`} />
                {new Date(s.startedAt).toISOString().slice(0, 10)} — {s.runs.ok}/{s.runs.total} ok,{' '}
                {s.findings} findings, {s.validationFailures} validation failures, {usd(s.costUSD)}
              </li>
            ))}
          </ul>
        )}
        <p className="acr-fl-empty">
          The auditor's daily narrative arrives in Stage E — until then this panel reports sweeps,
          not stories.
        </p>
      </section>
    </div>
  )
}
