import { EDIT_KINDS, EDIT_REFUSALS, LIFECYCLE_REFUSALS, STYLE_LIFECYCLES, type EditKind, type StyleLifecycle } from '@nexus/factory-domain/product/lifecycle/rules'
import { GATE_FIXES, GATE_ITEMS, type GateFix, type GateItemCode, type GateState } from '@nexus/factory-domain/product/release/gate'
import { LANGUAGE_TAG, normaliseLanguage, TEXT_LIMITS } from '@nexus/factory-domain/product/style-texts/rules'
import { REQUIRABLE_ATTRIBUTES } from '@nexus/factory-domain/product/types/rules'
import { WHERE_USED_KINDS, type WhereUsedKind } from '@nexus/factory-domain/product/where-used/rules'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { recordAddress } from '../../../../../lib/records/record-links'
import type { AssignView, GateSummaryRow, LifecycleView, PrivateLabelView, RangesView, StyleTypeView, TextsView, TypeView, WhereUsedView } from './api'

/**
 * The Style studio's depth (B-W2b-237; SCR-342), pure: who may do what, the parts and pop-ups of the Overview's identity
 * (product type, names per language, the private-label mark), of its side panel (the lifecycle and what it allows, the
 * completeness of the release gate, where the style is used) and of the colour × size matrix (the GTIN in a cell, Assign
 * GTINs: preview then confirm), and the words of every code the API answers. No money: none of these reads carries any.
 */

// ---- who may do what ----------------------------------------------------------------------------------------------------

export interface DepthCan {
  /** product.styles.view: every read here. */
  view: boolean
  /** product.styles.manage: names per language, sold under our name, the product type. */
  manage: boolean
  /** product.styles.lifecycle: move the style through its lifecycle, name the replacing style. */
  lifecycle: boolean
  /** product.gtins.manage: give SKUs GTINs from the company's GS1 range. */
  gtins: boolean
}

export function depthCan(permissions: readonly string[]): DepthCan {
  const held = new Set(permissions)
  return { view: held.has('product.styles.view'), manage: held.has('product.styles.manage'), lifecycle: held.has('product.styles.lifecycle'), gtins: held.has('product.gtins.manage') }
}

// ---- the parts ----------------------------------------------------------------------------------------------------------

/** One read of the depth: each loads and fails on its own (the rest of the record stays usable). */
export type DepthPart<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export const ready = <T,>(value: T): DepthPart<T> => ({ status: 'ready', value })
export const failed = <T,>(problem: string): DepthPart<T> => ({ status: 'error', problem })
export const valueOf = <T,>(part: DepthPart<T>): T | null => (part.status === 'ready' ? part.value : null)

export type MatrixShow = 'state' | 'sku' | 'gtin'
export const MATRIX_SHOWS: readonly MatrixShow[] = ['state', 'sku', 'gtin']

export interface TextDraft {
  language: string
  name: string
  shortDescription: string
  longDescription: string
}

export type DepthDialog =
  | { kind: 'move'; to: StyleLifecycle }
  | { kind: 'replacement' }
  /** A language's names: null = a new language. */
  | { kind: 'text'; language: string | null }
  | { kind: 'removeText'; language: string }
  | { kind: 'soldUnderOurName'; value: boolean }
  | { kind: 'type' }
  | { kind: 'whereUsed'; group: WhereUsedKind | null }
  | { kind: 'assign' }

export interface DepthNotice {
  key: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  params?: Record<string, string | number>
}

/** A style the replacement may name (found by code or name). */
export interface StyleChoice {
  id: string
  code: string
  name: string
}

/** Assign GTINs (pop:styles.gtin): the company's ranges, the one picked, the preview, then what was given. */
export interface AssignModel {
  ranges: DepthPart<RangesView>
  rangeId: string | null
  /** The preview of the picked range (dryRun). */
  preview: DepthPart<AssignView> | null
  /** The confirm's answer: what was given. */
  done: AssignView | null
  problem: string | null
}

