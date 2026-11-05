import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * The chemical register and the safety data sheet library (B-W2b-143; QHS-277 "Chemical list; assessment sits in the DVR
 * (D.Lgs. 81/2008 art. 223)", QHS-278 "SDS library; an SDS binder meets worker access today (REACH art. 35)"; design
 * plant.chemicals: tiles, register, SDS library, pop-ups Add chemical, Chemical, Print cabinet QR, new tabs SDS (PDF) and
 * Cabinet sheet), pure. The tables are factory-db health.prisma's Chemical and SafetyDataSheet (B-W2b-91); its guards
 * hold the same shape for every login (a name, a supplier as a party or by name, CLP codes each once, a place, a cabinet
 * as a code, the most kept above 0 with its unit, roles of the site and PPE of the company; a sheet a file of its chemical,
 * one CURRENT per chemical and language, a CURRENT one only SUPERSEDED). The law is named in words only as the plan names
 * it; no deadline is built in (the plan names none for a data sheet). Waste and restricted substances stay Later. Nothing
 * here is personal data and nothing is money.
 */

/** What a chemical is used for (factory-db ChemicalUse; the design's list, then OTHER). */
export const CHEMICAL_USES = ['GLUE', 'SOLVENT', 'PRIMER', 'FINISH', 'EDGE_PAINT', 'DYE', 'CLEANER', 'OIL', 'OTHER'] as const
export type ChemicalUse = (typeof CHEMICAL_USES)[number]

/** The nine GHS hazard pictograms (CLP Annex V; factory-db GhsPictogram). */
export const GHS_PICTOGRAMS = ['GHS01', 'GHS02', 'GHS03', 'GHS04', 'GHS05', 'GHS06', 'GHS07', 'GHS08', 'GHS09'] as const
export type GhsPictogram = (typeof GHS_PICTOGRAMS)[number]

export const SIGNAL_WORDS = ['DANGER', 'WARNING'] as const
export type SignalWord = (typeof SIGNAL_WORDS)[number]

export const QUANTITY_UNITS = ['ML', 'L', 'G', 'KG'] as const
export type QuantityUnit = (typeof QUANTITY_UNITS)[number]

export const CHEMICAL_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type ChemicalStatus = (typeof CHEMICAL_STATUSES)[number]

export const SHEET_STATUSES = ['CURRENT', 'SUPERSEDED'] as const
export type SheetStatus = (typeof SHEET_STATUSES)[number]

/** The law, in words, as the plan names it (W2B-PLAN B-W2b-143; SCOPE QHS-277, QHS-278). */
export const REGISTER_LAW = 'D.Lgs. 81/2008 art. 223'
export const SDS_LAW = 'REACH art. 35'

export const CHEMICAL_LIMITS = Object.freeze({ name: 200, place: 200, cabinet: 40, version: 50, note: 1000, reason: 500, statements: 40, list: 500 })

/** A hazard statement as CLP writes it: H225, H360Fd, H301+H311, EUH066 (factory-db's guard, the same pattern). */
export const HAZARD_CODE = /^(EUH[0-9]{3}[A-Za-z]?|H[0-9]{3}[A-Za-z]{0,2}(\+H[0-9]{3}[A-Za-z]{0,2})*)$/
/** A precautionary statement: P210, P305+P351+P338. */
export const PRECAUTION_CODE = /^P[0-9]{3}(\+P[0-9]{3})*$/

/**
 * The statements as typed ("h225, H319 ; euh066", "P305 + P351 + P338 P210") → the codes, each once, in the order typed.
 * The prefix (H, EUH, P) is put in capitals; the letters after an H code's digits (H360Fd: fertility, development) keep
 * their case, as CLP writes them.
 */
export function statementsOf(text: string): string[] {
  const joined = text.replace(/\s*\+\s*/g, '+')
  const out: string[] = []
  for (const raw of joined.split(/[\s,;]+/)) {
    const part = raw.trim()
    if (part === '') continue
    const code = part
      .split('+')
      .map((piece) => piece.replace(/^(euh|h|p)/i, (prefix) => prefix.toUpperCase()))
      .join('+')
    if (!out.includes(code)) out.push(code)
  }
  return out
}

/** The cabinet's code as stored: trimmed, in capitals; spaces are not allowed inside (the QR names it). */
export function cabinetCodeOf(text: string | null | undefined): string | null {
  const code = (text ?? '').trim().toUpperCase()
  return code === '' ? null : code
}

/** A decimal above 0 with at most four decimals (the most kept). */
const QUANTITY = /^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,4})?$/

