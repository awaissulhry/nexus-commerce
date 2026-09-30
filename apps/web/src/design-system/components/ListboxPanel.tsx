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
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Search } from 'lucide-react'
import { groupOptions } from '../lib/group-options'
import { nextActiveIndex } from '../lib/media-choice'
import { searchOptions, searchTokens } from '../lib/option-search'
import type { ListboxOption } from './Listbox'

/**
 * Past this many options the panel offers its own search field (D18: search at 9+, so the field
 * appears when there are MORE than 8). Below it the list is short enough to read.
 */
export const LISTBOX_SEARCH_THRESHOLD = 8
// -1 means no highlighted value. Clear needs its own position without shifting callers' option indices.
const CLEAR_INDEX = -2

/**
 * A panel option may be HELD: reachable and announced, never committed (Step 4.3 #2). The scope menu
 * uses it for a channel the operator cannot open yet — the same rule as a held ScopeBar chip, whose
 * refusal must stay readable. `disabled` would take it out of the keyboard's reach instead.
 */
export type ListboxPanelOption = ListboxOption & { heldReason?: string }

export interface ListboxPanelProps {
  options: ListboxPanelOption[]
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
  /** The panel's own ↑/↓ moved the highlight. Clear is -2; -1 means no choice. Fires in both modes. */
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
  /**
   * Text the panel's own search field starts with: the key that opened a grid cell by typing (AG's `eventKey`). The grid
   * consumed that keystroke to start the edit, so without this the first character was lost ("Cin" searched "in").
   */
  initialQuery?: string
  /**
   * Offer the typed text as a value of its own — `Use "…"` — for a list the channel leaves open (an eBay FREE_TEXT aspect,
   * an Amazon open enum). It is the FIRST row, so it is always in view, but the best match stays highlighted: Enter takes
   * "Nero" for "Ner", ↑ takes the typed text. When every typed word is a WHOLE word of that match ("Cotone" for "Cotone
   * biologico") the typed text is highlighted instead: it is a value, not the start of one (audit B23). With no match it
   * is the only row, and Enter takes it.
   */
  allowCustom?: boolean
  /**
   * Enter or Tab chose the highlighted option, reported in the CAPTURE phase, before a grid ends the edit. AG's popup
   * listener runs before this panel's bubble `onKeyDown` and commits whatever the editor last reported, so a grid editor
   * reports the value here and lets the grid commit and move (Enter down, Tab right). `null` = nothing is highlighted:
   * keep the stored value. When supplied, Enter is the owner's, and the panel does not also commit it.
   *
   * `end` is set for Ctrl/Cmd+Enter only: the panel keeps that key from the grid, whose Ctrl+Enter writes the value into
   * EVERY cell of the selected ranges with no fence and no question (audit B14). The owner ends the edit itself with
   * `stopEditing(false, end)`, so it saves this one cell and moves down, as Enter does. An Enter that confirms an IME
   * composition never reaches the grid and reports nothing (audit B18).
   */
  onKeyChoice?: (value: string | null, end?: KeyboardEvent) => void
}

/**
 * How many rows PageUp / PageDown move: the rows in view, less one kept for context. 8 (the panel's `--nds-combo-rows`)
 * when nothing can be measured.
 */
export function listboxPageSize(host: HTMLElement | null | undefined): number {
  const row = host?.querySelector<HTMLElement>('button[role="option"]')
  return host && row && row.offsetHeight ? Math.max(1, Math.floor(host.clientHeight / row.offsetHeight) - 1) : 8
}

const sameText = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
/** Every word of `typed` is a whole word of the option (not merely the start of one). */
const wholeWordsOf = (typed: string, o: ListboxOption) => {
  const words = new Set(searchTokens(typeof o.label === 'string' ? o.label : o.value))
  const t = searchTokens(typed)
  return t.length > 0 && t.every((w) => words.has(w))
}

