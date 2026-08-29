import type { ReactNode } from 'react'
import { hasHint, keyValueRootProps, type KeyValueColumns } from '../lib/key-value'

/**
 * KeyValue — a `<dl>` term/value grid (CX.2).
 *
 * The description list the console never had. Four pages had each spelled their own — the
 * channels detail page's `Stat` was the fourth (term 11px uppercase, value 13px) — and none of
 * them was a `<dl>`, so a screen reader read a label and a value as two unrelated lines.
 *
 * Term and value are `dt`/`dd` inside one `.nds-kv-item`, so the pair stays a pair when the
 * grid reflows. `columns` is a grid, not a table: an item never spans, and a narrow viewport
 * collapses every column count to one (styles/components.css).
 */
export interface KeyValueItem {
  label: ReactNode
  value: ReactNode
  /** A sub-line under the value — a unit, a source, a caveat. */
  hint?: ReactNode
}

export interface KeyValueProps {
  items: KeyValueItem[]
  /** Grid columns on a wide viewport. Default 1. */
  columns?: KeyValueColumns
  className?: string
  /** Tightens the row gap for a compact card body. */
  dense?: boolean
}

export function KeyValue({ items, columns, className, dense }: KeyValueProps) {
  return (
    <dl {...keyValueRootProps({ columns, dense, className })}>
      {items.map((item, i) => (
        <div key={i} className="nds-kv-item">
          <dt>{item.label}</dt>
          <dd>
            {item.value}
            {hasHint(item.hint) && <span className="nds-kv-hint">{item.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}
