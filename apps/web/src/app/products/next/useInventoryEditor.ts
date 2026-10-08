'use client'

/**
 * The inventory editor's data: ONE model (variations × locations, or a single product as a
 * one-row family) and ONE write — the batch. The server derives every delta from a fresh read
 * and refuses FBA / Shopify / invalid values per change; the result comes back per change so the
 * grid can keep a refused cell pending and clear the confirmed ones. Step 3: the read carries each
 * product's case sizes and each level's sealed cases per size; a change may carry absolute `cases`
 * for the sizes typed there.
 *
 * Live: a stock or case change of one of these products made elsewhere (a sale, another tab, the
 * Matrix Case pop-up) re-reads the model quietly — the grid stays, and the pending edits stay over
 * the new server numbers.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaseCount } from '@nexus/shared/stock-cases'

import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, useInvalidationChannel, type InvalidationEvent } from '@/lib/sync/invalidation-channel'
import type { ProductRow } from '@/app/products/_types'

import { buildMatrixModel, buildSingleModel, editorModeForRow, type CellChange, type MatrixModel, type RawLocation } from './inventoryEditor.logic'

/** What the editor needs from the row that opened it: a Products page row, or a Matrix row (Stock cell). */
export type InventoryEditorTarget = Pick<ProductRow, 'id' | 'sku' | 'name' | 'isParent'> & Partial<Pick<ProductRow, 'imageUrl' | 'lowStockThreshold'>>

interface State {
  loading: boolean
  error: string | null
  model: MatrixModel | null
}
const EMPTY: State = { loading: false, error: null, model: null }

/** One cell: an absolute on-hand (`value`), an absolute sealed count (`cases`), or both — saved in one transaction. */
export type BatchChange = CellChange
export interface BatchResult {
  productId: string
  locationId: string
  ok: boolean
  noop?: boolean
  /** The sealed counts after the change, when it named `cases`. */
  cases?: CaseCount[]
  error?: string
  code?: string
}

/** This editor's own `stock.adjusted` (its Apply re-reads by itself). */
const SOURCE = 'products-next-inventory-editor'
/** A burst of stock events (a 20-cell Apply elsewhere) re-reads once. */
const LIVE_DEBOUNCE_MS = 400

/** Does this invalidation concern the products the editor shows? A stock event with no product says nothing. */
export function concernsEditor(event: InvalidationEvent, productIds: ReadonlySet<string>): boolean {
  if (event.meta?.source === SOURCE) return false
  if (event.type === 'inventory.stock_changed' && event.meta?.subtype === 'fba-plan') return false
  const id = event.id ?? (typeof event.meta?.productId === 'string' ? event.meta.productId : undefined)
  return !!id && productIds.has(id)
}

export function useInventoryEditor(row: InventoryEditorTarget | null) {
  const [state, setState] = useState<State>(EMPTY)
  const reqId = useRef(0)
  const productId = row?.id ?? null
  const mode = row ? editorModeForRow(row) : 'list'

  /** `quiet`: a live re-read keeps the grid on screen (no "Loading…"), and an error keeps the last model. */
  const load = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!productId || !row) { setState(EMPTY); return }
    const my = ++reqId.current
    if (!opts.quiet) setState((s) => ({ ...s, loading: true, error: null }))
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
          { id: row.id, sku: row.sku, name: row.name, thumbnailUrl: row.imageUrl ?? null, lowStockThreshold: row.lowStockThreshold, caseSizes: pData.product?.caseSizes ?? [] },
          pData.stockLevels,
          active,
        )
        if (my === reqId.current) setState({ loading: false, error: null, model })
      }
    } catch (e: unknown) {
      if (my !== reqId.current) return
      if (opts.quiet) setState((s) => ({ ...s, loading: false }))
      else setState({ loading: false, error: e instanceof Error ? e.message : 'Failed to load', model: null })
    }
    // `row` is read for its identity fields only; the id is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, mode])

  useEffect(() => { void load() }, [load])

  // Live: re-read quietly when one of these products' stock or cases changed elsewhere (debounced).
  const shown = useRef<ReadonlySet<string>>(new Set())
  shown.current = new Set([...(productId ? [productId] : []), ...(state.model?.rows.map((r) => r.productId) ?? [])])
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (liveTimer.current) clearTimeout(liveTimer.current) }, [])
  useInvalidationChannel(['inventory.stock_changed', 'stock.adjusted'], (event) => {
    if (!productId || !concernsEditor(event, shown.current)) return
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => { liveTimer.current = null; void load({ quiet: true }) }, LIVE_DEBOUNCE_MS)
  })

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
          emitInvalidation({ type: 'stock.adjusted', meta: { productId: productId ?? undefined, source: SOURCE } })
        }
        await load()
        return { ok: true, results }
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : 'Apply failed' }
      }
    },
    [load, productId],
  )

  return { ...state, reload: () => load(), applyBatch }
}
