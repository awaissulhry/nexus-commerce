/**
 * DSP.8 — Unified navigation guard for unsaved state.
 *
 * Replaces the inline `beforeunload` pattern used in ProductEditClient,
 * ListWizardClient, SettingsSaveBar (each rolled their own copy). Adds
 * the in-app routing intercept that pre-DSP.8 was missing: clicking a
 * sidebar / breadcrumb / dashboard nav link with unsaved edits used to
 * navigate silently (Next.js App Router doesn't natively fire
 * `beforeunload` on client-side route changes).
 *
 * Two layers:
 *
 *   1. `beforeunload` — browser-level guard for tab close / refresh /
 *      hard URL change. Native browser dialog; we can't customize the
 *      message in modern browsers but the dialog still appears.
 *
 *   2. document-level `<a>` click capture — when the operator clicks
 *      an anchor pointing to a same-origin in-app URL, intercept BEFORE
 *      the browser navigates, run a sync confirm(), abort if rejected.
 *      Misses programmatic router.push() calls from buttons (those need
 *      explicit confirm at the call site) but catches the typical
 *      navigation pattern.
 *
 * See `docs/edit-ux.md` (Navigation guard section) for the canonical
 * rules — guard fires ONLY when dirty state is real (no false fire
 * from auto-saved values, which is why DSP.2 had to land first).
 */

import { useEffect } from 'react'

export interface NavigationGuardOptions {
  /** When false, the guard does nothing — useful as the toggle for
   *  "page is clean, allow navigation freely". Pass `registry.isDirty`. */
  enabled: boolean
  /** Message shown in the in-app confirm dialog. Browsers ignore the
   *  string for beforeunload and show their own copy. */
  message?: string
}

const DEFAULT_MESSAGE =
  'You have unsaved changes. Leave anyway?'

export function useNavigationGuard({ enabled, message = DEFAULT_MESSAGE }: NavigationGuardOptions): void {
  useEffect(() => {
    if (!enabled) return

    // ── Layer 1: tab close / refresh / hard URL change ──────────────
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      // Modern browsers ignore the string and show their own message,
      // but assigning is still required for the dialog to appear.
      e.returnValue = message
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    // ── Layer 2: in-app <a> click intercept ─────────────────────────
    // Capture-phase so we fire before any nested onClick handler that
    // might call event.preventDefault() for its own reasons.
    function onAnchorClick(e: MouseEvent) {
      if (e.defaultPrevented) return
      // Honour standard "open in new tab" gestures — they don't unload
      // the current page so no guard needed.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      if (e.button !== 0) return // Left-click only.

      const target = e.target as Element | null
      if (!target) return
      const anchor = target.closest('a') as HTMLAnchorElement | null
      if (!anchor) return
      // target="_blank" opens a new tab — current page isn't lost.
      if (anchor.target && anchor.target !== '_self') return
      // download links don't unload the page either.
      if (anchor.hasAttribute('download')) return

      // Only intercept same-origin in-app navigation. External links
      // are the operator's choice; the beforeunload guard above
      // covers the unload side of that case anyway.
      const href = anchor.getAttribute('href')
      if (!href) return
      if (href.startsWith('#')) return // in-page anchor
      if (href.startsWith('mailto:') || href.startsWith('tel:')) return

      let url: URL
      try {
        url = new URL(anchor.href, window.location.origin)
      } catch {
        return
      }
      if (url.origin !== window.location.origin) return
      // Same URL we're already on — no navigation will happen.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return

      // eslint-disable-next-line no-alert
      const ok = window.confirm(message)
      if (!ok) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('click', onAnchorClick, /* useCapture */ true)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onAnchorClick, /* useCapture */ true)
    }
  }, [enabled, message])
}
