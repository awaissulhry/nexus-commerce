'use client'

/**
 * ListboxPanel — the closed-list popover panel, with no trigger and no opinion about where it sits.
 *
 * Extracted from `Listbox` for D18 so the grid's `=`-mode editor and the studio's selects render the
 * SAME panel rather than two that resemble each other. `Listbox` is now this plus a trigger; AG's
 * custom cell editor is this plus AG's own mounting. One implementation, one look.
 *
 * 🔴 THIS COMPONENT DOES NOT POSITION ITSELF, and that is deliberate rather than an omission.
 * `position` comes from `style`, which whoever owns placement supplies — `Listbox` passes
 * `usePopoverPosition`'s output; AG passes coordinates for its own popup. `.nds-combo-pop`
 * deliberately no longer declares `position: fixed`, because a class that positions itself is wrong
 * for any consumer that is not the one it was written for: inside AG's absolutely-positioned popup a
 * `fixed` child anchors to the VIEWPORT, ignores AG's placement and does not move when the popup
 * does (AG.1, D18 gotcha 4). It would look correct in isolation and be wrong in the grid.
 *
 * 🔴 IT OWNS ITS OWN KEYBOARD, and that is also the fix for a bug that did not exist yet. In
 * `Listbox` the handler sat on the wrapper `div` and reached the portalled panel only because React
 * propagates events through the REACT tree, not the DOM tree. Mounted by anyone outside that tree —
 * exactly what AG does — the panel would have had no keyboard support and thrown no error. Behaviour
 * that is a property of the tree rather than of the component vanishes silently when the tree
 * changes, so it lives here now.
 *
 * 🔴 IT ALWAYS HAS A FOCUS TARGET. The only focus management used to be `autoFocus` on the search
 * input, and D18 hides that below 9 options — so on exactly the short lists D18 simplified there
 * would have been nothing focusable and the arrow keys would have landed nowhere. The container is
 * `tabIndex={-1}` and takes focus when there is no search field.
 *
 * 🔴 THE HIGHLIGHT CAN BE DRIVEN FROM OUTSIDE (`activeIndex`), and that exists because owning the
 * keyboard is not the same as being ABLE to receive it. `FormulaCellEditor` keeps DOM focus in the
 * cell's input — the operator is typing a formula — so this panel's own `onKeyDown` never fires, and
 * two attempts to forward the keys to it failed on the live page (a React handler cannot
 * `stopPropagation` past AG's lower native listener; a re-dispatching capture listener recursed).
 * The editor therefore had to drop ↑/↓ and ship Tab-accepts-best-match instead
 * (`FormulaCellEditor.tsx`, the keyboard note). An external index is the fix that does not race
 * anyone: whoever holds focus reads the keys it already receives and tells the panel what is
 * highlighted. Leave it undefined and nothing about this component changes.
 *
 * Requires `styles/components.css`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Search } from 'lucide-react'
import { groupOptions } from '../lib/group-options'
import { searchOptions } from '../lib/option-search'
import type { ListboxOption } from './Listbox'

/**
 * Past this many options the panel offers its own search field (D18: search at 9+, so the field
 * appears when there are MORE than 8). Below it the list is short enough to read.
 */
export const LISTBOX_SEARCH_THRESHOLD = 8

