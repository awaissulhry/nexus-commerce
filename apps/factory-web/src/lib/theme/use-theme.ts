'use client'

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { readCookie, writeCookie } from '../cookies'
import { THEME_COOKIE, isDark, nextThemeMode, type ThemeMode } from './theme'
import { createThemeStore } from './theme-store'

const QUERY = '(prefers-color-scheme: dark)'

function apply(mode: ThemeMode) {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia(QUERY).matches
  document.documentElement.classList.toggle('dark', isDark(mode, prefersDark))
}

/** The page's one theme state (theme-store.ts): the cookie, `<html>`'s class, and every control that shows it. */
const store = createThemeStore({ read: () => readCookie(THEME_COOKIE), write: (mode) => writeCookie(THEME_COOKIE, mode), apply })
const serverMode = (): ThemeMode => 'system'

/**
 * The person's theme on this device: read from the cookie, applied to `<html>`, followed live while it is "system".
 * Every caller shares one state, so the top bar's button and the profile's choice change together.
 */
export function useTheme() {
  // The server cannot read the browser's choice: it renders "system", then the browser's value follows.
  const mode = useSyncExternalStore(store.subscribe, store.get, serverMode)

  useEffect(() => {
    if (mode !== 'system') return
    const query = window.matchMedia(QUERY)
    const follow = () => apply('system')
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [mode])

  const setTheme = useCallback((next: ThemeMode) => store.set(next), [])
  const cycleTheme = useCallback(() => store.set(nextThemeMode(store.get())), [])

  return { mode, setTheme, cycleTheme }
}
