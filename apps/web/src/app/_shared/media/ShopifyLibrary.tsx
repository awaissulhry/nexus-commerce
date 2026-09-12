'use client'

import { useEffect, useRef, useState } from 'react'
import { Box, FileText, Film, Image as ImageIcon, RefreshCw, Upload } from 'lucide-react'
import { Banner, EmptyState, Field, FileDropzone, Listbox, MediaCard, Modal } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { SHOPIFY_UPLOAD_ACCEPT, SHOPIFY_UPLOAD_MAX_BYTES, type ShopifyFile, type ShopifyFilesResponse, type ShopifyFileReference, type ShopifyFileType, type ShopifyMediaSource } from '@nexus/shared/shopify-media'
import { formatBytes } from '@/app/marketing/content/_lib/format'
import { mediaRequest } from './media-api'
import styles from './media-library.module.css'

interface Props {
  store: ShopifyMediaSource
  imagesOnly?: boolean
  onUse?(reference: ShopifyFileReference): Promise<void>
  onBusyChange?(busy: boolean): void
}
const typeLabels = { image: 'Image', video: 'Video', document: 'Document', model3d: '3D model' }
const icons = { image: ImageIcon, video: Film, document: FileText, model3d: Box }
const statusLabel = (file: ShopifyFile) => file.status === 'READY' ? 'Ready' : file.status === 'FAILED' ? 'Processing failed' : 'Processing'

