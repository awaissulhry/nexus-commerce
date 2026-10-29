import { Decimal } from 'decimal.js'
import { z } from 'zod'
import type { Issue } from '../../core/errors'
import { isLanguageCode } from '../../parties/geo'
import { classificationOf, type StyleFacts } from '../../product/compliance/rules'
import { EN_13594_CLASSES, EN_17092_CLASSES } from '../../product/styles/rules'
import { defineMachine, nextStates } from '../../state/machine'

/**
 * The PPE garment label template (B-W1-19; PRD-331; A2 SCR-053 "Labels & marking"; Reg. (EU) 2016/425 art. 8(5)(6),
 * art. 10(3), art. 17, Annex II 1.4; Reg. (EU) 1007/2011 arts. 9, 12, 16; EN 17092 and EN ISO 13688 marking; ISO 3758
 * care symbols), pure. A template holds what is typed ONCE for the sewn-in label (factory-db `LabelTemplate`):
 *
 *   maker          the legal maker's name and postal address (art. 8(6)): the brand with a brand label, else our company
 *   importer       when the maker is outside the EU (art. 10(3))
 *   composition    the fibre composition per part (Reg. 1007/2011 art. 9; typed in W1, computed from the BOM in W2b)
 *   animal origin  the phrase "contains non-textile parts of animal origin" (art. 12), in each language the label prints
 *   care           the ISO 3758 care symbols, with an optional text per language
 *   layout         the layout choice (preset), the order of the fields, the CE notified-body number of a category III
 *                  style (art. 17(2)), how the date of manufacture prints, and the typed phrase texts
 *   size           the label's width and height in millimetres
 *
 * The values that come from records (the style and its standard, part and class, the size with its body measures, the
 * colourway, the batch number or serial, the date of manufacture, the certificate) are joined at render time
 * (./render.ts), each with the record it came from.
 *
 * Statuses: DRAFT (edited freely, even incomplete: the problems are listed) → ACTIVE (only when it has no problem; frozen
 * from then on, for every login: a change is a new revision of the same code) → RETIRED (a style revision naming it can
 * no longer release a work order, B-W1-38's labelCheck). A draft may be retired (abandoned); nothing is deleted.
 *
 * SCHEMA NOTE: the CE notified-body number and the typed animal-origin texts have no column of their own yet; they live in
 * `layout` (validated here). The status enum is DRAFT/ACTIVE/RETIRED.
 */

// ---- statuses ----------------------------------------------------------------------------------------------------------

export const LABEL_TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const
export type LabelTemplateStatus = (typeof LABEL_TEMPLATE_STATUSES)[number]

/** The template's machine; activation's conditions (no problem) are checked by the API with every problem's path. */
export const labelTemplateMachine = defineMachine<LabelTemplateStatus>({
  name: 'label template',
  states: LABEL_TEMPLATE_STATUSES,
  transitions: { DRAFT: ['ACTIVE', 'RETIRED'], ACTIVE: ['RETIRED'] },
})

export const labelNextStatuses = (status: LabelTemplateStatus): readonly LabelTemplateStatus[] => nextStates(labelTemplateMachine, status)

/** Only a draft is edited. */
export const isLabelEditable = (status: LabelTemplateStatus): boolean => status === 'DRAFT'

/** Why a template out of DRAFT is not edited (design 02 `lb-activate`). */
export const frozenMessage = (code: string, revision: number, status: LabelTemplateStatus): string =>
  status === 'ACTIVE'
    ? `Label ${code} r${revision} is active: active labels are never edited, a change is a new revision. Work orders keep the revision they were released with.`
    : `Label ${code} r${revision} is retired: it is kept as it was, never edited. Start a new revision of it instead.`

// ---- codes ---------------------------------------------------------------------------------------------------------------

/** A template code: 1 to 32 capital letters or digits, with . _ - inside ("LBL-JK100"). Revisions share it. */
export const LABEL_CODE = /^[A-Z0-9](?:[A-Z0-9._-]{0,30}[A-Z0-9])?$/
export const LABEL_CODE_RULE = '1 to 32 capital letters or digits, with . _ - inside'
/** The code a style's own label gets when none is typed. */
export const defaultLabelCode = (styleCode: string): string => `LBL-${styleCode}`.slice(0, 32)

