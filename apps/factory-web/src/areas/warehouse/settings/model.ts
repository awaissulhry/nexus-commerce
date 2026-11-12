import { SEPARATION_RULES, type SeparationRule } from '@nexus/factory-domain/inventory/counts-depth/separation'
import { DEFAULT_PURPOSES, HELD_ITEM_KINDS, LOCATION_KIND_PROFILES, mayHold, type DefaultPurpose, type HeldItemKind } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import type { LocationKind } from '@nexus/factory-domain/inventory/locations/rules'
import { adjustmentLimitLoosened, backDatingLoosened, BACK_DATING_LIMITS, MAX_ADJUSTMENT_AMOUNT } from '@nexus/factory-domain/inventory/posting/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { ApprovalRule, AuditEntry, DefaultRow, Place, RulesAnswer, RulesView, SeparationBody, SeparationView, SetDefaultBody, SitePlaces } from './api'

/**
 * Warehouse rules (SCR-258, B-W2b-355), the rules without React: the address, what each card shows and sends, when a change
 * loosens a rule (it asks the reason and a fresh code), why a control is held, and the API's refusals in this page's words
 * (keys of `warehouse-settings`). Pure, so the tests hold it. The rules in force come from the API; "what applies once saved"
 * follows the same order the API and the database read: the company's own value, else every company's, else the default.
 */

export { BACK_DATING_LIMITS, DEFAULT_PURPOSES, HELD_ITEM_KINDS, SEPARATION_RULES }
export type { DefaultPurpose, HeldItemKind, SeparationRule }

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

/**
 * "Changed by Anna Demo · 12/11 09:42"; `by` null: the time without a name. `row`: the change is the rules row's last one
 * (any of its cards: without audit.read the page cannot tell which card changed).
 */
export interface ChangedBy {
  readonly at: string
  readonly by: string | null
  readonly row?: boolean
}

export type Source = 'COMPANY' | 'TENANT' | 'DEFAULT'

// ---- the address ----------------------------------------------------------------------------------------------------------

/** Whose rules: the address's company (with what it follows), or every company's. */
export type Scope = 'company' | 'all'

export interface Address {
  readonly scope: Scope
  /** The site whose default places are shown (null: the first one). */
  readonly site: string | null
}
export const NO_ADDRESS: Address = { scope: 'company', site: null }

export function addressOf(params: { get(name: string): string | null } | null): Address {
  return { scope: params?.get('scope') === 'all' ? 'all' : 'company', site: params?.get('site') || null }
}

