'use client'

/**
 * NAF.SB.W — the worker registry.
 *
 * Every agent control plane researched for docs/2026-08-07-naf-sbw-workers-page.md
 * (Microsoft Agent 365, LangGraph assistants, UiPath Orchestrator, Temporal worker
 * deployments, ServiceNow AI Control Tower, Agentforce, CrewAI AMP) is built
 * around one row per agent, and everything else hangs off that row. The fleet map
 * answers "how do they connect"; this answers "what do I have, is it healthy, and
 * which one needs me" — comparable down a column, which is the one thing a graph
 * cannot do at twenty-five workers.
 *
 * W.1 is the honest-status pass. What changed and why:
 *
 * · A STATUS column, which did not exist. Six workers all reading "OFF" is true
 *   and useless; six words with a mandatory reason line under each is the same
 *   data made answerable. The derivation lives in _shared/run-health.ts so the
 *   roster, Activity and the worker's own page cannot disagree about whether
 *   something is broken.
 *
 * · Failure classes are never flattened. Of 26 not-ok runs in production, 21
 *   could not reach the provider, 3 were refused for credit, 1 broke its output
 *   contract and 1 was stopped by its token limit — and that last one is a limit
 *   working exactly as designed. "1 failed" for all four teaches an operator to
 *   distrust a working safety limit.
 *
 * · "Not set up" is now visible. fleet-auditor has no charter row and resolved
 *   identically to a worker deliberately switched off. The API's new
 *   `provisioned` flag is what makes the two distinguishable at all.
 *
 * · The table is the shared DS DataGrid, per the operator's standing rule. The
 *   in-repo objection to it (GuardrailGrid: "the DS stylesheets carry .dark
 *   rules") does not survive inspection — tokens.css has one .dark block that
 *   swaps custom properties and the other three sheets have none, so the light
 *   pin now on .fleet-surface is sufficient. Study 0 has the measurement.
 *
 * Reads only endpoints that already exist, so this page still adds no API
 * surface while a parallel session owns agent-fleet.routes.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Bot, RefreshCw, ShieldAlert, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { GLOSSARY, Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { DataGrid, type Column } from '@/design-system/components'
import { GridToolbar } from '@/design-system/patterns'
import {
  ago,
  classifyFailure,
  deriveStatus,
  DIAGNOSTIC_HINT,
  isDiagnostic,
  type RunLike,
  type WorkerStatus,
} from '../_shared/run-health'

/** Design contract rule 3: jargon without a glossary entry fails review. These
 *  maps are the narrowing — a tier or dial we have no definition for renders as
 *  plain text rather than a tooltip that would explain nothing. `analyst` maps
 *  to `worker` deliberately: an analyst IS the thing the glossary calls a
 *  worker, and inventing a second definition for it would be the drift the
 *  one-definition rule exists to prevent. */
type TermKey = keyof typeof GLOSSARY & string
const TIER_TERM: Record<string, TermKey> = {
  analyst: 'worker', director: 'director', critic: 'critic', auditor: 'auditor',
}
const LEVEL_TERM: Record<string, TermKey> = {
  OFF: 'off', OBSERVE: 'observe', PROPOSE: 'propose', AUTO: 'auto',
}

/* ── shapes, mirrored from the fleet API ───────────────────────────────── */

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
  /** SB.W.1 — false = no settings row exists. Optional so the page degrades
   *  gracefully to "Off" if it is deployed ahead of the API. */
  provisioned?: boolean | null
  scopeMarketplaces?: string[]
  scopeCampaignIds?: string[]
  pausedUntil?: string | null
  pausedReason?: string | null
}
interface RunRow extends RunLike {
  id: string
  agentKey: string
  mode: string | null
  costUSD: string | number
  findingCount: number
}
interface FindingRow {
  id: string
  charterKey: string
  status: string
}
interface ScorecardRow {
  charterKey: string
  grade: string | null
  promotionEligible: boolean
  acceptanceRate: string | number | null
  periodEnd: string
}

/** One assembled roster row — everything the table shows about a worker. */
interface WorkerRow {
  charter: CharterRow
  status: WorkerStatus
  diagnostic: boolean
  lastRun: RunRow | null
  runs7d: number
  failures7d: number
  cost7d: number
  openFindings: number
  grade: string | null
  promotionEligible: boolean
}

