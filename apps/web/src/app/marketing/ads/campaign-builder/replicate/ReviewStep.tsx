'use client'

/**
 * AX3.7 — step 2: Review & Edit.
 *
 * WHAT WAS WRONG. The previous review step was one collapsed tree. A plan with
 * 43 keyword conflicts across 345 rows opened showing eleven campaign names and
 * nothing else: no counts, no filter, no bulk action, and the resolution buttons
 * two expansions and eighty rows down. Step 3 said "resolved in step 2, on the
 * keywords themselves" and sent the operator to a screen where none were
 * visible. The launch was blocked and the block was unreachable.
 *
 * THE SHAPE NOW. A structure rail on the left scopes a working pane on the
 * right — the master/detail every serious bulk editor settles on, because the
 * thing you are editing and the thing you are navigating cannot be the same
 * scrolling surface. Above it, anything blocking is stated with the action that
 * clears it. Across it, a flat view of every target with filters, because "show
 * me all 43 conflicts wherever they are" is a question the tree cannot answer.
 *
 * Nothing here decides what gets created. It emits an edit set; the server
 * rebuilds the plan from the live account, replays it, and re-runs the whole
 * gate — so no arrangement of these controls can talk past the self-competition
 * check.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, ChevronRight, Layers, Trash2, RotateCcw,
  Search, SlidersHorizontal, Check, X,
} from 'lucide-react'
import { Button } from '@/design-system/primitives'
import {
  viewPlan, conflictGroups, dropConflicts, restoreConflicts, describeChanges,
  setKeyed, toggleId, setIds, countEdits,
  type TargetView, type CampaignView,
} from './edit-model'
import type { Plan, PlanEdits, PlanConflict } from './replicate-types'
import { TargetTable } from './ReviewTable'
import {
  CampaignSettings, AdGroupSettings, ChangesDrawer,
  RenameModal, BulkValueModal, AddTargetsModal, MatchTypeModal,
} from './ReviewPanels'

type Scope = { kind: 'all' } | { kind: 'campaign'; id: string } | { kind: 'adGroup'; id: string }
type Filter = 'all' | 'conflicts' | 'keywords' | 'negatives' | 'products' | 'auto' | 'edited' | 'dropped'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'conflicts', label: 'Conflicts' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'negatives', label: 'Negatives' },
  { key: 'products', label: 'Product targets' },
  { key: 'auto', label: 'Auto clauses' },
  { key: 'edited', label: 'Changed' },
  { key: 'dropped', label: 'Dropped' },
]

const FLOOR_CENTS = 2

export interface ReviewStepProps {
  plan: Plan
  edits: PlanEdits
  setEdits: (e: PlanEdits) => void
  conflictDecisions: Record<string, 'skip' | 'accept'>
  setConflictDecisions: (d: Record<string, 'skip' | 'accept'>) => void
  /** Every product the operator picked in step 1 — the ceiling for per-ad-group ads. */
  allAsins: string[]
  /** The gate's verdict over the edited plan — see viewPlan's `serverConflicts`. */
  serverConflicts: PlanConflict[]
  /** Set by step 3's "resolve this" buttons: open on the conflicts, filtered. */
  focus: { filter?: Filter; campaignId?: string; nonce: number } | null
}