/** A chemical as the Add chemical dialog and the record's Edit send it (the supplier's party is checked by the API). */
export interface ChemicalInput {
  readonly name: string
  readonly supplierPartyId?: string | null | undefined
  readonly supplierName?: string | null | undefined
  readonly use: ChemicalUse
  readonly ghsPictograms: readonly string[]
  readonly signalWord?: SignalWord | null | undefined
  readonly hazardStatements: readonly string[]
  readonly precautionStatements: readonly string[]
  readonly storagePlace: string
  readonly cabinetCode?: string | null | undefined
  readonly maxQuantity?: string | null | undefined
  readonly maxQuantityUnit?: QuantityUnit | null | undefined
  readonly roleSheetIds: readonly string[]
  readonly ppeItemIds: readonly string[]
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): boolean => (value ?? '').trim() === ''
const dupes = (values: readonly string[]): boolean => new Set(values).size !== values.length

/** What is wrong with a chemical as typed (the guard's rules in words; paths are the body's fields), empty when none. */
export function chemicalProblems(input: ChemicalInput): Issue[] {
  const problems: Issue[] = []
  if (blank(input.name) || input.name.trim().length > CHEMICAL_LIMITS.name) problems.push({ path: 'name', message: `Name the product (at most ${CHEMICAL_LIMITS.name} characters).` })
  if (!blank(input.supplierName) && input.supplierPartyId) problems.push({ path: 'supplierName', message: 'Name the supplier as a party or by name, one of the two.' })
  if ((input.supplierName ?? '').trim().length > CHEMICAL_LIMITS.name) problems.push({ path: 'supplierName', message: `The supplier's name has at most ${CHEMICAL_LIMITS.name} characters.` })
  if (input.ghsPictograms.some((code) => !(GHS_PICTOGRAMS as readonly string[]).includes(code)) || dupes(input.ghsPictograms)) problems.push({ path: 'ghsPictograms', message: 'Pick each GHS pictogram once.' })
  const badHazard = input.hazardStatements.find((code) => !HAZARD_CODE.test(code))
  if (badHazard !== undefined) problems.push({ path: 'hazardStatements', message: `"${badHazard}" is not a hazard statement as CLP writes it (H225, H319, EUH066).` })
  else if (dupes(input.hazardStatements) || input.hazardStatements.length > CHEMICAL_LIMITS.statements) problems.push({ path: 'hazardStatements', message: `List each hazard statement once (at most ${CHEMICAL_LIMITS.statements}).` })
  const badPrecaution = input.precautionStatements.find((code) => !PRECAUTION_CODE.test(code))
  if (badPrecaution !== undefined) problems.push({ path: 'precautionStatements', message: `"${badPrecaution}" is not a precautionary statement as CLP writes it (P210, P305+P351+P338).` })
  else if (dupes(input.precautionStatements) || input.precautionStatements.length > CHEMICAL_LIMITS.statements) problems.push({ path: 'precautionStatements', message: `List each precautionary statement once (at most ${CHEMICAL_LIMITS.statements}).` })
  if (input.signalWord && input.ghsPictograms.length === 0 && input.hazardStatements.length === 0) problems.push({ path: 'signalWord', message: 'A signal word comes with the hazards it warns of: add the pictograms or the hazard statements.' })
  if (blank(input.storagePlace) || input.storagePlace.trim().length > CHEMICAL_LIMITS.place) problems.push({ path: 'storagePlace', message: `Say where it is kept (at most ${CHEMICAL_LIMITS.place} characters).` })
  const cabinet = cabinetCodeOf(input.cabinetCode)
  if (cabinet !== null && (/\s/.test(cabinet) || cabinet.length > CHEMICAL_LIMITS.cabinet)) problems.push({ path: 'cabinetCode', message: `A cabinet's code has no spaces (at most ${CHEMICAL_LIMITS.cabinet} characters): CAB-CUT-1.` })
  const quantity = (input.maxQuantity ?? '').trim()
  if ((quantity === '') !== !input.maxQuantityUnit) problems.push({ path: quantity === '' ? 'maxQuantity' : 'maxQuantityUnit', message: 'The most kept comes with its unit: both, or neither.' })
  else if (quantity !== '' && (!QUANTITY.test(quantity) || !/[1-9]/.test(quantity))) problems.push({ path: 'maxQuantity', message: 'The most kept is a number above 0 (at most four decimals).' })
  if (dupes(input.roleSheetIds)) problems.push({ path: 'roleSheetIds', message: 'Name each role once.' })
  if (dupes(input.ppeItemIds)) problems.push({ path: 'ppeItemIds', message: 'Name each PPE item once.' })
  if ((input.note ?? '').trim().length > CHEMICAL_LIMITS.note) problems.push({ path: 'note', message: `A note has at most ${CHEMICAL_LIMITS.note} characters.` })
  return problems
}

/** ISO 639-1: two lower-case letters. */
export const isSheetLanguage = (value: string): boolean => /^[a-z]{2}$/.test(value)

/** A data sheet as the Replace SDS (and Add chemical) dialog sends it, besides its file. */
export interface SheetInput {
  readonly versionLabel: string
  readonly revisedOn: BusinessDate
  readonly language: string
}

