'use client'

/**
 * CBN.3.4 — "Create Ad Group: Settings" modal (H10 match). Name + default bid + targeting
 * type, POSTed to /advertising/adgroups/create ({ campaignId, name, defaultBidEur }). The
 * targeting choice is captured for parity; the local create service defaults it.
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const TARGETING = [
  { value: 'AUTO', title: 'Auto Targeting', desc: 'Amazon targets keywords and products that are similar to the product in your ad.' },
  { value: 'KEYWORD', title: 'Keyword Targeting', desc: 'Choose keywords to help your products appear in shopper searches, and set custom bids.' },
  { value: 'PRODUCT', title: 'Product Targeting', desc: 'Choose specific products, categories, or brands to target your ads.' },
]

export function CreateAdGroupModal({ campaignId, currency = '€', onClose, onCreated }: {
  campaignId: string; currency?: string; onClose: () => void; onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [bid, setBid] = useState('0.50')
  const [targeting, setTargeting] = useState('AUTO')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const valid = name.trim() !== '' && Number(bid) > 0

  async function create() {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/adgroups/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId, name: name.trim(), defaultBidEur: Number(bid), targetingType: targeting }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { error?: string }).error || `HTTP ${r.status}`) }
      onCreated(); onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to create ad group') } finally { setBusy(false) }
  }

  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create Ad Group">
        <div className="h10-modal-h"><b>Create Ad Group: Settings</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-sub">Set the name, default bid, and type of targeting</div>
        <div className="h10-modal-b">
          <div className="h10-cd-field"><label>Ad Group Name</label>
            <input type="text" placeholder="Enter ad group name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="h10-cd-field s"><label>Default Bid</label>
            <div className="h10-cd-money"><span className="pf">{currency}</span><input type="number" min="0.02" step="0.01" value={bid} onChange={(e) => setBid(e.target.value)} aria-label="Default bid" /></div>
          </div>
          <div className="h10-cd-field"><label>Targeting</label>
            {TARGETING.map((t) => (
              <label className={`h10-radio-card ${targeting === t.value ? 'on' : ''}`} key={t.value}>
                <input type="radio" name="targeting" checked={targeting === t.value} onChange={() => setTargeting(t.value)} />
                <span className="rc-b"><span className="rc-t">{t.title}</span><span className="rc-d">{t.desc}</span></span>
              </label>
            ))}
          </div>
          {err && <div className="h10-cd-modalerr">{err}</div>}
        </div>
        <div className="h10-modal-f">
          <button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <button type="button" className="h10-am-btn primary" disabled={!valid || busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create Ad Group'}</button>
        </div>
      </div>
    </div>
  )
}
