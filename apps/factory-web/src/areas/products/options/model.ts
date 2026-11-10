import type { CreateEffectBody, CreateGroupBody, CreateValueBody, EffectView, GroupRowView, GroupView, RuleView, StyleOptionsView, UpdateEffectBody, UpdateGroupBody, ValueView } from '@nexus/factory-domain/product/options/contracts'
import { ANY_OPTION, defaultPicks, OPTION_GROUP_KINDS, OPTION_LIMITS, PART_EFFECT_KINDS, RULE_SUBJECT_FIELD, type OptionGroupKind, type OptionRuleKind, type OptionRuleSeverity, type PartEffectKind } from '@nexus/factory-domain/product/options/rules'
import type { RuleDraft as UiRuleDraft, RuleOperator } from '@nexus/ui/patterns/RuleBuilder/index'
import type { RulesInput } from './api'

/**
 * Products › Options & rules (B-W2b-242; SCR-114; design products.options): the screens' rules, pure. The list's filters in
 * the address, what a person may do, the notices, the forms' problems in this catalogue's words (`products-options`), and
 * the bodies the API takes (B-W2b-229's contracts). factory-domain's product/options/rules says the same rules in the
 * API's English; here each one is a message key the page translates, never the API's sentence.
 */

export type GroupRow = GroupRowView
export type GroupRecord = GroupView
export type OptionValue = ValueView
export type OptionRule = RuleView
export type OptionEffect = EffectView
export type GroupOffer = GroupView['styles'][number]
export type StyleOptions = StyleOptionsView
export type { OptionGroupKind, OptionRuleKind, OptionRuleSeverity, PartEffectKind }
export { ANY_OPTION, OPTION_GROUP_KINDS, OPTION_LIMITS, PART_EFFECT_KINDS }

/** A problem of a form: the field it is about and its words (a `products-options` key). */
export interface DraftProblem {
  field: string
  key: string
  params?: Record<string, string | number>
}

// ---- the list's filters (the address) -------------------------------------------------------------------------------

/** Rows ▾ (the design's saved rows: Active; All) and the archived groups. */
export const OPTION_VIEWS = ['active', 'all', 'archived'] as const
export type OptionListView = (typeof OPTION_VIEWS)[number]

export interface OptionFilters {
  view: OptionListView
  q: string
  /** The selection kind (SINGLE, MULTI, FREE_TEXT); another word is not applied and said so. */
  kind: string
  /** The tile "Options that take a garment outside its certificate". */
  outside: boolean
  /** The Style studio's link: the groups this style offers, with its option lines and steps. */
  style: string
}

export const NO_FILTERS: OptionFilters = { view: 'active', q: '', kind: '', outside: false, style: '' }

export const isKind = (value: string): value is OptionGroupKind => (OPTION_GROUP_KINDS as readonly string[]).includes(value)

export function filtersOf(params: { get(name: string): string | null } | null | undefined): OptionFilters {
  const view = params?.get('view') ?? ''
  return {
    view: (OPTION_VIEWS as readonly string[]).includes(view) ? (view as OptionListView) : 'active',
    q: (params?.get('q') ?? '').slice(0, 100),
    kind: (params?.get('kind') ?? '').trim().slice(0, 40),
    outside: params?.get('outside') === '1',
    style: (params?.get('style') ?? '').trim().slice(0, 60),
  }
}

