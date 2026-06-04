'use client'

/**
 * RC4.11 — Keyword bid station. Absorbs the old "Keyword targeting" mode into the
 * cockpit: pick the campaign's keywords and bid them with one of three modes —
 * Boost % of the current bid, Set an exact €, or Bid-to-win (beat the query's
 * going CPC from Share-of-Voice). Applies via the gated bulk-bid path (clamped by
 * the CPC ceiling); nothing live until the write-gate.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ListChecks, Loader2, Zap, ChevronDown, ChevronRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface RawKw { id: string; text: string; kind: string; matchType: string | null; bidCents: number; impressions: number; acos: number | null; roas: number | null }
interface Sov { sovPct: number; cpcCents: number }
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)

export function KeywordBidStation({ campaignId, onChanged }: { campaignId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<RawKw[] | null>(null)
  const [sov, setSov] = useState<Record<string, Sov>>({})
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'win' | 'boost' | 'set'>('win')
  const [boostPct, setBoostPct] = useState(25)
  const [setEur, setSetEur] = useState('1.00')
  const [winMult, setWinMult] = useState(130)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback((signal?: AbortSignal) => {
    setRows(null); setSel(new Set())
    void fetch(`${getBackendUrl()}/api/advertising/targets?campaignId=${encodeURIComponent(campaignId)}&windowDays=30&kind=KEYWORD&limit=400`, { cache: 'no-store', signal }).then(r => r.json()).then(d => { if (!signal?.aborted) setRows((((d.rows ?? d.items) ?? []) as RawKw[]).filter(t => t.kind === 'KEYWORD' && t.text)) }).catch(() => { if (!signal?.aborted) setRows([]) })
    void fetch(`${getBackendUrl()}/api/advertising/share-of-voice?windowDays=30&limit=400`, { cache: 'no-store', signal }).then(r => r.json()).then(d => { if (signal?.aborted) return; const m: Record<string, Sov> = {}; for (const s of (d.rows ?? [])) m[(s.query ?? '').toLowerCase()] = s; setSov(m) }).catch(() => {})
  }, [campaignId])
  useEffect(() => { if (!open) return; const ac = new AbortController(); load(ac.signal); return () => ac.abort() }, [open, load])

  const targetBid = useCallback((t: RawKw) => {
    if (mode === 'set') return Math.max(2, Math.round(Number(setEur) * 100))
    if (mode === 'boost') return Math.max(2, Math.round(t.bidCents * (1 + boostPct / 100)))
    const going = sov[t.text.toLowerCase()]?.cpcCents ?? t.bidCents
    return Math.max(t.bidCents, Math.round(going * (winMult / 100)))
  }, [mode, setEur, boostPct, winMult, sov])

  const shown = useMemo(() => [...(rows ?? [])].sort((a, b) => b.impressions - a.impressions), [rows])
  const allSel = shown.length > 0 && shown.every(t => sel.has(t.id))

  const apply = useCallback(async () => {
    const targets = shown.filter(t => sel.has(t.id))
    if (!targets.length) return
    setBusy(true); setMsg('')
    try {
      const entries = targets.map(t => ({ adTargetId: t.id, bidCents: targetBid(t) }))
      const r = await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries, reason: `Rank Control keyword bid (${mode}) — RC4.11` }) }).then(x => x.json())
      setMsg(r?.ok !== false ? `Staged ${entries.length} keyword bid${entries.length === 1 ? '' : 's'} — review in Changes.${r?.clamps ? ` ${r.clamps} clamped by CPC ceiling.` : ''}` : 'Could not stage the bids.')
      setSel(new Set()); onChanged()
    } catch { setMsg('Could not stage the bids.') }
    setBusy(false)
  }, [shown, sel, targetBid, mode, onChanged])

  return (
    <div className="az-station">
      <button type="button" className="az-station-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} <ListChecks size={15} /> <b>Bid your keywords</b>
        <span className="sub">boost, set, or bid-to-win the exact keywords you choose</span>
      </button>
      {open && (
        <div className="az-station-body">
          <div className="az-kwb-push">
            <span className="lbl">Push</span>
            {([['win', 'Bid to win'], ['boost', 'Boost %'], ['set', 'Set bid']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={mode === k} className={`az-strat-btn ${mode === k ? 'on' : ''}`} onClick={() => setMode(k)}>{l}</button>)}
            {mode === 'boost' && <label>+<input type="number" value={boostPct} onChange={e => setBoostPct(Number(e.target.value))} />% of current</label>}
            {mode === 'set' && <label>€<input type="number" step="0.05" value={setEur} onChange={e => setSetEur(e.target.value)} />/click</label>}
            {mode === 'win' && <label>bid <input type="number" value={winMult} onChange={e => setWinMult(Number(e.target.value))} />% of going CPC</label>}
            <span style={{ flex: 1 }} />
            <button type="button" className="az-btn dark" disabled={busy || sel.size === 0} onClick={() => void apply()}>{busy ? <><Loader2 size={14} className="az-spin" /> …</> : <><Zap size={14} /> Stage {sel.size || ''}</>}</button>
          </div>
          {msg && <div className="az-cockpit-sub" style={{ margin: '8px 0 0' }} role="status" aria-live="polite">{msg}</div>}
          <div className="az-kwb-tablewrap">
            <table className="az-kwb-table">
              <thead><tr><th><input type="checkbox" checked={allSel} onChange={e => setSel(e.target.checked ? new Set(shown.map(t => t.id)) : new Set())} aria-label="Select all keywords" /></th><th className="l">Keyword</th><th>Bid</th><th>SoV</th><th>Impr</th><th>ACOS</th><th>New bid</th></tr></thead>
              <tbody>
                {rows === null && <tr><td colSpan={7} className="e">Loading keywords…</td></tr>}
                {rows !== null && shown.length === 0 && <tr><td colSpan={7} className="e">No keywords on this campaign.</td></tr>}
                {shown.map(t => { const nb = targetBid(t); const up = nb > t.bidCents; const s = sov[t.text.toLowerCase()]; return (
                  <tr key={t.id} className={sel.has(t.id) ? 'on' : ''}>
                    <td><input type="checkbox" checked={sel.has(t.id)} onChange={() => setSel(x => { const n = new Set(x); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n })} aria-label={`Select ${t.text}`} /></td>
                    <td className="l">{t.text}</td>
                    <td>{eur(t.bidCents)}</td>
                    <td>{s ? pct(s.sovPct) : '—'}</td>
                    <td>{t.impressions.toLocaleString()}</td>
                    <td>{pct(t.acos)}</td>
                    <td className={up ? 'up' : ''}>{eur(nb)}{up ? ' ↑' : ''}</td>
                  </tr>
                ) })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
