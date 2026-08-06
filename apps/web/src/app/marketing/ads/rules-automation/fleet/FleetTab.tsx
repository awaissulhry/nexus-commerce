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
import { useRouter } from 'next/navigation'
import { Bot, ChevronDown, ChevronRight, RefreshCw, ShieldAlert } from 'lucide-react'
import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { getBackendUrl } from '@/lib/backend-url'
import { DecisionCard } from './DecisionCard'
import {
  EntityGraphCanvas,
  RELATION_META,
  type EntityGraphData,
} from './EntityGraphCanvas'
import { FleetMapCanvas, type CanvasFinding, type NodeRunInfo } from './FleetMapCanvas'
import { Term } from './glossary'
import { FirstVisitIntro, HowItWorks } from './HowItWorks'
import { PlanStory, type PlanLabels, type StoryPlan } from './PlanStory'

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
type PlanRow = StoryPlan & { charterKey: string }
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
interface ScheduleJob {
  key: string
  label: string
  schedule: string
  enabled: boolean
  nextFireAt: string | null
  lastRun: { startedAt: string; status: string; outputSummary: string | null } | null
}
interface ScorecardRow {
  charterKey: string
  windowDays: number
  periodEnd: string
  findings: number
  approved: number
  rejected: number
  shadowAgreement: string | null
  grade: string | null
  promotionEligible: boolean
}

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
  const router = useRouter()
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null)
  const [fleetState, setFleetState] = useState<FleetState | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [plans, setPlans] = useState<PlanRow[]>([])
  const [planLabels, setPlanLabels] = useState<PlanLabels>({ campaigns: {}, targets: {} })
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [sweeps, setSweeps] = useState<SweepRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [expandedWorker, setExpandedWorker] = useState<string | null>(null)
  const [mapView, setMapView] = useState<'workers' | 'entities'>('workers')
  const [entityGraph, setEntityGraph] = useState<EntityGraphData | null>(null)
  const [entityLoading, setEntityLoading] = useState(false)
  const [openPlan, setOpenPlan] = useState<string | null>(null)
  const [schedule, setSchedule] = useState<ScheduleJob[]>([])
  const [scorecards, setScorecards] = useState<ScorecardRow[]>([])
  const [rejectAllFor, setRejectAllFor] = useState<string | null>(null)
  const [rejectAllReason, setRejectAllReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true)
    try {
      const [c, g, s, r, f, p, a, sw, sch, sc] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/graph`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/state`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/runs?limit=60`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/findings?limit=60`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/plans`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/approvals?status=pending`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/sweeps?limit=8`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/schedule`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/scorecards?limit=40`, { cache: 'no-store' }),
      ])
      if (!c.ok) throw new Error(`charters: ${c.status}`)
      setCharters(((await c.json()) as { charters: CharterRow[] }).charters)
      if (g.ok) setGraph((await g.json()) as { nodes: GraphNode[]; edges: GraphEdge[] })
      if (s.ok) setFleetState((await s.json()) as FleetState)
      if (r.ok) setRuns(((await r.json()) as { runs: RunRow[] }).runs)
      if (f.ok) setFindings(((await f.json()) as { findings: FindingRow[] }).findings)
      if (p.ok) {
        const pj = (await p.json()) as { plans: PlanRow[]; labels?: PlanLabels }
        setPlans(pj.plans)
        setPlanLabels(pj.labels ?? { campaigns: {}, targets: {} })
      }
      if (a.ok) setApprovals(((await a.json()) as { approvals: ApprovalRow[] }).approvals)
      if (sw.ok) setSweeps(((await sw.json()) as { sweeps: SweepRow[] }).sweeps)
      if (sch.ok) setSchedule(((await sch.json()) as { jobs: ScheduleJob[] }).jobs)
      if (sc.ok) setScorecards(((await sc.json()) as { scorecards: ScorecardRow[] }).scorecards)
      setUpdatedAt(Date.now())
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

  // FX.8 — quiet refresh every 60s: the page stays honest without the
  // operator touching anything, and a run in flight shows up pulsing.
  useEffect(() => {
    const t = setInterval(() => void load({ silent: true }), 60_000)
    return () => clearInterval(t)
  }, [load])

  // FX.10 — the entity graph: overview, or one entity's neighbourhood.
  const loadEntityGraph = useCallback(
    async (focus?: { type: string; id: string }) => {
      setEntityLoading(true)
      try {
        // depth 1: the focused view draws direct relationships in lanes;
        // going deeper is a click away, and a two-hop dump is a smear.
        const qs = focus ? `?type=${encodeURIComponent(focus.type)}&id=${encodeURIComponent(focus.id)}&depth=1&limit=300` : ''
        const r = await fetch(`${backend}/api/agent/fleet/entity-graph${qs}`, {
          cache: 'no-store',
        })
        if (r.ok) setEntityGraph((await r.json()) as EntityGraphData)
        else setErr(`entity graph: ${r.status}`)
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setEntityLoading(false)
      }
    },
    [backend],
  )

  useEffect(() => {
    if (mapView === 'entities' && !entityGraph && !entityLoading) void loadEntityGraph()
  }, [mapView, entityGraph, entityLoading, loadEntityGraph])

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

  const nameByKey = useMemo(() => new Map(charters.map((c) => [c.key, c.name])), [charters])

  // FX.5 — per-node "last run" info + running pulse, from the loaded runs.
  const runInfoByKey = useMemo(() => {
    const m = new Map<string, NodeRunInfo>()
    for (const r of runs) {
      const existing = m.get(r.agentKey)
      const running = r.status === 'running'
      if (!existing) {
        m.set(r.agentKey, {
          at: r.createdAt,
          ok: r.ok,
          findings: r.findingCount,
          running,
        })
      } else if (running) {
        existing.running = true
      }
    }
    return m
  }, [runs])

  // FX.5 — artifact counts on the edges: findings per source worker,
  // plans on the director→critic edge.
  const edgeCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of graph?.edges ?? []) {
      if (e.artifact === 'finding') {
        m.set(`${e.from}->${e.to}`, openFindingsByCharter.get(e.from) ?? 0)
      } else if (e.artifact === 'plan') {
        m.set(`${e.from}->${e.to}`, plans.length)
      }
    }
    return m
  }, [graph, openFindingsByCharter, plans])

  // FX.7 — daily spend bars from the loaded runs, honest about coverage.
  const dailyCost = useMemo(() => {
    const byDay = new Map<string, number>()
    for (const r of runs) {
      const day = new Date(r.createdAt).toISOString().slice(5, 10)
      byDay.set(day, (byDay.get(day) ?? 0) + Number(r.costUSD))
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, cost]) => ({ day, cost: Math.round(cost * 10_000) / 10_000 }))
  }, [runs])

  const lastSweepCost = sweeps[0]?.costUSD ?? null

  const latest14ByCharter = useMemo(() => {
    const m = new Map<string, ScorecardRow>()
    for (const s of scorecards) {
      if (s.windowDays !== 14) continue
      if (!m.has(s.charterKey)) m.set(s.charterKey, s)
    }
    return m
  }, [scorecards])

  // FX.7 — the auditor's nightly brief, when it exists, is the headline.
  const auditorBrief = useMemo(
    () => findings.find((f) => f.charterKey === 'fleet-auditor' && f.kind === 'fleet_brief'),
    [findings],
  )

  // FX.9 — the drill-down chips: each worker's open findings, for the map.
  const findingsByKey = useMemo(() => {
    const m = new Map<string, CanvasFinding[]>()
    for (const f of findings) {
      if (f.status !== 'open' || f.charterKey === 'fleet-selftest') continue
      m.set(f.charterKey, [
        ...(m.get(f.charterKey) ?? []),
        { id: f.id, kind: f.kind, entityId: f.entityId, severity: f.severity },
      ])
    }
    return m
  }, [findings])

  const nextOf = (key: string): string => {
    const j = schedule.find((x) => x.key === key)
    if (!j) return ''
    if (!j.enabled) return 'switched off'
    if (!j.nextFireAt) return 'not scheduled'
    const mins = Math.max(0, Math.round((new Date(j.nextFireAt).getTime() - Date.now()) / 60_000))
    const h = Math.floor(mins / 60)
    const d = Math.floor(h / 24)
    return d >= 1 ? `in ${d}d ${h % 24}h` : h >= 1 ? `in ${h}h ${mins % 60}m` : `in ${mins}m`
  }
  const pendingByCharter = useMemo(() => {
    const m = new Map<string, ApprovalRow[]>()
    for (const a of approvals) {
      const k = a.charterKey ?? 'unknown'
      m.set(k, [...(m.get(k) ?? []), a])
    }
    return m
  }, [approvals])

  if (loading && charters.length === 0) {
    return (
      <div className="acr-fleet" aria-busy="true" aria-label="Loading the fleet">
        <div className="acr-card acr-fl-skeleton" style={{ height: 360 }} />
        <div className="acr-card acr-fl-skeleton" style={{ height: 120 }} />
        <div className="acr-card acr-fl-skeleton" style={{ height: 120 }} />
      </div>
    )
  }

  return (
    <div className="acr-fleet">
      {err ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} /> {err}
          <button className="acr-btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      <FirstVisitIntro />

      {/* FX.7 — the auditor's brief is the headline when it exists */}
      {auditorBrief ? (
        <section className="acr-card acr-fl-brief-hero">
          <header className="acr-fl-head">
            <h3>This morning&apos;s brief</h3>
            <span className="acr-fl-sub">
              written by the <Term k="auditor">auditor</Term> · {ago(auditorBrief.createdAt)}
            </span>
          </header>
          <p className="acr-fl-brieftext">{auditorBrief.rationale}</p>
        </section>
      ) : null}

      {/* 1 — fleet map */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>
            <Bot size={15} /> {mapView === 'workers' ? 'Fleet map' : 'Entity graph'}
          </h3>
          <div className="acr-fl-headright">
            <div className="acr-eg-toggle" role="tablist" aria-label="Map view">
              <button
                role="tab"
                aria-selected={mapView === 'workers'}
                className={mapView === 'workers' ? 'on' : ''}
                onClick={() => setMapView('workers')}
              >
                Workers
              </button>
              <button
                role="tab"
                aria-selected={mapView === 'entities'}
                className={mapView === 'entities' ? 'on' : ''}
                onClick={() => setMapView('entities')}
              >
                Entity graph
              </button>
            </div>
            {fleetState?.halted ? (
              <Term k="running">
                <span className="acr-fl-pill acr-fl-pill-halt">
                  HALTED{fleetState.haltReason ? ` — ${fleetState.haltReason}` : ''}
                </span>
              </Term>
            ) : (
              <Term k="running">
                <span className="acr-fl-pill acr-fl-pill-ok">running</span>
              </Term>
            )}
            {updatedAt ? (
              <span className="acr-fl-sub">
                updated {Math.max(0, Math.round((Date.now() - updatedAt) / 1000))}s ago
              </span>
            ) : null}
            <button className="acr-btn" onClick={() => void load()} disabled={busy}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </header>
        {mapView === 'workers' ? (
          <p className="acr-fl-schedule">
            Next <Term k="sweep">sweep</Term> {nextOf('fleet-sweep')} · next{' '}
            <Term k="council">council</Term> {nextOf('fleet-council')} · spent {usd(costToday)} of
            the <Term k="ceiling">${fleetState?.dailyCeilingUSD?.toFixed(2) ?? '—'} daily ceiling</Term>{' '}
            · click a worker to see its full profile
          </p>
        ) : (
          <>
            <p className="acr-fl-schedule">
              {entityGraph?.focus ? (
                <>
                  Its direct relationships, grouped — click any card to explore that one next.{' '}
                  <button className="acr-eg-link" onClick={() => void loadEntityGraph()}>
                    ← back to the whole picture
                  </button>
                </>
              ) : (
                <>
                  Your campaigns and the relationships the fleet derived between them — click any
                  card to explore its neighbourhood, including the products behind it.
                </>
              )}
              {entityGraph?.truncated ? ' · view capped, showing the strongest links first' : ''}
            </p>
            <div className="acr-eg-legend">
              {Object.entries(entityGraph?.relationCounts ?? {}).map(([rel, n]) => (
                <span key={rel} className="acr-eg-legenditem" title={RELATION_META[rel]?.meaning}>
                  <span
                    className="acr-eg-swatch"
                    style={{ background: RELATION_META[rel]?.color ?? '#c3ccd8' }}
                    aria-hidden
                  />
                  {RELATION_META[rel]?.label ?? rel} · {n}
                </span>
              ))}
            </div>
          </>
        )}
        {mapView === 'entities' ? (
          entityLoading && !entityGraph ? (
            <div className="acr-fl-canvas acr-fl-skeleton" />
          ) : entityGraph && entityGraph.nodes.length > 0 ? (
            <EntityGraphCanvas
              data={entityGraph}
              onFocus={(type, id) => void loadEntityGraph({ type, id })}
            />
          ) : (
            <p className="acr-fl-empty">
              No relationships derived yet. The graph rebuilds every night with the{' '}
              <Term k="sweep">sweep</Term>.
            </p>
          )
        ) : graph ? (
          <FleetMapCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            nameByKey={nameByKey}
            openByKey={openFindingsByCharter}
            runInfoByKey={runInfoByKey}
            edgeCounts={edgeCounts}
            findingsByKey={findingsByKey}
            expanded={expandedWorker}
            onToggleExpand={(key) => setExpandedWorker(expandedWorker === key ? null : key)}
            onSelect={(key) => router.push(`/marketing/ads/rules-automation/fleet/worker/${key}`)}
          />
        ) : (
          <p className="acr-fl-empty">The graph endpoint returned nothing.</p>
        )}
      </section>


      {/* 3 — decision timeline */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Decision timeline</h3>
          <span className="acr-fl-sub">finding → plan → critic → approval</span>
        </header>
        {plans.length === 0 ? (
          <p className="acr-fl-empty">
            No plans yet. Plans appear when the <Term k="council">council</Term> runs — every
            Monday at 05:15 UTC, once the <Term k="director">director</Term> is enabled. Each one
            will show up here as a story: what the workers found, what the director chose, and
            what the <Term k="critic">critic</Term> ruled.
          </p>
        ) : (
          plans.slice(0, 5).map((p) => (
            <div key={p.id} id={`plan-${p.id}`} className="acr-fl-plan">
              <button
                className="acr-fl-planhead"
                onClick={() => setOpenPlan(openPlan === p.id ? null : p.id)}
              >
                {openPlan === p.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <strong>{p.headline}</strong>
                <span className={`acr-fl-pill verdict-${p.criticVerdict ?? 'none'}`}>
                  {p.criticVerdict === 'block'
                    ? 'blocked'
                    : p.criticVerdict === 'pass'
                      ? 'passed'
                      : (p.criticVerdict ?? 'awaiting review')}
                </span>
                <span className="acr-fl-sub">
                  {p.items.length} action{p.items.length === 1 ? '' : 's'} · {ago(p.createdAt)}
                </span>
              </button>
              {openPlan === p.id ? <PlanStory plan={p} labels={planLabels} /> : null}
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
              <DecisionCard
                key={a.id}
                approval={a}
                workerName={nameByKey.get(a.charterKey ?? '') ?? a.charterKey ?? 'A worker'}
                plans={plans}
                labels={planLabels}
                busy={busy}
                onDecide={(id, decision, reason) => void decide(id, decision, reason)}
                onOpenPlan={(planId) => {
                  setOpenPlan(planId)
                  document
                    .getElementById(`plan-${planId}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              />
            ))}
          </div>
        ))}
        {approvals.length === 0 ? (
          <p className="acr-fl-empty">
            Nothing is waiting for you. <Term k="approval">Approvals</Term> appear here when a
            plan passes the <Term k="critic">critic</Term> — and every yes or no you give
            becomes <Term k="exemplar">precedent</Term> the workers read on their next run.
          </p>
        ) : null}
      </section>

      {/* 5 — money & report cards (FX.7) */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>What it costs</h3>
          <span className="acr-fl-sub">
            today {usd(costToday)} of the{' '}
            <Term k="ceiling">${fleetState?.dailyCeilingUSD?.toFixed(2) ?? '—'} daily ceiling</Term>
            {lastSweepCost != null ? ` · a full night's sweep ≈ ${Math.round(lastSweepCost * 100)}¢` : ''}
          </span>
        </header>
        {dailyCost.length > 1 ? (
          <div className="acr-fl-chart">
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={dailyCost} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#8d97a6' }} tickLine={false} axisLine={{ stroke: '#dfe5ec' }} />
                <YAxis tick={{ fontSize: 10, fill: '#8d97a6' }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
                <RechartsTooltip formatter={(v) => [`$${Number(v ?? 0).toFixed(4)}`, 'spend']} labelStyle={{ fontSize: 12 }} contentStyle={{ fontSize: 12, borderRadius: 7, border: '1px solid #dfe5ec' }} />
                {fleetState ? (
                  <ReferenceLine y={Number(fleetState.dailyCeilingUSD)} stroke="#d4453f" strokeDasharray="4 3" label={{ value: 'ceiling', fontSize: 10, fill: '#9c2f2a', position: 'insideTopRight' }} />
                ) : null}
                <Bar dataKey="cost" fill="#7fb0ea" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : null}
        <table className="acr-fl-table">
          <thead>
            <tr>
              <th>Worker</th>
              <th>7d cost</th>
              <th><Term k="grade">Grade</Term></th>
              <th><Term k="shadow-agreement">Agrees with engines</Term></th>
              <th>Trust</th>
            </tr>
          </thead>
          <tbody>
            {charters.map((c) => {
              const card = latest14ByCharter.get(c.key)
              return (
                <tr key={c.key}>
                  <td>{c.name}</td>
                  <td>{usd(cost7dByCharter.get(c.key) ?? 0)}</td>
                  <td>{card?.grade ?? '—'}</td>
                  <td>
                    {card?.shadowAgreement == null
                      ? 'unknown'
                      : `${Math.round(Number(card.shadowAgreement) * 100)}%`}
                  </td>
                  <td>
                    {card?.promotionEligible
                      ? 'earned the next rung'
                      : c.autonomyLevel === 'OFF'
                        ? 'switched off'
                        : 'earning it'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="acr-fl-sub">
          Report cards recompute every night; costs here cover the {runs.length} most recent runs
          and reconcile against the sweep report. A grade of “—” means no nights on the books yet.
        </p>
      </section>

      {/* 6 — brief */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Brief</h3>
        </header>
        {sweeps.length === 0 ? (
          <p className="acr-fl-empty">
            No <Term k="sweep">sweeps</Term> recorded yet. The nightly sweep runs at 04:45 UTC —
            rows appear here after the first night with enabled workers.
          </p>
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
          The <Term k="auditor">auditor</Term>&apos;s nightly narrative appears here once it is
          enabled — until then this panel reports sweeps, not stories.
        </p>
      </section>

      {/* 7 — how it all works (FX.4) */}
      <HowItWorks />
    </div>
  )
}
