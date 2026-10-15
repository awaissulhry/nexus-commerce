/**
 * Google Ads programme 2, G8a (2026-10-15) — conversion actions and conversion goals: pure builders (request + live
 * state → GoogleChangeDraft, or a refusal). No call here.
 *
 * Google's rules, checked 2026-10-15 in the v25 reference (developers.google.com/google-ads/api/reference/rpc/v25/
 * ConversionAction, ConversionActionOperation, ConversionAction.ValueSettings, ConversionAction.AttributionModelSettings,
 * CustomerConversionGoal(Operation), CampaignConversionGoal(Operation), ConversionGoalCampaignConfig(Operation),
 * ConversionActionTypeEnum, ConversionActionStatusEnum, ConversionActionCountingTypeEnum, ConversionActionCategoryEnum,
 * ConversionOriginEnum, AttributionModelEnum, GoalConfigLevelEnum, ConversionActionErrorEnum) and the guides
 * …/docs/conversions/getting-started, …/goals/customer-goals, …/goals/campaign-goals:
 *   - conversionActionOperation: create, update (+ update_mask), remove (resource name). `type` is Immutable; `origin`,
 *     `owner_customer`, `tag_snippets` and `id` are Output only. name, category, status, primary_for_goal,
 *     include_in_conversions_metric, counting_type, the lookback windows, attribution_model_settings.attribution_model
 *     and value_settings are settable. primary_for_goal false = never biddable (except in a custom goal).
 *   - Status: ENABLED records; HIDDEN records nothing and is not shown in the UI; REMOVED records nothing (only by remove).
 *   - Types the API makes for a shop: WEBPAGE (the website tag) and UPLOAD_CLICKS (sales imported with their click);
 *     many types are "Read only" in the enum and CREATION_NOT_SUPPORTED otherwise.
 *   - Rule-based attribution models are deprecated (CANNOT_SET_RULE_BASED_ATTRIBUTION_MODELS): only
 *     GOOGLE_ADS_LAST_CLICK and GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN are offered.
 *   - Lookback windows: the reference gives no range; Google Ads' own limits (click-through 1–90 days, view-through
 *     1–30 days) are applied here and Google's check (validate_only) judges the rest.
 *   - customerConversionGoalOperation / campaignConversionGoalOperation: update only (biddable); resource names
 *     customers/{id}/customerConversionGoals/{category}~{origin} and
 *     customers/{id}/campaignConversionGoals/{campaign_id}~{category}~{origin}. Updating a campaign's goal moves the
 *     campaign to its own goals (goal_config_level CAMPAIGN): account goal changes no longer reach it until its
 *     ConversionGoalCampaignConfig (customers/{id}/conversionGoalCampaignConfigs/{campaign_id}, update only) is set back to
 *     goal_config_level CUSTOMER.
 *
 * Money: Smart Bidding (target CPA / ROAS, maximize conversions / value) bids for the conversions of the goals it
 * optimises. Making an action count for bidding (primary, include in conversions, enabled again, a goal made biddable)
 * or making it count more (more per click, longer windows, a higher value, another attribution or category) changes
 * what automatic bidding chases and can make it bid higher: SPENDS MONEY, each in words, naming the enabled campaigns
 * that bid with Smart Bidding for that goal (or saying none does, so nothing spends more yet).
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import type { LiveConversionAction, LiveConversions } from './live-account.js'
import { CONVERSION_BIDDING, VALUE_BIDDING, type SmartBiddingCampaign } from './live-conversions.js'
import type { GoogleMutateOperation } from './write-client.js'

// ── vocabulary ───────────────────────────────────────────────────────────────────────────────────────────────────

export const CREATABLE_TYPES = ['WEBPAGE', 'UPLOAD_CLICKS'] as const
export type CreatableType = (typeof CREATABLE_TYPES)[number]
export const ACTION_CATEGORIES = [
  'PURCHASE', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'SUBSCRIBE_PAID', 'PAGE_VIEW', 'SIGNUP', 'SUBMIT_LEAD_FORM', 'CONTACT',
  'REQUEST_QUOTE', 'BOOK_APPOINTMENT', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'QUALIFIED_LEAD', 'CONVERTED_LEAD',
  'OUTBOUND_CLICK', 'GET_DIRECTIONS', 'ENGAGEMENT', 'DOWNLOAD', 'STORE_VISIT', 'STORE_SALE', 'DEFAULT',
] as const
export const GOAL_ORIGINS = ['WEBSITE', 'APP', 'CALL_FROM_ADS', 'STORE', 'YOUTUBE_HOSTED', 'GOOGLE_HOSTED', 'LOCAL_SERVICES_ADS'] as const
export const ATTRIBUTION_MODELS = ['GOOGLE_ADS_LAST_CLICK', 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN'] as const
export const COUNTING_TYPES = ['ONE_PER_CLICK', 'MANY_PER_CLICK'] as const
export const SETTABLE_STATUSES = ['ENABLED', 'HIDDEN'] as const
export const MAX_CLICK_WINDOW_DAYS = 90
export const MAX_VIEW_WINDOW_DAYS = 30

/** An action's origin for a category: the types Nexus makes are website actions. */
const WEBSITE = 'WEBSITE'
const goalOf = (category: string | null, origin: string | null) => `${category ?? '?'}/${origin ?? '?'}`

