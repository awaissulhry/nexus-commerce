/**
 * Meta ads step 30 (2026-10-21) — what a Meta webhook delivery says, after its signature was checked: the envelope read
 * into single changes, each change's topic (`<object>.<field>`), the business key it is routed by, the little of its
 * value Nexus keeps, and the notice it raises. Pure: no database, no Meta call.
 *
 * A notification says WHAT changed, never the new state (ads-webhooks-overview: "poll the relevant Marketing API
 * endpoint to get the current details"), so a topic either asks for a re-read of the ad account, rings the alerts inbox
 * (Notification, the owners of the business), both, or is only recorded on the inbound ledger for the steps that read
 * comments, conversations, leads and catalogs (they read Meta live; nothing here is a copy of Meta's data).
 *
 * What is kept: an ALLOW-list of value paths per topic — ids, statuses, levels, Meta's own words about an issue. Never
 * what a person wrote (a message, a comment, a name, a username), never a PSID, never an amount (an alert subscription's
 * `current_value` and a rule's `current_value` can be money in minor units: left out, the notice names the field only).
 *
 * Checked 2026-10-21 (developers.facebook.com, v26.0):
 *   - ads webhooks (marketing-api/ads-webhooks/*.md): envelope {object:"ad_account", entry:[{id, time, changes:[{field,
 *     value}]}]}; effective status arrives as field `field_changed` with value.changed_fields ["effective_status"],
 *     value {object_id, object_type campaign|adset|ad}; with_issues_ad_objects {id, level, error_code, error_summary,
 *     error_message}; in_process_ad_objects {id, level, status_name}; creative_fatigue {ad_account_id, adgroup_id,
 *     creative_fatigue_level LOW|MEDIUM|HIGH, creative_fatigue_message}; ad_recommendations {ad_account_id, ad_object_ids,
 *     recommendation_type, recommendation_signature (may be empty), recommendation_message, recommendation_stage,
 *     recommendation_hash}; subscriptions {subscription_id, account_id, object_id, object_type, field?, current_value?}
 *     — ids may come as JSON numbers
 *   - graph-api/webhooks/reference/ad-account/: also ads_async_creation_request {status, result{result_id, error_code,
 *     error_message}} and product_set_issue {ad_account_id, product_set_id, type, description, recommended_action}
 *   - reference/application/: ad_account {id, account_status, disable_reason, business}, ads_rules_engine {rule_id,
 *     account_id, object_id, object_type, trigger_type, trigger_field, current_value}, async_requests {category, verb
 *     complete|fail, report_id}, dev_alerts {notification_id, date, header, subtitle}
 *   - reference/catalog/: items_batch {catalog_id, handle, status — "Finished": individual requests with errors were
 *     NOT saved}, product_feed {catalog_id, product_feed_id, status}
 *   - reference/permissions/: connected | bookmarked | public_search | social_ads, each {verb}
 *   - reference/page/ and messenger-platform/webhooks.md: Page `changes` (leadgen, feed, mention, product_review,
 *     messaging_in_thread_lead_form_submit …) and Messenger events in entry.messaging[] ({sender, recipient, timestamp}
 *     + message | delivery | read | reaction | message_edit | postback | referral | optin | policy_enforcement | thread
 *     control) or entry.standby[]; the Messenger page: answer 200 within 5 s, and a delivery that keeps failing for an
 *     hour UNSUBSCRIBES the app from the Page ("Webhooks Disabled")
 *   - instagram-platform/webhooks/fields.md: comments, live_comments, mentions, messages, message_reactions,
 *     messaging_handover, messaging_optins, messaging_policy_enforcement, messaging_postbacks, messaging_referral,
 *     messaging_seen, response_feedback, standby, story_insights (Facebook Login; signed with the Meta app's secret)
 *   - graph-api/webhooks/getting-started: `changed_fields` instead of `changes` when Include Values is off; `time` is
 *     when the notification was SENT; batches of up to 1000 updates; retries for 36 h → deduplicate
 */
import { createHash } from 'node:crypto'
import { metaAdAccountId, metaObjectId, AD_ACCOUNT_STATUS_WORDS } from '../../cx/connectors/meta/discovery.js'

/** Where a change's business is found: a link this business chose (MetaAccountLink), its own app, or its system user. */
export type MetaRouteKind = 'AD_ACCOUNT' | 'PAGE' | 'INSTAGRAM' | 'APP' | 'USER'

/** What Nexus does with a change once it is this business's. */
export type MetaWebhookAction = 'reread' | 'notice' | 'reread+notice' | 'record'

export interface MetaTopic {
  /** The master rows (step 30) this topic answers. */
  rows: readonly string[]
  route: MetaRouteKind
  /** For application topics that name an ad account in their value: the value key holding it. */
  accountKey?: string
  /** Value paths kept on the ledger row (an allow-list; dotted for nested objects). */
  keep: readonly string[]
  /**
   * Value paths that identify ONE event (a lead, a comment, an alert, a batch): when one is present, Meta's retries
   * are recognised by them alone, whatever `entry.time` says. Topics without one are keyed on the whole change and
   * `entry.time` (a state that can come back later must not be taken for a retry).
   */
  idKeys?: readonly string[]
  act: MetaWebhookAction
}

