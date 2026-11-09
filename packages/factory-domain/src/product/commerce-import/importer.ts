import { cell, foldWord, type CellValue } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { IMPORT_LIMITS } from '../../imports/job'
import { COLOURWAY_CODE, COLOURWAY_CODE_RULE } from '../styles/colourways'
import { PRODUCT_TYPES, STYLE_CODE, STYLE_CODE_RULE, type ProductType } from '../styles/rules'
import { parseGtin, SKU } from '../styles/sku'

/**
 * Start a style from a Nexus Commerce product (B-W2b-209; PRD-265; plan W2b-4, Owner answer 2026-11-09 Q4 = A): a
 * Commerce product export file (CSV or XLSX, the person downloads it from Commerce and uploads it here) makes DRAFT
 * styles through the imports registry, dry run first. Nothing is ever written to Commerce, and nothing reads it live
 * (./source: the switch is OFF). Pure: the columns, the per-row plan and the judgement of the families (`judgeFamilies`);
 * apps/factory-api's modules/product/commerce-import reads the facts and writes.
 *
 * One row per SKU, as Commerce exports a product family with its variants:
 *   sku         the SKU (the key): it becomes the factory SKU's code as it is, so the two systems name a garment alike
 *   family      the Parent SKU: the family the SKU belongs to; blank on the family's own row
 *   colour/size the variant's colour and size; both blank on the family's own row (its name, type, season, brand)
 *   gtin        the EAN-13 (any GTIN) of the SKU: kept on the factory SKU
 * Optional: the family's name (Family name), a Style code (default: the family's code), a Colour code (default: made
 * from the colour's name), the product type (from the category's words), the season, a private-label brand (W1's
 * Style.brandPartyId: a party with the BRAND role, by code or name) and the size scale (default: the one scale of the
 * job's company or of every company that holds every size of the family).
 *
 * A family becomes ONE style: its colours its colourways, its sizes the range (in the scale's order; no base size: the
 * person picks it), its SKUs the factory SKUs with their GTINs. The style is a DRAFT in the CONCEPT lifecycle (B-W2b-206)
 * with revision 1, a DRAFT whose change note names the family, not PPE until someone says so, not made to measure.
 * A family whose style exists (by code) takes its NEW colours, sizes and SKUs only while that style is a draft of its
 * company in CONCEPT or DEVELOPMENT; its own fields are never changed by an import. A family is started whole or not at
 * all: one problem refuses every new row of it, so no style is ever half made. A SKU the factory has already, on the
 * same style, colour and size, is UNCHANGED (a file imported again changes nothing); on another, an error.
 *
 * The whole sheet is judged at once (families can only be judged whole): at most COMMERCE_IMPORT_LIMITS.rows rows, the
 * dry run's one batch, and the apply is ONE batch (one command). A bigger export is split by family.
 */

export const COMMERCE_IMPORTER_KEY = 'product.commerceStyles'

export const COMMERCE_IMPORT_LIMITS = Object.freeze({
  /** One sheet is judged as one batch: the dry run's batch size. */
  rows: IMPORT_LIMITS.planBatchSize,
})

/** The lifecycles in which an existing style still takes new colours, sizes and SKUs from a Commerce file. */
export const OPEN_LIFECYCLES = ['CONCEPT', 'DEVELOPMENT'] as const

const code = (max: number) => cell.code({ max, upper: true })

