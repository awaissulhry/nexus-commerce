import { LIMIT_BOUNDS, SUBSTANCE_LISTS, SUBSTANCE_TESTS, UNIT_WORDS } from '@nexus/factory-domain/compliance/substances/rules'
import { PLAN_ITEM_KINDS, PLAN_LIMITS, planProblems, planSwitchRefusal, TEST_FREQUENCIES } from '@nexus/factory-domain/compliance/test-plans/rules'
import { switchRefusal } from '@nexus/factory-domain/compliance/substances/rules'
import type { CandidateListVersion, PlanBody, Substance, SubstanceList, SubstanceRule, TestPlan } from './api'

/**
 * The Substance list, its rules and the test plan rules (B-W2b-267; design compliance.tests sec:ts-rsl, page.h "Restricted
 * substance list (W2b)", "Test plan rules (W2b)") without React: the view's address (`part` substances | rules | plans, the
 * API's own filters, the dialogs `switch`, `plan`, `version`), the limit in our words from its figure, unit and bound (never
 * the API's sentence), the switch's held reasons (an OFF rule says why: the Owner's 11-09 Q5 A keeps CMR and PFAS off), the
 * plan rule's draft and its problems, and the CSV. Pure.
 */

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'
type Words = (key: string, params?: Record<string, string | number>) => string

export const PARTS = ['substances', 'rules', 'plans'] as const
export type SubstancesPart = (typeof PARTS)[number]

export interface SubstancesAddress {
  readonly part: SubstancesPart
  readonly list: SubstanceList | null
  readonly q: string
  /** Archived rows too (`?all=1`: the API's `status=ALL`). */
  readonly all: boolean
  /** The switch dialog of a rule or a plan rule (`?switch=<id>`). */
  readonly switchId: string | null
  /** The plan rule dialog (`?plan=<id>` or `new`). */
  readonly plan: string | null
  /** Record a Candidate List version (`?version=new`). */
  readonly version: boolean
}

export function substancesAddressOf(params: { get(name: string): string | null } | null | undefined): SubstancesAddress {
  const part = params?.get('part') ?? ''
  const list = params?.get('list') ?? ''
  return {
    part: (PARTS as readonly string[]).includes(part) ? (part as SubstancesPart) : 'substances',
    list: (SUBSTANCE_LISTS as readonly string[]).includes(list) ? (list as SubstanceList) : null,
    q: params?.get('q') ?? '',
    all: params?.get('all') === '1',
    switchId: params?.get('switch') || null,
    plan: params?.get('plan') || null,
    version: params?.get('version') === 'new',
  }
}

export function substancesAddressText(address: SubstancesAddress): string {
  const search = new URLSearchParams()
  search.set('view', 'substances')
  if (address.part !== 'substances') search.set('part', address.part)
  if (address.part === 'substances' && address.list) search.set('list', address.list)
  if (address.q.trim()) search.set('q', address.q.trim())
  if (address.all) search.set('all', '1')
  if (address.switchId) search.set('switch', address.switchId)
  if (address.plan) search.set('plan', address.plan)
  if (address.version) search.set('version', 'new')
  return `?${search.toString()}`
}

export interface SubstancesCan {
  readonly view: boolean
  readonly manage: boolean
  readonly imports: boolean
}

export function substancesCan(permissions: readonly string[]): SubstancesCan {
  const held = new Set(permissions)
  return { view: held.has('compliance.certificates.view'), manage: held.has('compliance.substances.manage'), imports: held.has('imports.view') }
}

export interface Held {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

// ---- limits and sources in our words -------------------------------------------------------------------------------------

/** A limit as our words' key and values: "at most {value} {unit}", "below …", or a ban (no figure: yes or no). */
export function limitOf(rule: { readonly limitValue: string | null; readonly limitUnit: keyof typeof UNIT_WORDS | null; readonly limitBound: (typeof LIMIT_BOUNDS)[number] | null }, locale: string): { key: string; params?: Record<string, string> } {
  if (rule.limitValue === null || rule.limitUnit === null || rule.limitBound === null) return { key: 'limit.ban' }
  return { key: rule.limitBound === 'BELOW' ? 'limit.below' : 'limit.atMost', params: { value: figure(rule.limitValue, locale), unit: UNIT_WORDS[rule.limitUnit] } }
}

/** A decimal string in the person's language without trailing zeros ("0,5"). */
export function figure(value: string, locale: string): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 6 }).format(number)
}