const MESSAGE = ['timestamp', 'message.mid', 'message.is_echo'] as const
// EN-041 (review B2): a person who clicks a Click-to-Messenger / Click-to-Direct ad starts the thread with a `messages`
// event whose message.referral names the ad (messenger-platform/reference/webhook-events/messages).
const MESSAGE_FROM_AD = [...MESSAGE, 'message.referral.source', 'message.referral.type', 'message.referral.ad_id', 'message.referral.ref', 'message.referral.ads_context_data.ad_title', 'message.referral.ads_context_data.post_id', 'message.referral.ads_context_data.product_id'] as const
const REFERRAL = ['timestamp', 'referral.source', 'referral.type', 'referral.ad_id', 'referral.ref', 'referral.ads_context_data.ad_title', 'referral.ads_context_data.post_id', 'referral.ads_context_data.product_id', 'referral.ads_context_data.flow_id'] as const
const POLICY = ['timestamp', 'policy_enforcement.action', 'policy_enforcement.reason'] as const
// Review B1 — Facebook Login for Business sends the comment as `comment_id` (Instagram Login as `id`): both kept.
const IG_COMMENT = ['comment_id', 'id', 'parent_id', 'media.id', 'media.ad_id', 'media.original_media_id', 'media.media_product_type'] as const

/**
 * Every topic Nexus knows. A topic not here is recorded with no value kept and nothing done (an object Nexus routes,
 * a field it has no use for); an object not here is not routed at all (answered 200, ignored, never stored).
 */