export interface ListboxPanelProps {
  options: ListboxOption[]
  /** the currently selected value; highlighted and scrolled into view on mount */
  value?: string
  /** the operator chose an option */
  onCommit: (value: string) => void
  /** Escape, or any other reason the owner should close without changing anything */
  onCancel: () => void
  /**
   * Filter the list from OUTSIDE, and render no search field of the panel's own.
   *
   * For a caller that already has the text the operator is typing — the grid's `=`-mode editor
   * filters `$column` autocomplete from a cell the operator is typing INTO, so a second input
   * inside the panel would be a second place to type. Leave it undefined and the panel owns its
   * own query, with the field appearing past `LISTBOX_SEARCH_THRESHOLD`.
   */
  query?: string
  /** force the panel's own search field below the threshold */
  searchable?: boolean
  searchPlaceholder?: string
  /** a "nothing selected" row at the top of the list */
  emptyLabel?: string
  /**
   * Take DOM focus on mount. Default true — without it the arrow keys have nowhere to land. AG
   * focuses its own popup on open, so it can pass `false` to yield rather than have the two fight.
   */
  autoFocus?: boolean
  /** Placement, supplied by whoever owns it. See the note above on why this is not optional in practice. */
  style?: CSSProperties
  className?: string
  /**
   * The panel's DOM node, for whoever measures it to place it. `Listbox` hands this to
   * `usePopoverPosition`; AG uses it for its own popup sizing.
   */
  panelRef?: React.Ref<HTMLDivElement>
  /**
   * Drive the highlight from OUTSIDE. Undefined — the default — leaves the panel exactly as it was:
   * it keeps its own index, resets it when an external `query` changes, and moves it on ↑/↓ when it
   * has focus.
   *
   * Supplied, the panel is controlled: it renders this index, never sets its own, and scrolls that
   * row into view when the number changes (the caller cannot — the scroll container is in here).
   * An index past the end of the list highlights nothing rather than throwing; the caller learns the
   * real length from `onMatchesChange`, which is also the ONLY honest way to index this list, because
   * the panel re-ranks and groups what it is given (`searchOptions` + `groupOptions`) and a caller
   * counting its own array would be counting a different one.
   */
  activeIndex?: number
  /** The panel's own ↑/↓ moved the highlight. Fires in both modes; controlled callers store it. */
  onActiveIndexChange?: (index: number) => void
  /** The flat, ranked, grouped list this panel is actually showing — index space for `activeIndex`. */
  onMatchesChange?: (matches: readonly ListboxOption[]) => void
  /**
   * Give every option a stable DOM id (`${idPrefix}-o${index}`), so a caller keeping focus in its own
   * field can point `aria-activedescendant` at the highlighted row. Without this a screen reader
   * follows focus, which never moves, and hears nothing as the operator walks the list.
   */
  idPrefix?: string
  /** Accessible name when embedded beneath an autocomplete input. */
  ariaLabel?: string
  /** A combobox input can own keyboard focus while its options stay out of the Tab order. */
  optionTabIndex?: number
}

