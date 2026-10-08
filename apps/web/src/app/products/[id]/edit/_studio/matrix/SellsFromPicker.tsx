'use client'

/**
 * "Sells from" — the warehouse list (Step 2, Owner 2026-10-07). ONE picker for the From pop-up and the bulk Edit's
 * "Sells from" field: the active warehouses as a DS `OrderedList`, each a `Checkbox` with its code and name (and this
 * SKU's units when one SKU is open). Ticked = sells; the ticked rows come first, in sale order (drag, or the grip's
 * ↑ ↓). Ticking adds a warehouse last; an unticked row has no place in a sale (`sellsFrom.ts`).
 */
import { OrderedList } from '@/design-system/components'
import { Checkbox } from '@/design-system/primitives'

import type { MatrixLocation } from './contract'
import { activeWarehouses, pickerOrder, tickedInOrder, toggleCode } from './sellsFrom'
import styles from './SellsFrom.module.css'

export interface SellsFromPickerProps {
  /** The list's accessible name. */
  label: string
  /** The business's warehouses (`MatrixRead.locations`); only active ones are offered. */
  locations: readonly MatrixLocation[]
  /** The ticked codes, in sale order. */
  value: readonly string[]
  onChange: (codes: string[]) => void
  /** This SKU's available units at a warehouse; absent = not shown (the bulk Edit: many SKUs). */
  unitsOf?: (code: string) => number
  disabled?: boolean
  /** The pop-up opens on the first warehouse (a keyboard open can tick at once), not on the ✕. */
  autoFocusFirst?: boolean
}

export function SellsFromPicker({ label, locations, value, onChange, unitsOf, disabled = false, autoFocusFirst = false }: SellsFromPickerProps) {
  const order = pickerOrder(locations, value)
  const names = new Map(activeWarehouses(locations).map((l) => [l.code, l.name]))
  if (order.length === 0) return <p className={styles.hint}>No active warehouse. Add one in Locations.</p>
  return (
    <OrderedList
      label={label}
      items={order}
      keyboardGrip
      liveDrag
      disabled={disabled}
      onChange={(next) => onChange(tickedInOrder(next, value))}
      renderItem={(code) => {
        const on = value.includes(code)
        const name = names.get(code)
        return (
          <span className={`${styles.item}${on ? '' : ` ${styles.off}`}`}>
            <Checkbox checked={on} disabled={disabled} onChange={() => onChange(toggleCode(value, code))} label={<span className={styles.code}>{code}</span>}
              data-autofocus={autoFocusFirst && code === order[0] ? true : undefined} />
            <span className={styles.name}>{name && name !== code ? name : ''}</span>
            {unitsOf && <span className={styles.units}>{unitsOf(code)} avail.</span>}
          </span>
        )
      }}
    />
  )
}
