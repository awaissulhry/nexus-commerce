/**
 * Google Ads programme 2, G14a (2026-10-16) — user lists (Google Ads "your data segments") Nexus makes and changes: pure
 * builders. No call here.
 *
 * Google's rules, checked 2026-10-16 with curl (reference/rpc/v25/UserList, UserListOperation, RuleBasedUserListInfo,
 * FlexibleRuleUserListInfo, FlexibleRuleOperandInfo, UserListRuleInfo, UserListRuleItemGroupInfo, UserListRuleItemInfo,
 * UserListStringRuleItemInfo, UserListNumberRuleItemInfo, UserListDateRuleItemInfo, LogicalUserListInfo,
 * UserListLogicalRuleInfo, LogicalUserListOperandInfo, BasicUserListInfo, UserListActionInfo, LookalikeUserListInfo, their
 * enums, UserListErrorEnum; googleapis v25 resources/user_list.proto) and the guides docs/remarketing/audience-segments/
 * getting-started, website-visitors, visited-specific-pages, took-specific-actions, multiple-user-lists,
 * lookalike-audiences:
 *   - userListOperation in GoogleAdsService.Mutate: create, update (+ update_mask), remove (customers/{c}/userLists/{id});
 *     the result is user_list_result. Exactly one list kind per list; similar_user_list is Output only; lookalike_user_list
 *     is Immutable; read_only (Output only) marks a list this account cannot change ("A user list can only be modified by
 *     the Google Ads or data partner account that created it"; OWNERSHIP_REQUIRED_FOR_SET).
 *   - Kinds Nexus makes: rule_based_user_list.flexible_rule_user_list (website visitors: inclusive operands joined by
 *     inclusive_rule_operator AND | OR, "AND_NOT" the exclusive operands joined by OR; each operand a rule — rule item
 *     groups ORed, items ANDed: "OR of ANDs is the only supported type for FlexibleRuleUserList" — over an optional
 *     lookback_window_days; prepopulation_status REQUESTED adds past visitors of the last 30 days, Display only);
 *     logical_user_list (rules ANDed, each ALL | ANY | NONE of user lists; CAN_NOT_ADD_LOGICAL_LIST_AS_LOGICAL_LIST_OPERAND,
 *     CAN_NOT_ADD_A_SIMILAR_USERLIST_AS_LOGICAL_LIST_OPERAND, CAN_NOT_MIX_CRM_BASED_IN_LOGICAL_LIST_WITH_OTHER_LISTS);
 *     basic_user_list (actions: conversion actions — people who converted); lookalike_user_list (seed_user_list_ids,
 *     expansion_level NARROW | BALANCED | BROAD, country_codes ISO-3166 alpha-2; Demand Gen only; DUPLICATE_LOOKALIKE).
 *   - A rule item: name (the tag parameter: url__ the page's URL, ref_url__ the referrer, or a custom parameter — "must
 *     begin with US-ascii letters or underscore … and consist of US-ascii letters or digits or underscore"), and ONE of
 *     string_rule_item (CONTAINS, EQUALS, STARTS_WITH, ENDS_WITH, NOT_EQUALS, NOT_CONTAINS, NOT_STARTS_WITH, NOT_ENDS_WITH;
 *     a URL value "can not contain illegal URL chars such as newlines, quotes, tabs, or parentheses"), number_rule_item
 *     (GREATER_THAN, GREATER_THAN_OR_EQUAL, EQUALS, NOT_EQUALS, LESS_THAN, LESS_THAN_OR_EQUAL) or date_rule_item (EQUALS,
 *     NOT_EQUALS, BEFORE, AFTER; value YYYY-MM-DD or offset_in_days).
 *   - membership_life_span 0–540 days, "ignored for logical_user_list and rule_based_user_list"; membership_status OPEN |
 *     CLOSED ("Only open user lists can accumulate more users and can be targeted to"); eligible_for_search settable.
 *   - NOT made here: crm_based_user_list (Customer Match). Filling one means uploading people's e-mails, phones or
 *     addresses (OfflineUserDataJobService, closed since 2026-04-01 to Cloud projects with no Customer Match use —
 *     getting-started "Caution" — and now the Data Manager API): Nexus never uploads personal data for audiences.
 *   The reference gives no limit on rules, items or lookback days: 1–540 days (the life span limit) and Google's check
 *   (validate_only) judge the rest.
 *
 * Money: a list spends nothing; the campaigns that use it do. A change that lets a list hold more people (open again, a
 * longer life span, Search allowed, other rules) is SPENDS MONEY when a campaign that serves targets or observes it; for
 * a list a serving campaign EXCLUDES, the opposite (closed, shorter, other rules, removed) lets more people in.
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { narrowLine, placeKeys, placesOf, widenLines, type UseContext } from './change-audience-uses.js'
import {
  DATE_OPERATORS, NUMBER_OPERATORS, STRING_OPERATORS, visitorRulesJson,
  type LiveUserList, type RuleItem, type RuleOperand, type VisitorRules,
} from './live-goals-audiences.js'
import type { LiveConversionAction } from './live-account.js'
import type { GoogleMutateOperation } from './write-client.js'

export const MEMBERSHIP_MAX_DAYS = 540
export const LOGICAL_OPERATORS = ['ALL', 'ANY', 'NONE'] as const
export const LOOKALIKE_LEVELS = ['NARROW', 'BALANCED', 'BROAD'] as const
export const NEW_USER_LIST = (n: number) => `new-user-list-${n}`
const PARAMETER_RE = /^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]{0,99}$/
const URL_PARAMETERS = new Set(['url__', 'ref_url__'])

export interface RuleItemAsk { parameter?: string; operator: string; text?: string; number?: number; date?: string; offsetDays?: number }
export interface OperandAsk { anyOf: Array<{ allOf: RuleItemAsk[] }>; lookbackDays?: number }
export interface VisitorsAsk { operator?: 'AND' | 'OR'; include: OperandAsk[]; exclude?: OperandAsk[] }
export interface CombinationRule { operator: typeof LOGICAL_OPERATORS[number]; userListIds: string[] }

export interface UserListCreate {
  name: string
  description?: string
  /** ONE of: */
  visitors?: VisitorsAsk
  combination?: CombinationRule[]
  converters?: { conversionActionIds: string[]; membershipDays?: number }
  lookalike?: { seedUserListIds: string[]; expansion: typeof LOOKALIKE_LEVELS[number]; countries?: string[] }
  /** visitors: also the past 30 days' visitors who match (Display only). */
  prepopulate?: boolean
}
export interface UserListChange {
  userListId: string
  name?: string
  description?: string
  membershipStatus?: 'OPEN' | 'CLOSED'
  membershipDays?: number
  eligibleForSearch?: boolean
  visitors?: VisitorsAsk
  combination?: CombinationRule[]
  conversionActionIds?: string[]
}
export interface UserListRequest { create?: UserListCreate[]; change?: UserListChange[]; remove?: string[] }

