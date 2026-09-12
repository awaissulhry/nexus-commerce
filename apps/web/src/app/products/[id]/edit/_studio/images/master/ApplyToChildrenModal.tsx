'use client'

/**
 * PES.7 — copy the master gallery down to every child SKU.
 *
 * 🔴 This is the most destructive control on the tab, and the API's own default is the destructive
 * one: `POST /images/apply-to-children` takes `mode` and falls back to `'replace'`, which DELETES
 * every image on every child before copying. On a product like GALE-JACKET that is 20 children.
 *
 * So this surface does three things the endpoint does not:
 *   1. It ALWAYS sends an explicit `mode`. The server's default is never allowed to apply — a
 *      destructive fallback reached by omission is exactly the shape of an accident.
 *   2. It defaults the CHOICE to `append`, the non-destructive one, and states in words what each
 *      mode does to images the children already have.
 *   3. It names the blast radius before the operator commits — how many children, and that
 *      replace deletes what is on them today.
 *
 * The result is reported from the server's own counts, not from what we hoped would happen.
 */
import { useCallback, useState } from 'react'

import { Modal } from '@/design-system/components'
import { Button, Radio } from '@/design-system/primitives'

import { apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import styles from './duplicates.module.css'

export interface ApplyToChildrenModalProps {
  open: boolean
  productId: string
  isParent: boolean
  childCount: number
  imageCount: number
  onClose(): void
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

interface ApplyResult {
  targetsTotal: number
  targetsUpdated: number
  imagesCreated: number
  imagesDeleted: number
  errors?: unknown[]
}

type Mode = 'append' | 'replace'

export function ApplyToChildrenModal({
  open, productId, isParent, childCount, imageCount, onClose, write,
}: ApplyToChildrenModalProps) {
  const [mode, setMode] = useState<Mode>('append')
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const run = useCallback(async () => {
    setRunning(true)
    setRefusal(null)
    // Explicit mode, every time — never the server's fallback.
    const res = await write(writeSubject.surface('apply-to-children'), () => apiSend<ApplyResult>(
      routes.applyToChildren(productId), 'POST', { mode }))
    setRunning(false)
    setConfirming(false)
    if (!res.ok) { setRefusal(res.message); return }
    setResult(res.data)
  }, [mode, productId, write])

  const close = useCallback(() => {
    setResult(null); setRefusal(null); setConfirming(false); setMode('append')
    onClose()
  }, [onClose])

  if (!open) return null

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title="Apply master images to child SKUs"
      subtitle={isParent ? `${childCount} child SKU${childCount === 1 ? '' : 's'}` : undefined}
      footer={
        result ? (
          <Button size="sm" variant="primary" onClick={close}>Done</Button>
        ) : confirming ? (
          <>
            <Button size="sm" variant="ghost" disabled={running} onClick={() => setConfirming(false)}>Back</Button>
            <Button size="sm" variant="primary" disabled={running} onClick={() => void run()}>
              {running ? 'Applying…' : mode === 'replace' ? `Replace images on ${childCount} SKUs` : `Add to ${childCount} SKUs`}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={!isParent || childCount === 0}
              onClick={() => setConfirming(true)}>Continue</Button>
          </>
        )
      }
    >
      {!isParent && (
        <p className={styles.note}>
          This product has no child SKUs — it is not a parent. Master images only cascade downwards.
        </p>
      )}

      {isParent && childCount === 0 && (
        <p className={styles.note}>This parent has no child SKUs yet, so there is nothing to apply to.</p>
      )}

      {refusal && <p className={styles.error} role="alert">{refusal}</p>}

      {result && (
        // The server's counts, verbatim. `imagesDeleted` is reported even when it is 0, because on
        // a replace it is the number the operator most needs to see.
        <p className={styles.note}>
          Updated {result.targetsUpdated} of {result.targetsTotal} child SKUs
          {' · '}{result.imagesCreated} image{result.imagesCreated === 1 ? '' : 's'} created
          {' · '}{result.imagesDeleted} deleted
          {Array.isArray(result.errors) && result.errors.length > 0
            ? ` · ${result.errors.length} failed` : ''}
        </p>
      )}

      {isParent && childCount > 0 && !result && !confirming && (
        <div className={styles.modes}>
          <label className={styles.mode}>
            <Radio name="apply-mode" checked={mode === 'append'} onChange={() => setMode('append')} />
            <span>
              <strong>Add to what they have</strong>
              <span className={styles.modeWhy}>
                Each child keeps its own images and gains this product&rsquo;s {imageCount}. Nothing is
                removed.
              </span>
            </span>
          </label>
          <label className={styles.mode}>
            <Radio name="apply-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            <span>
              <strong>Replace what they have</strong>
              <span className={styles.modeWhy}>
                Every image currently on a child SKU is <strong>deleted</strong>, then this
                product&rsquo;s {imageCount} are copied down. Per-variant photography is lost.
              </span>
            </span>
          </label>
        </div>
      )}

      {confirming && !result && (
        <div className={mode === 'replace' ? styles.error : styles.note} role={mode === 'replace' ? 'alert' : undefined}>
          {mode === 'replace'
            ? `This deletes every image on ${childCount} child SKU${childCount === 1 ? '' : 's'} and copies ${imageCount} down in their place. Images the children have that this product does not will be gone.`
            : `This adds ${imageCount} image${imageCount === 1 ? '' : 's'} to ${childCount} child SKU${childCount === 1 ? '' : 's'}. Nothing they already have is removed.`}
        </div>
      )}
    </Modal>
  )
}
