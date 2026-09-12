'use client'

/**
 * PES.4 — the drawer's own confirmation surface, rendered INSIDE the panel.
 *
 * Not `useConfirm()`. The app's `ConfirmDialog` portals a Modal that sits below the drawer's
 * z-layer, so a confirmation raised from a drawer opens BEHIND it: the click looks dead, and the
 * dialog only surfaces once the drawer — and the state that gave the question meaning — is gone.
 * That was measured across four gates in the Description Studio (DS-6), which is where the DS
 * `Drawer`'s `overlay` slot came from. The CAPABILITY is re-derived here — a promise-based
 * confirm that renders inside the panel and owns the keyboard while it is up. No code from that
 * surface is imported, copied or reskinned (spec §2 decision 10): it is Tailwind, it carries a
 * ⌘S gate for a manual save this studio does not have, and the studio it belongs to is not this
 * one.
 *
 * It matters more here than there, because a DOCKED drawer makes the mistake worse: the surface
 * behind it is not merely visible, it is LIVE. A confirmation that failed to own the keyboard
 * would leave the operator able to keep typing into the sheet cell the question is about.
 *
 * Contract (identical to the app confirm it replaces):
 *   • confirm(req) → Promise<boolean>; resolves false on cancel, Esc, or being superseded — it
 *     never leaves a caller's await dangling;
 *   • Esc is intercepted in the CAPTURE phase, so the dock's Esc-to-close cannot fire underneath;
 *   • `acknowledge` adds a required checkbox, for copies that overwrite a value someone typed.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/design-system/primitives/Button'
import { Checkbox } from '@/design-system/primitives/Checkbox'
import { Input } from '@/design-system/primitives/Input'
import styles from './drawer.module.css'

export interface DrawerConfirmRequest {
  title: string
  /** Rich body — rendered in a scrollable region, never clipped or truncated. */
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'warning'
  /** When set, Confirm stays disabled until this checkbox is ticked. */
  acknowledge?: string
  /**
   * When set, Confirm stays disabled until this exact phrase is typed.
   *
   * Not a stronger `acknowledge`: a checkbox is one click and a phrase is a sentence the operator
   * has to READ to reproduce. The registry chooses this level from a PREFLIGHT (`ActionImpact`),
   * and `validateImpact` treats a typed confirm that quietly becomes a click as a bug rather than
   * leniency — so this exists to make refusing-to-downgrade possible.
   */
  requireTyped?: string
  testId?: string
}

export interface DrawerConfirmApi {
  confirm: (req: DrawerConfirmRequest) => Promise<boolean>
  /** Hand this to `<Drawer overlay={…}>` — null when nothing is pending. */
  overlay: ReactNode | null
  /** A confirmation is up: the caller must block its own Esc, saves and background actions. */
  isOpen: boolean
  cancel: () => void
}

interface Pending extends DrawerConfirmRequest {
  seq: number
}

export function useDrawerConfirm(): DrawerConfirmApi {
  const [pending, setPending] = useState<Pending | null>(null)
  const resolverRef = useRef<((v: boolean) => void) | null>(null)
  const seqRef = useRef(0)

  const settle = useCallback((value: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setPending(null)
    resolve?.(value)
  }, [])

  const confirm = useCallback((req: DrawerConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      // A second request while one is pending cancels the first rather than orphaning its
      // promise — the superseded caller then simply does nothing.
      resolverRef.current?.(false)
      resolverRef.current = resolve
      seqRef.current += 1
      setPending({ ...req, seq: seqRef.current })
    })
  }, [])

  const cancel = useCallback(() => settle(false), [settle])
  const accept = useCallback(() => settle(true), [settle])

  /**
   * Memoised, and not as tidiness — a fresh object literal here is a real bug (ruling #153, where
   * PES.2 hit the identical thing in `useActionPress`).
   *
   * The correct way to consume this hook is to depend on it, and `RestoreMode`'s `run` callback
   * does exactly that. Returning a new object every render made that `useCallback` rebuild on every
   * render — a memo that never caches, which is worse than no memo because it reads as though it
   * does. It also handed `Drawer` a new `overlay` element each time.
   *
   * Found by applying #153 to this lane's own hooks rather than stopping at "the substrate fix does
   * not touch my adapter" — which was true, and would have left this one standing.
   */
  return useMemo(
    () => ({
      confirm,
      isOpen: pending != null,
      cancel,
      overlay: pending ? <ConfirmCard key={pending.seq} req={pending} onCancel={cancel} onConfirm={accept} /> : null,
    }),
    [confirm, pending, cancel, accept],
  )
}

