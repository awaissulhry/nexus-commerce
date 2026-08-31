'use client'

/**
 * TB — the app-wide top bar.
 *
 * A utility and context surface, NOT navigation: moving between modules stays in the rail. The
 * bar owns the brand, per-screen context (TB.5), the search trigger and the identity/utility
 * controls.
 *
 * ── This file composes; it implements nothing ────────────────────────────────────────────────
 *
 * Everything here already existed and was mounted elsewhere:
 *   • search        → `components/CommandPalette.tsx` — chords, "On this page" context commands,
 *                     and live remote search across listings / shipments / pending orders. The
 *                     field DISPATCHES `nexus:open-command-palette`; it is never a second search.
 *   • profile       → `ProfileSwitcher` (TB.6). Replaced the connected-accounts chip: the
 *                     operator wants identity and ACCESS scope here, not which marketplace is
 *                     connected. Account scoping lives at /settings/channels.
 *   • notifications → `components/NotificationsBell.tsx`, previously floated at `top-3 right-3`.
 *
 * Each floating mount was removed in the SAME change that added it here, so a duplicate bell or
 * a second account switcher cannot exist even briefly.
 *
 * ── Design system ────────────────────────────────────────────────────────────────────────────
 *
 * Every control is a DS primitive, not a hand-rolled lookalike: `.nds-field` + `.lead` for the
 * search box, `.nds-kbd` for the shortcut hint, `.nds-tdivider` between groups. `app-topbar.css`
 * contributes LAYOUT only (where the regions sit) — no colours, no borders, no radii of its own.
 * Appearance comes from the DS and from `--nds-topbar-*`, which alias the rail so the bar and the
 * rail read as one L-shaped piece of chrome.
 *
 * ⚠ `components/layout/TopBar.tsx` was NOT this file's predecessor. It looked exactly like this
 * bar (search, bell, help, hard-coded `Amazon IT` / `eBay` chips) and was imported by NOTHING —
 * it never rendered once. It is deleted alongside this; nothing was ported out of it, because
 * none of it was ever live.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Search, Sun, Moon, Monitor } from 'lucide-react'
import { useTheme } from '@/lib/theme/use-theme'
import NotificationsBell from '@/components/NotificationsBell'
import { ProfileSwitcher } from './ProfileSwitcher'

function openCommandPalette() {
  window.dispatchEvent(new CustomEvent('nexus:open-command-palette'))
}

export function AppTopBar() {
  // The shortcut hint has to match the key the palette actually listens for, and that differs by
  // platform. Resolved after mount: `navigator` does not exist during SSR, and rendering "⌘K" on
  // the server then swapping to "Ctrl K" on the client is a hydration mismatch.
  const [isMac, setIsMac] = useState(true)
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))
  }, [])

  /*
   * TB.4 — the theme cycler, moved out of the rail's footer.
   *
   * `useTheme` is not just this button's state: it is the hook that APPLIES the `.dark` class to
   * <html> and subscribes to `prefers-color-scheme` for the 'system' default. It used to be
   * mounted by AppNavRail, so it only ran where the rail rendered. The bar reaches every route
   * the rail does plus the standalone shells, so owning it here is strictly wider coverage.
   */
  const { mode, cycleTheme } = useTheme()
  const ThemeIcon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor
  const themeLabel =
    mode === 'light'
      ? 'Switch to dark mode'
      : mode === 'dark'
        ? 'Switch to system theme'
        : 'Switch to light mode'

  return (
    <header className="nds-topbar" role="banner" data-print-hide>
      <Link href="/" className="nds-topbar-brand" aria-label="Nexus home">
        <span className="logo" aria-hidden="true">
          N
        </span>
      </Link>

      {/* TB.5 — page context. Deliberately empty: pages opt in via usePageChrome() as they are
          rebuilt, so the 119 existing PageHeader consumers render exactly as they do today. */}
      <div className="nds-topbar-context" />

      <div className="nds-topbar-search">
        {/*
         * A readonly input rather than a button: it keeps the DS `.nds-field` primitive intact
         * (which styles `> input`, not an arbitrary child), reads to a screen reader as the
         * search control it is, and still hands every keystroke to the palette — which is the
         * component that actually knows how to search. `readOnly` (not `disabled`) so it remains
         * focusable and the focus ring works.
         */}
        <span className="nds-field nds-topbar-field">
          <span className="lead" aria-hidden="true">
            <Search size={15} />
          </span>
          <input
            type="text"
            readOnly
            placeholder="Jump to anything…"
            aria-label="Search — opens the command palette"
            /*
             * 🔴 `onMouseDown` + preventDefault, NOT `onClick`/`onFocus`.
             *
             * The palette focuses its own input inside a `requestAnimationFrame` when it opens
             * (CommandPalette.tsx:917). A plain click opens the palette, the rAF moves focus into
             * it — and then the click's own default focus lands on THIS input afterwards and
             * takes it straight back. Measured: the palette was open with its input rendered and
             * unfocused, so every keystroke went nowhere. It looked completely correct.
             *
             * Preventing the default means this input never takes focus from a pointer at all,
             * so whatever the palette does with focus is final.
             */
            onMouseDown={(e) => {
              e.preventDefault()
              openCommandPalette()
            }}
            /* Still reachable by keyboard: Tab to it, Enter or Space opens the palette, and the
               palette's rAF then owns focus with no pointer event to fight. */
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openCommandPalette()
              }
            }}
          />
          <span className="nds-topbar-field-kbd" aria-hidden="true">
            <kbd className="nds-kbd">{isMac ? '⌘' : 'Ctrl'}</kbd>
            <kbd className="nds-kbd">K</kbd>
          </span>
        </span>
      </div>

      <div className="nds-topbar-utility">
        <ProfileSwitcher />
        <span className="nds-tdivider" aria-hidden="true" />
        <button
          type="button"
          className="nds-tbtn"
          onClick={cycleTheme}
          title={themeLabel}
          aria-label={themeLabel}
        >
          <ThemeIcon size={16} />
        </button>
        {/* The wrapper carries the chrome hook, so NotificationsBell itself stays a plain
            shared component with no knowledge of the surface it is placed on. */}
        <span className="nds-topbar-bell">
          <NotificationsBell />
        </span>
      </div>
    </header>
  )
}

export default AppTopBar
