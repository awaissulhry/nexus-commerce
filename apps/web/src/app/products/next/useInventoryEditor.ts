'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import {
  buildListModel, buildMatrixModel,
  type LevelCell, type MatrixModel, type RawLocation,
} from './inventoryEditor.logic'

type Mode = 'list' | 'matrix'

interface State {
  loading: boolean
  error: string | null
  list: LevelCell[] | null
  matrix: MatrixModel | null
}

const EMPTY: State = { loading: false, error: null, list: null, matrix: null }

export function useInventoryEditor(productId: string | null, mode: Mode) {
  const [state, setState] = useState<State>(EMPTY)
  const reqId = useRef(0)

  const load = useCallback(async () => {
    if (!productId) {
      setState(EMPTY)
      return
    }
    const my = ++reqId.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const base = getBackendUrl()
      if (mode === 'matrix') {
        const res = await fetch(`${base}/api/stock/product/${productId}?family=true`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`Failed to load (${res.status})`)
        const data = await res.json()
        if (!data.family) throw new Error('No variation data for this product.')
        const matrix = buildMatrixModel(data.family.locations as RawLocation[], data.family.children)
        if (my === reqId.current) setState({ loading: false, error: null, list: null, matrix })
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
        const list = buildListModel(pData.stockLevels, active)
        if (my === reqId.current) setState({ loading: false, error: null, list, matrix: null })
      }
    } catch (e: any) {
      if (my === reqId.current) setState({ loading: false, error: e?.message ?? 'Failed to load', list: null, matrix: null })
    }
  }, [productId, mode])

  useEffect(() => { void load() }, [load])

  const commit = useCallback(
    async (args: { productId: string; locationId: string; value: number; reason: string; notes?: string }) => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/stock/adjust-location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) return { ok: false as const, error: data?.error ?? `Save failed (${res.status})` }
        emitInvalidation({ type: 'stock.adjusted', meta: { productId: args.productId, source: 'products-next-location-edit' } })
        await load()
        return { ok: true as const }
      } catch (e: any) {
        return { ok: false as const, error: e?.message ?? 'Save failed' }
      }
    },
    [load],
  )

  return { ...state, reload: load, commit }
}