/** The rules of a substance in the list's order: on first, then by key. */
export const rulesOf = (substance: Pick<Substance, 'rules'>) => [...substance.rules].sort((a, b) => Number(b.switchedOn) - Number(a.switchedOn) || a.key.localeCompare(b.key))

/** The Source column: the law's entries (Annex XVII), the lists, a brand's RSL. */
export function sourceKeys(substance: Pick<Substance, 'lists' | 'annexXviiEntries' | 'rules'>): { key: string; params?: Record<string, string> }[] {
  const keys: { key: string; params?: Record<string, string> }[] = []
  if (substance.annexXviiEntries.length > 0) keys.push({ key: 'source.annex', params: { entries: substance.annexXviiEntries.join(', ') } })
  for (const list of substance.lists) if (list !== 'REACH_ANNEX_XVII') keys.push({ key: `list.${list}` })
  if (substance.rules.some((rule) => rule.source === 'CUSTOMER')) keys.push({ key: 'source.brand' })
  return keys
}

// ---- the switches ------------------------------------------------------------------------------------------------------

export const OFF_REASON_MIN = 3

/** Why a rule's switch waits (no right, archived, offline), or null; the reason itself is checked in the dialog. */
export function ruleSwitchHeld(rule: Pick<SubstanceRule, 'status'>, can: SubstancesCan, online = true): Held | null {
  if (!can.manage) return { key: 'held.manage' }
  if (!online) return { key: 'held.offline' }
  if (rule.status !== 'ACTIVE') return { key: 'held.archived' }
  return null
}

/** The reason typed to switch off: the words key of what is wrong, or null (the domain's own rule, said in our words). */
export function offReasonProblem(subject: { readonly key?: string; readonly switchedOn: boolean; readonly status: string }, on: boolean, reason: string): string | null {
  const refusal = subject.key !== undefined ? switchRefusal({ key: subject.key, switchedOn: subject.switchedOn, status: subject.status as 'ACTIVE' | 'ARCHIVED' }, on, reason) : planSwitchRefusal({ switchedOn: subject.switchedOn, status: subject.status }, on, reason)
  if (!refusal) return null
  if (subject.status !== 'ACTIVE') return 'held.archived'
  if (subject.switchedOn === on) return on ? 'switch.alreadyOn' : 'switch.alreadyOff'
  return 'switch.reasonShort'
}

export const planSwitchHeld = ruleSwitchHeld

// ---- the Candidate List version -----------------------------------------------------------------------------------------

export interface VersionDraft {
  readonly publishedOn: string
  readonly entryCount: string
  readonly source: string
  readonly sourceUrl: string
  readonly note: string
}

export const blankVersion = (today: string): VersionDraft => ({ publishedOn: today, entryCount: '', source: 'ECHA Candidate List', sourceUrl: '', note: '' })

export function versionProblems(draft: VersionDraft, today: string, versions: readonly CandidateListVersion[]): Readonly<Record<string, string>> {
  const problems: Record<string, string> = {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.publishedOn)) problems.publishedOn = 'version.problem.day'
  else if (draft.publishedOn > today) problems.publishedOn = 'version.problem.future'
  else if (versions.some((version) => version.publishedOn === draft.publishedOn)) problems.publishedOn = 'version.problem.twice'
  const count = Number(draft.entryCount)
  if (!/^\d+$/.test(draft.entryCount.trim()) || count < 1 || count > 100_000) problems.entryCount = 'version.problem.count'
  if (draft.source.trim().length < 1 || draft.source.trim().length > 300) problems.source = 'version.problem.source'
  if (draft.sourceUrl.trim() && !/^https:\/\/\S+$/.test(draft.sourceUrl.trim())) problems.sourceUrl = 'version.problem.url'
  return problems
}

/** The newest version and how much it grew from the one before ("253 entries, +3"). */
export const newestOf = (versions: readonly CandidateListVersion[]): CandidateListVersion | null => versions.find((version) => version.newest) ?? versions[0] ?? null

// ---- the test plan rule -------------------------------------------------------------------------------------------------

export interface PlanDraft {
  readonly scope: 'KIND' | 'MATERIAL'
  readonly itemKind: string
  readonly itemId: string
  readonly test: (typeof SUBSTANCE_TESTS)[number]
  readonly frequency: (typeof TEST_FREQUENCIES)[number]
  readonly marketCode: string
  readonly substanceRuleId: string
  readonly method: string
  readonly note: string
  readonly switchedOn: boolean
  readonly offReason: string
}

