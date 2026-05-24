'use client'

// AC.5 — Product draft bus.
//
// In-page event bus carrying UNSAVED draft values from one tab of the
// product editor to another. Used by the Listing Cockpit so a keystroke
// in MasterDataTab updates the cockpit preview + health panel without
// waiting for header Save.
//
// Why a module-scope singleton instead of React context: the cockpit
// and the source tabs (MasterDataTab, ImagesTab, LocalesTab, MatrixTab)
// don't share a common ancestor near the leaves — they're siblings
// under ProductEditClient. Lifting state up to the parent would force
// a parent re-render on every keystroke, which kills the typing FPS
// on the 50+ -field MasterDataTab. The singleton + per-product listener
// set keeps re-render cost local to subscribers.
//
// Cross-window updates ride a different rail (SSE + BroadcastChannel —
// see use-listing-events.ts + invalidation-channel.ts). This bus is
// strictly the same-page, same-React-tree, unsaved-state pipe.

import { useEffect, useState } from 'react'

export type DraftValue =
  | string
  | number
  | boolean
  | string[]
  // AC.5b — image arrays are objects with url/type/sortOrder/isPrimary.
  // Widen to any-value arrays so consumer types can stay tight.
  | unknown[]
  | Record<string, unknown>
  | null
  | undefined

const drafts = new Map<string, Record<string, DraftValue>>()
const listeners = new Map<string, Set<() => void>>()

function notify(productId: string) {
  const set = listeners.get(productId)
  if (!set) return
  // Copy before iterating so a listener that unsubscribes mid-fire
  // doesn't trip the iterator.
  for (const fn of Array.from(set)) fn()
}

export function setDraftField(
  productId: string,
  key: string,
  value: DraftValue,
): void {
  const existing = drafts.get(productId) ?? {}
  // Identity short-circuit so repeated identical setDraftField calls
  // (e.g. controlled-input echo) don't fan out re-renders.
  if (Object.is(existing[key], value)) return
  drafts.set(productId, { ...existing, [key]: value })
  notify(productId)
}

export function getDraft(productId: string): Record<string, DraftValue> {
  return drafts.get(productId) ?? {}
}

export function getDraftField(
  productId: string,
  key: string,
): DraftValue | undefined {
  return drafts.get(productId)?.[key]
}

export function clearDraft(productId: string, key?: string): void {
  const existing = drafts.get(productId)
  if (!existing) return
  if (key) {
    if (!(key in existing)) return
    const next = { ...existing }
    delete next[key]
    if (Object.keys(next).length === 0) drafts.delete(productId)
    else drafts.set(productId, next)
  } else {
    drafts.delete(productId)
  }
  notify(productId)
}

/** Subscribe to draft changes for a specific product. Returns the
 *  current draft snapshot; the component re-renders on every change.
 *  Reads are read-after-mount — server-render returns an empty object. */
export function useProductDraft(
  productId: string,
): Record<string, DraftValue> {
  const [, force] = useState(0)
  useEffect(() => {
    if (!productId) return
    let set = listeners.get(productId)
    if (!set) {
      set = new Set()
      listeners.set(productId, set)
    }
    const fn = () => force((n) => (n + 1) % 1_000_000)
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) listeners.delete(productId)
    }
  }, [productId])
  return drafts.get(productId) ?? {}
}

/** Read-only one-shot getter for use outside React. Useful for
 *  computations triggered from event handlers. */
export function readDraft(
  productId: string,
): Record<string, DraftValue> {
  return drafts.get(productId) ?? {}
}
