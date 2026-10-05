'use client'

import { useEffect, useMemo, useState } from 'react'
import type { StudioPublishScope } from '@nexus/shared/studio-publication'
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import { PublishDialog, type PublicationInitialSelection, type PublicationSaveBridge } from '@/app/products/_publication/dialog/PublishDialog'
import { canonicalScope, listedAliases, listedDestinationKeys, sheetDestinationScope, type ListedDestinations } from '@/app/products/_publication/dialog/destinations'
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
 *
 * Aliases (Owner 2026-10-05: "I should be able to publish the aliases as well … I do not want to do anything in the
 * address bar"): the same read names the family's listing aliases, so every window — the sheet's, a retry's, an Undo
 * review's — offers each alias after its market's main listing, and a listed alias starts ticked like a listed main
 * listing. The sheet's own listing is named by its ALIAS id (a `listing=` ChannelListing id in the address never makes a
 * second destination), and never replaces its market's main listing.
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
  const familyId = product.parentId ?? product.id
  const read = useFamilyListings(product.id)
  const aliasKey = studio.destination.status === 'ready' ? studio.destination.data.aliasKey : undefined
  const current = useMemo<StudioPublishScope | undefined>(() => sheetDestinationScope(studio.scope, studio.market, studio.accountId, studio.listingId, aliasKey, read.cells),
    [studio.scope, studio.market, studio.accountId, studio.listingId, aliasKey, read.cells])
  // A retry's listing may be named by its ChannelListing id: it waits for the read, then becomes its alias id.
  const holding = !!initialDestination?.listingId && read.loading
  const initial = useMemo(() => {
    if (holding) return undefined
    const asked = initialDestination ?? current
    return asked && read.cells ? canonicalScope(asked, read.cells) : asked
  }, [initialDestination, current, holding, read.cells])
  const aliases = useMemo(() => (read.cells ? listedAliases(read.cells, familyId) : []), [read.cells, familyId])
  const destinations = useMemo(() => publicationDestinations(studio.marketplaces, initial, aliases), [studio.marketplaces, initial, aliases])
  const initialDestinations = useMemo(() => (initial ? [initial] : []), [initial])
  const save = useMemo<PublicationSaveBridge>(() => ({
    state,
    prepare: () => preparePublication(canChangeEditor),
    blocker: () => publicationBlocker(canChangeEditor),
  }), [state, preparePublication, publicationBlocker, canChangeEditor])
  const productIds = useMemo(() => [product.id], [product.id])
  const wanted = !initialDestination && !initialSelection
  const listed = useMemo<ListedDestinations | null>(() => {
    // The retry's own destination is still being read: the window says it is finding it.
    if (holding) return { keys: new Set(), loading: true }
    if (!wanted) return null
    if (read.loading) return { keys: new Set(), loading: true }
    if (!read.cells) return { keys: new Set(), loading: false, failed: true }
    return { keys: listedDestinationKeys(read.cells, familyId), loading: false, aliases }
  }, [holding, wanted, read.loading, read.cells, familyId, aliases])
  return <PublishDialog productIds={productIds} productLabel={product.sku} destinations={destinations} initialDestinations={initialDestinations}
    initialSelection={initialSelection} save={save} discoveryFailed={discoveryFailed} listed={listed} onClose={onClose} />
}

/**
 * Every listing of the family (the Status and Action read with no filter, no channel call), read once when the window
 * opens: where the family is listed, and its listing aliases with their names and places. Null cells when it failed.
 */
function useFamilyListings(productId: string): { cells: PublishActionCell[] | null; loading: boolean } {
  const [read, setRead] = useState<{ productId: string; cells: PublishActionCell[] | null } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    readPublishActions(productId, {}, controller.signal)
      .then(result => { if (!controller.signal.aborted) setRead({ productId, cells: result.rows }) })
      .catch(() => { if (!controller.signal.aborted) setRead({ productId, cells: null }) })
    return () => controller.abort()
  }, [productId])
  return read?.productId === productId ? { cells: read.cells, loading: false } : { cells: null, loading: true }
}