export function ReviewStep({
  plan, edits, setEdits, conflictDecisions, setConflictDecisions, allAsins, serverConflicts, focus,
}: ReviewStepProps) {
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const [flat, setFlat] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [changesOpen, setChangesOpen] = useState(false)
  const [rename, setRename] = useState<{ kind: 'campaign' | 'adGroup'; id: string; current: string } | null>(null)
  const [bulk, setBulk] = useState<null | 'bid' | 'budget' | 'selbid'>(null)
  const [matchOpen, setMatchOpen] = useState(false)
  const [addTo, setAddTo] = useState<{ id: string; name: string } | null>(null)

  // Arriving from step 3's blocker actions. `nonce` makes a repeat click work.
  useEffect(() => {
    if (!focus) return
    if (focus.campaignId) { setFlat(false); setScope({ kind: 'campaign', id: focus.campaignId }) }
    else if (focus.filter) { setFlat(true); setFilter(focus.filter) }
    setSel(new Set())
  }, [focus])

  const view = useMemo(
    () => viewPlan(plan, edits, conflictDecisions, serverConflicts),
    [plan, edits, conflictDecisions, serverConflicts],
  )
  const conflicts = useMemo(() => conflictGroups(view, conflictDecisions), [view, conflictDecisions])
  const unresolved = conflicts.filter((c) => c.unresolved)
  const changes = useMemo(() => describeChanges(plan, edits), [plan, edits])

  const byCampaign = useMemo(() => new Map(view.campaigns.map((c) => [c.id, c])), [view])
  const byAdGroup = useMemo(
    () => new Map(view.campaigns.flatMap((c) => c.adGroups.map((g) => [g.id, g] as const))),
    [view],
  )

  // ── the rows the working pane is showing ────────────────────────────────
  const scopedRows: TargetView[] = useMemo(() => {
    if (flat) return view.targets
    if (scope.kind === 'campaign') return byCampaign.get(scope.id)?.adGroups.flatMap((g) => g.targets) ?? []
    if (scope.kind === 'adGroup') return byAdGroup.get(scope.id)?.targets ?? []
    return []
  }, [flat, scope, view, byCampaign, byAdGroup])

  const needle = q.trim().toLowerCase()
  const rows = useMemo(() => scopedRows.filter((r) => {
    if (needle && !r.expression.toLowerCase().includes(needle)
      && !r.campaignName.toLowerCase().includes(needle) && !r.adGroupName.toLowerCase().includes(needle)) return false
    const kind = (r.kind ?? 'KEYWORD').toUpperCase()
    switch (filter) {
      case 'conflicts': return !!r.conflict
      case 'keywords': return kind === 'KEYWORD' && !r.isNegative
      case 'negatives': return r.isNegative
      case 'products': return kind === 'PRODUCT' || kind === 'CATEGORY'
      case 'auto': return kind === 'AUTO'
      case 'edited': return r.touched
      case 'dropped': return r.removed
      default: return true
    }
  }), [scopedRows, needle, filter])

  // ── edit handlers ───────────────────────────────────────────────────────
  const selRows = useMemo(() => view.targets.filter((r) => sel.has(r.id)), [view, sel])
  const onSelect = (ids: string[], on: boolean) => {
    const n = new Set(sel)
    for (const id of ids) { if (on) n.add(id); else n.delete(id) }
    setSel(n)
  }

  const removeRow = (r: TargetView) => {
    if (r.added) {
      const i = Number(r.id.split(':')[2])
      const of = (edits.addedTargets ?? []).filter((a) => a.adGroupId === r.adGroupId)
      const victim = of[i]
      if (victim) setEdits({ ...edits, addedTargets: (edits.addedTargets ?? []).filter((a) => a !== victim) })
      return
    }
    setEdits(toggleId(edits, 'removedTargets', r.id))
  }

  const setRowsRemoved = (list: TargetView[], removed: boolean) =>
    setEdits(setIds(edits, 'removedTargets', list.filter((r) => !r.added).map((r) => r.id), removed))

  const acceptConflicts = (keys: string[]) => {
    const next = { ...conflictDecisions }
    for (const k of keys) next[k] = 'accept'
    setConflictDecisions(next)
  }
  const dropAll = (groups: typeof conflicts) => {
    const { edits: e, decisions } = dropConflicts(edits, groups)
    setEdits(e)
    setConflictDecisions({ ...conflictDecisions, ...decisions })
  }
  const undropAll = (groups: typeof conflicts) => {
    setEdits(restoreConflicts(edits, groups))
    const next = { ...conflictDecisions }
    for (const g of groups) delete next[g.key]
    setConflictDecisions(next)
  }

  const activeCampaign = scope.kind === 'campaign' ? byCampaign.get(scope.id) ?? null
    : scope.kind === 'adGroup' ? byCampaign.get(byAdGroup.get(scope.id)?.campaignId ?? '') ?? null : null
  const activeAdGroup = scope.kind === 'adGroup' ? byAdGroup.get(scope.id) ?? null : null

  return (
    <div className="h10-rep-review2">
      {/* ── what is blocking, and how to clear it ───────────────────────── */}
      {unresolved.length > 0 ? (
        <div className="h10-rep-gate bad">
          <div className="ic"><AlertTriangle size={18} aria-hidden /></div>
          <div className="tx">
            <b>{unresolved.length} keyword{unresolved.length === 1 ? '' : 's'} would bid against campaigns you already run</b>
            <p>
              These are category and competitor terms, not this product’s own. Creating them puts two of your
              products in the same auction, where you raise your own clearing price and split one pool of demand.
              {conflicts.length > unresolved.length && <> {conflicts.length - unresolved.length} of {conflicts.length} already resolved.</>}
            </p>
          </div>
          <div className="ax">
            <Button variant="primary" onClick={() => { setFlat(true); setFilter('conflicts'); setSel(new Set()) }}>
              Review them
            </Button>
            <Button onClick={() => dropAll(unresolved)}>Drop all {unresolved.length}</Button>
            <Button onClick={() => acceptConflicts(unresolved.map((c) => c.key))}>Accept all {unresolved.length}</Button>
          </div>
        </div>
      ) : conflicts.length > 0 && (
        <div className="h10-rep-gate ok">
          <div className="ic"><CheckCircle2 size={18} aria-hidden /></div>
          <div className="tx">
            <b>All {conflicts.length} keyword conflicts resolved</b>
            <p>
              {conflicts.filter((c) => c.decision === 'accept').length} accepted,{' '}
              {conflicts.filter((c) => c.decision !== 'accept').length} dropped.
            </p>
          </div>
          <div className="ax"><Button onClick={() => undropAll(conflicts)}>Start over</Button></div>
        </div>
      )}

      <div className={`h10-rep-work ${flat ? 'solo' : ''}`}>
        {/* ── structure rail ───────────────────────────────────────────── */}
        {!flat && (
          <aside className="h10-rep-rail" aria-label="Structure">
            <button type="button" className={`root ${scope.kind === 'all' ? 'on' : ''}`} onClick={() => setScope({ kind: 'all' })}>
              <span className="n">All campaigns</span>
              <span className="c">{view.campaigns.filter((c) => !c.removed).length}</span>
            </button>
            {view.campaigns.map((c) => {
              const conf = c.adGroups.flatMap((g) => g.targets).filter((t) => t.conflict && t.decision !== 'accept' && !t.removed).length
              const on = scope.kind === 'campaign' && scope.id === c.id
              return (
                <div key={c.id} className="grp">
                  <button type="button" className={`cmp ${on ? 'on' : ''} ${c.removed ? 'cut' : ''}`} onClick={() => setScope({ kind: 'campaign', id: c.id })}>
                    <ChevronRight size={13} aria-hidden />
                    <span className="n" title={c.name}>{c.name}</span>
                    {conf > 0 && <span className="cf" title={`${conf} unresolved conflicts`}>{conf}</span>}
                  </button>
                  {c.adGroups.map((g) => {
                    const gconf = g.targets.filter((t) => t.conflict && t.decision !== 'accept' && !t.removed).length
                    const gon = scope.kind === 'adGroup' && scope.id === g.id
                    return (
                      <button key={g.id} type="button" className={`ag ${gon ? 'on' : ''} ${g.removed ? 'cut' : ''}`} onClick={() => setScope({ kind: 'adGroup', id: g.id })}>
                        <Layers size={11} aria-hidden />
                        <span className="n" title={g.name}>{g.name}</span>
                        <span className="c">{g.targets.filter((t) => !t.removed).length}</span>
                        {gconf > 0 && <span className="cf">{gconf}</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </aside>
        )}

        {/* ── working pane ─────────────────────────────────────────────── */}
        <div className="h10-rep-pane">
          <div className="h10-rep-toolbar">
            <div className="views">
              <button type="button" className={!flat ? 'on' : ''} onClick={() => setFlat(false)}>Structure</button>
              <button type="button" className={flat ? 'on' : ''} onClick={() => setFlat(true)}>
                All targets <span className="n">{view.targets.length}</span>
              </button>
            </div>
            <div className="h10-rep-search">
              <Search size={15} aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a keyword, ad group or campaign" aria-label="Filter the plan" />
              {q && <button type="button" className="clr" onClick={() => setQ('')} aria-label="Clear search"><X size={13} /></button>}
            </div>
            <button type="button" className={`h10-rep-chg ${changes.length ? 'on' : ''}`} onClick={() => setChangesOpen(true)}>
              <SlidersHorizontal size={13} aria-hidden /> {countEdits(edits) || 'No'} change{countEdits(edits) === 1 ? '' : 's'}
            </button>
          </div>

          {(flat || scope.kind !== 'all') && (
            <div className="h10-rep-chips">
              {FILTERS.map((f) => {
                const n = f.key === 'conflicts' ? scopedRows.filter((r) => r.conflict).length
                  : f.key === 'dropped' ? scopedRows.filter((r) => r.removed).length
                    : f.key === 'edited' ? scopedRows.filter((r) => r.touched).length : null
                if ((f.key === 'conflicts' || f.key === 'dropped' || f.key === 'edited') && !n) return null
                return (
                  <button key={f.key} type="button" className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
                    {f.label}{n != null && <span className="n">{n}</span>}
                  </button>
                )
              })}
            </div>
          )}

          {sel.size > 0 && (
            <div className="h10-rep-bulkbar">
              <span className="n">{sel.size} selected</span>
              <Button onClick={() => setRowsRemoved(selRows, true)}><Trash2 size={13} /> Drop</Button>
              <Button onClick={() => setRowsRemoved(selRows, false)}><RotateCcw size={13} /> Restore</Button>
              <Button onClick={() => setBulk('selbid')}>Set bid</Button>
              <Button onClick={() => setMatchOpen(true)}>Match type</Button>
              {selRows.some((r) => r.conflict) && (
                <Button onClick={() => acceptConflicts(selRows.filter((r) => r.conflict).map((r) => r.expression.toLowerCase()))}>
                  <Check size={13} /> Accept conflicts
                </Button>
              )}
              <span className="grow" />
              <button type="button" className="clr" onClick={() => setSel(new Set())}>Clear selection</button>
            </div>
          )}

          {/* Scope content */}
          {!flat && scope.kind === 'all' ? (
            <CampaignsTable
              campaigns={view.campaigns}
              onOpen={(id) => setScope({ kind: 'campaign', id })}
              onRemove={(id) => setEdits(toggleId(edits, 'removedCampaigns', id))}
              onBudget={(id, dailyBudget) => setEdits(setKeyed(edits, 'campaignBudgets', { id, dailyBudget }))}
              onBulkBudget={() => setBulk('budget')}
              onBulkBid={() => setBulk('bid')}
            />
          ) : (
            <>
              {activeCampaign && !flat && (
                <CampaignSettings
                  c={activeCampaign}
                  onBudget={(dailyBudget) => setEdits(setKeyed(edits, 'campaignBudgets', { id: activeCampaign.id, dailyBudget }))}
                  onStrategy={(biddingStrategy) => setEdits(setKeyed(edits, 'campaignBidding', { id: activeCampaign.id, biddingStrategy }))}
                  onPlacement={(placement, percentage) => {
                    const rest = activeCampaign.placementBidding.filter((p) => p.placement !== placement)
                    setEdits(setKeyed(edits, 'campaignPlacements', {
                      id: activeCampaign.id,
                      placementBidding: percentage > 0 ? [...rest, { placement, percentage }] : rest,
                    }))
                  }}
                  onRename={() => setRename({ kind: 'campaign', id: activeCampaign.id, current: activeCampaign.name })}
                  onRemove={() => setEdits(toggleId(edits, 'removedCampaigns', activeCampaign.id))}
                />
              )}
              {activeAdGroup && !flat && (
                <AdGroupSettings
                  g={activeAdGroup}
                  allAsins={allAsins}
                  onBid={(defaultBidCents) => setEdits(setKeyed(edits, 'adGroupBids', { id: activeAdGroup.id, defaultBidCents: Math.max(FLOOR_CENTS, defaultBidCents) }))}
                  onAsins={(asins) => setEdits(setKeyed(edits, 'adGroupAsins', { id: activeAdGroup.id, asins }))}
                  onRename={() => setRename({ kind: 'adGroup', id: activeAdGroup.id, current: activeAdGroup.name })}
                  onRemove={() => setEdits(toggleId(edits, 'removedAdGroups', activeAdGroup.id))}
                  onAdd={() => setAddTo({ id: activeAdGroup.id, name: activeAdGroup.name })}
                />
              )}
              {scope.kind === 'campaign' && !flat && activeCampaign && (
                <div className="h10-rep-aglist">
                  {activeCampaign.adGroups.map((g) => (
                    <button key={g.id} type="button" className={`item ${g.removed ? 'cut' : ''}`} onClick={() => setScope({ kind: 'adGroup', id: g.id })}>
                      <Layers size={13} aria-hidden />
                      <span className="n">{g.name}</span>
                      <span className="m">
                        {g.targets.filter((t) => !t.removed && !t.isNegative).length} targets ·{' '}
                        {g.targets.filter((t) => !t.removed && t.isNegative).length} negatives ·{' '}
                        {g.asins.length} products
                      </span>
                      <ChevronRight size={14} aria-hidden />
                    </button>
                  ))}
                </div>
              )}
              <TargetTable
                rows={rows}
                showWhere={flat}
                selected={sel}
                onSelect={onSelect}
                onExpression={(r, expression) => setEdits(setKeyed(edits, 'targetExpressions', { id: r.id, expression }))}
                onMatch={(r, expressionType) => setEdits(setKeyed(edits, 'targetMatchTypes', { id: r.id, expressionType }))}
                onBid={(r, bidCents) => setEdits(setKeyed(edits, 'targetBids', { id: r.id, bidCents: Math.max(FLOOR_CENTS, bidCents) }))}
                onRemove={removeRow}
                onConflict={(r, d) => (d === 'accept'
                  ? acceptConflicts([r.expression.toLowerCase()])
                  : dropAll(conflicts.filter((c) => c.key === r.expression.toLowerCase())))}
                onGoTo={(r) => { setFlat(false); setScope({ kind: 'adGroup', id: r.adGroupId }) }}
              />
            </>
          )}
        </div>
      </div>

      <ChangesDrawer
        open={changesOpen} onClose={() => setChangesOpen(false)} changes={changes} setEdits={setEdits}
        onClearAll={() => { setEdits({}); setConflictDecisions({}); setChangesOpen(false) }}
      />
      {rename && (
        <RenameModal
          current={rename.current} what={rename.kind === 'campaign' ? 'campaign' : 'ad group'}
          onClose={() => setRename(null)}
          onSave={(name) => {
            setEdits(setKeyed(edits, rename.kind === 'campaign' ? 'renamedCampaigns' : 'renamedAdGroups', { id: rename.id, name }))
            setRename(null)
          }}
        />
      )}
      {addTo && (
        <AddTargetsModal
          adGroupName={addTo.name} onClose={() => setAddTo(null)}
          onAdd={(list) => {
            setEdits({ ...edits, addedTargets: [...(edits.addedTargets ?? []), ...list.map((a) => ({ ...a, adGroupId: addTo.id }))] })
            setAddTo(null)
          }}
        />
      )}
      {matchOpen && (
        <MatchTypeModal
          count={sel.size} onClose={() => setMatchOpen(false)}
          onApply={(mt) => {
            let next = edits
            for (const r of selRows) {
              if ((r.kind ?? 'KEYWORD').toUpperCase() !== 'KEYWORD' || r.added) continue
              const value = r.isNegative && mt === 'BROAD' ? 'PHRASE' : mt
              next = setKeyed(next, 'targetMatchTypes', { id: r.id, expressionType: value })
            }
            setEdits(next)
            setMatchOpen(false)
          }}
        />
      )}
      {bulk && (
        <BulkValueModal
          title={bulk === 'budget' ? 'Set every daily budget' : bulk === 'bid' ? 'Set every bid' : `Set the bid on ${sel.size} target${sel.size === 1 ? '' : 's'}`}
          label={bulk === 'budget' ? 'Daily budget' : 'Bid'}
          hint={bulk === 'budget' ? 'Applies to every campaign in the plan.' : 'Floored at €0.02, Amazon’s minimum.'}
          onClose={() => setBulk(null)}
          onApply={(v) => {
            const n = Number(v) || 0
            if (bulk === 'budget') {
              setEdits({ ...edits, campaignBudgets: view.campaigns.map((c) => ({ id: c.id, dailyBudget: Math.max(1, n) })) })
            } else {
              const cents = Math.max(FLOOR_CENTS, Math.round(n * 100))
              const targets = bulk === 'selbid' ? selRows : view.targets
              let next = edits
              if (bulk === 'bid') {
                next = { ...next, adGroupBids: view.campaigns.flatMap((c) => c.adGroups.map((g) => ({ id: g.id, defaultBidCents: cents }))) }
              }
              for (const r of targets) {
                if (r.isNegative || r.added) continue
                next = setKeyed(next, 'targetBids', { id: r.id, bidCents: cents })
              }
              setEdits(next)
            }
            setBulk(null)
          }}
        />
      )}
    </div>
  )
}

/** The root view: every campaign, what it holds, and what it costs. */
function CampaignsTable({ campaigns, onOpen, onRemove, onBudget, onBulkBudget, onBulkBid }: {
  campaigns: CampaignView[]
  onOpen: (id: string) => void
  onRemove: (id: string) => void
  onBudget: (id: string, v: number) => void
  onBulkBudget: () => void
  onBulkBid: () => void
}) {
  const total = campaigns.filter((c) => !c.removed).reduce((s, c) => s + c.dailyBudget, 0)
  return (
    <div className="h10-rep-tblwrap">
      <div className="h10-rep-tblbar">
        <span>Click a campaign to edit its bidding, placements and targets.</span>
        <span className="grow" />
        <button type="button" onClick={onBulkBid}>Set all bids</button>
        <button type="button" onClick={onBulkBudget}>Set all budgets</button>
      </div>
      <table className="h10-rep-tbl camps">
        <thead>
          <tr>
            <th>Campaign</th><th className="ct">Type</th><th className="ct">Targets</th><th className="ct">Negatives</th>
            <th className="ct">Products</th><th className="ct">Placements</th><th className="bud">Daily budget</th><th className="act" />
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => {
            const t = c.adGroups.flatMap((g) => g.targets).filter((x) => !x.removed)
            const conf = t.filter((x) => x.conflict && x.decision !== 'accept').length
            const plc = c.placementBidding.filter((p) => p.percentage > 0)
            return (
              <tr key={c.id} className={c.removed ? 'cut' : ''}>
                <td className="exp">
                  <button type="button" className="expbtn" onClick={() => onOpen(c.id)}>
                    <b>{c.name}</b>
                  </button>
                  {conf > 0 && <span className="tag cf">{conf} conflict{conf === 1 ? '' : 's'}</span>}
                  <span className="whrline">{c.adGroups.length} ad group{c.adGroups.length === 1 ? '' : 's'}</span>
                </td>
                <td className="ct"><span className={`tag ${c.targetingType === 'AUTO' ? 'auto' : ''}`}>{c.targetingType === 'AUTO' ? 'auto' : 'manual'}</span></td>
                <td className="ct">{t.filter((x) => !x.isNegative).length}</td>
                <td className="ct">{t.filter((x) => x.isNegative).length}</td>
                <td className="ct">{c.adGroups.reduce((s, g) => s + g.asins.length, 0)}</td>
                <td className="ct">
                  {plc.length
                    ? <span className="tag" title={plc.map((p) => `${p.placement.replace('PLACEMENT_', '').replace(/_/g, ' ').toLowerCase()} +${p.percentage}%`).join(', ')}>{plc.length} set</span>
                    : <span className="dash">—</span>}
                </td>
                <td className="bud">
                  <label className="inl">
                    <span>€</span>
                    <input inputMode="decimal" value={String(c.dailyBudget)} aria-label={`Daily budget for ${c.name}`}
                      onChange={(e) => onBudget(c.id, Number(e.target.value) || 0)} />
                  </label>
                </td>
                <td className="act">
                  <button type="button" className={`cutbtn ${c.removed ? 'on' : ''}`} onClick={() => onRemove(c.id)}
                    aria-label={c.removed ? `Restore ${c.name}` : `Don’t create ${c.name}`}>
                    {c.removed ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr><td colSpan={6} /><td className="bud"><b>€{total.toFixed(2)}/day</b></td><td /></tr>
        </tfoot>
      </table>
    </div>
  )
}
