import { ValidationError, type Issue } from '../core/errors'
import { parseScanId, type ScanType } from '../numbering/scan-id'

/**
 * Labels for physical things (plan A1 §3.9; GAP-007; PLT-126): a hide, a lot, a bundle, a carton. Each carries its
 * scannable id (`HD-7K-0003RJ-M`, numbering/scan-id.ts) as a Code 128 barcode and as text a person can type, a heading
 * (what it is and whose), a title line and a few fields. The module that prints a label (receiving for hides and lots,
 * cutting for bundles, shipping for cartons) builds the input from its record; `composeLabel` checks and words it once,
 * and the same composition becomes ZPL for a label printer (./zpl.ts) or a PDF for any printer (the API).
 */

export const LABEL_KINDS = ['HIDE', 'LOT', 'BUNDLE', 'CARTON'] as const
export type LabelKind = (typeof LABEL_KINDS)[number]

export const LABEL_LANGUAGES = ['it', 'en'] as const
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number]

/** The scan type each label carries: a hide label holds a hide's code, never a bundle's. */
export const LABEL_SCAN_TYPE: Readonly<Record<LabelKind, ScanType>> = Object.freeze({ HIDE: 'HIDE', LOT: 'LOT', BUNDLE: 'BUNDLE', CARTON: 'CARTON' })

/** The fields each kind prints, in print order (two columns, at most six). */
export const LABEL_FIELDS = Object.freeze({
  HIDE: ['article', 'colour', 'grade', 'area', 'thickness', 'lot'],
  LOT: ['article', 'supplier', 'supplierLot', 'quantity', 'received'],
  BUNDLE: ['workOrder', 'style', 'size', 'colour', 'pieces', 'operation'],
  CARTON: ['order', 'customer', 'carton', 'contents', 'grossWeight'],
} as const satisfies Record<LabelKind, readonly string[]>)
export type LabelFieldKey = (typeof LABEL_FIELDS)[LabelKind][number]

const WORDS: Readonly<Record<LabelLanguage, { readonly kinds: Readonly<Record<LabelKind, string>>; readonly fields: Readonly<Record<LabelFieldKey, string>> }>> = {
  it: {
    kinds: { HIDE: 'Pelle', LOT: 'Lotto', BUNDLE: 'Fascio', CARTON: 'Collo' },
    fields: {
      article: 'Articolo',
      colour: 'Colore',
      grade: 'Scelta',
      area: 'Superficie',
      thickness: 'Spessore',
      lot: 'Lotto',
      supplier: 'Fornitore',
      supplierLot: 'Lotto fornitore',
      quantity: 'Quantità',
      received: 'Ricevuto il',
      workOrder: 'Ordine di lavoro',
      style: 'Modello',
      size: 'Taglia',
      pieces: 'Pezzi',
      operation: 'Fase',
      order: 'Ordine',
      customer: 'Cliente',
      carton: 'Collo',
      contents: 'Contenuto',
      grossWeight: 'Peso lordo',
    },
  },
  en: {
    kinds: { HIDE: 'Hide', LOT: 'Lot', BUNDLE: 'Bundle', CARTON: 'Carton' },
    fields: {
      article: 'Article',
      colour: 'Colour',
      grade: 'Grade',
      area: 'Area',
      thickness: 'Thickness',
      lot: 'Lot',
      supplier: 'Supplier',
      supplierLot: 'Supplier lot',
      quantity: 'Quantity',
      received: 'Received',
      workOrder: 'Work order',
      style: 'Style',
      size: 'Size',
      pieces: 'Pieces',
      operation: 'Operation',
      order: 'Order',
      customer: 'Customer',
      carton: 'Carton',
      contents: 'Contents',
      grossWeight: 'Gross weight',
    },
  },
}

/** What a module asks to print. Field values are the words as they should read ("5,42 m²", "3/12"). */
export interface LabelInput {
  readonly kind: LabelKind
  readonly language: LabelLanguage
  /** The thing's scannable id, as formatScanId printed it (or typed: it is read again and printed canonically). */
  readonly scanId: string
  /** Whose it is: the company's short name, printed in the heading. */
  readonly maker?: string | null
  /** The main line: the article of a hide or lot, the style of a bundle, the order of a carton. */
  readonly title: string
  readonly fields?: Readonly<Partial<Record<LabelFieldKey, string | null>>>
}

export interface ComposedLabel {
  readonly kind: LabelKind
  readonly language: LabelLanguage
  /** The canonical code: the barcode's data and the human-readable line. */
  readonly scanId: string
  /** "Pelle · Seed A". */
  readonly heading: string
  readonly title: string
  readonly fields: readonly { readonly key: LabelFieldKey; readonly label: string; readonly value: string }[]
}

/** The longest value a label keeps (the layout cuts what does not fit its line). */
export const LABEL_TEXT_MAX = 80

/** Text as a label holds it: no control characters, spaces collapsed, at most LABEL_TEXT_MAX characters. */
export function labelText(value: string): string {
  return [...value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, LABEL_TEXT_MAX).join('')
}

/** Every reason the label cannot be printed (empty when it can). `tenantTag` refuses another factory's code. */
export function labelProblems(input: LabelInput, options: { readonly tenantTag?: string } = {}): Issue[] {
  if (!(LABEL_KINDS as readonly string[]).includes(input?.kind)) return [{ path: 'label/kind', message: `A label is one of ${LABEL_KINDS.join(', ')}.` }]
  const problems: Issue[] = []
  if (!(LABEL_LANGUAGES as readonly string[]).includes(input.language)) problems.push({ path: 'label/language', message: 'Labels are printed in it or en.' })
  const scan = parseScanId(input.scanId, { types: [LABEL_SCAN_TYPE[input.kind]], ...(options.tenantTag === undefined ? {} : { tenantTag: options.tenantTag }) })
  if (!scan.ok) problems.push({ path: 'label/scanId', message: scan.message })
  if (typeof input.title !== 'string' || labelText(input.title) === '') problems.push({ path: 'label/title', message: 'A label needs its main line.' })
  const allowed = LABEL_FIELDS[input.kind] as readonly string[]
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (!allowed.includes(key)) problems.push({ path: `label/fields/${key}`, message: `A ${input.kind.toLowerCase()} label prints ${allowed.join(', ')}.` })
    else if (value !== null && value !== undefined && typeof value !== 'string') problems.push({ path: `label/fields/${key}`, message: 'Expected text.' })
  }
  return problems
}

/** The label with its words, ready for ZPL or PDF. Throws a ValidationError listing every problem. */
export function composeLabel(input: LabelInput, options: { readonly tenantTag?: string } = {}): ComposedLabel {
  const problems = labelProblems(input, options)
  if (problems.length > 0) throw new ValidationError('The label cannot be printed as it stands.', problems)
  const scan = parseScanId(input.scanId)
  if (!scan.ok) throw new ValidationError(scan.message)
  const words = WORDS[input.language]
  const maker = typeof input.maker === 'string' ? labelText(input.maker) : ''
  const fields = (LABEL_FIELDS[input.kind] as readonly LabelFieldKey[]).flatMap((key) => {
    const value = input.fields?.[key]
    const text = typeof value === 'string' ? labelText(value) : ''
    return text === '' ? [] : [{ key, label: words.fields[key], value: text }]
  })
  return {
    kind: input.kind,
    language: input.language,
    scanId: scan.text,
    heading: maker === '' ? words.kinds[input.kind] : `${words.kinds[input.kind]} · ${maker}`,
    title: labelText(input.title),
    fields,
  }
}
