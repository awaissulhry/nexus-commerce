import { countryName } from '../../documents/i18n'
import { labelText } from '../../labels/model'
import { parseDecimal } from '../../tax/decimal'
import type { ShippingMarkField } from '../packaging/rules'

/**
 * A carton's shipping marks (B-W2b-384; LOG-013: carton marks per customer for brand orders; design floor.pack "Close carton
 * … prints its marks"), pure: the fields of the customer's template (else the company's default), in its order, worded in
 * its language (Italian or English; another language prints in English), each a row of a label and one or more lines.
 * apps/factory-api platform/print/layouts/shipping-marks.ts lays them out as ZPL for a label printer and as a PDF.
 *
 * Words from codes only. The country of origin is printed as recorded for customs ("Country of origin: Italy"), never as
 * a "Made in Italy" claim (that claim has its own check, compliance/textile-rules/origin.ts). A field with nothing to show
 * (no customer order number, a carton not weighed, no batch) is left out; CUSTOMER_STYLE has no record yet (no column for
 * a customer's own style code): it is left out until there is one.
 */

export const MARK_LANGUAGES = ['it', 'en'] as const
export type MarkLanguage = (typeof MARK_LANGUAGES)[number]

/** The language the marks are printed in: the template's when it is Italian or English, else English. */
export const markLanguageOf = (language: string): MarkLanguage => (language === 'it' ? 'it' : 'en')

const WORDS = Object.freeze({
  it: {
    carton: 'Collo',
    of: 'di',
    pieces: (n: number) => (n === 1 ? '1 pezzo' : `${n} pezzi`),
    fields: {
      SHIP_TO: 'Destinatario',
      SENDER: 'Mittente',
      CUSTOMER_ORDER: 'Vostro ordine',
      ORDER_NUMBER: 'Nostro ordine',
      SHIPMENT_NUMBER: 'Spedizione',
      STYLE: 'Modello',
      CUSTOMER_STYLE: 'Vostro modello',
      COLOUR: 'Colore',
      SIZES: 'Taglie',
      QUANTITY: 'Quantità',
      CARTON_NUMBER: 'Collo',
      GROSS_WEIGHT: 'Peso lordo',
      NET_WEIGHT: 'Peso netto',
      DIMENSIONS: 'Dimensioni',
      BATCH: 'Lotto',
      ORIGIN: 'Paese di origine',
    },
  },
  en: {
    carton: 'Carton',
    of: 'of',
    pieces: (n: number) => (n === 1 ? '1 piece' : `${n} pieces`),
    fields: {
      SHIP_TO: 'Ship to',
      SENDER: 'Sender',
      CUSTOMER_ORDER: 'Your order',
      ORDER_NUMBER: 'Our order',
      SHIPMENT_NUMBER: 'Shipment',
      STYLE: 'Style',
      CUSTOMER_STYLE: 'Your style',
      COLOUR: 'Colour',
      SIZES: 'Sizes',
      QUANTITY: 'Quantity',
      CARTON_NUMBER: 'Carton',
      GROSS_WEIGHT: 'Gross weight',
      NET_WEIGHT: 'Net weight',
      DIMENSIONS: 'Dimensions',
      BATCH: 'Batch',
      ORIGIN: 'Country of origin',
    },
  },
} as const satisfies Record<MarkLanguage, { carton: string; of: string; pieces: (n: number) => string; fields: Record<ShippingMarkField, string> }>)

/**
 * The marks of a customer with no template and a company with no default: what the plan names for brand orders (the
 * customer's order number, "n of N", the style, the sizes, the ship-to) with the pieces and the batch.
 */
export const DEFAULT_MARK_FIELDS: readonly ShippingMarkField[] = Object.freeze(['SHIP_TO', 'CUSTOMER_ORDER', 'CARTON_NUMBER', 'STYLE', 'COLOUR', 'SIZES', 'QUANTITY', 'BATCH'])

/** An address as the shipment's ship-to snapshot and the site's sender address keep it. */
export interface MarkAddress {
  readonly name?: string | null
  readonly line1?: string | null
  readonly line2?: string | null
  readonly postalCode?: string | null
  readonly city?: string | null
  readonly province?: string | null
  readonly country?: string | null
}

/** One kind of garment in the carton (its contents record). */
export interface MarkContent {
  readonly styleCode: string
  readonly styleName: string
  readonly colourwayCode: string
  readonly colourwayName: string
  readonly size: string
  readonly quantity: number
  readonly batchNumber: string | null
  /** The style's country of origin (ISO 3166-1 alpha-2), as recorded for customs. */
  readonly originCountry: string | null
}

/** What a carton's marks can show. */
export interface MarkFacts {
  readonly maker: string | null
  readonly sender: MarkAddress | null
  readonly shipTo: MarkAddress
  readonly customerOrder: string | null
  readonly orderNumber: string
  readonly shipmentNumber: string
  readonly cartonNumber: number
  readonly cartonCount: number
  readonly contents: readonly MarkContent[]
  readonly grossWeightKg: string | null
  readonly netWeightKg: string | null
  readonly dimensionsCm: { readonly length: string; readonly width: string; readonly height: string } | null
}

export interface MarkRow {
  readonly field: ShippingMarkField
  readonly label: string
  readonly lines: readonly string[]
}

