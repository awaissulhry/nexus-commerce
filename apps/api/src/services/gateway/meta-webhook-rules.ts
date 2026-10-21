/**
 * Meta step 30 part 2 (2026-10-21) — the write allow-list entries of set-meta-webhooks, set-meta-alert-subscription and
 * remove-meta-alert-subscription: EXACT routes, keys and values, each rule bound to what it may touch (the gateway
 * confirms it before anything is sent — gateway.ts metaOwnerProblem):
 *   app        POST / DELETE /<app id>/subscriptions — the connection's OWN Meta app, with its APP token; the callback is
 *              exactly Nexus's own receiver for that app; the verify token is added by the gateway from
 *              META_WEBHOOK_VERIFY_TOKEN (never a caller's, never shown); DELETE always names an object
 *   adaccount  POST / DELETE /act_<id>/subscribed_apps with app_id (the connection's own app) — the CHOSEN ad account;
 *              POST /act_<id>/subscriptions, PATCH and DELETE /act_<id>/subscriptions/<id> — its alert subscriptions
 *   page       POST /<page id>/subscribed_apps subscribed_fields with the CHOSEN Page's own token (step 36's Page-token
 *              mode, `auth: 'page'`: the gateway reads it; part 3), DELETE /<page id>/subscribed_apps with the APP token
 *              — the CHOSEN Page only (gateway.ts metaPageOwnerProblem / metaWebhookOwnerProblem)
 *
 * Checked 2026-10-21 (developers.facebook.com and Meta's Python Business SDK, main):
 *   - graph-api/reference/app/subscriptions (v26.0): POST object, callback_url, fields, include_values, verify_token
 *     ("a POST with callback_url, verify_token and object reactivates the subscription"; publishing again amends fields
 *     "without overwriting existing ones"); DELETE object (omitted = ALL subscriptions removed), fields; app token; not
 *     for Instagram or WhatsApp ("must be configured in the App Dashboard"). SDK application.py create_subscription adds
 *     include_client_certificate (mTLS; not sent: Railway's edge ends TLS). The reference's object enum is the old one
 *     (user, page, permissions, payments); ad_account (ads-webhooks/setup/get-started.md), application (reference/
 *     application webhooks) and catalog (reference/catalog webhooks) are documented on their own pages.
 *   - marketing-api/reference/ad-account/subscribed_apps.md: POST app_id ("the id of app to be subscribed"), DELETE
 *     app_id; "an ad account admin token" (ads-webhooks get-started). SDK adaccount.py create_subscribed_app /
 *     delete_subscribed_apps (app_id). Meta's SDK sends a DELETE's parameters in the query string (api.py: `if method in
 *     ('GET', 'DELETE'): params=…`), so a DELETE here carries them there.
 *   - graph-api/reference/page/subscribed_apps: POST subscribed_fields (a Page access token of a person who can perform
 *     the CREATE_CONTENT, MANAGE or MODERATE task on the Page, pages_manage_metadata and pages_show_list; Messenger fields
 *     also pages_messaging; "cannot subscribe to Instagram" fields — an Instagram account's webhooks need its linked Page
 *     subscribed to any Page field, instagram-platform webhooks); GET (the same Page token) lists the installed apps with
 *     id, name, subscribed_fields; DELETE with an App Access Token ("an app can remove its own webhook subscription from a
 *     Page"); answers {success, messaging_success}. Whether a second POST replaces the field list or adds to it is not
 *     documented (LIVE-PROBES WH-010u): Nexus sends the whole list it wants, so either way the Page ends with it.
 *   - marketing-api/ads-webhooks/subscriptions.md: POST /act_<id>/subscriptions event_type, filters (≤ 20 {field, value,
 *     operator}, entity_type CAMPAIGN | ADSET | AD), field, value, operator, status ENABLED (default) | DISABLED; PATCH
 *     /act_<id>/subscriptions/<id> status; DELETE; money in the currency's minor unit, times epoch seconds; Meta's
 *     examples send JSON with a Bearer token — Nexus sends the same keys as a form with the account token, as every Graph
 *     change (STILL-UNVERIFIED for this endpoint: LIVE-PROBES WH-051f / WH-056p; Meta's answer decides).
 */
