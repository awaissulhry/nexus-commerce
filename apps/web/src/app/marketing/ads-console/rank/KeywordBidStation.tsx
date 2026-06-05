'use client'

/**
 * RC4.11/4.14 — Keyword station. The single keyword surface for the selected
 * campaign: it shows the campaign's own keywords (what it bids on / competes to
 * rank for) with their ad group, lets you bid them (Boost % / Set € / Bid-to-win
 * via Share-of-Voice going CPC), and lets you ADD new keywords — created in an ad
 * group you pick, via /keywords/create. Every write is gated (staged until the
 * write-gate opens); bids are clamped by the CPC ceiling.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ListChecks, Loader2, Zap, Plus, ChevronDown, ChevronRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface RawKw { id: string; text: string; kind: string; matchType: string | null; bidCents: number; status: string; adGroupId: string; adGroupName: string; impressions: number; acos: number | null }
interface Sov { sovPct: number; cpcCents: number }
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const MATCHES = ['BROAD', 'PHRASE', 'EXACT'] as const

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
  // add-keyword state
  const [paste, setPaste] = useState('')
  const [match, setMatch] = useState<typeof MATCHES[number]>('PHRASE')
  const [addBid, setAddBid] = useState('0.50')
  const [addGroup, setAddGroup] = useState('')
  const [adding, setAdding] = useState(false)
  const [addMsg, setAddMsg] = useState('')

  const load = useCallback((signal?: AbortSignal) => {
    setRows(null); setSel(new Set())
    void fetch(`${getBackendUrl()}/api/advertising/targets?campaignId=${encodeURIComponent(campaignId)}&windowDays=30&kind=KEYWORD&limit=400`, { cache: 'no-store', signal }).then(r => r.json()).then(d => { if (!signal?.aborted) setRows((((d.rows ?? d.items) ?? []) as RawKw[]).filter(t => t.kind === 'KEYWORD' && t.text)) }).catch(() => { if (!signal?.aborted) setRows([]) })
    void fetch(`${getBackendUrl()}/api/advertising/share-of-voice?windowDays=30&limit=400`, { cache: 'no-store', signal }).then(r => r.json()).then(d => { if (signal?.aborted) return; const m: Record<string, Sov> = {}; for (const s of (d.rows ?? [])) m[(s.query ?? '').toLowerCase()] = s; setSov(m) }).catch(() => {})
  }, [campaignId])
  useEffect(() => { if (!open) return; const ac = new AbortController(); load(ac.signal); return () => ac.abort() }, [open, load])

  // The campaign's ad groups (derived from its targets), biggest first — that's
  // where new keywords go. Default the add-target to the biggest.
  const adGroups = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>()
    for (const t of (rows ?? [])) { const g = m.get(t.adGroupId) ?? { name: t.adGroupName || 'Ad group', n: 0 }; g.n += 1; m.set(t.adGroupId, g) }
    return [...m.entries()].map(([id, v]) => ({ id, name: v.name, n: v.n })).sort((a, b) => b.n - a.n)
  }, [rows])
  useEffect(() => { if (adGroups.length && !adGroups.some(g => g.id === addGroup)) setAddGroup(adGroups[0]!.id) }, [adGroups]) // eslint-disable-line react-hooks/exhaustive-deps

  const targetBid = useCallback((t: RawKw) => {
    if (mode === 'set') return Math.max(2, Math.round(Number(setEur) * 100))
    if (mode === 'boost') return Math.max(2, Math.round(t.bidCents * (1 + boostPct / 100)))
    const going = sov[t.text.toLowerCase()]?.cpcCents ?? t.bidCents
    return Math.max(t.bidCents, Math.round(going * (winMult / 100)))
  }, [mode, setEur, boostPct, winMult, sov])

  const shown = useMemo(() => [...(rows ?? [])].sort((a, b) => b.impressions - a.impressions), [rows])
  const allSel = shown.length > 0 && shown.every(t => sel.has(t.id))
  const existingSet = useMemo(() => new Set((rows ?? []).map(t => t.text.trim().toLowerCase())), [rows])
  const newKws = useMemo(() => [...new Set(paste.split(/[\n,]+/).map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean))].filter(k => !existingSet.has(k.toLowerCase())), [paste, existingSet])

  const applyBids = useCallback(async () => {
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

  const addKeywords = useCallback(async () => {
    if (!addGroup || newKws.length === 0) return
    setAdding(true); setAddMsg('')
    let ok = 0
    for (const kw of newKws) {
      try { const r = await fetch(`${getBackendUrl()}/api/advertising/keywords/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId: addGroup, keywordText: kw, matchType: match, bidEur: Number(addBid) || 0.5 }) }).then(x => x.ok); if (r) ok += 1 } catch { /* continue */ }
    }
    const gname = adGroups.find(g => g.id === addGroup)?.name ?? 'the ad group'
    setAddMsg(`Added ${ok}/${newKws.length} ${match.toLowerCase()} keyword${newKws.length === 1 ? '' : 's'} to "${gname}" — staged until you open the write-gate.`)
    setPaste(''); onChanged(); load(); setAdding(false)
  }, [addGroup, newKws, match, addBid, adGroups, onChanged, load])

  return (
    <div className="az-station">
      <button type="button" className="az-station-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} <ListChecks size={15} /> <b>Keywords</b>
        <span className="sub">the keywords this campaign ranks for — bid them, or add new ones{rows ? ` · ${rows.length} active` : ''}</span>
      </button>
      {open && (
        <div className="az-station-body">
          {/* ── Add keywords ── */}
          <div className="az-kwb-add">
            <div className="az-kwb-addhd"><Plus size={14} /> Add keywords to this campaign</div>
            <textarea className="az-cq-ta" value={paste} onChange={e => setPaste(e.target.value)} placeholder={'giacca moto pelle\ngiubbotto moto estivo, guanti moto racing'} rows={3} />
            <div className="az-kwb-addrow">
              <label>Match {MATCHES.map(m => <button key={m} type="button" aria-pressed={match === m} className={`az-strat-btn ${match === m ? 'on' : ''}`} onClick={() => setMatch(m)}>{m[0] + m.slice(1).toLowerCase()}</button>)}</label>
              <label>Bid €<input type="number" min={0.02} step={0.05} value={addBid} onChange={e => setAddBid(e.target.value)} /></label>
              {adGroups.length > 0 && <label>Ad group <select value={addGroup} onChange={e => setAddGroup(e.target.value)}>{adGroups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.n})</option>)}</select></label>}
              <span style={{ flex: 1 }} />
              <button type="button" className="az-btn dark" disabled={adding || !addGroup || newKws.length === 0} onClick={() => void addKeywords()}>{adding ? <><Loader2 size={14} className="az-spin" /> …</> : <><Plus size={14} /> Add {newKws.length || ''}</>}</button>
            </div>
            <div className="az-cockpit-note">New keywords are created inside the chosen ad group of this campaign (so they inherit its products + placement settings). Staged until you open the write-gate — then they go live on Amazon. {newKws.length > 0 ? `${newKws.length} new` : 'Paste new keywords above'}.</div>
            {addMsg && <div className="az-cockpit-sub" style={{ margin: '6px 0 0' }} role="status" aria-live="polite">{addMsg}</div>}
          </div>

          {/* ── Bid existing keywords ── */}
          <div className="az-kwb-push">
            <span className="lbl">Bid</span>
            {([['win', 'Bid to win'], ['boost', 'Boost %'], ['set', 'Set bid']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={mode === k} className={`az-strat-btn ${mode === k ? 'on' : ''}`} onClick={() => setMode(k)}>{l}</button>)}
            {mode === 'boost' && <label>+<input type="number" value={boostPct} onChange={e => setBoostPct(Number(e.target.value))} />% of current</label>}
            {mode === 'set' && <label>€<input type="number" step="0.05" value={setEur} onChange={e => setSetEur(e.target.value)} />/click</label>}
            {mode === 'win' && <label>bid <input type="number" value={winMult} onChange={e => setWinMult(Number(e.target.value))} />% of going CPC</label>}
            <span style={{ flex: 1 }} />
            <button type="button" className="az-btn dark" disabled={busy || sel.size === 0} onClick={() => void applyBids()}>{busy ? <><Loader2 size={14} className="az-spin" /> …</> : <><Zap size={14} /> Stage {sel.size || ''}</>}</button>
          </div>
          {msg && <div className="az-cockpit-sub" style={{ margin: '8px 0 0' }} role="status" aria-live="polite">{msg}</div>}
          <div className="az-kwb-tablewrap">
            <table className="az-kwb-table">
              <thead><tr><th><input type="checkbox" checked={allSel} onChange={e => setSel(e.target.checked ? new Set(shown.map(t => t.id)) : new Set())} aria-label="Select all keywords" /></th><th className="l">Keyword</th><th className="l">Match · ad group</th><th>Bid</th><th>SoV</th><th>Impr</th><th>ACOS</th><th>New bid</th></tr></thead>
              <tbody>
                {rows === null && <tr><td colSpan={8} className="e">Loading keywords…</td></tr>}
                {rows !== null && shown.length === 0 && <tr><td colSpan={8} className="e">No keywords on this campaign yet — add some above.</td></tr>}
                {shown.map(t => { const nb = targetBid(t); const up = nb > t.bidCents; const s = sov[t.text.toLowerCase()]; return (
                  <tr key={t.id} className={sel.has(t.id) ? 'on' : ''}>
                    <td><input type="checkbox" checked={sel.has(t.id)} onChange={() => setSel(x => { const n = new Set(x); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n })} aria-label={`Select ${t.text}`} /></td>
                    <td className="l">{t.text}</td>
                    <td className="l"><span className="sub2">{(t.matchType ?? '').replace('SEARCH_', '').toLowerCase() || '—'} · {t.adGroupName || 'ad group'}</span></td>
                    <td>{eur(t.bidCents)}</td>
                    <td>{s ? pct(s.sovPct) : '—'}</td>
                    <td>{t.impressions.toLocaleString()}</td>
                    <td>{pct(t.acos)}</td>
                    <td className={up ? 'up' : ''}>{sel.has(t.id) ? <>{eur(nb)}{up ? ' ↑' : ''}</> : <span className="dim">{eur(nb)}</span>}</td>
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
