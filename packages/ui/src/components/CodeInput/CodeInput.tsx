'use client'

/**
 * CodeInput — a one-time code of 6 digits (B-W2b-155, design part CodeInput): portal sign-in, step-up by e-mail,
 * approvals above a limit.
 *
 *   <CodeInput value={code} onChange={setCode} onComplete={check} label="Codice dall'e-mail" error={wrong}
 *              triesLeft={tries} resend={{ availableAt, onResend: sendAgain }} labels={ds.codeInput} />
 *
 * - ONE real input under the boxes (`autocomplete="one-time-code"`, numeric keyboard): the phone offers the code from the
 *   mail or the SMS, a password manager fills it, and a screen reader reads one field with its label, hint, tries left
 *   and error. The boxes are drawn from its value (`aria-hidden`).
 * - The whole code pastes at once: a pasted sentence gives its run of 6 digits ("Your code is 123 456").
 * - The last digit submits (`onComplete`, once per new full code) — no button to find on a phone.
 * - Tries left in words; held whole (`heldReason`: locked, offline) or while it checks (`busy`), with the words on screen,
 *   still focusable. A new code: the resend button waits for `availableAt` with a Countdown, then sends (`onResend`).
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { MailCheck } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { Spinner } from '../../primitives/Spinner'
import { Countdown } from '../Countdown'
import type { CountdownLabels } from '../CountdownLabels'
import { CODE_INPUT_LABELS, type CodeInputLabels } from './CodeInputLabels'
import { CODE_LENGTH, codeCells, codeCompletes, codeFromText, codeGapAfter, resendReady } from './codeInputModel'
import './codeInput.css'

export interface CodeInputResend {
  /** When a new code may be asked for (an ISO instant or epoch ms). Absent or past: now. */
  availableAt?: string | number | null
  onResend: () => void
  /** The new code is being sent. */
  busy?: boolean
  /** A new code was sent: says so under the button. */
  sent?: boolean
  /** Held with its reason (too many codes asked today). */
  heldReason?: string | null
}

export interface CodeInputProps {
  value: string
  /** The digits after every change (never more than `length`). */
  onChange: (code: string) => void
  /** The last digit was typed or a whole code pasted: submit it. Once per new full code. */
  onComplete?: (code: string) => void
  /** Digits in the code. Default 6. */
  length?: number
  /** The field's label ("Code from the e-mail"). Default "Code". */
  label?: string
  /** A line under the label ("We sent it to a•••@brand.example"). Default "6 digits. You can paste the whole code." */
  hint?: ReactNode
  /** The code was refused, in words ("That code is not right."). */
  error?: string | null
  /** Tries left after a wrong code; null or absent: not said. */
  triesLeft?: number | null
  /** Held whole, with its reason on screen ("Too many tries. Ask for a new code."). */
  heldReason?: string | null
  /** The code is being checked: held with "Checking the code…". */
  busy?: boolean
  resend?: CodeInputResend | null
  autoFocus?: boolean
  /** The input's name. Default "one-time-code". */
  name?: string
  id?: string
  className?: string
  labels?: Partial<CodeInputLabels>
  /** The resend Countdown's unit words. */
  countdownLabels?: Partial<CountdownLabels>
}