export const META_WEBHOOK_TOPICS: Readonly<Record<string, MetaTopic>> = {
  // ── ad_account (ads webhooks) ── routed by entry.id, the ad account
  'ad_account.effective_status': { rows: ['WH-016'], route: 'AD_ACCOUNT', keep: ['object_id', 'object_type', 'changed_fields'], act: 'reread' },
  'ad_account.field_changed': { rows: ['WH-016'], route: 'AD_ACCOUNT', keep: ['object_id', 'object_type', 'changed_fields'], act: 'reread' },
  'ad_account.subscriptions': { rows: ['WH-017'], route: 'AD_ACCOUNT', keep: ['subscription_id', 'account_id', 'object_id', 'object_type', 'field'], act: 'notice' },
  'ad_account.creative_fatigue': { rows: ['WH-018'], route: 'AD_ACCOUNT', keep: ['ad_account_id', 'adgroup_id', 'creative_fatigue_level', 'creative_fatigue_message'], act: 'notice' },
  'ad_account.ad_recommendations': { rows: ['WH-019'], route: 'AD_ACCOUNT', keep: ['ad_account_id', 'ad_object_ids', 'recommendation_type', 'recommendation_stage', 'recommendation_hash', 'recommendation_message'], idKeys: ['recommendation_hash'], act: 'notice' },
  'ad_account.in_process_ad_objects': { rows: ['WH-020'], route: 'AD_ACCOUNT', keep: ['id', 'level', 'status_name'], act: 'reread' },
  'ad_account.with_issues_ad_objects': { rows: ['WH-021'], route: 'AD_ACCOUNT', keep: ['id', 'level', 'error_code', 'error_summary', 'error_message'], act: 'reread+notice' },
  'ad_account.ads_async_creation_request': { rows: ['WH-022'], route: 'AD_ACCOUNT', keep: ['status', 'result_id', 'error_code', 'error_message', 'result.result_id', 'result.error_code', 'result.error_message'], act: 'reread+notice' },
  'ad_account.product_set_issue': { rows: ['WH-023'], route: 'AD_ACCOUNT', keep: ['ad_account_id', 'product_set_id', 'type', 'description', 'recommended_action'], act: 'notice' },
  // ── application ── routed by the ad account the value names, else by the one business that uses the app
  'application.ad_account': { rows: ['WH-024'], route: 'AD_ACCOUNT', accountKey: 'id', keep: ['id', 'account_status', 'disable_reason', 'business'], act: 'reread+notice' },
  'application.ads_rules_engine': { rows: ['WH-025'], route: 'AD_ACCOUNT', accountKey: 'account_id', keep: ['rule_id', 'account_id', 'object_id', 'object_type', 'trigger_type', 'trigger_field'], act: 'notice' },
  // WH-026: Meta documents only polling for async insights runs (insights/best-practices); the field is recorded and a
  // failure noticed, nothing waits for it (RECHECK-C3 WH-026).
  'application.async_requests': { rows: ['WH-026'], route: 'APP', keep: ['category', 'verb', 'report_id'], idKeys: ['report_id', 'verb'], act: 'notice' },
  'application.dev_alerts': { rows: ['WH-027'], route: 'APP', keep: ['notification_id', 'date', 'header', 'subtitle'], idKeys: ['notification_id'], act: 'notice' },
  // ── page ── routed by entry.id, the Page
  'page.leadgen': { rows: ['LD-036', 'WH-028'], route: 'PAGE', keep: ['leadgen_id', 'page_id', 'form_id', 'adgroup_id', 'ad_id', 'created_time'], idKeys: ['leadgen_id'], act: 'notice' },
  // LD-050: Meta documents only the field name; only ids are kept.
  'page.messaging_in_thread_lead_form_submit': { rows: ['LD-050', 'WH-036'], route: 'PAGE', keep: ['timestamp', 'page_id', 'form_id', 'leadgen_id', 'lead_id', 'ad_id', 'created_time'], idKeys: ['leadgen_id', 'lead_id'], act: 'notice' },
  'page.feed': { rows: ['WH-029'], route: 'PAGE', keep: ['item', 'verb', 'post_id', 'comment_id', 'parent_id', 'created_time', 'post.id', 'post.promotion_status'], idKeys: ['comment_id', 'post_id', 'item', 'verb'], act: 'record' },
  'page.mention': { rows: ['WH-030'], route: 'PAGE', keep: ['item', 'verb', 'post_id', 'comment_id'], idKeys: ['comment_id', 'post_id', 'item', 'verb'], act: 'record' },
  'page.messages': { rows: ['WH-031', 'EN-041'], route: 'PAGE', keep: MESSAGE_FROM_AD, act: 'record' },
  'page.message_echoes': { rows: ['WH-031'], route: 'PAGE', keep: MESSAGE, act: 'record' },
  'page.message_reads': { rows: ['WH-031'], route: 'PAGE', keep: ['timestamp', 'read.watermark'], act: 'record' },
  'page.message_deliveries': { rows: ['WH-031'], route: 'PAGE', keep: ['timestamp', 'delivery.watermark'], act: 'record' },
  'page.message_reactions': { rows: ['WH-031'], route: 'PAGE', keep: ['timestamp', 'reaction.mid', 'reaction.action'], act: 'record' },
  'page.message_edits': { rows: ['WH-031'], route: 'PAGE', keep: ['timestamp', 'message_edit.mid'], act: 'record' },
  'page.messaging_postbacks': { rows: ['WH-033'], route: 'PAGE', keep: ['timestamp', 'postback.mid', 'postback.referral.source', 'postback.referral.type', 'postback.referral.ad_id', 'postback.referral.ref'], act: 'record' },
  // EN-041: which ad started (or resumed) a conversation — the ad id and its ref, never the person's id.
  'page.messaging_referrals': { rows: ['EN-041', 'WH-032'], route: 'PAGE', keep: REFERRAL, act: 'record' },
  'page.messaging_handovers': { rows: ['WH-034'], route: 'PAGE', keep: ['timestamp'], act: 'record' },
  'page.standby': { rows: ['WH-034'], route: 'PAGE', keep: ['timestamp'], act: 'record' },
  'page.messaging_policy_enforcement': { rows: ['WH-035'], route: 'PAGE', keep: POLICY, act: 'notice' },
  'page.messaging_integrity': { rows: ['WH-035'], route: 'PAGE', keep: ['timestamp'], act: 'notice' },
  'page.product_review': { rows: ['WH-040'], route: 'PAGE', keep: ['product_item_id', 'status', 'reasons'], act: 'notice' },
  // ── instagram (Facebook Login) ── routed by entry.id, the Instagram account
  'instagram.comments': { rows: ['WH-041'], route: 'INSTAGRAM', keep: IG_COMMENT, idKeys: ['comment_id', 'id'], act: 'record' },
  'instagram.live_comments': { rows: ['WH-042'], route: 'INSTAGRAM', keep: IG_COMMENT, idKeys: ['comment_id', 'id'], act: 'record' },
  'instagram.mentions': { rows: ['WH-043'], route: 'INSTAGRAM', keep: ['media_id', 'comment_id'], idKeys: ['comment_id', 'media_id'], act: 'record' },
  'instagram.messages': { rows: ['WH-044', 'EN-041'], route: 'INSTAGRAM', keep: MESSAGE_FROM_AD, act: 'record' },
  'instagram.message_echoes': { rows: ['WH-044'], route: 'INSTAGRAM', keep: MESSAGE, act: 'record' },
  'instagram.message_reactions': { rows: ['WH-044'], route: 'INSTAGRAM', keep: ['timestamp', 'reaction.mid', 'reaction.action'], act: 'record' },
  'instagram.message_edit': { rows: ['WH-044'], route: 'INSTAGRAM', keep: ['timestamp', 'message_edit.mid'], act: 'record' },
  'instagram.messaging_seen': { rows: ['WH-044'], route: 'INSTAGRAM', keep: ['timestamp', 'read.mid'], act: 'record' },
  'instagram.messaging_postbacks': { rows: ['WH-046'], route: 'INSTAGRAM', keep: ['timestamp', 'postback.mid'], act: 'record' },
  'instagram.messaging_optins': { rows: ['WH-046'], route: 'INSTAGRAM', keep: ['timestamp'], act: 'record' },
  'instagram.messaging_handover': { rows: ['WH-046'], route: 'INSTAGRAM', keep: ['timestamp'], act: 'record' },
  'instagram.standby': { rows: ['WH-046'], route: 'INSTAGRAM', keep: ['timestamp'], act: 'record' },
  'instagram.response_feedback': { rows: ['WH-046'], route: 'INSTAGRAM', keep: ['timestamp'], act: 'record' },
  'instagram.messaging_policy_enforcement': { rows: ['WH-046'], route: 'INSTAGRAM', keep: POLICY, act: 'notice' },
  'instagram.messaging_referral': { rows: ['EN-041', 'WH-045'], route: 'INSTAGRAM', keep: REFERRAL, act: 'record' },
  'instagram.story_insights': { rows: ['WH-047'], route: 'INSTAGRAM', keep: ['media_id', 'impressions', 'reach', 'taps_forward', 'taps_back', 'exits', 'replies'], act: 'record' },
  // ── catalog ── no per-catalog subscribe edge exists (CT-165, RECHECK-C3): the app's catalog subscription delivers for
  // catalogs its system user can reach, so a catalog event is routed only to the ONE business using the app. Nexus
  // never depends on these pushes (CT-166): the catalog reads poll batch status and feed uploads themselves.
  'catalog.items_batch': { rows: ['WH-048', 'CT-163', 'CT-165'], route: 'APP', keep: ['catalog_id', 'handle', 'status'], idKeys: ['handle', 'status'], act: 'notice' },
  'catalog.product_feed': { rows: ['WH-049', 'CT-164', 'CT-165'], route: 'APP', keep: ['catalog_id', 'product_feed_id', 'status'], act: 'notice' },
  // ── permissions ── user-scoped (WH-050): routed only when entry.id is the business's own system user
  'permissions.connected': { rows: ['WH-050'], route: 'USER', keep: ['verb'], act: 'notice' },
  'permissions.bookmarked': { rows: ['WH-050'], route: 'USER', keep: ['verb'], act: 'record' },
  'permissions.public_search': { rows: ['WH-050'], route: 'USER', keep: ['verb'], act: 'notice' },
  'permissions.social_ads': { rows: ['WH-050'], route: 'USER', keep: ['verb'], act: 'notice' },
}

