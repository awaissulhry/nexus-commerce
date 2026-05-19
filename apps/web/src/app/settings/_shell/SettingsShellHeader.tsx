'use client'

/**
 * Settings rebuild — Phase A.2
 *
 * Sticky header for every settings page. Renders:
 *   - The breadcrumb (Settings > Group > Page > [extra])
 *   - The page title + description (drawn from settings-nav)
 *   - The Cmd+K affordance ("Find a setting")
 *
 * Sub-pages should NOT render their own PageHeader anymore — this
 * one replaces them. Pages can still surface their own toolbar
 * underneath the header for page-specific controls.
 *
 * Phase A keeps backwards-compat by letting sub-pages render their
 * own headers if they want; we'll migrate them off in subsequent
 * phases. The shell header always renders, so during migration
 * some pages will briefly show two — that's intentional, makes
 * the migration progress visible.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight, Search } from 'lucide-react'
import { SettingsRailMobileTrigger } from './SettingsRail'
import {
  findGroupForPath,
  findNavItemForPath,
} from './settings-nav'
import { useSettingsPalette } from './SettingsPaletteContext'

export function SettingsShellHeader() {
  const pathname = usePathname() ?? '/settings'
  const item = findNavItemForPath(pathname)
  const group = findGroupForPath(pathname)
  const { open: openPalette } = useSettingsPalette()

  return (
    <header className="sticky top-0 z-20 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800">
      <div className="px-4 sm:px-6 py-3 flex items-center gap-3">
        <SettingsRailMobileTrigger />

        <div className="flex-1 min-w-0">
          {/* Breadcrumb — small, muted; the title below carries weight. */}
          <nav
            aria-label="Breadcrumb"
            className="flex items-center text-xs text-slate-500 dark:text-slate-400 mb-0.5"
          >
            <Link
              href="/settings"
              className="hover:text-slate-700 dark:hover:text-slate-200"
            >
              Settings
            </Link>
            {group && (
              <>
                <ChevronRight size={12} className="mx-1 opacity-50" />
                <span>{group.label}</span>
              </>
            )}
            {item && (
              <>
                <ChevronRight size={12} className="mx-1 opacity-50" />
                <Link
                  href={item.href}
                  className="hover:text-slate-700 dark:hover:text-slate-200"
                >
                  {item.label}
                </Link>
              </>
            )}
          </nav>

          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 truncate">
              {item?.label ?? 'Settings'}
            </h1>
            {item?.description && (
              <p className="text-sm text-slate-500 dark:text-slate-400 truncate hidden md:block">
                {item.description}
              </p>
            )}
          </div>
        </div>

        {/* Find a setting — Cmd+K trigger. Mirrors the global pattern
            so the palette is discoverable on every settings page. */}
        <button
          type="button"
          onClick={openPalette}
          className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          aria-label="Open settings command palette"
        >
          <Search size={14} />
          <span className="hidden sm:inline">Find a setting…</span>
          <kbd className="hidden sm:inline-flex items-center h-5 px-1.5 rounded bg-slate-100 dark:bg-slate-800 text-xs font-mono text-slate-500 dark:text-slate-400">
            ⌘K
          </kbd>
        </button>
      </div>
    </header>
  )
}
