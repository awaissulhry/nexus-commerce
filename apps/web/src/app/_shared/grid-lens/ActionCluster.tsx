'use client'

/**
 * XG.2 — Shared row-actions cluster.
 *
 * Hoisted from /products/_components/GridView.tsx's EditSplitButton
 * (PG.8) so every VirtualizedGrid consumer can plug in the same
 * segmented control: [icon | icon | icon | label | ▾] with a
 * portal-rendered dropdown for the long-tail.
 *
 * Generic shape (XG.0 contract):
 *   - inlineActions[]   → icon-only buttons at the left of the cluster
 *   - primaryAction?    → text button with href or onClick
 *   - dropdownItems[]   → chevron menu (omit/empty → no chevron)
 *   - rowId             → identifier for Cmd+. event targeting
 *   - variant='cluster' → full segmented control (default)
 *   - variant='ghost'   → single chevron-only button (drawer-only workspaces)
 *
 * Destructive items can opt into inline confirmation by setting
 * `confirm: { question, confirmLabel }` — the menu item swaps into a
 * Yes / Cancel pair until the operator commits. Pattern lifted from
 * PG.8's delete-confirm flow; workspaces opt in per-item.
 *
 * Cmd+. shortcut: every cluster listens for `nexus:open-row-actions`
 * filtered by its rowId; the workspace's keydown handler dispatches
 * the event when the focused row matches. Replaces the older
 * /products-only `nexus:open-product-actions` name (renamed in XG.2).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

// Lucide's `LucideIcon` type accepts a broad set of SVG props; our
// usage only needs `size` + optional `className`. Typing as
// ComponentType<any> keeps callers free of generic wrangling while
// the JSX call sites stay explicit about what we pass.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionIcon = ComponentType<any>

export interface ActionDef {
  /** Stable id (used by React keys + the Cmd+. target). */
  id: string
  icon: ActionIcon
  /** ARIA label + native tooltip. */
  label: string
  /** Click handler. Returning a Promise is supported (await in caller). */
  onClick: () => void | Promise<void>
  disabled?: boolean
  /** Renders in a destructive (red) tone. Display only — doesn't gate
   *  the click handler; pair with `confirm` for a safety prompt. */
  destructive?: boolean
}

export interface MenuItemDef {
  id: string
  label: string
  icon?: ActionIcon
  /** Render as <Link> instead of <button>. */
  href?: string
  onClick?: () => void | Promise<void>
  disabled?: boolean
  destructive?: boolean
  /** Inline-confirm flow for destructive ops. When set, clicking
   *  swaps the row to a Yes / Cancel pair; Yes fires onClick. */
  confirm?: { question: string; confirmLabel: string; cancelLabel?: string }
  /** Insert a horizontal divider above this item. */
  dividerBefore?: boolean
}

export type ActionClusterVariant = 'cluster' | 'ghost'

export interface ActionClusterProps {
  /** Promoted inline icon-only buttons (0-3 typical). */
  inlineActions?: ActionDef[]
  /** Primary text-labelled action (e.g. Edit). Omit for drawer-only
   *  workspaces. When `href` is set, renders as Next <Link>; else
   *  renders as <button> with onClick. */
  primaryAction?: {
    label: string
    href?: string
    onClick?: () => void
  }
  /** Long-tail dropdown items. Empty/undefined → no chevron. */
  dropdownItems?: MenuItemDef[]
  /** Identifier for Cmd+. targeting. Workspace's keydown handler
   *  dispatches `nexus:open-row-actions` with this id; the cluster
   *  opens its dropdown when ids match. */
  rowId: string
  /** Single chevron-only button (no cluster). Useful for drawer-only
   *  workspaces like /pricing. Set `dropdownItems` for the menu;
   *  `primaryAction` + `inlineActions` are ignored. */
  variant?: ActionClusterVariant
  /** Override the chevron's title (defaults to "More actions (⌘ .)").  */
  moreActionsTitle?: string
  /** Override the chevron's aria-label (defaults to "More actions"). */
  moreActionsAriaLabel?: string
}

