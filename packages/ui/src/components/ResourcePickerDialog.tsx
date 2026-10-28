'use client'

/**
 * ResourcePickerDialog — pick products, variants, collections or files from a searchable list with pictures.
 *
 * Shopify's "Edit products" picker, measured 2026-09-27 (docs/sheet-popup-editor/PLAN-2026-09-27.md §2): a search
 * line, rows of `tick · photo · title`, "3 products selected" on the left of the footer, Cancel / Done on the right.
 * Nexus' old `ReferencePicker` showed text only and picked ONE item per opening; this picks many.
 *
 * Rules it keeps:
 *   - The selection is a DRAFT until Done. Cancel, Esc or the backdrop throw it away.
 *   - Done keeps the order the operator made: old picks stay in place, new ones follow in pick order
 *     (`mergeSelection`). Re-sorting on Done would silently reorder a hand-ordered list.
 *   - The dialog carries `ag-custom-component-popup`, so opened from an AG cell editor a click inside it is not a
 *     click "outside" the editor (the same class `ShopifyDraftCell`'s dialog carries).
 *   - `search="remote"`: the caller runs the query against the server (`onQueryChange`) and passes the page it got;
 *     `hasMore` / `onLoadMore` page further. `local` filters the given list in memory.
 */
import { useEffect, useRef, useState } from 'react'

import { Button } from '../primitives/Button'
import { mergeSelection, selectionSummary, toggleChoice, type MediaChoice, type PickMode } from '../lib/media-choice'
import { MediaPickList, type MediaPickListHandle } from './MediaPickList'
import { Modal } from './Modal'

export interface ResourcePickerDialogProps {
  open: boolean
  /** "Select products". */
  title: string
  /** The thing being picked, for the count line: `{ one: 'product', other: 'products' }`. */
  noun: { one: string; other: string }
  choices: readonly MediaChoice[]
  /** The field's current values, in order. */
  initialSelected: readonly string[]
  mode?: PickMode
  /** Most values the field takes (a Shopify list's `list.max`), when it declares one. */
  max?: number | null
  search?: 'local' | 'remote'
  query?: string
  onQueryChange?: (query: string) => void
  searchPlaceholder?: string
  loading?: boolean
  error?: string | null
  hasMore?: boolean
  onLoadMore?: () => void
  onDone: (values: string[]) => void
  onCancel: () => void
  /** The cell the pop-up opened from; the dialog sits beside it on desktop. */
  anchor?: HTMLElement | null
}

export function ResourcePickerDialog(props: ResourcePickerDialogProps) {
  const {
    open, title, noun, choices, initialSelected, mode = 'multi', max = null, search = 'local', query, onQueryChange, searchPlaceholder,
    loading, error, hasMore, onLoadMore, onDone, onCancel, anchor,
  } = props
  const [picked, setPicked] = useState<readonly string[]>(initialSelected)
  const list = useRef<MediaPickListHandle>(null)
  /* Each opening starts from the field's value, never from a draft an earlier Cancel threw away. */
  useEffect(() => { if (open) setPicked(initialSelected) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const atCap = max != null && mode === 'multi' && picked.length >= max
  const done = () => onDone(mode === 'single' ? [...picked] : mergeSelection(initialSelected, picked))
  const changed = picked.length !== initialSelected.length || picked.some((v, i) => v !== initialSelected[i])

  return (
    <Modal open={open} onClose={onCancel} title={title} size="md" anchor={anchor} className="ag-custom-component-popup nds-rpick"
      footer={<>
        <span className="nds-rpick-count" role="status">
          {selectionSummary(picked.length, noun)}{atCap ? ` · the most this field takes` : ''}
        </span>
        <span className="grow" />
        <Button size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={done} disabled={!changed}>Done</Button>
      </>}>
      <MediaPickList ref={list} label={title} choices={choices} selected={picked} mode={mode} search={search} query={query}
        onQueryChange={onQueryChange} searchPlaceholder={searchPlaceholder ?? `Search ${noun.other}`} loading={loading} error={error}
        hasMore={hasMore} onLoadMore={onLoadMore} maxHeight={360} autoFocus
        onToggle={value => setPicked(current => toggleChoice(current, value, mode, max))} />
    </Modal>
  )
}
