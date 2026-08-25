'use client'

/**
 * SG.1 — the Suggestions page, rebuilt as the console's one review queue.
 *
 * The page is the halfway point of the rule pipeline: a rule on Manual control computes its
 * action and parks it here as an AdsRuleSuggestion; this page is where the operator audits the
 * math, approves the winners and dismisses the anomalies. H10's shape, on our substrate:
 *
 *   · type views (A.I. Bids · Bids · New Keywords · Negative Keywords · Budget · Placement),
 *     H10's tabs, as a SegmentedControl whose counts come from the SERVER's family map — every
 *     row carries `family`, computed once in ads-suggestions.service.ts, never re-derived here.
 *   · status tabs (Pending · Applied · Dismissed · Expired) — `expired` is SG.0's lifecycle:
 *     a pending row the engine stops re-proposing leaves the queue on its own.
 *   · ONE filter bar (`AdsFilterBar` + `buildScopeFilters` + `useMergedFilters`) with the scope
 *     grains resolved SERVER-side, so the grid, the money tiles and the pricing endpoint always
 *     describe the same rows.
 *   · a cursor poll + StaleBanner instead of the SSE bus (which carries 0.21% of writes and is
 *     blind to the engines) — the banner offers, it never reorders rows under a reading operator.
 *   · bulk approve/dismiss/restore through ONE server round trip with a PER-ROW outcome report
 *     that stays on screen until dismissed — a partial result names which rows were refused and
 *     why, instead of dissolving into a count (the W2 popover lesson).
 *
 * Everything shareable lives in the URL: ?view= ?status= ?market= ?line/portfolio/campaign/
 * adGroup= ?rule= ?row= — a copied link reproduces the view you are looking at.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Check, X, RefreshCw, Sparkles, ExternalLink, RotateCcw, Pause, Volume2, Settings } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter, type FilterState } from '../campaigns/_grid/AdsDataGrid'
import { RecommendationsView } from './RecommendationsView'
import { AdsBidSettingsModal } from '../_shared/AdsBidSettingsModal'
import { AdsFilterBar } from '../campaigns/_grid/AdsFilterBar'
import { buildScopeFilters, scopeToFilterState, scopePatchFromFilterState, type ScopeOptionsPayload, type ScopeValue } from '../rules-automation/_shared/scopeFilters'
import { useMergedFilters } from '../rules-automation/_shared/useMergedFilters'
import { useCursorPoll, useCursorBaseline } from '../rules-automation/_shared/useCursorPoll'
import { StaleBanner } from '../rules-automation/_shared/StaleBanner'
import { ScopeNotes } from '../rules-automation/_shared/ScopeNotes'
import { Button } from '@/design-system/primitives/Button'
import { Tag } from '@/design-system/primitives/Tag'
import { Select } from '@/design-system/primitives/Select'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Tabs, type TabItem } from '@/design-system/components/Tabs'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { dash, eur, AcosCell, RoasCell, ACOS_DOT_TIP, ROAS_DOT_TIP } from './cells'
/**
 * SGX (2026-08-24) — this file held seven tabs in 2,447 lines. The payload shapes, the
 * presentational cells, the two drawers and the A.I. change readers are now their own modules,
 * moved verbatim. What stays here is the SHELL: URL state, the one fetch that feeds all five
 * family tabs, the staging buffer, the filter bar, the column assemblies and the bulk verbs —
 * the things that genuinely span the tabs and are the reason this is one route rather than seven.
 */
import {
  ACTION_LABEL, ENTITY_LABEL, FAMILY_RULE_ROUTE, MARKETS, VIEWS, ageDays, ago, srcOf,
  type AiDecision, type BulkReport, type GroupKey, type Pricing, type Status, type Suggestion,
} from './_shared/types'
import { aiChangeText, aiHoverContent } from './_shared/aiText'
import {
  ApproveHover, BufferInput, ImpactCell, ProposedCell, RuleCell, SourceCell, StakeCell,
  impactScore, mCpc, mEur, mInt, mPct, prettyTrigger,
} from './_shared/rowCells'
import { AiDecisionDrawer, SuggestionDrawer } from './_views/drawers'
import { ApproveHoverCard } from './ApproveHoverCard'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './suggestions.css'

