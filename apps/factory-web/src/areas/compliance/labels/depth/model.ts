import { WARNING_PHRASE_KEYS, warningsAsked, type WarningReason } from '@nexus/factory-domain/compliance/label-rules/marking'
import type { LabelRuleOutcome } from '@nexus/factory-domain/compliance/label-rules/rules'
import { CARE_SYMBOLS, type LabelKind, type LabelQrTarget } from '@nexus/factory-domain/compliance/labels/rules'
import { classificationOf } from '@nexus/factory-domain/product/compliance/rules'
import type { PpeCategory } from '@nexus/factory-domain/product/styles/rules'
import type { CheckState } from '../../../quality/_shared/parts'
import type { LabelDetail, LabelTemplate } from '../api'
import type { LabelDraft, PartDraft } from '../model'
import type { Artwork, ArtworkVersion, ComputedPart, LabelChecks, LabelWarning, Market, MarketRef, MarkingBody, Phrase, PhraseCell, PhraseText, TEXTILE_OUTCOMES } from './api'

/**
 * Labels & marking in depth (B-W2b-270, SCR-053), pure — no React, no API client: who may do what beyond W1, the label's
 * kind in words, the translations that keep a label from printing for a market (the list's tile and view), the marking
 * checks and the textile checks as check lines, a draft label's kind / GPSR contact / QR target and what its save sends,
 * the composition computed from the BOM as the builder's parts, the Languages tab's rows and cells, and the artwork's held
 * reasons (said before the click). Built on B-W2b-253 (label rules), B-W2b-208 (textile rules), B-W2b-259 (artwork) and
 * B-W2b-249 (phrases, markets).
 */

// ---- rights -------------------------------------------------------------------------------------------------------------------

export interface DepthCan {
  /** Approve a label proof someone else made (compliance.artwork.approve). */
  approveArtwork: boolean
  /** Upload the proof's file (files.upload): adding a proof also needs compliance.labels.manage. */
  upload: boolean
  /** Propose a translation in the phrase library (compliance.phrases.manage). */
  phrasesManage: boolean
  /** Approve a translation someone else proposed (compliance.phrases.approve). */
  phrasesApprove: boolean
  /** Open Rules & markets (its tabs read with the certificate register's view). */
  rules: boolean
}

export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return {
    approveArtwork: held.has('compliance.artwork.approve'),
    upload: held.has('files.upload'),
    phrasesManage: held.has('compliance.phrases.manage'),
    phrasesApprove: held.has('compliance.phrases.approve'),
    rules: held.has('compliance.certificates.view'),
  }
}

/** The live events of the W2b parts (a hint to read again, never data): artwork proofs, phrases and translations, markets. */
export const DEPTH_EVENTS: readonly string[] = ['label_artwork.', 'compliance_rules.phrase_', 'compliance_rules.translation_', 'compliance_rules.market_']

/** Where a person keeps the phrases, the gates and a phrase of its own (Compliance › Settings › Rules & markets, B-W2b-265). */
export const phraseLibraryHref = (prefix: string, phraseKey?: string | null): string => `${prefix}/compliance/settings?tab=phrases${phraseKey ? `&open=${encodeURIComponent(phraseKey)}` : ''}`
export const gatesHref = (prefix: string): string => `${prefix}/compliance/settings?tab=gates`

// ---- the label's kind (PRD-331, PRD-336) --------------------------------------------------------------------------------------

export const KIND_TONE: Record<LabelKind, 'info' | 'neutral' | 'success' | 'warning'> = { PPE_GARMENT: 'info', GLOVE_MARKING: 'success', FIBRE_CARE: 'neutral', PACKAGING: 'neutral' }

/** The kind a row is (an answer without it is W1's PPE garment label). */
export const kindOf = (row: Pick<LabelTemplate, 'kind'>): LabelKind => row.kind ?? 'PPE_GARMENT'

/** A label that carries the GPSR identifier and contact (a consumer line that is not PPE, or a market that asks it). */
export const carriesGpsr = (row: Pick<LabelTemplate, 'gpsrContact'>): boolean => !!row.gpsrContact && row.gpsrContact.trim() !== ''

