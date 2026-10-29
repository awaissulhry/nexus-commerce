import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { classificationOf } from '../../product/compliance/rules'
import {
  animalOriginText,
  CARE_CATEGORIES,
  CARE_SYMBOLS,
  contentProblems,
  hundredthsOf,
  LAYOUT_PRESETS,
  mmText,
  printedFields,
  styleProblems,
  styleWarnings,
  type LabelContent,
  type LabelField,
  type LabelStyle,
  type LabelTemplateStatus,
  type LayoutPreset,
} from './rules'

/**
 * The garment label of one cell, rendered (B-W1-19; PRD-331; design 02 `lb-builder`: "every auto value shows where it
 * came from"), pure. The template gives what was typed once; the API reads the rest from the records:
 *
 *   ceMark          the style's PPE category (CE on PPE only; the notified-body number after it for category III, from
 *                   the template: art. 17(2))
 *   pictogram       the standard's pictogram with the class letters: the covering certificate's class when a certificate
 *                   covers the cell (it must equal the style's), else the style's (classificationOf)
 *   standard        the style's standard with its part and edition (classificationOf)
 *   model, class    the style (type or model, art. 8(5))
 *   colourway       the colourway (listed only)
 *   size            the size scale's label of the size, and its body measures (EN ISO 13688 size designation)
 *   batchOrSerial   the work order's batch number, or the garment's serial (art. 8(5)); a placeholder in a preview
 *   manufactureDate the batch's year and quarter (or month): the work order's release day; a placeholder in a preview
 *   maker, importer, composition, animalOrigin, care   the template
 *
 * Every block says where its value came from (`source`), and the label lists every problem that would stop a garment
 * label from printing (`problems`, `printable`): the template's own, the style's, the certificate gate's refusal, a
 * missing batch or serial, a language the buyer's market needs, and text that does not fit the label. A preview
 * (`sample`) shows placeholders and a SAMPLE banner; B-W1-44 renders with the real batch or serial at the final operation.
 *
 * Geometry is in hundredths of a millimetre (integers): the API's PDF and ./zpl.ts draw the same blocks.
 */

