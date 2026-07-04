'use client'

/**
 * EV3 — step ④ Keywords & Bids (Priority manual) on the section pattern:
 * per-ad-group keyword baskets (tabs = Mined seeds from our titles+aspects
 * miner / Enter keywords), negatives per group, multi-group via "+ Ad group".
 * eBay's suggest_bids API is campaign-scoped — it CANNOT answer pre-launch
 * (verified in ER1), so bids here anchor on our mined defaults and the
 * campaign's Keywords tab serves eBay's suggestions after launch
 * (AU/DE/GB/US only — stated honestly for the rest).
 */
import { useState } from 'react'
import { InfoTip } from '../../../../../campaigns/InfoTip'
import { H10Select } from '../../../../../campaigns/FilterDropdown'
import { postEbayAds } from '../../../../_lib'
import { emptyGroup, SUGGEST_MARKETS, type CampaignPlan, type PlanAdGroup, type Seed } from '../plan'

export function KeywordsStep({ plan, set }: { plan: CampaignPlan; set: (patch: Partial<CampaignPlan>) => void }) {
  const suggestAvailable = SUGGEST_MARKETS.has(plan.marketplace)
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
    <section className="h10-spw-sec" style={{ maxWidth: 980 }}>
      <h2>Ad groups, keywords &amp; bids</h2>
      <p>
        Keywords live under ad groups; each group carries a default bid and its own negatives.{' '}
        {suggestAvailable
          ? "eBay's per-keyword suggested bids unlock on the campaign's Keywords tab after launch (the suggest-bids API needs an existing campaign)."
          : `eBay has no keyword bid-suggestion API for ${plan.marketplace.replace('EBAY_', 'eBay ')} (AU/DE/GB/US only) — the mined defaults below come from your own data.`}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {plan.adGroups.map((g, i) => (
        <div key={i} className="h10-cd-card pad">
          <div className="eb-form-row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
            <div className="h10-cd-field s"><label>Ad group name <InfoTip tip="Structure for reporting and bid control — group keywords with a shared theme (e.g. one product family per group). Up to 500 groups per campaign." /></label>
              <input type="text" value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} /></div>
            <div className="h10-cd-field s" style={{ maxWidth: 140 }}><label>Default bid € <InfoTip tip="Applies to keywords without their own bid. Every bid stays editable per keyword, here and after launch." /></label>
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
                        <span className="eb-dd dense"><H10Select ariaLabel={`Match type for ${s.text}`} width={110} value={s.matchType}
                          onChange={(v) => setGroup(i, { seeds: g.seeds.map((x, j) => (j === k ? { ...x, matchType: v as Seed['matchType'] } : x)) })}
                          options={[{ value: 'PHRASE', label: 'Phrase' }, { value: 'EXACT', label: 'Exact' }, { value: 'BROAD', label: 'Broad' }]} /></span>
                      </td>
                      <td className="num"><input className="h10-cd-input" style={{ width: 70 }} type="number" min={0.05} step={0.05} value={s.bidEur} onChange={(e) => setGroup(i, { seeds: g.seeds.map((x, j) => (j === k ? { ...x, bidEur: e.target.value } : x)) })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="h10-cd-field" style={{ marginTop: 12, maxWidth: 520 }}>
            <label className="eb-neg-lbl">Negative keywords — one per line ·
              <span className="eb-dd dense"><H10Select ariaLabel="Negative match type" width={110} value={g.negMatch}
                onChange={(v) => setGroup(i, { negMatch: v as 'EXACT' | 'PHRASE' })}
                options={[{ value: 'EXACT', label: 'EXACT' }, { value: 'PHRASE', label: 'PHRASE' }]} /></span>
            </label>
            <textarea className="eb-textarea" rows={2} value={g.negativesText} onChange={(e) => setGroup(i, { negativesText: e.target.value })} placeholder="terms you never want to match (broad negatives don't exist on eBay)" />
          </div>
        </div>
      ))}
      <div><button type="button" className="h10-am-btn" onClick={() => set({ adGroups: [...plan.adGroups, { ...emptyGroup(), name: `Group ${plan.adGroups.length + 1}` }] })}>+ Ad group</button>
        <span className="eb-be-hint" style={{ marginLeft: 10 }}>eBay allows up to 500 groups; 1,000 keywords + 1,000 negatives per group.</span></div>
      </div>
    </section>
  )
}
