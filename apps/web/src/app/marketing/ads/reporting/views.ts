/**
 * GX.8 — what a saved view is made of, and how it is put back.
 *
 * ── One rule: a tab's state IS its localStorage prefix ────────────────────────
 *
 * Section layout, grid columns and chart heights are each owned by the component that draws
 * them, and each writes straight to localStorage. A registry naming every one of those keys by
 * hand would be correct on the day it was written and silently wrong the first time somebody
 * added a grid — the view would keep saving, keep restoring, and quietly leave the new panel out.
 *
 * So a tab owns a PREFIX, every key it stores begins with it, and a view is whatever is under
 * that prefix at the moment you save. A panel added tomorrow is carried with no change here.
 * The one obligation this puts on the page is that the prefixes stay disjoint and every
 * `storageKey` on a tab starts with its own — `assertPrefixed` below is that obligation, checked
 * in development rather than trusted.
 *
 * ── Applying REPLACES, never merges ──────────────────────────────────────────
 *
 * Restoring a view drops the keys under the prefix that the view does not carry. Merging would
 * leave a panel you hid after saving still hidden, which makes a view mean "some of what I was
 * looking at" — and no operator can tell which parts.
 *
 * ── The two tabs that are deliberately absent ────────────────────────────────
 *
 * The LIBRARY: a saved library view is a saved report, which this page has had since RPT.5, with
 * versioning this does not attempt. Two mechanisms for one gesture is the inconsistency, not the
 * gap.
 *
 * The EXPLORER: it renders one grid with `customizable={false}` and stores nothing at all, so a
 * view of it would hold the tab and the market and imply it held more. The address bar already
 * carries both. If that grid ever gains a Customize dialog, giving it an `rpx-explorer-` key and
 * adding the prefix below is the whole change.
 */

/** Tab id → the prefix every one of its stored keys begins with. Must stay mutually disjoint. */
export const TAB_PREFIX: Record<string, string> = {
  brand: 'rpx-brand-',
  'market-share': 'rpx-share-',
  business: 'rpx-business-',
  hourly: 'rpx-hourly-',
}

export function saveableTab(tab: string): boolean {
  return Object.prototype.hasOwnProperty.call(TAB_PREFIX, tab)
}

/**
 * Any `rpx-` key in storage that belongs to no tab.
 *
 * This is the obligation above, checked generically rather than by a registry that would have to
 * be maintained: a panel whose `storageKey` does not start with its tab's prefix shows up here
 * the first time it writes anything, and the alternative — noticing that a restored view is
 * quietly missing a panel — is a failure nobody reports because nothing looks broken.
 */
export function orphanKeys(): string[] {
  const prefixes = Object.values(TAB_PREFIX)
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith('rpx-')) continue
      if (!prefixes.some((p) => k.startsWith(p))) out.push(k)
    }
  } catch { /* unreadable — nothing to report */ }
  return out
}

/** Everything this tab has stored, right now, exactly as the browser holds it. */
export function captureKeys(tab: string): Record<string, string> {
  const prefix = TAB_PREFIX[tab]
  const out: Record<string, string> = {}
  if (!prefix) return out
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(prefix)) continue
      const v = localStorage.getItem(k)
      if (v != null) out[k] = v
    }
  } catch { /* private mode — a view can still be saved from what is on screen, just not read back */ }
  return out
}

/** Replace this tab's stored keys with the view's. Returns false if storage refused the write. */
export function applyKeys(tab: string, keys: Record<string, string>): boolean {
  const prefix = TAB_PREFIX[tab]
  if (!prefix) return false
  try {
    // Collect first, delete second: removing while enumerating shifts the indices under us and
    // skips every other key.
    const existing: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) existing.push(k)
    }
    for (const k of existing) localStorage.removeItem(k)
    for (const [k, v] of Object.entries(keys)) {
      if (k.startsWith(prefix)) localStorage.setItem(k, v)
    }
    return true
  } catch {
    return false
  }
}

/** Whether what is on screen has drifted from what was saved. Order-independent. */
export function keysDiffer(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return true
  return ka.some((k) => a[k] !== b[k])
}