export const SOURCE_KINDS = ['TEMPLATE', 'STYLE', 'CERTIFICATE', 'SIZE_SCALE', 'COLOURWAY', 'WORK_ORDER', 'SERIAL', 'RULE', 'SAMPLE'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** Where a printed value came from, in words for the person, with the record behind it. */
export interface LabelSource {
  readonly kind: SourceKind
  readonly words: string
  readonly recordType: string | null
  readonly recordId: string | null
}

export interface LabelLine {
  readonly text: string
  /** The language of a translated line (the animal-origin phrase, care texts); null for a value. */
  readonly language: string | null
}

export type LabelGraphic =
  | { readonly kind: 'CE'; readonly notifiedBodyNumber: string | null }
  | { readonly kind: 'PICTOGRAM'; readonly pictogram: 'MOTORCYCLIST' | 'GLOVE' | 'NONE'; readonly standardCode: string | null; readonly ppeClass: string | null }
  | { readonly kind: 'CARE'; readonly symbols: readonly { readonly code: string; readonly mark: string; readonly words: string }[] }

export interface RenderedBlock {
  readonly field: LabelField
  /** The main value as one string (what the screen shows beside the source). */
  readonly value: string | null
  /** The text lines as printed, wrapped to the label's width. */
  readonly lines: readonly LabelLine[]
  /** A drawn element above the lines (the CE mark, the pictogram, the care symbols). */
  readonly graphic: LabelGraphic | null
  /** A preview's stand-in: the real value is filled at print. */
  readonly placeholder: boolean
  readonly source: LabelSource
  /** Its height on the label, hundredths of a millimetre. */
  readonly height: number
}

export interface LabelFit {
  readonly widthMm: string
  readonly heightMm: string
  /** Height the blocks need, and the height inside the margins, in millimetres ("62.30"). */
  readonly neededMm: string
  readonly availableMm: string
  readonly charsPerLine: number
  readonly fits: boolean
}

export interface RenderedLabel {
  readonly template: { readonly id: string; readonly code: string; readonly revision: number; readonly status: LabelTemplateStatus; readonly name: string }
  readonly sample: boolean
  /** The SAMPLE banner of a preview or a test print; empty on a garment label. */
  readonly banner: readonly string[]
  readonly preset: LayoutPreset
  readonly languages: readonly string[]
  readonly blocks: readonly RenderedBlock[]
  readonly fit: LabelFit | null
  /** What stops a garment label from printing with these values. */
  readonly problems: readonly Issue[]
  /** Worth a look; prints anyway. */
  readonly warnings: readonly Issue[]
  /** No problem: a garment label with these values may print. */
  readonly printable: boolean
}

/** The template as the renderer reads it. `storedProblems`: what its stored JSON had wrong (unreadable layout…). */
export interface LabelTemplateFacts extends LabelContent {
  readonly id: string
  readonly code: string
  readonly revision: number
  readonly name: string
  readonly status: LabelTemplateStatus
  readonly styleId: string | null
  readonly companyId: string | null
  readonly storedProblems: readonly Issue[]
}

/** The certificate gate's answer for the cell (B-W1-12 certificateGateFor), as the label needs it. */
export interface CellCertificate {
  readonly outcome: 'covered' | 'not_required' | 'refused'
  readonly certificate: { readonly id: string; readonly number: string; readonly standard: string; readonly ppeClass: string | null; readonly validTo: BusinessDate } | null
  readonly reasons: readonly string[]
  readonly date: BusinessDate
}

/** A size's body measures by measurement point (Size.bodyMeasures): decimal strings, either end may be open. */
export type LabelBodyMeasures = Readonly<Record<string, { readonly min: string | null; readonly max: string | null; readonly unit: string }>>

export interface LabelSize {
  readonly code: string
  /** How the scale shows it ("52 (L)"); null: the code. */
  readonly label: string | null
  readonly scaleId: string
  readonly scaleCode: string
  readonly bodyMeasures: LabelBodyMeasures | null
}

/** The batch number (a work order's) or the garment's serial; value null in a preview. */
export interface Identification {
  readonly kind: 'BATCH' | 'SERIAL'
  readonly value: string | null
  readonly recordType: string | null
  readonly recordId: string | null
  /** The record as a person names it ("WO-00012"). */
  readonly reference: string | null
}

export interface LabelValues {
  readonly style: LabelStyle
  readonly colourway: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly size: LabelSize | null
  /** The gate for this colourway and size; null when not asked (no colourway or size). */
  readonly certificate: CellCertificate | null
  readonly identification: Identification
  /** When the batch was made (the work order's release day); null in a preview (today's date stands in). */
  readonly manufactured: { readonly date: BusinessDate; readonly recordType: string; readonly recordId: string; readonly reference: string } | null
  /** The day of the preview or print. */
  readonly date: BusinessDate
  /** A preview or test print: placeholders allowed, a banner, never a garment label. */
  readonly sample: boolean
  /** The languages the buyer's market needs (Party.language, the market's); empty: not known. */
  readonly marketLanguages: readonly string[]
}

export const SAMPLE_BANNER: readonly string[] = Object.freeze(['SAMPLE - NOT FOR GARMENTS', 'CAMPIONE - NON PER CAPI'])

const CLASS_WORDS: Readonly<Record<string, string>> = Object.freeze({ it: 'Classe', en: 'Class', de: 'Klasse', fr: 'Classe', es: 'Clase' })

/** Text as a label holds it: no control characters, spaces collapsed. */
export const labelLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()

/** Words wrapped to `max` characters a line; a word longer than a line is cut across lines. */
export function wrapText(value: string, max: number): string[] {
  const words = labelLine(value).split(' ').filter((word) => word !== '')
  const lines: string[] = []
  let current = ''
  for (let word of words) {
    while ([...word].length > max) {
      if (current !== '') {
        lines.push(current)
        current = ''
      }
      lines.push([...word].slice(0, max).join(''))
      word = [...word].slice(max).join('')
    }
    if (word === '') continue
    if (current === '') current = word
    else if ([...current].length + 1 + [...word].length <= max) current = `${current} ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/** "2026-Q4" or "2026-10". */
export function manufactureText(date: BusinessDate, format: 'QUARTER' | 'MONTH'): string {
  const [year, month] = date.split('-')
  return format === 'MONTH' ? `${year}-${month}` : `${year}-Q${Math.floor((Number.parseInt(month!, 10) - 1) / 3) + 1}`
}

/** A size's body measures as printed: "chest 100-104 cm, height 176-182 cm". */
export function bodyMeasuresText(measures: LabelBodyMeasures | null): string | null {
  const entries = Object.entries(measures ?? {}).filter(([, range]) => range.min !== null || range.max !== null)
  const rangeText = (range: LabelBodyMeasures[string]): string =>
    range.min !== null && range.max !== null ? `${range.min}-${range.max}` : range.min !== null ? `from ${range.min}` : `up to ${range.max}`
  return entries.length === 0 ? null : entries.map(([point, range]) => `${point} ${rangeText(range)} ${range.unit}`).join(', ')
}

const percentText = (percent: string): string => (/^\d{1,3}(?:\.\d{1,2})?$/.test(percent) ? new Decimal(percent).toString() : percent)

/** The width of a character of the preset's text (0.55 of its height, as the printers' font 0), hundredths of a millimetre. */
const charWidth = (preset: LayoutPreset): number => Math.ceil((LAYOUT_PRESETS[preset].text * 55) / 100)

/** Characters a line holds on a label this wide (hundredths), with the preset's margins; 40 when the width is unreadable. */
export function charsPerLine(widthHundredths: number | null, preset: LayoutPreset): number {
  if (widthHundredths === null) return 40
  return Math.max(1, Math.floor((widthHundredths - 2 * LAYOUT_PRESETS[preset].margin) / charWidth(preset)))
}

/** The narrowest label a preset accepts: 16 characters a line ("EN 17092-3:2020" on one line). */
export const MIN_CHARS_PER_LINE = 16

// ---- the blocks ---------------------------------------------------------------------------------------------------------------

interface Built {
  readonly blocks: RenderedBlock[]
  readonly problems: Issue[]
  readonly warnings: Issue[]
}

/** The blocks this template prints for these values, with the problems the values themselves raise. */
export function buildBlocks(template: LabelTemplateFacts, values: LabelValues): Built {
  const { style } = values
  const classification = classificationOf(style)
  const preset = LAYOUT_PRESETS[template.layout.preset]
  const width = charsPerLine(hundredthsOf(template.widthMm), template.layout.preset)
  const wrap = (text: string, language: string | null = null): LabelLine[] => wrapText(text, width).map((line) => ({ text: line, language }))
  const problems: Issue[] = []
  const warnings: Issue[] = []
  const blocks: RenderedBlock[] = []
  const styleRecord = { recordType: 'Style', recordId: style.id }
  const textHeight = (lines: number) => lines * preset.line
  const cell = values.colourway && values.size ? `${values.colourway.code} ${values.size.code}` : 'this cell'

  const covered = values.certificate?.outcome === 'covered' ? values.certificate.certificate : null
  const styleClass = classification.ppeClass ?? classification.partClass
  const ppeClass = covered?.ppeClass ?? styleClass
  if (covered && covered.ppeClass !== null && styleClass !== null && covered.ppeClass !== styleClass) {
    problems.push({
      path: 'pictogram',
      message: `Certificate ${covered.number} covering ${cell} grants class ${covered.ppeClass}; style ${style.code} says ${styleClass}: the label prints what the certificate grants, so correct the style or the certificate first.`,
    })
  }

  for (const field of printedFields(template, classification.isPpe)) {
    const add = (block: Omit<RenderedBlock, 'field'>) => blocks.push({ field, ...block })
    switch (field) {
      case 'ceMark': {
        const nb = template.layout.notifiedBodyNumber
        const category = style.ppeCategory === 'CATEGORY_III' ? 'category III' : style.ppeCategory === 'CATEGORY_II' ? 'category II' : 'category I'
        add({
          value: nb ? `CE ${nb}` : 'CE',
          lines: [],
          graphic: { kind: 'CE', notifiedBodyNumber: nb },
          placeholder: false,
          source: {
            kind: 'RULE',
            words: nb
              ? `Style ${style.code} is ${category} PPE: the CE marking, followed by notified body ${nb} as typed in the label (Reg. (EU) 2016/425 art. 17(2)).`
              : `Style ${style.code} is ${category} PPE: the CE marking, with no notified-body number after it (Reg. (EU) 2016/425 art. 17).`,
            ...styleRecord,
          },
          height: preset.ce,
        })
        break
      }
      case 'pictogram': {
        const pictogram = classification.standardCode === 'EN 17092' ? 'MOTORCYCLIST' : classification.standardCode === 'EN 13594' ? 'GLOVE' : 'NONE'
        const refused = values.certificate?.outcome === 'refused'
        add({
          value: ppeClass,
          lines: [],
          graphic: { kind: 'PICTOGRAM', pictogram, standardCode: classification.standardCode, ppeClass },
          placeholder: false,
          source: covered
            ? { kind: 'CERTIFICATE', words: `From certificate ${covered.number}: class ${ppeClass ?? 'none'}${covered.validTo ? `, valid until ${covered.validTo}` : ''}.`, recordType: 'Certificate', recordId: covered.id }
            : {
                kind: 'STYLE',
                words: `From style ${style.code}: class ${ppeClass ?? 'none'}${refused ? `; no valid certificate covers ${cell} on ${values.certificate!.date}` : values.certificate === null ? '; no cell was checked against a certificate' : ''}.`,
                ...styleRecord,
              },
          height: preset.pictogram,
        })
        break
      }
      case 'class': {
        const words = [...new Set(template.languages.map((language) => CLASS_WORDS[language] ?? 'Class'))].join(' / ')
        add({ value: ppeClass, lines: ppeClass ? wrap(`${words} ${ppeClass}`) : [], graphic: null, placeholder: false, source: { kind: covered ? 'CERTIFICATE' : 'STYLE', words: covered ? `From certificate ${covered.number}.` : `From style ${style.code}.`, recordType: covered ? 'Certificate' : 'Style', recordId: covered ? covered.id : style.id }, height: 0 })
        break
      }
      case 'standard': {
        const words = classification.standardCode
          ? `From style ${style.code}: ${classification.standardCode}${classification.part ? ` part ${classification.part}` : ''}${classification.edition ? `, edition ${classification.edition}` : ''}.`
          : `Style ${style.code} names no standard.`
        add({ value: style.ppeStandard, lines: style.ppeStandard ? wrap(style.ppeStandard) : [], graphic: null, placeholder: false, source: { kind: 'STYLE', words, ...styleRecord }, height: 0 })
        break
      }
      case 'model':
        add({ value: style.code, lines: wrap(`${style.code} ${style.name}`), graphic: null, placeholder: false, source: { kind: 'STYLE', words: `From style ${style.code} (the type or model, Reg. (EU) 2016/425 art. 8(5)).`, ...styleRecord }, height: 0 })
        break
      case 'colourway':
        add(
          values.colourway
            ? { value: values.colourway.code, lines: wrap(`${values.colourway.code} ${values.colourway.name}`), graphic: null, placeholder: false, source: { kind: 'COLOURWAY', words: `From colourway ${values.colourway.code} of style ${style.code}.`, recordType: 'Colourway', recordId: values.colourway.id }, height: 0 }
            : { value: null, lines: wrap('---'), graphic: null, placeholder: true, source: { kind: 'SAMPLE', words: 'The colourway of the garment fills it at print.', recordType: null, recordId: null }, height: 0 },
        )
        break
      case 'size': {
        const size = values.size
        add(
          size
            ? { value: size.code, lines: wrap(size.label ?? size.code), graphic: null, placeholder: false, source: { kind: 'SIZE_SCALE', words: `From size scale ${size.scaleCode}: size ${size.code}.`, recordType: 'SizeScale', recordId: size.scaleId }, height: 0 }
            : { value: null, lines: wrap('--'), graphic: null, placeholder: true, source: { kind: 'SAMPLE', words: 'The size of the garment fills it at print.', recordType: null, recordId: null }, height: 0 },
        )
        break
      }
      case 'bodyMeasures': {
        const size = values.size
        const text = size ? bodyMeasuresText(size.bodyMeasures) : null
        if (size && text === null && classification.isPpe) {
          problems.push({ path: 'bodyMeasures', message: `Size ${size.code} has no body measures in size scale ${size.scaleCode}: the PPE label shows the body measures the size is for (EN ISO 13688 size designation).` })
        }
        add({
          value: text,
          lines: text ? wrap(text) : [],
          graphic: null,
          placeholder: size === null,
          source: size ? { kind: 'SIZE_SCALE', words: `From size scale ${size.scaleCode}: the body measures of size ${size.code}.`, recordType: 'SizeScale', recordId: size.scaleId } : { kind: 'SAMPLE', words: 'The size of the garment fills it at print.', recordType: null, recordId: null },
          height: 0,
        })
        break
      }
      case 'batchOrSerial': {
        const id = values.identification
        const prefix = id.kind === 'SERIAL' ? 'SN' : 'LOT'
        if (id.value === null && !values.sample) {
          problems.push({ path: 'batchOrSerial', message: `A PPE garment carries its ${id.kind === 'SERIAL' ? 'serial' : 'batch'} number (Reg. (EU) 2016/425 art. 8(5)): none is given for this label yet.` })
        }
        add(
          id.value !== null
            ? {
                value: id.value,
                lines: wrap(`${prefix} ${id.value}`),
                graphic: null,
                placeholder: false,
                source: {
                  kind: id.kind === 'SERIAL' ? 'SERIAL' : 'WORK_ORDER',
                  words:
                    id.kind === 'SERIAL'
                      ? `The garment's serial ${id.value}${id.reference ? ` (work order ${id.reference})` : ''}.`
                      : `From ${id.reference ? `work order ${id.reference}` : 'the work order'}: batch ${id.value}, given at its release.`,
                  recordType: id.recordType,
                  recordId: id.recordId,
                },
                height: 0,
              }
            : {
                value: null,
                lines: wrap(`${prefix} ________`),
                graphic: null,
                placeholder: true,
                source: { kind: 'SAMPLE', words: id.kind === 'SERIAL' ? "The garment's serial fills it at print (B-W1-44)." : "The work order's batch number, given at its release, fills it at print (B-W1-44).", recordType: null, recordId: null },
                height: 0,
              },
        )
        break
      }
      case 'manufactureDate': {
        const format = template.layout.manufactureDate === 'MONTH' ? 'MONTH' : 'QUARTER'
        const made = values.manufactured
        add(
          made
            ? { value: manufactureText(made.date, format), lines: wrap(manufactureText(made.date, format)), graphic: null, placeholder: false, source: { kind: 'WORK_ORDER', words: `From work order ${made.reference}: released ${made.date}.`, recordType: made.recordType, recordId: made.recordId }, height: 0 }
            : { value: manufactureText(values.date, format), lines: wrap(manufactureText(values.date, format)), graphic: null, placeholder: true, source: { kind: 'SAMPLE', words: `The batch's ${format === 'MONTH' ? 'month' : 'quarter'} of manufacture fills it at print; shown with ${values.date}.`, recordType: null, recordId: null }, height: 0 },
        )
        break
      }
      case 'maker': {
        const who = template.makerPartyId === null ? 'our company' : template.makerPartyId === style.brandPartyId ? "the style's brand" : 'a party'
        add({
          value: template.makerName,
          lines: [...wrap(template.makerName), ...wrap(template.makerAddress)],
          graphic: null,
          placeholder: false,
          source: { kind: 'TEMPLATE', words: `Typed in the label: ${who}, the legal maker, with its postal address (Reg. (EU) 2016/425 art. 8(6)).`, recordType: template.makerPartyId ? 'Party' : 'LabelTemplate', recordId: template.makerPartyId ?? template.id },
          height: 0,
        })
        break
      }
      case 'importer':
        add({
          value: template.importerName,
          lines: [...wrap(template.importerName ?? ''), ...wrap(template.importerAddress ?? '')],
          graphic: null,
          placeholder: false,
          source: { kind: 'TEMPLATE', words: 'Typed in the label: the importer (Reg. (EU) 2016/425 art. 10(3)).', recordType: 'LabelTemplate', recordId: template.id },
          height: 0,
        })
        break
      case 'composition': {
        const parts = template.composition.map((part) => `${part.part}: ${part.fibres.map((fibre) => `${percentText(fibre.percent)}% ${fibre.fibre}`).join(', ')}`)
        add({
          value: parts.join('; '),
          lines: parts.flatMap((part) => wrap(part)),
          graphic: null,
          placeholder: false,
          source: { kind: 'TEMPLATE', words: 'Typed in the label: the fibre composition per part (Reg. (EU) 1007/2011 arts. 9, 16); computed from the BOM in W2b.', recordType: 'LabelTemplate', recordId: template.id },
          height: 0,
        })
        break
      }
      case 'animalOrigin': {
        const texts = template.languages.flatMap((language) => {
          const text = animalOriginText(template.layout, language)
          return text ? [{ language, ...text }] : []
        })
        const typed = texts.filter((text) => text.typed).map((text) => text.language)
        const official = texts.filter((text) => !text.typed).map((text) => text.language)
        add({
          value: texts[0]?.text ?? null,
          lines: texts.flatMap((text) => wrap(text.text, text.language)),
          graphic: null,
          placeholder: false,
          source: typed.length === 0
            ? { kind: 'RULE', words: `Reg. (EU) 1007/2011 art. 12, in the regulation's own words (${official.join(', ')}): the garment has non-textile parts of animal origin, as the label says.`, recordType: 'LabelTemplate', recordId: template.id }
            : { kind: 'TEMPLATE', words: `Reg. (EU) 1007/2011 art. 12: typed in the label for ${typed.join(', ')}${official.length > 0 ? `; the regulation's own words for ${official.join(', ')}` : ''}.`, recordType: 'LabelTemplate', recordId: template.id },
          height: 0,
        })
        break
      }
      case 'care': {
        const order = new Map(CARE_CATEGORIES.map((category, index) => [category, index]))
        const known = template.care.filter((entry) => CARE_SYMBOLS[entry.symbol] !== undefined)
        const symbols = [...known]
          .sort((a, b) => order.get(CARE_SYMBOLS[a.symbol]!.category)! - order.get(CARE_SYMBOLS[b.symbol]!.category)!)
          .map((entry) => ({ code: entry.symbol, mark: CARE_SYMBOLS[entry.symbol]!.mark, words: CARE_SYMBOLS[entry.symbol]!.words }))
        const lines = template.languages.flatMap((language) => {
          const texts = known.map((entry) => entry.text?.[language]?.trim() ?? '').filter((text) => text !== '')
          return texts.length > 0 ? wrap(texts.join('; '), language) : []
        })
        add({
          value: symbols.map((symbol) => symbol.code).join(' '),
          lines,
          graphic: { kind: 'CARE', symbols },
          placeholder: false,
          source: { kind: 'TEMPLATE', words: 'Typed in the label: the ISO 3758 care symbols (drawn as stand-ins until the licensed artwork, W2b).', recordType: 'LabelTemplate', recordId: template.id },
          height: preset.care,
        })
        break
      }
    }
  }
  const sized = blocks.map((block) => ({ ...block, height: block.height + textHeight(block.lines.length) }))
  return { blocks: sized, problems, warnings }
}

