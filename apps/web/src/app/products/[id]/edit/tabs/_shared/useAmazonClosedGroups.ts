'use client'

/**
 * AG.4 — Per-marketplace collapse state for Amazon tab grouping.
 *
 * Each (marketplace, productType) pair gets its own localStorage
 * entry so collapse decisions on DE don't leak into IT — Amazon
 * publishes different `__propertyGroups` per locale, so the same
 * groupId may not even exist in another marketplace.
 *
 * Storage key shape:
 *
 *   localStorage['amazon-tab:closed-groups:DE:OUTERWEAR'] = ['compliance', 'fulfillment']
 *
 * Default: empty set (all groups open). The hook returns a stable
 * `toggle(groupId)` so callers can wire it to a header click without
 * re-creating the handler each render.
 */

import { useCallback, useEffect, useState } from 'react'

interface UseAmazonClosedGroupsOptions {
  marketplace: string
  productType: string | null
}

export interface UseAmazonClosedGroupsResult {
  closedGroups: Set<string>
  isClosed: (groupId: string) => boolean
  toggle: (groupId: string) => void
}

function storageKey(marketplace: string, productType: string | null): string {
  return `amazon-tab:closed-groups:${marketplace}:${productType ?? 'none'}`
}

function readFromStorage(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((s): s is string => typeof s === 'string'))
  } catch {
    return new Set()
  }
}

function writeToStorage(key: string, set: Set<string>): void {
  if (typeof window === 'undefined') return
  try {
    if (set.size === 0) {
      // Don't pollute storage with empty arrays.
      window.localStorage.removeItem(key)
      return
    }
    window.localStorage.setItem(key, JSON.stringify([...set]))
  } catch {
    // Quota / private-browsing — collapse state just doesn't persist
    // across sessions. Functionality still works in-memory.
  }
}

export function useAmazonClosedGroups({
  marketplace,
  productType,
}: UseAmazonClosedGroupsOptions): UseAmazonClosedGroupsResult {
  const key = storageKey(marketplace, productType)
  // Seed once per (marketplace, productType) — the effect below
  // re-seeds when those change, so switching from IT to DE loads
  // DE's saved state cleanly.
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() =>
    readFromStorage(key),
  )

  // Re-seed on marketplace / productType change. The component using
  // this hook lives inside ChannelFieldEditor, which is keyed by
  // marketplace at the parent level today, so this effect mostly
  // covers the case where productType changes without a remount.
  useEffect(() => {
    setClosedGroups(readFromStorage(key))
  }, [key])

  const toggle = useCallback(
    (groupId: string) => {
      setClosedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(groupId)) next.delete(groupId)
        else next.add(groupId)
        writeToStorage(key, next)
        return next
      })
    },
    [key],
  )

  const isClosed = useCallback(
    (groupId: string) => closedGroups.has(groupId),
    [closedGroups],
  )

  return { closedGroups, isClosed, toggle }
}
