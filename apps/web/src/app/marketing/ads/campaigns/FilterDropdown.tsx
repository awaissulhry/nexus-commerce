'use client'

/**
 * CBN.2b — custom single-select dropdown for the Ad Manager filter bar, matching
 * the Helium 10 control instead of a native <select> (Portfolio / Bid Automation
 * / Rule). Optionally controlled (pass value + onChange) and optionally
 * searchable: when the in-popover search shows, type to filter, Enter picks the
 * first match, Esc closes. Styling lives in ads.css (.h10-dd-*).
 */
import { type ReactNode } from 'react'
import { HoverCard as DsHoverCard } from '@/design-system/components'

/** FB.3 — `title` is the hover explanation for ONE option. Placement's four placement-lane
 *  strings are per-option facts ("PLACEMENT_TOP. The only lane Amazon publishes an impression
 *  share for."), and a single filter-level tip cannot carry four of them. Defaults to the label. */
type Opt = { value: string; label: string; title?: string }

/** Past this many options a picker becomes a scroll-hunt, so the search box appears on its own. */

// FilterDropdown was here. Retired 2026-08-25 — its 4 call sites render the DS `Listbox`, which
// grew `emptyLabel` (the clear row that separates a FILTER select from a form one),
// `emptyIsPlaceholder`, and arrow/Enter navigation the DS had never had across 313 uses.

// H10Select was here. Retired 2026-08-25 — all 97 call sites now render the DS `Listbox`,
// which grew `width`, `searchable` and a per-option `title` to receive them. Its `held`/`onHeld`
// pair was NOT ported: a thoughtful alternative to `disabled` that no call site ever used.

// MultiSelect was here. Retired 2026-08-25 — its one consumer (AdsFilterBar) now renders the DS
// `MultiSelect`, which grew `ariaLabel`, `searchable` and the ranked option search to receive it.

// CBN.3 G6 — shared ad-status options. Inline option list (reuses the .h10-dd-* list
// styling) for use INSIDE the hover-edit popover, where a nested floating dropdown
// (H10Select) would z-fight the popover. The grid cell (bulk edit) still uses H10Select.
export const AD_STATUS_OPTS: Opt[] = [
  { value: 'ENABLED', label: 'Enable' },
  { value: 'PAUSED', label: 'Pause' },
  { value: 'ARCHIVED', label: 'Archive' },
]
export function StatusOptions({ value, onChange, options = AD_STATUS_OPTS }: { value: string; onChange: (v: string) => void; options?: Opt[] }) {
  return (
    <div className="h10-dd-list" role="listbox" aria-label="Status">
      {options.map((o) => (
        <button type="button" key={o.value} className={`h10-dd-opt ${o.value === value ? 'on' : ''}`} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  )
}

// CBN.2h.7 — the campaign info card. The implementation now lives in the DS `HoverCard`
// (portaled + fixed so it escapes the grid's overflow, viewport-clamped, above↔below flip,
// shared warm window). This wrapper exists only to feed it the console's own suppression
// signal — the DS must not know what `col-dragging` means. Originally: a custom tooltip
// replacing the native
// `title=` (OS-styled + delayed) with a styled card, portaled + fixed so it escapes
// the grid's overflow and renders above the row, anchored at the trigger.
// Module-level so all HoverCards share the "warm" window: once one tooltip has
// just hidden, moving onto another shows it immediately (H10's skip-delay). A
// cold hover (none recently shown) waits `delay` ms before appearing.
const colDragging = () => document.body.classList.contains('col-dragging')

export function HoverCard(props: {
  rows?: Array<[string, string]>
  text?: string
  placement?: 'above' | 'below'
  delay?: number
  children: ReactNode
}) {
  return <DsHoverCard {...props} shouldSuppress={colDragging} />
}
