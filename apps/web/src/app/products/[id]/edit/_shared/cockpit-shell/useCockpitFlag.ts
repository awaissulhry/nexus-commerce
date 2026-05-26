'use client'

// UC.0.2 — Cockpit feature-flag scaffold.
//
// The web app has no flag mechanism, so this is a tiny localStorage-backed
// one following the same pattern as the cockpit mode toggle (CustomEvent
// for same-tab broadcast + native `storage` for cross-tab). Every flag is
// DARK BY DEFAULT (fallback false) so each unified-cockpit migration ships
// off and is flipped on per-channel/per-capability in UC.10.2.
//
// Flip from the devtools console:
//   localStorage.setItem('nx.cockpit.flag.<name>', '1')
//   window.dispatchEvent(new CustomEvent('nx:cockpit-flag', {
//     detail: { name: '<name>', on: true } }))
// or call setCockpitFlag('<name>', true).

import { useEffect, useState } from 'react'

const PREFIX = 'nx.cockpit.flag.'
const EVENT = 'nx:cockpit-flag'

interface FlagDetail {
  name: string
  on: boolean
}

export function readCockpitFlag(name: string, fallback = false): boolean {
  try {
    const raw = window.localStorage.getItem(PREFIX + name)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    // ignore — private mode / disabled storage
  }
  return fallback
}

export function setCockpitFlag(name: string, on: boolean): void {
  try {
    window.localStorage.setItem(PREFIX + name, on ? '1' : '0')
    window.dispatchEvent(new CustomEvent<FlagDetail>(EVENT, { detail: { name, on } }))
  } catch {
    // ignore
  }
}

export function useCockpitFlag(name: string, fallback = false): boolean {
  const [on, setOn] = useState(fallback)

  useEffect(() => {
    setOn(readCockpitFlag(name, fallback))

    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<FlagDetail>).detail
      if (detail?.name === name) setOn(detail.on)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PREFIX + name) return
      setOn(e.newValue === '1')
    }
    window.addEventListener(EVENT, onCustom as EventListener)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT, onCustom as EventListener)
      window.removeEventListener('storage', onStorage)
    }
  }, [name, fallback])

  return on
}