export function queryOf(address: Address): string {
  const query = new URLSearchParams()
  if (address.scope === 'all') query.set('scope', 'all')
  if (address.site) query.set('site', address.site)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** Where other pages open (company-scoped: the caller passes `/w/<company>`). */
export const adminRuleHref = (prefix: string, ruleId: string | 'new'): string => `${prefix}/admin/automation?view=approvals&rule=${encodeURIComponent(ruleId)}`
export const inboxHref = (prefix: string): string => `${prefix}/home/approvals?kind=STOCK_ADJUSTMENT`
export const crViHref = (prefix: string): string => `${prefix}/compliance/settings?tab=cr6`
export const accountingHref = (prefix: string): string => `${prefix}/finance/accounting`
export const locationsHref = (prefix: string): string => `${prefix}/warehouse/locations`
/** Where a separation rule bites: the counts (approving a difference), the payables (approving an invoice, a match difference). */
export const ruleWhereHref = (prefix: string, rule: SeparationRule): string => (rule === 'COUNTER_NOT_APPROVER' ? `${prefix}/warehouse/counts` : `${prefix}/finance/payables`)
export function auditHref(prefix: string, recordType: string, recordId?: string | null): string {
  const query = new URLSearchParams({ type: recordType })
  if (recordId) query.set('record', recordId)
  return `${prefix}/admin/audit?${query.toString()}`
}

/** The InventorySettings row a scope writes: the company's (id = the company's) or every company's (id = the tenant's). */
export const rowIdOf = (scope: Scope, companyId: string | null, tenantId: string): string | null => (scope === 'company' ? companyId : tenantId)

/** The body's company: the address's company, or null for every company. */
export const bodyCompany = (scope: Scope, companyId: string | null): string | null => (scope === 'company' ? companyId : null)

/** The newest version of the shared rules row the page read (both cards' reads carry it). */
export function rowVersion(rules: Pick<RulesView, 'version'> | null, separation: Pick<SeparationView, 'version'> | null): number {
  return Math.max(rules?.version ?? 0, separation?.version ?? 0)
}

// ---- held -------------------------------------------------------------------------------------------------------------------

/** Why a rules card's Save is held now, or null. */
export function rulesHeld(input: { readonly may: boolean | null; readonly scope: Scope; readonly offline: boolean; readonly busy: boolean }): string | null {
  if (input.may === null) return 'held.reading'
  if (input.busy) return 'held.busy'
  if (!input.may) return input.scope === 'all' ? 'held.noRightAll' : 'held.noRight'
  if (input.offline) return 'held.offline'
  return null
}

// ---- separation of duties (ws-sod) ---------------------------------------------------------------------------------------

/** The scope's own value per switch: true / false, or null (as every company, or the default: on). */
export type SeparationDraft = Readonly<Record<SeparationRule, boolean | null>>

export interface InForce<Value> {
  readonly value: Value
  readonly source: Source
}

export const separationDraftOf = (view: SeparationView): SeparationDraft =>
  Object.fromEntries(SEPARATION_RULES.map((rule) => [rule, view.switches.find((entry) => entry.rule === rule)?.own ?? null])) as SeparationDraft

const switchOf = (view: SeparationView, rule: SeparationRule) => view.switches.find((entry) => entry.rule === rule) ?? null

/**
 * What a switch follows when the scope keeps no value of its own: every company's switch (a company), the default ON (every
 * company). Null: not known (every company's rules not read, and the company keeps its own now).
 */
export function followedSwitch(rule: SeparationRule, scope: Scope, view: SeparationView, tenant: SeparationView | null): InForce<boolean> | null {
  if (scope === 'all') return { value: true, source: 'DEFAULT' }
  const fromTenant = tenant ? switchOf(tenant, rule)?.inForce : null
  if (fromTenant) return { value: fromTenant.on, source: fromTenant.source === 'COMPANY' ? 'TENANT' : fromTenant.source }
  const now = switchOf(view, rule)?.inForce
  return now && now.source !== 'COMPANY' ? { value: now.on, source: now.source } : null
}

/** The switch in force once the draft is saved (null: not known). */
export function switchAfter(rule: SeparationRule, scope: Scope, draft: SeparationDraft, view: SeparationView, tenant: SeparationView | null): InForce<boolean> | null {
  const own = draft[rule]
  if (own !== null) return { value: own, source: scope === 'company' ? 'COMPANY' : 'TENANT' }
  return followedSwitch(rule, scope, view, tenant)
}

/** The switches the draft changes (the scope's own value). */
export const separationChanges = (view: SeparationView, draft: SeparationDraft): SeparationRule[] => SEPARATION_RULES.filter((rule) => (switchOf(view, rule)?.own ?? null) !== draft[rule])

/**
 * The switches the draft turns off, or may turn off (on now, off — or not known — once saved): each widens what one person
 * can do, so Save asks the reason first and the API a fresh code. A switch set off by the scope itself asks the reason too.
 */
export function separationLoosens(view: SeparationView, draft: SeparationDraft, scope: Scope, tenant: SeparationView | null): SeparationRule[] {
  return separationChanges(view, draft).filter((rule) => {
    const before = switchOf(view, rule)?.inForce.on ?? true
    const after = switchAfter(rule, scope, draft, view, tenant)
    const switchedOff = draft[rule] === false
    return switchedOff || (before && (after === null || !after.value))
  })
}

/** What Save sends: only the switches that changed, at the row's version; the reason when one is turned off. */
export function separationBody(view: SeparationView, draft: SeparationDraft, scope: Scope, companyId: string | null, version: number, reason: string): SeparationBody {
  const changed = separationChanges(view, draft)
  const body: { -readonly [K in keyof SeparationBody]?: SeparationBody[K] } = { companyId: bodyCompany(scope, companyId), version }
  if (changed.includes('COUNTER_NOT_APPROVER')) body.counterNotApprover = draft.COUNTER_NOT_APPROVER
  if (changed.includes('RECEIVER_NOT_MATCHER')) body.receiverNotMatcher = draft.RECEIVER_NOT_MATCHER
  if (reason.trim()) body.reason = reason.trim()
  return body as SeparationBody
}

/** The longest reason the API keeps (the domain's words: 1 to 500 characters). */
export const MAX_REASON = 500

/** Why the reason as typed cannot go, or null. */
export function reasonProblem(reason: string): string | null {
  const text = reason.trim()
  if (text.length === 0) return 'problem.reasonNeeded'
  if (text.length > MAX_REASON) return 'problem.reasonLong'
  return null
}

// ---- posting dates (ws-posting) ------------------------------------------------------------------------------------------

/** OWN: the scope's own days back; FOLLOW: as every company (a company); NONE: no limit (every company). */
export type LimitMode = 'OWN' | 'FOLLOW' | 'NONE'

export interface DaysDraft {
  readonly mode: LimitMode
  readonly days: number | ''
}

export function daysDraftOf(view: RulesView, scope: Scope): DaysDraft {
  const own = view.postingDates.own
  if (own !== null) return { mode: 'OWN', days: own }
  return { mode: scope === 'company' ? 'FOLLOW' : 'NONE', days: '' }
}

/** The value Save keeps as the scope's own (null: follow, or no limit). */
export const daysValueOf = (draft: DaysDraft): number | null => (draft.mode === 'OWN' && draft.days !== '' ? draft.days : null)

/** What a company follows: every company's days back (null: no limit); undefined: not known. */
export function followedDays(scope: Scope, view: RulesView, tenant: RulesView | null): InForce<number | null> | undefined {
  if (scope === 'all') return { value: null, source: 'DEFAULT' }
  if (tenant) return { value: tenant.postingDates.inForce.days, source: tenant.postingDates.inForce.source === 'DEFAULT' ? 'DEFAULT' : 'TENANT' }
  const now = view.postingDates.inForce
  return now.source !== 'COMPANY' ? { value: now.days, source: now.source } : undefined
}

/** The days back in force once saved (undefined: not known). */
export function daysAfter(draft: DaysDraft, scope: Scope, view: RulesView, tenant: RulesView | null): InForce<number | null> | undefined {
  if (draft.mode === 'OWN') return { value: draft.days === '' ? null : draft.days, source: scope === 'company' ? 'COMPANY' : 'TENANT' }
  if (draft.mode === 'NONE') return { value: null, source: 'DEFAULT' }
  return followedDays(scope, view, tenant)
}

export const daysChanged = (view: RulesView, draft: DaysDraft): boolean => daysValueOf(draft) !== view.postingDates.own || (draft.mode === 'OWN' && draft.days === '')

export function daysProblem(draft: DaysDraft): string | null {
  if (draft.mode !== 'OWN') return null
  if (draft.days === '') return 'problem.daysNeeded'
  if (!Number.isInteger(draft.days) || draft.days < BACK_DATING_LIMITS.min || draft.days > BACK_DATING_LIMITS.max) return 'problem.daysRange'
  return null
}

/** More days back than in force now, or no limit where there is one (or not known): the reason and a code. */
export function daysLoosens(view: RulesView, draft: DaysDraft, scope: Scope, tenant: RulesView | null): boolean {
  if (!daysChanged(view, draft)) return false
  const after = daysAfter(draft, scope, view, tenant)
  const before = view.postingDates.inForce.days
  if (after === undefined) return before !== null
  return backDatingLoosened(before, after.value)
}

// ---- the adjustment value (ws-adjust; the cost grain) ---------------------------------------------------------------------

export interface AmountDraft {
  readonly mode: LimitMode
  /** In the currency's major units, as typed. */
  readonly amount: number | ''
}

/** How many decimals a currency's amounts have (EUR: 2). */
export function minorDigits(currency: string | null): number {
  if (!currency) return 2
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}
export const toMajor = (minor: number, currency: string | null): number => minor / 10 ** minorDigits(currency)
export const toMinor = (major: number, currency: string | null): number => Math.round(major * 10 ** minorDigits(currency))

/** "€ 500,00" (a company), "500.00" (every company: each in its own currency). */
export function amountWords(minor: number, currency: string | null, locale: 'it' | 'en'): string {
  const tag = locale === 'it' ? 'it-IT' : 'en-GB'
  const digits = minorDigits(currency)
  if (!currency) return new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits)
  return new Intl.NumberFormat(tag, { style: 'currency', currency }).format(minor / 10 ** digits)
}

