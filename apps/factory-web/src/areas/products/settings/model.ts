import { DEFAULT_EDIT_RULES, EDIT_KINDS, EDIT_RULES, editRefusal, STYLE_LIFECYCLES, type EditKind, type EditRule, type RuleSource, type StyleLifecycle } from '@nexus/factory-domain/product/lifecycle/rules'
import { ITEM_KINDS, type ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { percentOf, toleranceFor, type ConsumptionTolerance, type ToleranceRow } from '@nexus/factory-domain/product/settings/rules'
import type { UpdateSettingsBody } from '@nexus/factory-domain/product/settings/contracts'
import { PPE_CATEGORIES, PRODUCT_TYPES, type PpeCategory, type ProductType as GarmentKind } from '@nexus/factory-domain/product/styles/rules'
import type { CreateTypeBody, UpdateTypeBody } from '@nexus/factory-domain/product/types/contracts'
import { REQUIRABLE_ATTRIBUTES, TYPE_CODE, TYPE_LIMITS, type RequirableAttribute } from '@nexus/factory-domain/product/types/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { AuditEntry, ProductSettings, ProductType } from './api'

/**
 * Product settings (SCR-251, B-W2b-221's API), pure: the address, the drafts of the two form cards (edit rules per
 * lifecycle state, the consumption tolerance) and what they change, what is in force after a change (factory-domain's own
 * `editRuleFor` / `toleranceFor`, so the screen and the API never disagree), the product types as a tree, the type form,
 * held reasons, and the API's refusals in this page's words (`products-settings` catalogue keys).
 */

export { EDIT_KINDS, EDIT_RULES, ITEM_KINDS, PPE_CATEGORIES, PRODUCT_TYPES, REQUIRABLE_ATTRIBUTES, STYLE_LIFECYCLES }
export type { ConsumptionTolerance, EditKind, EditRule, GarmentKind, ItemKind, PpeCategory, RequirableAttribute, RuleSource, StyleLifecycle }

export const TOLERANCES = ['MATCH', 'MAY_DIFFER', 'WARN_ABOVE'] as const satisfies readonly ConsumptionTolerance[]

/** The live events that change what this page shows (factory-domain product-lifecycle/events.ts). */
export const LIVE_EVENTS = ['product_settings.changed', 'product_type.changed'] as const

// ---- reads --------------------------------------------------------------------------------------------------------------

export interface Read<T> {
  readonly value: T | null
  readonly problem: string | null
}
export const reading = <T>(): Read<T> => ({ value: null, problem: null })
export const ready = <T>(value: T): Read<T> => ({ value, problem: null })
export const failed = <T>(problem: string): Read<T> => ({ value: null, problem })

export interface Notice {
  readonly key: string
  readonly tone: 'info' | 'success' | 'warning' | 'danger'
  readonly params?: Readonly<Record<string, string | number>>
}

// ---- the address --------------------------------------------------------------------------------------------------------

/** Whose settings: the address's company, or every company (the tenant-wide row). */
export type Scope = 'company' | 'all'
export type TypeFilter = 'ACTIVE' | 'ARCHIVED' | 'ALL'

export interface Address {
  readonly scope: Scope
  /** A type in its dialog: its id, or `new`. */
  readonly type: string | null
  readonly status: TypeFilter
}

export const NO_ADDRESS: Address = Object.freeze({ scope: 'company', type: null, status: 'ACTIVE' })

const ID = /^[0-9a-f-]{36}$/i

export function addressOf(params: { get(name: string): string | null }): Address {
  const scope = params.get('scope') === 'all' ? 'all' : 'company'
  const type = params.get('type')
  const status = params.get('status')
  return {
    scope,
    type: type === 'new' || (type !== null && ID.test(type)) ? type : null,
    status: status === 'ARCHIVED' || status === 'ALL' ? status : 'ACTIVE',
  }
}

export function queryOf(address: Address): string {
  const query = new URLSearchParams()
  if (address.scope === 'all') query.set('scope', 'all')
  if (address.status !== 'ACTIVE') query.set('status', address.status)
  if (address.type) query.set('type', address.type)
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ---- held reasons -------------------------------------------------------------------------------------------------------

/** Why a card's change is held now, or null: the read, the right, offline, a save running. */
export function changeHeld(settings: ProductSettings | null, scope: Scope, busy: boolean, offline: boolean): string | null {
  if (!settings) return 'held.reading'
  if (!settings.mayChange) return scope === 'all' ? 'held.noRightAll' : 'held.noRight'
  if (offline) return 'held.offline'
  if (busy) return 'held.busy'
  return null
}

/**
 * Whether the person may keep a type of `companyId`: a company's type with the right over the company (its settings row's
 * `mayChange`), every company's with a right over every company (the tenant row's). Offline: no.
 */
export function mayKeepTypeOf(scope: Scope, settings: ProductSettings | null, tenant: ProductSettings | null, offline: boolean, companyId: string | null): boolean {
  const company = scope === 'company' ? settings : null
  const wide = scope === 'all' ? settings : tenant
  return (companyId === null ? !!wide?.mayChange : !!company?.mayChange) && !offline
}

// ---- edit rules per lifecycle state -------------------------------------------------------------------------------------

/** The scope's own rule per state (null: it follows every company's, or the default). */
export type RulesDraft = Readonly<Record<StyleLifecycle, EditRule | null>>

export interface InForce<T> {
  readonly rule: T
  readonly source: RuleSource
}

export function rulesDraftOf(settings: ProductSettings): RulesDraft {
  return Object.fromEntries(STYLE_LIFECYCLES.map((state) => [state, settings.editRules.find((entry) => entry.state === state)?.own ?? null])) as RulesDraft
}

/**
 * What a state follows when the scope keeps no rule of its own: every company's rule (the tenant read, or the scope's own
 * read where it keeps none) for a company, the defaults for every company. null: not known (the tenant read is missing).
 */
export function inheritedRules(scope: Scope, settings: ProductSettings, tenant: ProductSettings | null): Readonly<Record<StyleLifecycle, InForce<EditRule> | null>> {
  return Object.fromEntries(
    STYLE_LIFECYCLES.map((state) => {
      if (scope === 'all') return [state, { rule: DEFAULT_EDIT_RULES[state], source: 'DEFAULT' }]
      const wide = tenant?.editRules.find((entry) => entry.state === state)
      if (wide) return [state, { rule: wide.rule, source: wide.source === 'DEFAULT' ? 'DEFAULT' : 'TENANT' }]
      const own = settings.editRules.find((entry) => entry.state === state)
      return [state, own && own.own === null ? { rule: own.rule, source: own.source } : null]
    }),
  ) as Record<StyleLifecycle, InForce<EditRule> | null>
}

/** The rule in force per state once the draft is saved: its own, else what it follows (as factory-domain editRuleFor reads it). */
export function rulesPreview(scope: Scope, draft: RulesDraft, inherited: Readonly<Record<StyleLifecycle, InForce<EditRule> | null>>): Record<StyleLifecycle, InForce<EditRule> | null> {
  return Object.fromEntries(
    STYLE_LIFECYCLES.map((state) => {
      const own = draft[state]
      return [state, own !== null ? { rule: own, source: scope === 'all' ? 'TENANT' : 'COMPANY' } : inherited[state]]
    }),
  ) as Record<StyleLifecycle, InForce<EditRule> | null>
}

/** The states whose own rule the draft changes. */
export const rulesChanged = (settings: ProductSettings, draft: RulesDraft): StyleLifecycle[] => {
  const saved = rulesDraftOf(settings)
  return STYLE_LIFECYCLES.filter((state) => saved[state] !== draft[state])
}

/** How strict a rule is: a lower number lets more through. */
export const STRICTNESS: Readonly<Record<EditRule, number>> = Object.freeze({ FREE: 0, NEW_REVISION: 1, CHANGE_ORDER: 2, BLOCKED: 3 })

export interface Loosening {
  readonly state: StyleLifecycle
  readonly from: EditRule
  readonly to: EditRule
}

/** The states where the draft lets more through than the rule in force now (said before Save, with a reason). */
export function rulesLoosenings(settings: ProductSettings, draft: RulesDraft, inherited: Readonly<Record<StyleLifecycle, InForce<EditRule> | null>>, scope: Scope): Loosening[] {
  const after = rulesPreview(scope, draft, inherited)
  const out: Loosening[] = []
  for (const state of rulesChanged(settings, draft)) {
    const now = settings.editRules.find((entry) => entry.state === state)?.rule
    const then = after[state]?.rule
    if (now && then && STRICTNESS[then] < STRICTNESS[now]) out.push({ state, from: now, to: then })
  }
  return out
}

export function rulesBody(settings: ProductSettings, draft: RulesDraft, reason: string | null): UpdateSettingsBody {
  const editRules = Object.fromEntries(rulesChanged(settings, draft).map((state) => [state, draft[state]]))
  return {
    companyId: settings.companyId,
    ...(settings.exists && settings.version !== null ? { version: settings.version } : {}),
    editRules,
    ...(reason ? { reason } : {}),
  } as UpdateSettingsBody
}

/** What a rule lets through for a kind of write (from factory-domain's own refusal, so it never drifts). */
export type LetsThrough = 'yes' | 'withDraft' | 'changeOrder' | 'no'

export function letsThrough(rule: EditRule, kind: EditKind): LetsThrough {
  const facts = { code: 'X', lifecycle: 'APPROVED' as const, draftRevision: null }
  if (editRefusal(rule, kind, facts) === null) return 'yes'
  if (editRefusal(rule, kind, { ...facts, draftRevision: 2 }) === null) return 'withDraft'
  if (editRefusal(rule, kind, { ...facts, changeOrder: 'CO' }) === null) return 'changeOrder'
  return 'no'
}

// ---- consumption tolerance ----------------------------------------------------------------------------------------------

/** A material kind's own rule: none (it follows the general rule, then every company's), or one of the three. */
export type KindChoice = 'NONE' | ConsumptionTolerance

export interface ToleranceDraft {
  /** The scope's general rule (null: it follows every company's, or the default "may differ"). */
  readonly rule: ConsumptionTolerance | null
  /** The percent as typed (with WARN_ABOVE). */
  readonly percent: string
  readonly byKind: Readonly<Record<ItemKind, { readonly rule: KindChoice; readonly percent: string }>>
}

/** A percent as the person reads it: "2.5" → "2,5" in Italian. */
export const percentText = (value: string | null | undefined, locale: 'it' | 'en'): string => (value ? (locale === 'it' ? value.replace('.', ',') : value) : '')

/** A typed percent as the API takes it ("2,5" → "2.5"), or null when it is not one (above 0, at most 100, 4 decimals). */
export function percentInput(text: string): string | null {
  const normal = text.trim().replace(',', '.')
  const parsed = percentOf(normal)
  return parsed === null ? null : parsed.toString()
}

export function toleranceDraftOf(settings: ProductSettings, locale: 'it' | 'en'): ToleranceDraft {
  const own = settings.tolerance.own
  return {
    rule: own.rule,
    percent: percentText(own.percent, locale),
    byKind: Object.fromEntries(
      ITEM_KINDS.map((kind) => {
        const entry = settings.tolerance.byKind.find((row) => row.kind === kind)?.own ?? null
        return [kind, { rule: entry?.rule ?? 'NONE', percent: percentText(entry?.percent ?? null, locale) }]
      }),
    ) as ToleranceDraft['byKind'],
  }
}

const sameRule = (a: { rule: string | null; percent: string }, b: { rule: string | null; percent: string }): boolean =>
  a.rule === b.rule && (a.rule !== 'WARN_ABOVE' || percentInput(a.percent) === percentInput(b.percent) || a.percent.trim() === b.percent.trim())

export function toleranceChanged(settings: ProductSettings, draft: ToleranceDraft, locale: 'it' | 'en'): { general: boolean; kinds: ItemKind[] } {
  const saved = toleranceDraftOf(settings, locale)
  return {
    general: !sameRule(saved, draft),
    kinds: ITEM_KINDS.filter((kind) => !sameRule(saved.byKind[kind], draft.byKind[kind])),
  }
}

export const toleranceChanges = (settings: ProductSettings, draft: ToleranceDraft, locale: 'it' | 'en'): number => {
  const changed = toleranceChanged(settings, draft, locale)
  return (changed.general ? 1 : 0) + changed.kinds.length
}

/** The fields that are not right yet: a percent with "warn above", in this catalogue's words. */
export function toleranceProblems(draft: ToleranceDraft): { general: string | null; kinds: Partial<Record<ItemKind, string>> } {
  const kinds: Partial<Record<ItemKind, string>> = {}
  for (const kind of ITEM_KINDS) {
    const entry = draft.byKind[kind]
    if (entry.rule === 'WARN_ABOVE' && percentInput(entry.percent) === null) kinds[kind] = 'tolerance.problem.percent'
  }
  return { general: draft.rule === 'WARN_ABOVE' && percentInput(draft.percent) === null ? 'tolerance.problem.percent' : null, kinds }
}

export const toleranceHeld = (draft: ToleranceDraft): string | null => {
  const problems = toleranceProblems(draft)
  return problems.general ?? Object.values(problems.kinds)[0] ?? null
}

const byKindMap = (draft: ToleranceDraft): Record<string, { rule: ConsumptionTolerance; percent?: string }> | null => {
  const entries = ITEM_KINDS.flatMap((kind) => {
    const entry = draft.byKind[kind]
    if (entry.rule === 'NONE') return []
    const percent = entry.rule === 'WARN_ABOVE' ? percentInput(entry.percent) : null
    return [[kind, percent === null ? { rule: entry.rule } : { rule: entry.rule, percent }] as const]
  })
  return entries.length === 0 ? null : Object.fromEntries(entries)
}

const toleranceRowOf = (draft: ToleranceDraft): ToleranceRow => ({
  consumptionTolerance: draft.rule,
  consumptionTolerancePct: draft.rule === 'WARN_ABOVE' ? percentInput(draft.percent) : null,
  consumptionToleranceByKind: byKindMap(draft),
})

/** Every company's row as its read says it (its own values), for what a company follows. */
const tenantRowOf = (tenant: ProductSettings | null): ToleranceRow | null =>
  tenant
    ? {
        consumptionTolerance: tenant.tolerance.own.rule,
        consumptionTolerancePct: tenant.tolerance.own.percent,
        consumptionToleranceByKind: Object.fromEntries(tenant.tolerance.byKind.flatMap((row) => (row.own ? [[row.kind, { rule: row.own.rule, ...(row.own.percent ? { percent: row.own.percent } : {}) }]] : []))),
      }
    : null

export interface ToleranceInForce {
  readonly rule: ConsumptionTolerance
  readonly percent: string | null
  readonly source: RuleSource
  /** A rule of the kind's own (else the general rule). */
  readonly byKind: boolean
}

/** What applies once the draft is saved: the general rule and each kind's (factory-domain toleranceFor, as the cutting table reads it). */
export function tolerancePreview(scope: Scope, draft: ToleranceDraft, tenant: ProductSettings | null): { general: ToleranceInForce; kinds: Record<ItemKind, ToleranceInForce> } {
  const mine = toleranceRowOf(draft)
  const [company, wide] = scope === 'all' ? [null, mine] : [mine, tenantRowOf(tenant)]
  return {
    general: toleranceFor(company, wide, null),
    kinds: Object.fromEntries(ITEM_KINDS.map((kind) => [kind, toleranceFor(company, wide, kind)])) as Record<ItemKind, ToleranceInForce>,
  }
}

export function toleranceBody(settings: ProductSettings, draft: ToleranceDraft, locale: 'it' | 'en'): UpdateSettingsBody {
  const changed = toleranceChanged(settings, draft, locale)
  const body: Record<string, unknown> = { companyId: settings.companyId }
  if (settings.exists && settings.version !== null) body.version = settings.version
  if (changed.general) {
    body.consumptionTolerance = draft.rule
    body.consumptionTolerancePct = draft.rule === 'WARN_ABOVE' ? percentInput(draft.percent) : null
  }
  if (changed.kinds.length > 0) body.consumptionToleranceByKind = byKindMap(draft)
  return body as UpdateSettingsBody
}

// ---- "Changed by" -------------------------------------------------------------------------------------------------------

export interface ChangedBy {
  readonly at: string
  /** The office person who saved it (null: not known to this person). */
  readonly by: string | null
}

const afterKeys = (entry: AuditEntry): string[] => (entry.after && typeof entry.after === 'object' && !Array.isArray(entry.after) ? Object.keys(entry.after) : [])

/** The newest audited change of a card's fields (`editRule…` or `consumptionTolerance…`), or null. */
export function changedByOf(entries: readonly AuditEntry[], prefix: 'editRule' | 'consumptionTolerance'): ChangedBy | null {
  const entry = entries.find((row) => afterKeys(row).some((key) => key.startsWith(prefix)))
  return entry ? { at: entry.at, by: entry.actorName } : null
}

/** The newest audited change of any of the entries (a type's, or any type's). */
export const newestChange = (entries: readonly AuditEntry[]): ChangedBy | null => (entries[0] ? { at: entries[0].at, by: entries[0].actorName } : null)

// ---- product types ------------------------------------------------------------------------------------------------------

export interface TypeNode {
  readonly type: ProductType
  /** 0 at the top of the tree. */
  readonly depth: number
}

/** The types the scope shows: every company's only for "every company"; then by status. */
export function typesShown(types: readonly ProductType[], scope: Scope, status: TypeFilter): ProductType[] {
  return types.filter((type) => (scope === 'all' ? type.companyId === null : true) && (status === 'ALL' || type.status === status))
}

/** The types as a tree: each parent before its children (by code), a child whose parent is not shown at the top. */
export function typeTree(types: readonly ProductType[]): TypeNode[] {
  const shown = new Set(types.map((type) => type.id))
  const byCode = (a: ProductType, b: ProductType) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id)
  const childrenOf = new Map<string, ProductType[]>()
  const roots: ProductType[] = []
  for (const type of types) {
    const parent = type.parent?.id ?? null
    if (parent && shown.has(parent)) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), type])
    else roots.push(type)
  }
  const out: TypeNode[] = []
  const seen = new Set<string>()
  const walk = (type: ProductType, depth: number) => {
    if (seen.has(type.id)) return
    seen.add(type.id)
    out.push({ type, depth })
    for (const child of [...(childrenOf.get(type.id) ?? [])].sort(byCode)) walk(child, depth + 1)
  }
  for (const root of [...roots].sort((a, b) => PRODUCT_TYPES.indexOf(a.productType) - PRODUCT_TYPES.indexOf(b.productType) || byCode(a, b))) walk(root, 0)
  return out
}

