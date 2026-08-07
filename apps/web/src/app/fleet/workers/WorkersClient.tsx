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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Ban, Bot, Check, Columns, Pause as PauseIcon, RefreshCw, ShieldAlert, X } from 'lucide-react'
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
import {
  applyAutonomy,
  applyPause,
  AutonomyDial,
  ConfirmAutonomy,
  isRaise,
  LEVELS,
  PauseDialog,
  RANK,
  type AffectedWorker,
  type Level,
} from '../_shared/autonomy'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'

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
/* The autonomy rungs no longer render here — the shared AutonomyDial owns them,
   and Controls keeps the glossary tooltips on its own copy where there is room
   for them. A rung in a table cell is 46px wide; a tooltip on it would be a
   tooltip nobody finds. */

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
  /** SB.W.1 — the charter says so itself; see isDiagnostic(). */
  diagnostic?: boolean
  scopeMarketplaces?: string[]
  scopeCampaignIds?: string[]
  pausedUntil?: string | null
  pausedReason?: string | null
  /* W.3 — optional columns, off by default. */
  version?: number
  modelFeature?: string
  modelProvider?: string
  modelName?: string
  activeRevisionNumber?: number
  cadence?: string | null
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
interface FleetStateRow {
  halted: boolean
  haltReason: string | null
  haltedBy: string | null
  haltedAt: string | null
  dailyCeilingUSD: number
  degraded: boolean
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

/**
 * W.2 — the slices the strip can put the operator into. `all`, `live` and
 * `attention` become the three named views in W.3; `eligible` is reachable
 * only from its tile, because "which workers have earned a promotion" is a
 * question you ask by noticing the number, not by browsing for it.
 */
type View = 'all' | 'live' | 'attention' | 'eligible'

const VIEW_LABEL: Record<Exclude<View, 'all'>, string> = {
  live: 'Switched on',
  attention: 'Needs attention',
  eligible: 'Earned a promotion',
}

/**
 * W.3 — the three views that get a named chip. `eligible` is deliberately not
 * among them: it is reachable from its tile, and a chip row is a place for
 * questions you ask every morning, not every question that can be asked.
 */
const NAMED_VIEWS: Array<{ v: View; label: string; hint: string }> = [
  { v: 'all', label: 'All', hint: 'Every worker the fleet has' },
  { v: 'live', label: 'Live', hint: 'Switched on and not paused — what is actually running' },
  { v: 'attention', label: 'Needs attention', hint: 'Never set up, unreadable, paused, failing, or on and never run' },
]

/**
 * The honest column list is longer than one screen, so the nine defaults are
 * on and the rest are opt-in — Agent 365's *Customize view*, in one popover.
 * Worker and Status cannot be turned off: a registry row without an identity or
 * a health state is not a registry row.
 */
const COLUMNS: Array<{ key: string; label: string; fixed?: true; on: boolean }> = [
  { key: 'worker', label: 'Worker', fixed: true, on: true },
  { key: 'status', label: 'Status', fixed: true, on: true },
  { key: 'job', label: 'Job', on: true },
  { key: 'autonomy', label: 'What it may do', on: true },
  { key: 'scope', label: 'Scope', on: true },
  { key: 'lastRun', label: 'Last run', on: true },
  { key: 'findings', label: 'Open findings', on: true },
  { key: 'cost', label: 'Cost 7d', on: true },
  { key: 'grade', label: 'Report card', on: true },
  { key: 'charter', label: 'Charter', on: false },
  { key: 'model', label: 'Model', on: false },
  { key: 'runsWhen', label: 'Runs when', on: false },
  { key: 'budget', label: 'Budget / day', on: false },
  { key: 'tokens', label: 'Tokens / run', on: false },
]
const COLS_KEY = 'nexus.fleet.workers.columns.v1'
const DEFAULT_COLS = COLUMNS.filter((c) => c.on).map((c) => c.key)

/* ── the page ──────────────────────────────────────────────────────────── */

export function WorkersClient() {
  const backend = getBackendUrl()
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [runs, setRuns] = useState<RunRow[]>([])
  const [findings, setFindings] = useState<FindingRow[]>([])
  const [scorecards, setScorecards] = useState<ScorecardRow[]>([])
  const [state, setState] = useState<FleetStateRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [tierFilter, setTierFilter] = useState<string | null>(null)
  /** W.2 — which slice of the roster is showing. Set by the strip tiles now,
   *  and by the named view chips in W.3; one piece of state so the two cannot
   *  end up disagreeing about what is on screen. */
  const [view, setView] = useState<View>('all')
  /** Which columns are on. Per browser, not per account: a per-account
   *  preference implies a settings surface this page does not have. */
  const [cols, setCols] = useState<string[]>(DEFAULT_COLS)
  const [colsOpen, setColsOpen] = useState(false)
  /** W.6 — what moved since the operator last looked. The table refreshes
   *  itself every 10s; a row changing state silently is how someone ends up
   *  acting on a screen that stopped being true a minute ago. */
  const [changes, setChanges] = useState<string[]>([])
  const seenStatus = useRef<Map<string, string> | null>(null)
  /* W.4 — acting on the roster. */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [pendingRaise, setPendingRaise] = useState<{ to: Level; workers: AffectedWorker[] } | null>(null)
  const [pendingPause, setPendingPause] = useState<AffectedWorker[] | null>(null)
  const [note, setNote] = useState<string | null>(null)

  /* Restore the view and the search from the URL, and the columns from this
     browser. Done with the History API rather than useSearchParams: the page is
     force-dynamic, this is a UI convenience rather than navigation, and
     replaceState neither re-renders the tree nor adds history entries the back
     button has to walk through. */
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const v = p.get('view')
    if (v === 'live' || v === 'attention' || v === 'eligible') setView(v)
    const query = p.get('q')
    if (query) setQ(query)
    const tier = p.get('tier')
    if (tier) setTierFilter(tier)
    try {
      const saved = localStorage.getItem(COLS_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as string[]
        // Intersect with the known set so a renamed column cannot resurrect,
        // and force the two that may never be hidden back on.
        const known = new Set(COLUMNS.map((c) => c.key))
        const next = parsed.filter((k) => known.has(k))
        for (const c of COLUMNS) if (c.fixed && !next.includes(c.key)) next.unshift(c.key)
        if (next.length) setCols(next)
      }
    } catch { /* a corrupt preference is not worth a broken page */ }
  }, [])

  /* Keep the URL in step, so a filtered roster can be linked and bookmarked. */
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    view === 'all' ? p.delete('view') : p.set('view', view)
    q.trim() ? p.set('q', q.trim()) : p.delete('q')
    tierFilter ? p.set('tier', tierFilter) : p.delete('tier')
    const qs = p.toString()
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname)
  }, [view, q, tierFilter])

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
      const [c, r, f, s, st] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/runs?limit=100`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/findings?status=open&limit=200`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/scorecards?limit=200`, { cache: 'no-store' }),
        // W.2 — the fleet halt and the daily ceiling. A roster that reports
        // healthy workers while the orchestrator is halted is telling half the
        // truth: nothing runs, whatever any dial says.
        fetch(`${backend}/api/agent/fleet/state`, { cache: 'no-store' }),
      ])
      if (!c.ok) throw new Error(`charters: ${c.status}`)
      setCharters(((await c.json()) as { charters: CharterRow[] }).charters)
      if (r.ok) setRuns(((await r.json()) as { runs: RunRow[] }).runs)
      if (f.ok) setFindings(((await f.json()) as { findings: FindingRow[] }).findings)
      if (s.ok) setScorecards(((await s.json()) as { scorecards: ScorecardRow[] }).scorecards)
      if (st.ok) setState((await st.json()) as FleetStateRow)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      // The poll hook's contract: `load` owns its error state and THROWS, so
      // the "as of" stamp stays at the last SUCCESSFUL read rather than
      // advancing on a failed attempt.
      throw e
    } finally {
      setLoading(false)
    }
  }, [backend])

  /**
   * W.6 — the shared visibility-gated poll (locks doc §5, extracted by the
   * Workflows stream). Refetch every 10s while the tab is visible, pause when
   * it is hidden, catch up on return.
   *
   * The guard matters as much as the poll. A refresh that lands while a
   * confirmation is open would change the "from" levels the operator is being
   * asked about, and one landing mid-write would race the write it is about to
   * contradict. Throwing is how this hook is told "we did not read" — it keeps
   * the previous stamp, which is the honest answer.
   */
  const pollable = useCallback(async () => {
    if (pendingRaise || pendingPause || busyKeys.size > 0) {
      throw new Error('skipped: a change is open')
    }
    await load()
  }, [load, pendingRaise, pendingPause, busyKeys])

  const { asOf, refresh } = useVisibilityPoll(pollable)


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
        // `!ok` alone counts the run that is still in flight: a run is created
        // ok:false and only flips true when it finishes, so a worker mid-run
        // reported "1 of 1 failed this week" while it was running perfectly
        // well. Same root cause as the Last-run label, caught in the same way.
        failures7d: recent.filter((r) => !r.ok && r.status !== 'running').length,
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
/* Name what moved, rather than letting rows re-sort under the cursor
     unannounced. Compared on the STATUS WORD, not the whole row: a cost
     ticking up by a hundredth of a cent is not news. */
  useEffect(() => {
    if (rows.length === 0) return
    const now = new Map(rows.map((r) => [r.charter.key, r.status.label]))
    const before = seenStatus.current
    seenStatus.current = now
    if (!before) return // first load is not a change
    const moved: string[] = []
    for (const [key, label] of now) {
      const was = before.get(key)
      if (was === undefined) moved.push(`${key} joined the roster`)
      else if (was !== label) moved.push(`${rows.find((r) => r.charter.key === key)?.charter.name ?? key} is now ${label}`)
    }
    for (const key of before.keys()) if (!now.has(key)) moved.push(`${key} left the roster`)
    if (moved.length) setChanges(moved)
  }, [rows])

  const tierCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.charter.tier, (m.get(r.charter.tier) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => (TIER_ORDER[a[0]] ?? 9) - (TIER_ORDER[b[0]] ?? 9))
  }, [rows])

  /** One predicate per view, used by BOTH the tile counts and the table, so a
   *  tile reading 3 above a table showing 4 cannot happen. */
  const matchesView = useCallback((r: WorkerRow, v: View): boolean => {
    switch (v) {
      case 'live':
        return r.status.word !== 'paused'
          && r.charter.enabled && r.charter.autonomyLevel !== 'OFF'
      case 'attention': return r.status.needsAttention
      case 'eligible': return r.promotionEligible
      case 'all':
      default: return true
    }
  }, [])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (!matchesView(r, view)) return false
      if (tierFilter && r.charter.tier !== tierFilter) return false
      if (!needle) return true
      return (
        r.charter.name.toLowerCase().includes(needle) ||
        r.charter.key.toLowerCase().includes(needle) ||
        r.charter.domain.toLowerCase().includes(needle) ||
        (r.charter.description ?? '').toLowerCase().includes(needle)
      )
    })
  }, [rows, q, tierFilter, view, matchesView])

  /* Headline numbers are BUSINESS workers only — fleet-selftest holds 47 of 64
     open findings and 38 of 47 runs, so counting it in makes every figure on
     this page mostly about a self-test. Its contribution is footnoted below the
     strip rather than hidden: excluded, never concealed. (Operator decision
     2026-08-07.) */
  const business = useMemo(() => rows.filter((r) => !r.diagnostic), [rows])
  const diagnostics = useMemo(() => rows.filter((r) => r.diagnostic), [rows])

  const allTiers = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.charter.tier, (m.get(r.charter.tier) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => (TIER_ORDER[a[0]] ?? 9) - (TIER_ORDER[b[0]] ?? 9))
  }, [rows])

  /**
   * Which population a number counts, and it is not the same answer for all of
   * them. Verifying W.2 in the browser made the distinction unavoidable: a tile
   * that says 3 and shows 4 rows when clicked is exactly the inconsistency this
   * page is supposed to be incapable of.
   *
   * The rule that came out of it, and it holds for every tile:
   *
   *   A tile that FILTERS counts workers over the WHOLE roster, and its number
   *   is the number of rows you get when you click it. A tile that does not
   *   filter may report a business-only figure.
   *
   * So health tiles (switched on, needs attention, earned a promotion) count
   * everything — an alarm that suppresses the diagnostic worker is a bad alarm,
   * and a broken self-test means the fleet's own health check is broken. The
   * VOLUME figures — findings and spend — stay business-only, because that is
   * where a self-test with 47 findings distorts rather than informs. The
   * footnote under the strip says which is which.
   */
  const totals = useMemo(() => ({
    // Filtering tiles — whole roster, equal to the rows the tile reveals.
    workers: rows.length,
    // A paused worker is not "switched on", whatever its dial says. The API
    // already resolves a live pause to enabled:false; this agrees with it
    // rather than trusting one of the two fields.
    running: rows.filter((r) => matchesView(r, 'live')).length,
    attention: rows.filter((r) => r.status.needsAttention).length,
    eligible: rows.filter((r) => r.promotionEligible).length,
    // Volume figures — business workers only.
    openFindings: business.reduce((s, r) => s + r.openFindings, 0),
    cost7d: business.reduce((s, r) => s + r.cost7d, 0),
    degraded: rows.filter((r) => r.charter.degraded).length,
    unprovisioned: rows.filter((r) => r.charter.provisioned === false).length,
  }), [business, rows, matchesView])

  const diagTotals = useMemo(() => ({
    findings: diagnostics.reduce((s, r) => s + r.openFindings, 0),
    cost7d: diagnostics.reduce((s, r) => s + r.cost7d, 0),
  }), [diagnostics])

  /** Today's spend, kept separate from the 7-day figure on purpose. The fleet
   *  ceiling is a DAILY one ($2.00 today), so showing a week's spend against it
   *  would invite the operator to read 18% of budget used when the real answer
   *  is a different number entirely. Both are shown, each against the period it
   *  belongs to. */
  const spentToday = useMemo(() => {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const since = midnight.getTime()
    // Business workers only, matching cost7d. Summing every run here while the
    // 7-day figure excluded the diagnostic produced "$0.0103 today" under
    // "$0.0094 this week" — a number that cannot be true, and the kind of thing
    // that costs a page all its credibility at a glance.
    const mine = new Set(business.map((r) => r.charter.key))
    return runs
      .filter((r) => mine.has(r.agentKey) && new Date(r.createdAt).getTime() >= since)
      .reduce((sum, r) => sum + Number(r.costUSD || 0), 0)
  }, [runs, business])

  /** "1 never set up · 2 cannot reach the AI" — the tile explains itself by
   *  tallying the same `tag` the rows carry. */
  const attentionTags = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) {
      if (r.status.needsAttention) m.set(r.status.tag, (m.get(r.status.tag) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  /** A tile is a button that filters. Clicking the active one clears it, so the
   *  strip is never a trap you can only leave via the toolbar. */
  const Tile = ({ v, k, value, sub, tone }: {
    v: View | null
    k: string
    value: React.ReactNode
    sub: React.ReactNode
    tone?: 'warn' | 'good'
  }) => {
    const active = v != null && view === v
    const Wrapper = v == null ? 'div' : 'button'
    return (
      <Wrapper
        className={`acr-pg-stat${v != null ? ' sbw-tile' : ''}${active ? ' on' : ''}${tone ? ` ${tone}` : ''}`}
        {...(v != null
          ? {
              type: 'button' as const,
              'aria-pressed': active,
              onClick: () => setView(active ? 'all' : v),
            }
          : {})}
      >
        <span className="k">{k}</span>
        <span className="v">{value}</span>
        <span className="sub">{sub}</span>
      </Wrapper>
    )
  }

  /* ── acting on workers ───────────────────────────────────────────────── */

  /**
   * A worker with no settings row cannot be changed — the PATCH 404s, because
   * there is nothing to update. Rather than let the operator select it and
   * collect a failure, the checkbox is disabled and says why.
   */
  const canAct = useCallback((r: WorkerRow) => r.charter.provisioned !== false, [])

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.charter.key) && canAct(r)),
    [rows, selected, canAct],
  )

  const report = useCallback((
    verb: string,
    res: { ok: string[]; failed: Array<{ key: string; error: string }> },
  ) => {
    if (res.failed.length === 0) {
      setNote(`${verb} ${res.ok.length} worker${res.ok.length === 1 ? '' : 's'}.`)
      setErr(null)
      return
    }
    // Partial success is reported as partial success. One request per worker
    // means the server can refuse one and accept another, and rounding that to
    // "done" or "failed" would be a lie either way.
    setNote(res.ok.length ? `${verb} ${res.ok.length} of ${res.ok.length + res.failed.length}.` : null)
    setErr(
      `${res.failed.length} refused — ` +
      res.failed.map((f) => `${f.key}: ${f.error}`).join(' · '),
    )
  }, [])

  const runAction = useCallback(async (
    keys: string[],
    verb: string,
    fn: () => Promise<{ ok: string[]; failed: Array<{ key: string; error: string }> }>,
  ) => {
    setBusyKeys(new Set(keys))
    setNote(null)
    try {
      report(verb, await fn())
      await load()
    } finally {
      setBusyKeys(new Set())
      setPendingRaise(null)
      setPendingPause(null)
    }
  }, [load, report])

  /** The safety rule, applied at the one place both a row click and a bulk
   *  action pass through: down is immediate, up asks first. */
  const requestLevel = useCallback((targets: WorkerRow[], to: Level) => {
    const changing = targets.filter((r) => r.charter.autonomyLevel !== to)
    if (changing.length === 0) return
    const raising = changing.filter((r) => isRaise(r.charter.autonomyLevel, to))
    if (raising.length === 0) {
      void runAction(changing.map((r) => r.charter.key), 'Switched down', () =>
        applyAutonomy(backend, changing.map((r) => r.charter.key), to))
      return
    }
    setPendingRaise({
      to,
      workers: changing.map((r) => ({
        key: r.charter.key,
        name: r.charter.name,
        from: r.charter.autonomyLevel,
        budgetUSD: Number(r.charter.dailyBudgetUSD ?? 0),
      })),
    })
  }, [backend, runAction])

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
      width: 178,
      label: 'What it may do',
      sortable: true,
      sortValue: (r) => LEVEL_ORDER[r.charter.autonomyLevel] ?? 0,
      render: (r) => (
        <>
          {/* W.4 — the same dial Controls renders, in `operate` mode. Changing
              it here and changing it there run the identical confirm, mutation
              and audit write. */}
          <AutonomyDial
            level={r.charter.autonomyLevel}
            cap={r.charter.autonomyCap}
            busy={busyKeys.has(r.charter.key)}
            disabled={!canAct(r)}
            label={`Autonomy for ${r.charter.name}`}
            onPick={(lvl) => requestLevel([r], lvl)}
          />
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
            {/* The week's record, not just the latest attempt. The old roster
                showed a bare "1 failed" here; replacing it with the last run's
                outcome alone would have quietly dropped the fact that a worker
                whose most recent run was fine failed three times before it.
                Phrased as a ratio because "1 failed" out of one run and out of
                forty are not the same worker. */}
            {r.failures7d > 0 && !f ? (
              <div className="sbw-note" title="Runs in the last 7 days that did not finish. Open Activity for what happened in each.">
                {r.failures7d} of {r.runs7d} failed this week
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

    /* ── W.3 · opt-in columns ─────────────────────────────────────────────
       Off by default because nine is what fits; on when the question they
       answer is the one being asked. */
    {
      key: 'charter',
      width: 130,
      label: <Term k="charter">Charter</Term>,
      sortable: true,
      sortValue: (r) => (r.charter.activeRevisionNumber ?? 0),
      render: (r) => (
        r.charter.activeRevisionNumber ? (
          <>
            <span className="sbw-editedchip" title="An operator-authored revision is in force. The code charter is still the fallback.">edited</span>
            <div className="sbw-note">revision {r.charter.activeRevisionNumber}</div>
          </>
        ) : (
          <span className="sbw-dim" title="Running the charter exactly as written in code.">
            code v{r.charter.version ?? 1}
          </span>
        )
      ),
    },
    {
      key: 'model',
      width: 150,
      label: 'Model',
      sortable: true,
      sortValue: (r) => r.charter.modelName ?? r.charter.modelFeature ?? '',
      render: (r) => (
        r.charter.modelName ? (
          <>
            {r.charter.modelName}
            <div className="sbw-note">pinned for this worker</div>
          </>
        ) : (
          <span className="sbw-dim" title="Inherits the model chosen for its tier.">
            {r.charter.modelFeature ?? '—'}
          </span>
        )
      ),
    },
    {
      key: 'runsWhen',
      width: 130,
      label: 'Runs when',
      sortable: true,
      sortValue: (r) => r.charter.cadence ?? 'zzz',
      render: (r) => (
        r.charter.cadence
          ? <code className="sbw-cadence">{r.charter.cadence}</code>
          : <span className="sbw-dim" title="It has no schedule of its own — it runs when a sweep or an operator starts it.">only when asked</span>
      ),
    },
    {
      key: 'budget',
      width: 110,
      label: 'Budget / day',
      align: 'right',
      sortable: true,
      sortValue: (r) => Number(r.charter.dailyBudgetUSD ?? 0),
      render: (r) => `$${Number(r.charter.dailyBudgetUSD ?? 0).toFixed(2)}`,
    },
    {
      key: 'tokens',
      width: 110,
      label: 'Tokens / run',
      align: 'right',
      sortable: true,
      sortValue: (r) => r.charter.maxTokensPerRun ?? 0,
      render: (r) => (r.charter.maxTokensPerRun ?? 0).toLocaleString(),
    },
  ], [busyKeys, canAct, requestLevel])

  /** Render in the operator's chosen order, and only what they chose. */
  const shownColumns = useMemo(
    () => cols.map((k) => columns.find((c) => c.key === k)).filter(Boolean) as Array<Column<WorkerRow>>,
    [cols, columns],
  )

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
        {(() => {
          const parts = [
            view !== 'all' ? `the “${VIEW_LABEL[view]}” view` : null,
            q.trim() ? `the search “${q.trim()}”` : null,
            tierFilter ? `the ${tierFilter} filter` : null,
          ].filter(Boolean) as string[]
          const list = parts.length > 1
            ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
            : parts[0] ?? 'the current filter'
          return `${list} ${parts.length > 1 ? 'are' : 'is'} hiding all ${rows.length} of them.`
        })()}
      </span>
      {view !== 'all' || q || tierFilter ? (
        <button
          className="acr-btn"
          onClick={() => { setView('all'); setQ(''); setTierFilter(null) }}
        >
          Show every worker
        </button>
      ) : null}
    </div>
  )

  return (
    <div className="acr-fleet">
      {err ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} /> {err}
          <button className="acr-btn" onClick={() => { setErr(null); refresh() }}>Try again</button>
        </div>
      ) : null}
      {note ? (
        <div className="acr-banner ok" role="status"><Check size={15} /> {note}</div>
      ) : null}
      {changes.length > 0 ? (
        <div className="acr-banner info" role="status">
          <RefreshCw size={15} />
          <span>
            <b>{changes.length} worker{changes.length === 1 ? '' : 's'} changed since you looked</b>
            {' — '}{changes.slice(0, 3).join(' · ')}
            {changes.length > 3 ? ` · and ${changes.length - 3} more` : ''}.
          </span>
          <button className="acr-btn" onClick={() => setChanges([])}>Dismiss</button>
        </div>
      ) : null}

      {pendingRaise ? (
        <ConfirmAutonomy
          to={pendingRaise.to}
          workers={pendingRaise.workers}
          busy={busyKeys.size > 0}
          onCancel={() => setPendingRaise(null)}
          onConfirm={() => void runAction(
            pendingRaise.workers.map((w) => w.key),
            'Changed',
            () => applyAutonomy(backend, pendingRaise.workers.map((w) => w.key), pendingRaise.to),
          )}
        />
      ) : null}

      {pendingPause ? (
        <PauseDialog
          workers={pendingPause}
          busy={busyKeys.size > 0}
          onCancel={() => setPendingPause(null)}
          onConfirm={(days, reason) => void runAction(
            pendingPause.map((w) => w.key),
            'Paused',
            () => applyPause(backend, pendingPause.map((w) => w.key), days, reason),
          )}
        />
      ) : null}

      <p className="acr-pg-intro">
        Every <Term k="worker">worker</Term> the fleet has, in one list. The fleet map shows how
        they connect; this shows what you have and which one needs you. Each worker is an AI
        analyst with one narrow job — none of them can change anything on Amazon by itself.
      </p>

      {state?.halted ? (
        <div className="acr-banner err" role="alert">
          <Ban size={15} />
          <span>
            <b>The fleet is halted.</b> No worker will start, whatever its dial says
            {state.haltReason ? <> — “{state.haltReason}”</> : null}
            {state.haltedBy ? <>, by {state.haltedBy}</> : null}.
          </span>
          <Link className="acr-btn" href="/fleet/controls">Open Controls</Link>
        </div>
      ) : null}

      {/* W.2 — five of the six tiles filter the table below. Microsoft's Agent
          Registry leads with Total agents / Agents WITHOUT OWNERS / UNMANAGED
          agents: two of its three headline cards are governance gaps rather
          than census, and that is the correction here. A number an operator
          cannot act on is a poster. */}
      <div className="acr-pg-strip">
        <Tile
          v="all"
          k="Workers"
          value={totals.workers}
          sub={allTiers.map(([t, n]) => `${n} ${t}`).join(' · ') || '—'}
        />
        <Tile
          v="live"
          k="Switched on"
          value={totals.running}
          sub={totals.running === 0 ? 'the whole fleet is off' : `of ${totals.workers}`}
        />
        <Tile
          v="attention"
          k="Needs attention"
          tone={totals.attention > 0 ? 'warn' : undefined}
          value={totals.attention}
          sub={
            totals.attention === 0
              ? 'nothing is asking for you'
              : attentionTags.map(([t, n]) => `${n} ${t}`).join(' · ')
          }
        />
        <Tile
          v="eligible"
          k="Earned a promotion"
          tone={totals.eligible > 0 ? 'good' : undefined}
          value={totals.eligible}
          sub={
            totals.eligible === 0
              ? 'none yet — trust is earned over 14 days'
              : `${totals.eligible === 1 ? 'has' : 'have'} earned it and not been given it`
          }
        />
        {/* Not a filter: this counts FINDINGS, not workers, so clicking it
            could not show "17 rows". It reports the business-worker total; the
            footnote below carries the diagnostic worker's separately. */}
        <div className="acr-pg-stat">
          <span className="k">Open findings</span>
          <span className="v">{totals.openFindings}</span>
          <span className="sub">waiting to be used or to expire</span>
        </div>
        {/* Not a filter: spend is a question about money, and the page that
            answers it is Cost & value. This tile points there. */}
        <div className="acr-pg-stat">
          <span className="k">Spent, last 7 days</span>
          <span className="v">${totals.cost7d.toFixed(4)}</span>
          <span className="sub">
            ${spentToday.toFixed(4)} today
            {state?.dailyCeilingUSD != null
              ? <> · ceiling ${Number(state.dailyCeilingUSD).toFixed(2)}/day</>
              : null}
          </span>
        </div>
      </div>

      {/* Excluded, never concealed. */}
      {diagnostics.length > 0 ? (
        <p className="sbw-note" style={{ margin: '-4px 0 12px' }}>
          <b>Open findings</b> and <b>spend</b> leave out{' '}
          {diagnostics.length === 1 ? 'one diagnostic worker' : `${diagnostics.length} diagnostic workers`}
          {' '}({diagnostics.map((d) => d.charter.key).join(', ')}), which check the fleet itself rather
          than your account: {diagTotals.findings} more finding{diagTotals.findings === 1 ? '' : 's'}
          {diagTotals.cost7d > 0 ? `, $${diagTotals.cost7d.toFixed(4)}` : ''}. The counts that filter
          the table — workers, switched on, needs attention — include{' '}
          {diagnostics.length === 1 ? 'it' : 'them'}, so every tile matches the rows it shows.
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

      {/* W.3 — three named views, because three answers to three real morning
          questions cost a beginner nothing, where a saved-view builder costs
          them a concept. Each writes itself into the URL, so a filtered roster
          can be linked. */}
      <div className="sbw-views" role="group" aria-label="Which workers to show">
        {NAMED_VIEWS.map(({ v, label, hint }) => {
          const n = v === 'all' ? rows.length : rows.filter((r) => matchesView(r, v)).length
          return (
            <button
              key={v}
              type="button"
              className={`sbw-view ${view === v ? 'on' : ''}`}
              aria-pressed={view === v}
              title={hint}
              onClick={() => setView(v)}
            >
              {label} <span className="n">{n}</span>
            </button>
          )
        })}
        {view === 'eligible' ? (
          <button type="button" className="sbw-view on" aria-pressed onClick={() => setView('all')}>
            {VIEW_LABEL.eligible} <X size={11} aria-hidden />
          </button>
        ) : null}
      </div>

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
            Any job <span className="n">{rows.length}</span>
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

        {/* Customize columns — Agent 365's own answer to a column list longer
            than one screen. */}
        <div className="sbw-colswrap">
          <button
            className="acr-btn"
            aria-expanded={colsOpen}
            aria-haspopup="true"
            onClick={() => setColsOpen((o) => !o)}
          >
            <Columns size={13} /> Columns <span className="sbw-note">{cols.length}</span>
          </button>
          {colsOpen ? (
            <>
              <div className="sbw-colsscrim" onClick={() => setColsOpen(false)} aria-hidden />
              <div className="sbw-colspop" role="dialog" aria-label="Choose which columns to show">
                <p className="sbw-colshead">Show these columns</p>
                {COLUMNS.map((c) => {
                  const on = cols.includes(c.key)
                  return (
                    <label key={c.key} className={`sbw-colsrow ${c.fixed ? 'fixed' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={c.fixed}
                        onChange={() => {
                          const next = on
                            ? cols.filter((k) => k !== c.key)
                            // keep the canonical order rather than click order
                            : COLUMNS.filter((x) => x.key === c.key || cols.includes(x.key)).map((x) => x.key)
                          setCols(next)
                          try { localStorage.setItem(COLS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
                        }}
                      />
                      {c.label}
                      {c.fixed ? <span className="sbw-note">always on</span> : null}
                    </label>
                  )
                })}
                <button
                  className="acr-btn"
                  onClick={() => {
                    setCols(DEFAULT_COLS)
                    try { localStorage.setItem(COLS_KEY, JSON.stringify(DEFAULT_COLS)) } catch { /* private mode */ }
                  }}
                >
                  Reset to the default nine
                </button>
              </div>
            </>
          ) : null}
        </div>

        {/* Refresh stays, deliberately. Polling that removes the manual control
            leaves an operator with no way to force the question. */}
        <button className="acr-btn" onClick={refresh} disabled={loading}>
          <RefreshCw size={13} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <span className="sbw-asof" title={asOf ? asOf.toLocaleString() : undefined}>
          {asOf ? `as of ${asOf.toLocaleTimeString()}` : 'not read yet'}
        </span>
      </div>

      <div className="h10-ds-gridcard sbw-gridcard">
        <GridToolbar
          count={
            selectedRows.length > 0 ? (
              <>Selected <b>{selectedRows.length}</b> worker{selectedRows.length === 1 ? '' : 's'}</>
            ) : (
              <>
                Showing <b>{visible.length}</b> of <b>{rows.length}</b> worker{rows.length === 1 ? '' : 's'}
                {view !== 'all' ? <> · {VIEW_LABEL[view].toLowerCase()}</> : null}
              </>
            )
          }
        >
          {/* W.4 — the registry's reason to exist at scale: do one thing to
              twelve workers without twelve page visits. Switching off and
              pausing REDUCE risk, so they apply at once; anything that lets a
              worker do more goes through the shared confirm, which names every
              worker it would change. */}
          {selectedRows.length > 0 ? (
            <span className="sbw-bulk">
              <button
                className="acr-btn stop"
                disabled={busyKeys.size > 0}
                onClick={() => requestLevel(selectedRows, 'OFF')}
              >
                <Ban size={13} /> Switch off
              </button>
              <button
                className="acr-btn"
                disabled={busyKeys.size > 0}
                onClick={() => setPendingPause(selectedRows.map((r) => ({
                  key: r.charter.key, name: r.charter.name, from: r.charter.autonomyLevel,
                })))}
              >
                <PauseIcon size={13} /> Pause…
              </button>
              <span className="sbw-bulksep" aria-hidden />
              <span className="sbw-note">Set all to</span>
              {LEVELS.filter((l) => l !== 'OFF').map((l) => {
                // A rung is offered only if EVERY selected worker's code cap
                // allows it. Offering a button that will 403 for three of six
                // is how bulk earns its reputation.
                const blocked = selectedRows.some((r) => (RANK[l] ?? 0) > (RANK[r.charter.autonomyCap] ?? 0))
                return (
                  <button
                    key={l}
                    className="acr-btn"
                    disabled={blocked || busyKeys.size > 0}
                    title={blocked
                      ? `At least one selected worker has a ceiling below ${l}`
                      : `Ask to move every selected worker to ${l}`}
                    onClick={() => requestLevel(selectedRows, l)}
                  >
                    {l}
                  </button>
                )
              })}
              <button className="acr-btn" onClick={() => setSelected(new Set())}>
                <X size={12} /> Clear
              </button>
            </span>
          ) : null}
        </GridToolbar>
        <DataGrid<WorkerRow>
          columns={shownColumns}
          rows={visible}
          rowKey={(r) => r.charter.key}
          initialSort={{ key: 'status', dir: 'asc' }}
          emptyState={emptyState}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          rowSelectable={canAct}
          rowSelectableHint="This worker has no settings row yet, so nothing can be changed on it. Seed the roster first."
          selectAllHint="Select every worker currently shown"
          selectRowHint="Select this worker for a bulk action"
        />
      </div>
    </div>
  )
}