/** The currency's sign for the field ("€"); null without a currency (every company: each its own). */
export function currencySymbol(currency: string | null, locale: 'it' | 'en'): string | null {
  if (!currency) return null
  try {
    return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency
  } catch {
    return currency
  }
}

/** The highest value the API keeps, in the currency's major units. */
export const maxAmountMajor = (currency: string | null): number => toMajor(MAX_ADJUSTMENT_AMOUNT, currency)

export function amountDraftOf(view: RulesView, scope: Scope): AmountDraft {
  const own = view.adjustmentApproval.own ?? null
  const currency = view.adjustmentApproval.currency
  if (own !== null) return { mode: 'OWN', amount: toMajor(own, currency) }
  return { mode: scope === 'company' ? 'FOLLOW' : 'NONE', amount: '' }
}

export const amountValueOf = (draft: AmountDraft, currency: string | null): number | null => (draft.mode === 'OWN' && draft.amount !== '' ? toMinor(draft.amount, currency) : null)

export const amountChanged = (view: RulesView, draft: AmountDraft): boolean =>
  amountValueOf(draft, view.adjustmentApproval.currency) !== (view.adjustmentApproval.own ?? null) || (draft.mode === 'OWN' && draft.amount === '')

export function amountProblem(draft: AmountDraft, currency: string | null): string | null {
  if (draft.mode !== 'OWN') return null
  if (draft.amount === '') return 'problem.amountNeeded'
  const minor = toMinor(draft.amount, currency)
  if (minor < 0 || minor > MAX_ADJUSTMENT_AMOUNT) return 'problem.amountRange'
  return null
}