// ── who bids for a goal ──────────────────────────────────────────────────────────────────────────────────────────

export interface BiddingContext {
  /** Every campaign that is not removed, with its bidding. */
  campaigns: SmartBiddingCampaign[]
  /** The account's goals and each campaign's goals (live-account.ts liveConversions). */
  goals: Pick<LiveConversions, 'accountGoals' | 'campaigns'>
}

/** The ENABLED campaigns bidding with Smart Bidding (or, `valueOnly`, on value) whose biddable goals include `goal`. */
export function chasersOf(ctx: BiddingContext, goal: string, valueOnly = false): SmartBiddingCampaign[] {
  const accountBiddable = new Set(ctx.goals.accountGoals.filter((g) => g.biddable).map((g) => g.goal))
  return ctx.campaigns.filter((c) => {
    if (c.status !== 'ENABLED' || !c.bidding || !(valueOnly ? VALUE_BIDDING : CONVERSION_BIDDING).has(c.bidding)) return false
    const own = ctx.goals.campaigns.find((g) => g.campaignId === c.campaignId)
    return own ? own.biddableGoals.includes(goal) : accountBiddable.has(goal)
  })
}

const names = (campaigns: SmartBiddingCampaign[]) =>
  campaigns.slice(0, 5).map((c) => `"${c.name}"`).join(', ') + (campaigns.length > 5 ? ` and ${campaigns.length - 5} more` : '')

/** A SPENDS MONEY sentence: what changes, and which enabled campaigns bid for it with Smart Bidding (or that none does). */
export function chaseSentence(what: string, chasers: SmartBiddingCampaign[]): string {
  return chasers.length
    ? `${what}: ${plural(chasers.length, 'enabled campaign')} bid${chasers.length === 1 ? 's' : ''} with Smart Bidding for it (${names(chasers)}) and may bid higher.`
    : `${what}. No enabled campaign bids with Smart Bidding for it now, so nothing spends more yet (it would once one does).`
}

// ── conversion actions: create and change ────────────────────────────────────────────────────────────────────────

/** The settings of a conversion action a request may set; each one given is written. */
export interface ActionSettings {
  name?: string
  category?: (typeof ACTION_CATEGORIES)[number]
  status?: (typeof SETTABLE_STATUSES)[number]
  primary?: boolean
  includeInConversions?: boolean
  counting?: (typeof COUNTING_TYPES)[number]
  clickWindowDays?: number
  viewWindowDays?: number
  attribution?: (typeof ATTRIBUTION_MODELS)[number]
  /** In minor units (cents) of `defaultValueCurrency` (or the account's currency). */
  defaultValueCents?: number
  defaultValueCurrency?: string
  alwaysUseDefaultValue?: boolean
}
export type SettingKey = keyof ActionSettings
export const ACTION_SETTING_KEYS: readonly SettingKey[] = [
  'name', 'category', 'status', 'primary', 'includeInConversions', 'counting', 'clickWindowDays', 'viewWindowDays', 'attribution',
  'defaultValueCents', 'defaultValueCurrency', 'alwaysUseDefaultValue',
]

export interface ActionCreate extends ActionSettings { name: string; type: CreatableType }
export interface ActionChange extends ActionSettings { conversionActionId: string }
export interface ActionRequest { create?: ActionCreate[]; change?: ActionChange[] }

/** One action's changed settings: the values it replaced (before) or wrote (after). */
export type ActionFields = { conversionActionId: string } & { [K in SettingKey]?: ActionSettings[K] | null }
export interface ActionRecord {
  actions: ActionFields[]
  /** Actions it made (`new-1`, `new-2` … until the run names Google's ids). */
  created: Array<{ conversionActionId: string; name: string; type: string }>
}

