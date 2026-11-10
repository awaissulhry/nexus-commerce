import { CELL_STATES, type CoverageKind, type CoverageState } from '@nexus/factory-domain/compliance/declarations/coverage'
import { REASON_MAX, REASON_MIN, WORDS_MAX } from '@nexus/factory-domain/compliance/declarations/rules'
import { SECTION_LAW, type SectionKey } from '@nexus/factory-domain/compliance/user-information/template'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import type { ApiProblem, Coverage, CoverageRow, DeclarationDetail, DeclarationRow, DocKind, DocStatus, LeafletDetail, ProtectorPosition, Source, SpareProtector, TimelineGroup, LanguagePack } from './api'

/**
 * Compliance › Declarations & instructions (SCR-052; B-W2b-268), the pure rules: the page's and the record's addresses, what
 * each person may do (the API's permissions), the tiles as saved filters, the grid's tree order (style › kind › language),
 * the language coverage's gaps, a declaration and a leaflet read as ONE record shape (their points or sections with the law
 * each answers and where each value came from), the Content draft and what it sends, the issue readiness (GATE-PPE-TEXTS:
 * a generated document is a draft until a PPE consultant checks its template — never issued here), the withdraw and translate
 * holds, and every API refusal said by its code in our words. Nothing here reads or draws.
 */

export const KINDS: readonly DocKind[] = ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION']
export const STATUSES: readonly DocStatus[] = ['DRAFT', 'ISSUED', 'SUPERSEDED', 'WITHDRAWN']
export const ORIGINS = ['SIGNED', 'GENERATED'] as const
export type Origin = (typeof ORIGINS)[number]

/** The law each kind answers (LawRef). */
export const LAW = {
  doc: 'Reg. (EU) 2016/425 art. 15, Annex IX',
  userInformation: 'Reg. (EU) 2016/425 art. 8(7), Annex II 1.4',
  docWithGoods: 'Reg. (EU) 2016/425 art. 8(8)',
  href: 'https://eur-lex.europa.eu/eli/reg/2016/425/oj',
} as const

// ---- who may do what ----------------------------------------------------------------------------------------------------------

export interface DeclarationsCan {
  /** Read every declaration and leaflet, the coverage and the tiles (compliance.certificates.view). */
  readonly view: boolean
  /** Generate, type, refresh, translate and withdraw a DoC draft. */
  readonly generate: boolean
  /** Check a DoC translation (a second person). */
  readonly check: boolean
  /** The same for user information. */
  readonly uiGenerate: boolean
  readonly uiCheck: boolean
  /** Record which version travelled with a shipment's batches (W1's compliance.declarations.manage). */
  readonly manage: boolean
  /** Build a shipment's compliance pack. */
  readonly pack: boolean
  /** Read a shipment's pack (shipping.view). */
  readonly shipping: boolean
}

export function declarationsCan(permissions: readonly string[]): DeclarationsCan {
  const has = (permission: string) => permissions.includes(permission)
  return {
    view: has('compliance.certificates.view'),
    generate: has('compliance.declarations.generate'),
    check: has('compliance.declarations.check'),
    uiGenerate: has('compliance.userInformation.generate'),
    uiCheck: has('compliance.userInformation.check'),
    manage: has('compliance.declarations.manage'),
    pack: has('compliance.declarations.pack'),
    shipping: has('shipping.view'),
  }
}

/** May this person make drafts of this kind? */
export const mayGenerate = (can: DeclarationsCan, kind: DocKind): boolean => (kind === 'USER_INFORMATION' ? can.uiGenerate : can.generate)
/** May this person make a draft of any kind? */
export const mayGenerateAny = (can: DeclarationsCan): boolean => can.generate || can.uiGenerate

// ---- the page's address -------------------------------------------------------------------------------------------------------

/**
 * `/w/<company>/compliance/declarations?kind=&status=&origin=&language=&q=&gaps=1&new=1&style=&newKind=&check=1&unrecorded=1`:
 * the grid's filters are the API's own (the export reads the same terms); `gaps=1` shows only the coverage rows with a missing
 * language (the "Languages missing" tile); `new=1` opens New declaration (`style`, `newKind`, `lang` prefill it, as the style's
 * Compliance tab and a coverage cell do); `check=1` the Language check; `unrecorded=1` the batches that left without a version.
 */
export interface DeclarationsAddress {
  readonly kind: DocKind | null
  readonly status: DocStatus | null
  readonly origin: Origin | null
  readonly language: string | null
  readonly q: string
  readonly gaps: boolean
  readonly add: boolean
  readonly newStyle: string | null
  readonly newKind: DocKind | null
  readonly newLanguage: string | null
  readonly check: boolean
  readonly unrecorded: boolean
}

