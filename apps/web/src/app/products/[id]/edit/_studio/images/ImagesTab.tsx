'use client'

/**
 * PES.7 — the Images tab of the Product Edit Studio.
 *
 * The tab renders the ACTIVE SCOPE and only that. It deliberately has no channel tab strip of its
 * own: the old tab carried Master/Amazon/eBay/Shopify tabs beside the page's own tabs, and under
 * the studio frame the scope bar already answers "which layer am I editing?"
 * (`useStudioScope()`). Two controls for one fact is the thing the frame exists to remove.
 *
 * The three signals the old strip's per-channel pills carried are not lost, they move:
 * completeness → the frame's readiness chips; unpublished and unsaved → this tab's own header,
 * within the scope they describe (inventory §8).
 *
 * Built from scratch on the DS (layout §2.10). Capability spec: inventory §2.
 */
import { useCallback, useEffect, useState } from 'react'

import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

import { useStudioScope } from '../contracts'
import { MASTER_SCOPE } from '../types'
import { AmazonMatrix } from './channel/amazon/AmazonMatrix'
import { EbayGrid } from './channel/ebay/EbayGrid'
import { PublishHistory } from './publish/PublishHistory'
import { ScheduleSurface } from './publish/ScheduleSurface'
import { LocalPublishSettings } from './local/LocalPublishSettings'
import { CrossChannelPlanner } from './plan/CrossChannelPlanner'
import { MasterGallery } from './master/MasterGallery'
import { VideoSection } from './master/VideoSection'
import { ImageEditor } from './editor/ImageEditor'
import { ImageViewer } from './viewer/ImageViewer'
import { useImageWorkspace } from './useImageWorkspace'
import type { MasterAsset } from './types'
import styles from './images.module.css'

export interface ImagesTabProps {
  productId: string
}

