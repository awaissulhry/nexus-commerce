'use client'

import type { ChannelMediaLayout } from '@nexus/shared/media-plan-channels'

import { AliasMark, FilterChip } from '@/design-system/primitives'

import { checkCounts, destinationCells, destinationLabel, destinationNameParts, siblingListings, type MediaDestinationRow, type MediaRead } from './model'
import styles from './planPage.module.css'

export interface ListingChipsProps {
  read: MediaRead
  /** The listing the page shows. */
  destination: MediaDestinationRow
  layouts: Record<string, ChannelMediaLayout>
  onPick(d: MediaDestinationRow): void
}

/**
 * Aliases on the Media page (2026-09-29; Owner: "we have, for the gale jacket on eBay, at least 3 to 4 listings we
 * manage from the same page"): one chip per listing of the chosen account and market — ★ Main listing, ① ② ③ … — each
 * saying whether it has its own photos and what its checks found. One click shows that listing's photos (the scope
 * selector's listing, as on the Information page). Nothing when the market holds one listing.
 */
export function ListingChips({ read, destination: d, layouts, onPick }: ListingChipsProps) {
  const listings = siblingListings(read, d)
  if (listings.length < 2) return null
  const { head } = destinationNameParts(d)
  return <div className={styles.listingChips} role="group" aria-label={`Listings on ${head}`}>
    {listings.map(x => {
      const { errors, warnings } = checkCounts(layouts[x.key]?.checks ?? [])
      const own = x.targetable && destinationCells(read, x).some(c => c.source === 'own' || c.source === 'channel')
      const state = !x.targetable ? 'not sent' : own ? 'own photos' : 'shared'
      const checks = errors.length ? `${errors.length} to fix` : warnings.length ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : undefined
      return <FilterChip key={x.key} size="md" pressed={x.key === d.key} onClick={() => { if (x.key !== d.key) onPick(x) }} badge={checks}
        aria-label={`${destinationLabel(x)}: ${state}${checks ? `, ${checks}` : ''}`}>
        {x.listingMark != null && <AliasMark position={x.listingMark} />}
        <span>{destinationNameParts(x).name}</span>
        <span className={styles.chipState}>{state}</span>
      </FilterChip>
    })}
  </div>
}