/** What is wrong with a sheet's facts (paths are the body's fields), empty when none. */
export function sheetProblems(input: SheetInput, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (blank(input.versionLabel) || input.versionLabel.trim().length > CHEMICAL_LIMITS.version) problems.push({ path: 'versionLabel', message: `Type the sheet's version as the supplier wrote it (at most ${CHEMICAL_LIMITS.version} characters).` })
  if (input.revisedOn > today) problems.push({ path: 'revisedOn', message: 'The revision day is today at the latest.' })
  if (!isSheetLanguage(input.language)) problems.push({ path: 'language', message: 'Pick the language the sheet is written in.' })
  return problems
}

export const CHEMICAL_REFUSALS = [
  'ARCHIVED',
  'NOT_ARCHIVED',
  'SITE_OTHER_COMPANY',
  'SUPPLIER_OTHER_COMPANY',
  'ROLE_OTHER_SITE',
  'PPE_OTHER_COMPANY',
  'FILE_NOT_READY',
  'FILE_NOT_PDF',
  'OLDER_THAN_CURRENT',
  'SAME_VERSION',
] as const
export type ChemicalRefusalCode = (typeof CHEMICAL_REFUSALS)[number]
export interface ChemicalRefusal {
  readonly code: ChemicalRefusalCode
  readonly message: string
  readonly field?: string
}

/** A current sheet of the same language, as the record holds it. */
export interface CurrentSheet {
  readonly versionLabel: string
  readonly revisedOn: BusinessDate
}

/**
 * Replace SDS (the design's "new version"): the new sheet becomes the current one of its language and the current one is
 * kept, SUPERSEDED, in the same command. A replacement is newer: never a sheet revised before the current one, never the
 * same version again (null: it may replace it).
 */
export function replaceRefusal(current: CurrentSheet | null, input: SheetInput): ChemicalRefusal | null {
  if (current === null) return null
  if (input.revisedOn < current.revisedOn) return { code: 'OLDER_THAN_CURRENT', message: `This sheet was revised before the current one (version ${current.versionLabel} of ${current.revisedOn}): a replacement is the newer sheet.`, field: 'revisedOn' }
  if (input.versionLabel.trim().toLowerCase() === current.versionLabel.trim().toLowerCase()) return { code: 'SAME_VERSION', message: `Version ${current.versionLabel} in this language is the current sheet already.`, field: 'versionLabel' }
  return null
}

/** Where a chemical stands with its data sheets (the register's column and the tiles). */
export type SheetState = 'MISSING' | 'OTHER_LANGUAGE' | 'OK'

/**
 * "Products without SDS" = an active product with no current sheet at all. "SDS to request" = an active product whose
 * current sheets are none in the company's language: the workers who read the sheet at the cabinet need it in their own
 * (REACH art. 35, access to the information). An age after which a sheet is "old" is not set by the plan: none is built in.
 */
export function sheetStateOf(sheets: readonly { readonly status: SheetStatus; readonly language: string }[], language: string): SheetState {
  const current = sheets.filter((sheet) => sheet.status === 'CURRENT')
  if (current.length === 0) return 'MISSING'
  return current.some((sheet) => sheet.language === language) ? 'OK' : 'OTHER_LANGUAGE'
}

/**
 * The current sheet a reader opens first: the one in the reader's language, else the company's, else the newest.
 */
export function sheetFor<T extends { readonly status: SheetStatus; readonly language: string; readonly revisedOn: BusinessDate }>(sheets: readonly T[], languages: readonly string[]): T | null {
  const current = sheets.filter((sheet) => sheet.status === 'CURRENT')
  for (const language of languages) {
    const found = current.find((sheet) => sheet.language === language)
    if (found) return found
  }
  return [...current].sort((a, b) => b.revisedOn.localeCompare(a.revisedOn))[0] ?? null
}

// ---- the cabinet QR (design plant.chemicals pop-up "Print cabinet QR": cabinet name + QR to its list) ----

/** The floor page a cabinet's QR opens: what the tablet keeps of the site's register and current sheets (offline). */
export const CABINET_PATH = '/floor/sds'

/** The address a cabinet's QR holds: `<web>/floor/sds?cabinet=<code>`. */
export function cabinetAddress(origin: string, cabinetCode: string): string {
  return `${origin.replace(/\/+$/, '')}${CABINET_PATH}?cabinet=${encodeURIComponent(cabinetCode)}`
}

/**
 * The cabinet a scanned or typed code names: a cabinet QR's address (any host: a tablet reads what the office printed on
 * another address of the same factory), or null when it is no cabinet's QR.
 */
export function cabinetOfScan(text: string): string | null {
  const value = text.trim()
  const at = value.indexOf(CABINET_PATH)
  if (at < 0 || value.length > 400) return null
  const rest = value.slice(at + CABINET_PATH.length)
  if (rest !== '' && !rest.startsWith('?') && !rest.startsWith('#')) return null
  const query = rest.replace(/^[?#]/, '').split('#')[0] ?? ''
  const code = cabinetCodeOf(new URLSearchParams(query).get('cabinet'))
  return code !== null && !/\s/.test(code) && code.length <= CHEMICAL_LIMITS.cabinet ? code : null
}
