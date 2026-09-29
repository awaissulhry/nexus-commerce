'use client'

import { useState } from 'react'
import { AMAZON_SLOTS, type AmazonMediaLayout, type ChannelMediaLayout, type EbayMediaLayout, type EtsyMediaLayout, type ShopifyMediaLayout } from '@nexus/shared/media-plan-channels'

import { Thumbnail } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { SegmentedControl } from '@/design-system/primitives'

import type { MediaDestinationRow, MediaRead } from './model'
import styles from './planPage.module.css'

/** What a buyer of one destination sees, from the layout a publish would send (PLAN.md §5.4) — the side panel's top. */
export function BuyerPreview({ read, destination: d, layout, url, name }: PreviewProps & { read: MediaRead; destination: MediaDestinationRow; layout: ChannelMediaLayout | undefined }) {
  if (!layout) return <p className={styles.muted}>This destination cannot receive photos: {d.refusal}</p>
  if (d.channel === 'EBAY') return <EbayPreview layout={layout as EbayMediaLayout} url={url} name={name} />
  if (d.channel === 'AMAZON') return <AmazonPreview layout={layout as AmazonMediaLayout} url={url} name={name} />
  if (d.channel === 'SHOPIFY') return <ShopifyPreview read={read} layout={layout as ShopifyMediaLayout} url={url} name={name} />
  return <EtsyPreview layout={layout as EtsyMediaLayout} url={url} name={name} />
}

interface PreviewProps { url(id: string): string | null; name(id: string): string }

function Strip({ ids, url, name, label }: PreviewProps & { ids: string[]; label: string }) {
  return ids.length ? <ol className={styles.previewStrip} aria-label={label}>
    {ids.map((id, i) => <li key={`${id}:${i}`}><Thumbnail src={url(id)} alt={name(id)} title={`${i + 1}. ${name(id)}`} /></li>)}
  </ol> : <p className={styles.muted}>No photos.</p>
}

function EbayPreview({ layout, url, name }: PreviewProps & { layout: EbayMediaLayout }) {
  const [value, setValue] = useState<string | null>(null)
  const set = layout.sets.find(s => s.valueKey === value)
  const shown = set ? set.items : layout.gallery
  return <div className={styles.preview}>
    <p className={styles.muted}>Search photo and first photo of the listing: {layout.gallery[0] ? name(layout.gallery[0]) : 'none'}.{layout.axisName ? ` A buyer who picks a ${layout.axisName} sees that value's photos.` : ''}</p>
    {layout.sets.length > 0 && <SegmentedControl ariaLabel={layout.axisName ?? 'Value'} size="sm" value={value ?? ''} onChange={v => setValue(v || null)}
      options={[{ value: '', label: 'Listing gallery' }, ...layout.sets.map(s => ({ value: s.valueKey, label: s.value }))]} />}
    <div className={styles.previewMain}>{shown[0] ? <Thumbnail src={url(shown[0])} alt={name(shown[0])} hoverPreview={false} /> : null}<span>{shown[0] ? name(shown[0]) : 'No picture available'}</span></div>
    <Strip ids={shown} url={url} name={name} label={set ? `${set.value} photos` : 'Listing gallery'} />
  </div>
}

function AmazonPreview({ layout, url, name }: PreviewProps & { layout: AmazonMediaLayout }) {
  // SKUs that receive the same slots are one row ("Nero · 3 SKUs").
  const groups = new Map<string, { skus: string[]; slots: AmazonMediaLayout['items'][number]['slots'] }>()
  for (const item of layout.items) {
    const key = JSON.stringify(item.slots)
    const group = groups.get(key) ?? { skus: [], slots: item.slots }
    group.skus.push(item.sku)
    groups.set(key, group)
  }
  const rows = [...(layout.parent ? [{ skus: [layout.parent.sku], slots: layout.parent.slots }] : []), ...groups.values()]
  const slots = [...AMAZON_SLOTS, 'SWCH'] as const
  // One short block per group of SKUs (the side panel is narrow): the SKUs, then each filled slot with its name.
  return <div className={styles.preview}>
    <ul className={styles.previewGroups} aria-label="Amazon slots per SKU">
      {rows.map(r => <li key={r.skus.join('|')} className={styles.previewGroup}>
        <span className={styles.previewSkus} title={r.skus.join(', ')}>{r.skus.length > 2 ? `${r.skus[0]} +${r.skus.length - 1}` : r.skus.join(', ')}</span>
        <ol className={styles.previewStrip} aria-label={`Slots of ${r.skus[0]}`}>
          {slots.filter(slot => r.slots[slot]).map(slot => <li key={slot} className={styles.previewSlot}>
            <Thumbnail src={url(r.slots[slot]!)} alt={`${slot}: ${name(r.slots[slot]!)}`} title={`${slot}: ${name(r.slots[slot]!)}`} /><span>{slot}</span>
          </li>)}
        </ol>
      </li>)}
    </ul>
    {layout.safety.length > 0 && <><p className={styles.muted}>Safety images (PS01–PS06), sent where the product type allows them:</p><Strip ids={layout.safety} url={url} name={name} label="Safety images" /></>}
  </div>
}

function ShopifyPreview({ read, layout, url, name }: PreviewProps & { read: MediaRead; layout: ShopifyMediaLayout }) {
  const rows = read.family.variants.filter(v => v.productId in layout.variantImages)
  return <div className={styles.preview}>
    <Strip ids={layout.media} url={url} name={name} label="Product media" />
    {rows.length > 0 && <DataGrid ariaLabel="Variant images" rows={rows} rowKey={v => v.productId} columns={[
      { key: 'sku', label: 'Variant', render: v => v.sku },
      { key: 'image', label: 'Variant image', render: v => layout.variantImages[v.productId] ? <Thumbnail src={url(layout.variantImages[v.productId]!)} alt={name(layout.variantImages[v.productId]!)} /> : '—' },
    ]} />}
  </div>
}

function EtsyPreview({ layout, url, name }: PreviewProps & { layout: EtsyMediaLayout }) {
  return <div className={styles.preview}>
    <Strip ids={layout.images} url={url} name={name} label="Listing photos" />
    {layout.variationImages.length > 0 && <p className={styles.muted}>Option photos: {layout.variationImages.map(v => `${v.value} → ${name(v.assetId)}`).join(' · ')}</p>}
  </div>
}
