'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * U.14 — theme management hook.
 *
 * Tri-state: 'light' | 'dark' | 'system'. The 'system' mode tracks
 * the OS preference via prefers-color-scheme; explicit choices are
 * persisted to localStorage so they survive reloads.
 *
 * Applies / removes the `dark` class on <html> directly (Tailwind's
 * `darkMode: 'class'` config picks it up). The mutation runs in
 * useEffect so SSR sees no class — no hydration mismatch — and the
 * class is set on first client render.
 */

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'nexus:theme'

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  const v = window.localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyClass(isDark: boolean) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (isDark) root.classList.add('dark')
  else root.classList.remove('dark')
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>('system')

  // Hydrate from localStorage on mount (avoid SSR mismatch by deferring).
  useEffect(() => {
    setMode(readStoredTheme())
  }, [])

  // Apply the class whenever mode changes; for 'system', also subscribe
  // to OS preference changes so toggling dark mode at the OS level
  // updates the app live.
  useEffect(() => {
    const resolveDark = () => mode === 'dark' || (mode === 'system' && systemPrefersDark())
    applyClass(resolveDark())

    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyClass(resolveDark())
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  const setTheme = useCallback((next: ThemeMode) => {
    setMode(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }, [])

  // Convenience: cycle light → dark → system on each call.
  const cycleTheme = useCallback(() => {
    setMode((prev) => {
      const next: ThemeMode =
        prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light'
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, next)
      }
      return next
    })
  }, [])

  return { mode, setTheme, cycleTheme }
}
