import { GARMENT_ZONES, isGarmentZone, type GarmentZone } from '@nexus/factory-domain/quality/defects/rules'

/**
 * The garment sketch of the GarmentZoneMap (design "GarmentZoneMap (new)": quality.defects df-drawer, quality.inspections
 * ins-defects), pure: three figures — the jacket's front, its back, the trousers' front — each zone of factory-domain's
 * GARMENT_ZONES drawn once as its own region (a few zones repeat on a second shape: both cuffs, the back of the sleeves,
 * the trousers' waistband: those copies are not focusable), and the zones without a place on a sketch (the lining) as
 * chips. Left and right are the WEARER's: on a front view the wearer's left is on the picture's right.
 */

export type Figure = 'front' | 'back' | 'trousers'

export interface ZoneShape {
  readonly zone: GarmentZone
  readonly figure: Figure
  /** An SVG polygon (`points`) in the figure's 120 × 150 box. */
  readonly points: string
  /** The first shape of a zone is its pressable region; a copy only takes the click. */
  readonly copy?: boolean
}

export const FIGURES: readonly Figure[] = ['front', 'back', 'trousers']

const rect = (x1: number, y1: number, x2: number, y2: number): string => `${x1},${y1} ${x2},${y1} ${x2},${y2} ${x1},${y2}`

/**
 * Painter's order: a later shape lies over an earlier one (the zip over the chest, the pockets over the front, the
 * back protector over the back, the elbows and knees over their sleeve and leg).
 */
export const ZONE_SHAPES: readonly ZoneShape[] = [
  // ---- jacket, front (the wearer's right on the picture's left) ----
  { zone: 'FRONT', figure: 'front', points: '32,32 88,32 90,124 30,124' },
  { zone: 'CHEST', figure: 'front', points: rect(33, 34, 87, 60) },
  { zone: 'POCKET', figure: 'front', points: rect(36, 84, 53, 99) },
  { zone: 'POCKET', figure: 'front', points: rect(67, 84, 84, 99), copy: true },
  { zone: 'WAIST', figure: 'front', points: rect(30, 112, 90, 126) },
  { zone: 'ZIP', figure: 'front', points: rect(57, 26, 63, 126) },
  { zone: 'COLLAR', figure: 'front', points: '46,8 74,8 78,20 60,30 42,20' },
  { zone: 'SHOULDER_R', figure: 'front', points: '24,22 44,18 46,32 28,36' },
  { zone: 'SHOULDER_L', figure: 'front', points: '96,22 76,18 74,32 92,36' },
  { zone: 'SLEEVE_R', figure: 'front', points: '24,24 30,36 26,96 12,96 14,40' },
  { zone: 'SLEEVE_L', figure: 'front', points: '96,24 90,36 94,96 108,96 106,40' },
  { zone: 'CUFF', figure: 'front', points: rect(12, 96, 26, 106) },
  { zone: 'CUFF', figure: 'front', points: rect(94, 96, 108, 106), copy: true },
  // ---- jacket, back (the wearer's left on the picture's left) ----
  { zone: 'BACK', figure: 'back', points: '32,32 88,32 90,126 30,126' },
  { zone: 'BACK_PROTECTOR', figure: 'back', points: rect(44, 40, 76, 98) },
  { zone: 'SHOULDER', figure: 'back', points: '24,22 46,12 74,12 96,22 92,34 28,34' },
  { zone: 'LABEL', figure: 'back', points: rect(54, 14, 66, 22) },
  { zone: 'SLEEVE_L', figure: 'back', points: '24,24 30,36 26,96 12,96 14,40', copy: true },
  { zone: 'SLEEVE_R', figure: 'back', points: '96,24 90,36 94,96 108,96 106,40', copy: true },
  { zone: 'ELBOW_L', figure: 'back', points: rect(14, 58, 28, 74) },
  { zone: 'ELBOW_R', figure: 'back', points: rect(92, 58, 106, 74) },
  { zone: 'CUFF', figure: 'back', points: rect(12, 96, 26, 106), copy: true },
  { zone: 'CUFF', figure: 'back', points: rect(94, 96, 108, 106), copy: true },
  // ---- trousers, front (the wearer's right on the picture's left) ----
  { zone: 'WAIST', figure: 'trousers', points: rect(28, 8, 92, 16), copy: true },
  { zone: 'HIP_R', figure: 'trousers', points: '28,16 60,16 60,40 30,44' },
  { zone: 'HIP_L', figure: 'trousers', points: '60,16 92,16 90,44 60,40' },
  { zone: 'SEAT', figure: 'trousers', points: '50,40 70,40 66,58 54,58' },
  { zone: 'LEG_R', figure: 'trousers', points: '30,44 54,58 56,142 34,142' },
  { zone: 'LEG_L', figure: 'trousers', points: '90,44 66,58 64,142 86,142' },
  { zone: 'KNEE_R', figure: 'trousers', points: rect(36, 82, 54, 100) },
  { zone: 'KNEE_L', figure: 'trousers', points: rect(66, 82, 84, 100) },
]

/** The zones with no place on a sketch: chips under it. */
export const OFF_SKETCH: readonly GarmentZone[] = GARMENT_ZONES.map((zone) => zone.id).filter((id) => !ZONE_SHAPES.some((shape) => shape.zone === id))

/** Each zone's pressable region (its first shape), in the order the arrows walk them (GARMENT_ZONES' order). */
export const PRIMARY_SHAPES: readonly ZoneShape[] = GARMENT_ZONES.flatMap((zone) => {
  const shape = ZONE_SHAPES.find((entry) => entry.zone === zone.id && !entry.copy)
  return shape ? [shape] : []
})

/** The zone's words in a language (Italian or English; another language: English); an unknown id as it is. */
export function zoneWords(zoneId: string | null | undefined, locale: string): string {
  if (!zoneId) return ''
  const zone = GARMENT_ZONES.find((entry) => entry.id === zoneId)
  if (!zone) return zoneId
  return locale === 'it' ? zone.it : zone.en
}

/** The middle of a polygon (where the pin goes). */
export function centreOf(points: string): { x: number; y: number } {
  const pairs = points.split(' ').map((pair) => pair.split(',').map(Number) as [number, number])
  const xs = pairs.map(([x]) => x)
  const ys = pairs.map(([, y]) => y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

/** The figure that shows a zone first (where the pin of a picked zone stands); null for a zone off the sketch. */
export function figureOf(zoneId: string | null): Figure | null {
  if (!zoneId) return null
  return ZONE_SHAPES.find((shape) => shape.zone === zoneId && !shape.copy)?.figure ?? null
}

/** The zone after or before this one (the arrows walk every zone, sketch and chips, in GARMENT_ZONES' order). */
export function stepZone(current: string | null, delta: 1 | -1): GarmentZone {
  const ids = GARMENT_ZONES.map((zone) => zone.id)
  const index = current && isGarmentZone(current) ? ids.indexOf(current) : -1
  const next = index < 0 ? (delta === 1 ? 0 : ids.length - 1) : (index + delta + ids.length) % ids.length
  return ids[next]!
}
