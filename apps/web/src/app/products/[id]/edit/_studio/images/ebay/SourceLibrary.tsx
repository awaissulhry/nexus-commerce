'use client'

import { useMemo, useState } from 'react'
import { Pin, PinOff, Plus, Search, Upload } from 'lucide-react'
import type { EbayMediaAsset } from '@nexus/shared/ebay-media'
import { Banner, Drawer, EmptyState, FileDropzone, MediaCard, Modal } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { mediaRequest } from './transport'
import styles from './media.module.css'

export function dimensions(asset: EbayMediaAsset) {
  return asset.width && asset.height ? `${asset.width} × ${asset.height} px` : 'Original dimensions unknown'
}

export function SourceLibrary({ assets, assignedUrls, productId, disabled, galleryLabel, galleryCount, galleryLimit, pinned, canPin, onPinChange, onClose, onAdd, onPreview, onRefresh, onBusyChange }: {
  assets: EbayMediaAsset[]; assignedUrls: Set<string>; productId: string; disabled: boolean
  galleryLabel: string; galleryCount: number; galleryLimit: number; pinned: boolean; canPin: boolean
  onPinChange(pinned: boolean): void; onClose(): void
  onAdd(ids: string[]): boolean; onPreview(id: string): void; onRefresh(): Promise<void>; onBusyChange(busy: boolean): void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [outcomes, setOutcomes] = useState<string[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const filtered = useMemo(() => assets.filter(a => `${a.label} ${a.origin}`.toLowerCase().includes(query.toLowerCase().trim())), [assets, query])
  const seen = new Set(assignedUrls)
  const addable = selected.filter(id => { const asset = assets.find(a => a.id === id); if (!asset || seen.has(asset.url)) return false; seen.add(asset.url); return true })
  const remaining = Math.max(0, galleryLimit - galleryCount)
  const close = () => { if (!uploading) onClose() }

  async function upload(files: File[]) {
    if (uploading || disabled) return
    setUploading(true); onBusyChange(true); setOutcomes([]); setUploadError(null)
    try {
      for (const file of files) {
        const body = new FormData(); body.append('file', file)
        try {
          const result = await mediaRequest(`/api/products/${encodeURIComponent(productId)}/images?type=ALT`, 'POST', body) as { id?: string; reused?: string }
          if (!result.id) throw new Error('The upload response did not confirm an image. Refresh the library before retrying.')
          setOutcomes(previous => [...previous, `${file.name}: ${result.reused === 'exact' ? 'already in the product library; reused' : 'added to the product library'}.`])
        } catch (error) {
          setOutcomes(previous => [...previous, `${file.name}: ${error instanceof Error ? error.message : 'Upload result unknown.'}`])
        }
      }
      await onRefresh()
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'The library could not be refreshed. Uploaded images may already be saved.')
    } finally { setUploading(false); onBusyChange(false) }
  }

  const footer = <>
    <span className={styles.selectionSummary} role="status">{addable.length} selected · {remaining} {remaining === 1 ? 'space' : 'spaces'} left</span>
    {!pinned && <Button disabled={uploading} onClick={close}>Cancel</Button>}
    <Button variant="tonal" disabled={disabled || !addable.length || addable.length > remaining} onClick={() => {
      if (onAdd(addable)) { setSelected([]); setAddError(null) }
      else setAddError('Photos could not be added. Close the picker to review the gallery message; your draft is retained.')
    }}><Plus size={16} aria-hidden />{addable.length ? `Add ${addable.length} ${addable.length === 1 ? 'photo' : 'photos'}` : 'Add selected'}</Button>
  </>
  const content = <section className={styles.library} aria-label="Source images">
    <div className={styles.sectionHead}>
      <p>{assets.length} photos · Shared product library</p>
      <div className={styles.actionRow}>
        {canPin && <Button size="sm" disabled={uploading} onClick={() => onPinChange(!pinned)}>{pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}{pinned ? 'Unpin library' : 'Keep open'}</Button>}
        <Button onClick={() => { setUploadOpen(true); setOutcomes([]); setUploadError(null) }} disabled={disabled}><Upload size={16} aria-hidden />Upload</Button>
      </div>
    </div>
    <Input aria-label="Search source images" placeholder="Search photos" leadingIcon={<Search size={16} aria-hidden />} value={query} onChange={event => setQuery(event.target.value)} data-autofocus />
    {addable.length > 0 && <div className={styles.sectionHead}><p>{addable.length} selected{query ? ' across all search results' : ''}</p><Button size="sm" onClick={() => setSelected([])}>Clear selection</Button></div>}
    {addError && <Banner tone="danger" title="Could not add photos">{addError}</Banner>}
    {remaining === 0 ? <Banner tone="neutral" title="This gallery is full">Remove a photo from the gallery to add another.</Banner>
      : addable.length > remaining && <Banner tone="neutral" title="Choose fewer photos">This gallery has room for {remaining} more. Deselect {addable.length - remaining} to continue.</Banner>}
    <div className={styles.sourceGrid}>
      {filtered.map(asset => <MediaCard key={asset.id} src={asset.url} label={asset.label}
        detail={<>{dimensions(asset)}<br />{assignedUrls.has(asset.url) ? 'In this gallery' : asset.origin === 'product' ? 'Product library' : 'Saved gallery image'}</>}
        selected={assignedUrls.has(asset.url) || selected.includes(asset.id)} disabled={disabled}
        onSelectedChange={assignedUrls.has(asset.url) ? undefined : checked => setSelected(current => checked ? [...new Set([...current, asset.id])] : current.filter(id => id !== asset.id))}
        onPreview={() => onPreview(asset.id)} />)}
      {filtered.length === 0 && <EmptyState title={assets.length ? 'No matching photos' : 'No source photos yet'} description={assets.length ? 'Try a different search.' : 'Upload product photos to start building your gallery.'} />}
    </div>
  </section>
  return <>
    {pinned ? <Drawer open onClose={close} mode="embedded" width={340} title="Source photos" subtitle={`To ${galleryLabel} · ${galleryCount} / ${galleryLimit}`} footer={footer} className={styles.sourcePanel}>{content}</Drawer>
      : <Modal open onClose={close} title="Add photos" subtitle={`To ${galleryLabel} · ${galleryCount} / ${galleryLimit}`} size="xl" footer={footer}>{content}</Modal>}
    <Modal open={uploadOpen} onClose={() => { if (!uploading) setUploadOpen(false) }} title="Upload source images" size="lg"
      subtitle="Files are saved to this product's library immediately. Add them to a gallery after uploading."
      footer={<Button disabled={uploading} onClick={() => setUploadOpen(false)}>{uploading ? 'Uploading…' : 'Done'}</Button>}>
      <FileDropzone multiple accept=".jpg,.jpeg,.png,.webp" maxBytes={10 * 1024 * 1024} disabled={uploading || disabled}
        hint="JPEG, PNG or WebP · up to 10 MB per file in this uploader" onFiles={files => { void upload(files) }} />
      {uploadError && <Banner tone="danger" title="Library refresh failed">{uploadError}</Banner>}
      <div role="status" className={styles.uploadResults}>{outcomes.map((text, index) => <p key={index}>{text}</p>)}{uploading && <p>Uploading files. Keep this window open.</p>}</div>
    </Modal>
  </>
}
