'use client'

import { useMemo } from 'react'
import type { StudioPublishScope } from '@nexus/shared/studio-publication'
import { PublishDialog, type PublicationInitialSelection, type PublicationSaveBridge } from '@/app/products/_publication/dialog/PublishDialog'
import { publicationDestinations } from '@/app/products/_publication/dialog/model'
import { usePublicationSave, useStudioDiscoveryFailure, useStudioProduct, useStudioScope } from './contracts'

/**
 * The studio's Publish dialog: the shared, context-free dialog fed from the studio's own state — the product, the
 * markets it can reach, its autosave, and the destination it is showing (ticked first).
 */
export function StudioPublishDialog({ onClose, initialDestination, initialSelection = null }: {
  onClose(): void
  /** Tick this destination instead of the one the studio shows (publish failed products again). */
  initialDestination?: StudioPublishScope
  initialSelection?: PublicationInitialSelection | null
}) {
  const product = useStudioProduct(), studio = useStudioScope()
  const { state, preparePublication, publicationBlocker } = usePublicationSave()
  const discoveryFailed = useStudioDiscoveryFailure()
  const canChangeEditor = studio.canChangeEditor
  const current = useMemo<StudioPublishScope | undefined>(() => studio.scope !== 'master' && studio.market && studio.accountId
    ? { channel: studio.scope, marketplace: studio.market, accountId: studio.accountId, ...(studio.listingId ? { listingId: studio.listingId } : {}) }
    : undefined, [studio.scope, studio.market, studio.accountId, studio.listingId])
  const initial = initialDestination ?? current
  const destinations = useMemo(() => publicationDestinations(studio.marketplaces, initial), [studio.marketplaces, initial])
  const initialDestinations = useMemo(() => (initial ? [initial] : []), [initial])
  const save = useMemo<PublicationSaveBridge>(() => ({
    state,
    prepare: () => preparePublication(canChangeEditor),
    blocker: () => publicationBlocker(canChangeEditor),
  }), [state, preparePublication, publicationBlocker, canChangeEditor])
  const productIds = useMemo(() => [product.id], [product.id])
  return <PublishDialog productIds={productIds} productLabel={product.sku} destinations={destinations} initialDestinations={initialDestinations}
    initialSelection={initialSelection} save={save} discoveryFailed={discoveryFailed} onClose={onClose} />
}