export const EMPTY_ADDRESS: DeclarationsAddress = { kind: null, status: null, origin: null, language: null, q: '', gaps: false, add: false, newStyle: null, newKind: null, newLanguage: null, check: false, unrecorded: false }

const LANGUAGE_TAG = /^[a-z]{2,3}$/
const oneOf = <T extends string>(list: readonly T[], value: string | null | undefined): T | null => (value && (list as readonly string[]).includes(value) ? (value as T) : null)

export function addressOf(params: { get(name: string): string | null } | null): DeclarationsAddress {
  const get = (name: string) => params?.get(name) ?? null
  const language = get('language')
  const newLanguage = get('lang')
  return {
    kind: oneOf(KINDS, get('kind')),
    status: oneOf(STATUSES, get('status')),
    origin: oneOf(ORIGINS, get('origin')),
    language: language && LANGUAGE_TAG.test(language) ? language : null,
    q: (get('q') ?? '').slice(0, 100),
    gaps: get('gaps') === '1',
    add: get('new') === '1',
    newStyle: get('style'),
    newKind: oneOf(KINDS, get('newKind')),
    newLanguage: newLanguage && LANGUAGE_TAG.test(newLanguage) ? newLanguage : null,
    check: get('check') === '1',
    unrecorded: get('unrecorded') === '1',
  }
}

export const withAddress = (address: DeclarationsAddress, change: Partial<DeclarationsAddress>): DeclarationsAddress => {
  const next = { ...address, ...change }
  // Closing New declaration forgets what prefilled it.
  return next.add ? next : { ...next, newStyle: null, newKind: null, newLanguage: null }
}

export function addressText(address: DeclarationsAddress): string {
  const search = new URLSearchParams()
  if (address.kind) search.set('kind', address.kind)
  if (address.status) search.set('status', address.status)
  if (address.origin) search.set('origin', address.origin)
  if (address.language) search.set('language', address.language)
  if (address.q) search.set('q', address.q)
  if (address.gaps) search.set('gaps', '1')
  if (address.add) {
    search.set('new', '1')
    if (address.newStyle) search.set('style', address.newStyle)
    if (address.newKind) search.set('newKind', address.newKind)
    if (address.newLanguage) search.set('lang', address.newLanguage)
  }
  if (address.check) search.set('check', '1')
  if (address.unrecorded) search.set('unrecorded', '1')
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const isFiltered = (address: DeclarationsAddress): boolean => !!(address.kind || address.status || address.origin || address.language || address.q)

/** The page's address of New declaration, prefilled (the style's Compliance tab, a coverage cell). */
export const newDeclarationHref = (prefix: string, prefill: { styleId?: string | null; kind?: DocKind | null; language?: string | null } = {}): string =>
  `${prefix}/compliance/declarations${addressText({ ...EMPTY_ADDRESS, add: true, newStyle: prefill.styleId ?? null, newKind: prefill.kind ?? null, newLanguage: prefill.language ?? null })}`

// ---- the tiles (saved filters) ------------------------------------------------------------------------------------------------

export const TILES = ['issued', 'drafts', 'languagesMissing', 'supersededIn30Days', 'batchesShippedWithoutVersion'] as const
export type TileId = (typeof TILES)[number]

/** What a tile sets in the address (a tile is a chip: a second click clears it). */
export function tileChange(tile: TileId, address: DeclarationsAddress): Partial<DeclarationsAddress> {
  const active = tileOf(address) === tile
  switch (tile) {
    case 'issued':
      return { status: active ? null : 'ISSUED' }
    case 'drafts':
      return { status: active ? null : 'DRAFT' }
    case 'supersededIn30Days':
      return { status: active ? null : 'SUPERSEDED' }
    case 'languagesMissing':
      return { gaps: !active }
    case 'batchesShippedWithoutVersion':
      return { unrecorded: true }
  }
}

/** The tile the address shows as chosen. */
export function tileOf(address: DeclarationsAddress): TileId | null {
  if (address.gaps) return 'languagesMissing'
  if (address.status === 'ISSUED') return 'issued'
  if (address.status === 'DRAFT') return 'drafts'
  if (address.status === 'SUPERSEDED') return 'supersededIn30Days'
  return null
}

// ---- the grid -----------------------------------------------------------------------------------------------------------------

const KIND_ORDER: Readonly<Record<DocKind, number>> = { DECLARATION_OF_CONFORMITY: 0, USER_INFORMATION: 1 }

/** A grid row with its place in the tree (style › kind › language): the first row of a style and of a kind say so. */
export interface TreeRow extends DeclarationRow {
  readonly firstOfStyle: boolean
  readonly firstOfKind: boolean
}

/** The rows in the tree's order: style code, kind (DoC first), revision (newest first), the original before its translations, language, signed before generated. */
export function treeRows(rows: readonly DeclarationRow[]): TreeRow[] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.style.code.localeCompare(b.style.code) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      b.revision - a.revision ||
      Number(a.translationOfId !== null) - Number(b.translationOfId !== null) ||
      a.language.localeCompare(b.language) ||
      a.origin.localeCompare(b.origin) ||
      a.id.localeCompare(b.id),
  )
  return sorted.map((row, index) => {
    const before = sorted[index - 1]
    const firstOfStyle = !before || before.styleId !== row.styleId
    return { ...row, firstOfStyle, firstOfKind: firstOfStyle || before!.kind !== row.kind }
  })
}

