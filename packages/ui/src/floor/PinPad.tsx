'use client'

/**
 * PinPad — six digits on big keys, for sign-in, sign-off and step-up on a shared tablet (gap G4, SCR-021, SCR-097;
 * the floor PIN variant of `StepUpModal`).
 *
 *   <PinPad label="PIN" enteredLabel={(n, t) => `${n} di ${t}`} clearLabel="Cancella" backLabel="Indietro"
 *           onSubmit={verify} locked={tries.locked} message={tries.message} messageTone="danger" />
 *
 * - 🔴 No digit is ever rendered, spoken or kept: dots only; a screen reader hears "3 di 6"; the digits live in a ref,
 *   go to `onSubmit` the moment the sixth is typed, and are cleared in the same step. There is no `<input>`, so no
 *   browser can autofill, remember or show the PIN.
 * - One fixed 3 × 4 layout (1–9, then Clear, 0, Back), keys sized by the density: on the floor tier 80 px with 8 mm
 *   between them; on comfortable 60 px.
 * - Keyboard: Tab reaches every key; digits, Backspace, and Escape or Delete work while focus is anywhere in the pad.
 *   `autoFocus` puts focus on the pad so a person can type at once.
 * - `locked` (too many tries) or `busy` (checking): every key is held — still focusable, announced as unavailable,
 *   inert — and a locked pad forgets what was typed. `message` says why, as an alert, in the tone given.
 * - Every word comes from the app.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Delete, X } from 'lucide-react'

import { PIN_LENGTH, PIN_PAD_ROWS, pinDots, pinKeyFromKeyboard, pinPress, type PinKey } from './pinPadModel'
import './floor.css'

export interface PinPadProps {
  /** The PIN, once all digits are typed. The pad is empty again by the time this runs. */
  onSubmit: (pin: string) => void
  /** The pad's name ("PIN", "Firma con il PIN"). */
  label: string
  /** Keep the name for screen readers only. */
  hideLabel?: boolean
  /** How many digits are typed, in words: (3, 6) => "3 di 6". Never the digits. */
  enteredLabel: (entered: number, total: number) => string
  /** "Cancella" — clears every digit. */
  clearLabel: string
  /** "Indietro" — removes the last digit. */
  backLabel: string
  /** Default 6. */
  length?: number
  /** Too many tries: every key held, the digits forgotten. */
  locked?: boolean
  /** The PIN is being checked: every key held. */
  busy?: boolean
  /** Why the pad is locked, or that the PIN was wrong. */
  message?: ReactNode
  messageTone?: 'danger' | 'warning' | 'info' | 'success'
  /** Focus the pad on mount. */
  autoFocus?: boolean
  id?: string
}

export function PinPad({
  onSubmit,
  label,
  hideLabel,
  enteredLabel,
  clearLabel,
  backLabel,
  length = PIN_LENGTH,
  locked = false,
  busy = false,
  message,
  messageTone = 'danger',
  autoFocus,
  id,
}: PinPadProps) {
  const digits = useRef('')
  const [entered, setEntered] = useState(0)
  const keysRef = useRef<HTMLDivElement>(null)
  const labelId = useId()
  const submit = useRef(onSubmit)
  submit.current = onSubmit
  const inert = locked || busy

  const press = useCallback(
    (key: PinKey) => {
      if (inert) return
      const r = pinPress(digits.current, key, length)
      digits.current = r.digits
      setEntered(r.digits.length)
      if (r.submit) submit.current(r.submit)
    },
    [inert, length],
  )

  // A locked pad, or one whose length changed, keeps nothing.
  useEffect(() => {
    if (!locked) return
    digits.current = ''
    setEntered(0)
  }, [locked])
  useEffect(() => {
    digits.current = ''
    setEntered(0)
  }, [length])

  useEffect(() => {
    if (autoFocus) keysRef.current?.focus({ preventScroll: true })
    // Mount only: a later prop change must not pull focus back.
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const key = pinKeyFromKeyboard(e.key)
    if (!key) return
    e.preventDefault()
    press(key)
  }

  const words = enteredLabel(entered, length)
  return (
    <div id={id} className="nds-floor-pin" data-locked={locked ? 'true' : 'false'} data-busy={busy ? 'true' : 'false'}>
      <div id={labelId} className={hideLabel ? 'nds-floor-sr' : 'nds-floor-pin-label'}>
        {label}
      </div>
      <div className="nds-floor-pin-dots" aria-hidden>
        {pinDots(entered, length).map((filled, i) => (
          <span key={i} className="nds-floor-pin-dot" data-filled={filled ? 'true' : 'false'} />
        ))}
      </div>
      <span className="nds-floor-sr" aria-live="polite" aria-atomic="true">
        {words}
      </span>
      {message ? (
        <p role="alert" className="nds-floor-pin-message" data-tone={messageTone}>
          {message}
        </p>
      ) : null}
      <div ref={keysRef} className="nds-floor-pin-keys" role="group" aria-labelledby={labelId} tabIndex={-1} onKeyDown={onKeyDown}>
        {PIN_PAD_ROWS.flat().map((key) => {
          const word = key === 'clear' ? clearLabel : key === 'back' ? backLabel : null
          return (
            <button
              key={key}
              type="button"
              className="nds-floor-pin-key"
              data-key={key}
              aria-disabled={inert || undefined}
              aria-label={word ?? undefined}
              onClick={() => press(key)}
            >
              {word ? (
                <>
                  <span className="nds-floor-icon" aria-hidden>
                    {key === 'clear' ? <X /> : <Delete />}
                  </span>
                  <span className="nds-floor-pin-key-word" aria-hidden>
                    {word}
                  </span>
                </>
              ) : (
                key
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