const TIER_ORDER: Record<string, number> = {
  analyst: 0, director: 1, critic: 2, strategist: 3, auditor: 4,
}
const LEVEL_ORDER: Record<string, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }
/** Sort order for the status column: what needs you, first. */
const STATUS_ORDER: Record<string, number> = {
  attention: 0, 'not-set-up': 1, paused: 2, running: 3, working: 4, off: 5,
}
const DAY = 24 * 3600 * 1000

/* ── the page ──────────────────────────────────────────────────────────── */

export function WorkersClient() {
  const backend = getBackendUrl()
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [scorecards, setScorecards] = useState<ScorecardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [tierFilter, setTierFilter] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // `runs` is capped at 100 server-side (Math.min(limit, 100)) and is NOT
      // per-worker — it is the newest 100 runs across the whole fleet. At 47
      // lifetime fleet runs every worker's history is fully covered; once the
      // fleet is lit and runs nightly, "last run" for a quiet worker would fall
      // off the end. The fix is a per-charter aggregate endpoint, which belongs
      // in the API the parallel session currently owns — until then this is
      // exact, and this comment is here so it is noticed before it is not.
      const [c, r, f, s] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/runs?limit=100`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/findings?status=open&limit=200`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/scorecards?limit=200`, { cache: 'no-store' }),
      ])
      if (!c.ok) throw new Error(`charters: ${c.status}`)
      setCharters(((await c.json()) as { charters: CharterRow[] }).charters)
      if (r.ok) setRuns(((await r.json()) as { runs: RunRow[] }).runs)
      if (f.ok) setFindings(((await f.json()) as { findings: FindingRow[] }).findings)
      if (s.ok) setScorecards(((await s.json()) as { scorecards: ScorecardRow[] }).scorecards)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [backend])

  useEffect(() => { void load() }, [load])

  /* assemble one row per worker from the four feeds */
  const rows: WorkerRow[] = useMemo(() => {
    const since = Date.now() - 7 * DAY
    return charters.map((charter) => {
      const mine = runs.filter((r) => r.agentKey === charter.key)
      const recent = mine.filter((r) => new Date(r.createdAt).getTime() >= since)
      const lastRun = mine[0] ?? null
      // Scorecards arrive newest-first; the first match is the current window.
      const card = scorecards.find((s) => s.charterKey === charter.key)
      return {
        charter,
        status: deriveStatus(charter, lastRun),
        diagnostic: isDiagnostic(charter),
        lastRun,
        runs7d: recent.length,
        failures7d: recent.filter((r) => !r.ok).length,
        cost7d: recent.reduce((sum, r) => sum + Number(r.costUSD || 0), 0),
        openFindings: findings.filter((f) => f.charterKey === charter.key).length,
        grade: card?.grade ?? null,
        promotionEligible: card?.promotionEligible ?? false,
      }
    })
  }, [charters, runs, findings, scorecards])

  /** Chip counts filter the WHOLE table, so they count every row. The strip's
   *  breakdown counts business workers only, to match the number above it —
   *  a "5 workers" headline over a breakdown summing to 7 is the kind of small
   *  inconsistency that costs a page its credibility. */
  const tierCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.charter.tier, (m.get(r.charter.tier) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => (TIER_ORDER[a[0]] ?? 9) - (TIER_ORDER[b[0]] ?? 9))
  }, [rows])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (tierFilter && r.charter.tier !== tierFilter) return false
      if (!needle) return true
      return (
        r.charter.name.toLowerCase().includes(needle) ||
        r.charter.key.toLowerCase().includes(needle) ||
        r.charter.domain.toLowerCase().includes(needle) ||
        (r.charter.description ?? '').toLowerCase().includes(needle)
      )
    })
  }, [rows, q, tierFilter])

  /* Headline numbers are BUSINESS workers only — fleet-selftest holds 47 of 64
     open findings and 38 of 47 runs, so counting it in makes every figure on
     this page mostly about a self-test. Its contribution is footnoted below the
     strip rather than hidden: excluded, never concealed. (Operator decision
     2026-08-07.) */
  const business = useMemo(() => rows.filter((r) => !r.diagnostic), [rows])
  const diagnostics = useMemo(() => rows.filter((r) => r.diagnostic), [rows])

  const businessTiers = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of business) m.set(r.charter.tier, (m.get(r.charter.tier) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => (TIER_ORDER[a[0]] ?? 9) - (TIER_ORDER[b[0]] ?? 9))
  }, [business])

  const totals = useMemo(() => ({
    workers: business.length,
    // A paused worker is not "switched on", whatever its dial says. The API
    // already resolves a live pause to enabled:false; this agrees with it
    // rather than trusting one of the two fields.
    running: business.filter((r) => r.status.word !== 'paused'
      && r.charter.enabled && r.charter.autonomyLevel !== 'OFF').length,
    attention: business.filter((r) => r.status.needsAttention).length,
    openFindings: business.reduce((s, r) => s + r.openFindings, 0),
    cost7d: business.reduce((s, r) => s + r.cost7d, 0),
    degraded: rows.filter((r) => r.charter.degraded).length,
    unprovisioned: rows.filter((r) => r.charter.provisioned === false).length,
  }), [business, rows])

  const diagTotals = useMemo(() => ({
    findings: diagnostics.reduce((s, r) => s + r.openFindings, 0),
    cost7d: diagnostics.reduce((s, r) => s + r.cost7d, 0),
  }), [diagnostics])

  /* ── columns ─────────────────────────────────────────────────────────── */

  const columns: Array<Column<WorkerRow>> = useMemo(() => [
    {
      key: 'worker',
      label: <Term k="worker">Worker</Term>,
      sortable: true,
      sortValue: (r) => r.charter.name.toLowerCase(),
      width: 240,
      render: (r) => (
        <div className="sbw-who">
          <span className="sbw-avatar" aria-hidden><Bot size={14} /></span>
          <span className="txt">
            <Link className="nm" href={`/fleet/workers/${r.charter.key}`}>
              {r.charter.name}
            </Link>
            {r.diagnostic ? (
              <span className="sbw-diag" title={DIAGNOSTIC_HINT}>diagnostic</span>
            ) : null}
            <span className="ky">{r.charter.key}</span>
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      width: 330,
      label: 'Status',
      sortable: true,
      sortValue: (r) => STATUS_ORDER[r.status.word] ?? 9,
      render: (r) => (
        <div className="sbw-status">
          <span
            className={`sbw-badge ${r.status.tone}${r.status.word === 'not-set-up' ? ' outline' : ''}`}
          >
            <span className="dot" aria-hidden />
            {r.status.label}
          </span>
          <span
            className={`sbw-reason${r.status.tone === 'bad' ? ' bad' : r.status.tone === 'warn' ? ' warn' : ''}`}
          >
            {r.status.reason}
          </span>
        </div>
      ),
    },
    {
      key: 'job',
      width: 112,
      label: 'Job',
      sortable: true,
      sortValue: (r) => `${TIER_ORDER[r.charter.tier] ?? 9}${r.charter.name}`,
      render: (r) => (
        <>
          {TIER_TERM[r.charter.tier]
            ? <Term k={TIER_TERM[r.charter.tier]!}>{r.charter.tier}</Term>
            : r.charter.tier}
          {r.charter.domain ? <div className="sbw-note">{r.charter.domain}</div> : null}
        </>
      ),
    },
    {
      key: 'autonomy',
      width: 132,
      label: 'What it may do',
      sortable: true,
      sortValue: (r) => LEVEL_ORDER[r.charter.autonomyLevel] ?? 0,
      render: (r) => (
        <>
          <span className={`acr-pg-lvl ${r.charter.autonomyLevel.toLowerCase()}`}>
            {LEVEL_TERM[r.charter.autonomyLevel]
              ? <Term k={LEVEL_TERM[r.charter.autonomyLevel]!}>{r.charter.autonomyLevel}</Term>
              : r.charter.autonomyLevel}
          </span>
          {r.charter.autonomyCap !== r.charter.autonomyLevel ? (
            <div className="sbw-note">
              <Term k="cap">ceiling</Term> {r.charter.autonomyCap}
            </div>
          ) : null}
        </>
      ),
    },
    {
      key: 'scope',
      width: 136,
      label: 'Scope',
      sortable: true,
      // Scoped workers first: an explicit scope is the safer state, and sorting
      // brings the unbounded ones to the other end where they can be seen.
      sortValue: (r) => (r.charter.scopeMarketplaces?.length ? 0 : 1),
      render: (r) => {
        const mk = r.charter.scopeMarketplaces ?? []
        const camps = r.charter.scopeCampaignIds?.length ?? 0
        const live = r.charter.enabled && r.charter.autonomyLevel !== 'OFF'
        if (mk.length === 0 && camps === 0) {
          return (
            <span
              className={`sbw-scope${live ? ' wide' : ''}`}
              title={
                live
                  ? 'No limit set — this worker may look at every marketplace and every campaign.'
                  : 'No limit set. It is switched off, so nothing is looking at anything yet.'
              }
            >
              Everything
            </span>
          )
        }
        return (
          <span className="sbw-scope">
            {mk.map((m) => <span key={m} className="mk">{m}</span>)}
            {camps > 0 ? <span className="sbw-note">{camps} campaign{camps === 1 ? '' : 's'}</span> : null}
          </span>
        )
      },
    },
    {
      key: 'lastRun',
      width: 112,
      label: 'Last run',
      sortable: true,
      sortValue: (r) => (r.lastRun ? new Date(r.lastRun.createdAt).getTime() : 0),
      render: (r) => {
        if (!r.lastRun) return <span className="sbw-dim">never run</span>
        const f = classifyFailure(r.lastRun)
        return (
          <>
            {ago(r.lastRun.createdAt)}
            {f ? (
              <div className={`sbw-note ${f.severe ? 'sbw-reason bad' : 'sbw-reason warn'}`}>
                {f.klass === 'limit' ? 'stopped by a limit' : 'did not finish'}
              </div>
            ) : null}
          </>
        )
      },
    },
    {
      key: 'findings',
      width: 96,
      label: <Term k="finding">Open findings</Term>,
      align: 'right',
      sortable: true,
      sortValue: (r) => r.openFindings,
      render: (r) => (r.openFindings > 0 ? r.openFindings : <span className="sbw-dim">—</span>),
    },
    {
      key: 'cost',
      width: 96,
      label: 'Cost 7d',
      align: 'right',
      sortable: true,
      sortValue: (r) => r.cost7d,
      render: (r) => (r.cost7d > 0
        ? `$${r.cost7d.toFixed(4)}`
        : <span className="sbw-dim">$0</span>),
    },
    {
      key: 'grade',
      width: 124,
      label: <Term k="grade">Report card</Term>,
      sortable: true,
      sortValue: (r) => r.grade ?? 'ZZ',
      render: (r) => (
        r.grade ? (
          <>
            <span className={`acr-pg-grade g-${r.grade}`}>{r.grade}</span>
            {r.promotionEligible ? <div className="sbw-note">may be promoted</div> : null}
          </>
        ) : (
          <span className="sbw-dim" title="Report cards are computed nightly. This one appears after its first night on the books.">
            not graded yet
          </span>
        )
      ),
    },
  ], [])

  /* ── teaching empty state ────────────────────────────────────────────── */

  const emptyState = loading ? (
    <div className="sbw-empty">
      <strong>Loading the roster…</strong>
      <span>Reading charters, runs, findings and report cards.</span>
    </div>
  ) : charters.length === 0 ? (
    <div className="sbw-empty">
      <strong>No workers are set up yet.</strong>
      <span>
        Seven workers exist in code. Each needs a settings row before it can be switched on —
        seeding the roster creates them, all switched off, changing nothing about what runs.
      </span>
    </div>
  ) : (
    <div className="sbw-empty">
      <strong>No worker matches that.</strong>
      <span>
        {[q.trim() ? `the search “${q.trim()}”` : null, tierFilter ? `the ${tierFilter} filter` : null]
          .filter(Boolean)
          .join(' and ')}
        {' '}is hiding all {rows.length} of them. Clear it to see the whole fleet.
      </span>
    </div>
  )

  return (
    <div className="acr-fleet">
      {err ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} /> {err}
          <button className="acr-btn" onClick={() => void load()}>Try again</button>
        </div>
      ) : null}

      <p className="acr-pg-intro">
        Every <Term k="worker">worker</Term> the fleet has, in one list. The fleet map shows how
        they connect; this shows what you have and which one needs you. Each worker is an AI
        analyst with one narrow job — none of them can change anything on Amazon by itself.
      </p>

      <div className="acr-pg-strip">
        <div className="acr-pg-stat">
          <span className="k">Workers</span>
          <span className="v">{totals.workers}</span>
          <span className="sub">{businessTiers.map(([t, n]) => `${n} ${t}`).join(' · ') || '—'}</span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Switched on</span>
          <span className="v">{totals.running}</span>
          <span className="sub">
            {totals.running === 0 ? 'the whole fleet is off' : `of ${totals.workers}`}
          </span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Needs attention</span>
          <span className="v">{totals.attention}</span>
          <span className="sub">
            {totals.attention === 0 ? 'nothing is asking for you' : 'see the status column'}
          </span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Open findings</span>
          <span className="v">{totals.openFindings}</span>
          <span className="sub">waiting to be used or to expire</span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Spent, last 7 days</span>
          <span className="v">${totals.cost7d.toFixed(4)}</span>
          <span className="sub">across every worker</span>
        </div>
      </div>

      {/* Excluded, never concealed. */}
      {diagnostics.length > 0 ? (
        <p className="sbw-note" style={{ margin: '-4px 0 12px' }}>
          Not counting {diagnostics.length === 1 ? 'one diagnostic worker' : `${diagnostics.length} diagnostic workers`}
          {' '}({diagnostics.map((d) => d.charter.key).join(', ')}), which check the fleet itself rather
          than your account: {diagTotals.findings} more finding{diagTotals.findings === 1 ? '' : 's'}
          {diagTotals.cost7d > 0 ? `, $${diagTotals.cost7d.toFixed(4)}` : ''}.
        </p>
      ) : null}

      {totals.degraded > 0 ? (
        <div className="acr-banner warn" role="status">
          <AlertTriangle size={15} />
          {totals.degraded} worker{totals.degraded === 1 ? '' : 's'} could not have their settings
          read from the database. The values below are the fail-safe posture, not your choices.
        </div>
      ) : null}

      {totals.unprovisioned > 0 ? (
        <div className="acr-banner warn" role="status">
          <AlertTriangle size={15} />
          {totals.unprovisioned} worker{totals.unprovisioned === 1 ? ' exists' : 's exist'} in code
          with no settings row, so {totals.unprovisioned === 1 ? 'it has' : 'they have'} never been
          set up and cannot be switched on. Seeding creates the missing rows switched off, which
          changes nothing about what runs.
        </div>
      ) : null}

      <div className="acr-pg-toolbar">
        <input
          className="acr-pg-search"
          type="search"
          aria-label="Search workers by name, key, domain or description"
          placeholder="Search workers…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="acr-pg-chips" role="group" aria-label="Filter by tier">
          <button
            type="button"
            className={`acr-pg-chip ${tierFilter === null ? 'on' : ''}`}
            onClick={() => setTierFilter(null)}
          >
            All <span className="n">{rows.length}</span>
          </button>
          {tierCounts.map(([tier, n]) => (
            <button
              key={tier}
              type="button"
              className={`acr-pg-chip ${tierFilter === tier ? 'on' : ''}`}
              onClick={() => setTierFilter(tierFilter === tier ? null : tier)}
            >
              {tier} <span className="n">{n}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="acr-btn" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="h10-ds-gridcard sbw-gridcard">
        <GridToolbar
          count={
            <>Showing <b>{visible.length}</b> of <b>{rows.length}</b> worker{rows.length === 1 ? '' : 's'}</>
          }
        />
        <DataGrid<WorkerRow>
          columns={columns}
          rows={visible}
          rowKey={(r) => r.charter.key}
          initialSort={{ key: 'status', dir: 'asc' }}
          emptyState={emptyState}
        />
      </div>
    </div>
  )
}
