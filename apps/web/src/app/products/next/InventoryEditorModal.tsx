'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import { Modal, Combobox, DataGrid, type Column } from '@/design-system/components'
import { Input, Button } from '@/design-system/primitives'
import type { ProductRow } from '../_types'
import { useInventoryEditor } from './useInventoryEditor'
import { LocationQtyInput } from './LocationQtyInput'
import {
  editorModeForRow,
  REASON_OPTIONS,
  DEFAULT_REASON,
  type LevelCell,
  type MatrixModel,
} from './inventoryEditor.logic'
import styles from './styles.module.css'

export function InventoryEditorModal({ row, onClose }: { row: ProductRow | null; onClose: () => void }) {
  const open = row != null
  const mode = row ? editorModeForRow(row) : 'list'
  const { loading, error, list, matrix, commit, reload } = useInventoryEditor(row?.id ?? null, mode)

  const [reason, setReason] = useState<string>(DEFAULT_REASON)
  const [notes, setNotes] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setReason(DEFAULT_REASON)
    setNotes('')
    setToast(null)
  }, [row?.id])

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
          <Combobox
            options={[...REASON_OPTIONS]}
            value={reason}
            onChange={setReason}
            placeholder="Select reason"
            className={styles.invReasonCombo}
          />
        </label>
        <Input
          fieldClassName={styles.invNotesField}
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
      <Button type="button" variant="secondary" size="sm" onClick={onClose}>Close</Button>
    </div>
  )

  // ── List mode: one row per location ─────────────────────────────
  const listColumns = useMemo<Column<LevelCell>[]>(() => [
    {
      key: 'location',
      label: 'Location',
      render: (lv) => (
        <>
          <span className={styles.invLocCode}>{lv.locationCode}</span>
          <span className={styles.invLocType}>{lv.locationType.replace(/_/g, ' ').toLowerCase()}</span>
        </>
      ),
    },
    {
      key: 'onHand',
      label: 'On hand',
      render: (lv) => (
        <LocationQtyInput
          value={lv.quantity}
          reserved={lv.reserved}
          editable={lv.editable}
          locationType={lv.locationType}
          saving={savingKey === `${row!.id}:${lv.locationId}`}
          onCommit={(v) => doCommit(row!.id, lv.locationId, v)}
        />
      ),
    },
    { key: 'reserved', label: 'Reserved', numeric: true, render: (lv) => lv.reserved },
    { key: 'available', label: 'Available', numeric: true, render: (lv) => lv.available },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [row?.id, savingKey, reason, notes])

  // ── Matrix mode: variations × locations ─────────────────────────
  // The SKU column is `sticky` so it stays readable while the location columns scroll — the
  // behaviour the hand-rolled table spelled out with `position: sticky; left: 0` on two classes.
  const matrixColumns = useMemo<Column<MatrixModel['rows'][number]>[]>(() => {
    if (!matrix) return []
    return [
      {
        key: '_sku',
        label: 'Variation',
        sticky: true,
        width: 220,
        render: (r) => <span title={r.name || r.sku}>{r.sku}</span>,
      },
      ...matrix.columns.map((c) => ({
        key: c.locationId,
        label: (
          <>
            {c.locationCode}
            {!c.editable && <Lock size={11} aria-label="Amazon-managed, read-only" style={{ marginLeft: 4, verticalAlign: 'middle' }} />}
          </>
        ),
        prefsLabel: c.locationCode,
        align: 'center' as const,
        width: 120,
        render: (r: MatrixModel['rows'][number]) => {
          const cell = r.cells[c.locationId] ?? { quantity: 0, reserved: 0, available: 0 }
          return (
            <LocationQtyInput
              value={cell.quantity}
              reserved={cell.reserved}
              editable={c.editable}
              locationType={c.locationType}
              saving={savingKey === `${r.productId}:${c.locationId}`}
              onCommit={(v) => doCommit(r.productId, c.locationId, v)}
            />
          )
        },
      })),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrix, savingKey, reason, notes])

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
          <Button type="button" variant="secondary" size="sm" onClick={() => void reload()}>Retry</Button>
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
          <DataGrid<LevelCell>
            columns={listColumns}
            rows={list}
            rowKey={(lv) => lv.locationId}
            size="sm"
          />
        )
      )}

      {!loading && !error && mode === 'matrix' && matrix && (
        <DataGrid<MatrixModel['rows'][number]>
          columns={matrixColumns}
          rows={matrix.rows}
          rowKey={(r) => r.productId}
          size="sm"
        />
      )}
    </Modal>
  )
}