/** The type and every type under it (a parent may not be one of them: no circle). */
export function descendantsOf(types: readonly ProductType[], typeId: string): Set<string> {
  const out = new Set<string>([typeId])
  let grew = true
  while (grew) {
    grew = false
    for (const type of types) {
      if (type.parent && out.has(type.parent.id) && !out.has(type.id)) {
        out.add(type.id)
        grew = true
      }
    }
  }
  return out
}

export interface TypeDraft {
  readonly id: string | null
  readonly version: number | null
  /** null: every company's type. */
  readonly companyId: string | null
  readonly code: string
  readonly name: string
  readonly productType: GarmentKind
  readonly parentId: string | null
  /** The type's own (a parent's come on top). */
  readonly requiredAttributes: readonly RequirableAttribute[]
  readonly defaultSizeScaleId: string | null
  readonly labelTemplateId: string | null
  readonly measurementTemplateId: string | null
  readonly defaultPpeCategory: PpeCategory | null
  readonly defaultPpeStandard: string
  readonly defaultPpeClass: string
}

export function typeDraftOf(type: ProductType | null, companyId: string | null): TypeDraft {
  if (!type) {
    return { id: null, version: null, companyId, code: '', name: '', productType: 'JACKET', parentId: null, requiredAttributes: [], defaultSizeScaleId: null, labelTemplateId: null, measurementTemplateId: null, defaultPpeCategory: null, defaultPpeStandard: '', defaultPpeClass: '' }
  }
  return {
    id: type.id,
    version: type.version,
    companyId: type.companyId,
    code: type.code,
    name: type.name,
    productType: type.productType,
    parentId: type.parent?.id ?? null,
    requiredAttributes: type.own.requiredAttributes.filter((name): name is RequirableAttribute => (REQUIRABLE_ATTRIBUTES as readonly string[]).includes(name)),
    defaultSizeScaleId: type.own.defaultSizeScaleId,
    labelTemplateId: type.own.labelTemplateId,
    measurementTemplateId: type.own.measurementTemplateId,
    defaultPpeCategory: type.own.defaultPpeCategory,
    defaultPpeStandard: type.own.defaultPpeStandard ?? '',
    defaultPpeClass: type.own.defaultPpeClass ?? '',
  }
}