export const NO_ASSIGN: AssignModel = { ranges: { status: 'idle' }, rangeId: null, preview: null, done: null, problem: null }

export interface StyleDepthModel {
  /** `/w/<company>`. */
  prefix: string
  styleId: string
  styleCode: string
  /** The style's company (null: every company). */
  companyId: string | null
  archived: boolean
  can: DepthCan
  online: boolean
  busy: boolean
  notice: DepthNotice | null
  lifecycle: DepthPart<LifecycleView>
  type: DepthPart<StyleTypeView>
  texts: DepthPart<TextsView>
  privateLabel: DepthPart<PrivateLabelView>
  whereUsed: DepthPart<WhereUsedView>
  /** The release gate summed up for this style (B-W2b-231); null inside ready: the style has no revision. */
  gate: DepthPart<GateSummaryRow | null>
  dialog: DepthDialog | null
  /** The pop-ups' choices: the types of the style's kind (Type…), the styles found for the replacement. */
  types: DepthPart<TypeView[]>
  replacements: { query: string; found: StyleChoice[] | null }
  /** What a cell of the colour × size matrix says beside its state. */
  matrixShow: MatrixShow
  assign: AssignModel
  /** The refusal of the last write in a pop-up, said at its field or above its buttons. */
  problem: string | null
  /** Design cases: a dialog's draft already typed. */
  textDraft?: TextDraft
  moveDraft?: { reason: string; replacedById: string | null }
}

export interface StyleDepthActions {
  onRetry?: () => void
  onDialog?: (dialog: DepthDialog | null) => void
  onDismissNotice?: () => void
  onMove?: (to: StyleLifecycle, reason: string, replacedById: string | null | undefined) => Promise<boolean>
  onReplacement?: (replacedById: string | null, reason: string) => Promise<boolean>
  onFindReplacement?: (query: string) => void
  onSaveText?: (draft: TextDraft, version: number | null) => Promise<boolean>
  onRemoveText?: (language: string, version: number) => Promise<boolean>
  onSoldUnderOurName?: (value: boolean, reason: string) => Promise<boolean>
  onSetType?: (typeId: string | null) => Promise<boolean>
  onMatrixShow?: (show: MatrixShow) => void
  onPickRange?: (rangeId: string) => void
  onPreview?: () => void
  onAssign?: () => Promise<boolean>
}

// ---- the lifecycle ------------------------------------------------------------------------------------------------------

export const LIFECYCLE_TONE: Readonly<Record<StyleLifecycle, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = Object.freeze({
  CONCEPT: 'neutral',
  DEVELOPMENT: 'info',
  SAMPLING: 'info',
  APPROVED: 'success',
  IN_PRODUCTION: 'success',
  PHASE_OUT: 'warning',
  DISCONTINUED: 'neutral',
})

/** A move into these states may name the style that replaces it. */
export const namesReplacement = (to: StyleLifecycle): boolean => to === 'PHASE_OUT' || to === 'DISCONTINUED'

/** The rule the target state has (the move's "what it allows after"). */
export const ruleIn = (view: LifecycleView, state: StyleLifecycle) => view.rules.find((row) => row.state === state) ?? null

/** A move's refusal in our words: a key of the catalogue, never the API's English. */
export const refusalKey = (code: string): string => ((LIFECYCLE_REFUSALS as readonly string[]).includes(code) || (EDIT_REFUSALS as readonly string[]).includes(code) ? `refusal.${code}` : 'refusal.other')

/** Why "Move to…" is held as a whole (null: the menu opens). */
export function moveHeld(model: Pick<StyleDepthModel, 'can' | 'archived' | 'online' | 'busy'>): string | null {
  if (!model.can.lifecycle) return 'lifecycle.held.noRight'
  if (model.archived) return 'lifecycle.held.archived'
  if (!model.online) return 'hold.offline'
  if (model.busy) return 'hold.busy'
  return null
}