import type { MetaWriteRule } from './meta-calls.js'
import { publicApiOrigin } from '../public-api-origin.js'

type Params = ReadonlyMap<string, string>
/** An own key of a table (never `constructor`, `__proto__` or another inherited name — review A4). */
const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)

// ── app subscriptions ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fields Nexus subscribes per object: exactly the topics its receiver knows (marketing/meta-ads/webhook-topics.ts;
 * a test holds them equal). Effective status is subscribed as `effective_status` and arrives as `field_changed`.
 */
export const META_WEBHOOK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ad_account: ['effective_status', 'subscriptions', 'creative_fatigue', 'ad_recommendations', 'in_process_ad_objects', 'with_issues_ad_objects', 'ads_async_creation_request', 'product_set_issue'],
  application: ['ad_account', 'ads_rules_engine', 'async_requests', 'dev_alerts'],
  page: [
    'leadgen', 'feed', 'mention', 'messages', 'message_echoes', 'message_reads', 'message_deliveries', 'message_reactions', 'message_edits',
    'messaging_postbacks', 'messaging_referrals', 'messaging_handovers', 'standby', 'messaging_policy_enforcement', 'messaging_integrity',
    'messaging_in_thread_lead_form_submit', 'product_review',
  ],
  catalog: ['items_batch', 'product_feed'],
  permissions: ['connected', 'bookmarked', 'public_search', 'social_ads'],
}
export const META_WEBHOOK_OBJECTS = Object.keys(META_WEBHOOK_FIELDS) as Array<keyof typeof META_WEBHOOK_FIELDS>
/** The fields Nexus subscribes for an object, or null — an own key only (review A4: never `constructor` or `__proto__`). */
export const metaWebhookFieldsOf = (object: string): readonly string[] | null => (hasOwn(META_WEBHOOK_FIELDS, object) ? META_WEBHOOK_FIELDS[object] : null)

/** Nexus's own receiver for this app (routes/meta-webhooks.routes.ts), or why there is none. */
export function metaWebhookCallback(appId: string): { url: string } | { error: string } {
  const origin = publicApiOrigin()
  if ('error' in origin) return origin
  return { url: `${origin.origin}/webhooks/meta/${appId}` }
}

/** A comma list of these names, each once, at least one (Meta: list<string>; Nexus writes it with commas, no spaces). */
function fieldList(value: string | undefined, allowed: readonly string[], what: string): string | null {
  if (!value) return `${what} names at least one field`
  const names = value.split(',')
  if (names.some((n) => !allowed.includes(n))) return `${what} are only ${allowed.join(', ')}`
  return new Set(names).size === names.length ? null : `${what} names each field once`
}

const appOfRoute = (route: string): string | null => /^(\d{5,25})\//.exec(route)?.[1] ?? null

// ── alert subscriptions (ads-webhooks/subscriptions.md) ─────────────────────────────────────────────────────────────

export const ALERT_EVENT_TYPES = ['OBJECT_CREATED', 'OBJECT_UPDATED', 'INSIGHTS_UPDATED', 'INSIGHTS_MILESTONE_REACHED'] as const
export const ALERT_ENTITY_TYPES = ['CAMPAIGN', 'ADSET', 'AD'] as const
export const ALERT_STATUSES = ['ENABLED', 'DISABLED'] as const
const RANGE_OPS = ['GREATER_THAN', 'LESS_THAN', 'IN_RANGE', 'NOT_IN_RANGE'] as const