export const commerceStylesImporter = defineImporter({
  key: COMMERCE_IMPORTER_KEY,
  label: 'Styles from a Nexus Commerce export',
  description:
    'A Nexus Commerce product export (or a sheet with the same columns), one row per SKU: each product family becomes a draft style with its colours, sizes, SKU codes and barcodes. Nothing is sent to Nexus Commerce.',
  columns: {
    sku: {
      label: 'SKU',
      aliases: ['codice sku', 'sku variante', 'variant sku', 'seller sku', 'item sku', 'codice variante', 'codice articolo', 'articolo'],
      required: true,
      type: code(64),
      description: 'The SKU of the variant: the factory SKU keeps it as it is (capital letters, digits, . _ -).',
    },
    family: {
      label: 'Parent SKU',
      aliases: ['parent', 'parent code', 'sku padre', 'codice padre', 'padre', 'famiglia', 'family', 'product family', 'codice famiglia', 'parent sku code'],
      type: code(64),
      description: "The family the SKU belongs to; blank on the family's own row (no colour, no size).",
    },
    name: {
      label: 'Name',
      aliases: ['nome', 'titolo', 'title', 'product name', 'nome prodotto', 'product title'],
      type: cell.text({ max: 200 }),
      description: "The product's name: on the family's own row, the style's name.",
    },
    familyName: {
      label: 'Family name',
      aliases: ['parent name', 'parent title', 'nome famiglia', 'nome padre', 'nome modello', 'style name'],
      type: cell.text({ max: 200 }),
      description: "The style's name when the sheet has no row of the family itself.",
    },
    style: {
      label: 'Style code',
      aliases: ['codice modello', 'modello', 'style', 'factory style'],
      type: code(64),
      description: "Our style code; blank: the family's code. 1 to 24 capital letters or digits, with . _ - inside.",
    },
    colour: {
      label: 'Colour',
      aliases: ['color', 'colore', 'colour name', 'color name', 'nome colore', 'variante colore', 'variation color', 'variation colour'],
      type: cell.text({ max: 120 }),
      description: 'The colour of the variant: one colourway of the style per colour.',
    },
    colourCode: {
      label: 'Colour code',
      aliases: ['color code', 'codice colore', 'colour id', 'colourway', 'colourway code', 'variante'],
      type: code(12),
      description: "The colourway's code; blank: made from the colour's name (Nero opaco → NERO_OPACO).",
    },
    size: {
      label: 'Size',
      aliases: ['taglia', 'misura', 'size name', 'variation size', 'nome taglia'],
      type: cell.text({ max: 40 }),
      description: "The size of the variant: a size of the style's scale, by its code or label.",
    },
    gtin: {
      label: 'EAN / GTIN',
      aliases: ['ean', 'ean13', 'ean 13', 'gtin', 'barcode', 'bar code', 'codice a barre', 'upc'],
      type: cell.text({ max: 20 }),
      description: 'The barcode of the SKU (EAN-13 or another GTIN); blank: none yet.',
    },
    productType: {
      label: 'Product type',
      aliases: ['tipo prodotto', 'tipo', 'type', 'category', 'categoria', 'product category', 'categoria prodotto'],
      type: cell.text({ max: 120 }),
      description: 'Jacket, trousers, suit, gloves, vest or other (Commerce categories are read by their words: Giacche moto → jacket).',
    },
    season: {
      label: 'Season',
      aliases: ['stagione', 'collection', 'collezione'],
      type: cell.text({ max: 20 }),
    },
    brand: {
      label: 'Private-label brand',
      aliases: ['brand party', 'codice brand', 'private label', 'marchio cliente', 'brand cliente', 'cliente brand'],
      type: cell.text({ max: 200 }),
      description: 'Blank: our own collection. A brand we make it for: its party code or name (a party with the brand role).',
    },
    sizeScale: {
      label: 'Size scale',
      aliases: ['scala taglie', 'scala', 'size chart', 'tabella taglie', 'size range'],
      type: cell.text({ max: 120 }),
      description: 'Blank: the one size scale that holds every size of the family.',
    },
  },
  keyColumns: ['sku'],
  maxRows: COMMERCE_IMPORT_LIMITS.rows,
  // The families are judged and written whole: the apply is ONE batch (one command).
  batchSize: COMMERCE_IMPORT_LIMITS.rows,
  validateRow: (values: RowValues): RowIssue[] => commerceRowProblems(values),
  plan: (values, existing) => planCommerceRow(values, existing),
})

// ---- one row ------------------------------------------------------------------------------------------------------------