/** The generated original (the draft its translations come from) of a style's kind and revision, from the grid's rows. */
export function originalOf(rows: readonly DeclarationRow[], styleId: string, kind: DocKind, revision: number | null): DeclarationRow | null {
  return (
    rows
      .filter((row) => row.styleId === styleId && row.kind === kind && row.origin === 'GENERATED' && row.translationOfId === null && row.status === 'DRAFT' && (revision === null || row.revision === revision))
      .sort((a, b) => b.revision - a.revision)[0] ?? null
  )
}

/** Tone of a document's status (never colour alone: the pill carries its word). */
export const STATUS_TONE: Readonly<Record<DocStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = { DRAFT: 'info', ISSUED: 'success', SUPERSEDED: 'neutral', WITHDRAWN: 'warning' }

/** The grid's row as CSV (Export N): the columns the screen shows, the words of the page's language. */
export function rowsCsv(rows: readonly DeclarationRow[], t: (key: string, params?: Record<string, string | number>) => string): string {
  const cell = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const head = ['number', 'style', 'kind', 'language', 'revision', 'status', 'origin', 'certificate', 'maker', 'standards', 'signedBy', 'batches', 'markets'].map((key) => t(`grid.col.${key}`))
  const lines = rows.map((row) =>
    [
      row.number ?? '',
      `${row.style.code} · ${row.style.name}`,
      t(`kind.${row.kind}`),
      row.language.toUpperCase(),
      row.revision,
      t(`status.${row.status}`),
      t(`origin.${row.origin}`),
      row.certificate?.number ?? '',
      row.maker.name,
      row.standards.join(', '),
      [row.signedByName, row.signedPlace, row.signedOn].filter(Boolean).join(', '),
      row.batches,
      row.marketsNeeding.join(', '),
    ]
      .map(cell)
      .join(';'),
  )
  return [head.map(cell).join(';'), ...lines].join('\r\n')
}

// ---- the language coverage --------------------------------------------------------------------------------------------------

export const CELL_TONE: Readonly<Record<CoverageState, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = { ISSUED: 'success', CHECKED: 'info', DRAFT: 'info', IN_TRANSLATION: 'warning', MISSING: 'danger', NOT_NEEDED: 'neutral' }
export { CELL_STATES }

/** The languages a coverage row still misses (a market needs them; no document of the current revision). */
export const gapsOf = (row: CoverageRow): string[] => row.cells.filter((cell) => cell.state === 'MISSING').map((cell) => cell.language)
/** The languages a row needs (every cell but "not needed"). */
export const neededOf = (row: CoverageRow): string[] => row.cells.filter((cell) => cell.state !== 'NOT_NEEDED').map((cell) => cell.language)

export const rowKey = (row: Pick<CoverageRow, 'style' | 'kind'>): string => `${row.style.id}|${row.kind}`

/** The coverage rows the page shows: gaps first when asked, the words typed (style code or name), the kind chosen. */
export function coverageRows(coverage: Coverage, address: Pick<DeclarationsAddress, 'gaps' | 'q' | 'kind'>): CoverageRow[] {
  const words = address.q.trim().toLowerCase()
  return coverage.rows.filter(
    (row) => (!address.gaps || gapsOf(row).length > 0) && (!address.kind || row.kind === address.kind) && (!words || row.style.code.toLowerCase().includes(words) || row.style.name.toLowerCase().includes(words)),
  )
}

/**
 * What a cell does: open its document, or — a missing language — add it: a translation of the generated original of that
 * revision when there is one (the person may generate), else New declaration for that style, kind and language.
 */
export type CellAction = { readonly kind: 'open'; readonly documentId: string } | { readonly kind: 'translate'; readonly originalId: string; readonly language: string } | { readonly kind: 'new'; readonly language: string } | { readonly kind: 'none' }

