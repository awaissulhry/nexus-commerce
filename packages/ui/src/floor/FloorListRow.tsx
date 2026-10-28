'use client'

/**
 * FloorList + FloorListRow — a floor list (gap G5, SCR-089 my work, SCR-093 pick list, SCR-023 sync queue): one row
 * per item with an icon in its status colour, a title, a status word, and a big number (icon + colour + number;
 * colour never alone).
 *
 *   <FloorList label="Da prelevare">
 *     <FloorListRow icon={<Package />} tone="warning" title="Pelle nera 1,2 mm" meta="Scaffale B3"
 *                   status="Manca 1" count={4} countLabel="pezzi" onPress={…} />
 *   </FloorList>
 *
 * - Sized by the density: at least 1.25 × the main action's height (80 px on the floor tier), the number in the numeral
 *   size. Pressable rows keep 8 mm between them (`--nds-density-target-gap`); display-only rows sit closer.
 * - A row is a button (`onPress`), a link (`href`) or plain (neither). `selected` marks the row that is open.
 * - In a phone-wide `FloorFrame` the status word moves under the title.
 * - Every word comes from the app.
 */
import type { MouseEvent, ReactNode } from 'react'

import type { FloorTone } from './tone'
import './floor.css'

export interface FloorListProps {
  children: ReactNode
  /** The list's name for a screen reader. */
  label?: string
}

export function FloorList({ children, label }: FloorListProps) {
  return (
    <ul className="nds-floor-list" aria-label={label}>
      {children}
    </ul>
  )
}

export interface FloorListRowProps {
  icon: ReactNode
  title: ReactNode
  /** A second line (where, which order). */
  meta?: ReactNode
  /** A status word, drawn in the row's tone ("Pronto", "Manca 1"). */
  status?: ReactNode
  /** Default `neutral`. */
  tone?: FloorTone
  /** The big number. */
  count?: number | string
  /** The unit under the number ("pezzi"). */
  countLabel?: string
  onPress?: (event: MouseEvent<HTMLElement>) => void
  href?: string
  /** The row that is open. */
  selected?: boolean
  /** Why this row cannot open now. Set: held (focusable, announced, inert). */
  heldReason?: string | null
}

export function FloorListRow({ icon, title, meta, status, tone = 'neutral', count, countLabel, onPress, href, selected, heldReason }: FloorListRowProps) {
  const body = (
    <>
      <span className="nds-floor-icon nds-floor-tone-icon nds-floor-row-icon" aria-hidden>
        {icon}
      </span>
      <span className="nds-floor-row-text">
        <span className="nds-floor-row-title">{title}</span>
        {meta ? <span className="nds-floor-row-meta">{meta}</span> : null}
      </span>
      {status ? <span className="nds-floor-row-status">{status}</span> : null}
      {count !== undefined && count !== null ? (
        <span className="nds-floor-row-count">
          <span className="nds-floor-row-number">{count}</span>
          {countLabel ? <span className="nds-floor-row-count-label">{countLabel}</span> : null}
        </span>
      ) : null}
    </>
  )
  const pressable = Boolean(onPress || href)
  const common = {
    className: pressable ? 'nds-floor-row is-pressable' : 'nds-floor-row',
    'data-tone': tone,
    'data-selected': selected ? 'true' : undefined,
  }
  let row: ReactNode
  if (href && !heldReason) {
    row = (
      <a {...common} href={href} onClick={onPress} aria-current={selected ? 'page' : undefined}>
        {body}
      </a>
    )
  } else if (pressable) {
    row = (
      <button
        {...common}
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-disabled={heldReason ? true : undefined}
        aria-description={heldReason || undefined}
        onClick={heldReason ? (e) => e.preventDefault() : onPress}
      >
        {body}
      </button>
    )
  } else {
    row = <div {...common}>{body}</div>
  }
  return <li className="nds-floor-list-item">{row}</li>
}
