'use client'

/**
 * PES.7 — duplicate review for the master gallery.
 *
 * The server clusters by two rules and says which applied: `exact` means identical bytes
 * (contentHash), `near` means both perceptual hashes agree within threshold. The distinction is
 * the operator's whole decision — an exact pair is a re-upload and one copy is safe to drop; a
 * near pair may be two legitimately different shots of the same thing.
 *
 * 🔴 Nothing is pre-selected and nothing is auto-deleted. The gallery is the product's stored
 * truth, and a cluster is evidence, not a verdict. Deletion happens one image at a time, through
 * the same DELETE the gallery uses, with the server's own refusal shown if it refuses.
 */
import { useCallback, useEffect, useState } from 'react'

import { Modal } from '@/design-system/components'
import { Button, Pill } from '@/design-system/primitives'
import { cdnFit } from '@/design-system/lib/cdn-image'

import { apiGet, apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import type { MasterAsset } from '../types'
import styles from './duplicates.module.css'

export interface DuplicatesModalProps {
  open: boolean
  productId: string
  onClose(): void
  /** Remove a deleted row from the tab's state. */
  onDeleted(id: string): void
  /** Close and flash the tile in the gallery. */
  onLocate(id: string): void
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

interface DuplicateGroup {
  kind: 'exact' | 'near'
  images: MasterAsset[]
}

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; groups: DuplicateGroup[]; totalImages: number }
  | { status: 'error'; message: string }

const THUMB_PX = 240

function formatBytes(n: number | null): string {
  if (n == null) return 'size not recorded'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${Math.round(n / 1024)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

export function DuplicatesModal({ open, productId, onClose, onDeleted, onLocate, write }: DuplicatesModalProps) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  // Scanned on OPEN, not on every tab load: the scan is O(n²) over the product's images and most
  // visits to this tab are not looking for duplicates.
  useEffect(() => {
    if (!open) { setState({ status: 'idle' }); setRefusal(null); return }
    let cancelled = false
    setState({ status: 'loading' })
    void (async () => {
      const res = await apiGet<{ groups: DuplicateGroup[]; totalImages: number }>(
        routes.duplicateGroups(productId))
      if (cancelled) return
      if (!res.ok) { setState({ status: 'error', message: res.message }); return }
      setState({ status: 'ready', groups: res.data.groups ?? [], totalImages: res.data.totalImages ?? 0 })
    })()
    return () => { cancelled = true }
  }, [open, productId])

  const remove = useCallback(async (image: MasterAsset) => {
    setBusyId(image.id)
    setRefusal(null)
    const res = await write(writeSubject.asset(image.id), () => apiSend<unknown>(routes.masterImage(productId, image.id), 'DELETE'))
    setBusyId(null)
    if (!res.ok) { setRefusal(res.message); return }
    onDeleted(image.id)
    // Drop it from the clusters on screen, and drop any cluster that is no longer a cluster.
    setState((s) => (s.status !== 'ready' ? s : {
      ...s,
      groups: s.groups
        .map((g) => ({ ...g, images: g.images.filter((i) => i.id !== image.id) }))
        .filter((g) => g.images.length > 1),
    }))
  }, [onDeleted, productId, write])

  if (!open) return null

  return (
    <Modal
      open
      onClose={onClose}
      size="xxl"
      title="Duplicate images"
      subtitle={state.status === 'ready'
        ? `${state.groups.length} group${state.groups.length === 1 ? '' : 's'} across ${state.totalImages} images`
        : undefined}
    >
      {state.status === 'loading' && <p className={styles.note}>Comparing images…</p>}

      {state.status === 'error' && (
        <p className={styles.error} role="alert">{state.message}</p>
      )}

      {state.status === 'ready' && state.groups.length === 0 && (
        <p className={styles.note}>
          No duplicates found across {state.totalImages} images — every one is byte-distinct and
          visually distinct from the others.
        </p>
      )}

      {refusal && <p className={styles.error} role="alert">{refusal}</p>}

      {state.status === 'ready' && state.groups.map((group, gi) => (
        <section key={gi} className={styles.group}>
          <header className={styles.groupHead}>
            <Pill tone={group.kind === 'exact' ? 'danger' : 'warning'}>
              {group.kind === 'exact' ? 'Identical bytes' : 'Looks alike'}
            </Pill>
            <span className={styles.groupCount}>{group.images.length} images</span>
            <span className={styles.groupWhy}>
              {group.kind === 'exact'
                ? 'The same file uploaded more than once — keeping one is safe.'
                : 'Visually similar, not identical. They may be different shots; check before deleting.'}
            </span>
          </header>

          <div className={styles.members}>
            {group.images.map((img) => (
              <figure key={img.id} className={styles.member}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.memberImg} src={cdnFit(img.url, THUMB_PX)} alt={img.alt ?? ''} />
                <figcaption className={styles.memberMeta}>
                  <span>{img.type}</span>
                  <span>{img.width != null && img.height != null ? `${img.width}×${img.height}` : 'size unknown'}</span>
                  <span>{formatBytes(img.fileSize)}</span>
                  <span>added {new Date(img.createdAt).toLocaleDateString()}</span>
                  {img.isPrimary && <span className={styles.memberHero}>hero image</span>}
                </figcaption>
                <div className={styles.memberActions}>
                  <Button size="sm" variant="ghost" onClick={() => onLocate(img.id)}>Locate</Button>
                  <Button
                    size="sm" variant="ghost"
                    disabled={busyId === img.id}
                    onClick={() => void remove(img)}
                  >
                    {busyId === img.id ? 'Deleting…' : 'Delete'}
                  </Button>
                </div>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </Modal>
  )
}
