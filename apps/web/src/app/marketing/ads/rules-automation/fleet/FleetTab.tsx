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
import { Bot, RefreshCw, ShieldAlert } from 'lucide-react'
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
import {
  ApprovalInbox,
  type ApprovalRow,
  type InboxCounts,
  type InboxView,
} from './ApprovalInbox'
import {
  EntityGraphCanvas,
  RELATION_META,
  type EntityGraphData,
} from './EntityGraphCanvas'
import { FleetMapCanvas, type CanvasFinding, type NodeRunInfo } from './FleetMapCanvas'
import { Term } from './glossary'
import { FirstVisitIntro, HowItWorks } from './HowItWorks'
import { type PlanLabels, type StoryPlan } from './PlanStory'
import { TimelineStream, type FleetTimelinePage } from './TimelineStream'

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
  // NAF.AP.2 — waiting / decided / expired, with counts for the tabs.
  const [inboxView, setInboxView] = useState<InboxView>('waiting')
  const [inboxCounts, setInboxCounts] = useState<InboxCounts>({ waiting: 0, decided: 0, expired: 0 })
  const [inboxLoading, setInboxLoading] = useState(false)
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
  const [busy, setBusy] = useState(false)
  // NAF.DT — the decision timeline's own feed, paged independently of the
  // rest of the page so "show older" never re-fetches the whole fleet.
  const [timeline, setTimeline] = useState<FleetTimelinePage | null>(null)
  const [timelineMore, setTimelineMore] = useState(false)

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true)
    try {
      const [c, g, s, r, f, p, a, sw, sch, sc, tl] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/graph`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/state`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/runs?limit=60`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/findings?limit=60`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/plans`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/approvals?view=${inboxView}`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/sweeps?limit=8`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/schedule`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/scorecards?limit=40`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/timeline?limit=40`, { cache: 'no-store' }),
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
      if (a.ok) {
        const aj = (await a.json()) as { approvals: ApprovalRow[]; counts: InboxCounts }
        setApprovals(aj.approvals)
        setInboxCounts(aj.counts)
      }
      if (sw.ok) setSweeps(((await sw.json()) as { sweeps: SweepRow[] }).sweeps)
      if (sch.ok) setSchedule(((await sch.json()) as { jobs: ScheduleJob[] }).jobs)
      if (sc.ok) setScorecards(((await sc.json()) as { scorecards: ScorecardRow[] }).scorecards)
      if (tl.ok) setTimeline((await tl.json()) as FleetTimelinePage)
      setUpdatedAt(Date.now())
      setInboxLoading(false)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [backend, inboxView])

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

  // NAF.DT.2 — "show older" appends the next page. The totals come from the
  // freshest response, so the count stays right as history grows.
  const loadMoreTimeline = useCallback(async () => {
    if (!timeline?.nextCursor || timelineMore) return
    setTimelineMore(true)
    try {
      const r = await fetch(
        `${backend}/api/agent/fleet/timeline?limit=40&cursor=${encodeURIComponent(timeline.nextCursor)}`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`timeline: ${r.status}`)
      const next = (await r.json()) as FleetTimelinePage
      setTimeline({ ...next, events: [...timeline.events, ...next.events] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTimelineMore(false)
    }
  }, [backend, timeline, timelineMore])

  // NAF.AP.4 — the brake. `post` keeps these four handlers to one shape.
  const post = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true)
      try {
        const r = await fetch(`${backend}/api/agent/fleet/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const d = (await r.json().catch(() => null)) as
          | { error?: string; sentence?: string }
          | null
        if (!r.ok) setErr(d?.error ?? `${path}: ${r.status}`)
        return d
      } finally {
        setBusy(false)
      }
    },
    [backend],
  )

  const undoApproval = useCallback(
    async (id: string) => {
      await post(`approvals/${id}/undo`)
      await load()
    },
    [post, load],
  )

  // The window closed while this tab was open, so commit it now rather than
  // waiting up to 30s for the maintenance sweep to notice.
  const commitApproval = useCallback(
    async (id: string) => {
      await post(`approvals/${id}/commit`)
      await load()
    },
    [post, load],
  )

  const bulkPreview = useCallback(
    async (ids: string[], decision: 'approve' | 'reject') => {
      const d = await post('approvals/bulk-preview', { ids, decision })
      return d?.sentence ?? `This affects ${ids.length} actions.`
    },
    [post],
  )

  const bulkDecide = useCallback(
    async (ids: string[], decision: 'approve' | 'reject', reason?: string) => {
      await post('approvals/bulk-decide', { ids, decision, reason })
      await load()
    },
    [post, load],
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

  // NAF.DT — report-card columns render only when a report card exists.
  // Scorecards recompute nightly; until the first one lands, Grade / agreement
  // / trust are three columns of "—", and a column with no data is not a
  // column. They come back on their own the moment there is something in them.
  const haveScorecards = latest14ByCharter.size > 0

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


      {/* 3 — decision timeline (NAF.DT.1–DT.3): every event the fleet has
          produced, newest first, grouped by day and by episode. It used to
          list plans, and only one plan has ever existed. */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Decision timeline</h3>
          <span className="acr-fl-sub">
            everything the fleet has done — newest first
          </span>
        </header>
        <p className="acr-fl-schedule">
          Each line says who did it, what happened, and what set it off. A group of
          related events — one run and everything it produced, or a whole{' '}
          <Term k="council">council</Term> — collapses into a single card you can open.
        </p>
        <TimelineStream
          page={timeline}
          plans={plans}
          labels={planLabels}
          loading={loading}
          loadingMore={timelineMore}
          onLoadMore={() => void loadMoreTimeline()}
          focusPlanId={openPlan}
        />
      </section>

      {/* 4 — approval inbox */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>Approval inbox</h3>
          <span className="acr-fl-sub">
            {inboxCounts.waiting === 0
              ? 'nothing waiting for you'
              : `${inboxCounts.waiting} waiting for you`}
          </span>
        </header>
        <ApprovalInbox
          view={inboxView}
          counts={inboxCounts}
          approvals={approvals}
          plans={plans}
          nameByKey={nameByKey}
          busy={busy}
          loading={inboxLoading}
          onViewChange={(v) => {
            setInboxView(v)
            setInboxLoading(true)
          }}
          onDecide={(id, decision, reason) => void decide(id, decision, reason)}
          onRejectAll={(charterKey, reason) => void rejectAll(charterKey, reason)}
          onUndo={(id) => void undoApproval(id)}
          onCommit={(id) => void commitApproval(id)}
          onBulkPreview={bulkPreview}
          onBulkDecide={(ids, decision, reason) => void bulkDecide(ids, decision, reason)}
          onOpenPlan={(planId) => {
            setOpenPlan(planId)
            document
              .getElementById(`plan-${planId}`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
        />
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
              {haveScorecards ? (
                <>
                  <th><Term k="grade">Grade</Term></th>
                  <th><Term k="shadow-agreement">Agrees with engines</Term></th>
                  <th>Trust</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {charters.map((c) => {
              const card = latest14ByCharter.get(c.key)
              return (
                <tr key={c.key}>
                  <td>{c.name}</td>
                  <td>{usd(cost7dByCharter.get(c.key) ?? 0)}</td>
                  {haveScorecards ? (
                    <>
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
                    </>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="acr-fl-sub">
          Costs here cover the {runs.length} most recent runs and reconcile against the sweep
          report.{' '}
          {haveScorecards
            ? 'Report cards recompute every night.'
            : 'No report card exists yet, so grades and trust are not shown — they appear here after the first night a worker runs.'}
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
          There is no <Term k="auditor">auditor</Term> worker yet — the charter has not been
          built, so no nightly narrative can be written. Until one exists this panel reports
          sweeps, not stories.
        </p>
      </section>

      {/* 7 — how it all works (FX.4) */}
      <HowItWorks />
    </div>
  )
}
