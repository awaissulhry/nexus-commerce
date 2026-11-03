import { CHEMICAL_REFUSALS, CHEMICAL_USES, chemicalProblems, isSheetLanguage, QUANTITY_UNITS, sheetProblems, statementsOf, type ChemicalUse, type QuantityUnit, type SignalWord } from '@nexus/factory-domain/safety/chemicals/rules'
import { issuePath, isApiError } from '../../../lib/api/errors'
import type { Chemical, ChemicalBody, CountsAnswer, SheetFacts } from './api'

/**
 * Plant › Health & safety › Chemicals & waste (SCR-213; B-W2b-143; design plant.chemicals): the page's rules, pure. The address
 * ⇄ the page's state (a tile is a filter of the register; every dialog lives in the address), the tiles, the dialogs' drafts
 * with why their buttons are held and what they send (factory-domain safety/chemicals/rules decides what is well formed: the
 * screen and the API say the same), and the API's refusals in our words. No person and no money anywhere.
 */

// ---- who may do what ------------------------------------------------------------------------------------------------------

export interface ChemicalsCan {
  readonly view: boolean
  readonly manage: boolean
}

export const chemicalsCan = (permissions: readonly string[]): ChemicalsCan => ({ view: permissions.includes('safety.view'), manage: permissions.includes('safety.chemicals.manage') })

// ---- the address ------------------------------------------------------------------------------------------------------------

export const TILES = ['active', 'withoutSds', 'toRequest', 'cabinets'] as const
export type TileId = (typeof TILES)[number]
export type RegisterTile = 'withoutSds' | 'toRequest'
export type RegisterStatus = 'ACTIVE' | 'ARCHIVED' | 'all'
/** What the open chemical's window shows: its facts, the edit form, Replace SDS, Archive. */
export type ChemicalMode = 'view' | 'edit' | 'replace' | 'archive'

/**
 * `?tile=withoutSds|toRequest&status=ACTIVE|ARCHIVED|all&use=<USE>&cabinet=<code>&q=&open=<id>&do=edit|replace|archive
 * &sheet=<sheet id>&new=1&qr=1` — the register's filters are the API's own (the export reads the same terms).
 */
export interface ChemicalsAddress {
  tile: RegisterTile | null
  status: RegisterStatus
  use: ChemicalUse | null
  cabinet: string | null
  q: string
  open: string | null
  mode: ChemicalMode
  sheet: string | null
  add: boolean
  qr: boolean
}

export const EMPTY_ADDRESS: ChemicalsAddress = { tile: null, status: 'ACTIVE', use: null, cabinet: null, q: '', open: null, mode: 'view', sheet: null, add: false, qr: false }

const MODES: readonly ChemicalMode[] = ['view', 'edit', 'replace', 'archive']

export function addressOf(params: { get(name: string): string | null }): ChemicalsAddress {
  const tile = params.get('tile')
  const status = params.get('status')
  const use = params.get('use')
  const mode = params.get('do')
  return {
    tile: tile === 'withoutSds' || tile === 'toRequest' ? tile : null,
    status: status === 'ARCHIVED' || status === 'all' ? status : 'ACTIVE',
    use: use && (CHEMICAL_USES as readonly string[]).includes(use) ? (use as ChemicalUse) : null,
    cabinet: params.get('cabinet')?.trim() || null,
    q: params.get('q')?.trim().slice(0, 80) ?? '',
    open: params.get('open')?.trim() || null,
    mode: mode && (MODES as readonly string[]).includes(mode) ? (mode as ChemicalMode) : 'view',
    sheet: params.get('sheet')?.trim() || null,
    add: params.get('new') === '1',
    qr: params.get('qr') === '1',
  }
}

/** The address with a change: opening another chemical starts on its facts; closing it clears its mode. */
export function withAddress(address: ChemicalsAddress, change: Partial<ChemicalsAddress>): ChemicalsAddress {
  const next = { ...address, ...change }
  if ('open' in change && change.open !== address.open && !('mode' in change)) next.mode = 'view'
  if (next.open === null) {
    next.mode = 'view'
    next.sheet = null
  }
  return next
}