export function cellAction(row: CoverageRow, language: string, rows: readonly DeclarationRow[], can: DeclarationsCan): CellAction {
  const cell = row.cells.find((entry) => entry.language === language)
  if (!cell) return { kind: 'none' }
  if (cell.documentId) return { kind: 'open', documentId: cell.documentId }
  if (cell.state !== 'MISSING' || !mayGenerate(can, row.kind)) return { kind: 'none' }
  const original = originalOf(rows, row.style.id, row.kind, row.style.revision)
  return original ? { kind: 'translate', originalId: original.id, language } : { kind: 'new', language }
}

/** The Language check (design pop:dc-langcheck): per style and kind, the languages the markets need against what is issued, gaps first. */
export interface LanguageCheckRow {
  readonly key: string
  readonly row: CoverageRow
  readonly needed: readonly string[]
  readonly issued: readonly string[]
  readonly gaps: readonly string[]
  /** The generated original the gaps can be translated from, or why they cannot (a held reason key). */
  readonly originalId: string | null
  readonly held: string | null
}

export function languageCheck(coverage: Coverage, rows: readonly DeclarationRow[], can: DeclarationsCan): LanguageCheckRow[] {
  return coverage.rows
    .map((row) => {
      const gaps = gapsOf(row)
      const original = originalOf(rows, row.style.id, row.kind, row.style.revision)
      const held = gaps.length === 0 ? 'held.noGaps' : !mayGenerate(can, row.kind) ? (row.kind === 'USER_INFORMATION' ? 'held.uiGenerate' : 'held.generate') : !original ? 'held.noOriginal' : null
      return {
        key: rowKey(row),
        row,
        needed: neededOf(row),
        issued: row.cells.filter((cell) => cell.state === 'ISSUED').map((cell) => cell.language),
        gaps,
        originalId: original?.id ?? null,
        held,
      }
    })
    .sort((a, b) => Number(b.gaps.length > 0) - Number(a.gaps.length > 0) || b.gaps.length - a.gaps.length || a.row.style.code.localeCompare(b.row.style.code) || KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind])
}

// ---- one record: a DoC or a leaflet ------------------------------------------------------------------------------------------

/** A point of the DoC or a section of the leaflet: the law it answers, the words, where they came from. */
export interface RecordPart {
  readonly id: string
  /** The point number ("1" … "9") or the Annex II point ("1.4(a)"). */
  readonly law: string
  readonly text: string
  readonly source: Source
  readonly values: readonly { readonly field: string; readonly value: string; readonly source: Source }[]
  /** The words still hold the original's (to translate) or wait to be typed. */
  readonly open: boolean
}

export interface FamilyEntry {
  readonly id: string
  readonly language: string
  readonly status: DocStatus
  readonly origin: Origin
  readonly translationStatus: DeclarationRow['translationStatus']
  readonly checkedBy: string | null
  readonly marketCode: string | null
  readonly original: boolean
  readonly toType: readonly string[]
}

export interface RecordDoc {
  readonly kind: DocKind
  readonly row: DeclarationRow
  readonly parts: readonly RecordPart[]
  readonly toType: readonly string[]
  readonly generated: boolean
  readonly template: string | null
  readonly createdBy: string | null
  readonly original: { readonly id: string; readonly language: string; readonly status: DocStatus } | null
  readonly family: readonly FamilyEntry[]
  /** Parts that differ from today's records (typed words never), and whether the leaflet's lists changed. */
  readonly stale: { readonly parts: readonly string[]; readonly lists: { readonly positions: boolean; readonly spares: boolean } | null } | null
  readonly problems: readonly ApiProblem[]
  readonly batches: readonly TimelineGroup[]
  readonly publicAddress: string | null
  /** A signed DoC is issued for the style: the public page shows it. */
  readonly publicLive: boolean | null
  readonly may: DeclarationDetail['may']
  readonly positions: readonly ProtectorPosition[]
  readonly spares: readonly SpareProtector[]
  readonly packs: readonly LanguagePack[]
}

/** The batches and shipments recorded under one document (the detail carries the timeline in place of the row's counts). */
export function countsOf(documentId: string, groups: readonly TimelineGroup[]): { batches: number; shipments: number } {
  const batches = groups.flatMap((group) => group.batches).filter((batch) => batch.documentIds.includes(documentId))
  return { batches: new Set(batches.map((batch) => batch.batchNumber)).size, shipments: new Set(batches.flatMap((batch) => batch.shipmentIds)).size }
}

const isOpen = (source: Source) => source.kind === 'UNTRANSLATED' || source.kind === 'TO_TYPE'

