'use client'

/**
 * E6.1 — automation, re-skinned on the Rules & Automation idiom:
 * .h10-rules-page + .h10-cd-tabs bar (Rules | Approvals | Applied), rules as
 * rows with .h10-bktoggle enable switches + clickable mode pills, proposals
 * as an AdsDataGrid with bulk Approve/Reject, posture card with the dial +
 * ceilings + halt. Logic unchanged from E5; visuals = console idiom.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'
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

const TABS = [
  { key: 'rules', label: 'Rules' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'applied', label: 'Applied' },
]

export function EbayAutomationClient() {
  const writeMode = useWriteMode()
  const [tab, setTab] = useState('rules')
  const [state, setState] = useState<StatePayload | null>(null)
  const [rules, setRules] = useState<RuleRow[]>([])
  const [proposals, setProposals] = useState<ProposalRow[]>([])
  const [applied, setApplied] = useState<ProposalRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [capInput, setCapInput] = useState('300')

  const reload = useCallback(async () => {
    try {
      const [s, r, p, a] = await Promise.all([
        fetchJson<StatePayload>('/automation/state'),
        fetchJson<{ rules: RuleRow[] }>('/automation/rules'),
        fetchJson<{ proposals: ProposalRow[] }>('/automation/proposals?status=PENDING'),
        fetchJson<{ proposals: ProposalRow[] }>('/automation/proposals?status=APPLIED'),
      ])
      setState(s); setRules(r.rules); setProposals(p.proposals); setApplied(a.proposals.slice(0, 30))
      const cap = s.ceilings.find((c) => c.marketplace === 'EBAY_IT')
      if (cap) setCapInput(String(Math.round(cap.capCents / 100)))
    } catch (e) { setToast((e as Error).message) }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try { await fn(); if (done) setToast(done); await reload() } catch (e) { setToast((e as Error).message) } finally { setBusy(false) }
  }

  const proposalColumns: GridColumn<ProposalRow>[] = useMemo(() => [
    { key: 'kind', label: 'Action', metric: false, sortValue: (p) => p.kind, render: (p) => <span className="h10-pill ok">{p.kind.replace(/_/g, ' ')}</span> },
    { key: 'change', label: 'Change', metric: false, sortable: false, render: (p) => <span>{String(p.proposedAction.from ?? '')} → <b>{String(p.proposedAction.to ?? '')}</b></span> },
    { key: 'guard', label: 'Guardrail', metric: false, sortable: false, render: (p) => p.reasoning?.clampNote ? <span className="h10-pill warn">{p.reasoning.clampNote}</span> : <span className="h10-pill ok">within break-even</span> },
    { key: 'age', label: 'Proposed', metric: false, sortValue: (p) => p.createdAt, render: (p) => new Date(p.createdAt).toLocaleDateString('en-GB') },
  ], [])

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="eBay Rules & Automation"
        subtitle="Rules propose; you approve — or grant autopilot within hard margin guardrails. Everything is audited and reversible."
        markets={['EBAY_IT']} market="EBAY_IT" onMarketChange={() => {}}
        showLearn={false} showDataSync={false} showDateRange={false}
        primaryAction={{ label: 'Evaluate now', onClick: () => void act(() => postEbayAds('/automation/evaluate', {}), 'evaluation run') }}
      />
      <SandboxBanner mode={writeMode} />

      {state?.state.halted && (
        <div className="dash-banner" role="alert">
          <b>Automation HALTED</b> — {state.state.haltReason ?? 'no reason recorded'} · <button className="h10-am-link" onClick={() => void act(() => postEbayAds('/automation/state', { halted: false }), 'resumed')}>Resume</button>
        </div>
      )}

      {/* Posture card */}
      <div className="h10-cd-card pad" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#475467' }}>POSTURE</span>
        {(['OFF', 'SUGGEST', 'AUTO'] as const).map((m) => (
          <button key={m} type="button" className={`h10-am-btn ${state?.state.globalMode === m ? 'on' : ''}`} disabled={busy}
            title={m === 'OFF' ? 'Engine dormant' : m === 'SUGGEST' ? 'Proposals only — autopilot rules downgrade' : 'Rule modes decide'}
            onClick={() => void act(() => postEbayAds('/automation/state', { globalMode: m }), `mode → ${m}`)}>
            {m === 'OFF' ? 'Off' : m === 'SUGGEST' ? 'Suggest' : 'Auto'}
          </button>
        ))}
        <span className="grow" style={{ flex: 1 }} />
        <label style={{ fontSize: 12, color: '#5b6573' }}>Monthly ceiling (EBAY_IT) €
          <input className="h10-cd-input" style={{ width: 80, marginLeft: 6 }} type="number" min={10} value={capInput} onChange={(e) => setCapInput(e.target.value)} />
        </label>
        <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => void act(() => postEbayAds('/automation/ceilings', { marketplace: 'EBAY_IT', monthlyCapCents: Math.round(Number(capInput) * 100) }), 'ceiling saved')}>Save</button>
        {state?.ceilings.map((cl) => (
          <span key={cl.marketplace} className={`h10-pill ${cl.pct >= 80 ? 'warn' : 'arch'}`} title="MTD attributed ad fees vs the monthly cap (General has no native cap — this is it)">
            {cl.marketplace.replace('EBAY_', '')}: {eurC(cl.mtdCents)} / {eurC(cl.capCents)} · {cl.pct}%
          </span>
        ))}
        <button type="button" className="h10-am-btn" disabled={busy || state?.state.halted} onClick={() => void act(() => postEbayAds('/automation/state', { halted: true, haltReason: 'operator kill switch' }), 'HALTED')}>⛔ Halt everything</button>
      </div>

      <nav className="h10-cd-tabs h10-rules-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`h10-cd-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}{t.key === 'approvals' && proposals.length > 0 && <span className="h10-cd-new">{proposals.length}</span>}
          </button>
        ))}
      </nav>

      {tab === 'rules' && (
        <div className="h10-am-card" style={{ padding: '6px 0' }}>
          {rules.length === 0 ? (
            <div style={{ padding: '28px 18px', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: '#5b6573', marginBottom: 12 }}>No rules yet. The starter pack ships six documented rules — fee creep-down, click-bleeder removal, break-even repair, restock re-promote, keyword bleeder pause, keyword bid-down — all disabled, all PROPOSE.</p>
              <button type="button" className="h10-am-btn primary" disabled={busy} onClick={() => void act(() => postEbayAds('/automation/presets/starter-pack', {}), 'starter pack installed')}>Install starter rule-pack</button>
            </div>
          ) : rules.map((r) => {
            const last = r.executions[0]
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', borderBottom: '1px solid #eef1f5', flexWrap: 'wrap' }}>
                <button type="button" role="switch" aria-checked={r.enabled} className={`h10-bktoggle ${r.enabled ? 'on' : ''}`} disabled={busy}
                  onClick={() => void act(() => postEbayAds(`/automation/rules/${r.id}`, { enabled: !r.enabled }))}>
                  <span />
                </button>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#1c2530', minWidth: 240 }}>{r.name}</span>
                <button type="button" className={`h10-pill ${r.mode === 'AUTOPILOT' ? 'ok' : 'arch'}`} style={{ cursor: 'pointer', border: 'none' }} disabled={busy}
                  title="Click to toggle PROPOSE ↔ AUTOPILOT (autopilot applies within guardrails when the dial is on Auto)"
                  onClick={() => void act(() => postEbayAds(`/automation/rules/${r.id}`, { mode: r.mode === 'AUTOPILOT' ? 'PROPOSE' : 'AUTOPILOT' }))}>
                  {r.mode}
                </button>
                <span style={{ fontSize: 11.5, color: '#8a93a1' }}>
                  {last ? `last run: ${last.evaluated} evaluated · ${last.matched} matched · ${last.proposed} proposed · ${last.applied} applied` : 'never run'}
                  {r.lastEvaluatedAt && ` · ${new Date(r.lastEvaluatedAt).toLocaleString('en-GB')}`}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'approvals' && (
        <AdsDataGrid<ProposalRow>
          rows={proposals}
          rowId={(p) => p.id}
          noun="Proposal"
          firstColLabel="Target"
          renderFirst={(p) => (
            <div className="nmw">
              <span className="t" title={p.entityRef.campaignName}>{p.entityRef.campaignName ?? '—'}</span>
              <span className="mk">{p.entityRef.listingId ?? p.entityRef.keywordText ?? ''}</span>
            </div>
          )}
          firstSortValue={(p) => p.entityRef.campaignName ?? ''}
          columns={proposalColumns}
          selected={selected}
          onSelectedChange={setSelected}
          selectionActions={(ids, clear) => (
            <span className="h10-bulkrow">
              <button type="button" className="h10-am-btn bulk" disabled={busy} onClick={() => void act(async () => { await postEbayAds('/automation/proposals/decide', { ids, decision: 'approve' }); clear() }, 'approved')}>Approve</button>
              <button type="button" className="h10-am-btn bulk" disabled={busy} onClick={() => void act(async () => { await postEbayAds('/automation/proposals/decide', { ids, decision: 'reject' }); clear() }, 'rejected')}>Reject</button>
            </span>
          )}
          storageKey="h10-ebay-proposals-cols"
          emptyLabel="Nothing awaiting review — proposals appear after the daily evaluation (or Evaluate now)."
        />
      )}

      {tab === 'applied' && (
        <div className="h10-am-card" style={{ padding: '6px 0' }}>
          {applied.length === 0 ? (
            <div style={{ padding: '28px 18px', textAlign: 'center', fontSize: 13, color: '#5b6573' }}>Nothing applied yet — AUTOPILOT rules (dial on Auto) and approved proposals report here, each with one-click rollback.</div>
          ) : applied.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderBottom: '1px solid #eef1f5', flexWrap: 'wrap', fontSize: 12.5 }}>
              <span className="h10-pill ok">{p.kind.replace(/_/g, ' ')}</span>
              <span style={{ fontWeight: 600 }}>{p.entityRef.campaignName}</span>
              <span style={{ color: '#8a93a1' }}>{p.entityRef.listingId ?? p.entityRef.keywordText ?? ''}</span>
              <span>{String(p.proposedAction.from ?? '')} → <b>{String(p.proposedAction.to ?? '')}</b></span>
              <span className="grow" style={{ flex: 1 }} />
              <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => void act(() => postEbayAds(`/automation/proposals/${p.id}/rollback`, {}), 'rolled back')}>Rollback</button>
            </div>
          ))}
        </div>
      )}

      {toast && <div className="h10-am-toast" role="status">{toast}</div>}
    </div>
  )
}
