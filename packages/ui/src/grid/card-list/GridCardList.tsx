'use client'

/**
 * GridCardList — a list's rows as cards on a phone (B-W2b-09, D3 / A2 gap G22; design 00-page-anatomy §2.1 item 10):
 * the same columns, sort, filter and selection as the table, so a phone never gets a second list that drifts.
 *
 *   const phone = useCardList()            // below 720 px
 *   phone ? <GridCardList label="Orders" rows={rows} rowId={(r) => r.id} columns={columns} hrefOf={(r) => href(r)}
 *             count={count} search={search} tools={tools} sort={sort} onSortChange={setSort}
 *             selection={{ selected, onChange, actions: bulkButtons }} isRowSelectable={why} labels={ds.cardList} />
 *         : <the list frame's grid … />
 *
 * - **Cards from the columns** (`cardFieldsOf`): the first shown column is the title (a real link with `hrefOf`), a
 *   column without a header the actions (the ⋯ menu), the rest label: value lines drawn by the column's own renderer.
 *   `fields` moves a column (`subtitle`, `aside`, `hidden`) or draws it differently on a card.
 * - **Sort and filter are the list's**: the search and the filter tools are the list's own controls passed in; the sort
 *   control writes the list's sort (`onSortChange`), the rows come in already sorted.
 * - **Select mode** (bulk on a phone): Select → a box on each card, the header box selects every loaded row that may be
 *   selected (mixed when some), the bulk actions appear while rows are selected, Done leaves and clears. A row that may
 *   not be selected keeps a held box with the reason. `x` toggles the card that holds the focus.
 * - States: `rows === null` → three skeleton cards ("Reading…" heard once); `state` replaces the cards (a failed read,
 *   nothing yet, nothing matching); `more` is the list's "Show N more".
 * Its own entry point (`grid/card-list`), not in the grid barrel. Every word from `labels` or the app.
 */
import { useMemo, useState, useSyncExternalStore, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'
import NextLink from 'next/link'
import type { ColDef } from 'ag-grid-community'

import { Button } from '../../primitives/Button'
import { Checkbox } from '../../primitives/Checkbox'
import { Select } from '../../primitives/Select'
import { Skeleton } from '../../primitives/Skeleton'
import { Tooltip } from '../../primitives/Tooltip'
import { mergeLabels } from '../../lib/labels'
import { CARD_LIST_LABELS, type CardListLabels } from './CardListLabels'
import {
  CARD_LIST_BELOW, cardFieldsOf, cardSelection, cardSortChoices, cardSortFrom, cardSortValue, cardToggle, cardToggleAll,
  type CardField, type CardFieldOverride, type CardSort,
} from './cardListModel'
import './card-list.css'

export type CardListLinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>

export interface GridCardListSelection {
  selected: readonly string[]
  onChange: (ids: string[]) => void
  /** The list's bulk actions (they say their reach), shown while rows are selected. */
  actions: ReactNode
}

export interface GridCardListProps<T> {
  /** The list's name for a screen reader ("Purchase orders"). */
  label: string
  /** The loaded rows (already filtered and sorted); null while the first page is read. */
  rows: readonly T[] | null
  rowId: (row: T) => string
  /** The list's columns — the same `ColDef`s the table draws. */
  columns: readonly ColDef<T>[]
  /** Per column id: its place on the card or its own drawing. */
  fields?: Readonly<Record<string, CardFieldOverride<T>>>
  /** The row's record: the title becomes a real link. */
  hrefOf?: (row: T) => string | null
  /** "11 of 132". */
  count?: ReactNode
  /** The list's search field. */
  search?: ReactNode
  /** The list's filter tools (saved views, Rows ▾). */
  tools?: ReactNode
  /** The list's sort; with `onSortChange` a sort control is drawn. */
  sort?: CardSort | null
  onSortChange?: (sort: CardSort | null) => void
  /** Multi-select with bulk actions (select mode). */
  selection?: GridCardListSelection
  /** Why a row may not be selected; null when it may. */
  isRowSelectable?: (row: T) => string | null
  /** Start in select mode (design cases). */
  selectMode?: boolean
  /** Drawn in place of the cards: a failed read, nothing yet, nothing matching. */
  state?: ReactNode
  /** The list's "Show N more". */
  more?: { label: string; onMore: () => void; held?: string | null } | null
  linkAs?: CardListLinkComponent
  labels?: Partial<CardListLabels>
  className?: string
}

const QUERY = (below: number) => `(max-width: ${below - 0.02}px)`

/** True below `below` px (720): draw the list as cards. Server and first render: false (the table). */
export function useCardList(below: number = CARD_LIST_BELOW): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(QUERY(below))
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    },
    () => window.matchMedia(QUERY(below)).matches,
    () => false,
  )
}

const isTyping = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"]')