/** The settings of a changed list, in the request's shape (what undo sends back). */
export interface UserListFields {
  userListId: string
  name?: string | null
  description?: string | null
  membershipStatus?: string | null
  membershipDays?: number | null
  eligibleForSearch?: boolean | null
  visitors?: VisitorRules | null
  combination?: CombinationRule[] | null
  conversionActionIds?: string[] | null
}
export interface UserListRecord {
  lists: UserListFields[]
  created: Array<{ userListId: string; name: string; kind: string }>
  removed: Array<{ userListId: string; name: string | null; type: string | null }>
}

export interface UserListLive extends UseContext { lists: LiveUserList[]; actions: LiveConversionAction[] }

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────────────────

function ruleItemFrom(i: RuleItemAsk, what: string): RuleItem | { problem: string } {
  const parameter = (i.parameter ?? 'url__').trim()
  if (!PARAMETER_RE.test(parameter)) return { problem: `${what}: "${parameter.slice(0, 40)}" is not a tag parameter name (letters, digits, underscore; url__ is the page's address)` }
  const kinds = [i.text !== undefined, i.number !== undefined, i.date !== undefined || i.offsetDays !== undefined].filter(Boolean).length
  if (kinds !== 1) return { problem: `${what}: a rule compares with ONE of text, number, or date / offsetDays` }
  if (i.text !== undefined) {
    if (!(STRING_OPERATORS as readonly string[]).includes(i.operator)) return { problem: `${what}: ${i.operator} does not compare text (${STRING_OPERATORS.join(', ')})` }
    const text = i.text.trim()
    if (!text) return { problem: `${what}: the text is empty` }
    if (URL_PARAMETERS.has(parameter) && /[\s"'()]/.test(text)) return { problem: `${what}: "${text.slice(0, 60)}" has a space, quote or parenthesis, which Google refuses in an address` }
    return { parameter, operator: i.operator, text }
  }
  if (i.number !== undefined) {
    if (!(NUMBER_OPERATORS as readonly string[]).includes(i.operator)) return { problem: `${what}: ${i.operator} does not compare numbers (${NUMBER_OPERATORS.join(', ')})` }
    if (URL_PARAMETERS.has(parameter)) return { problem: `${what}: ${parameter} is text, not a number` }
    return { parameter, operator: i.operator, number: i.number }
  }
  if (!(DATE_OPERATORS as readonly string[]).includes(i.operator)) return { problem: `${what}: ${i.operator} does not compare dates (${DATE_OPERATORS.join(', ')})` }
  if (i.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(i.date)) return { problem: `${what}: a date is YYYY-MM-DD` }
  return { parameter, operator: i.operator, ...(i.date !== undefined ? { date: i.date } : {}), ...(i.offsetDays !== undefined ? { offsetDays: i.offsetDays } : {}) }
}

function operandFrom(o: OperandAsk, what: string): RuleOperand | { problem: string } {
  if (!o.anyOf.length || o.anyOf.some((g) => !g.allOf.length)) return { problem: `${what}: a rule names at least one condition in each group` }
  if (o.lookbackDays !== undefined && (!Number.isInteger(o.lookbackDays) || o.lookbackDays < 1 || o.lookbackDays > MEMBERSHIP_MAX_DAYS)) return { problem: `${what}: the lookback window is 1 to ${MEMBERSHIP_MAX_DAYS} days` }
  const anyOf: RuleOperand['anyOf'] = []
  for (const g of o.anyOf) {
    const allOf: RuleItem[] = []
    for (const i of g.allOf) {
      const item = ruleItemFrom(i, what)
      if ('problem' in item) return item
      allOf.push(item)
    }
    anyOf.push({ allOf })
  }
  return { anyOf, lookbackDays: o.lookbackDays ?? null }
}

export function visitorsFrom(v: VisitorsAsk, what: string): VisitorRules | { problem: string } {
  if (!v.include.length) return { problem: `${what}: name at least one rule of who is IN the list (include)` }
  const include: RuleOperand[] = []
  const exclude: RuleOperand[] = []
  for (const o of v.include) { const r = operandFrom(o, what); if ('problem' in r) return r; include.push(r) }
  for (const o of v.exclude ?? []) { const r = operandFrom(o, what); if ('problem' in r) return r; exclude.push(r) }
  return { operator: v.operator ?? 'AND', include, exclude }
}

/**
 * One canonical text of visitor rules (to compare two), case aside: Google may write a rule's text or parameter back in
 * another case, and an address rule is no other rule for it.
 */
export const visitorsKey = (v: VisitorRules | null): string => JSON.stringify(v ? visitorRulesJson(v) : null).toLowerCase()
const combinationKey = (c: CombinationRule[] | null) => JSON.stringify((c ?? []).map((r) => ({ o: r.operator, u: [...r.userListIds].sort() })))
const itemWords = (i: RuleItem) => `${i.parameter === 'url__' ? 'page' : i.parameter === 'ref_url__' ? 'referrer' : i.parameter} ${i.operator.toLowerCase().replace(/_/g, ' ')} ${i.text ?? i.number ?? i.date ?? `${i.offsetDays} days`}`
const operandWords = (o: RuleOperand) => o.anyOf.map((g) => g.allOf.map(itemWords).join(' and ')).join(' or ') + (o.lookbackDays ? ` (last ${o.lookbackDays} days)` : '')
export const visitorsWords = (v: VisitorRules | null) => (v
  ? `visitors: ${v.include.map(operandWords).join(v.operator === 'OR' ? ' OR ' : ' AND ')}${v.exclude.length ? `, not ${v.exclude.map(operandWords).join(' or ')}` : ''}`.slice(0, 300)
  : '(no rule)')

// ── the draft ────────────────────────────────────────────────────────────────────────────────────────────────────

const kindOf = (c: UserListCreate) => (['visitors', 'combination', 'converters', 'lookalike'] as const).filter((k) => c[k] !== undefined)

export function userListDraft(customer: string, request: UserListRequest, live: UserListLive): GoogleChangeDraft | { refusal: string } {
  const creates = request.create ?? []
  const changes = request.change ?? []
  const removes = [...new Set(request.remove ?? [])].sort()
  if (!creates.length && !changes.length && !removes.length) return { refusal: 'Say what to change: create, change or remove.' }
  const byId = new Map(live.lists.map((l) => [l.userListId, l]))
  const taken = (name: string, except?: string) => live.lists.some((l) => l.userListId !== except && l.accessReason === 'OWNED' && (l.name ?? '').trim().toLowerCase() === name.trim().toLowerCase())
  const actionIds = new Set(live.actions.map((a) => a.conversionActionId))
  const createOps: GoogleMutateOperation[] = []
  const updateOps: GoogleMutateOperation[] = []
  const removeOps: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: UserListRecord = { lists: [], created: [], removed: [] }
  const after: UserListRecord = { lists: [], created: [], removed: [] }
  const newNames = new Set<string>()
  const listRef = (id: string) => `${customer}/userLists/${id}`

  const combinationProblem = (rules: CombinationRule[], what: string): string | null => {
    if (!rules.length || rules.some((r) => !r.userListIds.length)) return `${what}: a combination has at least one rule, each with at least one user list`
    const ids = [...new Set(rules.flatMap((r) => r.userListIds))]
    for (const id of ids) {
      const l = byId.get(id)
      if (!l) return `${what}: user list ${id} is not one this account can use (google-ads-live view lookup, lookup user-lists)`
      if (l.type === 'LOGICAL') return `${what}: "${l.name}" is itself a combination (Google: CAN_NOT_ADD_LOGICAL_LIST_AS_LOGICAL_LIST_OPERAND)`
      if (l.type === 'SIMILAR') return `${what}: "${l.name}" is a similar-audience list (Google: CAN_NOT_ADD_A_SIMILAR_USERLIST_AS_LOGICAL_LIST_OPERAND)`
    }
    const crm = ids.filter((id) => byId.get(id)?.type === 'CRM_BASED')
    if (crm.length && crm.length < ids.length) return `${what}: a customer list cannot be combined with other kinds of lists (Google: CAN_NOT_MIX_CRM_BASED_IN_LOGICAL_LIST_WITH_OTHER_LISTS)`
    return null
  }
  const combinationJson = (rules: CombinationRule[]) => ({ rules: rules.map((r) => ({ operator: r.operator, ruleOperands: [...new Set(r.userListIds)].map((id) => ({ userList: listRef(id) })) })) })
  const actionsProblem = (ids: string[], what: string) => {
    if (!ids.length) return `${what}: name at least one conversion action`
    const missing = ids.filter((id) => !actionIds.has(id))
    return missing.length ? `${what}: conversion action ${missing.join(', ')} is not in the account (google-ads-live view conversions)` : null
  }
  const daysProblem = (days: number | undefined, what: string) =>
    days !== undefined && (!Number.isInteger(days) || days < 0 || days > MEMBERSHIP_MAX_DAYS) ? `${what}: membership lasts 0 to ${MEMBERSHIP_MAX_DAYS} days` : null

  for (const [i, c] of creates.entries()) {
    const name = c.name.trim()
    const what = `New list "${name}"`
    if (!name) return { refusal: 'A user list has a name.' }
    if (taken(name) || newNames.has(name.toLowerCase())) return { refusal: `${what}: a list of this account has this name (Google: NAME_ALREADY_USED).` }
    newNames.add(name.toLowerCase())
    const kinds = kindOf(c)
    if (kinds.length !== 1) return { refusal: `${what}: say exactly ONE of visitors (website visitors by rules), combination (of other lists), converters (people who converted) or lookalike. Customer lists (Customer Match) are not made by Nexus: they hold uploaded personal data.` }
    if (c.prepopulate !== undefined && kinds[0] !== 'visitors') return { refusal: `${what}: prepopulate is for a visitors list only.` }
    const list: Record<string, unknown> = { name, ...(c.description?.trim() ? { description: c.description.trim() } : {}) }
    let words = ''
    if (c.visitors) {
      const v = visitorsFrom(c.visitors, what)
      if ('problem' in v) return { refusal: `${v.problem}.` }
      list.membershipStatus = 'OPEN'
      list.ruleBasedUserList = { ...(c.prepopulate ? { prepopulationStatus: 'REQUESTED' } : {}), flexibleRuleUserList: visitorRulesJson(v) }
      words = visitorsWords(v)
      warnings.push(`"${name}" gathers people only where the Google tag is on the shop's pages, and serves once it holds enough of them (Google: at least 100 active people on Display, 1,000 on Search).`)
    } else if (c.combination) {
      const problem = combinationProblem(c.combination, what)
      if (problem) return { refusal: `${problem}.` }
      list.membershipStatus = 'OPEN'
      list.logicalUserList = combinationJson(c.combination)
      words = `combination: ${c.combination.map((r) => `${r.operator} of ${r.userListIds.length}`).join(' and ')}`
    } else if (c.converters) {
      const ids = [...new Set(c.converters.conversionActionIds)].sort()
      const problem = actionsProblem(ids, what) ?? daysProblem(c.converters.membershipDays, what)
      if (problem) return { refusal: `${problem}.` }
      list.membershipStatus = 'OPEN'
      if (c.converters.membershipDays !== undefined) list.membershipLifeSpan = String(c.converters.membershipDays)
      list.basicUserList = { actions: ids.map((id) => ({ conversionAction: `${customer}/conversionActions/${id}` })) }
      words = `people who converted (${plural(ids.length, 'conversion action')})${c.converters.membershipDays !== undefined ? `, kept ${c.converters.membershipDays} days` : ''}`
    } else if (c.lookalike) {
      const seeds = [...new Set(c.lookalike.seedUserListIds)].sort()
      const missing = seeds.filter((id) => !byId.has(id))
      if (!seeds.length || missing.length) return { refusal: `${what}: ${seeds.length ? `seed list ${missing.join(', ')} is not one this account can use` : 'name at least one seed list'}.` }
      const countries = [...new Set((c.lookalike.countries ?? []).map((x) => x.trim().toUpperCase()))].sort()
      if (countries.some((x) => !/^[A-Z]{2}$/.test(x))) return { refusal: `${what}: a country is a 2-letter ISO 3166 code (IT).` }
      list.lookalikeUserList = { seedUserListIds: seeds, expansionLevel: c.lookalike.expansion, ...(countries.length ? { countryCodes: countries } : {}) }
      words = `lookalike (${c.lookalike.expansion}) of ${plural(seeds.length, 'list')}${countries.length ? ` in ${countries.join(', ')}` : ''}`
      warnings.push(`"${name}" is a lookalike segment: Google serves it in Demand Gen campaigns only, once its seed lists hold enough people.`)
    }
    createOps.push({ userListOperation: { create: list } })
    after.created.push({ userListId: NEW_USER_LIST(i + 1), name, kind: kinds[0] })
    lines.push([`new list: ${name}`, null, words])
  }
  if (creates.length) warnings.push('A new list reaches nobody until a campaign uses it (set-google-audiences, a reusable audience, a Demand Gen ad group): that is where it can spend.')

  const seen = new Set<string>()
  for (const ch of changes) {
    const l = byId.get(ch.userListId)
    if (!l) return { refusal: `User list ${ch.userListId} is not one this account can see.` }
    if (seen.has(l.userListId) || removes.includes(l.userListId)) return { refusal: `User list ${l.userListId} is named twice (change and remove are one or the other).` }
    seen.add(l.userListId)
    const what = `List "${l.name ?? l.userListId}"`
    if (l.readOnly || l.accessReason !== 'OWNED') return { refusal: `${what} is not this account's own (${l.accessReason ?? 'read only'}): Google lets only the account that made a list change it.` }
    const was: UserListFields = { userListId: l.userListId }
    const now: UserListFields = { userListId: l.userListId }
    const body: Record<string, unknown> = { resourceName: listRef(l.userListId) }
    const mask: string[] = []
    const places = placesOf(live, 'USER_LIST', l.userListId)
    const widenIn: string[] = []
    const widenOut: string[] = []
    // Search eligibility matters only where the list is used in a Search or Shopping campaign.
    const searchIn: string[] = []
    const searchOut: string[] = []
    const onSearch = (uses: typeof places.positive) => uses.filter((u) => u.channel === 'SEARCH' || u.channel === 'SHOPPING')
    const set = <K extends keyof UserListFields>(key: K, from: UserListFields[K], to: UserListFields[K], json: Record<string, unknown>, path: string, label: string, show: (v: unknown) => string) => {
      ;(was as unknown as Record<string, unknown>)[key] = from
      ;(now as unknown as Record<string, unknown>)[key] = to
      Object.assign(body, json)
      mask.push(path)
      lines.push([`${l.name}: ${label}`, show(from), show(to)])
    }
    const plain = (v: unknown) => (v === null || v === undefined || v === '' ? '(none)' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v))
    if (ch.name !== undefined) {
      const name = ch.name.trim()
      if (!name) return { refusal: `${what}: a name cannot be empty.` }
      if (taken(name, l.userListId) || newNames.has(name.toLowerCase())) return { refusal: `${what}: another list is called "${name}".` }
      if (name === l.name) skipped.push(`${what}: the name is already "${name}".`)
      else set('name', l.name, name, { name }, 'name', 'name', plain)
    }
    if (ch.description !== undefined) {
      const description = ch.description.trim()
      if (description === (l.description ?? '')) skipped.push(`${what}: the description is already so.`)
      else set('description', l.description, description, { description }, 'description', 'description', plain)
    }
    if (ch.membershipStatus !== undefined) {
      if (ch.membershipStatus === l.membershipStatus) skipped.push(`${what} is already ${ch.membershipStatus}.`)
      else {
        set('membershipStatus', l.membershipStatus, ch.membershipStatus, { membershipStatus: ch.membershipStatus }, 'membership_status', 'membership', plain)
        if (ch.membershipStatus === 'OPEN') widenIn.push('is open again (it gathers people and can be targeted)')
        else { widenOut.push('is closed (it stops gathering the people it leaves out)'); warnings.push(`${what} is closed: it gathers nobody new, and Google does not target a closed list.`) }
      }
    }
    if (ch.membershipDays !== undefined) {
      const problem = daysProblem(ch.membershipDays, what)
      if (problem) return { refusal: `${problem}.` }
      if (l.type === 'RULE_BASED' || l.type === 'LOGICAL') return { refusal: `${what}: Google ignores the membership life span of a ${l.type === 'LOGICAL' ? 'combination' : 'rule-based'} list (its rules decide; give the rules a lookback window).` }
      if (ch.membershipDays === l.membershipDays) skipped.push(`${what} already keeps people ${ch.membershipDays} days.`)
      else {
        set('membershipDays', l.membershipDays, ch.membershipDays, { membershipLifeSpan: String(ch.membershipDays) }, 'membership_life_span', 'kept (days)', plain)
        if (ch.membershipDays > (l.membershipDays ?? 0)) widenIn.push(`keeps people longer (${l.membershipDays ?? '?'} → ${ch.membershipDays} days)`)
        else widenOut.push(`keeps people shorter (${l.membershipDays ?? '?'} → ${ch.membershipDays} days)`)
      }
    }
    if (ch.eligibleForSearch !== undefined) {
      if (ch.eligibleForSearch === l.eligibleForSearch) skipped.push(`${what}: Search is already ${ch.eligibleForSearch ? 'allowed' : 'off'}.`)
      else {
        set('eligibleForSearch', l.eligibleForSearch, ch.eligibleForSearch, { eligibleForSearch: ch.eligibleForSearch }, 'eligible_for_search', 'on Search', plain)
        if (ch.eligibleForSearch) searchIn.push('can serve on Google Search')
        else searchOut.push('stops applying on Google Search')
      }
    }
    if (ch.visitors !== undefined) {
      if (l.type !== 'RULE_BASED' || !l.visitors) return { refusal: `${what} is not a website-visitors (rule-based) list Nexus can read the rules of.` }
      const v = visitorsFrom(ch.visitors, what)
      if ('problem' in v) return { refusal: `${v.problem}.` }
      if (visitorsKey(v) === visitorsKey(l.visitors)) skipped.push(`${what} already has exactly these rules.`)
      else {
        set('visitors', l.visitors, v, { ruleBasedUserList: { flexibleRuleUserList: visitorRulesJson(v) } }, 'rule_based_user_list.flexible_rule_user_list', 'rules', (x) => visitorsWords(x as VisitorRules))
        widenIn.push('gets other rules (it may hold more people)')
        widenOut.push('gets other rules (it may leave out fewer people)')
      }
    }
    if (ch.combination !== undefined) {
      if (l.type !== 'LOGICAL' || !l.combination) return { refusal: `${what} is not a combination list.` }
      const problem = combinationProblem(ch.combination, what)
      if (problem) return { refusal: `${problem}.` }
      const rules = ch.combination.map((r) => ({ operator: r.operator, userListIds: [...new Set(r.userListIds)] }))
      if (combinationKey(rules) === combinationKey(l.combination as CombinationRule[])) skipped.push(`${what} already combines exactly these.`)
      else {
        set('combination', l.combination as CombinationRule[], rules, { logicalUserList: combinationJson(rules) }, 'logical_user_list.rules', 'combination', (x) => `${(x as CombinationRule[]).length} rules`)
        widenIn.push('combines other lists (it may hold more people)')
        widenOut.push('combines other lists (it may leave out fewer people)')
      }
    }
    if (ch.conversionActionIds !== undefined) {
      if (!l.actions) return { refusal: `${what} is not a list of people who converted.` }
      const ids = [...new Set(ch.conversionActionIds)].sort()
      const problem = actionsProblem(ids, what)
      if (problem) return { refusal: `${problem}.` }
      if (ids.join(',') === l.actions.conversionActionIds.join(',')) skipped.push(`${what} already holds the people of exactly these conversion actions.`)
      else {
        // The remarketing actions it holds stay (actions is written whole).
        const actions = [...ids.map((id) => ({ conversionAction: `${customer}/conversionActions/${id}` })), ...l.actions.remarketingActionIds.map((id) => ({ remarketingAction: `${customer}/remarketingActions/${id}` }))]
        set('conversionActionIds', l.actions.conversionActionIds, ids, { basicUserList: { actions } }, 'basic_user_list.actions', 'conversion actions', (x) => `${(x as string[]).length}`)
        if (ids.some((id) => !l.actions!.conversionActionIds.includes(id))) widenIn.push('takes in the people of more conversion actions')
        if (l.actions.conversionActionIds.some((id) => !ids.includes(id))) widenOut.push('drops the people of some conversion actions')
      }
    }
    if (!mask.length) continue
    for (const why of [...new Set(widenIn)]) { const o = widenLines(what, why, places.positive); spends.push(...o.spends); warnings.push(...o.warnings) }
    for (const why of [...new Set(widenOut)]) { const o = widenLines(`${what} (an exclusion)`, why, places.negative); spends.push(...o.spends); warnings.push(...o.warnings) }
    for (const why of searchIn) { const o = widenLines(what, why, onSearch(places.positive)); spends.push(...o.spends); warnings.push(...o.warnings) }
    for (const why of searchOut) { const o = widenLines(`${what} (an exclusion)`, why, onSearch(places.negative)); spends.push(...o.spends); warnings.push(...o.warnings) }
    if (!widenIn.length && !searchIn.length && mask.some((m) => m !== 'name' && m !== 'description')) warnings.push(...narrowLine(what, 'holds fewer people', places.positive))
    updateOps.push({ userListOperation: { update: body, updateMask: mask.join(',') } })
    before.lists.push(was)
    after.lists.push(now)
  }

  for (const id of removes) {
    const l = byId.get(id)
    if (!l) return { refusal: `User list ${id} is not one this account can see.` }
    if (l.readOnly || l.accessReason !== 'OWNED') return { refusal: `List "${l.name ?? id}" is not this account's own: Google lets only the account that made a list remove it.` }
    removeOps.push({ userListOperation: { remove: listRef(id) } })
    lines.push([`list ${l.name ?? id}`, l.type, 'REMOVED'])
    const removed = { userListId: id, name: l.name, type: l.type }
    before.removed.push(removed)
    after.removed.push(removed)
    const places = placesOf(live, 'USER_LIST', id)
    const out = widenLines(`List "${l.name ?? id}" (an exclusion)`, 'is removed', places.negative)
    spends.push(...out.spends)
    warnings.push(...out.warnings)
    if (places.positive.length) warnings.push(`List "${l.name ?? id}" is targeted or observed by campaigns: they lose it (Google may refuse while it is used).`)
  }
  if (removes.length) warnings.push('A removed list and the people in it cannot be restored; undo does not make it again.')

  const operations = [...createOps, ...updateOps, ...removeOps]
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ') || 'every list is already so.'}` }
  const { changes: table, more } = changeLines(lines)
  const parts = [
    after.created.length ? `make ${plural(after.created.length, 'user list')}` : '',
    after.lists.length ? `change ${plural(after.lists.length, 'user list')}` : '',
    after.removed.length ? `remove ${plural(after.removed.length, 'user list')} for good` : '',
  ].filter(Boolean)
  return {
    summary: `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.`,
    changes: table,
    totals: { created: after.created.length, changed: after.lists.length, removed: after.removed.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      // What a change reads of a list (not its size: Google's estimate moves by itself).
      lists: live.lists.filter((l) => seen.has(l.userListId) || removes.includes(l.userListId)).map((l) => JSON.stringify([
        l.userListId, l.name, l.description, l.type, l.membershipStatus, l.membershipDays, l.readOnly, l.accessReason, l.eligibleForSearch,
        visitorsKey(l.visitors), combinationKey(l.combination as CombinationRule[] | null), l.actions, l.lookalike,
      ])).sort(),
      operands: [...new Set([...creates, ...changes].flatMap((c) => [...(c.combination ?? []).flatMap((r) => r.userListIds), ...('lookalike' in c && c.lookalike ? c.lookalike.seedUserListIds : [])]))].sort()
        .map((id) => `${id}:${byId.get(id)?.type ?? '-'}`),
      names: creates.length || changes.some((c) => c.name !== undefined) ? live.lists.filter((l) => l.accessReason === 'OWNED').map((l) => (l.name ?? '').toLowerCase()).sort() : [],
      // Direct uses and those through reusable audiences, combinations and lookalikes (each with its path).
      uses: [...seen, ...removes].sort().map((id) => `${id}:${placeKeys(placesOf(live, 'USER_LIST', id)).join(',')}`),
    },
    before,
    after,
  }
}

/** After the run: the ids Google gave the lists it made (user_list_result, in create order — creates go first). */
export function userListRecordAfterRun(after: UserListRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): UserListRecord {
  const made = responses.map((r) => r.userListResult?.resourceName)
  const out = structuredClone(after)
  out.created = out.created.map((c, i) => {
    const name = made[i]
    return name ? { ...c, userListId: name.slice(name.lastIndexOf('/') + 1) } : c
  })
  return out
}
