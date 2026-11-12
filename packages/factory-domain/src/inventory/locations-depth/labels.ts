import type { Issue } from '../../core/errors'
import { labelText, type LabelLanguage } from '../../labels/model'
import type { LaidOutLabel } from '../../labels/zpl'
import type { LocationKind } from '../locations/rules'

/**
 * Bin labels (B-W2b-289; SCM-178; design warehouse.locations › Location › Labels, "Print labels", the bin labels PDF), pure.
 * A place on the floor carries a printed label whose code (Location.labelCode) is what a scan reads: the factory's phone
 * or tablet camera (the Owner's answer Q4 = A: no handheld scanner, no device fields), to confirm a put-away, a move or a
 * count (B-W2b-292, -299). The code is unique in the tenant (a scan names one place), 1 to 64 letters, digits and
 * . _ : / - without spaces (the database's check), stored in capitals (a typed one is upper-cased, a scan too).
 *
 * The label (one layout with the scan labels of factory-domain labels/: the same geometry, ZPL for a label printer, PDF
 * for any printer): heading "Ubicazione · <maker>", the place's name as the title, the code as Code 128 bars and as text,
 * then the site, the place's path in the tree, its kind and its own code. Printing it is a print job of the location
 * (PrintJob recordType "Location", label kind LOCATION): its print history.
 */

/** The print job's label kind of a bin label (apps/factory-api platform/print MODULE_LABEL_KINDS). */
export const LOCATION_LABEL_KIND = 'LOCATION' as const
/** The print history's record type. */
export const LOCATION_RECORD = 'Location' as const

/** As the database checks it, on the capitals it stores. */
export const LABEL_CODE = /^[A-Z0-9][A-Z0-9._:/-]{0,63}$/
export const LABEL_CODE_MAX = 64

/** Labels printed or made into one PDF at once. */
export const MAX_LABELS_AT_ONCE = 200
/** Copies of each label in one print. */
export const MAX_BIN_LABEL_COPIES = 10

/** A typed or scanned code as stored: trimmed, in capitals. */
export const normalizeLabelCode = (code: string): string => code.trim().toUpperCase()

/** The problems of a label code (path `labelCode`). */
export function labelCodeProblems(code: string): Issue[] {
  return LABEL_CODE.test(code) ? [] : [{ path: 'labelCode', message: 'Expected 1 to 64 letters, digits and . _ : / - without spaces (the code the bin label carries).' }]
}

/**
 * The code a place gets when it is given none: its own code, after its site's code when that is not already its start
 * (`A1-STORE-01` on site A1 stays `A1-STORE-01`; `R4-02` on site A1 becomes `A1-R4-02`), so it is unique in the tenant
 * as long as site codes are. Cut to 64 characters.
 */
export function suggestedLabelCode(siteCode: string, locationCode: string): string {
  const site = normalizeLabelCode(siteCode).replace(/[^A-Z0-9._:/-]/g, '')
  const own = normalizeLabelCode(locationCode).replace(/[^A-Z0-9._:/-]/g, '')
  const code = site === '' || own === site || own.startsWith(`${site}-`) ? own : `${site}-${own}`
  return code.slice(0, LABEL_CODE_MAX)
}

/** What a bin label prints of its place. */
export interface BinLabelFacts {
  readonly labelCode: string
  readonly maker: string | null
  readonly name: string
  readonly siteCode: string
  /** The codes from the top of the site's tree down to this one. */
  readonly path: readonly string[]
  readonly kind: LocationKind
  readonly code: string
}

/** One bin label, laid out as the scan labels are (factory-domain labels/zpl labelZpl, the API's label PDF). */
export interface BinLabel extends LaidOutLabel {
  readonly language: LabelLanguage
}

const WORDS = Object.freeze({
  it: {
    heading: 'Ubicazione',
    site: 'Sito',
    path: 'Percorso',
    kind: 'Tipo',
    code: 'Codice',
    kinds: {
      WAREHOUSE: 'Magazzino',
      ZONE: 'Zona',
      BIN: 'Scaffale',
      RECEIVING: 'Ricevimento',
      QUARANTINE: 'Quarantena',
      PRODUCTION: 'Bordo linea',
      SHIPPING: 'Spedizione',
      SUBCONTRACTOR: 'Terzista',
      FINISHED_GOODS: 'Prodotti finiti',
      CUSTOMER: 'Presso cliente',
      TRANSIT: 'In transito',
      PICK_FACE: 'Prelievo',
      BULK: 'Scorta',
    },
  },
  en: {
    heading: 'Location',
    site: 'Site',
    path: 'Path',
    kind: 'Kind',
    code: 'Code',
    kinds: {
      WAREHOUSE: 'Warehouse',
      ZONE: 'Zone',
      BIN: 'Bin',
      RECEIVING: 'Goods in',
      QUARANTINE: 'Quarantine',
      PRODUCTION: 'Line side',
      SHIPPING: 'Shipping',
      SUBCONTRACTOR: 'Workshop',
      FINISHED_GOODS: 'Finished goods',
      CUSTOMER: 'At a customer',
      TRANSIT: 'In transit',
      PICK_FACE: 'Pick face',
      BULK: 'Bulk',
    },
  },
} as const satisfies Record<LabelLanguage, { heading: string; site: string; path: string; kind: string; code: string; kinds: Record<LocationKind, string> }>)

/** The bin label of a place in a language (its code must be a valid label code: the caller checked it). */
export function binLabel(facts: BinLabelFacts, language: LabelLanguage): BinLabel {
  const words = WORDS[language]
  const maker = facts.maker ? labelText(facts.maker) : ''
  const fields = [
    { label: words.site, value: facts.siteCode },
    { label: words.kind, value: words.kinds[facts.kind] },
    { label: words.path, value: facts.path.join(' › ') },
    { label: words.code, value: facts.code },
  ]
    .map((field) => ({ label: field.label, value: labelText(field.value) }))
    .filter((field) => field.value !== '')
  return {
    language,
    heading: maker === '' ? words.heading : `${words.heading} · ${maker}`,
    title: labelText(facts.name) || facts.code,
    scanId: facts.labelCode,
    fields,
  }
}