// ---- the translations that keep a label from printing for a market (the list) ------------------------------------------------

/** What a switched-on market needs that the label cannot print: languages it lacks, warnings without an approved text. */
export interface TranslationGap {
  market: string
  marketName: string
  /** Languages the market's labels need that the label does not print (B-W2b-254's label.languages). */
  languages: string[]
  /** Warning phrases without an approved text in a language the market needs (B-W2b-253's class warnings). */
  phrases: { key: string; languages: string[] }[]
}

/** The switched-on markets a label serves: every market of its company and every market of all companies. */
export function marketsFor(row: Pick<LabelTemplate, 'companyId'>, markets: readonly Market[]): Market[] {
  return markets.filter((market) => market.status === 'ACTIVE' && market.switchedOn && (row.companyId === null || market.companyId === null || market.companyId === row.companyId))
}

/**
 * The class warnings a label must print as the list knows it: an EN 17092 PPE garment label of class B or C (the style's
 * class). The removable-protectors warning needs the revision's protector pockets: only the label's record reads it.
 */
export function listWarningKeys(row: Pick<LabelTemplate, 'kind' | 'style'>): string[] {
  if (kindOf(row) !== 'PPE_GARMENT' || !row.style || row.style.ppeCategory === 'NOT_PPE') return []
  const facts = classificationOf({ id: row.style.id, code: row.style.code, productType: 'JACKET', ppeCategory: row.style.ppeCategory as PpeCategory, ppeStandard: row.style.ppeStandard, ppeClass: row.style.ppeClass, brandPartyId: null })
  return warningsAsked({ standardCode: facts.standardCode, ppeClass: facts.ppeClass, protectorPockets: [] }).map((reason) => WARNING_PHRASE_KEYS[reason])
}

/** The languages the switched-on markets need on labels (what the phrase texts are read for). */
export const marketLabelLanguages = (markets: readonly Market[]): string[] => [...new Set(markets.filter((market) => market.switchedOn && market.status === 'ACTIVE').flatMap((market) => market.labelLanguages))].sort()

/** The gaps of one label that prints (a draft or an active label; a retired one prints nothing). */
export function translationGaps(row: Pick<LabelTemplate, 'status' | 'companyId' | 'languages' | 'kind' | 'style'>, markets: readonly Market[], texts: readonly PhraseText[]): TranslationGap[] {
  if (row.status === 'RETIRED') return []
  const keys = listWarningKeys(row)
  const approved = new Set(texts.filter((entry) => entry.text !== null).map((entry) => `${entry.key}|${entry.language}`))
  const gaps: TranslationGap[] = []
  for (const market of marketsFor(row, markets)) {
    const languages = market.labelLanguages.filter((language) => !row.languages.includes(language))
    const phrases = keys.flatMap((key) => {
      const missing = market.labelLanguages.filter((language) => !approved.has(`${key}|${language}`))
      return missing.length > 0 ? [{ key, languages: missing }] : []
    })
    if (languages.length > 0 || phrases.length > 0) gaps.push({ market: market.code, marketName: market.name, languages, phrases })
  }
  return gaps
}

/** Every warning key the list's labels need (the one texts read). */
export const listPhraseKeys = (rows: readonly LabelTemplate[]): string[] => [...new Set(rows.filter((row) => row.status !== 'RETIRED').flatMap(listWarningKeys))].sort()

/** The list's W2b reads: null value while read; a problem when not readable (the tile then says "—"). */
export interface ListDepth {
  /** Label ids with a proof waiting for a second person. */
  waiting: ReadonlySet<string> | null
  waitingFailed: boolean
  /** Label id → the markets it cannot print for (only labels with a gap). */
  gaps: ReadonlyMap<string, TranslationGap[]> | null
  gapsFailed: boolean
}

export const NO_DEPTH: ListDepth = { waiting: null, waitingFailed: false, gaps: null, gapsFailed: false }

