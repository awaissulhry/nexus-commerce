/**
 * Meta step 15 (2026-10-25) — the READS Meta answers only to a Page's OWN access token, sent with the token of the
 * business's CHOSEN Facebook Page. Step 36's Page token mode (meta-page-token.ts) is the one way Nexus gets that token;
 * step 30 part 3's read of the Page's connected apps (meta-calls.ts `pageApps`) was the first read made with it. This file
 * is the allow-list of the others: the conversations, inbox and messaging setup of the chosen Page that
 * marketing/meta-ads/live-messaging.ts reads (meta-conversations, meta-message-templates, meta-messaging-setup).
 *
 * Why the Page's token (checked 2026-10-25, curl ≥ 3 s apart, developers.facebook.com):
 *   - documentation/business-messaging/messenger-platform/conversations.md — conversations, a conversation and its
 *     messages: "A Page access token requested from a person who can perform the MESSAGING or MODERATE task on the Page";
 *     docs/graph-api/reference/conversation — the same, and its `/messages` edge;
 *   - …/identity/custom-labels.md (labels), …/ads/ads-welcome-message-flows.md (welcome flows),
 *     …/send-messages/utility-messages.md (utility templates, page_utility_messaging), …/reference/messenger-profile-api.md
 *     (the profile), …/send-messages/personas.md, …/conversation-routing.md (thread owner), …/calling/callsettings.md and
 *     …/calling/biz2consumer/check-permissions.md — each asks a Page access token;
 *   - the chat plugin, feature review, Messenger lead templates and click-to-message eligibility edges of the Page (Graph
 *     reference page/chat_plugin, page/messaging_feature_review, page/messenger_lead_forms,
 *     page/ctx_optimization_eligibility; Meta's Python Business SDK page.py) are the Page's own and go with its token too.
 *
 * The rules (binding):
 *   - ALLOW-list. A read goes with the Page's token only on a route below, with exactly that route's query keys, `fields`
 *     exactly items of that route's own list (each item exactly as written here, its own `{…}` list included), `limit`
 *     digits ≤ 100 and `after` Meta's own cursor. Anything else on these routes is refused before any token is read. The
 *     other read gates (meta-calls.ts: every key's value on ROUTE_KEYS, fieldsProblem, the token words) apply first.
 *   - The Page in the path must be the CHOSEN Page (gateway.ts: its PAGE MetaAccountLink); another Page is refused and
 *     nothing is sent. A caller never asks for the token (`auth` other than the account's own is refused).
 *   - A conversation's own node and its messages edge name no Page: they go with the CHOSEN Page's token (no Page chosen:
 *     refused), so Meta answers them only for a conversation of that Page — its token reaches no other Page's inbox — and
 *     live-messaging.ts also checks Meta names the chosen Page or Instagram account among the conversation's participants.
 *     A conversation id is one of Meta's own two forms only (META_THREAD_ID, a positive pattern — review fix A4).
 *   - `message_templates` is also a WhatsApp Business account's edge. A Page-shaped read (the Messenger keys and fields
 *     only) is this file's read, of the CHOSEN Page only (another id: refused, review fix A5); a WhatsApp account's read
 *     always names `summary` (live-messaging.ts readWhatsAppTemplates), so it is never Page-shaped and stays an ordinary
 *     read with the business's system-user token.
 *   - A person's own id (a PSID) never goes in a path here (the ledger keeps the path): only in the query (user_id,
 *     recipient, psid), which no ledger row or trace keeps. So `/<psid>/custom_labels` (one person's labels) is not read.
 * Review fix A1 — these reads, and the read of the Page's token, take the `page` rate bucket (rate.ts), and the WhatsApp
 * account's reads (metaWhatsAppRead, below) the `whatsapp` one: the ad account's bucket never pays for them.
 *
 * Live-probe fixes (2026-10-26, LIVE-PROBES MD-101, MD-106, IN-092, CR-490): Meta refused these reads of the chosen Page to
 * the system-user token — the feed ("A Page access token is required for this call for the new Pages experience"),
 * published posts (#210), ad posts (#200), a post's catalog-ad (dynamic) posts and its insights (#10), the Page's insights
 * and its Instant Experiences (#190 "must be called with a Page Access Token") — so they go with the chosen Page's token
 * too, on the routes below. Checked 2026-10-26 (curl ≥ 3 s apart, developers.facebook.com/docs/graph-api/reference v26.0):
 * page/feed (a token of someone who can do CREATE_CONTENT, MANAGE or MODERATE on the Page, pages_read_engagement and
 * pages_read_user_content; "If you do not own or manage the Page … Page Public Content Access … use a system user access
 * token"), page/published_posts, page/ads_posts (ADVERTISE, pages_manage_ads, pages_show_list, ads_management), page/insights
 * ("A Page access token requested by a person who can perform the ANALYZE task", read_insights, pages_read_engagement — for
 * Pages and Page posts alike), page/canvases ("A Page access token"), post ("A page access token can read all posts posted
 * to or posted by that Page"). Each route keeps exactly the keys, values and fields live-media.ts (and the comment and
 * research reads of the same edges, live-engagement.ts and live-partners.ts) send. Two routes stay ordinary reads in part:
 *   - `<page>/feed` of ANOTHER Page (meta-ad-library page-posts: public posts, Meta's Page Public Content Access, which the
 *     feed reference reads with the system-user token) is an ordinary read, as before; only the chosen Page's own feed goes
 *     with its token (MetaPageRead.otherPages: gateway.ts decides once it knows the chosen Page);
 *   - `<id>/insights` is the Page's only when every metric is one of Nexus's Page metrics (a campaign's or an Instagram
 *     account's insights name none of them: ordinary reads, unchanged), and `<page>_<post>/insights` only with post metrics.
 * A leaf module (it imports only the fixed metric lists, services/meta/meta-media-lists.ts, a leaf too), so meta-calls.ts
 * takes it without an import cycle.
 */