/** The address's terms (`?view=all&kind=MULTI&outside=1&style=…`); `new` opens New option group. */
export function searchOf(filters: OptionFilters, extra: { new?: boolean } = {}): string {
  const search = new URLSearchParams()
  if (filters.view !== 'active') search.set('view', filters.view)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  if (filters.kind) search.set('kind', filters.kind)
  if (filters.outside) search.set('outside', '1')
  if (filters.style) search.set('style', filters.style)
  if (extra.new) search.set('new', '1')
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const isFiltered = (filters: OptionFilters): boolean => filters.view !== 'active' || filters.q.trim() !== '' || filters.kind !== '' || filters.outside || filters.style !== ''

/** What the API is asked, and the terms it could not apply (`kind=XYZ`: a word that is no kind is never sent). */
export function listQueryOf(filters: OptionFilters): { query: Record<string, string | undefined>; ignored: string[] } {
  return {
    query: {
      status: filters.view === 'all' ? 'ALL' : filters.view === 'archived' ? 'ARCHIVED' : 'ACTIVE',
      kind: isKind(filters.kind) ? filters.kind : undefined,
      q: filters.q.trim() || undefined,
      outsideCertificate: filters.outside ? 'true' : undefined,
    },
    ignored: filters.kind && !isKind(filters.kind) ? [`kind=${filters.kind}`] : [],
  }
}

/** The groups a style offers (active offers): the list shows only them while the style's link is on. */
export const offeredGroupIds = (options: StyleOptions | null | undefined): Set<string> => new Set((options?.offers ?? []).filter((offer) => offer.status === 'ACTIVE').map((offer) => offer.group.id))

/** The rows the grid shows: the API's, narrowed to the style's offers when its link is on (null while it is read). */
export function shownRows(rows: readonly GroupRow[] | null, style: { options: StyleOptions | null; problem: string | null } | null): GroupRow[] | null {
  if (!rows) return null
  if (!style) return [...rows]
  if (style.problem) return [...rows]
  if (!style.options) return null
  const ids = offeredGroupIds(style.options)
  return rows.filter((row) => ids.has(row.id))
}

/**
 * A refused write in the libraries' words, with one more case of this page: the API answers a taken code of a group or an
 * option as an invalid field (400, "… is taken"), said as "this code is already used".
 */
export function formProblem<P extends { key: string; messages: string[]; paths: string[] }>(problem: P): P {
  return problem.key === 'problem.write.invalid' && problem.messages.some((message) => /\bis taken\b/.test(message)) ? { ...problem, key: 'problem.write.codeTaken' } : problem
}

// ---- who may do what ------------------------------------------------------------------------------------------------

export interface OptionsCan {
  /** product.styles.view: the library, a style's offers. */
  view: boolean
  /** product.options.manage: groups, values, free-text rules, rules and effects. */
  manage: boolean
  /** product.options.price + money.price: an option's price surcharge. */
  price: boolean
  /** money.price: the surcharge is shown at all (the API drops it otherwise). */
  seesPrice: boolean
  /** money.cost: the cost column is listed (it comes with costing, W2b-6). */
  seesCost: boolean
  /** product.styles.manage: offer a group on a style, its own picks, withdraw it. */
  offer: boolean
  /** product.materials.view: the material picker of an effect. */
  materials: boolean
  /** product.routing.view: the operation picker of an effect. */
  operations: boolean
}

export function optionsCan(permissions: readonly string[]): OptionsCan {
  const held = new Set(permissions)
  return {
    view: held.has('product.styles.view'),
    manage: held.has('product.options.manage'),
    price: held.has('product.options.price') && held.has('money.price'),
    seesPrice: held.has('money.price'),
    seesCost: held.has('money.cost'),
    offer: held.has('product.styles.manage'),
    materials: held.has('product.materials.view'),
    operations: held.has('product.routing.view'),
  }
}

// ---- notices (one Banner at a time, the most serious first; dismissed by value) --------------------------------------

export const DISMISSED_STORE = 'factory.products.options.dismissed'

export type OptionNoticeKind = 'IGNORED_FILTER' | 'STYLE_UNREAD' | 'NO_OPTIONS' | 'NOT_OFFERED'

export interface OptionNotice {
  kind: OptionNoticeKind
  /** What the notice is about (the term, the style, the codes): a new fact is a new value, so it shows again. */
  value: string
  count: number
  /** The first codes it names. */
  codes: string[]
}

export const NOTICE_TONE: Readonly<Record<OptionNoticeKind, 'warning' | 'info'>> = { IGNORED_FILTER: 'warning', STYLE_UNREAD: 'warning', NO_OPTIONS: 'warning', NOT_OFFERED: 'info' }

export const noticeKey = (notice: Pick<OptionNotice, 'kind' | 'value'>): string => `${notice.kind}:${notice.value}`

/**
 * The page's notices, the most serious first: a filter the server did not apply and the style the link names that could
 * not be read (warnings, never dismissed: their action removes them), active groups without options (a style that offers
 * one asks nothing of it), active groups no style offers yet (info).
 */
export function noticesOf(input: { ignored: readonly string[]; styleUnread: string | null; rows: readonly GroupRow[] | null }, dismissed: ReadonlySet<string>): OptionNotice[] {
  const notices: OptionNotice[] = input.ignored.map((term) => ({ kind: 'IGNORED_FILTER' as const, value: term, count: 1, codes: [] }))
  if (input.styleUnread) notices.push({ kind: 'STYLE_UNREAD', value: input.styleUnread, count: 1, codes: [] })
  const active = (input.rows ?? []).filter((row) => row.status === 'ACTIVE')
  const empty = active.filter((row) => row.values === 0).map((row) => row.code).sort()
  if (empty.length > 0) notices.push({ kind: 'NO_OPTIONS', value: empty.join(','), count: empty.length, codes: empty.slice(0, 5) })
  const unoffered = active.filter((row) => row.values > 0 && row.styles === 0).map((row) => row.code).sort()
  if (unoffered.length > 0) notices.push({ kind: 'NOT_OFFERED', value: unoffered.join(','), count: unoffered.length, codes: unoffered.slice(0, 5) })
  return notices.filter((notice) => notice.kind === 'IGNORED_FILTER' || notice.kind === 'STYLE_UNREAD' || !dismissed.has(noticeKey(notice)))
}

// ---- groups: New option group and Edit group -------------------------------------------------------------------------

export interface GroupDraft {
  /** '' = every company (a tenant-wide group; a grant over every company). */
  companyId: string
  code: string
  name: string
  description: string
  kind: OptionGroupKind
  /** Typed whole numbers; an empty maximum = no maximum. */
  minPicks: string
  maxPicks: string
}

const picksText = (value: number | null): string => (value === null ? '' : String(value))

/** A group's own fields (the list's row and the record share them). */
export type GroupFields = Pick<GroupRow, 'code' | 'name' | 'description' | 'companyId' | 'kind' | 'minPicks' | 'maxPicks' | 'version'>

export function groupDraftOf(group: GroupFields | null, companyId: string | null): GroupDraft {
  if (group) return { companyId: group.companyId ?? '', code: group.code, name: group.name, description: group.description ?? '', kind: group.kind, minPicks: String(group.minPicks), maxPicks: picksText(group.maxPicks) }
  const picks = defaultPicks('SINGLE')
  return { companyId: companyId ?? '', code: '', name: '', description: '', kind: 'SINGLE', minPicks: String(picks.minPicks), maxPicks: picksText(picks.maxPicks) }
}

/** Another kind: picks still at the old kind's start take the new kind's (a single choice 0–1, the others 0–any). */
export function withKind(draft: GroupDraft, kind: OptionGroupKind): GroupDraft {
  const before = defaultPicks(draft.kind)
  const after = defaultPicks(kind)
  const untouched = draft.minPicks.trim() === String(before.minPicks) && draft.maxPicks.trim() === picksText(before.maxPicks)
  return untouched ? { ...draft, kind, minPicks: String(after.minPicks), maxPicks: picksText(after.maxPicks) } : { ...draft, kind }
}

/** A typed whole number: null when empty, undefined when it is not one. */
export function wholeOf(text: string): number | null | undefined {
  const value = text.trim()
  if (value === '') return null
  return /^\d{1,4}$/.test(value) ? Number(value) : undefined
}

/** A group's picks (factory-domain groupPicksProblems, in words): at least 0–100, at most 1–100 or none, a single choice 0–1. */
export function picksProblems(kind: OptionGroupKind, minText: string, maxText: string): DraftProblem[] {
  const problems: DraftProblem[] = []
  const min = wholeOf(minText)
  const max = wholeOf(maxText)
  if (min === null || min === undefined || min > OPTION_LIMITS.picks) problems.push({ field: 'minPicks', key: 'group.problem.min', params: { max: OPTION_LIMITS.picks } })
  if (max === undefined || (max !== null && (max < 1 || max > OPTION_LIMITS.picks))) problems.push({ field: 'maxPicks', key: 'group.problem.max', params: { max: OPTION_LIMITS.picks } })
  else if (max !== null && typeof min === 'number' && max < min) problems.push({ field: 'maxPicks', key: 'group.problem.maxBelow', params: { min, max } })
  if (kind === 'SINGLE') {
    if (max !== 1 && !problems.some((problem) => problem.field === 'maxPicks')) problems.push({ field: 'maxPicks', key: 'group.problem.singleMax' })
    if (typeof min === 'number' && min > 1) problems.push({ field: 'minPicks', key: 'group.problem.singleMin' })
  }
  return problems
}

const CODE = /^\S+$/

export function groupDraftProblems(draft: GroupDraft): DraftProblem[] {
  const problems: DraftProblem[] = []
  const code = draft.code.trim()
  if (code === '') problems.push({ field: 'code', key: 'group.problem.code' })
  else if (!CODE.test(code) || code.length > OPTION_LIMITS.code) problems.push({ field: 'code', key: 'group.problem.codeForm', params: { max: OPTION_LIMITS.code } })
  const name = draft.name.trim()
  if (name === '') problems.push({ field: 'name', key: 'group.problem.name' })
  else if (name.length > OPTION_LIMITS.name) problems.push({ field: 'name', key: 'group.problem.long', params: { max: OPTION_LIMITS.name } })
  if (draft.description.trim().length > OPTION_LIMITS.description) problems.push({ field: 'description', key: 'group.problem.long', params: { max: OPTION_LIMITS.description } })
  problems.push(...picksProblems(draft.kind, draft.minPicks, draft.maxPicks))
  return problems
}

export function createGroupBodyOf(draft: GroupDraft): CreateGroupBody {
  return {
    companyId: draft.companyId || null,
    code: draft.code.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    kind: draft.kind,
    minPicks: wholeOf(draft.minPicks) ?? 0,
    maxPicks: wholeOf(draft.maxPicks) ?? null,
  }
}

/** Only what changed, at the group's version (null: nothing changed). The company never changes. */
export function updateGroupBodyOf(group: GroupFields, draft: GroupDraft): UpdateGroupBody | null {
  const body: UpdateGroupBody = { version: group.version }
  const code = draft.code.trim()
  const name = draft.name.trim()
  const description = draft.description.trim() || null
  const min = wholeOf(draft.minPicks) ?? 0
  const max = wholeOf(draft.maxPicks) ?? null
  if (code !== group.code) body.code = code
  if (name !== group.name) body.name = name
  if (description !== (group.description ?? null)) body.description = description
  if (draft.kind !== group.kind) body.kind = draft.kind
  if (min !== group.minPicks) body.minPicks = min
  if (max !== group.maxPicks) body.maxPicks = max
  return Object.keys(body).length > 1 ? body : null
}

/** Archive N / Restore N held: none of the selected can move, or no right (null: it may). */
export function moveHeldKey(rows: readonly GroupRow[], can: Pick<OptionsCan, 'manage'>, to: 'archive' | 'restore'): string | null {
  if (!can.manage) return 'held.noManage'
  const from = to === 'archive' ? 'ACTIVE' : 'ARCHIVED'
  if (!rows.some((row) => row.status === from)) return to === 'archive' ? 'held.noneActive' : 'held.noneArchived'
  return null
}

// ---- values (the Options tab) ---------------------------------------------------------------------------------------

export interface ValueDraft {
  code: string
  name: string
  freeText: boolean
  maxLength: string
  pattern: string
}

/** A free-text value's length when the person switches it on (a name to embroider). */
export const FREE_TEXT_START = 30

export const valueDraftOf = (kind: OptionGroupKind): ValueDraft => ({ code: '', name: '', freeText: kind === 'FREE_TEXT', maxLength: kind === 'FREE_TEXT' ? String(FREE_TEXT_START) : '', pattern: '' })

/** Why a free-text pattern cannot be a rule (factory-domain patternProblem, in words), or null. */
export function patternProblemKey(pattern: string): string | null {
  if (pattern.length < 1 || pattern.length > OPTION_LIMITS.pattern) return 'value.problem.patternLength'
  if (/\[\[?:[a-z]+:\]/.test(pattern)) return 'value.problem.patternClass'
  if (/\\[pP]\{/.test(pattern)) return 'value.problem.patternUnicode'
  try {
    new RegExp(pattern, 'u')
  } catch {
    return 'value.problem.pattern'
  }
  return null
}

/** A typed maximum length of a free text: 1 to 500. */
export const maxLengthProblemKey = (text: string): string | null => {
  const value = wholeOf(text)
  return value === null || value === undefined || value < 1 || value > OPTION_LIMITS.freeTextLength ? 'value.problem.maxLength' : null
}

export function valueDraftProblems(draft: ValueDraft, kind: OptionGroupKind, values: readonly OptionValue[]): DraftProblem[] {
  const problems: DraftProblem[] = []
  const code = draft.code.trim()
  if (code === '') problems.push({ field: 'code', key: 'value.problem.code' })
  else if (!CODE.test(code) || code.length > OPTION_LIMITS.code) problems.push({ field: 'code', key: 'group.problem.codeForm', params: { max: OPTION_LIMITS.code } })
  else if (values.some((value) => value.code === code)) problems.push({ field: 'code', key: 'value.problem.codeTaken', params: { code } })
  if (draft.name.trim() === '') problems.push({ field: 'name', key: 'value.problem.name' })
  else if (draft.name.trim().length > OPTION_LIMITS.name) problems.push({ field: 'name', key: 'group.problem.long', params: { max: OPTION_LIMITS.name } })
  if (kind === 'FREE_TEXT' && !draft.freeText) problems.push({ field: 'freeText', key: 'value.problem.freeTextGroup' })
  if (draft.freeText) {
    const length = maxLengthProblemKey(draft.maxLength)
    if (length) problems.push({ field: 'maxLength', key: length, params: { max: OPTION_LIMITS.freeTextLength } })
    if (draft.pattern !== '') {
      const pattern = patternProblemKey(draft.pattern)
      if (pattern) problems.push({ field: 'pattern', key: pattern, params: { max: OPTION_LIMITS.pattern } })
    }
  }
  return problems
}

export function addValueBodyOf(draft: ValueDraft): CreateValueBody {
  return {
    code: draft.code.trim(),
    name: draft.name.trim(),
    freeText: draft.freeText,
    freeTextMaxLength: draft.freeText ? (wholeOf(draft.maxLength) ?? FREE_TEXT_START) : null,
    freeTextPattern: draft.freeText && draft.pattern !== '' ? draft.pattern : null,
  }
}

/** The values in the configurator's order, the archived ones after them. */
export const valuesInOrder = (values: readonly OptionValue[]): OptionValue[] => [...values].sort((a, b) => (a.status === b.status ? a.seq - b.seq || (a.code < b.code ? -1 : 1) : a.status === 'ACTIVE' ? -1 : 1))

/** The place a value takes when moved up or down among the active ones (its seq between its new neighbours), or null at an end. */
export function movedSeq(values: readonly OptionValue[], valueId: string, by: -1 | 1): number | null {
  const active = valuesInOrder(values).filter((value) => value.status === 'ACTIVE')
  const index = active.findIndex((value) => value.id === valueId)
  const target = index + by
  if (index < 0 || target < 0 || target >= active.length) return null
  const other = active[target]!
  const beyond = active[target + by]
  if (!beyond) return by < 0 ? Math.max(0, other.seq - 10) : other.seq + 10
  const between = Math.round((other.seq + beyond.seq) / 2)
  // No room between the neighbours: just past the one it moves over (the API keeps seq as given).
  return between === other.seq || between === beyond.seq ? other.seq + by : between
}

// ---- the price surcharge (money.price) ------------------------------------------------------------------------------

export interface Surcharge {
  amount: string | null
  currency: string | null
  percent: string | null
}

export const DEFAULT_CURRENCY = 'EUR'

/** A value's surcharge: null without one; undefined when the answer carried no price (no price grain). */
export function surchargeOf(effects: readonly OptionEffect[], valueId: string): Surcharge | null | undefined {
  const price = effects.find((effect) => effect.valueId === valueId && effect.kind === 'PRICE')
  if (!price) return null
  if (price.priceDelta === undefined && price.pricePct === undefined) return undefined
  return { amount: (price.priceDelta as string | null | undefined) ?? null, currency: price.currency, percent: (price.pricePct as string | null | undefined) ?? null }
}

const signed = (value: string, format: (value: number) => string): string => (value.startsWith('-') ? `−${format(Math.abs(Number(value)))}` : `+${format(Number(value))}`)

/** "+35,00 EUR", "+10 %", "—" (none). */
export function surchargeText(surcharge: Surcharge | null | undefined, locale: string): string {
  if (!surcharge) return '—'
  if (surcharge.percent !== null) return `${signed(surcharge.percent, (value) => new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value))} %`
  if (surcharge.amount !== null) return `${signed(surcharge.amount, (value) => new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value))} ${surcharge.currency ?? ''}`.trim()
  return '—'
}

/** The text the cell opens on: "35.5 EUR", "10 %", "". */
export function surchargeEditText(surcharge: Surcharge | null | undefined): string {
  if (!surcharge) return ''
  if (surcharge.percent !== null) return `${surcharge.percent} %`
  if (surcharge.amount !== null) return `${surcharge.amount} ${surcharge.currency ?? DEFAULT_CURRENCY}`
  return ''
}

/** A typed decimal ("1,5", "+2", "-0.25") as the API's plain decimal, or undefined when it is not one; "" → null. */
export function decimalOf(text: string): string | null | undefined {
  const value = text.trim().replace(/^\+/, '')
  if (value === '') return null
  if (!/^-?\d+([.,]\d+)?$/.test(value)) return undefined
  const plain = value.replace(',', '.').replace(/^(-?)0+(?=\d)/, '$1')
  return /^-?0(\.0+)?$/.test(plain) ? '0' : plain
}

const decimals = (value: string): number => value.split('.')[1]?.length ?? 0

/**
 * What a typed surcharge sends (factory-domain effectProblems' PRICE rule, in words): "35" or "35 EUR" an amount in a
 * currency (EUR when none is typed), "-25 USD", "10 %" a percent of the price (−100 to 1000); "" no surcharge. Never 0.
 */
export function parseSurcharge(text: string): { ok: true; body: { priceDelta?: string; currency?: string; pricePct?: string } } | { ok: false; key: string } {
  const typed = text.trim().replace(/\s+/g, ' ')
  if (typed === '' || typed === '—') return { ok: true, body: {} }
  const percent = /^([+-]?\d+(?:[.,]\d+)?) ?%$/.exec(typed)
  if (percent) {
    const value = decimalOf(percent[1]!)
    if (!value || value === '0') return { ok: false, key: 'price.problem.zero' }
    if (Number(value) < OPTION_LIMITS.pctMin || Number(value) > OPTION_LIMITS.pctMax || decimals(value) > 4) return { ok: false, key: 'price.problem.percent' }
    return { ok: true, body: { pricePct: value } }
  }
  const amount = /^(?:([A-Za-z]{3}) ?)?([+-]?\d+(?:[.,]\d+)?)(?: ?([A-Za-z]{3}))?$/.exec(typed)
  if (amount && !(amount[1] && amount[3])) {
    const value = decimalOf(amount[2]!)
    if (!value || value === '0') return { ok: false, key: 'price.problem.zero' }
    if (decimals(value) > 6 || value.replace(/^-/, '').split('.')[0]!.length > 12) return { ok: false, key: 'price.problem.amount' }
    return { ok: true, body: { priceDelta: value, currency: (amount[1] ?? amount[3] ?? DEFAULT_CURRENCY).toUpperCase() } }
  }
  return { ok: false, key: 'price.problem.form' }
}

// ---- rules (the Rules tab: RuleBuilder + the outcome, saved as a set) -------------------------------------------------

/** One rule as the tab edits it: the RuleBuilder's subject row, then the outcome's own controls. */
export interface RuleItem {
  /** Stable on the page (the rule's id, or a new key). */
  key: string
  id: string | null
  when: UiRuleDraft
  kind: OptionRuleKind
  /** The other option's group (picked first: the values of another group are read on demand). */
  otherGroupId: string | null
  otherValueId: string | null
  severity: OptionRuleSeverity
  messageIt: string
  messageEn: string
  /** Off: kept, switched off (ARCHIVED). */
  active: boolean
}

export function ruleItemsOf(group: Pick<GroupRecord, 'rules'>): RuleItem[] {
  return group.rules.map((rule) => ({
    key: rule.id,
    id: rule.id,
    when: { combinator: rule.when.combinator, rows: rule.when.rows.map((row) => ({ id: row.id, field: row.field, operator: row.operator as RuleOperator | null, value: row.value })) },
    kind: rule.kind,
    otherGroupId: rule.other.groupId,
    otherValueId: rule.otherValueId,
    severity: rule.severity,
    messageIt: rule.messageI18n?.['it'] ?? '',
    messageEn: rule.messageI18n?.['en'] ?? '',
    active: rule.status === 'ACTIVE',
  }))
}

export const newRuleItem = (key: string, groupId: string): RuleItem => ({
  key,
  id: null,
  when: { combinator: 'and', rows: [{ id: 'subject', field: RULE_SUBJECT_FIELD, operator: 'eq', value: null }] },
  kind: 'EXCLUDES',
  otherGroupId: groupId,
  otherValueId: null,
  severity: 'BLOCK',
  messageIt: '',
  messageEn: '',
  active: true,
})

/** The value the rule is about: a value id, ANY_OPTION, or null while none is picked. */
export function subjectOf(item: Pick<RuleItem, 'when'>): string | null {
  const row = item.when.rows[0]
  return item.when.rows.length === 1 && row?.field === RULE_SUBJECT_FIELD && row.operator === 'eq' && typeof row.value === 'string' && row.value !== '' ? row.value : null
}

/**
 * The rules' problems as the API's rulesProblems says them (in words): a subject and another option picked, not the same,
 * a rule about any option of the group names an option of another group, a message at most 500 characters, no rule twice,
 * no subject both requiring and excluding the same option.
 */
export function ruleProblems(items: readonly RuleItem[], groupId: string, valueGroup: (valueId: string) => string | undefined): Array<{ index: number; key: string; params?: Record<string, number> }> {
  const problems: Array<{ index: number; key: string; params?: Record<string, number> }> = []
  const seen = new Map<string, number>()
  items.forEach((item, index) => {
    const subject = subjectOf(item)
    if (subject === null) return void problems.push({ index, key: 'rules.problem.subject' })
    if (item.otherValueId === null) return void problems.push({ index, key: 'rules.problem.other' })
    if (subject === item.otherValueId) return void problems.push({ index, key: 'rules.problem.same' })
    if (subject === ANY_OPTION && valueGroup(item.otherValueId) === groupId) return void problems.push({ index, key: 'rules.problem.anyOwn' })
    if (item.messageIt.trim().length > OPTION_LIMITS.message || item.messageEn.trim().length > OPTION_LIMITS.message) return void problems.push({ index, key: 'rules.problem.message', params: { max: OPTION_LIMITS.message } })
    const key = `${subject}|${item.kind}|${item.otherValueId}`
    const opposite = `${subject}|${item.kind === 'REQUIRES' ? 'EXCLUDES' : 'REQUIRES'}|${item.otherValueId}`
    if (seen.has(key)) problems.push({ index, key: 'rules.problem.twice', params: { other: seen.get(key)! + 1 } })
    else if (seen.has(opposite)) problems.push({ index, key: 'rules.problem.opposite', params: { other: seen.get(opposite)! + 1 } })
    if (!seen.has(key)) seen.set(key, index)
  })
  return problems
}

const messageOf = (item: RuleItem, saved: OptionRule | undefined): { it?: string; en?: string } | null | undefined => {
  const it = item.messageIt.trim()
  const en = item.messageEn.trim()
  if (!it && !en) return saved?.messageI18n ? null : undefined
  return { ...(it ? { it } : {}), ...(en ? { en } : {}) }
}

/** The whole set at the group's version (a rule left out is removed). Items with a problem are not sent (Save is held). */
export function rulesBodyOf(group: Pick<GroupRecord, 'version' | 'rules'>, items: readonly RuleItem[]): RulesInput {
  return {
    version: group.version,
    rules: items.map((item) => {
      const saved = item.id ? group.rules.find((rule) => rule.id === item.id) : undefined
      const message = messageOf(item, saved)
      return {
        ...(item.id ? { id: item.id } : {}),
        when: { combinator: 'and' as const, rows: [{ id: item.when.rows[0]?.id ?? 'subject', field: RULE_SUBJECT_FIELD, operator: 'eq', value: subjectOf(item) }] },
        kind: item.kind,
        otherValueId: item.otherValueId ?? '',
        severity: item.severity,
        ...(message !== undefined ? { message } : {}),
        status: item.active ? ('ACTIVE' as const) : ('ARCHIVED' as const),
      }
    }),
  }
}

const sameRule = (item: RuleItem, saved: RuleItem): boolean =>
  subjectOf(item) === subjectOf(saved) && item.kind === saved.kind && item.otherValueId === saved.otherValueId && item.severity === saved.severity && item.messageIt.trim() === saved.messageIt.trim() && item.messageEn.trim() === saved.messageEn.trim() && item.active === saved.active

/** How many rules the draft adds, removes or changes (the EditModeBar's count). */
export function rulesChangeCount(group: Pick<GroupRecord, 'rules'>, items: readonly RuleItem[]): number {
  const saved = new Map(ruleItemsOf(group).map((item) => [item.id!, item]))
  let count = 0
  for (const item of items) {
    const before = item.id ? saved.get(item.id) : undefined
    if (!before || !sameRule(item, before)) count++
  }
  const kept = new Set(items.map((item) => item.id).filter((id): id is string => id !== null))
  for (const id of saved.keys()) if (!kept.has(id)) count++
  return count
}

// ---- effects (the Price & BOM effects tab) --------------------------------------------------------------------------

export interface PickedRef {
  id: string
  code: string
  name: string
}

export interface EffectDraft {
  valueId: string
  kind: PartEffectKind
  item: PickedRef | null
  target: PickedRef | null
  qty: string
  uom: string
  section: string
  operation: PickedRef | null
  minutes: string
  note: string
}

export const effectDraftOf = (valueId: string, kind: PartEffectKind = 'BOM_ADD'): EffectDraft => ({ valueId, kind, item: null, target: null, qty: '', uom: '', section: '', operation: null, minutes: '', note: '' })

const decimalText = (value: string | null): string => (value === null ? '' : value)

export function effectDraftFrom(effect: OptionEffect): EffectDraft {
  return {
    valueId: effect.valueId,
    kind: effect.kind === 'PRICE' ? 'BOM_ADD' : effect.kind,
    item: effect.item,
    target: effect.targetItem,
    qty: decimalText(effect.qty),
    uom: effect.uom ?? '',
    section: effect.section ?? '',
    operation: effect.operation,
    minutes: decimalText(effect.minutes),
    note: effect.note ?? '',
  }
}

/** The fields each kind fills (the database's OptionEffect_check). */
export const EFFECT_FIELDS: Readonly<Record<PartEffectKind, readonly ('item' | 'target' | 'qty' | 'uom' | 'section' | 'operation' | 'minutes')[]>> = {
  BOM_ADD: ['item', 'qty', 'uom', 'section'],
  BOM_REPLACE: ['item', 'target', 'qty', 'uom'],
  BOM_REMOVE: ['target'],
  OPERATION_ADD: ['operation', 'minutes'],
  MINUTES: ['operation', 'minutes'],
  CERTIFICATE: [],
}

const fits = (value: string, integers: number, places: number): boolean => value.replace(/^-/, '').split('.')[0]!.replace(/^0+(?=\d)/, '').length <= integers && decimals(value) <= places

/** factory-domain effectProblems, in words: each kind's fields filled, quantities above 0 (4 decimals), minutes (3). */
export function effectDraftProblems(draft: EffectDraft, hasSizes = false): DraftProblem[] {
  const problems: DraftProblem[] = []
  const qty = decimalOf(draft.qty)
  const minutes = decimalOf(draft.minutes)
  const positive = (value: string | null | undefined, field: string, integers: number, places: number, key: string) => {
    if (value === undefined || (value !== null && (Number(value) <= 0 || !fits(value, integers, places)))) problems.push({ field, key })
  }
  if (draft.note.trim().length > OPTION_LIMITS.note) problems.push({ field: 'note', key: 'effect.problem.note', params: { max: OPTION_LIMITS.note } })
  switch (draft.kind) {
    case 'BOM_ADD':
      if (!draft.item) problems.push({ field: 'item', key: 'effect.problem.item' })
      if (!draft.uom) problems.push({ field: 'uom', key: 'effect.problem.uom' })
      if (qty === null && !hasSizes) problems.push({ field: 'qty', key: 'effect.problem.qtyNeeded' })
      positive(qty, 'qty', 14, 4, 'effect.problem.qty')
      break
    case 'BOM_REPLACE':
      if (!draft.item) problems.push({ field: 'item', key: 'effect.problem.itemIn' })
      if (!draft.target) problems.push({ field: 'target', key: 'effect.problem.target' })
      if (draft.item && draft.target && draft.item.id === draft.target.id) problems.push({ field: 'item', key: 'effect.problem.sameItem' })
      if ((qty === null) !== (draft.uom === '')) problems.push({ field: qty === null ? 'qty' : 'uom', key: 'effect.problem.qtyWithUom' })
      positive(qty, 'qty', 14, 4, 'effect.problem.qty')
      break
    case 'BOM_REMOVE':
      if (!draft.target) problems.push({ field: 'target', key: 'effect.problem.targetOut' })
      break
    case 'OPERATION_ADD':
      if (!draft.operation) problems.push({ field: 'operation', key: 'effect.problem.operation' })
      positive(minutes, 'minutes', 7, 3, 'effect.problem.minutes')
      break
    case 'MINUTES':
      if (minutes === null || minutes === undefined || minutes === '0' || !fits(minutes, 7, 3)) problems.push({ field: 'minutes', key: 'effect.problem.minutesNotZero' })
      break
    case 'CERTIFICATE':
      if (draft.note.trim() === '') problems.push({ field: 'note', key: 'effect.problem.certificate' })
      break
  }
  return problems
}

/** A new effect at the value's version: only its kind's fields. */
export function effectBodyOf(draft: EffectDraft, version: number): CreateEffectBody {
  const fields = EFFECT_FIELDS[draft.kind]
  const has = (field: (typeof fields)[number]) => fields.includes(field)
  const qty = decimalOf(draft.qty) ?? null
  const minutes = decimalOf(draft.minutes) ?? null
  return {
    version,
    kind: draft.kind,
    ...(has('item') && draft.item ? { itemId: draft.item.id } : {}),
    ...(has('target') && draft.target ? { targetItemId: draft.target.id } : {}),
    ...(has('qty') && qty !== null ? { qty } : {}),
    ...(has('uom') && draft.uom ? { uom: draft.uom as NonNullable<CreateEffectBody['uom']> } : {}),
    ...(has('section') && draft.section ? { section: draft.section as NonNullable<CreateEffectBody['section']> } : {}),
    ...(has('operation') && draft.operation ? { operationId: draft.operation.id } : {}),
    ...(has('minutes') && minutes !== null ? { minutes } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}

/** An effect's changes at the value's version (the kind stays); null when nothing changed. */
export function effectPatchOf(effect: OptionEffect, draft: EffectDraft, version: number): UpdateEffectBody | null {
  const fields = EFFECT_FIELDS[draft.kind]
  const has = (field: (typeof fields)[number]) => fields.includes(field)
  const body: UpdateEffectBody = { version }
  const qty = decimalOf(draft.qty) ?? null
  const minutes = decimalOf(draft.minutes) ?? null
  if (has('item') && (draft.item?.id ?? null) !== (effect.item?.id ?? null)) body.itemId = draft.item?.id ?? null
  if (has('target') && (draft.target?.id ?? null) !== (effect.targetItem?.id ?? null)) body.targetItemId = draft.target?.id ?? null
  if (has('qty') && qty !== (effect.qty === null ? null : decimalOf(effect.qty) ?? null)) body.qty = qty
  if (has('uom') && (draft.uom || null) !== effect.uom) body.uom = (draft.uom || null) as UpdateEffectBody['uom']
  if (has('section') && (draft.section || null) !== effect.section) body.section = (draft.section || null) as UpdateEffectBody['section']
  if (has('operation') && (draft.operation?.id ?? null) !== (effect.operation?.id ?? null)) body.operationId = draft.operation?.id ?? null
  if (has('minutes') && minutes !== (effect.minutes === null ? null : decimalOf(effect.minutes) ?? null)) body.minutes = minutes
  if ((draft.note.trim() || null) !== effect.note) body.note = draft.note.trim() || null
  return Object.keys(body).length > 1 ? body : null
}

/** A BOM_ADD's quantities per size with one size changed (null clears it); null when none is left. */
export function withSizeQuantity(current: Readonly<Record<string, string>> | null, size: string, value: string | null): Record<string, string> | null {
  const next = { ...(current ?? {}) }
  if (value === null) delete next[size]
  else next[size] = value
  return Object.keys(next).length > 0 ? next : null
}

/** The effects the tab lists (the price surcharge is the Options tab's column), by the options' order. */
export function effectsInOrder(group: Pick<GroupRecord, 'effects' | 'values'>): OptionEffect[] {
  const order = new Map(valuesInOrder(group.values).map((value, index) => [value.id, index]))
  const kinds = PART_EFFECT_KINDS as readonly string[]
  return group.effects.filter((effect) => effect.kind !== 'PRICE').sort((a, b) => (order.get(a.valueId) ?? 0) - (order.get(b.valueId) ?? 0) || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || (a.id < b.id ? -1 : 1))
}

// ---- styles (the Styles tab) ----------------------------------------------------------------------------------------

/** A style's own minimum or maximum typed in a cell: null = the group's; undefined = not a whole number. */
export const offerPicksOf = (text: string): number | null | undefined => wholeOf(text)

/** A style's own picks against the group (factory-domain offerPicksProblems, in words), or null. */
export function offerPicksProblemKey(kind: OptionGroupKind, group: { minPicks: number; maxPicks: number | null }, min: number | null, max: number | null): string | null {
  if (min !== null && (min < 0 || min > OPTION_LIMITS.picks)) return 'styles.problem.min'
  if (max !== null && (max < 1 || max > OPTION_LIMITS.picks)) return 'styles.problem.max'
  if (kind === 'SINGLE' && ((max ?? 1) > 1 || (min ?? 0) > 1)) return 'styles.problem.single'
  const effectiveMin = min ?? group.minPicks
  const effectiveMax = max ?? group.maxPicks
  if (effectiveMax !== null && effectiveMax < effectiveMin) return 'styles.problem.contradicts'
  return null
}

export type OptionTab = 'options' | 'rules' | 'effects' | 'styles'
export const OPTION_TABS: readonly OptionTab[] = ['options', 'rules', 'effects', 'styles']
export const tabOf = (value: string | null | undefined): OptionTab => ((OPTION_TABS as readonly string[]).includes(value ?? '') ? (value as OptionTab) : 'options')

export const STATUS_TONE = { ACTIVE: 'success', ARCHIVED: 'neutral' } as const
