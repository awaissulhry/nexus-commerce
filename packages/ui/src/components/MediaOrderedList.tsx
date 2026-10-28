'use client'

/**
 * MediaOrderedList — chosen items as ordered rows: grip, picture, name (and a second line), ×.
 *
 * The pop-up Shopify's bulk editor opens on a product list, measured 2026-09-27
 * (docs/sheet-popup-editor/PLAN-2026-09-27.md §2): a "Select products" line with "Clear all", then one row per product
 * — `⠿ photo MOSS Jacket ×` — dragged into order. Built on `OrderedList` with `liveDrag`: the whole row is the handle,
 * it lifts and follows the pointer while the other rows slide to make room; the grip keeps ↑ ↓ with a spoken position.
 *
 * `actions` sits on the header line (the "Select products" button that opens `ResourcePickerDialog`). An item whose
 * value no known choice carries is shown as itself, marked, and kept until removed (`resolveChosen`).
 */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

import { Button } from '../primitives/Button'
import { ToolbarButton } from '../primitives/ToolbarButton'
import { anyMedia, removeChoice, type MediaChoice } from '../lib/media-choice'
import { MediaMark } from './MediaChoice'
import { OrderedList } from './OrderedList'

export type MediaListItem = MediaChoice & { unknown?: boolean }

export interface MediaOrderedListProps {
  /** Accessible name ("Variation products, in order"). */
  label: string
  items: readonly MediaListItem[]
  onChange: (values: string[]) => void
  /** Header actions — typically the button that opens the picker. */
  actions?: ReactNode
  /** Shows "Clear all" while there is something to clear. */
  onClear?: () => void
  /** Text when nothing is chosen. */
  emptyText?: string
  disabled?: boolean
  className?: string
}

export function MediaOrderedList({ label, items, onChange, actions, onClear, emptyText = 'Nothing chosen yet', disabled = false, className }: MediaOrderedListProps) {
  const byValue = new Map(items.map(i => [i.value, i]))
  const values = items.map(i => i.value)
  const withMedia = anyMedia(items)
  const nameOf = (value: string) => byValue.get(value)?.label ?? value
  return (
    <div className={['nds-molist', className].filter(Boolean).join(' ')}>
      {(actions || onClear) && (
        <div className="nds-molist-head">
          {actions}
          <span className="nds-molist-grow" />
          {onClear && items.length > 0 && <Button size="xs" variant="link" disabled={disabled} onClick={onClear}>Clear all</Button>}
        </div>
      )}
      {items.length === 0
        ? <div className="nds-molist-empty">{emptyText}</div>
        : <OrderedList label={label} items={values} onChange={onChange} keyboardGrip liveDrag disabled={disabled} itemLabel={nameOf}
            renderItem={value => {
              const item = byValue.get(value)!
              return (
                <span className={['nds-molist-row', item.unknown ? 'unknown' : ''].filter(Boolean).join(' ')}
                  title={item.unknown ? 'Not found — it may have been deleted. It is kept until you remove it.' : undefined}>
                  {withMedia && <span className="nds-molist-media"><MediaMark choice={item} /></span>}
                  <span className="nds-molist-text">
                    <span className="nds-molist-label">{item.label}{item.unknown ? ' (not found)' : ''}</span>
                    {item.detail && <span className="nds-molist-detail">{item.detail}</span>}
                  </span>
                  <ToolbarButton label={`Remove ${item.label}`} icon={<X size={14} />} disabled={disabled}
                    onClick={() => onChange([...removeChoice(values, value)])} />
                </span>
              )
            }} />}
    </div>
  )
}
