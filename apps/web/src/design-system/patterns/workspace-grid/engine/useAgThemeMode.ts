'use client'

/**
 * AG.4 — extracted from `AgWorkspaceGrid` so the feature lab reads the theme the same way the
 * parity wrapper does. A second copy of this would be a grid that stays light in dark mode on
 * exactly one of the two labs, which is the kind of difference nobody notices until a screenshot
 * goes out.
 *
 * AG Grid resolves its light/dark mode from a `data-ag-theme-mode` attribute, which has to be a
 * real attribute — it is read by the style system, not matched by a selector. The app's own dark
 * mode is the `dark` class on `<html>` (lib/theme/use-theme.ts), set by an effect and also
 * flipped by the OS listener, so this observes the class rather than re-deriving the preference.
 * Re-deriving it would give two answers whenever the two mechanisms disagreed.
 */
import { useEffect, useState } from 'react'

export function useAgThemeMode(): 'light' | 'dark' {
  const [mode, setMode] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const root = document.documentElement
    const read = () => {
      const next = root.classList.contains('dark') ? 'dark' : 'light'
      setMode(next)
      // Popups are parented to the document (see NexusGrid), outside the grid wrapper that
      // carries the mode for the theme's `browserColorScheme`. AG reads the attribute from any
      // ancestor, so the document root carries it too — measured: a body-level header menu had
      // no `data-ag-theme-mode` ancestor at all before this.
      root.setAttribute('data-ag-theme-mode', next)
    }
    read()
    const mo = new MutationObserver(read)
    mo.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  return mode
}
