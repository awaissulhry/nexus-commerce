'use client'

/**
 * The inventory editor's data: ONE model (variations × locations, or a single product as a
 * one-row family) and ONE write — the batch. The server derives every delta from a fresh read
 * and refuses FBA / Shopify / invalid values per change; the result comes back per change so the
 * grid can keep a refused cell pending and clear the confirmed ones.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import type { ProductRow } from '@/app/products/_types'

import { buildMatrixModel, buildSingleModel, editorModeForRow, type MatrixModel, type RawLocation } from './inventoryEditor.logic'

interface State {
  loading: boolean
  error: string | null
  model: MatrixModel | null
}
const EMPTY: State = { loading: false, error: null, model: null }

export interface BatchChange { productId: string; locationId: string; value: number }
export interface BatchResult {
  productId: string
  locationId: string
  ok: boolean
  noop?: boolean
  error?: string
  code?: string
}

export function useInventoryEditor(row: ProductRow | null) {
  const [state, setState] = useState<State>(EMPTY)
  const reqId = useRef(0)
  const productId = row?.id ?? null
  const mode = row ? editorModeForRow(row) : 'list'

  const load = useCallback(async () => {
    if (!productId || !row) { setState(EMPTY); return }
    const my = ++reqId.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const base = getBackendUrl()
      if (mode === 'matrix') {
        const res = await fetch(`${base}/api/stock/product/${productId}?family=true`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`Failed to load (${res.status})`)
        const data = await res.json()
        if (!data.family) throw new Error('No variation data for this product.')
        const model = buildMatrixModel(data.family.locations as RawLocation[], data.family.children)
        if (my === reqId.current) setState({ loading: false, error: null, model })
      } else {
        const [pRes, lRes] = await Promise.all([
          fetch(`${base}/api/stock/product/${productId}`, { cache: 'no-store' }),
          fetch(`${base}/api/stock/locations`, { cache: 'no-store' }),
        ])
        if (!pRes.ok) throw new Error(`Failed to load product (${pRes.status})`)
        if (!lRes.ok) throw new Error(`Failed to load locations (${lRes.status})`)
        const pData = await pRes.json()
        const lData = await lRes.json()
        const active = (lData.locations as Array<RawLocation & { isActive: boolean }>).filter((l) => l.isActive)
        const model = buildSingleModel(
          { id: row.id, sku: row.sku, name: row.name, thumbnailUrl: row.imageUrl ?? null, lowStockThreshold: row.lowStockThreshold },
          pData.stockLevels,
          active,
        )
        if (my === reqId.current) setState({ loading: false, error: null, model })
      }
    } catch (e: unknown) {
      if (my === reqId.current) setState({ loading: false, error: e instanceof Error ? e.message : 'Failed to load', model: null })
    }
    // `row` is read for its identity fields only; the id is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, mode])

  useEffect(() => { void load() }, [load])

  /** Apply every pending change as one audited batch. Resolves per change; never throws. */
  const applyBatch = useCallback(
    async (args: { reason: string; notes?: string; changes: BatchChange[] }): Promise<{ ok: true; results: BatchResult[] } | { ok: false; error: string }> => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/stock/adjust-locations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) return { ok: false, error: data?.error ?? `Apply failed (${res.status})` }
        const results = (data.results ?? []) as BatchResult[]
        if (results.some((r) => r.ok && !r.noop)) {
          emitInvalidation({ type: 'stock.adjusted', meta: { productId: productId ?? undefined, source: 'products-next-inventory-editor' } })
        }
        await load()
        return { ok: true, results }
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : 'Apply failed' }
      }
    },
    [load, productId],
  )

  return { ...state, reload: load, applyBatch }
}
