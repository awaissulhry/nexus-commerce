'use client'

/**
 * E5 — automation control room: global dial (OFF/SUGGEST/AUTO) + halt +
 * spend ceilings + kill switch; rules (enable / PROPOSE↔AUTOPILOT / run now);
 * proposals queue (bulk approve/reject, rollback of applied); executions.
 * Every applied change is auditable + reversible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { Banner } from '@/design-system/components/Banner'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { getBackendUrl } from '@/lib/backend-url'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '../ebay.css'
import { postEbayAds, eurC, useWriteMode, SandboxBanner } from '../_shared'

interface RuleRow { id: string; name: string; enabled: boolean; mode: string; marketplace: string | null; cooldownHours: number; lastEvaluatedAt: string | null; executions: Array<{ status: string; evaluated: number; matched: number; proposed: number; applied: number; createdAt: string }> }
interface ProposalRow { id: string; kind: string; status: string; entityRef: { campaignName?: string; listingId?: string; keywordText?: string; marketplace?: string }; proposedAction: { from?: unknown; to?: unknown }; reasoning?: { clampNote?: string | null } | null; createdAt: string }
interface StatePayload { state: { globalMode: string; halted: boolean; haltReason: string | null }; ceilings: Array<{ marketplace: string; mtdCents: number; capCents: number; pct: number }> }

const fetchJson = async <T,>(path: string): Promise<T> => {
  const r = await fetch(`${getBackendUrl()}/api/ebay-ads${path}`, { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

export function EbayAutomationClient() {
  const writeMode = useWriteMode()
  const [state, setState] = useState<StatePayload | null>(null)
  const [rules, setRules] = useState<RuleRow[]>([])
  const [proposals, setProposals] = useState<ProposalRow[]>([])
  const [applied, setApplied] = useState<ProposalRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [capInput, setCapInput] = useState('300')

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [s, r, p, a] = await Promise.all([
        fetchJson<StatePayload>('/automation/state'),
        fetchJson<{ rules: RuleRow[] }>('/automation/rules'),
        fetchJson<{ proposals: ProposalRow[] }>('/automation/proposals?status=PENDING'),
        fetchJson<{ proposals: ProposalRow[] }>('/automation/proposals?status=APPLIED'),
      ])
      setState(s); setRules(r.rules); setProposals(p.proposals); setApplied(a.proposals.slice(0, 20))
    } catch (e) { setMsg((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setMsg(null)
    try { await fn(); if (done) setMsg(done); await reload() } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }

  const proposalColumns: Column<ProposalRow>[] = useMemo(() => [
    { key: 'kind', label: 'Action', width: 150, render: (p) => <span className="eb-chip eb-chip--cpc">{p.kind.replace(/_/g, ' ')}</span> },
    {
      key: 'target', label: 'Target', width: 280,
      render: (p) => (
        <div className="eb-cell-name">
          <span className="nm">{p.entityRef.campaignName ?? '—'}</span>
          <span className="sub">{p.entityRef.listingId ?? p.entityRef.keywordText ?? ''} · {p.entityRef.marketplace ?? ''}</span>
        </div>
      ),
    },
    { key: 'change', label: 'Change', width: 190, render: (p) => <span>{String(p.proposedAction.from ?? '')} → <b>{String(p.proposedAction.to ?? '')}</b></span> },
    { key: 'note', label: 'Guardrail', render: (p) => p.reasoning?.clampNote ? <span className="eb-chip eb-chip--warn">{p.reasoning.clampNote}</span> : <span className="eb-chip eb-chip--run">within break-even</span> },
    { key: 'age', label: 'Proposed', width: 110, render: (p) => new Date(p.createdAt).toLocaleDateString('en-GB') },
  ], [])

  return (
    <div className="eb-page">
      <AdsPageHeader title="eBay Automation" subtitle="Rules propose; you approve — or grant autopilot within hard margin guardrails. Everything is audited and reversible." markets={['EBAY_IT']} market="EBAY_IT" onMarketChange={() => {}} />
      <SandboxBanner mode={writeMode} />

      {loading ? <Skeleton height={420} /> : state && (
        <>
          {state.state.halted && (
            <Banner tone="danger" title="Automation is HALTED">
              {state.state.haltReason ?? 'no reason recorded'} — <button className="eb-linkbtn" onClick={() => act(() => postEbayAds('/automation/state', { halted: false }), 'resumed')}>resume</button>
            </Banner>
          )}

          <section className="eb-panel">
            <header className="eb-panel-head"><h3>Posture</h3><span className="eb-panel-note">OFF = engine dormant · SUGGEST = proposals only (autopilot rules downgrade) · AUTO = rule modes decide</span></header>
            <div className="eb-form-row">
              <SegmentedControl
                options={[{ value: 'OFF', label: 'Off' }, { value: 'SUGGEST', label: 'Suggest' }, { value: 'AUTO', label: 'Auto' }]}
                value={state.state.globalMode}
                onChange={(v) => act(() => postEbayAds('/automation/state', { globalMode: v }), `mode → ${v}`)}
                aria-label="Automation mode"
              />
              <Button variant="ghost" onClick={() => act(() => postEbayAds('/automation/state', { halted: true, haltReason: 'operator kill switch' }), 'HALTED')} disabled={busy || state.state.halted}>⛔ Halt everything</Button>
              <Button variant="ghost" onClick={() => act(() => postEbayAds('/automation/evaluate', {}), 'evaluation run')} disabled={busy}>Evaluate now</Button>
            </div>
            <div className="eb-form-row" style={{ marginTop: 10 }}>
              <div><label>Monthly ceiling EBAY_IT (EUR)</label><Input type="number" min={10} value={capInput} onChange={(e) => setCapInput(e.target.value)} /></div>
              <Button variant="ghost" onClick={() => act(() => postEbayAds('/automation/ceilings', { marketplace: 'EBAY_IT', monthlyCapCents: Math.round(Number(capInput) * 100) }), 'ceiling saved')} disabled={busy}>Save ceiling</Button>
              {state.ceilings.map((c) => (
                <span key={c.marketplace} className={`eb-chip ${c.pct >= 80 ? 'eb-chip--warn' : 'eb-chip--dim'}`}>
                  {c.marketplace}: {eurC(c.mtdCents)} / {eurC(c.capCents)} ({c.pct}%)
                </span>
              ))}
            </div>
            <p className="eb-be-hint">Ceilings project General fee run-rate + CPC spend against the cap (eBay's CPC pacing can spend 2× a daily budget in one day; General has NO native cap). Breach ⇒ automation halts + critical alert.</p>
          </section>

          <section className="eb-panel">
            <header className="eb-panel-head">
              <h3>Rules ({rules.length})</h3>
              {rules.length === 0 && <Button onClick={() => act(() => postEbayAds('/automation/presets/starter-pack', {}), 'starter pack installed')} disabled={busy}>Install starter rule-pack</Button>}
            </header>
            {rules.length === 0 ? (
              <EmptyState title="No rules yet" description="Install the starter pack: fee-creep-down, click-bleeder removal, break-even repair, restock re-promote, keyword bleeder pause, keyword bid-down. All arrive disabled, in PROPOSE mode." />
            ) : (
              <div className="eb-rules">
                {rules.map((r) => {
                  const last = r.executions[0]
                  return (
                    <div key={r.id} className="eb-rule">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none' }}>
                        <input type="checkbox" checked={r.enabled} onChange={(e) => act(() => postEbayAds(`/automation/rules/${r.id}`, { enabled: e.target.checked }))} />
                        <b>{r.name}</b>
                      </label>
                      <span className={`eb-chip ${r.mode === 'AUTOPILOT' ? 'eb-chip--cpc' : 'eb-chip--dim'}`} role="button" tabIndex={0}
                        title="Click to toggle PROPOSE ↔ AUTOPILOT"
                        onClick={() => act(() => postEbayAds(`/automation/rules/${r.id}`, { mode: r.mode === 'AUTOPILOT' ? 'PROPOSE' : 'AUTOPILOT' }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') void act(() => postEbayAds(`/automation/rules/${r.id}`, { mode: r.mode === 'AUTOPILOT' ? 'PROPOSE' : 'AUTOPILOT' })) }}>
                        {r.mode}
                      </span>
                      <span className="eb-be-hint">
                        {last ? `last run: ${last.evaluated} evaluated · ${last.matched} matched · ${last.proposed} proposed · ${last.applied} applied` : 'never run'}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="eb-panel">
            <header className="eb-panel-head">
              <h3>Proposals awaiting review ({proposals.length})</h3>
              <div className="eb-actions">
                <Button onClick={() => act(() => postEbayAds('/automation/proposals/decide', { ids: [...selected], decision: 'approve' }), 'approved')} disabled={busy || selected.size === 0}>Approve ({selected.size})</Button>
                <Button variant="ghost" onClick={() => act(() => postEbayAds('/automation/proposals/decide', { ids: [...selected], decision: 'reject' }), 'rejected')} disabled={busy || selected.size === 0}>Reject ({selected.size})</Button>
              </div>
            </header>
            {proposals.length === 0 ? (
              <EmptyState title="Nothing awaiting review" description="Proposals appear after the daily evaluation (05:45 UTC) or Evaluate now." />
            ) : (
              <DataGrid<ProposalRow> columns={proposalColumns} rows={proposals} rowKey={(p) => p.id} selectable selected={selected} onSelectedChange={setSelected} maxHeight={340} />
            )}
          </section>

          <section className="eb-panel">
            <header className="eb-panel-head"><h3>Recently applied ({applied.length})</h3><span className="eb-panel-note">one-click rollback applies the recorded inverse through the audited write path</span></header>
            {applied.length === 0 ? <EmptyState title="Nothing applied yet" /> : (
              <ul className="eb-results">
                {applied.map((p) => (
                  <li key={p.id} className="ok">
                    <b>{p.kind.replace(/_/g, ' ')}</b> · {p.entityRef.campaignName} · {p.entityRef.listingId ?? p.entityRef.keywordText ?? ''} — {String(p.proposedAction.from ?? '')} → {String(p.proposedAction.to ?? '')}
                    {' '}<button className="eb-linkbtn" onClick={() => act(() => postEbayAds(`/automation/proposals/${p.id}/rollback`, {}), 'rolled back')}>rollback</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {msg && <p className="eb-be-hint">{msg}</p>}
        </>
      )}
    </div>
  )
}
