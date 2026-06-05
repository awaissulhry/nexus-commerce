'use client'

/**
 * RC4.4 — Conquest station. Absorbs the old "Conquesting" mode: place this
 * campaign's ads on competitor product pages by creating PRODUCT targets (rival
 * ASINs) in one of the campaign's ad groups. (Add-keywords + bid already live in
 * the embedded cockpit's keyword manager + RC3 overlap, so this fills the one
 * gap.) Ad groups are derived from /targets; creation via /targets/create.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crosshair, Loader2, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Targ { id: string; kind: string; adGroupId: string; adGroupName: string; text: string }
const isAsin = (s: string) => /^[A-Z0-9]{10}$/.test(s)

export function ConquestStation({ campaignId, onChanged }: { campaignId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<Targ[]>([])
  const [adGroupId, setAdGroupId] = useState('')
  const [asinsRaw, setAsinsRaw] = useState('')
  const [bid, setBid] = useState('0.75')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!campaignId || !open) return
    const ac = new AbortController()
    void fetch(`${getBackendUrl()}/api/advertising/targets?campaignId=${encodeURIComponent(campaignId)}&windowDays=30&limit=400`, { cache: 'no-store', signal: ac.signal }).then(r => r.json()).then(d => { if (!ac.signal.aborted) setTargets(((d.rows ?? d.items) ?? []) as Targ[]) }).catch(() => {})
    return () => ac.abort()
  }, [campaignId, open])

  const adGroups = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of targets) if (t.adGroupId) m.set(t.adGroupId, t.adGroupName ?? 'Ad group')
    return [...m].map(([id, name]) => ({ id, name }))
  }, [targets])
  useEffect(() => { if (adGroups.length && !adGroups.some(a => a.id === adGroupId)) setAdGroupId(adGroups[0]!.id) }, [adGroups]) // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => {
    const uniq = [...new Set(asinsRaw.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean))]
    return { valid: uniq.filter(isAsin), invalid: uniq.filter(a => !isAsin(a)) }
  }, [asinsRaw])
  const existing = useMemo(() => new Set(targets.filter(t => t.kind === 'PRODUCT').map(t => (t.text || '').toUpperCase())), [targets])

  const create = useCallback(async () => {
    if (!adGroupId || parsed.valid.length === 0) return
    setBusy(true); setMsg('')
    let ok = 0
    for (const asin of parsed.valid) {
      try { const r = await fetch(`${getBackendUrl()}/api/advertising/targets/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adGroupId, kind: 'PRODUCT', value: asin, bidEur: Number(bid) || 0.75 }) }).then(x => x.ok); if (r) ok += 1 } catch { /* continue */ }
    }
    setMsg(`Created ${ok}/${parsed.valid.length} competitor target${parsed.valid.length === 1 ? '' : 's'} at €${(Number(bid) || 0.75).toFixed(2)}.`)
    setAsinsRaw(''); onChanged(); setBusy(false)
  }, [adGroupId, parsed, bid, onChanged])

  return (
    <div className="az-station">
      <button type="button" className="az-station-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} <Crosshair size={15} /> <b>Conquer competitors</b>
        <span className="sub">place your ads on rival product pages{existing.size ? ` · ${existing.size} active` : ''}</span>
      </button>
      {open && (
        <div className="az-station-body">
          {adGroups.length === 0
            ? <div className="az-cockpit-sub">No ad groups found for this campaign yet — add a keyword/target in the keyword manager first.</div>
            : (<>
              {adGroups.length > 1 && <label className="az-cq-ag">Ad group <select value={adGroupId} onChange={e => setAdGroupId(e.target.value)}>{adGroups.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
              <textarea className="az-cq-ta" value={asinsRaw} onChange={e => setAsinsRaw(e.target.value)} placeholder={'Competitor ASINs — one per line or comma-separated\nB0XXXXXXXX, B0YYYYYYYY'} rows={3} />
              <div className="az-cq-row">
                <label>Bid € <input type="number" min={0.05} step={0.05} value={bid} onChange={e => setBid(e.target.value)} /></label>
                <span className="az-cockpit-sub" style={{ margin: 0 }}>{parsed.valid.length} valid{parsed.invalid.length ? ` · ${parsed.invalid.length} invalid` : ''}{parsed.valid.some(a => existing.has(a)) ? ' · some already targeted' : ''}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="az-btn dark" disabled={busy || !adGroupId || parsed.valid.length === 0} onClick={() => void create()}>{busy ? <><Loader2 size={14} className="az-spin" /> …</> : <><Check size={14} /> Target {parsed.valid.length || ''}</>}</button>
              </div>
              {msg && <div className="az-cockpit-sub" style={{ marginTop: 6 }}>{msg}</div>}
              <div className="az-cockpit-note" style={{ marginTop: 8 }}>How it works: each ASIN becomes a <b>Product target</b> in the chosen ad group, so your ad shows on that competitor&apos;s product page (the Sponsored slot) and you pay per click at the bid above. Staged until you open the write-gate.</div>
            </>)}
        </div>
      )}
    </div>
  )
}
