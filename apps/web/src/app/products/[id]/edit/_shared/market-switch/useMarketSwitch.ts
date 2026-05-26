'use client'

// AC.3 — useMarketSwitch.
//
// Glue hook for the cockpit chip strip. Owns:
//   * URL ?market=<code> sync (read on mount, write on switch).
//   * Alt+1..9 keyboard shortcuts mapping to the first 9 chips.
//   * Dirty-flush prompt before switching away from a market with
//     unsaved edits (Save / Discard / Cancel via window.confirm —
//     AC.13 promotes this to the project's ConfirmProvider modal).
//
// The hook is channel-agnostic; Amazon, eBay, and Shopify cockpits
// can mount it. Lives in _shared/market-switch/ so the FF-MS
// patterns it borrows from never need the cockpit to import any
// /products/amazon-flat-file code — that surface is OFF-LIMITS by
// engagement rule.

import { useCallback, useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { MarketChip } from './types'
import { announce } from '../announce/useAnnounce'
import { postCockpitEvent } from '../telemetry/cockpit-telemetry'

interface Options {
  /** Channel id, e.g. "AMAZON" or "EBAY". Used as scoping prefix on
   *  the URL searchParam key when multiple cockpits coexist on the
   *  same route. For now only the active channel's cockpit reads
   *  `?market=` so a plain key is fine; the channel arg is kept for
   *  future-proofing. */
  channel: string
  /** Currently selected market code (parent-owned state). */
  active: string
  /** Available markets. The hook walks this for the Alt+N mapping. */
  markets: MarketChip[]
  /** Called with the new code AFTER the dirty prompt resolves to
   *  "switch". Parent does whatever state update + remount it needs. */
  onSwitch: (code: string) => void
  /** Optional. Called by the dirty prompt's "Save & switch" path. */
  flush?: () => Promise<void>
  /** Optional. Called by the dirty prompt's "Discard & switch" path. */
  discard?: () => void
  /** Total dirty field count for the active market. When > 0 a switch
   *  attempt prompts the operator. */
  isDirty?: number
  /** When true (default), maintain `?market=<code>` in the URL via
   *  router.replace. */
  syncUrl?: boolean
}

/** Per-tab in-memory map of recently warmed manifest keys. Lives at
 *  module scope so multiple cockpit instances share the cache check
 *  inside a single page session — same FF-MS SWR-cache idea, lifted
 *  here without importing flat-file code. */
const warmedKeys = new Map<string, number>()

// FX.1 — Per-(path, channel) URL-adoption guard. The cockpit REMOUNTS on
// every market switch (its key includes the selected market), so a plain
// per-instance ref re-runs the adopt effect each remount. At that moment
// useSearchParams still reflects the OLD ?market= (router.replace from the
// previous instance hasn't propagated), so the adopt would call
// onSwitch(oldMarket) and revert the switch — the "can't change market"
// bug. Keying by pathname+channel at module scope means we adopt the URL
// exactly once per product+channel (genuine deep-link) and never re-adopt
// on a switch-remount. A different product (pathname change) adopts afresh.
const adoptedPaths = new Set<string>()

export function isManifestWarm(key: string, ttlMs = 5 * 60_000): boolean {
  const at = warmedKeys.get(key)
  if (!at) return false
  if (Date.now() - at > ttlMs) {
    warmedKeys.delete(key)
    return false
  }
  return true
}

export function markManifestWarm(key: string): void {
  warmedKeys.set(key, Date.now())
}

export function useMarketSwitch({
  channel,
  active,
  markets,
  onSwitch,
  flush,
  discard,
  isDirty = 0,
  syncUrl = true,
}: Options) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const activeRef = useRef(active)
  activeRef.current = active

  // Read ?market= and adopt it ONCE per product+channel (genuine deep
  // link). The module-scope guard (keyed by pathname+channel) survives the
  // remount that a market switch triggers, so we never re-adopt a stale
  // URL and revert the switch.
  useEffect(() => {
    if (!syncUrl) return
    const adoptKey = `${pathname}__${channel}`
    if (adoptedPaths.has(adoptKey)) return
    adoptedPaths.add(adoptKey)
    const url = params?.get('market')
    if (!url || url === active) return
    const known = markets.some((m) => m.code === url)
    if (known) onSwitch(url)
    // onSwitch intentionally omitted — adopt fires once per path+channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, markets, active, syncUrl, pathname, channel])

  // Write the URL when `active` changes. Use replace (no history
  // entry per chip click — would clutter back/forward). Only writes
  // when the value actually differs from the URL.
  useEffect(() => {
    if (!syncUrl) return
    const current = params?.get('market')
    if (current === active) return
    const next = new URLSearchParams(params?.toString() ?? '')
    next.set('market', active)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, syncUrl])

  // Dirty-prompt + switch.
  const switchTo = useCallback(
    async (next: string) => {
      if (next === activeRef.current) return
      const t0 =
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (isDirty > 0) {
        // window.confirm yields a 3-state intent via two prompts so we
        // can offer Save / Discard / Cancel without pulling a modal
        // dep in. AC.13 swaps this for the project's ConfirmProvider.
        const wantsSave = window.confirm(
          `You have ${isDirty} unsaved field${isDirty === 1 ? '' : 's'} on ${activeRef.current}.\n\nOK = Save and switch to ${next}\nCancel = stay here (or discard with second prompt)`,
        )
        if (wantsSave) {
          try {
            if (flush) await flush()
          } catch {
            window.alert('Save failed — staying on current market.')
            return
          }
        } else {
          const wantsDiscard = window.confirm(
            `Discard the ${isDirty} unsaved field${isDirty === 1 ? '' : 's'} on ${activeRef.current} and switch to ${next}?`,
          )
          if (!wantsDiscard) return
          discard?.()
        }
      }
      const from = activeRef.current
      onSwitch(next)
      announce(`Switched to ${next}`)
      const t1 =
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      postCockpitEvent({
        type: 'market_switched',
        marketplace: next,
        durationMs: Math.round(t1 - t0),
        payload: { from, to: next },
      })
    },
    [isDirty, flush, discard, onSwitch],
  )

  // Alt+1..9 — map to the first 9 chips (the strip won't surface a
  // hint past 9). Skips when target === active. Ignored when focus is
  // inside an editable element so it never steals Alt+Letter accents.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const tag =
        (e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? ''
      const editable =
        (e.target as HTMLElement | null)?.isContentEditable ?? false
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || editable) {
        return
      }
      const digit = parseInt(e.key, 10)
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return
      const target = markets[digit - 1]
      if (!target) return
      if (target.code === activeRef.current) return
      e.preventDefault()
      void switchTo(target.code)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [markets, switchTo])

  return { switchTo }
}
