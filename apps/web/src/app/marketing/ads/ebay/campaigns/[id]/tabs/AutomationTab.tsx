'use client'

/**
 * ER1 — the NEW per-campaign Automation tab (SPEC §5.7, fixes critique D-3):
 * posture override (Inherit/Off/Suggest/Auto) + Protected flag + guardrail
 * caps/floors (always clamped by break-even server-side) · rules that apply
 * here · pending proposals (approve/reject inline) · applied with rollback ·
 * drift scoped to this campaign. One aggregate fetch.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { money } from '../../../../campaigns/_grid/format'
import { getEbayAds, postEbayAds, type CampaignAutomationPayload } from '../../../_lib'

const POSTURES = [
  { id: 'INHERIT', label: 'Inherit', tip: 'Follow the global dial (Rules & Automation hub)' },
  { id: 'OFF', label: 'Off', tip: 'No automation touches this campaign' },
  { id: 'SUGGEST', label: 'Suggest', tip: 'Rules may only PROPOSE here, even in autopilot' },
  { id: 'AUTO', label: 'Auto', tip: 'Rule modes decide (autopilot rules apply within guardrails)' },
]

interface DiscoveryPlan {
  status: string; floorPct: number; capPct: number; stepPct: number; dwellDays: number
  currentPct: number | null; bestPct: number | null; lastStepAt: string | null
  history: Array<{ pct: number; from: string; to: string; days: number; adFeesCents: number; salesCents: number }>
}

export function AutomationTab({ campaignId, campaignStatus, say, onPolicyChange }: { campaignId: string; campaignStatus: string; say: (m: string) => void; onPolicyChange: () => void }) {
  const [data, setData] = useState<CampaignAutomationPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [capPct, setCapPct] = useState('')
  const [floorPct, setFloorPct] = useState('')

  const load = useCallback(() => {
    getEbayAds<CampaignAutomationPayload>(`/campaigns/${campaignId}/automation`)
      .then((d) => { setData(d); setCapPct(d.policy.rateCapPct != null ? String(d.policy.rateCapPct) : ''); setFloorPct(d.policy.rateFloorPct != null ? String(d.policy.rateFloorPct) : '') })
      .catch((e) => setError((e as Error).message))
  }, [campaignId])
  useEffect(() => { load() }, [load])

  const savePolicy = async (patch: Record<string, unknown>, note: string) => {
    setBusy(true)
    try {
      await postEbayAds(`/campaigns/${campaignId}/automation-policy`, patch, 'PUT')
      say(note)
      load()
      onPolicyChange()
    } catch (e) { say((e as Error).message) } finally { setBusy(false) }
  }
  const decide = async (ids: string[], decision: 'approve' | 'reject') => {
    setBusy(true)
    try { await postEbayAds('/automation/proposals/decide', { ids, decision }); say(`${decision}d`); load() } catch (e) { say((e as Error).message) } finally { setBusy(false) }
  }
  const rollback = async (id: string) => {
    setBusy(true)
    try { await postEbayAds(`/automation/proposals/${id}/rollback`, {}); say('rolled back'); load() } catch (e) { say((e as Error).message) } finally { setBusy(false) }
  }
  const repairDrift = async (d: { campaignId: string; kind: string; listingId: string | null }, action: 'reapply' | 'accept') => {
    setBusy(true)
    try { await postEbayAds('/reconciliation/repair', { campaignId: d.campaignId, kind: d.kind, listingId: d.listingId, action }); say(action === 'reapply' ? 'Nexus value re-applied' : 'eBay value accepted'); load() } catch (e) { say((e as Error).message) } finally { setBusy(false) }
  }

  if (error) return <div className="h10-cd-error">Couldn&apos;t load automation — {error}. <button type="button" className="h10-am-link" onClick={load}>Retry</button></div>
  if (!data) return <div className="h10-cd-skel" aria-busy="true"><div className="sk-line w40" /><div className="sk-block" /></div>
  const p = data.policy

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Policy card */}
      <div className="h10-cd-card pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="eb-cap">Posture</span>
          {POSTURES.map((m) => (
            <button key={m.id} type="button" className={`h10-am-btn ${p.posture === m.id ? 'on' : ''}`} title={m.tip} disabled={busy}
              onClick={() => void savePolicy({ posture: m.id }, `posture → ${m.id}`)}>{m.label}</button>
          ))}
          <span className="h10-pill arch" title="The global dial this campaign inherits from">global: {data.globalMode}{data.halted ? ' · HALTED' : ''}</span>
          <span className="grow" style={{ flex: 1 }} />
          <label className="eb-toggle-lbl" title="Excluded from ALL automation — rules, coverage guard, discovery. Badged in the header and Ad Manager.">
            <button type="button" role="switch" aria-checked={p.protected} className={`h10-bktoggle ${p.protected ? 'on' : ''}`} disabled={busy}
              onClick={() => void savePolicy({ protected: !p.protected }, p.protected ? 'protection removed' : 'campaign PROTECTED')}>
              <span />
            </button>
            Protected
          </label>
        </div>
        <div className="eb-form-row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <div className="h10-cd-field s">
            <label>Rate cap % (this campaign)</label>
            <input type="number" min={2} max={100} step={0.1} value={capPct} onChange={(e) => setCapPct(e.target.value)} placeholder="none" />
          </div>
          <div className="h10-cd-field s">
            <label>Rate floor %</label>
            <input type="number" min={0} max={100} step={0.1} value={floorPct} onChange={(e) => setFloorPct(e.target.value)} placeholder="none" />
          </div>
          <button type="button" className="h10-am-btn sm" disabled={busy}
            onClick={() => void savePolicy({ rateCapPct: capPct === '' ? null : Number(capPct), rateFloorPct: floorPct === '' ? null : Number(floorPct) }, 'guardrail overrides saved')}>Save caps</button>
          <span className="eb-be-hint">Caps clamp automation AFTER the break-even clamp — they can tighten the guardrail, never exceed it.</span>
        </div>
      </div>

      {/* Rules that apply here */}
      <div className="h10-am-card eb-rowlist">
        <p className="hd plain">Rules that apply to this campaign — <Link className="h10-am-link" href="/marketing/ads/ebay/automation">manage in Rules &amp; Automation</Link></p>
        {data.rules.length === 0 ? (
          <div className="empty">No rules apply here.</div>
        ) : data.rules.map((r) => (
          <div key={r.id} className="eb-row">
            <span className={`h10-pill ${r.enabled ? 'ok' : 'arch'}`}>{r.enabled ? 'on' : 'off'}</span>
            <span className="nm6">{r.name}</span>
            <span className="h10-pill arch">{r.mode}</span>
            <span className="h10-pill arch">{r.scoped ? 'bound to this campaign' : 'global'}</span>
            <span className="grow" style={{ flex: 1 }} />
            <span className="ts">{r.lastEvaluatedAt ? `last run ${new Date(r.lastEvaluatedAt).toLocaleString('en-GB')}` : 'never run'}</span>
          </div>
        ))}
      </div>

      {/* Pending proposals */}
      <div className="h10-am-card eb-rowlist">
        <p className="hd">Awaiting your decision ({data.proposals.length})</p>
        {data.proposals.length === 0 ? (
          <div className="empty">Nothing pending for this campaign.</div>
        ) : data.proposals.map((pr) => (
          <div key={pr.id} className="eb-row">
            <span className="h10-pill ok">{pr.kind.replace(/_/g, ' ')}</span>
            <span className="dim">{pr.entityRef.listingId ?? pr.entityRef.keywordText ?? ''}</span>
            <span>{String(pr.proposedAction.from ?? '')} → <b>{String(pr.proposedAction.to ?? '')}</b></span>
            {pr.reasoning?.clampNote && <span className="h10-pill warn">{pr.reasoning.clampNote}</span>}
            <span className="grow" style={{ flex: 1 }} />
            <button type="button" className="h10-am-btn sm primary" disabled={busy} onClick={() => void decide([pr.id], 'approve')}>Approve</button>
            <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => void decide([pr.id], 'reject')}>Reject</button>
          </div>
        ))}
      </div>

      {/* Applied */}
      <div className="h10-am-card eb-rowlist">
        <p className="hd">Applied here (rollback available)</p>
        {data.applied.length === 0 ? (
          <div className="empty">Nothing applied yet.</div>
        ) : data.applied.map((pr) => (
          <div key={pr.id} className="eb-row">
            <span className="h10-pill ok">{pr.kind.replace(/_/g, ' ')}</span>
            <span className="dim">{pr.entityRef.listingId ?? pr.entityRef.keywordText ?? ''}</span>
            <span>{String(pr.proposedAction.from ?? '')} → <b>{String(pr.proposedAction.to ?? '')}</b></span>
            <span className="ts">{pr.decidedAt ? new Date(pr.decidedAt).toLocaleString('en-GB') : ''}</span>
            <span className="grow" style={{ flex: 1 }} />
            <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => void rollback(pr.id)}>Rollback</button>
          </div>
        ))}
      </div>

      {/* ER2 — Rate Discovery progress */}
      {(data as unknown as { rateDiscovery?: DiscoveryPlan | null }).rateDiscovery && (() => {
        const rd = (data as unknown as { rateDiscovery: DiscoveryPlan }).rateDiscovery
        return (
          <div className="h10-cd-card pad">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <b className="eb-strong">Rate Discovery</b>
              <span className={`h10-pill ${rd.status === 'ACTIVE' ? 'ok' : rd.status === 'COMPLETE' ? 'arch' : 'warn'}`}>{rd.status}</span>
              <span className="h10-pill arch">{rd.floorPct}% → {rd.capPct}% · {rd.stepPct}% steps · {rd.dwellDays}-day windows</span>
              {rd.currentPct != null && <span className="h10-pill ok">now at {rd.currentPct}%</span>}
              {rd.bestPct != null && <span className="h10-pill ok" title="Best net-of-fees attributed sales per day">best: {rd.bestPct}%</span>}
            </div>
            {rd.history.length === 0 ? (
              <p className="eb-be-hint">No completed windows yet — each step arrives as a proposal above; approving it moves every ad&apos;s rate (clamped per listing to break-even).</p>
            ) : (
              <table className="eb-difftable">
                <thead><tr><th>Rate</th><th>Window</th><th>Days</th><th>Ad fees</th><th>Ad sales</th><th>Net/day</th></tr></thead>
                <tbody>
                  {rd.history.map((h, i) => (
                    <tr key={i}>
                      <td>{h.pct}%</td><td>{h.from} → {h.to}</td><td>{h.days}</td>
                      <td>{money(h.adFeesCents)}</td><td>{money(h.salesCents)}</td>
                      <td>{money(Math.round((h.salesCents - h.adFeesCents) / Math.max(1, h.days)))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })()}

      {/* Drift */}
      <div className="h10-am-card eb-rowlist">
        <p className="hd">Drift — values eBay changed under us</p>
        {campaignStatus === 'ENDED' ? (
          <div className="empty">Ended campaigns are not reconciled.</div>
        ) : data.drifts.length === 0 ? (
          <div className="empty">No drift — everything matches what Nexus last set.</div>
        ) : data.drifts.map((d) => (
          <div key={`${d.kind}-${d.listingId ?? 'campaign'}`} className="eb-row">
            <span className={`h10-pill ${d.kind === 'ad_removed' ? 'warn' : 'arch'}`}>{d.kind.replace(/_/g, ' ')}</span>
            <span className="dim">{d.listingId ?? ''}</span>
            <span>Nexus set <b>{d.kind === 'budget' ? money(d.nexusValue) : `${d.nexusValue}%`}</b> · eBay now <b>{d.ebayValue == null ? 'removed' : d.kind === 'budget' ? money(d.ebayValue) : `${d.ebayValue}%`}</b></span>
            <span className="grow" style={{ flex: 1 }} />
            <button type="button" className="h10-am-btn sm primary" disabled={busy} onClick={() => void repairDrift(d, 'reapply')}>Re-apply</button>
            <button type="button" className="h10-am-btn sm" disabled={busy} onClick={() => void repairDrift(d, 'accept')}>Accept</button>
          </div>
        ))}
      </div>
    </div>
  )
}
