'use client'

// AC.1 — Cockpit-vs-classic toggle for the Amazon channel.
//
// Same shape as ebay-cockpit/useCockpitMode but a SEPARATE storage key
// so the choice doesn't bleed across channels. An operator who flipped
// the eBay tab back to "classic" should still see the Amazon cockpit
// by default, and vice-versa.
//
// Default mode is 'cockpit' during the AC engagement; once AC.12
// (publish flow) is stable we can drop the toggle.

import { useEffect, useState } from 'react'
import type { CockpitMode } from './types'

const STORAGE_KEY = 'nx.products.edit.amazon-cockpit'
const EVENT_NAME = 'nx:amazon-cockpit-mode'
const DEFAULT_MODE: CockpitMode = 'cockpit'

export function useAmazonCockpitMode(): [CockpitMode, (m: CockpitMode) => void] {
  const [mode, setModeState] = useState<CockpitMode>(DEFAULT_MODE)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw === 'cockpit' || raw === 'classic') setModeState(raw)
    } catch {
      // ignore — private mode / disabled storage
    }

    // Cross-instance same-tab sync: the cockpit's "Classic view" link
    // and the page-level mode hook are separate useState slots, so a
    // setMode call needs to broadcast for the other instance to pick
    // up without a page refresh. Storage events don't fire in the tab
    // that wrote the value, so we dispatch a CustomEvent.
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<CockpitMode>).detail
      if (detail === 'cockpit' || detail === 'classic') setModeState(detail)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      const v = e.newValue
      if (v === 'cockpit' || v === 'classic') setModeState(v)
    }
    window.addEventListener(EVENT_NAME, onCustom as EventListener)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onCustom as EventListener)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setMode = (next: CockpitMode) => {
    setModeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
      window.dispatchEvent(new CustomEvent<CockpitMode>(EVENT_NAME, { detail: next }))
    } catch {
      // ignore
    }
  }

  return [mode, setMode]
}