/** A DoC detail as the record. */
export function recordOfDeclaration(detail: DeclarationDetail): RecordDoc {
  const { points, languages, stale, publication, may, template, createdBy, original, problems, batches, ...row } = detail
  return {
    kind: 'DECLARATION_OF_CONFORMITY',
    row: { ...row, ...countsOf(row.id, batches), pointsToType: detail.pointsToType },
    parts: points.map((point) => ({ id: point.point, law: point.point, text: point.text, source: point.source, values: point.values, open: isOpen(point.source) })),
    toType: detail.pointsToType,
    generated: detail.origin === 'GENERATED',
    template,
    createdBy: createdBy?.name ?? null,
    original,
    family: languages.map((entry) => ({ id: entry.id, language: entry.language, status: entry.status, origin: entry.origin, translationStatus: entry.translationStatus, checkedBy: entry.translationCheckedBy?.name ?? null, marketCode: entry.marketCode, original: entry.original, toType: entry.pointsToType })),
    stale: stale && stale.differences.length > 0 ? { parts: stale.differences.map((entry) => entry.point), lists: null } : null,
    problems,
    batches,
    publicAddress: publication?.address ?? null,
    publicLive: publication?.live ?? null,
    may,
    positions: [],
    spares: [],
    packs: [],
  }
}

/** A leaflet detail as the record. */
export function recordOfLeaflet(detail: LeafletDetail): RecordDoc {
  const { sections, languages, stale, publication, may, template, createdBy, original, problems, batches, protectorPositions, spareProtectors, packs, sectionsToType, ...row } = detail
  const listsChanged = !!stale && (stale.lists.positions || stale.lists.spares)
  return {
    kind: 'USER_INFORMATION',
    row: { ...row, ...countsOf(row.id, batches), pointsToType: sectionsToType },
    parts: sections.map((section) => ({ id: section.key, law: section.law ?? SECTION_LAW[section.key as SectionKey] ?? '', text: section.text, source: section.source, values: section.values, open: isOpen(section.source) })),
    toType: sectionsToType,
    generated: detail.origin === 'GENERATED',
    template,
    createdBy: createdBy?.name ?? null,
    original,
    family: languages.map((entry) => ({ id: entry.id, language: entry.language, status: entry.status, origin: entry.origin, translationStatus: entry.translationStatus, checkedBy: entry.translationCheckedBy?.name ?? null, marketCode: entry.marketCode, original: entry.original, toType: entry.sectionsToType })),
    stale: stale && (stale.differences.length > 0 || listsChanged) ? { parts: stale.differences.map((entry) => entry.key), lists: stale.lists } : null,
    problems,
    batches,
    publicAddress: publication?.docAddress ?? null,
    publicLive: null,
    may,
    positions: protectorPositions,
    spares: spareProtectors,
    packs,
  }
}

// ---- the record's address ------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['content', 'languages', 'batches', 'publication'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const RECORD_DIALOGS = ['issue', 'translate', 'withdraw', 'check', 'refresh'] as const
export type RecordDialog = (typeof RECORD_DIALOGS)[number]

/** `/w/<company>/compliance/declarations/<id>?tab=content|languages|batches|publication&do=issue|translate|withdraw|check|refresh&edit=1`. */
export interface RecordAddress {
  readonly tab: RecordTab
  readonly dialog: RecordDialog | null
  readonly edit: boolean
}

export function recordAddressOf(params: { get(name: string): string | null } | null): RecordAddress {
  return { tab: oneOf(RECORD_TABS, params?.get('tab')) ?? 'content', dialog: oneOf(RECORD_DIALOGS, params?.get('do')), edit: params?.get('edit') === '1' }
}

