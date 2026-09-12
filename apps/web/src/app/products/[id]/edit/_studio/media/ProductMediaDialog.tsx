'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Banner, Field, FileDropzone, MediaCard, MediaGallery, MediaPreview, Modal, mediaTypeLabel } from '@/design-system/components'
import { Button, Input, Textarea, TooltipPortalProvider } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { mediaCaptionSchema, productMediaCollectionSchema, type ProductMediaCollection, type ProductMediaItem, type ProductMediaQuery, type ProductMediaWorkspace } from '@nexus/shared/product-media'
import styles from './media.module.css'

export function productMediaEndpoint(productId: string, context: ProductMediaQuery) {
  return `${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/product-media?${new URLSearchParams(Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`
}

async function responseData(response: Response) {
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error === 'NEAR_DUPLICATE' ? 'A similar file already exists. Choose it from the library, or manage duplicate uploads in Media.' : data?.error || `The request failed (${response.status}).`)
  return data
}

export function ProductMediaDialog({ productId, title, context, contextLabel, anchor, onClose, onSaved, onDirtyChange }: {
  productId: string; title: string; context: ProductMediaQuery; contextLabel: string; anchor: HTMLElement | null
  onClose(): void; onSaved(): void; onDirtyChange?(dirty: boolean): void
}) {
  const canEdit = usePermission('products.images.edit')
  const [workspace, setWorkspace] = useState<ProductMediaWorkspace | null>(null)
  const [draft, setDraft] = useState<ProductMediaCollection>({ version: 1, items: [] })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState<string | null>(null), [library, setLibrary] = useState(false), [discard, setDiscard] = useState(false)
  const [reset, setReset] = useState(false)
  const [requiresReload, setRequiresReload] = useState(false)
  const id = useId(), mounted = useRef(true)
  const endpoint = productMediaEndpoint(productId, context)
  const dirty = !!workspace && (reset || JSON.stringify(draft) !== JSON.stringify(workspace.collection))
  const read = useCallback(async (signal?: AbortSignal) => responseData(await fetch(endpoint, { credentials: 'include', cache: 'no-store', signal })) as Promise<ProductMediaWorkspace>, [endpoint])
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('')
    try { const value = await read(signal); if (!signal?.aborted && mounted.current) { setWorkspace(value); setDraft(value.collection); setReset(false); setRequiresReload(false) } }
    catch (e) { if (!signal?.aborted && mounted.current) setError(e instanceof Error ? e.message : 'Media could not be loaded.') }
    finally { if (!signal?.aborted && mounted.current) setLoading(false) }
  }, [read])
  useEffect(() => { mounted.current = true; const controller = new AbortController(); void load(controller.signal); return () => { mounted.current = false; controller.abort() } }, [load])
  useEffect(() => { onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [dirty, busy, onDirtyChange])
  useEffect(() => {
    if (!dirty && !busy) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, busy])
  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  function changeItem(assetId: string, update: Partial<ProductMediaItem>) { setReset(false); setDraft(old => ({ ...old, items: old.items.map(item => item.assetId === assetId ? { ...item, ...update } : item) })) }
  async function save() {
    if (!workspace || busy || !canEdit || requiresReload) return
    const parsed = productMediaCollectionSchema.safeParse(draft)
    if (!reset && !parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the media details.'); return }
    setBusy(true); setError('')
    try {
      const saved: ProductMediaWorkspace = await responseData(await fetch(endpoint, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: workspace.revision, collection: reset ? null : draft }) }))
      if (mounted.current) { setWorkspace(saved); setDraft(saved.collection); setReset(false); onSaved(); onClose() }
    } catch (e) { if (mounted.current) { setRequiresReload(true); setError(e instanceof Error ? e.message : 'The save result could not be confirmed. Reload the saved gallery before retrying.') } }
    finally { if (mounted.current) setBusy(false) }
  }
  async function upload(files: File[]) {
    if (!workspace || busy || !canEdit) return
    if (draft.items.length + files.length > 250) { setError('A gallery can contain up to 250 files. Remove gallery references before adding more.'); return }
    setBusy(true); setError('')
    const added: string[] = []
    try {
      for (const file of files) {
        const video = /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)
        if (!video && file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: images must be no larger than 20 MB.`)
        const form = new FormData(); form.append('file', file)
        const value = await responseData(await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/${video ? 'videos' : 'images'}`, { method: 'POST', credentials: 'include', body: form }))
        if (typeof value?.id !== 'string') throw new Error('The upload result could not be confirmed. Reload the library before retrying.')
        added.push(value.id)
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'The upload result could not be confirmed. Reload the library before retrying.') }
    finally {
      try {
        const updated = await read()
        if (mounted.current) {
          // Uploads add library files immediately. Retain unsaved selection and metadata, and
          // advance the revision only when the saved selection still matches our observation.
          const withoutNew = (value: ProductMediaCollection) => ({ ...value, items: value.items.filter(item => !added.includes(item.assetId)) })
          if (JSON.stringify(withoutNew(updated.collection)) === JSON.stringify(withoutNew(workspace.collection))) setWorkspace(updated)
          else { setRequiresReload(true); setWorkspace(old => old ? { ...old, assets: updated.assets } : old); setError('The saved gallery changed during upload. Reload the gallery before saving. Uploaded files are retained in the library.') }
          setReset(false); setDraft(old => ({ ...old, items: [...old.items, ...added.filter(assetId => !old.items.some(item => item.assetId === assetId)).map(assetId => ({ assetId }))] }))
          onSaved()
        }
      } catch { if (mounted.current) { setRequiresReload(true); setError('The library could not be refreshed after upload. Reload before saving; uploaded files may already be stored.') } }
      if (mounted.current) setBusy(false)
    }
  }
  const currentItem = draft.items.find(item => item.assetId === preview), current = workspace?.assets.find(asset => asset.id === preview)
  const index = draft.items.findIndex(item => item.assetId === preview)
  const displayLabel = (assetId: string, position: number) => {
    const asset = workspace?.assets.find(asset => asset.id === assetId), item = draft.items.find(item => item.assetId === assetId)
    return `${(item?.alt ?? asset?.alt) || mediaTypeLabel(asset?.type ?? 'FILE')}, ${position + 1} of ${draft.items.length}`
  }
  return <TooltipPortalProvider>
    <Modal open readable anchor={anchor} size="lg" title={`Product media · ${title}`} subtitle={contextLabel} onClose={close} footer={<>
      <Button size="sm" disabled={busy} onClick={close}>Cancel</Button>
      <Button size="sm" variant="primary" disabled={loading || busy || !canEdit || requiresReload || !dirty} onClick={() => void save()}>{busy ? 'Working…' : 'Save media'}</Button>
    </>}>
      <div className={styles.stack} aria-busy={busy || loading}>
        {error && <Banner tone="danger" title="Media needs attention">{error} <Button size="sm" disabled={busy} onClick={() => { if (dirty) setDiscard(true); else void load() }}>Reload gallery</Button></Banner>}
        {!canEdit && <Banner tone="neutral">You can preview this gallery. Media editing access is required to change it.</Banner>}
        {loading ? <p role="status">Loading media…</p> : workspace && <>
          <div className={styles.toolbar}><span>{draft.items.length} files · {workspace.hasOverride ? 'Custom gallery' : workspace.source === 'parent' ? 'From parent product' : workspace.source === 'shared' ? 'From shared product' : workspace.source === 'all-languages' ? 'From all languages' : 'Product library'}</span>
            <Button size="sm" disabled={busy || !canEdit || reset} onClick={() => setLibrary(true)}>Add from library</Button>
            {workspace.hasOverride && <Button size="sm" disabled={busy || !canEdit} onClick={() => setReset(true)}>Use inherited media</Button>}
          </div>
          {reset ? <Banner tone="neutral">Save to remove this language’s override and use inherited media again. <Button size="sm" onClick={() => setReset(false)}>Keep custom gallery</Button></Banner>
            : <>
              {draft.items.length ? <MediaGallery compact positionControls firstLabel="First" label={`${title} media`} disabled={busy || !canEdit}
                items={draft.items.map((item, position) => { const asset = workspace.assets.find(asset => asset.id === item.assetId); return { id: item.assetId, src: asset?.preview, mediaType: asset?.type ?? 'FILE', label: displayLabel(item.assetId, position), detail: !asset ? 'Source file missing' : undefined } })}
                onChange={ids => setDraft(old => ({ ...old, items: ids.map(assetId => old.items.find(item => item.assetId === assetId)!) }))}
                onPreview={setPreview} onRemove={assetId => setDraft(old => ({ ...old, items: old.items.filter(item => item.assetId !== assetId) }))} />
                : <p>No media selected. Add images or videos from the library, or upload files below.</p>}
              <FileDropzone disabled={busy || !canEdit} multiple accept=".jpg,.jpeg,.png,.webp,.gif,.avif,.mp4,.mov,.webm" maxBytes={200 * 1024 * 1024} onFiles={files => void upload(files)} hint="Images up to 20 MB · MP4, MOV and WebM up to 200 MB. Uploads are retained in the shared product library; gallery changes are saved separately." />
            </>}
          <p className={styles.note}>Order and descriptions apply to {contextLabel}. Removing an item keeps the source file in the library.</p>
          {context.scope !== 'MASTER' && <Banner tone="neutral">Save media stores a Nexus draft for this destination and language. Synchronize separately to update live channel attachments.</Banner>}
        </>}
      </div>
    </Modal>
    {library && workspace && <Modal open readable size="lg" title="Product media library" subtitle="Select a file to add it to this gallery." onClose={() => setLibrary(false)} footer={<Button size="sm" onClick={() => setLibrary(false)}>Done</Button>}>
      <div className={styles.library}>{workspace.assets.map(asset => <MediaCard key={asset.id} src={asset.preview} mediaType={asset.type} label={asset.alt || mediaTypeLabel(asset.type)}
        onPreview={() => setPreview(asset.id)}
        marker={draft.items.some(item => item.assetId === asset.id) ? 'In gallery' : undefined}
        actions={<Button size="sm" disabled={!canEdit || draft.items.length >= 250 || draft.items.some(item => item.assetId === asset.id)} onClick={() => { setReset(false); setDraft(old => ({ ...old, items: [...old.items, { assetId: asset.id }] })) }}>Add to gallery</Button>} />)}</div>
      {!workspace.assets.length && <p>No files yet. Close the library to upload images or videos.</p>}
    </Modal>}
    {preview && !current && <Modal open readable title="Source file unavailable" onClose={() => setPreview(null)}><p>This file is no longer in the product library. Close this preview to remove its gallery reference, or reload the gallery to check for updates.</p></Modal>}
    {current && !currentItem && <Modal open readable size="lg" title={current.alt || mediaTypeLabel(current.type)} onClose={() => setPreview(null)}><MediaPreview type={current.type} url={current.url} poster={current.preview} label={current.alt || title} /></Modal>}
    {current && currentItem && <Modal open readable size="lg" title={`${title} · ${index + 1} of ${draft.items.length}`} subtitle={contextLabel} onClose={() => setPreview(null)} footer={<>
      <Button size="sm" disabled={index <= 0} onClick={() => setPreview(draft.items[index - 1].assetId)}>Previous file</Button><Button size="sm" disabled={index >= draft.items.length - 1} onClick={() => setPreview(draft.items[index + 1].assetId)}>Next file</Button><Button size="sm" onClick={() => setPreview(null)}>Done</Button>
    </>}>
      <div className={styles.details}>
        <MediaPreview type={current.type} url={current.url} poster={current.preview} label={(currentItem.alt ?? current.alt) || title} captions={currentItem.captions?.filter(caption => mediaCaptionSchema.safeParse(caption).success).map(caption => ({ ...caption, default: caption.language === context.locale }))} transcript={currentItem.transcript} />
        <div className={styles.stack}>
          <p>{mediaTypeLabel(current.type)}{current.width && current.height ? ` · ${current.width} × ${current.height}` : ''}{current.durationSec ? ` · ${Math.round(current.durationSec)} seconds` : ''}</p>
          <Field label={`Alt text · ${context.locale === 'und' ? 'All languages' : context.locale}`} hint="Describe the meaningful visual details in the selected language."><Textarea readOnly={!canEdit} id={`${id}-alt`} rows={3} maxLength={2000} value={currentItem.alt ?? current.alt} onChange={event => changeItem(current.id, { alt: event.target.value })} /></Field>
          {['VIDEO', 'EXTERNAL_VIDEO', 'AUDIO'].includes(current.type) && <>
            <Field label="Transcript"><Textarea readOnly={!canEdit} id={`${id}-transcript`} rows={6} maxLength={50000} value={currentItem.transcript ?? ''} onChange={event => changeItem(current.id, { transcript: event.target.value })} /></Field>
            <Field label={`Captions · ${context.locale}`} hint="Public HTTPS URL of a WebVTT (.vtt) file. Other language tracks are retained."><Input readOnly={!canEdit} id={`${id}-captions`} type="url" value={currentItem.captions?.find(caption => caption.language === context.locale)?.url ?? ''} onChange={event => changeItem(current.id, { captions: [...(currentItem.captions ?? []).filter(caption => caption.language !== context.locale), ...(event.target.value ? [{ url: event.target.value, language: context.locale, label: context.locale }] : [])] })} /></Field>
          </>}
        </div>
      </div>
    </Modal>}
    {discard && <Modal open readable title="Discard unsaved media changes?" onClose={() => setDiscard(false)} footer={<><Button size="sm" onClick={() => setDiscard(false)}>Keep editing</Button><Button size="sm" onClick={() => { setDiscard(false); void load() }}>Discard and reload</Button><Button size="sm" variant="danger" onClick={onClose}>Discard and close</Button></>}><p>Uploaded files stay in the library. Unsaved gallery changes will be discarded.</p></Modal>}
  </TooltipPortalProvider>
}