/** The parents a type may take: active, of the same kind of garment, its company's or every company's, never itself or a child. */
export function parentChoices(types: readonly ProductType[], draft: TypeDraft): ProductType[] {
  const below = draft.id ? descendantsOf(types, draft.id) : new Set<string>()
  return types
    .filter((type) => type.status === 'ACTIVE' && type.productType === draft.productType && (type.companyId === null || type.companyId === draft.companyId) && !below.has(type.id))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** What the draft takes from its parent: the parent's own effective values (each with the type it comes from). */
export function inheritedOf(types: readonly ProductType[], draft: TypeDraft): ProductType['effective'] | null {
  if (!draft.parentId) return null
  return types.find((type) => type.id === draft.parentId)?.effective ?? null
}

/** The kind of garment stays while styles or child types use the type (the API says the same: 409). */
export const kindHeld = (type: ProductType | null): string | null => (type && (type.styles > 0 || type.children.length > 0) ? 'type.held.kindInUse' : null)

const trimmed = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The form's problems at their fields (this catalogue's keys); the first one holds Save. */
export function typeProblems(draft: TypeDraft, inherited: ProductType['effective'] | null): Partial<Record<string, string>> {
  const problems: Partial<Record<string, string>> = {}
  if (!TYPE_CODE.test(draft.code.trim())) problems.code = 'type.problem.code'
  if (draft.name.trim() === '' || draft.name.trim().length > TYPE_LIMITS.name) problems.name = 'type.problem.name'
  if (draft.defaultPpeStandard.trim().length > TYPE_LIMITS.standard) problems.defaultPpeStandard = 'type.problem.standard'
  if (draft.defaultPpeClass.trim().length > TYPE_LIMITS.ppeClass) problems.defaultPpeClass = 'type.problem.ppeClass'
  const category = draft.defaultPpeCategory ?? inherited?.defaults.defaultPpeCategory.value ?? null
  if (category === null && (trimmed(draft.defaultPpeStandard) !== null || trimmed(draft.defaultPpeClass) !== null)) problems.defaultPpeCategory = 'type.problem.ppeCategory'
  return problems
}