// Tailwind class fragments — pulled out so the JSX stays readable.
// PG.8 baseline; XG.3 adjusted to handle the "inline-only" cluster
// (no primary, no chevron — e.g. /stock's single-Eye affordance) by
// not assuming a primary/chevron sibling owns the right border. The
// `last:` classes only apply when this is the rightmost segment.
const INLINE_BTN_CLS =
  'h-7 w-7 inline-flex items-center justify-center bg-white dark:bg-slate-800 border-y border-l-0 first:border-l first:rounded-l-md border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

const INLINE_BTN_LAST_CLS = 'last:border-r last:rounded-r-md'

const PRIMARY_BTN_CLS =
  'h-7 px-3 text-sm font-medium bg-white dark:bg-slate-800 border-l-0 border-y border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 inline-flex items-center transition-colors'

const CHEVRON_BTN_CLS =
  'h-7 px-1.5 bg-white dark:bg-slate-800 border border-l-0 border-slate-300 dark:border-slate-600 rounded-r-md text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 inline-flex items-center transition-colors'

const CHEVRON_GHOST_BTN_CLS =
  'h-7 w-7 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors'

const ITEM_BTN_CLS =
  'w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2'

const ITEM_LINK_CLS =
  'block px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'

const ITEM_DESTRUCTIVE_CLS =
  'w-full text-left px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2'