export function CodeInput({
  value, onChange, onComplete, length = CODE_LENGTH, label, hint, error, triesLeft, heldReason, busy = false, resend, autoFocus, name = 'one-time-code', id, className,
  labels, countdownLabels,
}: CodeInputProps) {
  const lw = mergeLabels(CODE_INPUT_LABELS, labels)
  const auto = useId()
  const inputId = id ?? `${auto}-code`
  const hintId = `${auto}-hint`
  const triesId = `${auto}-tries`
  const errorId = `${auto}-error`
  const heldId = `${auto}-held`
  const [focused, setFocused] = useState(false)
  const held = heldReason ?? null
  const blocked = held !== null || busy
  const cells = codeCells(value, length)
  const gap = codeGapAfter(length)
  const showTries = typeof triesLeft === 'number' && triesLeft >= 0 && held === null

  const take = (text: string) => {
    if (blocked) return
    const next = codeFromText(text, length)
    if (next === value) return
    onChange(next)
    if (codeCompletes(value, next, length)) onComplete?.(next)
  }

  const describedBy = [hintId, showTries ? triesId : null, error ? errorId : null, held ? heldId : null].filter(Boolean).join(' ')

  return (
    <div
      className={['nds-code', className].filter(Boolean).join(' ')}
      data-state={held ? 'held' : busy ? 'busy' : error ? 'error' : undefined}
      data-focused={focused ? 'true' : undefined}
    >
      <label className="nds-code-label" htmlFor={inputId}>
        {label ?? lw.label}
      </label>
      <p className="nds-code-hint" id={hintId}>
        {hint ?? lw.hint(length)}
      </p>
      <div className="nds-code-boxes">
        <div className="nds-code-cells" aria-hidden>
          {cells.map((cell, i) => (
            <span key={i} className="nds-code-cellwrap">
              <span className="nds-code-cell" data-filled={cell.digit ? 'true' : undefined} data-active={cell.active ? 'true' : undefined}>
                {cell.digit}
              </span>
              {gap !== null && i === gap - 1 ? <span className="nds-code-gap" /> : null}
            </span>
          ))}
        </div>
        <input
          id={inputId}
          name={name}
          className="nds-code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoFocus={autoFocus}
          value={value}
          readOnly={blocked}
          aria-disabled={blocked ? true : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          aria-busy={busy || undefined}
          onChange={(e) => take(e.currentTarget.value)}
          onPaste={(e) => {
            e.preventDefault()
            take(e.clipboardData.getData('text/plain'))
          }}
          onFocus={(e) => {
            setFocused(true)
            if (value.length >= length) e.currentTarget.select()
          }}
          onBlur={() => setFocused(false)}
        />
      </div>
      <div className="nds-code-lines">
        {busy && held === null ? (
          <p className="nds-code-line" role="status">
            <Spinner size={14} /> {lw.checking}
          </p>
        ) : null}
        {error ? (
          <p className="nds-code-line nds-code-error" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
        {showTries ? (
          <p className="nds-code-line nds-code-tries" id={triesId}>
            {lw.triesLeft(triesLeft as number)}
          </p>
        ) : null}
        {held ? (
          <p className="nds-code-line nds-code-held" id={heldId}>
            {held}
          </p>
        ) : null}
      </div>
      {resend ? <Resend resend={resend} labels={lw} countdownLabels={countdownLabels} /> : null}
    </div>
  )
}

function Resend({ resend, labels: lw, countdownLabels }: { resend: CodeInputResend; labels: CodeInputLabels; countdownLabels?: Partial<CountdownLabels> }) {
  const { availableAt, onResend, busy = false, sent = false, heldReason = null } = resend
  // Server and first render: the button waits when a time is given (no clock yet); the client decides at once.
  const [ready, setReady] = useState(() => availableAt === null || availableAt === undefined)
  useEffect(() => {
    setReady(resendReady(availableAt, Date.now()))
  }, [availableAt])
  return (
    <div className="nds-code-resend">
      {ready || availableAt === null || availableAt === undefined ? (
        <Button variant="link" heldReason={busy ? lw.resending : heldReason} onClick={onResend}>
          {busy ? <Spinner size={14} /> : null}
          {busy ? lw.resending : lw.resend}
        </Button>
      ) : (
        <span className="nds-code-wait">
          <Countdown to={availableAt} label={lw.resendIn} doneLabel="" onDone={() => setReady(true)} announce={false} labels={countdownLabels} />
        </span>
      )}
      {sent && !busy ? (
        <p className="nds-code-line nds-code-sent" role="status">
          <MailCheck size={16} aria-hidden /> {lw.resent}
        </p>
      ) : null}
    </div>
  )
}
