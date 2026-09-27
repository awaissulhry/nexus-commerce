'use client'

/**
 * MediaPickList — a searchable list of choices, each with its picture or swatch, ticked one or many at a time.
 *
 * The list inside Shopify's bulk-editor pop-ups, measured 2026-09-27 (docs/sheet-popup-editor/PLAN-2026-09-27.md §2):
 * a search line, then rows of `tick · swatch or picture · name`, grouped ("store entries" / "Default entries"), with
 * "Add new entry" under them. The same list serves a metaobject field, a product picker and the variation values.
 *
 * Rules it keeps:
 *   - It does NOT position itself and does NOT portal. It renders where it is put, so inside an AG pop-up editor it
 *     stays inside the pop-up's DOM and a click on a row is not a click "outside" (the R-VT-8 trap).
 *   - It owns its keys (↑ ↓ Home End PageUp PageDown, Space and Enter tick) and ALSO hands them out: `handleKey`
 *     on the ref lets a caller that keeps focus in its own field — the chip field's search line — drive the same
 *     highlight, the way `ListboxPanel.activeIndex` exists for the formula editor.
 *   - A click on a row never takes focus from the search field (the pointer-down default is prevented), so typing
 *     can continue after a click.
 *   - `local` search ranks in memory; `remote` shows the page the server returned for the query as given.
 *   - A held row is reachable and read out with its reason, and never ticks.
 */
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react'
import { Check, Plus, Search } from 'lucide-react'

import { Button } from '../primitives/Button'
import { Input } from '../primitives/Input'
import { Spinner } from '../primitives/Spinner'
import { anyMedia, filterChoices, groupChoices, groupOrderOf, nextActiveIndex, type ListKey, type MediaChoice, type PickMode } from '../lib/media-choice'
import { MediaMark } from './MediaChoice'

export interface MediaPickListHandle {
  /** Run a key the caller received. Returns true when the list used it (the caller then stops it). */
  handleKey: (event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> & { preventDefault(): void }) => boolean
  /** The highlighted row's DOM id, for `aria-activedescendant` on the caller's field. */
  activeId: () => string | undefined
  /** The list's DOM id, for `aria-controls` on the caller's field. */
  listId: string
}

export interface MediaPickListProps {
  /** Accessible name of the list ("Colour entries"). */
  label: string
  choices: readonly MediaChoice[]
  selected: readonly string[]
  onToggle: (value: string) => void
  mode?: PickMode
  /** `local` filters in memory, `remote` trusts the caller's list for the query, `none` shows no search. */
  search?: 'local' | 'remote' | 'none'
  /** Controlled query. Leave undefined and the list keeps its own. */
  query?: string
  onQueryChange?: (query: string) => void
  /** Render the list's own search field. False when the caller has a field of its own (the chip field). */
  searchField?: boolean
  searchPlaceholder?: string
  loading?: boolean
  /** A read failed — shown instead of the empty text, so "none" is never claimed when the answer is "could not ask". */
  error?: string | null
  emptyText?: string
  hasMore?: boolean
  onLoadMore?: () => void
  /** "Add new entry". Called with the current query, so the new entry can start from what was typed. */
  createLabel?: string
  onCreate?: (query: string) => void
  /**
   * Enter on the list. Default: tick the highlighted row. A host that uses Enter for "save" (a grid cell editor)
   * takes it here instead; the list then leaves Enter alone.
   */
  onEnterKey?: (active: MediaChoice | undefined) => void
  /**
   * Buttons at the end of a row (e.g. "Edit entry" on a picked entry). A click inside them never ticks the row.
   * Keep them few: the row's own click is the main action.
   */
  rowActions?: (choice: MediaChoice, picked: boolean) => ReactNode
  /** The highlighted row changed — its DOM id, for `aria-activedescendant` on a caller's own field. */
  onActiveChange?: (optionId: string | undefined) => void
  /** Scroll height of the rows; the search field and footer stay in view. */
  maxHeight?: number
  autoFocus?: boolean
  inputRef?: Ref<HTMLInputElement>
  className?: string
}

const LIST_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'])