// ---- layout -----------------------------------------------------------------------------------------------------------------

/**
 * The fields a label prints, by key. `pictogram` is the standard's pictogram with the class letters (EN 17092: the
 * motorcyclist; EN 13594: the glove); `class` is the class again in words, printed only when the layout lists it.
 */
export const LABEL_FIELDS = [
  'ceMark',
  'pictogram',
  'class',
  'standard',
  'model',
  'colourway',
  'size',
  'bodyMeasures',
  'batchOrSerial',
  'manufactureDate',
  'maker',
  'importer',
  'composition',
  'animalOrigin',
  'care',
] as const
export type LabelField = (typeof LABEL_FIELDS)[number]

/** The order of the fields the layout does not place itself. */
export const DEFAULT_FIELD_ORDER: readonly LabelField[] = LABEL_FIELDS
/** Printed on every PPE label, whether or not the layout lists them (PRD-331; art. 8(5)(6), art. 17; EN 17092, EN ISO 13688). */
export const PPE_FIELDS: readonly LabelField[] = ['ceMark', 'pictogram', 'standard', 'model', 'size', 'bodyMeasures', 'batchOrSerial', 'maker']
/** Printed on every label, PPE or not. */
export const ALWAYS_FIELDS: readonly LabelField[] = ['model', 'size', 'batchOrSerial', 'maker']
/** Printed only when the layout lists them. */
export const LISTED_ONLY_FIELDS: readonly LabelField[] = ['class', 'colourway']

/**
 * The layout choices (sizes in hundredths of a millimetre): the text height and line pitch, the CE mark's height (5 mm
 * at least, the CE marking's smallest), the pictogram's and the care symbols' rows, the margin and the gap between fields.
 */
export const LAYOUT_PRESETS = Object.freeze({
  STANDARD: { margin: 250, text: 180, line: 230, gap: 100, ce: 600, pictogram: 1000, care: 500 },
  COMPACT: { margin: 200, text: 140, line: 180, gap: 60, ce: 500, pictogram: 800, care: 400 },
})
export type LayoutPreset = keyof typeof LAYOUT_PRESETS
export const LAYOUT_PRESET_KEYS = Object.keys(LAYOUT_PRESETS) as [LayoutPreset, ...LayoutPreset[]]

/** How the date of manufacture prints: year and quarter ("2026-Q4"), year and month ("2026-10"), or not at all. */
export const MANUFACTURE_DATE_FORMATS = ['QUARTER', 'MONTH', 'NONE'] as const
export type ManufactureDateFormat = (typeof MANUFACTURE_DATE_FORMATS)[number]

const TEXT_MAX = 120

/** `layout` as stored and sent. Unknown keys are refused; left-out ones take their defaults (the seed's `{ fields }`). */
export const labelLayoutSchema = z.strictObject({
  preset: z.enum(LAYOUT_PRESET_KEYS).default('STANDARD'),
  /** The order of the fields; the ones left out follow in DEFAULT_FIELD_ORDER (those the label prints anyway). */
  fields: z.array(z.enum(LABEL_FIELDS)).max(LABEL_FIELDS.length).default([]),
  /** Category III only: the notified body that checks production, printed after the CE mark (art. 17(2)). */
  notifiedBodyNumber: z.string().trim().max(8).nullable().default(null),
  manufactureDate: z.enum(MANUFACTURE_DATE_FORMATS).default('QUARTER'),
  /** Phrase texts typed per language (ISO 639-1 → text); a built-in official text is used where none is typed. */
  texts: z
    .strictObject({ animalOrigin: z.record(z.string().max(8), z.string().trim().max(TEXT_MAX)).default({}) })
    .default({ animalOrigin: {} }),
})
export type LabelLayout = z.infer<typeof labelLayoutSchema>
export const DEFAULT_LAYOUT: LabelLayout = Object.freeze({ preset: 'STANDARD', fields: [], notifiedBodyNumber: null, manufactureDate: 'QUARTER', texts: { animalOrigin: {} } })

const issuesOf = (error: z.ZodError, at: string): Issue[] =>
  error.issues.map((issue) => ({ path: [at, ...issue.path.map(String)].join('/'), message: issue.message }))