function SuggestionsInner() {
  const router = useRouter()
  const params = useSearchParams()
  const { toast } = useToast()

  // ── URL state — the source of truth for everything shareable ──────────────
  const viewParam = params.get('view')
  const status = (['pending', 'applied', 'dismissed', 'expired', 'muted'].includes(params.get('status') ?? '') ? params.get('status') : 'pending') as Status
  const market = params.get('market') ?? 'all'
  const scope: ScopeValue = {
    line: params.get('line') ?? '',
    portfolio: params.get('portfolio') ?? '',
    campaign: params.get('campaign') ?? '',
    adGroup: params.get('adGroup') ?? '',
  }
  const ruleParam = params.get('rule') ?? ''
  const rowParam = params.get('row')

  const writeUrl = useCallback((patch: Record<string, string>, opts?: { history?: boolean }) => {
    const next = new URLSearchParams(params.toString())
    const DEFAULTS: Record<string, string> = { view: 'bids', status: 'pending', market: 'all' }
    for (const [k, v] of Object.entries(patch)) {
      if (!v || v === DEFAULTS[k]) next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    // replace for filters/views (three clicks must not stack three history entries);
    // push for opening a drawer, so Back closes it.
    if (opts?.history) router.push(qs ? `?${qs}` : '?', { scroll: false })
    else router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  // ── data ──────────────────────────────────────────────────────────────────
  const [items, setItems] = useState<Suggestion[]>([])
  /**
   * 🔴 SGX — `?rule=` used to dead-end on an empty Bids tab.
   *
   * The Rules & Automation grid links a rule's "N waiting" count here (`RulesGrid.tsx`) carrying
   * only `?rule=<id>`, and `view` defaulted to `'bids'`. So a harvest rule with two waiting rows
   * landed on Bids, which said **"No bid suggestions right now — Create a Bid rule"**: the
   * operator was told to create a rule that already exists and already has suggestions waiting,
   * while the New Keywords tab beside it showed the pill "2". Verified on prod before the fix.
   *
   * With no explicit `?view=`, a rule-scoped link now resolves to the tab that actually HOLDS
   * that rule's rows — the busiest one, since a single rule can produce several families.
   * DERIVED, never written to the URL: a redirect would fight the operator's own tab clicks, and
   * clicking any tab sets `?view=`, which takes precedence from then on.
   */
  const ruleView = useMemo(() => {
    if (viewParam || !ruleParam) return null
    const tally = new Map<string, number>()
    for (const s of items) if (s.ruleId === ruleParam) tally.set(s.family, (tally.get(s.family) ?? 0) + 1)
    const best = [...tally].sort((a, b) => b[1] - a[1])[0]
    if (!best) return null
    return VIEWS.find((v) => v.family === best[0])?.key ?? (best[0] === 'other' ? 'other' : null)
  }, [viewParam, ruleParam, items])
  const view = viewParam ?? ruleView ?? 'bids'
  const [families, setFamilies] = useState<Record<string, number>>({})
  /** The tab pills — PENDING counts per family (the queue), whatever status is on screen. */
  const [pendingFamilies, setPendingFamilies] = useState<Record<string, number> | null>(null)
  // SG.4 — the A.I. Bids tab: PROPOSED autopilot decisions (source ≠ 'rule-setting'). Count on
  // the pill; rows fetched lazily on entering the view. null = not fetched, never a confident 0.
  const [aiBidsCount, setAiBidsCount] = useState<number | null>(null)
  const [aiItems, setAiItems] = useState<AiDecision[] | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  // SG.5 — the Bid Settings gear (shared modal; mounts on the bid-relevant views).
  const [bidSettingsOpen, setBidSettingsOpen] = useState(false)
  /**
   * SG.7/SG.8 — the A.I. view's Filters card, so the tab wears the page's one anatomy (tabs →
   * Filters → grid). Honest facets only: a decision carries its campaign, module, action and
   * plan — no scope grains (the notesSlot states why), cut client-side at this volume.
   * SG.8 adds the Status axis (Proposed | Applied | Dismissed), URL-owned via ?status= like
   * every other view, and the staging buffer behind the ✓/✕ verbs.
   */
  const aiStatus = status === 'applied' ? 'applied' : status === 'dismissed' ? 'dismissed' : status === 'muted' ? 'muted' : 'proposed'
  /** ✓/✕ stage; [Apply N Changes] commits the batch — no per-row € override here (a bid
   *  approve re-runs the plan's optimizer, so there is no single figure to edit). */
  const [aiStaged, setAiStaged] = useState<Map<string, 'apply' | 'remove' | 'mute'>>(new Map())
  const aiStage = useCallback((id: string, kind: 'apply' | 'remove' | 'mute') => {
    setAiStaged((cur) => {
      const next = new Map(cur)
      if (next.get(id) === kind) next.delete(id)
      else next.set(id, kind)
      return next
    })
  }, [])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [pricing, setPricing] = useState<Pricing | null>(null)
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [group, setGroup] = useState<GroupKey>('none')
  /**
   * SG.2b — H10's STAGING BUFFER, adopted exactly from the reference recording:
   *
   *   ✓ stages an ACCEPT — the row's value input fills with the suggested value and becomes
   *     editable (↺ restores the suggestion); nothing is written yet.
   *   ✕ stages a REMOVAL ("Remove suggestion until a new one is generated").
   *   [Apply N Changes] commits the WHOLE staged batch — accepts (with any inline overrides)
   *     and removals together, one server round trip. [Discard Changes] clears the buffer.
   *
   * The pending grid therefore has NO checkbox column — the verbs are the selection. The
   * Dismissed/Expired tabs keep checkboxes for bulk Restore.
   */
  type StagedEntry = { kind: 'apply' | 'remove' | 'mute'; value?: number }
  const [staged, setStaged] = useState<Map<string, StagedEntry>>(new Map())
  const stage = useCallback((id: string, kind: 'apply' | 'remove' | 'mute') => {
    setStaged((cur) => {
      const next = new Map(cur)
      const existing = next.get(id)
      if (existing?.kind === kind) next.delete(id) // second click un-stages
      else next.set(id, { kind }) // switching verb replaces (drops any typed override)
      return next
    })
  }, [])
  const setStagedValue = useCallback((id: string, value: number | undefined) => {
    setStaged((cur) => {
      const e = cur.get(id)
      if (!e || e.kind !== 'apply') return cur
      const next = new Map(cur)
      next.set(id, { kind: 'apply', value })
      return next
    })
  }, [])
  /** the Dismissed/Expired tabs' checkbox selection (bulk Restore) — separate from staging */
  const [sel, setSel] = useState<Set<string>>(new Set())
  useEffect(() => { setSel(new Set()); setStaged(new Map()); setAiStaged(new Map()) }, [view, status])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkReport, setBulkReport] = useState<BulkReport | null>(null)
  const [reload, setReload] = useState(0)
  /**
   * Bumped after every successful decide of our own, WITHOUT bumping `reload`: the cursor
   * baseline re-reads (so the StaleBanner cannot cry about our own write) while the rows stay
   * exactly where the operator's j/k position left them — a refetch mid-triage would re-sort
   * the queue under their cursor.
   */
  const [baselineKey, setBaselineKey] = useState(0)

  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/scope-options`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.campaigns)) setOptions(d as ScopeOptionsPayload) })
      .catch(() => { /* the pickers degrade to empty; the grid does not depend on them */ })
    return () => { alive = false }
  }, [])

  const scopeQs = useMemo(() => {
    const q = new URLSearchParams()
    if (market !== 'all') q.set('market', market)
    if (scope.line) q.set('line', scope.line)
    if (scope.portfolio) q.set('portfolio', scope.portfolio)
    if (scope.campaign) q.set('campaign', scope.campaign)
    if (scope.adGroup) q.set('adGroup', scope.adGroup)
    return q.toString()
  }, [market, scope.line, scope.portfolio, scope.campaign, scope.adGroup])

  const load = useCallback(async () => {
    try {
      // ONE fetch per status+scope: every row carries its server-computed `family`, so switching
      // type tabs is a client-side cut and the tab counts (`families`) describe the same fetch.
      // limit=1000 is the endpoint's ceiling; `total` beside it is what keeps a capped list honest.
      const j = await fetch(`${getBackendUrl()}/api/advertising/suggestions?status=${status}&limit=1000${scopeQs ? `&${scopeQs}` : ''}`).then((r) => r.json())
      setItems(Array.isArray(j?.items) ? j.items : [])
      setTotal(typeof j?.total === 'number' ? j.total : null)
      setFamilies(j?.families && typeof j.families === 'object' ? j.families : {})
    } catch { setItems([]); setTotal(null); setFamilies({}) } finally { setLoading(false) }
    // The tab pills are the QUEUE (pending counts), independent of the status on screen —
    // switching to Applied must not blank the numbers on the tabs. Fails soft to null (no pill),
    // never to 0: an unfetchable count is unknown, and 0 is a real answer.
    try {
      const c = await fetch(`${getBackendUrl()}/api/advertising/suggestions/count`).then((r) => r.json())
      setPendingFamilies(c?.families && typeof c.families === 'object' ? c.families : null)
      setAiBidsCount(typeof c?.aiBids === 'number' ? c.aiBids : null)
    } catch { setPendingFamilies(null) }
    // ACR.4.4 — pricing is a separate, slower call and only means anything for pending rows.
    // Fetched AFTER the list and never awaited by it: an unpriced grid is a degraded page, an
    // empty one is a broken page. It carries the SAME scope params, resolved by the same server
    // function, so the tiles cannot describe different rows from the grid.
    if (status !== 'pending') { setPricing(null); return }
    try {
      const p = await fetch(`${getBackendUrl()}/api/advertising/suggestions/pricing${scopeQs ? `?${scopeQs}` : ''}`).then((r) => r.json())
      setPricing(p?.byId ? (p as Pricing) : null)
    } catch { setPricing(null) }
  }, [status, scopeQs])
  useEffect(() => { setLoading(true); void load() }, [load, reload])

  // SG.4/SG.8 — the A.I. view's rows, fetched on entry, on Refresh (`reload`) and per status
  // view. The verbs are SG.8's decision routes; approve runs the same engine an AUTO plan does.
  useEffect(() => {
    if (view !== 'ai') return
    let alive = true
    setAiLoading(true)
    const aiUrl = status === 'muted'
      ? `${getBackendUrl()}/api/advertising/ai-decisions/mutes`
      : `${getBackendUrl()}/api/advertising/ai-decisions?status=${status === 'applied' ? 'applied' : status === 'dismissed' ? 'dismissed' : 'proposed'}`
    fetch(aiUrl, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setAiItems(Array.isArray(j?.items) ? j.items : []) })
      .catch(() => { if (alive) setAiItems(null) })
      .finally(() => { if (alive) setAiLoading(false) })
    return () => { alive = false }
  }, [view, reload, status])

  // After a write the acted rows are patched out locally (a full reload would lose the j/k
  // position), but the tab pills come from /count — refetch just that, so the pills tell the
  // server's truth instead of holding the pre-write number until the next full load.
  const refreshCounts = useCallback(async () => {
    try {
      const c = await fetch(`${getBackendUrl()}/api/advertising/suggestions/count`, { cache: 'no-store' }).then((r) => r.json())
      setPendingFamilies(c?.families && typeof c.families === 'object' ? c.families : null)
      // SG.8 — the A.I. pill must move too: approve/dismiss changes the PROPOSED population.
      setAiBidsCount(typeof c?.aiBids === 'number' ? c.aiBids : null)
    } catch { /* the pill keeps its last honest value; the next load corrects it */ }
  }, [])

  // ── live updates: cursor poll + StaleBanner, never the SSE bus ────────────
  // The cursor is a fingerprint of the QUEUE's membership (account-wide — a queue change outside
  // the current scope still matters, because the tab counts include it). Paused while the drawer
  // is open or a bulk write is in flight (RA.SPINE S2).
  const cursorUrl = `${getBackendUrl()}/api/advertising/suggestions/cursor`
  const baseline = useCursorBaseline<{ pending: number; fp: string }>(cursorUrl, {}, `${reload}:${baselineKey}`)
  const detail = rowParam ? items.find((s) => s.id === rowParam) ?? null : null
  const aiDetail = rowParam ? (aiItems ?? []).find((d) => d.id === rowParam) ?? null : null
  const { stale } = useCursorPoll<{ pending: number; fp: string }>({
    url: cursorUrl, params: {}, baseline, enabled: !detail && !bulkBusy,
  })

  // SG.7 — the A.I. facets, from the loaded rows (an option that matches nothing is a lie).
  // SG.8 — Status heads the card (family placement): Proposed is the live queue; Applied is
  // the decided history (operator approvals AND an AUTO plan's own writes); Dismissed waits
  // out the 7-day suppression window.
  const aiFilters = useMemo<GridFilter[]>(() => {
    const rows = aiItems ?? []
    const opts = (get: (r: AiDecision) => string | null, labelOf?: (v: string, r: AiDecision) => string) => {
      const seen = new Map<string, string>()
      for (const r of rows) { const v = get(r); if (v && !seen.has(v)) seen.set(v, labelOf ? labelOf(v, r) : v) }
      return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
    }
    return [
      {
        key: '__status', label: 'Status', kind: 'select', placeholder: 'Proposed',
        options: [{ value: 'applied', label: 'Applied' }, { value: 'dismissed', label: 'Dismissed' }, { value: 'muted', label: 'Muted' }],
        tip: 'Proposed is the live queue (the plan re-evaluates it every 15 minutes). Applied is the decided history — your approvals and an AUTO plan’s own writes, each row carrying its real outcome. Dismissed proposals stay suppressed for 7 days, then may return. Muted campaigns keep running — the plans simply stop proposing for them.',
      },
      { key: 'aiCampaign', label: 'Campaign', kind: 'select', wide: true, searchable: true, placeholder: 'All campaigns', options: opts((r) => r.campaignId, (v, r) => r.campaignName ?? v), value: (r) => (r as AiDecision).campaignId ?? '' },
      // A mute row carries only its campaign — module/action/plan facets would be empty
      // selects that narrow nothing, so this view does not render them.
      ...(aiStatus === 'muted' ? [] : [
        { key: 'aiModule', label: 'Module', kind: 'select', placeholder: 'All modules', options: opts((r) => r.module), value: (r) => (r as AiDecision).module },
        { key: 'aiAction', label: 'Action', kind: 'select', placeholder: 'All actions', options: opts((r) => r.action, (v) => v.replace(/_/g, ' ').toLowerCase()), value: (r) => (r as AiDecision).action },
        { key: 'aiPlan', label: 'Plan', kind: 'select', placeholder: 'All plans', options: opts((r) => r.planId, (v, r) => r.planName ?? v), value: (r) => (r as AiDecision).planId },
      ] as GridFilter[]),
    ]
  }, [aiItems, aiStatus])
  const aiUrlValues = useMemo<FilterState>(
    () => ({ __status: aiStatus === 'proposed' ? '' : aiStatus }),
    [aiStatus],
  )
  const onAiUrlChange = useCallback((patch: Record<string, string>) => {
    writeUrl({ status: patch.__status ?? '', row: '' })
  }, [writeUrl])
  const { filterState: aiFilterState, setFilterState: setAiFilterState } = useMergedFilters({ urlValues: aiUrlValues, onUrlChange: onAiUrlChange })

  // ── the view cut (client-side, over the server-attached family) ───────────
  const activeView = VIEWS.find((v) => v.key === view) ?? (view === 'other' ? { key: 'other', label: 'Other', family: 'other', noun: 'other' } : VIEWS[1])
  const viewRows = useMemo(
    () => (activeView.family ? items.filter((s) => s.family === activeView.family) : []),
    [items, activeView.family],
  )

  const post = useCallback((id: string, kind: 'apply' | 'dismiss' | 'restore', body?: Record<string, unknown>) =>
    fetch(`${getBackendUrl()}/api/advertising/suggestions/${id}/${kind}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST' })
      .then(async (r): Promise<{ ok: boolean; refused?: boolean; error?: string }> =>
        (r.ok ? (await r.json()) as { ok: boolean; refused?: boolean; error?: string } : { ok: false, error: `HTTP ${r.status}` }))
      .catch((): { ok: boolean; refused?: boolean; error?: string } => ({ ok: false, error: 'network' })), [])

  // Undo a dismiss (single or bulk): restore the rows to pending, then reload.
  const restore = useCallback(async (ids: string[]) => {
    await Promise.all(ids.map((id) => post(id, 'restore')))
    setReload((n) => n + 1)
  }, [post])

  const act = useCallback(async (id: string, kind: 'apply' | 'dismiss' | 'restore', overrideValue?: number) => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const body = kind === 'apply' && overrideValue != null ? { value: overrideValue } : undefined
      const res = await post(id, kind, body)
      if (res.ok) {
        setItems((cur) => cur.filter((s) => s.id !== id))
        // The row left THIS status's population: keep `total` honest (it feeds the truncation
        // notice, which otherwise reads "Showing 0 of 1 — capped" after a local removal) and
        // re-baseline the cursor so the StaleBanner cannot announce our own write.
        setTotal((t) => (t == null ? t : Math.max(0, t - 1)))
        setBaselineKey((n) => n + 1)
        void refreshCounts()
        if (kind === 'dismiss') toast(<>Removed — back when a new suggestion is generated · <button type="button" className="h10-am-link" onClick={() => void restore([id])}>Undo</button></>, 'info', { duration: 8000 })
        else if (kind === 'restore') toast('Restored to pending', 'success')
        else toast(<>Change applied{overrideValue != null ? ' with your edit' : ''}. It may take a few minutes to complete — view it in the <Link className="h10-am-link" href="/marketing/ads/changelog">Change Log</Link>.</>, 'success')
      } else if (res.refused) {
        // SG.0 — a refusal is a governed stop, in the server's words. The row STAYS pending.
        toast(<>Refused — {res.error ?? 'the write gate declined this action'}</>, 'danger')
      } else if (res.error) {
        toast(`Could not ${kind}: ${res.error}`, 'danger')
      }
    } finally { setBusy((b) => { const n = { ...b }; delete n[id]; return n }) }
  }, [post, toast, restore, refreshCounts])

  /**
   * SG.2/SG.9 — the REAL pause: a status write on the underlying target, allowed because it is
   * operator-clicked (the no-pause policy binds the ENGINE). It is no longer the grid's ⏸ —
   * that icon now carries H10's own meaning, "stop suggesting for this" — so this lives in the
   * row drawer, which arms it there. A refusal at the gate comes back in the server's words
   * and the row stays pending.
   */
  const pauseTarget = useCallback(async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/suggestions/${id}/pause-target`, { method: 'POST' })
        .then(async (r): Promise<{ ok: boolean; refused?: boolean; error?: string }> =>
          (r.ok ? (await r.json()) as { ok: boolean; refused?: boolean; error?: string } : { ok: false, error: (await r.json().catch(() => null) as { error?: string } | null)?.error ?? `HTTP ${r.status}` }))
        .catch((): { ok: boolean; refused?: boolean; error?: string } => ({ ok: false, error: 'network' }))
      if (res.ok) {
        setItems((cur) => cur.filter((s) => s.id !== id))
        setTotal((t) => (t == null ? t : Math.max(0, t - 1)))
        setBaselineKey((n) => n + 1)
        void refreshCounts()
        toast('Target paused — the suggestion is set aside under Dismissed', 'success')
      } else if (res.refused) {
        toast(<>Pause refused — {res.error}</>, 'danger')
      } else {
        toast(`Could not pause: ${res.error}`, 'danger')
      }
    } finally { setBusy((b) => { const n = { ...b }; delete n[id]; return n }) }
  }, [toast, refreshCounts])

  /**
   * SG.3 — Undo an applied change, two-step like every real Amazon write here: the FIRST click
   * fetches the rollback preview (eligibility in the service's own words + how many rows the
   * change set reverses together) and arms the button; the SECOND click executes. An ineligible
   * change never arms — the reason lands as a toast instead of a doomed request.
   */
  const [armedUndo, setArmedUndo] = useState<{ id: string; note: string } | null>(null)
  useEffect(() => {
    if (!armedUndo) return
    const t = setTimeout(() => setArmedUndo(null), 6000)
    return () => clearTimeout(t)
  }, [armedUndo])
  const armUndo = useCallback(async (s: Suggestion) => {
    if (!s.undo) return
    setBusy((b) => ({ ...b, [s.id]: true }))
    try {
      const p = await fetch(`${getBackendUrl()}/api/advertising/changes/${s.undo.actionLogId}/undo-preview`, { cache: 'no-store' })
        .then((r) => r.json()).catch(() => null) as { eligible?: boolean; reason?: string; groupedWith?: number } | null
      if (!p?.eligible) {
        toast(p?.reason ?? 'No undo is offered for this row here', 'info')
        return
      }
      setArmedUndo({ id: s.id, note: p.groupedWith && p.groupedWith > 1 ? `Reverses ${p.groupedWith} grouped changes together — click again to undo` : 'Click again to undo this change at Amazon' })
    } finally { setBusy((b) => { const n = { ...b }; delete n[s.id]; return n }) }
  }, [toast])
  const doUndo = useCallback(async (s: Suggestion) => {
    if (!s.undo) return
    setArmedUndo(null)
    setBusy((b) => ({ ...b, [s.id]: true }))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes/${s.undo.actionLogId}/undo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: `undo from the Suggestions queue (suggestion ${s.id})` }),
      })
      const j = await r.json().catch(() => null) as { ok?: boolean; reversed?: number; reason?: string; error?: string } | null
      if (r.ok && j?.ok !== false) {
        setItems((cur) => cur.map((x) => (x.id === s.id && x.undo ? { ...x, undo: { ...x.undo, rolledBack: true } } : x)))
        setBaselineKey((n) => n + 1)
        toast(<>Change undone{j?.reversed && j.reversed > 1 ? ` (${j.reversed} grouped rows reversed)` : ''}. The reversal is a change like any other — it is in the <Link className="h10-am-link" href="/marketing/ads/changelog">Change Log</Link>.</>, 'success')
      } else {
        toast(j?.reason ?? j?.error ?? 'The undo was declined', 'danger')
      }
    } finally { setBusy((b) => { const n = { ...b }; delete n[s.id]; return n }) }
  }, [toast])

  /** One bulk call; shared by the staged batch and the Restore-N path. The per-row outcome
   *  report renders OUTSIDE any popover so a partial result survives it (W2). */
  const runOps = useCallback(async (
    ops: Array<{ id: string; kind: 'apply' | 'dismiss' | 'restore' | 'mute' | 'unmute'; value?: number; resultBidCents?: number; resultBudgetEur?: number }>,
    onDone?: () => void,
  ) => {
    if (!ops.length || bulkBusy) return
    setBulkBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/suggestions/bulk`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }),
      })
      const j = (await r.json()) as { okCount?: number; results?: Array<{ id: string; kind: string; ok: boolean; refused?: boolean; error?: string }> }
      if (!r.ok) { toast(`Could not apply the changes: ${(j as { error?: string })?.error ?? r.status}`, 'danger'); return }
      const results = j.results ?? []
      const okIds = results.filter((x) => x.ok).map((x) => x.id)
      const labelById = new Map(items.map((s) => [s.id, srcOf(s).label]))
      const refusals = results.filter((x) => !x.ok).map((x) => ({ id: x.id, label: labelById.get(x.id) ?? x.id, error: x.error ?? 'failed' }))
      setItems((cur) => cur.filter((s) => !okIds.includes(s.id)))
      setTotal((t) => (t == null ? t : Math.max(0, t - okIds.length)))
      setBaselineKey((n) => n + 1)
      void refreshCounts()
      const appliedOk = results.filter((x) => x.ok && x.kind === 'apply').length
      const removedOk = results.filter((x) => x.ok && x.kind === 'dismiss').map((x) => x.id)
      const restoredOk = results.filter((x) => x.ok && x.kind === 'restore').length
      const mutedOk = results.filter((x) => x.ok && x.kind === 'mute').length
      const unmutedOk = results.filter((x) => x.ok && x.kind === 'unmute').length
      if (refusals.length === 0 && (mutedOk > 0 || unmutedOk > 0) && appliedOk === 0 && !removedOk.length) {
        // SG.9 — the mute is a producer-side stop, and the copy has to say the entity is
        // still running or "paused" is exactly what the operator will assume.
        if (mutedOk > 0) {
          toast(<>Muted {mutedOk} — nothing was changed at Amazon; the {mutedOk === 1 ? 'target keeps' : 'targets keep'} running and we stop suggesting for {mutedOk === 1 ? 'it' : 'them'}. Find {mutedOk === 1 ? 'it' : 'them'} under Status → Muted.</>, 'success')
        } else {
          toast(`Unmuted ${unmutedOk} — suggestions resume on the next evaluation`, 'success')
        }
        onDone?.()
        return
      }
      if (refusals.length === 0) {
        if (appliedOk > 0) {
          // H10's own honest copy — an apply is enqueued, not instant, and the receipt lives
          // in the Change Log.
          toast(<>
            Applied {appliedOk} {appliedOk === 1 ? 'change' : 'changes'}{removedOk.length ? <> · removed {removedOk.length}</> : null}.
            Changes may take a few minutes to complete — view them in the <Link className="h10-am-link" href="/marketing/ads/changelog">Change Log</Link>.
          </>, 'success')
        } else if (removedOk.length) {
          toast(<>Removed {removedOk.length} — back when a new suggestion is generated · <button type="button" className="h10-am-link" onClick={() => void restore(removedOk)}>Undo</button></>, 'info', { duration: 8000 })
        } else if (restoredOk) {
          toast(`Restored ${restoredOk} to pending`, 'success')
        }
      } else {
        setBulkReport({
          verb: appliedOk || ops.some((o) => o.kind === 'apply') ? 'Applied' : restoredOk ? 'Restored' : 'Removed',
          ok: okIds.length, fail: refusals.length, refusals,
          undoIds: removedOk.length ? removedOk : undefined,
        })
      }
      onDone?.()
    } catch { toast('Could not apply the changes', 'danger') } finally { setBulkBusy(false) }
  }, [bulkBusy, items, toast, restore, refreshCounts])

  /** Commit the staged buffer: accepts (with inline overrides that differ from the projection)
   *  and removals, one batch — H10's [Apply N Changes]. */
  const applyStaged = useCallback(() => {
    const ops: Array<{ id: string; kind: 'apply' | 'dismiss' | 'mute'; resultBidCents?: number; resultBudgetEur?: number }> = []
    for (const [id, e] of staged) {
      if (e.kind === 'remove') { ops.push({ id, kind: 'dismiss' }); continue }
      if (e.kind === 'mute') { ops.push({ id, kind: 'mute' }); continue }
      const row = items.find((s) => s.id === id)
      const projBid = row?.suggested?.bidCents ?? null
      const projBud = row?.suggested?.budgetEur ?? null
      const op: { id: string; kind: 'apply'; resultBidCents?: number; resultBudgetEur?: number } = { id, kind: 'apply' }
      if (e.value != null && projBid != null && Math.round(e.value * 100) !== projBid) op.resultBidCents = Math.round(e.value * 100)
      else if (e.value != null && projBud != null && e.value !== projBud) op.resultBudgetEur = e.value
      ops.push(op)
    }
    void runOps(ops, () => setStaged(new Map()))
  }, [staged, items, runOps])

  /** SG.8 — undo an A.I. removal / restore dismissed decisions: bulk restore, then refetch
   *  (a restored row rejoins the proposed queue, which the local patch-out cannot show). */
  const aiRestore = useCallback(async (ids: string[]) => {
    await fetch(`${getBackendUrl()}/api/advertising/ai-decisions/bulk`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: ids.map((id) => ({ id, kind: 'restore' })) }),
    }).catch(() => null)
    setReload((n) => n + 1)
  }, [])

  /**
   * SG.8 — the A.I. staging bar's one round trip (and the dismissed view's Restore N),
   * mirroring `runOps`: per-row outcomes, refusals into the report banner that survives
   * (W2), toasts in the page's one copy family. Approve outcomes are the SERVER's words:
   * 'applied' wrote through the AUTO engine; 'skipped' settled with nothing to change.
   */
  const aiRunOps = useCallback(async (
    ops: Array<{ id: string; kind: 'approve' | 'dismiss' | 'restore' | 'mute' }>,
    onDone?: () => void,
  ) => {
    if (!ops.length || bulkBusy) return
    setBulkBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/ai-decisions/bulk`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }),
      })
      const j = (await r.json()) as { okCount?: number; results?: Array<{ id: string; kind: string; ok: boolean; refused?: boolean; outcome?: string; error?: string }> }
      if (!r.ok) { toast(`Could not apply the changes: ${(j as { error?: string })?.error ?? r.status}`, 'danger'); return }
      const results = j.results ?? []
      const okIds = results.filter((x) => x.ok).map((x) => x.id)
      const labelById = new Map((aiItems ?? []).map((d) => [d.id, d.campaignName ?? d.planName ?? d.id]))
      const refusals = results.filter((x) => !x.ok).map((x) => ({ id: x.id, label: labelById.get(x.id) ?? x.id, error: x.error ?? 'failed' }))
      setAiItems((cur) => (cur ?? []).filter((d) => !okIds.includes(d.id)))
      void refreshCounts()
      const appliedOk = results.filter((x) => x.ok && x.kind === 'approve' && x.outcome === 'applied').length
      const skippedOk = results.filter((x) => x.ok && x.kind === 'approve' && x.outcome === 'skipped').length
      const removedOk = results.filter((x) => x.ok && x.kind === 'dismiss').map((x) => x.id)
      const restoredOk = results.filter((x) => x.ok && x.kind === 'restore').length
      const mutedOk = results.filter((x) => x.ok && x.kind === 'mute').length
      if (refusals.length === 0 && mutedOk > 0 && appliedOk === 0 && !removedOk.length) {
        toast(<>Muted {mutedOk} {mutedOk === 1 ? 'campaign' : 'campaigns'} — nothing was changed at Amazon; {mutedOk === 1 ? 'it keeps' : 'they keep'} running and the plans stop proposing. Find {mutedOk === 1 ? 'it' : 'them'} under Status → Muted.</>, 'success')
        onDone?.(); return
      }
      if (refusals.length === 0) {
        if (appliedOk > 0 || skippedOk > 0) {
          const parts = [
            appliedOk > 0 ? `Applied ${appliedOk} ${appliedOk === 1 ? 'change' : 'changes'}` : null,
            skippedOk > 0 ? `${skippedOk} settled with nothing to change` : null,
            removedOk.length ? `removed ${removedOk.length}` : null,
          ].filter(Boolean)
          toast(<>
            {parts.join(' · ')}.
            {appliedOk > 0 ? <>{' '}Changes may take a few minutes to complete — view them in the <Link className="h10-am-link" href="/marketing/ads/changelog">Change Log</Link>.</> : null}
          </>, 'success')
        } else if (removedOk.length) {
          toast(<>Removed {removedOk.length} — the plan won’t re-propose {removedOk.length === 1 ? 'it' : 'them'} for 7 days · <button type="button" className="h10-am-link" onClick={() => void aiRestore(removedOk)}>Undo</button></>, 'info', { duration: 8000 })
        } else if (restoredOk) {
          toast(`Restored ${restoredOk} to proposed`, 'success')
          setReload((n) => n + 1)
        }
      } else {
        setBulkReport({
          verb: ops.some((o) => o.kind === 'approve') ? 'Applied' : ops.some((o) => o.kind === 'restore') ? 'Restored' : 'Removed',
          ok: okIds.length, fail: refusals.length, refusals,
          undoIds: removedOk.length ? removedOk : undefined,
        })
      }
      onDone?.()
    } catch { toast('Could not apply the changes', 'danger') } finally { setBulkBusy(false) }
  }, [bulkBusy, aiItems, toast, refreshCounts, aiRestore])

  /**
   * SG.10 — undo an approved A.I. change. Deliberately the SAME two-step shape as the family
   * tab's undo (SG.3): the first click asks the rollback service whether it is even eligible
   * and how many rows it would reverse, and an ineligible change lands as a TOAST rather than
   * arming a doomed request. The handle is the decision's executionId — for a bid apply that
   * is one log from its change set, and rollback follows the set.
   */
  const [aiArmedUndo, setAiArmedUndo] = useState<{ id: string; note: string } | null>(null)
  useEffect(() => {
    if (!aiArmedUndo) return
    const t = setTimeout(() => setAiArmedUndo(null), 6000)
    return () => clearTimeout(t)
  }, [aiArmedUndo])
  const aiArmUndo = useCallback(async (d: AiDecision) => {
    if (!d.undo) return
    const p = await fetch(`${getBackendUrl()}/api/advertising/changes/${d.undo.actionLogId}/undo-preview`, { cache: 'no-store' })
      .then((r) => r.json()).catch(() => null) as { eligible?: boolean; reason?: string; groupedWith?: number } | null
    if (!p?.eligible) { toast(p?.reason ?? 'No undo is offered for this row here', 'info'); return }
    setAiArmedUndo({
      id: d.id,
      note: p.groupedWith && p.groupedWith > 1
        ? `Reverses ${p.groupedWith} grouped changes together — click again to undo`
        : 'Click again to undo this change at Amazon',
    })
  }, [toast])
  const aiDoUndo = useCallback(async (d: AiDecision) => {
    if (!d.undo) return
    setAiArmedUndo(null)
    setBulkBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes/${d.undo.actionLogId}/undo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: `undo from the A.I. Bids queue (decision ${d.id})` }),
      })
      const j = await r.json().catch(() => null) as { ok?: boolean; reversed?: number; reason?: string; error?: string } | null
      if (r.ok && j?.ok !== false) {
        setAiItems((cur) => (cur ?? []).map((x) => (x.id === d.id && x.undo ? { ...x, undo: { ...x.undo, rolledBack: true } } : x)))
        toast(<>Change undone{j?.reversed && j.reversed > 1 ? ` (${j.reversed} grouped rows reversed)` : ''}. The reversal is a change like any other — it is in the <Link className="h10-am-link" href="/marketing/ads/changelog">Change Log</Link>.</>, 'success')
      } else {
        toast(j?.reason ?? j?.error ?? 'The undo was declined', 'danger')
      }
    } finally { setBulkBusy(false) }
  }, [toast])

  /** Commit the A.I. staged buffer — H10's [Apply N Changes], the family interaction. */
  const applyAiStaged = useCallback(() => {
    const ops = [...aiStaged].map(([id, k]) => ({ id, kind: (k === 'apply' ? 'approve' : k === 'mute' ? 'mute' : 'dismiss') as 'approve' | 'dismiss' | 'mute' }))
    void aiRunOps(ops, () => setAiStaged(new Map()))
  }, [aiStaged, aiRunOps])

  // SG.2e — the summary band is GONE (operator, twice): H10 puts nothing between the tabs and
  // Filters, and the money facts already live on the rows — the € at stake column, the ♦
  // pure-waste marker, and the waste-first default ordering.

  // ── the one filter bar: scope grains + page facets ────────────────────────
  const adGroupOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of items) {
      const src = srcOf(s)
      if (src.adGroupId && !seen.has(src.adGroupId)) {
        seen.set(src.adGroupId, `${src.adGroupName ?? src.adGroupId}${src.campaignName ? ` · ${src.campaignName}` : ''}`)
      }
    }
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [items])

  const ruleOptions = useMemo(() => {
    // One option per rule ID; the label is the live name the API resolved onto the row.
    // 🔴 Keyed on ruleId, never ruleName — a renamed rule must stay ONE option (B4).
    const seen = new Map<string, string>()
    for (const s of items) if (s.ruleId && !seen.has(s.ruleId)) seen.set(s.ruleId, s.ruleName ?? 'Rule')
    return [...seen].map(([value, label]) => ({ value, label }))
  }, [items])

  const stakeOf = useCallback((r: unknown) => pricing?.byId[(r as Suggestion).id]?.spendAtStakeCents ?? -1, [pricing])

  const filters = useMemo<GridFilter[]>(() => [
    ...buildScopeFilters({ options, market, value: scope, adGroupOptions }),
    /**
     * SG.2e — Status lives in the FILTERS card, exactly where H10 puts it (their Bids filter
     * card defaults to "Active"; ours to Pending). The status-tab row is gone on the
     * operator's instruction. `__`-prefixed: URL-owned, the server resolves it (it drives the
     * fetch), no client accessor, and a saved preset can never carry it.
     */
    {
      key: '__status', label: 'Status', kind: 'select', placeholder: 'Pending',
      options: [
        { value: 'applied', label: 'Applied' },
        { value: 'dismissed', label: 'Dismissed' },
        { value: 'expired', label: 'Expired' },
        { value: 'muted', label: 'Muted' },
      ],
      tip: 'Pending is the live queue. Applied / Dismissed / Expired are its history — Dismissed rows return on their own when the engine generates a new suggestion. Muted holds the keywords and targets you told the engine to stop proposing for; they keep running at Amazon.',
    },
    {
      key: 'rule', label: 'Rule', kind: 'select', options: ruleOptions, placeholder: 'All rules',
      wide: true, searchable: true, value: (r) => (r as Suggestion).ruleId ?? '',
    },
    {
      key: 'fSpend', label: 'Spend', kind: 'range', unit: '€',
      tip: 'The entity’s trailing 30-day ad spend. Rows with no performance data never match a set range.',
      value: (r) => { const m = (r as Suggestion).metrics; return m ? m.spendCents / 100 : NaN },
    },
    {
      key: 'fSales', label: 'Sales', kind: 'range', unit: '€',
      tip: 'The entity’s trailing 30-day attributed sales. Rows with no performance data never match a set range.',
      value: (r) => { const m = (r as Suggestion).metrics; return m ? m.salesCents / 100 : NaN },
    },
    {
      key: 'fAcos', label: 'ACoS', kind: 'range', unit: '%',
      tip: 'The entity’s trailing 30-day ACoS. Rows where ACoS is not measurable never match a set range.',
      value: (r) => { const m = (r as Suggestion).metrics; return m?.acos != null ? m.acos * 100 : NaN },
    },
    {
      key: 'stake', label: '€ at stake', kind: 'range', unit: '€',
      tip: 'Trailing 30-day spend the action would redirect, in euros. Unpriced rows never match a range.',
      value: (r) => stakeOf(r) / 100,
    },
    {
      key: 'age', label: 'Age (days)', kind: 'range', unit: '',
      tip: 'Days since this change was FIRST proposed. The engine re-confirms pending rows on every evaluation; ones it stops proposing expire on their own.',
      value: (r) => ageDays((r as Suggestion).createdAt),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [options, market, scope.line, scope.portfolio, scope.campaign, scope.adGroup, adGroupOptions, ruleOptions, stakeOf])

  const urlValues = useMemo<FilterState>(
    () => ({ ...scopeToFilterState(scope), rule: ruleParam, __status: status === 'pending' ? '' : status }),
    [scope.line, scope.portfolio, scope.campaign, scope.adGroup, ruleParam, status], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const onUrlChange = useCallback((patch: Record<string, string>) => {
    writeUrl({ ...scopePatchFromFilterState(patch), rule: patch.rule ?? '', status: patch.__status ?? '', row: '' })
  }, [writeUrl])
  const { filterState, setFilterState } = useMergedFilters({ urlValues, onUrlChange })

  const scopeNotes = useMemo(() => {
    const notes: string[] = []
    if (scope.portfolio && options) {
      const orphans = (options as ScopeOptionsPayload & { campaignsWithoutPortfolio?: number }).campaignsWithoutPortfolio
      if (typeof orphans === 'number' && orphans > 0) {
        notes.push(`${orphans} campaigns carry no portfolio at all — a portfolio view can never show their suggestions`)
      }
    }
    return notes
  }, [scope.portfolio, options])

  // ── grid ──────────────────────────────────────────────────────────────────
  const groupBy = useMemo(() => {
    if (group === 'none') return undefined
    return (s: Suggestion): { key: string; label: string } => {
      if (group === 'rule') return { key: s.ruleId, label: s.ruleName ?? 'Rule' }
      if (group === 'campaign') { const src = srcOf(s); return { key: src.campaignId ?? s.entityId, label: src.campaignName ?? src.label } }
      return { key: s.proposedAction?.type ?? 'other', label: ACTION_LABEL[s.proposedAction?.type ?? ''] ?? 'Other' }
    }
  }, [group])

  // Unpriced rows sort to the BOTTOM in either direction (-1 sentinel) — "we could not price
  // this" is not "this is worth nothing".
  const stakeSort = (s: Suggestion): number => pricing?.byId[s.id]?.spendAtStakeCents ?? -1

  // The default order is the PRICING SERVICE's order — recoverable first, then by size — not raw
  // € descending: pure upside before trades. Clicking "€ at stake" still sorts by € alone.
  const ordered = useMemo(() => {
    if (status !== 'pending' || !pricing) return viewRows
    return [...viewRows].sort((a, b) => {
      const pa = pricing.byId[a.id], pb = pricing.byId[b.id]
      return Number(!!pb?.recoverable) - Number(!!pa?.recoverable)
        || (pb?.spendAtStakeCents ?? -1) - (pa?.spendAtStakeCents ?? -1)
    })
  }, [viewRows, pricing, status])

  /**
   * SG.2 — the column model, per view.
   *
   *   Source (pinned LEFT, the grid's frozen first column)
   *   Proposed change · the view's VALUE columns (Current → Suggested, so the change reads
   *   left-to-right) · the 30-day METRIC set (Impressions · Clicks · Spend · Sales · Orders ·
   *   ACoS · ROAS · CTR · CVR · CPC — the decision evidence; the long tail default-hidden
   *   behind Customize) · € at stake · Impact · Rule · When ·
   *   the DECISION columns (✓ ✕ ⏸), pinned RIGHT so they stay reachable however wide the
   *   metrics scroll (freezeRight — the operator's ask, and H10's shape).
   */
  const fam = activeView.family
  const isPending = status === 'pending'
  /** the delta half of H10's "Suggested Change" — new value beside a colored arrow + delta */
  const suggestedChange = (cur: number | null, next: number | null, unit: 'cents' | 'eur') => {
    if (next == null) return dash('Needs a current value to project from')
    const fmt = (v: number) => (unit === 'cents' ? eur(v) : `€${v.toFixed(2)}`)
    if (cur == null) return <b className="h10-sug-sugval">{fmt(next)}</b>
    const d = next - cur
    if (Math.abs(d) < (unit === 'cents' ? 1 : 0.005)) return <b className="h10-sug-sugval">{fmt(next)}</b>
    return (
      <span className="h10-sug-change">
        <b className="h10-sug-sugval">{fmt(next)}</b>
        <span className={`d ${d < 0 ? 'down' : 'up'}`}>{d < 0 ? '↓' : '↑'} {fmt(Math.abs(d))}</span>
      </span>
    )
  }
  const isPauseRow = (s: Suggestion) => s.proposedAction?.type === 'pause_target' || s.proposedAction?.type === 'enable_target'
  const dmy = (iso: string) => new Date(iso).toLocaleDateString('en-GB')
  const metricTip = (what: string) => `${what}, trailing 30 days, for the entity this suggestion touches. “—” = no performance rows in the window — absence, not zero.`

  /**
   * SG.2f — the column library, assembled PER FAMILY below to the operator's exact lists
   * ("we're not supposed to add irrelevant columns … depending on the type of the page").
   * Everything not in a family's visible list is reachable through Customize (defaultHidden).
   */
  const C: Record<string, GridColumn<Suggestion>> = {
    adGroup: {
      key: 'adGroup', label: 'Ad Group', metric: false, sortable: true,
      tip: 'The ad group this target lives in — opens in a new tab.',
      sortValue: (s) => srcOf(s).adGroupName ?? '',
      render: (s) => {
        const src = srcOf(s)
        if (!src.adGroupName) return dash('No ad group resolves for this row')
        return src.campaignId && src.adGroupId ? (
          <span className="h10-sug-agx">
            <a href={`/marketing/ads/campaigns/${src.campaignId}/ad-groups/${src.adGroupId}?tab=targets`} target="_blank" rel="noopener noreferrer" title={`Open ${src.adGroupName} in a new tab`}>
              {src.adGroupName} <ExternalLink size={11} aria-hidden />
            </a>
          </span>
        ) : <span>{src.adGroupName}</span>
      },
    },
    spend: { key: 'spend', label: 'Spend', metric: true, sortable: true, tip: metricTip('Ad spend'), sortValue: (s) => s.metrics?.spendCents ?? null, render: (s) => mEur(s.metrics, 'spendCents') },
    sales: { key: 'sales', label: 'Sales', metric: true, sortable: true, tip: metricTip('Attributed sales (7-day window)'), sortValue: (s) => s.metrics?.salesCents ?? null, render: (s) => mEur(s.metrics, 'salesCents') },
    acos: { key: 'acos', label: 'ACoS', metric: true, sortable: true, tip: `${metricTip('ACoS (spend ÷ sales)')} Dot: ${ACOS_DOT_TIP}.`, sortValue: (s) => s.metrics?.acos ?? null, render: (s) => <AcosCell m={s.metrics} /> },
    roas: { key: 'roas', label: 'ROAS', metric: true, sortable: true, tip: `${metricTip('ROAS (sales ÷ spend)')} Dot: ${ROAS_DOT_TIP}.`, sortValue: (s) => s.metrics?.roas ?? null, render: (s) => <RoasCell m={s.metrics} /> },
    impr: { key: 'impr', label: 'Impressions', metric: true, sortable: true, tip: metricTip('Impressions'), sortValue: (s) => s.metrics?.impressions ?? null, render: (s) => mInt(s.metrics, 'impressions') },
    clicks: { key: 'clicks', label: 'Clicks', metric: true, sortable: true, tip: metricTip('Clicks'), sortValue: (s) => s.metrics?.clicks ?? null, render: (s) => mInt(s.metrics, 'clicks') },
    ctr: { key: 'ctr', label: 'CTR', metric: true, sortable: true, tip: metricTip('Click-through rate'), sortValue: (s) => s.metrics?.ctr ?? null, render: (s) => mPct(s.metrics, 'ctr') },
    cvr: { key: 'cvr', label: 'CVR', metric: true, sortable: true, tip: metricTip('Conversion rate (orders ÷ clicks)'), sortValue: (s) => s.metrics?.cvr ?? null, render: (s) => mPct(s.metrics, 'cvr') },
    cpc: { key: 'cpc', label: 'CPC', metric: true, sortable: true, tip: metricTip('Average cost per click'), sortValue: (s) => s.metrics?.cpcCents ?? null, render: (s) => mCpc(s.metrics) },
    orders: { key: 'orders', label: 'PPC Orders', metric: true, sortable: true, tip: metricTip('Attributed orders'), sortValue: (s) => s.metrics?.orders ?? null, render: (s) => mInt(s.metrics, 'orders') },
    volume: {
      key: 'volume', label: 'Search Volume', metric: true, sortable: true,
      tip: 'The whole market’s searches for this term (Brand Analytics, newest period). “—” = the feed does not cover this query — absence, not zero.',
      sortValue: (s) => s.volume ?? null,
      render: (s) => s.volume != null ? <span className="h10-sug-num">{s.volume.toLocaleString('en-IE')}</span> : dash('Not covered by the Brand Analytics feed'),
    },
    lookback: {
      key: 'lookback', label: 'Lookback Period', metric: false, sortable: true,
      tip: 'The window of Amazon performance data this rule computes from — read from the same table the engine reads, never a copy.',
      sortValue: (s) => s.lookback?.label ?? '',
      render: (s) => s.lookback ? <span className="h10-sug-lb" title={s.lookback.why}>{s.lookback.label}</span> : dash('This rule’s trigger reads no performance window'),
    },
    rule: { key: 'rule', label: 'Rule', metric: false, sortable: true, sortValue: (s) => s.ruleName ?? '', render: (s) => <RuleCell s={s} /> },
    /**
     * 🔴 SGX — the Reason now carries its own WINDOW, because without it the row contradicted
     * itself. On prod the Placement row read "Sales = €0 and Clicks ≥ 20" beside a Sales column
     * of €162.30 — both true: the criteria run over the rule's lookback (7 days, minus the last
     * 2), the metric columns over trailing 30. An operator reading that concludes the engine is
     * broken. The window is muted and inline so the sentence stays one line, and the tooltip
     * spells out both grains.
     */
    reason: {
      key: 'reason', label: 'Reason', metric: false, sortable: true,
      tip: 'Why this surfaced — the rule’s own criteria, in operator units, followed by the window it measures them over. That window is the RULE’s; the metric columns on this row are trailing 30 days, so the two can legitimately disagree. Falls back to the trigger when the rule states no criteria.',
      sortValue: (s) => s.ruleCriteria ?? prettyTrigger(s.trigger),
      render: (s) => {
        const crit = s.ruleCriteria ?? prettyTrigger(s.trigger)
        const full = s.ruleWindow ? `${crit} · measured over ${s.ruleWindow} (the metric columns are trailing 30 days)` : crit
        return (
          <span className="h10-sug-reason" title={full}>
            {crit}
            {s.ruleWindow ? <span className="win"> · {s.ruleWindow}</span> : null}
          </span>
        )
      },
    },
    dateAdded: {
      key: 'dateAdded', label: 'Date Added', metric: false, sortable: true,
      tip: 'When the engine last generated or re-confirmed this suggestion. Suggestion Created is the FIRST time it was proposed.',
      sortValue: (s) => s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : null,
      render: (s) => s.lastSeenAt ? <span className="h10-sug-when" title={ago(s.lastSeenAt)}>{dmy(s.lastSeenAt)}</span> : dash(),
    },
    created: {
      key: 'created', label: 'Suggestion Created', metric: false, sortable: true,
      tip: 'When this change was FIRST proposed. Pending rows the engine stops re-proposing expire on their own.',
      sortValue: (s) => new Date(s.createdAt).getTime(),
      render: (s) => <span className="h10-sug-when" title={ago(s.createdAt)}>{dmy(s.createdAt)}</span>,
    },
    proposed: { key: 'proposed', label: 'Proposed change', metric: false, sortable: true, sortValue: (s) => s.proposedAction?.type ?? '', render: (s) => <ProposedCell s={s} /> },
    impact: { key: 'impact', label: 'Impact', metric: true, sortable: true, tip: 'Daily € change (or keywords affected). Sort to triage the biggest moves first.', sortValue: impactScore, render: (s) => <ImpactCell s={s} /> },
    tacos: { key: 'tacos', label: 'Target ACoS', tip: 'The campaign’s own target ACoS.', metric: true, sortable: true, sortValue: (s) => s.current?.targetAcosPct ?? null, render: (s) => s.current?.targetAcosPct != null ? <span className="h10-sug-num">{s.current.targetAcosPct.toFixed(0)}%</span> : dash('No target ACoS set on the campaign') },
    stake: {
      key: 'stake', label: '€ at stake', metric: true, sortable: true,
      tip: 'Trailing 30-day spend this action would redirect — not money saved. ♦ marks spend that produced no sales at all, the only case where cutting it is pure recovery.',
      sortValue: stakeSort,
      render: (s) => <StakeCell p={pricing?.byId[s.id]} />,
    },
    curBid: {
      key: 'curBid', label: 'Current Bid', metric: true, sortable: true, width: 132,
      tip: 'The live bid. ✓ the row and this becomes the value Apply will set — editable, ↺ restores the suggestion.',
      sortValue: (s) => s.current?.bidCents ?? null,
      render: (s) => {
        if (s.current?.bidCents == null) return dash('The target no longer resolves locally')
        if (!isPending) return <span className="h10-sug-num">{eur(s.current.bidCents)}</span>
        const st = staged.get(s.id)
        return (
          <BufferInput
            current={(s.current.bidCents / 100).toFixed(2)}
            suggestedEur={s.suggested?.bidCents != null ? s.suggested.bidCents / 100 : null}
            stagedValue={st?.kind === 'apply' ? st.value : undefined}
            isStaged={st?.kind === 'apply'}
            disabled={isPauseRow(s)}
            onChange={(v) => setStagedValue(s.id, v)}
            onRevert={() => setStagedValue(s.id, undefined)}
          />
        )
      },
    },
    sugBid: {
      key: 'sugBid', label: 'Suggested Change', tip: 'The projected new bid and its delta — the rule’s action against the current bid. Its min/max still clamp at apply time.',
      metric: true, sortable: true, sortValue: (s) => s.suggested?.bidCents ?? null,
      render: (s) => isPauseRow(s)
        ? <span className="h10-sug-pausechg">Enabled → Paused</span>
        : suggestedChange(s.current?.bidCents ?? null, s.suggested?.bidCents ?? null, 'cents'),
    },
    /**
     * 🔴 SGX — this printed "—" on EVERY wire-rule row under the tooltip "The rule sets no
     * starting bid", while the ✓ hover card two columns away printed €0.38 from the same row's
     * `destinations`. The server now derives `suggested.bidCents` from the engine's own
     * `outcomes[]` when the action carries no scalar `bidEur`; a fan-out whose destinations
     * disagree reports the RANGE rather than picking one and calling it the answer.
     */
    startBid: {
      key: 'startBid', label: 'Starting Bid', metric: true, sortable: true,
      tip: 'The bid the new target would launch with, as the engine resolved it. A range means this term fans out to destinations that launch at different bids — hover ✓ for the per-destination breakdown.',
      sortValue: (s) => s.suggested?.bidCents ?? null,
      render: (s) => {
        const lo = s.suggested?.bidCents
        if (lo == null) return dash('This rule sets no starting bid — the new target would launch at its ad group’s default')
        const hi = s.suggested?.bidCentsMax
        return hi != null && hi !== lo
          ? <b className="h10-sug-sugval" title={`${eur(lo)} – ${eur(hi)} across this term’s destinations`}>{eur(lo)} – {eur(hi)}</b>
          : <b className="h10-sug-sugval">{eur(lo)}</b>
      },
    },
    curBud: {
      key: 'curBud', label: 'Current Budget', metric: true, sortable: true, width: 132,
      tip: 'The live daily budget. ✓ the row and this becomes the value Apply will set — editable, ↺ restores the suggestion.',
      sortValue: (s) => s.current?.dailyBudgetEur ?? null,
      render: (s) => {
        if (s.current?.dailyBudgetEur == null) return dash('The campaign no longer resolves locally')
        if (!isPending) return <span className="h10-sug-num">€{s.current.dailyBudgetEur.toFixed(2)}</span>
        const st = staged.get(s.id)
        return (
          <BufferInput
            current={s.current.dailyBudgetEur.toFixed(2)}
            suggestedEur={s.suggested?.budgetEur ?? null}
            stagedValue={st?.kind === 'apply' ? st.value : undefined}
            isStaged={st?.kind === 'apply'}
            onChange={(v) => setStagedValue(s.id, v)}
            onRevert={() => setStagedValue(s.id, undefined)}
          />
        )
      },
    },
    sugBud: {
      key: 'sugBud', label: 'Suggested Change', tip: 'The projected new daily budget and its delta (€1 floor as at apply time).',
      metric: true, sortable: true, sortValue: (s) => s.suggested?.budgetEur ?? null,
      render: (s) => suggestedChange(s.current?.dailyBudgetEur ?? null, s.suggested?.budgetEur ?? null, 'eur'),
    },
    /**
     * SGX — the Placement family's before→after pair. It was the ONE family with no value
     * columns at all: its change lived only inside the "Proposed change" cell ("30% → 24%"),
     * while bids, budget and new-keywords each got a Current → Suggested pair. 0% is a real
     * reading (Amazon's "no modifier on this lane"), never a dash.
     */
    curPlace: {
      key: 'curPlace', label: 'Current Modifier', metric: true, sortable: true,
      tip: 'The campaign’s live bid modifier for the placement this rule targets. 0% means no modifier is set on that lane.',
      sortValue: (s) => s.current?.placementPct ?? null,
      render: (s) => s.current?.placementPct != null
        ? <span className="h10-sug-num">{s.current.placementPct}%</span>
        : dash('The campaign no longer resolves locally'),
    },
    sugPlace: {
      key: 'sugPlace', label: 'Suggested Change', metric: true, sortable: true,
      tip: 'The projected new placement bid modifier and its delta. The rule’s own floor/ceiling (and Amazon’s 0–900% band) still clamp at apply time.',
      sortValue: (s) => s.suggested?.placementPct ?? null,
      render: (s) => {
        const cur = s.current?.placementPct ?? null
        const next = s.suggested?.placementPct ?? null
        if (next == null) return dash('Needs a current modifier to project from')
        if (cur == null || cur === next) return <b className="h10-sug-sugval">{next}%</b>
        const d = next - cur
        return (
          <span className="h10-sug-change">
            <b className="h10-sug-sugval">{next}%</b>
            <span className={`d ${d < 0 ? 'down' : 'up'}`}>{d < 0 ? '↓' : '↑'} {Math.abs(d)}%</span>
          </span>
        )
      },
    },
    /**
     * 🔴 SGX — what the apply ACTUALLY did, on the Applied tab.
     *
     * This column REPLACES "Suggested Change" there. That column rendered
     * `suggestedChange(current, suggested)`, and both halves are recomputed against TODAY — so an
     * applied row advertised a change that never happened, beside a green Delivered chip. Prod
     * showed "€11.25 → €8.44 ↓€2.81 · Delivered" for an apply that was €15.00 → €11.25.
     */
    applied: {
      key: 'applied', label: 'Applied change', metric: true, sortable: true,
      tip: 'What this apply actually changed — the value as it stood when the change was proposed, and the value the handler wrote. Read from the stored proposal and the write’s own result, so it is history and does not move. The Current column beside it is today’s live value, which may have changed since.',
      sortValue: (s) => s.appliedChange?.to ?? '',
      render: (s) => {
        const a = s.appliedChange
        if (!a) return dash('This row records no readable before/after — the Change Log holds the receipt')
        return (
          <span className="h10-sug-change" title={a.note ?? undefined}>
            {a.from ? <><span className="h10-sug-num">{a.from}</span><span className="d"> → </span></> : <span className="d">set to </span>}
            <b className="h10-sug-sugval">{a.to}</b>
            {a.note ? <span className="d" title={a.note}> ✎</span> : null}
          </span>
        )
      },
    },
    scope: { key: 'scope', label: 'Scope', tip: 'Where the negative lands. Ad group is the default — the path that measurably reaches Amazon; campaign-wide only when the rule says so explicitly.', metric: false, sortable: true, sortValue: (s) => s.proposedAction?.scope ?? 'AD_GROUP', render: (s) => <Tag tone="neutral">{s.proposedAction?.scope === 'CAMPAIGN' ? 'Campaign' : 'Ad group'}</Tag> },
  }
  const hidden = (c: GridColumn<Suggestion>): GridColumn<Suggestion> => ({ ...c, defaultHidden: true })

  /**
   * The family assemblies — the operator's exact lists, in their order; everything else via
   * Customize. Bids gets the Ad Group column (open-in-new-tab); keyword tabs get Search Volume
   * and the date pair; the harvest tab gets Lookback Period; no family carries columns that
   * don't answer its own decision.
   */
  /**
   * 🔴 SGX — on the Applied tab the PROJECTION column is replaced by what the apply actually did.
   * `C.sugBid` / `C.sugBud` / `C.sugPlace` all read `suggested`, which `attachDecisionData`
   * recomputes against today's value — a future that already happened, and on a delivered row a
   * plain falsehood. `C.applied` is history: it reads the stored proposal and the write's own
   * result, so it does not move. Only the three families that HAVE a numeric before/after swap;
   * a harvest or a negative creates an entity rather than moving a number, and a column of
   * dashes would be noise beside their Delivery chip.
   */
  const projOrApplied = (projected: GridColumn<Suggestion>): GridColumn<Suggestion> =>
    (status === 'applied' ? C.applied : projected)

  const familyCols: GridColumn<Suggestion>[] =
    fam === 'bids' ? [
      C.adGroup, C.spend, C.sales, C.acos, C.rule, C.curBid, C.cpc, projOrApplied(C.sugBid), C.reason,
      hidden(C.roas), hidden(C.impr), hidden(C.clicks), hidden(C.ctr), hidden(C.cvr), hidden(C.orders),
      hidden(C.tacos), ...(isPending ? [hidden(C.stake)] : []), hidden(C.created), hidden(C.dateAdded), hidden(C.impact),
    ] : fam === 'negatives' ? [
      C.spend, C.rule, C.dateAdded, C.reason, C.volume, C.impr, C.ctr, C.cpc, C.cvr, C.orders,
      C.clicks, C.created, C.sales, C.acos, C.roas,
      hidden(C.scope), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact),
    ] : fam === 'new-keywords' ? [
      C.lookback, C.rule, C.dateAdded, C.volume, C.created, C.reason, C.spend, C.sales, C.acos,
      C.clicks, C.ctr, C.cpc, C.orders, C.startBid,
      hidden(C.roas), hidden(C.cvr), hidden(C.impr), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact),
    ] : fam === 'budget' ? [
      C.curBud, projOrApplied(C.sugBud), C.spend, C.sales, C.acos, C.roas, C.rule, C.reason, C.created,
      hidden(C.impr), hidden(C.clicks), hidden(C.dateAdded), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact),
    ] : fam === 'placement' ? [
      // SGX — placement used to fall through to the generic list, so it was the one family with
      // no before→after pair. Same shape as budget's: the lane's live modifier, then the change.
      C.curPlace, projOrApplied(C.sugPlace), C.spend, C.sales, C.acos, C.roas, C.rule, C.reason, C.created,
      hidden(C.proposed), hidden(C.impr), hidden(C.clicks), hidden(C.ctr), hidden(C.cvr), hidden(C.orders),
      hidden(C.cpc), hidden(C.dateAdded), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact),
    ] : [
      C.proposed, C.spend, C.sales, C.acos, C.rule, C.reason, C.created,
      hidden(C.roas), hidden(C.impr), hidden(C.clicks), ...(isPending ? [hidden(C.stake)] : []), hidden(C.impact), hidden(C.dateAdded),
    ]

  const DECISION_W = 52
  const columns: GridColumn<Suggestion>[] = [
    ...familyCols,
    // H10's decision columns: each verb is its OWN narrow icon column, PINNED RIGHT — on
    // pending they STAGE (the fill is the staged state); [Apply N Changes] commits the batch.
    // Hovering ✓ opens the action card stating EXACTLY what will land where (SG.2f).
    ...(status === 'pending' ? [
      {
        key: 'ok', label: '✓', tip: 'Stage this change for Apply — hover for exactly what will happen. Click again to un-stage.', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
        render: (s: Suggestion) => {
          const on = staged.get(s.id)?.kind === 'apply'
          return (
            <ApproveHover s={s} onEdit={() => writeUrl({ row: s.id }, { history: true })}>
              <button type="button" className={`h10-sug-iconbtn ok${on ? ' on' : ''}`} disabled={!!busy[s.id]} aria-pressed={on} aria-label={on ? 'Staged to apply — click to un-stage' : 'Stage this change for Apply'} onClick={() => stage(s.id, 'apply')}>
                <Check size={14} />
              </button>
            </ApproveHover>
          )
        },
      } as GridColumn<Suggestion>,
      {
        key: 'no', label: '✕', tip: 'Remove suggestion until a new one is generated — stages with Apply. Click again to un-stage.', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
        render: (s: Suggestion) => {
          const on = staged.get(s.id)?.kind === 'remove'
          return (
            <button type="button" className={`h10-sug-iconbtn no${on ? ' on' : ''}`} disabled={!!busy[s.id]} aria-pressed={on} aria-label={on ? 'Staged to remove — click to un-stage' : 'Remove until a new suggestion is generated'} title={on ? 'Staged to remove — click to un-stage' : 'Remove suggestion until a new one is generated'} onClick={() => stage(s.id, 'remove')}>
              <X size={14} />
            </button>
          )
        },
      } as GridColumn<Suggestion>,
      {
        /**
         * SG.9 — H10's third verb, at the meaning their KB actually gives it: *"Pausing a
         * Suggestion means you no longer wish to collect data on the keyword or target … for
         * suggestions"*, and it *"ensur[es] that it remains active regardless of performance"*.
         * So this MUTES the producer and writes nothing to Amazon — the target keeps running.
         * (It used to pause the target here, which is close to the opposite; the real pause
         * still exists and now lives in the row drawer, where its blast radius is legible.)
         */
        key: 'pz', label: '⏸', tip: 'Stop suggesting for this keyword/target. Nothing is changed at Amazon — it keeps running; we simply stop proposing changes for it. Stages with Apply; find muted rows under Status → Muted.', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
        render: (s: Suggestion) => {
          const on = staged.get(s.id)?.kind === 'mute'
          const what = ENTITY_LABEL[s.entityType]?.toLowerCase() ?? 'entity'
          return (
            <button
              type="button"
              className={`h10-sug-iconbtn pz${on ? ' on' : ''}`}
              disabled={!!busy[s.id]}
              aria-pressed={on}
              aria-label={on ? 'Staged to mute — click to un-stage' : `Stop suggesting for this ${what}`}
              title={on ? 'Staged to mute — click to un-stage' : `Stop suggesting for this ${what} — it keeps running at Amazon`}
              onClick={() => stage(s.id, 'mute')}
            >
              <Pause size={14} />
            </button>
          )
        },
      } as GridColumn<Suggestion>,
    ] : status === 'applied' ? [
      {
        key: 'dl', label: 'Delivery', metric: false, sortable: true, freezeRight: true, width: 118,
        tip: 'The write’s actual fate. An approve is ENQUEUED — the write gate and the drain worker settle it afterwards: Delivered reached Amazon; Refused is the gate’s governed stop (its reason on hover); Failed dead-lettered; Pending is still in flight.',
        sortValue: (s: Suggestion) => s.delivery?.state ?? 'unknown',
        render: (s: Suggestion) => {
          const d = s.delivery ?? { state: 'unknown' as const, detail: null }
          const M: Record<string, { cls: string; label: string }> = {
            delivered: { cls: 'ok', label: 'Delivered' }, pending: { cls: 'pd', label: 'Pending' },
            refused: { cls: 'rf', label: 'Refused' }, failed: { cls: 'fl', label: 'Failed' }, unknown: { cls: 'uk', label: '—' },
          }
          const m = M[d.state]
          return <span className={`h10-sug-dl ${m.cls}`} title={d.detail ?? (d.state === 'unknown' ? 'This row predates delivery tracking — its fate was not recorded' : undefined)}>{m.label}</span>
        },
      } as GridColumn<Suggestion>,
      {
        key: 'act', label: 'Undo', metric: false, sortable: false, freezeRight: true, width: 96,
        tip: 'Reverses the change at Amazon through the rollback service (24h window; a grouped change reverses with its whole set). Refused/failed applies offer Restore instead — the write never landed.',
        render: (s: Suggestion) => {
          if (s.delivery?.state === 'refused' || s.delivery?.state === 'failed') {
            return (
              <button type="button" className="h10-sug-iconbtn" disabled={!!busy[s.id]} aria-label="Restore to pending — this write never landed" title="Restore to pending — this write never landed at Amazon" onClick={() => void act(s.id, 'restore')}>
                <RotateCcw size={14} />
              </button>
            )
          }
          if (s.undo?.rolledBack) return <span className="h10-sug-applied">Undone</span>
          if (!s.undo) return dash('No undo is offered for this row here — the change may still exist; it just has no handle from this queue')
          const armed = armedUndo?.id === s.id
          return (
            <button
              type="button"
              className={`h10-sug-iconbtn${armed ? ' pz armed' : ''}`}
              disabled={!!busy[s.id]}
              aria-label={armed ? armedUndo!.note : 'Undo this change (click twice)'}
              title={armed ? armedUndo!.note : 'Undo this change at Amazon — first click previews, second executes'}
              onClick={() => (armed ? void doUndo(s) : void armUndo(s))}
            >
              <RotateCcw size={14} />
            </button>
          )
        },
      } as GridColumn<Suggestion>,
    ] : status === 'muted' ? [
      {
        // SG.9 — the Muted view's way back. Un-muting lets the producers propose for the
        // entity again and returns its silenced rows to the queue.
        key: 'act', label: 'Unmute', metric: false, sortable: false, freezeRight: true, width: 88,
        tip: 'Resume suggestions for this keyword/target. Its muted rows return to the queue and the engine may propose for it again on the next evaluation.',
        render: (s: Suggestion) => (
          <button type="button" className="h10-sug-iconbtn" disabled={!!busy[s.id] || bulkBusy} aria-label="Resume suggestions for this entity" title="Resume suggestions — the engine may propose for it again" onClick={() => void runOps([{ id: s.id, kind: 'unmute' }])}>
            <Volume2 size={14} />
          </button>
        ),
      } as GridColumn<Suggestion>,
    ] : [
      {
        key: 'act', label: 'Restore', metric: false, sortable: false, freezeRight: true, width: 84,
        render: (s: Suggestion) => (
          <button type="button" className="h10-sug-iconbtn" disabled={!!busy[s.id]} aria-label="Restore to pending" title="Restore to pending" onClick={() => void act(s.id, 'restore')}>
            <RotateCcw size={14} />
          </button>
        ),
      } as GridColumn<Suggestion>,
    ]),
  ]


  // H10's page-level tab bar: bold labels, a count pill per tab (the PENDING queue), the A.I.
  // tab marked with its icon. `count: null` (no pill) when the count is genuinely unknown —
  // the A.I. store wires in SG.4, and an unfetched /count must not print a confident 0.
  const viewTabs = useMemo<TabItem[]>(() => {
    const pillFor = (family: string | null): number | null =>
      family == null ? null : pendingFamilies == null ? null : (pendingFamilies[family] ?? 0)
    const tabs: TabItem[] = VIEWS.map((v) => ({
      id: v.key,
      label: v.label,
      // SG.4 — the A.I. pill counts PROPOSED autopilot decisions (its own store, from /count's
      // aiBids). Recommendations is a computed feed with no stored pending set — no pill.
      count: v.key === 'ai' ? aiBidsCount : pillFor(v.family),
      icon: v.key === 'ai' ? <Sparkles size={15} /> : undefined,
    }))
    if ((pendingFamilies?.other ?? 0) > 0 || (families.other ?? 0) > 0 || view === 'other') {
      tabs.push({ id: 'other', label: 'Other', count: pillFor('other') })
    }
    return tabs
  }, [pendingFamilies, families, view, aiBidsCount])

  const familyCta = activeView.family ? FAMILY_RULE_ROUTE[activeView.family] : undefined

  return (
    <div className="h10-sug">
      <AdsPageHeader
        title="Suggestions"
        subtitle="The review queue — audit the math, approve the winners, dismiss the anomalies."
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => writeUrl({ market: m })}
        showDataSync={false}
        /* Suggestions are point-in-time proposals, not a time series — no date range. */
        showDateRange={false}
      />

      <div className="h10-sug-views">
        <Tabs
          size="lg"
          tabs={viewTabs}
          active={activeView.key}
          onChange={(v) => writeUrl({ view: v, row: '' })}
        />
        <StaleBanner stale={stale} subject="The queue" onRefresh={() => setReload((n) => n + 1)} />
      </div>

      {/* The bulk outcome report — ABOVE the view fork (SG.8: the A.I. verbs report here too);
          outside any popover so a partial result survives it (W2). */}
      {bulkReport && (
        <div className="h10-sug-report" role="status">
          <b>{bulkReport.verb} {bulkReport.ok} · {bulkReport.fail} refused</b>
          <ul>
            {bulkReport.refusals.slice(0, 8).map((r) => <li key={r.id}><span className="nm">{r.label}</span> — {r.error}</li>)}
            {bulkReport.refusals.length > 8 && <li>…and {bulkReport.refusals.length - 8} more</li>}
          </ul>
          <span className="h10-sug-repacts">
            {bulkReport.undoIds?.length ? (
              <button type="button" className="h10-am-link" onClick={() => { void (view === 'ai' ? aiRestore(bulkReport.undoIds!) : restore(bulkReport.undoIds!)); setBulkReport(null) }}>
                Undo the {bulkReport.ok}
              </button>
            ) : null}
            <button type="button" className="h10-am-link" onClick={() => setBulkReport(null)}>Dismiss</button>
          </span>
        </div>
      )}

      {view === 'recommendations' ? (
        /* SG.4/SG.7 — the AI + 5-engine impact feed, folded in from /marketing/ads/
           recommendations (which now redirects here) and rebuilt on the page's one anatomy:
           the SAME Filters card + grid as every family view, ?status/?row shared with them. */
        <RecommendationsView status={status === 'applied' ? 'applied' : status === 'muted' ? 'muted' : 'pending'} rowParam={rowParam} writeUrl={writeUrl} />
      ) : view === 'ai' ? (
        /* SG.8 — autopilot decisions with the family verbs (operator ask 2026-08-21: "nothing
           to approve, snooze or ignore — do it as we did on the other pages"). ✓/✕ STAGE and
           [Apply N Changes] commits the batch; approve executes through applyPlanActions —
           the same write-gated engine an AUTO plan uses. Status views: Proposed (the live
           queue, re-evaluated every 15 min) · Applied (the decided history, each row wearing
           its REAL outcome) · Dismissed (suppressed for 7 days; Restore any time). */
        <>
          <AdsFilterBar
            filters={aiFilters}
            value={aiFilterState}
            onChange={setAiFilterState}
            defaultOpen
            notesSlot={<ScopeNotes notes={['A.I. decisions carry only their campaign — the product line / portfolio / ad group grains do not apply here']} />}
          />
          <AdsDataGrid<AiDecision>
            rows={aiItems ?? []}
            loading={aiLoading}
            rowId={(r) => r.id}
            /* proposed: the ✓/✕ verbs ARE the selection (family rule — no checkbox column);
               dismissed keeps checkboxes for Restore N (the FB.3c selectable-default trap) */
            selectable={aiStatus === 'dismissed'}
            selected={sel}
            onSelectedChange={setSel}
            noun={aiStatus === 'muted' ? 'muted campaign' : 'A.I. bid decision'}
            firstColLabel="Campaign"
            /* A muted row is a MUTE, not a decision — it carries a campaign and nothing else,
               so the module chip (and the decision columns below) are dropped rather than
               rendered empty. */
            renderFirst={(r) => (
              <span className="h10-sug-src">
                {aiStatus !== 'muted' && <Tag tone="info">{r.module}</Tag>}
                {/* a MUTE always names a campaign — falling back to "account-wide" there would
                    describe a reach it does not have; the id is the honest last resort. */}
                <span className="h10-sug-agx">{aiStatus === 'muted'
                  ? (r.campaignName ?? r.campaignId ?? '—')
                  : (r.campaignName ?? r.planName ?? 'account-wide')}</span>
              </span>
            )}
            firstSortValue={(r) => r.campaignName ?? r.planName ?? ''}
            columns={[
              ...(aiStatus === 'muted' ? [] : [
              { key: 'action', label: 'Action', metric: false, sortable: true, sortValue: (r) => r.action, render: (r) => <Tag tone="neutral">{r.action.replace(/_/g, ' ').toLowerCase()}</Tag> } as GridColumn<AiDecision>,
              { key: 'change', label: 'Change', metric: false, render: (r) => <span className="h10-sug-reason" title={aiChangeText(r.module, r.before, r.after)}>{aiChangeText(r.module, r.before, r.after)}</span> } as GridColumn<AiDecision>,
              ]),
              { key: 'reason', label: aiStatus === 'muted' ? 'Why' : 'Reason', metric: false, render: (r) => <span className="h10-sug-reason" title={r.reason}>{r.reason}</span> } as GridColumn<AiDecision>,
              ...(aiStatus === 'muted' ? [] : [
              { key: 'plan', label: 'Plan', metric: false, sortable: true, sortValue: (r) => r.planName ?? '', render: (r) => <span className="h10-sug-agx"><Link href="/marketing/ads/ai-advertising" title="Operate this plan in AI Advertising">{r.planName ?? r.planId}</Link></span> } as GridColumn<AiDecision>,
              { key: 'cycle', label: 'Cycle', metric: false, sortable: true, sortValue: (r) => r.cycle, render: (r) => <span className="h10-sug-when">{r.cycle}</span> } as GridColumn<AiDecision>,
              ]),
              { key: 'at', label: aiStatus === 'dismissed' ? 'Dismissed' : aiStatus === 'applied' ? 'Decided' : aiStatus === 'muted' ? 'Muted' : 'Proposed', metric: false, sortable: true, sortValue: (r) => r.at, render: (r) => <span className="h10-sug-when">{new Date(r.at).toLocaleDateString('en-GB')}</span> } as GridColumn<AiDecision>,
              ...(aiStatus === 'proposed' ? [
                {
                  key: 'ok', label: '✓', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
                  tip: 'Stage this proposal for Apply — approval executes through the same write-gated engine an AUTO plan uses. A bid approve re-runs the plan’s optimizer at apply time, so the applied bids are computed fresh and can differ from the shown figure. Click again to un-stage.',
                  render: (r: AiDecision) => {
                    const on = aiStaged.get(r.id) === 'apply'
                    return (
                      <ApproveHoverCard content={() => aiHoverContent(r, () => writeUrl({ row: r.id }, { history: true }))}>
                        <button type="button" className={`h10-sug-iconbtn ok${on ? ' on' : ''}`} disabled={bulkBusy} aria-pressed={on} aria-label={on ? 'Staged to apply — click to un-stage' : 'Stage this proposal for Apply'} onClick={() => aiStage(r.id, 'apply')}>
                          <Check size={14} />
                        </button>
                      </ApproveHoverCard>
                    )
                  },
                } as GridColumn<AiDecision>,
                {
                  key: 'no', label: '✕', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
                  tip: 'Remove this proposal — the plan won’t re-propose it for 7 days (restore it from the Dismissed view any time). Stages with Apply; click again to un-stage.',
                  render: (r: AiDecision) => {
                    const on = aiStaged.get(r.id) === 'remove'
                    return (
                      <button type="button" className={`h10-sug-iconbtn no${on ? ' on' : ''}`} disabled={bulkBusy} aria-pressed={on} aria-label={on ? 'Staged to remove — click to un-stage' : 'Remove for 7 days'} onClick={() => aiStage(r.id, 'remove')}>
                        <X size={14} />
                      </button>
                    )
                  },
                } as GridColumn<AiDecision>,
                {
                  // SG.9 — the mute, at this tab's grain: a decision names a campaign, so
                  // "stop suggesting for this" means the plans stop proposing for that
                  // campaign. Nothing is written; the campaign keeps running and spending.
                  key: 'pz', label: '⏸', metric: false, sortable: false, freezeRight: true, width: DECISION_W,
                  tip: 'Stop the A.I. proposing for this campaign. Nothing is changed at Amazon — the campaign keeps running; only the proposals stop. Stages with Apply; find muted campaigns under Status → Muted.',
                  render: (r: AiDecision) => {
                    const on = aiStaged.get(r.id) === 'mute'
                    return (
                      <button type="button" className={`h10-sug-iconbtn pz${on ? ' on' : ''}`} disabled={bulkBusy || !r.campaignId} aria-pressed={on}
                        aria-label={on ? 'Staged to mute — click to un-stage' : 'Stop suggesting for this campaign'}
                        title={r.campaignId ? (on ? 'Staged to mute — click to un-stage' : 'Stop suggesting for this campaign — it keeps running at Amazon') : 'This decision names no campaign to mute'}
                        onClick={() => aiStage(r.id, 'mute')}>
                        <Pause size={14} />
                      </button>
                    )
                  },
                } as GridColumn<AiDecision>,
              ] : aiStatus === 'muted' ? [
                {
                  key: 'unmute', label: 'Unmute', metric: false, sortable: false, freezeRight: true, width: 88,
                  tip: 'Let the plans propose for this campaign again from their next tick.',
                  render: (r: AiDecision) => (
                    <button type="button" className="h10-sug-iconbtn" disabled={bulkBusy}
                      aria-label="Resume A.I. suggestions for this campaign" title="Resume suggestions — the plans may propose for it again"
                      onClick={() => {
                        void fetch(`${getBackendUrl()}/api/advertising/ai-decisions/mutes/${encodeURIComponent(r.campaignId ?? '')}`, { method: 'DELETE' })
                          .then(() => { toast('Unmuted — the plans may propose for this campaign again', 'success'); setReload((n) => n + 1); void refreshCounts() })
                          .catch(() => toast('Could not unmute', 'danger'))
                      }}>
                      <Volume2 size={14} />
                    </button>
                  ),
                } as GridColumn<AiDecision>,
              ] : aiStatus === 'applied' ? [
                {
                  /**
                   * SG.10 — undo an approved A.I. change, through the SAME rollback service the
                   * family tab uses (two-step: the first click PREVIEWS eligibility in the
                   * service's own words and arms; the second executes). A bid apply reverses its
                   * whole change set, which the preview states as "N grouped changes".
                   */
                  key: 'undo', label: 'Undo', metric: false, sortable: false, freezeRight: true, width: 96,
                  tip: 'Reverses this change at Amazon through the rollback service (24h window). A bid apply moved several targets in one change set and reverses as a set. Rows with no handle say so rather than offering a button that cannot act.',
                  render: (r: AiDecision) => {
                    if (r.status !== 'APPLIED') return dash('Nothing was written for this row, so there is nothing to reverse')
                    if (r.undo?.rolledBack) return <span className="h10-sug-applied">Undone</span>
                    if (!r.undo) return dash('No undo is offered for this row here — the change may still exist; this queue just holds no handle to it')
                    const armed = aiArmedUndo?.id === r.id
                    return (
                      <button
                        type="button"
                        className={`h10-sug-iconbtn${armed ? ' pz armed' : ''}`}
                        disabled={bulkBusy}
                        aria-label={armed ? aiArmedUndo!.note : 'Undo this change (click twice)'}
                        title={armed ? aiArmedUndo!.note : 'Undo this change at Amazon — first click previews, second executes'}
                        onClick={() => (armed ? void aiDoUndo(r) : void aiArmUndo(r))}
                      >
                        <RotateCcw size={14} />
                      </button>
                    )
                  },
                } as GridColumn<AiDecision>,
                {
                  /**
                   * SG.9 — DELIVERY, not intent. An approve returns at ENQUEUE: the write gate
                   * runs afterwards in the drain worker and refuses a large share of writes
                   * (measured on this account: 298 of 398 budget writes in a week). So an
                   * APPLIED decision reads its outbound queue row and says what actually
                   * happened; a row with no queue handle is an honest "—", never a confident
                   * "Applied". Same treatment as the family tabs' Delivery column.
                   */
                  key: 'st', label: 'Delivery', metric: false, sortable: true, freezeRight: true, width: 104,
                  tip: 'What actually happened at Amazon. Approving ENQUEUES the write; the gate and the drain worker settle it afterwards — Delivered reached Amazon, Refused is the gate’s governed stop (reason on hover), Failed dead-lettered, Pending is still in flight. Skipped means the apply found nothing to change. “—” means no single delivery handle: a bid apply writes each target separately, and rows decided before this column existed carry none — the Change Log has those receipts.',
                  sortValue: (r: AiDecision) => r.delivery?.state ?? r.status,
                  render: (r: AiDecision) => {
                    if (r.status === 'DENIED') return <span className="h10-sug-dl rf" title={r.reason}>Refused</span>
                    if (r.status === 'SKIPPED') return <span className="h10-sug-dl uk" title={r.reason}>Skipped</span>
                    const d = r.delivery
                    if (!d) {
                      // Honest about WHY there is no handle. A bid apply fans out across every
                      // target in the campaign — many queue rows, no single one to point at — so
                      // claiming "predates tracking" on a decision approved a minute ago would be
                      // a false sentence. Only the other modules can truthfully say that.
                      const why = r.module === 'bid'
                        ? 'A bid apply writes each target separately, so there is no single delivery handle to read — the receipts are in the Change Log.'
                        : 'This decision was made before delivery was tracked here — its fate at Amazon was not recorded.'
                      return <span className="h10-sug-dl uk" title={why}>—</span>
                    }
                    const M: Record<string, { cls: string; label: string }> = {
                      delivered: { cls: 'ok', label: 'Delivered' }, pending: { cls: 'pd', label: 'Pending' },
                      refused: { cls: 'rf', label: 'Refused' }, failed: { cls: 'fl', label: 'Failed' }, unknown: { cls: 'uk', label: '—' },
                    }
                    const m = M[d.state] ?? M.unknown
                    return <span className={`h10-sug-dl ${m.cls}`} title={d.detail ?? r.reason}>{m.label}</span>
                  },
                } as GridColumn<AiDecision>,
              ] : [
                {
                  key: 'rs', label: 'Restore', metric: false, sortable: false, freezeRight: true, width: 84,
                  render: (r: AiDecision) => (
                    <button type="button" className="h10-sug-iconbtn" disabled={bulkBusy} aria-label="Restore to proposed" title="Restore to proposed — the plan re-evaluates it on its next tick" onClick={() => void aiRunOps([{ id: r.id, kind: 'restore' }])}>
                      <RotateCcw size={14} />
                    </button>
                  ),
                } as GridColumn<AiDecision>,
              ]),
            ]}
            filters={aiFilters}
            filterState={aiFilterState}
            onFilterStateChange={setAiFilterState}
            hideFilterPanel
            keyboardNav={!aiDetail}
            onRowKey={(r, k) => {
              if (aiStatus === 'proposed') {
                if (k === 'a') aiStage(r.id, 'apply')
                else if (k === 'e') aiStage(r.id, 'remove')
                else if (k === 'p') aiStage(r.id, 'mute')
              } else if (aiStatus === 'dismissed' && k === 'r') void aiRunOps([{ id: r.id, kind: 'restore' }])
            }}
            toolbarLeft={aiStatus === 'proposed' ? (
              /* H10's master pair, the family interaction: stage with the row verbs, commit
                 in ONE batch. Disabled at 0 = self-explaining (the count is the label). */
              <span className="h10-sug-applybar">
                <button type="button" className="h10-am-link" disabled={aiStaged.size === 0 || bulkBusy} onClick={() => setAiStaged(new Map())}>
                  Discard Changes
                </button>
                <Button variant="primary" size="sm" disabled={aiStaged.size === 0 || bulkBusy} onClick={applyAiStaged}>
                  <Check size={13} /> Apply {aiStaged.size} {aiStaged.size === 1 ? 'Change' : 'Changes'}
                </Button>
              </span>
            ) : aiStatus === 'dismissed' ? (
              <span className="h10-sug-applybar">
                <Button variant="secondary" size="sm" disabled={sel.size === 0 || bulkBusy} onClick={() => void aiRunOps([...sel].map((id) => ({ id, kind: 'restore' as const })), () => setSel(new Set()))}>
                  <RotateCcw size={13} /> Restore {sel.size}
                </Button>
              </span>
            ) : null}
            toolbarRight={
              <span className="h10-sug-toolbar">
                <Button variant="secondary" size="sm" onClick={() => setBidSettingsOpen(true)}><Settings size={13} /> Bid Settings</Button>
                <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}><RefreshCw size={13} /> Refresh</Button>
              </span>
            }
            defaultSort={{ key: 'at', dir: 'desc' }}
            onRowClick={aiStatus === 'muted' ? undefined : (r) => writeUrl({ row: r.id }, { history: true })}
            emptyNode={
              <EmptyState
                icon={<Sparkles size={26} />}
                title={aiStatus === 'applied' ? 'No decided A.I. changes yet'
                  : aiStatus === 'dismissed' ? 'Nothing dismissed'
                  : aiStatus === 'muted' ? 'Nothing muted'
                  : 'No A.I. bid suggestions yet'}
                description={aiStatus === 'applied'
                  ? 'Approve a proposal and its real outcome lands here — an AUTO plan’s own writes are recorded here too.'
                  : aiStatus === 'muted'
                    ? '⏸ a row and its campaign lands here: still running and spending at Amazon, just no longer proposed for. Unmute any time.'
                  : aiStatus === 'dismissed'
                    ? 'Removed proposals wait here for 7 days — the plan won’t re-propose them meanwhile. Restore one any time.'
                    : <>A.I. bid suggestions come from <Link className="h10-sug-lnk" href="/marketing/ads/ai-advertising">AI Advertising</Link> goals. Launch a goal and its proposed bids will queue here for your approval.</>}
              />
            }
            reportLabel="A.I. bid decisions"
          />
        </>
      ) : (
        <>
          <AdsFilterBar
            filters={filters}
            value={filterState}
            onChange={setFilterState}
            defaultOpen
            notesSlot={<ScopeNotes notes={scopeNotes} />}
          />

          <AdsDataGrid<Suggestion>
            rows={ordered}
            loading={loading}
            rowId={(s) => s.id}
            noun="suggestion"
            firstColLabel="Source"
            renderFirst={(s) => <SourceCell s={s} />}
            firstSortValue={(s) => srcOf(s).label}
            columns={columns}
            /* SG.7 — the grid needs the filter DEFINITIONS as well as the state: without
               `filters` it returns rows uncut and the panel's client facets (Rule, the metric
               ranges) silently filter nothing (BidClient is the reference wiring). Scope +
               __status keys carry no `value` accessor, so the grid skips them — they stay
               server-resolved. */
            filters={filters}
            filterState={filterState}
            onFilterStateChange={setFilterState}
            hideFilterPanel
            groupBy={groupBy}
            /* pending: the ✓/✕ verbs ARE the selection (H10 has no checkbox column there);
               dismissed/expired keep checkboxes for bulk Restore */
            selectable={status === 'dismissed' || status === 'expired'}
            selected={sel}
            onSelectedChange={setSel}
            searchable
            searchPlaceholder="Search terms & keywords…"
            pagerCentered
            customizable
            storageKey={`suggestions-grid-${activeView.key}-v1`}
            defaultSort={status === 'pending' ? undefined : { key: 'when', dir: 'desc' }}
            onRowClick={(s) => writeUrl({ row: s.id }, { history: true })}
            keyboardNav={!detail}
            onRowKey={(s, k) => {
              if (status === 'pending') {
                if (k === 'a') stage(s.id, 'apply')
                else if (k === 'e') stage(s.id, 'remove')
                else if (k === 'p') stage(s.id, 'mute')
              } else if ((status === 'dismissed' || status === 'expired') && k === 'r') void act(s.id, 'restore')
              else if (status === 'muted' && k === 'r') void runOps([{ id: s.id, kind: 'unmute' }])
            }}
            toolbarLeft={
              <>
                {/* H10's master pair — ALWAYS visible: Discard Changes clears the staged
                    buffer; Apply N Changes commits accepts + removals in ONE batch. Disabled
                    at 0 — ticking the row verbs is what arms them. */}
                {status === 'pending' ? (
                  <span className="h10-sug-applybar">
                    <button type="button" className="h10-am-link" disabled={staged.size === 0 || bulkBusy} onClick={() => setStaged(new Map())}>
                      Discard Changes
                    </button>
                    <Button variant="primary" size="sm" disabled={staged.size === 0 || bulkBusy} onClick={applyStaged}>
                      <Check size={13} /> Apply {staged.size} {staged.size === 1 ? 'Change' : 'Changes'}
                    </Button>
                  </span>
                ) : status === 'dismissed' || status === 'expired' ? (
                  <span className="h10-sug-applybar">
                    <Button variant="secondary" size="sm" disabled={sel.size === 0 || bulkBusy} onClick={() => void runOps([...sel].map((id) => ({ id, kind: 'restore' as const })), () => setSel(new Set()))}>
                      <RotateCcw size={13} /> Restore {sel.size}
                    </Button>
                  </span>
                ) : null}
                {/* A truncated list must SAY it is truncated (B4): the endpoint caps at 1000. */}
                {total != null && total > items.length && (
                  <span className="h10-sug-trunc" role="status">
                    Showing {items.length.toLocaleString('en-IE')} of {total.toLocaleString('en-IE')} — this list is capped
                  </span>
                )}
                <label className="h10-sug-group">
                  <span>Group by</span>
                  <Select value={group} onChange={(e) => setGroup(e.target.value as GroupKey)} aria-label="Group suggestions by">
                    <option value="none">None</option>
                    <option value="rule">Rule</option>
                    <option value="campaign">Campaign</option>
                    <option value="type">Type</option>
                  </Select>
                </label>
              </>
            }
            toolbarRight={
              <span className="h10-sug-toolbar">
                {activeView.key === 'bids' && (
                  <Button variant="secondary" size="sm" onClick={() => setBidSettingsOpen(true)}><Settings size={13} /> Bid Settings</Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}><RefreshCw size={13} /> Refresh</Button>
              </span>
            }
            emptyNode={
              <EmptyState
                icon={<Sparkles size={26} />}
                title={status === 'applied' ? 'No applied suggestions yet'
                  : status === 'dismissed' ? 'Nothing dismissed'
                  : status === 'expired' ? 'Nothing has expired'
                  : status === 'muted' ? 'Nothing muted'
                  : `No ${activeView.noun} suggestions right now`}
                description={status === 'pending'
                  ? familyCta
                    ? <span className="h10-sug-ctawrap">Create a {familyCta.label} rule set to <em>Manual</em> — its proposed changes will queue here for your approval.<br /><Link className="nds-btn primary h10-sug-cta" href={familyCta.href}>Create Rule</Link></span>
                    : <>When a rule set to <em>Manual</em> finds something to do, its proposed change appears here for you to approve.</>
                  : status === 'applied' ? 'Suggestions you approve will be listed here.'
                  : status === 'expired' ? 'A pending suggestion the engine stops re-proposing expires on its own and lands here — the queue only ever holds the engine’s current opinion.'
                  : status === 'muted' ? '⏸ a row and its keyword or target lands here: still running at Amazon, just no longer proposed for. Unmute any time to let the engine speak up about it again.'
                  : 'Suggestions you remove land here, and come back on their own when the engine generates a new one. You can also restore them by hand.'}
              />
            }
          />
        </>
      )}

      {view === 'ai' && aiDetail && (
        <AiDecisionDrawer
          decision={aiDetail}
          busy={bulkBusy}
          onClose={() => writeUrl({ row: '' })}
          onAct={(id, kind) => aiRunOps([{ id, kind }])}
        />
      )}

      {detail && <SuggestionDrawer suggestion={detail} priced={pricing?.byId[detail.id]} busy={!!busy[detail.id]} onClose={() => writeUrl({ row: '' })} onAct={act} onPauseTarget={pauseTarget} />}

      <AdsBidSettingsModal open={bidSettingsOpen} onClose={() => setBidSettingsOpen(false)} markets={MARKETS} />
    </div>
  )
}

/** The Suggestions page. The ads routes are standalone (AppShell) and sit outside the root
 *  ToastProvider, so we provide one here for the approve/dismiss + bulk-undo toasts. */
export function SuggestionsClient() {
  return (
    <ToastProvider>
      <SuggestionsInner />
    </ToastProvider>
  )
}
