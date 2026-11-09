import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'

/**
 * A garment zone's words (factory-domain GARMENT_ZONES). The zone map itself — the rider sketch, its shapes and its
 * drawing — moved to the DS part `@nexus/ui/components/GarmentZoneMap` (B-W2b-207); `GarmentZoneMap.tsx` beside this file
 * binds it to these zones and words.
 */

/** The zone's words in a language (Italian or English; another language: English); an unknown id as it is. */
export function zoneWords(zoneId: string | null | undefined, locale: string): string {
  if (!zoneId) return ''
  const zone = GARMENT_ZONES.find((entry) => entry.id === zoneId)
  if (!zone) return zoneId
  return locale === 'it' ? zone.it : zone.en
}
