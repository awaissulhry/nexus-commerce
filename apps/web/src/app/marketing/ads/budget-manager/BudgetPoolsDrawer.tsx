'use client'

/**
 * ACR.6 (R9) — budget pools, on the page that owns budgets.
 *
 * THE FINDING THAT PUT THIS HERE: prod has **zero** budget pools and zero allocations, while
 * `budget-pool-rebalance.job.ts` runs against them and `ads-control-room.service.ts` counts them as
 * one of the account's engines. A live engine with no way to feed it is worse than an absent one —
 * the Control Room lists it, so it reads as "configured and quiet" rather than "never started".
 * The only surface that could create a pool was the legacy `/marketing/advertising/budget-pools`
 * workspace, which Stage 6 retires.
 *
 * Pools are NOT the same thing as the monthly plans this page's grid manages, and merging them
 * would be wrong: a plan caps ONE marketplace for ONE month, a pool shares ONE daily budget ACROSS
 * marketplaces and reweights it by profit or by aged-stock urgency. Same subject, different grain —
 * so a drawer off the budget page, not a row in its grid and not a rail entry.
 *
 * Everything the legacy pair of pages could do is here: create, enable/disable, dry-run vs live,
 * allocations, a rebalance preview before committing, and the audit history. `preview` ignores the
 * cooldown; a real run honours `pool.dryRun`, which is why the two buttons are visually distinct.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, X, FlaskConical, PlayCircle, ChevronDown, Wallet } from 'lucide-react'
import { DataGrid, Drawer } from '@/design-system/components'
import { Button, Input, SegmentedControl, ToolbarButton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'

type Strategy = 'STATIC' | 'PROFIT_WEIGHTED' | 'URGENCY_WEIGHTED'

const STRATEGIES: Array<{ key: Strategy; label: string; blurb: string }> = [
  { key: 'STATIC', label: 'Static', blurb: 'Hold the target share you set per campaign.' },
  { key: 'PROFIT_WEIGHTED', label: 'Profit-weighted', blurb: 'Move budget toward the campaigns with the best 30d true profit.' },
  { key: 'URGENCY_WEIGHTED', label: 'Urgency-weighted', blurb: 'Move budget toward products under aged-stock pressure.' },
]
const STRATEGY_LABEL: Record<Strategy, string> = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.label])) as Record<Strategy, string>

interface Allocation { id: string; marketplace: string; campaignId: string | null; targetSharePct: string; minDailyBudgetCents: number; maxDailyBudgetCents: number | null }
interface Rebalance { id: string; triggeredBy: string; inputs: unknown; outputs: unknown; dryRun: boolean; appliedAt: string | null; totalShiftCents: number; createdAt: string }
interface Pool {
  id: string; name: string; description: string | null; totalDailyBudgetCents: number
  strategy: Strategy; coolDownMinutes: number; maxShiftPerRebalancePct: number
  enabled: boolean; dryRun: boolean; lastRebalancedAt: string | null
  allocations: Allocation[]; _count: { allocations: number; rebalances: number }
}
interface CampaignSnapshot { id: string; name: string; marketplace: string | null; status: string; dailyBudget: string }
interface PoolDetail { pool: Pool & { rebalances: Rebalance[] }; campaigns: CampaignSnapshot[] }
interface ProposedRow { allocationId: string; campaignId: string | null; marketplace: string; oldBudgetCents: number; proposedBudgetCents: number; shiftCents: number; clampedReason?: string }
interface RebalanceOutcome { ok: boolean; poolName: string; strategy: string; proposed: ProposedRow[]; totalShiftCents: number; warnings: string[]; skipped?: string }

const API = () => getBackendUrl()
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : 'never')

// ── one expanded pool: controls, allocations, rebalance, history ──────────────
function PoolBody({ poolId, onChanged, toast }: { poolId: string; onChanged: () => void; toast: (m: string) => void }) {
  const [d, setD] = useState<PoolDetail | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<RebalanceOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addingId, setAddingId] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const j = await fetch(`${API()}/api/advertising/budget-pools/${poolId}`, { cache: 'no-store' }).then((r) => r.json())
      setD(j?.pool ? j : null)
    } catch { setD(null) }
  }, [poolId])
  useEffect(() => { void load() }, [load])

  const patch = async (body: Record<string, unknown>, label: string) => {
    setBusy(label)
    try {
      const r = await fetch(`${API()}/api/advertising/budget-pools/${poolId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (r.ok) { await load(); onChanged() } else toast('Update failed.')
    } finally { setBusy(null) }
  }

  const addAllocation = async () => {
    if (!addingId.trim()) return
    setBusy('add'); setError(null)
    try {
      const r = await fetch(`${API()}/api/advertising/budget-pools/${poolId}/allocations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId: addingId.trim() }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(j?.error ?? 'Could not add that campaign.'); return }
      setAddingId(''); await load(); onChanged()
    } finally { setBusy(null) }
  }

  const removeAllocation = async (allocationId: string) => {
    setBusy(allocationId)
    try {
      const r = await fetch(`${API()}/api/advertising/budget-pools/${poolId}/allocations/${allocationId}`, { method: 'DELETE' })
      if (r.ok) { await load(); onChanged() }
    } finally { setBusy(null) }
  }

  const rebalance = async (isPreview: boolean) => {
    setBusy(isPreview ? 'preview' : 'commit'); setError(null)
    try {
      const r = await fetch(`${API()}/api/advertising/budget-pools/${poolId}/rebalance${isPreview ? '?preview=1' : ''}`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(j?.reason ?? j?.error ?? 'Rebalance failed.'); return }
      if (isPreview) setPreview(j.outcome as RebalanceOutcome)
      else { setPreview(null); toast('Rebalance run.'); await load(); onChanged() }
    } finally { setBusy(null) }
  }

  if (!d) return <div className="bp-loading">Loading pool…</div>
  const { pool, campaigns } = d
  const byId = new Map(campaigns.map((c) => [c.id, c]))
  const currentTotal = pool.allocations.reduce((a, x) => {
    const c = x.campaignId ? byId.get(x.campaignId) : null
    return c ? a + Math.round(Number(c.dailyBudget) * 100) : a
  }, 0)
  const delta = currentTotal - pool.totalDailyBudgetCents

  return (
    <div className="bp-body">
      <div className="bp-stats">
        <span className="bp-stat"><i>Target/day</i><b>{eur(pool.totalDailyBudgetCents)}</b></span>
        <span className="bp-stat"><i>Current total</i><b>{eur(currentTotal)}</b></span>
        <span className="bp-stat"><i>Δ vs target</i><b className={Math.abs(delta) > pool.totalDailyBudgetCents * 0.1 ? 'warn' : ''}>{delta >= 0 ? '+' : ''}{eur(delta)}</b></span>
        <span className="bp-stat"><i>Last rebalance</i><b>{when(pool.lastRebalancedAt)}</b></span>
      </div>

      <div className="bp-controls">
        <Button size="xs" className={`bp-toggle ${pool.enabled ? 'on' : ''}`} disabled={busy != null} onClick={() => patch({ enabled: !pool.enabled }, 'enabled')} role="switch" aria-checked={pool.enabled}>
          {busy === 'enabled' ? <Loader2 size={13} className="bp-spin" /> : null}{pool.enabled ? 'Pool active' : 'Pool disabled'}
        </Button>
        <Button size="xs" className={`bp-toggle ${pool.dryRun ? 'dry' : 'live'}`} disabled={busy != null || !pool.enabled} onClick={() => patch({ dryRun: !pool.dryRun }, 'dryRun')} role="switch" aria-checked={!pool.dryRun}>
          {pool.dryRun ? 'Dry-run' : 'Live — writes to Amazon'}
        </Button>
        <span className="bp-meta">Cooldown {pool.coolDownMinutes}m · max shift {pool.maxShiftPerRebalancePct}%</span>
      </div>

      <SegmentedControl
        className="bp-strat"
        size="sm"
        ariaLabel="Allocation strategy"
        disabled={busy != null}
        value={pool.strategy}
        onChange={(v) => { if (pool.strategy !== v) void patch({ strategy: v as Strategy }, 'strategy') }}
        options={STRATEGIES.map((s) => ({ value: s.key, label: <span title={s.blurb}>{s.label}</span> }))}
      />
      <p className="bp-strat-blurb">{STRATEGIES.find((s) => s.key === pool.strategy)?.blurb}</p>

      <div className="bp-sec-h">Allocations <em>{pool.allocations.length}</em></div>
      {pool.allocations.length === 0 ? (
        <div className="bp-empty">No allocations yet. Add at least two campaigns — a rebalancer with one member has nothing to shift.</div>
      ) : (
        <div className="bp-allocs">
          {pool.allocations.map((a) => {
            const c = a.campaignId ? byId.get(a.campaignId) : null
            return (
              <div className="bp-alloc" key={a.id}>
                <span className="mk">{a.marketplace}</span>
                <span className="nm" title={c?.name}>{c?.name ?? a.campaignId?.slice(0, 12) ?? '—'}</span>
                {c && <span className="st">{c.status}</span>}
                {c && <span className="bd">{eur(Math.round(Number(c.dailyBudget) * 100))}/d</span>}
                <span className="tg">target {a.targetSharePct}%</span>
                <span className="mm">min {eur(a.minDailyBudgetCents)}{a.maxDailyBudgetCents != null ? ` · max ${eur(a.maxDailyBudgetCents)}` : ''}</span>
                <ToolbarButton
                  size="sm" tone="danger" tooltip={false}
                  icon={busy === a.id ? <Loader2 size={13} className="bp-spin" /> : <X size={13} />}
                  label="Remove allocation" disabled={busy === a.id} onClick={() => void removeAllocation(a.id)}
                />
              </div>
            )
          })}
        </div>
      )}
      <div className="bp-addrow">
        <Input size="xs" fieldClassName="bp-add-f" value={addingId} onChange={(e) => setAddingId(e.target.value)} placeholder="Campaign ID" aria-label="Campaign ID to add" onKeyDown={(e) => { if (e.key === 'Enter') void addAllocation() }} />
        <Button size="sm" disabled={busy === 'add' || !addingId.trim()} onClick={() => void addAllocation()}>
          {busy === 'add' ? <Loader2 size={13} className="bp-spin" /> : <Plus size={13} />} Add
        </Button>
      </div>

      <div className="bp-sec-h">Rebalance</div>
      <div className="bp-reb">
        <Button variant="warning" size="sm" disabled={busy != null} onClick={() => void rebalance(true)}>
          {busy === 'preview' ? <Loader2 size={13} className="bp-spin" /> : <FlaskConical size={13} />} Dry-run preview
        </Button>
        <Button variant="primary" size="sm" disabled={busy != null} onClick={() => void rebalance(false)}>
          {busy === 'commit' ? <Loader2 size={13} className="bp-spin" /> : <PlayCircle size={13} />} Run rebalance
        </Button>
        <span className="bp-meta">Preview ignores the cooldown. A real run honours this pool’s dry-run flag.</span>
      </div>
      {error && <div className="bp-err">{error}</div>}

      {preview && (
        <div className="bp-prev">
          <div className="bp-prev-h">{STRATEGY_LABEL[preview.strategy as Strategy] ?? preview.strategy} · total shift {eur(preview.totalShiftCents)}</div>
          {preview.warnings.length > 0 && <div className="bp-warn">{preview.warnings.join(' · ')}</div>}
          {preview.proposed.length === 0 ? (
            <div className="bp-empty">Nothing to move — every allocation is already where the strategy would put it.</div>
          ) : (
            <DataGrid<ProposedRow>
              className="bp-tbl"
              size="xs"
              maxHeight={260}
              rows={preview.proposed}
              rowKey={(r) => r.allocationId}
              columns={[
                { key: 'mkt', label: 'Mkt', render: (r) => <span className="mono">{r.marketplace}</span> },
                { key: 'campaign', label: 'Campaign', render: (r) => <span className="mono trunc" title={r.campaignId ?? ''}>{byId.get(r.campaignId ?? '')?.name ?? r.campaignId?.slice(0, 10) ?? '—'}</span> },
                { key: 'current', label: 'Current', align: 'right', render: (r) => eur(r.oldBudgetCents) },
                { key: 'proposed', label: 'Proposed', align: 'right', render: (r) => eur(r.proposedBudgetCents) },
                { key: 'delta', label: 'Δ', align: 'right', render: (r) => <span className={r.shiftCents > 0 ? 'pos' : r.shiftCents < 0 ? 'neg' : ''}>{r.shiftCents > 0 ? '+' : ''}{eur(r.shiftCents)}</span> },
                { key: 'clamp', label: 'Clamp', render: (r) => <span className="clamp">{r.clampedReason ?? ''}</span> },
              ]}
            />
          )}
        </div>
      )}

      <div className="bp-hist-t">
        <Button variant="link" size="sm" aria-expanded={historyOpen} onClick={() => setHistoryOpen((o) => !o)}>
          Rebalance history ({pool.rebalances?.length ?? 0}) <ChevronDown size={14} className={historyOpen ? 'open' : ''} />
        </Button>
      </div>
      {historyOpen && (
        (pool.rebalances?.length ?? 0) === 0
          ? <div className="bp-empty">Nothing recorded yet — run a dry-run above.</div>
          : <div className="bp-hist">
              {pool.rebalances.map((rb) => (
                <div className="bp-histrow" key={rb.id}>
                  <span className="t">{when(rb.createdAt)}</span>
                  <span className={`tag ${rb.appliedAt ? 'ok' : 'dry'}`}>{rb.appliedAt ? 'Applied' : 'Dry-run'}</span>
                  <span className="by">{rb.triggeredBy}</span>
                  <span className="sh">shift {eur(rb.totalShiftCents)}</span>
                </div>
              ))}
            </div>
      )}
    </div>
  )
}

// ── the drawer ───────────────────────────────────────────────────────────────
export function BudgetPoolsDrawer({ open, onClose, toast }: { open: boolean; onClose: () => void; toast: (m: string) => void }) {
  const [pools, setPools] = useState<Pool[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [budget, setBudget] = useState('100')
  const [strategy, setStrategy] = useState<Strategy>('PROFIT_WEIGHTED')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const j = await fetch(`${API()}/api/advertising/budget-pools`, { cache: 'no-store' }).then((r) => r.json())
      setPools(Array.isArray(j?.items) ? j.items : [])
    } catch { setPools([]) }
  }, [])
  useEffect(() => { if (open) void load() }, [open, load])

  const create = async () => {
    const cents = Math.round((parseFloat(budget.replace(',', '.')) || 0) * 100)
    if (!name.trim()) { setError('Give the pool a name.'); return }
    if (cents <= 0) { setError('Set a daily budget above zero.'); return }
    setBusy(true); setError(null)
    try {
      const r = await fetch(`${API()}/api/advertising/budget-pools`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), totalDailyBudgetCents: cents, strategy }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(j?.error ?? 'Could not create the pool.'); return }
      setCreating(false); setName(''); setBudget('100')
      toast('Pool created.')
      await load()
      if (j?.pool?.id) setExpanded(j.pool.id)
    } finally { setBusy(false) }
  }

  const activeBudget = (pools ?? []).reduce((a, p) => (p.enabled ? a + p.totalDailyBudgetCents : a), 0)

  return (
    <Drawer open={open} onClose={onClose} title="Budget Pools">
      <p className="bp-intro">
        A pool shares <b>one daily budget across markets</b> and reweights it — by target share, by 30d true
        profit, or by aged-stock urgency. That is a different job from the monthly per-market caps on this
        page, which is why they live side by side rather than merged.
      </p>

      {pools == null ? <div className="bp-loading">Loading pools…</div> : (
        <>
          <div className="bp-top">
            <span className="bp-stat"><i>Pools</i><b>{pools.length}</b></span>
            <span className="bp-stat"><i>Active</i><b>{pools.filter((p) => p.enabled).length}</b></span>
            <span className="bp-stat"><i>Active budget/day</i><b>{eur(activeBudget)}</b></span>
            <span className="bp-stat"><i>Allocations</i><b>{pools.reduce((a, p) => a + (p._count?.allocations ?? 0), 0)}</b></span>
          </div>

          {creating ? (
            <div className="bp-new">
              <div className="bp-new-h">New budget pool</div>
              <div className="bp-new-f">
                <label><span>Name</span><Input size="sm" fieldClassName="bp-new-in" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GALE — IT/DE/FR" aria-label="Pool name" /></label>
                <label><span>Budget €/day</span><Input size="sm" fieldClassName="bp-new-in" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Daily budget" /></label>
              </div>
              <SegmentedControl
                className="bp-strat"
                size="sm"
                ariaLabel="Allocation strategy"
                value={strategy}
                onChange={(v) => setStrategy(v as Strategy)}
                options={STRATEGIES.map((s) => ({ value: s.key, label: <span title={s.blurb}>{s.label}</span> }))}
              />
              <p className="bp-strat-blurb">{STRATEGIES.find((s) => s.key === strategy)?.blurb}</p>
              {error && <div className="bp-err">{error}</div>}
              <div className="bp-new-a">
                <Button size="sm" onClick={() => { setCreating(false); setError(null) }}>Cancel</Button>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void create()}>{busy ? <Loader2 size={13} className="bp-spin" /> : null} Create pool</Button>
              </div>
            </div>
          ) : (
            <Button variant="primary" size="sm" className="bp-newb" onClick={() => setCreating(true)}><Plus size={13} /> New pool</Button>
          )}

          {pools.length === 0 && !creating ? (
            <div className="bp-empty bp-empty-lg">
              <span className="ill"><Wallet size={22} /></span>
              <b>No pools yet</b>
              <span>The rebalancer runs on a schedule and the Control Room lists it as an engine — but with no pool it has nothing to balance. Create one to start.</span>
            </div>
          ) : (
            <div className="bp-list">
              {pools.map((p) => (
                <div className={`bp-item ${expanded === p.id ? 'open' : ''}`} key={p.id}>
                  <Button
                    variant="quiet" block className="bp-item-h"
                    aria-expanded={expanded === p.id}
                    onClick={() => setExpanded((x) => (x === p.id ? null : p.id))}
                  >
                    <span className="nm">{p.name}</span>
                    <span className={`tag ${p.enabled ? (p.dryRun ? 'dry' : 'ok') : 'off'}`}>{p.enabled ? (p.dryRun ? 'Dry-run' : 'Live') : 'Disabled'}</span>
                    <span className="tag strat">{STRATEGY_LABEL[p.strategy]}</span>
                    <span className="bd">{eur(p.totalDailyBudgetCents)}/d</span>
                    <span className="al">{p._count?.allocations ?? 0} alloc</span>
                    <ChevronDown size={15} className={`chev ${expanded === p.id ? 'open' : ''}`} />
                  </Button>
                  {expanded === p.id && <PoolBody poolId={p.id} onChanged={() => void load()} toast={toast} />}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Drawer>
  )
}