/** The fields the draft changes on the saved type. */
export function typeChanged(type: ProductType | null, draft: TypeDraft): string[] {
  const saved = typeDraftOf(type, draft.companyId)
  const fields: (keyof TypeDraft)[] = ['code', 'name', 'productType', 'parentId', 'requiredAttributes', 'defaultSizeScaleId', 'labelTemplateId', 'measurementTemplateId', 'defaultPpeCategory', 'defaultPpeStandard', 'defaultPpeClass']
  return fields.filter((field) => {
    const a = saved[field]
    const b = draft[field]
    if (Array.isArray(a) && Array.isArray(b)) return [...a].sort().join(',') !== [...b].sort().join(',')
    return typeof a === 'string' && typeof b === 'string' ? a.trim() !== b.trim() : a !== b
  })
}

export function createTypeBody(draft: TypeDraft): CreateTypeBody {
  return {
    companyId: draft.companyId,
    code: draft.code.trim(),
    name: draft.name.trim(),
    productType: draft.productType,
    parentId: draft.parentId,
    requiredAttributes: [...draft.requiredAttributes],
    defaultSizeScaleId: draft.defaultSizeScaleId,
    labelTemplateId: draft.labelTemplateId,
    measurementTemplateId: draft.measurementTemplateId,
    defaultPpeCategory: draft.defaultPpeCategory,
    defaultPpeStandard: trimmed(draft.defaultPpeStandard),
    defaultPpeClass: trimmed(draft.defaultPpeClass),
  } as CreateTypeBody
}