/** What a move asks before it is made: a reason (a move back needs one; the API refuses it without), within 500 characters. */
export function moveProblem(backward: boolean, reason: string): string | null {
  const text = reason.trim()
  if (backward && text.length === 0) return 'move.held.reason'
  if (text.length > 500) return 'hold.long'
  return null
}

/** The kinds of write in the order the card says them. */
export const KINDS: readonly EditKind[] = EDIT_KINDS

// ---- the product type ---------------------------------------------------------------------------------------------------

/** A required attribute's words (the type's names: settings › product types). Unknown names are said as "another field". */
export const attributeKey = (name: string): string => ((REQUIRABLE_ATTRIBUTES as readonly string[]).includes(name) ? `attr.${name}` : 'attr.other')

/** A default the style does not follow. */
export const DIFFERS_FIELDS = ['sizeScaleId', 'measurementTemplateId', 'ppeCategory', 'ppeStandard', 'ppeClass'] as const
export const differsKey = (field: string): string => ((DIFFERS_FIELDS as readonly string[]).includes(field) ? `type.default.${field}` : 'type.default.other')

/** Why the type is held (null: Change… opens). The edit rule (SPEC) is the API's: it answers in words. */
export function typeHeld(model: Pick<StyleDepthModel, 'can' | 'archived' | 'online' | 'busy'>): string | null {
  if (!model.can.manage) return 'hold.noManage'
  if (model.archived) return 'hold.archived'
  if (!model.online) return 'hold.offline'
  if (model.busy) return 'hold.busy'
  return null
}

/** The address of a product type (Products › Settings, B-W2b-239). */
export const typeHref = (prefix: string, typeId: string, built: ReadonlySet<string>): string => `${prefix}${recordAddress({ type: 'ProductTypeProfile', id: typeId }, built)}`

// ---- names per language -------------------------------------------------------------------------------------------------

/** The languages offered first (the factory's markets); any other BCP 47 tag may be typed. */
export const COMMON_LANGUAGES = ['it', 'en', 'de', 'fr', 'es', 'nl', 'pt', 'pl'] as const

/** A language's words: its name in the person's language when the browser knows it, else the tag. */
export function languageName(tag: string, locale: 'it' | 'en'): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(tag)
    return name && name !== tag ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : tag
  } catch {
    return tag
  }
}

/** The draft of a language: the row's words, or a new language's empty form. */
export function textDraftOf(texts: TextsView | null, language: string | null): TextDraft {
  const row = language ? texts?.texts.find((entry) => entry.language === language) : undefined
  return { language: language ?? '', name: row?.name ?? '', shortDescription: row?.shortDescription ?? '', longDescription: row?.longDescription ?? '' }
}

export type TextField = 'language' | 'name' | 'shortDescription' | 'longDescription'

/**
 * What holds Save, each at its field (keys of the catalogue): the language a tag not written yet (a new one), the name one
 * line within its limit, the descriptions within theirs (the short one on one line). The same rules as factory-domain's
 * `textProblems` and `normaliseLanguage`, said in our words.
 */
export function textProblems(draft: TextDraft, texts: TextsView | null, isNew: boolean): Partial<Record<TextField, string>> {
  const problems: Partial<Record<TextField, string>> = {}
  if (isNew) {
    const tag = normaliseLanguage(draft.language)
    if (draft.language.trim() === '') problems.language = 'text.problem.languageEmpty'
    else if (tag === null || !LANGUAGE_TAG.test(tag)) problems.language = 'text.problem.languageTag'
    else if (texts?.texts.some((row) => row.language === tag)) problems.language = 'text.problem.languageTaken'
  }
  const line = (value: string, max: number): string | null =>
    value.length > max ? 'text.problem.long' : /[\r\n\t]/.test(value) ? 'text.problem.oneLine' : /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) ? 'text.problem.control' : null
  if (draft.name.trim() === '') problems.name = 'text.problem.nameEmpty'
  else {
    const name = line(draft.name, TEXT_LIMITS.name)
    if (name) problems.name = name
  }
  const short = draft.shortDescription.trim() === '' ? null : line(draft.shortDescription, TEXT_LIMITS.shortDescription)
  if (short) problems.shortDescription = short
  if (draft.longDescription.length > TEXT_LIMITS.longDescription) problems.longDescription = 'text.problem.long'
  else if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(draft.longDescription)) problems.longDescription = 'text.problem.control'
  return problems
}

