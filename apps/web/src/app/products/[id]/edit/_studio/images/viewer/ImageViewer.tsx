'use client'

/**
 * PES.7 — the master image viewer.
 *
 * A picture is inspected at something near its own size: the operator is checking framing, the
 * white background Amazon requires, and whether text is burned into the pixels. The DS had no
 * surface for that — `xxl` caps at 1040px × 82vh, which showed a 2250×2250 photo smaller than the
 * tile it was opened from — so `Modal` gained a `full` size (a DS change, not a page-local one:
 * layout §2.9). Everything else here is DS components.
 *
 * The detail pane is where alt text actually gets written. 23 of GALE-JACKET's 24 master images
 * have none, and alt text is a channel requirement, not decoration — so it is the first field,
 * focused and editable, rather than a read-only row in a metadata table.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Modal } from '@/design-system/components'
import { Button, Input, Select } from '@/design-system/primitives'
import { cdnFit } from '@/design-system/lib/cdn-image'

import { apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import { MASTER_IMAGE_TYPES, type ListingAsset, type MasterAsset, type PushToDamResponse } from '../types'
import styles from './viewer.module.css'

export interface ImageViewerProps {
  productId: string
  /** The asset on screen; `null` closes the viewer. */
  asset: MasterAsset | null
  /** Everything the ← / → keys can walk to, in gallery order. */
  siblings: MasterAsset[]
  /** Channel rows, so the pane can say where this picture is actually used. */
  listing: ListingAsset[]
  damAssetId: string | null
  onNavigate(next: MasterAsset): void
  onClose(): void
  /** Hand this image to the editor — the viewer is where an operator decides it needs one. */
  onEdit(asset: MasterAsset): void
  onPatched(next: MasterAsset): void
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

