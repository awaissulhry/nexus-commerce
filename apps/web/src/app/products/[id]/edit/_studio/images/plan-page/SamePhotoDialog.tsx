'use client'

import { useEffect, useState } from 'react'

import { Banner, MediaPreview, Modal } from '@/design-system/components'
import { Button, Radio } from '@/design-system/primitives'

import { defaultKeep, photoPlacements, photoSource, type LibraryAsset, type MediaRead } from './model'
import styles from './planPage.module.css'

export interface SamePhotoDialogProps {
  read: MediaRead
  /** The two cards that look alike, or null when closed. */
  pair: { a: string; b: string } | null
  onClose(): void
  /** Keep `keep`; `drop` becomes its copy. Resolves with the server's answer, rejects with its sentence. */
  onSame(keep: LibraryAsset, drop: LibraryAsset): Promise<void>
  onDistinct(a: LibraryAsset, b: LibraryAsset): Promise<void>
}

/**
 * Images rebuild W4a — "Same photo?" (LIBRARY-DUPLICATES.md Fix 2): two library photos that look the same at two
 * addresses (an Amazon image and a Nexus upload), side by side with their size, source and where each one is used.
 * "Same photo" keeps the chosen one and makes the other its copy — nothing is deleted — and every photo set that showed
 * the other one (Shared, channels, listings, aliases) shows the kept one. "Not the same" stops the suggestion.
 */
export function SamePhotoDialog({ read, pair, onClose, onSame, onDistinct }: SamePhotoDialogProps) {
  const a = pair ? read.library.find(x => x.id === pair.a) ?? null : null
  const b = pair ? read.library.find(x => x.id === pair.b) ?? null : null
  const [keepId, setKeepId] = useState<string | null>(null)
  const [busy, setBusy] = useState<'same' | 'distinct' | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { if (a && b) setKeepId(defaultKeep(read, a, b).id); setError('') }, [pair?.a, pair?.b]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!pair || !a || !b) return <Modal open={false} onClose={onClose} title="Same photo?" />
  const keep = keepId === b.id ? b : a, drop = keep === a ? b : a
  const moves = photoPlacements(read, [drop.id, ...(drop.copies ?? [])])
  const run = async (kind: 'same' | 'distinct') => {
    setBusy(kind); setError('')
    try { if (kind === 'same') await onSame(keep, drop); else await onDistinct(a, b); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  const side = (x: LibraryAsset) => {
    const where = photoPlacements(read, [x.id, ...(x.copies ?? [])])
    return <section className={styles.sameSide} aria-label={x.label}>
      <MediaPreview type={x.mediaType} url={x.url} label={x.label} />
      <Radio name="same-photo-keep" label={`Keep ${x.label}`} checked={keep.id === x.id} disabled={!!busy} onChange={() => setKeepId(x.id)} />
      <p className={styles.muted}>{photoSource(x.url)}{x.width && x.height ? ` · ${x.width} × ${x.height} px` : ''}{x.copies?.length ? ` · stored ${x.copies.length + 1} times` : ''}</p>
      <p className={styles.muted}>{where.length ? `Used in: ${where.join('; ')}` : 'Not in any photo set'}</p>
    </section>
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} size="lg" title="Same photo?"
    subtitle="These two photos look the same, at two addresses. Nothing is deleted and nothing is sent to a channel."
    footer={<>
      <Button size="sm" disabled={!!busy} onClick={onClose}>Cancel</Button>
      <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('distinct')}>{busy === 'distinct' ? 'Saving…' : 'Not the same'}</Button>
      <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void run('same')}>{busy === 'same' ? 'Saving…' : `Same photo — keep ${keep.label}`}</Button>
    </>}>
    <div className={styles.sameBody}>
      <div className={styles.samePair}>{side(a)}{side(b)}</div>
      <p className={styles.sameText}>{moves.length
        ? `${drop.label} becomes a copy of ${keep.label}. These photo sets show ${keep.label} instead: ${moves.join('; ')}.`
        : `${drop.label} becomes a copy of ${keep.label}. No photo set uses it, so no set changes.`}</p>
      {error && <Banner tone="danger" title="Nothing was changed">{error}</Banner>}
    </div>
  </Modal>
}
