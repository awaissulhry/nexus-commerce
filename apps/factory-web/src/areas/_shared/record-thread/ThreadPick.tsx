'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { ChevronDown, Lock } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { useT } from '../../../lib/i18n/provider'
import { DockColumn, type DockColumnProps } from '../../../lib/record-thread/DockColumn' // F-OP-202
import { WithMessages } from '../../../record-panels/i18n'
import './thread-pick.css'

/**
 * F-SA-260 (sales page plan N4, picks P9, P19; 10-order-page §6.1, 11-customer-page §9.1; review C-13) — THE pick of a record's dock:
 * which ONE thread the dock shows (PL1 "one thread per page"), lifted from the work order's dock (B-TH-265, WorkOrderThreads) so the
 * work order, the order page and the customer page pick their thread with the same part and the same look: a design-system
 * segmented pick (small, wrapping) at the dock's top and, under it, ONE line that says whose the picked thread is — who reads what
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
 * line, whole: F-OP-303) or, in a card of 480 px or less, its short words; its full words on hover; "N new" as a small Pill
 * with the number visible ("2 new" for a screen reader). The whose-line is a polite live line (office tone on work-order notes).
 *
 * tw- W2.1 (THE THREAD REBUILD; Z4, P0-B4; 10-design §8): the pick band and its sentence GO — the pick is ONE menu in the head's title
 * (the card hands it to its head: rt/head/view/HeadPick): the picked thread's ONE label (the long one, cut with "…" only when it is
 * wider than the head; never other words at another width) with ▾, a lock when it is office only (never told by colour alone), and
 * each thread a row of the menu with its "N new" in words. The second select and the quieter note stay, under the title.
 */

/** One thread the dock may show. */
export interface ThreadChoice<V extends string = string> {
  readonly value: V
  /** The thread's ONE label ("Work order notes", "SO-0142 · Brand Alpha"). */
  readonly label: string
  /** The segment's hover words. */
  readonly title?: string
  /**
   * Whose thread it is (who reads what is written there). tw- W2.1: no line under the title any more — these words are its row's
   * tooltip in the pick. F-SA-279: null when the view says it itself (All of <customer>).
   */
  readonly line: string | null
  // ---- F-OP-202: the segment's look inside the card
  /** tw- W2.1 (P0-B4): ignored — one label per thread at every width (hosts may still name it). */
  readonly short?: string
  /** The segment's icon (a 14 px lucide glyph, aria-hidden). */
  readonly icon?: ReactNode
  /** The reader's new messages in this thread ("N new"); 0 or absent: no pill. */
  readonly count?: number
  /** 'office': an office-only thread (a work order's notes: never shared with a customer) — tw- W2.1: a lock in the title. */
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

/** What one thread shows in the pick: its ONE label (P0-B4: never other words at another width), its full words on hover, its count. */
export interface PickSegment {
  readonly long: string
  readonly title: string
  readonly count: number
}

export function segmentOf(choice: ThreadChoice): PickSegment {
  // The hover keeps every word the title may cut, and whose thread it is.
  const title = [...new Set([choice.label, choice.title, choice.line].filter((words): words is string => Boolean(words)))].join(' · ')
  const count = Number.isFinite(choice.count) ? Math.max(0, Math.trunc(choice.count ?? 0)) : 0
  return { long: choice.label, title, count }
}

/** tw- W2.1: the pick's rows — every thread the host offers, in its order, the picked one checked, its "N new" count and hover words. */
export interface PickRow<V extends string = string> {
  readonly value: V
  readonly label: string
  readonly title: string
  readonly count: number
  readonly checked: boolean
}

export function pickRows<V extends string>(choices: readonly ThreadChoice<V>[], picked: V): PickRow<V>[] {
  return choices.map((choice) => {
    const segment = segmentOf(choice)
    return { value: choice.value, label: segment.long, title: segment.title, count: segment.count, checked: choice.value === picked }
  })
}

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

/**
 * tw- W2.1: the pick as the head's title — ONE menu (each thread a row, its "N new" in words), the picked thread's ONE label with ▾ and
 * a lock when it is office only; the second select and the quieter note under it.
 */
function PickBand<V extends string>({ label, choices, picked, onPick, note, extra }: { label: string; choices: readonly ThreadChoice<V>[]; picked: ThreadChoice<V>; onPick: ((value: V) => void) | undefined; note: string | null; extra: ReactNode }) {
  const t = useT('record-thread')
  const shown = segmentOf(picked)
  const icons = new Map(choices.map((choice) => [choice.value, choice.icon] as const))
  const items: MenuItemDef[] = pickRows(choices, picked.value).map((row) => {
    const icon = icons.get(row.value)
    return { id: `pick-${row.value}`, label: row.count > 0 ? `${row.label} · ${t('dock.newCount', { count: row.count })}` : row.label, ...(icon ? { icon } : {}), checked: row.checked, title: row.title, onSelect: () => onPick?.(row.value) }
  })
  return (
    <div className="fw-thread-pick">
      <Menu
        className="fw-thread-pick-menu"
        label={
          <>
            <span className="fw-thread-pick-long">{shown.long}</span>
            {picked.tone === 'office' && <Lock size={13} className="fw-thread-pick-lock" aria-hidden />}
            <ChevronDown size={14} aria-hidden />
          </>
        }
        items={items}
        triggerProps={{ className: 'fw-thread-pick-title', 'aria-label': `${label}: ${shown.long}`, title: shown.title }}
      />
      {extra ? <div className="fw-thread-pick-extra">{extra /* F-SA-262 */}</div> : null}
      {note && <p className="fw-thread-pick-line is-note">{note}</p> /* F-SA-279 */}
    </div>
  )
}
