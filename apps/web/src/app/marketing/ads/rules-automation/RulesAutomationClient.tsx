'use client'

/**
 * R1 — Rules & Automation, pixel-matched to Helium 10 Ads.
 *
 * The page is the shared ads shell (AdsPageHeader + sidebar) + a sticky 10-tab bar
 * (reusing the proven .h10-cd-tabs styling) + the active tab's body. The first tab,
 * "Rules", renders the campaign automation grid through the ONE shared AdsDataGrid —
 * same toolbar / sticky checkbox+first column / pager as the Ad Manager, so any future
 * grid change propagates here too. Cells (Bid Rule · Target ACoS · Min/Max Bid · Bid
 * Automation · Budget Rule) reuse the existing h10-* cell markup; per-cell hover-pencil
 * editing rides AdsDataGrid's built-in editMode (bulk:false) popover.
 *
 * The other 9 tabs are navigable but render a "coming soon" panel until we have video
 * references for each (per scoping decision 2026-06-19).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Plus, ExternalLink, Atom, Wand2 } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter, type GridEditMode } from '../campaigns/_grid/AdsDataGrid'
import { HoverCard } from '../campaigns/FilterDropdown'
import { getBackendUrl } from '@/lib/backend-url'
import { RuleTypeModal } from './_shared/RuleTypeModal'
import { NoDataIllus } from './_shared/NoDataIllus'
import { RuleListTab } from './tabs/RuleListTab'
import { SovTrackerTab } from './tabs/SovTrackerTab'
import { BudgetScheduleTab } from './_schedule/BudgetScheduleTab'
import { TAB_RULES } from './tabs/placeholderSeeds'

// ── data (subset of the Ad Manager campaign shape; same endpoint) ──
interface Camp {
  id: string; name: string; marketplace?: string | null; status: string
  adProduct?: string | null; type?: string | null
  portfolioId?: string | null
  targetAcos?: number | null; bidAutomation?: boolean
  bidAlgorithm?: string | null
  minMaxBid?: { min: number | null; max: number | null } | null
}

const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Row icon cluster (H10): targeting letter (A=auto / M=manual) + product badge (SP/SB/SD).
const productBadge = (c: Camp): string => (c.adProduct === 'SPONSORED_BRANDS' || c.type === 'SB') ? 'SB' : (c.adProduct === 'SPONSORED_DISPLAY' || c.type === 'SD') ? 'SD' : 'SP'
const targetingLetter = (c: Camp): string => /(^|[^a-z])auto([^a-z]|$)/i.test(c.name) ? 'A' : 'M'
const STATUS_LABEL: Record<string, string> = { ENABLED: 'Enabled', PAUSED: 'Paused', ARCHIVED: 'Archived' }
const TYPE_LABEL: Record<string, string> = { SPONSORED_PRODUCTS: 'Sponsored Products', SPONSORED_BRANDS: 'Sponsored Brands', SPONSORED_DISPLAY: 'Sponsored Display', SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' }
const typeLabel = (c: Camp) => TYPE_LABEL[(c.type ?? c.adProduct ?? '') as string] ?? 'Sponsored Products'

// Bid algorithms (the "Bid Rule" cell). UI-only until Amazon exposes a per-campaign
// field — selection updates local state (matches the Ad Manager grid).
const BID_ALGOS: Array<{ value: string; label: string }> = [
  { value: 'TARGET_ACOS', label: 'Target ACOS' },
  { value: 'MAX_IMPRESSIONS', label: 'Max Impressions' },
  { value: 'MAX_ORDERS', label: 'Max Orders' },
]
const bidAlgoLabel = (c: Camp): string => BID_ALGOS.find((a) => a.value === (c.bidAlgorithm ?? 'TARGET_ACOS'))?.label ?? 'Target ACOS'
const mmLabel = (mm: Camp['minMaxBid']): string =>
  mm && (mm.min != null || mm.max != null) ? `${mm.min != null ? eur(mm.min) : '—'} – ${mm.max != null ? eur(mm.max) : '—'}` : 'None'

// Verbatim Helium 10 Ads column tooltips (captured from the live product).
const COL_TIPS: Record<string, string> = {
  bidRule: 'Custom Bid Rule - Create your own bid change logic using PPC metrics available in Analytics',
  targetAcos: 'Only if "Target ACoS" is selected for the Bid Algorithm. This selection dictates the ACoS goal. Click the Edit Campaigns button to edit the displayed ACoS',
  minMaxBid: 'Max bid settings do not currently take into account placement modifiers. CPCs may be higher than max bid due to placement modifiers.',
  bidAutomation: 'Active will automate the keyword bid suggestions currently found on the Suggestions page. Changes will be recorded in the Change Log',
  budgetRule: 'Budget rules automatically adjust this campaign’s budget on a schedule or based on performance.',
}

// ── the 10 tabs (exact H10 order/labels). Only "rules" is built in R1. ──
interface Tab { key: string; label: string }
const TABS: Tab[] = [
  { key: 'rules', label: 'Apply Rules' },
  { key: 'bid', label: 'Bid' },
  { key: 'keyword-harvest', label: 'Keyword Harvest' },
  { key: 'negative-targeting', label: 'Negative Targeting' },
  { key: 'budget', label: 'Budget' },
  { key: 'dayparting', label: 'Dayparting Schedules' },
  { key: 'budget-schedules', label: 'Budget Schedules' },
  { key: 'placement', label: 'Placement' },
  { key: 'share-of-voice', label: 'Share of Voice' },
  { key: 'keyword-tracker', label: 'Keyword Tracker' },
]

async function patchJson(url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    return r.ok && j?.ok !== false
  } catch { return false }
}

export function RulesAutomationClient() {
  const [rows, setRows] = useState<Camp[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('rules')
  const [market, setMarket] = useState('all')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [showRuleType, setShowRuleType] = useState(false)
  // selection-bar bulk popovers (Automation menu / Target ACoS / Min-Max Bid)
  const [bulkPop, setBulkPop] = useState<{ kind: 'automation' | 'targetAcos' | 'minMaxBid'; x: number; y: number } | null>(null)
  const [bulkDraft, setBulkDraft] = useState({ acos: '30', min: '', max: '' })

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      const d = await r.json()
      setRows((d.items ?? []) as Camp[])
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const markets = useMemo(() => Array.from(new Set(rows.map((c) => c.marketplace).filter(Boolean))) as string[], [rows])
  const portfolioOpts = useMemo(() => Array.from(new Set(rows.map((c) => c.portfolioId).filter(Boolean))).map((p) => ({ value: String(p), label: String(p) })), [rows])
  const visible = useMemo(() => (market === 'all' ? rows : rows.filter((c) => c.marketplace === market)), [rows, market])

  // optimistic per-campaign update + persist (UI-only fields stay local)
  const patchLocal = (id: string, patch: Partial<Camp>) => setRows((rs) => rs.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  const toggleAutomation = (c: Camp) => {
    const next = !c.bidAutomation
    patchLocal(c.id, { bidAutomation: next })
    void patchJson(`${getBackendUrl()}/api/advertising/campaigns/${c.id}/automation`, { bidAutomation: next })
  }

  // ── selection-bar bulk actions (Automation · Assign Rule · Target ACoS · Min/Max Bid) ──
  const openBulk = (kind: 'automation' | 'targetAcos' | 'minMaxBid', e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect()
    setBulkPop({ kind, x: r.left, y: r.bottom + 6 })
  }
  const applyBulkAutomation = (on: boolean) => {
    [...sel].forEach((id) => { patchLocal(id, { bidAutomation: on }); void patchJson(`${getBackendUrl()}/api/advertising/campaigns/${id}/automation`, { bidAutomation: on }) })
    setBulkPop(null)
  }
  const applyBulkTargetAcos = () => {
    const frac = (Number(bulkDraft.acos) || 0) / 100
    ;[...sel].forEach((id) => { patchLocal(id, { targetAcos: frac }); void patchJson(`${getBackendUrl()}/api/advertising/campaigns/${id}/automation`, { targetAcos: frac }) })
    setBulkPop(null)
  }
  const applyBulkMinMaxBid = () => {
    const mm = { min: bulkDraft.min.trim() ? Number(bulkDraft.min) : null, max: bulkDraft.max.trim() ? Number(bulkDraft.max) : null }
    ;[...sel].forEach((id) => patchLocal(id, { minMaxBid: mm }))
    setBulkPop(null)
  }

  // ── grid columns (all left-aligned "settings" cells, like the Ad Manager cluster) ──
  const columns: GridColumn<Camp>[] = useMemo(() => [
    {
      key: 'bidRule', label: 'Bid Rule', metric: false, sortable: false, tip: COL_TIPS.bidRule,
      render: (c) => <span className="h10-bidrule"><Atom size={14} className="h10-rr-atom" /> {bidAlgoLabel(c)}</span>,
    },
    {
      key: 'targetAcos', label: 'Target ACoS', metric: false, sortable: false, tip: COL_TIPS.targetAcos,
      render: (c) => ((c.bidAlgorithm ?? 'TARGET_ACOS') === 'TARGET_ACOS' ? `${((c.targetAcos ?? 0.3) * 100).toFixed(2)}%` : '-'),
    },
    {
      key: 'minMaxBid', label: 'Min/Max Bid', metric: false, sortable: false, tip: COL_TIPS.minMaxBid,
      render: (c) => mmLabel(c.minMaxBid),
    },
    {
      key: 'bidAutomation', label: 'Bid Automation', metric: false, sortable: false, tip: COL_TIPS.bidAutomation,
      render: (c) => (
        <button type="button" className={`h10-bktoggle ${c.bidAutomation ? 'on' : ''}`} role="switch" aria-checked={!!c.bidAutomation} aria-label={`Bid Automation for ${c.name}`} onClick={() => toggleAutomation(c)}><span /></button>
      ),
    },
    {
      key: 'budgetRule', label: 'Budget Rule', metric: false, sortable: false, tip: COL_TIPS.budgetRule,
      render: () => <span className="h10-rr-none">None</span>,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  // ── per-cell hover-pencil edit (rides AdsDataGrid's editMode popover) ──
  const editMode: GridEditMode<Camp> = useMemo(() => ({
    label: 'Edit', bulk: false,
    fields: [
      {
        key: 'targetAcos',
        initial: (c) => String(Math.round((c.targetAcos ?? 0.3) * 100)),
        render: (v, set) => (
          <span className="h10-bulk-inp sf"><input inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} aria-label="Target ACoS" autoFocus /><span className="sfx">%</span></span>
        ),
      },
      {
        key: 'bidRule',
        initial: (c) => c.bidAlgorithm ?? 'TARGET_ACOS',
        render: (v, set) => (
          <select className="h10-rr-select" value={v} onChange={(e) => set(e.target.value)} aria-label="Bid Rule">
            {BID_ALGOS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        ),
      },
      {
        key: 'minMaxBid',
        initial: (c) => `${c.minMaxBid?.min ?? ''}|${c.minMaxBid?.max ?? ''}`,
        render: (v, set) => {
          const [mn, mx] = v.split('|')
          return (
            <span className="h10-rr-mm">
              <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Min" value={mn} onChange={(e) => set(`${e.target.value}|${mx ?? ''}`)} aria-label="Min bid" /></span>
              <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Max" value={mx} onChange={(e) => set(`${mn ?? ''}|${e.target.value}`)} aria-label="Max bid" /></span>
            </span>
          )
        },
      },
    ],
    onApply: async (edits) => {
      for (const e of edits) {
        const { id, values } = e
        if (values.targetAcos != null) {
          const frac = (Number(values.targetAcos) || 0) / 100
          patchLocal(id, { targetAcos: frac })
          await patchJson(`${getBackendUrl()}/api/advertising/campaigns/${id}/automation`, { targetAcos: frac })
        }
        if (values.bidRule != null) patchLocal(id, { bidAlgorithm: values.bidRule })
        if (values.minMaxBid != null) {
          const [mn, mx] = values.minMaxBid.split('|')
          patchLocal(id, { minMaxBid: { min: mn?.trim() ? Number(mn) : null, max: mx?.trim() ? Number(mx) : null } })
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  const filters: GridFilter[] = useMemo(() => [
    { key: 'status', label: 'Status', kind: 'multiselect', options: [{ value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }, { value: 'ARCHIVED', label: 'Archived' }], placeholder: 'Enabled', value: (c) => (c as Camp).status },
    { key: 'type', label: 'Campaign Type', kind: 'select', options: [{ value: 'SP', label: 'Sponsored Products' }, { value: 'SB', label: 'Sponsored Brands' }, { value: 'SD', label: 'Sponsored Display' }], placeholder: 'All', value: (c) => productBadge(c as Camp) },
    { key: 'portfolio', label: 'Portfolio', kind: 'select', options: portfolioOpts, placeholder: 'Select a Portfolio', searchable: true, wide: true, value: (c) => String((c as Camp).portfolioId ?? '') },
    { key: 'campaign', label: 'Campaign', kind: 'select', options: visible.map((c) => ({ value: c.name, label: c.name })), placeholder: 'Select a Campaign', searchable: true, wide: true, value: (c) => (c as Camp).name },
    { key: 'bidAutomation', label: 'Bid Automation', kind: 'select', options: [{ value: 'on', label: 'Active' }, { value: 'off', label: 'Inactive' }], placeholder: 'All', value: (c) => ((c as Camp).bidAutomation ? 'on' : 'off') },
  ], [portfolioOpts, visible])

  const renderFirst = (c: Camp): ReactNode => (
    <div className="nmw">
      <HoverCard rows={[
        ['Status', STATUS_LABEL[c.status] ?? c.status],
        ['Targeting Type', targetingLetter(c) === 'A' ? 'Auto' : 'Manual'],
        ['Campaign Type', typeLabel(c)],
      ]}>
        <span className="tg" data-t={targetingLetter(c)}>{targetingLetter(c)}</span>
        <span className="pb" data-p={productBadge(c)}>{productBadge(c)}</span>
      </HoverCard>
      <span className="t" title={c.name}>{c.name}</span>
      {c.marketplace && <span className="mk">{c.marketplace}</span>}
      <a className="h10-open" href={`/marketing/ads/campaigns/${c.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
    </div>
  )

  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0]

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Rules & Automation"
        subtitle="Create and manage rules for all of your campaigns"
        markets={markets}
        market={market}
        onMarketChange={setMarket}
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        primaryAction={{ label: 'Rule', icon: <Plus size={15} />, onClick: () => setShowRuleType(true) }}
      />

      {/* sticky 10-tab bar (reuses the proven .h10-cd-tabs underline styling) */}
      <div className="h10-cd-tabs h10-rules-tabs" role="tablist" aria-label="Rule types">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            className={`h10-cd-tab ${t.key === tab ? 'on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'rules' ? (
        <AdsDataGrid<Camp>
          rows={visible}
          loading={loading}
          rowId={(c) => c.id}
          noun="Campaign"
          firstColLabel="Campaign"
          renderFirst={renderFirst}
          firstSortValue={(c) => c.name}
          columns={columns}
          filters={filters}
          editMode={editMode}
          selectable
          selected={sel}
          onSelectedChange={setSel}
          selectionActions={() => (
            <span className="h10-rr-selacts">
              <button type="button" className="h10-rr-selbtn" onClick={(e) => openBulk('automation', e)}>Automation</button>
              <button type="button" className="h10-rr-selbtn" onClick={() => setShowRuleType(true)}><Plus size={13} /> Assign Rule</button>
              <button type="button" className="h10-rr-selbtn" onClick={(e) => openBulk('targetAcos', e)}>Target ACoS</button>
              <button type="button" className="h10-rr-selbtn" onClick={(e) => openBulk('minMaxBid', e)}>Min/Max Bid</button>
            </span>
          )}
          customizable={false}
          searchable
          searchPlaceholder="Search campaigns…"
          searchValue={(c) => c.name}
          pagerCentered
          filtersDefaultOpen={false}
          emptyLabel="No campaigns found."
        />
      ) : tab === 'share-of-voice' ? (
        <SovTrackerTab kind="sov" />
      ) : tab === 'keyword-tracker' ? (
        <SovTrackerTab kind="tracker" />
      ) : tab === 'budget' ? (
        <RuleListTab
          noun="Budget Rule"
          seed={[]}
          liveType="budget"
          editHref={(id) => `/marketing/ads/rules-automation/builder/budget?ruleId=${id}`}
          onAddRule={() => { window.location.href = '/marketing/ads/rules-automation/builder/budget' }}
          emptyNode={(
            <span className="h10-rr-empty">
              <NoDataIllus size={104} />
              <b>Create a Budget Rule to generate suggestions for a campaign!</b>
              <a className="h10-am-btn primary" href="/marketing/ads/rules-automation/builder/budget"><Plus size={13} /> Create Rule</a>
            </span>
          )}
        />
      ) : tab === 'dayparting' ? (
        <RuleListTab
          noun="Dayparting Schedule"
          seed={[]}
          liveType="dayparting-schedule"
          editHref={(id) => `/marketing/ads/rules-automation/builder/dayparting-schedule?scheduleId=${id}`}
          onAddRule={() => { window.location.href = '/marketing/ads/rules-automation/builder/dayparting-schedule' }}
          emptyNode={(
            <span className="h10-rr-empty">
              <NoDataIllus size={104} />
              <b>Create a Dayparting Schedule to control when your campaigns run!</b>
              <a className="h10-am-btn primary" href="/marketing/ads/rules-automation/builder/dayparting-schedule"><Plus size={13} /> Create Schedule</a>
            </span>
          )}
        />
      ) : tab === 'placement' ? (
        <RuleListTab
          noun="Placement Rule"
          seed={[]}
          liveType="placement"
          editHref={(id) => `/marketing/ads/rules-automation/builder/placement?ruleId=${id}`}
          onAddRule={() => { window.location.href = '/marketing/ads/rules-automation/builder/placement' }}
          emptyNode={(
            <span className="h10-rr-empty">
              <NoDataIllus size={104} />
              <b>Create a Placement Rule to optimize your placement bids!</b>
              <a className="h10-am-btn primary" href="/marketing/ads/rules-automation/builder/placement"><Plus size={13} /> Create Rule</a>
            </span>
          )}
        />
      ) : tab === 'budget-schedules' ? (
        <BudgetScheduleTab />
      ) : TAB_RULES[tab] ? (
        <RuleListTab noun={TAB_RULES[tab].noun} seed={TAB_RULES[tab].rows} onAddRule={() => setShowRuleType(true)} />
      ) : (
        <ComingSoon label={activeTab.label} />
      )}
      {showRuleType && <RuleTypeModal onClose={() => setShowRuleType(false)} />}
      {bulkPop && (<>
        <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setBulkPop(null)} />
        <div className="h10-editpop" style={{ position: 'fixed', left: bulkPop.x, top: bulkPop.y, zIndex: 1000 }} role="dialog" aria-label="Bulk action">
          {bulkPop.kind === 'automation' ? (
            <div className="h10-rr-bulkmenu">
              <button type="button" onClick={() => applyBulkAutomation(true)}>Enable Bid Automation</button>
              <button type="button" onClick={() => applyBulkAutomation(false)}>Disable Bid Automation</button>
            </div>
          ) : bulkPop.kind === 'targetAcos' ? (
            <>
              <div className="h">Target ACoS</div>
              <span className="h10-bulk-inp sf"><input inputMode="decimal" value={bulkDraft.acos} onChange={(e) => setBulkDraft((d) => ({ ...d, acos: e.target.value }))} aria-label="Target ACoS" autoFocus /><span className="sfx">%</span></span>
              <div className="f"><button type="button" className="h10-am-btn sm" onClick={() => setBulkPop(null)}>Cancel</button><button type="button" className="h10-am-btn primary sm" onClick={applyBulkTargetAcos}>Apply</button></div>
            </>
          ) : (
            <>
              <div className="h">Min/Max Bid</div>
              <div className="h10-rr-mm">
                <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Min" value={bulkDraft.min} onChange={(e) => setBulkDraft((d) => ({ ...d, min: e.target.value }))} aria-label="Min bid" /></span>
                <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Max" value={bulkDraft.max} onChange={(e) => setBulkDraft((d) => ({ ...d, max: e.target.value }))} aria-label="Max bid" /></span>
              </div>
              <div className="f"><button type="button" className="h10-am-btn sm" onClick={() => setBulkPop(null)}>Cancel</button><button type="button" className="h10-am-btn primary sm" onClick={applyBulkMinMaxBid}>Apply</button></div>
            </>
          )}
        </div>
      </>)}
    </div>
  )
}

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="h10-rules-soon">
      <div className="ic"><Wand2 size={26} /></div>
      <h3>{label}</h3>
      <p>This automation type is being rebuilt to match Adtomic — coming soon.</p>
      <Link href="/marketing/ads/rules-automation/builder" className="h10-am-btn primary"><Plus size={13} /> Create a Rule</Link>
    </div>
  )
}
