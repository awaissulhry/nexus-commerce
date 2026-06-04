'use client'

/**
 * RC4.5 — Staged-changes tray. Every cockpit write is sandbox-gated: it lands in
 * OutboundSyncQueue with a 5-minute hold and only reaches Amazon once the
 * campaign's write-gate is open. This tray is the single place to SEE every
 * staged change (before → after), discard any of them within the grace window,
 * and open the gate to send them. Reads /pending-writes; cancels via the RC4.5
 * /queued-mutations/:id/cancel endpoint; opens the gate via /live-writes.
 */

import { useCallback, useEffect, useState } from 'react'
import { X, Loader2, Check, AlertTriangle, Clock, Trash2, History, Undo2, Layers } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { RankUndoApi } from './useRankUndo'

interface FieldChange { field: string; oldValue: string | null; newValue: string | null }
interface PendingWrite { queueId: string; syncType: string; entityType: string | null; entityId: string; externalId: string | null; fieldChanges: FieldChange[]; holdUntil: string | null; graceExpired: boolean }
interface RecentWrite { queueId: string; syncType: string; status: string; errorCode: string | null; errorMessage: string | null; changes: Record<string, string | null>; at: string }
interface PendingResp {
  campaign: { id: string; name: string; marketplace: string | null; liveBidWritesEnabled: boolean; writesToday: number }
  adsMode: string
  gate: { allowed: true; mode: string } | { allowed: false; reason: string; deniedAt?: string }
  guardrails: { cpcCeiling: { enabled: boolean; multiple: number }; maxBidChangePct: number | null; maxWritesPerDay: number | null }
  pending: PendingWrite[]
  pendingCount: number
  recent: RecentWrite[]
}

