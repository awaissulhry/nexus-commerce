'use client'

/**
 * Trading Desk — Campaigns ▸ By-product lens (P2.2).
 *
 * Row = a product (photo + name + sku) with its rolled-up ad spend / revenue /
 * TACOS / true profit / units / #campaigns, from /api/advertising/by-product
 * (per-product attribution — PC-series). Expand a row to see the campaigns
 * advertising that product, via /api/advertising/by-product/campaigns.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Package, ChevronRight, ChevronDown } from 'lucide-react'
import { marketplaceCode } from '@/lib/marketplace-code'
import { getBackendUrl } from '@/lib/backend-url'

interface ProductRow {
  id: string; sku?: string | null; name: string; asin?: string | null; photoUrl?: string | null
  adSpendCents: number; revenueCents: number; profitCents: number; units: number
  tacos: number | null; marginPct: number | null; campaignCount: number; isParent?: boolean
}
interface SubCampaign {
  id: string; name: string; marketplace: string | null; status: string
  adSpendCents: number; adSalesCents: number; acos: number | null
}

const eur = (c: number | null | undefined) => (c == null ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100))
const pctN = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
const acosClsPct = (v: number | null | undefined) => (v == null ? '' : v <= 20 ? 'acos-good' : v <= 35 ? 'acos-mid' : 'acos-bad')
const profitColor = (c: number) => (c < 0 ? 'var(--red)' : c === 0 ? 'var(--ink3)' : '#6d28d9')

export function ByProductTable({ search, market }: { search: string; market: string }) {
  const [rows, setRows] = useState<ProductRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, SubCampaign[] | 'loading'>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const b = getBackendUrl()
      const url = `${b}/api/advertising/by-product?windowDays=30${market ? `&marketplace=${encodeURIComponent(market)}` : ''}`
      const data = await fetch(url, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ rows: [] }))
      setRows((data.rows ?? []) as ProductRow[])
    } finally { setLoading(false) }
  }, [market])
  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter((r) => r.name.toLowerCase().includes(q) || (r.sku ?? '').toLowerCase().includes(q) || (r.asin ?? '').toLowerCase().includes(q))
  }, [rows, search])

  const toggle = async (id: string) => {
    if (expanded[id]) { setExpanded((e) => { const next = { ...e }; delete next[id]; return next }); return }
    setExpanded((e) => ({ ...e, [id]: 'loading' }))
    const b = getBackendUrl()
    const data = await fetch(`${b}/api/advertising/by-product/campaigns?productId=${encodeURIComponent(id)}&windowDays=30`, { cache: 'no-store' })
      .then((r) => r.json()).catch(() => ({ rows: [] }))
    setExpanded((e) => ({ ...e, [id]: (data.rows ?? []) as SubCampaign[] }))
  }

  return (
    <div className="card">
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="l">Product</th>
              <th>Ad spend</th><th>Revenue</th><th>TACOS</th><th>True profit</th><th>Margin</th><th>Units</th><th>Campaigns</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="empty">Loading products…</td></tr>}
            {!loading && filtered.length === 0 && <tr><td colSpan={8} className="empty">No advertised products match.</td></tr>}
            {!loading && filtered.map((r) => {
              const sub = expanded[r.id]
              const open = sub != null
              const hasCampaigns = r.campaignCount > 0
              return (
                <FragmentRow
                  key={r.id}
                  r={r}
                  open={open}
                  sub={sub}
                  hasCampaigns={hasCampaigns}
                  onToggle={() => void toggle(r.id)}
                />
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="legend" style={{ padding: '12px 14px' }}>
        <span><b>By product</b> — row is the product; expand to see its campaigns. Per-product attribution (TACOS = ad spend ÷ total revenue).</span>
      </div>
    </div>
  )
}

function FragmentRow({
  r, open, sub, hasCampaigns, onToggle,
}: {
  r: ProductRow; open: boolean; sub: SubCampaign[] | 'loading' | undefined; hasCampaigns: boolean; onToggle: () => void
}) {
  const thumb = r.photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={r.photoUrl} alt="" />
  ) : (
    <Package size={20} />
  )
  return (
    <>
      <tr>
        <td className="l">
          <div className="pname">
            {hasCampaigns
              ? <span className="expander" onClick={onToggle} role="button" aria-label={open ? 'Collapse' : 'Expand'}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
              : <span className="expander" />}
            <span className="thumb">{thumb}</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 650, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{r.name}</span>
              <span className="sub">{r.sku ?? r.asin ?? ''}{r.isParent ? ' · parent' : ''}</span>
            </span>
          </div>
        </td>
        <td className="num">{eur(r.adSpendCents)}</td>
        <td className="num">{eur(r.revenueCents)}</td>
        <td><span className={acosClsPct(r.tacos)}>{pctN(r.tacos)}</span></td>
        <td className="num" style={{ color: profitColor(r.profitCents), fontWeight: 700 }}>{eur(r.profitCents)}</td>
        <td className="num">{pctN(r.marginPct)}</td>
        <td className="num">{r.units}</td>
        <td>{hasCampaigns ? <span className="pill b">{r.campaignCount}</span> : <span className="pill n">0</span>}</td>
      </tr>
      {open && (
        <tr className="subrow">
          <td colSpan={8}>
            <div className="subwrap">
              {sub === 'loading' ? (
                <span className="sub">Loading campaigns…</span>
              ) : sub && sub.length > 0 ? (
                <>
                  <div className="subhead"><span>Campaign</span><span>Spend</span><span>Ad sales</span><span>ACOS</span></div>
                  {sub.map((c) => (
                    <div className="subitem" key={c.id}>
                      <span className="subname">
                        <span className="cc az"><span className="dot" style={{ background: 'var(--az)' }} />{marketplaceCode(c.marketplace)}</span>
                        <span className="nm">{c.name}</span>
                        {c.status !== 'ENABLED' && <span className="pill n">{c.status === 'PAUSED' ? 'Paused' : c.status}</span>}
                      </span>
                      <span className="subnum">{eur(c.adSpendCents)}</span>
                      <span className="subnum">{eur(c.adSalesCents)}</span>
                      <span className="subacos"><span className={acosClsPct(c.acos)}>{pctN(c.acos)}</span></span>
                    </div>
                  ))}
                </>
              ) : (
                <span className="sub">No campaign-attributed spend in this window.</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