export function ShopifyLibrary({ store, imagesOnly = false, onUse, onBusyChange }: Props) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [type, setType] = useState<ShopifyFileType>(imagesOnly ? 'image' : 'all')
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{ key: string; data: ShopifyFilesResponse } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ShopifyFile | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploads, setUploads] = useState<{ name: string; message: string; failed: boolean }[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [using, setUsing] = useState<string | null>(null)
  const [used, setUsed] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const busyRef = useRef(false)
  const key = JSON.stringify([store.accountId, type, debounced, revision])
  const matches = snapshot?.key === key && search.trim() === debounced
  const items = matches ? snapshot.data.items : []
  const busy = uploading || using !== null

  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort() } }, [])
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort
    if (store.readIssue) return () => abort.abort()
    setLoading(true); setError(null); setPreview(null)
    const query = new URLSearchParams({ accountId: store.accountId, type, search: debounced })
    void mediaRequest<ShopifyFilesResponse>(`shopify/files?${query}`, { signal: abort.signal }).then(data => {
      if (abort.signal.aborted) return
      if (data.accountId !== store.accountId) throw new Error('The returned library belongs to a different store. Reload it.')
      setSnapshot({ key, data })
    }).catch(err => { if (!abort.signal.aborted) setError(err.message) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [key, store.accountId, store.readIssue, type, debounced])

  async function loadMore() {
    const after = matches ? snapshot.data.nextCursor : null
    if (!after || loading) return
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort
    setLoading(true); setError(null)
    try {
      const query = new URLSearchParams({ accountId: store.accountId, type, search: debounced, after })
      const data = await mediaRequest<ShopifyFilesResponse>(`shopify/files?${query}`, { signal: abort.signal })
      if (abort.signal.aborted) return
      if (data.accountId !== store.accountId) throw new Error('The returned library belongs to a different store. Reload it.')
      if (data.nextCursor === after) throw new Error('Shopify pagination did not advance. Refresh the library.')
      setSnapshot(previous => previous?.key !== key ? previous : { key, data: { ...data, items: [...new Map([...previous.data.items, ...data.items].map(file => [file.id, file])).values()] } })
    } catch (err) { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'More files could not be loaded.') }
    finally { if (!abort.signal.aborted) setLoading(false) }
  }
  async function useFile(file: ShopifyFile) {
    if (!onUse || busyRef.current) return
    busyRef.current = true; setUsing(file.id); setActionError(null); onBusyChange?.(true)
    try {
      const reference = await mediaRequest<ShopifyFileReference>('shopify/reference', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: store.accountId, id: file.id }) })
      if (!alive.current) return
      await onUse(reference)
      if (alive.current) setUsed(previous => new Set(previous).add(file.id))
    } catch (err) { if (alive.current) setActionError(err instanceof Error ? err.message : 'The file could not be added.') }
    finally { busyRef.current = false; if (alive.current) { setUsing(null); onBusyChange?.(false) } }
  }
  async function uploadFiles(files: File[]) {
    if (busyRef.current) return
    if (files.length > 20) { setUploadError('Choose up to 20 files at a time.'); return }
    setUploadError(null)
    busyRef.current = true; setUploading(true); onBusyChange?.(true); setActionError(null)
    setUploads(files.map(file => ({ name: file.name, message: 'Waiting', failed: false })))
    for (const [index, file] of files.entries()) {
      if (!alive.current) break
      const update = (message: string, failed = false) => { if (alive.current) setUploads(previous => previous.map((row, i) => i === index ? { ...row, message, failed } : row)) }
      update('Uploading to Shopify…')
      try {
        const body = new FormData(); body.append('file', file)
        const result = await mediaRequest<{ file: ShopifyFile; reused: boolean }>(`shopify/upload?${new URLSearchParams({ accountId: store.accountId })}`, { method: 'POST', body })
        if (result.file.accountId !== store.accountId) throw new Error('The upload destination could not be confirmed. Refresh the library.')
        update(result.file.status === 'FAILED' ? result.file.errors.join('; ') || 'Shopify could not process this file.' : result.file.status === 'READY' ? result.reused ? 'Already in Shopify' : 'Ready in Shopify' : 'Uploaded · Shopify is processing', result.file.status === 'FAILED')
      } catch (err) { update(err instanceof Error ? err.message : 'Upload could not be confirmed. Refresh before retrying.', true) }
    }
    busyRef.current = false
    if (alive.current) { setUploading(false); onBusyChange?.(false); setRevision(value => value + 1) }
  }

  return <div className={styles.library}>
    <div className={styles.heading}>
      <div><h2>{store.label}</h2><p>{store.domain} · Files load directly from Shopify</p></div>
      <div className={styles.actions}>
        <Button disabled={loading || busy || !!store.readIssue} onClick={() => { setUsed(new Set()); setRevision(value => value + 1) }}><RefreshCw size={14} aria-hidden />Refresh</Button>
        {!imagesOnly && <Button variant="primary" disabled={!!store.uploadIssue || !!store.readIssue || busy} onClick={() => setUploadOpen(true)}><Upload size={14} aria-hidden />Upload to Shopify</Button>}
      </div>
    </div>
    {store.readIssue ? <Banner tone="warning" title="Store connection needs attention">{store.readIssue}</Banner> : <>
      {!imagesOnly && store.uploadIssue && <Banner tone="neutral">{store.uploadIssue} You can still browse the library.</Banner>}
      <div className={styles.filters}>
        <Field label="Search files"><Input type="search" value={search} maxLength={200} placeholder="Search by filename" onChange={event => setSearch(event.target.value)} disabled={busy} /></Field>
        {!imagesOnly && <Field label="File type"><Listbox value={type} onChange={value => setType(value as ShopifyFileType)} disabled={busy} width="100%" options={[
          { value: 'all', label: 'All files' }, { value: 'image', label: 'Images' }, { value: 'video', label: 'Videos' }, { value: 'document', label: 'Documents & other files' }, { value: 'model3d', label: '3D models' },
        ]} /></Field>}
      </div>
      {error && <Banner tone="danger" title="Library could not be loaded" action={<Button disabled={loading} onClick={() => matches && snapshot.data.nextCursor ? void loadMore() : setRevision(value => value + 1)}>Retry</Button>}>{error}</Banner>}
      {actionError && <Banner tone="danger" onDismiss={() => setActionError(null)}>{actionError}</Banner>}
      <p className={styles.count} role="status">{loading || search.trim() !== debounced ? 'Loading Shopify files…' : matches ? `${items.length.toLocaleString()} ${items.length === 1 ? 'file' : 'files'} loaded${snapshot.data.nextCursor ? ' · More available' : ''}` : ''}</p>
      {!loading && !error && matches && !items.length && <EmptyState icon={<ImageIcon size={28} />} title={search || type !== 'all' ? 'No matching files' : 'Your Shopify library is empty'} description={search || type !== 'all' ? 'Try a different filename or file type.' : 'Upload a file here or add media in Shopify, then refresh.'} />}
      <ul className={styles.grid} aria-label="Shopify files" aria-busy={loading}>
        {items.map(file => { const Icon = icons[file.type]; return <li key={file.id}>
          <MediaCard src={file.previewUrl} label={file.label} placeholder={<><Icon size={28} aria-hidden />{typeLabels[file.type]}</>} marker={typeLabels[file.type]} onPreview={() => setPreview(file)}
            detail={<div className={styles.cardFacts}><span>{statusLabel(file)}</span>{file.width && file.height ? <span>{file.width} × {file.height} px</span> : null}{file.sizeBytes !== null && <span>{formatBytes(file.sizeBytes)}</span>}</div>}
            actions={onUse ? <Button size="sm" disabled={busy || used.has(file.id) || file.status !== 'READY' || !file.url || file.type !== 'image'} onClick={() => void useFile(file)}>{used.has(file.id) ? 'Added' : using === file.id ? 'Adding…' : 'Add image'}</Button> : undefined} />
        </li> })}
      </ul>
      {matches && snapshot.data.nextCursor && <div className={styles.more}><Button disabled={loading || busy} onClick={() => void loadMore()}>{loading ? 'Loading…' : 'Load more files'}</Button></div>}
      {matches && items.some(file => !['READY', 'FAILED'].includes(file.status)) && <Banner tone="neutral">Some files are still processing in Shopify. Refresh to check their progress.</Banner>}
    </>}
    {preview && <FilePreview key={preview.id} file={preview} onClose={() => setPreview(null)} />}
    <Modal open={uploadOpen} onClose={() => { if (!uploading) setUploadOpen(false) }} size="lg" readable title="Upload to Shopify" subtitle={store.label}
      footer={<Button disabled={uploading} onClick={() => setUploadOpen(false)}>{uploading ? 'Uploading…' : 'Done'}</Button>}>
      <div className={styles.library}>
        <p>Files will be publicly accessible from Shopify. Choose up to 20 files: images and documents up to 20 MB each; videos and 3D models up to 200 MB each.</p>
        {uploadError && <Banner tone="danger">{uploadError}</Banner>}
        <FileDropzone accept={SHOPIFY_UPLOAD_ACCEPT} maxBytes={SHOPIFY_UPLOAD_MAX_BYTES} multiple disabled={uploading} onFiles={files => void uploadFiles(files)} hint="Images, videos, 3D models and documents" />
        <ul className={styles.uploads} aria-live="polite">{uploads.map((row, index) => <li key={index}><strong>{row.name}</strong><span>{row.failed ? 'Failed · ' : ''}{row.message}</span></li>)}</ul>
      </div>
    </Modal>
  </div>
}

