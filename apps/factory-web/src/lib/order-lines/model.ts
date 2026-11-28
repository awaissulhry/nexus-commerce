import type { CustomLineFields, DraftChoice, DraftRequest } from '../order-draft/schema'
import { draftFilesOf, linesInOrder } from '../order-draft/model'
import { NO_OWN_COLUMNS, type OwnColumn, type OwnValue, type RecordOwnColumns, type RemovedLine } from './schema'

/**
 * owb-po3.2 (design § 5zi B, § 5j; prototype oplus.js `modelOptions`, `modelOf`, `newLine`; portal.js `composeWin` rows) — the ONE lines
 * table, pure: its row (door-neutral, NEVER a price), its modes, the model choices, what a new line takes from the line above, the
 * price hint (only for a host that passes money), and the adapter from a draft's record. S2 builds its rows from an order the same
 * way (its own adapter) and mounts the same table. No React, no API.
 */

/** What the table may do: a draft saves · a sent order reads (it says why) · a confirmed order makes an ASK of what is typed · shipped reads. */
export const LINE_MODES = ['draft', 'sent', 'confirmed', 'shipped'] as const
export type LinesMode = (typeof LINE_MODES)[number]

/** Your designs · The factory's range · A new design · "As in my message". */
export type LineModelKind = 'OWN' | 'RANGE' | 'NEW' | 'TEXT'

/** A model picked in the Model cell. */
export type ModelChoice = { readonly kind: 'STYLE'; readonly styleId: string } | { readonly kind: 'NEW'; readonly garmentType: string } | { readonly kind: 'TEXT' }

/** A style the Model cell offers (the customer's catalogue: its own label = Your designs, else The factory's range). */
export interface ModelStyle {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly ownLabel: boolean
  /** Its colourways (the Material of a line with this style); absent: not known. */
  readonly colours?: readonly { readonly id: string; readonly name: string }[]
}
/** A kind of new design (race suit, jacket…): code + its words in the page's language. */
export interface NewDesignKind {
  readonly code: string
  readonly words: string
}

/** The option values of the Model select: `style:<id>` · `new:<code>` · `text` · '' (not chosen yet). */
export const modelValueOf = (choice: ModelChoice | null): string => (choice === null ? '' : choice.kind === 'STYLE' ? `style:${choice.styleId}` : choice.kind === 'NEW' ? `new:${choice.garmentType}` : 'text')
export function modelChoiceOf(value: string): ModelChoice | null {
  if (value.startsWith('style:') && value.length > 6) return { kind: 'STYLE', styleId: value.slice(6) }
  if (value.startsWith('new:') && value.length > 4) return { kind: 'NEW', garmentType: value.slice(4) }
  return value === 'text' ? { kind: 'TEXT' } : null
}

export interface ModelGroup {
  readonly kind: LineModelKind
  /** The group's word key ("Your designs"). */
  readonly key: string
  readonly options: readonly { readonly value: string; readonly words: string }[]
}

/** The Model select's groups, in the design's order: Your designs · The factory's range · A new design · As in my message. Empty groups go. */
export function modelGroupsOf(styles: readonly ModelStyle[], kinds: readonly NewDesignKind[]): ModelGroup[] {
  const style = (entry: ModelStyle) => ({ value: modelValueOf({ kind: 'STYLE', styleId: entry.id }), words: entry.name.trim() || entry.code })
  const groups: ModelGroup[] = [
    { kind: 'OWN', key: 'model.group.own', options: styles.filter((entry) => entry.ownLabel).map(style) },
    { kind: 'RANGE', key: 'model.group.range', options: styles.filter((entry) => !entry.ownLabel).map(style) },
    { kind: 'NEW', key: 'model.group.new', options: kinds.map((kind) => ({ value: modelValueOf({ kind: 'NEW', garmentType: kind.code }), words: kind.words })) },
    { kind: 'TEXT', key: 'model.group.text', options: [{ value: 'text', words: '' }] },
  ]
  return groups.filter((group) => group.options.length > 0)
}

/** How a line's Material is set: the style's colourway · the line's own "Material" option (od- choices) · not on this line. */
export type MaterialHow = 'COLOURWAY' | 'CHOICE' | 'NONE'
export interface LineMaterial {
  readonly how: MaterialHow
  /** Its words now (null: not decided yet). */
  readonly words: string | null
  /** The select's value now ('' = not decided yet): a colourway id, or the picked choice. */
  readonly value: string
  readonly options: readonly { readonly value: string; readonly words: string }[]
  /** CHOICE: the option's topic as the line holds it ("Material", "Leather"). */
  readonly topic: string | null
}

/** How the line's pieces are given (the Sizes cell says it; the Pieces cell takes a typed total only for TOTAL / NONE). */
export type SizesMode = 'NONE' | 'TOTAL' | 'SIZES' | 'PEOPLE' | 'MTM' | 'FILE'

