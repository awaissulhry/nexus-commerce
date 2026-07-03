'use client'

/**
 * ER1 — structured rendering of a rules-based campaign's selection rules
 * (fixes critique D-2: no more raw JSON.stringify). Live matching preview via
 * POST /ebay-ads/criterion-preview (shared with the ER2 builder). Rules are
 * immutable on eBay — the only action is "clone with edited rules".
 */
import { useEffect, useState } from 'react'
import { money } from '../../../../campaigns/_grid/format'
import { postEbayAds } from '../../../_lib'

interface SelectionRule { brands?: string[]; categoryIds?: string[]; categoryScope?: string; listingConditionIds?: string[]; minPrice?: number; maxPrice?: number }
interface Preview { count: number; totalLive: number; sample: Array<{ itemId: string; title: string | null; priceCents: number | null }>; note: string | null }

export function CriterionCard({ criterion, marketplace, onClone }: { criterion: Record<string, unknown> | null; marketplace: string; onClone: () => void }) {
  const rules = ((criterion?.selectionRules ?? []) as SelectionRule[])
  const autoSelect = criterion?.autoSelectFutureInventory === true || criterion?.autoSelectFutureInventory === 'true'
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    postEbayAds<Preview>('/criterion-preview', { marketplace, rules: rules.map((r) => ({ brands: r.brands, categoryIds: r.categoryIds, minPrice: r.minPrice != null ? Number(r.minPrice) : undefined, maxPrice: r.maxPrice != null ? Number(r.maxPrice) : undefined, listingConditionIds: r.listingConditionIds })) })
      .then((p) => { if (alive) setPreview(p) })
      .catch((e) => { if (alive) setPreviewErr((e as Error).message) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace, JSON.stringify(rules)])

  return (
    <div className="h10-cd-card pad">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className={`h10-pill ${autoSelect ? 'ok' : 'arch'}`} title="eBay re-evaluates matching listings daily: matches are added, non-matches removed — including newly created listings.">
          auto-select future listings: {autoSelect ? 'ON' : 'OFF'}
        </span>
        {preview && <span className="h10-pill arch">{preview.count} of {preview.totalLive} live listings match now</span>}
      </div>
      {rules.length === 0 ? (
        <p className="eb-be-hint">No selection rules recorded on the sync — eBay applies the campaign&apos;s original rules server-side.</p>
      ) : (
        <table className="eb-difftable">
          <thead><tr><th>#</th><th>Brands</th><th>Categories</th><th>Condition</th><th>Price range</th></tr></thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{r.brands?.length ? r.brands.join(', ') : 'any'}</td>
                <td>{r.categoryIds?.length ? `${r.categoryIds.join(', ')}${r.categoryScope ? ` (${r.categoryScope})` : ''}` : 'any'}</td>
                <td>{r.listingConditionIds?.length ? r.listingConditionIds.join(', ') : 'any'}</td>
                <td>{r.minPrice != null || r.maxPrice != null ? `${r.minPrice != null ? money(Math.round(Number(r.minPrice) * 100)) : '…'} – ${r.maxPrice != null ? money(Math.round(Number(r.maxPrice) * 100)) : '…'}` : 'any'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {preview?.sample.length ? (
        <ul className="eb-results" style={{ marginTop: 10 }}>
          {preview.sample.map((s) => <li key={s.itemId} className="ok">{s.title ?? s.itemId} {s.priceCents != null ? `· ${money(s.priceCents)}` : ''}</li>)}
        </ul>
      ) : null}
      {preview?.note && <p className="eb-be-hint" style={{ marginTop: 8 }}>{preview.note}</p>}
      {previewErr && <p className="eb-be-hint" style={{ marginTop: 8 }}>Preview unavailable: {previewErr}</p>}
      <p className="eb-be-hint" style={{ marginTop: 12 }}>
        Selection rules are <b>immutable on eBay</b> — to change them, <button type="button" className="h10-am-link" onClick={onClone}>clone this campaign with edited rules</button>.
      </p>
    </div>
  )
}
