'use client'

/**
 * SG.7 — the Recommendations feed on the page's ONE anatomy: tabs → Filters card → grid
 * (operator, 2026-08-21: "the recommendation page is actually supposed to be the same as the
 * others — the appearance, the filters, the filter bar, and the grid").
 *
 * What moved where (all operator decisions, AskUserQuestion 2026-08-21):
 *   · the sandbox/live banner, alerts strip, AI action brief and summary tiles are REMOVED —
 *     H10 puts nothing between the tabs and Filters, and the account mode still states itself
 *     inside every Apply confirm, which is where it governs a decision.
 *   · AccountPlanPanel is PARKED (⛔ KEEP — an ACR.6 surface; AI Advertising operates plans).
 *   · "Apply all high-priority (N)" lives on the grid toolbar, behind the same confirm.
 *   · the strategy rail folds into the Filters card as the Strategy select (+ counts); the
 *     small Pending/Applied tabs fold in as the Status select — the family views' placement.
 *
 * The feed itself is unchanged: the AI + 5-engine impact-ranked recommendations, distinct from
 * the rule families (the propose-only queue for Manual rules). Reads:
 * GET /advertising/recommendations · /summary. Writes: POST /advertising/recommendations/apply
 * { kind, payload } (gated). There is no client dry-run — the apply endpoint hardcodes
 * dryRun:false and the REAL guard is the server-side 4-check write-gate (sandbox-default), so
 * every apply sits behind the mode-aware confirm (Sandbox = simulated · Live = gated writes).
 *
 * Server truth this view must not overstate: recommendations have NO stored status — Applied
 * is this browser's memory (localStorage, deterministic ids), Dismissed is session-only. The
 * Status filter's tip says so.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sparkles, AlertTriangle, Check, X, ChevronRight, RefreshCw, Pause, Volume2 } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type GridFilter, type FilterState } from '../campaigns/_grid/AdsDataGrid'
import { AdsFilterBar } from '../campaigns/_grid/AdsFilterBar'
import { useMergedFilters } from '../rules-automation/_shared/useMergedFilters'
import { ScopeNotes } from '../rules-automation/_shared/ScopeNotes'
import { Button } from '@/design-system/primitives/Button'
import { Tag } from '@/design-system/primitives/Tag'
import { Modal } from '@/design-system/components/Modal'
import { Drawer } from '@/design-system/components/Drawer'
import { EmptyState } from '@/design-system/components/EmptyState'
import { useToast } from '@/design-system/components/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { eur2, pct, intl, roas as roasFmt } from '../_canvas/format'
import { dash, eur, AcosCell, RoasCell, type SuggestionMetrics } from './cells'
import { ApproveHoverCard, type HoverContent } from './ApproveHoverCard'
import type { RecMetrics } from '@/app/_shared/ads-ui'
import '../recommendations/recommendations.css'

type RecCategory = 'bid' | 'negative' | 'graduate' | 'budget' | 'sov' | 'retail'
type RecSeverity = 'high' | 'medium' | 'low'
interface Recommendation {
  id: string; category: RecCategory; severity: RecSeverity; title: string; detail: string
  estImpactCents: number; apply: { kind: string; payload: unknown } | null; metrics?: RecMetrics
}
interface RecResult {
  generatedAt: string; windowDays: number; counts: Record<RecCategory, number>
  potentialMonthlyImpactCents: number; recommendations: Recommendation[]
}

const CAT_LABEL: Record<RecCategory, string> = { bid: 'Bid', negative: 'Negative', graduate: 'Graduate', budget: 'Budget', sov: 'Share of voice', retail: 'Inventory' }
const CAT_DOT: Record<RecCategory, string> = { bid: '#1f6fde', negative: '#e5484d', graduate: '#067d62', budget: '#7c5cff', sov: '#0ea5e9', retail: '#d6336c' }
// The named strategies — formerly the left rail, now the Strategy select's vocabulary.
const STRATEGY: Array<{ key: RecCategory; label: string; blurb: string }> = [
  { key: 'budget', label: 'Budget Optimization', blurb: 'Raise out-of-budget winners, trim losers' },
  { key: 'bid', label: 'Bid Optimization', blurb: 'Move bids toward your target ACoS' },
  { key: 'negative', label: 'Negative Harvesting', blurb: 'Cut wasteful search terms' },
  { key: 'graduate', label: 'Keyword Graduation', blurb: 'Promote converting terms to exact' },
  { key: 'retail', label: 'Inventory Shortage', blurb: 'Pause ads for unsellable products' },
  { key: 'sov', label: 'Share of Voice', blurb: 'Outbid & cannibalization signals' },
]

/**
 * RecMetrics cells. Every field is INDIVIDUALLY nullable (unlike the suggestion grid's
 * all-or-nothing `metrics`), so each cell dashes its own absence. Encodings verified against
 * the shared cells before reuse: acos/ctr/cvr are FRACTIONS on both payloads (the shared
 * AcosCell multiplies by 100 itself); roas is the plain ratio on both.
 */