/** How a field's value is written: money (minor units), a time (epoch seconds), a count or ratio, an enum, text, label ids. */
export type AlertValueKind = 'money' | 'count' | 'time' | 'number' | 'enum' | 'bool' | 'text' | 'ids'

const ALL_LEVELS = ['CAMPAIGN', 'ADSET', 'AD'] as const
/**
 * OBJECT_UPDATED: the metadata fields, the operators each accepts, how its value is written, and the object levels Meta's
 * table gives it (review B5: an alert on a field of another level is refused).
 */
export const ALERT_OBJECT_FIELDS: Readonly<Record<string, { ops: readonly string[]; kind: AlertValueKind; levels: readonly string[] }>> = {
  name: { ops: ['EQUAL', 'CONTAIN', 'NOT_CONTAIN'], kind: 'text', levels: ALL_LEVELS },
  objective: { ops: ['IN', 'NOT_IN'], kind: 'enum', levels: ['CAMPAIGN'] },
  optimization_goal: { ops: ['IN', 'NOT_IN'], kind: 'enum', levels: ['ADSET'] },
  buying_type: { ops: ['IN', 'NOT_IN'], kind: 'enum', levels: ['CAMPAIGN'] },
  billing_event: { ops: ['IN', 'NOT_IN'], kind: 'enum', levels: ['ADSET'] },
  is_autobid: { ops: ['IN', 'NOT_IN'], kind: 'bool', levels: ['ADSET'] },
  daily_budget: { ops: RANGE_OPS, kind: 'money', levels: ['ADSET'] },
  lifetime_budget: { ops: RANGE_OPS, kind: 'money', levels: ['ADSET'] },
  spend_cap: { ops: RANGE_OPS, kind: 'money', levels: ['CAMPAIGN'] },
  bid_amount: { ops: RANGE_OPS, kind: 'money', levels: ['ADSET', 'AD'] },
  adlabel_ids: { ops: ['ANY', 'ALL', 'NONE'], kind: 'ids', levels: ALL_LEVELS },
  start_time: { ops: RANGE_OPS, kind: 'time', levels: ['ADSET', 'CAMPAIGN'] },
  stop_time: { ops: ['GREATER_THAN', 'LESS_THAN'], kind: 'time', levels: ['ADSET', 'CAMPAIGN'] },
  created_time: { ops: RANGE_OPS, kind: 'time', levels: ALL_LEVELS },
  updated_time: { ops: RANGE_OPS, kind: 'time', levels: ALL_LEVELS },
}
const objectFieldOf = (field: string) => (hasOwn(ALERT_OBJECT_FIELDS, field) ? ALERT_OBJECT_FIELDS[field] : null)
/** The level an extra filter field belongs to (its own entry above). */
export const alertLevelsOf = (field: string): readonly string[] => objectFieldOf(field)?.levels ?? []
const LEVEL_WORD: Readonly<Record<string, string>> = { CAMPAIGN: 'a campaign', ADSET: 'an ad set', AD: 'an ad' }
/** "daily_budget is a setting of an ad set (not of a campaign)". */
const levelProblem = (field: string, entity: string) => `${field} is a setting of ${alertLevelsOf(field).map((l) => LEVEL_WORD[l]).join(' or ')} (not of ${LEVEL_WORD[entity] ?? entity})`