export function addressText(address: ChemicalsAddress): string {
  const params = new URLSearchParams()
  if (address.tile) params.set('tile', address.tile)
  if (address.status !== 'ACTIVE') params.set('status', address.status)
  if (address.use) params.set('use', address.use)
  if (address.cabinet) params.set('cabinet', address.cabinet)
  if (address.q) params.set('q', address.q)
  if (address.open) params.set('open', address.open)
  if (address.open && address.mode !== 'view') params.set('do', address.mode)
  if (address.open && address.sheet) params.set('sheet', address.sheet)
  if (address.add) params.set('new', '1')
  if (address.qr) params.set('qr', '1')
  const text = params.toString()
  return text ? `?${text}` : ''
}

// ---- the tiles ----------------------------------------------------------------------------------------------------------------

export interface Tile {
  readonly id: TileId
  readonly value: number | null
}

/** The design's tiles that are built (restricted substances and waste stay Later: never a tile that says nothing). */
export const tilesOf = (counts: CountsAnswer | null): Tile[] => TILES.map((id) => ({ id, value: counts ? counts[id === 'active' ? 'active' : id] : null }))

// ---- the register's words ----------------------------------------------------------------------------------------------------

/** Where a product's sheets stand, as a message key. */
export const sheetStateKey = (state: Chemical['sheetState']): string => `sds.state.${state}`

/** The most kept, in words ("25 l"): the unit's word is the catalogue's. */
export const quantityOf = (row: Pick<Chemical, 'maxQuantity' | 'maxQuantityUnit'>, unit: (code: QuantityUnit) => string): string | null => (row.maxQuantity && row.maxQuantityUnit ? `${row.maxQuantity.replace('.', ',')} ${unit(row.maxQuantityUnit)}` : null)

/** Where it is kept: the place and its cabinet. */
export const placeOf = (row: Pick<Chemical, 'storagePlace' | 'cabinetCode'>): string => (row.cabinetCode ? `${row.storagePlace} · ${row.cabinetCode}` : row.storagePlace)

/** The current sheet a reader opens first: the company's language, else the newest. */
export const firstSheet = (row: Pick<Chemical, 'current' | 'language'>) => row.current.find((sheet) => sheet.language === row.language) ?? row.current[0] ?? null

/** The sheets in words for the register's column ("3.1 · it, en · 25 Aug 2026"). */
export function sheetsText(row: Pick<Chemical, 'current'>, day: (value: string) => string, none: string): string {
  if (row.current.length === 0) return none
  const newest = row.current[0]!
  return `${newest.versionLabel} · ${row.current.map((sheet) => sheet.language).join(', ')} · ${day(newest.revisedOn)}`
}

// ---- the chemical's draft (Add chemical, Edit) --------------------------------------------------------------------------------

export interface ChemicalDraft {
  siteId: string | null
  name: string
  supplierMode: 'party' | 'name'
  supplierPartyId: string | null
  supplierName: string
  use: ChemicalUse | ''
  ghsPictograms: string[]
  signalWord: SignalWord | ''
  hazards: string
  precautions: string
  storagePlace: string
  cabinetCode: string
  maxQuantity: string
  maxQuantityUnit: QuantityUnit | ''
  roleSheetIds: string[]
  ppeItemIds: string[]
  note: string
}

export const EMPTY_DRAFT: ChemicalDraft = {
  siteId: null,
  name: '',
  supplierMode: 'name',
  supplierPartyId: null,
  supplierName: '',
  use: '',
  ghsPictograms: [],
  signalWord: '',
  hazards: '',
  precautions: '',
  storagePlace: '',
  cabinetCode: '',
  maxQuantity: '',
  maxQuantityUnit: '',
  roleSheetIds: [],
  ppeItemIds: [],
  note: '',
}

/** The draft of an existing chemical (Edit). */
export function draftOf(row: Chemical): ChemicalDraft {
  return {
    siteId: row.siteId,
    name: row.name,
    supplierMode: row.supplier.partyId ? 'party' : 'name',
    supplierPartyId: row.supplier.partyId,
    supplierName: row.supplier.partyId ? '' : (row.supplier.name ?? ''),
    use: row.use,
    ghsPictograms: [...row.ghsPictograms],
    signalWord: row.signalWord ?? '',
    hazards: row.hazardStatements.join(' '),
    precautions: row.precautionStatements.join(' '),
    storagePlace: row.storagePlace,
    cabinetCode: row.cabinetCode ?? '',
    maxQuantity: row.maxQuantity ?? '',
    maxQuantityUnit: row.maxQuantityUnit ?? '',
    roleSheetIds: row.roles.map((role) => role.id),
    ppeItemIds: row.ppe.map((item) => item.id),
    note: row.note ?? '',
  }
}

