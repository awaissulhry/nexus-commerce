'use client'

/**
 * ER2 — step ④ Keywords & Bids (Priority manual): per-ad-group keyword
 * baskets on the KeywordTargetingPanel PATTERN (§PL-8): tabs = Mined seeds
 * (our titles+aspects miner) / Enter keywords; suggested bids on demand
 * (post-launch API needs a group, so pre-launch we show BE-CPC context);
 * negatives per group; multi-group via "+ Ad group".
 */
import { useState } from 'react'
import { postEbayAds } from '../../../../_lib'
import { emptyGroup, type CampaignPlan, type PlanAdGroup, type Seed } from '../plan'

export function KeywordsStep({ plan, set }: { plan: CampaignPlan; set: (patch: Partial<CampaignPlan>) => void }) {
  const [tab, setTab] = useState<Record<number, 'mined' | 'enter'>>({})
  const [entry, setEntry] = useState<Record<number, string>>({})
  const [mining, setMining] = useState(false)

  const setGroup = (i: number, patch: Partial<PlanAdGroup>) =>
    set({ adGroups: plan.adGroups.map((g, j) => (j === i ? { ...g, ...patch } : g)) })

  const mineSeeds = async (i: number) => {
    setMining(true)
    try {
      const out = await postEbayAds<{ seeds: Array<{ text: string; source: string; matchType: string; bidCents: number }> }>('/builder/seeds', { marketplace: plan.marketplace, listingIds: plan.selected })
      const existing = new Set(plan.adGroups[i]!.seeds.map((s) => s.text))
      const fresh: Seed[] = out.seeds.filter((s) => !existing.has(s.text)).map((s) => ({ text: s.text, source: s.source, matchType: s.matchType as Seed['matchType'], bidEur: (s.bidCents / 100).toFixed(2), on: true }))
      setGroup(i, { seeds: [...plan.adGroups[i]!.seeds, ...fresh] })
    } finally { setMining(false) }
  }

  const addEntered = (i: number) => {
    const lines = (entry[i] ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return
    const existing = new Set(plan.adGroups[i]!.seeds.map((s) => s.text))
    const fresh: Seed[] = lines.filter((t) => !existing.has(t)).map((t) => ({ text: t, source: 'MANUAL', matchType: 'PHRASE', bidEur: '0.30', on: true }))
    setGroup(i, { seeds: [...plan.adGroups[i]!.seeds, ...fresh] })
    setEntry((e) => ({ ...e, [i]: '' }))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {plan.adGroups.map((g, i) => (
        <div key={i} className="h10-cd-card pad">
          <div className="eb-form-row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
            <div className="h10-cd-field s"><label>Ad group name</label>
              <input value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} /></div>
            <div className="h10-cd-field s" style={{ maxWidth: 140 }}><label>Default bid €</label>
              <input type="number" min={0.02} step={0.01} value={g.defaultBidEur} onChange={(e) => setGroup(i, { defaultBidEur: e.target.value })} /></div>
            <span className="grow" style={{ flex: 1 }} />
            {plan.adGroups.length > 1 && <button type="button" className="h10-am-btn sm" onClick={() => set({ adGroups: plan.adGroups.filter((_, j) => j !== i) })}>Remove group</button>}
          </div>

          <nav className="h10-cd-tabs" style={{ marginBottom: 10 }}>
            <button type="button" className={`h10-cd-tab ${(tab[i] ?? 'mined') === 'mined' ? 'on' : ''}`} onClick={() => setTab((t) => ({ ...t, [i]: 'mined' }))}>Mined seeds</button>
            <button type="button" className={`h10-cd-tab ${tab[i] === 'enter' ? 'on' : ''}`} onClick={() => setTab((t) => ({ ...t, [i]: 'enter' }))}>Enter keywords</button>
          </nav>

          {(tab[i] ?? 'mined') === 'mined' && (
            <div style={{ marginBottom: 10 }}>
              <button type="button" className="h10-am-btn" disabled={mining || plan.selected.length === 0} onClick={() => void mineSeeds(i)}>{mining ? 'Mining…' : `Mine seeds from ${plan.selected.length} staged listing(s)`}</button>
              <span className="eb-be-hint" style={{ marginLeft: 10 }}>Title bigrams + Marca×Tipo aspects — no eBay suggest API exists pre-launch; these are YOUR data.</span>
            </div>
          )}
          {tab[i] === 'enter' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <textarea className="eb-textarea" rows={3} style={{ flex: 1 }} placeholder={'one keyword per line…'} value={entry[i] ?? ''} onChange={(e) => setEntry((x) => ({ ...x, [i]: e.target.value }))} />
              <button type="button" className="h10-am-btn" onClick={() => addEntered(i)}>Add</button>
            </div>
          )}

          {g.seeds.length === 0 ? (
            <p className="eb-be-hint">No keywords in this group yet.</p>
          ) : (
            <div className="h10-am-grid" style={{ maxHeight: 260 }}>
              <table>
                <thead><tr><th className="ed">Keyword ({g.seeds.filter((s) => s.on).length} selected)</th><th className="ed">Source</th><th className="ed">Match</th><th className="num">Bid €</th></tr></thead>
                <tbody>
                  {g.seeds.map((s, k) => (
                    <tr key={`${s.text}-${k}`} style={s.on ? undefined : { opacity: 0.45 }}>
                      <td className="ed">
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <input type="checkbox" checked={s.on} onChange={(e) => setGroup(i, { seeds: g.seeds.map((x, j) => (j === k ? { ...x, on: e.target.checked } : x)) })} />
                          <span className="t">{s.text}</span>
                        </label>
                      </td>
                      <td className="ed"><span className={`h10-pill ${s.source === 'MANUAL' ? 'ok' : 'arch'}`}>{s.source === 'ASPECT/FREQUENT' ? 'aspects' : s.source.toLowerCase()}</span></td>
                      <td className="ed">
                        <select className="h10-cd-input" value={s.matchType} onChange={(e) => setGroup(i, { seeds: g.seeds.map((x, j) => (j === k ? { ...x, matchType: e.target.value as Seed['matchType'] } : x)) })}>
                          <option value="PHRASE">Phrase</option><option value="EXACT">Exact</option><option value="BROAD">Broad</option>
                        </select>
                      </td>
                      <td className="num"><input className="h10-cd-input" style={{ width: 70 }} type="number" min={0.05} step={0.05} value={s.bidEur} onChange={(e) => setGroup(i, { seeds: g.seeds.map((x, j) => (j === k ? { ...x, bidEur: e.target.value } : x)) })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="h10-cd-field" style={{ marginTop: 12, maxWidth: 520 }}>
            <label>Negative keywords — one per line ·
              <select className="h10-cd-input" style={{ marginLeft: 8 }} value={g.negMatch} onChange={(e) => setGroup(i, { negMatch: e.target.value as 'EXACT' | 'PHRASE' })}>
                <option value="EXACT">EXACT</option><option value="PHRASE">PHRASE</option>
              </select>
            </label>
            <textarea className="eb-textarea" rows={2} value={g.negativesText} onChange={(e) => setGroup(i, { negativesText: e.target.value })} placeholder="terms you never want to match (broad negatives don't exist on eBay)" />
          </div>
        </div>
      ))}
      <div><button type="button" className="h10-am-btn" onClick={() => set({ adGroups: [...plan.adGroups, { ...emptyGroup(), name: `Group ${plan.adGroups.length + 1}` }] })}>+ Ad group</button>
        <span className="eb-be-hint" style={{ marginLeft: 10 }}>eBay allows up to 500 groups; 1,000 keywords + 1,000 negatives per group.</span></div>
    </div>
  )
}