/** INSIGHTS_UPDATED: the metric fields (all take GREATER_THAN, LESS_THAN, IN_RANGE, NOT_IN_RANGE). */
export const ALERT_METRIC_FIELDS: readonly string[] = [
  'clicks', 'cost_per', 'cpa', 'cpc', 'cpm', 'cpp', 'ctr', 'frequency', 'impressions', 'lifetime_impressions', 'lifetime_spent', 'link_ctr',
  'mobile_app_purchase_roas', 'reach', 'results', 'result_rate', 'spent', 'today_spent', 'website_purchase_roas', 'yesterday_spent',
  'leadgen', 'like', 'link_click', 'offsite_engagement', 'post', 'post_comment', 'post_engagement', 'post_like', 'post_reaction',
  'view_content', 'video_play', 'video_view', 'vote',
  'cost_per_unique_click', 'cost_per_link_click', 'cost_per_post_engagement', 'cost_per_video_view', 'cost_per_messaging_first_reply',
  'cost_per_messaging_reply', 'cost_per_mobile_app_install', 'cost_per_mobile_achievement_unlocked', 'cost_per_mobile_activate_app',
  'cost_per_mobile_add_payment_info', 'cost_per_mobile_add_to_cart', 'cost_per_mobile_add_to_wishlist', 'cost_per_mobile_complete_registration',
  'cost_per_mobile_content_view', 'cost_per_mobile_initiated_checkout', 'cost_per_mobile_level_achieved', 'cost_per_mobile_purchase',
  'cost_per_mobile_rate', 'cost_per_mobile_search', 'cost_per_mobile_spent_credits', 'cost_per_mobile_tutorial_completion',
  'cost_per_offline_conversion', 'cost_per_offline_add_payment_info', 'cost_per_offline_add_to_cart', 'cost_per_offline_add_to_wishlist',
  'cost_per_offline_complete_registration', 'cost_per_offline_initiate_checkout', 'cost_per_offline_lead', 'cost_per_offline_other',
  'cost_per_offline_purchase', 'cost_per_offline_search', 'cost_per_offline_view_content',
  'cost_per_initiate_checkout_fb', 'cost_per_purchase_fb', 'cost_per_add_to_cart_fb', 'cost_per_lead_fb', 'cost_per_add_payment_info_fb',
  'cost_per_complete_registration_fb', 'cost_per_add_to_wishlist_fb', 'cost_per_search_fb', 'cost_per_view_content_fb',
  'mobile_app_install', 'app_custom_event',
  ...['achievement_unlocked', 'activate_app', 'add_payment_info', 'add_to_cart', 'add_to_wishlist', 'complete_registration', 'content_view',
    'initiated_checkout', 'level_achieved', 'purchase', 'rate', 'search', 'spent_credits', 'tutorial_completion'].map((e) => `app_custom_event.fb_mobile_${e}`),
  'app_custom_event.other', 'offline_conversion',
  ...['add_payment_info', 'add_to_cart', 'add_to_wishlist', 'complete_registration', 'initiate_checkout', 'lead', 'other', 'purchase', 'search', 'view_content'].map((e) => `offline_conversion.${e}`),
  'offsite_conversion',
  ...['add_payment_info', 'add_to_cart', 'add_to_wishlist', 'complete_registration', 'initiate_checkout', 'lead', 'other', 'purchase', 'search', 'view_content'].map((e) => `offsite_conversion.fb_pixel_${e}`),
  'onsite_conversion', 'onsite_conversion.messaging_first_reply', 'onsite_conversion.messaging_reply',
]

/** INSIGHTS_MILESTONE_REACHED: the fields and their minimum (`value` fires at each multiple; lifetime counts). */
export const ALERT_MILESTONE_MINIMUMS: Readonly<Record<string, number>> = {
  impressions: 1000, unique_impressions: 1000, reach: 1000, clicks: 10, unique_clicks: 10, spent: 1000, results: 5,
  app_custom_event: 1, app_custom_event_other: 1, mobile_app_install: 1,
  ...Object.fromEntries(['achievement_unlocked', 'activate_app', 'add_payment_info', 'add_to_cart', 'add_to_wishlist', 'complete_registration', 'content_view',
    'initiated_checkout', 'level_achieved', 'purchase', 'rate', 'search', 'spent_credits', 'tutorial_completion'].map((e) => [`app_custom_event_fb_mobile_${e}`, 1])),
  offsite_conversion: 1, offsite_conversion_add_to_cart: 1, offsite_conversion_checkout: 1,
  ...Object.fromEntries(['add_payment_info', 'add_to_cart', 'add_to_wishlist', 'complete_registration', 'initiate_checkout', 'lead', 'other', 'purchase', 'search', 'view_content']
    .map((e) => [`offsite_conversion_fb_pixel_${e}`, 1])),
  ...Object.fromEntries(['link_click', 'like', 'leadgen', 'offsite_engagement', 'post', 'post_comment', 'post_engagement', 'post_like', 'post_reaction', 'view_content', 'video_play', 'video_view', 'vote'].map((e) => [e, 1])),
}