/** What a company follows: every company's value (null: none); undefined: not known. */
export function followedAmount(scope: Scope, view: RulesView, tenant: RulesView | null): InForce<number | null> | undefined {
  if (scope === 'all') return { value: null, source: 'DEFAULT' }
  if (tenant && tenant.adjustmentApproval.held === null) {
    const inForce = tenant.adjustmentApproval.inForce
    return { value: inForce.amount ?? null, source: inForce.source === 'DEFAULT' ? 'DEFAULT' : 'TENANT' }
  }
  const now = view.adjustmentApproval.inForce
  return now.source !== 'COMPANY' && view.adjustmentApproval.held === null ? { value: now.amount ?? null, source: now.source } : undefined
}

/** The value in force once saved (undefined: not known). */
export function amountAfter(draft: AmountDraft, scope: Scope, view: RulesView, tenant: RulesView | null): InForce<number | null> | undefined {
  if (draft.mode === 'OWN') return { value: amountValueOf(draft, view.adjustmentApproval.currency), source: scope === 'company' ? 'COMPANY' : 'TENANT' }
  if (draft.mode === 'NONE') return { value: null, source: 'DEFAULT' }
  return followedAmount(scope, view, tenant)
}

/** A higher value than in force now, or none where there is one (or not known): the reason and a code. */
export function amountLoosens(view: RulesView, draft: AmountDraft, scope: Scope, tenant: RulesView | null): boolean {
  if (!amountChanged(view, draft)) return false
  const before = view.adjustmentApproval.inForce.amount ?? null
  const after = amountAfter(draft, scope, view, tenant)
  if (after === undefined) return before !== null
  return adjustmentLimitLoosened(before, after.value)
}

/** The STOCK_ADJUSTMENT rules this scope shows: a company's own and every company's, or (every company) all of them. */
export function adjustmentRulesOf(answer: RulesAnswer | null, scope: Scope, companyId: string | null): ApprovalRule[] {
  if (!answer) return []
  return answer.rules
    .filter((rule) => rule.kind === 'STOCK_ADJUSTMENT' && (scope === 'all' || rule.companyId === null || rule.companyId === companyId))
    .sort((a, b) => (a.active === b.active ? a.sequence - b.sequence || a.name.localeCompare(b.name) || a.id.localeCompare(b.id) : a.active ? -1 : 1))
}

/**
 * Whether an adjustment above the value waits for a yes now: NO_VALUE (no value set: none waits), NO_RULE (a value, but no
 * approval rule names who approves: they post without a yes — the default until the Owner switches a rule on), WAITS.
 */
