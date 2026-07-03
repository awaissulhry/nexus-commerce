'use client'

/**
 * ER2 — step ③ Listings: two-panel product-first picker (§PL-7
 * ProductSelection anatomy): left = live listings with break-even/conflict/
 * stock context + search, right = staged selection. Conflict resolution
 * (skip / move / include) is a per-listing select ON the staged side. PRI
 * wizards flag out-of-stock listings excluded (eBay rejects OOS on Priority
 * at creation — teardown §6 #8).
 */
import { useMemo, useState } from 'react'
import { money, pct } from '../../../../../campaigns/_grid/format'
import type { CampaignPlan, PlanListing } from '../plan'

export function ListingsStep({ plan, set, listings, isPriority }: {
  plan: CampaignPlan
  set: (patch: Partial<CampaignPlan>) => void
  listings: PlanListing[]
  isPriority: boolean
}) {
  const [q, setQ] = useState('')
  const selectedSet = useMemo(() => new Set(plan.selected), [plan.selected])
  const available = useMemo(
    () => listings.filter((l) => !selectedSet.has(l.itemId) && (!q.trim() || (l.title ?? l.itemId).toLowerCase().includes(q.trim().toLowerCase()))),
    [listings, selectedSet, q],
  )
  const staged = useMemo(() => listings.filter((l) => selectedSet.has(l.itemId)), [listings, selectedSet])
  const oos = (l: PlanListing) => isPriority && (l.quantity ?? 0) <= 0

  const add = (ids: string[]) => set({ selected: [...new Set([...plan.selected, ...ids.filter((id) => !oosById.get(id))])] })
  const remove = (id: string) => set({ selected: plan.selected.filter((x) => x !== id) })
  const oosById = useMemo(() => new Map(listings.map((l) => [l.itemId, oos(l)])), [listings, isPriority]) // eslint-disable-line react-hooks/exhaustive-deps

  const trailingStaged = staged.reduce((a, l) => a + l.trailingSales30dCents, 0)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignItems: 'start' }}>
      {/* left — available */}
      <div className="h10-am-card" style={{ padding: '6px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px 6px' }}>
          <b style={{ fontSize: 13 }}>Live listings ({available.length})</b>
          <span className="grow" style={{ flex: 1 }} />
          <input className="h10-cd-input" style={{ width: 180 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="h10-am-btn sm" onClick={() => add(available.map((l) => l.itemId))}>Add all</button>
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {available.length === 0 ? (
            <div style={{ padding: '20px 14px', fontSize: 12.5, color: '#8a93a1' }}>{q ? 'No matches.' : 'Everything is staged.'}</div>
          ) : available.map((l) => (
            <div key={l.itemId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: '1px solid #eef1f5', fontSize: 12.5, opacity: oos(l) ? 0.55 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: '#1c2530' }}>{l.title ?? l.itemId}</div>
                <div style={{ color: '#8a93a1', fontSize: 11.5 }}>
                  {money(l.priceCents)} · qty {l.quantity ?? '—'} · BE {l.breakEvenPct != null ? pct(l.breakEvenPct / 100) : 'add cost'} · 30d {money(l.trailingSales30dCents)}
                </div>
              </div>
              {l.conflict && <span className="h10-pill warn" title={`Already promoted in "${l.conflict.campaignName}" — resolve after staging`}>in campaign</span>}
              {oos(l)
                ? <span className="h10-pill warn" title="eBay rejects out-of-stock listings on Priority campaigns at creation">out of stock</span>
                : <button type="button" className="h10-am-btn sm" onClick={() => add([l.itemId])}>Add</button>}
            </div>
          ))}
        </div>
      </div>

      {/* right — staged + conflict resolution */}
      <div className="h10-am-card" style={{ padding: '6px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px 6px' }}>
          <b style={{ fontSize: 13 }}>Staged ({staged.length})</b>
          <span style={{ fontSize: 11.5, color: '#8a93a1' }}>trailing-30d sales {money(trailingStaged)}</span>
          <span className="grow" style={{ flex: 1 }} />
          {staged.length > 0 && <button type="button" className="h10-am-btn sm" onClick={() => set({ selected: [] })}>Clear</button>}
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {staged.length === 0 ? (
            <div className="h10-cd-empty" style={{ margin: 14 }}><h3>Nothing staged</h3><p>Add listings from the left — or Add all for a catch-all.</p></div>
          ) : staged.map((l) => (
            <div key={l.itemId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: '1px solid #eef1f5', fontSize: 12.5 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: '#1c2530' }}>{l.title ?? l.itemId}</div>
                <div style={{ color: '#8a93a1', fontSize: 11.5 }}>{money(l.priceCents)} · BE {l.breakEvenPct != null ? pct(l.breakEvenPct / 100) : 'add cost'}</div>
              </div>
              {l.conflict && (
                <select className="h10-cd-input" value={plan.resolutions[l.itemId] ?? 'skip'} title={`Already in "${l.conflict.campaignName}" at ${l.conflict.currentRatePct ?? '?'}% — one listing = one General campaign`}
                  onChange={(e) => set({ resolutions: { ...plan.resolutions, [l.itemId]: e.target.value as 'include' | 'skip' | 'move' } })}>
                  <option value="skip">skip</option>
                  <option value="move">move here</option>
                  <option value="include">include (will fail)</option>
                </select>
              )}
              <button type="button" className="h10-am-btn sm" onClick={() => remove(l.itemId)}>Remove</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
