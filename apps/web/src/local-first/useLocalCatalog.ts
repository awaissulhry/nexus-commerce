'use client'

/**
 * LF.1 — `useLocalCatalog`, the abstraction hook.
 *
 * ── This hook IS guardrail 1 ────────────────────────────────────────────────────────────────
 *
 * "Never scatter raw sync-engine query syntax directly inside your UI components. Wrap all
 * catalog data fetching in abstraction hooks. When you switch from an in-browser SQLite query to
 * a Typesense search query, you only update the hook implementation — the AG Grid and UI
 * components will not know the difference."
 *
 * So the contract below is deliberately engine-agnostic: `rows`, `status`, `error`, `refresh`,
 * `stats`. Nothing PGlite-shaped escapes. The CQRS migration replaces the body of this file and
 * touches no consumer. It is the same seam `productsServerContract.ts` provides for SSRM — that
 * file is the only translator between the grid and the API, and this is its local twin.
 *
 * ── Status is a state machine, not a boolean ────────────────────────────────────────────────
 *
 * `idle → opening → seeding → ready`, plus `error`. A single `loading` flag cannot distinguish
 * "instantiating a WASM database" (slow, once) from "seeding over the network" (slow, once) from
 * "querying locally" (sub-millisecond, always) — and the entire point of the spike is to measure
 * exactly that difference. A boolean would hide the finding.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import {
  getLocalDb,
  localRowCount,
  readLocalCatalog,
  seedFromApi,
  clearLocalCatalog,
} from './client'
import type { LocalProductRow } from './projection'

export type LocalCatalogStatus = 'idle' | 'opening' | 'seeding' | 'ready' | 'error'

export interface LocalCatalogStats {
  /** ms to instantiate PGlite and apply the DDL. Paid once per tab. */
  openMs: number | null
  /** ms to page the API and write every row. Paid once, then persisted to IndexedDB. */
  seedMs: number | null
  /** ms for the most recent local read. This is the number the spike exists to produce. */
  queryMs: number | null
  rowCount: number
  /** true when rows came from IndexedDB rather than a fresh network seed. */
  fromCache: boolean
}

export interface UseLocalCatalogResult {
  rows: LocalProductRow[]
  status: LocalCatalogStatus
  error: string | null
  stats: LocalCatalogStats
  /** Re-read locally. No network. */
  refresh: () => Promise<void>
  /** Drop the local store and seed again from the API. */
  reseed: () => Promise<void>
}

const EMPTY_STATS: LocalCatalogStats = {
  openMs: null,
  seedMs: null,
  queryMs: null,
  rowCount: 0,
  fromCache: false,
}

export function useLocalCatalog(): UseLocalCatalogResult {
  const [rows, setRows] = useState<LocalProductRow[]>([])
  const [status, setStatus] = useState<LocalCatalogStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<LocalCatalogStats>(EMPTY_STATS)

  // React 18 StrictMode double-invokes effects in dev. Instantiating PGlite twice is wasteful and
  // makes the openMs measurement meaningless, so the run is latched.
  const startedRef = useRef(false)

  const readRows = useCallback(async (fromCache: boolean) => {
    const t0 = performance.now()
    const next = await readLocalCatalog()
    const queryMs = performance.now() - t0
    setRows(next)
    setStats((s) => ({ ...s, queryMs, rowCount: next.length, fromCache }))
  }, [])

  const boot = useCallback(async () => {
    setError(null)
    try {
      setStatus('opening')
      const t0 = performance.now()
      await getLocalDb()
      const openMs = performance.now() - t0
      setStats((s) => ({ ...s, openMs }))

      const existing = await localRowCount()
      let seedMs: number | null = null
      let fromCache = true

      if (existing === 0) {
        fromCache = false
        setStatus('seeding')
        const t1 = performance.now()
        await seedFromApi(getBackendUrl())
        seedMs = performance.now() - t1
        setStats((s) => ({ ...s, seedMs }))
      }

      await readRows(fromCache)
      setStatus('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [readRows])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void boot()
  }, [boot])

  const refresh = useCallback(async () => {
    if (status !== 'ready') return
    await readRows(true)
  }, [status, readRows])

  const reseed = useCallback(async () => {
    setStats(EMPTY_STATS)
    await clearLocalCatalog()
    startedRef.current = true
    await boot()
  }, [boot])

  return { rows, status, error, stats, refresh, reseed }
}
