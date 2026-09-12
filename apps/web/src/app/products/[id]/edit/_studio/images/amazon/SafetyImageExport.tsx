'use client'
import { useState } from 'react'
import { planAmazonSafetyExport, type AmazonMediaWorkspace } from '@nexus/shared/amazon-media'
import { Banner, Disclosure, Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { requestAmazonSafetyArchive } from './transport'
import { SkuSelection } from './SkuSelection'
import styles from './media.module.css'

export function SafetyImageExport({ path, workspace, axis, onClose, onBusyChange }: {
  path: string; workspace: AmazonMediaWorkspace; axis: string; onClose(): void; onBusyChange(busy: boolean): void
}) {
  const [ids, setIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [downloaded, setDownloaded] = useState(false)
  const plan = planAmazonSafetyExport(workspace, ids)
  async function download() {
    if (busy || plan.issues.length || !plan.files.length) return
    setBusy(true); onBusyChange(true); setError(''); setDownloaded(false)
    try {
      const blob = await requestAmazonSafetyArchive(path, workspace.revision, ids)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = `amazon-${workspace.destination.marketplace}-safety-${workspace.revision.slice(0, 12)}.zip`
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setDownloaded(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'The safety archive could not be downloaded.') }
    finally { setBusy(false); onBusyChange(false) }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} title="Export safety images for Seller Central" size="xl"
    subtitle={`${workspace.destination.marketplace} · ${workspace.destination.label} · PS01–PS06`}
    footer={<><Button disabled={busy} onClick={onClose}>Close</Button><Button variant="primary" disabled={busy || !!plan.issues.length || !plan.files.length} onClick={() => void download()}>{busy ? 'Preparing archive…' : `Download ${plan.files.length} images`}</Button></>}>
    <div className={styles.selectionList}>
      <Banner tone="info">Amazon’s Listings API does not accept PS images. Download the archive, then upload it through Image Manager in the intended Seller Central account and market.</Banner>
      <p className={styles.note}>The archive uses saved listing ASINs and names each file ASIN.PS01.jpg through ASIN.PS06.jpg. Images are converted to JPEG at their original resolution. Empty slots are omitted; clearing a draft slot does not remove an image in Seller Central.</p>
      <SkuSelection items={workspace.items} selected={ids} onChange={next => { setIds(next); setDownloaded(false) }} defaultAxis={axis} disabled={busy} />
      {ids.length > 0 && plan.issues.map(issue => <Banner key={issue} tone="warning">{issue}</Banner>)}
      <Disclosure summary={`Archive contents · ${plan.files.length} images`}>
        <div className={styles.exportFiles}>{plan.files.map(file => <div key={`${file.asin}.${file.slot}`}><strong>{file.asin}.{file.slot}.jpg</strong><span>{file.language} · {file.listingIds.map(id => workspace.items.find(i => i.id === id)?.sku).join(', ')}</span></div>)}</div>
      </Disclosure>
      {error && <Banner tone="danger">{error}</Banner>}
      {downloaded && <Banner tone="info">Archive download prepared. Upload it in Seller Central and check Amazon’s processing result there. Nexus has not published or verified these PS images.</Banner>}
    </div>
  </Modal>
}
