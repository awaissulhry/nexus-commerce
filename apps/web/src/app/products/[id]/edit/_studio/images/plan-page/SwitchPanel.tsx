'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ChannelMediaLayout, MediaAsset, MediaCheck } from '@nexus/shared/media-plan-channels'

import { Banner, DataGrid, MediaStrip, type Column } from '@/design-system/components'
import { Button, Spinner } from '@/design-system/primitives'

import { apiGet, apiSend } from '../api'
import { CHANNEL_LABEL, checkCounts, layoutSummary, type MediaChannel } from './model'
import styles from './planPage.module.css'

interface PreviewDestination {
  key: string; channel: MediaChannel; marketplace: string; markets: string[]; accountLabel: string | null
  alias: { id: string; label: string } | null; source: string; layout: ChannelMediaLayout; checks: MediaCheck[]
}
type SwitchPreview = { rootId: string; switched: true } | {
  rootId: string; switched: false; revision: string; sharedSource: string; imports: number; report: string[]
  layers: Array<{ key: string; label: string; source: string }>; destinations: PreviewDestination[]; assets: Record<string, MediaAsset>
}

/** The photos a layout would send first, in order — for the preview's strip. */
function firstPhotos(layout: ChannelMediaLayout): string[] {
  if ('gallery' in layout) return [...layout.gallery, ...layout.sets.flatMap(s => s.items)]
  if ('items' in layout) return [...(layout.parent ? Object.values(layout.parent.slots) : []), ...layout.items.flatMap(i => Object.values(i.slots))].filter((id): id is string => !!id)
  if ('media' in layout) return layout.media
  return layout.images
}

/**
 * P3a/P3b — a family not on the photo plan yet: what each destination would get, next to where its photos come from
 * today, and ONE explicit switch (docs/images-studio-rebuild/P3-PLAN.md). The switch writes the plan only; nothing is
 * sent to any channel, and publishing stays its own step.
 */
export function SwitchPanel({ productId, onSwitched }: { productId: string; onSwitched(): void }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; preview: SwitchPreview }>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    const res = await apiGet<SwitchPreview>(`/api/products/${encodeURIComponent(productId)}/media/switch-preview`)
    setState(res.ok ? { status: 'ready', preview: res.data } : { status: 'error', message: res.message })
  }, [productId])
  useEffect(() => { void load() }, [load])
  // Someone else switched it meanwhile: show the page.
  useEffect(() => { if (state.status === 'ready' && state.preview.switched) onSwitched() }, [state, onSwitched])

  if (state.status === 'loading') return <section className={styles.switch} aria-busy="true"><Spinner size={14} /> Building the preview…</section>
  if (state.status === 'error') return <Banner tone="danger" title="The photo plan preview could not be built" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{state.message}</Banner>
  const preview = state.preview
  if (preview.switched) return null

  const start = async () => {
    setBusy(true); setError(null)
    const res = await apiSend<{ layers: number; imported: number; report: string[] }>(`/api/products/${encodeURIComponent(productId)}/media/switch`, 'POST', { revision: preview.revision })
    setBusy(false)
    if (!res.ok) {
      setError(res.message)
      // The preview went stale (someone changed the photos): show the new one.
      if (res.status === 409) void load()
      return
    }
    onSwitched()
  }

  const url = (id: string) => preview.assets[id]?.url ?? null
  const columns: Array<Column<PreviewDestination>> = [
    { key: 'destination', label: 'Destination', render: d => `${CHANNEL_LABEL[d.channel]}${d.marketplace === 'GLOBAL' ? ` (${d.markets.join(' ')})` : ` ${d.marketplace}`} · ${d.accountLabel ?? 'Unknown account'}${d.alias ? ` · ${d.alias.label}` : ''}` },
    { key: 'source', label: 'Photos come from', render: d => d.source },
    { key: 'sends', label: 'Would send', render: d => <span className={styles.destination}>
      <span>{layoutSummary(d.channel, d.layout)}</span>
      <MediaStrip label={`First photos for ${CHANNEL_LABEL[d.channel]}`} limit={8} items={[...new Set(firstPhotos(d.layout))].map(id => ({ id, type: preview.assets[id]?.mediaType ?? 'IMAGE', preview: url(id), alt: preview.assets[id]?.label }))} />
    </span> },
    { key: 'checks', label: 'Checks', render: d => {
      const { errors, warnings } = checkCounts(d.checks)
      return errors.length || warnings.length ? <ul className={styles.checkList}>{[...errors, ...warnings].slice(0, 4).map(c => <li key={c.message}>{c.severity === 'error' ? 'To fix: ' : ''}{c.message}</li>)}{errors.length + warnings.length > 4 && <li>+{errors.length + warnings.length - 4} more</li>}</ul> : 'Ready'
    } },
  ]

  return <section className={styles.switch} aria-label="Start using the photo plan">
    <Banner tone="info" title="This product does not use the photo plan yet">
      With the photo plan you place each photo once and every channel, market and listing follows it. Below is what each
      destination would get. Starting changes no listing: nothing is sent to any channel, and publishing stays a separate step.
    </Banner>
    <p>Shared photos would come from: <strong>{preview.sharedSource}</strong>. Layers written: {preview.layers.map(l => `${l.label} (${l.source})`).join(', ')}.
      {preview.imports > 0 && ` ${preview.imports} photo${preview.imports > 1 ? 's' : ''} from older listings will be added to the library (the same file is reused, never copied twice).`}</p>
    {preview.report.length > 0 && <Banner tone="warning" title="Read before you start"><ul className={styles.checkList}>{preview.report.map(line => <li key={line}>{line}</li>)}</ul></Banner>}
    <DataGrid ariaLabel="What each destination would get" columns={columns} rows={preview.destinations} rowKey={d => d.key}
      emptyState={<span className={styles.muted}>This product has no listings yet. The plan starts from the library order.</span>} />
    {error && <Banner tone="danger" title="Not started">{error}</Banner>}
    <div className={styles.switchActions}>
      <Button variant="primary" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start using the photo plan'}</Button>
      <Button variant="ghost" onClick={() => void load()} disabled={busy}>Refresh the preview</Button>
    </div>
  </section>
}