const textOf = (value: CellValue | null | undefined): string | null => {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** The family's own row: no colour and no size (its name, type, season and brand). */
export const isFamilyRow = (values: RowValues): boolean => textOf(values.colour) === null && textOf(values.size) === null

/** The family a row belongs to: its Parent SKU; the family's own row is its own; a SKU row without one, its Style code. */
export function familyKeyOf(values: RowValues): string | null {
  return textOf(values.family) ?? (isFamilyRow(values) ? textOf(values.sku) : textOf(values.style))
}

/** The style code a row makes: its Style code, else its family's code. */
export function styleCodeOf(values: RowValues): string | null {
  return textOf(values.style) ?? familyKeyOf(values)
}

/** A colourway code made from a colour's name: accents off, capitals, other characters `_`, 12 at most ("Nero opaco" → NERO_OPACO). */
export function colourwayCodeFromName(name: string): string | null {
  const folded = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const cut = folded.slice(0, 12).replace(/_+$/, '')
  return COLOURWAY_CODE.test(cut) ? cut : null
}

/** The colourway code a row makes: its Colour code, else one made from its colour's name. */
export function colourwayCodeOf(values: RowValues): string | null {
  const given = textOf(values.colourCode)
  if (given !== null) return given
  const colour = textOf(values.colour)
  return colour === null ? null : colourwayCodeFromName(colour)
}

const TYPE_WORDS: readonly (readonly [RegExp, ProductType])[] = [
  [/\b(giacc|giubb|giubbin|jacket|blouson|parka|coat|cappott|anorak)/, 'JACKET'],
  [/\b(tut[ae]\b|suit|one ?piece|intero)/, 'SUIT'],
  [/\b(pantal|trouser|pants?\b|jeans?\b|overpant)/, 'TROUSERS'],
  [/\b(guant|glove)/, 'GLOVES'],
  [/\b(gilet|vest|panciott)/, 'VEST'],
  [/\b(altro|altri|other|accessor)/, 'OTHER'],
]

/** A product type from the words of a type or a Commerce category ("Giacche moto" → JACKET), or null when none fits. */
export function productTypeOf(text: string): ProductType | null {
  const folded = foldWord(text).replace(/[^a-z0-9 ]+/g, ' ')
  const exact = PRODUCT_TYPES.find((type) => type.toLowerCase() === folded.trim())
  if (exact) return exact
  for (const [pattern, type] of TYPE_WORDS) if (pattern.test(folded)) return type
  return null
}

/** The GTIN of a row as stored (canonical), or undefined when none is given. */
export function gtinOf(values: RowValues): string | undefined {
  const text = textOf(values.gtin)
  if (text === null) return undefined
  const parsed = parseGtin(text)
  return parsed.ok ? parsed.gtin : undefined
}

/** The checks of one row's cells together (the family's are `judgeFamilies`). */
export function commerceRowProblems(values: RowValues): RowIssue[] {
  const issues: RowIssue[] = []
  const sku = textOf(values.sku)
  if (sku !== null && !SKU.test(sku)) issues.push({ column: 'sku', message: 'A SKU is 1 to 64 capital letters or digits, with . _ - inside.' })
  const colour = textOf(values.colour)
  const size = textOf(values.size)
  if (colour === null && size !== null) issues.push({ column: 'colour', message: "Give the SKU's colour (a family in one colour: the same colour on every row)." })
  if (size === null && colour !== null) issues.push({ column: 'size', message: "Give the SKU's size." })
  if (isFamilyRow(values)) {
    const family = textOf(values.family)
    if (family !== null && family !== sku) issues.push({ column: 'size', message: "A row with a Parent SKU is a SKU of that family: give its colour and size (the family's own row has no Parent SKU)." })
    if (textOf(values.gtin) !== null) issues.push({ column: 'gtin', message: "The family's own row has no barcode: barcodes belong to its SKUs." })
  } else if (familyKeyOf(values) === null) {
    issues.push({ column: 'family', message: 'Name the family of the SKU (Parent SKU) or its Style code.' })
  }
  const styleCode = styleCodeOf(values)
  if (styleCode !== null && !STYLE_CODE.test(styleCode)) {
    issues.push({ column: textOf(values.style) !== null ? 'style' : 'family', message: `${styleCode} is no style code (${STYLE_CODE_RULE}): give a Style code.` })
  }
  if (!isFamilyRow(values) && colour !== null && colourwayCodeOf(values) === null) {
    issues.push({ column: 'colourCode', message: `No colourway code can be made from this colour's name: give a Colour code (${COLOURWAY_CODE_RULE}).` })
  }
  const colourCode = textOf(values.colourCode)
  if (colourCode !== null && !COLOURWAY_CODE.test(colourCode)) issues.push({ column: 'colourCode', message: `Expected ${COLOURWAY_CODE_RULE}.` })
  const gtin = textOf(values.gtin)
  if (gtin !== null) {
    const parsed = parseGtin(gtin)
    if (!parsed.ok) issues.push({ column: 'gtin', message: parsed.message })
  }
  const type = textOf(values.productType)
  if (type !== null && productTypeOf(type) === null) issues.push({ column: 'productType', message: `Expected a jacket, trousers, a suit, gloves, a vest or other (${PRODUCT_TYPES.join(', ')}).` })
  return issues
}

/** What a SKU the factory has already holds (the adapter's load answers it beside the columns). */
export interface KnownSku {
  readonly kind: 'sku'
  readonly style: string
  readonly colourCode: string
  readonly size: string
}
/** A style whose code is the key of a family's own row. */
export interface KnownStyle {
  readonly kind: 'style'
  readonly style: string
}
const KNOWN = '$known'

/** A record of the load: the SKU (or the style) its key found, with what the plan compares. */
export function knownRecordValues(sku: string, known: KnownSku | KnownStyle): RecordValues {
  return known.kind === 'sku'
    ? { sku, style: known.style, colourCode: known.colourCode, size: known.size, [KNOWN]: JSON.stringify(known) }
    : { sku, style: known.style, [KNOWN]: JSON.stringify(known) }
}

const knownOf = (existing: ExistingRecord): KnownSku | KnownStyle | null => {
  const raw = existing.values[KNOWN]
  return typeof raw === 'string' ? (JSON.parse(raw) as KnownSku | KnownStyle) : null
}

/** The words for a SKU the factory has on another style, colour or size (the plan's and the check's). */
export function skuElsewhere(sku: string, known: KnownSku): string {
  return `SKU ${sku} is on style ${known.style} (colourway ${known.colourCode}, size ${known.size}) already: a SKU names one garment only. Leave the row out, or change the SKU.`
}

/** A row as planned: the codes it makes (style, colourway, the stored GTIN) beside the cells it gives. */
function derived(values: RowValues): RowValues {
  const out: Record<string, CellValue> = { ...values }
  const style = styleCodeOf(values)
  if (style !== null) out.style = style
  if (!isFamilyRow(values)) {
    const colourway = colourwayCodeOf(values)
    if (colourway !== null) out.colourCode = colourway
    const gtin = gtinOf(values)
    if (gtin !== undefined) out.gtin = gtin
  }
  return out
}

/**
 * One row's plan: a new SKU (or a family whose style does not exist) is a CREATE, with the codes it makes; a SKU the
 * factory has on the same style, colourway and size, or a family whose style exists, is UNCHANGED; anything else an
 * error in words. What the family needs of the database (a scale, the style's state, the brand) is the check's.
 */
export function planCommerceRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) return { action: 'CREATE', after: derived(values) }
  const known = knownOf(existing)
  const sku = String(values.sku)
  if (known === null) return { action: 'ERROR', errors: [{ column: 'sku', message: `${sku} is in the factory already.` }] }
  if (isFamilyRow(values)) {
    if (known.kind === 'style') return { action: 'UNCHANGED' }
    return { action: 'ERROR', errors: [{ column: 'sku', message: `${sku} is a SKU of style ${known.style} already, not a family: give the family's rows its own code.` }] }
  }
  if (known.kind === 'style') return { action: 'ERROR', errors: [{ column: 'sku', message: `${sku} is the code of style ${known.style}, not of a SKU: change the SKU.` }] }
  const same = known.style === styleCodeOf(values) && known.colourCode === colourwayCodeOf(values) && known.size === sizeKey(String(values.size))
  return same ? { action: 'UNCHANGED' } : { action: 'ERROR', errors: [{ column: 'sku', message: skuElsewhere(sku, known) }] }
}