/** The extra filters (beside entity_type) Nexus writes: the enum metadata fields, EQUAL / IN / NOT_IN. */
export const ALERT_FILTER_FIELDS = ['objective', 'optimization_goal', 'buying_type', 'billing_event'] as const
export const ALERT_FILTER_OPS = ['EQUAL', 'IN', 'NOT_IN'] as const

/** Money metrics (spend, costs): written in the currency's minor unit, like Meta's own. */
export const isAlertMoneyMetric = (field: string) => ['spent', 'today_spent', 'yesterday_spent', 'lifetime_spent', 'cpa', 'cpc', 'cpm', 'cpp', 'cost_per'].includes(field) || field.startsWith('cost_per_')

/** How a field of this event type is written, or null when the event type does not take it. */
export function alertFieldKind(eventType: string, field: string): AlertValueKind | null {
  if (eventType === 'OBJECT_UPDATED') return objectFieldOf(field)?.kind ?? null
  if (eventType === 'INSIGHTS_UPDATED') return ALERT_METRIC_FIELDS.includes(field) ? (isAlertMoneyMetric(field) ? 'money' : 'number') : null
  // Review B5 — a milestone is a count (or spend in minor units): a whole number either way.
  if (eventType === 'INSIGHTS_MILESTONE_REACHED') return hasOwn(ALERT_MILESTONE_MINIMUMS, field) ? (field === 'spent' ? 'money' : 'count') : null
  return null
}

/** The operators this event type and field take. */
export function alertFieldOps(eventType: string, field: string): readonly string[] {
  if (eventType === 'OBJECT_UPDATED') return objectFieldOf(field)?.ops ?? []
  if (eventType === 'INSIGHTS_UPDATED') return RANGE_OPS
  if (eventType === 'INSIGHTS_MILESTONE_REACHED') return ['EQUAL']
  return []
}

const WHOLE = /^(0|[1-9]\d{0,14})$/
const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/
const TOKEN = /^[A-Z][A-Z0-9_]{0,59}$/

/** Why one value (or one end of a range) of this kind is refused, or null. */
function scalarProblem(kind: AlertValueKind, value: unknown): string | null {
  const s = typeof value === 'string' ? value : null
  switch (kind) {
    case 'money': return s && WHOLE.test(s) && Number(s) <= 100_000_000_000 ? null : 'an amount in the currency\'s minor unit, a whole number'
    case 'count': return s && WHOLE.test(s) ? null : 'a whole number'
    case 'time': return s && /^\d{10}$/.test(s) ? null : 'a time in epoch seconds'
    case 'number': return s && DECIMAL.test(s) ? null : 'a number (at most 4 decimals)'
    case 'enum': return s && TOKEN.test(s) ? null : 'one of Meta\'s values (capital letters, digits and _)'
    case 'bool': return s === 'true' || s === 'false' ? null : 'true or false'
    case 'text': return s && /^[\x20-\x7e]{1,100}$/.test(s) && s === s.trim() ? null : 'plain text, 1 to 100 characters'
    case 'ids': return s && /^\d{1,20}$/.test(s) ? null : 'a Meta id (digits)'
  }
}

/**
 * Why the value of a condition is refused, or null. One spelling per kind: a single value as text; a range (IN_RANGE,
 * NOT_IN_RANGE) and a list (IN, NOT_IN, ANY, ALL, NONE) as a JSON list of text values, no spaces.
 */