/** The objects Nexus routes, and how an unknown field of each is routed (recorded, nothing kept, nothing done). */
const OBJECT_ROUTE: Readonly<Record<string, MetaRouteKind>> = {
  ad_account: 'AD_ACCOUNT', application: 'APP', page: 'PAGE', instagram: 'INSTAGRAM', catalog: 'APP', permissions: 'USER',
}

/** The topics a handler runs for (everything but `record`): the inbound replay registry lists exactly these. */
export const META_HANDLED_TOPICS: readonly string[] = Object.entries(META_WEBHOOK_TOPICS).filter(([, t]) => t.act !== 'record').map(([k]) => k)

// ── the envelope ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** More changes than this in one delivery are not read (Meta batches at most 1000). */
export const MAX_CHANGES_PER_DELIVERY = 2000

/** One change of a delivery, as Meta sent it (value unreduced; it never leaves this process). */
export interface MetaWebhookChange {
  object: string
  /** Where in the entry it came from: Messenger / Instagram events (messaging, standby) carry their own timestamp. */
  source: 'changes' | 'messaging' | 'standby' | 'changed_fields'
  entryId: string
  /** entry.time: when Meta SENT the notification (seconds, or milliseconds on Messenger). */
  time: number | null
  field: string
  value: Record<string, unknown>
}

/**
 * JSON with Meta's long ids intact: an integer JSON.parse cannot hold exactly (campaign and ad ids are 15–18 digits; the
 * subscriptions example sends ids as numbers) becomes its digits as a string. Node ≥ 21 hands a reviver the source text
 * (production runs Node 22); without it the number stays as parsed.
 */
export function parseMetaJson(raw: Buffer | string): unknown {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && typeof context?.source === 'string' && /^-?\d+$/.test(context.source)) return context.source
    return value
  } as (key: string, value: unknown) => unknown)
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const idText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null)

/** The field of one Messenger / Instagram messaging event (entry.messaging[]), by the key that carries it. */
export function messagingFieldOf(object: string, event: Record<string, unknown>): string {
  const page = object === 'page'
  const message = rec(event.message)
  if (message) return message.is_echo === true ? 'message_echoes' : 'messages'
  if (rec(event.message_edit)) return page ? 'message_edits' : 'message_edit'
  if (rec(event.reaction)) return 'message_reactions'
  if (rec(event.read)) return page ? 'message_reads' : 'messaging_seen'
  if (rec(event.delivery)) return 'message_deliveries'
  if (rec(event.postback)) return 'messaging_postbacks'
  if (rec(event.referral)) return page ? 'messaging_referrals' : 'messaging_referral'
  if (rec(event.optin)) return 'messaging_optins'
  if (rec(event.policy_enforcement)) return 'messaging_policy_enforcement'
  if (rec(event.pass_thread_control) || rec(event.take_thread_control) || rec(event.request_thread_control) || rec(event.app_roles)) return page ? 'messaging_handovers' : 'messaging_handover'
  if (rec(event.account_linking)) return 'messaging_account_linking'
  if (rec(event.response_feedback)) return 'response_feedback'
  return 'messaging'
}