import { PAGE_BREAKDOWNS, PAGE_METRICS, PAGE_PERIODS, POST_METRICS } from '../meta/meta-media-lists.js'

/** What the gateway does with a read on one of these routes: the chosen Page's token, for this Page (null: a conversation). */
export interface MetaPageRead {
  pageId: string | null
  /**
   * Probe fix MD-101 — the feed only: a read of ANOTHER Page stays an ordinary read with the system-user token (Meta's Page
   * Public Content Access). Only the CHOSEN Page's own feed goes with its token, and only within this route's list:
   * `problem` says why not (gateway.ts refuses it then, nothing sent).
   */
  otherPages?: { problem: string | null }
}

interface PageReadRule {
  /** On the canonical route (lower case, no version). */
  route: RegExp
  /** In words, for the refusals. */
  what: string
  keys: ReadonlySet<string>
  fields: ReadonlySet<string>
  /**
   * `path`: the Page is the route's first segment; `thread`: a conversation's own node or edge (the chosen Page's token);
   * `post`: a post's edge, `<page id>_<post id>/…` — the Page is the post id's first part.
   */
  page: 'path' | 'thread' | 'post'
  /** message_templates only: a read that is not Page-shaped is a WhatsApp account's (an ordinary read). */
  pageShapedOnly?: true
  /** Probe fixes — exactly the values these keys may carry here (limit and after keep their own checks below). */
  values?: Readonly<Record<string, RegExp>>
  /**
   * Probe fix IN-092 — an organic insights read: no `fields`; `metric` a list of these, each once. The read is this rule's
   * only when EVERY metric is one of them; else it is no Page read (a campaign's or an Instagram account's insights).
   */
  metrics?: ReadonlySet<string>
  /** Probe fix MD-101 — the feed only: another Page's read stays an ordinary read (MetaPageRead.otherPages). */
  otherPagesOrdinary?: true
}

