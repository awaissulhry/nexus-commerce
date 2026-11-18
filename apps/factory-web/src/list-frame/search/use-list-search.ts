'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'

/**
 * F-SA-223 (sales page plan N5 / N8, picks P18, P23; 12-lists-board §5 rule 3): ONE search rule for every list's search field —
 * Sales › Orders, Incoming, Quotes, Made-to-measure › Riders, Customers and Purchasing › Suppliers (one shared list) alike:
 *
 *   typing     the list reads the words 300 ms after the last key (never one read per key)
 *   Enter      at once (the wait is skipped)
 *   Esc        clears the field and the list's search at once (on an empty field Esc is left to the page: a dialog, a menu)
 *   100        at most 100 characters (the APIs' own maximum: a longer search would be refused)
 *   address    the field follows the list's search when it changes from outside (Back, a saved view, Clear all, a door) —
 *              unless the person is typing: their words are never overwritten
 *
 * The list's search lives in its address (the committed words); the field holds what is typed. searchStep is the rule, pure (the
 * test holds it); useListSearch runs it with the timer.
 */

/** The longest search the APIs read (their `q`: max 100). */
export const SEARCH_MAX = 100
/** The wait after the last key before the list reads the words. */
export const SEARCH_DELAY_MS = 300

export interface SearchState {
  /** What the field shows. */
  readonly value: string
  /** Typed and not committed yet: the person is typing (the address does not overwrite it). */
  readonly dirty: boolean
}

export type SearchEvent =
  | { readonly type: 'type'; readonly text: string }
  /** The wait after the last key passed. */
  | { readonly type: 'settle' }
  | { readonly type: 'enter' }
  | { readonly type: 'escape' }
  /** The list's committed search (its address) is now `committed`. */
  | { readonly type: 'address' }

const same = (a: string, b: string): boolean => a.trim() === b.trim()

/**
 * One step of the rule: the field's next state and the words to commit (null: nothing to commit — the list already reads them).
 * `committed` is the list's search as its address holds it now.
 */
export function searchStep(state: SearchState, event: SearchEvent, committed: string): { state: SearchState; commit: string | null } {
  switch (event.type) {
    case 'type':
      return { state: { value: event.text.slice(0, SEARCH_MAX), dirty: true }, commit: null }
    case 'settle':
    case 'enter':
      return { state: { value: state.value, dirty: false }, commit: same(state.value, committed) ? null : state.value.trim() }
    case 'escape':
      return { state: { value: '', dirty: false }, commit: committed.trim() === '' ? null : '' }
    case 'address':
      return state.dirty ? { state, commit: null } : { state: { value: committed.slice(0, SEARCH_MAX), dirty: false }, commit: null }
  }
}

export interface ListSearch {
  /** What the field shows. */
  readonly value: string
  /** Spread on the search input (DS `Input`): its value, its maximum, its keys. */
  readonly field: {
    readonly value: string
    readonly maxLength: number
    readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void
    readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  }
  /** Sets the field without committing (Clear all clears the list's terms itself). */
  readonly reset: (value: string) => void
}

/** The search field of a list whose committed search is `committed`; `onCommit` writes the words into the list (its address). */
export function useListSearch(committed: string, onCommit: (q: string) => void, delay: number = SEARCH_DELAY_MS): ListSearch {
  const [state, setState] = useState<SearchState>(() => ({ value: committed.slice(0, SEARCH_MAX), dirty: false }))
  const current = useRef(state)
  const latest = useRef({ committed, onCommit })
  latest.current = { committed, onCommit }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const run = useCallback((event: SearchEvent) => {
    const next = searchStep(current.current, event, latest.current.committed)
    current.current = next.state
    setState(next.state)
    if (next.commit !== null) latest.current.onCommit(next.commit)
  }, [])
  useEffect(() => run({ type: 'address' }), [committed, run])
  useEffect(() => stop, [])
  const field = {
    value: state.value,
    maxLength: SEARCH_MAX,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      run({ type: 'type', text: event.target.value })
      stop()
      timer.current = setTimeout(() => {
        timer.current = null
        run({ type: 'settle' })
      }, delay)
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        stop()
        run({ type: 'enter' })
        return
      }
      if (event.key === 'Escape' && current.current.value !== '') {
        // The field is cleared; the page's own Esc (a dialog, a menu) is not reached from a field with words.
        event.preventDefault()
        event.stopPropagation()
        stop()
        run({ type: 'escape' })
      }
    },
  }
  const reset = useCallback((value: string) => {
    stop()
    current.current = { value: value.slice(0, SEARCH_MAX), dirty: false }
    setState(current.current)
  }, [])
  return { value: state.value, field, reset }
}