/** Google's JSON field, its update-mask path, and the value as Google takes it. */
const FIELD: Record<Exclude<SettingKey, 'defaultValueCents' | 'defaultValueCurrency' | 'alwaysUseDefaultValue' | 'attribution'>, { mask: string; json: string }> = {
  name: { mask: 'name', json: 'name' },
  category: { mask: 'category', json: 'category' },
  status: { mask: 'status', json: 'status' },
  primary: { mask: 'primary_for_goal', json: 'primaryForGoal' },
  includeInConversions: { mask: 'include_in_conversions_metric', json: 'includeInConversionsMetric' },
  counting: { mask: 'counting_type', json: 'countingType' },
  clickWindowDays: { mask: 'click_through_lookback_window_days', json: 'clickThroughLookbackWindowDays' },
  viewWindowDays: { mask: 'view_through_lookback_window_days', json: 'viewThroughLookbackWindowDays' },
}

const LABEL: Record<SettingKey, string> = {
  name: 'name', category: 'category', status: 'status', primary: 'primary (counts for bidding)', includeInConversions: 'in "Conversions"',
  counting: 'counting', clickWindowDays: 'click-through window (days)', viewWindowDays: 'view-through window (days)', attribution: 'attribution',
  defaultValueCents: 'default value', defaultValueCurrency: 'default value currency', alwaysUseDefaultValue: 'always use the default value',
}

/** The live value of a setting, in the request's shape. */
export function liveSetting(a: LiveConversionAction, key: SettingKey): unknown {
  switch (key) {
    case 'name': return a.name
    case 'category': return a.category
    case 'status': return a.status
    case 'primary': return a.primary
    case 'includeInConversions': return a.includeInConversions
    case 'counting': return a.counting
    case 'clickWindowDays': return a.clickWindowDays
    case 'viewWindowDays': return a.viewWindowDays
    case 'attribution': return a.attribution
    case 'defaultValueCents': return a.defaultValueCents
    case 'defaultValueCurrency': return a.defaultValueCurrency
    case 'alwaysUseDefaultValue': return a.alwaysUseDefaultValue
  }
}