/**
 * Review fix A4 — a conversation id in exactly one of Meta's own two forms, a POSITIVE pattern (no deny look-ahead):
 * Messenger `t_<digits>` (the form Meta's Page conversations answer; Meta's pages show placeholders only — LIVE-PROBES
 * EN-035), and Instagram's `aWdf` + letters and digits (Meta's one real example, creator-marketplace-messaging.md:
 * `aWdfZAG06MTpJR01lc3N3Njkz`; base64 of Meta's `ig_…` thread key — LIVE-PROBES EN-042). Case as Meta writes it.
 */
export const META_THREAD_ID = /^(?:t_\d{1,25}|aWdf[A-Za-z0-9]{12,196})$/
const THREAD_NODE = /^[a-z0-9_]{1,200}$/
const THREAD_MESSAGES = /^[a-z0-9_]{1,200}\/messages$/
const LIST_KEYS = ['fields', 'limit', 'after'] as const
const set = (...values: string[]) => new Set(values)

// ── the probe fixes' routes (2026-10-26): their fields, keys and values ─────────────────────────────────────────────
/**
 * A Page post as live-media.ts reads one in a list (POST_FIELDS.PagePost and ListMore), and the five meta-ad-library
 * page-posts asks (id, message, created_time, permalink_url, status_type: a subset).
 */
const POST_LIST_FIELDS = set(
  'id', 'message', 'story', 'created_time', 'updated_time', 'permalink_url', 'status_type', 'is_published', 'is_hidden', 'is_expired',
  'is_eligible_for_promotion', 'promotable_id', 'scheduled_publish_time', 'full_picture', 'is_instagram_eligible', 'from{id}', 'is_inline_created',
)
/** A catalog-ad (dynamic) post: live-media.ts POST_FIELDS.DynamicPost and live-engagement.ts COMMENT_FIELDS.DynamicPost (RTBDynamicPost, SDK). */
const DYNAMIC_POST_FIELDS = set('id', 'title', 'message', 'description', 'link', 'image_url', 'product_id', 'created', 'owner_id')
/** An Instant Experience in the Page's list: live-media.ts IX_FIELDS.Canvas (never last_editor, a person). */
const CANVAS_LIST_FIELDS = set('id', 'name', 'is_published', 'is_hidden', 'canvas_link', 'update_time', 'background_color')
const BOOL = /^(true|false)$/
/** A day as Nexus sends one (YYYY-MM-DD: dayArg). */
const DAY = /^\d{4}-\d{2}-\d{2}$/
const oneOf = (values: readonly string[]) => new RegExp(`^(${values.join('|')})$`)
const INSIGHT_VALUES = { period: oneOf(PAGE_PERIODS), since: DAY, until: DAY, breakdown: oneOf(PAGE_BREAKDOWNS) }

/**
 * The routes, their keys and their fields. Fields: the conversations guide and reference (id, updated_time, participants,
 * is_owner; SDK unifiedthread.py: message_count, unread_count, snippet, can_reply, link), message (reference/message;
 * the guide's id, created_time, from, to, message, reply_to), SDK pageusermessagethreadlabel.py, pagethreadowner.py,
 * messengercallpermissions.py, customusersettings.py, messengerprofile.py (+ greeting: the profile reference), persona.py,
 * ctxpartnerappwelcomemessageflow.py, chatplugin.py, messagingfeaturereview.py, messengercallsettings.py,
 * messengerbusinesstemplate.py, messengeradspartialautomatedsteplist.py, ctxoptimizationeligibility.py.
 */