export type AdjustState = 'NO_VALUE' | 'NO_RULE' | 'WAITS' | 'UNKNOWN'
export function adjustStateOf(view: RulesView): AdjustState {
  if (!view.adjustmentApproval.inForce.set) return 'NO_VALUE'
  return view.adjustmentApproval.approvalRules.active > 0 ? 'WAITS' : 'NO_RULE'
}

// ---- low-stock alerts --------------------------------------------------------------------------------------------------------

/** The scope's own switch: on, off, or null (as every company; every company's default: on). */
export type AlertsDraft = boolean | null

export function alertsAfter(draft: AlertsDraft, scope: Scope, view: RulesView, tenant: RulesView | null): InForce<boolean> | null {
  if (draft !== null) return { value: draft, source: scope === 'company' ? 'COMPANY' : 'TENANT' }
  if (scope === 'all') return { value: true, source: 'DEFAULT' }
  if (tenant) return { value: tenant.lowStockAlerts.inForce.on, source: tenant.lowStockAlerts.inForce.source === 'DEFAULT' ? 'DEFAULT' : 'TENANT' }
  const now = view.lowStockAlerts.inForce
  return now.source !== 'COMPANY' ? { value: now.on, source: now.source } : null
}

// ---- default places (ws-defaults) -------------------------------------------------------------------------------------------

/** The Combobox value of "no default" (a cell cleared). */
export const NONE_VALUE = '__none'

/** A cell of the table: a purpose × a kind of material (`*`: the site's fallback, every kind without its own). */
export type CellKey = `${DefaultPurpose}:${HeldItemKind | '*'}`
export const cellKey = (purpose: DefaultPurpose, kind: HeldItemKind | null): CellKey => `${purpose}:${kind ?? '*'}`

/** The cells typed on the page: a place's id, or null (cleared). A cell not in it keeps what is saved. */
export type DefaultsDraft = Readonly<Partial<Record<CellKey, string | null>>>

export const savedCell = (defaults: readonly DefaultRow[], purpose: DefaultPurpose, kind: HeldItemKind | null): DefaultRow | null =>
  defaults.find((row) => row.purpose === purpose && row.itemKind === kind) ?? null

/** The place a cell shows: typed, else saved; null: none. */
export function cellValue(defaults: readonly DefaultRow[], draft: DefaultsDraft, purpose: DefaultPurpose, kind: HeldItemKind | null): string | null {
  const key = cellKey(purpose, kind)
  if (key in draft) return draft[key] ?? null
  return savedCell(defaults, purpose, kind)?.location.id ?? null
}

/** The rows the table shows: the fallback first, then each kind with a default saved or typed, or added on the page, in the kinds' order. */
export function defaultKindsOf(defaults: readonly DefaultRow[], draft: DefaultsDraft, added: readonly HeldItemKind[]): (HeldItemKind | null)[] {
  const kinds = new Set<HeldItemKind>(added)
  for (const row of defaults) if (row.itemKind) kinds.add(row.itemKind)
  for (const key of Object.keys(draft)) {
    const kind = key.split(':')[1]
    if (kind && kind !== '*') kinds.add(kind as HeldItemKind)
  }
  return [null, ...HELD_ITEM_KINDS.filter((kind) => kinds.has(kind))]
}

/** The kinds a row may still be added for. */
export const addableKinds = (shown: readonly (HeldItemKind | null)[]): HeldItemKind[] => HELD_ITEM_KINDS.filter((kind) => !shown.includes(kind))

/** True when a place of this kind may be a default of the purpose for these goods (the API's own rule, factory-domain). */
export function servesCell(kind: LocationKind, purpose: DefaultPurpose, itemKind: HeldItemKind | null): boolean {
  return LOCATION_KIND_PROFILES[kind].purposes.includes(purpose) && (itemKind === null || mayHold(kind, itemKind))
}

/** The site's active places a cell may name, by code (a quality default: a quarantine place; finished garments: where they may lie …). */
export const cellOptions = (site: SitePlaces | null, purpose: DefaultPurpose, itemKind: HeldItemKind | null): Place[] =>
  (site?.locations ?? []).filter((place) => place.status === 'ACTIVE' && servesCell(place.kind, purpose, itemKind)).sort((a, b) => a.code.localeCompare(b.code))