/**
 * Every change of a delivery: `entry[].changes[]`, Messenger/Instagram `entry[].messaging[]` and `entry[].standby[]`,
 * and `entry[].changed_fields[]` (Include Values off). Effective status (`field_changed` naming effective_status in
 * changed_fields) is read as `effective_status`. Null when the body is not Meta's envelope.
 */
export function metaWebhookChanges(body: unknown): MetaWebhookChange[] | null {
  const root = rec(body)
  const object = typeof root?.object === 'string' ? root.object.trim() : ''
  if (!root || !object || !Array.isArray(root.entry)) return null
  const out: MetaWebhookChange[] = []
  const push = (source: MetaWebhookChange['source'], entryId: string, time: number | null, field: string, value: Record<string, unknown>) => {
    if (out.length < MAX_CHANGES_PER_DELIVERY) out.push({ object, source, entryId, time, field, value })
  }
  for (const raw of root.entry) {
    const entry = rec(raw)
    const entryId = idText(entry?.id)
    if (!entry || !entryId) continue
    const time = typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : null
    for (const c of Array.isArray(entry.changes) ? entry.changes : []) {
      const change = rec(c)
      const field = typeof change?.field === 'string' ? change.field.trim() : ''
      if (!change || !field) continue
      const value = rec(change.value) ?? {}
      const changed = Array.isArray(value.changed_fields) ? value.changed_fields : []
      push('changes', entryId, time, field === 'field_changed' && changed.includes('effective_status') ? 'effective_status' : field, value)
    }
    for (const m of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const event = rec(m)
      if (event) push('messaging', entryId, time, messagingFieldOf(object, event), event)
    }
    for (const s of Array.isArray(entry.standby) ? entry.standby : []) {
      const event = rec(s)
      if (event) push('standby', entryId, time, 'standby', event)
    }
    for (const f of Array.isArray(entry.changed_fields) ? entry.changed_fields : []) {
      if (typeof f === 'string' && f.trim()) push('changed_fields', entryId, time, f.trim(), {})
    }
  }
  return out
}

/** `<object>.<field>`: the ledger's event type for a change. */
export const metaTopicOf = (change: Pick<MetaWebhookChange, 'object' | 'field'>): string => `${change.object}.${change.field}`.slice(0, 120)

/** How a change is routed, or null when Nexus does not route its object at all. */
export function metaRouteOf(change: Omit<MetaWebhookChange, 'source'>): { kind: MetaRouteKind; id: string | null } | null {
  const topic = META_WEBHOOK_TOPICS[metaTopicOf(change)]
  const kind = topic?.route ?? OBJECT_ROUTE[change.object]
  if (!kind) return null
  if (kind === 'AD_ACCOUNT') return { kind, id: metaAdAccountId(topic?.accountKey ? change.value[topic.accountKey] : change.entryId) }
  if (kind === 'PAGE' || kind === 'INSTAGRAM' || kind === 'USER') return { kind, id: metaObjectId(change.entryId) }
  return { kind, id: null }
}

// ── what is kept ─────────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_TEXT = 500
const MAX_LIST = 50

