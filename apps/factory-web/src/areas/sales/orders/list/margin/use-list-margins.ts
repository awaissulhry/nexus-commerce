'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { getMargins } from '../../../../finance/margins/api'
import { EVERY_STATUS, marginsCanOf, showsMargin } from '../../../../finance/margins/model'

/** Pages of margins read at most per list read (the API has no `ids` filter: see coverMargins). */
const MAX_PAGES = 20
const PAGE = 100

/**
 * B-W2a-72 — the orders list's Margin % column (design sales.orders orders.grid "Margin % (margin, W2a)"): the margin %
 * as estimated now for each order on screen, from `GET /costing/margins` (costing.view; the margin grain). Both lists are
 * the newest order first (by id), so the margins are read from the top, with the list's search, every status, in pages
 * of 100 until every order on screen is covered (an order the margins do not hold — outside the person's costing scope —
 * shows "—"). Read again with every full read of the list (its time), and for the rows "Show more" adds. Null: the
 * column is not drawn (no costing.view or no margin grain).
 */
export function useListMargins(api: ApiClient, items: readonly { id: string }[] | null, q: string, permissions: readonly string[], readAt: string | null): ReadonlyMap<string, string | null> | null {
  const can = useMemo(() => marginsCanOf(permissions), [permissions])
  const enabled = showsMargin(can)
  const [known, setKnown] = useState<ReadonlyMap<string, string | null>>(new Map())
  const cache = useRef<{ key: string; map: Map<string, string | null>; cursor: string | null; done: boolean }>({ key: '', map: new Map(), cursor: null, done: false })
  const seq = useRef(0)

  useEffect(() => {
    if (!enabled || !items) return
    const key = `${readAt ?? ''}|${q}`
    if (cache.current.key !== key) {
      cache.current = { key, map: new Map(), cursor: null, done: false }
      setKnown(new Map())
    }
    const state = cache.current
    const missing = items.map((row) => row.id).filter((id) => !state.map.has(id))
    if (missing.length === 0) return
    const mine = ++seq.current
    void coverMargins(api, state, missing, q).then(() => {
      if (mine === seq.current && cache.current === state) setKnown(new Map(state.map))
    })
  }, [api, enabled, items, q, readAt])

  return enabled ? known : null
}

/** Reads margin pages from where the last read stopped until every missing id is covered; the ones not met are "—". */
async function coverMargins(api: ApiClient, state: { map: Map<string, string | null>; cursor: string | null; done: boolean }, missing: readonly string[], q: string): Promise<void> {
  const lowest = [...missing].sort()[0]!
  try {
    for (let page = 0; page < MAX_PAGES && !state.done; page += 1) {
      const answer = await getMargins(api, { status: EVERY_STATUS, q: q.trim() || null, cursor: state.cursor, limit: PAGE })
      for (const row of answer.rows) state.map.set(row.order.id, row.estimateMarginPct ?? null)
      state.cursor = answer.nextCursor
      state.done = answer.nextCursor === null
      const last = answer.rows.at(-1)?.order.id ?? null
      if (last !== null && last <= lowest) break
    }
  } catch {
    // A failed read leaves those cells at "—" (the list itself is unchanged); the next full read tries again.
  }
  const reached = state.done ? null : state.cursor
  for (const id of missing) if (!state.map.has(id) && (reached === null || id > reached)) state.map.set(id, null)
}