export function updateTypeBody(type: ProductType, draft: TypeDraft): UpdateTypeBody {
  const body: Record<string, unknown> = { version: type.version }
  for (const field of typeChanged(type, draft)) {
    const value = draft[field as keyof TypeDraft]
    body[field] = field === 'defaultPpeStandard' || field === 'defaultPpeClass' ? trimmed(value as string) : field === 'code' || field === 'name' ? (value as string).trim() : Array.isArray(value) ? [...value] : value
  }
  return body as UpdateTypeBody
}

/** The types ticked that Archive N / Restore N would move (the others are said by the held reason). */
export const movable = (types: readonly ProductType[], selected: readonly string[], to: 'archive' | 'restore'): ProductType[] =>
  types.filter((type) => selected.includes(type.id) && type.status === (to === 'archive' ? 'ACTIVE' : 'ARCHIVED'))

// ---- the API's refusals in this page's words ----------------------------------------------------------------------------

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  return ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract'].includes(error.kind) ? `problem.read.${error.kind}` : 'problem.read.internal'
}

export interface WriteProblem {
  readonly key: string
  /** Read again: someone changed the row meanwhile (never overwritten). */
  readonly reload: boolean
  /** The type form's fields the API refused, each with this page's words. */
  readonly fields: Readonly<Record<string, string>>
}