export function ImagesTab({ productId }: ImagesTabProps) {
  // `options.channels` is the marketplace table's own answer — the planner must never invent a
  // channel or a market the DB does not declare.
  const { scope, market, options } = useStudioScope()
  const publicationAvailable = false
  const ws = useImageWorkspace(productId)
  const [error, setError] = useState<string | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  const openViewer = useCallback((asset: MasterAsset) => setViewingId(asset.id), [])

  // Say something once a load has clearly gone past "quick". Reset whenever the status changes so
  // a later reload starts the clock again.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (ws.state.status !== 'loading') { setSlow(false); return }
    const t = window.setTimeout(() => setSlow(true), 4000)
    return () => window.clearTimeout(t)
  }, [ws.state.status])

  if (ws.state.status === 'loading') {
    return (
      <div className={styles.tab}>
        <div className={styles.state}>
          <span>Loading images…</span>
          {/* Measured against prod: this read takes ~6s on a 24-image product. A spinner that says
              nothing for six seconds is indistinguishable from one that will never finish. */}
          {slow && (
            <span>
              Still waiting on the server. <Button size="sm" variant="ghost" onClick={() => void ws.reload()}>Retry</Button>
            </span>
          )}
        </div>
      </div>
    )
  }

  if (ws.state.status === 'error') {
    return (
      <div className={styles.tab}>
        <div className={styles.state}>
          <span className={styles.stateTitle}>Images could not be loaded</span>
          {/* The server's own sentence — the operator acts on the real reason, not on "an error". */}
          <span>{ws.state.message}</span>
          {/* A dead end is never acceptable: whatever went wrong, there is a way to try again. */}
          <Button size="sm" variant="secondary" onClick={() => void ws.reload()}>Try again</Button>
        </div>
      </div>
    )
  }

  // Held by ID, not by object: a save replaces the row, and a captured object would keep showing
  // the pre-save copy while the gallery behind it showed the new one.
  const viewing = viewingId ? ws.images.find((a) => a.id === viewingId) ?? null : null
  const editing = editingId ? ws.images.find((a) => a.id === editingId) ?? null : null

  return (
    <div className={styles.tab}>
      {scope !== MASTER_SCOPE && <Banner tone="neutral" title="Shared gallery assets">These images are shared by product, channel and market. Gallery edits affect every account using them. Account-specific live status, publication, scheduling and cross-channel copying remain unavailable until those operations can preserve this destination.</Banner>}
      {error && <div className={styles.error} role="alert">{error}</div>}

      {/* Axis resolution warns, never blocks — a ghost axis is worth saying out loud because it
          changes how many buckets a channel will publish. */}
      {ws.axisWarnings.length > 0 && (
        <div className={styles.notice}>
          {ws.axisWarnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      {scope === MASTER_SCOPE ? (
        <>
        <MasterGallery
          productId={productId}
          isParent={ws.state.status === 'ready' ? ws.state.data.product.isParent : false}
          childCount={ws.state.status === 'ready' ? ws.state.data.variants.length : 0}
          brand={ws.state.status === 'ready' ? ws.state.data.product.brand : null}
          productType={ws.state.status === 'ready' ? ws.state.data.product.productType : null}
          productName={ws.state.status === 'ready' ? ws.state.data.product.name : null}
          assets={ws.images}
          damDrift={ws.damDrift}
          onOpen={openViewer}
          onAssetsChange={(next) => ws.setMaster([...next, ...ws.videos])}
          write={ws.write}
          onError={setError}
        />
        <VideoSection
          productId={productId}
          videos={ws.videos}
          onVideosChange={(next) => ws.setMaster([...ws.images, ...next])}
          write={ws.write}
          onError={setError}
        />
        </>
      ) : scope === 'AMAZON' ? (
        <AmazonMatrix
          publicationAvailable={false}
          market={market}
          listing={ws.state.data.listing}
          master={ws.images}
          slotTaxonomy={ws.state.data.amazonSlotTaxonomy}
          slotTaxonomySource={ws.state.data.amazonSlotTaxonomySource}
          // The axis the buckets are grouped by: the server's resolved catalog when it sent one.
          axisValues={ws.axes[0]?.values ?? []}
          axisName={ws.axes[0]?.name ?? null}
          productId={productId}
          reload={ws.reload}
          write={ws.write}
        />
      ) : scope === 'EBAY' ? (
        <EbayGrid
          publicationAvailable={false}
          productId={productId}
          listing={ws.state.data.listing}
          master={ws.images}
          axisValues={ws.axes[0]?.values ?? []}
          axisName={ws.axes[0]?.name ?? null}
          reload={ws.reload}
          write={ws.write}
        />
      ) : (
        <div className={styles.state}>
          <span className={styles.stateTitle}>{scope} · {market ?? 'no market'}</span>
          <span>
            The Shopify image scope is the remaining P4 surface — a product-level pool plus
            per-colour variant assignment. Its shape is specified in
            <code> docs/2026-09-01-pes7-images-inventory.md</code> §2.4. This product has no Shopify
            image rows yet.
          </span>
        </div>
      )}

      {/* Before the record of what happened: what would happen, and to how many places. */}
      {publicationAvailable && scope !== MASTER_SCOPE && ws.state.status === 'ready' && (
        <CrossChannelPlanner
          productId={productId}
          channels={options.channels}
          listing={ws.state.data.listing}
          write={ws.write}
          reload={ws.reload}
        />
      )}

      {/* Every channel's attempts in one place — an operator asking "did the images go out?" does
          not think about which service recorded it. */}
      {publicationAvailable && scope !== MASTER_SCOPE && <PublishHistory productId={productId} />}

      {/* Scheduling sits below the record of what has already happened, because that is the order
          an operator reads it in: what happened, then what is meant to happen next. */}
      {publicationAvailable && scope !== MASTER_SCOPE && (
        <ScheduleSurface productId={productId} channel={scope} marketplace={market} />
      )}

      {/* Last, because everything above is the shared truth and this is only ever this operator's
          own machine — the ordering is itself part of saying so. */}
      {publicationAvailable && scope !== MASTER_SCOPE && ws.state.status === 'ready' && (
        <LocalPublishSettings
          productId={productId}
          channel={scope}
          marketplace={market}
          listing={ws.state.data.listing}
          axisName={ws.axes[0]?.name ?? null}
          reload={ws.reload}
          write={ws.write}
        />
      )}

      <ImageViewer
        productId={productId}
        asset={viewing}
        siblings={ws.images}
        listing={ws.state.status === 'ready' ? ws.state.data.listing : []}
        damAssetId={viewing ? (ws.state.status === 'ready' ? ws.state.data.damLinks[viewing.id] ?? null : null) : null}
        onNavigate={(next) => setViewingId(next.id)}
        onClose={() => setViewingId(null)}
        onEdit={(a) => { setViewingId(null); setEditingId(a.id) }}
        onPatched={(next) => ws.setMaster([
          ...ws.images.map((a) => (a.id === next.id ? next : a)),
          ...ws.videos,
        ])}
        write={ws.write}
      />

      <ImageEditor
        productId={productId}
        asset={editing}
        onClose={() => setEditingId(null)}
        onDerived={(created) => ws.setMaster([...ws.images, created, ...ws.videos])}
        write={ws.write}
      />
    </div>
  )
}
