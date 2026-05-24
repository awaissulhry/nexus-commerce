'use client'

// EC.1 — Cockpit-vs-classic mode toggle.
//
// localStorage-backed so operators who land on the new UI mid-session
// keep their choice across reloads. Default is 'cockpit' for the eBay
// channel during the EC engagement; once EC.10 (publish) is stable we
// can drop the toggle entirely.

import { useEffect, useState } from 'react'
import type { CockpitMode } from './types'

const STORAGE_KEY = 'nx.products.edit.ebay-cockpit'
const EVENT_NAME = 'nx:ebay-cockpit-mode'
const DEFAULT_MODE: CockpitMode = 'cockpit'

export function useCockpitMode(): [CockpitMode, (m: CockpitMode) => void] {
  const [mode, setModeState] = useState<CockpitMode>(DEFAULT_MODE)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw === 'cockpit' || raw === 'classic') setModeState(raw)
    } catch {
      // ignore — private mode / disabled storage
    }

    // Same-tab cross-instance sync: the cockpit's "Classic view" link
    // and the page-level mode hook are separate useState slots, so a
    // setMode call needs to broadcast for the other instances to pick
    // it up without a page refresh. Storage events don't fire in the
    // tab that wrote the value, so we dispatch our own.
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
