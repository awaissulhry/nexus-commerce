'use client'

import { useState } from 'react'
import type { MediaOp, MediaSetRef } from '@nexus/shared/media-plan'
import { AMAZON_SLOTS, type AmazonMediaLayout, type ChannelMediaLayout, type EbayMediaLayout, type EtsyMediaLayout, type MediaAsset, type ShopifyMediaLayout } from '@nexus/shared/media-plan-channels'

import { Banner, DataGrid, Menu, Thumbnail, type Column } from '@/design-system/components'
import { Button, SegmentedControl } from '@/design-system/primitives'

import { CHANNEL_LABEL, checkCounts, copyFromOps, destinationLabel, followAllOps, type LayerView, type MediaDestinationRow, type MediaRead } from './model'
import { PlanBoard } from './PlanBoard'
import styles from './planPage.module.css'

export interface ChannelViewProps {
  read: MediaRead
  destination: MediaDestinationRow
  layout: ChannelMediaLayout | undefined
  assets: Map<string, MediaAsset>
  languages: string[] | null
  edit(view: LayerView, ops: MediaOp[], label: string): void
  onAddRequest(view: LayerView, ref: MediaSetRef, label: string): void
  onOpen(assetId: string): void
  onClose(): void
}

/** One destination: its sets on its own layer or its channel's, the buyer preview and the checks (PLAN.md §5.4). */
export function ChannelView({ read, destination: d, layout, assets, languages, edit, onAddRequest, onOpen, onClose }: ChannelViewProps) {
  const [scope, setScope] = useState<'LISTING' | 'CHANNEL'>('LISTING')
  const view: LayerView = scope === 'LISTING' ? { layer: 'LISTING', destination: d.key } : { layer: 'CHANNEL', channel: d.channel }
  const channel = CHANNEL_LABEL[d.channel]
  const others = read.destinations.filter(x => x.key !== d.key && x.targetable).sort((a, b) => Number(b.channel === d.channel) - Number(a.channel === d.channel))
  const followAll = followAllOps(read, view)
  const { errors, warnings } = checkCounts(layout?.checks ?? [])
  const url = (id: string) => assets.get(id)?.url ?? null
  const name = (id: string) => assets.get(id)?.label ?? 'Photo'

  return <section className={styles.channelView} aria-label={`Photos for ${destinationLabel(d)}`}>
    <header className={styles.channelHead}>
      <Button size="sm" variant="ghost" onClick={onClose}>← All destinations</Button>
      <h3 className={styles.sectionTitle}>{destinationLabel(d)}</h3>
      {d.channel === 'AMAZON' && <span className={styles.muted}>Applies to {d.markets.join(' ')} — Amazon keeps one photo set per ASIN.</span>}
      <span className={styles.spacer} />
      {others.length > 0 && scope === 'LISTING' && <Menu label="Copy photos from ▾" align="right" triggerProps={{ className: 'nds-btn sm' }}
        items={others.map(o => ({ id: o.key, label: destinationLabel(o), onSelect: () => {
          const ops = copyFromOps(read, o, d)
          if (ops.length) edit(view, ops, `Copy photos from ${destinationLabel(o)}`)
        } }))} />}
      <Button size="sm" variant="secondary" disabled={!followAll.length} onClick={() => edit(view, followAll, `Follow ${scope === 'LISTING' ? `all ${channel} listings` : 'Shared'} for every set`)}>
        {scope === 'LISTING' ? 'Follow the channel for all sets' : 'Follow Shared for all sets'}
      </Button>
    </header>
    <SegmentedControl ariaLabel="Which photos to edit" size="sm" value={scope} onChange={value => setScope(value as 'LISTING' | 'CHANNEL')}
      options={[{ value: 'LISTING', label: d.channel === 'AMAZON' || d.channel === 'SHOPIFY' ? 'This account only' : 'This listing only' }, { value: 'CHANNEL', label: `All ${channel} ${d.channel === 'AMAZON' || d.channel === 'SHOPIFY' ? 'accounts' : 'listings'}` }]} />
    <PlanBoard read={read} view={view} channel={d.channel} assets={assets} languages={languages ?? d.languages} showSkus={false}
      edit={(ops, label) => edit(view, ops, label)} onAddRequest={(ref, label) => onAddRequest(view, ref, label)} onOpen={onOpen} />

    <h4 className={styles.subTitle}>Buyer preview</h4>
    {!layout ? <p className={styles.muted}>This destination cannot receive photos: {d.refusal}</p>
      : d.channel === 'EBAY' ? <EbayPreview layout={layout as EbayMediaLayout} url={url} name={name} />
      : d.channel === 'AMAZON' ? <AmazonPreview layout={layout as AmazonMediaLayout} url={url} name={name} />
      : d.channel === 'SHOPIFY' ? <ShopifyPreview read={read} layout={layout as ShopifyMediaLayout} url={url} name={name} />
      : <EtsyPreview layout={layout as EtsyMediaLayout} url={url} name={name} />}

    <h4 className={styles.subTitle}>Checks</h4>
    {errors.length === 0 && warnings.length === 0 ? <p className={styles.muted}>No problems. Publishing is a separate step.</p> : <>
      {errors.length > 0 && <Banner tone="danger" title={`${errors.length} to fix before this destination can be published`}><ul className={styles.checkList}>{errors.map(c => <li key={c.message}>{c.message}</li>)}</ul></Banner>}
      {warnings.length > 0 && <Banner tone="warning" title={`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`}><ul className={styles.checkList}>{warnings.map(c => <li key={c.message}>{c.message}</li>)}</ul></Banner>}
    </>}
  </section>
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
  const columns: Array<Column<typeof rows[number]>> = [
    { key: 'skus', label: 'SKUs', render: r => r.skus.length > 2 ? `${r.skus[0]} +${r.skus.length - 1}` : r.skus.join(', ') },
    ...slots.map(slot => ({ key: slot, label: slot, render: (r: typeof rows[number]) => r.slots[slot] ? <Thumbnail src={url(r.slots[slot]!)} alt={`${slot}: ${name(r.slots[slot]!)}`} /> : '—' })),
  ]
  return <div className={styles.preview}>
    <DataGrid ariaLabel="Amazon slots per SKU" columns={columns} rows={rows} rowKey={r => r.skus.join('|')} />
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