const REC_NO_DATA = 'Not reported for this recommendation — absence, not zero'
const rInt = (v: number | null | undefined) => (v == null ? dash(REC_NO_DATA) : <span className="h10-sug-num">{v.toLocaleString('en-IE')}</span>)
const rEurC = (v: number | null | undefined) => (v == null ? dash(REC_NO_DATA) : <span className="h10-sug-num">{eur(v)}</span>)
const rPct = (v: number | null | undefined) => (v == null ? dash(REC_NO_DATA) : <span className="h10-sug-num">{(v * 100).toFixed(2)}%</span>)
// The dot treatments are the SHARED cells' — adapt only the fields each one reads. The cast is
// safe because AcosCell/RoasCell read acos+spendCents / roas alone.
const rAcos = (m?: RecMetrics) => {
  if (m?.acos != null) return <AcosCell m={{ acos: m.acos, spendCents: m.spendCents ?? 0 } as SuggestionMetrics} />
  // acos is unreadable when sales are 0 — the shared cell's red-dot case, only claimed when
  // the payload actually says sales were zero beside real spend.
  if (m && (m.spendCents ?? 0) > 0 && m.salesCents === 0) return <AcosCell m={{ acos: null, spendCents: m.spendCents } as SuggestionMetrics} />
  return dash(REC_NO_DATA)
}
const rRoas = (m?: RecMetrics) => (m?.roas != null ? <RoasCell m={{ roas: m.roas, spendCents: m.spendCents ?? 0 } as SuggestionMetrics} /> : dash(REC_NO_DATA))

/**
 * SG.9 — what hovering ✓ promises on this tab. A recommendation carries a fixed server-side
 * payload (no editable magnitude), so the card states the engine, the exact change and the
 * account mode that will govern it — and its button opens the row for review rather than
 * offering an edit this feed cannot honour.
 */
function recHoverContent(r: Recommendation, onReview: () => void, mode: string): HoverContent {
  const strat = STRATEGY.find((x) => x.key === r.category)
  return {
    title: `Engine: ${strat?.label ?? CAT_LABEL[r.category]}`,
    sub: `${strat?.blurb ?? 'An impact-ranked recommendation.'} ${mode === 'sandbox' ? 'Applying is simulated while the account is in sandbox.' : 'Applying routes through the write gate — it reaches Amazon only where you have enabled writes.'}`,
    headers: ['Severity', 'Impact', 'What it does', 'Scope', 'Notes'],
    rows: [{
      badge: null,
      typeLabel: r.severity,
      bid: r.category !== 'sov' && r.estImpactCents > 0 ? `${eur(r.estImpactCents)}/mo` : '—',
      campaign: r.title,
      adGroup: 'account-wide',
      adProduct: null,
      note: r.apply ? 'One-click apply' : 'Review only',
    }],
    action: { label: 'Review recommendation', onClick: onReview },
  }
}

type Confirm = { kind: 'one'; rec: Recommendation } | { kind: 'all'; recs: Recommendation[] } | null