const isMoney = (f: string) => /bid|budget|cents/i.test(f)
const fmtVal = (f: string, v: string | null) => { if (v == null || v === '') return '—'; if (isMoney(f)) { const n = Number(v); return Number.isFinite(n) ? `€${(n / 100).toFixed(2)}` : v } return v }
const fieldLabel = (f: string) => f.replace(/Cents$/, '').replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim()
const entityLabel = (e: string | null) => e === 'AD_TARGET' ? 'Keyword/target' : e === 'CAMPAIGN' ? 'Campaign' : e === 'AD_GROUP' ? 'Ad group' : e === 'PRODUCT_AD' ? 'Product ad' : (e ?? 'Change')
const relTime = (iso: string) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago` }

export function StagedChangesTray({ campaignId, open, tab, onTab, onClose, onChanged, undoApi }: { campaignId: string; open: boolean; tab: 'staged' | 'history'; onTab: (t: 'staged' | 'history') => void; onClose: () => void; onChanged: () => void; undoApi: RankUndoApi }) {
  const [data, setData] = useState<PendingResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [showRecent, setShowRecent] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!campaignId) { setData(null); return }
    setLoading(true)
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/pending-writes`, { cache: 'no-store', signal }).then(r => r.json()); if (!signal?.aborted) setData(d as PendingResp) } catch { /* ignore */ } finally { if (!signal?.aborted) setLoading(false) }
  }, [campaignId])

  useEffect(() => { if (!open) return; const ac = new AbortController(); setMsg(''); void load(ac.signal); return () => ac.abort() }, [open, load])
  useEffect(() => { if (!open) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [open])

  const cancelOne = useCallback(async (queueId: string) => {
    setBusy(queueId)
    try { const r = await fetch(`${getBackendUrl()}/api/advertising/queued-mutations/${queueId}/cancel`, { method: 'POST' }).then(x => x.json()); if (r.ok) { setMsg('Change discarded.'); await load(); onChanged() } else setMsg(`Couldn't discard (${r.error}).`) } catch { setMsg("Couldn't discard.") }
    setBusy(null)
  }, [load, onChanged])

  const discardAll = useCallback(async () => {
    if (!data) return
    setBusy('all')
    for (const p of data.pending) { try { await fetch(`${getBackendUrl()}/api/advertising/queued-mutations/${p.queueId}/cancel`, { method: 'POST' }) } catch { /* continue */ } }
    setMsg('All staged changes discarded.'); await load(); onChanged(); setBusy(null)
  }, [data, load, onChanged])

  const toggleGate = useCallback(async (enabled: boolean) => {
    setBusy('gate')
    try { await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/live-writes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }); setMsg(enabled ? 'Write-gate OPEN — staged changes sync to Amazon as their 5-min hold expires.' : 'Write-gate closed — staged changes stay local until you open it.'); await load(); onChanged() } catch { setMsg("Couldn't change the write-gate.") }
    setBusy(null)
  }, [campaignId, load, onChanged])

  if (!open) return null
  const grace = (p: PendingWrite) => {
    if (p.graceExpired || !p.holdUntil) return { ready: true, label: 'ready to sync' }
    const rem = new Date(p.holdUntil).getTime() - now
    if (rem <= 0) return { ready: true, label: 'ready to sync' }
    return { ready: false, label: `${Math.floor(rem / 60000)}m ${Math.floor((rem % 60000) / 1000)}s` }
  }

  return (
    <div className="az-tray" role="region" aria-label="Staged changes">
      <div className="az-tray-head">
        <div className="az-tray-tabs">
          <button type="button" className={tab === 'staged' ? 'on' : ''} onClick={() => onTab('staged')}><Layers size={13} /> Staged{data && data.pending.length > 0 ? ` (${data.pending.length})` : ''}</button>
          <button type="button" className={tab === 'history' ? 'on' : ''} onClick={() => onTab('history')}><History size={13} /> History{undoApi.entries.length ? ` (${undoApi.entries.length})` : ''}</button>
        </div>
        <span className="sp" />
        {data?.campaign ? <span className="cn">{data.campaign.name}</span> : null}
        {loading && <Loader2 size={14} className="az-spin" />}
        <button type="button" className="az-tray-x" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </div>

      {tab === 'staged' && (<>
      {data && (
        <div className="az-tray-gate">
          <label className="az-tray-toggle">
            <input type="checkbox" checked={data.campaign.liveBidWritesEnabled} disabled={busy === 'gate'} onChange={e => void toggleGate(e.target.checked)} />
            <span>Send staged changes to Amazon (write-gate)</span>
          </label>
          <span className="sp" />
          <span className={`az-tray-mode ${data.adsMode === 'live' ? 'live' : ''}`}>{data.adsMode === 'live' ? 'LIVE account' : 'Sandbox'}</span>
          {data.gate.allowed
            ? <span className="az-tray-gst ok"><Check size={12} /> gate open · {data.gate.mode}</span>
            : <span className="az-tray-gst no"><AlertTriangle size={12} /> {data.gate.reason}</span>}
        </div>
      )}

      {msg && <div className="az-tray-msg" role="status" aria-live="polite">{msg}</div>}

      <div className="az-tray-body">
        {!data || data.pending.length === 0
          ? <div className="az-tray-empty"><Check size={14} /> Nothing staged — every change is live or already sent.</div>
          : data.pending.map(p => {
            const g = grace(p)
            return (
              <div key={p.queueId} className="az-tray-row">
                <span className="ent">{entityLabel(p.entityType)}</span>
                <span className="chg">
                  {p.fieldChanges.length === 0 ? <em>—</em> : p.fieldChanges.map((c, i) => (
                    <span key={i} className="fc"><b>{fieldLabel(c.field)}</b> {fmtVal(c.field, c.oldValue)} <span className="arr">→</span> <b className="nv">{fmtVal(c.field, c.newValue)}</b></span>
                  ))}
                </span>
                <span className={`gr ${g.ready ? 'rdy' : ''}`}><Clock size={11} /> {g.label}</span>
                <button type="button" className="az-tray-cancel" disabled={busy === p.queueId || g.ready} title={g.ready ? 'Grace window expired — can no longer cancel' : 'Discard this staged change'} onClick={() => void cancelOne(p.queueId)}>
                  {busy === p.queueId ? <Loader2 size={12} className="az-spin" /> : <X size={12} />}
                </button>
              </div>
            )
          })}
      </div>

      {data && data.pending.length > 0 && (
        <div className="az-tray-foot">
          <button type="button" className="az-btn" disabled={busy === 'all'} onClick={() => void discardAll()}>{busy === 'all' ? <><Loader2 size={13} className="az-spin" /> …</> : <><Trash2 size={13} /> Discard all {data.pending.length}</>}</button>
          <span className="sp" />
          {!data.campaign.liveBidWritesEnabled && <button type="button" className="az-btn dark" disabled={busy === 'gate'} onClick={() => void toggleGate(true)}><Check size={13} /> Open gate &amp; send {data.pending.length}</button>}
        </div>
      )}

      {data && data.recent.length > 0 && (
        <div className="az-tray-recent">
          <button type="button" className="az-tray-rectoggle" onClick={() => setShowRecent(v => !v)} aria-expanded={showRecent}><History size={12} /> Recently sent ({data.recent.length}) {showRecent ? '▾' : '▸'}</button>
          {showRecent && <div className="az-tray-reclist">
            {data.recent.map(r => (
              <div key={r.queueId} className={`rec ${r.status === 'FAILED' ? 'fail' : r.status === 'CANCELLED' ? 'cancel' : 'ok'}`}>
                <span className="st">{r.status}</span>
                <span className="ch">{Object.entries(r.changes).map(([f, v]) => `${fieldLabel(f)} → ${fmtVal(f, v)}`).join(', ') || r.syncType}</span>
                {r.errorMessage && <span className="er">{r.errorMessage}</span>}
              </div>
            ))}
          </div>}
        </div>
      )}
      </>)}

      {tab === 'history' && (
        <div className="az-tray-body az-hist">
          {undoApi.entries.length === 0
            ? <div className="az-tray-empty"><History size={14} /> No changes recorded yet for this campaign.</div>
            : undoApi.entries.map(e => (
              <div key={e.id} className={`az-hist-row ${e.isUndo ? 'undo' : ''}`}>
                <span className={`who ${e.actor}`}>{e.actor === 'automation' ? 'AUTO' : 'YOU'}</span>
                <span className="chg"><b>{fieldLabel(e.field)}</b> {fmtVal(e.field, e.oldValue)} <span className="arr">→</span> <b className="nv">{fmtVal(e.field, e.newValue)}</b>{e.reason ? <span className="rsn"> · {e.reason}</span> : null}</span>
                <span className="when">{relTime(e.at)}</span>
                {e.undoable && !e.isUndo
                  ? <button type="button" className="az-tray-cancel" disabled={undoApi.busy} title="Undo this change — re-stages the old bid" onClick={() => void undoApi.undoEntry(e)}><Undo2 size={12} /></button>
                  : <span style={{ width: 24, flex: 'none' }} />}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
