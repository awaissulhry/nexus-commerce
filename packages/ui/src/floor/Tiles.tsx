'use client'

/**
 * FloorTile + FloorTileGrid — the big tiles of a floor home screen (gap G5, SCR-021, 024, 089): an icon, a word, and a
 * number when there is one (icon + colour + number, A2 §3.1 "Low literacy"; colour never alone).
 *
 *   <FloorTileGrid label="Cosa vuoi fare">
 *     <FloorTile icon={<Scissors />} label="Taglio" count={4} countLabel="4 fasci in coda" tone="primary" onPress={…} />
 *     <FloorTile icon={<ScanLine />} label="Scansiona" onPress={…} />
 *   </FloorTileGrid>
 *
 * - Sized by the density: at least twice the main action's height (128 px on the floor tier), label at 1.2 × body,
 *   count in the numeral size, icon at twice the density icon; 8 mm between tiles (`--nds-density-target-gap`).
 * - A tile is a button (`onPress`) or a link (`href`; `onPress` still runs, so an app router can take over). Held
 *   (`heldReason`): focusable, announced with its reason, inert — show the reason on screen too.
 * - At most six tiles on a home screen (A2 §3.1): the grid lays out at most three a row (or two), each at least 9 rem —
 *   two a row on a phone, one in a narrow column — by its own width, with no viewport query.
 * - Every word comes from the app; `countLabel` gives the number its words for a screen reader.
 */
import type { MouseEvent, ReactNode } from 'react'

import type { FloorTone } from './tone'
import './floor.css'

export interface FloorTileProps {
  icon: ReactNode
  /** One or two short words ("Taglio"). */
  label: string
  /** A number read at a glance (what waits). */
  count?: number | string
  /** The number in words for a screen reader ("4 fasci in coda"). */
  countLabel?: string
  /** A short line under the label. */
  hint?: string
  /** Default `neutral`. */
  tone?: FloorTone
  onPress?: (event: MouseEvent<HTMLElement>) => void
  /** A link instead of a button. */
  href?: string
  /** Why this tile cannot open now. Set: held (focusable, announced, inert). */
  heldReason?: string | null
  /** The tile of the screen that is open (`aria-current`). */
  current?: boolean
  id?: string
}

export function FloorTile({ icon, label, count, countLabel, hint, tone = 'neutral', onPress, href, heldReason, current, id }: FloorTileProps) {
  const body = (
    <>
      <span className="nds-floor-icon nds-floor-tone-icon nds-floor-tile-icon" aria-hidden>
        {icon}
      </span>
      {count !== undefined && count !== null ? (
        <span className="nds-floor-tile-count" aria-hidden={countLabel ? true : undefined}>
          {count}
        </span>
      ) : null}
      <span className="nds-floor-tile-label">{label}</span>
      {hint ? <span className="nds-floor-tile-hint">{hint}</span> : null}
      {countLabel ? <span className="nds-floor-sr">{countLabel}</span> : null}
    </>
  )
  const common = { id, className: 'nds-floor-tile', 'data-tone': tone, 'aria-current': current ? ('page' as const) : undefined }
  if (href && !heldReason) {
    return (
      <a {...common} href={href} onClick={onPress}>
        {body}
      </a>
    )
  }
  return (
    <button
      {...common}
      type="button"
      aria-disabled={heldReason ? true : undefined}
      aria-description={heldReason || undefined}
      onClick={heldReason ? (e) => e.preventDefault() : onPress}
    >
      {body}
    </button>
  )
}

export interface FloorTileGridProps {
  children: ReactNode
  /** The group's name for a screen reader ("Cosa vuoi fare"). */
  label?: string
  /** The most tiles a row: 3 (default) or 2. Fewer when a tile would be under 9 rem. */
  columns?: 2 | 3
}

export function FloorTileGrid({ children, label, columns }: FloorTileGridProps) {
  return (
    <div className="nds-floor-tiles" role="group" aria-label={label} data-columns={columns}>
      {children}
    </div>
  )
}
