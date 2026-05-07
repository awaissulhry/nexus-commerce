'use client'

/**
 * Modal — canonical overlay primitive.
 *
 * Replaces 28+ inline `<div className="fixed inset-0 ...">` overlays
 * scattered across the app. Each of those re-invented backdrop
 * opacity, escape handling, click-outside, focus management, and z-
 * index — and they all drift apart over time.
 *
 * One component fixes:
 *   - Backdrop opacity + blur consistent across the app.
 *   - Escape key dismissal (configurable).
 *   - Click-outside dismissal (configurable; pass dismissOnBackdrop=false
 *     for save-confirm dialogs that shouldn't close on accidental click).
 *   - Body scroll lock while open (no more "scroll the page behind a
 *     modal" weirdness).
 *   - Focus management: first focusable child auto-focused on open;
 *     focus returns to the previously-focused element on close.
 *   - Three placements: 'centered' (default), 'top' (cmd-palette
 *     style with a 12vh top offset), 'drawer-right' (side panel like
 *     ProductDrawer).
 *   - Six size presets: sm 384px / md 448px / lg 512px / xl 640px /
 *     2xl 768px / 3xl 1024px. Drawer-right uses 640px max regardless.
 *
 * Usage:
 *   <Modal open={open} onClose={close} title="Confirm" size="md">
 *     body content
 *     <ModalFooter>
 *       <Button onClick={close}>Cancel</Button>
 *       <Button variant="primary" onClick={save}>Save</Button>
 *     </ModalFooter>
 *   </Modal>
 *
 * The `title` prop renders a default header strip with a close X.
 * Pass `header={null}` to skip it (e.g. for command-palette modals
 * where the input itself is the header).
 */

import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type MouseEvent,
} from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ModalPlacement = 'centered' | 'top' | 'drawer-right'
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
}

interface ModalProps {
  open: boolean
  onClose: () => void
  /** Render a default header with title + close button. Pass null to
   *  skip the header entirely (command-palette pattern). */
  title?: ReactNode
  /** Optional one-line subtitle below the title. */
  description?: ReactNode
  /** Override the default header. Takes precedence over title. */
  header?: ReactNode | null
  size?: ModalSize
  placement?: ModalPlacement
  /** When false, click on backdrop does nothing. Default true. */
  dismissOnBackdrop?: boolean
  /** When false, Escape does nothing. Default true. */
  dismissOnEscape?: boolean
  /** Extra class for the inner panel. */
  className?: string
  children: ReactNode
}

export function Modal({
  open,
  onClose,
  title,
  description,
  header,
  size = 'md',
  placement = 'centered',
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  className,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Focus management: capture the trigger element on open, restore
  // focus on close. First focusable child gets focus when the panel
  // mounts so keyboard users land somewhere usable.
  useEffect(() => {
    if (!open) return
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null

    // Defer to allow the modal to mount + render its children.
    const handle = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
      )
      first?.focus()
    }, 10)
    return () => {
      window.clearTimeout(handle)
      previouslyFocused.current?.focus?.()
    }
  }, [open])

  // Escape key.
  useEffect(() => {
    if (!open || !dismissOnEscape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dismissOnEscape, onClose])

  // Body scroll lock. Restored when the modal closes (or unmounts
  // mid-scroll-lock, which can happen on route change).
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  const onBackdropMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      // Close only when the mousedown originated on the backdrop
      // itself, not bubbled from inside the panel. Prevents the
      // "drag-selecting text inside the modal closes it" annoyance.
      if (!dismissOnBackdrop) return
      if (e.target === e.currentTarget) onClose()
    },
    [dismissOnBackdrop, onClose],
  )

  if (!open) return null

  const isDrawer = placement === 'drawer-right'
  // U.12 — outer padding tightens on mobile so the modal fills more
  // of a narrow viewport. p-2 (8px gutter) → p-4 (16px) at sm.
  // Top placement uses pt-[8vh] on mobile for higher real estate.
  const justify =
    placement === 'centered'
      ? 'items-center justify-center p-2 sm:p-4'
      : placement === 'top'
        ? 'items-start justify-center pt-[8vh] sm:pt-[12vh] p-2 sm:p-4'
        : 'items-stretch justify-end'

  // U.12 — mobile parity:
  //   - centered: max-h uses dvh (dynamic viewport height) so iOS
  //     Safari's URL-bar resize doesn't clip content. Falls back to
  //     vh on browsers without dvh support (every modern engine has
  //     it as of 2024 — Safari 15.4+, Chrome 108+, Firefox 101+).
  //   - drawer-right: full-width on mobile (no max-w cap), slides
  //     in as a full-screen sheet; flips back to a 640px right panel
  //     at sm and above. The mobile sheet still keeps the right-side
  //     border for visual continuity but it sits flush.
  const panelBase = isDrawer
    ? 'h-full w-full sm:max-w-[640px] bg-white dark:bg-slate-900 shadow-2xl sm:border-l border-slate-200 dark:border-slate-800 flex flex-col'
    : `w-full ${SIZE_CLASS[size]} bg-white dark:bg-slate-900 rounded-lg shadow-xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[85dvh] sm:max-h-[90vh]`

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
      onMouseDown={onBackdropMouseDown}
      className={cn(
        // U.16 — backdrop fades in to soften the focus shift away
        // from the underlying page.
        'fixed inset-0 z-50 flex bg-slate-900/40 backdrop-blur-[1px] animate-fade-in',
        justify,
      )}
    >
      <div
        ref={panelRef}
        // Stop bubbling so a click inside the panel never reaches the
        // backdrop's onClick.
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          panelBase,
          // U.16 — panel scales in (centered) or slides in from the
          // right (drawer). Honors `prefers-reduced-motion` via the
          // `motion-reduce:animate-none` utility.
          isDrawer ? 'animate-slide-from-right' : 'animate-scale-in',
          'motion-reduce:animate-none',
          className,
        )}
      >
        {header !== null && (header ?? renderDefaultHeader(title, description, onClose))}
        {children}
      </div>
    </div>
  )
}

function renderDefaultHeader(
  title: ReactNode | undefined,
  description: ReactNode | undefined,
  onClose: () => void,
): ReactNode {
  if (!title) return null
  return (
    <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-3 flex-shrink-0">
      <div className="min-w-0">
        <div
          id="modal-title"
          className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate"
        >
          {title}
        </div>
        {description && (
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

/**
 * ModalBody — opt-in scroll container for long modal bodies. Use when
 * the body content overflows the modal's max-height; it adds the
 * overflow-y + padding the manual implementations have been doing
 * inline.
 */
export function ModalBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex-1 overflow-y-auto p-5', className)}>{children}</div>
  )
}

/**
 * ModalFooter — sticky-bottom action bar. Use for the cancel/save
 * button row that 95% of modals need.
 */
export function ModalFooter({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'px-5 py-3 border-t border-slate-100 flex items-center justify-end gap-2 flex-shrink-0',
        className,
      )}
    >
      {children}
    </div>
  )
}
