'use client'
import { useEffect, useState } from 'react'
import { amazonManagedImageSlots, amazonSlotsForSection, effectiveImageSlots, type AmazonImageSection, type AmazonMediaWorkspace } from '@nexus/shared/amazon-media'
import { Banner, Field, MediaCard, Modal } from '@/design-system/components'
import { Button, Select } from '@/design-system/primitives'
import { amazonMediaPath, requestAmazonWorkspace, requestAmazonDestinations } from './transport'
import styles from './media.module.css'

export function CopyMarketGallery({ path, workspace, targetGalleryId, section, onClose, onCopied, onBusyChange }: {
  path: string; workspace: AmazonMediaWorkspace; targetGalleryId: string; section: AmazonImageSection; onClose(): void; onCopied(next: AmazonMediaWorkspace): void; onBusyChange(busy: boolean): void
}) {
  const [market, setMarket] = useState('')
  const [listing, setListing] = useState('')
  const [gallery, setGallery] = useState('common')
  const [source, setSource] = useState<AmazonMediaWorkspace | null>(null)
  const [choices, setChoices] = useState<Array<{ id: string; label: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [inspect, setInspect] = useState<string | null>(null)
  const [copySection, setCopySection] = useState<AmazonImageSection | 'all'>(section)
  const definitions = copySection === 'all' ? amazonManagedImageSlots : amazonSlotsForSection(copySection)
  useEffect(() => {
    if (!market) return
    const controller = new AbortController()
    setLoading(true); setSource(null); setChoices([]); setError(null)
    const params = new URLSearchParams({ market, accountId: workspace.destination.accountId, ...(listing ? { listingId: listing } : {}) })
    const sourcePath = `${path.split('?')[0]}?${params}`
    void requestAmazonWorkspace(sourcePath, 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) { setSource(value); setGallery('common') }
    }).catch(async e => { if (!controller.signal.aborted) {
      setError(e.message)
      try { const options = await requestAmazonDestinations(sourcePath, controller.signal); if (!controller.signal.aborted) setChoices(options) } catch { /* Original destination error remains visible. */ }
    } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [market, listing, path, workspace.destination.accountId])
  const slots = source ? gallery === 'common' ? source.draft.common : effectiveImageSlots(source.draft, gallery) : {}
  async function copy() {
    if (!source || busy) return
    setBusy(true); onBusyChange(true); setError(null)
    try {
      onCopied(await requestAmazonWorkspace(amazonMediaPath(path, '/copy-market'), 'POST', { expectedRevision: workspace.revision, sourceMarket: market,
        sourceListingId: source.destination.listingId, sourceGalleryId: gallery, sourceRevision: source.revision, targetGalleryId, section: copySection }))
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'Copy outcome unknown. Reload the saved gallery before retrying.') }
    finally { setBusy(false); onBusyChange(false) }
  }
  const inspected = source?.assets.find(a => a.id === inspect)
  return <><Modal open onClose={() => { if (!busy) onClose() }} title={`Copy images into Amazon ${workspace.destination.marketplace}`} size="xl"
    subtitle="Replaces only the chosen image section in the destination gallery and saves its draft. Images containing text need a new language review for this market."
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !source || !definitions.some(s => slots[s.code])} onClick={() => void copy()}>Copy & save draft</Button></>}>
    <div className={styles.copyControls}>
      <Field label="Images to copy"><Select value={copySection} disabled={busy} onChange={e => setCopySection(e.target.value as AmazonImageSection | 'all')}><option value="gallery">Product gallery</option><option value="safety">Safety images (PS)</option><option value="all">Product gallery and safety images</option></Select></Field>
      <Field label="Source market"><Select value={market} disabled={busy} onChange={event => { setMarket(event.target.value); setListing('') }}><option value="">Choose market</option>{workspace.markets.filter(m => m.code !== workspace.destination.marketplace).map(m => <option key={m.code} value={m.code}>{m.label}</option>)}</Select></Field>
      {!source && choices.length > 0 && <Field label="Source listing"><Select value={listing} disabled={busy} onChange={event => setListing(event.target.value)}><option value="">Choose listing</option>{choices.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></Field>}
      {source && <><Field label="Source listing"><Select value={source.destination.listingId} disabled={busy} onChange={event => setListing(event.target.value)}>{source.destination.listings.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></Field>
        <Field label="Source gallery"><Select value={gallery} disabled={busy} onChange={event => setGallery(event.target.value)}><option value="common">Common images</option>{source.items.map(i => <option key={i.id} value={i.id}>{i.sku || i.label}</option>)}</Select></Field></>}
    </div>
    {loading && <p role="status">Loading source market…</p>}
    {error && <Banner tone="danger">{error}</Banner>}
    {source && !definitions.some(s => slots[s.code]) && <p>This source section is empty. Choose a SKU gallery or a different listing.</p>}
    <div className={styles.previewGrid}>{definitions.flatMap(slot => {
      const value = slots[slot.code]; const asset = value && source?.assets.find(a => a.id === value.assetId)
      return asset ? [<MediaCard key={slot.code} src={asset.url} label={slot.label} onPreview={() => setInspect(asset.id)} detail={value!.language === 'zxx' ? 'Language-neutral' : 'Language review required after copying'} />] : []
    })}</div>
  </Modal><Modal open={!!inspected} onClose={() => setInspect(null)} title={inspected?.label ?? 'Image'} size="xl">{inspected && <img className={styles.inspection} src={inspected.url} alt={inspected.label} />}</Modal></>
}
