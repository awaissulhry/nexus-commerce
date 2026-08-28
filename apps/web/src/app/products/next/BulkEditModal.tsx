'use client'

/**
 * Bulk edit — one dialog for every FIELD a selection can be written to.
 *
 * The shape is Ad Manager's `BulkActionsModal`, deliberately: operators already know it, and the
 * two steps are the point. Step one is a tick per field, so nothing is written that was not asked
 * for; step two states what is about to happen — "Status → Active · 12 products · 38 variations" —
 * before anything is sent. The toolbar used to carry three status buttons that wrote to N rows
 * with no such statement.
 *
 * Only FIELDS live here. Duplicate, Publish and Delete are verbs — they create rows, queue an
 * outbound job, or destroy — and each carries its own outcome, so bundling them under one
 * "Submit changes" would let a green result hide a failed one.
 */
import { useEffect, useMemo, useState } from 'react'

import { Listbox, Modal } from '@/design-system/components'
import { Button, Checkbox, Pill } from '@/design-system/primitives'
import type { ProductRow } from '@/app/products/_types'

import styles from './styles.module.css'

export type BulkStatus = 'ACTIVE' | 'DRAFT' | 'INACTIVE'

export interface BulkEditChanges {
  status?: BulkStatus
  /** Variations follow their parent — the same cascade the tag dialog and the status write use. */
  includeChildren: boolean
}

export interface BulkEditModalProps {
  open: boolean
  onClose: () => void
  /** The rows the operator selected — the counts and the variation cascade. */
  selection: ProductRow[]
  busy?: boolean
  onSubmit: (changes: BulkEditChanges) => void | Promise<void>
}

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'INACTIVE', label: 'Inactive' },
]
const STATUS_TONE: Record<BulkStatus, 'success' | 'neutral' | 'danger'> = { ACTIVE: 'success', DRAFT: 'neutral', INACTIVE: 'danger' }
const STATUS_LABEL: Record<BulkStatus, string> = { ACTIVE: 'Active', DRAFT: 'Draft', INACTIVE: 'Inactive' }
export function BulkEditModal({ open, onClose, selection, busy = false, onSubmit }: BulkEditModalProps) {
  const [step, setStep] = useState<1 | 2>(1)
  const [enStatus, setEnStatus] = useState(false)
  const [status, setStatus] = useState<BulkStatus>('ACTIVE')
  const [includeChildren, setIncludeChildren] = useState(true)
  useEffect(() => {
    if (!open) return
    setStep(1)
    setEnStatus(false)
    setStatus('ACTIVE')
    setIncludeChildren(true)
  }, [open])

  const childCount = useMemo(
    () => selection.filter((r) => r.parentId === null).reduce((n, r) => n + (r.childCount ?? 0), 0),
    [selection],
  )

  const ready = enStatus

  const changes: BulkEditChanges = { ...(enStatus ? { status } : {}), includeChildren }

  const scope = `${selection.length} ${selection.length === 1 ? 'product' : 'products'}${includeChildren && childCount > 0 ? ` · ${childCount} ${childCount === 1 ? 'variation' : 'variations'}` : ''}`

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Bulk edit"
      subtitle={step === 1 ? `Choose what to change across ${scope}` : 'Review before it is written'}
      footer={
        step === 1 ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <span className="grow" />
            <Button variant="primary" disabled={!ready} onClick={() => setStep(2)}>Review</Button>
          </>
        ) : (
          <>
            <Button variant="link" onClick={() => setStep(1)}>Back</Button>
            <span className="grow" />
            <Button variant="primary" disabled={busy} onClick={() => void onSubmit(changes)}>
              {busy ? 'Applying…' : 'Apply changes'}
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className={styles.bulkBody}>
          <div className={styles.bulkHd}>
            <span />
            <span>Field</span>
            <span>Change</span>
          </div>

          <div className={styles.bulkRow}>
            <Checkbox checked={enStatus} onChange={() => setEnStatus((v) => !v)} aria-label="Change status" />
            <span className={styles.bulkItem}>Status</span>
            <div className={styles.bulkAction}>
              <Listbox
                width={160}
                options={STATUS_OPTIONS}
                value={status}
                onChange={(v) => { setStatus(v as BulkStatus); setEnStatus(true) }}
                ariaLabel="Status to set"
              />
            </div>
          </div>

          {childCount > 0 && (
            <label className={styles.bulkCascade}>
              <Checkbox checked={includeChildren} onChange={() => setIncludeChildren((v) => !v)} aria-label="Also apply to variations" />
              <span>
                Also apply to the <b>{childCount}</b> {childCount === 1 ? 'variation' : 'variations'} under the selected {selection.length === 1 ? 'product' : 'products'}
              </span>
            </label>
          )}
        </div>
      ) : (
        <div className={styles.bulkReview}>
          {changes.status && (
            <div className={styles.bulkReviewRow}>
              <span className={styles.bulkReviewField}>Status</span>
              <span><Pill tone={STATUS_TONE[changes.status]}>{STATUS_LABEL[changes.status]}</Pill></span>
            </div>
          )}
          <div className={styles.bulkReviewRow}>
            <span className={styles.bulkReviewField}>Applies to</span>
            <span>{scope}</span>
          </div>
        </div>
      )}
    </Modal>
  )
}