/** A size as written, compared with a scale's codes (capitals, no spaces around). */
export const sizeKey = (size: string): string => size.trim().toUpperCase()

// ---- the families -------------------------------------------------------------------------------------------------------

/** A row as the check reads it: its number and its values (key columns included). */
export interface CommerceRow {
  readonly rowNumber: number
  readonly values: RowValues
}

/** An existing style a family's code finds (in the tenant: a style code is unique there). */
export interface StyleFact {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
  readonly status: string
  readonly lifecycle: string
  readonly released: boolean
  readonly sizeScaleId: string
  /** Its range, in the scale's order. */
  readonly sizes: readonly string[]
  readonly colourways: readonly { readonly code: string; readonly name: string }[]
  /** Its SKUs by colourway code and size: `BLK|52` → SKU. */
  readonly cells: ReadonlyMap<string, string>
}

export interface ScaleFact {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string | null
  readonly status: string
  readonly sizes: readonly { readonly code: string; readonly label: string | null; readonly seq: number; readonly status: string }[]
}

export interface BrandFact {
  readonly id: string
  readonly code: string
  readonly names: readonly string[]
}

export interface ColourFact {
  readonly id: string
  readonly code: string
  readonly names: readonly string[]
}

/** What the database says about the sheet's families (the adapter reads it in the check's transaction). */
export interface CommerceFacts {
  /** The job's company; null: every company. */
  readonly companyId: string | null
  /** The styles the families' codes find, by code. */
  readonly styles: ReadonlyMap<string, StyleFact>
  /** The SKUs of the sheet the factory has already, by SKU. */
  readonly skus: ReadonlyMap<string, KnownSku>
  /** The GTINs of the sheet on a factory SKU already: GTIN → that SKU. */
  readonly gtins: ReadonlyMap<string, string>
  /** The size scales a style of the job's company may use (its own and every company's), any state. */
  readonly scales: readonly ScaleFact[]
  /** The brands a style of the job's company may be made for (BRAND role, not blocked or archived). */
  readonly brands: readonly BrandFact[]
  /** The library colours a colourway of the job's company may take (active). */
  readonly colours: readonly ColourFact[]
}