function show(key: SettingKey, value: unknown, currency: string): string {
  if (value === null || value === undefined) return '(none)'
  if (key === 'defaultValueCents') return money(Number(value), currency)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

/** What settings problem a request has, before anything is built. */
function settingsProblem(s: ActionSettings, what: string): string | null {
  if (s.name !== undefined && !s.name.trim()) return `${what}: a name cannot be empty.`
  if (s.clickWindowDays !== undefined && (!Number.isInteger(s.clickWindowDays) || s.clickWindowDays < 1 || s.clickWindowDays > MAX_CLICK_WINDOW_DAYS)) return `${what}: the click-through window is 1 to ${MAX_CLICK_WINDOW_DAYS} days.`
  if (s.viewWindowDays !== undefined && (!Number.isInteger(s.viewWindowDays) || s.viewWindowDays < 1 || s.viewWindowDays > MAX_VIEW_WINDOW_DAYS)) return `${what}: the view-through window is 1 to ${MAX_VIEW_WINDOW_DAYS} days.`
  if (s.defaultValueCents !== undefined && (!Number.isInteger(s.defaultValueCents) || s.defaultValueCents < 0)) return `${what}: a default value is whole cents, 0 or more.`
  if (s.defaultValueCurrency !== undefined && !/^[A-Z]{3}$/.test(s.defaultValueCurrency)) return `${what}: a currency is a 3-letter ISO 4217 code (EUR).`
  return null
}

/** The JSON body fields and update-mask paths of settings (create writes them, update names them in the mask). */
function writeSettings(s: ActionSettings, currency: string): { body: Record<string, unknown>; mask: string[] } {
  const body: Record<string, unknown> = {}
  const mask: string[] = []
  for (const key of Object.keys(FIELD) as Array<keyof typeof FIELD>) {
    if (s[key] === undefined) continue
    body[FIELD[key].json] = key === 'name' ? String(s[key]).trim() : s[key]
    mask.push(FIELD[key].mask)
  }
  if (s.attribution !== undefined) {
    body.attributionModelSettings = { attributionModel: s.attribution }
    mask.push('attribution_model_settings.attribution_model')
  }
  const value: Record<string, unknown> = {}
  if (s.defaultValueCents !== undefined) {
    value.defaultValue = s.defaultValueCents / 100
    mask.push('value_settings.default_value')
    // A value without a currency is in the account's currency, said once so it is never another.
    if (s.defaultValueCurrency === undefined) { value.defaultCurrencyCode = currency; mask.push('value_settings.default_currency_code') }
  }
  if (s.defaultValueCurrency !== undefined) { value.defaultCurrencyCode = s.defaultValueCurrency; mask.push('value_settings.default_currency_code') }
  if (s.alwaysUseDefaultValue !== undefined) { value.alwaysUseDefaultValue = s.alwaysUseDefaultValue; mask.push('value_settings.always_use_default_value') }
  if (Object.keys(value).length) body.valueSettings = value
  return { body, mask }
}

/** Why moving a setting from → to on a PRIMARY action can make Smart Bidding bid more (null when it cannot). */
function chaseMore(key: SettingKey, from: unknown, to: unknown): string | null {
  switch (key) {
    case 'primary': return to === true && from !== true ? 'becomes a primary action (it counts for bidding)' : null
    case 'includeInConversions': return to === true && from !== true ? 'is counted in "Conversions" again' : null
    case 'status': return to === 'ENABLED' && from !== 'ENABLED' ? 'records conversions again' : null
    case 'category': return to !== from ? `moves to the ${String(to)} goal` : null
    case 'counting': return to === 'MANY_PER_CLICK' && from !== 'MANY_PER_CLICK' ? 'counts every conversion of a click, not one' : null
    case 'clickWindowDays': case 'viewWindowDays': return Number(to) > Number(from ?? 0) ? `counts conversions over a longer ${key === 'clickWindowDays' ? 'click-through' : 'view-through'} window` : null
    case 'attribution': return to !== from ? 'gives credit to other clicks (another attribution model)' : null
    default: return null
  }
}

/** Why a value setting can make VALUE bidding bid more (null when it cannot). */
function valueMore(key: SettingKey, from: unknown, to: unknown): string | null {
  if (key === 'defaultValueCents') return Number(to) > Number(from ?? 0) ? 'gets a higher default value' : null
  if (key === 'alwaysUseDefaultValue') return to !== from ? 'changes which value it reports (always the default, or the sale\'s own)' : null
  if (key === 'defaultValueCurrency') return to !== from ? 'reports its default value in another currency' : null
  return null
}

export const NEW_ACTION = (n: number) => `new-${n}`

export function actionChangeDraft(
  customer: string,
  currency: string,
  request: ActionRequest,
  live: { actions: LiveConversionAction[]; bidding: BiddingContext; customerId: string },
): GoogleChangeDraft | { refusal: string } {
  const creates = request.create ?? []
  const changes = request.change ?? []
  if (!creates.length && !changes.length) return { refusal: 'Say what to change: create or change.' }
  const byId = new Map(live.actions.map((a) => [a.conversionActionId ?? '', a]))
  const taken = (name: string, except?: string) => live.actions.some((a) => a.conversionActionId !== except && (a.name ?? '').trim().toLowerCase() === name.trim().toLowerCase())
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: ActionRecord = { actions: [], created: [] }
  const after: ActionRecord = { actions: [], created: [] }
  const seenNames = new Set<string>()

  for (const [i, c] of creates.entries()) {
    const what = `New conversion action "${c.name}"`
    const problem = settingsProblem(c, what)
    if (problem) return { refusal: problem }
    if (!(CREATABLE_TYPES as readonly string[]).includes(c.type)) return { refusal: `${what}: Nexus makes ${CREATABLE_TYPES.join(' or ')} conversion actions.` }
    const key = c.name.trim().toLowerCase()
    if (taken(c.name) || seenNames.has(key)) return { refusal: `${what}: a conversion action with this name already exists (names are unique in the account).` }
    seenNames.add(key)
    const category = c.category ?? 'PURCHASE'
    // New things cannot spend by themselves: a new action is SECONDARY (observation only) unless the request says primary.
    const primary = c.primary === true
    const settings: ActionSettings = {
      ...c,
      category,
      status: c.status ?? 'ENABLED',
      primary,
      counting: c.counting ?? (category === 'PURCHASE' ? 'MANY_PER_CLICK' : 'ONE_PER_CLICK'),
    }
    const { body } = writeSettings(settings, currency)
    operations.push({ conversionActionOperation: { create: { ...body, type: c.type } } })
    const id = NEW_ACTION(i + 1)
    after.created.push({ conversionActionId: id, name: c.name.trim(), type: c.type })
    lines.push([`new: ${c.name.trim()}`, null, `${c.type === 'UPLOAD_CLICKS' ? 'imported sales (UPLOAD_CLICKS)' : 'website tag (WEBPAGE)'}, ${category}, ${primary ? 'PRIMARY' : 'secondary (observation only)'}`])
    if (primary) spends.push(chaseSentence(`New action "${c.name.trim()}" is primary for the ${category} goal`, chasersOf(live.bidding, goalOf(category, WEBSITE))))
    if (c.type === 'WEBPAGE') warnings.push(`"${c.name.trim()}" records nothing until its tag is on the shop: the answer after it runs gives the site tag and the event snippet to paste (Shopify: Settings › Customer events).`)
    if (c.type === 'UPLOAD_CLICKS') warnings.push(`"${c.name.trim()}" records only sales sent to it (upload-google-sales); Google takes them about 6 hours after the action is made.`)
    if (!live.bidding.goals.accountGoals.some((g) => g.category === category && g.origin === WEBSITE)) {
      warnings.push(`The account has no ${category} website goal yet: Google adds it to the account and to every campaign when this action is made, biddable unless another goal of that category is not.`)
    }
  }

  const seen = new Set<string>()
  for (const ch of changes) {
    const a = byId.get(ch.conversionActionId)
    if (!a) return { refusal: `Conversion action ${ch.conversionActionId} is not in the account (or is removed). google-ads-live view conversions lists them.` }
    if (seen.has(ch.conversionActionId)) return { refusal: `Conversion action ${ch.conversionActionId} is named twice.` }
    seen.add(ch.conversionActionId)
    const what = `"${a.name}" (${a.conversionActionId})`
    const problem = settingsProblem(ch, `Conversion action ${what}`)
    if (problem) return { refusal: problem }
    if (!a.ownerCustomerId) return { refusal: `Conversion action ${what} is one of Google's own (system-defined): Google does not let it be changed.` }
    if (a.ownerCustomerId !== live.customerId) return { refusal: `Conversion action ${what} belongs to account ${a.ownerCustomerId} (cross-account conversion tracking): change it there.` }
    if (ch.name !== undefined && taken(ch.name, a.conversionActionId ?? undefined)) return { refusal: `Conversion action ${what}: another action is already called "${ch.name.trim()}".` }
    const wanted: ActionSettings = {}
    const was: ActionFields = { conversionActionId: ch.conversionActionId }
    const now: ActionFields = { conversionActionId: ch.conversionActionId }
    const actionCurrency = a.defaultValueCurrency ?? currency
    for (const key of ACTION_SETTING_KEYS) {
      const to = ch[key]
      if (to === undefined) continue
      const from = liveSetting(a, key)
      if (from === to || (key === 'name' && typeof to === 'string' && to.trim() === from)) { skipped.push(`${what}: ${LABEL[key]} is already ${show(key, to, actionCurrency)}.`); continue }
      ;(wanted as Record<string, unknown>)[key] = to
      ;(was as Record<string, unknown>)[key] = from ?? null
      ;(now as Record<string, unknown>)[key] = to
      lines.push([`${a.name}: ${LABEL[key]}`, show(key, from, actionCurrency), show(key, to, ch.defaultValueCurrency ?? actionCurrency)])
    }
    if (Object.keys(now).length === 1) continue
    const { body, mask } = writeSettings(wanted, actionCurrency)
    operations.push({ conversionActionOperation: { update: { resourceName: `${customer}/conversionActions/${ch.conversionActionId}`, ...body }, updateMask: mask.join(',') } })
    before.actions.push(was)
    after.actions.push(now)
    if (a.ga4) warnings.push(`${what} comes from Google Analytics 4: Google may refuse changes it manages there.`)

    // Money: what makes Smart Bidding chase this action (more).
    const primaryAfter = (now.primary ?? a.primary) === true
    const goalAfter = goalOf((now.category as string | undefined) ?? a.category, a.origin)
    const reasons: string[] = []
    const valueReasons: string[] = []
    for (const key of ACTION_SETTING_KEYS) {
      if (!(key in now)) continue
      const from = (was as Record<string, unknown>)[key]
      const to = (now as Record<string, unknown>)[key]
      const more = chaseMore(key, from, to)
      // A switch to primary always counts; the others only matter for an action bidding uses (primary after the change).
      if (more && (key === 'primary' || primaryAfter)) reasons.push(more)
      const valueMoreReason = valueMore(key, from, to)
      if (valueMoreReason && primaryAfter) valueReasons.push(valueMoreReason)
    }
    if (reasons.length) spends.push(chaseSentence(`${what} ${reasons.join(', ')}`, chasersOf(live.bidding, goalAfter)))
    if (valueReasons.length) spends.push(chaseSentence(`${what} ${valueReasons.join(', ')} (value bidding)`, chasersOf(live.bidding, goalAfter, true)))
    if (now.primary === false && a.primary) warnings.push(`${what} becomes secondary: automatic bidding stops counting it.`)
    if (now.status === 'HIDDEN' && a.status === 'ENABLED') warnings.push(`${what} is hidden: it records no conversions from now${a.primary ? ', and automatic bidding loses this signal' : ''}.`)
    if (now.includeInConversions === false && a.includeInConversions) warnings.push(`${what} leaves "Conversions": automatic bidding stops counting it.`)
  }

  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ') || 'every setting is already so.'}` }
  const { changes: table, more } = changeLines(lines)
  const changed = after.actions.length
  const made = after.created.length
  return {
    summary: made && changed
      ? `Make ${plural(made, 'conversion action')} and change ${plural(changed, 'conversion action')}.`
      : made ? `Make ${plural(made, 'conversion action')}.` : `Change ${plural(changed, 'conversion action')}.`,
    changes: table,
    totals: { created: made, changed, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      actions: [...seen].sort().map((id) => {
        const a = byId.get(id)!
        return `${id}:${ACTION_SETTING_KEYS.map((k) => String(liveSetting(a, k))).join('|')}`
      }),
      names: creates.length ? live.actions.map((a) => (a.name ?? '').toLowerCase()).sort() : [],
    },
    before,
    after,
  }
}

/** After the run: the ids Google gave the actions it made (`new-1` … in create order). */
export function actionRecordAfterRun(after: ActionRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): ActionRecord {
  const made = responses.map((r) => r.conversionActionResult?.resourceName).filter((n): n is string => !!n)
  const out = structuredClone(after)
  out.created = out.created.map((c, i) => {
    const name = made[i]
    return { ...c, conversionActionId: name ? name.slice(name.lastIndexOf('/') + 1) : c.conversionActionId }
  })
  return out
}

// ── conversion actions: remove ───────────────────────────────────────────────────────────────────────────────────

export function actionRemoveDraft(customer: string, ids: string[], live: { actions: LiveConversionAction[]; customerId: string }): GoogleChangeDraft | { refusal: string } {
  if (!ids.length) return { refusal: 'Name the conversion actions to remove.' }
  const byId = new Map(live.actions.map((a) => [a.conversionActionId ?? '', a]))
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const removed: Array<{ conversionActionId: string; name: string | null; type: string | null; primary: boolean }> = []
  for (const id of [...new Set(ids)]) {
    const a = byId.get(id)
    if (!a) return { refusal: `Conversion action ${id} is not in the account (or is already removed).` }
    if (!a.ownerCustomerId) return { refusal: `Conversion action "${a.name}" (${id}) is one of Google's own (system-defined): Google does not let it be removed.` }
    if (a.ownerCustomerId !== live.customerId) return { refusal: `Conversion action "${a.name}" (${id}) belongs to account ${a.ownerCustomerId}: remove it there.` }
    operations.push({ conversionActionOperation: { remove: `${customer}/conversionActions/${id}` } })
    lines.push([`${a.name} (${id})`, `${a.status}, ${a.primary ? 'primary' : 'secondary'}`, 'REMOVED'])
    removed.push({ conversionActionId: id, name: a.name, type: a.type, primary: a.primary })
    if (a.primary && a.status === 'ENABLED') warnings.push(`"${a.name}" is a primary action: automatic bidding loses this signal.`)
  }
  warnings.push('A removed conversion action never records again and cannot be restored; its past numbers stay in the reports.')
  const { changes, more } = changeLines(lines)
  return {
    summary: `Remove ${plural(removed.length, 'conversion action')} for good.`,
    changes,
    totals: { removed: removed.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped: [],
    operations,
    stands: { actions: removed.map((r) => r.conversionActionId).sort() },
    before: { removed: removed.map((r) => ({ ...r, status: byId.get(r.conversionActionId)?.status ?? null })) },
    after: { removed },
  }
}

// ── goals ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GoalAsk { category: string; origin: string; biddable: boolean }
export interface GoalRequest {
  accountGoals?: GoalAsk[]
  campaignGoals?: Array<GoalAsk & { campaignId: string }>
  /** Campaigns that go back to the account's goals (goal_config_level CUSTOMER). */
  useAccountGoals?: string[]
}
export interface GoalRecord {
  account: GoalAsk[]
  campaigns: Array<GoalAsk & { campaignId: string }>
  /** Each campaign's goal level (CUSTOMER: follows the account's goals; CAMPAIGN: its own). */
  levels: Array<{ campaignId: string; goalsFrom: string | null }>
}

export function goalChangeDraft(
  customer: string,
  request: GoalRequest,
  live: { bidding: BiddingContext },
): GoalRecordDraft {
  const asks = request.accountGoals ?? []
  const campaignAsks = request.campaignGoals ?? []
  const back = [...new Set(request.useAccountGoals ?? [])]
  if (!asks.length && !campaignAsks.length && !back.length) return { refusal: 'Say what to change: accountGoals, campaignGoals or useAccountGoals.' }
  const goals = live.bidding.goals
  const accountGoal = (g: { category: string; origin: string }) => goals.accountGoals.find((a) => a.category === g.category && a.origin === g.origin)
  const campaignOf = (id: string) => goals.campaigns.find((c) => c.campaignId === id)
  // The campaign itself, when it is enabled and bids with Smart Bidding (what a goal it bids for can make spend more).
  const smart = (c: SmartBiddingCampaign) => (c.status === 'ENABLED' && c.bidding && CONVERSION_BIDDING.has(c.bidding) ? [c] : [])
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: GoalRecord = { account: [], campaigns: [], levels: [] }
  const after: GoalRecord = { account: [], campaigns: [], levels: [] }
  const seen = new Set<string>()

  for (const g of asks) {
    const key = goalOf(g.category, g.origin)
    if (seen.has(`a:${key}`)) return { refusal: `The account goal ${key} is named twice.` }
    seen.add(`a:${key}`)
    const now = accountGoal(g)
    if (!now) return { refusal: `The account has no ${g.category} goal from ${g.origin} (Google makes a goal when a conversion action of that category and origin exists). google-ads-live view conversions lists them.` }
    if (now.biddable === g.biddable) { skipped.push(`Account goal ${key} is already ${g.biddable ? 'biddable' : 'not biddable'}.`); continue }
    operations.push({ customerConversionGoalOperation: { update: { resourceName: `${customer}/customerConversionGoals/${g.category}~${g.origin}`, biddable: g.biddable }, updateMask: 'biddable' } })
    lines.push([`account goal ${key}`, now.biddable ? 'biddable' : 'not biddable', g.biddable ? 'biddable' : 'not biddable'])
    before.account.push({ category: g.category, origin: g.origin, biddable: now.biddable })
    after.account.push({ category: g.category, origin: g.origin, biddable: g.biddable })
    if (g.biddable) {
      // Campaigns that follow the account's goals start bidding for it.
      const following = live.bidding.campaigns.filter((c) => {
        const own = campaignOf(c.campaignId)
        return c.status === 'ENABLED' && !!c.bidding && CONVERSION_BIDDING.has(c.bidding) && (!own || own.goalsFrom !== 'CAMPAIGN')
      })
      spends.push(chaseSentence(`The account goal ${key} becomes biddable for every campaign that follows the account's goals`, following))
    } else {
      warnings.push(`The account goal ${key} stops being biddable: campaigns that follow the account's goals stop bidding for it.`)
    }
  }

  const overridden = new Set<string>()
  for (const g of campaignAsks) {
    const key = goalOf(g.category, g.origin)
    if (seen.has(`c:${g.campaignId}:${key}`)) return { refusal: `Campaign ${g.campaignId}'s goal ${key} is named twice.` }
    seen.add(`c:${g.campaignId}:${key}`)
    if (back.includes(g.campaignId)) return { refusal: `Campaign ${g.campaignId} is in campaignGoals and in useAccountGoals: one or the other.` }
    const campaign = live.bidding.campaigns.find((c) => c.campaignId === g.campaignId)
    if (!campaign) return { refusal: `Campaign ${g.campaignId} is not in the account (or is removed).` }
    if (!accountGoal(g)) return { refusal: `The account has no ${g.category} goal from ${g.origin}, so campaign "${campaign.name}" has none either.` }
    const own = campaignOf(g.campaignId)
    const was = own ? own.biddableGoals.includes(key) : accountGoal(g)!.biddable
    if (was === g.biddable) { skipped.push(`Campaign "${campaign.name}": goal ${key} is already ${g.biddable ? 'biddable' : 'not biddable'}.`); continue }
    operations.push({ campaignConversionGoalOperation: { update: { resourceName: `${customer}/campaignConversionGoals/${g.campaignId}~${g.category}~${g.origin}`, biddable: g.biddable }, updateMask: 'biddable' } })
    lines.push([`${campaign.name}: goal ${key}`, was ? 'biddable' : 'not biddable', g.biddable ? 'biddable' : 'not biddable'])
    before.campaigns.push({ campaignId: g.campaignId, category: g.category, origin: g.origin, biddable: was })
    after.campaigns.push({ campaignId: g.campaignId, category: g.category, origin: g.origin, biddable: g.biddable })
    if (!overridden.has(g.campaignId)) {
      overridden.add(g.campaignId)
      const level = own?.goalsFrom ?? 'CUSTOMER'
      before.levels.push({ campaignId: g.campaignId, goalsFrom: level })
      after.levels.push({ campaignId: g.campaignId, goalsFrom: 'CAMPAIGN' })
      if (level !== 'CAMPAIGN') warnings.push(`Campaign "${campaign.name}" gets goals of its own: changes to the account's goals no longer reach it (useAccountGoals puts it back).`)
      if (own?.customGoalId) warnings.push(`Campaign "${campaign.name}" uses a custom goal (${own.customGoalId}); Google decides how it combines with these goals.`)
    }
    if (g.biddable) spends.push(chaseSentence(`Campaign "${campaign.name}" starts bidding for ${key}`, smart(campaign)))
    else warnings.push(`Campaign "${campaign.name}" stops bidding for ${key}.`)
  }

  for (const id of back) {
    const campaign = live.bidding.campaigns.find((c) => c.campaignId === id)
    if (!campaign) return { refusal: `Campaign ${id} is not in the account (or is removed).` }
    const own = campaignOf(id)
    if (!own || own.goalsFrom !== 'CAMPAIGN') { skipped.push(`Campaign "${campaign.name}" already follows the account's goals.`); continue }
    operations.push({ conversionGoalCampaignConfigOperation: { update: { resourceName: `${customer}/conversionGoalCampaignConfigs/${id}`, goalConfigLevel: 'CUSTOMER' }, updateMask: 'goal_config_level' } })
    lines.push([`${campaign.name}: goals`, 'its own', 'the account\'s'])
    before.levels.push({ campaignId: id, goalsFrom: own.goalsFrom })
    after.levels.push({ campaignId: id, goalsFrom: 'CUSTOMER' })
    // Its own biddable goals, so undo can give them back.
    for (const ag of goals.accountGoals) {
      const key = goalOf(ag.category, ag.origin)
      if (!ag.category || !ag.origin) continue
      before.campaigns.push({ campaignId: id, category: ag.category, origin: ag.origin, biddable: own.biddableGoals.includes(key) })
    }
    const gained = goals.accountGoals.filter((ag) => ag.biddable && !own.biddableGoals.includes(ag.goal)).map((ag) => ag.goal)
    const lost = own.biddableGoals.filter((g) => !goals.accountGoals.some((ag) => ag.biddable && ag.goal === g))
    if (gained.length) spends.push(chaseSentence(`Campaign "${campaign.name}" starts bidding for ${gained.join(', ')} (the account's goals)`, smart(campaign)))
    if (lost.length) warnings.push(`Campaign "${campaign.name}" stops bidding for ${lost.join(', ')}.`)
    if (own.customGoalId) warnings.push(`Campaign "${campaign.name}" stops using its custom goal (${own.customGoalId}); undo cannot give a custom goal back.`)
  }

  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ') || 'every goal is already so.'}` }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Change ${plural(operations.length, 'conversion goal setting')}.`,
    changes,
    totals: { accountGoals: after.account.length, campaignGoals: after.campaigns.length, campaignsBackToAccountGoals: back.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      account: goals.accountGoals.map((g) => `${g.goal}:${g.biddable}`).sort(),
      campaigns: goals.campaigns.filter((c) => campaignAsks.some((a) => a.campaignId === c.campaignId) || back.includes(c.campaignId ?? ''))
        .map((c) => `${c.campaignId}:${c.goalsFrom}:${c.biddableGoals.join(',')}:${c.customGoalId ?? ''}`).sort(),
    },
    before,
    after,
  }
}
export type GoalRecordDraft = GoogleChangeDraft | { refusal: string }
