'use client'

/**
 * RC4.8 — Simple mode. The "a kid can understand and operate it" view: where you
 * rank, three big rank choices (Push hard / Balanced / Ease off — holistic
 * placement presets), set-a-schedule, and one-click safe automation. Every action
 * is the same gated path as the full cockpit (stages locally; nothing live until
 * the write-gate). Flip to Full for the power controls.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, ArrowUp, Minus, ArrowDown, Clock, Bot, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Tos { campaignId: string; topIS: number | null; currentPct: number }
const LEVELS = [
  { k: 'hard', label: 'Push hard', desc: 'Aim for the top spot', icon: ArrowUp, top: 150, rest: 20, prod: 10 },
  { k: 'balanced', label: 'Balanced', desc: 'Compete without overspending', icon: Minus, top: 50, rest: 15, prod: 5 },
  { k: 'ease', label: 'Ease off', desc: 'Save budget, rank naturally', icon: ArrowDown, top: 0, rest: 0, prod: 0 },
]

export function SimpleRankPanel({ market, campaignId, campaignName, onFull, onChanged }: { market: string; campaignId: string; campaignName: string; onFull: () => void; onChanged: () => void }) {
  const [tos, setTos] = useState<Tos | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!campaignId) return
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/top-of-search?windowDays=30&marketplace=${market}`, { cache: 'no-store', signal }).then(r => r.json()); const row = (d.rows ?? []).find((r: Tos) => r.campaignId === campaignId) ?? null; if (!signal?.aborted) setTos(row) } catch { /* ignore */ }
  }, [campaignId, market])
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort() }, [load])

  const setRank = useCallback(async (lvl: typeof LEVELS[number]) => {
    setBusy(lvl.k); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/placements`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adjustments: [{ placement: 'PLACEMENT_TOP', percentage: lvl.top }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: lvl.rest }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: lvl.prod }] }) }).then(x => x.json())
      setMsg(r?.mode && r.mode !== 'local' ? `“${lvl.label}” applied live on Amazon.` : `“${lvl.label}” set — open Changes to send it live.`)
      onChanged()
    } catch { setMsg('Could not set the rank.') }
    setBusy(null)
  }, [campaignId, onChanged])

  const automate = useCallback(async () => {
    setBusy('auto'); setMsg('')
    try {
      await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Hold Top-of-Search IS ≥ 50% (${market})`,
          description: 'Simple-mode auto-rule: holds top-of-search share at ≥ 50% bounded by 30% ACOS.',
          trigger: 'SCHEDULE', conditions: [],
          actions: [{ type: 'defend_top_of_search', targetIS: 0.5, targetAcos: 0.3, marketplace: market }, { type: 'notify', target: 'operator', message: 'Top-of-Search IS defense holding ≥ 50%' }],
          scopeMarketplace: market, maxExecutionsPerDay: 48,
        }),
      })
      setMsg('Auto-rule created (safe, dry-run). Turn it on in Full view → Automate when you’re ready.')
    } catch { setMsg('Could not set up automation.') }
    setBusy(null)
  }, [market])

  const share = tos?.topIS != null ? Math.round(tos.topIS * 100) : null
  const shareLabel = share == null ? 'No data yet' : share >= 55 ? 'Dominant at the top' : share >= 38 ? 'Strong at the top' : share >= 20 ? 'Sometimes at the top' : 'Rarely at the top'

  return (
    <div className="az-simple">
      <div className="az-simple-where">
        <div className="l">
          <span className="cap">Where you rank · {campaignName}</span>
          <span className="big">{share == null ? '—' : `${share}%`}</span>
          <span className="sub">of searches show you at the <b>top</b> · {shareLabel}</span>
        </div>
      </div>

      <div className="az-simple-q">How hard should this push for the top spot?</div>
      <div className="az-simple-levels">
        {LEVELS.map(l => {
          const Icon = l.icon
          return (
            <button key={l.k} type="button" className="az-simple-lvl" aria-label={`${l.label} — ${l.desc}`} disabled={busy === l.k} onClick={() => void setRank(l)}>
              {busy === l.k ? <Loader2 size={22} className="az-spin" /> : <Icon size={22} />}
              <span className="t">{l.label}</span>
              <span className="d">{l.desc}</span>
            </button>
          )
        })}
      </div>

      <div className="az-simple-more">
        <button type="button" className="az-btn" onClick={onFull}><Clock size={14} /> Set a schedule</button>
        <button type="button" className="az-btn" disabled={busy === 'auto'} onClick={() => void automate()}>{busy === 'auto' ? <><Loader2 size={14} className="az-spin" /> …</> : <><Bot size={14} /> Automate this for me</>}</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="az-simple-full" onClick={onFull}>Full controls →</button>
      </div>
      {msg && <div className="az-simple-msg" role="status" aria-live="polite"><Check size={13} /> {msg}</div>}
    </div>
  )
}