/** A new SKU of a family, as the write makes it. */
export interface PlannedSku {
  readonly rowNumber: number
  readonly sku: string
  readonly colourCode: string
  readonly size: string
  readonly gtin: string | null
}

/** One family as one style: what the write makes (a new style) or adds (to the style its code found). */
export interface FamilyPlan {
  readonly family: string
  readonly styleCode: string
  /** The style the code found (it takes the new colours, sizes and SKUs); null: a new style. */
  readonly existingStyleId: string | null
  readonly name: string
  readonly productType: ProductType
  readonly season: string | null
  readonly brandPartyId: string | null
  readonly sizeScaleId: string
  /** The whole range afterwards, in the scale's order. */
  readonly sizes: readonly string[]
  /** The sizes the range gains (a new style: all of them). */
  readonly newSizes: readonly string[]
  /** The colourways the style gains. */
  readonly colourways: readonly { readonly code: string; readonly name: string; readonly colourId: string | null }[]
  readonly skus: readonly PlannedSku[]
  /** The rows of the family that are new (they are written with it). */
  readonly rowNumbers: readonly number[]
}

export interface Judgement {
  /** One list of issues per row, in the order given. */
  readonly issues: readonly RowIssue[][]
  /** The families that pass, as they are written. */
  readonly families: readonly FamilyPlan[]
}

const fits = (owner: string | null, companyId: string | null): boolean => owner === null || owner === companyId
const list = (values: readonly string[], max = 5): string => values.slice(0, max).join(', ') + (values.length > max ? ' …' : '')

/** The one value the family's rows give for a column (blank rows aside), or a problem when they give several. */
function agreed(rows: readonly CommerceRow[], column: string, label: string): { value: string | null; problem?: string } {
  const given = [...new Set(rows.map((row) => textOf(row.values[column])).filter((value): value is string => value !== null))]
  if (given.length > 1) return { value: null, problem: `The family's rows give different ${label}s (${list(given, 3)}): give one.` }
  return { value: given[0] ?? null }
}

/** The size of a scale a size as written names (its code, or its label), or null. */
export function sizeInScale(scale: ScaleFact, size: string): string | null {
  const key = sizeKey(size)
  const folded = foldWord(size)
  const active = scale.sizes.filter((entry) => entry.status === 'ACTIVE')
  return active.find((entry) => entry.code === key)?.code ?? active.find((entry) => entry.label !== null && foldWord(entry.label) === folded)?.code ?? null
}