export function recordAddressText(address: RecordAddress): string {
  const search = new URLSearchParams()
  if (address.tab !== 'content') search.set('tab', address.tab)
  if (address.dialog) search.set('do', address.dialog)
  if (address.edit) search.set('edit', '1')
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const recordHref = (prefix: string, id: string, tab: RecordTab = 'content'): string => `${prefix}/compliance/declarations/${encodeURIComponent(id)}${tab === 'content' ? '' : `?tab=${tab}`}`
export const pdfHref = (prefix: string, id: string): string => `${prefix}/compliance/declarations/pdf?id=${encodeURIComponent(id)}`
export const packHref = (prefix: string, shipmentId: string): string => `${prefix}/compliance/declarations/pack?shipment=${encodeURIComponent(shipmentId)}`

// ---- the Content draft ---------------------------------------------------------------------------------------------------------

export interface ContentDraft {
  readonly parts: Readonly<Record<string, string>>
  readonly number: string
  readonly signedByName: string
  readonly signedByFunction: string
  readonly signedPlace: string
  readonly signedOn: string
}

export function draftOf(record: RecordDoc): ContentDraft {
  return {
    parts: Object.fromEntries(record.parts.map((part) => [part.id, part.text])),
    number: record.row.number ?? '',
    signedByName: record.row.signedByName ?? '',
    signedByFunction: record.row.signedByFunction ?? '',
    signedPlace: record.row.signedPlace ?? '',
    signedOn: record.row.signedOn ?? '',
  }
}

/** The signatory belongs to the original DoC (point 9 follows it); a translation and a leaflet have none of their own. */
export const hasSignatory = (record: RecordDoc): boolean => record.kind === 'DECLARATION_OF_CONFORMITY' && record.original === null

/** What the draft changes, as the PATCH sends it (null: nothing changed). */
export function editOf(record: RecordDoc, draft: ContentDraft): { parts: { id: string; text: string }[]; number?: string | null; signedByName?: string | null; signedByFunction?: string | null; signedPlace?: string | null; signedOn?: string | null } | null {
  const parts = record.parts.filter((part) => (draft.parts[part.id] ?? part.text).trim() !== part.text.trim()).map((part) => ({ id: part.id, text: (draft.parts[part.id] ?? '').trim() }))
  const field = (typed: string, stored: string | null) => (typed.trim() === (stored ?? '') ? undefined : typed.trim() === '' ? null : typed.trim())
  const out: ReturnType<typeof editOf> & object = { parts }
  const number = field(draft.number, record.row.number)
  if (number !== undefined) out.number = number
  if (hasSignatory(record)) {
    const name = field(draft.signedByName, record.row.signedByName)
    const role = field(draft.signedByFunction, record.row.signedByFunction)
    const place = field(draft.signedPlace, record.row.signedPlace)
    const on = field(draft.signedOn, record.row.signedOn)
    if (name !== undefined) out.signedByName = name
    if (role !== undefined) out.signedByFunction = role
    if (place !== undefined) out.signedPlace = place
    if (on !== undefined) out.signedOn = on
  }
  return Object.keys(out).length === 1 && parts.length === 0 ? null : out
}

/** Why Save is held (null: it may be sent). */
export function saveHeld(record: RecordDoc, draft: ContentDraft, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!editOf(record, draft)) return 'held.nothingChanged'
  if (record.parts.some((part) => (draft.parts[part.id] ?? '').trim() === '')) return 'held.emptyPart'
  if (record.parts.some((part) => (draft.parts[part.id] ?? '').length > WORDS_MAX)) return 'held.longPart'
  return null
}

/** Why the content cannot be typed now (null: Edit is offered). */
export function editHeld(record: RecordDoc): string | null {
  if (!record.generated) return 'held.signedFile'
  if (record.row.status !== 'DRAFT') return 'held.notDraft'
  if (record.row.translationStatus === 'CHECKED') return 'held.checkedEdit'
  if (!record.may.edit) return record.kind === 'USER_INFORMATION' ? 'held.uiGenerate' : 'held.generate'
  return null
}

// ---- Issue (GATE-PPE-TEXTS) ----------------------------------------------------------------------------------------------------

export interface IssueCheck {
  readonly id: string
  readonly state: 'OK' | 'OPEN' | 'NOT_NEEDED'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/**
 * The issue review (design pop:dc-issue): every point present and typed, the signatory typed (the original DoC), a translation
 * checked by a second person, nothing refusing a refresh, and — always open for a generated document — the PPE consultant's yes
 * on its template (GATE-PPE-TEXTS, Owner 11-09 B). The last line never passes here: the screen never issues a generated one.
 */
export function issueChecks(record: RecordDoc): IssueCheck[] {
  const open = record.parts.filter((part) => part.open).map((part) => part.id)
  const checks: IssueCheck[] = [{ id: 'parts', state: open.length === 0 && record.parts.length > 0 ? 'OK' : 'OPEN', key: open.length === 0 ? (record.kind === 'USER_INFORMATION' ? 'issue.check.sections' : 'issue.check.points') : 'issue.check.toType', params: { count: record.parts.length, list: open.join(', ') } }]
  if (hasSignatory(record)) checks.push({ id: 'signatory', state: record.row.signedByName && record.row.signedPlace && record.row.signedOn ? 'OK' : 'OPEN', key: 'issue.check.signatory' })
  if (record.original) checks.push({ id: 'checked', state: record.row.translationStatus === 'CHECKED' ? 'OK' : 'OPEN', key: 'issue.check.translation' })
  const blocking = record.problems.filter((problem) => BLOCKING.has(problem.code))
  checks.push({ id: 'records', state: blocking.length === 0 ? 'OK' : 'OPEN', key: blocking.length === 0 ? 'issue.check.records' : 'issue.check.recordsRefuse', params: { count: blocking.length } })
  checks.push({ id: 'gate', state: 'OPEN', key: 'issue.check.gate' })
  return checks
}

/** Why Issue is held, always for a generated document (the gate), else why there is nothing to issue here. */
export function issueHeld(record: RecordDoc): string {
  if (!record.generated) return record.row.status === 'ISSUED' ? 'held.issuedAlready' : 'held.signedRoute'
  if (record.row.status !== 'DRAFT') return 'held.notDraft'
  return 'held.gate'
}

// ---- withdraw, translate, check ----------------------------------------------------------------------------------------------

/** The typed confirm of a withdraw (legal): the document's number, else the word of the page's language. */
export const withdrawPhrase = (record: RecordDoc, word: string): string => record.row.number ?? word

export function withdrawHeld(record: RecordDoc, reason: string, typed: string, phrase: string, busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!record.may.withdraw) return record.generated ? (record.row.status !== 'DRAFT' ? 'held.notDraft' : 'held.generate') : 'held.signedWithdraw'
  const words = reason.trim()
  if (words.length < REASON_MIN) return 'held.reason'
  if (words.length > REASON_MAX) return 'held.reasonLong'
  if (typed.trim() !== phrase) return 'held.phrase'
  return null
}

