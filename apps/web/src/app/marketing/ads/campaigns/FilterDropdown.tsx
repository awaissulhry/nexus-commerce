'use client'

/**
 * CBN.2b — custom single-select dropdown for the Ad Manager filter bar, matching
 * the Helium 10 control instead of a native <select> (Portfolio / Bid Automation
 * / Rule). Optionally controlled (pass value + onChange) and optionally
 * searchable: when the in-popover search shows, type to filter, Enter picks the
 * first match, Esc closes. Styling lives in ads.css (.h10-dd-*).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search } from 'lucide-react'
import { searchOptions } from '@/lib/option-search'

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
            <button type="button" className={`h10-dd-opt ${!value ? 'on' : ''}`} onClick={() => pick('')}>{emptyLabel}</button>
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

// CBN.2h.7 — required single-select dropdown (H10-styled, never a native <select>).
// The popover is portaled to <body> with fixed positioning so it's never clipped by
// a scrolling modal body or the grid's overflow, and flips up near the viewport
// bottom. Shares the .h10-dd-* styling so it stays consistent with FilterDropdown.
export function H10Select({ options, value, onChange, ariaLabel, width, searchable, searchPlaceholder = 'Search…' }: {
  options: Opt[]
  value: string
  onChange: (v: string) => void
  ariaLabel?: string
  width?: number | string
  /** Force the in-popover search box. Otherwise it auto-shows past SEARCH_THRESHOLD options. */
  searchable?: boolean
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const selected = options.find((o) => o.value === value)
  // OS.2 — this control had no search at all, so picking a portfolio or campaign from a long list
  // meant scroll-hunting. Ranked, token-based matching now (see lib/option-search).
  const showSearch = searchable || options.length > SEARCH_THRESHOLD
  const matches = showSearch ? searchOptions(q, options, (o) => o.label) : options
  const place = () => {
    const el = btnRef.current; if (!el) return
    const r = el.getBoundingClientRect()
    const estH = Math.min(options.length, 7) * 36 + 12 + (showSearch ? 42 : 0)
    const up = r.bottom + estH > window.innerHeight - 8
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: r.left, width: r.width, up })
  }
  const close = () => { setOpen(false); setQ(''); setActive(0) }
  const toggle = () => { if (!open) { place(); setQ(''); setActive(0) } ; setOpen((o) => !o) }
  const pick = (v: string) => { onChange(v); close() }
  // Type to narrow, ↑/↓ to move, Enter to take the highlighted row, Esc to back out.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const m = matches[active]; if (m) pick(m.value) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }
  // Runs once the pop is in the DOM and its real (content-driven) width is known — the only moment
  // an overflow can be detected, since the width depends on the longest option label.
  const edgeClamp = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    const overflow = r.right - (window.innerWidth - 8)
    if (overflow > 0) el.style.left = `${Math.max(8, r.left - overflow)}px`
  }, [])
  return (
    <div className="h10-dd" style={width != null ? { width } : undefined}>
      <button ref={btnRef} type="button" className={`h10-dd-btn ${open ? 'open' : ''}`} onClick={toggle} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
        <span>{selected?.label ?? ''}</span><ChevronDown size={14} />
      </button>
      {open && pos && createPortal(<>
        <button type="button" className="h10-dd-back" aria-label="Close" onClick={close} />
        {/* DPS.4 — the pop is positioned at the trigger's left and sized to its widest option, with
            no right-edge clamp: a select near the right of the viewport holding long labels rendered
            off-screen (measured 953px wide overflowing by 390px on Rank & Dayparting Schedules).
            `maxWidth` keeps it on screen and `edgeClamp` slides it left only when it would spill —
            a trigger with short options is positioned exactly as before. */}
        <div
          ref={edgeClamp}
          className="h10-dd-pop fixed"
          role="listbox"
          style={{ top: pos.top, left: pos.left, minWidth: Math.max(pos.width, 180), maxWidth: 'calc(100vw - 16px)', transform: pos.up ? 'translateY(-100%)' : undefined }}
        >
          {showSearch && (
            <div className="h10-dd-search">
              <Search size={13} />
              <input
                autoFocus
                value={q}
                onChange={(e) => { setQ(e.target.value); setActive(0) }}
                onKeyDown={onKey}
                placeholder={searchPlaceholder}
                aria-label="Search options"
              />
            </div>
          )}
          <div className="h10-dd-list">
            {matches.length === 0 ? (
              <div className="h10-dd-empty">No matches</div>
            ) : matches.map((o, i) => (
              <button
                type="button"
                key={`${o.value}__${i}`}
                className={`h10-dd-opt ${o.value === value ? 'on' : ''} ${showSearch && i === active ? 'active' : ''}`}
                onClick={() => pick(o.value)}
                onMouseEnter={() => showSearch && setActive(i)}
                title={o.label}
              >{o.label}</button>
            ))}
          </div>
        </div>
      </>, document.body)}
    </div>
  )
}

