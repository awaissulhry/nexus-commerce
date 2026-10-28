'use client'

/**
 * QuantityPad — a count on the floor (gap G6, SCR-090, 092, 094): a big number, − and + the size of the main action, a
 * digit pad, quick values, and an optional Confirm. The floor size of `NumberStepper`, with no keyboard ever opening.
 *
 *   <QuantityPad label="Buoni" unit="pezzi" value={good} onChange={setGood} min={0} max={bundle.qty}
 *                expected={bundle.qty} expectedLabel={(n) => `Attesi ${n}`} quickValues={[{ value: bundle.qty, label: 'Tutti' }]}
 *                decrementLabel="Meno" incrementLabel="Più" clearLabel="Cancella" backLabel="Indietro"
 *                emptyLabel="Scrivi una quantità" rangeLabel={(min, max) => `Da ${min} a ${max}`}
 *                confirmLabel="Conferma" onConfirm={save} />
 *
 * - **One tap for the usual case** (MES-090): give the default as `value` (the bundle quantity). It is shown in full and
 *   the first digit typed replaces it, so 2, 2 makes 22, not 2422 (`quantityPadModel.ts`).
 * - **Bounds**: a digit that would pass `max` is refused — the number stays, the pad flashes amber with a buzz
 *   (`useConfirmFeedback`, muted with the frame) and says `rangeLabel`. Under `min` may be typed on the way (1 → 15);
 *   Confirm is held until the number is in range. − and + stop at the bounds, held with the same words.
 * - **Decimals** (`decimals`, e.g. a hide's area): the separator key takes Clear's place; Clear moves beside the quick
 *   values. The app's separator (`decimalSeparator`, "," in Italian) is shown; `.` and `,` on a keyboard both type it.
 * - **Keys**: the PIN pad's own keys (`.nds-floor-pin-key*`: 80 px with 8 mm between them on the floor tier), so a worker
 *   who knows one pad knows the other. The big number is a spin button: Tab reaches it; ↑ ↓ step, Page ↑ ↓ step ten,
 *   Home / End go to min / max, Enter confirms. Digits, the separator, Backspace and Escape work with focus anywhere in
 *   the pad (Escape clears, and a second Escape on an empty pad is left to a dialog around it).
 * - **Layout by its own width**: from 40 rem the number and its buttons sit beside the pad (a landscape tablet keeps
 *   everything above the action bar); narrower, they stack, and the keys shrink on a phone as the PIN pad's do.
 * - Confirm here, or in the screen's `FloorActionBar`: then leave `onConfirm` out and hold that action with
 *   `qtyHeldReason(value, bounds, words)`, the same rule this pad uses.
 * - Every word comes from the app.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Delete, Minus, Plus, X } from 'lucide-react'

import { useConfirmFeedback } from '../FloorFrame'
import { FloorButton } from '../FloorButton'
import {
  qtyCanStep,
  qtyDisplayText,
  qtyEntry,
  qtyFromText,
  qtyHeldReason,
  qtyInRange,
  qtyKeyFromKeyboard,
  qtyPadRows,
  qtyPress,
  qtyStep,
  type QtyBounds,
  type QtyEntry,
  type QtyKey,
} from './quantityPadModel'
import '../floor.css'
import './quantityPad.css'

/** A quick value with its own words ("Tutti 24"). A bare number is shown as the number. */
export interface QtyQuickValue {
  value: number
  label: string
}

export interface QuantityPadProps extends QtyBounds {
  /** The quantity's name ("Buoni", "Scarti", "Area"). */
  label: string
  /** Keep the name for screen readers only. */
  hideLabel?: boolean
  /** The number shown; `null` when nothing is typed. The default goes here (it is replaced by the first digit). */
  value: number | null
  onChange: (value: number | null) => void
  /** A short unit after the number ("pezzi", "m²"). */
  unit?: string
  /** The number expected, shown beside the name (A2 §3.1: "the expected number shown next to the field"). */
  expected?: number
  /** (24) => "Attesi 24". */
  expectedLabel?: (expected: number) => string
  /** Buttons that set a number in one tap ("Tutti", 0, 12). */
  quickValues?: readonly (number | QtyQuickValue)[]
  /** The separator the person reads. Default ".". */
  decimalSeparator?: string
  /** The separator key's name for a screen reader ("Virgola"). Default: the separator. */
  separatorLabel?: string
  /** "Meno" — the − button. */
  decrementLabel: string
  /** "Più" — the + button. */
  incrementLabel: string
  /** "Cancella" — clears the number. */
  clearLabel: string
  /** "Indietro" — removes the last digit. */
  backLabel: string
  /** Why Confirm is held with nothing typed ("Scrivi una quantità"); read on the empty number too. */
  emptyLabel: string
  /** The range in words ("Da 0 a 24"): said when a digit is refused, and why Confirm or a stepper is held. */
  rangeLabel: (min: number | undefined, max: number | undefined) => string
  /** The pad's own Confirm (the main action, under the number). Leave out to confirm from the action bar. */
  onConfirm?: (value: number) => void
  confirmLabel?: string
  /** Default: a tick. */
  confirmIcon?: ReactNode
  /** Why Confirm cannot run besides the number (sending, no bundle scanned). */
  confirmHeldReason?: string | null
  /** The digit pad. Default true; false leaves − and + and the quick values. */
  showPad?: boolean
  /** A line under the number from the app (a server refusal, a hint). */
  message?: ReactNode
  messageTone?: 'danger' | 'warning' | 'info' | 'success'
  /** Focus the number on mount. */
  autoFocus?: boolean
  id?: string
}