function ConfirmCard({
  req,
  onCancel,
  onConfirm,
}: {
  req: DrawerConfirmRequest
  onCancel: () => void
  onConfirm: () => void
}) {
  const [acked, setAcked] = useState(false)
  const [typed, setTyped] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)
  const tone = req.tone ?? 'danger'

  // Focus Cancel first — an accidental Enter must never overwrite a value across scopes.
  useEffect(() => {
    const t = setTimeout(() => cardRef.current?.querySelector<HTMLElement>('[data-confirm-cancel]')?.focus(), 30)
    return () => clearTimeout(t)
  }, [])

  /**
   * While this card is up it OWNS the keyboard, and it takes it in the capture phase so nothing
   * downstream gets a turn. Two things make that necessary here rather than optional:
   *
   *   Esc — the dock listens for it on `document` to close the record. Cancelling a confirmation
   *   must not also shut the panel whose state the question was about, so Esc is answered here
   *   and stopped. Capture at `document` runs before the dock's own document listener, so
   *   stopping propagation genuinely stops it.
   *
   *   Tab — a docked drawer sits beside a LIVE sheet. Without a cycle the next Tab walks straight
   *   out of the card into an editable grid cell behind a scrim, where the operator can type into
   *   a record while a question about it is still on screen. This is the one place in the drawer
   *   that traps focus, and it traps it because for as long as the card is up the rest genuinely
   *   is unavailable.
   */
  useEffect(() => {
    const focusablesIn = (root: HTMLElement) =>
      Array.from(
        root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null)

    const onKey = (e: KeyboardEvent) => {
      const root = cardRef.current
      if (!root) return

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return

      const items = focusablesIn(root)
      if (items.length === 0) return
      const edge = e.shiftKey ? items[0] : items[items.length - 1]
      const wrapTo = e.shiftKey ? items[items.length - 1] : items[0]
      const active = document.activeElement as HTMLElement | null

      // Two ways out of the card, and both wrap: off its last (or first) control, or from
      // somewhere outside it entirely — which is where focus starts if a click landed on the
      // scrim.
      if (active === edge || !root.contains(active)) {
        e.preventDefault()
        e.stopPropagation()
        wrapTo.focus()
      }
    }

    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  // Both gates, independently. A verb can require reading AND typing.
  const blocked = (!!req.acknowledge && !acked) || (!!req.requireTyped && typed.trim() !== req.requireTyped)

  return (
    <div
      ref={cardRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={req.title}
      data-testid={req.testId ?? 'drawer-confirm'}
      className={`${styles.confirmCard} ${tone === 'danger' ? styles.confirmDanger : styles.confirmWarning}`}
    >
      <div className={styles.confirmHead}>
        <AlertTriangle size={18} aria-hidden />
        <h2>{req.title}</h2>
      </div>

      {/* The scrollable region is the ONLY place unbounded content may go: a long body in a
          fixed header grows past the panel and paints over everything below it. */}
      <div className={styles.confirmBody}>{req.body}</div>

      <div className={styles.confirmFoot}>
        {req.requireTyped && (
          <label className={styles.confirmTyped}>
            <span>
              Type <strong>{req.requireTyped}</strong> to confirm
            </span>
            <Input
              size="sm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={`Type ${req.requireTyped} to confirm`}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        {req.acknowledge && (
          <Checkbox
            className={styles.confirmAck}
            checked={acked}
            label={req.acknowledge}
            onChange={(e) => setAcked(e.target.checked)}
          />
        )}
        <Button size="sm" data-confirm-cancel="" onClick={onCancel}>
          {req.cancelLabel ?? 'Cancel'}
        </Button>
        <Button
          size="sm"
          variant={tone === 'danger' ? 'danger' : 'primary'}
          disabled={blocked}
          // A disabled control must be able to say why it is disabled.
          title={
            blocked
              ? req.requireTyped && typed.trim() !== req.requireTyped
                ? `Type “${req.requireTyped}” exactly to continue`
                : `Tick “${req.acknowledge}” to continue`
              : undefined
          }
          onClick={onConfirm}
        >
          {req.confirmLabel}
        </Button>
      </div>
    </div>
  )
}
