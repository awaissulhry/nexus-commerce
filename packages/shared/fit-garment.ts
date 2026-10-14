/**
 * Garment measurements — the finished garment's measurements per size, in cm, ONE table per product
 * (`Product.fitGarment`). The Owner types them in the product sheet; shoppers never see them. The size finder of the
 * store theme reads them (sent later as the Shopify product metafield `xavia.fit_garment`, JSON) to check how much room
 * a size leaves around a shopper's body.
 *
 * PURE: the API's door (`bulk-edit.service.ts`, the catalogue import) and the sheet's editor ask the same rules, so the
 * editor shows exactly the sentences the save would answer.
 *
 * The stored shape (canonical — it is also what the store receives, so keep it this shape):
 *
 *     { "measures": ["chest", "waist", "sleeve"],
 *       "sizes": [{ "name": "M", "chest": 106, "waist": 94, "sleeve": 62.5 }],
 *       "flat": ["chest"],                 ← optional: typed as the flat (half) width; the numbers stay FULL
 *       "room": { "chest": [6, 16] } }     ← optional: the least and most room for a good fit, cm
 *
 *   measures  an ordered subset of FIT_MEASURES. Circumferences (chest, waist, hips, neck, thigh, calf) are the FULL
 *             way round; sleeve is shoulder seam to cuff; inseam is crotch seam to hem.
 *   sizes     1 to 30 rows. `name` is 1–12 characters, unique ignoring case. Each listed measure is a number of cm,
 *             above 0, at most 250, at most one decimal — or missing (an empty cell). A row with no values is dropped.
 *   flat      circumference measures the operator typed as the flat (half) width. The stored numbers are always the
 *             full circumference: the editor doubles a typed flat value when saving and halves it for display.
 *   room      per measure [least, most] in cm, least below most, each from −20 to 60, at most one decimal.
 *
 * Normalising: no value anywhere → `null` (the field is cleared). A measure with no value in any size is left out, and
 * so are its `flat` and `room` entries; an empty `flat` or `room` is left out. Numbers may arrive as text ("62,5" or
 * "62.5"); they are stored as numbers.
 */

/** Every measure the table may hold, in the order the editor offers them. */
export const FIT_MEASURES = ['chest', 'waist', 'hips', 'neck', 'thigh', 'calf', 'sleeve', 'inseam'] as const
export type FitMeasure = (typeof FIT_MEASURES)[number]

/** The measures taken the full way round the garment — the only ones that may be measured flat (half). */
export const FIT_CIRCUMFERENCES: readonly FitMeasure[] = ['chest', 'waist', 'hips', 'neck', 'thigh', 'calf']

/** Each measure's plain name, as the operator reads it. */
export const FIT_MEASURE_LABELS: Readonly<Record<FitMeasure, string>> = {
  chest: 'Chest',
  waist: 'Waist',
  hips: 'Hips',
  neck: 'Neck',
  thigh: 'Thigh',
  calf: 'Calf',
  sleeve: 'Sleeve length',
  inseam: 'Inside leg',
}

export const FIT_SIZES_MAX = 30
export const FIT_SIZE_NAME_MAX = 12
export const FIT_VALUE_MAX = 250
export const FIT_ROOM_MIN = -20
export const FIT_ROOM_MAX = 60

/** One size row: its name, and a number of cm per measure it has a value for. */
export type FitSize = { name: string } & Partial<Record<FitMeasure, number>>

export interface FitGarment {
  measures: FitMeasure[]
  sizes: FitSize[]
  flat?: FitMeasure[]
  room?: Partial<Record<FitMeasure, [number, number]>>
}

/** Thrown by `normalizeFitGarment`: every reason the table cannot be saved, one sentence each. */
export class FitGarmentError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(problems.join(' '))
    this.name = 'FitGarmentError'
    this.problems = problems
  }
}

const isMeasure = (key: unknown): key is FitMeasure => typeof key === 'string' && (FIT_MEASURES as readonly string[]).includes(key)
const isCircumference = (key: FitMeasure) => FIT_CIRCUMFERENCES.includes(key)
const label = (key: FitMeasure) => FIT_MEASURE_LABELS[key]
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** A number of cm from a number or its text ("62,5" and "62.5" alike); `undefined` = empty; `NaN` = not a number. */
export function fitNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : Number.NaN
  if (typeof raw !== 'string') return Number.NaN
  const text = raw.trim().replace(',', '.')
  if (text === '') return undefined
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : Number.NaN
}

