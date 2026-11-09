/**
 * `GarmentZoneMap`'s words (B-W2b-207). English by default; a host passes the words it translates. The zones' own names
 * are not here: the app passes them with the zones (`zones`), in the page's language.
 */
export interface GarmentZoneMapLabels {
  /** The words under the map for the picked zone: "Zone: Chest". */
  picked: (zone: string) => string
  /** The words under the map when no zone is picked. */
  nonePicked: string
  /** Before the chips of the zones with no place on the sketch (the lining). */
  elsewhere: string
  /** The list's name ("Or pick from the list"). */
  list: string
  /** The list's empty choice. */
  none: string
  /** The button that clears the pick. */
  clear: string
  /** Why Clear is held when nothing is picked. */
  nothingToClear: string
  /** The hint under an editable map (how the keyboard walks it). */
  hint: string
  /** Each figure's caption, by its id (the rider garment's: front, back, trousers). An unknown figure shows its id. */
  figures: Readonly<Record<string, string>>
  /** The marks list's name (a heat map's "Defects by zone", a risk assessment's "Hazards by zone"). */
  marks: string
  /** The marks list's zone column. */
  marksZone: string
  /** The marks list's value column. */
  marksValue: string
  /** A marked zone said whole, for a screen reader and the shape's tooltip: "Chest: 4". */
  marked: (zone: string, words: string) => string
}

export const GARMENT_ZONE_MAP_LABELS: GarmentZoneMapLabels = {
  picked: (zone) => `Zone: ${zone}`,
  nonePicked: 'No zone picked',
  elsewhere: 'Not on the sketch:',
  list: 'Or pick from the list',
  none: 'No zone',
  clear: 'Clear the zone',
  nothingToClear: 'No zone is picked.',
  hint: "Tap a zone; on the keyboard the arrows move between zones and Enter picks. Left and right are the wearer's.",
  figures: { front: 'Jacket, front', back: 'Jacket, back', trousers: 'Trousers, front' },
  marks: 'Marked zones',
  marksZone: 'Zone',
  marksValue: 'Value',
  marked: (zone, words) => (words ? `${zone}: ${words}` : zone),
}