/** The scale of a new style: the one named (code or name; its sizes are checked row by row), else the one scale that holds every size. */
export function scaleFor(named: string | null, sizes: readonly string[], scales: readonly ScaleFact[], companyId: string | null): { scale: ScaleFact } | { problem: RowIssue } {
  const usable = scales.filter((scale) => scale.status === 'ACTIVE' && fits(scale.companyId, companyId))
  if (named !== null) {
    const found = scales.find((scale) => scale.code === sizeKey(named)) ?? scales.find((scale) => foldWord(scale.name) === foldWord(named))
    if (!found) return { problem: { column: 'sizeScale', message: `No size scale ${named}.` } }
    if (found.status !== 'ACTIVE') return { problem: { column: 'sizeScale', message: `Size scale ${found.code} is archived.` } }
    if (!fits(found.companyId, companyId)) return { problem: { column: 'sizeScale', message: `Size scale ${found.code} belongs to another company than the import's.` } }
    // Each SKU's size is checked on its own row (a size the named scale lacks stops the family from that row).
    return { scale: found }
  }
  const holding = usable.filter((scale) => sizes.every((size) => sizeInScale(scale, size) !== null))
  if (holding.length === 1) return { scale: holding[0]! }
  if (holding.length === 0) return { problem: { column: 'size', message: `No size scale holds every size of the family (${list(sizes, 8)}): add them to a scale in Products › Sizes & measurements, or name the scale in a Size scale column.` } }
  return { problem: { column: 'sizeScale', message: `Several size scales hold the family's sizes (${list(holding.map((scale) => scale.code))}): name one in a Size scale column.` } }
}

function brandFor(text: string, brands: readonly BrandFact[]): { id: string } | { problem: RowIssue } {
  const byCode = brands.filter((brand) => brand.code === sizeKey(text))
  const found = byCode.length > 0 ? byCode : brands.filter((brand) => brand.names.some((name) => foldWord(name) === foldWord(text)))
  if (found.length === 1) return { id: found[0]!.id }
  if (found.length === 0) return { problem: { column: 'brand', message: `No brand ${text} for the import's company (a party with the brand role, not blocked): add it in Parties, or leave the cell blank for our own collection.` } }
  return { problem: { column: 'brand', message: `Several brands are called ${text}: give the party's code.` } }
}

function libraryColour(name: string, code: string, colours: readonly ColourFact[]): string | null {
  const byCode = colours.filter((colour) => colour.code === code)
  if (byCode.length === 1) return byCode[0]!.id
  const byName = colours.filter((colour) => colour.names.some((entry) => foldWord(entry) === foldWord(name)))
  return byName.length === 1 ? byName[0]!.id : null
}

/**
 * The sheet's rows judged as families (see the module comment): one list of issues per row, and the families that pass,
 * as the write makes them. Rows whose SKU the factory has already are the plan's (UNCHANGED, or an error when the SKU is
 * on another style, colour or size: said here too, so the family stops); a family's own row whose style exists, too.
 */