/** How the blocks fit the label: their height (with the gaps) against the height inside the margins, and the line width. */
export function fitOf(template: Pick<LabelContent, 'widthMm' | 'heightMm' | 'layout'>, blocks: readonly Pick<RenderedBlock, 'height'>[]): { readonly fit: LabelFit | null; readonly problems: Issue[] } {
  const width = hundredthsOf(template.widthMm)
  const height = hundredthsOf(template.heightMm)
  if (width === null || height === null) return { fit: null, problems: [] }
  const preset = LAYOUT_PRESETS[template.layout.preset]
  const needed = blocks.reduce((sum, block) => sum + block.height, 0) + Math.max(0, blocks.length - 1) * preset.gap
  const available = Math.max(0, height - 2 * preset.margin)
  const chars = charsPerLine(width, template.layout.preset)
  const problems: Issue[] = []
  if (chars < MIN_CHARS_PER_LINE) {
    problems.push({ path: 'widthMm', message: `At ${mmText(width)} mm wide a line holds ${chars} characters in the ${template.layout.preset.toLowerCase()} layout: make the label at least wide enough for ${MIN_CHARS_PER_LINE}.` })
  }
  if (needed > available) {
    problems.push({
      path: 'heightMm',
      message: `The text is too long for the layout: the label needs ${mmText(needed)} mm of height and has ${mmText(available)} mm inside its margins. Make it taller, choose the compact layout or shorten the texts.`,
    })
  }
  return { fit: { widthMm: mmText(width), heightMm: mmText(height), neededMm: mmText(needed), availableMm: mmText(available), charsPerLine: chars, fits: problems.length === 0 }, problems }
}

