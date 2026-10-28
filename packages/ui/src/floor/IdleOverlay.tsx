'use client'

/**
 * IdleOverlay + useIdleSignOut — a shared tablet signs its operator out when nobody touches it (gap G2, SCR-022,
 * A2 §3.1 "Sign-in": idle sign-out with a countdown overlay).
 *
 *   const idle = useIdleSignOut({ idleMs: 120_000, warnMs: 30_000, onSignOut: signOut })
 *   <IdleOverlay open={idle.warning} secondsLeft={idle.secondsLeft} onStay={idle.stay} title="Ci sei ancora?" … />
 *
 * - The hook listens for touches, keys and scans on the window and runs the countdown (`idleTimer.ts`). During the
 *   warning only "I am here" (`stay`) ends it: a stray touch does not.
 * - The overlay covers the screen (`contained`: only its frame — the catalogue), draws the seconds as a big numeral,
 *   and puts focus on the big "I am here" button, which is also the first and last stop of Tab. Escape means "I am
 *   here" too. A screen reader hears the title at once and the time at 60, 30 and 10 seconds — never every second.
 * - Every word comes from the app.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Hand, LogOut } from 'lucide-react'

import { countdownStep } from '../components/countdownTicker'
import { FloorButton } from './FloorButton'
import { createIdleTimer, type IdleSnapshot } from './idleTimer'
import './floor.css'

export interface IdleSignOutOptions {
  /** How long without a touch before the warning, ms. */
  idleMs: number
  /** How long the warning counts down, ms. */
  warnMs: number
  /** Runs once, when the countdown reaches zero. */
  onSignOut: () => void
  /** Default true. False: no timer at all (nobody signed in, a screen that must not time out). */
  enabled?: boolean
}

export interface IdleSignOut {
  /** The warning is showing. */
  warning: boolean
  /** Whole seconds left in the warning. */
  secondsLeft: number
  /** "I am here". */
  stay: () => void
}

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

const browserClock = {
  now: () => Date.now(),
  setTimeout: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
  clearTimeout: (h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
}

export function useIdleSignOut({ idleMs, warnMs, onSignOut, enabled = true }: IdleSignOutOptions): IdleSignOut {
  const [snap, setSnap] = useState<IdleSnapshot>({ phase: 'active', secondsLeft: 0 })
  const timer = useRef<ReturnType<typeof createIdleTimer> | null>(null)
  const signOut = useRef(onSignOut)
  signOut.current = onSignOut

  useEffect(() => {
    if (!enabled) return
    const t = createIdleTimer({ idleMs, warnMs, clock: browserClock, onChange: setSnap, onExpire: () => signOut.current() })
    timer.current = t
    setSnap(t.snapshot())
    const onActivity = () => t.activity()
    for (const type of ACTIVITY) window.addEventListener(type, onActivity, { capture: true, passive: true })
    return () => {
      for (const type of ACTIVITY) window.removeEventListener(type, onActivity, { capture: true })
      t.stop()
      timer.current = null
    }
  }, [enabled, idleMs, warnMs])

  const stay = useCallback(() => timer.current?.stay(), [])
  return { warning: enabled && snap.phase === 'warning', secondsLeft: snap.secondsLeft, stay }
}

export interface IdleOverlayProps {
  open: boolean
  secondsLeft: number
  /** "Ci sei ancora?" */
  title: string
  /** "Tra poco esci da questo tablet. Il lavoro salvato resta." */
  message?: string
  /** The words under the numeral and for a screen reader: (12) => "12 secondi". */
  secondsLabel: (seconds: number) => string
  /** "Sono qui" — the big button. */
  stayLabel: string
  onStay: () => void
  /** "Esci ora" — sign out at once. */
  signOutLabel?: string
  onSignOut?: () => void
  /** Cover only the nearest positioned ancestor (the frame), not the screen. */
  contained?: boolean
}

export function IdleOverlay({ open, secondsLeft, title, message, secondsLabel, stayLabel, onStay, signOutLabel, onSignOut, contained }: IdleOverlayProps) {
  const stayRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const returnTo = useRef<Element | null>(null)
  const titleId = useId()
  const messageId = useId()

  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement
    stayRef.current?.focus()
    return () => {
      const back = returnTo.current
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
  }, [open])

  // What a screen reader hears: the time at 60, 30 and 10 seconds only.
  const step = countdownStep(secondsLeft * 1000)
  const spoken = open && step !== null && step > 0 && secondsLeft === step ? secondsLabel(secondsLeft) : ''

  if (!open) return null

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onStay()
      return
    }
    if (e.key !== 'Tab') return
    const stops = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button') ?? [])
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="nds-floor-idle" data-contained={contained ? 'true' : 'false'} onKeyDown={onKeyDown}>
      <div ref={panelRef} className="nds-floor-idle-panel" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={message ? messageId : undefined}>
        <h2 id={titleId} className="nds-floor-idle-title">
          {title}
        </h2>
        <div className="nds-floor-idle-count" aria-hidden>
          <span className="nds-floor-idle-number">{Math.max(0, secondsLeft)}</span>
          <span className="nds-floor-idle-unit">{secondsLabel(Math.max(0, secondsLeft))}</span>
        </div>
        {message ? (
          <p id={messageId} className="nds-floor-idle-message">
            {message}
          </p>
        ) : null}
        <div className="nds-floor-idle-actions">
          {signOutLabel && onSignOut ? (
            <FloorButton size="md" variant="secondary" icon={<LogOut />} onClick={onSignOut}>
              {signOutLabel}
            </FloorButton>
          ) : null}
          <FloorButton ref={stayRef} size="lg" variant="primary" icon={<Hand />} onClick={onStay} className="nds-floor-idle-stay">
            {stayLabel}
          </FloorButton>
        </div>
        <span className="nds-floor-sr" aria-live="polite" aria-atomic="true">
          {spoken}
        </span>
      </div>
    </div>
  )
}