export const META_PAGE_READ_RULES: readonly PageReadRule[] = [
  {
    route: /^\d+\/conversations$/, what: 'the Page\'s conversations', page: 'path',
    keys: set(...LIST_KEYS, 'platform', 'user_id', 'folder'),
    fields: set('id', 'updated_time', 'participants', 'message_count', 'unread_count', 'snippet', 'can_reply', 'link', 'is_owner'),
  },
  { route: THREAD_NODE, what: 'a conversation', page: 'thread', keys: set('fields'), fields: set('id', 'participants') },
  {
    route: THREAD_MESSAGES, what: 'a conversation\'s messages', page: 'thread', keys: set(...LIST_KEYS),
    fields: set('id', 'created_time', 'from', 'to', 'message', 'attachments{id,name,file_url,image_data,video_data}', 'shares{id,name,description,type,url}', 'story', 'is_unsupported', 'reply_to'),
  },
  { route: /^\d+\/custom_labels$/, what: 'the Page\'s inbox labels', page: 'path', keys: set(...LIST_KEYS), fields: set('id', 'page_label_name') },
  { route: /^\d+\/thread_owner$/, what: 'who answers a person', page: 'path', keys: set('fields', 'recipient'), fields: set('thread_owner') },
  { route: /^\d+\/messenger_call_permissions$/, what: 'a person\'s call permission', page: 'path', keys: set('fields', 'psid'), fields: set('permission', 'actions') },
  { route: /^\d+\/custom_user_settings$/, what: 'a person\'s menu', page: 'path', keys: set('fields', 'psid'), fields: set('page_level_persistent_menu', 'user_level_persistent_menu') },
  {
    route: /^\d+\/messenger_profile$/, what: 'the Page\'s Messenger profile', page: 'path', keys: set('fields', 'platform'),
    fields: set('get_started', 'greeting', 'ice_breakers', 'persistent_menu', 'whitelisted_domains', 'account_linking_url', 'commands', 'subject_to_new_eu_privacy_rules'),
  },
  { route: /^\d+\/personas$/, what: 'the Page\'s personas', page: 'path', keys: set(...LIST_KEYS), fields: set('id', 'name', 'profile_picture_url') },
  {
    route: /^\d+\/welcome_message_flows$/, what: 'the Page\'s welcome flows', page: 'path', keys: set(...LIST_KEYS, 'flow_id'),
    // Review B-SF4: the guide answers `welcome_message`; the SDK names welcome_message_flow and welcome_message_sequence.
    fields: set('id', 'name', 'eligible_platforms', 'last_update_time', 'is_used_in_ad', 'welcome_message', 'welcome_message_flow', 'welcome_message_sequence', 'is_ig_only_flow', 'compatible_platforms'),
  },
  {
    route: /^\d+\/chat_plugin$/, what: 'the Page\'s chat plugin', page: 'path', keys: set('fields'),
    fields: set('alignment', 'desktop_bottom_spacing', 'desktop_side_spacing', 'entry_point_icon', 'entry_point_label', 'greeting_dialog_display', 'guest_chat_mode', 'mobile_bottom_spacing', 'mobile_chat_display', 'mobile_side_spacing', 'theme_color', 'welcome_screen_greeting'),
  },
  { route: /^\d+\/messaging_feature_review$/, what: 'the Page\'s messaging feature review', page: 'path', keys: set(...LIST_KEYS), fields: set('feature', 'status') },
  { route: /^\d+\/messenger_call_settings$/, what: 'the Page\'s Messenger calling', page: 'path', keys: set('fields'), fields: set('audio_enabled', 'video_enabled', 'icon_enabled', 'call_hours', 'call_routing') },
  {
    route: /^\d+\/message_templates$/, what: 'the Page\'s utility templates', page: 'path', pageShapedOnly: true,
    keys: set(...LIST_KEYS, 'name', 'name_or_content', 'language', 'status'),
    fields: set('id', 'name', 'category', 'language', 'status', 'components', 'parameter_format', 'library_template_name', 'rejected_reason', 'rejection_reasons', 'specific_rejection_reasons', 'creation_time', 'last_updated_time'),
  },
  {
    route: /^\d+\/messenger_lead_forms$/, what: 'the Page\'s Messenger lead templates', page: 'path', keys: set(...LIST_KEYS),
    fields: set('id', 'privacy_url', 'reminder_text', 'stop_question_message', 'first_step_id', 'fblead_form{id}'),
  },
  { route: /^\d+\/ctx_optimization_eligibility$/, what: 'the Page\'s click-to-message eligibility', page: 'path', keys: set('fields'), fields: set('ctm') },
  // Live-probe fixes (2026-10-26) — the chosen Page's posts, catalog-ad posts, insights and Instant Experiences.
  {
    route: /^\d+\/feed$/, what: 'the Page\'s own posts', page: 'path', otherPagesOrdinary: true,
    keys: set(...LIST_KEYS, 'include_hidden', 'show_expired'), values: { include_hidden: BOOL, show_expired: BOOL }, fields: POST_LIST_FIELDS,
  },
  {
    route: /^\d+\/published_posts$/, what: 'the Page\'s published posts', page: 'path',
    keys: set(...LIST_KEYS, 'include_hidden', 'show_expired'), values: { include_hidden: BOOL, show_expired: BOOL }, fields: POST_LIST_FIELDS,
  },
  {
    route: /^\d+\/ads_posts$/, what: 'the Page\'s ad posts', page: 'path',
    keys: set(...LIST_KEYS, 'include_inline_create', 'exclude_dynamic_ads', 'since', 'until'),
    values: { include_inline_create: BOOL, exclude_dynamic_ads: BOOL, since: DAY, until: DAY }, fields: POST_LIST_FIELDS,
  },
  { route: /^\d+_\d+\/dynamic_posts$/, what: 'a post\'s catalog-ad posts', page: 'post', keys: set(...LIST_KEYS), fields: DYNAMIC_POST_FIELDS },
  {
    route: /^\d+\/insights$/, what: 'the Page\'s insights', page: 'path', metrics: new Set(PAGE_METRICS),
    keys: set('metric', 'period', 'since', 'until', 'breakdown'), values: INSIGHT_VALUES, fields: set(),
  },
  {
    route: /^\d+_\d+\/insights$/, what: 'a post\'s insights', page: 'post', metrics: new Set(POST_METRICS),
    keys: set('metric', 'period', 'since', 'until', 'breakdown'), values: INSIGHT_VALUES, fields: set(),
  },
  {
    route: /^\d+\/canvases$/, what: 'the Page\'s Instant Experiences', page: 'path',
    keys: set(...LIST_KEYS, 'is_hidden', 'is_published'), values: { is_hidden: BOOL, is_published: BOOL }, fields: CANVAS_LIST_FIELDS,
  },
]