// CBN.3.8 — checkbox multi-select (H10's Status filter). Reuses the .h10-ms-* shell
// shared with the Ad Manager. "Select All" is the first plain row (checked when all on,
// indeterminate when some); the button summarises as the placeholder / single label /
// "All" / "N selected". Values are an array; empty ⇒ no filter (matches H10).
export function MultiSelect({ options, value, onChange, placeholder = 'All', ariaLabel, searchable, searchPlaceholder = 'Search…' }: {
  options: Opt[]
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  ariaLabel?: string
  /** Force the in-popover search box. Otherwise it auto-shows past SEARCH_THRESHOLD options. */
  searchable?: boolean
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useClickAway<HTMLDivElement>(() => { setOpen(false); setQ('') })
  const allOn = options.length > 0 && value.length === options.length
  const some = value.length > 0 && !allOn
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  // OS.3 — a Portfolio/Campaign multi-filter could run to dozens of checkboxes with no way to find
  // one. "Select All" deliberately still applies to ALL options, not just the visible matches —
  // silently selecting a filtered subset from a control labelled "Select All" would be a lie.
  const showSearch = searchable || options.length > SEARCH_THRESHOLD
  const matches = showSearch ? searchOptions(q, options, (o) => o.label) : options
  const toggleAll = () => onChange(allOn ? [] : options.map((o) => o.value))
  const summary = value.length === 0 ? placeholder
    : allOn ? 'All'
    : value.length === 1 ? (options.find((o) => o.value === value[0])?.label ?? '1 selected')
    : `${value.length} selected`
  return (
    <div className={`h10-ms ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className={`h10-ms-btn ${value.length === 0 ? 'ph' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}>
        <span>{summary}</span><ChevronDown size={14} />
      </button>
      {open && (
        <div className="h10-ms-pop" role="listbox">
          {showSearch && (
            <div className="h10-dd-search">
              <Search size={13} />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQ('') } }}
                placeholder={searchPlaceholder}
                aria-label="Search options"
              />
            </div>
          )}
          <label className="h10-ms-opt">
            <input type="checkbox" checked={allOn} ref={(el) => { if (el) el.indeterminate = some }} onChange={toggleAll} /> Select All
          </label>
          {matches.length === 0 ? (
            <div className="h10-dd-empty">No matches</div>
          ) : matches.map((o, i) => (
            <label key={`${o.value}__${i}`} className={`h10-ms-opt ${value.includes(o.value) ? 'sel' : ''}`}>
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

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

// CBN.2h.7 — custom hover tooltip (H10's campaign info card). Replaces the native
// `title=` (OS-styled + delayed) with a styled card, portaled + fixed so it escapes
// the grid's overflow and renders above the row, anchored at the trigger.
// Module-level so all HoverCards share the "warm" window: once one tooltip has
// just hidden, moving onto another shows it immediately (H10's skip-delay). A
// cold hover (none recently shown) waits `delay` ms before appearing.
let lastHcHide = 0
export function HoverCard({ rows, text, placement = 'above', delay = 0, children }: { rows?: Array<[string, string]>; text?: string; placement?: 'above' | 'below'; delay?: number; children: ReactNode }) {
  const [pos, setPos] = useState<{ top: number; left: number; place: 'above' | 'below' } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const place = () => { if (document.body.classList.contains('col-dragging')) return; const el = ref.current; if (el) { const r = el.getBoundingClientRect(); setPos({ top: placement === 'below' ? r.bottom + 6 : r.top - 6, left: r.left, place: placement }) } }
  const show = () => {
    if (document.body.classList.contains('col-dragging')) return
    clearTimeout(timer.current)
    const warm = performance.now() - lastHcHide < 350
    if (delay > 0 && !warm) timer.current = setTimeout(place, delay)
    else place()
  }
  const hide = () => { clearTimeout(timer.current); lastHcHide = performance.now(); setPos(null) }
  useEffect(() => () => clearTimeout(timer.current), [])
  // Keep the card fully on-screen: clamp horizontally to the viewport, and flip
  // above↔below when the chosen side has no room. Runs after the card mounts so
  // it can measure the card's real size; the guard prevents a re-render loop.
  useLayoutEffect(() => {
    if (!pos || !cardRef.current || !ref.current) return
    const c = cardRef.current.getBoundingClientRect()
    const a = ref.current.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight, m = 8
    let left = pos.left, place = pos.place
    if (left + c.width > vw - m) left = vw - m - c.width
    if (left < m) left = m
    if (place === 'above' && a.top - c.height - 6 < m) place = 'below'
    else if (place === 'below' && a.bottom + c.height + 6 > vh - m) place = 'above'
    const top = place === 'below' ? a.bottom + 6 : a.top - 6
    if (left !== pos.left || place !== pos.place || top !== pos.top) setPos({ top, left, place })
  }, [pos])
  return (
    <span className="h10-hc-anchor" ref={ref} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos && createPortal(
        <div ref={cardRef} className={`h10-hc ${pos.place}`} style={{ top: pos.top, left: pos.left }} role="tooltip">
          {text != null ? <div className="r1">{text}</div> : (rows ?? []).map(([k, v]) => <div className="r" key={k}><b className="k">{k}:</b> <span className="v">{v}</span></div>)}
        </div>, document.body,
      )}
    </span>
  )
}