/** A stored layout (JSON) with its problems; an unreadable one is the default layout plus the problem. */
export function layoutOf(value: unknown): { readonly layout: LabelLayout; readonly problems: Issue[] } {
  const parsed = labelLayoutSchema.safeParse(value ?? {})
  return parsed.success ? { layout: parsed.data, problems: [] } : { layout: DEFAULT_LAYOUT, problems: issuesOf(parsed.error, 'layout') }
}

// ---- composition and care ------------------------------------------------------------------------------------------------

export const compositionSchema = z
  .array(
    z.strictObject({
      part: z.string().trim().max(40),
      fibres: z.array(z.strictObject({ fibre: z.string().trim().max(40), percent: z.string().trim().max(8) })).max(8),
    }),
  )
  .max(8)
export type CompositionPart = z.infer<typeof compositionSchema>[number]

/** ISO 3758:2023 care symbols by category, in the order the label prints them. The artwork needs a GINETEX licence (W2b). */
export const CARE_CATEGORIES = ['WASH', 'BLEACH', 'TUMBLE_DRY', 'NATURAL_DRY', 'IRON', 'DRY_CLEAN', 'WET_CLEAN'] as const
export type CareCategory = (typeof CARE_CATEGORIES)[number]

interface CareSymbol {
  readonly category: CareCategory
  /** What it says, in English (the screen's words; the label prints the symbol). */
  readonly words: string
  /** The stand-in drawn in the symbol's box until the artwork is licensed. */
  readonly mark: string
}
const care = (category: CareCategory, words: string, mark: string): CareSymbol => Object.freeze({ category, words, mark })

export const CARE_SYMBOLS: Readonly<Record<string, CareSymbol>> = Object.freeze({
  'wash-95': care('WASH', 'Wash at 95 °C', 'W95'),
  'wash-70': care('WASH', 'Wash at 70 °C', 'W70'),
  'wash-60': care('WASH', 'Wash at 60 °C', 'W60'),
  'wash-60-mild': care('WASH', 'Wash at 60 °C, mild process', 'W60-'),
  'wash-50': care('WASH', 'Wash at 50 °C', 'W50'),
  'wash-50-mild': care('WASH', 'Wash at 50 °C, mild process', 'W50-'),
  'wash-40': care('WASH', 'Wash at 40 °C', 'W40'),
  'wash-40-mild': care('WASH', 'Wash at 40 °C, mild process', 'W40-'),
  'wash-40-very-mild': care('WASH', 'Wash at 40 °C, very mild process', 'W40='),
  'wash-30': care('WASH', 'Wash at 30 °C', 'W30'),
  'wash-30-mild': care('WASH', 'Wash at 30 °C, mild process', 'W30-'),
  'wash-30-very-mild': care('WASH', 'Wash at 30 °C, very mild process', 'W30='),
  'wash-hand': care('WASH', 'Hand wash', 'WH'),
  'wash-not': care('WASH', 'Do not wash', 'WX'),
  'bleach-any': care('BLEACH', 'Any bleaching agent allowed', 'B'),
  'bleach-oxygen': care('BLEACH', 'Only oxygen bleach', 'BO'),
  'bleach-not': care('BLEACH', 'Do not bleach', 'BX'),
  'tumble-normal': care('TUMBLE_DRY', 'Tumble dry, normal temperature', 'T2'),
  'tumble-low': care('TUMBLE_DRY', 'Tumble dry, low temperature', 'T1'),
  'tumble-not': care('TUMBLE_DRY', 'Do not tumble dry', 'TX'),
  'dry-line': care('NATURAL_DRY', 'Line dry', 'DL'),
  'dry-line-shade': care('NATURAL_DRY', 'Line dry in the shade', 'DLS'),
  'dry-drip': care('NATURAL_DRY', 'Drip dry', 'DD'),
  'dry-drip-shade': care('NATURAL_DRY', 'Drip dry in the shade', 'DDS'),
  'dry-flat': care('NATURAL_DRY', 'Dry flat', 'DF'),
  'dry-flat-shade': care('NATURAL_DRY', 'Dry flat in the shade', 'DFS'),
  'iron-200': care('IRON', 'Iron at up to 200 °C', 'I3'),
  'iron-150': care('IRON', 'Iron at up to 150 °C', 'I2'),
  'iron-110': care('IRON', 'Iron at up to 110 °C', 'I1'),
  'iron-110-no-steam': care('IRON', 'Iron at up to 110 °C without steam', 'I1S'),
  'iron-not': care('IRON', 'Do not iron', 'IX'),
  'dryclean-professional': care('DRY_CLEAN', 'Professional dry cleaning in tetrachloroethene (P)', 'P'),
  'dryclean-p-mild': care('DRY_CLEAN', 'Professional dry cleaning (P), mild process', 'P-'),
  'dryclean-f': care('DRY_CLEAN', 'Professional dry cleaning in hydrocarbons (F)', 'F'),
  'dryclean-f-mild': care('DRY_CLEAN', 'Professional dry cleaning (F), mild process', 'F-'),
  'dryclean-not': care('DRY_CLEAN', 'Do not dry clean', 'PX'),
  'wetclean-w': care('WET_CLEAN', 'Professional wet cleaning (W)', 'W'),
  'wetclean-w-mild': care('WET_CLEAN', 'Professional wet cleaning (W), mild process', 'W-'),
  'wetclean-w-very-mild': care('WET_CLEAN', 'Professional wet cleaning (W), very mild process', 'W='),
  'wetclean-not': care('WET_CLEAN', 'Do not wet clean', 'WCX'),
})
export const CARE_SYMBOL_CODES = Object.keys(CARE_SYMBOLS) as [string, ...string[]]

