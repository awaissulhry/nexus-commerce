'use client'

// EC.1 / UC.4.5 — Cockpit-vs-classic mode toggle for the eBay channel.
//
// Now a thin wrapper over the shared useCockpitModeBase (UC.1.1). Same
// storage key, event name, and default as before, so behaviour is
// unchanged — the cross-instance + cross-tab sync logic just lives in
// one place shared with the Amazon toggle.

import {
  useCockpitModeBase,
  type CockpitMode,
} from '../../_shared/cockpit-shell/useCockpitModeBase'

export function useCockpitMode(): [CockpitMode, (m: CockpitMode) => void] {
  return useCockpitModeBase({
    storageKey: 'nx.products.edit.ebay-cockpit',
    eventName: 'nx:ebay-cockpit-mode',
    defaultMode: 'cockpit',
  })
}