/** The body of a language's text: empty descriptions are none. */
export const textInputOf = (draft: TextDraft) => ({
  name: draft.name.trim(),
  shortDescription: draft.shortDescription.trim() === '' ? null : draft.shortDescription.trim(),
  longDescription: draft.longDescription.trim() === '' ? null : draft.longDescription,
})

/** The draft says what the row says already (Save is held: nothing changed). */
export function sameText(draft: TextDraft, texts: TextsView | null): boolean {
  const row = texts?.texts.find((entry) => entry.language === draft.language)
  if (!row) return false
  const input = textInputOf(draft)
  return row.name === input.name && row.shortDescription === input.shortDescription && row.longDescription === input.longDescription
}

/** Why the names cannot change now (the API's refusal of the texts: archived, the edit rule), or null. */
export function textsHeld(model: Pick<StyleDepthModel, 'can' | 'archived' | 'online' | 'busy'>, texts: TextsView | null): string | null {
  if (!model.can.manage) return 'hold.noManage'
  if (model.archived) return 'hold.archived'
  if (texts?.editRefusal) return refusalKey(texts.editRefusal.code)
  if (!model.online) return 'hold.offline'
  if (model.busy) return 'hold.busy'
  return null
}

/** The languages a reader falls back through: written rows first (company language first), then W1's names not written. */
export function languageRows(texts: TextsView): Array<{ language: string; row: TextsView['texts'][number] | null; styleName: string | null }> {
  const rows = [...texts.texts].sort((a, b) => Number(b.language === texts.companyLanguage) - Number(a.language === texts.companyLanguage) || a.language.localeCompare(b.language))
  const written = new Set(rows.map((row) => row.language))
  const extra = Object.entries(texts.styleNames)
    .filter(([language, name]) => !written.has(language) && name.trim() !== '')
    .sort(([a], [b]) => a.localeCompare(b))
  return [...rows.map((row) => ({ language: row.language, row, styleName: texts.styleNames[row.language] ?? null })), ...extra.map(([language, name]) => ({ language, row: null, styleName: name }))]
}

// ---- the private label --------------------------------------------------------------------------------------------------

/** Why "Sold under our name" cannot change now (null: it can). Clearing the brand itself stays in Identity (W1's field). */
export function soldHeld(model: Pick<StyleDepthModel, 'can' | 'archived' | 'online' | 'busy'>, view: PrivateLabelView | null): string | null {
  if (!model.can.manage) return 'hold.noManage'
  if (model.archived) return 'hold.archived'
  if (view && view.brand === null && !view.soldUnderOurName) return 'label.held.noBrand'
  if (!model.online) return 'hold.offline'
  if (model.busy) return 'hold.busy'
  return null
}

// ---- completeness (B-W2b-231) -------------------------------------------------------------------------------------------

/** The meter's tone (colour rule A: from what is open, never from the percentage). */
export function completenessTone(row: GateSummaryRow): 'complete' | 'partial' | 'missing' | 'unknown' {
  if (row.completenessPct === null) return 'unknown'
  if (row.blockers > 0) return 'missing'
  if (row.open > 0) return 'partial'
  return 'complete'
}

/** "87.5" → 87.5 (null: no score). */
export const pctNumber = (value: string | null): number | null => (value === null || value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value))

/** The percentage in the person's language ("87,5 %"). */
export function pctText(value: string | null, locale: 'it' | 'en'): string {
  const number = pctNumber(value)
  if (number === null) return '—'
  return `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 1 }).format(number)} %`
}