export function RecommendationsView({ status, rowParam, writeUrl }: {
  /** the page's ?status= — pending | applied | muted (this feed has no server-side status) */
  status: 'pending' | 'applied' | 'muted'
  /** the page's ?row= deep link — recommendation ids are deterministic across reloads */
  rowParam: string | null
  /** the page's one URL writer (replace for filters, push for the drawer) */
  writeUrl: (patch: Record<string, string>, opts?: { history?: boolean }) => void
}) {
  const [data, setData] = useState<RecResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<string>('sandbox')
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const { toast } = useToast()

  // Applied recs persist across reloads (rec ids are deterministic).
  useEffect(() => { try { const s = localStorage.getItem('ax.recs.applied'); if (s) setApplied(new Set(JSON.parse(s))) } catch { /* ignore */ } }, [])
  const persistApplied = (next: Set<string>) => { try { localStorage.setItem('ax.recs.applied', JSON.stringify([...next])) } catch { /* ignore */ } }

  const load = useCallback(() => {
    const base = getBackendUrl()
    setLoading(true)
    // SG.9 — the Muted view asks for the silenced set; every other view gets the live feed
    // (which the server has already filtered, so counts describe what is on screen).
    const url = status === 'muted' ? `${base}/api/advertising/recommendations-muted` : `${base}/api/advertising/recommendations`
    fetch(url, { cache: 'no-store' }).then((x) => x.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
    fetch(`${base}/api/advertising/summary`, { cache: 'no-store' }).then((x) => x.json()).then((s) => setMode(s?.mode ?? 'sandbox')).catch(() => {})
  }, [status])

  /**
   * SG.9 — H10's third verb on a COMPUTED feed. There is no stored row to mark, so the mute is
   * keyed on the recommendation's own id (deterministic across reloads) and the server drops it
   * from the feed AND from the counts. Nothing is written to Amazon; the engines simply stop
   * raising this one. Immediate rather than staged — this tab has no staging buffer, because
   * each apply is its own gated POST — so it carries an Undo instead.
   */
  const muteRec = useCallback(async (r: Recommendation) => {
    setBusy(r.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/recommendation-mutes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id, label: r.title }),
      }).then((x) => x.json()).catch(() => null)
      if (!res?.ok) { toast('Could not mute that recommendation', 'danger'); return }
      if (rowParam === r.id) writeUrl({ row: '' })
      setData((d) => (d ? { ...d, recommendations: d.recommendations.filter((x) => x.id !== r.id) } : d))
      toast(<>Muted — nothing was changed at Amazon; the engines stop raising this one · <button type="button" className="h10-am-link" onClick={() => void unmuteRec(r.id)}>Undo</button></>, 'success', { duration: 8000 })
    } finally { setBusy(null) }
  }, [rowParam, writeUrl, toast]) // eslint-disable-line react-hooks/exhaustive-deps

  const unmuteRec = useCallback(async (id: string) => {
    await fetch(`${getBackendUrl()}/api/advertising/recommendation-mutes/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null)
    load()
  }, [load])
  useEffect(() => { load() }, [load])

  // Apply — POST { kind, payload }. The server-side write-gate decides simulate-vs-live.
  const apply = useCallback(async (r: Recommendation): Promise<boolean> => {
    if (!r.apply) return false
    setBusy(r.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/recommendations/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.apply),
      }).then((x) => x.json())
      if (res?.error) return false
      setApplied((s) => { const n = new Set(s).add(r.id); persistApplied(n); return n })
      return true
    } catch { return false } finally { setBusy(null) }
  }, [])

  const confirmApply = async () => {
    if (!confirm) return
    if (confirm.kind === 'one') {
      const ok = await apply(confirm.rec)
      toast(ok ? (mode === 'sandbox' ? 'Applied — simulated in sandbox' : 'Apply submitted — gated writes reach Amazon only where enabled') : 'Apply failed', ok ? 'success' : 'danger')
    } else {
      let ok = 0; let fail = 0
      for (const r of confirm.recs) { if (await apply(r)) ok++; else fail++ } // sequential — clean audit ordering
      toast(`${ok} applied${fail ? ` · ${fail} failed` : ''}${mode === 'sandbox' ? ' (simulated)' : ' (gated — live where enabled)'}`, fail ? 'danger' : 'success')
    }
    setConfirm(null)
  }

  const dismiss = useCallback((r: Recommendation) => {
    setDismissed((s) => new Set(s).add(r.id))
    if (rowParam === r.id) writeUrl({ row: '' })
    toast(<>Dismissed for this session · <button type="button" className="h10-am-link" onClick={() => setDismissed((s) => { const n = new Set(s); n.delete(r.id); return n })}>Undo</button></>, 'info', { duration: 8000 })
  }, [rowParam, writeUrl, toast])

  // ── the status cut (client truth: Applied is this browser's memory) ────────
  const all = useMemo(() => data?.recommendations ?? [], [data])
  const rows = useMemo(
    // the Muted view's rows ARE the muted set (the server sent exactly those), so the
    // applied/dismissed cut does not apply to it
    () => (status === 'muted' ? all : all.filter((r) => !dismissed.has(r.id)).filter((r) => (status === 'applied' ? applied.has(r.id) : !applied.has(r.id)))),
    [all, dismissed, applied, status],
  )
  const highPending = all.filter((r) => r.severity === 'high' && r.apply && !applied.has(r.id) && !dismissed.has(r.id))
  const detail = rowParam ? all.find((r) => r.id === rowParam) ?? null : null

  // ── the Filters card — the SAME bar as every other view ───────────────────
  // No scope grains ON PURPOSE: recommendations are account-wide aggregates, and a picker that
  // filters nothing is a lie. The notesSlot states the fact instead.
  const filters = useMemo<GridFilter[]>(() => [
    {
      key: '__status', label: 'Status', kind: 'select', placeholder: 'Pending',
      options: [{ value: 'applied', label: 'Applied' }, { value: 'muted', label: 'Muted' }],
      tip: 'Pending is the live feed. Applied is what you have applied from this browser — recommendations carry no stored status on the server, so this memory is per-browser. Muted holds the ones you told the engines to stop raising; nothing about them changed at Amazon.',
    },
    {
      key: 'cat', label: 'Strategy', kind: 'select', wide: true, placeholder: 'All strategies',
      options: STRATEGY.map((s) => ({ value: s.key, label: `${s.label}${data ? ` (${data.counts?.[s.key] ?? 0})` : ''}`, title: s.blurb })),
      value: (r) => (r as Recommendation).category,
      tip: 'The engine that produced the recommendation. Counts are the whole feed, before other filters.',
    },
    {
      key: 'sev', label: 'Severity', kind: 'select', placeholder: 'All',
      options: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }],
      value: (r) => (r as Recommendation).severity,
    },
    {
      key: 'impact', label: 'Impact', kind: 'range', unit: '€',
      tip: 'Estimated monthly € impact. Rows without an estimate (share-of-voice signals) never match a set range.',
      value: (r) => { const x = r as Recommendation; return x.category !== 'sov' && x.estImpactCents > 0 ? x.estImpactCents / 100 : NaN },
    },
  ], [data])

  const urlValues = useMemo<FilterState>(() => ({ __status: status === 'pending' ? '' : status }), [status])
  const onUrlChange = useCallback((patch: Record<string, string>) => {
    writeUrl({ status: patch.__status ?? '', row: '' })
  }, [writeUrl])
  const { filterState, setFilterState } = useMergedFilters({ urlValues, onUrlChange })

  // ── the grid — the page's column conventions ──────────────────────────────
  const wd = data?.windowDays ?? 30
  const metricTip = (what: string) => `${what} behind this recommendation, over the engine’s ${wd}-day window. “—” = not reported — absence, not zero.`
  const isPending = status === 'pending'
  const isMuted = status === 'muted'

  const columns: GridColumn<Recommendation>[] = [
    { key: 'cat', label: 'Strategy', metric: false, sortable: true, tip: 'The engine that produced this recommendation.', sortValue: (r) => CAT_LABEL[r.category], render: (r) => <Tag tone="neutral">{CAT_LABEL[r.category]}</Tag> },
    { key: 'detail', label: 'Detail', metric: false, sortable: false, tip: 'The recommendation’s own explanation — the full text is on the row and in its drawer.', render: (r) => <span className="h10-sug-recdet" title={r.detail}>{r.detail}</span> },
    {
      key: 'impact', label: 'Impact €/mo', metric: true, sortable: true,
      tip: 'Estimated monthly € impact if applied — the feed is ranked by it. Share-of-voice signals carry no € estimate.',
      sortValue: (r) => (r.category !== 'sov' && r.estImpactCents > 0 ? r.estImpactCents : null),
      render: (r) => (r.category !== 'sov' && r.estImpactCents > 0
        ? <span className="h10-sug-num h10-sug-sugval">{eur(r.estImpactCents)}</span>
        : dash(r.category === 'sov' ? 'Share-of-voice recommendations carry no € estimate' : 'No € estimate for this recommendation')),
    },
    { key: 'impr', label: 'Impressions', metric: true, sortable: true, tip: metricTip('Impressions'), sortValue: (r) => r.metrics?.impressions ?? null, render: (r) => rInt(r.metrics?.impressions) },
    { key: 'clicks', label: 'Clicks', metric: true, sortable: true, tip: metricTip('Clicks'), sortValue: (r) => r.metrics?.clicks ?? null, render: (r) => rInt(r.metrics?.clicks) },
    { key: 'ctr', label: 'CTR', metric: true, sortable: true, tip: metricTip('Click-through rate'), sortValue: (r) => r.metrics?.ctr ?? null, render: (r) => rPct(r.metrics?.ctr) },
    { key: 'spend', label: 'Spend', metric: true, sortable: true, tip: metricTip('Ad spend'), sortValue: (r) => r.metrics?.spendCents ?? null, render: (r) => rEurC(r.metrics?.spendCents) },
    { key: 'sales', label: 'Sales', metric: true, sortable: true, tip: metricTip('Attributed sales'), sortValue: (r) => r.metrics?.salesCents ?? null, render: (r) => rEurC(r.metrics?.salesCents) },
    { key: 'orders', label: 'PPC Orders', metric: true, sortable: true, tip: metricTip('Attributed orders'), sortValue: (r) => r.metrics?.orders ?? null, render: (r) => rInt(r.metrics?.orders) },
    { key: 'acos', label: 'ACoS', metric: true, sortable: true, tip: metricTip('ACoS (spend ÷ sales)'), sortValue: (r) => r.metrics?.acos ?? null, render: (r) => rAcos(r.metrics) },
    { key: 'roas', label: 'ROAS', metric: true, sortable: true, tip: metricTip('ROAS (sales ÷ spend)'), sortValue: (r) => r.metrics?.roas ?? null, render: (r) => rRoas(r.metrics) },
    { key: 'cvr', label: 'CVR', metric: true, sortable: true, tip: metricTip('Conversion rate (orders ÷ clicks)'), sortValue: (r) => r.metrics?.cvr ?? null, render: (r) => rPct(r.metrics?.cvr) },
    // The decision verbs, pinned right like every other tab. These act IMMEDIATELY (✓ behind
    // the mode-aware confirm; ✕ with an Undo toast) — this feed has no staging buffer because
    // it has no bulk apply endpoint: each apply is its own gated POST.
    ...(isPending ? [
      {
        key: 'ok', label: '✓', tip: 'Apply this recommendation — hover for exactly what it does; a confirm states the account mode (sandbox = simulated · live = gated writes) before anything is sent.', metric: false, sortable: false, freezeRight: true, width: 52,
        render: (r: Recommendation) => r.apply ? (
          <ApproveHoverCard content={() => recHoverContent(r, () => writeUrl({ row: r.id }, { history: true }), mode)}>
            <button type="button" className="h10-sug-iconbtn ok" disabled={busy === r.id} aria-label="Apply this recommendation" onClick={() => setConfirm({ kind: 'one', rec: r })}>
              <Check size={14} />
            </button>
          </ApproveHoverCard>
        ) : dash('No one-click apply for this recommendation — open the row to review it'),
      } as GridColumn<Recommendation>,
      {
        key: 'no', label: '✕', tip: 'Snooze — hides it for this session. The engines recompute this feed continuously, so it comes back with the next run; ⏸ is how you stop it for good. Undo lives in the toast.', metric: false, sortable: false, freezeRight: true, width: 52,
        render: (r: Recommendation) => (
          <button type="button" className="h10-sug-iconbtn no" disabled={busy === r.id} aria-label="Snooze this recommendation for this session" onClick={() => dismiss(r)}>
            <X size={14} />
          </button>
        ),
      } as GridColumn<Recommendation>,
      {
        // SG.9 — H10's third verb: stop raising this one. Nothing changes at Amazon; the
        // engines simply stop proposing it until you unmute.
        key: 'pz', label: '⏸', tip: 'Stop suggesting this. Nothing is changed at Amazon — the engines just stop raising it, permanently, until you unmute it under Status → Muted.', metric: false, sortable: false, freezeRight: true, width: 52,
        render: (r: Recommendation) => (
          <button type="button" className="h10-sug-iconbtn pz" disabled={busy === r.id} aria-label="Stop suggesting this recommendation" title="Stop suggesting this — nothing changes at Amazon" onClick={() => void muteRec(r)}>
            <Pause size={14} />
          </button>
        ),
      } as GridColumn<Recommendation>,
    ] : isMuted ? [
      {
        key: 'unmute', label: 'Unmute', metric: false, sortable: false, freezeRight: true, width: 88,
        tip: 'Let the engines raise this recommendation again when the data still warrants it.',
        render: (r: Recommendation) => (
          <button type="button" className="h10-sug-iconbtn" disabled={busy === r.id} aria-label="Resume suggesting this recommendation" title="Resume — the engines may raise it again" onClick={() => void unmuteRec(r.id)}>
            <Volume2 size={14} />
          </button>
        ),
      } as GridColumn<Recommendation>,
    ] : [
      {
        key: 'done', label: 'Applied', tip: 'Applied from this browser. Recommendations have no stored status on the server — the receipt of any live write is in the Change Log.', metric: false, sortable: false, freezeRight: true, width: 96,
        render: () => <span className="h10-sug-applied"><Check size={14} /> Applied</span>,
      } as GridColumn<Recommendation>,
    ]),
  ]

  return (
    <>
      <AdsFilterBar
        filters={filters}
        value={filterState}
        onChange={setFilterState}
        defaultOpen
        notesSlot={<ScopeNotes notes={['this feed is account-wide — recommendations aggregate the whole account, so the scope grains (product line / portfolio / campaign / ad group) do not apply here']} />}
      />

      <AdsDataGrid<Recommendation>
        rows={rows}
        loading={loading}
        rowId={(r) => r.id}
        noun="recommendation"
        firstColLabel="Recommendation"
        renderFirst={(r) => (
          <span className="h10-sug-recsrc">
            <span className={`rec-sevchip rec-sevchip--${r.severity}`}>{r.severity}</span>
            <span className="ttl" title={r.title}>{r.title}</span>
          </span>
        )}
        firstSortValue={(r) => r.title}
        columns={columns}
        /* the definitions AND the state — a grid without `filters` returns rows uncut */
        filters={filters}
        filterState={filterState}
        onFilterStateChange={setFilterState}
        hideFilterPanel
        /* the verbs are the decision — no checkbox column promising bulk ones */
        selectable={false}
        searchable
        searchPlaceholder="Search recommendations…"
        searchValue={(r) => `${r.title} ${r.detail}`}
        pagerCentered
        customizable
        storageKey="suggestions-grid-recommendations-v1"
        defaultSort={{ key: 'impact', dir: 'desc' }}
        onRowClick={(r) => writeUrl({ row: r.id }, { history: true })}
        keyboardNav={!detail && !confirm}
        onRowKey={(r, k) => {
          if (!isPending) return
          if (k === 'a' && r.apply) setConfirm({ kind: 'one', rec: r })
          else if (k === 'e') dismiss(r)
        }}
        toolbarLeft={isPending ? (
          <span className="h10-sug-applybar">
            <Button variant="primary" size="sm" disabled={highPending.length === 0 || !!busy} onClick={() => setConfirm({ kind: 'all', recs: highPending })}>
              <Check size={13} /> Apply all high-priority ({highPending.length})
            </Button>
          </span>
        ) : null}
        toolbarRight={
          <span className="h10-sug-toolbar">
            <Button variant="secondary" size="sm" onClick={load}><RefreshCw size={13} /> Refresh</Button>
          </span>
        }
        emptyNode={
          <EmptyState
            icon={<Sparkles size={26} />}
            title={isMuted ? 'Nothing muted' : isPending ? 'Nothing to act on right now' : 'Nothing applied yet'}
            description={isMuted
              ? '⏸ a recommendation and it lands here: nothing about your account changed, the engines simply stop raising it. Unmute any time.'
              : isPending
                ? 'The engines recompute this feed from live account data — when one finds something worth doing, it appears here.'
                : 'Apply a recommendation and it moves here. Applied is this browser’s memory — the receipt of any live write is in the Change Log.'}
          />
        }
      />

      {/* Per-action confirm — shows the diff + live account mode (the gate is server-side) */}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'all' ? 'Apply all high-priority' : 'Apply recommendation'}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="primary" className={mode === 'sandbox' ? undefined : 'rec-btn-live'} size="sm" disabled={!!busy} onClick={confirmApply}>
              {mode === 'sandbox' ? 'Apply in sandbox' : 'Apply'}
            </Button>
          </>
        }
      >
        {confirm?.kind === 'one' && (
          <div className="rec-confirm-rec">
            <div className="rec-confirm-title">{confirm.rec.title}</div>
            <div className="rec-confirm-detail">{confirm.rec.detail}</div>
          </div>
        )}
        {confirm?.kind === 'all' && (
          <ul className="rec-confirm-list">
            {confirm.recs.map((r) => (
              <li className="rec-confirm-li" key={r.id}>
                <span className="rec-card-dot" style={{ background: CAT_DOT[r.category], marginTop: 0 }} />
                <b>{r.title}</b>
                <span className="rec-impact">{r.estImpactCents > 0 ? eur(r.estImpactCents) : ''}</span>
              </li>
            ))}
          </ul>
        )}
        <div className={`rec-mode rec-mode--${mode === 'sandbox' ? 'sandbox' : 'live'}`}>
          {mode === 'sandbox'
            ? <span><b>Sandbox.</b>{' '}This is simulated — nothing is sent to Amazon.</span>
            : <><AlertTriangle size={14} /> <span><b>Live mode.</b>{' '}This routes through the write-gate — it reaches Amazon only for connections &amp; campaigns you&rsquo;ve enabled, and stays simulated otherwise.</span></>}
        </div>
      </Modal>

      {/* Detail drawer — provenance + full metric proof; ?row= deep-links it like every tab */}
      {detail && (
        <Drawer
          open
          onClose={() => writeUrl({ row: '' })}
          title={<span className="rec-dh"><Tag tone="neutral">{CAT_LABEL[detail.category]}</Tag> {detail.title}</span>}
          footer={
            <div className="rec-dfoot">
              <span className="grow" />
              {isPending && <Button variant="secondary" size="sm" onClick={() => dismiss(detail)}><X size={14} /> Dismiss</Button>}
              {isPending && detail.apply && (
                <Button variant="primary" size="sm" onClick={() => { setConfirm({ kind: 'one', rec: detail }); writeUrl({ row: '' }) }}><Check size={14} /> Apply</Button>
              )}
              {applied.has(detail.id) && <span className="rec-applied"><Check size={14} /> Applied</span>}
            </div>
          }
        >
          <div className="rec-flow">
            <div className="rec-fnode"><span className="ey">Signal</span><span className="ti">{CAT_LABEL[detail.category]} · {detail.severity} severity</span></div>
            <span className="rec-fconn" />
            <div className="rec-fnode"><span className="ey">Engine</span><span className="ti">{STRATEGY.find((s) => s.key === detail.category)?.label ?? CAT_LABEL[detail.category]}</span><span className="sub">{STRATEGY.find((s) => s.key === detail.category)?.blurb}</span></div>
            <span className="rec-fconn" />
            <div className="rec-fnode"><span className="ey">Proposed action</span><span className="ti">{detail.title}</span><span className="sub">{detail.detail}</span></div>
            {detail.category !== 'sov' && detail.estImpactCents > 0 && (
              <>
                <span className="rec-fconn" />
                <div className="rec-fnode"><span className="ey">Estimated impact</span><span className="ti">{eur2(detail.estImpactCents / 100)} <ChevronRight size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> potential / month</span></div>
              </>
            )}
          </div>
          {detail.metrics && (
            <div className="rec-dmetrics">
              <div className="rec-dmetrics-h">Supporting metrics</div>
              <div className="rec-dgrid">
                {([
                  ['Impressions', detail.metrics.impressions == null ? null : intl(detail.metrics.impressions)],
                  ['Clicks', detail.metrics.clicks == null ? null : intl(detail.metrics.clicks)],
                  ['CTR', detail.metrics.ctr == null ? null : pct(detail.metrics.ctr)],
                  ['Spend', detail.metrics.spendCents == null ? null : eur(detail.metrics.spendCents)],
                  ['Sales', detail.metrics.salesCents == null ? null : eur(detail.metrics.salesCents)],
                  ['Orders', detail.metrics.orders == null ? null : intl(detail.metrics.orders)],
                  ['ACoS', detail.metrics.acos == null ? null : pct(detail.metrics.acos)],
                  ['ROAS', detail.metrics.roas == null ? null : roasFmt(detail.metrics.roas)],
                  ['CVR', detail.metrics.cvr == null ? null : pct(detail.metrics.cvr)],
                ] as Array<[string, string | null]>).filter(([, v]) => v != null).map(([k, v]) => (
                  <div className="rec-dcell" key={k}><div className="rec-dcell-k">{k}</div><div className="rec-dcell-v">{v}</div></div>
                ))}
              </div>
            </div>
          )}
        </Drawer>
      )}
    </>
  )
}