/** The label of one cell: the blocks, where each value came from, and every problem that stops a garment label. */
export function renderLabel(template: LabelTemplateFacts, values: LabelValues): RenderedLabel {
  const built = buildBlocks(template, values)
  const fit = fitOf(template, built.blocks)
  const problems: Issue[] = [...template.storedProblems, ...contentProblems(template), ...styleProblems(template, values.style)]
  const warnings: Issue[] = [...styleWarnings(template, values.style), ...built.warnings]
  if (template.styleId !== null && template.styleId !== values.style.id) {
    problems.push({ path: 'styleId', message: `Label ${template.code} r${template.revision} is another style's label, not style ${values.style.code}'s.` })
  }
  if (values.certificate?.outcome === 'refused') {
    const cell = values.colourway && values.size ? `${values.colourway.code} ${values.size.code}` : 'this cell'
    problems.push({
      path: 'certificate',
      message: `No valid certificate covers ${cell} of style ${values.style.code} on ${values.certificate.date}: its garment label is not printed (Reg. (EU) 2016/425 art. 17). ${values.certificate.reasons.join(' ')}`.trim(),
    })
  }
  if (template.status !== 'ACTIVE') {
    const message = `Label ${template.code} r${template.revision} is ${template.status}: garment labels print only from an ACTIVE label.`
    if (values.sample) warnings.push({ path: 'status', message })
    else problems.push({ path: 'status', message })
  }
  const missing = [...new Set(values.marketLanguages)].filter((language) => !template.languages.includes(language))
  if (missing.length > 0) {
    problems.push({
      path: 'languages',
      message: `The buyer's market needs ${missing.join(', ')}; the label prints ${template.languages.join(', ') || 'no language'}: add ${missing.length === 1 ? 'it' : 'them'} (Reg. (EU) 1007/2011 art. 16(3); Reg. (EU) 2016/425 art. 8(7)).`,
    })
  }
  problems.push(...built.problems, ...fit.problems)
  return {
    template: { id: template.id, code: template.code, revision: template.revision, status: template.status, name: template.name },
    sample: values.sample,
    banner: values.sample ? SAMPLE_BANNER : [],
    preset: template.layout.preset,
    languages: template.languages,
    blocks: built.blocks,
    fit: fit.fit,
    problems,
    warnings,
    printable: problems.length === 0,
  }
}