/** A decimal typed with a comma ("2,5") as the API takes it ("2.5"). */
const decimalOf = (text: string): string => text.trim().replace(',', '.')

/** What the draft sends (the API stores the statements in CLP's writing and the cabinet in capitals). */
export function bodyOf(draft: ChemicalDraft): ChemicalBody {
  return {
    name: draft.name.trim(),
    supplierPartyId: draft.supplierMode === 'party' ? draft.supplierPartyId : null,
    supplierName: draft.supplierMode === 'name' && draft.supplierName.trim() !== '' ? draft.supplierName.trim() : null,
    use: (draft.use || 'OTHER') as ChemicalUse,
    ghsPictograms: [...draft.ghsPictograms],
    signalWord: draft.signalWord || null,
    hazardStatements: statementsOf(draft.hazards),
    precautionStatements: statementsOf(draft.precautions),
    storagePlace: draft.storagePlace.trim(),
    cabinetCode: draft.cabinetCode.trim() === '' ? null : draft.cabinetCode.trim().toUpperCase(),
    maxQuantity: draft.maxQuantity.trim() === '' ? null : decimalOf(draft.maxQuantity),
    maxQuantityUnit: draft.maxQuantityUnit || null,
    roleSheetIds: [...draft.roleSheetIds],
    ppeItemIds: [...draft.ppeItemIds],
    note: draft.note.trim() === '' ? null : draft.note.trim(),
  }
}

/** The fields at fault in the draft (the domain's rules) → their message keys, the first one being why Add is held. */
export function draftProblems(draft: ChemicalDraft, needsSite: boolean): { field: string; key: string }[] {
  const problems: { field: string; key: string }[] = []
  if (needsSite && !draft.siteId) problems.push({ field: 'siteId', key: 'held.site' })
  if (draft.use === '') problems.push({ field: 'use', key: 'held.use' })
  if (draft.supplierMode === 'party' && !draft.supplierPartyId) problems.push({ field: 'supplierPartyId', key: 'held.supplierParty' })
  for (const problem of chemicalProblems(bodyOf(draft))) if (!problems.some((entry) => entry.field === problem.path)) problems.push({ field: problem.path, key: `held.${problem.path}` })
  return problems
}

/** The first statement as typed that CLP would not take, to show beside its field. */
export function badStatement(text: string, kind: 'hazard' | 'precaution'): string | null {
  const pattern = kind === 'hazard' ? /^(EUH[0-9]{3}[A-Za-z]?|H[0-9]{3}[A-Za-z]{0,2}(\+H[0-9]{3}[A-Za-z]{0,2})*)$/ : /^P[0-9]{3}(\+P[0-9]{3})*$/
  return statementsOf(text).find((code) => !pattern.test(code)) ?? null
}

/** Whether the edit changes anything (Save is held "Nothing changed" otherwise). */
export function draftChanged(row: Chemical, draft: ChemicalDraft): boolean {
  return JSON.stringify(bodyOf(draftOf(row))) !== JSON.stringify(bodyOf(draft))
}

// ---- the sheet's facts (Replace SDS; the first sheet of Add chemical) ---------------------------------------------------------

/** The languages a sheet is offered in (the company's first); a sheet in another is typed by its code. */
export const SHEET_LANGUAGES = ['it', 'en', 'de', 'fr', 'es', 'pt', 'ro', 'pl', 'ar', 'zh'] as const

export interface SheetDraft {
  file: { name: string; type: string; size: number } | null
  versionLabel: string
  revisedOn: string
  language: string
}

export const sheetDraft = (language: string): SheetDraft => ({ file: null, versionLabel: '', revisedOn: '', language })

/** Why the sheet cannot be sent yet, as a message key (null: it can). */
export function sheetHeld(draft: SheetDraft, today: string, busy = false): string | null {
  if (busy) return 'held.busy'
  if (!draft.file) return 'held.file'
  if (draft.file.type && draft.file.type !== 'application/pdf') return 'held.pdf'
  if (draft.versionLabel.trim() === '') return 'held.versionLabel'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.revisedOn)) return 'held.revisedOn'
  const problem = sheetProblems({ versionLabel: draft.versionLabel, revisedOn: draft.revisedOn, language: draft.language }, today)[0]
  if (problem) return problem.path === 'revisedOn' ? 'held.revisedFuture' : `held.${problem.path}`
  if (!isSheetLanguage(draft.language)) return 'held.language'
  return null
}