export function judgeFamilies(rows: readonly CommerceRow[], facts: CommerceFacts): Judgement {
  const issues = rows.map((): RowIssue[] => [])
  const families = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const key = familyKeyOf(row.values)
    if (key === null) return
    families.set(key, [...(families.get(key) ?? []), index])
  })

  // The GTINs of the sheet: each once, and on no other factory SKU.
  const gtinRows = new Map<string, number>()
  rows.forEach((row, index) => {
    const gtin = gtinOf(row.values)
    if (gtin === undefined) return
    const sku = String(row.values.sku)
    const first = gtinRows.get(gtin)
    if (first !== undefined) issues[index]!.push({ column: 'gtin', message: `The same barcode as row ${rows[first]!.rowNumber}: a GTIN names one SKU.` })
    else gtinRows.set(gtin, index)
    const holder = facts.gtins.get(gtin)
    if (holder !== undefined && holder !== sku) issues[index]!.push({ column: 'gtin', message: `This barcode is on SKU ${holder} already: a GTIN names one SKU.` })
  })

  const passed: FamilyPlan[] = []
  for (const [family, indexes] of families) {
    const valuesOf = (index: number) => rows[index]!.values
    const codes = new Set(indexes.map((index) => styleCodeOf(valuesOf(index))).filter((value): value is string => value !== null))
    const styleCode = [...codes][0] ?? family
    const style = facts.styles.get(styleCode) ?? null
    const styleRow = indexes.find((index) => isFamilyRow(valuesOf(index))) ?? null

    // The rows that would write something: new SKUs, a SKU on another style (it stops the family), and the family's
    // own row while its style is new. A SKU the factory has on the same cell, and the row of a style that exists, are
    // the plan's (UNCHANGED).
    const skuRows: number[] = []
    const clashes: number[] = []
    for (const index of indexes) {
      if (isFamilyRow(valuesOf(index))) continue
      const known = facts.skus.get(String(valuesOf(index).sku))
      if (!known) {
        skuRows.push(index)
        continue
      }
      const same = known.style === styleCodeOf(valuesOf(index)) && known.colourCode === colourwayCodeOf(valuesOf(index)) && known.size === sizeKey(String(valuesOf(index).size))
      if (!same) {
        issues[index]!.push({ column: 'sku', message: skuElsewhere(String(valuesOf(index).sku), known) })
        clashes.push(index)
      }
    }
    const fresh = [...skuRows, ...clashes, ...(styleRow !== null && style === null ? [styleRow] : [])].sort((a, b) => a - b)
    if (fresh.length === 0) continue
    const stop = (issue: RowIssue) => {
      for (const index of fresh) issues[index]!.push(issue)
    }

    if (codes.size > 1) {
      stop({ column: 'style', message: `The rows of family ${family} make different style codes (${list([...codes], 3)}): give the same Style code on every row of the family, or none.` })
      continue
    }
    if (style) {
      // The style its code found takes new colours, sizes and SKUs only as a draft of the import's company, still open.
      const refusal =
        style.companyId !== facts.companyId
          ? `Style ${style.code} is ${style.companyId === null ? "every company's" : "another company's"}: import its family with a job for ${style.companyId === null ? 'every company' : 'its company'}.`
          : style.status === 'ARCHIVED'
            ? `Style ${style.code} is archived: reactivate it first, or give the family another Style code.`
            : style.released || style.status !== 'DRAFT' || !(OPEN_LIFECYCLES as readonly string[]).includes(style.lifecycle)
              ? `Style ${style.code} is past development (${style.lifecycle.toLowerCase().replace(/_/g, ' ')}): add its new colours and sizes on the style itself.`
              : null
      if (refusal) {
        stop({ column: 'style', message: refusal })
        continue
      }
    } else if (skuRows.length === 0 && clashes.length === 0) {
      stop({ column: 'sku', message: `Family ${family} has no SKU row (with colour and size) in the sheet: a style needs its colours and sizes.` })
      continue
    }

    // The family's facts: problems of the family (index null) stop every fresh row; a row's own stops the family too.
    const problems: { index: number | null; issue: RowIssue }[] = []
    const familyRows = indexes.map((index) => rows[index]!)
    let name = style?.code ?? ''
    if (!style) {
      const own = styleRow === null ? null : textOf(valuesOf(styleRow).name)
      const parent = agreed(familyRows, 'familyName', 'family name')
      const names = agreed(skuRows.map((index) => rows[index]!), 'name', 'name')
      if (own !== null) name = own
      else if (parent.problem) problems.push({ index: null, issue: { column: 'familyName', message: parent.problem } })
      else if (parent.value !== null) name = parent.value
      else if (names.value !== null && !names.problem) name = names.value
      else problems.push({ index: null, issue: { column: 'name', message: `Name the style: give the family's own row (${family}, no colour and no size) with its name, or a Family name column.` } })
    }
    const typeText = agreed(familyRows, 'productType', 'product type')
    const season = agreed(familyRows, 'season', 'season')
    const brandText = agreed(familyRows, 'brand', 'brand')
    const scaleText = agreed(familyRows, 'sizeScale', 'size scale')
    for (const [column, answer] of [['productType', typeText], ['season', season], ['brand', brandText], ['sizeScale', scaleText]] as const) {
      if (answer.problem) problems.push({ index: null, issue: { column, message: answer.problem } })
    }
    let brandPartyId: string | null = null
    if (!style && brandText.value !== null && !brandText.problem) {
      const brand = brandFor(brandText.value, facts.brands)
      if ('problem' in brand) problems.push({ index: null, issue: brand.problem })
      else brandPartyId = brand.id
    }

    // The scale: the style's own, else the one named or the one that holds every size.
    let scale: ScaleFact | null = null
    if (style) {
      scale = facts.scales.find((entry) => entry.id === style.sizeScaleId) ?? null
      if (!scale) problems.push({ index: null, issue: { column: 'size', message: `The size scale of style ${style.code} cannot be read.` } })
    } else if (!scaleText.problem) {
      const chosen = scaleFor(scaleText.value, [...new Set(skuRows.map((index) => sizeKey(String(valuesOf(index).size))))], facts.scales, facts.companyId)
      if ('problem' in chosen) problems.push({ index: null, issue: chosen.problem })
      else scale = chosen.scale
    }

    // The new SKUs: each in a size of the scale, its colourway named once, each cell once.
    const planned: PlannedSku[] = []
    const colourways = new Map<string, { code: string; name: string; colourId: string | null }>()
    const own = new Map((style?.colourways ?? []).map((colourway) => [colourway.code, colourway.name]))
    const cells = new Map<string, number>(style ? [...style.cells.keys()].map((cell) => [cell, -1]) : [])
    if (scale) {
      for (const index of skuRows) {
        const values = valuesOf(index)
        const size = sizeInScale(scale, String(values.size))
        if (size === null) {
          problems.push({ index, issue: { column: 'size', message: `Size scale ${scale.code} has no active size ${String(values.size)}: add it in Products › Sizes & measurements, or name another scale.` } })
          continue
        }
        const colourCode = colourwayCodeOf(values)!
        const colourName = textOf(values.colour)!
        const named = colourways.get(colourCode)?.name ?? own.get(colourCode)
        if (named !== undefined && foldWord(named) !== foldWord(colourName) && textOf(values.colourCode) === null) {
          problems.push({ index, issue: { column: 'colour', message: `Colours ${named} and ${colourName} both make colourway ${colourCode}: give a Colour code.` } })
          continue
        }
        if (!own.has(colourCode) && !colourways.has(colourCode)) colourways.set(colourCode, { code: colourCode, name: colourName, colourId: libraryColour(colourName, colourCode, facts.colours) })
        const cell = `${colourCode}|${size}`
        const before = cells.get(cell)
        if (before !== undefined) {
          const message =
            before === -1
              ? `Style ${styleCode} has SKU ${style!.cells.get(cell)} for colourway ${colourCode} in size ${size} already.`
              : `Colourway ${colourCode} in size ${size} is the SKU of row ${rows[before]!.rowNumber} already.`
          problems.push({ index, issue: { column: 'size', message } })
          continue
        }
        cells.set(cell, index)
        planned.push({ rowNumber: rows[index]!.rowNumber, sku: String(values.sku), colourCode, size, gtin: gtinOf(values) ?? null })
      }
    }
    if (own.size + colourways.size > 100) problems.push({ index: null, issue: { column: 'colour', message: 'A style has at most 100 colourways.' } })

    for (const problem of problems) {
      if (problem.index === null) stop(problem.issue)
      else issues[problem.index]!.push(problem.issue)
    }
    const stopped = fresh.filter((index) => issues[index]!.length > 0)
    if (stopped.length > 0) {
      // The family is started whole or not at all: its other rows say which row stops it.
      const general = problems.some((problem) => problem.index === null)
      const named = general ? [] : stopped.map((index) => String(rows[index]!.rowNumber))
      if (named.length > 0) {
        const words = `Family ${family} is started whole or not at all: row ${list(named)} has a problem.`
        for (const index of fresh) if (issues[index]!.length === 0) issues[index]!.push({ column: 'family', message: words })
      }
      continue
    }

    const range = style ? [...style.sizes] : []
    const order = new Map(scale!.sizes.map((entry) => [entry.code, entry.seq]))
    const bySeq = (a: string, b: string) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)
    const newSizes = [...new Set(planned.map((entry) => entry.size))].filter((size) => !range.includes(size)).sort(bySeq)
    passed.push({
      family,
      styleCode,
      existingStyleId: style?.id ?? null,
      name,
      productType: typeText.value === null ? 'OTHER' : (productTypeOf(typeText.value) ?? 'OTHER'),
      season: season.value,
      brandPartyId,
      sizeScaleId: scale!.id,
      sizes: [...range, ...newSizes].sort(bySeq),
      newSizes,
      colourways: [...colourways.values()],
      skus: planned,
      rowNumbers: fresh.map((index) => rows[index]!.rowNumber),
    })
  }
  return { issues, families: passed }
}

/** The change note of revision 1 of a style a Commerce family started. */
export const startedNote = (family: string): string => `Started from the Nexus Commerce export (family ${family}).`
