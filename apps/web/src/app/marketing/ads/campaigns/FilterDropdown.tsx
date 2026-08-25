'use client'

/**
 * CBN.2b — custom single-select dropdown for the Ad Manager filter bar, matching
 * the Helium 10 control instead of a native <select> (Portfolio / Bid Automation
 * / Rule). Optionally controlled (pass value + onChange) and optionally
 * searchable: when the in-popover search shows, type to filter, Enter picks the
 * first match, Esc closes. Styling lives in ads.css (.h10-dd-*).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { searchOptions } from '@/lib/option-search'
import { HoverCard as DsHoverCard } from '@/design-system/components'

/** FB.3 — `title` is the hover explanation for ONE option. Placement's four placement-lane
 *  strings are per-option facts ("PLACEMENT_TOP. The only lane Amazon publishes an impression
 *  share for."), and a single filter-level tip cannot carry four of them. Defaults to the label. */
type Opt = { value: string; label: string; title?: string }

/** Past this many options a picker becomes a scroll-hunt, so the search box appears on its own. */
const SEARCH_THRESHOLD = 7

function useClickAway<T extends HTMLElement>(onAway: () => void) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onAway() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onAway])
  return ref
}

export function FilterDropdown({
  options, value: controlledValue, onChange, emptyLabel,
  emptyIsPlaceholder = false, searchable = false, searchPlaceholder = 'Search…', ariaLabel, disabled = false,
}: {
  options: Opt[]
  /** Controlled value. Omit both value + onChange for a self-managed (cosmetic) dropdown. */
  value?: string
  onChange?: (v: string) => void
  /** Shown when nothing is selected; also the "clear" row at the top of the list. */
  emptyLabel: string
  /** Render the empty label greyed (a placeholder, e.g. "Select a Portfolio") vs a real default (e.g. "All"). */
  emptyIsPlaceholder?: boolean
  /** FB.1 — an overridden grain stays VISIBLE and inert rather than vanishing: a bar that silently
   *  dropped a selection would lie about the URL you are about to share. Pair with `note`. */
  disabled?: boolean
  /** Force the in-popover search box (otherwise it auto-shows past 7 options). */
  searchable?: boolean
  searchPlaceholder?: string
  ariaLabel?: string
}) {
  const [internal, setInternal] = useState('')
  const isControlled = controlledValue !== undefined
  const value = isControlled ? controlledValue : internal
  const setValue = (v: string) => { if (!isControlled) setInternal(v); onChange?.(v) }

  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const ref = useClickAway<HTMLDivElement>(() => { setOpen(false); setQ(''); setActive(0) })

  const showSearch = searchable || options.length > SEARCH_THRESHOLD
  const hasOwnEmpty = options.some((o) => o.value === '')
  const selected = options.find((o) => o.value === value)
  // OS.1 — was `label.toLowerCase().includes(q)`, which could not match across the separators in ad
  // entity names: "gale broad" found nothing in "GALE | IT | Broad | Brand". Now ranked + tokenised.
  const matches = showSearch ? searchOptions(q, options, (o) => o.label) : options
  const pick = (v: string) => { setValue(v); setOpen(false); setQ(''); setActive(0) }

  return (
    <div className={`h10-dd ${open && !disabled ? 'open' : ''} ${disabled ? 'is-off' : ''}`} ref={ref}>
      <button type="button" className="h10-dd-btn" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open && !disabled} aria-label={ariaLabel}>
        <span className={!selected && emptyIsPlaceholder ? 'ph' : ''}>{selected ? selected.label : emptyLabel}</span>
        <ChevronDown size={14} />
      </button>
      {open && !disabled && (
        <div className="h10-dd-pop" role="listbox">
          {showSearch && (
            <div className="h10-dd-search">
              <Search size={13} />
              <input
                autoFocus
                value={q}
                onChange={(e) => { setQ(e.target.value); setActive(0) }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)) }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
                  else if (e.key === 'Enter') { e.preventDefault(); const m = matches[active]; if (m) pick(m.value) }
                  else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQ(''); setActive(0) }
                }}
                placeholder={searchPlaceholder}
                aria-label="Search options"
              />
            </div>
          )}
          <div className="h10-dd-list">
            {/* FB.3 — only when the option list does not already carry one. Several call sites in
                this section prepend their own `{ value: '', label: 'Any kind' }`, which rendered a
                SECOND clear row directly under this one. Left to itself the injected row also wins
                `options.find(o => o.value === value)` at the empty value, so its label overrides
                `emptyLabel` on the closed control — which is how an overridden grain showed
                "All portfolios" instead of naming the campaign deciding it. */}
            {!hasOwnEmpty && <button type="button" className={`h10-dd-opt ${!value ? 'on' : ''}`} onClick={() => pick('')}>{emptyLabel}</button>}
            {matches.length === 0 ? (
              <div className="h10-dd-empty">No matches</div>
            ) : matches.map((o, i) => (
              <button
                type="button"
                key={`${o.value}__${i}`}
                className={`h10-dd-opt ${o.value === value ? 'on' : ''} ${showSearch && i === active ? 'active' : ''}`}
                onClick={() => pick(o.value)}
                onMouseEnter={() => showSearch && setActive(i)}
                title={o.title ?? o.label}
              >{o.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

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
