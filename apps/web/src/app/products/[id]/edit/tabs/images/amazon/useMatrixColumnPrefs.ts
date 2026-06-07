// MM.5 — dynamic Amazon matrix columns. The operator chooses which slot-columns
// to see (e.g. hide PS once done) and their order, persisted per-browser. Clones
// the useTabPrefs pattern: versioned localStorage + reconcile-against-canonical
// (ALL_SLOTS) + a min-visible guard (MAIN is always shown — Amazon requires it).
// The pure reconcile lives in ./matrixColumnPrefs so it stays unit-testable.

import { useCallback, useEffect, useState } from 'react'
import { ALL_SLOTS } from './useAmazonImages'
import { reconcileColPrefs, type ColPref } from './matrixColumnPrefs'

export type { ColPref }

const STORAGE_KEY = 'product-edit:amazon-cols:v1'

export function useMatrixColumnPrefs() {
  const [prefs, setPrefs] = useState<ColPref[]>(() => reconcileColPrefs(null, ALL_SLOTS))

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const parsed = raw ? (JSON.parse(raw) as { v: number; items: ColPref[] }) : null
      setPrefs(reconcileColPrefs(parsed?.items ?? null, ALL_SLOTS))
    } catch {
      /* keep defaults */
    }
  }, [])

  const save = useCallback((next: ColPref[]) => {
    const reconciled = reconcileColPrefs(next, ALL_SLOTS)
    setPrefs(reconciled)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items: reconciled }))
    } catch {
      /* ignore quota / private mode */
    }
  }, [])

  const reset = useCallback(() => {
    setPrefs(reconcileColPrefs(null, ALL_SLOTS))
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const visibleSlots = prefs.filter((p) => p.visible).map((p) => p.slot)
  const hiddenCount = prefs.length - visibleSlots.length
  return { prefs, visibleSlots, hiddenCount, save, reset }
}