const oneDecimal = (value: number) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-6
const tidy = (value: number) => Math.round(value * 10) / 10
const shown = (raw: unknown) => (typeof raw === 'string' ? `"${raw.trim()}"` : String(raw))

/**
 * The table as stored and every reason it cannot be: `problems: []` = it can be saved, and `value` is what to store
 * (`null` = nothing to keep: the field is cleared).
 */
export function readFitGarment(input: unknown): { value: FitGarment | null; problems: string[] } {
  let raw = input
  if (raw === null || raw === undefined) return { value: null, problems: [] }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return { value: null, problems: [] }
    try { raw = JSON.parse(text) } catch { return { value: null, problems: ['Garment measurements must be a table of sizes and measures.'] } }
  }
  if (!isRecord(raw)) return { value: null, problems: ['Garment measurements must be a table of sizes and measures.'] }

  const problems: string[] = []
  for (const key of Object.keys(raw)) {
    if (!['measures', 'sizes', 'flat', 'room'].includes(key)) problems.push(`"${key}" is not part of a garment measurements table (it has measures, sizes, flat and room).`)
  }

  // ── measures ──
  const measures: FitMeasure[] = []
  const measuresRaw = raw.measures ?? []
  if (!Array.isArray(measuresRaw)) problems.push('The measures must be a list.')
  else {
    for (const key of measuresRaw) {
      if (!isMeasure(key)) problems.push(`"${String(key)}" is not a measure Nexus knows. Use ${FIT_MEASURES.join(', ')}.`)
      else if (measures.includes(key)) problems.push(`${label(key)} is listed twice.`)
      else measures.push(key)
    }
  }

  // ── sizes ──
  const sizes: FitSize[] = []
  const sizesRaw = raw.sizes ?? []
  if (!Array.isArray(sizesRaw)) problems.push('The sizes must be a list of rows.')
  else {
    const seen = new Map<string, string>()
    sizesRaw.forEach((rowRaw, index) => {
      if (!isRecord(rowRaw)) { problems.push(`Row ${index + 1} is not a size row.`); return }
      const name = typeof rowRaw.name === 'string' ? rowRaw.name.trim() : rowRaw.name == null ? '' : String(rowRaw.name).trim()
      const where = name ? `Size ${name}` : `Row ${index + 1}`
      const row: FitSize = { name }
      let values = 0
      for (const [key, cell] of Object.entries(rowRaw)) {
        if (key === 'name') continue
        if (!isMeasure(key)) { problems.push(`${where}: "${key}" is not a measure Nexus knows.`); continue }
        const value = fitNumber(cell)
        if (value === undefined) continue
        if (!measures.includes(key)) { problems.push(`${where} has a value for ${label(key)}, which is not one of the measures.`); continue }
        if (Number.isNaN(value)) { problems.push(`${where}, ${label(key)}: ${shown(cell)} is not a number.`); continue }
        if (value <= 0 || value > FIT_VALUE_MAX) { problems.push(`${where}, ${label(key)}: ${value} cm must be above 0 and at most ${FIT_VALUE_MAX}.`); continue }
        if (!oneDecimal(value)) { problems.push(`${where}, ${label(key)}: ${value} cm may have at most one decimal.`); continue }
        row[key] = tidy(value)
        values++
      }
      if (!values) return // a row with no values is dropped, named or not
      if (!name) { problems.push(`Row ${index + 1} has measurements but no size name.`); return }
      if (name.length > FIT_SIZE_NAME_MAX) problems.push(`Size "${name}" is longer than ${FIT_SIZE_NAME_MAX} characters.`)
      const folded = name.toLocaleLowerCase()
      const first = seen.get(folded)
      if (first !== undefined) problems.push(first === name ? `Size ${name} is listed twice.` : `Sizes ${first} and ${name} are the same size name.`)
      else seen.set(folded, name)
      // The canonical key order: name, then the measures in their order.
      const ordered: FitSize = { name }
      for (const key of measures) if (row[key] !== undefined) ordered[key] = row[key]
      sizes.push(ordered)
    })
  }
  if (sizes.length > FIT_SIZES_MAX) problems.push(`A table holds at most ${FIT_SIZES_MAX} sizes; this one has ${sizes.length}.`)

  // ── flat ──
  const flat: FitMeasure[] = []
  if (raw.flat !== undefined && raw.flat !== null) {
    if (!Array.isArray(raw.flat)) problems.push('The flat measures must be a list.')
    else {
      for (const key of raw.flat) {
        if (!isMeasure(key)) problems.push(`"${String(key)}" is not a measure Nexus knows, so it cannot be measured flat.`)
        else if (!isCircumference(key)) problems.push(`${label(key)} is a length, not a width round the body: it cannot be measured flat.`)
        else if (!measures.includes(key)) problems.push(`${label(key)} is measured flat but is not one of the measures.`)
        else if (!flat.includes(key)) flat.push(key)
      }
    }
  }

  // ── room ──
  const room: Partial<Record<FitMeasure, [number, number]>> = {}
  if (raw.room !== undefined && raw.room !== null) {
    if (!isRecord(raw.room)) problems.push('The room for a good fit must give a least and a most per measure.')
    else {
      for (const [key, pair] of Object.entries(raw.room)) {
        if (!isMeasure(key)) { problems.push(`"${key}" is not a measure Nexus knows, so it has no room for a good fit.`); continue }
        if (!measures.includes(key)) { problems.push(`${label(key)} has room for a good fit but is not one of the measures.`); continue }
        if (!Array.isArray(pair) || pair.length !== 2) { problems.push(`${label(key)}: the room for a good fit is a least and a most.`); continue }
        const least = fitNumber(pair[0]), most = fitNumber(pair[1])
        if (least === undefined && most === undefined) continue
        if (least === undefined || most === undefined) { problems.push(`${label(key)}: give both the least and the most room, or neither.`); continue }
        if (Number.isNaN(least) || Number.isNaN(most)) { problems.push(`${label(key)}: the room for a good fit must be numbers.`); continue }
        if ([least, most].some((v) => v < FIT_ROOM_MIN || v > FIT_ROOM_MAX)) { problems.push(`${label(key)}: the room for a good fit must be from ${FIT_ROOM_MIN} to ${FIT_ROOM_MAX} cm.`); continue }
        if (!oneDecimal(least) || !oneDecimal(most)) { problems.push(`${label(key)}: the room for a good fit may have at most one decimal.`); continue }
        if (!(least < most)) { problems.push(`${label(key)}: the least room (${least}) must be below the most (${most}).`); continue }
        room[key] = [tidy(least), tidy(most)]
      }
    }
  }

  if (problems.length) return { value: null, problems }
  if (!sizes.length) return { value: null, problems: [] }

  // A measure no size has a value for is left out, with its flat and room entries.
  const used = measures.filter((key) => sizes.some((size) => size[key] !== undefined))
  const value: FitGarment = { measures: used, sizes }
  const keptFlat = flat.filter((key) => used.includes(key))
  if (keptFlat.length) value.flat = keptFlat
  const keptRoom = Object.fromEntries(used.filter((key) => room[key]).map((key) => [key, room[key]!])) as FitGarment['room']
  if (keptRoom && Object.keys(keptRoom).length) value.room = keptRoom
  return { value, problems: [] }
}

/** Every reason this table cannot be saved, one sentence each; `[]` = it can be saved. */
export function fitGarmentProblems(input: unknown): string[] {
  return readFitGarment(input).problems
}

/**
 * THE rule: the table as it is stored, or `null` when there is nothing to keep (the field is cleared). Throws a
 * `FitGarmentError` naming every problem when the table cannot be saved.
 */
export function normalizeFitGarment(input: unknown): FitGarment | null {
  const { value, problems } = readFitGarment(input)
  if (problems.length) throw new FitGarmentError(problems)
  return value
}

/** The sheet cell's words: "6 sizes · chest, waist, sleeve length", or '' when the table is empty or unreadable. */
export function fitGarmentSummary(input: unknown): string {
  const { value } = readFitGarment(input)
  if (!value) return ''
  const sizes = `${value.sizes.length} ${value.sizes.length === 1 ? 'size' : 'sizes'}`
  return value.measures.length ? `${sizes} · ${value.measures.map((key) => label(key).toLocaleLowerCase()).join(', ')}` : sizes
}
