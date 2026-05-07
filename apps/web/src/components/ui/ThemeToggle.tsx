'use client'

import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme, type ThemeMode } from '@/lib/theme/use-theme'
import { cn } from '@/lib/utils'

/**
 * U.14 — three-state theme toggle. Cycles light → dark → system.
 * The icon reflects the current mode so the user can see at a glance
 * which mode is active. Tooltip + aria-label spell it out for
 * keyboard / screen-reader users.
 */

const ICON: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}

const NEXT_LABEL: Record<ThemeMode, string> = {
  light: 'Switch to dark mode',
  dark: 'Switch to system theme',
  system: 'Switch to light mode',
}

export function ThemeToggle({ className }: { className?: string }) {
  const { mode, cycleTheme } = useTheme()
  const Icon = ICON[mode]
  return (
    <button
      type="button"
      onClick={cycleTheme}
      title={NEXT_LABEL[mode]}
      aria-label={NEXT_LABEL[mode]}
      className={cn(
        'inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors',
        'dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        className,
      )}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}