const quick = (q: number | QtyQuickValue): QtyQuickValue => (typeof q === 'number' ? { value: q, label: String(q) } : q)

export function QuantityPad({
  label,
  hideLabel,
  value,
  onChange,
  min,
  max,
  step,
  decimals = 0,
  unit,
  expected,
  expectedLabel,
  quickValues,
  decimalSeparator = '.',
  separatorLabel,
  decrementLabel,
  incrementLabel,
  clearLabel,
  backLabel,
  emptyLabel,
  rangeLabel,
  onConfirm,
  confirmLabel,
  confirmIcon,
  confirmHeldReason,
  showPad = true,
  message,
  messageTone = 'warning',
  autoFocus,
  id,
}: QuantityPadProps) {
  const bounds: QtyBounds = { min, max, step, decimals }
  const [entry, setEntryState] = useState<QtyEntry>(() => qtyEntry(value, decimals))
  const entryRef = useRef(entry)
  const setEntry = (next: QtyEntry) => {
    entryRef.current = next
    setEntryState(next)
  }
  // A digit refused for passing `max` says the range until the next press; other refusals only flash.
  const [overMax, setOverMax] = useState(false)
  const [said, setSaid] = useState('')
  const displayRef = useRef<HTMLDivElement>(null)
  const feedback = useConfirmFeedback()
  const labelId = useId()
  const noticeId = useId()

  // A value from outside (a reset after Confirm, a new bundle) replaces the text; our own value coming back does not.
  useEffect(() => {
    if ((value ?? null) !== qtyFromText(entryRef.current.text)) setEntry(qtyEntry(value, decimals))
  }, [value, decimals])

  useEffect(() => {
    if (autoFocus) displayRef.current?.focus({ preventScroll: true })
    // Mount only: a later prop change must not pull focus back.
  }, [])

  const current = qtyFromText(entry.text)
  const inRange = qtyInRange(current, bounds)
  const range = rangeLabel(min, max)
  const shown = qtyDisplayText(entry.text, decimalSeparator)
  const valueText = current == null ? emptyLabel : unit ? `${shown} ${unit}` : shown

  // Every change goes through here: the text, the number handed on, and (for a press on a button) the words said.
  const commit = (next: QtyEntry, announce: boolean) => {
    setEntry(next)
    setOverMax(false)
    const n = qtyFromText(next.text)
    if (announce) {
      const words = qtyDisplayText(next.text, decimalSeparator)
      setSaid(n == null ? emptyLabel : unit ? `${words} ${unit}` : words)
    }
    onChange(n)
  }

  const press = (key: QtyKey, announce: boolean) => {
    const r = qtyPress(entryRef.current, key, bounds)
    if (r.refused) {
      setOverMax(r.refused === 'max')
      if (announce) setSaid(r.refused === 'max' ? range : valueText)
      feedback('warning', displayRef.current)
      return
    }
    commit(r.entry, announce)
  }

  const stepBy = (direction: 1 | -1, times: number, announce: boolean) => {
    const next = qtyStep(qtyFromText(entryRef.current.text), direction, bounds, times)
    commit(qtyEntry(next, decimals), announce)
  }

  const goTo = (n: number | undefined, announce: boolean) => {
    if (n == null) return
    commit(qtyEntry(n, decimals), announce)
  }

  const held = confirmHeldReason || qtyHeldReason(current, bounds, { emptyLabel, rangeLabel })
  const confirm = () => {
    if (!onConfirm || held || current == null) return
    // Confirmed: the number is no longer being typed, so the next digit starts a new one (also when the app keeps it).
    setEntry(qtyEntry(current, decimals))
    onConfirm(current)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const action = qtyKeyFromKeyboard(e.key, decimals)
    if (!action) return
    const onNumber = e.target === displayRef.current
    switch (action) {
      case 'confirm':
        // Enter on a button presses that button.
        if (!onNumber) return
        e.preventDefault()
        confirm()
        return
      case 'clear':
        // An empty pad lets Escape through, to a dialog around it.
        if (entryRef.current.text === '' && e.key === 'Escape') return
        e.preventDefault()
        press('clear', !onNumber)
        return
      case 'up':
      case 'down':
        e.preventDefault()
        stepBy(action === 'up' ? 1 : -1, 1, !onNumber)
        return
      case 'up10':
      case 'down10':
        e.preventDefault()
        stepBy(action === 'up10' ? 1 : -1, 10, !onNumber)
        return
      case 'first':
      case 'last':
        if (!onNumber) return
        e.preventDefault()
        goTo(action === 'first' ? min : max, false)
        return
      default:
        e.preventDefault()
        press(action, !onNumber)
    }
  }

  const notice = message ?? (overMax || (current != null && !inRange) ? range : null)
  const noticeTone = message ? messageTone : 'warning'
  const quicks = (quickValues ?? []).map(quick)
  const clearBeside = showPad && decimals > 0

  return (
    <div id={id} className="nds-floor-qty" role="group" aria-labelledby={labelId} onKeyDown={onKeyDown}>
      <div className="nds-floor-qty-body" data-pad={showPad ? 'true' : 'false'}>
        <div className="nds-floor-qty-main">
          <div className="nds-floor-qty-head">
            <span id={labelId} className={hideLabel ? 'nds-floor-sr' : 'nds-floor-qty-label'}>
              {label}
            </span>
            {expected != null && expectedLabel ? <span className="nds-floor-qty-expected">{expectedLabel(expected)}</span> : null}
          </div>
          <div className="nds-floor-qty-row">
            <FloorButton
              className="nds-floor-qty-step"
              size="lg"
              icon={<Minus />}
              aria-label={decrementLabel}
              heldReason={qtyCanStep(current, -1, bounds) ? null : range}
              onClick={() => stepBy(-1, 1, true)}
            />
            <div
              ref={displayRef}
              className="nds-floor-qty-display"
              role="spinbutton"
              tabIndex={0}
              aria-labelledby={labelId}
              aria-valuenow={current ?? undefined}
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuetext={valueText}
              aria-invalid={current != null && !inRange ? true : undefined}
              aria-describedby={notice ? noticeId : undefined}
              data-empty={current == null ? 'true' : 'false'}
              data-fresh={entry.fresh ? 'true' : 'false'}
              data-invalid={(current != null && !inRange) || overMax ? 'true' : 'false'}
            >
              <span className="nds-floor-qty-value" aria-hidden>
                <span className="nds-floor-qty-number">{current == null ? '–' : shown}</span>
                {unit ? <span className="nds-floor-qty-unit">{unit}</span> : null}
              </span>
            </div>
            <FloorButton
              className="nds-floor-qty-step"
              size="lg"
              icon={<Plus />}
              aria-label={incrementLabel}
              heldReason={qtyCanStep(current, 1, bounds) ? null : range}
              onClick={() => stepBy(1, 1, true)}
            />
          </div>
          {quicks.length || clearBeside ? (
            <div className="nds-floor-qty-quick">
              {clearBeside ? (
                <FloorButton size="sm" variant="quiet" icon={<X />} onClick={() => press('clear', true)}>
                  {clearLabel}
                </FloorButton>
              ) : null}
              {quicks.map((q) => (
                <FloorButton
                  key={`${q.value}-${q.label}`}
                  size="sm"
                  aria-pressed={current === q.value}
                  heldReason={qtyInRange(q.value, { min, max }) ? null : range}
                  onClick={() => goTo(q.value, true)}
                >
                  {q.label}
                </FloorButton>
              ))}
            </div>
          ) : null}
          <span className="nds-floor-sr" aria-live="polite" aria-atomic="true">
            {said}
          </span>
          {notice ? (
            <p id={noticeId} className="nds-floor-qty-notice" data-tone={noticeTone} role="status">
              {notice}
            </p>
          ) : null}
          {onConfirm ? (
            <FloorButton className="nds-floor-qty-confirm" variant="primary" size="lg" block icon={confirmIcon ?? <Check />} heldReason={held} onClick={confirm}>
              {confirmLabel}
            </FloorButton>
          ) : null}
        </div>
        {showPad ? (
          <div className="nds-floor-qty-pad">
            <div className="nds-floor-pin-keys">
              {qtyPadRows(decimals)
                .flat()
                .map((key) => {
                  const word = key === 'clear' ? clearLabel : key === 'back' ? backLabel : key === 'sep' ? (separatorLabel ?? decimalSeparator) : null
                  return (
                    <button
                      key={key}
                      type="button"
                      className="nds-floor-pin-key"
                      data-key={key}
                      aria-label={word ?? undefined}
                      onClick={() => press(key, true)}
                    >
                      {key === 'clear' || key === 'back' ? (
                        <>
                          <span className="nds-floor-icon" aria-hidden>
                            {key === 'clear' ? <X /> : <Delete />}
                          </span>
                          <span className="nds-floor-pin-key-word" aria-hidden>
                            {word}
                          </span>
                        </>
                      ) : key === 'sep' ? (
                        <span aria-hidden>{decimalSeparator}</span>
                      ) : (
                        key
                      )}
                    </button>
                  )
                })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
