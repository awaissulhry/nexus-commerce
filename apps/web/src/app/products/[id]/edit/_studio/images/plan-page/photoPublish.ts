'use client'

import { useSyncExternalStore } from 'react'

/**
 * The one Publish button (Media redesign, 2026-09-29; Owner: "one Publish button"). While the Media page of a family on
 * the photo plan is open, the studio header's Publish opens "Publish photos" for what the page shows (one destination,
 * or every destination on the Shared product) instead of the whole-listing publish. The page registers here; the
 * header reads it. Anywhere else the header keeps its own Publish.
 */
export interface PhotoPublish { open(): void }

let current: PhotoPublish | null = null
const listeners = new Set<() => void>()

export function setPhotoPublish(next: PhotoPublish | null) {
  current = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function usePhotoPublish(): PhotoPublish | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}
