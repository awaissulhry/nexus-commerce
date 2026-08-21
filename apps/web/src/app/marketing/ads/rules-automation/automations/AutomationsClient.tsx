'use client'

/**
 * RA.AUTO — Automations: every rule you have, and one honest mode control.
 *
 * Replaces what `ads-console/automation?tab=active` and the five rule-type tabs were each doing
 * half of, and fixes what both were doing wrongly:
 *
 *   · The mode control writes `autonomyLevel` through `PATCH /advertising/autonomy/rules/:id`
 *     and never touches `dryRun`. `resolveAutonomy()` reads `dryRun` only when `autonomyLevel`
 *     is null or OFF, and all 51 rules carry an explicit level — so the console's dry-run⇄LIVE
 *     toggle cannot change what any of them does. (Plan Part 2.)
 *   · The type filter uses the SERVER's 8-family taxonomy, not the client's 13-action-type tab
 *     map. Measured: the two disagree — the tab bar reads "Keyword Harvest 5" while the server
 *     says harvest 0 — and 17 of 51 rules have no tab home at all.
 *   · The census counts rules that can WRITE (8), not rules on AUTO (9). "Alert: ACOS spike" is
 *     on AUTO and only notifies.
 *   · Every control here changes something. The five tabs' Automation switch, Criteria edit,
 *     Frequency edit and bulk Delete were all local state — bulk Delete said "this cannot be
 *     undone" and deleted nothing.
 *
 * One read (`GET /advertising/autonomy/rules`) carries the census, the categories, the resolved
 * scope names, the ceilings and the week counts. The graduation board is a second, independent
 * read: a rule you cannot judge is still a rule you must be able to switch off.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, GraduationCap, Info, ShieldAlert, Sliders, Trash2, Zap } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { HistoryDrawer } from '../tabs/RuleListTab'
import { getBackendUrl } from '@/lib/backend-url'
import { ModeNotches, RANK, type Level } from './ModeNotches'
import { RuleDetail, type Readiness, type DetailRule } from './RuleDetail'
import { EngineDetail, type EngineActor, type ObservedActor } from './EngineDetail'
import { LimitsView } from './LimitsView'
import { LedgerView } from './LedgerView'
// SG.6 — QueueView is ⛔ PARKED (one inbox: the Suggestions page). Its file stays at this path.
import type { ScopeOptions, ScopeValue } from './ScopeForm'
import { triggerText } from './ruleText'
import { emitAdsChange, useAdsSync } from '../_shared/adsBus'
import { useCursorBaseline, useCursorPoll } from '../_shared/useCursorPoll'
import { StaleBanner } from '../_shared/StaleBanner'
import { AdsFilterBar } from '../../campaigns/_grid/AdsFilterBar'
import { useMergedFilters } from '../_shared/useMergedFilters'

interface Rule extends DetailRule {
  category: string
}

/**
 * AUTO.A2 — the grid's row is an ACTOR, not a rule. Rules stay the majority kind; engines come
 * from `GET /advertising/actors` (A0), and `observed` are actor strings the last window's log
 * carries that no rule and no engine claims — the list is declared ∪ observed because the
 * registry provably misses authors (9,598 writes with a null userId when this was measured).
 */
type ActorRow =
  | { k: 'rule'; r: Rule }
  | { k: 'engine'; e: EngineActor }
  | { k: 'obs'; o: ObservedActor }
type ActorKind = 'all' | 'rules' | 'engines'

/** Stable order for the type filter, matching `rule-category.ts`'s own family order. */
const CATEGORY_ORDER = ['bid', 'budget', 'harvest', 'negative', 'placement', 'guard', 'alert', 'other'] as const

const num = (n: number) => n.toLocaleString('en-IE')
const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}
const LEVEL_WORD: Record<Level, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Propose', AUTO: 'Auto' }

/** The three band tiles that narrow the grid. `null` is "not narrowed". */
type TileKey = 'writing' | 'unscoped' | 'off'
const asTile = (v: string | null | undefined): TileKey | null =>
  (v === 'writing' || v === 'unscoped' || v === 'off' ? v : null)

