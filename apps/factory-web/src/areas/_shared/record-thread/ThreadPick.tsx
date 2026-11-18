'use client'

import type { ReactNode } from 'react'
import { SegmentedControl } from '@nexus/ui/primitives'
import './thread-pick.css'

/**
 * F-SA-260 (sales page plan N4, picks P9, P19; 10-order-page §6.1, 11-customer-page §9.1; review C-13) — THE pick of a record's dock:
 * which ONE thread the dock shows (PL1 "one thread per page"), lifted from the work order's dock (B-TH-265, WorkOrderThreads) so the
 * work order, the order page and the customer page pick their thread with the same part and the same look: a design-system
 * SegmentedControl (small, wrapping) at the dock's top and, under it, ONE line that says whose the picked thread is — who reads what
 * is written there — so nobody writes to a customer believing it stays in the office. The dock's children are the picked thread.
 *
 * The host names its choices (only those the reader may read, each with its words and its line) and the value; a value that is not
 * among the choices shows the first (the default) without a word, so a thread the reader may not open is never hinted at. One choice
 * alone needs no pick: the thread is drawn without it. The words are the host's (the work order keeps its own).
 */

/** One thread the dock may show. */
export interface ThreadChoice<V extends string = string> {
  readonly value: V
  /** The segment's words ("Work order notes", "SO-0142 · Brand Alpha"). */
  readonly label: string
  /** The segment's hover words. */
  readonly title?: string
  /**
   * The ONE line under the pick while this choice is picked: whose thread it is (who reads what is written there). F-SA-279: null
   * when the picked view says it itself (All of <customer>'s own read-only line).
   */
  readonly line: string | null
}

export interface ThreadPickProps<V extends string = string> {
  /** The pick's name for a screen reader ("Which thread"). */
  readonly label: string
  /** The threads the reader may read, the default first. */
  readonly choices: readonly ThreadChoice<V>[]
  readonly value: V
  readonly onPick?: (value: V) => void
  /** The picked thread (the docked office thread, or a design case's). */
  readonly children: ReactNode
  // ---- F-SA-262 / F-SA-279: a second, quieter line under the pick ("Draft kept on SO-…"), and what sits beside the pick in the same
  // block (a choice's second select: which project, which work order). Absent: nothing.
  readonly note?: string | null
  readonly extra?: ReactNode
  // ---- end F-SA-262 / F-SA-279
}

/** The choice shown: the one asked for, else the first (the default) — never one the host did not offer. Null: no choice at all. */
export function pickedChoice<V extends string>(choices: readonly ThreadChoice<V>[], value: V | null | undefined): ThreadChoice<V> | null {
  return choices.find((choice) => choice.value === value) ?? choices[0] ?? null
}

/** The pick is drawn only when there is something to pick: two threads or more (one thread alone needs no pick). */
export const pickShown = (choices: readonly ThreadChoice[]): boolean => choices.length > 1

export function ThreadPick<V extends string>({ label, choices, value, onPick, children, note /* F-SA-279 */, extra /* F-SA-262 */ }: ThreadPickProps<V>) {
  const picked = pickedChoice(choices, value)
  return (
    <>
      {pickShown(choices) && picked && (
        <div className="fw-thread-pick">
          <SegmentedControl
            size="sm"
            wrap
            ariaLabel={label}
            value={picked.value}
            onChange={(next) => {
              const chosen = choices.find((choice) => choice.value === next)
              if (chosen) onPick?.(chosen.value)
            }}
            options={choices.map((choice) => ({ value: choice.value, label: choice.label, ...(choice.title ? { title: choice.title } : {}) }))}
          />
          {extra /* F-SA-262 */}
          {picked.line && <p className="fw-thread-pick-line">{picked.line}</p>}
          {note && <p className="fw-thread-pick-line is-note">{note}</p> /* F-SA-279 */}
        </div>
      )}
      {children}
    </>
  )
}