export const careSchema = z
  .array(z.strictObject({ symbol: z.string().trim().max(40), text: z.record(z.string().max(8), z.string().trim().max(80)).optional() }))
  .max(10)
export type CareEntry = z.infer<typeof careSchema>[number]

/** A stored composition or care list (JSON); an unreadable one is empty plus its problem. */
export function compositionOf(value: unknown): { readonly composition: CompositionPart[]; readonly problems: Issue[] } {
  const parsed = compositionSchema.safeParse(value ?? [])
  return parsed.success ? { composition: parsed.data, problems: [] } : { composition: [], problems: issuesOf(parsed.error, 'composition') }
}
export function careOf(value: unknown): { readonly care: CareEntry[]; readonly problems: Issue[] } {
  const parsed = careSchema.safeParse(value ?? [])
  return parsed.success ? { care: parsed.data, problems: [] } : { care: [], problems: issuesOf(parsed.error, 'care') }
}

// ---- the animal-origin phrase (Reg. (EU) 1007/2011 art. 12) -----------------------------------------------------------------

/**
 * Art. 12's own words in the language versions of the regulation the factory's markets use first. A label language not
 * here needs its text typed in the template (`layout.texts.animalOrigin`); a typed text replaces the built-in one.
 */
export const ANIMAL_ORIGIN_PHRASES: Readonly<Record<string, string>> = Object.freeze({
  it: 'Contiene parti non tessili di origine animale',
  en: 'Contains non-textile parts of animal origin',
  de: 'Enthält nichttextile Teile tierischen Ursprungs',
  fr: "Contient des parties non textiles d'origine animale",
  es: 'Contiene partes no textiles de origen animal',
})

/** The phrase in one language: the typed text, else the regulation's own words, else null. */
export function animalOriginText(layout: Pick<LabelLayout, 'texts'>, language: string): { readonly text: string; readonly typed: boolean } | null {
  const typed = layout.texts.animalOrigin[language]?.trim()
  if (typed) return { text: typed, typed: true }
  const official = ANIMAL_ORIGIN_PHRASES[language]
  return official ? { text: official, typed: false } : null
}

// ---- the content and its problems ----------------------------------------------------------------------------------------

/** What a template holds, as the rules read it. Sizes are decimal strings in millimetres ("50.00"). */
export interface LabelContent {
  readonly name: string
  readonly languages: readonly string[]
  readonly makerPartyId: string | null
  readonly makerName: string
  readonly makerAddress: string
  readonly importerName: string | null
  readonly importerAddress: string | null
  readonly composition: readonly CompositionPart[]
  readonly animalOriginPhrase: boolean
  readonly care: readonly CareEntry[]
  readonly layout: LabelLayout
  readonly widthMm: string
  readonly heightMm: string
}