/** The marks of one carton, ready to be laid out. */
export interface CartonMarks {
  readonly language: MarkLanguage
  /** "Collo · <maker>". */
  readonly heading: string
  /** "Collo 2 di 3". */
  readonly title: string
  /** What the bars carry: the shipment's number and the carton's ("SH-00012-2"). */
  readonly code: string
  readonly rows: readonly MarkRow[]
}

/** The code a carton's marks carry: its shipment's number and its number, printable ASCII only. */
export const cartonMarkCode = (shipmentNumber: string, cartonNumber: number): string => `${shipmentNumber.replace(/[^\x21-\x7e]/g, '')}-${cartonNumber}`

/** A decimal as people read it in the language: no trailing zeros, a comma in Italian. */
function decimalWords(value: string, language: MarkLanguage): string {
  const parsed = parseDecimal(value)
  const text = parsed ? parsed.toFixed() : value
  return language === 'it' ? text.replace('.', ',') : text
}

const distinct = (values: readonly string[]): string[] => [...new Set(values.filter((value) => value !== ''))]

const addressLines = (address: MarkAddress, language: MarkLanguage): string[] =>
  [
    address.name ?? '',
    address.line1 ?? '',
    address.line2 ?? '',
    [address.postalCode, address.city, address.province ? `(${address.province})` : null].filter((part) => part).join(' '),
    address.country ? countryName(address.country, language) : '',
  ]
    .map(labelText)
    .filter((line) => line !== '')

/** The sizes in the carton, "50 × 2 · 52 × 3", per style and colour when it holds more than one. */
function sizesLines(contents: readonly MarkContent[]): string[] {
  const groups = new Map<string, MarkContent[]>()
  for (const content of contents) groups.set(`${content.styleCode} ${content.colourwayCode}`, [...(groups.get(`${content.styleCode} ${content.colourwayCode}`) ?? []), content])
  const sizes = (entries: readonly MarkContent[]) => entries.map((entry) => `${entry.size} × ${entry.quantity}`).join(' · ')
  return groups.size === 1 ? [sizes([...groups.values()][0]!)] : [...groups.entries()].map(([group, entries]) => `${group}: ${sizes(entries)}`)
}

/** The value lines of a field, empty when it has nothing to show. */
function linesOf(field: ShippingMarkField, facts: MarkFacts, language: MarkLanguage): string[] {
  const words = WORDS[language]
  switch (field) {
    case 'SHIP_TO':
      return addressLines(facts.shipTo, language)
    case 'SENDER':
      return facts.sender ? addressLines(facts.sender, language) : []
    case 'CUSTOMER_ORDER':
      return facts.customerOrder ? [facts.customerOrder] : []
    case 'ORDER_NUMBER':
      return [facts.orderNumber]
    case 'SHIPMENT_NUMBER':
      return [facts.shipmentNumber]
    case 'STYLE':
      return distinct(facts.contents.map((content) => `${content.styleCode} ${content.styleName}`))
    case 'CUSTOMER_STYLE':
      return []
    case 'COLOUR':
      return distinct(facts.contents.map((content) => `${content.colourwayCode} ${content.colourwayName}`))
    case 'SIZES':
      return facts.contents.length > 0 ? sizesLines(facts.contents) : []
    case 'QUANTITY':
      return [words.pieces(facts.contents.reduce((sum, content) => sum + content.quantity, 0))]
    case 'CARTON_NUMBER':
      return [`${facts.cartonNumber} ${words.of} ${facts.cartonCount}`]
    case 'GROSS_WEIGHT':
      return facts.grossWeightKg ? [`${decimalWords(facts.grossWeightKg, language)} kg`] : []
    case 'NET_WEIGHT':
      return facts.netWeightKg ? [`${decimalWords(facts.netWeightKg, language)} kg`] : []
    case 'DIMENSIONS': {
      const size = facts.dimensionsCm
      return size ? [`${decimalWords(size.length, language)} × ${decimalWords(size.width, language)} × ${decimalWords(size.height, language)} cm`] : []
    }
    case 'BATCH': {
      const batches = distinct(facts.contents.map((content) => content.batchNumber ?? ''))
      return batches.length > 0 ? [batches.join(', ')] : []
    }
    case 'ORIGIN': {
      const origins = distinct(facts.contents.map((content) => content.originCountry ?? ''))
      return origins.length > 0 ? [origins.map((code) => countryName(code, language)).join(', ')] : []
    }
  }
}

/** The marks of a carton from the template's fields and language. */
export function cartonMarks(fields: readonly ShippingMarkField[], language: string, facts: MarkFacts): CartonMarks {
  const lang = markLanguageOf(language)
  const words = WORDS[lang]
  const maker = facts.maker ? labelText(facts.maker) : ''
  const rows = fields.flatMap((field): MarkRow[] => {
    const lines = linesOf(field, facts, lang).map(labelText).filter((line) => line !== '')
    return lines.length === 0 ? [] : [{ field, label: words.fields[field], lines }]
  })
  return {
    language: lang,
    heading: maker === '' ? words.carton : `${words.carton} · ${maker}`,
    title: `${words.carton} ${facts.cartonNumber} ${words.of} ${facts.cartonCount}`,
    code: cartonMarkCode(facts.shipmentNumber, facts.cartonNumber),
    rows,
  }
}
