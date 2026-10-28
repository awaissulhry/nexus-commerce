'use client'

import { useCallback, useEffect, useState } from 'react'
import { writeCookie, readCookie } from '../cookies'
import { THEME_COOKIE, isDark, nextThemeMode, themeModeOf, type ThemeMode } from './theme'

const QUERY = '(prefers-color-scheme: dark)'

function apply(mode: ThemeMode) {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia(QUERY).matches
  document.documentElement.classList.toggle('dark', isDark(mode, prefersDark))
}

/** The person's theme: read from the cookie, applied to `<html>`, followed live while it is "system". */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>('system')

  useEffect(() => {
    setMode(themeModeOf(readCookie(THEME_COOKIE)))
  }, [])

  useEffect(() => {
    if (mode !== 'system') return
    const query = window.matchMedia(QUERY)
    const follow = () => apply('system')
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [mode])

  const setTheme = useCallback((next: ThemeMode) => {
    writeCookie(THEME_COOKIE, next)
    apply(next)
    setMode(next)
  }, [])

  const cycleTheme = useCallback(() => setTheme(nextThemeMode(mode)), [mode, setTheme])

  return { mode, setTheme, cycleTheme }
}