export function ListboxPanel({
  options, value, onCommit, onCancel, query, searchable, searchPlaceholder = 'Search…',
  emptyLabel, autoFocus = true, style, className, panelRef,
  activeIndex, onActiveIndexChange, onMatchesChange, idPrefix, ariaLabel, optionTabIndex,
  initialQuery, allowCustom, onKeyChoice,
}: ListboxPanelProps) {
  const [ownQuery, setOwnQuery] = useState(initialQuery ?? '')
  /**
   * `null` until the operator moves: the highlight then IS the selected row (Step 4.3 #2, T1). It
   * used to start at 0 while the panel's Enter commits `matches[active]` — so opening a short list
   * on "Bravo" and pressing Enter committed "Alpha", a hidden row 1 (proved by
   * `listboxPanelKeys.vitest.test.ts` before this fix).
   */
  const [ownActive, setOwnActive] = useState<number | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const controlled = activeIndex !== undefined
  /**
   * One place that both moves the panel's own index and tells a controlled owner.
   *
   * 🔴 It composes off a REF, not off the rendered `active`. Two ArrowDowns that land in one React
   * batch would otherwise both compute from the same stale number and the highlight would move one
   * row for two presses — the exact behaviour a functional `setState` gave for free before this
   * function existed. The callback cannot go inside the updater instead: StrictMode double-invokes
   * updaters, and a listener that fires twice per press is worse than the bug it replaces.
   */
  const activeRef = useRef(0)
  const moveActive = (next: (current: number) => number) => {
    const n = next(activeRef.current)
    activeRef.current = n
    if (!controlled) setOwnActive(n)
    onActiveIndexChange?.(n)
    return n
  }

  // An externally supplied query means the caller owns the input, so the panel renders none.
  const external = query !== undefined
  const ownsSearch = !external && (searchable || allowCustom || !!initialQuery || options.length > LISTBOX_SEARCH_THRESHOLD)
  /* A searching panel keeps DOM focus in its own field, so the field is a combobox pointing at the highlighted row and the
     options sit in a listbox of their own, beside it — a screen reader heard nothing as the operator walked the list, and
     the field sat inside role=listbox (audit B19). Its rows need ids for that, with or without `idPrefix`. */
  const ownId = useId()
  const ids = idPrefix ?? (ownsSearch ? ownId : undefined)
  const q = external ? query : ownQuery
  const filtering = ownsSearch || external

  const ranked = filtering ? searchOptions(q, options, (o) => o.searchText ?? o.label) : options
  // Group headings are visual, but they REORDER the list, and keyboard nav indexes a flat array.
  // `groupOptions` returns both halves together so they cannot drift apart — see its tests.
  const grouped = groupOptions(ranked)
  const groups = grouped?.groups ?? null
  const listed = grouped?.flat ?? ranked
  const typed = allowCustom && !external ? q.trim() : ''
  const custom: ListboxOption | null = typed && !options.some((o) => sameText(o.value, typed) || (typeof o.label === 'string' && sameText(o.label, typed)))
    ? { value: typed, label: `Use "${typed}"` }
    : null
  const matches = custom ? [custom, ...listed] : listed
  // While the operator types, the highlight starts on the best match — past the typed-text row when there is one, unless
  // the typed words are whole words of that match (above).
  const bestMatch = custom && listed.length && !wholeWordsOf(typed, listed[0]) ? 1 : 0
  /* A query with no search token ("-", "&", "#") matches every option, so it searches for nothing: the highlight stays on
     the stored value, as if nothing were typed. It jumped to row 1, and "-" then Enter replaced "Inverno" with "Estate"
     (audit B15). */
  const searching = ownsSearch && searchTokens(q).length > 0
  const hasOwnEmpty = options.some((o) => o.value === '')
  const showClear = emptyLabel != null && !hasOwnEmpty
  const selectedIndex = matches.findIndex((o) => o.value === value)
  /* A stored value that is not in the list highlights NOTHING until the operator moves or types, so Enter keeps a value it
     cannot show instead of committing row 1 in its place (P0, 2026-09-30: an Amazon product type was overwritten so). */
  const active = controlled ? activeIndex : ownActive ?? (searching ? bestMatch : selectedIndex >= 0 ? selectedIndex : q && !ownsSearch ? 0 : -1)
  activeRef.current = active
  const heldReason = (o: ListboxOption) => (o as ListboxPanelOption).heldReason

  // An external query changes the list under the cursor; an active index into the old list is a
  // highlight on the wrong row. A CONTROLLED owner resets its own index — doing it here as well
  // would fight it, and the panel does not own that number.
  // Not on mount: the highlight starts on the selected row (above) and a mount reset would undo it.
  const lastQuery = useRef(query)
  useEffect(() => {
    if (lastQuery.current === query) return
    lastQuery.current = query
    if (!controlled) setOwnActive(0)
  }, [query, controlled])

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
    // A searching panel moves its highlight with ↑/↓ while focus stays in the search field, so it is kept in view too.
    if (!controlled && !filtering) return
    const host = hostRef.current
    const row = host?.querySelectorAll<HTMLElement>('button[role="option"]')[active === CLEAR_INDEX && showClear ? 0 : active + (showClear ? 1 : 0)]
    if (!host || !row) return
    if (active === 0 || active === CLEAR_INDEX) { host.scrollTop = 0; return }
    // The panel may be static inside a positioned editor. offsetTop belongs to that ancestor,
    // so measure within this scroll viewport instead of counting the editor's preceding tools.
    const top = row.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - host.clientTop
    const bottom = top + row.offsetHeight
    // The panel's own search field is sticky, so a row scrolled to the top edge would sit under it.
    const head = ownsSearch ? host.querySelector<HTMLElement>('.nds-combo-search')?.offsetHeight ?? 0 : 0
    if (top - head < host.scrollTop) host.scrollTop = top - head
    else if (bottom > host.scrollTop + host.clientHeight) host.scrollTop = bottom - host.clientHeight
  }, [controlled, filtering, ownsSearch, active, matchKey, showClear])

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

  // With no search field there is no other focusable element in the panel. Before paint (a layout effect), like the
  // search field's own `autoFocus`: a key pressed as soon as the list shows must reach the list, not the cell under it
  // (P2, 2026-09-30 — measured: an Enter-then-ArrowDown on a busy page reached the grid cell and Tab then committed nothing).
  useLayoutEffect(() => {
    if (autoFocus && !ownsSearch) hostRef.current?.focus()
  }, [autoFocus, ownsSearch])

  const renderOption = (o: ListboxOption, i: number) => (
    <button key={o.value} type="button" role="option" aria-selected={o.value === value} disabled={o.disabled}
      id={ids ? `${ids}-o${i}` : undefined} tabIndex={optionTabIndex}
      className={[o.value === value ? 'on' : '', (filtering || controlled) && i === active ? 'active' : '', heldReason(o) ? 'held' : ''].filter(Boolean).join(' ') || undefined}
      title={heldReason(o) ?? o.title ?? o.label}
      aria-disabled={heldReason(o) ? true : undefined}
      aria-description={heldReason(o)}
      // Tab (or a click) onto an option makes it the one Enter commits. A controlled owner keeps its index.
      onFocus={controlled ? undefined : () => { if (activeRef.current !== i) moveActive(() => i) }}
      onClick={() => { if (!heldReason(o)) onCommit(o.value) }}>
      {o.leading != null && <span className="nds-listbox-lead">{o.leading}</span>}
      {o.trailing != null ? <><span className="nds-listbox-label">{o.label}</span><span className="nds-listbox-trailing">{o.trailing}</span></> : o.label}
    </button>
  )

  const activeId = !ids ? undefined : active === CLEAR_INDEX && showClear ? `${ids}-o${CLEAR_INDEX}` : active >= 0 && matches[active] ? `${ids}-o${active}` : undefined
  const rows = <>
    {showClear && (
      <button type="button" role="option" aria-selected={!value} tabIndex={optionTabIndex}
        id={ids ? `${ids}-o${CLEAR_INDEX}` : undefined}
        className={[!value ? 'on' : '', (filtering || controlled) && active === CLEAR_INDEX ? 'active' : ''].filter(Boolean).join(' ') || undefined}
        onFocus={controlled ? undefined : () => { if (activeRef.current !== CLEAR_INDEX) moveActive(() => CLEAR_INDEX) }}
        onClick={() => onCommit('')}>
        {emptyLabel}
      </button>
    )}
    {groups
      ? (() => {
          let i = custom ? 0 : -1
          return [
            custom && renderOption(custom, 0),
            ...groups.map((g) => (
              <div className="nds-combo-group" role="group" aria-label={g.name || undefined} key={g.name}>
                {g.name !== '' && <div className="nds-combo-grouphd" aria-hidden>{g.name}</div>}
                {g.options.map((o) => { i += 1; return renderOption(o, i) })}
              </div>
            )),
          ]
        })()
      : matches.map((o, i) => renderOption(o, i))}
  </>

  return (
    <div
      ref={(n) => {
        hostRef.current = n
        if (typeof panelRef === 'function') panelRef(n)
        else if (panelRef) (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = n
      }}
      style={style}
      className={['nds-combo-pop', 'nds-listbox-pop', className].filter(Boolean).join(' ')}
      id={!ownsSearch && ids ? `${ids}-listbox` : undefined}
      role={ownsSearch ? undefined : 'listbox'}
      aria-label={ownsSearch ? undefined : ariaLabel}
      tabIndex={-1}
      onKeyDownCapture={onKeyChoice ? (e) => {
        if (e.key !== 'Enter' && e.key !== 'Tab') return
        if (e.nativeEvent.isComposing) { if (e.key === 'Enter') e.stopPropagation(); return }
        // Not also a click: Enter on a focused option button would activate it and commit a second time (code review).
        if (e.key === 'Enter') e.preventDefault()
        const ranged = e.key === 'Enter' && (e.ctrlKey || e.metaKey)
        if (ranged) e.stopPropagation()
        const m = active >= 0 ? matches[active] : undefined
        const chosen = active === CLEAR_INDEX && showClear ? '' : m && !m.disabled && !heldReason(m) ? m.value : null
        if (ranged) onKeyChoice(chosen, e.nativeEvent)
        else onKeyChoice(chosen)
      } : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const n = moveActive((i) => {
            if (e.key === 'ArrowUp') return i <= 0 && showClear ? CLEAR_INDEX : Math.max(i - 1, 0)
            if (i === CLEAR_INDEX) return matches.length ? 0 : CLEAR_INDEX
            return Math.min(i + 1, matches.length - 1)
          })
          // A short uncontrolled list draws no `.active` row, so the focus ring IS the highlight: move it.
          if (!filtering && !controlled) hostRef.current?.querySelectorAll<HTMLElement>('button[role="option"]')[n === CLEAR_INDEX ? 0 : n + (showClear ? 1 : 0)]?.focus()
        }
        /* A page of rows, and the ends (audit B20): PageDown scrolled the panel and left the highlight — and Enter's row —
           out of view. Home and End stay the search field's caret keys where there is one. */
        else if (e.key === 'PageDown' || e.key === 'PageUp' || ((e.key === 'Home' || e.key === 'End') && !ownsSearch)) {
          e.preventDefault()
          const n = moveActive((i) => {
            const next = nextActiveIndex(matches, i === CLEAR_INDEX ? -1 : i, e.key as 'PageDown' | 'PageUp' | 'Home' | 'End', listboxPageSize(hostRef.current))
            return next === -1 ? i : next
          })
          if (!filtering && !controlled) hostRef.current?.querySelectorAll<HTMLElement>('button[role="option"]')[n + (showClear ? 1 : 0)]?.focus()
        }
        else if (e.key === 'Enter' && !onKeyChoice) {
          if (active === CLEAR_INDEX && showClear) { e.preventDefault(); onCommit(''); return }
          const m = matches[active]
          if (m) { e.preventDefault(); if (!m.disabled && !heldReason(m)) onCommit(m.value) }
        }
      }}
    >
      {ownsSearch && (
        <div className="nds-combo-search">
          <Search size={13} aria-hidden />
          <input autoFocus={autoFocus} value={ownQuery} onChange={(e) => { setOwnQuery(e.target.value); if (controlled) moveActive(() => 0); else setOwnActive(null) }}
            placeholder={searchPlaceholder} aria-label={ariaLabel ? `Search ${ariaLabel}` : 'Search options'}
            role="combobox" aria-autocomplete="list" aria-expanded aria-controls={`${ids}-listbox`} aria-activedescendant={activeId} />
        </div>
      )}
      {/* Nothing searched and only Clear to offer (a picker's choices not loaded yet): Clear is the list, not "No matches". */}
      {matches.length === 0 && !(showClear && !q) && <div className="nds-combo-empty">No matches</div>}
      {ownsSearch ? <div role="listbox" id={`${ids}-listbox`} aria-label={ariaLabel}>{rows}</div> : rows}
    </div>
  )
}