function FilePreview({ file, onClose }: { file: ShopifyFile; onClose(): void }) {
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const Icon = icons[file.type]
  return <Modal open readable size="xl" title={file.label} subtitle={`${typeLabels[file.type]} · ${statusLabel(file)}`} onClose={onClose}
    footer={file.url ? <><span role="status">{copied ? 'Link copied' : copyError ? 'The link could not be copied. Open the file to copy its address.' : ''}</span><Button onClick={async () => { try { await navigator.clipboard.writeText(file.url!); setCopied(true); setCopyError(false) } catch { setCopyError(true) } }}>Copy link</Button><Button asChild><a href={file.url} target="_blank" rel="noopener noreferrer">Open file</a></Button></> : undefined}>
    <div className={styles.library}>
      {file.errors.length > 0 && <Banner tone="danger">{file.errors.join('; ')}</Banner>}
      {failed ? <Banner tone="warning">The preview is unavailable. Refresh the library to check whether the file has changed in Shopify.</Banner>
        : file.url && file.type === 'image' ? <img className={styles.preview} src={file.url} alt={file.alt ?? file.label} onError={() => setFailed(true)} />
        : file.url && file.type === 'video' ? <video className={styles.preview} src={file.url} poster={file.previewUrl ?? undefined} controls tabIndex={0} playsInline preload="metadata" aria-label={file.alt ?? file.label} onError={() => setFailed(true)} />
        : <EmptyState icon={<Icon size={32} />} title={file.url ? 'Open this file to view it' : file.status === 'FAILED' ? 'Shopify could not process this file' : file.status === 'READY' ? 'No compatible preview is available' : 'Shopify is processing this file'} description={file.url ? 'Use Open file to view or download it.' : 'Close this preview and refresh the library to check its status.'} />}
      <dl className={styles.facts}><dt>Filename</dt><dd>{file.label}</dd><dt>Alt text</dt><dd>{file.alt || 'Not provided'}</dd><dt>Size</dt><dd>{file.sizeBytes === null ? 'Not reported by Shopify' : formatBytes(file.sizeBytes)}</dd>
        {file.durationSeconds !== null && <><dt>Duration</dt><dd>{file.durationSeconds.toFixed(1)} seconds</dd></>}
        <dt>Updated</dt><dd>{new Date(file.updatedAt).toLocaleString()}</dd></dl>
    </div>
  </Modal>
}
