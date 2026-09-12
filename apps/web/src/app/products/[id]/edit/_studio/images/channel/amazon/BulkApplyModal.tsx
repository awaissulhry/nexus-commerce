'use client'

/**
 * PES.7 — put one master image into many matrix cells.
 *
 * Serves both surfaces the programme moved into P3: BULK APPLY (an image already in the gallery)
 * and SCOPED UPLOAD (upload, then choose where it lands). Same operation, same targeting, one
 * screen — a wizard would only add steps between the operator and a decision they can see whole.
 *
 * The sentence above the button is the decision surface, and it always leads with what would be
 * REPLACED. Everything it says comes from `bulkApply.ts`, which is pure and tested.
 */
import { useCallback, useMemo, useState } from 'react'

import { Modal } from '@/design-system/components'
import { FileDropzone } from '@/design-system/components'
import { Button, Checkbox } from '@/design-system/primitives'
import { cdnFit } from '@/design-system/lib/cdn-image'

import { apiSend, routes, type ApiResult } from '../../api'
import { writeSubject } from '../../imageWrites'
import { type MasterAsset, type UploadImageResponse } from '../../types'
import type { ResolvedCell } from './cascade'
import { buildBulkPlan } from './bulkApply'
import type { CellCoordinate } from './edits'
import type { MatrixColumn, MatrixRow } from './matrixModel'
import styles from './matrix.module.css'

export interface BulkApplyModalProps {
  open: boolean
  productId: string
  market: string | null
  groupKey: string | null
  rows: MatrixRow[]
  columns: MatrixColumn[]
  master: MasterAsset[]
  /** The shared resolver, so the plan is computed against the same cascade the grid renders. */
  resolveAt(rowId: string, slot: string): { row: MatrixRow; resolved: ResolvedCell } | null
  onClose(): void
  onApplied(): Promise<void>
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

const THUMB_PX = 180

export function BulkApplyModal({
  open, productId, market, groupKey, rows, columns, master, resolveAt, onClose, onApplied, write,
}: BulkApplyModalProps) {
  const [picked, setPicked] = useState<MasterAsset | null>(null)
  const [buckets, setBuckets] = useState<Set<string>>(new Set())
  const [slots, setSlots] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  }

  const plan = useMemo(() => {
    if (!picked || buckets.size === 0 || slots.size === 0) return null
    const targets: Array<{ at: CellCoordinate; resolved: ResolvedCell; writable: boolean }> = []
    for (const rowId of buckets) {
      for (const slot of slots) {
        const hit = resolveAt(rowId, slot)
        if (!hit) continue
        targets.push({
          at: { slot, groupValue: hit.row.groupValue, groupKey, market },
          resolved: hit.resolved,
          writable: columns.find((c) => c.slot === slot)?.writable ?? true,
        })
      }
    }
    return buildBulkPlan({ url: picked.url, sourceProductImageId: picked.id, targets })
  }, [buckets, columns, groupKey, market, picked, resolveAt, slots])

  const upload = useCallback(async (file: File) => {
    setBusy(true); setRefusal(null)
    const fd = new FormData()
    fd.append('file', file)
    // Uploaded to MASTER first — a channel row references a picture, it does not own bytes.
    const res = await write(writeSubject.upload(file.name), () => apiSend<UploadImageResponse>(
      `${routes.masterImages(productId)}?type=ALT`, 'POST', fd))
    setBusy(false)
    if (!res.ok) { setRefusal(res.message); return }
    if (res.data?.id) setPicked(res.data)
  }, [productId, write])

  const apply = useCallback(async () => {
    if (!plan || plan.upserts.length === 0) return
    setBusy(true); setRefusal(null)
    const res = await write(writeSubject.surface('amazon-bulk-apply'), () => apiSend<unknown>(routes.bulkSave(productId), 'POST', { upserts: plan.upserts }))
    setBusy(false)
    if (!res.ok) { setRefusal(res.message); return }
    await onApplied()
    onClose()
  }, [onApplied, onClose, plan, productId, write])

  if (!open) return null

  return (
    <Modal
      open
      onClose={onClose}
      size="xxl"
      title="Fill slots from one image"
      subtitle={market ? `Amazon · ${market}` : 'Amazon · all markets'}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            size="sm" variant="primary"
            disabled={!plan || plan.upserts.length === 0 || busy}
            onClick={() => void apply()}
          >
            {busy ? 'Applying…' : plan && plan.upserts.length > 0 ? `Apply to ${plan.upserts.length} slots` : 'Apply'}
          </Button>
        </>
      }
    >
      {refusal && <p className={styles.warning} role="alert">{refusal}</p>}

      <div className={styles.bulkLayout}>
        <section className={styles.bulkCol}>
          <span className={styles.issuesTitle}>1 · The image</span>
          <div className={styles.bulkPickRow}>
            <FileDropzone
              onFiles={(files) => { const f = files[0]; if (f) void upload(f) }}
              accept="image/*"
              disabled={busy}
              hint="Upload a new one"
            />
          </div>
          <div className={styles.bulkGrid}>
            {master.map((m) => (
              <Button
                key={m.id}
                variant="ghost"
                className={`${styles.pickerCard}${picked?.id === m.id ? ` ${styles.pickerCardOn}` : ''}`}
                onClick={() => setPicked(m)} title={m.alt ?? m.type}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.pickerImg} src={cdnFit(m.url, THUMB_PX)} alt="" loading="lazy" />
                <span className={styles.pickerLabel}>{m.type}</span>
              </Button>
            ))}
          </div>
        </section>

        <section className={styles.bulkCol}>
          <span className={styles.issuesTitle}>2 · Where it goes</span>

          <div className={styles.bulkChecks}>
            <span className={styles.bulkChecksTitle}>Rows</span>
            {rows.map((r) => (
              <label key={r.id} className={styles.bulkCheck}>
                <Checkbox checked={buckets.has(r.id)} onChange={() => setBuckets((s) => toggle(s, r.id))} />
                <span>{r.label}</span>
              </label>
            ))}
          </div>

          <div className={styles.bulkChecks}>
            <span className={styles.bulkChecksTitle}>Slots</span>
            {columns.map((c) => (
              <label key={c.slot} className={styles.bulkCheck}>
                <Checkbox
                  checked={slots.has(c.slot)}
                  disabled={!c.writable}
                  onChange={() => setSlots((s) => toggle(s, c.slot))}
                />
                {/* A read-only slot says so rather than being a tick that quietly does nothing. */}
                <span>{c.slot}{c.writable ? '' : ' · read-only'}</span>
              </label>
            ))}
          </div>
        </section>
      </div>

      {/* The decision surface. Always leads with what would be replaced. */}
      <p className={plan && plan.counts.overwrite > 0 ? styles.warning : styles.pickerState}>
        {plan ? plan.summary : 'Choose an image, then the rows and slots to put it in.'}
      </p>
    </Modal>
  )
}
