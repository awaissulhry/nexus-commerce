'use client'

/**
 * CR.2 — the one quick way to set placement bias. Three holistic presets (Push
 * hard / Balanced / Ease off) that write PLACEMENT_TOP/REST/PRODUCT in one shot,
 * via the same gated /placements path the manual control uses. Replaces the old
 * Simple-mode layout-swap + its duplicate preset buttons: placement is now set
 * here (quick) or in the cockpit below it (fine), in ONE section — never four.
 */

import { useCallback, useState } from 'react'
import { Loader2, ArrowUp, Minus, ArrowDown, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const LEVELS = [
  { k: 'hard', label: 'Push hard', desc: 'Aim for the top spot', icon: ArrowUp, top: 150, rest: 20, prod: 10 },
  { k: 'balanced', label: 'Balanced', desc: 'Compete without overspending', icon: Minus, top: 50, rest: 15, prod: 5 },
  { k: 'ease', label: 'Ease off', desc: 'Save budget, rank naturally', icon: ArrowDown, top: 0, rest: 0, prod: 0 },
]

export function QuickRankSet({ campaignId, currentTopPct, onChanged, locked }: { campaignId: string; currentTopPct?: number; onChanged: () => void; locked?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const setRank = useCallback(async (lvl: typeof LEVELS[number]) => {
    if (!campaignId) return
    setBusy(lvl.k); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/placements`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adjustments: [{ placement: 'PLACEMENT_TOP', percentage: lvl.top }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: lvl.rest }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: lvl.prod }] }) }).then(x => x.json())
      setMsg(r?.mode && r.mode !== 'local' ? `“${lvl.label}” applied live on Amazon.` : `“${lvl.label}” set — review & send it in the Changes tray.`)
      onChanged()
    } catch { setMsg('Could not set the rank.') }
    setBusy(null)
  }, [campaignId, onChanged])

  // Which preset best matches the current top bias (so the active one is highlighted).
  const active = currentTopPct == null ? null : LEVELS.reduce((best, l) => Math.abs(l.top - currentTopPct) < Math.abs(best.top - currentTopPct) ? l : best, LEVELS[0]).k

  return (
    <div className={`az-qrs ${locked ? 'locked' : ''}`}>
      <div className="az-qrs-row">
        <span className="lbl">Quick set:</span>
        {LEVELS.map(l => {
          const Icon = l.icon
          return (
            <button key={l.k} type="button" className={`az-qrs-btn ${active === l.k ? 'on' : ''}`} disabled={busy === l.k || !!locked} onClick={() => void setRank(l)} title={locked ? 'Managed by your rank goal (§2)' : l.desc}>
              {busy === l.k ? <Loader2 size={15} className="az-spin" /> : <Icon size={15} />}
              <span className="t">{l.label}</span>
            </button>
          )
        })}
        <span className="hint">{locked ? 'Top-of-Search is held by your rank goal above' : 'or fine-tune the placement ladder below'}</span>
      </div>
      {msg && <div className="az-qrs-msg" role="status" aria-live="polite"><Check size={12} /> {msg}</div>}
    </div>
  )
}