/** Big enough to judge framing on a retina panel without fetching the 1.6 MB original. */
const VIEW_PX = 1400

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function ImageViewer({
  productId, asset, siblings, listing, damAssetId, onNavigate, onClose, onEdit, onPatched, write,
}: ImageViewerProps) {
  const [alt, setAlt] = useState('')
  const [type, setType] = useState('')
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  /**
   * The push-to-library outcome for the picture ON SCREEN. Held here rather than lifted, because the
   * workspace's `damLinks` is what the Lineage block reads and it refreshes on its own next load —
   * and because what the operator needs to know is what the SERVER just said, `created` included.
   */
  const [pushing, setPushing] = useState(false)
  const [pushed, setPushed] = useState<{ created: boolean } | null>(null)

  // The draft follows whichever asset is on screen — walking to the next image must not carry the
  // previous one's unsaved text into a field that now belongs to a different row.
  useEffect(() => {
    setAlt(asset?.alt ?? '')
    setType(asset?.type ?? '')
    setRefusal(null)
    // The outcome belongs to the picture it was about — carrying "Added to the library" onto the
    // next image would be a claim about a row nobody pushed.
    setPushed(null)
  }, [asset?.id, asset?.alt, asset?.type])

  const index = useMemo(
    () => (asset ? siblings.findIndex((s) => s.id === asset.id) : -1),
    [asset, siblings],
  )

  const step = useCallback((delta: number) => {
    if (index < 0) return
    const next = siblings[index + delta]
    if (next) onNavigate(next)
  }, [index, onNavigate, siblings])

  useEffect(() => {
    if (!asset) return
    const onKey = (e: KeyboardEvent) => {
      // Never hijack the arrows while the operator is typing alt text.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asset, step])

  const dirty = !!asset && (alt !== (asset.alt ?? '') || type !== asset.type)
  /* Either the workspace already knew, or this session just pushed it and the server said so. */
  const alreadyInLibrary = !!damAssetId || pushed !== null

  /**
   * Hand this picture to the DAM library.
   *
   * The route is idempotent per Cloudinary `publicId`, so this is safe to press twice — but it
   * answers `created: false` the second time and the surface says so rather than claiming a new
   * library asset. A picture with no `publicId` is refused by the route (400, `NO_PUBLIC_ID`); that
   * message is shown verbatim in the refusal slot, because "images we own" is the actual rule and
   * rewording it would leave the operator guessing which of their pictures qualify.
   */
  const pushToLibrary = useCallback(async () => {
    if (!asset) return
    setPushing(true)
    setRefusal(null)
    const res = await write(
      writeSubject.asset(asset.id),
      () => apiSend<PushToDamResponse>(routes.pushToDam(productId, asset.id), 'POST'),
    )
    setPushing(false)
    if (!res.ok) { setRefusal(res.message); return }
    setPushed({ created: res.data?.created === true })
  }, [asset, productId, write])

  const save = useCallback(async () => {
    if (!asset) return
    setSaving(true)
    setRefusal(null)
    const res = await write(writeSubject.asset(asset.id), () => apiSend<MasterAsset>(
      routes.masterImage(productId, asset.id), 'PATCH',
      { alt: alt.trim() === '' ? null : alt.trim(), type },
    ))
    setSaving(false)
    if (!res.ok) { setRefusal(res.message); return }
    // Repaint from the row the server stored, not from the draft.
    if (res.data?.id) onPatched(res.data)
  }, [alt, asset, onPatched, productId, type, write])

  if (!asset) return null

  const usedIn = listing.filter((l) => l.sourceProductImageId === asset.id)
  const hasDims = asset.width != null && asset.height != null
  const analysed = asset.aiAnalyzedAt != null

  return (
    <Modal
      open
      onClose={onClose}
      size="full"
      title={asset.alt || asset.type}
      subtitle={index >= 0 ? `${index + 1} of ${siblings.length}` : undefined}
    >
      <div className={styles.layout}>
        <div className={styles.media}>
          <Button
            size="sm" variant="ghost" className={styles.navPrev}
            disabled={index <= 0} onClick={() => step(-1)} aria-label="Previous image"
          >‹</Button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.mediaImg} src={cdnFit(asset.url, VIEW_PX)} alt={asset.alt ?? ''} />
          <Button
            size="sm" variant="ghost" className={styles.navNext}
            disabled={index < 0 || index >= siblings.length - 1} onClick={() => step(1)}
            aria-label="Next image"
          >›</Button>
        </div>

        <aside className={styles.pane}>
          <section className={styles.paneBlock}>
            <label className={styles.label} htmlFor="viewer-alt">Alt text</label>
            <Input
              id="viewer-alt"
              size="sm"
              value={alt}
              placeholder="What the picture shows"
              onChange={(e) => setAlt(e.target.value)}
            />
            <p className={styles.hint}>
              Channels require it, and it is what a screen reader announces. Empty means the
              channel falls back to the product title.
            </p>
          </section>

          <section className={styles.paneBlock}>
            <label className={styles.label} htmlFor="viewer-type">Type</label>
            <Select id="viewer-type" size="sm" value={type} onChange={(e) => setType(e.target.value)}>
              {MASTER_IMAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              {/* A legacy value the API no longer accepts still has to be selectable-as-current,
                  or the picker would silently show a different type than the row holds. */}
              {!MASTER_IMAGE_TYPES.includes(asset.type as never) && (
                <option value={asset.type}>{asset.type} (legacy)</option>
              )}
            </Select>
          </section>

          {refusal && <div className={styles.refusal} role="alert">{refusal}</div>}

          <div className={styles.paneActions}>
            <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" disabled={saving}
                onClick={() => { setAlt(asset.alt ?? ''); setType(asset.type); setRefusal(null) }}>
                Revert
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onEdit(asset)}>Crop / rotate…</Button>
            {/* Kept VISIBLE when the library already holds it, not hidden: a control that disappears
                teaches nothing, and "why can I not add this one?" is the question a missing button
                creates. The title is what a disabled control cannot say for itself. */}
            <Button
              size="sm"
              variant="ghost"
              disabled={pushing || alreadyInLibrary}
              title={alreadyInLibrary
                ? 'This picture is already a library asset — the link is shown under Lineage.'
                : 'Add this picture to the DAM library so other products can reuse it.'}
              onClick={() => void pushToLibrary()}
            >
              {pushing ? 'Adding…' : alreadyInLibrary ? 'In the library' : 'Add to library'}
            </Button>
          </div>

          {/* The server's own answer, not the intent: an idempotent reuse is not an addition. */}
          {pushed && (
            <p className={styles.hint} role="status">
              {pushed.created
                ? 'Added to the library. Other products can now reuse this picture.'
                : 'Already in the library — the existing asset was reused, nothing new was made.'}
            </p>
          )}

          <section className={styles.paneBlock}>
            <span className={styles.label}>Asset</span>
            <dl className={styles.facts}>
              <dt>Dimensions</dt>
              <dd>{hasDims ? `${asset.width}×${asset.height}` : <em>not recorded</em>}</dd>
              <dt>Size</dt>
              <dd>{asset.fileSize != null ? formatBytes(asset.fileSize) : <em>not recorded</em>}</dd>
              <dt>Format</dt>
              <dd>{asset.mimeType ?? <em>not recorded</em>}</dd>
              <dt>Added</dt>
              <dd>{new Date(asset.createdAt).toLocaleDateString()}</dd>
              <dt>Hero</dt>
              <dd>{asset.isPrimary ? 'Yes — the catalog thumbnail follows this' : 'No'}</dd>
            </dl>
          </section>

          <section className={styles.paneBlock}>
            <span className={styles.label}>Analysis</span>
            {analysed ? (
              <dl className={styles.facts}>
                <dt>White background</dt>
                <dd>{asset.aiHasWhiteBackground == null ? <em>—</em> : asset.aiHasWhiteBackground ? 'Yes' : 'No'}</dd>
                <dt>Frame fill</dt>
                <dd>{asset.aiFrameFillPct == null ? <em>—</em> : `${Math.round(asset.aiFrameFillPct)}%`}</dd>
                <dt>Text overlay</dt>
                <dd>{asset.aiHasTextOverlay == null ? <em>—</em> : asset.aiHasTextOverlay ? 'Yes' : 'No'}</dd>
              </dl>
            ) : (
              /* Not "0%" and not a grey pass — an image nobody has analysed is not a failing one. */
              <p className={styles.hint}>Not analysed yet.</p>
            )}
          </section>

          <section className={styles.paneBlock}>
            <span className={styles.label}>Used on channels</span>
            {usedIn.length === 0
              ? <p className={styles.hint}>Not placed on any channel from this master row.</p>
              : (
                <ul className={styles.uses}>
                  {usedIn.slice(0, 12).map((l) => (
                    <li key={l.id}>
                      {l.platform ?? 'Master'}
                      {l.marketplace ? ` · ${l.marketplace}` : ''}
                      {l.amazonSlot ? ` · ${l.amazonSlot}` : ` · position ${l.position}`}
                      {l.variantGroupValue ? ` · ${l.variantGroupValue}` : ''}
                    </li>
                  ))}
                  {usedIn.length > 12 && <li>and {usedIn.length - 12} more</li>}
                </ul>
              )}
          </section>

          {/* `alreadyInLibrary`, not `damAssetId`: after a push in this session the workspace's
              `damLinks` is stale until its next read, and a button reading "In the library" above a
              Lineage block that lists nothing is the surface contradicting itself. */}
          {(alreadyInLibrary || asset.derivedFromImageId) && (
            <section className={styles.paneBlock}>
              <span className={styles.label}>Lineage</span>
              <dl className={styles.facts}>
                {asset.derivedFromImageId && (<><dt>Edited from</dt><dd>another master image</dd></>)}
                {alreadyInLibrary && (<><dt>DAM asset</dt><dd>linked</dd></>)}
              </dl>
            </section>
          )}
        </aside>
      </div>
    </Modal>
  )
}