export function AutomationsClient() {
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [protectedTerms, setProtectedTerms] = useState(0)
  const [grad, setGrad] = useState<Map<string, Readiness>>(new Map())
  const [weeksRequired, setWeeksRequired] = useState(3)
  const [scopeOptions, setScopeOptions] = useState<ScopeOptions | null>(null)
  const [market, setMarket] = useState('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  // BUD.3 / A3 — `?rule=<id>` deep-links a rule's drawer, so every other page's rule row can
  // point HERE instead of forking a second record (one owner: this page owns the actor).
  const [detailId, setDetailId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('rule')
  })
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null)
  const [bulk, setBulk] = useState<{ kind: 'mode'; level: Level } | { kind: 'delete' } | null>(null)
  // AUTO.A2 — the non-rule actors, and the All ⇄ Rules ⇄ Engines segment (?kind= in the URL).
  const [actors, setActors] = useState<{ engines: EngineActor[]; observed: ObservedActor[]; global?: { autonomy: string; halted: boolean; degraded: boolean; envKill: boolean } } | null>(null)
  const [actorsErr, setActorsErr] = useState<string | null>(null)
  const [engineKey, setEngineKey] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  // AUTO.A4 — the server's by-entity conflict payload. null = not loaded / failed (the banner
  // then stays silent rather than claiming "no conflicts", which would be a different fact).
  const [conflictsData, setConflictsData] = useState<{
    windowDays: number
    totalCampaigns: number
    byField: Array<{ field: string; reachable: number; contested: number; worst: { name: string; actors: Array<{ name: string; kind: string; level: string }> } | null }>
    pairs: Array<{ cls: string; a: string; b: string; field: string; note: string }>
    perRule: Record<string, string[]>
    cadence: Array<{ name: string; pct: number; windowDays: number; capPerDay: number | null; atCapFactor: number }>
    duplicates: { bodies: string[][]; names: string[][] }
  } | null>(null)
  // AUTO.A1 — the band tile acting as a filter (?tile=). Clicking the active tile clears it.
  //
  // 🔴 FB.2 — this used to be a SECOND STORE. The tile lived here in `?tile=` while Mode lived in
  // the grid's own filter state, with nothing reconciling them: setting Mode=Propose while
  // `?tile=writing` was on left an empty grid under two controls that both looked live, and the
  // panel's Clear could not clear the tile. The tile is now a filter like any other — it appears in
  // the merged bar as "Exposure", it clears with everything else, and the band buttons are a second
  // affordance on the same store rather than a store of their own.
  const [tile, setTile] = useState<TileKey | null>(() => {
    if (typeof window === 'undefined') return null
    return asTile(new URLSearchParams(window.location.search).get('tile'))
  })
  const applyTile = useCallback((next: TileKey | null) => {
    setTile(next)
    const u = new URL(window.location.href)
    if (next) u.searchParams.set('tile', next); else u.searchParams.delete('tile')
    window.history.replaceState(null, '', u)
  }, [])
  /** The band's affordance: clicking the active tile clears it. The select does not toggle. */
  const setTileAndUrl = (t: TileKey | null) => applyTile(t === tile ? null : t)
  const [kind, setKind] = useState<ActorKind>(() => {
    if (typeof window === 'undefined') return 'all'
    const v = new URLSearchParams(window.location.search).get('kind')
    return v === 'rules' || v === 'engines' ? v : 'all'
  })
  // AUTO.A0 — the view switcher (?view=). Actors is the default (decision D1: a person arriving
  // at the section wants the control plane). Views land as they are built.
  const [view, setView] = useState<'actors' | 'conflicts' | 'ledger' | 'queue' | 'limits'>(() => {
    if (typeof window === 'undefined') return 'actors'
    const v = new URLSearchParams(window.location.search).get('view')
    return v === 'limits' || v === 'ledger' || v === 'queue' || v === 'conflicts' ? v : 'actors'
  })
  const setViewAndUrl = (v: typeof view) => {
    setView(v)
    const u = new URL(window.location.href)
    if (v === 'actors') u.searchParams.delete('view'); else u.searchParams.set('view', v)
    window.history.replaceState(null, '', u)
  }
  const setKindAndUrl = (k: ActorKind) => {
    setKind(k)
    const u = new URL(window.location.href)
    if (k === 'all') u.searchParams.delete('kind'); else u.searchParams.set('kind', k)
    window.history.replaceState(null, '', u)
  }

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load automations (${r.status})`)
      const j = await r.json()
      setRules(Array.isArray(j?.items) ? (j.items as Rule[]) : [])
      setProtectedTerms(Number(j?.protectedTerms ?? 0))
      setErr(null)
    } catch (e) { setErr((e as Error).message); setRules([]) }
    // Independent of the above on purpose — see the file header.
    try {
      const g = await fetch(`${getBackendUrl()}/api/advertising/autonomy/graduation`, { cache: 'no-store' })
      if (!g.ok) throw new Error(String(g.status))
      const gj = await g.json()
      const all = [...(gj?.ready ?? []), ...(gj?.others ?? [])] as Array<Readiness & { ruleId: string }>
      setGrad(new Map(all.map((x) => [x.ruleId, x])))
      setWeeksRequired(Number(gj?.weeksRequired ?? 3))
    } catch { setGrad(new Map()) }
    // AUTO.A0 — the engine/observed half. Also independent: a failed actors read must degrade to
    // "engines could not load", never blank the rules an operator may be about to switch off.
    try {
      const a = await fetch(`${getBackendUrl()}/api/advertising/actors`, { cache: 'no-store' })
      if (!a.ok) throw new Error(`Could not load engines (${a.status})`)
      const aj = await a.json()
      setActors({ engines: Array.isArray(aj?.engines) ? aj.engines : [], observed: Array.isArray(aj?.observed) ? aj.observed : [], global: aj?.global })
      setActorsErr(null)
    } catch (e) { setActorsErr((e as Error).message); setActors({ engines: [], observed: [] }) }
    // AUTO.A1 — the queue, in one number. null (not 0) on failure: "no queue" and "could not
    // count the queue" must never render the same.
    try {
      const q = await fetch(`${getBackendUrl()}/api/advertising/suggestions/count`, { cache: 'no-store' })
      const qj = await q.json()
      setPendingCount(q.ok && typeof qj?.pending === 'number' ? qj.pending : null)
    } catch { setPendingCount(null) }
    // AUTO.A4 — the by-entity conflicts. Failure leaves null: the banners stay silent instead of
    // claiming a clean account, and the badges simply do not render.
    try {
      const c = await fetch(`${getBackendUrl()}/api/advertising/autonomy/conflicts`, { cache: 'no-store' })
      if (!c.ok) throw new Error(String(c.status))
      setConflictsData(await c.json())
    } catch { setConflictsData(null) }
  }, [])

  useEffect(() => { void load() }, [load])

  // RT.2 — the cursor. Account-wide on purpose: all four of this page's reads are account-wide, so
  // a scoped cursor would describe a different row set from the grid. `cfg` folds every rule's
  // CONFIG while excluding evaluationCount / lastEvaluatedAt / updatedAt — measured, those moved on
  // 19 of 51 rules in 20 minutes because the evaluator touches every rule every tick. `actedAt`
  // rides only on the ledger view, where those writes ARE the subject.
  const autoCursorParams = useMemo(() => ({ view }), [view])
  const autoCursorUrl = `${getBackendUrl()}/api/advertising/automations/cursor`
  const autoBaseline = useCursorBaseline<Record<string, unknown>>(autoCursorUrl, autoCursorParams, rules?.length ?? 0)
  const autoRefresh = useCursorPoll<Record<string, unknown>>({
    url: autoCursorUrl, params: autoCursorParams, baseline: autoBaseline,
    // A rule drawer open is a conversation about one rule; a banner about the other fifty waits.
    enabled: detailId == null && engineKey == null && bulk == null,
  })

  // RT.1 — your own writes, from any tab, applied silently. This page is the control plane, so it
  // hears the three subjects it owns: rule edits (from the builder or any page's rule section),
  // queue decisions, and the limits it enforces. An ENGINE's write arrives on the other rail (the
  // cursor poll) and offers a banner instead; see `_shared/adsBus.ts`.
  useAdsSync(['ads.rule.changed', 'ads.suggestion.changed', 'ads.guardrail.changed'], () => { void load() })

  /**
   * RA.GRAIN — one read feeds every grain's picker and the local reach maths.
   *
   * Replaces the two separate campaigns/portfolios fetches. `/advertising/scope-options` carries
   * ~220 campaigns plus 13 product lines with their campaign ids, which is small enough to compute
   * any combination's exact reach in the browser — so a dropdown twiddle costs nothing and the
   * number shown is the same intersection the server enforces.
   */
  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/scope-options`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.campaigns)) setScopeOptions(d as ScopeOptions) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const markets = useMemo(
    () => Array.from(new Set((scopeOptions?.campaigns ?? []).map((c) => c.marketplace).filter(Boolean))) as string[],
    [scopeOptions],
  )

  const setLevel = async (rule: Rule, level: Level) => {
    if (busy || level === rule.level) return
    setBusy(rule.id); setErr(null); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string }
        // 409 is the ceiling refusing, which is policy rather than failure — so it gets the
        // policy's own words. The route returns them on `message`; reading `reason` here would
        // have fallen back to generic copy forever.
        throw new Error(r.status === 409
          ? (j.message ?? 'That mode is above this rule’s ceiling.')
          : (j.error ?? `Could not change mode (${r.status})`))
      }
      await load()
      // RT.1 — a rule mode, scope or bulk change moves every tab badge and every page's rule section.
      emitAdsChange('ads.rule.changed')
      setNote(`“${rule.name}” is now ${LEVEL_WORD[level]}.`)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const setScope = async (rule: Rule, scope: ScopeValue) => {
    setBusy(rule.id); setErr(null); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${rule.id}/scope`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string; reach?: { campaigns: number; total: number } }
      if (!r.ok || j.ok === false) {
        // 409 scope_matches_nothing is the server refusing a combination that could never fire.
        // It gets the server's own sentence, which names which pair conflicts.
        throw new Error(j.message ?? j.error ?? `Could not bind scope (${r.status})`)
      }
      await load()
      // RT.1 — a rule mode, scope or bulk change moves every tab badge and every page's rule section.
      emitAdsChange('ads.rule.changed')
      setNote(j.reach
        ? `Scope updated for “${rule.name}” — it now covers ${j.reach.campaigns} of ${j.reach.total} campaigns.`
        : `Scope updated for “${rule.name}”.`)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const all = rules ?? []

  /**
   * The market switch, wired. A rule with no `scopeMarketplace` can act in every market, so
   * narrowing to IT must keep it — an equality test would hide 43 of 51 rules and read as a
   * data bug. The pixel this control changes is the row count.
   */
  const rows = useMemo(
    () => (market === 'all' ? all : all.filter((r) => !r.marketplace || r.marketplace === market)),
    [all, market],
  )

  /**
   * AUTO.A2 — the grid's population, by kind. Engines survive the market switch for the same
   * L1 reason unscoped rules do: an engine acts in every market, so narrowing the view must
   * keep it. `observed` rows ride with the engines segment — they are the log's answer to
   * "who else", and hiding them under Rules would bury the one list nothing else shows.
   */
  /** A rule with no grain bound at all — the account's actual exposure when it also writes. */
  const isUnscoped = (r: Rule) => r.scope.kind === 'account' && !r.marketplace && !r.scope.product

  const gridRows = useMemo<ActorRow[]>(() => {
    let ruleRows: ActorRow[] = rows.map((r) => ({ k: 'rule', r }))
    let engineRows: ActorRow[] = (actors?.engines ?? []).map((e) => ({ k: 'engine', e }))
    let obsRows: ActorRow[] = (actors?.observed ?? []).map((o) => ({ k: 'obs', o }))
    // A1 — the active tile narrows every kind it can describe. Engines are unscoped by
    // construction, so 'unscoped' keeps the AUTO ones; 'off' keeps OFF engines.
    if (tile === 'writing') {
      ruleRows = ruleRows.filter((a) => a.k === 'rule' && a.r.level === 'AUTO' && a.r.writes)
      engineRows = engineRows.filter((a) => a.k === 'engine' && a.e.posture === 'AUTO')
      obsRows = []
    } else if (tile === 'unscoped') {
      ruleRows = ruleRows.filter((a) => a.k === 'rule' && a.r.level === 'AUTO' && a.r.writes && isUnscoped(a.r))
      engineRows = engineRows.filter((a) => a.k === 'engine' && a.e.posture === 'AUTO')
      obsRows = []
    } else if (tile === 'off') {
      ruleRows = ruleRows.filter((a) => a.k === 'rule' && a.r.level === 'OFF')
      engineRows = engineRows.filter((a) => a.k === 'engine' && a.e.posture === 'OFF')
      obsRows = []
    }
    if (kind === 'rules') return ruleRows
    if (kind === 'engines') return [...engineRows, ...obsRows]
    return [...ruleRows, ...engineRows, ...obsRows]
  }, [rows, actors, kind, tile])

  /**
   * AUTO.A4 — conflicts come from the SERVER's by-entity detector now. The client model this
   * replaced matched on trigger and flagged 0 of 22 live rules; the server resolves every
   * actor's reach (rules from scope, engines and the operator from the log) and reports
   * (campaign × field) contests. `conflicts` keeps the Map<ruleId, string[]> shape the grid
   * badges and drawer already consume.
   */
  const conflicts = useMemo(
    () => new Map(Object.entries(conflictsData?.perRule ?? {})),
    [conflictsData],
  )

  const counts = useMemo(() => ({
    total: all.length,
    off: all.filter((r) => r.level === 'OFF').length,
    observe: all.filter((r) => r.level === 'OBSERVE').length,
    propose: all.filter((r) => r.level === 'PROPOSE').length,
    auto: all.filter((r) => r.level === 'AUTO').length,
    // The number that matters: on AUTO *and* able to reach Amazon.
    writing: all.filter((r) => r.level === 'AUTO' && r.writes).length,
    autoNotifyOnly: all.filter((r) => r.level === 'AUTO' && !r.writes).length,
    // A1 — the account's actual exposure: writes, on AUTO, and bound to NOTHING.
    unscopedWriting: all.filter((r) => r.level === 'AUTO' && r.writes && isUnscoped(r)).length,
    engineAuto: (actors?.engines ?? []).filter((e) => e.posture === 'AUTO').length,
    engineOff: (actors?.engines ?? []).filter((e) => e.posture === 'OFF').length,
    ready: [...grad.values()].filter((g) => g.canGraduate).length,
    // A rule can report completed executions while every action inside them failed, so the run
    // count alone reads as health. This is the state that has no surface anywhere today.
    allFailing: all.filter((r) => r.week.failed > 0 && r.week.acted === 0),
    neverRan: all.filter((r) => r.lifetime.evaluations === 0).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [all, grad, actors])

  const categoryOpts = useMemo(() => {
    const seen = new Map<string, { label: string; n: number }>()
    for (const r of all) {
      const e = seen.get(r.category) ?? { label: r.categoryLabel, n: 0 }
      e.n++; seen.set(r.category, e)
    }
    return CATEGORY_ORDER
      .filter((c) => seen.has(c))
      .map((c) => ({ value: c, label: `${seen.get(c)!.label} (${seen.get(c)!.n})` }))
  }, [all])

  const columns: GridColumn<ActorRow>[] = useMemo(() => [
    {
      key: 'mode', label: 'Mode', metric: false, sortable: true,
      sortValue: (a) => (a.k === 'rule' ? RANK[a.r.level] : a.k === 'engine' ? RANK[a.e.posture] : -1),
      render: (a) => {
        if (a.k === 'obs') return <span className="h10-au-obsdash" title="Appears only in the write log — it has no mode to set">—</span>
        if (a.k === 'engine') {
          // An engine renders its posture in the same four words, READ-ONLY — its notches are env
          // flags, and a dial here that could not turn would be worse than a word that says so.
          return (
            <span className={`h10-au-eposture ${a.e.posture.toLowerCase()}`} title={a.e.postureReason}>
              {LEVEL_WORD[a.e.posture]}
              <em>{a.e.haltBehaviour === 'honours' ? 'honours halt' : a.e.haltBehaviour === 'gated' ? 'gated at the write gate' : 'halt-exempt'}</em>
            </span>
          )
        }
        const r = a.r
        const g = grad.get(r.id)
        return (
          <ModeNotches
            level={r.level}
            ceiling={r.ceiling}
            ceilingReason={r.ceilingReason}
            ruleName={r.name}
            busy={busy === r.id}
            earnedAuto={!!g?.canGraduate}
            earnedWhy={g?.summary}
            onSet={(lv) => void setLevel(r, lv)}
            /* U13 — a notch above the ceiling now says so instead of refusing in silence. It
               reuses this page's own banner, so the refusal reads the same whether the ceiling
               stopped it here or the server's 409 did. */
            onRefused={(why) => { setNote(null); setErr(`“${r.name}” — ${why}`) }}
          />
        )
      },
    },
    {
      key: 'trigger', label: 'When', metric: false, sortable: true,
      sortValue: (a) => (a.k === 'rule' ? a.r.trigger : a.k === 'engine' ? (a.e.schedule ?? a.e.cron ?? '') : ''),
      render: (a) => (
        a.k === 'rule' ? <span className="h10-au-trg">{triggerText(a.r.trigger)}</span>
          : a.k === 'engine' ? <span className="h10-au-trg">{a.e.schedule ?? a.e.cron ?? '—'}</span>
            : <span className="h10-au-obsdash">—</span>
      ),
    },
    {
      key: 'scope', label: 'Scope', metric: false, sortable: true,
      sortValue: (a) => (a.k === 'rule' ? a.r.scope.kind : a.k === 'engine' ? 'engine' : 'obs'),
      render: (a) => {
        if (a.k === 'obs') return <span className="h10-au-obsdash" title={a.o.label}>—</span>
        if (a.k === 'engine') return <span className="h10-au-scope engine">{a.e.scope ?? 'account-wide'}</span>
        const r = a.r
        return (
          <span className={`h10-au-scope ${r.scope.kind}`}>
            {r.scope.kind === 'account' ? 'Whole account' : `${r.scope.kind}: ${r.scope.name ?? r.scope.id}`}
            {r.marketplace && <em> · {r.marketplace}</em>}
          </span>
        )
      },
    },
    {
      /**
       * EA7 — ORDER. Where this rule sits in the run order, and who it would yield to.
       *
       * 🔴 The column only earns its place because collisions are real: measured on this account
       * every campaign has 12+ actors on its bids and 4+ on its budget, and until EA7 the winner
       * of any of those was decided by the order Postgres returned rows in. Lower runs first.
       *
       * A rule sharing the default 100 with everything else is shown muted — the number is true
       * but says nothing yet. It only becomes information once someone orders a colliding pair.
       */
      key: 'priority', label: 'Order', metric: false, sortable: true,
      tip: 'Which rule wins when two of them write the same field on the same campaign in one tick. Lower runs first; 100 is the default. The rule that loses records "yielded" — it matched, and went second.',
      sortValue: (a) => (a.k === 'rule' ? (a.r.priority ?? 100) : 1000),
      render: (a) => {
        if (a.k !== 'rule') return <span className="h10-au-obsdash" title="Engines run on their own cron, not in the rule tick">—</span>
        const p = a.r.priority ?? 100
        return (
          <span className={`h10-au-prio ${p === 100 ? 'default' : ''}`}
            title={p === 100
              ? 'The default. Every rule shares it, so ties fall back to creation order — the order they already ran in.'
              : `Runs ${p < 100 ? 'BEFORE' : 'after'} the default rules. Lower goes first.`}>
            {p}
          </span>
        )
      },
    },
    {
      /**
       * EA6 — REACH. How many campaigns this rule can currently touch.
       *
       * 🔴 The number that answers "is it safe to arm this?" before the switch is flipped, rather
       * than after. Measured on prod 2026-08-19: 43 of 51 rules are unscoped and read the full
       * 220; the 8 that carry scope are market-scoped only, so rules NAMED for one product line
       * ("Hold top rank ≥ 45% — XAVIA GALE…") reach 150 campaigns. That gap between what a rule is
       * called and what it can touch is invisible without this column.
       *
       * Computed with the evaluator's own `ruleMatchesScope`, so it cannot disagree with what runs.
       * Engines and observed actors carry their own bounds and show a dash rather than a guess.
       */
      key: 'reach', label: 'Reaches', metric: false, sortable: true,
      tip: 'How many campaigns this rule\'s scope currently admits, resolved the same way the engine resolves it on every tick. 0 means the rule is armed and can act on nothing. The whole-account figure is the total campaign count.',
      sortValue: (a) => (a.k === 'rule' ? (a.r.reach?.campaigns ?? -1) : -1),
      render: (a) => {
        if (a.k !== 'rule') return <span className="h10-au-obsdash" title="Engines and observed actors carry their own bounds, in their own services">—</span>
        const re = a.r.reach
        if (!re) return <span className="h10-au-obsdash" title="This build of the server did not report reach">unknown</span>
        if (re.campaigns === 0) {
          return <span className="h10-au-reach dead" title="This rule's scope resolves to no campaign at all. It is armed and cannot act — which looks identical to a quiet week until you read this number.">0 <em>dead</em></span>
        }
        const all = re.campaigns === re.total
        return (
          <span className={`h10-au-reach ${all ? 'all' : ''}`}
            title={all
              ? `Every campaign in the account (${re.total}). This rule carries no scope that narrows it — ${re.enabledCampaigns} of them are enabled right now.`
              : `${re.campaigns} of ${re.total} campaigns match this rule's scope · ${re.enabledCampaigns} enabled right now.`}>
            <b>{num(re.campaigns)}</b>{all && <em>all</em>}
          </span>
        )
      },
    },
    {
      /**
       * AUTO.A2 — the Ceiling cell: the caps in force, never a bare number. Renderable at last —
       * the row cap has been enforced since 2026-08-14 (the null-safe counter) and the write cap
       * demotes past its bound. `capped` is the week's refusals; a cap with zero refusals may be
       * working or may be governing a quiet trigger, so the cell never claims "working".
       */
      key: 'ceiling', label: 'Caps', metric: false, sortable: false,
      render: (a) => {
        if (a.k !== 'rule') return <span className="h10-au-obsdash" title="Engines carry their own bounds in their own services">—</span>
        const c = a.r.caps
        return (
          <span className="h10-au-caps">
            {c.perDay != null && <em title="Row cap: matches dispatched per day. Reaching it refuses further matches (no row is written).">{num(c.perDay)}/day</em>}
            {c.writesPerDay != null && <em title="Write cap: writes per day, counted by actor. Reaching it demotes the rule to dry-run — it keeps proposing, stops writing.">{num(c.writesPerDay)} wr/day</em>}
            {c.perDayCents != null && <em title="Spend ceiling per day.">€{(c.perDayCents / 100).toFixed(0)}</em>}
            {c.perDay == null && c.writesPerDay == null && c.perDayCents == null && (
              <i className="h10-au-nocap" title="No cap of any kind is set on this rule.">uncapped</i>
            )}
          </span>
        )
      },
    },
    {
      key: 'week', label: 'This week', metric: false, sortable: true,
      sortValue: (a) => (a.k === 'rule' ? a.r.week.acted : a.k === 'engine' ? a.e.writes7d : a.o.writes7d),
      render: (a) => {
        if (a.k === 'obs') return <span className="h10-au-week"><b>{num(a.o.writes7d)}</b> writes</span>
        if (a.k === 'engine') {
          return (
            <span className="h10-au-week">
              <b>{num(a.e.writes7d)}</b> writes
              <em>{num(a.e.runs7d)} runs</em>
              {a.e.failures7d > 0 && <i className="bad">{num(a.e.failures7d)} failed</i>}
            </span>
          )
        }
        const r = a.r
        return (
          <span className="h10-au-week">
            <b>{num(r.week.acted)}</b> acted
            <em>{num(r.week.proposed)} proposed</em>
            {r.week.failed > 0 && <i className="bad">{num(r.week.failed)} failed</i>}
            {r.week.capped > 0 && (
              <i className="cap" title="Its own daily cap declined to run it. Not a failure — but it bounds how much of the account the rule reaches.">
                {num(r.week.capped)} capped
              </i>
            )}
          </span>
        )
      },
    },
    {
      key: 'lastRun', label: 'Last run', metric: false, sortable: true,
      sortValue: (a) => {
        const iso = a.k === 'rule' ? a.r.lastExecutedAt : a.k === 'engine' ? a.e.lastRunAt : a.o.lastWriteAt
        return iso ? new Date(iso).getTime() : 0
      },
      render: (a) => {
        const iso = a.k === 'rule' ? a.r.lastExecutedAt : a.k === 'engine' ? a.e.lastRunAt : a.o.lastWriteAt
        return <span className={iso ? '' : 'h10-au-never'}>{ago(iso)}</span>
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [grad, busy])

  const renderFirst = (a: ActorRow) => {
    if (a.k === 'engine') {
      const e = a.e
      return (
        <span className="h10-au-namew">
          <span className="h10-au-kindtag engine" aria-hidden>engine</span>
          <span className="h10-au-nm">
            <button type="button" className="h10-au-name" onClick={(ev) => { ev.stopPropagation(); setEngineKey(e.key) }}>
              {e.name}
            </button>
            <em>{e.what}</em>
          </span>
          {e.warning && <span className="h10-au-badge conf" title={e.warning}><AlertTriangle size={10} aria-hidden /> attention</span>}
          <button type="button" className="h10-au-open" onClick={(ev) => { ev.stopPropagation(); setEngineKey(e.key) }} aria-label={`Open ${e.name}`}>
            <Sliders size={11} aria-hidden /> Details
          </button>
        </span>
      )
    }
    if (a.k === 'obs') {
      return (
        <span className="h10-au-namew">
          <span className="h10-au-kindtag obs" aria-hidden>observed</span>
          <span className="h10-au-nm">
            <span className="h10-au-name asname">{a.o.actor}</span>
            <em>{a.o.label}</em>
          </span>
        </span>
      )
    }
    const r = a.r
    const conf = conflicts.get(r.id)
    const g = grad.get(r.id)
    return (
      <span className="h10-au-namew">
        <span className="h10-au-swatch" style={{ background: r.categoryColor }} title={r.categoryLabel} aria-hidden />
        <span className="h10-au-nm">
          <button type="button" className="h10-au-name" onClick={(e) => { e.stopPropagation(); setDetailId(r.id) }}>
            {r.name}
          </button>
          <em>{r.categoryLabel}{!r.writes && <> · reaches nothing</>}</em>
        </span>
        {r.level === 'AUTO' && r.writes && (
          <span className="h10-au-badge writes" title="On Auto and able to change your account">writes</span>
        )}
        {/* W1 — provenance, not behaviour. `=== true` on purpose: an older API payload omits the
            field, and absence must not render as either state. */}
        {r.legacy === true && (
          <span className="h10-au-badge legacy" title="Legacy — predates 2026-08-20 and was not created by you (seeded or machine-created). It runs exactly as configured; the label is for triage only.">legacy</span>
        )}
        {g?.canGraduate && (
          <span className="h10-au-badge ready" title={g.summary}><GraduationCap size={10} aria-hidden /> ready</span>
        )}
        {conf && (
          <span className="h10-au-badge conf" title={conf.join(' · ')}><AlertTriangle size={10} aria-hidden /> conflict</span>
        )}
        <button
          type="button"
          className="h10-au-open"
          onClick={(e) => { e.stopPropagation(); setDetailId(r.id) }}
          aria-label={`Open ${r.name}`}
        >
          <Sliders size={11} aria-hidden /> Details
        </button>
      </span>
    )
  }

  /**
   * The ceiling is per rule, so a bulk mode change partially succeeds. Say so before it runs.
   * A2 — the selection can now contain engine/observed rows; they are counted and NAMED as
   * skipped rather than silently dropped: their posture is env-owned, not this page's to set.
   */
  const nonRuleSel = useMemo(() => [...sel].filter((id) => id.startsWith('engine:') || id.startsWith('obs:')).length, [sel])
  const bulkPreview = useMemo(() => {
    if (!bulk || bulk.kind !== 'mode') return null
    const chosen = all.filter((r) => sel.has(r.id))
    const refused = chosen.filter((r) => RANK[bulk.level] > RANK[r.ceiling])
    const willWrite = bulk.level === 'AUTO' ? chosen.filter((r) => r.writes && RANK.AUTO <= RANK[r.ceiling]).length : 0
    return { total: chosen.length, refused: refused.length, names: refused.map((r) => r.name), willWrite }
  }, [bulk, sel, all])

  const doBulk = async () => {
    if (!bulk) return
    const ids = [...sel]
    setBusy('bulk'); setErr(null); setNote(null)
    let ok = 0; let refused = 0; let failed = 0
    const refusedNames: string[] = []
    try {
      for (const id of ids) {
        const rule = all.find((r) => r.id === id)
        if (!rule) continue
        if (bulk.kind === 'delete') {
          // A real DELETE. The rule-type tabs' bulk delete said "this cannot be undone" and
          // removed the row from local state only — the rules came back on reload.
          const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'DELETE' })
          if (r.ok) ok++; else failed++
        } else {
          const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: bulk.level }),
          })
          if (r.ok) ok++
          else if (r.status === 409) { refused++; refusedNames.push(rule.name) }
          else failed++
        }
      }
      setSel(new Set()); setBulk(null); setDetailId(null)
      await load()
      // RT.1 — a rule mode, scope or bulk change moves every tab badge and every page's rule section.
      emitAdsChange('ads.rule.changed')
      setNote([
        `${ok} ${bulk.kind === 'delete' ? 'deleted' : 'updated'}`,
        refused ? `${refused} refused by their ceiling (${refusedNames.slice(0, 3).join(', ')}${refusedNames.length > 3 ? '…' : ''})` : null,
        failed ? `${failed} failed` : null,
      ].filter(Boolean).join(' · '))
    } finally { setBusy(null) }
  }

  /**
   * The bulk modal sits at z-index 140 and this drawer at 161, so the two must never be open
   * together — the modal would render underneath its own backdrop. Rather than fight the
   * stacking (raising the drawer above H10Select's portalled popover at 200 would clip every
   * dropdown inside it), the drawer simply yields.
   */
  const openBulk = (b: { kind: 'mode'; level: Level } | { kind: 'delete' }) => { setDetailId(null); setBulk(b) }

  const detail = detailId && !bulk ? all.find((r) => r.id === detailId) ?? null : null
  const subtitle = rulesTabByKey('automations')?.subtitle ?? ''

  // ── FB.2 — one bar. Exposure leads it, because it is the coarsest thing on the page and the
  //    band tiles above write it.
  //
  //    🔴 `__tile` carries no `value` accessor. The tile predicate is not a row property — 'writing'
  //    is `level==='AUTO' && writes` across three row KINDS, and 'unscoped' adds "bound to no
  //    market, portfolio, campaign or product". It is applied in `visible` before the grid sees a
  //    row, so an accessor here would be a second, weaker copy of that predicate.
  const filters: GridFilter[] = useMemo(() => [
    {
      key: '__tile', label: 'Exposure', kind: 'select', placeholder: 'Everything', wide: true,
      options: [
        { value: 'writing', label: `Writing to Amazon (${num(counts.writing + counts.engineAuto)})` },
        { value: 'unscoped', label: `Unscoped and writing (${num(counts.unscopedWriting + counts.engineAuto)})` },
        { value: 'off', label: `Off (${num(counts.off)})` },
      ],
    },
    // Rule-property filters. An ACTIVE selection names rule facts, so engine/observed rows
    // (whose accessor returns nothing) drop out while it is set — a filtered view never
    // silently carries rows the filter cannot describe.
    { key: 'category', label: 'Type', kind: 'multiselect', options: categoryOpts, placeholder: 'All types', wide: true, value: (a: unknown) => ((a as ActorRow).k === 'rule' ? (a as { r: Rule }).r.category : '') },
    {
      key: 'mode', label: 'Mode', kind: 'multiselect', placeholder: 'All modes', wide: true,
      options: [
        { value: 'AUTO', label: `Auto (${counts.auto})` },
        { value: 'PROPOSE', label: `Propose (${counts.propose})` },
        { value: 'OBSERVE', label: `Observe (${counts.observe})` },
        { value: 'OFF', label: `Off (${counts.off})` },
      ],
      value: (a: unknown) => ((a as ActorRow).k === 'rule' ? (a as { r: Rule }).r.level : ''),
    },
    {
      key: 'scopeKind', label: 'Rule scope', kind: 'select', placeholder: 'Any scope', wide: true,
      options: [
        { value: 'account', label: 'Whole account' },
        { value: 'portfolio', label: 'One portfolio' },
        { value: 'campaign', label: 'One campaign' },
      ],
      value: (a: unknown) => ((a as ActorRow).k === 'rule' ? (a as { r: Rule }).r.scope.kind : ''),
    },
    /**
     * W1 — provenance. "Legacy" = created before the 2026-08-20 cutover: seeded or
     * machine-created, none authored by the operator. The accessor returns '' for engine and
     * observed rows AND for rules whose payload predates W1 (no `legacy` field), so an active
     * selection never silently carries rows it cannot describe — the rule-property convention
     * stated above.
     */
    {
      key: 'provenance', label: 'Provenance', kind: 'select', placeholder: 'All rules', wide: true,
      options: [
        { value: 'legacy', label: 'Legacy', title: 'Created before 2026-08-20 — seeded or machine-created, not by you' },
        { value: 'current', label: 'Created by you', title: 'Created on or after 2026-08-20' },
      ],
      value: (a: unknown) => {
        if ((a as ActorRow).k !== 'rule') return ''
        const lg = (a as { r: Rule }).r.legacy
        return lg === true ? 'legacy' : lg === false ? 'current' : ''
      },
    },
  ], [categoryOpts, counts])

  const urlValues = useMemo(() => ({ __tile: tile ?? '' }), [tile])
  const onUrlChange = useCallback((next: Record<string, string>) => { applyTile(asTile(next.__tile)) }, [applyTile])
  const { filterState, setFilterState } = useMergedFilters({ urlValues, onUrlChange })

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Rules & Automation"
        subtitle={subtitle}
        markets={markets}
        market={market}
        onMarketChange={setMarket}
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
        primaryAction={{ label: 'Rule', icon: <Zap size={15} />, href: '/marketing/ads/rules-automation/builder' }}
      />
      <RulesTabs active="automations" />
      <StaleBanner stale={autoRefresh.stale} subject="A rule, a cap, a scope or the queue" onRefresh={() => { void load() }} />

      {/* FB.2 — ONE bar, at the top: controls, then the numbers they produce, then the rows. Only on
          the Actors view; Ledger, Queue and Limits mount different components with different rows,
          and a bar that filtered none of them would be a control that does nothing. */}
      {view === 'actors' && (
        <AdsFilterBar filters={filters} value={filterState} onChange={setFilterState} defaultOpen />
      )}

      {/* ── A1 — the exposure band. Every tile that can filter the grid IS a filter (aria-pressed,
             click again to clear); the two that cannot say why in their footline. ───────────── */}
      <div className="h10-au-census">
        <div className="h10-au-stat">
          <div className="k">Automations</div>
          <div className="v">{rules === null ? '…' : num(counts.total)}</div>
          <div className="s">
            {counts.neverRan > 0 ? `${counts.neverRan} have never evaluated once` : 'all have evaluated at least once'}
          </div>
        </div>
        <button type="button" className={`h10-au-stat tilebtn${tile === 'off' ? ' on' : ''}`} aria-pressed={tile === 'off'} onClick={() => setTileAndUrl('off')}>
          <div className="k">Off</div>
          <div className="v muted">{num(counts.off)}</div>
          <div className="s">rules that do not evaluate{counts.engineOff > 0 ? ` · ${counts.engineOff} engines off` : ''}</div>
        </button>
        <div className="h10-au-stat">
          <div className="k">Proposing</div>
          <div className="v">{num(counts.propose)}</div>
          <div className="s">
            {counts.observe > 0 ? `${counts.observe} observing · ` : ''}queue for you, never write
          </div>
        </div>
        {/* The emphasis, and it counts what can WRITE rather than what is on Auto. */}
        <button type="button" className={`h10-au-stat writing tilebtn${tile === 'writing' ? ' on' : ''}`} aria-pressed={tile === 'writing'} onClick={() => setTileAndUrl('writing')}>
          <div className="k">Writing to Amazon</div>
          <div className="v">{rules === null || actors === null ? '…' : num(counts.writing + counts.engineAuto)}</div>
          <div className="s">
            {num(counts.writing)} rules + {actors === null ? '…' : num(counts.engineAuto)} engines on Auto
            {counts.autoNotifyOnly > 0 && <> · {counts.autoNotifyOnly} more on Auto that only notifies</>}
          </div>
        </button>
        <button type="button" className={`h10-au-stat exposure tilebtn${tile === 'unscoped' ? ' on' : ''}`} aria-pressed={tile === 'unscoped'} onClick={() => setTileAndUrl('unscoped')}>
          <div className="k">Unscoped and writing</div>
          <div className="v">{rules === null || actors === null ? '…' : num(counts.unscopedWriting + counts.engineAuto)}</div>
          <div className="s">bound to no market, portfolio, campaign or product — the account&rsquo;s actual exposure</div>
        </button>
        <div className="h10-au-stat">
          <div className="k">Awaiting you</div>
          <div className="v">{pendingCount === null ? '—' : num(pendingCount)}</div>
          <div className="s">{pendingCount === null ? 'the queue could not be counted' : 'pending proposals — the inbox is A6’s build'}</div>
        </div>
        {counts.ready > 0 && (
          <div className="h10-au-stat ready">
            <div className="k">Ready to graduate</div>
            <div className="v">{num(counts.ready)}</div>
            <div className="s">you applied their proposals unchanged in {weeksRequired} weeks</div>
          </div>
        )}
      </div>

      {/* AUTO.A0 — the view switcher. Views land as they are built; Actors is D1's default. */}
      <div className="h10-au-viewrow">
        <SegmentedControl
          size="sm"
          value={view}
          onChange={(v) => setViewAndUrl(v as typeof view)}
          options={[
            { value: 'actors', label: 'Actors' },
            { value: 'ledger', label: 'Ledger' },
            { value: 'queue', label: pendingCount != null ? `Queue (${num(pendingCount)})` : 'Queue' },
            { value: 'limits', label: 'Limits' },
          ]}
        />
      </div>

      {err && <div className="h10-au-banner err" role="alert"><AlertTriangle size={15} aria-hidden /><span>{err}</span></div>}
      {note && <div className="h10-au-banner ok" role="status"><Info size={15} aria-hidden /><span>{note}</span></div>}

      {view === 'limits' && <LimitsView scopeOptions={scopeOptions} global={actors?.global ?? null} />}
      {view === 'ledger' && <LedgerView />}
      {/**
        * SG.6 — ONE inbox. This segment used to render its own queue (QueueView, now ⛔ PARKED):
        * the same endpoint, a third mental model, and decisions made here that the Suggestions
        * page could not explain — no delivery truth, no undo, no per-family columns. The count
        * stays, because "how much is waiting" belongs on the section's front page; the deciding
        * moved to the page built for it. RT.1's cross-page emit went with the verbs.
        */}
      {view === 'queue' && (
        <div className="h10-au-queueout">
          <p className="q">
            {pendingCount === null
              ? 'The queue could not be counted just now.'
              : pendingCount === 0
                ? 'Nothing is waiting for your approval.'
                : <><b>{num(pendingCount)}</b> proposed change{pendingCount === 1 ? '' : 's'} {pendingCount === 1 ? 'is' : 'are'} waiting for your approval.</>}
          </p>
          <p className="s">
            {/* {' '} after </em> and </b>: the build strips a plain space there ("Suggestions— the"). */}
            Rules set to <em>Manual</em>{' '}park their proposals in <b>Suggestions</b>{' '}— the review
            queue, with each family&rsquo;s own columns, the evidence behind every proposal, and what
            actually reached Amazon after you approve.
          </p>
          <Link className="h10-am-btn primary" href="/marketing/ads/suggestions">Open Suggestions</Link>
        </div>
      )}

      {view === 'actors' && counts.allFailing.length > 0 && (
        <div className="h10-au-banner warn">
          <AlertTriangle size={15} aria-hidden />
          <span>
            <b>{counts.allFailing.length} rule{counts.allFailing.length > 1 ? 's' : ''} failed every run this week and succeeded at nothing</b>
            {' '}— {counts.allFailing.slice(0, 2).map((r) => r.name).join(', ')}
            {counts.allFailing.length > 2 ? ` and ${counts.allFailing.length - 2} more` : ''}.
            A rule reports completed executions even when every action inside them fails, so the run
            count on its own reads as health.
          </span>
        </div>
      )}

      {view === 'actors' && (<>
      {protectedTerms === 0 && (
        <div className="h10-au-banner warn">
          <ShieldAlert size={15} aria-hidden />
          <span>
            No protected terms are configured, so every rule that negates search terms stays capped
            at Propose — otherwise a brand term could be negated with nothing to stop it.
          </span>
        </div>
      )}

      {conflictsData && conflictsData.byField.some((f) => f.contested > 0) && (
        <div className="h10-au-banner warn">
          <AlertTriangle size={15} aria-hidden />
          <span>
            <b>Contested fields, by entity:</b>{' '}
            {conflictsData.byField.filter((f) => f.contested > 0).map((f) => `${f.field} — ${num(f.contested)} of ${num(f.reachable)} campaigns have >1 actor`).join(' · ')}.
            {' '}Worst: {(() => {
              const w = conflictsData.byField.filter((f) => f.worst).sort((a, b) => (b.worst!.actors.length - a.worst!.actors.length))[0]
              return w?.worst ? `“${w.worst.name}” — ${w.worst.actors.length} actors can change its ${w.field}` : '—'
            })()}. Open a flagged rule to see its pairs.
          </span>
        </div>
      )}

      {conflictsData && conflictsData.cadence.length > 0 && (
        <div className="h10-au-banner warn">
          <AlertTriangle size={15} aria-hidden />
          <span>
            <b>{conflictsData.cadence.length} rule{conflictsData.cadence.length > 1 ? 's' : ''} compound{conflictsData.cadence.length === 1 ? 's' : ''} a percentage on evidence older than {'their'} tick</b>
            {' '}— {conflictsData.cadence.slice(0, 2).map((c) => `${c.name} (${c.pct > 0 ? '+' : ''}${c.pct}% on a ${c.windowDays}d window; ×${c.atCapFactor} at its cap in one day)`).join(' · ')}
            {conflictsData.cadence.length > 2 ? ` and ${conflictsData.cadence.length - 2} more` : ''}.
            The write cap bounds how often; only a baseline (BUD.2) stops the compounding itself.
          </span>
        </div>
      )}

      {grad.size > 0 && (
        <p className="h10-au-gradrule">
          <GraduationCap size={13} aria-hidden />
          <span>
            A rule is offered the <b>Auto</b> notch only after you have applied its proposals{' '}
            <strong>unchanged</strong> in {weeksRequired} separate weeks with no failures. Running
            cleanly is not the same evidence and never earns it — nor does any ceiling move: rules
            that create or destroy things stay gated whatever their history.
          </span>
        </p>
      )}

      {/* AUTO.A2 — the population switch. Counts are stated per kind so "All (63)" is a claim the
          grid can be checked against; a failed engines read says so instead of rendering 0. */}
      <div className="h10-au-kindrow">
        <SegmentedControl
          size="sm"
          value={kind}
          onChange={(v) => setKindAndUrl(v as ActorKind)}
          options={[
            { value: 'all', label: `All (${rows.length + (actors ? actors.engines.length + actors.observed.length : 0)})` },
            { value: 'rules', label: `Rules (${rows.length})` },
            { value: 'engines', label: `Engines (${actors ? actors.engines.length : '…'})` },
          ]}
        />
        {actorsErr && <span className="h10-au-actorserr" role="alert"><AlertTriangle size={12} aria-hidden /> {actorsErr} — the rules below are unaffected.</span>}
        {kind !== 'rules' && actors && actors.observed.length > 0 && (
          <span className="h10-au-obsnote">
            + {actors.observed.length} observed actor{actors.observed.length === 1 ? '' : 's'} the registry does not declare
          </span>
        )}
      </div>

      <AdsDataGrid<ActorRow>
        rows={gridRows}
        loading={rules === null}
        rowId={(a) => (a.k === 'rule' ? a.r.id : a.k === 'engine' ? `engine:${a.e.key}` : `obs:${a.o.actor}`)}
        noun="Actor"
        firstColLabel="Actor"
        renderFirst={renderFirst}
        firstSortValue={(a) => (a.k === 'rule' ? a.r.name : a.k === 'engine' ? a.e.name : a.o.actor)}
        columns={columns}
        customizable={false}
        searchable
        searchPlaceholder="Search actors…"
        searchValue={(a) => (a.k === 'rule'
          ? `${a.r.name} ${a.r.description ?? ''} ${a.r.trigger} ${a.r.categoryLabel} ${a.r.actionTypes.join(' ')}`
          : a.k === 'engine' ? `${a.e.name} ${a.e.what} engine` : `${a.o.actor} ${a.o.label}`)}
        selectable
        selected={sel}
        onSelectedChange={setSel}
        defaultSort={{ key: 'mode', dir: 'desc' }}
        pagerCentered
        rowClassName={(a) => (a.k === 'rule' && conflicts.has(a.r.id) ? 'h10-au-rowconf' : a.k !== 'rule' ? 'h10-au-rowactor' : undefined)}
        emptyLabel="No actors match this filter."
        filters={filters}
        filterState={filterState}
        onFilterStateChange={setFilterState}
        hideFilterPanel
        selectionActions={(ids, clear) => (
          <span className="h10-au-bulkrow">
            <span className="lbl">Set mode</span>
            {(['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as Level[]).map((lv) => (
              <button key={lv} type="button" className="h10-am-btn bulk" disabled={busy === 'bulk'} onClick={() => openBulk({ kind: 'mode', level: lv })}>
                {LEVEL_WORD[lv]}
              </button>
            ))}
            <button type="button" className="h10-am-btn bulk danger" disabled={busy === 'bulk'} onClick={() => openBulk({ kind: 'delete' })}>
              <Trash2 size={13} aria-hidden /> Delete
            </button>
            <button type="button" className="h10-am-link" onClick={clear}>Clear {ids.length}</button>
          </span>
        )}
      />
      </>)}

      {detail && (
        <RuleDetail
          rule={detail}
          scopeOptions={scopeOptions}
          readiness={grad.get(detail.id)}
          conflicts={conflicts.get(detail.id)}
          busy={busy === detail.id}
          onScope={(s) => void setScope(detail, s)}
          onHistory={() => { setHistoryRule({ id: detail.id, name: detail.name }); setDetailId(null) }}
          onClose={() => setDetailId(null)}
        />
      )}

      {historyRule && <HistoryDrawer rule={historyRule} onClose={() => setHistoryRule(null)} />}

      {engineKey && !bulk && (() => {
        const e = actors?.engines.find((x) => x.key === engineKey)
        return e ? <EngineDetail engine={e} onClose={() => setEngineKey(null)} /> : null
      })()}

      {bulk && (
        <div className="h10-ntm-back" onClick={() => setBulk(null)}>
          <div className="h10-ntm" role="dialog" aria-modal="true" aria-label={bulk.kind === 'delete' ? 'Delete automations' : 'Set mode'} onClick={(e) => e.stopPropagation()}>
            <div className="h10-ntm-h">
              <b>{bulk.kind === 'delete' ? `Delete ${sel.size} automation${sel.size === 1 ? '' : 's'}` : `Set ${sel.size} to ${LEVEL_WORD[bulk.level]}`}</b>
            </div>
            <div className="h10-ntm-sub">
              {bulk.kind === 'delete'
                ? 'Their execution history goes with them. This cannot be undone.'
                : bulkPreview && bulkPreview.refused > 0
                  ? `${bulkPreview.total - bulkPreview.refused} of ${bulkPreview.total} will change. ${bulkPreview.refused} sit above their graduation ceiling and the server will refuse them: ${bulkPreview.names.slice(0, 3).join(', ')}${bulkPreview.names.length > 3 ? '…' : ''}.`
                  : `All ${bulkPreview?.total ?? sel.size} will change. Each is checked against its own ceiling by the server.`}
              {nonRuleSel > 0 && ` ${nonRuleSel} selected ${nonRuleSel === 1 ? 'row is not a rule' : 'rows are not rules'} (engines/observed) and will be skipped — their posture is not set from this page.`}
            </div>
            {bulk.kind === 'mode' && bulk.level === 'AUTO' && bulkPreview && bulkPreview.willWrite > 0 && (
              <div className="h10-ntm-b">
                <p className="h10-au-note danger">
                  <ShieldAlert size={13} aria-hidden />
                  <span>
                    <b>{bulkPreview.willWrite} of these can change real campaigns.</b> On Auto they act
                    without asking, inside their daily caps and the account write gate.
                  </span>
                </p>
              </div>
            )}
            <div className="h10-ntm-f">
              <button type="button" className="cancel" onClick={() => setBulk(null)}>Cancel</button>
              <span className="grow" />
              <button type="button" className={`apply ${bulk.kind === 'delete' ? 'danger' : ''}`} disabled={busy === 'bulk'} onClick={() => void doBulk()}>
                {busy === 'bulk' ? 'Working…' : bulk.kind === 'delete' ? 'Delete' : `Set ${LEVEL_WORD[bulk.level]}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
