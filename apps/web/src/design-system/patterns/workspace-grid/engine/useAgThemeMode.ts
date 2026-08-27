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
    const read = () => setMode(root.classList.contains('dark') ? 'dark' : 'light')
    read()
    const mo = new MutationObserver(read)
    mo.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  return mode
}