export const MAX_LANGUAGES = 8
/** The label sizes the builder accepts (sewn-in labels and the label printers' stock), in millimetres. */
export const MIN_LABEL_MM = 20
export const MAX_LABEL_WIDTH_MM = 150
export const MAX_LABEL_HEIGHT_MM = 300
const MM = /^\d{1,4}(?:\.\d{1,2})?$/
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/
const NOTIFIED_BODY = /^\d{4}$/

/** Millimetres as hundredths (integer arithmetic, no float); null when not a plain decimal with at most 2 places. */
export function hundredthsOf(mm: string): number | null {
  if (!MM.test(mm.trim())) return null
  const [whole, fraction = ''] = mm.trim().split('.')
  return Number.parseInt(whole!, 10) * 100 + Number.parseInt(fraction.padEnd(2, '0'), 10)
}
/** Hundredths of a millimetre as "50.00". */
export const mmText = (hundredths: number): string => `${Math.trunc(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`

const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''

/** Every problem of the typed content (empty when it may be activated as far as the content goes). Paths are field paths. */
export function contentProblems(content: LabelContent): Issue[] {
  const problems: Issue[] = []
  const add = (path: string, message: string) => problems.push({ path, message })

  if (blank(content.name)) add('name', 'Give the label a name.')

  // Languages: the label's texts are printed in each (Reg. 1007/2011 art. 16(3); Reg. 2016/425 art. 8(7)).
  if (content.languages.length === 0) add('languages', 'Name at least one language the label prints (ISO 639-1: it, en, de…).')
  if (content.languages.length > MAX_LANGUAGES) add('languages', `A label prints at most ${MAX_LANGUAGES} languages.`)
  const seen = new Set<string>()
  content.languages.forEach((language, index) => {
    if (!isLanguageCode(language)) add(`languages/${index}`, `${language} is not an ISO 639-1 language code (it, en, de…).`)
    else if (seen.has(language)) add(`languages/${index}`, `${language} is listed twice.`)
    seen.add(language)
  })

  // The maker (art. 8(6)): name and a postal address at which it can be contacted.
  if (blank(content.makerName)) add('makerName', "The maker's name, registered trade name or mark is printed on PPE (Reg. (EU) 2016/425 art. 8(6)).")
  if (blank(content.makerAddress)) add('makerAddress', "The maker's postal address is printed on PPE (Reg. (EU) 2016/425 art. 8(6)).")
  else if (!/\d/.test(content.makerAddress)) add('makerAddress', 'A postal address names the street and number, the postal code and the town (Reg. (EU) 2016/425 art. 8(6)).')
  // The importer (art. 10(3)): both or neither.
  if (blank(content.importerName) !== blank(content.importerAddress)) {
    add(blank(content.importerName) ? 'importerName' : 'importerAddress', "An importer is printed with its name and postal address together (Reg. (EU) 2016/425 art. 10(3)).")
  }

  // Fibre composition (Reg. 1007/2011 art. 9): each part's fibres add up to 100 %.
  content.composition.forEach((part, index) => {
    const at = `composition/${index}`
    if (blank(part.part)) add(`${at}/part`, 'Name the part (shell, lining, padding…).')
    if (part.fibres.length === 0) add(`${at}/fibres`, `Give the fibres of ${part.part || 'the part'}.`)
    const fibres = new Set<string>()
    let sum = new Decimal(0)
    let readable = true
    part.fibres.forEach((fibre, fibreIndex) => {
      const fibreAt = `${at}/fibres/${fibreIndex}`
      if (blank(fibre.fibre)) add(`${fibreAt}/fibre`, 'Name the fibre (Reg. (EU) 1007/2011 Annex I).')
      else if (fibres.has(fibre.fibre.trim().toLowerCase())) add(`${fibreAt}/fibre`, `${fibre.fibre} is listed twice in ${part.part}.`)
      fibres.add(fibre.fibre.trim().toLowerCase())
      if (!PERCENT.test(fibre.percent) || new Decimal(fibre.percent).lte(0) || new Decimal(fibre.percent).gt(100)) {
        add(`${fibreAt}/percent`, 'A share is a percentage above 0 and at most 100, with at most 2 decimals.')
        readable = false
      } else sum = sum.plus(fibre.percent)
    })
    if (readable && part.fibres.length > 0 && !sum.eq(100)) {
      add(`${at}/fibres`, `The fibres of ${part.part || 'the part'} add up to ${sum.toString()} %, not 100 % (Reg. (EU) 1007/2011 art. 9).`)
    }
  })

  // The animal-origin phrase (art. 12) in every language the label prints.
  const printed = [...new Set(content.languages)].filter(isLanguageCode)
  if (content.animalOriginPhrase) {
    for (const language of printed) {
      if (animalOriginText(content.layout, language) === null) {
        add(`layout/texts/animalOrigin/${language}`, `Type the animal-origin phrase in ${language}: "contains non-textile parts of animal origin" (Reg. (EU) 1007/2011 art. 12).`)
      }
    }
  }
  for (const language of Object.keys(content.layout.texts.animalOrigin)) {
    if (!content.languages.includes(language)) add(`layout/texts/animalOrigin/${language}`, `The label does not print ${language}: add the language or remove the text.`)
  }

  // Care symbols (ISO 3758): known, one per category; a text, when given, in every language.
  const categories = new Map<CareCategory, string>()
  content.care.forEach((entry, index) => {
    const at = `care/${index}`
    const symbol = CARE_SYMBOLS[entry.symbol]
    if (!symbol) {
      add(`${at}/symbol`, `${entry.symbol} is not an ISO 3758 care symbol this builder knows.`)
      return
    }
    const before = categories.get(symbol.category)
    if (before) add(`${at}/symbol`, `${symbol.words} and ${CARE_SYMBOLS[before]!.words} are two symbols of one kind: keep one.`)
    categories.set(symbol.category, entry.symbol)
    const texts = entry.text ?? {}
    if (Object.keys(texts).length > 0) {
      for (const language of printed) {
        if (blank(texts[language])) add(`${at}/text/${language}`, `The care text "${symbol.words}" has no ${language} text: the label prints ${printed.join(', ')}.`)
      }
      for (const language of Object.keys(texts)) {
        if (!content.languages.includes(language)) add(`${at}/text/${language}`, `The label does not print ${language}: add the language or remove the text.`)
      }
    }
  })

  // The layout.
  const fields = new Set<string>()
  content.layout.fields.forEach((field, index) => {
    if (fields.has(field)) add(`layout/fields/${index}`, `${field} is placed twice.`)
    fields.add(field)
  })
  const nb = content.layout.notifiedBodyNumber
  if (nb !== null && !NOTIFIED_BODY.test(nb)) add('layout/notifiedBodyNumber', "A notified body's identification number has four digits (NANDO).")

  // The size.
  const width = hundredthsOf(content.widthMm)
  const height = hundredthsOf(content.heightMm)
  if (width === null || width < MIN_LABEL_MM * 100 || width > MAX_LABEL_WIDTH_MM * 100) add('widthMm', `A label is ${MIN_LABEL_MM} to ${MAX_LABEL_WIDTH_MM} mm wide (at most 2 decimals).`)
  if (height === null || height < MIN_LABEL_MM * 100 || height > MAX_LABEL_HEIGHT_MM * 100) add('heightMm', `A label is ${MIN_LABEL_MM} to ${MAX_LABEL_HEIGHT_MM} mm high (at most 2 decimals).`)
  return problems
}

