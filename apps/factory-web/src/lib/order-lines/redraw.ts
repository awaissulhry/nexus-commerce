'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * owb-po3 — THE TRAP "type then click" (design § 5zi A; memory "type then click"): a field saves when you leave it. If the page draws
 * itself again IN THE MIDDLE of your move, the first click after typing does nothing (the button moved or was drawn anew under the
 * pointer) and a Tab loses the keys of the next field (it was drawn anew). The fix, at the root, in two pure parts and their hooks:
 *
 * 1. THE GATE — while a pointer is down (or a key is held), a new model WAITS; it is drawn after the pointer is up AND the click has
 *    run (the next task), so the click lands on what the person pressed. `heldModel` holds the state; `useHeldModel` wires it to the
 *    document's pointer and key events.
 * 2. THE CELL — a field you are in keeps what YOU typed: a new model never overwrites it while it has the focus (`cellOnModel`); on
 *    leaving it says once what changed (`cellLeave`), and only then follows the model again. Rows keep stable keys (the line's id),
 *    so no field is drawn anew under the cursor.
 */

// ── 1. the gate ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface HeldModel<M> {
  /** What is drawn. */
  readonly shown: M
  /** A newer model that waits for the pointer / key to be done (null: none). */
  readonly waiting: M | null
  readonly holding: boolean
}

export const heldStart = <M,>(model: M): HeldModel<M> => ({ shown: model, waiting: null, holding: false })
/** A pointer went down (or a key is held): new models wait. */
export const heldHold = <M,>(state: HeldModel<M>): HeldModel<M> => (state.holding ? state : { ...state, holding: true })
/** A new model: drawn at once, or it waits while holding (the newest wins). */
export const heldModel = <M,>(state: HeldModel<M>, next: M): HeldModel<M> => (state.holding ? { ...state, waiting: next } : { shown: next, waiting: null, holding: false })
/** The pointer / key is done AND its click ran: the waiting model is drawn. */
export const heldRelease = <M,>(state: HeldModel<M>): HeldModel<M> => ({ shown: state.waiting ?? state.shown, waiting: null, holding: false })

/**
 * The model to DRAW: the host's newest, except while a pointer is down or Tab / Enter / Space is held anywhere on the page — then the
 * one from before, until the pointer is up and its click has run (released on the next task, `setTimeout 0`).
 */
export function useHeldModel<M>(model: M, active = true): M {
  const [state, setState] = useState<HeldModel<M>>(() => heldStart(model))
  const latest = useRef(state)
  latest.current = state
  useEffect(() => {
    setState((current) => heldModel(current, model))
  }, [model])
  useEffect(() => {
    if (!active || typeof document === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const hold = () => {
      if (timer) clearTimeout(timer)
      timer = null
      setState((current) => heldHold(current))
    }
    const release = () => {
      if (timer) clearTimeout(timer)
      // The click comes after pointerup in the same turn: draw the waiting model on the next task, after the click ran.
      timer = setTimeout(() => {
        timer = null
        setState((current) => heldRelease(current))
      }, 0)
    }
    const onKeyDown = (event: KeyboardEvent) => (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ' ? hold() : undefined)
    const onKeyUp = (event: KeyboardEvent) => (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ' ? release() : undefined)
    document.addEventListener('pointerdown', hold, true)
    document.addEventListener('pointerup', release, true)
    document.addEventListener('pointercancel', release, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('pointerdown', hold, true)
      document.removeEventListener('pointerup', release, true)
      document.removeEventListener('pointercancel', release, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
    }
  }, [active])
  return state.shown
}

// ── 2. the cell ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CellState {
  /** What the field shows. */
  readonly text: string
  /** The value it had when the person came into it (what Esc puts back; what a change is measured against). */
  readonly before: string
  readonly focused: boolean
}

export const cellStart = (value: string): CellState => ({ text: value, before: value, focused: false })
/** The person comes into the field. */
export const cellFocus = (state: CellState): CellState => ({ ...state, before: state.text, focused: true })
/** The person types. */
export const cellType = (state: CellState, text: string): CellState => ({ ...state, text })
/** A new model's value: followed only while the field does NOT have the focus (what you type is never overwritten). */
export const cellOnModel = (state: CellState, value: string): CellState => (state.focused ? state : { text: value, before: value, focused: false })
/** Esc: what was there when you came in comes back (the focus stays). */
export const cellEscape = (state: CellState): CellState => ({ ...state, text: state.before })
/** The person leaves the field: what to save (null: nothing changed), and the field at rest. */
export function cellLeave(state: CellState): { readonly state: CellState; readonly save: string | null } {
  const changed = state.text.trim() !== state.before.trim()
  return { state: { text: state.text, before: state.text, focused: false }, save: changed ? state.text : null }
}

/** A field that saves on leaving it, as a hook: what you type is never overwritten by the model while you are in it. */
export function useCell(value: string, onSave: (text: string) => void) {
  const [state, setState] = useState<CellState>(() => cellStart(value))
  const latest = useRef(state)
  latest.current = state
  useEffect(() => {
    setState((current) => cellOnModel(current, value))
  }, [value])
  return {
    text: state.text,
    onFocus: () => setState(cellFocus),
    onChange: (text: string) => setState((current) => cellType(current, text)),
    onEscape: () => setState(cellEscape),
    onBlur: () => {
      const left = cellLeave(latest.current)
      setState(left.state)
      if (left.save !== null) onSave(left.save)
    },
  }
}
