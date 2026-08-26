/**
 * GX.8 — a one-line announcement that a stored preference changed.
 *
 * Column choices, section layouts and chart heights are written straight to localStorage by the
 * component that owns them, which is the right place for them to live: no page has to thread a
 * callback through four levels to let a grid remember its columns.
 *
 * The cost shows up the moment something else needs to KNOW they changed — a saved-view bar that
 * has to say "unsaved changes" truthfully. `localStorage` fires no event in the tab that wrote it,
 * so the choices were a poll or an announcement. A poll is a timer that is wrong between ticks and
 * burns work forever to catch a change that happens twice an hour; this is one synchronous event
 * at the moment of the write.
 *
 * Deliberately carries no payload beyond the key. A listener that wants the value reads it — one
 * source of truth stays one source of truth, and a stale payload can never race the store.
 */
const EVENT = 'nds:prefs-changed'

export function emitPrefsChanged(key: string): void {
  if (typeof window === 'undefined') return
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: { key } })) } catch { /* non-fatal */ }
}

/** Returns the unsubscribe function, so a caller can hand it straight back from `useEffect`. */
export function onPrefsChanged(cb: (key: string) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const h = (e: Event) => cb((e as CustomEvent<{ key: string }>).detail?.key ?? '')
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}