/** ONE row of the table. No price, ever (money lives only in the host's `prices`). */
export interface LineRow {
  readonly id: string
  readonly seq: number
  readonly model: { readonly kind: LineModelKind | null; readonly value: string; readonly words: string | null; readonly styleId: string | null; readonly garmentType: string | null; readonly fixed: boolean }
  readonly material: LineMaterial
  readonly sizes: { readonly mode: SizesMode; readonly run: string | null; readonly people: number }
  /** The pieces (null: not given yet); `typed`: the cell takes a typed total (a line with a total or nothing yet). */
  readonly pieces: { readonly count: number | null; readonly typed: boolean }
  /** The line's own values: column id → value. */
  readonly own: Readonly<Record<string, OwnValue['value']>>
  /** The line's own value versions (a save sends the one it read). */
  readonly ownVersions: Readonly<Record<string, number>>
}

/** The host's money for the Your price column; null = the reader has no price grain: no column, no key, nothing. */
export interface LinePrices {
  readonly currency: string
  /** May the reader type their own price now (a draft, a price holder). */
  readonly edit: boolean
  /** Line id → today's list price (`list`, decimal string or null) and the customer's own price (`own`). */
  readonly byLine: Readonly<Record<string, { readonly list: string | null; readonly own: string | null }>>
}

/** The hint under Your price: "agreed € 45" (today's list price) · "choose the material" (the price depends on it) · "the factory answers". */
export type PriceHint = { readonly kind: 'AGREED'; readonly amount: string } | { readonly kind: 'MATERIAL' } | { readonly kind: 'FACTORY' }
export function priceHintOf(row: Pick<LineRow, 'model' | 'material'>, price: { readonly list: string | null } | undefined): PriceHint {
  if (price?.list) return { kind: 'AGREED', amount: price.list }
  if (row.model.styleId && row.material.how === 'COLOURWAY' && row.material.value === '') return { kind: 'MATERIAL' }
  return { kind: 'FACTORY' }
}

const MATERIAL_TOPIC = /^(material|materiale|materials|materiali|leather|pelle)$/i

/** The line's "Material" option (od- choices): the first whose topic names a material. */
export const materialChoiceOf = (choices: readonly DraftChoice[] | null | undefined): DraftChoice | null => (choices ?? []).find((choice) => MATERIAL_TOPIC.test(choice.topic.trim())) ?? null

function materialOf(input: { colourway: { id: string; name: string } | null; colours: readonly { id: string; name: string }[] | null; choices: readonly DraftChoice[] | null | undefined; serverWords?: string | null }): LineMaterial {
  if (input.colours && input.colours.length > 0) {
    return { how: 'COLOURWAY', words: input.colourway?.name ?? input.serverWords ?? null, value: input.colourway?.id ?? '', options: input.colours.map((colour) => ({ value: colour.id, words: colour.name })), topic: null }
  }
  const choice = materialChoiceOf(input.choices)
  if (choice) return { how: 'CHOICE', words: choice.picked ?? input.serverWords ?? null, value: choice.picked ?? '', options: choice.options.map((option) => ({ value: option, words: option })), topic: choice.topic }
  return { how: 'NONE', words: input.colourway?.name ?? input.serverWords ?? null, value: '', options: [], topic: null }
}

/** The draft record as the table reads it: the server's newer fields (owb-po1) read as optional. */
type DraftForLines = Pick<DraftRequest, 'lines' | 'files'> &
  Partial<Pick<DraftRequest, 'customLines'>> & {
    readonly ownColumns?: RecordOwnColumns
    readonly removedLines?: readonly RemovedLine[]
  }

