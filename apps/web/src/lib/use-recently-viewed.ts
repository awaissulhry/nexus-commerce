'use client'

import { useEffect, useState, useCallback } from 'react'

export interface RecentItem {
  id: string
  label: string
  href: string
  type: 'product' | 'order' | 'listing'
}

const STORAGE_KEY = 'nexus_recent'
const MAX_ITEMS = 5

function readStorage(): RecentItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeStorage(items: RecentItem[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    // Notify same-tab listeners (the storage event only fires cross-tab).
    window.dispatchEvent(new CustomEvent('nexus:recent-changed'))
  } catch {
    /* swallow quota / privacy errors */
  }
}

/**
 * Read-only access to the recently-viewed list. Re-renders whenever
 * something in this tab pushes a new entry.
 */
export function useRecentlyViewed(): RecentItem[] {
  const [items, setItems] = useState<RecentItem[]>(() => readStorage())

  useEffect(() => {
    const refresh = () => setItems(readStorage())
    window.addEventListener('storage', refresh)
    window.addEventListener('nexus:recent-changed', refresh)
    return () => {
      window.removeEventListener('storage', refresh)
      window.removeEventListener('nexus:recent-changed', refresh)
    }
  }, [])

  return items
}

/**
 * Push an item to the recently-viewed list. De-dupes by id; caps at 5.
 * Use inside a useEffect with the item as the dep so it only fires once
 * per visit.
 */
export function pushRecentlyViewed(item: RecentItem) {
  const current = readStorage()
  const next = [item, ...current.filter((r) => r.id !== item.id)].slice(0, MAX_ITEMS)
  writeStorage(next)
}

/** Hook variant for ergonomic usage in a component. */
export function useTrackRecentlyViewed(item: RecentItem | null) {
  useEffect(() => {
    if (item) pushRecentlyViewed(item)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id])
}

export const _internal = { readStorage, writeStorage, MAX_ITEMS }
// useCallback intentionally re-exported so callers can wrap pushRecentlyViewed
export { useCallback }
