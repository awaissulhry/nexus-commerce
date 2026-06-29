'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Modal } from '@/design-system/components'
import type { ProductRow } from '../_types'
import { useInventoryEditor } from './useInventoryEditor'
import { LocationQtyInput } from './LocationQtyInput'
import { editorModeForRow, REASON_OPTIONS, DEFAULT_REASON } from './inventoryEditor.logic'
import styles from './styles.module.css'

export function InventoryEditorModal({ row, onClose }: { row: ProductRow | null; onClose: () => void }) {
  const open = row != null
  const mode = row ? editorModeForRow(row) : 'list'
  const { loading, error, list, matrix, commit, reload } = useInventoryEditor(row?.id ?? null, mode)

  const [reason, setReason] = useState<string>(DEFAULT_REASON)
  const [notes, setNotes] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const doCommit = async (productId: string, locationId: string, value: number) => {
    const key = `${productId}:${locationId}`
    setSavingKey(key)
    setToast(null)
    const r = await commit({ productId, locationId, value, reason, notes: notes || undefined })
    setSavingKey(null)
    if (!r.ok) setToast(r.error ?? 'Save failed')
  }

  const header = useMemo(() => (
    <div className={styles.invModalHead}>
      <div className={styles.invReasonRow}>
        <label className={styles.invReasonLabel}>
          Reason
          <select className={styles.invReasonSelect} value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <input
          className={styles.invNotesInput}
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          aria-label="Adjustment notes"
        />
      </div>
      {toast && <div className={styles.invToast} role="alert">{toast}</div>}
    </div>
  ), [reason, notes, toast])

  const footer = (
    <div className={styles.invModalFoot}>
      <Link href="/fulfillment/stock" className={styles.invManageLink} target="_blank" rel="noopener noreferrer">
        Manage in Stock →
      </Link>
      <button type="button" className={styles.invCloseBtn} onClick={onClose}>Close</button>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      size={mode === 'matrix' ? 'xl' : 'md'}
      title={row ? row.name : 'Inventory'}
      subtitle={row?.sku}
      footer={footer}
    >
      {header}

      {loading && <div className={styles.invState}>Loading inventory…</div>}

      {!loading && error && (
        <div className={styles.invState}>
          <p>{error}</p>
          <button type="button" className={styles.invRetryBtn} onClick={() => void reload()}>Retry</button>
        </div>
      )}

      {!loading && !error && mode === 'list' && list && (
        list.length === 0 ? (
          <div className={styles.invState}>
            <p>No active locations yet.</p>
            <Link href="/fulfillment/stock/locations" className={styles.invManageLink} target="_blank" rel="noopener noreferrer">
              Create a location →
            </Link>
          </div>
        ) : (
          <table className={styles.invTable}>
            <thead>
              <tr>
                <th>Location</th><th>On hand</th><th>Reserved</th><th>Available</th>
              </tr>
            </thead>
            <tbody>
              {list.map((lv) => (
                <tr key={lv.locationId}>
                  <td>
                    <span className={styles.invLocCode}>{lv.locationCode}</span>
                    <span className={styles.invLocType}>{lv.locationType.replace(/_/g, ' ').toLowerCase()}</span>
                  </td>
                  <td>
                    <LocationQtyInput
                      value={lv.quantity}
                      reserved={lv.reserved}
                      editable={lv.editable}
                      locationType={lv.locationType}
                      saving={savingKey === `${row!.id}:${lv.locationId}`}
                      onCommit={(v) => doCommit(row!.id, lv.locationId, v)}
                    />
                  </td>
                  <td className={styles.invNum}>{lv.reserved}</td>
                  <td className={styles.invNum}>{lv.available}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {!loading && !error && mode === 'matrix' && matrix && (
        <div className={styles.invMatrixWrap}>
          <table className={styles.invMatrix}>
            <thead>
              <tr>
                <th className={styles.invMatrixCorner}>Variation</th>
                {matrix.columns.map((c) => (
                  <th key={c.locationId}>{c.locationCode}{!c.editable && ' 🔒'}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((r) => (
                <tr key={r.productId}>
                  <td className={styles.invMatrixRowHead}>{r.name || r.sku}</td>
                  {matrix.columns.map((c) => {
                    const cell = r.cells[c.locationId] ?? { quantity: 0, reserved: 0, available: 0 }
                    return (
                      <td key={c.locationId}>
                        <LocationQtyInput
                          value={cell.quantity}
                          reserved={cell.reserved}
                          editable={c.editable}
                          locationType={c.locationType}
                          saving={savingKey === `${r.productId}:${c.locationId}`}
                          onCommit={(v) => doCommit(r.productId, c.locationId, v)}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