export function gapsOf(rows: readonly LabelTemplate[], markets: readonly Market[], texts: readonly PhraseText[]): Map<string, TranslationGap[]> {
  const out = new Map<string, TranslationGap[]>()
  for (const row of rows) {
    const gaps = translationGaps(row, markets, texts)
    if (gaps.length > 0) out.set(row.id, gaps)
  }
  return out
}

// ---- the checks as check lines -------------------------------------------------------------------------------------------------

export const RULE_STATE: Record<LabelRuleOutcome, CheckState> = { PASS: 'OK', FAIL: 'OPEN', WARN: 'WARNING', WAITING: 'OPEN', UNKNOWN: 'UNKNOWN', NOT_APPLICABLE: 'NOT_NEEDED' }
export const TEXTILE_STATE: Record<(typeof TEXTILE_OUTCOMES)[number], CheckState> = { PASS: 'OK', FAIL: 'OPEN', WARN: 'WARNING', UNKNOWN: 'UNKNOWN', NOT_APPLICABLE: 'NOT_NEEDED', OFF: 'NOT_NEEDED' }

/** The market whose checks show first: the one asked, else the first that blocks, else the first. */
export function marketShown(checks: LabelChecks, asked: string | null): string | null {
  const codes = checks.markets.map((entry) => entry.market?.code ?? null)
  if (asked && codes.includes(asked)) return asked
  return checks.markets.find((entry) => entry.blocks)?.market?.code ?? codes[0] ?? null
}

/** How many markets the label cannot print for, by the marking checks. */
export const blockedMarkets = (checks: LabelChecks): number => checks.markets.filter((entry) => entry.blocks).length

// ---- the marking of a draft (kind, GPSR contact, QR target) ---------------------------------------------------------------------

export interface MarkingDraft {
  kind: LabelKind
  gpsrContact: string
  qrTarget: LabelQrTarget
}

export const GPSR_MAX = 500

export const markingDraftOf = (template: Pick<LabelTemplate, 'kind' | 'gpsrContact' | 'qrTarget'>): MarkingDraft => ({ kind: kindOf(template), gpsrContact: template.gpsrContact ?? '', qrTarget: template.qrTarget ?? 'NONE' })

/** What the marking's save sends: only what changed (an empty contact is none). */
export function markingPatch(template: Pick<LabelTemplate, 'kind' | 'gpsrContact' | 'qrTarget'>, draft: MarkingDraft | null): MarkingBody {
  if (!draft) return {}
  const now = markingDraftOf(template)
  const patch: MarkingBody = {}
  if (draft.kind !== now.kind) patch.kind = draft.kind
  if (draft.qrTarget !== now.qrTarget) patch.qrTarget = draft.qrTarget
  const contact = draft.gpsrContact.trim()
  if (contact !== now.gpsrContact.trim()) patch.gpsrContact = contact === '' ? null : contact
  return patch
}

export const markingDirty = (template: Pick<LabelTemplate, 'kind' | 'gpsrContact' | 'qrTarget'>, draft: MarkingDraft | null): boolean => Object.keys(markingPatch(template, draft)).length > 0

/** Why the marking cannot be saved as typed (a message key of compliance-labels-depth), or null. */
export const markingProblem = (draft: MarkingDraft | null): string | null => (draft && draft.gpsrContact.trim().length > GPSR_MAX ? 'marking.problem.long' : null)

// ---- the composition computed from the BOM (B-W2b-208) ------------------------------------------------------------------------

/** The page's language for the official names: Italian or English (the names the API knows). */
const nameLanguage = (language: string): 'it' | 'en' => (language === 'it' ? 'it' : 'en')

/** A computed fibre in the official name of a language (the typed word when the regulation has no name for it). */
export const fibreName = (fibre: { fibre: string; names: Readonly<Record<string, string>> }, language: string): string => fibre.names[nameLanguage(language)] ?? fibre.names.en ?? fibre.fibre

const capitalised = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text)