/** The kinds of place that may serve a purpose (for the hint under a cell no place serves). */
export const kindsServing = (purpose: DefaultPurpose): LocationKind[] => (Object.keys(LOCATION_KIND_PROFILES) as LocationKind[]).filter((kind) => LOCATION_KIND_PROFILES[kind].purposes.includes(purpose))

/**
 * Where a command takes goods of a kind without a default of its own: the site's fallback when it may hold them, else
 * nothing (the command's own rule: the goods-in dock, the quarantine place, the place named). Factory-domain resolveDefault
 * for one kind.
 */
export function fallbackFor(defaults: readonly DefaultRow[], draft: DefaultsDraft, site: SitePlaces | null, purpose: DefaultPurpose, kind: HeldItemKind): Place | null {
  const id = cellValue(defaults, draft, purpose, null)
  const place = id ? (site?.locations.find((entry) => entry.id === id) ?? null) : null
  return place && place.status === 'ACTIVE' && mayHold(place.kind, kind) ? place : null
}

/** The cells that differ from what is saved. */
export function defaultChanges(defaults: readonly DefaultRow[], draft: DefaultsDraft): CellKey[] {
  return (Object.keys(draft) as CellKey[]).filter((key) => {
    const [purpose, kind] = key.split(':') as [DefaultPurpose, string]
    return (draft[key] ?? null) !== (savedCell(defaults, purpose, kind === '*' ? null : (kind as HeldItemKind))?.location.id ?? null)
  })
}

/** What Save sends, one PUT per changed cell, each at the version read (none while the cell keeps no default). */
export function defaultWrites(defaults: readonly DefaultRow[], draft: DefaultsDraft, siteId: string): SetDefaultBody[] {
  return defaultChanges(defaults, draft).map((key) => {
    const [purpose, kind] = key.split(':') as [DefaultPurpose, string]
    const itemKind = kind === '*' ? null : (kind as HeldItemKind)
    const saved = savedCell(defaults, purpose, itemKind)
    return { siteId, itemKind, purpose, locationId: draft[key] ?? null, ...(saved ? { version: saved.version } : {}) }
  })
}

/** The sites a scope shows: the company's (company scope) or every site the reader reaches. */
export const sitesOfScope = (sites: readonly SitePlaces[], scope: Scope, companyId: string | null): SitePlaces[] => sites.filter((site) => scope === 'all' || site.companyId === companyId)

/** The site of the address, else the first of the scope. */
export const siteOf = (sites: readonly SitePlaces[], address: Address): SitePlaces | null => sites.find((site) => site.id === address.site) ?? sites[0] ?? null

/** Why the defaults' Save is held now, or null. */
export function defaultsHeld(input: { readonly may: boolean; readonly offline: boolean; readonly busy: boolean }): string | null {
  if (input.busy) return 'held.busy'
  if (!input.may) return 'held.noLocationsRight'
  if (input.offline) return 'held.offline'
  return null
}

// ---- what is unsaved ----------------------------------------------------------------------------------------------------------

/** A card that saves on its own (its EditModeBar). */
export type DirtyCard = 'separation' | 'posting' | 'adjust' | 'alerts' | 'defaults'

export interface DraftState {
  readonly rules: Read<RulesView>
  readonly separation: Read<SeparationView>
  readonly separationDraft: SeparationDraft | null
  readonly daysDraft: DaysDraft | null
  readonly amountDraft: AmountDraft | null
  readonly alertsDraft: AlertsDraft | undefined
  readonly defaults: Read<DefaultRow[]> | null
  readonly defaultsDraft: DefaultsDraft
}

/** The cards holding a change, in the page's order (⌘S saves the first; SaveStatus counts them). */
export function dirtyCards(state: DraftState): DirtyCard[] {
  const rules = state.rules.value
  const separation = state.separation.value
  const cards: DirtyCard[] = []
  if (separation && state.separationDraft && separationChanges(separation, state.separationDraft).length > 0) cards.push('separation')
  if (rules && state.daysDraft && daysChanged(rules, state.daysDraft)) cards.push('posting')
  if (state.defaults?.value && defaultChanges(state.defaults.value, state.defaultsDraft).length > 0) cards.push('defaults')
  if (rules && state.amountDraft && rules.adjustmentApproval.held === null && amountChanged(rules, state.amountDraft)) cards.push('adjust')
  if (rules && state.alertsDraft !== undefined && state.alertsDraft !== rules.lowStockAlerts.own) cards.push('alerts')
  return cards
}

