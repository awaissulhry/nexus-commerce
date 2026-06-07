// MM.5 — pure prefs logic for the dynamic Amazon matrix columns. No React /
// no value-imports from useAmazonImages, so it's cleanly unit-testable. The
// canonical slot list is passed in by the hook.

import type { AmazonSlot } from './useAmazonImages'

export interface ColPref {
  slot: AmazonSlot
  visible: boolean
}

/**
 * Reconcile stored prefs against the canonical slot list: keep stored order for
 * known slots, append new/unknown canonical slots (visible by default), drop
 * stale ones, force MAIN visible, and guarantee at least one visible column.
 */
export function reconcileColPrefs(stored: ColPref[] | null, canonical: readonly AmazonSlot[]): ColPref[] {
  const ordered: ColPref[] = []
  const seen = new Set<string>()
  for (const p of stored ?? []) {
    if (canonical.includes(p.slot) && !seen.has(p.slot)) {
      ordered.push({ slot: p.slot, visible: p.slot === 'MAIN' ? true : !!p.visible })
      seen.add(p.slot)
    }
  }
  for (const slot of canonical) {
    if (!seen.has(slot)) ordered.push({ slot, visible: true })
  }
  if (!ordered.some((p) => p.visible)) {
    const main = ordered.find((p) => p.slot === 'MAIN') ?? ordered[0]
    if (main) main.visible = true
  }
  return ordered
}