/** Probe fix IN-092 — the metric names of an insights read (Meta's comma list), or [] when it names none. */
const metricsOf = (search: URLSearchParams): string[] => (search.get('metric') ?? '').split(',').filter(Boolean)
/** Is this read the rule's own by its metrics (every one a metric of the rule's list)? A rule without metrics: always. */
const metricShaped = (rule: PageReadRule, search: URLSearchParams): boolean => {
  if (!rule.metrics) return true
  const metrics = metricsOf(search)
  return metrics.length > 0 && metrics.every((m) => rule.metrics!.has(m))
}

/** Meta's paging cursor as Meta writes it (base64url-like: letters, digits, _, - and =) — step 30 part 3's own rule. */
const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/

/** A `fields` value's top-level items: a `{…}` or `(…)` list stays with the item it belongs to. Null: unbalanced. */
export function topLevelFieldItems(value: string): string[] | null {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '{' || c === '(') depth++
    else if (c === '}' || c === ')') { if (--depth < 0) return null }
    else if (c === ',' && depth === 0) { items.push(value.slice(start, i)); start = i + 1 }
  }
  if (depth !== 0) return null
  items.push(value.slice(start))
  return items
}

/**
 * The verdict on a read of one of these routes: null when the route is none of them (a conversation route only for an id
 * of META_THREAD_ID; message_templates only when Page-shaped — else an ordinary read); `{ problem }` when it breaks the
 * route's own list; else the Page whose token it goes with (null: the chosen Page's, for a conversation).
 */