/** The computed parts as the builder's composition, in the label's first language (parts without fibres left out). */
export function compositionDraft(parts: readonly ComputedPart[], language: string): PartDraft[] {
  return parts
    .filter((part) => part.fibres !== null && part.fibres.length > 0)
    .slice(0, 8)
    .map((part) => ({ part: capitalised(part.words[nameLanguage(language)] || part.part), fibres: part.fibres!.slice(0, 8).map((fibre) => ({ fibre: fibreName(fibre, language), percent: fibre.percent })) }))
}

const partKey = (parts: readonly PartDraft[]): string =>
  JSON.stringify(parts.map((part) => [part.part.trim().toLowerCase(), part.fibres.map((fibre) => [fibre.fibre.trim().toLowerCase(), Number(fibre.percent.replace(',', '.'))])]))

/** The draft already says what the BOM computes. */
export const sameComposition = (a: readonly PartDraft[], b: readonly PartDraft[]): boolean => partKey(a) === partKey(b)

/** Parts the BOM could not compute (a missing weight): the label is typed by hand for those. */
export const uncomputed = (parts: readonly ComputedPart[]): ComputedPart[] => parts.filter((part) => part.fibres === null)

// ---- the Languages tab --------------------------------------------------------------------------------------------------------

export interface LanguageColumn {
  language: string
  /** The label prints it. */
  onLabel: boolean
  /** Switched-on markets whose labels need it. */
  markets: string[]
}

/** The label's languages first, then those the switched-on markets need on labels. */
export function languageColumns(labelLanguages: readonly string[], markets: readonly (MarketRef | null)[]): LanguageColumn[] {
  const on = markets.filter((market): market is MarketRef => market !== null && market.switchedOn)
  const all = [...new Set([...labelLanguages, ...on.flatMap((market) => market.labelLanguages)])]
  return all.map((language) => ({ language, onLabel: labelLanguages.includes(language), markets: on.filter((market) => market.labelLanguages.includes(language)).map((market) => market.code) }))
}

export const PHRASE_ROW_KINDS = ['WARNING', 'ANIMAL_ORIGIN', 'CARE', 'CLAIM'] as const
export type PhraseRowKind = (typeof PHRASE_ROW_KINDS)[number]

export interface PhraseSpec {
  key: string
  kind: PhraseRowKind
  /** The care symbol (CARE). */
  symbol?: string
}

export const ANIMAL_ORIGIN_KEY = 'marking.animal-origin'

/** The class warning a phrase key prints (CLASS_B, CLASS_C, REMOVABLE_PROTECTORS), or null for another key. */
export const warningReasonOf = (key: string): WarningReason | null => (Object.entries(WARNING_PHRASE_KEYS).find(([, phrase]) => phrase === key)?.[0] as WarningReason | undefined) ?? null
export const careKey = (symbol: string): string => `care.${symbol}`

/** The phrases the label prints, in its order: the class warnings, the animal-origin phrase, each care symbol's words, the origin claim. */
export function labelPhraseSpecs(detail: Pick<LabelDetail, 'animalOriginPhrase' | 'care' | 'originClaimKey'>, warnings: readonly Pick<LabelWarning, 'key'>[]): PhraseSpec[] {
  return [
    ...warnings.map((warning) => ({ key: warning.key, kind: 'WARNING' as const })),
    ...(detail.animalOriginPhrase ? [{ key: ANIMAL_ORIGIN_KEY, kind: 'ANIMAL_ORIGIN' as const }] : []),
    ...detail.care.map((entry) => ({ key: careKey(entry.symbol), kind: 'CARE' as const, symbol: entry.symbol })),
    ...(detail.originClaimKey ? [{ key: detail.originClaimKey, kind: 'CLAIM' as const }] : []),
  ]
}

export type CellState = PhraseCell['state'] | 'NOT_IN_LIBRARY'

export interface CellView {
  language: string
  state: CellState
  /** What the library prints in it: the approved words, or the source words in the source language. */
  text: string | null
  /** A proposal waiting for a second person. */
  draft: PhraseCell['draft']
  /** The label's own words for it (care and animal-origin texts typed on the label), else null. */
  labelText: string | null
  /** Switched-on markets this cell keeps the label from printing for (a warning, or a language the label lacks). */
  blocks: string[]
}