/** The languages a record's family may still take: the markets' languages and the factory's two, not taken yet. */
export function translatable(record: RecordDoc, coverageLanguages: readonly string[]): string[] {
  const taken = new Set(record.family.filter((entry) => entry.status !== 'WITHDRAWN' || entry.origin === 'GENERATED').map((entry) => entry.language))
  return [...new Set([...coverageLanguages, 'it', 'en', 'de', 'fr', 'es'])].filter((language) => !taken.has(language)).sort()
}

export function translateHeld(record: RecordDoc, languages: readonly string[], packs: readonly string[], busy: boolean): string | null {
  if (busy) return 'held.busy'
  if (!record.generated) return 'held.signedTranslate'
  if (record.original) return 'held.translateOriginal'
  if (!record.may.translate) return record.row.status !== 'DRAFT' ? 'held.notDraft' : record.kind === 'USER_INFORMATION' ? 'held.uiGenerate' : 'held.generate'
  if (languages.length === 0 && packs.length === 0) return 'held.chooseLanguage'
  return null
}

/** Why this person may not check the translation (null: Check is offered). Words for the API's own refusals. */
export function checkHeld(record: RecordDoc, userId: string, typists: readonly string[]): string | null {
  if (!record.original) return 'held.notTranslation'
  if (record.row.status !== 'DRAFT') return 'held.notDraft'
  if (record.row.translationStatus === 'CHECKED') return 'held.checkedAlready'
  if (record.toType.length > 0) return 'refusal.WORDS_MISSING'
  if (!record.may.check) return record.kind === 'USER_INFORMATION' ? 'held.uiCheck' : 'held.check'
  if (typists.includes(userId)) return 'refusal.OWN_WORDS'
  return null
}

/** Who typed the record's words (a typed part names its typist). */
export const typistsOf = (record: RecordDoc): string[] => [...new Set(record.parts.filter((part) => part.source.kind === 'TYPED' && part.source.recordType === 'User' && part.source.recordId).map((part) => part.source.recordId!))]

// ---- sources, problems and refusals in our words -----------------------------------------------------------------------------

/** The DS SourceIndicator's kind for where a value came from. */
export function indicatorKind(source: Source): 'master' | 'override' | 'default' | 'missing' | 'linked' | 'pending' | 'warning' {
  switch (source.kind) {
    case 'TYPED':
      return 'override'
    case 'TEMPLATE':
      return 'default'
    case 'PHRASE':
      return 'master'
    case 'UNTRANSLATED':
      return 'pending'
    case 'TO_TYPE':
      return 'missing'
    default:
      return 'linked'
  }
}

const SOURCE_RECORDS: Readonly<Record<string, string>> = { Certificate: 'Certificate', Style: 'Style', Party: 'Party', LabelTemplate: 'LabelTemplate', Item: 'Item' }

/** Where the source record opens (its own page), or null. */
export function sourceHref(prefix: string, source: Source): string | null {
  const type = source.recordType ? SOURCE_RECORDS[source.recordType] : undefined
  if (!type || !source.recordId) return null
  return `${prefix}${recordAddress({ type, id: source.recordId }, OFFICE_PAGES)}`
}

/** The word keys of a source kind (`source.<KIND>`), the unknown ones as "from the records". */
const SOURCE_KINDS = new Set(['STYLE', 'STYLE_REVISION', 'OPERATOR', 'PARTY', 'COMPANY', 'LABEL', 'CERTIFICATE', 'NOTIFIED_BODY', 'REGISTER', 'PHRASE', 'TEMPLATE', 'TYPED', 'UNTRANSLATED', 'TO_TYPE', 'PROTECTOR_PLACEMENT', 'MATERIAL', 'MARKET', 'PUBLIC_DOC'])
export const sourceKey = (source: Source): string => (SOURCE_KINDS.has(source.kind) ? `source.${source.kind}` : 'source.OTHER')