/** Where a gate item's Fix goes: the style's tab (the release check itself for SCOPE/DRIFT and release). */
const FIX_TAB: Readonly<Record<GateFix, string>> = Object.freeze({
  bom: 'bom',
  routing: 'routing',
  minutes: 'routing',
  materials: 'bom',
  labels: 'compliance',
  compliance: 'compliance',
  measurements: 'sizes',
  type: 'overview',
  changes: 'overview',
  release: 'overview',
  versions: 'overview',
})

export const fixTab = (fix: string): string => ((GATE_FIXES as readonly string[]).includes(fix) ? FIX_TAB[fix as GateFix] : 'overview')
export const gateItemKey = (code: string): string => ((GATE_ITEMS as readonly string[]).includes(code) ? `score.item.${code as GateItemCode}` : 'score.item.other')
export const gateStateKey = (state: GateState): string => `score.state.${state}`

// ---- where-used ---------------------------------------------------------------------------------------------------------

export const WHERE_USED: readonly WhereUsedKind[] = WHERE_USED_KINDS

/** The record each kind's rows are (their own page when built, else the record panels). Stock rows are SKUs: no link. */
const KIND_TYPE: Readonly<Record<WhereUsedKind, string | null>> = Object.freeze({
  QUOTES: 'Quote',
  SALES_ORDERS: 'SalesOrder',
  WORK_ORDERS: 'WorkOrder',
  STOCK: null,
  PRICE_LISTS: 'PriceList',
  SAMPLE_ROUNDS: 'SampleRound',
  CERTIFICATES: 'Certificate',
})

export function whereUsedHref(prefix: string, kind: WhereUsedKind, row: WhereUsedView['groups'][number]['rows'][number], built: ReadonlySet<string>): string | null {
  const type = KIND_TYPE[kind]
  if (!type) return null
  return `${prefix}${recordAddress({ type, id: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId }, built)}`
}

/** The states the API says, each with words (an unknown one is said as open or closed, never as its code). */
export const WHERE_USED_STATES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'SENT',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'CONFIRMED',
  'IN_PRODUCTION',
  'READY',
  'PARTLY_SHIPPED',
  'SHIPPED',
  'CLOSED',
  'RELEASED',
  'IN_PROGRESS',
  'COMPLETED',
  'ON_HOLD',
  'ACTIVE',
  'REQUESTED',
  'IN_MAKING',
  'UNDER_REVIEW',
  'DECIDED',
  'VALID',
  'SUSPENDED',
  'WITHDRAWN',
  'ON_HAND',
] as const

export const stateKey = (state: string, open: boolean): string => ((WHERE_USED_STATES as readonly string[]).includes(state) ? `whereUsed.state.${state}` : open ? 'whereUsed.state.otherOpen' : 'whereUsed.state.otherClosed')

/** The kinds the side panel says (allowed ones only: a kind the role does not read is not mentioned at all). */
export const allowedGroups = (view: WhereUsedView) => view.groups.filter((group) => group.allowed)

// ---- GTINs --------------------------------------------------------------------------------------------------------------

/** Why Assign GTINs is held (null: it opens). */
export function assignHeld(model: Pick<StyleDepthModel, 'can' | 'archived' | 'online' | 'busy'>, waiting: number): string | null {
  if (!model.can.gtins) return 'gtin.held.noRight'
  if (model.archived) return 'hold.archived'
  if (waiting === 0) return 'gtin.held.none'
  if (!model.online) return 'hold.offline'
  if (model.busy) return 'hold.busy'
  return null
}

/** The SKUs switched on without a GTIN (what Assign gives numbers to). */
export const waitingForGtin = (skus: ReadonlyArray<{ status: string; gtin: string | null }>): number => skus.filter((sku) => sku.status === 'ACTIVE' && !sku.gtin).length

/** Why the confirm is held: no preview yet, the gate closed here (GATE-SPEND), nothing to give. */
export function confirmHeld(assign: AssignModel, busy: boolean): string | null {
  const preview = assign.preview?.status === 'ready' ? assign.preview.value : null
  if (!preview) return 'gtin.held.preview'
  if (!preview.allocation.open) return 'gtin.held.gate'
  if (preview.count === 0) return 'gtin.held.nothing'
  if (busy) return 'hold.busy'
  return null
}