export function alertValueProblem(kind: AlertValueKind, operator: string, value: string): string | null {
  const listOp = ['IN', 'NOT_IN', 'ANY', 'ALL', 'NONE'].includes(operator)
  const rangeOp = operator === 'IN_RANGE' || operator === 'NOT_IN_RANGE'
  if (listOp || rangeOp) {
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { return 'a list or range is a JSON list' }
    if (!Array.isArray(parsed) || JSON.stringify(parsed) !== value) return 'a list or range is a JSON list in one spelling (no spaces)'
    if (rangeOp && parsed.length !== 2) return 'a range is two values, low then high'
    if (listOp && (parsed.length < 1 || parsed.length > 20)) return 'a list has 1 to 20 values'
    for (const part of parsed) { const p = scalarProblem(kind, part); if (p) return `each value is ${p}` }
    if (rangeOp && Number(parsed[0]) >= Number(parsed[1])) return 'a range is low then high'
    return null
  }
  const p = scalarProblem(kind, value)
  return p ? `the value is ${p}` : null
}

/**
 * The canonical filters list Nexus writes: entity_type first, then up to 19 enum filters of that level — EQUAL with one
 * value, IN / NOT_IN with a real JSON list of values (review B2, as ad-rule filters are written).
 */
export function alertFiltersProblem(value: string | undefined): string | null {
  if (!value) return 'filters lists at least the entity_type'
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return 'filters is a JSON list' }
  if (!Array.isArray(parsed) || JSON.stringify(parsed) !== value) return 'filters is a JSON list in one spelling (no spaces)'
  if (parsed.length < 1 || parsed.length > 20) return 'filters has 1 to 20 conditions (Meta allows at most 20)'
  const seen = new Set<string>()
  for (const [i, f] of parsed.entries()) {
    if (!f || typeof f !== 'object' || Array.isArray(f) || JSON.stringify(Object.keys(f)) !== '["field","value","operator"]') return 'each filter is {field, value, operator}, in that order'
    const { field, value: v, operator } = f as Record<string, unknown>
    if (typeof field !== 'string' || typeof operator !== 'string') return 'a filter\'s field and operator are text'
    if (i === 0) {
      if (field !== 'entity_type' || operator !== 'EQUAL' || typeof v !== 'string' || !(ALERT_ENTITY_TYPES as readonly string[]).includes(v)) return 'the first filter is entity_type EQUAL CAMPAIGN, ADSET or AD'
      continue
    }
    if (!(ALERT_FILTER_FIELDS as readonly string[]).includes(field)) return `a filter is entity_type or one of ${ALERT_FILTER_FIELDS.join(', ')}`
    if (!(ALERT_FILTER_OPS as readonly string[]).includes(operator)) return `a filter's operator is ${ALERT_FILTER_OPS.join(', ')}`
    if (seen.has(field)) return 'each filter field once'
    seen.add(field)
    const entity = (parsed[0] as Record<string, unknown>).value as string
    if (!alertLevelsOf(field).includes(entity)) return `filter ${levelProblem(field, entity)}`
    if (operator === 'EQUAL') {
      if (typeof v !== 'string' || !TOKEN.test(v)) return `filter ${field}: EQUAL takes one of Meta's values (capital letters, digits and _)`
    } else if (!Array.isArray(v) || v.length < 1 || v.length > 20 || v.some((x) => typeof x !== 'string' || !TOKEN.test(x))) {
      return `filter ${field}: ${operator} takes a list of 1 to 20 of Meta's values`
    }
  }
  return null
}

/** The level a create watches: its first filter's entity_type (alertFiltersProblem has judged it). */
const entityOf = (filters: string): string | null => { try { const f = (JSON.parse(filters) as Array<{ value?: unknown }>)[0]; return typeof f?.value === 'string' ? f.value : null } catch { return null } }

