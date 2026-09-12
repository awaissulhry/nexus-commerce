'use client'

/**
 * PES.7 — choose the picture for one matrix slot.
 *
 * Opens on a cell and offers the master gallery, because master is where a channel picture comes
 * from — the cascade's last layer and the operator's own library for this product. The cell's
 * current state is stated at the top, including WHERE its picture comes from, so "replace" and
 * "pin over an inherited image" are visibly different acts.
 */
import { Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { cdnFit } from '@/design-system/lib/cdn-image'

import type { MasterAsset } from '../../types'
import type { ResolvedCell } from './cascade'
import styles from './matrix.module.css'

export interface SlotPickerProps {
  open: boolean
  slot: string
  bucketLabel: string
  market: string | null
  resolved: ResolvedCell | null
  master: MasterAsset[]
  busy: boolean
  onPick(asset: MasterAsset): void
  onClear(): void
  onClose(): void
}

const THUMB_PX = 200

/** What the cell is showing now, in one sentence. */
function currentState(r: ResolvedCell | null): string {
  if (!r || r.origin === 'empty') return 'This slot is empty.'
  if (r.origin === 'pictureless') return 'A row claims this slot but holds no image.'
  if (r.origin === 'shared') return 'Showing the shared row’s picture — choosing here pins one for this bucket only.'
  if (r.origin === 'master') return 'Showing what the master gallery would publish — choosing here pins one on Amazon.'
  if (r.origin === 'market') return 'Pinned for this market.'
  return 'Set for all markets.'
}

export function SlotPicker({
  open, slot, bucketLabel, market, resolved, master, busy, onPick, onClear, onClose,
}: SlotPickerProps) {
  if (!open) return null

  const canClear = resolved != null && (resolved.origin === 'market' || resolved.origin === 'platform' || resolved.origin === 'pictureless')

  return (
    <Modal
      open
      onClose={onClose}
      size="xxl"
      title={`${bucketLabel} · ${slot}`}
      subtitle={market ? `Amazon · ${market}` : 'Amazon · all markets'}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          {canClear && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
              Clear this slot
            </Button>
          )}
        </>
      }
    >
      <p className={styles.pickerState}>{currentState(resolved)}</p>

      {master.length === 0 ? (
        <p className={styles.notice}>
          The master gallery is empty, so there is nothing to place here yet. Add images on the
          Master scope first.
        </p>
      ) : (
        <div className={styles.pickerGrid}>
          {master.map((m) => (
            <Button
              key={m.id}
              variant="ghost"
              className={styles.pickerCard}
              disabled={busy}
              onClick={() => onPick(m)}
              title={m.alt ?? m.type}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.pickerImg} src={cdnFit(m.url, THUMB_PX)} alt="" loading="lazy" />
              <span className={styles.pickerLabel}>{m.type}</span>
            </Button>
          ))}
        </div>
      )}
    </Modal>
  )
}