// ---- "Changed by" -----------------------------------------------------------------------------------------------------------

export type RulesCard = 'SEPARATION_OF_DUTIES' | 'POSTING_DATES' | 'ADJUSTMENT_APPROVAL' | 'LOW_STOCK_ALERTS'

const cardOfEntry = (entry: AuditEntry): string | null => {
  const after = entry.after
  return after && typeof after === 'object' && 'card' in after && typeof (after as { card: unknown }).card === 'string' ? (after as { card: string }).card : null
}

/**
 * A rules card's last change: the newest audit entry of that card on the scope's row (with the name), else the row's own last
 * change (any card: `row` — the audit trail is not in the role, or holds no save of this card: a value seeded or older than the
 * entries read), else null (the scope keeps no row: never changed here).
 */
export function cardChangedOf(card: RulesCard, view: Pick<RulesView, 'version' | 'updatedAt' | 'changedBy'> | null, audit: readonly AuditEntry[] | null): ChangedBy | null {
  if (!view || view.version === 0 || !view.updatedAt) return null
  const entry = audit?.find((row) => row.action === 'inventory.rules.save' && cardOfEntry(row) === card)
  if (entry) return { at: entry.at, by: entry.actorName }
  return { at: view.updatedAt, by: view.changedBy?.name ?? null, row: true }
}

/** The defaults' last change: the audit trail's (with the name), else the newest default's own time. */
export function defaultsChangedOf(defaults: readonly DefaultRow[] | null, audit: readonly AuditEntry[] | null): ChangedBy | null {
  const entry = audit?.[0]
  if (entry) return { at: entry.at, by: entry.actorName }
  const newest = [...(defaults ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return newest ? { at: newest.updatedAt, by: null } : null
}

/** The newest change among the approval rules shown (the API names who changed each). */
export function rulesChangedOf(rules: readonly ApprovalRule[]): ChangedBy | null {
  const newest = [...rules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return newest ? { at: newest.updatedAt, by: newest.changedBy?.name ?? null } : null
}

// ---- the API's answers in this page's words -----------------------------------------------------------------------------------

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  return ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract'].includes(error.kind) ? `problem.read.${error.kind}` : 'problem.read.internal'
}

export interface WriteProblem {
  readonly key: string
  /** Read again: the row moved meanwhile (never overwritten). */
  readonly reload: boolean
  /** The API asks the reason: the card shows its field. */
  readonly reason: boolean
}

export function writeProblemOf(error: unknown, scope: Scope): WriteProblem {
  const plain = (key: string, reload = false): WriteProblem => ({ key, reload, reason: false })
  if (!isApiError(error)) return plain('problem.write.internal')
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[./]/, ''))
  switch (error.kind) {
    case 'conflict':
      return plain('problem.write.moved', true)
    case 'invalid':
      if (paths.includes('reason')) return { key: 'problem.write.reasonNeeded', reload: false, reason: true }
      if (paths.includes('version')) return plain('problem.write.moved', true)
      if (paths.includes('locationId')) return plain('problem.write.placeRefused', true)
      return plain('problem.write.invalid')
    case 'forbidden':
      return plain(/cost/i.test(error.message) ? 'problem.write.noCost' : scope === 'all' ? 'problem.write.forbiddenAll' : 'problem.write.forbidden')
    case 'not_found':
      return plain('problem.write.not_found', true)
    case 'step_up':
      return plain('stepUp.cancelled')
    case 'signed_out':
    case 'rate_limited':
    case 'unavailable':
      return plain(`problem.write.${error.kind}`)
    default:
      return plain('problem.write.internal')
  }
}

/** Every write problem key this page may say (the catalogue test reads them). */
export const WRITE_PROBLEM_KEYS = ['moved', 'reasonNeeded', 'placeRefused', 'invalid', 'noCost', 'forbidden', 'forbiddenAll', 'not_found', 'signed_out', 'rate_limited', 'unavailable', 'internal'] as const
export const READ_PROBLEM_KEYS = ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'contract', 'internal'] as const
export const LIVE_EVENTS = ['inventory.rules_changed', 'inventory.default_location_changed', 'approval.rule_changed', 'quality.settings_changed'] as const
export const SOURCES: readonly Source[] = ['COMPANY', 'TENANT', 'DEFAULT']