export const blankPlan = (): PlanDraft => ({ scope: 'KIND', itemKind: 'LEATHER', itemId: '', test: 'AZO', frequency: 'EVERY_LOT', marketCode: '', substanceRuleId: '', method: '', note: '', switchedOn: true, offReason: '' })

export const planDraftOf = (plan: TestPlan): PlanDraft => ({
  scope: plan.item ? 'MATERIAL' : 'KIND',
  itemKind: plan.itemKind ?? 'LEATHER',
  itemId: plan.item?.id ?? '',
  test: plan.test,
  frequency: plan.frequency,
  marketCode: plan.marketCode ?? '',
  substanceRuleId: plan.substanceRule?.id ?? '',
  method: plan.method ?? '',
  note: plan.note ?? '',
  switchedOn: plan.switchedOn,
  offReason: plan.offReason ?? '',
})

export function planBodyOf(draft: PlanDraft): PlanBody {
  return {
    itemKind: draft.scope === 'KIND' ? draft.itemKind : null,
    itemId: draft.scope === 'MATERIAL' ? draft.itemId || null : null,
    test: draft.test,
    frequency: draft.frequency,
    marketCode: draft.marketCode.trim().toUpperCase() || null,
    substanceRuleId: draft.substanceRuleId || null,
    method: draft.method.trim() || null,
    note: draft.note.trim() || null,
  }
}

/** What holds the plan rule's save, field by field (our words' keys); the domain's rule decides. */
export function planDraftProblems(draft: PlanDraft, creating: boolean): Readonly<Record<string, string>> {
  const problems: Record<string, string> = {}
  const body = planBodyOf(draft)
  if (draft.scope === 'MATERIAL' && !draft.itemId) problems.itemId = 'plan.problem.material'
  if (draft.scope === 'KIND' && !(PLAN_ITEM_KINDS as readonly string[]).includes(draft.itemKind)) problems.itemKind = 'plan.problem.kind'
  for (const issue of planProblems({ ...body, ...(creating ? { switchedOn: draft.switchedOn, offReason: draft.switchedOn ? null : draft.offReason.trim() || null } : {}) })) {
    const field = issue.path.split('/')[1] ?? ''
    if (field === 'marketCode') problems.marketCode = 'plan.problem.market'
    else if (field === 'method') problems.method = 'plan.problem.method'
    else if (field === 'note') problems.note = 'plan.problem.note'
    else if (field === 'offReason') problems.offReason = 'switch.reasonShort'
  }
  if (draft.method.trim().length > PLAN_LIMITS.method) problems.method = 'plan.problem.method'
  return problems
}

/** What changed in an edit (none: Save waits). */
export function planChanges(plan: TestPlan, draft: PlanDraft): Partial<PlanBody> {
  const body = planBodyOf(draft)
  const before = planBodyOf(planDraftOf(plan))
  const changes: Partial<Record<keyof PlanBody, unknown>> = {}
  for (const key of Object.keys(body) as (keyof PlanBody)[]) if (body[key] !== before[key]) changes[key] = body[key]
  // A kind replaces the material and back: send both sides of the scope when it moved.
  if (changes.itemKind !== undefined || changes.itemId !== undefined) {
    changes.itemKind = body.itemKind
    changes.itemId = body.itemId
  }
  return changes as Partial<PlanBody>
}

// ---- CSV ----------------------------------------------------------------------------------------------------------------

export function substancesCsv(rows: readonly Substance[], t: Words, locale: string): string[][] {
  const header = ['csv.substance', 'csv.cas', 'csv.ec', 'csv.group', 'csv.limit', 'csv.scope', 'csv.method', 'csv.source', 'csv.version'].map((key) => t(key))
  return [
    header,
    ...rows.map((row) => {
      const rules = rulesOf(row)
      return [
        row.name,
        row.casNumber ?? '',
        row.ecNumber ?? '',
        row.groupCode ?? '',
        rules.map((rule) => `${rule.key}: ${t(limitOf(rule, locale).key, limitOf(rule, locale).params)}${rule.switchedOn ? '' : ` (${t('switch.off')})`}`).join('; '),
        [...new Set(rules.flatMap((rule) => rule.materialKinds))].map((kind) => t(`materialKind.${kind}`)).join('; '),
        [...new Set(rules.flatMap((rule) => (rule.testMethod ? [rule.testMethod] : [])))].join('; '),
        sourceKeys(row).map((source) => t(source.key, source.params)).join('; '),
        row.svhcListVersion?.publishedOn ?? '',
      ]
    }),
  ]
}
