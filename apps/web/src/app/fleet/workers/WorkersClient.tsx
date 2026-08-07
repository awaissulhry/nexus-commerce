'use client'

/**
 * NAF.SB.4 — the worker registry.
 *
 * Every agent control plane researched for docs/2026-08-07-naf-sb-fleet-pages.md
 * (Microsoft Agent 365, ServiceNow AI Control Tower, LangSmith, CrewAI AMP) is
 * built around one row per agent — owner, permissions, lifecycle state — and
 * everything else hangs off that row. We had worker DETAIL pages and no roster,
 * which is fine at six workers and impossible at the twenty-five the roster in
 * docs/AGENT_FLEET.md Part 6 plans for.
 *
 * The fleet map answers "how do they connect". This answers "what do I have,
 * and which one needs me" — sortable, filterable, comparable down a column.
 *
 * Reads only endpoints that already exist, so this page adds no API surface
 * while a parallel session owns agent-fleet.routes.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Bot, RefreshCw, ShieldAlert, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { GLOSSARY, Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'

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
  scopeMarketplaces?: string[]
  pausedUntil?: string | null
}
interface RunRow {
  id: string
  agentKey: string
  status: string
  ok: boolean
  mode: string | null
  costUSD: string | number
  findingCount: number
  createdAt: string
  errorMessage?: string | null
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
  lastRun: RunRow | null
  runs7d: number
  failures7d: number
  cost7d: number
  openFindings: number
  grade: string | null
  promotionEligible: boolean
}

type SortKey = 'name' | 'tier' | 'autonomy' | 'lastRun' | 'findings' | 'cost' | 'grade'

const TIER_ORDER: Record<string, number> = {
  analyst: 0, director: 1, critic: 2, strategist: 3, auditor: 4,
}
const LEVEL_ORDER: Record<string, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }
const DAY = 24 * 3600 * 1000

function ago(iso: string | undefined | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

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
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'tier', dir: 'asc',
  })

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
      // Scorecards arrive newest-first; the first match is the current window.
      const card = scorecards.find((s) => s.charterKey === charter.key)
      return {
        charter,
        lastRun: mine[0] ?? null,
        runs7d: recent.length,
        failures7d: recent.filter((r) => !r.ok).length,
        cost7d: recent.reduce((sum, r) => sum + Number(r.costUSD || 0), 0),
        openFindings: findings.filter((f) => f.charterKey === charter.key).length,
        grade: card?.grade ?? null,
        promotionEligible: card?.promotionEligible ?? false,
      }
    })
  }, [charters, runs, findings, scorecards])

  const tierCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.charter.tier, (m.get(r.charter.tier) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => (TIER_ORDER[a[0]] ?? 9) - (TIER_ORDER[b[0]] ?? 9))
  }, [rows])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const filtered = rows.filter((r) => {
      if (tierFilter && r.charter.tier !== tierFilter) return false
      if (!needle) return true
      return (
        r.charter.name.toLowerCase().includes(needle) ||
        r.charter.key.toLowerCase().includes(needle) ||
        (r.charter.description ?? '').toLowerCase().includes(needle)
      )
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'name': return dir * a.charter.name.localeCompare(b.charter.name)
        case 'autonomy':
          return dir * ((LEVEL_ORDER[a.charter.autonomyLevel] ?? 0) - (LEVEL_ORDER[b.charter.autonomyLevel] ?? 0))
        case 'lastRun':
          return dir * ((a.lastRun ? new Date(a.lastRun.createdAt).getTime() : 0) -
            (b.lastRun ? new Date(b.lastRun.createdAt).getTime() : 0))
        case 'findings': return dir * (a.openFindings - b.openFindings)
        case 'cost': return dir * (a.cost7d - b.cost7d)
        case 'grade': return dir * ((a.grade ?? 'ZZ').localeCompare(b.grade ?? 'ZZ'))
        case 'tier':
        default: {
          const t = (TIER_ORDER[a.charter.tier] ?? 9) - (TIER_ORDER[b.charter.tier] ?? 9)
          return dir * (t !== 0 ? t : a.charter.name.localeCompare(b.charter.name))
        }
      }
    })
  }, [rows, q, tierFilter, sort])

  const totals = useMemo(() => ({
    workers: rows.length,
    running: rows.filter((r) => r.charter.enabled && r.charter.autonomyLevel !== 'OFF').length,
    openFindings: rows.reduce((s, r) => s + r.openFindings, 0),
    cost7d: rows.reduce((s, r) => s + r.cost7d, 0),
    degraded: rows.filter((r) => r.charter.degraded).length,
  }), [rows])

  const th = (key: SortKey, label: React.ReactNode, numeric = false) => (
    <th className={numeric ? 'num' : undefined} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className="acr-pg-sortbtn"
        onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))}
      >
        {label}
        {sort.key === key ? <span className="caret" aria-hidden>{sort.dir === 'asc' ? '▲' : '▼'}</span> : null}
      </button>
    </th>
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
          <span className="sub">{tierCounts.map(([t, n]) => `${n} ${t}`).join(' · ') || '—'}</span>
        </div>
        <div className="acr-pg-stat">
          <span className="k">Switched on</span>
          <span className="v">{totals.running}</span>
          <span className="sub">
            {totals.running === 0 ? 'the whole fleet is off' : `of ${totals.workers}`}
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

      <div className="acr-pg-toolbar">
        <input
          className="acr-pg-search"
          type="search"
          aria-label="Search workers by name, key or description"
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

      {totals.degraded > 0 ? (
        <div className="acr-banner warn" role="status">
          <AlertTriangle size={15} />
          {totals.degraded} worker{totals.degraded === 1 ? '' : 's'} could not have their settings
          read from the database. The values below are the fail-safe posture, not your choices.
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="acr-pg-empty">
          <strong>{loading ? 'Loading the roster…' : 'No worker matches that.'}</strong>
          {loading
            ? 'Reading charters, runs, findings and report cards.'
            : 'Clear the search or the tier filter to see the whole fleet.'}
        </div>
      ) : (
        <div className="acr-pg-tablewrap">
          <table className="acr-pg-tbl">
            <thead>
              <tr>
                {th('name', 'Worker')}
                {th('tier', 'Job')}
                {th('autonomy', 'What it may do')}
                {th('lastRun', 'Last run')}
                {th('findings', 'Open findings', true)}
                {th('cost', 'Cost 7d', true)}
                {th('grade', 'Report card')}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const c = r.charter
                const lvl = c.autonomyLevel.toLowerCase()
                return (
                  <tr key={c.key}>
                    <td>
                      <div className="acr-pg-who">
                        <span className="acr-pg-avatar" aria-hidden><Bot size={15} /></span>
                        <span>
                          <Link className="nm" href={`/fleet/workers/${c.key}`}>
                            {c.name}
                          </Link>
                          <span className="ky">{c.key}</span>
                        </span>
                      </div>
                    </td>
                    <td>
                      {TIER_TERM[c.tier]
                        ? <Term k={TIER_TERM[c.tier]!}>{c.tier}</Term>
                        : c.tier}
                      {c.domain ? <span className="acr-pg-muted"> · {c.domain}</span> : null}
                    </td>
                    <td>
                      <span className="acr-pg-dial">
                        <span className={`acr-pg-lvl ${lvl}`}>
                          {LEVEL_TERM[c.autonomyLevel]
                            ? <Term k={LEVEL_TERM[c.autonomyLevel]!}>{c.autonomyLevel}</Term>
                            : c.autonomyLevel}
                        </span>
                        {c.autonomyCap !== c.autonomyLevel ? (
                          <span className="acr-pg-capnote">
                            <Term k="cap">ceiling</Term> {c.autonomyCap}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      {r.lastRun ? (
                        <>
                          {ago(r.lastRun.createdAt)}
                          {/* The separator lives OUTSIDE the chip: acr-pg-warn is
                              inline-flex, which eats leading whitespace. */}
                          {r.failures7d > 0 ? (
                            <>
                              {' · '}
                              <span className="acr-pg-warn">{r.failures7d} failed</span>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <span className="acr-pg-muted">never run</span>
                      )}
                    </td>
                    <td className="num">
                      {r.openFindings > 0 ? r.openFindings : <span className="acr-pg-muted">—</span>}
                    </td>
                    <td className="num">
                      {r.cost7d > 0 ? `$${r.cost7d.toFixed(4)}` : <span className="acr-pg-muted">$0</span>}
                    </td>
                    <td>
                      <span className={`acr-pg-grade g-${r.grade ?? 'none'}`} title={r.grade ? `Grade ${r.grade}` : 'Not graded yet'}>
                        {r.grade ?? '–'}
                      </span>
                      {r.promotionEligible ? (
                        <span className="acr-pg-muted"> · may be promoted</span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