/** Why a create's form is refused, or null — the gateway's judge, which the tool also asks before anything is queued. */
export function alertCreateProblem(params: Params): string | null {
  const eventType = params.get('event_type') ?? ''
  if (!(ALERT_EVENT_TYPES as readonly string[]).includes(eventType)) return `event_type is ${ALERT_EVENT_TYPES.join(', ')}`
  const filters = alertFiltersProblem(params.get('filters'))
  if (filters) return filters
  if (params.has('status') && !(ALERT_STATUSES as readonly string[]).includes(params.get('status')!)) return 'status is ENABLED or DISABLED'
  const field = params.get('field')
  const operator = params.get('operator')
  const value = params.get('value')
  if (eventType === 'OBJECT_CREATED') return field || operator || value ? 'OBJECT_CREATED takes no field, value or operator (filter by entity_type only)' : null
  if (!field) return `${eventType} names its field`
  const kind = alertFieldKind(eventType, field)
  if (!kind) return `${field} is not a field ${eventType} watches`
  // Review B5 — a setting of the level the alert watches (Meta's table: daily_budget an ad set's, objective a campaign's, …).
  const entity = entityOf(params.get('filters')!)
  if (eventType === 'OBJECT_UPDATED' && entity && !alertLevelsOf(field).includes(entity)) return levelProblem(field, entity)
  if (eventType === 'OBJECT_UPDATED' && !operator && !value) return null
  if (!operator || value === undefined) return `${eventType} on ${field} names its operator and value`
  if (!alertFieldOps(eventType, field).includes(operator)) return `${field} takes ${alertFieldOps(eventType, field).join(', ')}`
  const p = alertValueProblem(kind, operator, value)
  if (p) return p
  if (eventType === 'INSIGHTS_MILESTONE_REACHED' && Number(value) < ALERT_MILESTONE_MINIMUMS[field]) return `a ${field} milestone is at least ${ALERT_MILESTONE_MINIMUMS[field]}`
  return null
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const META_WEBHOOK_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // set-meta-webhooks subscribe-app: POST /<app id>/subscriptions with the app token.
    name: 'app.subscriptions',
    method: 'POST',
    path: /^\d{5,25}\/subscriptions$/,
    kinds: ['app'],
    auth: 'app',
    verifyToken: true,
    required: ['object', 'callback_url', 'fields', 'include_values'],
    optional: [],
    values: (params) => {
      const object = params.get('object') ?? ''
      const allowed = metaWebhookFieldsOf(object)
      if (!allowed) return `object is ${META_WEBHOOK_OBJECTS.join(', ')} (Instagram and WhatsApp only in Meta's App Dashboard)`
      if (params.get('include_values') !== 'true') return 'include_values is true (Nexus reads what changed from the notification)'
      return fieldList(params.get('fields'), allowed, `the ${object} fields`)
    },
    routeCheck: (route, params) => {
      const app = appOfRoute(route)
      const callback = app ? metaWebhookCallback(app) : { error: 'no app id' }
      if ('error' in callback) return `Nexus has no callback to give Meta: ${callback.error}`
      return params.get('callback_url') === callback.url ? null : 'the callback is exactly Nexus\'s own Meta receiver for this app (https://<the API>/webhooks/meta/<app id>)'
    },
    appIdOf: (route) => appOfRoute(route),
    budget: false,
  },
  {
    // set-meta-webhooks unsubscribe-app: DELETE /<app id>/subscriptions?object=…[&fields=…] — never without an object.
    name: 'app.subscriptions.delete',
    method: 'DELETE',
    path: /^\d{5,25}\/subscriptions$/,
    kinds: ['app'],
    auth: 'app',
    inQuery: true,
    required: ['object'],
    optional: ['fields'],
    values: (params) => {
      const object = params.get('object') ?? ''
      const allowed = metaWebhookFieldsOf(object)
      if (!allowed) return `object is ${META_WEBHOOK_OBJECTS.join(', ')} (a DELETE without one would remove every subscription of the app)`
      return params.has('fields') ? fieldList(params.get('fields'), allowed, `the ${object} fields`) : null
    },
    appIdOf: (route) => appOfRoute(route),
    budget: false,
  },
  {
    // set-meta-webhooks connect-ad-account: POST /act_<id>/subscribed_apps app_id=<the connection's own app>.
    name: 'adaccount.subscribed_apps',
    method: 'POST',
    path: /^act_\d{1,25}\/subscribed_apps$/,
    kinds: ['adaccount'],
    required: ['app_id'],
    optional: [],
    values: (params) => (/^\d{5,25}$/.test(params.get('app_id') ?? '') ? null : 'app_id is a Meta app id'),
    appIdOf: (_route, params) => params.get('app_id') ?? null,
    budget: false,
  },
  {
    name: 'adaccount.subscribed_apps.delete',
    method: 'DELETE',
    path: /^act_\d{1,25}\/subscribed_apps$/,
    kinds: ['adaccount'],
    inQuery: true,
    required: ['app_id'],
    optional: [],
    values: (params) => (/^\d{5,25}$/.test(params.get('app_id') ?? '') ? null : 'app_id is a Meta app id'),
    appIdOf: (_route, params) => params.get('app_id') ?? null,
    budget: false,
  },
  {
    // set-meta-webhooks install-page (part 3): POST /<page id>/subscribed_apps subscribed_fields=… with the CHOSEN Page's
    // own token (the gateway reads it: meta-page-token.ts; its owner check: meta-page-owner.ts). The Page's connected apps
    // are an edge: no ad object is edited, so Meta's 30-s gap of an ad object does not hold it.
    name: 'page.subscribed_apps',
    method: 'POST',
    path: /^\d{1,25}\/subscribed_apps$/,
    kinds: ['page'],
    auth: 'page',
    edgeCall: true,
    required: ['subscribed_fields'],
    optional: [],
    values: (params) => fieldList(params.get('subscribed_fields'), META_WEBHOOK_FIELDS.page, 'the Page\'s subscribed fields'),
    budget: false,
  },
  {
    // set-meta-webhooks remove-page: DELETE /<page id>/subscribed_apps with the app token (the app removes itself).
    name: 'page.subscribed_apps.delete',
    method: 'DELETE',
    path: /^\d{1,25}\/subscribed_apps$/,
    kinds: ['page'],
    auth: 'app',
    edgeCall: true,
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
  {
    // set-meta-alert-subscription create: POST /act_<id>/subscriptions.
    name: 'adaccount.alert.create',
    method: 'POST',
    path: /^act_\d{1,25}\/subscriptions$/,
    kinds: ['adaccount'],
    required: ['event_type', 'filters'],
    optional: ['field', 'operator', 'value', 'status'],
    maxBody: 4_000,
    values: alertCreateProblem,
    budget: false,
  },
  {
    // set-meta-alert-subscription enable / disable: PATCH /act_<id>/subscriptions/<id> status.
    name: 'adaccount.alert.status',
    method: 'PATCH',
    path: /^act_\d{1,25}\/subscriptions\/\d{1,25}$/,
    kinds: ['adaccount'],
    required: ['status'],
    optional: [],
    values: (params) => ((ALERT_STATUSES as readonly string[]).includes(params.get('status') ?? '') ? null : 'status is ENABLED or DISABLED'),
    budget: false,
  },
  {
    // remove-meta-alert-subscription: DELETE /act_<id>/subscriptions/<id>.
    name: 'adaccount.alert.delete',
    method: 'DELETE',
    path: /^act_\d{1,25}\/subscriptions\/\d{1,25}$/,
    kinds: ['adaccount'],
    required: [],
    optional: [],
    values: () => null,
    budget: false,
  },
]
