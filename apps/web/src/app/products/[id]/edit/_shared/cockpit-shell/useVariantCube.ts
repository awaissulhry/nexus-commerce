'use client'

// UC.6.1 — Variant Cube data service.
//
// One shared source over the three existing endpoints (children +
// channel-pricing + channel-inventory) that MatrixTab already uses,
// normalized into a cube the cockpit's three pivot views (UC.6.2–6.4)
// and MatrixTab (UC.6.6) all read — so the surfaces never diverge.
//
// Fixes channel by argument (the cockpit fixes it by tab); markets stay
// a dimension so the by-market view can pivot across them.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export interface VariantMarketCell {
  marketplace: string
  price: number | null
  salePrice: number | null
  listedQty: number | null
  physicalStock: number
  listingStatus: string
  lastSyncedAt: string | null
}

export interface CubeVariant {
  id: string
  sku: string
  name: string | null
  status: string | null
  basePrice: number | null
  totalStock: number | null
  lowStockThreshold: number | null
  /** Variation axis values, e.g. { Color: 'Red', Size: 'M' }. */
  axes: Record<string, string>
  /** Per-marketplace channel cell (price + inventory merged). */
  marketsByCode: Record<string, VariantMarketCell>
}

interface RawChild {
  id: string
  sku: string
  name?: string | null
  basePrice: number | string | null
  totalStock: number | null
  lowStockThreshold?: number | null
  status?: string | null
  variantAttributes?: Record<string, unknown> | null
  variations?: Record<string, string> | null
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return Number.isFinite(n) ? n : null
}

export function useVariantCube(productId: string, channel = 'AMAZON') {
  const backend = getBackendUrl()
  const [variants, setVariants] = useState<CubeVariant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [childRes, pricingRes, invRes] = await Promise.all([
        fetch(`${backend}/api/products/${productId}/children`, { cache: 'no-store', credentials: 'include' }),
        fetch(`${backend}/api/products/${productId}/channel-pricing?channel=${channel}`, { credentials: 'include' }),
        fetch(`${backend}/api/products/${productId}/channel-inventory?channel=${channel}`, { credentials: 'include' }),
      ])
      if (!childRes.ok) throw new Error(`HTTP ${childRes.status}`)
      const childJson = await childRes.json()
      const children: RawChild[] = childJson.children ?? []

      // Merge pricing + inventory into per-variant, per-market cells.
      const cells = new Map<string, Record<string, VariantMarketCell>>()
      const ensure = (variantId: string, mp: string): VariantMarketCell => {
        const byMarket = cells.get(variantId) ?? {}
        const cell =
          byMarket[mp] ??
          ({
            marketplace: mp,
            price: null,
            salePrice: null,
            listedQty: null,
            physicalStock: 0,
            listingStatus: '',
            lastSyncedAt: null,
          } as VariantMarketCell)
        byMarket[mp] = cell
        cells.set(variantId, byMarket)
        return cell
      }

      if (pricingRes.ok) {
        const pd = await pricingRes.json()
        for (const v of pd.variants ?? []) {
          for (const m of v.markets ?? []) {
            const cell = ensure(v.variantId, m.marketplace)
            cell.price = toNum(m.price)
            cell.salePrice = toNum(m.salePrice)
            if (m.listingStatus) cell.listingStatus = m.listingStatus
            cell.lastSyncedAt = m.lastSyncedAt ?? cell.lastSyncedAt
          }
        }
      }
      if (invRes.ok) {
        const id_ = await invRes.json()
        for (const v of id_.variants ?? []) {
          for (const m of v.markets ?? []) {
            const cell = ensure(v.variantId, m.marketplace)
            cell.listedQty = m.listedQty ?? cell.listedQty
            cell.physicalStock = v.physicalStock ?? cell.physicalStock
            if (m.listingStatus && !cell.listingStatus) cell.listingStatus = m.listingStatus
          }
        }
      }

      const cube: CubeVariant[] = children.map((c) => ({
        id: c.id,
        sku: c.sku,
        name: c.name ?? null,
        status: c.status ?? null,
        basePrice: toNum(c.basePrice),
        totalStock: c.totalStock ?? null,
        lowStockThreshold: c.lowStockThreshold ?? null,
        axes: (c.variations ?? {}) as Record<string, string>,
        marketsByCode: cells.get(c.id) ?? {},
      }))
      setVariants(cube)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [backend, productId, channel])

  useEffect(() => {
    void refetch()
  }, [refetch])

  // Derived dimensions: axis names + the market codes present.
  const axisNames = useMemo(() => {
    const set = new Set<string>()
    for (const v of variants) for (const k of Object.keys(v.axes)) set.add(k)
    return Array.from(set)
  }, [variants])

  const marketCodes = useMemo(() => {
    const set = new Set<string>()
    for (const v of variants) for (const k of Object.keys(v.marketsByCode)) set.add(k)
    return Array.from(set).sort()
  }, [variants])

  return { variants, axisNames, marketCodes, loading, error, refetch }
}