const FIELD_WORDS: Readonly<Record<string, string>> = Object.freeze({
  code: 'type.problem.code',
  name: 'type.problem.name',
  productType: 'type.problem.kindInUse',
  parentId: 'type.problem.parent',
  requiredAttributes: 'type.problem.required',
  defaultSizeScaleId: 'type.problem.scale',
  labelTemplateId: 'type.problem.label',
  measurementTemplateId: 'type.problem.template',
  defaultPpeCategory: 'type.problem.ppe',
  defaultPpeStandard: 'type.problem.ppe',
  defaultPpeClass: 'type.problem.ppe',
  consumptionTolerancePct: 'tolerance.problem.percent',
  consumptionToleranceByKind: 'tolerance.problem.percent',
})

export function writeProblemOf(error: unknown, scope: Scope): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false, fields: {} }
  const issues = error.issues.map((issue) => ({ path: issuePath(issue).replace(/^body[./]/, '').replace(/\./g, '/'), message: issue.message ?? '' })).filter((issue) => issue.path !== '')
  const paths = issues.map((issue) => issue.path)
  const fields: Record<string, string> = {}
  for (const issue of issues) {
    const field = issue.path.split('/')[0] ?? issue.path
    // The API says a taken code at the field (body/code "… is taken."), as the database's unique key would.
    const words = field === 'code' && /taken/i.test(issue.message) ? 'type.problem.codeTaken' : FIELD_WORDS[field]
    if (words && !fields[field]) fields[field] = words
  }
  switch (error.kind) {
    case 'conflict': {
      if (error.code === 'version_conflict' || paths.some((path) => path.split('/').includes('version')) || /load (them|it) again|meanwhile|at the same time/i.test(error.message)) return { key: 'problem.write.moved', reload: true, fields }
      if (error.code === 'invalid_state') return { key: /archived/i.test(error.message) ? 'problem.write.archived' : 'problem.write.state', reload: true, fields }
      if (/taken/i.test(error.message)) return { key: 'problem.write.codeTaken', reload: false, fields: { ...fields, code: 'type.problem.codeTaken' } }
      if (/kind of garment stays/i.test(error.message)) return { key: 'problem.write.kindInUse', reload: false, fields: { ...fields, productType: 'type.problem.kindInUse' } }
      return { key: 'problem.write.state', reload: true, fields }
    }
    case 'invalid':
      return { key: fields.code === 'type.problem.codeTaken' ? 'problem.write.codeTaken' : 'problem.write.invalid', reload: false, fields }
    case 'forbidden':
      return { key: scope === 'all' ? 'problem.write.forbiddenAll' : 'problem.write.forbidden', reload: false, fields }
    case 'signed_out':
    case 'not_found':
    case 'rate_limited':
    case 'unavailable':
      return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found', fields }
    default:
      return { key: 'problem.write.internal', reload: false, fields }
  }
}

// ---- the address of the audit log ("Changed by") ------------------------------------------------------------------------

export function auditHref(prefix: string, recordType: string, recordId?: string | null): string {
  const query = new URLSearchParams({ type: recordType })
  if (recordId) query.set('record', recordId)
  return `${prefix}/admin/audit?${query.toString()}`
}