// ---- the style it marks ----------------------------------------------------------------------------------------------------

/** The style as the label reads it. */
export interface LabelStyle extends StyleFacts {
  readonly name: string
  readonly companyId: string | null
}

const CATEGORY_WORDS = { NOT_PPE: 'not PPE', CATEGORY_I: 'category I PPE', CATEGORY_II: 'category II PPE', CATEGORY_III: 'category III PPE' } as const

/** The class an EN 17092 or EN 13594 style must name; null for other standards (EN 1621 levels…). */
const classesOf = (standardCode: string | null): readonly string[] | null =>
  standardCode === 'EN 17092' ? EN_17092_CLASSES : standardCode === 'EN 13594' ? EN_13594_CLASSES : null

/**
 * The problems of this template on this style: what the PPE marking needs from the style (a standard and, for EN 17092 and
 * EN 13594, a class), the CE mark's notified-body number (only and always for category III: art. 17(2)), and the maker
 * (with a brand label, the brand: PLAN §2.8). Paths: `style/…` for the style's own data, `layout/…`, `makerPartyId`.
 */
export function styleProblems(content: Pick<LabelContent, 'layout' | 'makerPartyId'>, style: LabelStyle): Issue[] {
  const problems: Issue[] = []
  const classification = classificationOf(style)
  const nb = content.layout.notifiedBodyNumber
  if (classification.isPpe) {
    if (style.ppeStandard === null) {
      problems.push({ path: 'style/ppeStandard', message: `Style ${style.code} is ${CATEGORY_WORDS[style.ppeCategory]} but names no harmonised standard: the label prints the standard and the class (Reg. (EU) 2016/425 Annex II 1.4).` })
    } else {
      const classes = classesOf(classification.standardCode)
      const ppeClass = classification.ppeClass ?? classification.partClass
      if (classes && ppeClass === null) {
        problems.push({ path: 'style/ppeClass', message: `Style ${style.code} is made to ${style.ppeStandard} but names no class: the pictogram prints the class (${classes.join(', ')}).` })
      }
    }
  }
  if (style.ppeCategory === 'CATEGORY_III' && nb === null) {
    problems.push({
      path: 'layout/notifiedBodyNumber',
      message: `Style ${style.code} is category III PPE: the CE marking is followed by the identification number of the notified body that checks production (Reg. (EU) 2016/425 art. 17(2)). Type it in the label.`,
    })
  }
  if (style.ppeCategory !== 'CATEGORY_III' && nb !== null) {
    problems.push({
      path: 'layout/notifiedBodyNumber',
      message: classification.isPpe
        ? `No notified-body number after the CE mark: style ${style.code} is ${CATEGORY_WORDS[style.ppeCategory]}, and only category III carries one (Reg. (EU) 2016/425 art. 17(2)). Remove it.`
        : `Style ${style.code} is not PPE: its label carries no CE marking and no notified-body number. Remove it.`,
    })
  }
  if (content.makerPartyId !== null && style.brandPartyId !== null && content.makerPartyId !== style.brandPartyId) {
    problems.push({ path: 'makerPartyId', message: `Style ${style.code} is made for another brand: with a brand label, that brand is the legal maker the label names (Reg. (EU) 2016/425 art. 8(6)).` })
  }
  return problems
}

