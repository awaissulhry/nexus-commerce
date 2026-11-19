'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Pill, SegmentedControl } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { DockColumn, type DockColumnProps } from '../../../lib/record-thread/DockColumn' // F-OP-202
import { WithMessages } from '../../../record-panels/i18n'
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
 *
 * F-OP-202 (order page plan N4; 11-dock §0.1, §1, §2; review R-13) — the pick is the first band INSIDE the dock's one card: ThreadPick
 * draws nothing above its children any more; it hands its band down (DockTop, `useDockTop()`) and the card inside draws it first —
 * the docked office thread through RecordThread's `slots.top` (kept when that thread is forbidden), a read-only view through
 * `PickedDockColumn`. Hosts keep their shape (`<ThreadPick …>{thread}</ThreadPick>`). Each segment: its icon, its long words (one
 * line, at most 22 characters) or, in a card of 480 px or less, its short words; its full words on hover; "N new" as a small Pill
 * with the number visible ("2 new" for a screen reader). The whose-line is a polite live line (office tone on work-order notes).
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
  // ---- F-OP-202: the segment's look inside the card
  /** The short words of a narrow card (≤ 480 px): "General", "Projects", "Work orders", "All". Absent: the label at every width. */
  readonly short?: string
  /** The segment's icon (a 14 px lucide glyph, aria-hidden). */
  readonly icon?: ReactNode
  /** The reader's new messages in this thread ("N new"); 0 or absent: no pill. */
  readonly count?: number
  /** 'office': the whose-line in the office tone (a work order's notes: never shared with a customer). */
  readonly tone?: 'office'
  // ---- end F-OP-202
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

// ---- F-OP-202: the pick model (what one segment shows) and the band handed down to the card ----

/** What one segment shows: its long words, its short words (null: the long ones at every width), its full words on hover, its count. */
export interface PickSegment {
  readonly long: string
  readonly short: string | null
  readonly title: string
  readonly count: number
}

export function segmentOf(choice: ThreadChoice): PickSegment {
  const short = choice.short && choice.short !== choice.label ? choice.short : null
  // The hover keeps every word the segment may cut (the long words end at 22 characters; the short ones drop the customer).
  const title = choice.title && choice.title !== choice.label ? `${choice.label} · ${choice.title}` : choice.label
  const count = Number.isFinite(choice.count) ? Math.max(0, Math.trunc(choice.count ?? 0)) : 0
  return { long: choice.label, short, title, count }
}

/** The whose-line's class: the office tone for an office-only thread. */
export const lineClassOf = (choice: Pick<ThreadChoice, 'tone'>): string => `fw-thread-pick-line${choice.tone === 'office' ? ' is-office' : ''}`

/** The catalogue the band reads ("N new"); ThreadPick brings it, so every host's card has it. */
export const THREAD_PICK_NS = ['record-thread'] as const

const DockTop = createContext<ReactNode>(null)

/**
 * The dock's pick band, for the card inside the dock to draw as its FIRST band (DockedOfficeThread → RecordThread `slots.top`,
 * PickedDockColumn → `top`). Null outside a ThreadPick and when there is nothing to pick: a page without a pick draws no band.
 */
export function useDockTop(): ReactNode {
  return useContext(DockTop)
}

/** DockColumn (a read-only view's card: All of <Customer>) with the dock's pick band on top. */
export function PickedDockColumn(props: Omit<DockColumnProps, 'top'>) {
  return <DockColumn {...props} top={useDockTop()} />
}
// ---- end F-OP-202

export function ThreadPick<V extends string>({ label, choices, value, onPick, children, note /* F-SA-279 */, extra /* F-SA-262 */ }: ThreadPickProps<V>) {
  const picked = pickedChoice(choices, value)
  // F-OP-202: nothing is drawn here — the band goes down to the card inside the dock, which draws it first.
  const band = pickShown(choices) && picked ? <PickBand label={label} choices={choices} picked={picked} onPick={onPick} note={note ?? null} extra={extra ?? null} /> : null
  return (
    <WithMessages namespaces={THREAD_PICK_NS}>
      <DockTop.Provider value={band}>{children}</DockTop.Provider>
    </WithMessages>
  )
}

/** F-OP-202: the pick band — the segments, the second select under them, the ONE whose-line, the quieter note. */
function PickBand<V extends string>({ label, choices, picked, onPick, note, extra }: { label: string; choices: readonly ThreadChoice<V>[]; picked: ThreadChoice<V>; onPick: ((value: V) => void) | undefined; note: string | null; extra: ReactNode }) {
  const t = useT('record-thread')
  return (
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
        options={choices.map((choice) => {
          const segment = segmentOf(choice)
          const fresh = segment.count > 0 ? t('dock.newCount', { count: segment.count }) : null
          return {
            value: choice.value,
            label: (
              <>
                <span className={`fw-thread-pick-long${segment.short ? ' has-short' : ''}`}>{segment.long}</span>
                {segment.short && <span className="fw-thread-pick-short">{segment.short}</span>}
                {/* R-13: size sm, not compact (compact hides the words): the number shows, the words are its name. */}
                {fresh && (
                  <Pill tone="info" size="sm" className="fw-thread-pick-new" aria-label={fresh} title={fresh}>
                    {segment.count}
                  </Pill>
                )}
              </>
            ),
            title: segment.title,
            ...(choice.icon ? { icon: choice.icon } : {}),
          }
        })}
      />
      {extra ? <div className="fw-thread-pick-extra">{extra /* F-SA-262 */}</div> : null}
      {picked.line && (
        <p className={lineClassOf(picked)} aria-live="polite">
          <Info size={14} aria-hidden />
          <span>{picked.line}</span>
        </p>
      )}
      {note && <p className="fw-thread-pick-line is-note">{note}</p> /* F-SA-279 */}
    </div>
  )
}