/** The rows of a draft, in ONE order by seq (catalogue and the customer's own lines together; a row never jumps under the cursor). */
export function lineRowsOfDraft(request: DraftForLines, options: { readonly styles?: readonly ModelStyle[]; readonly kinds?: readonly NewDesignKind[] } = {}): LineRow[] {
  const styles = options.styles ?? []
  const kinds = options.kinds ?? []
  const own = request.ownColumns ?? NO_OWN_COLUMNS
  const sheets = draftFilesOf(request).sheets
  const valuesOf = (lineId: string) => {
    const line = own.values[lineId] ?? {}
    return {
      own: Object.fromEntries(Object.entries(line).map(([columnId, value]) => [columnId, value.value])),
      ownVersions: Object.fromEntries(Object.entries(line).map(([columnId, value]) => [columnId, value.version])),
    }
  }
  const kindOfStyle = (styleId: string | null): LineModelKind | null => (styleId ? (styles.find((entry) => entry.id === styleId)?.ownLabel === false ? 'RANGE' : 'OWN') : null)
  const rows: LineRow[] = []
  for (const line of linesInOrder(request.lines)) {
    const run = line.sizes.filter((row) => row.quantity > 0).map((row) => `${row.quantity} × ${row.size}`).join(' · ')
    rows.push({
      id: line.id,
      seq: line.seq,
      model: { kind: kindOfStyle(line.style.id), value: modelValueOf({ kind: 'STYLE', styleId: line.style.id }), words: line.style.name.trim() || line.style.code, styleId: line.style.id, garmentType: null, fixed: true },
      material: materialOf({ colourway: line.colourway, colours: line.colours, choices: line.choices, serverWords: (line as { material?: string | null }).material ?? null }),
      sizes: { mode: line.sizing === 'MADE_TO_MEASURE' ? 'MTM' : run !== '' ? 'SIZES' : 'NONE', run: run !== '' ? run : null, people: 0 },
      pieces: { count: line.pieces > 0 ? line.pieces : null, typed: false },
      ...valuesOf(line.id),
    })
  }
  for (const line of linesInOrder(request.customLines ?? [])) {
    const garment = line.garmentType?.code ?? null
    const kind: LineModelKind = line.style ? (kindOfStyle(line.style.id) ?? 'OWN') : garment ? 'NEW' : 'TEXT'
    const choice: ModelChoice = line.style ? { kind: 'STYLE', styleId: line.style.id } : garment ? { kind: 'NEW', garmentType: garment } : { kind: 'TEXT' }
    // A line in the customer's words with nothing chosen yet reads "Choose the model…" (nothing is chosen for you).
    const chosen = line.style !== null || garment !== null || (line.description !== null && line.description.trim() !== '')
    const style = line.style ? styles.find((entry) => entry.id === line.style!.id) : undefined
    const run = line.sizes.map((row) => `${row.quantity} × ${row.size}`).join(' · ')
    const hasSheet = sheets.some((file) => file.lineId === line.id)
    const mode: SizesMode = line.byPerson ? (line.sizing === 'MADE_TO_MEASURE' || line.kind === 'MADE_TO_MEASURE' ? 'MTM' : 'PEOPLE') : run !== '' ? 'SIZES' : hasSheet ? 'FILE' : line.quantity !== null ? 'TOTAL' : 'NONE'
    const kindWords = garment ? (kinds.find((entry) => entry.code === garment)?.words ?? line.garmentType?.words.en ?? garment) : null
    rows.push({
      id: line.id,
      seq: line.seq,
      model: {
        kind: chosen ? kind : null,
        value: chosen ? modelValueOf(choice) : '',
        words: line.style ? line.style.name.trim() || line.style.code : kindWords,
        styleId: line.style?.id ?? null,
        garmentType: garment,
        fixed: false,
      },
      material: materialOf({ colourway: line.colourway, colours: style?.colours ?? null, choices: line.choices, serverWords: (line as { material?: string | null }).material ?? null }),
      sizes: { mode, run: run !== '' ? run : null, people: line.people.length },
      pieces: { count: line.pieces > 0 ? line.pieces : line.quantity, typed: !line.byPerson && run === '' },
      ...valuesOf(line.id),
    })
  }
  return rows.sort((a, b) => a.seq - b.seq)
}

/** A new line takes the model and the material of the line above (design § 5zi B); the first line takes nothing ("Choose the model…"). */
export function nextLineFields(above: LineRow | undefined): CustomLineFields | null {
  if (!above || above.model.value === '') return null
  const fields: CustomLineFields = {}
  if (above.model.styleId) fields.styleId = above.model.styleId
  else if (above.model.garmentType) fields.garmentType = above.model.garmentType
  if (above.material.how === 'COLOURWAY' && above.material.value !== '' && above.model.styleId) fields.colourwayId = above.material.value
  if (above.material.how === 'CHOICE' && above.material.topic) fields.choices = [{ topic: above.material.topic, options: above.material.options.map((option) => option.value), picked: above.material.value === '' ? null : above.material.value }]
  return fields
}

/** What a model picked writes on a line in the customer's words (the others it clears: a style takes no garment type and back). */
export function modelFields(choice: ModelChoice): CustomLineFields {
  if (choice.kind === 'STYLE') return { styleId: choice.styleId, garmentType: null }
  if (choice.kind === 'NEW') return { garmentType: choice.garmentType, styleId: null, colourwayId: null }
  return { styleId: null, colourwayId: null, garmentType: null }
}

/** The pieces typed in a Pieces cell: a whole number 1–100 000, '' = not given yet; else a word key (refused on leaving). */
export function piecesTyped(text: string): { readonly count: number | null } | { readonly problem: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { count: null }
  if (!/^\d+$/.test(trimmed)) return { problem: 'pieces.refused' }
  const count = Number(trimmed)
  return count >= 1 && count <= 100_000 ? { count } : { problem: 'pieces.refused' }
}

/** Why the table writes nothing now, in its mode (a word key), or null (draft: it writes; confirmed with an ask door: it asks). */
export function modeHeldOf(mode: LinesMode, asks: boolean): string | null {
  if (mode === 'sent') return 'mode.sent'
  if (mode === 'shipped') return 'mode.shipped'
  if (mode === 'confirmed' && !asks) return 'mode.confirmed'
  return null
}

/** The columns the table draws after the fixed ones: the record's own columns in their order (closed ones it still uses stay). */
export const ownColumnsOfRecord = (own: RecordOwnColumns | undefined): readonly OwnColumn[] => (own ?? NO_OWN_COLUMNS).used

/** The sum of the pieces given (a line with none adds nothing). */
export const piecesOfRows = (rows: readonly Pick<LineRow, 'pieces'>[]): number => rows.reduce((sum, row) => sum + (row.pieces.count ?? 0), 0)