/** What is worth a look but does not stop the label (paths as above). */
export function styleWarnings(content: Pick<LabelContent, 'makerPartyId'>, style: LabelStyle): Issue[] {
  if (style.brandPartyId !== null && content.makerPartyId === null) {
    return [{ path: 'makerPartyId', message: `Style ${style.code} is made for a brand, and the label names our company as the maker: right only when the garment carries our own label, not the brand's.` }]
  }
  return []
}

/** The fields this label prints, in order: the layout's first, then the others it prints (PPE or not, with or without data). */
export function printedFields(content: Pick<LabelContent, 'layout' | 'importerName' | 'composition' | 'animalOriginPhrase' | 'care'>, isPpe: boolean): LabelField[] {
  const listed = new Set<LabelField>(content.layout.fields)
  const prints = (field: LabelField): boolean => {
    if ((isPpe ? PPE_FIELDS : ALWAYS_FIELDS).includes(field)) return true
    if (!isPpe && (field === 'ceMark' || field === 'pictogram' || field === 'class' || field === 'standard')) return false
    if (LISTED_ONLY_FIELDS.includes(field)) return listed.has(field)
    if (field === 'bodyMeasures') return listed.has(field)
    if (field === 'manufactureDate') return content.layout.manufactureDate !== 'NONE'
    if (field === 'importer') return !blank(content.importerName)
    if (field === 'composition') return content.composition.length > 0
    if (field === 'animalOrigin') return content.animalOriginPhrase
    if (field === 'care') return content.care.length > 0
    return false
  }
  const ordered = [...new Set<LabelField>([...content.layout.fields, ...DEFAULT_FIELD_ORDER])]
  return ordered.filter(prints)
}