export function ListboxPanel({
  options, value, onCommit, onCancel, query, searchable, searchPlaceholder = 'Search…',
  emptyLabel, autoFocus = true, style, className, panelRef,
  activeIndex, onActiveIndexChange, onMatchesChange, idPrefix, ariaLabel, optionTabIndex,
}: ListboxPanelProps) {
  const [ownQuery, setOwnQuery] = useState('')
  const [ownActive, setOwnActive] = useState(0)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const controlled = activeIndex !== undefined
  const active = controlled ? activeIndex : ownActive
  /**
   * One place that both moves the panel's own index and tells a controlled owner.
   *
   * 🔴 It composes off a REF, not off the rendered `active`. Two ArrowDowns that land in one React
   * batch would otherwise both compute from the same stale number and the highlight would move one
   * row for two presses — the exact behaviour a functional `setState` gave for free before this
   * function existed. The callback cannot go inside the updater instead: StrictMode double-invokes
   * updaters, and a listener that fires twice per press is worse than the bug it replaces.
   */
  const activeRef = useRef(active)
  activeRef.current = active
  const moveActive = (next: (current: number) => number) => {
    const n = next(activeRef.current)
    activeRef.current = n
    if (!controlled) setOwnActive(n)
    onActiveIndexChange?.(n)
  }

  // An externally supplied query means the caller owns the input, so the panel renders none.
  const external = query !== undefined
  const ownsSearch = !external && (searchable || options.length > LISTBOX_SEARCH_THRESHOLD)
  const q = external ? query : ownQuery
  const filtering = ownsSearch || external

  const ranked = filtering ? searchOptions(q, options, (o) => o.searchText ?? o.label) : options
  // Group headings are visual, but they REORDER the list, and keyboard nav indexes a flat array.
  // `groupOptions` returns both halves together so they cannot drift apart — see its tests.
  const grouped = groupOptions(ranked)
  const groups = grouped?.groups ?? null
  const matches = grouped?.flat ?? ranked
  const hasOwnEmpty = options.some((o) => o.value === '')
  const showClear = emptyLabel != null && !hasOwnEmpty

  // An external query changes the list under the cursor; an active index into the old list is a
  // highlight on the wrong row. A CONTROLLED owner resets its own index — doing it here as well
  // would fight it, and the panel does not own that number.
  useEffect(() => { if (!controlled) setOwnActive(0) }, [query, controlled])

  /**
   * Hand the caller the list it must index into. Keyed on the VALUES, not the array identity, which
   * is new on every render — depending on the array would call this every render forever.
   */
  const matchKey = matches.map((m) => m.value).join('\u0000')
  useEffect(() => {
    onMatchesChange?.(matches)
    // `matches` is derived from `matchKey`; depending on it would re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey])

  /**
   * Keep a controlled highlight visible. The uncontrolled path deliberately does NOT do this: it
   * would be a behaviour change for `Listbox` and `SelectPanelEditor`, who did not ask for one.
   * (That the panel's own ↑/↓ can walk the highlight below the fold is a real gap — reported, not
   * fixed here.)
   */
  useLayoutEffect(() => {
    if (!controlled) return
    const host = hostRef.current
    const row = host?.querySelectorAll<HTMLElement>('button[role="option"]')[active + (showClear ? 1 : 0)]
    if (!host || !row) return
    if (active === 0) { host.scrollTop = 0; return }
    // The panel may be static inside a positioned editor. offsetTop belongs to that ancestor,
    // so measure within this scroll viewport instead of counting the editor's preceding tools.
    const top = row.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - host.clientTop
    const bottom = top + row.offsetHeight
    if (top < host.scrollTop) host.scrollTop = top
    else if (bottom > host.scrollTop + host.clientHeight) host.scrollTop = bottom - host.clientHeight
  }, [controlled, active, matchKey, showClear])

  // D18 — the selected value is scrolled into view, not merely highlighted. Measured 2026-09-02 on
  // the studio's 12-option market Listbox: `selectedInView: false`, `scrollTop: 0` — the current
  // value was highlighted below the fold, which is a highlight the operator cannot see.
  // Scrolls the PANEL only, never `scrollIntoView`, which would also scroll the page behind it.
  useLayoutEffect(() => {
    const host = hostRef.current
    const sel = host?.querySelector<HTMLElement>('button[aria-selected="true"]')
    if (!host || !sel) return
    const top = sel.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - host.clientTop
    const bottom = top + sel.offsetHeight
    if (top < host.scrollTop) host.scrollTop = top
    else if (bottom > host.scrollTop + host.clientHeight) host.scrollTop = bottom - host.clientHeight
    // mount only: re-running as the operator filters would fight their scrolling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // With no search field there is no other focusable element in the panel.
  useEffect(() => {
    if (autoFocus && !ownsSearch) hostRef.current?.focus()
  }, [autoFocus, ownsSearch])

  const renderOption = (o: ListboxOption, i: number) => (
    <button key={o.value} type="button" role="option" aria-selected={o.value === value} disabled={o.disabled}
      id={idPrefix ? `${idPrefix}-o${i}` : undefined} tabIndex={optionTabIndex}
      className={[o.value === value ? 'on' : '', (filtering || controlled) && i === active ? 'active' : ''].filter(Boolean).join(' ') || undefined}
      title={o.title ?? o.label}
      onClick={() => onCommit(o.value)}>
      {o.leading != null && <span className="nds-listbox-lead">{o.leading}</span>}
      {o.trailing != null ? <><span className="nds-listbox-label">{o.label}</span><span className="nds-listbox-trailing">{o.trailing}</span></> : o.label}
    </button>
  )

  return (
    <div
      ref={(n) => {
        hostRef.current = n
        if (typeof panelRef === 'function') panelRef(n)
        else if (panelRef) (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = n
      }}
      style={style}
      className={['nds-combo-pop', 'nds-listbox-pop', className].filter(Boolean).join(' ')}
      id={idPrefix ? `${idPrefix}-listbox` : undefined}
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        else if (e.key === 'ArrowDown') { e.preventDefault(); moveActive((i) => Math.min(i + 1, matches.length - 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive((i) => Math.max(i - 1, 0)) }
        else if (e.key === 'Enter') { const m = matches[active]; if (m) { e.preventDefault(); onCommit(m.value) } }
      }}
    >
      {ownsSearch && (
        <div className="nds-combo-search">
          <Search size={13} aria-hidden />
          <input autoFocus={autoFocus} value={ownQuery} onChange={(e) => { setOwnQuery(e.target.value); moveActive(() => 0) }}
            placeholder={searchPlaceholder} aria-label="Search options" />
        </div>
      )}
      {showClear && (
        <button type="button" role="option" aria-selected={!value} className={!value ? 'on' : undefined}
          onClick={() => onCommit('')}>
          {emptyLabel}
        </button>
      )}
      {matches.length === 0 && <div className="nds-combo-empty">No matches</div>}
      {groups
        ? (() => {
            let i = -1
            return groups.map((g) => (
              <div className="nds-combo-group" role="group" aria-label={g.name || undefined} key={g.name}>
                {g.name !== '' && <div className="nds-combo-grouphd" aria-hidden>{g.name}</div>}
                {g.options.map((o) => { i += 1; return renderOption(o, i) })}
              </div>
            ))
          })()
        : matches.map((o, i) => renderOption(o, i))}
    </div>
  )
}