export const factsOf = (draft: SheetDraft): SheetFacts => ({ versionLabel: draft.versionLabel.trim(), revisedOn: draft.revisedOn, language: draft.language })

/**
 * What Replace SDS will do, in words: the sheet it replaces in that language (kept, superseded), or "the first sheet in
 * <language>"; refused before sending when it is older than the current one or the same version (the API says the same).
 */
export function replaceWords(row: Pick<Chemical, 'current'>, draft: SheetDraft): { key: string; params: Record<string, string> } {
  const current = row.current.find((sheet) => sheet.language === draft.language)
  if (!current) return { key: 'replace.first', params: { language: draft.language } }
  if (draft.revisedOn && draft.revisedOn < current.revisedOn) return { key: 'refusal.OLDER_THAN_CURRENT', params: { version: current.versionLabel } }
  if (draft.versionLabel.trim() && draft.versionLabel.trim().toLowerCase() === current.versionLabel.trim().toLowerCase()) return { key: 'refusal.SAME_VERSION', params: { version: current.versionLabel } }
  return { key: 'replace.supersedes', params: { version: current.versionLabel, language: current.language } }
}

/** Replace SDS's button is also held when the sheet would be refused (older, the same version). */
export function replaceHeld(row: Pick<Chemical, 'current' | 'status'>, draft: SheetDraft, today: string, busy = false): string | null {
  if (row.status !== 'ACTIVE') return 'held.archived'
  const held = sheetHeld(draft, today, busy)
  if (held) return held
  const words = replaceWords(row, draft)
  return words.key.startsWith('refusal.') ? words.key : null
}

// ---- archive --------------------------------------------------------------------------------------------------------------

export const archiveHeld = (reason: string, busy: boolean): string | null => (busy ? 'held.busy' : reason.trim() === '' ? 'held.reason' : null)

// ---- the API's answers in our words --------------------------------------------------------------------------------------------

export interface Problem {
  readonly key: string
  readonly field: string | null
  readonly unknown?: boolean
}

const REFUSALS = new Set<string>(CHEMICAL_REFUSALS)

export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null, unknown: true }
  let refusal: string | null = null
  let field: string | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (REFUSALS.has(code)) refusal = code
    } else if (/^body[./]/.test(path) && !field) {
      field = path.replace(/^body[./]/, '').split(/[./]/)[0] || null
    }
  }
  if (refusal) return { key: `refusal.${refusal}`, field }
  switch (error.kind) {
    case 'invalid':
      return { key: field ? `held.${field}` : 'problem.invalid', field }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null }
    case 'forbidden':
      return { key: 'problem.forbidden', field: null }
    case 'not_found':
      return { key: 'problem.notFound', field: null }
    case 'conflict':
      return { key: 'problem.conflict', field: null }
    case 'rate_limited':
      return { key: 'problem.rateLimited', field: null }
    case 'unavailable':
      return error.code === 'network' ? { key: 'problem.noAnswer', field: null, unknown: true } : { key: 'problem.unavailable', field: null }
    default:
      return { key: 'problem.internal', field: null }
  }
}

/** A read that failed, in words (a section says it and offers Try again; never drawn as empty). */
export const readProblemOf = (error: unknown): string => {
  const problem = problemOf(error)
  return problem.key === 'problem.forbidden' || problem.key === 'problem.signedOut' || problem.key === 'problem.notFound' ? problem.key : 'problem.read'
}

/** The problem's words at a field, when it names that field. */
export const atField = (problem: Problem | null, ...fields: readonly string[]): string | null => (problem && problem.field && fields.includes(problem.field) ? problem.key : null)

// ---- live ---------------------------------------------------------------------------------------------------------------------

/** chemical.changed and sds.replaced (design "live: sds.replaced → register") move the register, the tiles and the library. */
export const isChemicalsChange = (change: { readonly type: string }): boolean => change.type === 'chemical.changed' || change.type === 'sds.replaced'

export { QUANTITY_UNITS, CHEMICAL_USES }
