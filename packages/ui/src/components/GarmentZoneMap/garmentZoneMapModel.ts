/**
 * GarmentZoneMap's sketch and rules (B-W2b-207; moved from the factory's quality area, where B-W2a-67 built it), pure:
 * the rider garment's three figures — the jacket's front, its back, the trousers' front — each zone drawn once as its own
 * pressable region (a few zones repeat on a second shape: both cuffs, the back of the sleeves, the trousers' waistband:
 * those copies take the click but are not focusable), and the rules the part draws by. The zone ids are the app's (the
 * factory keeps them in factory-domain `GARMENT_ZONES`); the words come from the app too (`zones` on the part).
 * Left and right are the WEARER's: on a front view the wearer's left is on the picture's right.
 */

/** A figure of the sketch: the rider garment has `front`, `back` and `trousers`; another sketch names its own. */
export type GarmentFigure = string

export interface GarmentZoneShape {
  /** The zone id this region belongs to. */
  readonly zone: string
  readonly figure: GarmentFigure
  /** An SVG polygon (`points`) in the figure's 120 × 150 box. */
  readonly points: string
  /** The first shape of a zone is its pressable region; a copy only takes the click. */
  readonly copy?: boolean
}

/** A zone as the part lists it: its id and its words in the page's language. */
export interface GarmentZoneOption {
  readonly id: string
  readonly label: string
}

/**
 * A mark on a zone (a heat map: defects found there; a risk assessment: the hazards it controls). `value` sets how strong
 * the zone is drawn (relative to the biggest value; four steps) and is written; `text` is written instead when given.
 */
export interface GarmentZoneMark {
  readonly zone: string
  readonly value?: number | null
  readonly text?: string | null
}

/** The rider garment's figures, in drawing order. */
export const RIDER_GARMENT_FIGURES: readonly GarmentFigure[] = ['front', 'back', 'trousers']

const rect = (x1: number, y1: number, x2: number, y2: number): string => `${x1},${y1} ${x2},${y1} ${x2},${y2} ${x1},${y2}`

/**
 * The rider garment (EN 17092's impact zones, the seams, the label), in painter's order: a later shape lies over an
 * earlier one (the zip over the chest, the pockets over the front, the back protector over the back, the elbows and knees
 * over their sleeve and leg). The ids are the factory's `GARMENT_ZONES` ids; LINING has no place on a sketch.
 */
export const RIDER_GARMENT_SHAPES: readonly GarmentZoneShape[] = [
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

/** The zones with no place on the sketch (drawn as chips under it), in the zones' order. */
export function offSketch(zoneIds: readonly string[], shapes: readonly GarmentZoneShape[] = RIDER_GARMENT_SHAPES): string[] {
  return zoneIds.filter((id) => !shapes.some((shape) => shape.zone === id))
}

/** Each zone's pressable region (its first shape that is not a copy), in the zones' order (the order the arrows walk). */
export function primaryShapes(zoneIds: readonly string[], shapes: readonly GarmentZoneShape[] = RIDER_GARMENT_SHAPES): GarmentZoneShape[] {
  return zoneIds.flatMap((id) => {
    const shape = shapes.find((entry) => entry.zone === id && !entry.copy)
    return shape ? [shape] : []
  })
}

/** The middle of a polygon (where the pin goes). */
export function centreOf(points: string): { x: number; y: number } {
  const pairs = points
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number) as [number, number])
  const xs = pairs.map(([x]) => x)
  const ys = pairs.map(([, y]) => y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

/** The figure that shows a zone first (where the pin of a picked zone stands); null for a zone off the sketch. */
export function figureOf(zoneId: string | null | undefined, shapes: readonly GarmentZoneShape[] = RIDER_GARMENT_SHAPES): GarmentFigure | null {
  if (!zoneId) return null
  return shapes.find((shape) => shape.zone === zoneId && !shape.copy)?.figure ?? null
}

/** The zone after or before this one: the arrows walk every zone, sketch and chips, in the zones' order, round the end. */
export function stepZone(zoneIds: readonly string[], current: string | null | undefined, delta: 1 | -1): string | null {
  if (zoneIds.length === 0) return null
  const index = current ? zoneIds.indexOf(current) : -1
  const next = index < 0 ? (delta === 1 ? 0 : zoneIds.length - 1) : (index + delta + zoneIds.length) % zoneIds.length
  return zoneIds[next] ?? null
}

/** A zone's words from the list; an unknown id as it is; nothing for no zone. */
export function zoneLabel(zones: readonly GarmentZoneOption[], zoneId: string | null | undefined): string {
  if (!zoneId) return ''
  return zones.find((zone) => zone.id === zoneId)?.label ?? zoneId
}

export interface GarmentZoneMarkView {
  readonly zone: string
  readonly label: string
  /** 1 (light) … 4 (strongest): the value against the biggest value; a mark without a value is 2. */
  readonly level: 1 | 2 | 3 | 4
  /** What is written for it: `text`, else the value as given to `format`, else nothing. */
  readonly words: string
  /** What the sketch writes on the zone: the value (a number fits a zone); a text mark is said by the table only. */
  readonly badge: string
  readonly value: number | null
}

/**
 * The marks as the part draws them: one per zone (a zone marked twice keeps its biggest value and its first text), the
 * level of each, biggest first (then the zones' order). A value of 0 or below is not a mark.
 */
export function zoneMarkViews(
  marks: readonly GarmentZoneMark[] | null | undefined,
  zones: readonly GarmentZoneOption[],
  format: (value: number) => string = String,
): GarmentZoneMarkView[] {
  if (!marks?.length) return []
  const byZone = new Map<string, { value: number | null; text: string | null }>()
  for (const mark of marks) {
    const value = typeof mark.value === 'number' && Number.isFinite(mark.value) ? mark.value : null
    if (value !== null && value <= 0 && !mark.text) continue
    const seen = byZone.get(mark.zone)
    if (!seen) byZone.set(mark.zone, { value, text: mark.text ?? null })
    else byZone.set(mark.zone, { value: value === null ? seen.value : Math.max(seen.value ?? value, value), text: seen.text ?? mark.text ?? null })
  }
  const max = Math.max(0, ...[...byZone.values()].map((entry) => entry.value ?? 0))
  const order = (id: string) => {
    const at = zones.findIndex((zone) => zone.id === id)
    return at < 0 ? zones.length : at
  }
  return [...byZone.entries()]
    .map(([zone, entry]) => {
      const level = (entry.value === null || max === 0 ? 2 : Math.min(4, Math.max(1, Math.ceil((entry.value / max) * 4)))) as 1 | 2 | 3 | 4
      const number = entry.value === null ? '' : format(entry.value)
      return { zone, label: zoneLabel(zones, zone), level, words: entry.text ?? number, badge: number, value: entry.value }
    })
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || order(a.zone) - order(b.zone))
}