export function metaPageReadOf(route: string, segments: readonly string[], search: URLSearchParams, auth: unknown): MetaPageRead | { problem: string } | null {
  const rule = META_PAGE_READ_RULES.find((r) => r.route.test(route) && (r.page !== 'thread' || META_THREAD_ID.test(segments[0] ?? '')) && metricShaped(r, search))
  if (!rule) return null
  const keys = [...search.keys()]
  const fields = search.get('fields')
  const items = fields === null ? null : topLevelFieldItems(fields)
  // A WhatsApp account's templates (any read that is not the Page's Messenger template read): an ordinary read.
  if (rule.pageShapedOnly && (!keys.every((k) => rule.keys.has(k)) || !items || !items.every((f) => rule.fields.has(f)))) return null
  const pageId = rule.page === 'thread' ? null : rule.page === 'post' ? (segments[0] ?? '').split('_')[0] : segments[0]
  const problem = pageReadProblem(rule, keys, search, items, auth)
  // Probe fix MD-101 — the feed: the problem counts only for the CHOSEN Page's own read (gateway.ts); another Page's is an
  // ordinary read, as before.
  if (rule.otherPagesOrdinary) return { pageId, otherPages: { problem: problem ? `${rule.what} ${problem}` : null } }
  if (problem) return { problem: `${rule.what} ${problem}` }
  return { pageId }
}

/** Why a read on one of these routes breaks the route's own list (words after the route's `what`), or null. */
function pageReadProblem(rule: PageReadRule, keys: string[], search: URLSearchParams, items: string[] | null, auth: unknown): string | null {
  if (auth !== undefined && auth !== 'account') return 'are read with the chosen Page\'s own token, which the gateway reads itself: a caller asks for no token'
  const extra = keys.find((k) => !rule.keys.has(k))
  if (extra) return `are read with ${[...rule.keys].join(', ')} only (not "${extra}")`
  if (rule.metrics) {
    // An organic insights read names no fields, and each of its metrics once (metricShaped: all of them the rule's own).
    if (items !== null) return 'are read with metric, never fields'
    const metrics = metricsOf(search)
    if (new Set(metrics).size !== metrics.length) return 'are read with each metric once'
  } else if (!items || !items.length || !items.every((f) => rule.fields.has(f)) || new Set(items).size !== items.length) {
    return `are read with fields from ${[...rule.fields].join(', ')} only, each once`
  }
  for (const [key, value] of Object.entries(rule.values ?? {})) {
    const given = search.get(key)
    if (given !== null && !value.test(given)) return `are read with ${key} only as Nexus sends it (not "${given.slice(0, 40)}")`
  }
  const limit = search.get('limit')
  if (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) return 'are read with a limit of digits only, 1 to 100'
  const after = search.get('after')
  if (after !== null && !CURSOR.test(after)) return 'are read with after as Meta\'s own cursor only (letters, digits, _, - and =, at most 512)'
  return null
}

/** The fields' names (letters, digits, _), for metaWhatsAppRead. */
const fieldNames = (value: string | null) => new Set((value ?? '').split(/[^A-Za-z0-9_]+/).filter(Boolean))
/** A WhatsApp Business account's node read: its analytics fields, or a template group's account and templates. */
const WHATSAPP_NODE_FIELDS = ['conversation_analytics', 'pricing_analytics', 'call_analytics', 'whatsapp_business_account', 'whatsapp_business_templates']

/**
 * Review fix A1 — a read of the business's WhatsApp Business account (meta-conversations' and meta-message-templates'
 * WhatsApp views): Meta counts these per WhatsApp account ("200 requests per hour, per app, per WABA" — the rate-limiting
 * page lists GET /<WABA>, /phone_numbers, /message_templates), so they take the `whatsapp` bucket: the portfolio's list of
 * its WhatsApp accounts, an account's numbers, templates (any read of message_templates that is not the Page's own) and
 * template groups, a group itself, and the account's analytics.
 */
export function metaWhatsAppRead(route: string, search: URLSearchParams, pageRead: boolean): boolean {
  if (pageRead) return false
  if (/^\d+\/(owned_whatsapp_business_accounts|phone_numbers|message_templates|template_groups)$/.test(route)) return true
  if (!/^\d+$/.test(route)) return false
  const names = fieldNames(search.get('fields'))
  return WHATSAPP_NODE_FIELDS.some((f) => names.has(f))
}
