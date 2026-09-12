'use client'
import { useState } from 'react'
import { MediaGallery, MediaPreview, Modal, Banner, Field, mediaTypeLabel } from '@/design-system/components'
import { Button, Checkbox, Input, TooltipPortalProvider } from '@/design-system/primitives'
import type { InformationMedia, MediaOrderEdit } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { ReferencePicker } from './ReferencePicker'
import styles from './information.module.css'

export function InformationMediaDialog({ title, items, baseline, existing, path, schema, anchor, disabled, onApply, onClose }: {
  title: string; items: InformationMedia[]; anchor: HTMLElement | null; disabled: boolean
  baseline: InformationMedia[]; existing?: MediaOrderEdit; path: string; schema: ShopifyStoreSchema
  onApply(ids: string[], added: InformationMedia[], altEdits: NonNullable<MediaOrderEdit['altEdits']>): boolean; onClose(): void
}) {
  const [ids, setIds] = useState(() => items.map(m => m.id)), [preview, setPreview] = useState<string | null>(null), [library, setLibrary] = useState(false)
  const [files, setFiles] = useState(items), [alts, setAlts] = useState<Record<string, string>>(() => Object.fromEntries((existing?.altEdits ?? []).map(a => [a.id, a.nextValue])))
  const [confirmed, setConfirmed] = useState(!!existing?.sharedAltConfirmed)
  const dirty = JSON.stringify(ids) !== JSON.stringify(items.map(m => m.id)) || JSON.stringify(alts) !== JSON.stringify(Object.fromEntries((existing?.altEdits ?? []).map(a => [a.id, a.nextValue])))
  const current = files.find(m => m.id === preview), index = preview ? ids.indexOf(preview) : -1
  const altEdits = Object.entries(alts).flatMap(([id, nextValue]) => { const value = (baseline.find(m => m.id === id) ?? files.find(m => m.id === id))?.alt ?? ''; return ids.includes(id) && value !== nextValue ? [{ id, value, nextValue }] : [] })
  const filesAllowed = !disabled && !!schema.native?.scopes.includes('write_files')
  return <TooltipPortalProvider><Modal open readable anchor={anchor} title={`Media: ${title}`} size="lg" onClose={onClose}
    subtitle={`${ids.length} media items · Drag to reorder, or choose a position`}
    footer={<><Button size="sm" onClick={onClose}>Cancel</Button><Button size="sm" variant="primary" disabled={disabled || !dirty || !!altEdits.length && !confirmed} onClick={() => { if (onApply(ids, files.filter(m => ids.includes(m.id) && !baseline.some(b => b.id === m.id)), altEdits)) onClose() }}>Apply to draft</Button></>}>
    <div className={styles.stack}>
      <Button size="sm" disabled={!filesAllowed || ids.length >= 250} onClick={() => setLibrary(true)}>Add from Shopify files</Button>
      {ids.length ? <MediaGallery compact label={`${title} gallery`} items={ids.map((id, position) => { const m = files.find(m => m.id === id)!; return { id, src: m.preview, mediaType: m.type, label: `${title}, ${(alts[id] ?? m.alt) || mediaTypeLabel(m.type)}, ${position + 1} of ${ids.length}`, detail: m.status !== 'READY' ? m.status : undefined } })}
        firstLabel="First" positionControls disabled={disabled} onChange={setIds} onRemove={filesAllowed ? id => setIds(old => old.filter(value => value !== id)) : undefined} onPreview={setPreview} /> : <p>Add an image, video or 3D model from this store’s files.</p>}
      <p className={styles.hint}>{dirty ? 'Media order changed. Apply to draft, then save and synchronize.' : 'The first media item supplies the product gallery preview.'}</p>
      {baseline.some(m => !ids.includes(m.id)) && <Banner tone="warning">Removing a gallery item can clear variant images that use it. The synchronization review identifies affected variants. Source files remain in the library; external-video embeds are removed from this product.</Banner>}
      {!!altEdits.length && <Checkbox label="Update this shared file’s alt text everywhere the file is used" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />}
      {!schema.native?.scopes.includes('write_files') && <p className={styles.hint}>Attachment and alt-text changes require Shopify write_files permission. Reordering remains available.</p>}
    </div>
  </Modal>
  {library && <ReferencePicker path={path} schema={schema} type="product_media" excluded={ids} onClose={() => setLibrary(false)} onChoose={item => {
    if (item.media?.status !== 'READY') return
    setFiles(old => [...old.filter(m => m.id !== item.id), item.media!]); setIds(old => [...old, item.id]); setLibrary(false)
  }} />}
  {current && <Modal open readable title={`${title} · ${index + 1} of ${ids.length}`} size="lg" onClose={() => setPreview(null)} footer={<>
    <Button size="sm" disabled={index <= 0} onClick={() => setPreview(ids[index - 1])}>Previous file</Button><Button size="sm" disabled={index >= ids.length - 1} onClick={() => setPreview(ids[index + 1])}>Next file</Button>
  </>}><div className={styles.preview}>
    <MediaPreview type={current.type} url={current.url} poster={current.preview} sources={current.sources} label={current.alt || `${title}, ${mediaTypeLabel(current.type)} ${index + 1}`} />
    <dl><dt>Media type</dt><dd>{mediaTypeLabel(current.type)}</dd><dt>Processing</dt><dd>{current.status}</dd><dt>Alt text</dt><dd>{current.alt || 'Not set'}</dd></dl>
    <Field label="Alt text" hint="This description belongs to the shared Shopify file."><Input size="sm" disabled={!filesAllowed} value={alts[current.id] ?? current.alt} maxLength={2000} onChange={e => { setAlts(old => ({ ...old, [current.id]: e.target.value })); setConfirmed(false) }} /></Field>
  </div></Modal>}
  </TooltipPortalProvider>
}