/** The GTIN written in groups the eye can check (13 digits: 1 · 6 · 6). */
export function gtinText(gtin: string): string {
  return gtin.length === 13 ? `${gtin.slice(0, 1)} ${gtin.slice(1, 7)} ${gtin.slice(7)}` : gtin
}

// ---- problems -----------------------------------------------------------------------------------------------------------

export type DepthWrite = 'move' | 'text' | 'label' | 'type' | 'assign' | 'preview' | 'read'

/** A refused write in our words (a key of `products-styles-depth`), and whether the record is read again. */
export function depthProblem(error: unknown, write: DepthWrite): { key: string; reload: boolean } {
  if (!isApiError(error)) return { key: 'fault.internal', reload: false }
  const paths = error.issues.map(issuePath)
  const refusal = paths.find((path) => path.startsWith('refusal/'))
  if (refusal) return { key: refusalKey(refusal.slice('refusal/'.length)), reload: true }
  if (error.kind === 'conflict') {
    if (error.code === 'version_conflict' || paths.some((path) => path.split(/[./]/).includes('version'))) return { key: 'fault.moved', reload: true }
    if (write === 'assign') return { key: 'gtin.problem.again', reload: true }
    if (write === 'text') return { key: 'text.problem.meanwhile', reload: true }
    if (write === 'label') return { key: 'label.problem.thread', reload: true }
    return { key: 'fault.state', reload: true }
  }
  if (error.kind === 'invalid') {
    if (paths.includes('body/soldUnderOurName')) return { key: 'label.held.noBrand', reload: false }
    if (paths.some((path) => path.startsWith('body/replacedById'))) return { key: 'refusal.REPLACEMENT_UNUSABLE', reload: false }
    if (paths.includes('body/rangeId')) return { key: 'gtin.problem.range', reload: false }
    if (paths.includes('params/language')) return { key: 'text.problem.languageTag', reload: false }
    return { key: 'fault.invalid', reload: false }
  }
  if (error.kind === 'forbidden') return { key: write === 'read' ? 'fault.read.forbidden' : 'fault.forbidden', reload: false }
  if (['signed_out', 'not_found', 'rate_limited', 'unavailable', 'step_up'].includes(error.kind)) return { key: `fault.${error.kind}`, reload: error.kind === 'not_found' }
  return { key: 'fault.internal', reload: false }
}

/** Every key the screen may say for a code (the catalogue test reads it). */
export const CODE_KEYS: readonly string[] = [
  ...STYLE_LIFECYCLES.flatMap((state) => [`lifecycle.state.${state}`, `lifecycle.means.${state}`]),
  ...EDIT_KINDS.map((kind) => `lifecycle.kind.${kind}`),
  ...['FREE', 'NEW_REVISION', 'CHANGE_ORDER', 'BLOCKED'].map((rule) => `lifecycle.rule.${rule}`),
  ...[...LIFECYCLE_REFUSALS, ...EDIT_REFUSALS].map((code) => `refusal.${code}`),
  'refusal.other',
  ...REQUIRABLE_ATTRIBUTES.map((name) => `attr.${name}`),
  'attr.other',
  ...DIFFERS_FIELDS.map((field) => `type.default.${field}`),
  'type.default.other',
  ...GATE_ITEMS.map((item) => `score.item.${item}`),
  'score.item.other',
  ...(['OK', 'WARNING', 'BLOCKED', 'NOT_REQUIRED'] as const).map((state) => `score.state.${state}`),
  ...WHERE_USED_KINDS.map((kind) => `whereUsed.kind.${kind}`),
  ...WHERE_USED_STATES.map((state) => `whereUsed.state.${state}`),
  'whereUsed.state.otherOpen',
  'whereUsed.state.otherClosed',
  ...MATRIX_SHOWS.map((show) => `cells.show.${show}`),
]
