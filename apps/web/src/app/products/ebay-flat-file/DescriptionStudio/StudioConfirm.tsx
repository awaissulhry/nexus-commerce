'use client'

/**
 * DS-6 — the Studio's OWN confirmation surface, rendered INSIDE the drawer.
 *
 * Why not the app-wide `useConfirm()`: it portals a z-50 Modal, and the DS
 * Drawer panel is z-61. Every confirm the Studio raised — discard unsaved
 * edits, delete theme, reload families, and the live-push gate — therefore
 * opened BEHIND the drawer. The operator saw a dead click; the dialog only
 * surfaced once the Studio was closed, by which point the drawer state that
 * gave it meaning was gone. (The z-order is fixed for the rest of the app in
 * ConfirmDialog; the Studio keeps its confirmations in-panel regardless, so
 * the push flow reads as one continuous surface.)
 *
 * Contract, matching the app confirm it replaces:
 *   • confirm(req) → Promise<boolean>, resolves false on cancel/Esc/supersede
 *     — it NEVER leaves a caller's await dangling;
 *   • Esc is intercepted in the CAPTURE phase so the Drawer's own Esc-to-close
 *     (and the Studio's ⌘S) can't fire while a confirmation is up;
 *   • `acknowledge` adds a required checkbox — used for the draft-copy gate,
 *     so putting unsigned-off legal copy on live listings takes a deliberate
 *     tick, not a reflex Enter.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/design-system/primitives/Button'
import { Checkbox } from '@/design-system/primitives/Checkbox'

export interface StudioConfirmRequest {
  title: string
  /** Rich body — rendered in a scrollable region, never clipped or truncated. */
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'warning'
  /** When set, Confirm stays disabled until this checkbox is ticked. */
  acknowledge?: string
  testId?: string
}

interface Pending extends StudioConfirmRequest {
  seq: number
}

export interface StudioConfirmApi {
  confirm: (req: StudioConfirmRequest) => Promise<boolean>
  /** The element to hand to <Drawer overlay={…}> — null when nothing is pending. */
  overlay: ReactNode | null
  /** A confirmation is on screen: block Esc-close, saves and background actions. */
  isOpen: boolean
  /** Resolve the pending confirmation as "cancelled" (Esc / drawer close attempt). */
  cancel: () => void
}

export function useStudioConfirm(): StudioConfirmApi {
  const [pending, setPending] = useState<Pending | null>(null)
  const resolverRef = useRef<((v: boolean) => void) | null>(null)
  const seqRef = useRef(0)

  const settle = useCallback((value: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setPending(null)
    resolve?.(value)
  }, [])

  const confirm = useCallback((req: StudioConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      // A second request while one is pending cancels the first rather than
      // orphaning its promise (the caller then simply does nothing).
      resolverRef.current?.(false)
      resolverRef.current = resolve
      seqRef.current += 1
      setPending({ ...req, seq: seqRef.current })
    })
  }, [])

  // Stable identities: the card's document-level key handler depends on
  // onCancel, so a fresh closure per render would re-subscribe every time.
  const cancel = useCallback(() => settle(false), [settle])
  const accept = useCallback(() => settle(true), [settle])

  return {
    confirm,
    isOpen: pending != null,
    cancel,
    overlay: pending
      ? <StudioConfirmCard key={pending.seq} req={pending} onCancel={cancel} onConfirm={accept} />
      : null,
  }
}

function StudioConfirmCard({ req, onCancel, onConfirm }: {
  req: StudioConfirmRequest
  onCancel: () => void
  onConfirm: () => void
}) {
  const [acked, setAcked] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const tone = req.tone ?? 'danger'

  // Focus Cancel first — an accidental Enter must never revise live listings.
  // (The DS Button is a plain function component, so the focus target is
  // reached through the card rather than a forwarded ref.)
  useEffect(() => {
    const t = setTimeout(
      () => cardRef.current?.querySelector<HTMLElement>('[data-studio-confirm-cancel]')?.focus(),
      30,
    )
    return () => clearTimeout(t)
  }, [])

  // Capture-phase keyboard ownership while a confirmation is up:
  //  - Esc cancels HERE and never reaches the Drawer's Esc-to-close;
  //  - ⌘S/Ctrl+S can't save the editor behind the card;
  //  - Tab cycles inside the card, so focus can't wander into the panel
  //    underneath and act on a control the operator can't even see.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.key !== 'Tab') return
      const root = cardRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey ? active === first || !root.contains(active) : active === last || !root.contains(active)) {
        e.preventDefault()
        e.stopPropagation()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const blocked = !!req.acknowledge && !acked

  return (
    <div
      ref={cardRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={req.title}
      data-testid={req.testId ?? 'studio-confirm'}
      className={cn(
        // Opaque in both themes — nothing behind this card may read through it.
        'w-full max-w-[760px] max-h-full flex flex-col rounded-lg shadow-2xl',
        'bg-white dark:bg-slate-900 border',
        tone === 'danger' ? 'border-red-300 dark:border-red-800' : 'border-amber-300 dark:border-amber-700',
      )}
    >
      <div className={cn(
        'shrink-0 flex items-start gap-2.5 px-4 py-3 border-b rounded-t-lg',
        tone === 'danger'
          ? 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40'
          : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40',
      )}>
        <AlertTriangle className={cn('w-5 h-5 shrink-0 mt-px',
          tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')} />
        <h2 className={cn('text-sm font-bold leading-5',
          tone === 'danger' ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200')}>
          {req.title}
        </h2>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-xs leading-5 text-slate-700 dark:text-slate-200">
        {req.body}
      </div>

      <div className="shrink-0 flex flex-wrap items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 rounded-b-lg">
        {req.acknowledge && (
          <Checkbox
            className="mr-auto"
            checked={acked}
            label={req.acknowledge}
            onChange={(e) => setAcked(e.target.checked)}
          />
        )}
        <Button size="sm" data-studio-confirm-cancel="" onClick={onCancel}>
          {req.cancelLabel ?? 'Cancel'}
        </Button>
        <Button
          size="sm"
          variant={tone === 'danger' ? 'danger' : 'primary'}
          disabled={blocked}
          title={blocked ? 'Tick the acknowledgement first' : undefined}
          onClick={onConfirm}
          data-testid="studio-confirm-accept"
        >
          {req.confirmLabel}
        </Button>
      </div>
    </div>
  )
}
