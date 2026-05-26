'use client'

// UC.1.1 — Parameterized cockpit/classic mode toggle.
//
// The Amazon (useAmazonCockpitMode) and eBay (useCockpitMode) hooks were
// byte-for-byte identical apart from their storage key, event name, and
// default. This is the shared base; UC.3.4 / UC.4.5 re-point those two
// wrappers at it so the behaviour stays exactly the same while the logic
// lives in one place.
//
// Cross-instance same-tab sync: the cockpit's "Classic view" link and
// the page-level hook are separate useState slots, so a setMode call
// broadcasts a CustomEvent (storage events don't fire in the writing
// tab). Cross-tab sync rides the native `storage` event.

import { useEffect, useState } from 'react'

export type CockpitMode = 'cockpit' | 'classic'

export interface CockpitModeConfig {
  /** localStorage key, e.g. "nx.products.edit.amazon-cockpit". */
  storageKey: string
  /** CustomEvent name for same-tab broadcast, e.g. "nx:amazon-cockpit-mode". */
  eventName: string
  /** Mode when nothing is stored yet. Defaults to 'cockpit'. */
  defaultMode?: CockpitMode
}

function isMode(v: unknown): v is CockpitMode {
  return v === 'cockpit' || v === 'classic'
}

export function useCockpitModeBase(
  config: CockpitModeConfig,
): [CockpitMode, (m: CockpitMode) => void] {
  const { storageKey, eventName, defaultMode = 'cockpit' } = config
  const [mode, setModeState] = useState<CockpitMode>(defaultMode)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (isMode(raw)) setModeState(raw)
    } catch {
      // ignore — private mode / disabled storage
    }

    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<CockpitMode>).detail
      if (isMode(detail)) setModeState(detail)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey) return
      if (isMode(e.newValue)) setModeState(e.newValue)
    }
    window.addEventListener(eventName, onCustom as EventListener)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(eventName, onCustom as EventListener)
      window.removeEventListener('storage', onStorage)
    }
  }, [storageKey, eventName])

  const setMode = (next: CockpitMode) => {
    setModeState(next)
    try {
      window.localStorage.setItem(storageKey, next)
      window.dispatchEvent(new CustomEvent<CockpitMode>(eventName, { detail: next }))
    } catch {
      // ignore
    }
  }

  return [mode, setMode]
}
