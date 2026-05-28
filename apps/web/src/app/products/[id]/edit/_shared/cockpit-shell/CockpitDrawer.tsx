'use client'

// AF.1 — Shared slide-over drawer primitive.
//
// The Zone-4 "All fields" surface (and any future cockpit slide-over)
// opens through this. A right-anchored panel over a dim backdrop, with
// the accessibility basics wired: role="dialog" aria-modal, Escape to
// close, focus moved into the panel on open and restored to the trigger
// on close, and body-scroll lock while open.
//
// Channel-agnostic + content-agnostic: the body is a slot, so the same
// drawer hosts the grouped ChannelFieldEditor on Amazon and whatever
// eBay needs. Width is configurable because the long-tail field editor
// wants room (xl) while a lighter panel can be md.

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

type DrawerWidth = 'md' | 'lg' | 'xl' | 'full'

const WIDTH_CLASS: Record<DrawerWidth, string> = {
  md: 'w-full max-w-md',
  lg: 'w-full max-w-2xl',
  xl: 'w-full max-w-4xl',
  full: 'w-full max-w-6xl',
}

export interface CockpitDrawerProps {
  open: boolean
  onClose: () => void
  /** Header title node. */
  title: ReactNode
  /** Optional header controls (search, filters) rendered under the title. */
  toolbar?: ReactNode
  /** Optional sticky footer (actions). */
  footer?: ReactNode
  children: ReactNode
  width?: DrawerWidth
  /** aria-label when `title` is not a plain string. */
  ariaLabel?: string
  /** Keep children mounted while closed (slide off-screen instead of
   *  unmount). Use when the body owns dirty state / registered handlers
   *  that must survive close — e.g. the All-fields editor. Default false
   *  (unmount on close). */
  keepMounted?: boolean
}

export default function CockpitDrawer({
  open,
  onClose,
  title,
  toolbar,
  footer,
  children,
  width = 'xl',
  ariaLabel,
  keepMounted = false,
}: CockpitDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Keep the latest onClose in a ref so the focus/scroll effect can run
  // ONLY on open-state changes. Callers usually pass an inline arrow for
  // onClose (new identity every render); including it in the deps re-ran
  // this effect on every parent re-render (the cockpit re-renders
  // constantly from SSE/heartbeat), thrashing focus — which slammed shut
  // any native <select> the moment it was clicked.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return

    // Remember the trigger so focus returns there on close.
    restoreFocusRef.current = document.activeElement as HTMLElement | null

    // Move focus into the panel.
    const id = window.setTimeout(() => panelRef.current?.focus(), 0)

    // Lock body scroll.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      window.clearTimeout(id)
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
      // Restore focus to the trigger.
      restoreFocusRef.current?.focus?.()
    }
  }, [open])

  // Unmount-on-close only when not keepMounted. keepMounted slides the
  // panel off-screen (transform) so children stay mounted.
  if (!open && !keepMounted) return null

  return (
    <div
      className={cn('fixed inset-0 z-50 flex justify-end', !open && 'pointer-events-none')}
      role="presentation"
    >
      {/* Backdrop — only when open */}
      {open && (
        <div
          className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
          onClick={onClose}
          aria-hidden
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={open ? 'true' : undefined}
        aria-hidden={!open}
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : 'Drawer')}
        tabIndex={-1}
        className={cn(
          'relative flex h-full flex-col bg-white shadow-2xl outline-none dark:bg-slate-900',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
          WIDTH_CLASS[width],
        )}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </div>
            {toolbar && <div className="mt-2">{toolbar}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
