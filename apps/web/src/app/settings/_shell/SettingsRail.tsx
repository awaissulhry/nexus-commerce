'use client'

/**
 * Settings rebuild — Phase A.2
 *
 * Left-rail navigation for the settings shell. Renders SETTINGS_NAV
 * groups vertically, with active-state highlighting that matches
 * findNavItemForPath() — so /settings/pim/families/abc123 still
 * highlights the "Product families" entry.
 *
 * Split into two components so each can live in its natural place
 * in the layout tree:
 *   - <SettingsRail>          the panel itself (column on desktop,
 *                             off-canvas drawer on mobile)
 *   - <SettingsRailMobileTrigger>  the burger button, rendered
 *                                  inside the shell header so it
 *                                  sits visually with the title.
 *
 * Mobile open-state is shared between them via a tiny zustand-style
 * external store. Avoids prop-drilling through the layout boundary.
 */

import { useEffect, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SETTINGS_NAV, findNavItemForPath } from './settings-nav'

// ─── tiny mobile-open store ──────────────────────────────────────
// useSyncExternalStore avoids a Context+Provider layer for one
// boolean. The rail + trigger both subscribe; toggling the boolean
// re-renders both.
let mobileOpen = false
const listeners = new Set<() => void>()
function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function getSnapshot() {
  return mobileOpen
}
function setMobileOpen(next: boolean) {
  if (mobileOpen === next) return
  mobileOpen = next
  listeners.forEach((fn) => fn())
}

export function SettingsRailMobileTrigger() {
  const open = useSyncExternalStore(subscribe, getSnapshot, () => false)
  if (open) return null
  return (
    <button
      type="button"
      onClick={() => setMobileOpen(true)}
      className="lg:hidden inline-flex items-center justify-center h-9 w-9 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      aria-label="Open settings navigation"
    >
      <Menu size={16} />
    </button>
  )
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  beta: {
    label: 'Beta',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  },
  soon: {
    label: 'Soon',
    cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  },
}

export function SettingsRail() {
  const pathname = usePathname() ?? '/settings'
  const activeItem = findNavItemForPath(pathname)
  const open = useSyncExternalStore(subscribe, getSnapshot, () => false)

  // Close the mobile sheet when the route changes — without this the
  // overlay stays open after navigating, which on small screens hides
  // the page the user just asked for.
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  return (
    <>
      {/* Backdrop — only on mobile when open. */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          'shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800',
          // Desktop: persistent left rail. lg breakpoint = 1024px.
          'lg:block lg:w-64 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto',
          // Mobile: off-canvas drawer.
          open
            ? 'fixed inset-y-0 left-0 z-50 w-72 overflow-y-auto shadow-xl'
            : 'hidden',
        )}
        aria-label="Settings navigation"
      >
        <div className="px-4 py-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 lg:border-b-0">
          <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Settings
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="lg:hidden inline-flex items-center justify-center h-7 w-7 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close settings navigation"
          >
            <X size={14} />
          </button>
        </div>

        <nav className="px-2 pb-6">
          {SETTINGS_NAV.map((group) => (
            <div key={group.label} className="mt-4 first:mt-2">
              <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {group.label}
              </div>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = activeItem?.href === item.href
                  const Icon = item.icon
                  const badge = item.status ? STATUS_BADGE[item.status] : null
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        prefetch={false}
                        className={cn(
                          'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                          isActive
                            ? 'bg-blue-50 text-blue-700 font-medium dark:bg-blue-950/40 dark:text-blue-300'
                            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                        )}
                        aria-current={isActive ? 'page' : undefined}
                      >
                        <Icon
                          size={15}
                          className={cn(
                            isActive
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-slate-400 dark:text-slate-500',
                          )}
                        />
                        <span className="flex-1 truncate">{item.label}</span>
                        {badge && (
                          <span
                            className={cn(
                              'text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded',
                              badge.cls,
                            )}
                          >
                            {badge.label}
                          </span>
                        )}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  )
}
