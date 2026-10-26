'use client'

import { PublishDialog } from './PublishDialog'
import { useBusinessDestinations } from './useBusinessDestinations'

/**
 * The products list's Publish dialog: the shared dialog in many-product mode, fed with the business's own markets and
 * connected accounts (the products list has no studio to borrow them from). The Listings window opens it on its own
 * destination (`initialKeys`).
 */
export function ProductsPublishDialog({ productIds, familyCount, initialKeys, onClose }: { productIds: string[]; familyCount: number; initialKeys?: readonly string[]; onClose(): void }) {
  const { destinations, loading, failed } = useBusinessDestinations(true)
  return <PublishDialog mode="many" productIds={productIds} familyCount={familyCount} destinations={destinations}
    loadingDestinations={loading} discoveryFailed={failed} initialKeys={initialKeys} onClose={onClose} />
}