export function ActionCluster({
  inlineActions,
  primaryAction,
  dropdownItems,
  rowId,
  variant = 'cluster',
  moreActionsTitle,
  moreActionsAriaLabel,
}: ActionClusterProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const chevronRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const hasDropdown = (dropdownItems?.length ?? 0) > 0

  // ── Outside-click + scroll → close menu ────────────────────────────
  useEffect(() => {
    if (!menuOpen) return
    const closeOnClick = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        chevronRef.current && !chevronRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false)
        setPendingConfirmId(null)
      }
    }
    const closeOnScroll = () => {
      setMenuOpen(false)
      setPendingConfirmId(null)
    }
    document.addEventListener('mousedown', closeOnClick)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      document.removeEventListener('mousedown', closeOnClick)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [menuOpen])

  // ── Cmd+. shortcut: open menu when workspace dispatches our id ──
  useEffect(() => {
    if (!hasDropdown) return
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { rowId?: string } | undefined
      if (!detail?.rowId || detail.rowId !== rowId) return
      const rect = chevronRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
      setMenuOpen(true)
      setPendingConfirmId(null)
    }
    window.addEventListener('nexus:open-row-actions', onOpen as EventListener)
    return () => window.removeEventListener('nexus:open-row-actions', onOpen as EventListener)
  }, [rowId, hasDropdown])

  const handleChevron = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (menuOpen) {
      setMenuOpen(false)
      setPendingConfirmId(null)
      return
    }
    const rect = chevronRef.current?.getBoundingClientRect()
    if (rect) {
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    setMenuOpen(true)
    setPendingConfirmId(null)
  }, [menuOpen])

  const runInline = useCallback(
    async (action: ActionDef, e: React.MouseEvent) => {
      e.stopPropagation()
      if (action.disabled || busyId === action.id) return
      setBusyId(action.id)
      try {
        await action.onClick()
      } finally {
        setBusyId(null)
      }
    },
    [busyId],
  )

  const runMenuItem = useCallback(
    async (item: MenuItemDef) => {
      if (item.disabled || !item.onClick) return
      if (item.confirm && pendingConfirmId !== item.id) {
        setPendingConfirmId(item.id)
        return
      }
      try {
        setBusyId(item.id)
        await item.onClick()
        setMenuOpen(false)
        setPendingConfirmId(null)
      } finally {
        setBusyId(null)
      }
    },
    [pendingConfirmId],
  )

  const dropdownMenu: ReactNode = useMemo(() => {
    if (!menuOpen || !menuPos || !hasDropdown) return null
    return createPortal(
      <div
        ref={menuRef}
        style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
        className="w-56 bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-md shadow-xl py-1 text-sm"
        role="menu"
      >
        {dropdownItems!.map((item, idx) => {
          const inConfirm = pendingConfirmId === item.id && !!item.confirm
          return (
            <div key={item.id}>
              {item.dividerBefore && idx > 0 && (
                <div className="border-t border-subtle dark:border-slate-800 my-1" />
              )}
              {inConfirm ? (
                <div className="px-3 py-1.5 space-y-1.5">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {item.confirm!.question}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busyId === item.id}
                      onClick={() => void runMenuItem(item)}
                      className="flex-1 text-xs h-6 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center justify-center gap-1"
                    >
                      {busyId === item.id && (
                        <span className="animate-spin inline-block w-3 h-3 border border-white border-t-transparent rounded-full" />
                      )}
                      {item.confirm!.confirmLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingConfirmId(null)}
                      className="flex-1 text-xs h-6 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      {item.confirm!.cancelLabel ?? 'Cancel'}
                    </button>
                  </div>
                </div>
              ) : item.href ? (
                <Link
                  href={item.href}
                  className={cn(
                    ITEM_LINK_CLS,
                    item.destructive && 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20',
                  )}
                  onClick={() => {
                    setMenuOpen(false)
                    setPendingConfirmId(null)
                  }}
                >
                  <span className="inline-flex items-center gap-2">
                    {item.icon && <item.icon size={14} className="flex-shrink-0" />}
                    {item.label}
                  </span>
                </Link>
              ) : (
                <button
                  type="button"
                  disabled={item.disabled || busyId === item.id}
                  onClick={() => void runMenuItem(item)}
                  className={item.destructive ? ITEM_DESTRUCTIVE_CLS : ITEM_BTN_CLS}
                  role="menuitem"
                >
                  {item.icon && <item.icon size={14} className="flex-shrink-0" />}
                  <span className="flex-1">{item.label}</span>
                </button>
              )}
            </div>
          )
        })}
      </div>,
      document.body,
    )
  }, [menuOpen, menuPos, hasDropdown, dropdownItems, pendingConfirmId, busyId, runMenuItem])

  // ── Ghost variant: single chevron-only button (drawer-only WS) ──
  if (variant === 'ghost') {
    return (
      <div className="inline-flex">
        <button
          ref={chevronRef}
          type="button"
          onClick={handleChevron}
          className={CHEVRON_GHOST_BTN_CLS}
          aria-label={moreActionsAriaLabel ?? 'More actions'}
          title={moreActionsTitle ?? 'More actions (⌘ .)'}
        >
          <ChevronDown size={14} />
        </button>
        {dropdownMenu}
      </div>
    )
  }

  // ── Cluster variant: full segmented control ─────────────────────
  // If neither primaryAction nor a chevron renders, the rightmost
  // inline button needs to close the cluster with its own right
  // border + rounded corner. The `last:` modifier handles the case
  // automatically since inline buttons are the last children.
  const inlineOnly = !primaryAction && !hasDropdown
  return (
    <div className="inline-flex rounded-md shadow-sm">
      {inlineActions?.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={(e) => void runInline(action, e)}
          disabled={action.disabled || busyId === action.id}
          className={cn(INLINE_BTN_CLS, inlineOnly && INLINE_BTN_LAST_CLS)}
          title={action.label}
          aria-label={action.label}
        >
          <action.icon size={13} />
        </button>
      ))}
      {primaryAction &&
        (primaryAction.href ? (
          <Link href={primaryAction.href} className={PRIMARY_BTN_CLS}>
            {primaryAction.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={primaryAction.onClick}
            className={PRIMARY_BTN_CLS}
          >
            {primaryAction.label}
          </button>
        ))}
      {hasDropdown && (
        <button
          ref={chevronRef}
          type="button"
          onClick={handleChevron}
          className={CHEVRON_BTN_CLS}
          aria-label={moreActionsAriaLabel ?? 'More actions'}
          title={moreActionsTitle ?? 'More actions (⌘ .)'}
        >
          <ChevronDown size={12} />
        </button>
      )}
      {dropdownMenu}
    </div>
  )
}
