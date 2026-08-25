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
import { Button, Input, Textarea } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { Listbox } from '@/design-system/components/Listbox'

interface RawKw { id: string; text: string; kind: string; matchType: string | null; bidCents: number; status: string; adGroupId: string; adGroupName: string; impressions: number; acos: number | null }
interface Sov { sovPct: number; cpcCents: number }

/** `size="xs"` on purpose: `.az-kwb-table` is a COMPACT grid (12px / 6px 9px) inside a 340px
 *  scroller, not the roomy `.az-table`. At the default `md` the rows go ~25px → ~42px and a
 *  bid-editing station shows barely half as many keywords without scrolling. `xs` is
 *  11.5px / 5px 9px — the near match. `maxHeight` carries the scroller's cap.
 *
 *  A factory: the SoV map, the bid target and `sel` are all component state. `.sub2`, `.up` and
 *  `.dim` were scoped under `.az-kwb-table`, so like `.sub` before them they die on contact
 *  with `.nds-grid` — hence the `.az-kwb-*` equivalents in amazon.css. */
const kwbColumns = (
  sov: Record<string, Sov | undefined>,
  targetBid: (t: RawKw) => number,
  sel: Set<string>,
): Array<Column<RawKw>> => [
  { key: 'keyword', label: 'Keyword', render: t => t.text },
  { key: 'match', label: 'Match · ad group', render: t => <span className="az-kwb-sub">{(t.matchType ?? '').replace('SEARCH_', '').toLowerCase() || '—'} · {t.adGroupName || 'ad group'}</span> },
  { key: 'bid', label: 'Bid', align: 'right', render: t => eur(t.bidCents) },
  { key: 'sov', label: 'SoV', align: 'right', render: t => { const s = sov[t.text.toLowerCase()]; return s ? pct(s.sovPct) : '—' } },
  { key: 'impr', label: 'Impr', align: 'right', render: t => t.impressions.toLocaleString() },
  { key: 'acos', label: 'ACOS', align: 'right', render: t => pct(t.acos) },
  { key: 'newbid', label: 'New bid', align: 'right', render: t => {
    const nb = targetBid(t); const up = nb > t.bidCents
    return sel.has(t.id)
      ? <span className={up ? 'az-kwb-up' : undefined}>{eur(nb)}{up ? ' ↑' : ''}</span>
      : <span className="az-kwb-dim">{eur(nb)}</span>
  } },
]
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
            <Textarea aria-label="Paste keywords" value={paste} onChange={e => setPaste(e.target.value)} placeholder={'giacca moto pelle\ngiubbotto moto estivo, guanti moto racing'} rows={3} style={{ minHeight: 80, fontSize: 12.5 }} />
            <div className="az-kwb-addrow">
              <span>Match {MATCHES.map(m => <Button key={m} size="sm" aria-pressed={match === m} active={match === m} onClick={() => setMatch(m)}>{m[0] + m.slice(1).toLowerCase()}</Button>)}</span>
              <label>Bid <Input type="number" min={0.02} step={0.05} prefix="€" aria-label="Bid" value={addBid} onChange={e => setAddBid(e.target.value)} style={{ width: 62 }} /></label>
              {adGroups.length > 0 && <span>Ad group <Listbox ariaLabel="Ad group" width={200} value={addGroup} onChange={setAddGroup} options={adGroups.map(g => ({ value: g.id, label: `${g.name} (${g.n})` }))} /></span>}
              <span style={{ flex: 1 }} />
              <Button variant="primary" disabled={adding || !addGroup || newKws.length === 0} onClick={() => void addKeywords()}>{adding ? <><Loader2 size={14} className="az-spin" /> …</> : <><Plus size={14} /> Add {newKws.length || ''}</>}</Button>
            </div>
            <div className="az-cockpit-note">New keywords are created inside the chosen ad group of this campaign (so they inherit its products + placement settings). Staged until you open the write-gate — then they go live on Amazon. {newKws.length > 0 ? `${newKws.length} new` : 'Paste new keywords above'}.</div>
            {addMsg && <div className="az-cockpit-sub" style={{ margin: '6px 0 0' }} role="status" aria-live="polite">{addMsg}</div>}
          </div>

          {/* ── Bid existing keywords ── */}
          <div className="az-kwb-push">
            <span className="lbl">Bid</span>
            {([['win', 'Bid to win'], ['boost', 'Boost %'], ['set', 'Set bid']] as const).map(([k, l]) => <Button key={k} size="sm" aria-pressed={mode === k} active={mode === k} onClick={() => setMode(k)}>{l}</Button>)}
            {mode === 'boost' && <label><Input type="number" aria-label="Boost percent" prefix="+" suffix="%" value={boostPct} onChange={e => setBoostPct(Number(e.target.value))} style={{ width: 52 }} /> of current</label>}
            {mode === 'set' && <label><Input type="number" step="0.05" aria-label="Bid per click" prefix="€" value={setEur} onChange={e => setSetEur(e.target.value)} style={{ width: 62 }} /> /click</label>}
            {mode === 'win' && <label>bid <Input type="number" aria-label="Percent of going CPC" suffix="%" value={winMult} onChange={e => setWinMult(Number(e.target.value))} style={{ width: 56 }} /> of going CPC</label>}
            <span style={{ flex: 1 }} />
            <Button variant="primary" disabled={busy || sel.size === 0} onClick={() => void applyBids()}>{busy ? <><Loader2 size={14} className="az-spin" /> …</> : <><Zap size={14} /> Stage {sel.size || ''}</>}</Button>
          </div>
          {msg && <div className="az-cockpit-sub" style={{ margin: '8px 0 0' }} role="status" aria-live="polite">{msg}</div>}
          <DataGrid<RawKw>
              size="xs"
              maxHeight={340}
              className="az-kwb-grid"
              rows={rows === null ? [] : shown}
              rowKey={t => t.id}
              columns={kwbColumns(sov, targetBid, sel)}
              selectable
              selected={sel}
              onSelectedChange={setSel}
              selectAllHint="Select every keyword on this campaign"
              rowClassName={t => (sel.has(t.id) ? 'on' : undefined)}
              emptyState={rows === null ? 'Loading keywords…' : 'No keywords on this campaign yet — add some above.'}
            />
        </div>
      )}
    </div>
  )
}
