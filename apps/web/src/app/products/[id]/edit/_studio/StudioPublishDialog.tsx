'use client'

import { useEffect, useMemo, useState } from 'react'
import type { StudioPublishScope } from '@nexus/shared/studio-publication'
import { PublishDialog, type PublicationInitialSelection, type PublicationSaveBridge } from '@/app/products/_publication/dialog/PublishDialog'
import { listedDestinationKeys, type ListedDestinations } from '@/app/products/_publication/dialog/destinations'
import { publicationDestinations } from '@/app/products/_publication/dialog/model'
import { usePublicationSave, useStudioDiscoveryFailure, useStudioProduct, useStudioScope } from './contracts'
import { readPublishActions } from './sheet/publishActionsApi'

/**
 * The studio's Publish dialog: the shared, context-free dialog fed from the studio's own state — the product, the
 * markets it can reach, its autosave, and the destination it is showing (ticked first).
 *
 * One-click publish (Owner 2026-10-04, OD1/OD2 A): it also reads where the family is listed (the Status and Action read
 * with no filter: every listing of the family, no channel call), so the window starts with every listed market of the
 * sheet's channel and account — from the Shared tab, the first channel where the family is listed. A retry ("Publish
 * failed products again…") or an Undo review opens on its own destination only, as before.
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
  const listed = useListedDestinations(product.id, product.parentId ?? product.id, !initialDestination && !initialSelection)
  return <PublishDialog productIds={productIds} productLabel={product.sku} destinations={destinations} initialDestinations={initialDestinations}
    initialSelection={initialSelection} save={save} discoveryFailed={discoveryFailed} listed={listed} onClose={onClose} />
}

/** Where the family is listed, read once when the window opens; null when the window opens on one destination only. */
function useListedDestinations(productId: string, familyId: string, wanted: boolean): ListedDestinations | null {
  const [listed, setListed] = useState<ListedDestinations | null>(() => (wanted ? { keys: new Set(), loading: true } : null))
  useEffect(() => {
    if (!wanted) return
    const controller = new AbortController()
    readPublishActions(productId, {}, controller.signal)
      .then(read => { if (!controller.signal.aborted) setListed({ keys: listedDestinationKeys(read.rows, familyId), loading: false }) })
      .catch(() => { if (!controller.signal.aborted) setListed({ keys: new Set(), loading: false, failed: true }) })
    return () => controller.abort()
  }, [productId, familyId, wanted])
  return listed
}