// ---- activation ---------------------------------------------------------------------------------------------------------------

/** A stand-in style for a shared template's checks: PPE category II, EN 17092-3, so the probe prints every PPE field. */
const PROBE_STYLE = (template: LabelTemplateFacts): LabelStyle => ({
  id: '00000000-0000-4000-8000-000000000000',
  code: 'XXXXXXXXXXXXXXXXXXXXXXXX',
  name: 'Xxxxxxxxxxxxxxxxxxxxxxxx',
  productType: 'JACKET',
  ppeCategory: template.layout.notifiedBodyNumber ? 'CATEGORY_III' : 'CATEGORY_II',
  ppeStandard: 'EN 17092-3:2020',
  ppeClass: 'AA',
  brandPartyId: template.makerPartyId,
  companyId: template.companyId,
})

/** Values of typical length for the fit check when no cell is given: what a garment label of the style would print. */
export function probeValues(style: LabelStyle, date: BusinessDate): LabelValues {
  return {
    style,
    colourway: { id: style.id, code: 'XXX', name: 'Xxxxxxxxxx' },
    size: { code: '52', label: '52 (L)', scaleId: style.id, scaleCode: 'XXXXXXXX', bodyMeasures: { chest: { min: '100', max: '104', unit: 'cm' }, height: { min: '176', max: '182', unit: 'cm' } } },
    certificate: null,
    identification: { kind: 'BATCH', value: 'XX-00000', recordType: null, recordId: null, reference: null },
    manufactured: { date, recordType: 'WorkOrder', recordId: style.id, reference: 'XX-00000' },
    date,
    sample: true,
    marketLanguages: [],
  }
}

/**
 * Every problem that keeps the template from ACTIVE: its stored data, its content, the style it is for (a shared
 * template: the checks a style needs are made when a style revision names it), and whether its content fits the label
 * with values of typical length.
 */
export function activationProblems(template: LabelTemplateFacts, style: LabelStyle | null, date: BusinessDate): Issue[] {
  const probe = probeValues(style ?? PROBE_STYLE(template), date)
  const built = buildBlocks(template, probe)
  return [...template.storedProblems, ...contentProblems(template), ...(style ? styleProblems(template, style) : []), ...fitOf(template, built.blocks).problems]
}
