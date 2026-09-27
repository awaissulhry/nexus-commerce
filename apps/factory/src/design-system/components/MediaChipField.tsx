'use client'

/**
 * MediaChipField — the chosen values as chips (picture or swatch, name, ×) with a search line after them.
 *
 * The top of Shopify's list pop-ups, measured 2026-09-27 (docs/sheet-popup-editor/PLAN-2026-09-27.md §2):
 * `[icon Water-Repellent ×] [icon Regular Fit ×] Add text with icon…`, and "Clear" beside it. Nexus adds ORDER,
 * which Shopify's chip line lacks: a list metafield and a variation axis are ordered lists, so a chip can be dragged,
 * or moved with Alt + ← / → while it has focus, with a spoken position.
 *
 * Keys: ← / → walk the chips, Backspace or Delete removes the focused chip, Backspace in an empty search line removes
 * the last chip, ← at the start of an empty search line steps onto the last chip. Everything else the search line
 * receives is handed to `onInputKeyDown` — the pick list below uses it for ↑ ↓ Space Enter.
 *
 * A chip whose value no known choice carries (`unknown`) is still shown, marked, never dropped: dropping it would let
 * the next save delete a value the operator never saw (`resolveChosen`).
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react'

import { Button } from '../primitives/Button'
import { Input } from '../primitives/Input'
import { TokenChip } from '../primitives/TokenChip'
import { moveChoice, removeChoice, type MediaChoice } from '../lib/media-choice'
import { MediaMark } from './MediaChoice'
import { useSortableDrag } from './useSortableDrag'

export type MediaChipItem = MediaChoice & { unknown?: boolean }

export interface MediaChipFieldProps {
  /** Accessible name of the chip list ("Chosen colours"). */
  label: string
  /** The chosen values, in order, already resolved to choices. */
  items: readonly MediaChipItem[]
  onChange: (values: string[]) => void
  query: string
  onQueryChange: (query: string) => void
  placeholder?: string
  /** Chips can be dragged and moved with Alt + ← / →. Default true. */
  reorderable?: boolean
  /** Shows "Clear" while there is something to clear. */
  onClear?: () => void
  disabled?: boolean
  inputRef?: Ref<HTMLInputElement>
  /** Keys the search line did not use itself — hand them to the pick list. */
  onInputKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  /** Wire the search line to the pick list: `aria-controls` and the highlighted row. */
  controls?: string
  activeDescendant?: string
  className?: string
}

export function MediaChipField(props: MediaChipFieldProps) {
  const {
    label, items, onChange, query, onQueryChange, placeholder = 'Search', reorderable = true, onClear, disabled = false, inputRef, onInputKeyDown,
    controls, activeDescendant, className,
  } = props
  const values = items.map(i => i.value)
  const chipRefs = useRef(new Map<string, HTMLLIElement | null>())
  const ownInput = useRef<HTMLInputElement | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const setInput = (el: HTMLInputElement | null) => {
    ownInput.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el
  }
  const focusChip = (value: string | undefined) => { if (value) chipRefs.current.get(value)?.focus(); else ownInput.current?.focus() }

  const remove = (value: string, focusAfter?: string) => {
    const item = items.find(i => i.value === value)
    onChange([...removeChoice(values, value)])
    if (item) setAnnouncement(`${item.label} removed`)
    requestAnimationFrame(() => focusChip(focusAfter))
  }
  const move = (from: number, to: number) => {
    const next = moveChoice(values, from, to)
    if (next === values) return
    onChange([...next])
    setAnnouncement(`${items[from].label}, position ${to + 1} of ${items.length}`)
    requestAnimationFrame(() => focusChip(values[from]))
  }

  /* Pointer drag: the chip lifts and follows the pointer, and the chip it will land beside shows an insertion bar
     (`useSortableDrag` in `wrap` layout — chips flow over several lines). The × keeps its own click. */
  const sort = useSortableDrag({
    layout: 'wrap', disabled: disabled || !reorderable || items.length < 2, onMove: move,
    onDragState: state => { if (state) setAnnouncement(`${items[state.from].label}, moving to position ${state.to + 1} of ${items.length}`) },
  })

  const chipKeys = (event: ReactKeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.target !== event.currentTarget) return
    const value = values[index]
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) { event.preventDefault(); if (reorderable) move(index, index - 1); return }
    if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) { event.preventDefault(); if (reorderable) move(index, index + 1); return }
    if (event.key === 'ArrowLeft') { event.preventDefault(); focusChip(values[Math.max(0, index - 1)]); return }
    if (event.key === 'ArrowRight') { event.preventDefault(); focusChip(values[index + 1]); return }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      if (!disabled) remove(value, values[index + 1] ?? values[index - 1])
    }
  }

  const inputKeys = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0
    if (!query && event.key === 'Backspace' && values.length && !disabled) { event.preventDefault(); remove(values[values.length - 1]); return }
    if (!query && atStart && event.key === 'ArrowLeft' && values.length) { event.preventDefault(); focusChip(values[values.length - 1]); return }
    onInputKeyDown?.(event)
  }

  return (
    <div className={['nds-mchips', disabled ? 'disabled' : '', className].filter(Boolean).join(' ')}
      onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); ownInput.current?.focus() } }}>
      <ul ref={sort.listRef as unknown as Ref<HTMLUListElement>} className={`nds-mchips-list${sort.drag ? ' dragging' : ''}`} aria-label={label} data-nds-reorder-list>
        {items.map((item, index) => (
          <li key={item.value} ref={el => { chipRefs.current.set(item.value, el) }} data-nds-reorder-item tabIndex={0} {...sort.itemProps(index)}
            className={['nds-mchip', item.unknown ? 'unknown' : ''].filter(Boolean).join(' ')}
            aria-label={`${item.label}${item.unknown ? ' (not found)' : ''}, ${index + 1} of ${items.length}${reorderable ? '; Alt and arrow keys move it' : ''}`}
            title={item.unknown ? 'Not found — it may have been deleted. It is kept until you remove it.' : item.detail ?? item.label}
            onKeyDown={event => chipKeys(event, index)}>
            <TokenChip disabled={disabled} onRemove={() => remove(item.value)} removeLabel={`Remove ${item.label}`}>
              <MediaMark choice={item} size="chip" />
              <span className="nds-mchip-label">{item.label}</span>
            </TokenChip>
          </li>
        ))}
        <li className="nds-mchips-input">
          <Input size="sm" ref={setInput} value={query} placeholder={placeholder} disabled={disabled} fieldClassName="nds-mchips-field"
            aria-label={placeholder} role={controls ? 'combobox' : undefined} aria-expanded={controls ? true : undefined}
            aria-controls={controls} aria-activedescendant={activeDescendant}
            onChange={event => onQueryChange(event.target.value)} onKeyDown={inputKeys} />
        </li>
      </ul>
      {onClear && items.length > 0 && (
        <Button className="nds-mchips-clear" size="xs" variant="link" disabled={disabled}
          onClick={() => { onClear(); setAnnouncement('All cleared'); ownInput.current?.focus() }}>Clear</Button>
      )}
      <span className="sr-only" role="status">{announcement}</span>
    </div>
  )
}