/** Composition codes that refuse a draft (the rest are warnings). */
export const BLOCKING: ReadonlySet<string> = new Set(['NOT_PPE', 'NO_REVISION', 'NO_MAKER', 'NO_CERTIFICATE', 'PHRASE_MISSING'])
const PROBLEM_CODES = new Set([
  ...BLOCKING,
  'STANDARD_NOT_IN_REGISTER',
  'STANDARD_NOT_IN_FORCE',
  'NO_STANDARD',
  'LEGISLATION_NOT_IN_REGISTER',
  'POINT8_TO_TYPE',
  'SIGNATORY_TO_TYPE',
  'PHRASE_PLACEHOLDERS',
  'PHRASE_BUILT_IN',
  'NO_CLASS',
  'NO_PROTECTORS',
  'SPARE_NOT_CERTIFIED',
  'CLASS_WARNING_MISSING',
  'POSITION_NOTE_AS_TYPED',
  'NO_BODY_ADDRESS',
])

/** A composition problem's word key (`problem.code.<CODE>`); a placement finding and an unknown code have shared words. */
export const problemCodeKey = (code: string): string => (PROBLEM_CODES.has(code) ? `code.${code}` : code.startsWith('PLACEMENT_') ? 'code.PLACEMENT' : 'code.OTHER')

/** The API's refusal codes this page says in its own words (`refusal.<CODE>`). */
const REFUSALS = new Set([
  ...BLOCKING,
  'EXISTS',
  'WITHDRAWN',
  'TAKEN',
  'SOURCE_LANGUAGE',
  'NOTHING_TO_ADD',
  'DECLARATION',
  'USER_INFORMATION',
  'SIGNED',
  'NOT_DRAFT',
  'CHECKED',
  'WORDS_MISSING',
  'OWN_TRANSLATION',
  'OWN_WORDS',
  'NOT_A_TRANSLATION',
  'TRANSLATION',
  'TRANSLATION_SIGNATORY',
  'SAME_STATE',
  'RECORDED',
  'SHIPMENT_CANCELLED',
  'CANCELLED',
  'NO_PPE',
  'DOCUMENT_MISSING',
  'DATABASE',
  'LANGUAGE',
  'REASON',
])

export interface Problem {
  readonly key: string
  readonly field: string | null
}

/** An error in our words: a known refusal by its code, else by the kind of answer. */
export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.unavailable', field: null }
  let refusal: string | null = null
  let field: string | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) refusal = path.slice('refusal/'.length)
    else if (/^(body|querystring)[./]/.test(path) && !field) field = path.replace(/^(body|querystring)[./]/, '').split(/[./]/)[0] || null
  }
  if (refusal) return { key: REFUSALS.has(refusal) ? `refusal.${refusal}` : 'refusal.OTHER', field }
  switch (error.kind) {
    case 'invalid':
      return { key: field === 'companyId' ? 'problem.company' : 'problem.invalid', field }
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
      return { key: error.code === 'network' ? 'problem.noAnswer' : 'problem.unavailable', field: null }
    default:
      return { key: 'problem.internal', field: null }
  }
}

export const readProblemOf = (error: unknown): string => {
  const problem = problemOf(error)
  return problem.key.startsWith('refusal.') ? 'problem.read' : problem.key
}

/** A pack refusal or warning code in our words (`pack.code.<CODE>`). */
const PACK_CODES = new Set(['CANCELLED', 'NO_PPE', 'DOCUMENT_MISSING', 'FALLBACK_LANGUAGE', 'NO_CERTIFICATE', 'CERTIFICATE_NOT_VALID', 'NO_BATCH'])
export const packCodeKey = (code: string): string => (PACK_CODES.has(code) ? `pack.code.${code}` : 'pack.code.OTHER')

// ---- live ----------------------------------------------------------------------------------------------------------------------

/** The live events that change this page: the generator's, the leaflet builder's and W1's signed uploads. */
export const isDeclarationsChange = (change: { readonly type: string }): boolean =>
  change.type.startsWith('compliance_declarations.') || change.type.startsWith('compliance_user_information.') || change.type === 'style.compliance_document_issued' || change.type === 'style.compliance_document_replaced'

/** A language's name in the page's language ("Deutsch" → "Tedesco"), else its tag. */
export function languageName(tag: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(tag)
    return name && name !== tag ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : tag.toUpperCase()
  } catch {
    return tag.toUpperCase()
  }
}

export type { CoverageKind }
