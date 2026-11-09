'use client'

import { useMemo } from 'react'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { GarmentZoneMap as ZoneMapPart, type GarmentZoneMapProps as PartProps } from '@nexus/ui/components/GarmentZoneMap/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { zoneWords } from './zones'

export { zoneWords } from './zones'

/** The quality screens' props: the zones (factory-domain GARMENT_ZONES) and the words are bound here. */
export type GarmentZoneMapProps = Omit<PartProps, 'zones' | 'labels'>

/**
 * GarmentZoneMap — the DS part (`@nexus/ui/components/GarmentZoneMap`, B-W2b-207; it moved there from this folder) with the
 * factory's zones (GARMENT_ZONES, in the person's language) and the `ds-words` catalogue's words, so the quality screens
 * keep calling it as before.
 */
export function GarmentZoneMap(props: GarmentZoneMapProps) {
  const locale = useLocale()
  const words = useDsWords()
  const zones = useMemo(() => GARMENT_ZONES.map((zone) => ({ id: zone.id, label: zoneWords(zone.id, locale) })), [locale])
  return <ZoneMapPart {...props} zones={zones} labels={words.garmentZoneMap} />
}