function scalar(v: unknown): string | number | boolean | null | undefined {
  if (typeof v === 'string') return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT - 1)}…` : v
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean') return v
  if (v === null) return null
  return undefined
}

/** Only the allow-listed paths of a value, scalars and lists of scalars only (never a nested object wholesale). */
export function keptValue(value: Record<string, unknown>, keep: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of keep) {
    const parts = path.split('.')
    let at: unknown = value
    for (const part of parts) at = rec(at)?.[part]
    const kept = Array.isArray(at)
      ? at.slice(0, MAX_LIST).map(scalar).filter((x) => x !== undefined)
      : scalar(at)
    if (kept === undefined) continue
    let into = out
    for (const part of parts.slice(0, -1)) into = (rec(into[part]) ?? (into[part] = {})) as Record<string, unknown>
    into[parts[parts.length - 1]] = kept
  }
  return out
}

/** What the ledger row holds for a change: the topic's allow-listed value, and where it came from. */
export interface MetaWebhookPayload {
  appId: string
  object: string
  entryId: string
  field: string
  time: number | null
  value: Record<string, unknown>
}

export function metaWebhookPayload(appId: string, change: MetaWebhookChange): MetaWebhookPayload {
  const topic = META_WEBHOOK_TOPICS[metaTopicOf(change)]
  return { appId, object: change.object, entryId: change.entryId, field: change.field, time: change.time, value: keptValue(change.value, topic?.keep ?? []) }
}

const scalarAt = (value: Record<string, unknown>, path: string): unknown => {
  let at: unknown = value
  for (const part of path.split('.')) at = rec(at)?.[part]
  return typeof at === 'string' || typeof at === 'number' || typeof at === 'boolean' ? at : null
}
const MESSAGING_IDS = ['message.mid', 'message_edit.mid', 'reaction.mid', 'postback.mid', 'read.mid'] as const

/**
 * The ledger's delivery id for a change on one connection, the same on every retry of Meta's (whatever batch it comes
 * in). Review F4:
 *   - a topic with event ids (a lead, a comment, an alert, a batch handle): those ids alone;
 *   - a Messenger / Instagram event: its message id and its own timestamp, never `entry.time` (when it was SENT);
 *   - anything else: the whole change and `entry.time` (a state that comes back later is a new change).
 */
export function metaChangeKey(appId: string, connectionId: string, change: MetaWebhookChange): string {
  const topic = META_WEBHOOK_TOPICS[metaTopicOf(change)]
  const ids = (topic?.idKeys ?? []).map((path) => scalarAt(change.value, path))
  let identity: unknown[]
  if (ids.some((v) => v !== null && v !== '')) identity = ['ids', ...ids]
  else if (change.source === 'messaging' || change.source === 'standby') {
    const mid = MESSAGING_IDS.map((path) => scalarAt(change.value, path)).find((v) => v !== null && v !== '') ?? null
    identity = mid !== null ? ['mid', mid, change.value.timestamp ?? null] : ['event', change.value]
  } else identity = ['time', change.time, change.value]
  // Review N1 — the account row is part of the id: a business that moved to a new Meta connection row records anew.
  const digest = createHash('sha256').update(JSON.stringify([appId, connectionId, change.object, change.entryId, change.field, ...identity])).digest('hex')
  return `meta:${digest}`
}

/** entry.time as a date (Messenger sends milliseconds, the rest seconds). */
export function metaChangeTime(time: number | null): Date | null {
  if (time === null || time <= 0) return null
  const ms = time > 1e12 ? time : time * 1000
  const at = new Date(ms)
  return Number.isNaN(at.getTime()) ? null : at
}

// ── the alerts inbox ─────────────────────────────────────────────────────────────────────────────────────────────────

export type MetaNoticeKind =
  | 'meta-ads-object-issue' | 'meta-ads-account-status' | 'meta-ads-alert-fired' | 'meta-ads-creative-fatigue'
  | 'meta-ads-recommendation' | 'meta-ads-product-set-issue' | 'meta-app-notice' | 'meta-messaging-policy'
  | 'meta-lead-received' | 'meta-catalog-update' | 'meta-product-review' | 'meta-webhook-signature'

export interface MetaNotice {
  kind: MetaNoticeKind
  severity: 'info' | 'warn' | 'danger'
  title: string
  body: string
  entityType: string
  entityId: string
  href: string | null
}

const ADS_PAGE = '/marketing/ads/meta'
const CHANNELS_PAGE = '/settings/channels'
const LEVEL_WORDS: Record<string, string> = { CAMPAIGN: 'campaign', AD_SET: 'ad set', ADSET: 'ad set', AD: 'ad', CREATIVE: 'creative' }
const levelWord = (v: unknown): string => LEVEL_WORDS[String(v ?? '').toUpperCase()] ?? 'object'
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const sentence = (v: unknown): string => { const t = s(v); return t ? ` Meta says: "${t}"` : '' }

/**
 * The notice a change raises, or null (this value needs none: a fatigue going LOW, a grant, a finished async run).
 * Review F1 — a notice is one unread per subject (channel-alerts), so the subject of a STATE names the state: an unread
 * "active again" never hides a later "disabled", a MEDIUM fatigue never hides a HIGH one, a Finished batch never hides
 * a failed one.
 */
export function metaWebhookNotice(payload: MetaWebhookPayload): MetaNotice | null {
  const v = payload.value
  const topic = `${payload.object}.${payload.field}`
  const named = payload.object === 'ad_account' ? payload.entryId : s(v.account_id) ?? s(v.id) ?? payload.entryId
  const account = metaAdAccountId(named) ?? named
  switch (topic) {
    case 'ad_account.with_issues_ad_objects': {
      const id = s(v.id) ?? 'unknown'
      return { kind: 'meta-ads-object-issue', severity: 'warn', title: `Meta: a ${levelWord(v.level)} has a problem`, body: `Meta reports a problem on ${levelWord(v.level)} ${id} (error ${s(v.error_code) ?? 'without a code'}).${sentence(v.error_summary)} Nexus reads the ad account again to show its current status.`, entityType: 'meta-ad-object', entityId: `${account}~${id}~issue~${s(v.error_code) ?? ''}`, href: ADS_PAGE }
    }
    case 'ad_account.ads_async_creation_request': {
      const code = s(v.error_code) ?? s(rec(v.result)?.error_code)
      const status = s(v.status) ?? ''
      if (!code && !/fail|error/i.test(status)) return null
      return { kind: 'meta-ads-object-issue', severity: 'warn', title: 'Meta: an ad creation job failed', body: `An ad or creative Meta was creating in the background did not finish (status ${status || 'unknown'}${code ? `, error ${code}` : ''}).${sentence(v.error_message ?? rec(v.result)?.error_message)}`, entityType: 'meta-ad-account', entityId: `${account}~async~${status || code || ''}`, href: ADS_PAGE }
    }
    case 'ad_account.product_set_issue': {
      const id = s(v.product_set_id) ?? 'unknown'
      return { kind: 'meta-ads-product-set-issue', severity: 'warn', title: 'Meta: a product set used by ads has a problem', body: `Product set ${id}${s(v.type) ? ` (${s(v.type)})` : ''}.${sentence(v.description)}${s(v.recommended_action) ? ` Meta suggests: "${s(v.recommended_action)}"` : ''}`, entityType: 'meta-product-set', entityId: `${account}~${id}~${s(v.type) ?? ''}`, href: ADS_PAGE }
    }
    case 'ad_account.subscriptions': {
      const object = s(v.object_id) ?? 'unknown'
      return { kind: 'meta-ads-alert-fired', severity: 'warn', title: 'Meta: one of your alert subscriptions fired', body: `Alert subscription ${s(v.subscription_id) ?? 'unknown'} fired for ${levelWord(v.object_type)} ${object}${s(v.field) ? ` (${s(v.field)})` : ''}. Read the ${levelWord(v.object_type)}'s current numbers before acting: Nexus keeps no amount from the push.`, entityType: 'meta-ad-object', entityId: `${account}~${object}~alert~${s(v.subscription_id) ?? ''}`, href: ADS_PAGE }
    }
    case 'ad_account.creative_fatigue': {
      const level = String(v.creative_fatigue_level ?? '').toUpperCase()
      if (level !== 'HIGH' && level !== 'MEDIUM') return null
      const ad = s(v.adgroup_id) ?? 'unknown'
      return { kind: 'meta-ads-creative-fatigue', severity: level === 'HIGH' ? 'warn' : 'info', title: `Meta: an ad's creative is wearing out (${level.toLowerCase()})`, body: `Ad ${ad}: its creative fatigue is now ${level.toLowerCase()}.${sentence(v.creative_fatigue_message)} Read its last 7 days (frequency, CTR, cost per result) before changing it.`, entityType: 'meta-ad-object', entityId: `${account}~${ad}~fatigue~${level}`, href: ADS_PAGE }
    }
    case 'ad_account.ad_recommendations': {
      const type = s(v.recommendation_type) ?? 'a recommendation'
      return { kind: 'meta-ads-recommendation', severity: 'info', title: `Meta has a new recommendation (${type})`, body: `Meta made a new recommendation for ${Array.isArray(v.ad_object_ids) ? v.ad_object_ids.length : 0} object(s) of this ad account. The push does not carry what it would change: read the recommendation in full before applying it.`, entityType: 'meta-recommendation', entityId: `${account}~${s(v.recommendation_hash) ?? type}`, href: ADS_PAGE }
    }
    case 'application.ad_account': {
      const status = typeof v.account_status === 'number' ? v.account_status : Number(v.account_status)
      const words = Number.isFinite(status) ? AD_ACCOUNT_STATUS_WORDS[status] ?? `status ${status}` : 'unknown'
      return { kind: 'meta-ads-account-status', severity: status === 1 ? 'info' : 'danger', title: status === 1 ? 'Meta: the ad account is active again' : `Meta: the ad account is now ${words.toLowerCase()}`, body: `Meta changed ad account ${account} to "${words}"${Number(v.disable_reason) ? ` (disable reason ${v.disable_reason})` : ''}. Nexus reads the account again.`, entityType: 'meta-ad-account', entityId: `${account}~status~${Number.isFinite(status) ? status : 'unknown'}`, href: ADS_PAGE }
    }
    case 'application.ads_rules_engine': {
      const object = s(v.object_id) ?? 'unknown'
      return { kind: 'meta-ads-alert-fired', severity: 'info', title: 'Meta: a trigger rule fired', body: `Rule ${s(v.rule_id) ?? 'unknown'} fired for ${levelWord(v.object_type)} ${object} (${s(v.trigger_type) ?? 'trigger'}${s(v.trigger_field) ? ` on ${s(v.trigger_field)}` : ''}).`, entityType: 'meta-ad-object', entityId: `${account}~${object}~rule~${s(v.rule_id) ?? ''}`, href: ADS_PAGE }
    }
    case 'application.async_requests':
      if (s(v.verb) !== 'fail') return null
      return { kind: 'meta-app-notice', severity: 'info', title: 'Meta: a background job failed', body: `A ${s(v.category) ?? 'background'} job of the Meta app failed${s(v.report_id) ? ` (run ${s(v.report_id)})` : ''}. Nexus reads its reports by asking Meta, so nothing waits on this push.`, entityType: 'meta-app', entityId: `${payload.appId}~async`, href: null }
    case 'application.dev_alerts':
      return { kind: 'meta-app-notice', severity: 'warn', title: `Meta app alert: ${s(v.header) ?? 'a developer alert'}`, body: `${s(v.subtitle) ?? 'Meta sent an alert about the business\'s Meta app.'} Read it in the Meta App Dashboard.`, entityType: 'meta-app', entityId: `${payload.appId}~${s(v.notification_id) ?? 'alert'}`, href: CHANNELS_PAGE }
    case 'page.leadgen':
    case 'page.messaging_in_thread_lead_form_submit': {
      const form = s(v.form_id) ?? 'unknown'
      return { kind: 'meta-lead-received', severity: 'info', title: 'Meta: a new lead arrived', body: `A person filled in ${topic === 'page.leadgen' ? 'lead form' : 'a Messenger lead form'} ${form}${s(v.ad_id) ? ` from ad ${s(v.ad_id)}` : ''} on Page ${payload.entryId}. The push holds no answers: the lead itself is read from Meta.`, entityType: 'meta-lead-form', entityId: `${payload.entryId}~${form}`, href: null }
    }
    case 'page.messaging_policy_enforcement':
    case 'page.messaging_integrity':
    case 'instagram.messaging_policy_enforcement': {
      const where = payload.object === 'page' ? `Page ${payload.entryId}` : `Instagram account ${payload.entryId}`
      const action = (s(rec(v.policy_enforcement)?.action) ?? '').toLowerCase()
      // Review B5 — Meta's actions (messaging_policy_enforcement): warning, block, unblock.
      if (action === 'unblock') {
        return { kind: 'meta-messaging-policy', severity: 'info', title: 'Meta lifted its messaging block', body: `Meta lifted the messaging block on ${where}: messages can be sent again.`, entityType: payload.object === 'page' ? 'meta-page' : 'meta-instagram', entityId: `${payload.entryId}~policy~unblock`, href: null }
      }
      const block = action === 'block'
      return { kind: 'meta-messaging-policy', severity: block ? 'danger' : 'warn', title: block ? 'Meta blocked messaging for a policy breach' : 'Meta warned about its messaging policy', body: `Meta took a messaging policy action on ${where}${action ? ` (${action})` : ''}.${sentence(rec(v.policy_enforcement)?.reason)} ${block ? 'Send no more messages from this account until it is resolved in Meta.' : 'Check the messages sent from this account before Meta blocks it.'}`, entityType: payload.object === 'page' ? 'meta-page' : 'meta-instagram', entityId: `${payload.entryId}~policy~${action || topic}`, href: null }
    }
    case 'page.product_review': {
      if (String(v.status ?? '').toUpperCase() !== 'REJECTED') return null
      const item = s(v.product_item_id) ?? 'unknown'
      const reasons = Array.isArray(v.reasons) ? v.reasons.map(s).filter(Boolean).slice(0, 5).join('; ') : ''
      return { kind: 'meta-product-review', severity: 'warn', title: 'Meta rejected a catalog item in review', body: `Catalog item ${item} was rejected in Meta's product review on Page ${payload.entryId}.${reasons ? ` Meta says: "${reasons}"` : ''}`, entityType: 'meta-catalog-item', entityId: `${item}~${String(v.status).toUpperCase()}`, href: null }
    }
    case 'catalog.items_batch':
    case 'catalog.product_feed': {
      const status = s(v.status) ?? 'unknown'
      const batch = topic === 'catalog.items_batch'
      return { kind: 'meta-catalog-update', severity: status === 'Finished' ? 'info' : 'warn', title: batch ? `Meta: a catalog batch is ${status.toLowerCase()}` : `Meta: a catalog feed upload is ${status.toLowerCase()}`, body: batch ? `Catalog ${payload.entryId}: batch ${s(v.handle) ?? 'unknown'} is "${status}". Requests in it that had errors were NOT saved: check the batch status for them.` : `Catalog ${payload.entryId}: feed ${s(v.product_feed_id) ?? 'unknown'} is "${status}". Check the upload's errors.`, entityType: 'meta-catalog', entityId: `${payload.entryId}~${s(v.handle) ?? s(v.product_feed_id) ?? ''}~${status}`, href: null }
    }
    case 'permissions.connected':
    case 'permissions.public_search':
    case 'permissions.social_ads': {
      const verb = s(v.verb) ?? ''
      if (!/^(disconnected|revoked|removed)$/i.test(verb)) return null
      return { kind: 'meta-app-notice', severity: 'warn', title: 'Meta: a permission of the business\'s Meta app was removed', body: `Meta says ${payload.field.replace('_', ' ')} was ${verb} for the system user of this business. Check the Meta connection in Settings › Channels › Meta ("Check now").`, entityType: 'meta-app', entityId: `${payload.appId}~${payload.field}~${verb.toLowerCase()}`, href: CHANNELS_PAGE }
    }
    default:
      return null
  }
}

/**
 * Review F2 — a delivery for this business's Meta app that the app secret Nexus holds for it does not sign: nothing
 * of it was read. At most one per business per 24 hours (the receiver passes the day as its occurrence).
 */
export function metaSignatureNotice(appId: string): MetaNotice {
  return {
    kind: 'meta-webhook-signature', severity: 'danger', title: 'Meta webhook signatures stopped matching',
    body: `Nexus received notifications for Meta app ${appId} that the app secret it holds for this business does not sign, so it read none of them. Either the app secret was changed in Meta (enter the new one in Settings › Channels › Meta, Replace), or someone other than Meta sent them.`,
    entityType: 'meta-app', entityId: `${appId}~signature`, href: CHANNELS_PAGE,
  }
}
