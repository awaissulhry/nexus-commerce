'use client'

import { useState } from 'react'

import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

import { MasterGallery } from '../master/MasterGallery'
import { VideoSection } from '../master/VideoSection'
import { ImageEditor } from '../editor/ImageEditor'
import { ImageViewer } from '../viewer/ImageViewer'
import { useImageWorkspace } from '../useImageWorkspace'
import styles from './planPage.module.css'

/**
 * The library's own tools — upload (with the duplicate check), edit, delete, videos — until P4's upload dialog. The
 * same components the Media page used before the plan; they change the library only, never a set or a channel. Shown in
 * place of the plan (not in a drawer): their own dialogs would open behind a drawer.
 */
export function LibraryManager({ productId, onClose }: { productId: string; onClose(): void }) {
  return <section className={styles.managerPage} aria-label="Upload and edit photos">
    <header className={styles.channelHead}>
      <Button size="sm" variant="ghost" onClick={onClose}>← Back to the photo plan</Button>
      <h3 className={styles.sectionTitle}>Upload and edit photos</h3>
      <span className={styles.muted}>Changes here edit the library only. Place photos in sets on the photo plan.</span>
    </header>
    <ManagerBody productId={productId} />
  </section>
}

function ManagerBody({ productId }: { productId: string }) {
  const ws = useImageWorkspace(productId)
  const [error, setError] = useState<string | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  if (ws.state.status === 'loading') return <p className={styles.muted}>Loading the library…</p>
  if (ws.state.status === 'error') return <Banner tone="danger" title="The library could not be loaded" action={<Button size="sm" variant="secondary" onClick={() => void ws.reload()}>Try again</Button>}>{ws.state.message}</Banner>
  const data = ws.state.data
  const viewing = viewingId ? ws.images.find(a => a.id === viewingId) ?? null : null
  const editing = editingId ? ws.images.find(a => a.id === editingId) ?? null : null
  return <div className={styles.manager}>
    {error && <Banner tone="danger" title="Not saved" onDismiss={() => setError(null)}>{error}</Banner>}
    <MasterGallery productId={productId} isParent={data.product.isParent} childCount={data.variants.length} brand={data.product.brand}
      productType={data.product.productType} productName={data.product.name} assets={ws.images} damDrift={ws.damDrift}
      onOpen={asset => setViewingId(asset.id)} onAssetsChange={next => ws.setMaster([...next, ...ws.videos])} write={ws.write} onError={setError} />
    <VideoSection productId={productId} videos={ws.videos} onVideosChange={next => ws.setMaster([...ws.images, ...next])} write={ws.write} onError={setError} />
    <ImageViewer productId={productId} asset={viewing} siblings={ws.images} listing={data.listing} damAssetId={viewing ? data.damLinks[viewing.id] ?? null : null}
      onNavigate={next => setViewingId(next.id)} onClose={() => setViewingId(null)} onEdit={a => { setViewingId(null); setEditingId(a.id) }}
      onPatched={next => ws.setMaster([...ws.images.map(a => (a.id === next.id ? next : a)), ...ws.videos])} write={ws.write} />
    <ImageEditor productId={productId} asset={editing} onClose={() => setEditingId(null)} onDerived={created => ws.setMaster([...ws.images, created, ...ws.videos])} write={ws.write} />
  </div>
}