export interface PhraseRow {
  id: string
  spec: PhraseSpec
  phrase: Phrase | null
  cells: CellView[]
  /** Markets any of its cells blocks. */
  blocks: string[]
  /** Cells with no approved words (missing, stale, waiting, not in the library) among the columns. */
  missing: number
}

const printsFrom = (state: CellState): boolean => state === 'APPROVED' || state === 'SOURCE'

/** The label's own words for a phrase in a language (what W1 prints today: the typed text). */
function typedText(detail: Pick<LabelDetail, 'layout' | 'care'>, spec: PhraseSpec, language: string): string | null {
  if (spec.kind === 'ANIMAL_ORIGIN') return detail.layout.texts.animalOrigin[language]?.trim() || null
  if (spec.kind === 'CARE') return detail.care.find((entry) => entry.symbol === spec.symbol)?.text?.[language]?.trim() || null
  return null
}

/** One row per phrase the label prints, one cell per column; a warning without approved words blocks the markets needing the language. */
export function phraseRows(specs: readonly PhraseSpec[], phrases: readonly Phrase[], columns: readonly LanguageColumn[], detail: Pick<LabelDetail, 'layout' | 'care'>): PhraseRow[] {
  const byKey = new Map(phrases.map((phrase) => [phrase.key, phrase]))
  return specs.map((spec) => {
    const phrase = byKey.get(spec.key) ?? null
    const cells: CellView[] = columns.map((column) => {
      const cell = phrase?.cells.find((entry) => entry.language === column.language) ?? null
      const state: CellState = phrase ? (cell?.state ?? 'MISSING') : 'NOT_IN_LIBRARY'
      const text = phrase && cell ? (cell.state === 'SOURCE' ? phrase.sourceText : (cell.approved?.text ?? null)) : null
      const blocks = !column.onLabel ? column.markets : spec.kind === 'WARNING' && !printsFrom(state) ? column.markets : []
      return { language: column.language, state, text: cell?.state === 'STALE' ? null : text, draft: cell?.draft ?? null, labelText: typedText(detail, spec, column.language), blocks }
    })
    return { id: spec.key, spec, phrase, cells, blocks: [...new Set(cells.flatMap((cell) => cell.blocks))].sort(), missing: cells.filter((cell) => !printsFrom(cell.state)).length }
  })
}

/** Markets the Languages tab says the label cannot print for (any row, any language). */
export const rowsBlock = (rows: readonly PhraseRow[], columns: readonly LanguageColumn[]): string[] =>
  [...new Set([...rows.flatMap((row) => row.blocks), ...columns.filter((column) => !column.onLabel).flatMap((column) => column.markets)])].sort()

/** Why a translation cannot be proposed in this cell now (a key), or null. */
export function proposeHeld(can: Pick<DepthCan, 'phrasesManage'>, row: PhraseRow, cell: CellView, busy: boolean): string | null {
  if (!can.phrasesManage) return 'held.phrasesManage'
  if (!row.phrase) return 'held.notInLibrary'
  if (cell.state === 'SOURCE') return 'held.source'
  if (busy) return 'held.busy'
  return null
}

/** Why a waiting translation cannot be approved by the reader now (a key), or null. */
export function approveTranslationHeld(can: Pick<DepthCan, 'phrasesApprove'>, me: string, cell: CellView, busy: boolean): string | null {
  if (!cell.draft) return 'held.noProposal'
  if (!can.phrasesApprove) return 'held.phrasesApprove'
  if (cell.draft.proposedBy?.id === me) return 'held.ownProposal'
  if (busy) return 'held.busy'
  return null
}

/**
 * Fill from the library: the approved words of the animal-origin phrase and of each care symbol become the label's own
 * texts in every language it prints (W1 prints the label's typed words). Only words that differ change; nothing is
 * cleared where the library has no approved words.
 */
