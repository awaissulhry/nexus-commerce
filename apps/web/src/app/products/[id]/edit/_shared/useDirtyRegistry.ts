/**
 * DSP.1 — central dirty-state registry for the product editor.
 *
 * Replaces the inline `dirtyByTab: Record<string, number>` pattern in
 * ProductEditClient with a structured registry that also stores
 * optional `flush()` and `discard()` callbacks per tab.
 *
 * Current consumers (DSP.1):
 *   - ProductEditClient — owns the registry instance, reads `byTab` for
 *     per-tab dirty dots, calls `saveAll()` from header Save.
 *   - All tabs — call `register(key, { count })` on dirty-count change
 *     (existing onDirtyChange API still works through a shim).
 *
 * Future consumers (DSP.2+):
 *   - Tabs that move from auto-save to explicit save will register a
 *     `flush()` callback. Header Save then awaits every registered
 *     flush in parallel instead of relying on debounce timing.
 *   - DSP.3 Discard modal reads `byTab` to enumerate dirty scopes.
 *   - DSP.4 Publish calls `saveAll()` before pushing to channels.
 *
 * See `docs/edit-ux.md` for the canonical spec.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

export interface DirtyEntry {
  /** Number of unsaved fields/changes on this tab. */
  count: number
  /** Persists this tab's pending state to the server. Called by header
   *  Save All in parallel with other tabs' flushes. Throws on failure.
   *  Undefined for tabs that auto-save (existing pattern) or have no
   *  save semantics. */
  flush?: () => Promise<void>
  /** Reverts this tab's local state to server values WITHOUT refetching.
   *  Called by header Discard. Tabs without this fall back to watching
   *  the discardSignal prop. */
  discard?: () => void
  /** Human-readable label for the DSP.3 Discard confirmation modal.
   *  Defaults to the tabKey. */
  label?: string
}

export interface DirtyRegistry {
  /** Stable callback for tabs to register / update their dirty state.
   *  Passing `count: 0` keeps the entry but reports clean; passing
   *  undefined to flush/discard preserves any previously-registered
   *  callback (so a tab can re-register on every render without
   *  losing its handlers). To fully remove an entry use `unregister`. */
  register: (tabKey: string, entry: Partial<DirtyEntry>) => void
  /** Removes a tab from the registry entirely. */
  unregister: (tabKey: string) => void
  /** Read-only snapshot of all entries, keyed by tabKey. */
  byTab: Record<string, DirtyEntry>
  /** Sum of every count across all tabs. */
  total: number
  /** Convenience: total > 0. */
  isDirty: boolean
  /** Awaits every registered `flush()` in parallel for tabs with
   *  count > 0. Tabs without a flush are skipped (they're expected
   *  to be auto-saving or read-only). Re-throws if any flush throws. */
  saveAll: () => Promise<void>
  /** Calls every registered `discard()` in parallel. Tabs without a
   *  discard handler should watch the legacy discardSignal prop. */
  discardAll: () => void
}

export function useDirtyRegistry(): DirtyRegistry {
  // Mutable ref so register() doesn't trigger re-renders by itself —
  // only when the entry's shape actually changes (count or callback
  // identity). Avoids re-render storms when tabs call register on
  // every render with the same values.
  const entries = useRef<Map<string, DirtyEntry>>(new Map())
  const [stamp, setStamp] = useState(0)

  const register = useCallback((tabKey: string, entry: Partial<DirtyEntry>) => {
    const existing = entries.current.get(tabKey)
    // Preserve existing values when the key is not in `entry` (i.e.
    // the caller is updating only one slice). Explicit `undefined`
    // still clears via `'key' in entry`. Lets tabs register handlers
    // once on mount + report count via separate calls without
    // clobbering each other.
    const next: DirtyEntry = {
      count: 'count' in entry ? (entry.count ?? 0) : (existing?.count ?? 0),
      flush: 'flush' in entry ? entry.flush : existing?.flush,
      discard: 'discard' in entry ? entry.discard : existing?.discard,
      label: 'label' in entry ? entry.label : existing?.label,
    }
    if (
      existing &&
      existing.count === next.count &&
      existing.flush === next.flush &&
      existing.discard === next.discard &&
      existing.label === next.label
    ) {
      return
    }
    entries.current.set(tabKey, next)
    setStamp((s) => s + 1)
  }, [])

  const unregister = useCallback((tabKey: string) => {
    if (entries.current.delete(tabKey)) setStamp((s) => s + 1)
  }, [])

  const byTab = useMemo(() => {
    const out: Record<string, DirtyEntry> = {}
    for (const [k, e] of entries.current.entries()) out[k] = e
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])

  const total = useMemo(() => {
    let n = 0
    for (const e of entries.current.values()) n += e.count
    return n
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])

  const saveAll = useCallback(async () => {
    const flushes: Array<Promise<void>> = []
    for (const e of entries.current.values()) {
      if (e.flush && e.count > 0) flushes.push(e.flush())
    }
    await Promise.all(flushes)
  }, [])

  const discardAll = useCallback(() => {
    for (const e of entries.current.values()) {
      if (e.discard) e.discard()
    }
  }, [])

  return {
    register,
    unregister,
    byTab,
    total,
    isDirty: total > 0,
    saveAll,
    discardAll,
  }
}