export function GridCardList<T>({
  label, rows, rowId, columns, fields: overrides, hrefOf, count, search, tools, sort, onSortChange, selection, isRowSelectable,
  selectMode, state, more, linkAs, labels, className,
}: GridCardListProps<T>) {
  const words = mergeLabels(CARD_LIST_LABELS, labels)
  const fields = useMemo(() => cardFieldsOf(columns, overrides ?? {}), [columns, overrides])
  const [selecting, setSelecting] = useState(selectMode ?? (selection ? selection.selected.length > 0 : false))
  const items = rows ?? []
  const sel = selection ? cardSelection(items, selection.selected, rowId, isRowSelectable) : null
  const Link = linkAs ?? NextLink
  const title = fields.find((field) => field.role === 'title')
  const nameOf = (row: T) => (title ? title.text(row) : '') || rowId(row)
  const byRole = (role: CardField<T>['role']) => fields.filter((field) => field.role === role)
  const choices = onSortChange ? cardSortChoices(fields) : []

  const toggleRow = (row: T) => {
    if (!selection) return
    if (isRowSelectable?.(row)) return
    if (!selecting) setSelecting(true)
    selection.onChange(cardToggle(selection.selected, rowId(row)))
  }
  const onKey = (event: KeyboardEvent<HTMLLIElement>, row: T) => {
    if (event.key !== 'x' && event.key !== 'X') return
    if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return
    event.preventDefault()
    toggleRow(row)
  }

  const cls = ['nds-cardlist', className ?? ''].filter(Boolean).join(' ')
  return (
    <section className={cls} aria-label={label}>
      <div className="nds-cardlist-bar">
        {selection && selecting && sel ? (
          <>
            <Checkbox
              className="nds-cardlist-all"
              checked={sel.all}
              ref={(box) => {
                // The DS box has no mixed state of its own: the native one, set on the element.
                if (box) box.indeterminate = sel.some
              }}
              aria-label={words.selectAll}
              label={words.selected(sel.count)}
              onChange={() => selection.onChange(cardToggleAll(sel, selection.selected))}
            />
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setSelecting(false)
                selection.onChange([])
              }}
            >
              {words.done}
            </Button>
          </>
        ) : (
          <>
            {search != null && <div className="nds-cardlist-search">{search}</div>}
            {tools}
            {selection && (
              <Button size="sm" variant="quiet" onClick={() => setSelecting(true)} heldReason={sel && sel.selectable.length === 0 && rows !== null ? words.nothingToSelect : null}>
                {words.select}
              </Button>
            )}
          </>
        )}
      </div>
      {selection && selecting && selection.selected.length > 0 && <div className="nds-cardlist-bar nds-cardlist-bulk">{selection.actions}</div>}
      {(count != null || choices.length > 1) && (
        <div className="nds-cardlist-meta">
          <span className="nds-cardlist-count" role="status" aria-live="polite">
            {rows === null ? words.reading : count}
          </span>
          {choices.length > 1 && onSortChange && (
            <label className="nds-cardlist-sort">
              <span className="nds-vh">{words.sortBy}</span>
              <Select size="sm" value={cardSortValue(sort)} onChange={(event) => onSortChange(cardSortFrom(event.target.value))} aria-label={words.sortBy}>
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.colId === null ? words.listOrder : choice.dir === 'asc' ? words.ascending(choice.label) : words.descending(choice.label)}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
      )}
      {rows === null ? (
        <ul className="nds-cardlist-cards" aria-hidden>
          {[0, 1, 2].map((index) => (
            <li key={index} className="nds-cardlist-card is-skeleton">
              <Skeleton width="60%" height={14} />
              <Skeleton width="85%" height={12} />
              <Skeleton width="40%" height={12} />
            </li>
          ))}
        </ul>
      ) : state != null ? (
        <div className="nds-cardlist-state">{state}</div>
      ) : (
        <ul className="nds-cardlist-cards" aria-label={label}>
          {items.map((row) => {
            const id = rowId(row)
            const on = !!selection?.selected.includes(id)
            const held = isRowSelectable?.(row) ?? null
            const href = hrefOf?.(row) ?? null
            const name = nameOf(row)
            return (
              <li key={id} className={`nds-cardlist-card${on ? ' is-on' : ''}`} onKeyDown={(event) => onKey(event, row)}>
                {selection && selecting && (
                  <span className="nds-cardlist-box">
                    {held ? (
                      <Tooltip label={held} portal>
                        <Checkbox checked={on} aria-label={words.selectOne(name)} aria-disabled aria-description={held} onChange={() => {}} />
                      </Tooltip>
                    ) : (
                      <Checkbox checked={on} aria-label={words.selectOne(name)} onChange={() => toggleRow(row)} />
                    )}
                  </span>
                )}
                <div className="nds-cardlist-body">
                  <div className="nds-cardlist-top">
                    <span className="nds-cardlist-title">
                      {title ? href ? <Link className="nds-cardlist-link" href={href}>{name}</Link> : title.draw(row) : href ? <Link className="nds-cardlist-link" href={href}>{name}</Link> : name}
                    </span>
                    {byRole('aside').map((field) => (
                      <span key={field.id} className="nds-cardlist-aside">{field.draw(row)}</span>
                    ))}
                    {byRole('actions').map((field) => (
                      <span key={field.id} className="nds-cardlist-actions">{field.draw(row)}</span>
                    ))}
                  </div>
                  {byRole('subtitle').map((field) => (
                    <div key={field.id} className="nds-cardlist-sub">{field.draw(row)}</div>
                  ))}
                  {byRole('field').length > 0 && (
                    <dl className="nds-cardlist-fields">
                      {byRole('field').map((field) => {
                        const value = field.draw(row)
                        if (value === '' || value == null) return null
                        return (
                          <div key={field.id} className="nds-cardlist-field">
                            <dt>{field.label}</dt>
                            <dd>{value}</dd>
                          </div>
                        )
                      })}
                    </dl>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {more && rows !== null && state == null && (
        <div className="nds-cardlist-more">
          <Button size="sm" onClick={more.onMore} heldReason={more.held ?? null}>
            {more.label}
          </Button>
        </div>
      )}
    </section>
  )
}