export function fillFromLibrary(draft: LabelDraft, rows: readonly PhraseRow[]): { draft: LabelDraft; filled: number } {
  let filled = 0
  const animal = { ...draft.animalOriginTexts }
  const care = draft.care.map((entry) => ({ ...entry, text: { ...entry.text } }))
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!draft.languages.includes(cell.language) || !cell.text || !printsFrom(cell.state)) continue
      if (row.spec.kind === 'ANIMAL_ORIGIN' && draft.animalOriginPhrase && (animal[cell.language] ?? '').trim() !== cell.text) {
        animal[cell.language] = cell.text
        filled += 1
      }
      if (row.spec.kind === 'CARE') {
        const entry = care.find((item) => item.symbol === row.spec.symbol)
        if (entry && (entry.text[cell.language] ?? '').trim() !== cell.text) {
          entry.text[cell.language] = cell.text
          filled += 1
        }
      }
    }
  }
  return { draft: { ...draft, animalOriginTexts: animal, care }, filled }
}

/** The words a care row is named by: the symbol's (English, the W1 builder's words are the screen's own). */
export const careSymbolKnown = (symbol: string | undefined): boolean => !!symbol && !!CARE_SYMBOLS[symbol]

// ---- artwork (PRD-347) ---------------------------------------------------------------------------------------------------------

/** The version the tab opens on: the approved one, else the newest draft, else the newest. */
export function currentVersion(artwork: Pick<Artwork, 'versions' | 'approvedId'>): ArtworkVersion | null {
  return artwork.versions.find((entry) => entry.id === artwork.approvedId) ?? artwork.versions.find((entry) => entry.status === 'DRAFT') ?? artwork.versions[0] ?? null
}

/** The draft waiting for a second person (newest first), if any. */
export const waitingVersion = (artwork: Pick<Artwork, 'versions'>): ArtworkVersion | null => artwork.versions.find((entry) => entry.status === 'DRAFT') ?? null

/** Why the reader cannot approve this proof now (a key; our words, the API's `approveHeld` stays data), or null. */
export function approveHeld(version: ArtworkVersion, artwork: Pick<Artwork, 'mayApprove' | 'label'>, busy: boolean): string | null {
  if (!artwork.mayApprove) return 'held.approveRight'
  if (artwork.label.status === 'RETIRED') return 'held.labelRetired'
  if (version.status !== 'DRAFT') return 'held.notDraft'
  if (version.byYou) return 'held.ownProof'
  if (version.approveHeld) return 'held.approveOther'
  if (busy) return 'held.busy'
  return null
}

export function addProofHeld(artwork: Pick<Artwork, 'mayManage' | 'label'>, can: Pick<DepthCan, 'upload'>, busy: boolean): string | null {
  if (!artwork.mayManage) return 'held.manage'
  if (!can.upload) return 'held.upload'
  if (artwork.label.status === 'RETIRED') return 'held.labelRetired'
  if (busy) return 'held.busy'
  return null
}

export function retireHeld(version: ArtworkVersion, artwork: Pick<Artwork, 'mayManage'>, busy: boolean): string | null {
  if (!artwork.mayManage) return 'held.manage'
  if (version.status === 'RETIRED') return 'held.retired'
  if (busy) return 'held.busy'
  return null
}

export function removeHeld(version: ArtworkVersion, artwork: Pick<Artwork, 'mayManage'>, busy: boolean): string | null {
  if (!artwork.mayManage) return 'held.manage'
  if (version.status !== 'DRAFT') return 'held.kept'
  if (busy) return 'held.busy'
  return null
}

/** A proof file a person may pick: a PDF or a picture, at most 25 MB. */
export const PROOF_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const
export const PROOF_MAX_BYTES = 25 * 1024 * 1024
export function proofFileProblem(file: { contentType: string; size: number } | null): string | null {
  if (!file) return 'held.pickFile'
  if (!(PROOF_TYPES as readonly string[]).includes(file.contentType)) return 'artwork.problem.type'
  if (file.size > PROOF_MAX_BYTES) return 'artwork.problem.size'
  return null
}

export const isPdf = (contentType: string | null | undefined): boolean => (contentType ?? '').toLowerCase().startsWith('application/pdf')
