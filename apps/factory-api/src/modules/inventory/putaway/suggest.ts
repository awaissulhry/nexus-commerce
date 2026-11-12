import { suggestPlace, type SuggestionReason } from '@nexus/factory-domain/inventory/putaway/rules'
import type { HeldItemKind } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { readSiteStock, type Reader } from '../issue/store'
import { defaultPlaceFor } from '../locations-depth/defaults'
import { placesById } from '../bin-moves/hand'

/**
 * The suggested place of a put-away (B-W2b-292; SCM-202; factory-domain inventory/putaway rules suggestPlace): for goods not
 * released the site's quality place (its QUALITY default, else its only quarantine place); else the site's PUT_AWAY default
 * for the item's kind (B-W2b-289 defaultPlaceFor), else where the same lot lies. Read as the caller (a tablet at its site, or
 * the system for a task's source). The bin scanned confirms where it goes; the suggestion is only a suggestion.
 */
export async function suggestedPlace(
  db: Reader,
  ask: { readonly siteId: string; readonly itemId: string; readonly itemKind: string; readonly lotId: string | null; readonly fromId: string; readonly released: boolean },
): Promise<{ readonly location: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string }; readonly why: SuggestionReason } | null> {
  let qualityPlace: { id: string; code: string } | null = null
  if (!ask.released) {
    qualityPlace = await defaultPlaceFor(db, { siteId: ask.siteId, purpose: 'QUALITY' })
    if (!qualityPlace) {
      const places = await db.location.findMany({ where: { siteId: ask.siteId, kind: 'QUARANTINE', status: 'ACTIVE' }, select: { id: true, code: true }, take: 2, orderBy: { code: 'asc' } })
      qualityPlace = places.length === 1 ? places[0]! : null
    }
  }
  const defaultPlace = ask.released ? await defaultPlaceFor(db, { siteId: ask.siteId, purpose: 'PUT_AWAY', itemKinds: [ask.itemKind as HeldItemKind] }) : null
  const lotStock = ask.released && !defaultPlace && ask.lotId ? await readSiteStock(db, ask.siteId, { itemIds: [ask.itemId], lotId: ask.lotId }) : []
  const lotPlaces = await placesById(db, lotStock.map((row) => row.locationId))
  // A lot tracked hide by hide lies hide by hide: what each place holds of it, summed.
  const byPlace = new Map<string, { id: string; code: string; kind: string; onHand: Decimal }>()
  for (const row of lotStock) {
    const place = lotPlaces.get(row.locationId)
    if (!place || place.status !== 'ACTIVE') continue
    const entry = byPlace.get(place.id)
    if (entry) entry.onHand = entry.onHand.plus(row.onHand)
    else byPlace.set(place.id, { id: place.id, code: place.code, kind: place.kind, onHand: new Dec(row.onHand) })
  }
  const sameLot = [...byPlace.values()]
  const found = suggestPlace({ fromId: ask.fromId, released: ask.released, qualityPlace, defaultPlace, sameLot })
  if (!found) return null
  const place = (await placesById(db, [found.location.id])).get(found.location.id)
  return place ? { location: { id: place.id, code: place.code, name: place.name, kind: place.kind }, why: found.why } : null
}
