'use client'

import { Lock } from 'lucide-react'
import type { ProductRow } from '../_types'
import { getStockColor } from './inventoryEditor.logic'
import styles from './styles.module.css'

/** Available column cell: FBA (read-only, lock) over FBM (color-coded). Whole
 *  cell is a button that opens the per-location inventory editor. */
export function InventoryCell({ row, onOpen }: { row: ProductRow; onOpen: (row: ProductRow) => void }) {
  const hasSplit = row.fbaStock != null || row.fbmStock != null
  return (
    <button
      type="button"
      className={styles.invCellBtn}
      onClick={() => onOpen(row)}
      aria-label={`Edit inventory for ${row.name}`}
    >
      <span className={styles.invSplit}>
        {hasSplit ? (
          <>
            <span className={styles.invLine}>
              <span className={styles.invNum}>{row.fbaStock ?? 0}</span>
              <span className={styles.invTag}>FBA</span>
              <Lock size={10} className={styles.invLock} aria-hidden="true" />
            </span>
            <span className={styles.invLine}>
              <span className={styles.invNum} style={{ color: getStockColor(row.fbmStock ?? 0, row.lowStockThreshold) }}>
                {row.fbmStock ?? 0}
              </span>
              <span className={styles.invTag}>FBM</span>
            </span>
          </>
        ) : (
          <span className={styles.invLine}>
            <span className={styles.invNum} style={{ color: getStockColor(row.totalStock, row.lowStockThreshold) }}>
              {row.totalStock}
            </span>
            <span className={styles.invTag}>units</span>
          </span>
        )}
      </span>
    </button>
  )
}
