'use client'

import { useState } from 'react'
import { galleryKey, galleryLabel, resolveGalleryFocus, type EbayMediaDraft, type EbayMediaGallery, type EbayMediaWorkspace } from '@nexus/shared/ebay-media'
import { EmptyState, Field, MediaCard, Thumbnail } from '@/design-system/components'
import { Select } from '@/design-system/primitives'
import styles from './media.module.css'

/** A preview of saved/draft image associations, not a claim about the live eBay listing. */
export function ListingPhotoPreview({ workspace, draft, galleries, onPreview }: {
  workspace: EbayMediaWorkspace; draft: EbayMediaDraft; galleries: EbayMediaGallery[]; onPreview(id: string): void
}) {
  const [selectedKey, setSelectedKey] = useState(galleryKey({ axis: null, value: null }))
  const [inspected, setInspected] = useState<{ groupKey: string; assetId: string } | null>(null)
  const selected = galleries.find(g => galleryKey(g) === selectedKey) ?? galleries[0]
  const selectionKey = galleryKey(selected)
  const initial = resolveGalleryFocus(draft, selected.value)
  const manuallyFocused = inspected?.groupKey === selectionKey && galleries.some(g => g.assetIds.includes(inspected.assetId))
  const focusId = manuallyFocused ? inspected.assetId : initial.assetId
  const focused = workspace.assets.find(a => a.id === focusId)
  return <section className={styles.photoPreview} aria-label="Listing photo preview">
    <header><h2>Common photos first, variation photos on selection</h2><p>Preview this draft’s photo associations. Live eBay images and page layout are not verified here.</p></header>
    <Field label="Preview selection"><Select value={selectionKey} onChange={event => { setSelectedKey(event.target.value); setInspected(null) }}>
      {galleries.map(g => <option key={galleryKey(g)} value={galleryKey(g)}>{g.axis === null ? 'Before selecting a variation' : galleryLabel(g, workspace.axisLabels)}</option>)}
    </Select></Field>
    <p role="status">{manuallyFocused ? `Inspecting ${focused?.label ?? 'an unavailable photo'}. Photo assignments are unchanged.` : initial.kind === 'missing-variation' ? `No photos are assigned to ${selected.value}. ${initial.assetId ? 'The common cover remains in view.' : 'There is no common cover to show.'}`
      : initial.kind === 'common' ? 'The first common photo is the default cover.' : `Selecting ${selected.value} focuses its first assigned photo. Common photos remain in the listing.`}</p>
    <div className={styles.photoPreviewLayout}>
      <div>{focused ? <MediaCard src={focused.url} label={focused.label} marker="In focus" onPreview={() => onPreview(focused.id)} />
        : <EmptyState title="No photo to show" description="Assign a default cover in Cover & common photos." />}</div>
      <div className={styles.photoSets}>{galleries.map(g => <section key={galleryKey(g)}>
        <h3>{galleryLabel(g, workspace.axisLabels)}</h3>
        {g.assetIds.length ? <ol className={styles.photoStrip} aria-label={`${galleryLabel(g, workspace.axisLabels)} preview photos`}>
          {g.assetIds.map((id, index) => { const asset = workspace.assets.find(a => a.id === id); return <li key={id}>
            <Thumbnail src={asset?.url ?? null} alt={asset?.label ?? 'Unavailable photo'} hoverPreview={false}
              title={`${galleryLabel(g, workspace.axisLabels)} · ${index + 1} · ${asset?.label ?? 'Unavailable photo'}`}
              onClick={() => setInspected({ groupKey: selectionKey, assetId: id })} />
          </li> })}
        </ol> : <p>No photos assigned.</p>}
      </section>)}</div>
    </div>
    <p><a href="https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/variations.html" target="_blank" rel="noreferrer">eBay’s common and variation photo behavior</a></p>
  </section>
}