export const MediaPickList = forwardRef<MediaPickListHandle, MediaPickListProps>(function MediaPickList(props, ref) {
  const {
    label, choices, selected, onToggle, mode = 'multi', search = 'local', query: controlledQuery, onQueryChange, searchPlaceholder = 'Search',
    loading = false, error = null, emptyText = 'No matches', hasMore = false, onLoadMore, createLabel, onCreate, onEnterKey, onActiveChange, rowActions, maxHeight = 280,
    autoFocus = false, inputRef, className,
  } = props
  const searchField = props.searchField ?? search !== 'none'
  const idPrefix = useId()
  const [ownQuery, setOwnQuery] = useState('')
  const query = controlledQuery ?? ownQuery
  const setQuery = (q: string) => { if (controlledQuery === undefined) setOwnQuery(q); onQueryChange?.(q) }

  const shown = useMemo(() => (search === 'local' ? filterChoices(query, choices) : choices.slice()), [search, query, choices])
  const groupOrder = useMemo(() => groupOrderOf(choices), [choices])
  const { groups, flat } = useMemo(() => groupChoices(shown, groupOrder), [shown, groupOrder])
  const withMedia = useMemo(() => anyMedia(flat), [flat])
  const [active, setActive] = useState(-1)
  /* A new query starts the highlight on the first usable row — typing "nero" and pressing Enter ticks Nero. */
  useEffect(() => { setActive(query ? nextActiveIndex(flat, -1, 'ArrowDown') : -1) }, [query, flat])

  const listRef = useRef<HTMLDivElement>(null)
  const ownInput = useRef<HTMLInputElement | null>(null)
  const optionId = (i: number) => `${idPrefix}-o${i}`
  useEffect(() => {
    onActiveChange?.(active >= 0 ? optionId(active) : undefined)
    if (active < 0) return
    listRef.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' })
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!autoFocus) return
    ;(ownInput.current ?? listRef.current)?.focus()
  }, [autoFocus])

  const tick = (choice: MediaChoice | undefined) => {
    if (!choice || choice.disabled || choice.heldReason) return
    onToggle(choice.value)
  }

  const handleKey: MediaPickListHandle['handleKey'] = event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return false
    if (LIST_KEYS.has(event.key)) {
      event.preventDefault()
      setActive(current => nextActiveIndex(flat, current, event.key as ListKey))
      return true
    }
    if (event.key === ' ' && active >= 0 && !query) {
      /* Space ticks — except while a query is being typed (in this list's field or the caller's), where it is a space. */
      event.preventDefault()
      tick(flat[active])
      return true
    }
    if (event.key === 'Enter') {
      if (onEnterKey) { onEnterKey(flat[active]); return false }
      if (active < 0) return false
      event.preventDefault()
      tick(flat[active])
      return true
    }
    return false
  }
  useImperativeHandle(ref, () => ({ handleKey, activeId: () => (active >= 0 ? optionId(active) : undefined), listId: `${idPrefix}-list` }))

  const onKeyDown = (event: ReactKeyboardEvent) => { if (handleKey(event)) event.stopPropagation() }
  const setInput = (el: HTMLInputElement | null) => {
    ownInput.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el
  }

  let index = -1
  const body = (() => {
    if (loading && flat.length === 0) return <div className="nds-mpick-state" role="status"><Spinner size={14} /> Loading…</div>
    if (error && flat.length === 0) return <div className="nds-mpick-state error" role="alert">{error}</div>
    if (flat.length === 0) return <div className="nds-mpick-state">{emptyText}</div>
    return groups.map(group => (
      <div key={group.name || '_'} role="group" aria-label={group.name || undefined}>
        {group.name && <div className="nds-mpick-group" aria-hidden>{group.name}</div>}
        {group.choices.map(choice => {
          index += 1
          const i = index
          const on = selected.includes(choice.value)
          const held = !!choice.heldReason
          return (
            <div key={choice.value} id={optionId(i)} role="option" aria-selected={on} aria-disabled={choice.disabled || held || undefined}
              className={['nds-mpick-row', i === active ? 'active' : '', on ? 'on' : '', choice.disabled ? 'disabled' : '', held ? 'held' : ''].filter(Boolean).join(' ')}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => { if (!choice.disabled) setActive(i) }}
              onClick={() => tick(choice)}>
              {mode === 'multi' && <span className="nds-mpick-box" aria-hidden>{on && <Check size={12} strokeWidth={3} />}</span>}
              {withMedia && <span className="nds-mpick-media"><MediaMark choice={choice} /></span>}
              <span className="nds-mpick-text">
                <span className="nds-mpick-label">{choice.label}</span>
                {choice.detail && <span className="nds-mpick-detail">{choice.detail}</span>}
                {held && <span className="nds-mpick-held">{choice.heldReason}</span>}
              </span>
              {rowActions && (() => { const actions = rowActions(choice, on); return actions ? <span className="nds-mpick-actions" onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}>{actions}</span> : null })()}
              {mode === 'single' && on && <Check className="nds-mpick-check" size={16} aria-hidden />}
            </div>
          )
        })}
      </div>
    ))
  })()

  return (
    <div className={['nds-mpick', className].filter(Boolean).join(' ')}>
      {searchField && (
        <Input size="sm" ref={setInput} value={query} placeholder={searchPlaceholder} leadingIcon={<Search size={14} aria-hidden />}
          aria-label={searchPlaceholder} role="combobox" aria-expanded aria-controls={`${idPrefix}-list`}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} fieldClassName="nds-mpick-search" />
      )}
      <div ref={listRef} id={`${idPrefix}-list`} role="listbox" aria-label={label} aria-multiselectable={mode === 'multi' || undefined}
        aria-busy={loading || undefined} tabIndex={searchField ? -1 : 0} className="nds-mpick-list" style={{ maxHeight }}
        aria-activedescendant={!searchField && active >= 0 ? optionId(active) : undefined} onKeyDown={onKeyDown}>
        {body}
        {hasMore && onLoadMore && (
          <div className="nds-mpick-more">
            <Button size="xs" variant="ghost" onClick={onLoadMore} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</Button>
          </div>
        )}
      </div>
      {onCreate && (
        <div className="nds-mpick-foot">
          <Button size="sm" variant="ghost" onClick={() => onCreate(query)}><Plus size={14} aria-hidden /> {createLabel ?? 'Add new entry'}</Button>
        </div>
      )}
    </div>
  )
})
