'use client'

// AC.1 / UC.3.4 — Cockpit-vs-classic toggle for the Amazon channel.
//
// Now a thin wrapper over the shared useCockpitModeBase (UC.1.1). Same
// storage key, event name, and default as before, so behaviour is
// unchanged — the cross-instance + cross-tab sync logic just lives in
// one place shared with the eBay toggle.

import {
  useCockpitModeBase,
  type CockpitMode,
} from '../../_shared/cockpit-shell/useCockpitModeBase'

export function useAmazonCockpitMode(): [CockpitMode, (m: CockpitMode) => void] {
  return useCockpitModeBase({
    storageKey: 'nx.products.edit.amazon-cockpit',
    eventName: 'nx:amazon-cockpit-mode',
    defaultMode: 'cockpit',
  })
}
