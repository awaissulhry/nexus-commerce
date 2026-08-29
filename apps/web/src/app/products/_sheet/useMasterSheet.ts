'use client'

/**
 * MS.3 — the master sheet's data: read one market's page, save ONE CELL at a time.
 *
 * The Owner's decision (docs/2026-08-29-master-sheet-design.md §8.1): **autosave per cell**. There is
 * no page-level Save and no dirty-sheet state; each edit goes to the server on its own and that
 * cell shows what the server said. A refusal is a RESULT, never a toast — it stays on the cell.
 *
 * Writes reuse what already exists rather than adding endpoints:
 *   `column` + `categoryAttributes` → PATCH /api/products/bulk   (the cell path: rate-limited for
 *      typing at 300/min, per-cell structured errors `{id, field, error}`, 409 on a version conflict)
 *   `localizedContent`             → PATCH /api/products/:id/global  (per-locale merge; the bulk
 *      endpoint writes Product columns and `attr_*`, and has no route into a locale slot)
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { getBackendUrl } from '@/lib/backend-url'

import type { SheetColumn, SheetPage, SheetRow } from './types'

export interface SaveOutcome {
  ok: boolean
  reason?: string
  /** The row's version after the write, when the server reports one. */
  version?: number
}

export interface UseMasterSheetOptions {
  market: string
  page?: number
  limit?: number
  search?: string
}

export interface MasterSheetState {
  data: SheetPage | null
  loading: boolean
  error: string | null
  reload: () => void
  /** Patch a row in place after a successful save, without refetching the page. */
  applyLocal: (rowId: string, mutate: (row: SheetRow) => void) => void
}

export function useMasterSheet({ market, page = 1, limit = 25, search }: UseMasterSheetOptions): MasterSheetState {
  const [data, setData] = useState<SheetPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // A slow market must not paint over a faster one that the operator switched to since.
  const requestRef = useRef(0)

  useEffect(() => {
    const mine = ++requestRef.current
    let cancelled = false
    setLoading(true)
    setError(null)

    const params = new URLSearchParams({ market, page: String(page), limit: String(limit) })
    if (search) params.set('search', search)

    fetch(`${getBackendUrl()}/api/products/sheet?${params}`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
        return body as SheetPage
      })
      .then((body) => {
        if (cancelled || mine !== requestRef.current) return
        setData(body)
      })
      .catch((err: unknown) => {
        if (cancelled || mine !== requestRef.current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled && mine === requestRef.current) setLoading(false)
      })

    return () => { cancelled = true }
  }, [market, page, limit, search, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const applyLocal = useCallback((rowId: string, mutate: (row: SheetRow) => void) => {
    setData((prev) => {
      if (!prev) return prev
      const rows = prev.rows.map((r) => {
        if (r.id !== rowId) return r
        const next = { ...r, values: { ...r.values } }
        mutate(next)
        return next
      })
      return { ...prev, rows }
    })
  }, [])

  return { data, loading, error, reload, applyLocal }
}

/**
 * Save one cell. Returns the server's answer — a refusal is an outcome, never an exception, so the
 * grid can paint `.nds-cell-is-refused` with the reason on hover.
 */
export async function saveSheetCell(input: {
  row: SheetRow
  column: SheetColumn
  value: unknown
  locale: string
}): Promise<SaveOutcome> {
  const { row, column, value, locale } = input
  const backend = getBackendUrl()

  try {
    if (column.storage === 'localizedContent') {
      const res = await fetch(`${backend}/api/products/${row.id}/global`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: { [locale]: { [column.key]: value === '' ? null : value } } }),
      })
      const body = await res.json().catch(() => null)
      if (res.ok) return { ok: true }
      // This route answers with prose in `details[]`, not a field-keyed error.
      const detail = Array.isArray(body?.details) ? body.details[0] : undefined
      return { ok: false, reason: detail || body?.error || `Refused (HTTP ${res.status})` }
    }

    const res = await fetch(`${backend}/api/products/bulk`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changes: [{ id: row.id, field: column.writeField, value: value === '' ? null : value }],
        // Two operators on one row must not silently overwrite each other.
        expectedVersion: row.version,
      }),
    })
    const body = await res.json().catch(() => null)

    if (res.status === 409) {
      return { ok: false, reason: `Someone else changed this row (v${body?.currentVersion ?? '?'}). Reload to see it.` }
    }
    if (!res.ok) {
      const first = Array.isArray(body?.errors) ? body.errors[0] : undefined
      return { ok: false, reason: first?.error || body?.error || `Refused (HTTP ${res.status})` }
    }
    // A 200 can still carry per-cell refusals alongside partial success.
    const mine = Array.isArray(body?.errors) ? body.errors.find((e: { id?: string }) => e.id === row.id) : undefined
    if (mine) return { ok: false, reason: mine.error || 'Refused' }
    if (body?.updated === 0) return { ok: false, reason: 'The server accepted the request but changed nothing' }

    return { ok: true, version: typeof body?.currentVersion === 'number' ? body.currentVersion : undefined }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
