/**
 * Meta step 38 (2026-10-26) — the write allow-list entries of create-meta-message, set-meta-conversation-labels,
 * set-meta-message-templates and set-meta-messaging-setup: messages and handovers of the business's CHOSEN Facebook Page
 * (Messenger) and its CHOSEN Instagram account (Instagram Direct, through that Page), the Page's inbox labels, utility
 * templates and messaging setup, and the WhatsApp templates and template groups of a WhatsApp Business account the chosen ad
 * account's own business portfolio owns. EXACT keys per kind of object, every value judged, JSON in ONE spelling (the string
 * judged is the string sent) with every key at every depth on a list, text only where a person types it, links https only.
 *
 * Every Page rule is `auth: 'page'`: it goes with the chosen Page's own token, which the gateway reads for that one call
 * (meta-page-token.ts), and only for an object the gateway confirmed is the Page's (meta-messaging-owner.ts: the Page itself,
 * a label, persona or utility template of it) with every id inside the body (the person, a comment or visitor post, a
 * persona, a lead form, an app on the Page, a message of the same conversation, a creator Meta's marketplace lists, a flow).
 * The WhatsApp rules go with the business's system-user token (whatsapp_business_management), only for a WhatsApp account of
 * the chosen ad account's portfolio that no other Nexus business shares (meta-messaging-owner.ts).
 *
 * Checked 2026-10-26 (curl ≥ 3 s apart, developers.facebook.com; Meta's Python Business SDK main, facebook_business/adobjects):
 *   - docs/graph-api/reference/page/messages (v26.0): POST /{page_id}/messages with message {text, attachment {type, payload},
 *     quick_replies [{content_type, title, payload, image_url}], template {name, language {code}, components}}, messaging_type
 *     {RESPONSE, UPDATE, MESSAGE_TAG, UTILITY}, notification_type {REGULAR, SILENT_PUSH, NO_PUSH}, payload (a sender action's),
 *     persona_id, recipient {id, comment_id, post_id, …} (required), reply_to {mid}, sender_action {MARK_SEEN, TYPING_ON,
 *     TYPING_OFF, REACT, UNREACT}, tag (ACCOUNT_UPDATE, CONFIRMED_EVENT_UPDATE, CUSTOMER_FEEDBACK, HUMAN_AGENT,
 *     POST_PURCHASE_UPDATE; "Only HUMAN_AGENT is available for Instagram Messaging"), thread_control; returns
 *     {recipient_id, message_id}; errors 551, 100, 2022, 613, 10903, 368, 190, 10900 (activity already replied to), 200,
 *     10904 (messages disabled). SDK page.py create_message (+ folder: PARTNERSHIP).
 *   - documentation/business-messaging/messenger-platform/send-messages.md: the standard window (24 h; up to 7 days after a
 *     first message from a Click-to-Messenger / Direct ad), RESPONSE / UPDATE inside it, a MESSAGE_TAG outside it, never
 *     promotional; "Effective April 27th, 2026, all API requests containing the Message Tags CONFIRMED_EVENT_UPDATE,
 *     ACCOUNT_UPDATE, and POST_PURCHASE_UPDATE will receive error code 100"; reply_to {mid}; automated chats tell German and
 *     Californian users they are automated. policy.md: utility messages are a documented way outside the window.
 *   - …/send-messages/utility-messages.md: a utility message is messaging_type UTILITY with message.template {name, language
 *     {code}, components [{type: header | body, parameters [{type: text, text, parameter_name (NAMED templates)}]}, {type:
 *     buttons, parameters [{type: POSTBACK, payload} | {type: URL, url}]}]}; page_utility_messaging; never marketing.
 *   - …/discovery/private-replies.md and …/instagram-messaging/features/private-replies.md: POST /{page_id}/messages with
 *     recipient {post_id | comment_id} — ONE message within 7 days of the post or comment (Instagram Live: only during the
 *     broadcast); Standard access reaches only people with a role on the app; Instagram needs instagram_manage_comments,
 *     pages_messaging, the Human Agent feature and Advanced access.
 *   - …/send-messages/sender-actions.md, …/instagram-messaging/features/sender-actions.md and send-message.md: recipient and
 *     sender_action only (typing_on, typing_off, mark_seen; react / unreact with payload {message_id, reaction}; Instagram's
 *     reaction "love"); Instagram text ≤ 1,000 bytes UTF-8, quick replies ≤ 13 of ≤ 20 characters, plain text only.
 *   - …/send-messages/templates/instant-form-template.md: message.attachment {type: template, payload {template_type:
 *     instant_form, form_id}}; "in development"; error 2018382 (form id wrong or not in-thread eligible).
 *   - documentation/instagram-platform/instagram-api-with-facebook-login/creator-marketplace-messaging.md: POST
 *     /{page_id}/messages recipient {id: <messaging_id>}, message, folder "partnership" (required), with a Page token and
 *     instagram_creator_marketplace_messaging (App Review); the messaging_id comes from creator_marketplace_creators
 *     (fields=messaging_id); ≤ 2 messages per 30 days per creator and 250 creators a day before a reply (9/2207094, 9/2207095).
 *   - …/conversation-routing.md and …/instagram-messaging/features/conversation-routing/apis.md: POST /{page}/pass_thread_control
 *     (recipient, target_app_id — 263902037430900 the Page Inbox, 1217981644879628 the Instagram Inbox — metadata),
 *     /release_thread_control (recipient, metadata), /take_thread_control (recipient, metadata; needs the takeover setting) →
 *     {success}; Graph reference page/pass_thread_control and page/take_thread_control; SDK page.py.
 *   - …/identity/custom-labels.md: POST /{page}/custom_labels page_label_name → {id}; POST and DELETE /{label}/label user=<PSID>
 *     → {success}; DELETE /{label} → {success}; the Page Contact Terms.
 *   - docs/graph-api/reference/page/message_templates and messenger-business-template: POST /{page}/message_templates (name,
 *     language, category UTILITY, components [HEADER | BODY | BUTTONS: QUICK_REPLY, URL, PHONE_NUMBER, …, POSTBACK; format TEXT |
 *     IMAGE; example {header_text, body_text, header_handle, *_named_params}], library_template_name,
 *     library_template_button_inputs) → {id, status, category, rejection_reason, specific_rejection_reason}; POST
 *     /{template_id} (components) → {success, status, rejection_reason, …}; DELETE /{page}/message_templates name (required:
 *     all languages without template_id) + template_id. SDK page.py create_message_template (+ parameter_format NAMED |
 *     POSITIONAL), messengerbusinesstemplate.py api_update.
 *   - documentation/business-messaging/whatsapp/templates/template-management.md and template-groups.md: names `^[a-z0-9_]+$`
 *     ≤ 512; delete by hsm_id + name (by name alone: every language); an approved template's name cannot be used again for
 *     30 days; groups POST /{waba}/template_groups (name ≤ 256, description ≤ 512, whatsapp_business_templates) → {id}, POST
 *     /{group} (name, description, add_templates, remove_templates) → {success}, DELETE /{group}; a template is in one group
 *     at a time. SDK whatsappbusinessaccount.py (category AUTHENTICATION | MARKETING | UTILITY, parameter_format).
 *   - …/reference/messenger-profile-api.md (+ ice-breakers.md, commands.md, persistent-menu.md, welcome-screen.md,
 *     domain-whitelisting.md; Instagram ice-breakers.md, persistent-menu.md: platform instagram, no composer_input_disabled):
 *     POST /{page}/messenger_profile ("Only properties set in the request body will be overwritten") → {result: success};
 *     DELETE with fields [names] ("Only properties specified in the fields array will be deleted"); 10 calls per 10 minutes
 *     per Page. Ice breakers ≤ 4; menu items ≤ 20, titles ≤ 30, payload ≤ 1,000; commands 1–100, name ≤ 32 (no "/"),
 *     description ≤ 64; a "default" locale required.
 *   - …/send-messages/persistent-menu.md "User-level menu": POST /{page}/custom_user_settings psid + persistent_menu; DELETE
 *     psid + params ["persistent_menu"]; 10 calls per person per 10 minutes.
 *   - …/send-messages/personas.md: POST /{page}/personas name (≤ 50) + profile_picture_url → {id}; DELETE /{persona} (soft).
 *   - …/built-in-nlp.md and Graph page/nlp_configs: nlp_enabled, model (SDK enum), n_best, custom_token (a Wit.ai token:
 *     never sent), other_language_support; Meta has no read of it ("Reading: can't").
 *   - …/calling/callsettings.md and SDK page.py create_messenger_call_setting: audio_enabled, video_enabled, icon_enabled,
 *     call_hours {timezone_id, weekly_operating_hours [{day_of_week, open_time, close_time}]} (days not set are closed), call_routing
 *     {ring_target: META | PARTNERS}.
 *   - …/ads/ads-welcome-message-flows.md: POST /{page}/welcome_message_flows name, welcome_message_flow (JSON), eligible_platforms
 *     ["messenger", "instagram"] → {flow_id}; update with flow_id; DELETE with flow_id; a flow used in an ad can be neither.
 *   - docs/graph-api/reference/page/page_whatsapp_number_verification: POST whatsapp_number (required), verification_code →
 *     {verification_status, whatsapp_number_type, whatsapp_display_number, biz_link_attempted, error_message}; no read, no
 *     delete.
 * DELETE parameters ride in the form body, as every other Nexus DELETE (Meta's guides show them in the query: LIVE-PROBES
 * MS38-12).
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_COMMENT_TEXT, META_NAME_TEXT } from './meta-write-text.js'
import { metaLeadUrlProblem } from './meta-lead-form-rules.js'

type Params = ReadonlyMap<string, string>
type Row = Record<string, unknown>

/**
 * Step 38 — what only the messaging tools name: the chosen Page as it sends in Messenger (`messengerpage`) or Instagram
 * Direct (`instagrampage`), the chosen Page's own messaging setup (`messagingpage`), an inbox label, a persona and a utility
 * template of it — all made AS the Page — and a WhatsApp Business account and one of its template groups (system-user token).
 */
export type MetaMessagingKind = 'messengerpage' | 'instagrampage' | 'messagingpage' | 'pagelabel' | 'persona' | 'messengertemplate' | 'waba' | 'templategroup'
/** The edges the messaging changes post to (gateway meta.ts MetaWriteEdge). */
export type MetaMessagingEdge = 'messages' | 'pass_thread_control' | 'release_thread_control' | 'take_thread_control' | 'custom_labels' | 'label'
  | 'message_templates' | 'template_groups' | 'messenger_profile' | 'custom_user_settings' | 'personas' | 'nlp_configs' | 'messenger_call_settings'
  | 'welcome_message_flows' | 'page_whatsapp_number_verification'
/** The kinds made AS the chosen Page (meta-page-owner.ts routes them to meta-messaging-owner.ts). */
export const META_MESSAGING_PAGE_KINDS: ReadonlySet<string> = new Set(['messengerpage', 'instagrampage', 'messagingpage', 'pagelabel', 'persona', 'messengertemplate'])
/** The WhatsApp kinds (system-user token; gateway.ts routes them to meta-messaging-owner.ts). */
export const META_WHATSAPP_KINDS: ReadonlySet<string> = new Set(['waba', 'templategroup'])
/**
 * Step 38 — the ids inside a messaging body (meta-messaging-owner.ts checks each): the person a message, label or menu is
 * for, the comment or visitor post of a private reply, a persona, a lead form of an instant-form message, an app on the
 * Page a conversation passes to, a message of the same conversation, a creator Meta's marketplace lists, a utility template
 * of the Page, a WhatsApp template of the account, a welcome flow of the Page.
 */
export type MetaMessagingBodyKind = 'messageperson' | 'messagecomment' | 'visitorpost' | 'messagepersona' | 'messageleadform' | 'pageapp'
  | 'threadmessage' | 'creator' | 'pagetemplate' | 'wabatemplate' | 'welcomeflow'
export const isMetaMessagingBodyKind = (kind: string): kind is MetaMessagingBodyKind => (MESSAGING_BODY_KINDS as readonly string[]).includes(kind)
const MESSAGING_BODY_KINDS = ['messageperson', 'messagecomment', 'visitorpost', 'messagepersona', 'messageleadform', 'pageapp', 'threadmessage', 'creator', 'pagetemplate', 'wabatemplate', 'welcomeflow'] as const

/** Meta's two inbox apps a conversation may be passed to (conversation-routing.md). */
export const META_PAGE_INBOX_APP = '263902037430900'
export const META_INSTAGRAM_INBOX_APP = '1217981644879628'

/** Meta's limits where documented, Nexus's caps where not (each said in the tool). */
export const META_MESSAGE_LIMITS = {
  /** Messenger text: 2,000 characters (Send API reference, the message's text). */
  messengerText: 2000,
  /** Instagram Direct text: "UTF-8 and 1,000 bytes or less" (instagram-messaging send-message.md). */
  instagramTextBytes: 1000,
  quickReplies: 13, quickReplyTitle: 20, payload: 1000, url: 2000, metadata: 1000,
  labelName: 100, personaName: 50,
  templateName: 512, headerText: 60, bodyText: 1024, footerText: 60, buttonText: 25, messengerButtons: 3, whatsappButtons: 10, examples: 20, templateParameters: 20,
  greeting: 160, iceBreakers: 4, iceQuestion: 80, menus: 20, menuItems: 20, menuTitle: 30, commandSets: 20, commands: 100, commandName: 32, commandDescription: 64, domains: 50,
  flowName: 200, flowMessages: 5, groupName: 256, groupDescription: 512, groupTemplates: 100,
} as const
/** The longest body of a message rule (a 2,000-character text of emoji, form-encoded, with its quick replies). */
export const META_MESSAGE_MAX_BODY = 60_000
/** The longest body of a setup or template rule (a full persistent menu in 20 locales; a template with its examples). */
export const META_MESSAGING_SETUP_MAX_BODY = 200_000

/** Message tags Meta answers with error 100 since 2026-04-27 (send-messages.md): refused in words, never sent. */
export const META_DEAD_TAGS: ReadonlySet<string> = new Set(['ACCOUNT_UPDATE', 'POST_PURCHASE_UPDATE', 'CONFIRMED_EVENT_UPDATE'])
export const META_SENDER_ACTIONS = ['mark_seen', 'typing_on', 'typing_off', 'react', 'unreact'] as const
export const META_MEDIA_TYPES = ['image', 'video', 'audio', 'file'] as const
export const META_INSTAGRAM_MEDIA_TYPES = ['image', 'video', 'audio'] as const
export const META_NOTIFICATION_TYPES = ['REGULAR', 'SILENT_PUSH', 'NO_PUSH'] as const
/** Meta's Built-In NLP models (Graph page/nlp_configs; SDK page.py Model), CUSTOM left out (it needs a Wit.ai token). */
export const META_NLP_MODELS = ['ARABIC', 'CHINESE', 'CROATIAN', 'DANISH', 'DUTCH', 'ENGLISH', 'FRENCH_STANDARD', 'GEORGIAN', 'GERMAN_STANDARD', 'GREEK', 'HEBREW', 'HUNGARIAN', 'IRISH', 'ITALIAN_STANDARD', 'KOREAN', 'NORWEGIAN_BOKMAL', 'POLISH', 'PORTUGUESE', 'ROMANIAN', 'SPANISH', 'SWEDISH', 'VIETNAMESE'] as const
export const META_WEEK_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const
/** The Messenger profile properties Nexus writes (and deletes), lower case as the profile guide names them. */
export const META_PROFILE_FIELDS = ['get_started', 'greeting', 'ice_breakers', 'persistent_menu', 'whitelisted_domains', 'account_linking_url', 'commands'] as const
/** Instagram's profile properties (Instagram ice-breakers.md and persistent-menu.md). */
export const META_INSTAGRAM_PROFILE_FIELDS = ['ice_breakers', 'persistent_menu'] as const
/** WhatsApp categories Nexus sends: AUTHENTICATION is for one-time codes, which Nexus never sends. */
export const META_WHATSAPP_CATEGORIES = ['MARKETING', 'UTILITY'] as const

/** A template name: lower-case letters, digits and _ (template-management.md "Template name validation"). */
export const META_TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/
/** A template language: Meta's locale codes (en, en_US, it_IT, pt_BR, …). */
export const META_TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/
/** A Messenger profile locale: "default" or a locale code (supported-locales.md). */
const LOCALE = /^(default|[a-z]{2}_[A-Z]{2})$/
/** Meta's message id forms: Messenger `m_…` / `mid.$…`, Instagram `aWdf…` (base64 letters and digits). */
export const META_MESSAGE_ID = /^(m_[A-Za-z0-9_-]{8,256}|mid\.\$?[A-Za-z0-9_.:-]{6,256}|aWdf[A-Za-z0-9_-]{8,300})$/
/** A WhatsApp number as Meta takes it: E.164 digits with an optional + (no spaces). */
export const META_WHATSAPP_NUMBER = /^\+?[1-9]\d{6,14}$/
/** The code WhatsApp sends to that number (digits only). */
export const META_VERIFICATION_CODE = /^\d{4,10}$/
const IDS = /^\d{1,25}$/

// ── judges (a value Nexus sends, or why not) ───────────────────────────────────────────────────────────────────────

type Judge = (value: unknown, where: string) => string | null
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)

/** Text a person types on one line: META_NAME_TEXT (no control or format character), not only spaces, at most `max`. */
const line = (max: number): Judge => (v, where) => (typeof v !== 'string' || !v.trim() ? `${where} is text`
  : [...v].length > max ? `${where} is at most ${max} characters` : !META_NAME_TEXT.test(v) ? `${where} is printable text (no control or format characters)` : null)
/** Text of several lines (a message, a template's body): META_COMMENT_TEXT (a line break allowed). */
const lines = (max: number): Judge => (v, where) => (typeof v !== 'string' || !v.trim() ? `${where} is text`
  : [...v].length > max ? `${where} is at most ${max} characters` : !META_COMMENT_TEXT.test(v) ? `${where} is printable text (line breaks allowed; no control or format characters)` : null)
const oneOf = (values: readonly string[]): Judge => (v, where) => (typeof v === 'string' && values.includes(v) ? null : `${where} is one of ${values.join(', ')}`)
const boolean: Judge = (v, where) => (typeof v === 'boolean' ? null : `${where} is true or false`)
const digits: Judge = (v, where) => (typeof v === 'string' && IDS.test(v) ? null : `${where} is a Meta id (digits, as text)`)
const url: Judge = (v, where) => metaLeadUrlProblem(v, where)

/** The object has only these keys, and the required ones; each judged. */
function shape(o: unknown, where: string, judges: Readonly<Record<string, Judge>>, required: readonly string[] = []): string | null {
  if (!isObj(o)) return `${where} is an object`
  for (const k of Object.keys(o)) if (!Object.prototype.hasOwnProperty.call(judges, k)) return `${where} has no key "${k.slice(0, 40)}" Nexus sends`
  for (const k of required) if (!(k in o)) return `${where} names ${k}`
  for (const [k, v] of Object.entries(o)) {
    const problem = judges[k](v, `${where}.${k}`)
    if (problem) return problem
  }
  return null
}
/** A list of min..max items, each judged. */
const list = (min: number, max: number, item: Judge): Judge => (v, where) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) return `${where} is a list of ${min} to ${max}`
  for (const [i, x] of v.entries()) {
    const problem = item(x, `${where}[${i}]`)
    if (problem) return problem
  }
  return null
}
/** A form value as JSON in exactly Nexus's spelling (the string judged is the string sent), or why not. */
export function messagingJson(value: string | undefined, where: string): { value: unknown } | { problem: string } {
  let parsed: unknown
  try { parsed = JSON.parse(value ?? '') } catch { return { problem: `${where} is JSON` } }
  if (JSON.stringify(parsed) !== value) return { problem: `${where} is JSON in one spelling only (no spaces, no escapes Nexus does not write)` }
  return { value: parsed }
}
/** A form value that is JSON judged by `judge`. */
function jsonValue(params: Params, key: string, judge: Judge): string | null {
  const parsed = messagingJson(params.get(key), key)
  if ('problem' in parsed) return parsed.problem
  return judge(parsed.value, key)
}
/** Instagram's text cap is in BYTES (UTF-8). */
const bytes = (v: string) => Buffer.byteLength(v, 'utf8')

// ── messages ───────────────────────────────────────────────────────────────────────────────────────────────────────

const QUICK_REPLY: Judge = (v, where) => shape(v, where, { content_type: oneOf(['text']), title: line(META_MESSAGE_LIMITS.quickReplyTitle), payload: line(META_MESSAGE_LIMITS.payload) }, ['content_type', 'title', 'payload'])
const QUICK_REPLIES = list(1, META_MESSAGE_LIMITS.quickReplies, QUICK_REPLY)
const MEDIA = (types: readonly string[]): Judge => (v, where) => shape(v, where, { type: oneOf(types), payload: (p, w) => shape(p, w, { url }, ['url']) }, ['type', 'payload'])
const INSTANT_FORM: Judge = (v, where) => shape(v, where, {
  type: oneOf(['template']),
  payload: (p, w) => shape(p, w, { template_type: oneOf(['instant_form']), form_id: digits }, ['template_type', 'form_id']),
}, ['type', 'payload'])

/** A utility template's parameters as the utility guide sends them (header / body text, a postback or URL button). */
const TEMPLATE_PARAMETER: Judge = (v, where) => shape(v, where, { type: oneOf(['text']), text: line(META_MESSAGE_LIMITS.bodyText), parameter_name: (x, w) => (typeof x === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x) ? null : `${w} is a parameter name (lower case, digits and _)`) }, ['type', 'text'])
const BUTTON_PARAMETER: Judge = (v, where) => {
  if (isObj(v) && v.type === 'URL') return shape(v, where, { type: oneOf(['URL']), url: line(META_MESSAGE_LIMITS.url) }, ['type', 'url'])
  return shape(v, where, { type: oneOf(['POSTBACK']), payload: line(META_MESSAGE_LIMITS.payload) }, ['type', 'payload'])
}
const SEND_COMPONENT: Judge = (v, where) => {
  if (isObj(v) && v.type === 'buttons') return shape(v, where, { type: oneOf(['buttons']), parameters: list(1, META_MESSAGE_LIMITS.messengerButtons, BUTTON_PARAMETER) }, ['type', 'parameters'])
  return shape(v, where, { type: oneOf(['header', 'body', 'buttons']), parameters: list(1, META_MESSAGE_LIMITS.templateParameters, TEMPLATE_PARAMETER) }, ['type', 'parameters'])
}
const SEND_TEMPLATE: Judge = (v, where) => shape(v, where, {
  name: (x, w) => (typeof x === 'string' && META_TEMPLATE_NAME.test(x) ? null : `${w} is a template name (lower case, digits and _)`),
  language: (x, w) => shape(x, w, { code: (c, cw) => (typeof c === 'string' && META_TEMPLATE_LANGUAGE.test(c) ? null : `${cw} is a language code`) }, ['code']),
  components: list(1, 3, SEND_COMPONENT),
}, ['name', 'language'])

/** The message object of a Messenger or Instagram send: text, a media link, an instant form, or a utility template. */
function messageProblem(value: unknown, platform: 'messenger' | 'instagram', variant: 'chat' | 'template' | 'private' | 'creator'): string | null {
  if (!isObj(value)) return 'message is an object'
  const text: Judge = (v, w) => {
    const problem = lines(META_MESSAGE_LIMITS.messengerText)(v, w)
    if (problem) return problem
    return platform === 'instagram' && bytes(v as string) > META_MESSAGE_LIMITS.instagramTextBytes ? `${w} is at most ${META_MESSAGE_LIMITS.instagramTextBytes} bytes on Instagram (Meta's limit)` : null
  }
  if (variant === 'template') return shape(value, 'message', { template: SEND_TEMPLATE }, ['template'])
  if (variant === 'private') return shape(value, 'message', { text }, ['text'])
  const media = MEDIA(platform === 'instagram' && variant !== 'creator' ? META_INSTAGRAM_MEDIA_TYPES : META_MEDIA_TYPES)
  if ('text' in value) return shape(value, 'message', { text, ...(variant === 'chat' ? { quick_replies: QUICK_REPLIES } : {}) }, ['text'])
  const attachment = value.attachment
  if (variant === 'chat' && platform === 'messenger' && isObj(attachment) && attachment.type === 'template') return shape(value, 'message', { attachment: INSTANT_FORM }, ['attachment'])
  return shape(value, 'message', { attachment: media, ...(variant === 'chat' ? { quick_replies: QUICK_REPLIES } : {}) }, ['attachment'])
}

const RECIPIENT: Judge = (v, where) => {
  if (!isObj(v) || Object.keys(v).length !== 1) return `${where} names exactly one of id (a person), comment_id or post_id`
  if ('id' in v) return digits(v.id, `${where}.id`)
  if ('comment_id' in v) return typeof v.comment_id === 'string' && /^\d{1,25}(_\d{1,25})?$/.test(v.comment_id) ? null : `${where}.comment_id is a comment id`
  if ('post_id' in v) return typeof v.post_id === 'string' && /^\d{1,25}_\d{1,25}$/.test(v.post_id) ? null : `${where}.post_id is a Page post id (<Page id>_<post id>)`
  return `${where} names exactly one of id (a person), comment_id or post_id`
}

/** The JSON of a form key, parsed (only after its judge passed). */
const parsedOf = (params: Params, key: string): unknown => { try { return JSON.parse(params.get(key) ?? 'null') } catch { return null } }
const recipientOf = (params: Params): Row => (isObj(parsedOf(params, 'recipient')) ? parsedOf(params, 'recipient') as Row : {})

/**
 * The whole send, judged together: a sender action (recipient + sender_action [+ payload]); a creator message (recipient id,
 * message, folder partnership); a private reply (recipient comment_id / post_id, RESPONSE, text); a utility message (Messenger:
 * recipient id, UTILITY, a template); a message in a conversation (recipient id, RESPONSE / UPDATE, or MESSAGE_TAG with the
 * HUMAN_AGENT tag — the dead tags refused in words).
 */
function sendProblem(params: Params, platform: 'messenger' | 'instagram'): string | null {
  const recipient = jsonValue(params, 'recipient', RECIPIENT)
  if (recipient) return recipient
  const to = recipientOf(params)
  const has = (k: string) => params.has(k)
  const only = (keys: readonly string[], what: string) => {
    const extra = [...params.keys()].find((k) => !keys.includes(k))
    return extra ? `${what} takes ${keys.join(', ')} only (not ${extra})` : null
  }
  if (has('sender_action')) {
    const problem = only(['recipient', 'sender_action', 'payload'], 'a sender action') ?? oneOf(META_SENDER_ACTIONS)(params.get('sender_action'), 'sender_action')
    if (problem) return problem
    if (!('id' in to)) return 'a sender action goes to a person (recipient id)'
    const action = params.get('sender_action')!
    if (action === 'react' || action === 'unreact') {
      if (!has('payload')) return `${action} names the message (payload {message_id${action === 'react' ? ', reaction' : ''}})`
      return jsonValue(params, 'payload', (v, w) => shape(v, w, {
        message_id: (x, xw) => (typeof x === 'string' && META_MESSAGE_ID.test(x) ? null : `${xw} is a Meta message id`),
        ...(action === 'react' ? { reaction: platform === 'instagram' ? oneOf(['love']) : (x: unknown, xw: string) => (typeof x === 'string' && /^\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}‍\p{Extended_Pictographic}]{0,15}$/u.test(x) ? null : `${xw} is one emoji`) } : {}),
      }, action === 'react' ? ['message_id', 'reaction'] : ['message_id']))
    }
    return has('payload') ? `${action} takes no payload` : null
  }
  if (has('payload')) return 'payload is a sender action\'s (react, unreact) only'
  if (has('folder')) {
    if (platform !== 'instagram') return 'the Partnership folder is Instagram\'s (creator messages)'
    const problem = only(['recipient', 'message', 'folder'], 'a creator message') ?? oneOf(['partnership'])(params.get('folder'), 'folder')
    if (problem) return problem
    if (!('id' in to)) return 'a creator message goes to the creator\'s messaging id (recipient id)'
    return jsonValue(params, 'message', (v) => messageProblem(v, platform, 'creator'))
  }
  const type = params.get('messaging_type')
  const typeProblem = oneOf(platform === 'messenger' ? ['RESPONSE', 'UPDATE', 'MESSAGE_TAG', 'UTILITY'] : ['RESPONSE', 'UPDATE', 'MESSAGE_TAG'])(type, 'messaging_type')
  if (typeProblem) return typeProblem
  if (!has('message')) return 'a message names its content (message)'
  if (has('tag') !== (type === 'MESSAGE_TAG')) return 'a tag goes with messaging_type MESSAGE_TAG, and MESSAGE_TAG with a tag'
  if (has('tag')) {
    const tag = params.get('tag') ?? ''
    if (META_DEAD_TAGS.has(tag)) return `Meta answers the ${tag} tag with error 100 since 2026-04-27: it is never sent (outside the window: HUMAN_AGENT, or a Messenger utility template)`
    if (tag !== 'HUMAN_AGENT') return 'the only message tag Nexus sends is HUMAN_AGENT (a person\'s own reply within 7 days of the person\'s last message)'
  }
  if (has('notification_type') && platform === 'messenger') {
    const problem = oneOf(META_NOTIFICATION_TYPES)(params.get('notification_type'), 'notification_type')
    if (problem) return problem
  }
  if (has('persona_id') && !IDS.test(params.get('persona_id') ?? '')) return 'persona_id is a persona id (digits)'
  const privateReply = 'comment_id' in to || 'post_id' in to
  if (privateReply) {
    const problem = only(['recipient', 'messaging_type', 'message'], 'a private reply')
    if (problem) return problem
    if (type !== 'RESPONSE') return 'a private reply goes as messaging_type RESPONSE'
    if ('post_id' in to && platform !== 'messenger') return 'a private reply to a visitor post is Messenger\'s (a Facebook Page post)'
    return jsonValue(params, 'message', (v) => messageProblem(v, platform, 'private'))
  }
  if (type === 'UTILITY') {
    const problem = only(['recipient', 'messaging_type', 'message'], 'a utility message')
    if (problem) return problem
    return jsonValue(params, 'message', (v) => messageProblem(v, platform, 'template'))
  }
  if (has('reply_to')) {
    const problem = jsonValue(params, 'reply_to', (v, w) => shape(v, w, { mid: (x, xw) => (typeof x === 'string' && META_MESSAGE_ID.test(x) ? null : `${xw} is a Meta message id`) }, ['mid']))
    if (problem) return problem
  }
  const message = jsonValue(params, 'message', (v) => messageProblem(v, platform, 'chat'))
  if (message) return message
  const parsed = parsedOf(params, 'message') as Row
  if (isObj(parsed.attachment) && parsed.attachment.type === 'template' && type === 'MESSAGE_TAG') return 'an instant form goes inside the standard window (RESPONSE or UPDATE), never with a tag'
  return null
}

/** The ids inside a send (meta-messaging-owner.ts checks each before anything goes). */
function sendIds(params: Params): MetaWriteBodyId[] {
  const out: MetaWriteBodyId[] = []
  const to = recipientOf(params)
  const folder = params.get('folder')
  if (typeof to.id === 'string') out.push({ id: to.id, kind: folder ? 'creator' : 'messageperson' })
  if (typeof to.comment_id === 'string') out.push({ id: to.comment_id, kind: 'messagecomment' })
  if (typeof to.post_id === 'string') out.push({ id: to.post_id, kind: 'visitorpost' })
  const persona = params.get('persona_id')
  if (persona) out.push({ id: persona, kind: 'messagepersona' })
  const message = parsedOf(params, 'message')
  const form = isObj(message) && isObj(message.attachment) && isObj(message.attachment.payload) ? message.attachment.payload.form_id : null
  if (typeof form === 'string') out.push({ id: form, kind: 'messageleadform' })
  const replyTo = parsedOf(params, 'reply_to')
  if (isObj(replyTo) && typeof replyTo.mid === 'string') out.push({ id: replyTo.mid, kind: 'threadmessage' })
  const payload = parsedOf(params, 'payload')
  if (isObj(payload) && typeof payload.message_id === 'string') out.push({ id: payload.message_id, kind: 'threadmessage' })
  return out
}

/**
 * What the ledger keeps of a failed message: its kind, never the person's id or the words (people's data: the change record
 * and the call log keep neither).
 */
function sendLedger(params: Params): Record<string, string> {
  const out: Record<string, string> = { recipient: '(a person)' }
  for (const k of ['messaging_type', 'tag', 'folder', 'sender_action', 'notification_type']) if (params.has(k)) out[k] = params.get(k)!
  if (params.has('message')) out.message = `(a message of ${(params.get('message') ?? '').length} characters)`
  if (params.has('persona_id')) out.persona_id = params.get('persona_id')!
  return out
}

const sendRule = (platform: 'messenger' | 'instagram'): MetaWriteRule => ({
  // create-meta-message: a message, private reply, sender action, instant form, utility message or creator message (Instagram:
  // the Partnership folder), POST /{page}/messages, as the chosen Page.
  name: `${platform}.message`,
  method: 'POST',
  path: /^\d{1,25}\/messages$/,
  kinds: [platform === 'messenger' ? 'messengerpage' : 'instagrampage'],
  auth: 'page',
  required: ['recipient'],
  optional: platform === 'messenger'
    ? ['messaging_type', 'message', 'tag', 'notification_type', 'persona_id', 'reply_to', 'sender_action', 'payload']
    : ['messaging_type', 'message', 'tag', 'reply_to', 'sender_action', 'payload', 'folder'],
  text: { message: META_COMMENT_TEXT, payload: META_NAME_TEXT },
  maxBody: META_MESSAGE_MAX_BODY,
  values: (params) => sendProblem(params, platform),
  ids: sendIds,
  ledger: sendLedger,
  edgeCall: true,
  budget: false,
})

/** The person of a thread-control call (recipient {id}). */
const personRecipient = (params: Params): string | null => jsonValue(params, 'recipient', (v, w) => shape(v, w, { id: digits }, ['id']))
const personId = (params: Params): MetaWriteBodyId[] => {
  const to = recipientOf(params)
  return typeof to.id === 'string' ? [{ id: to.id, kind: 'messageperson' }] : []
}
const threadLedger = (params: Params): Record<string, string> => ({ recipient: '(a person)', ...(params.has('target_app_id') ? { target_app_id: params.get('target_app_id')! } : {}), ...(params.has('metadata') ? { metadata: '(metadata)' } : {}) })
const metadataProblem = (params: Params): string | null => (params.has('metadata') ? line(META_MESSAGE_LIMITS.metadata)(params.get('metadata'), 'metadata') : null)

const threadRule = (control: 'pass' | 'release' | 'take'): MetaWriteRule => ({
  // create-meta-message action handover: pass (to Meta's Page or Instagram inbox, or an app on the Page), release, take.
  name: `thread.${control}`,
  method: 'POST',
  path: new RegExp(`^\\d{1,25}\\/${control}_thread_control$`),
  kinds: ['messengerpage', 'instagrampage'],
  auth: 'page',
  required: ['recipient'],
  optional: control === 'pass' ? ['target_app_id', 'metadata'] : ['metadata'],
  text: { metadata: META_NAME_TEXT },
  values: (params) => personRecipient(params) ?? metadataProblem(params) ?? (params.has('target_app_id') && !IDS.test(params.get('target_app_id') ?? '') ? 'target_app_id is a Meta app id (digits)' : null),
  ids: (params) => [...personId(params), ...(params.has('target_app_id') ? [{ id: params.get('target_app_id')!, kind: 'pageapp' as const }] : [])],
  ledger: threadLedger,
  edgeCall: true,
  budget: false,
})

// ── templates ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The placeholders of a template text: positional {{1}}…, or named {{name}}. */
export function templatePlaceholders(text: string): { positional: number[]; named: string[]; other: string[] } {
  const found = [...text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1])
  return {
    positional: found.filter((p) => /^[1-9]\d{0,1}$/.test(p)).map(Number),
    named: found.filter((p) => /^[a-z][a-z0-9_]{0,63}$/.test(p)),
    other: found.filter((p) => !/^[1-9]\d{0,1}$/.test(p) && !/^[a-z][a-z0-9_]{0,63}$/.test(p)),
  }
}

/**
 * A HEADER or BODY text and its example: every placeholder has an example ("Templates will not be approved without
 * examples"), positional {{1}}…{{n}} in order (POSITIONAL), or named ones each with its param_name (NAMED).
 */
function placeholderProblem(text: string, example: unknown, where: string, part: 'header' | 'body', format: 'NAMED' | 'POSITIONAL'): string | null {
  const p = templatePlaceholders(text)
  if (p.other.length) return `${where}.text: {{${p.other[0]}}} is no placeholder Nexus sends (${format === 'NAMED' ? 'lower-case names' : '{{1}}, {{2}}, …'})`
  if (format === 'POSITIONAL' && p.named.length) return `${where}.text: a positional template takes {{1}}, {{2}}, … (named ones need parameter_format NAMED)`
  if (format === 'NAMED' && p.positional.length) return `${where}.text: a named template takes {{name}} placeholders, not {{1}}`
  const count = format === 'NAMED' ? new Set(p.named).size : p.positional.length
  if (!count) return example === undefined ? null : `${where}.example is only for a text with placeholders`
  if (part === 'header' && count > 1) return `${where}: a header has at most one placeholder`
  if (format === 'POSITIONAL') {
    if (p.positional.some((n, i) => n !== i + 1)) return `${where}.text: the placeholders are {{1}}, {{2}}, … in order`
    const key = part === 'header' ? 'header_text' : 'body_text'
    const shapeProblem = shape(example, `${where}.example`, { [key]: part === 'header' ? list(1, 1, line(200)) : list(1, 1, list(1, META_MESSAGE_LIMITS.examples, line(200))) }, [key])
    if (shapeProblem) return shapeProblem
    const values = part === 'header' ? (example as Row).header_text as unknown[] : ((example as Row).body_text as unknown[][])[0]
    return values.length === count ? null : `${where}.example gives one example per placeholder (${count})`
  }
  const key = part === 'header' ? 'header_text_named_params' : 'body_text_named_params'
  const shapeProblem = shape(example, `${where}.example`, { [key]: list(1, META_MESSAGE_LIMITS.examples, (v, w) => shape(v, w, { param_name: (x, xw) => (typeof x === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(x) ? null : `${xw} is a parameter name`), example: line(200) }, ['param_name', 'example'])) }, [key])
  if (shapeProblem) return shapeProblem
  const names = ((example as Row)[key] as Row[]).map((r) => r.param_name as string)
  return new Set(names).size === names.length && names.length === count && [...new Set(p.named)].every((n) => names.includes(n)) ? null : `${where}.example names each placeholder once`
}

const TEMPLATE_BUTTON = (channel: 'messenger' | 'whatsapp'): Judge => (v, where) => {
  const types = channel === 'messenger' ? ['URL', 'PHONE_NUMBER', 'POSTBACK'] : ['QUICK_REPLY', 'URL', 'PHONE_NUMBER']
  if (!isObj(v) || !types.includes(String(v.type))) return `${where}.type is one of ${types.join(', ')}`
  const text = line(META_MESSAGE_LIMITS.buttonText)
  if (v.type === 'URL') {
    if (typeof v.url === 'string' && /\{\{/.test(v.url)) return `${where}: Nexus sends a link button with a fixed https link only (a link with a placeholder needs an example Meta documents in two different shapes)`
    return shape(v, where, { type: oneOf(['URL']), text, url }, ['type', 'text', 'url'])
  }
  if (v.type === 'PHONE_NUMBER') return shape(v, where, { type: oneOf(['PHONE_NUMBER']), text, phone_number: (x, w) => (typeof x === 'string' && META_WHATSAPP_NUMBER.test(x) ? null : `${w} is a phone number (+ and digits)`) }, ['type', 'text', 'phone_number'])
  if (v.type === 'POSTBACK') return shape(v, where, { type: oneOf(['POSTBACK']), text, payload: line(META_MESSAGE_LIMITS.payload) }, ['type', 'text', 'payload'])
  return shape(v, where, { type: oneOf(['QUICK_REPLY']), text }, ['type', 'text'])
}

/**
 * A template's components: HEADER (text), BODY (required), FOOTER (WhatsApp), BUTTONS, each once, in that order; every
 * placeholder with its example. An image header needs a file handle from Meta's Resumable Upload API, which Nexus does not
 * make for templates: refused in words.
 */
export function templateComponentsProblem(value: unknown, channel: 'messenger' | 'whatsapp', format: 'NAMED' | 'POSITIONAL'): string | null {
  const order = channel === 'messenger' ? ['HEADER', 'BODY', 'BUTTONS'] : ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']
  if (!Array.isArray(value) || !value.length || value.length > order.length) return `components is a list of 1 to ${order.length}`
  let last = -1
  for (const [i, c] of value.entries()) {
    const where = `components[${i}]`
    if (!isObj(c) || !order.includes(String(c.type))) return `${where}.type is one of ${order.join(', ')}`
    const at = order.indexOf(String(c.type))
    if (at <= last) return `components are ${order.join(', ')}, each once and in that order`
    last = at
    if (c.type === 'HEADER') {
      if (c.format === 'IMAGE' || c.format === 'VIDEO' || c.format === 'DOCUMENT') return `${where}: a header with media needs a file handle from Meta's Resumable Upload API, which Nexus does not make for templates — use a text header`
      const problem = shape(c, where, { type: oneOf(['HEADER']), format: oneOf(['TEXT']), text: line(META_MESSAGE_LIMITS.headerText), example: () => null }, ['type', 'format', 'text'])
      if (problem) return problem
      const p = placeholderProblem(c.text as string, c.example, where, 'header', format)
      if (p) return p
    } else if (c.type === 'BODY') {
      const problem = shape(c, where, { type: oneOf(['BODY']), text: lines(META_MESSAGE_LIMITS.bodyText), example: () => null }, ['type', 'text'])
      if (problem) return problem
      const p = placeholderProblem(c.text as string, c.example, where, 'body', format)
      if (p) return p
    } else if (c.type === 'FOOTER') {
      const problem = shape(c, where, { type: oneOf(['FOOTER']), text: line(META_MESSAGE_LIMITS.footerText) }, ['type', 'text'])
      if (problem) return problem
      if (templatePlaceholders(c.text as string).positional.length || templatePlaceholders(c.text as string).named.length) return `${where}: a footer has no placeholders`
    } else {
      const problem = shape(c, where, { type: oneOf(['BUTTONS']), buttons: list(1, channel === 'messenger' ? META_MESSAGE_LIMITS.messengerButtons : META_MESSAGE_LIMITS.whatsappButtons, TEMPLATE_BUTTON(channel)) }, ['type', 'buttons'])
      if (problem) return problem
      const buttons = c.buttons as Row[]
      if (buttons.filter((b) => b.type === 'URL').length > 2) return `${where}: at most 2 link buttons`
      if (buttons.filter((b) => b.type === 'PHONE_NUMBER').length > 1) return `${where}: at most 1 phone button`
    }
  }
  return value.some((c) => isObj(c) && c.type === 'BODY') ? null : 'components name a BODY'
}

const formatOf = (params: Params): 'NAMED' | 'POSITIONAL' => (params.get('parameter_format') === 'NAMED' ? 'NAMED' : 'POSITIONAL')
const parameterFormatProblem = (params: Params): string | null => (params.has('parameter_format') ? oneOf(['NAMED', 'POSITIONAL'])(params.get('parameter_format'), 'parameter_format') : null)
const nameProblem = (params: Params): string | null => (META_TEMPLATE_NAME.test(params.get('name') ?? '') ? null : 'name is a template name: lower-case letters, digits and _ (at most 512)')
const languageProblem = (params: Params): string | null => (META_TEMPLATE_LANGUAGE.test(params.get('language') ?? '') ? null : 'language is a language code (it, it_IT, en_US, …)')
const componentsJson = (params: Params, channel: 'messenger' | 'whatsapp'): string | null => jsonValue(params, 'components', (v) => templateComponentsProblem(v, channel, formatOf(params)))

const LIBRARY_BUTTON: Judge = (v, where) => {
  if (isObj(v) && v.type === 'URL') return shape(v, where, { type: oneOf(['URL']), url: (u, w) => shape(u, w, { base_url: url }, ['base_url']) }, ['type', 'url'])
  return shape(v, where, { type: oneOf(['PHONE_NUMBER']), phone_number: (x, w) => (typeof x === 'string' && META_WHATSAPP_NUMBER.test(x) ? null : `${w} is a phone number`) }, ['type', 'phone_number'])
}

/** The ids of a WhatsApp group body: each template id of a JSON list (`["1","2"]`). */
function templateIdsOf(params: Params, key: string): MetaWriteBodyId[] {
  const v = parsedOf(params, key)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((id) => ({ id, kind: 'wabatemplate' as const })) : []
}
const idList = (min: number): Judge => (v, where) => {
  const problem = list(min, META_MESSAGE_LIMITS.groupTemplates, digits)(v, where)
  if (problem) return problem
  return new Set(v as string[]).size === (v as string[]).length ? null : `${where} names each template once`
}

// ── messaging setup ────────────────────────────────────────────────────────────────────────────────────────────────

const localeOf: Judge = (v, where) => (typeof v === 'string' && LOCALE.test(v) ? null : `${where} is "default" or a locale (it_IT, en_GB, …)`)
/** A list of locale objects with a "default" one and each locale once. */
const localized = (max: number, item: Judge): Judge => (v, where) => {
  const problem = list(1, max, item)(v, where)
  if (problem) return problem
  const locales = (v as Row[]).map((r) => r.locale)
  if (!locales.includes('default')) return `${where} has a "default" locale (Meta requires it)`
  return new Set(locales).size === locales.length ? null : `${where} names each locale once`
}
const MENU_ITEM: Judge = (v, where) => {
  if (isObj(v) && v.type === 'web_url') return shape(v, where, { type: oneOf(['web_url']), title: line(META_MESSAGE_LIMITS.menuTitle), url, webview_height_ratio: oneOf(['compact', 'tall', 'full']) }, ['type', 'title', 'url'])
  return shape(v, where, { type: oneOf(['postback']), title: line(META_MESSAGE_LIMITS.menuTitle), payload: line(META_MESSAGE_LIMITS.payload) }, ['type', 'title', 'payload'])
}
const MENU = (instagram: boolean): Judge => localized(META_MESSAGE_LIMITS.menus, (v, where) => shape(v, where, {
  locale: localeOf, call_to_actions: list(1, META_MESSAGE_LIMITS.menuItems, MENU_ITEM),
  ...(instagram ? {} : { composer_input_disabled: boolean }),
}, ['locale', 'call_to_actions']))
const ICE_BREAKERS = localized(META_MESSAGE_LIMITS.menus, (v, where) => shape(v, where, {
  locale: localeOf,
  call_to_actions: list(1, META_MESSAGE_LIMITS.iceBreakers, (q, w) => shape(q, w, { question: line(META_MESSAGE_LIMITS.iceQuestion), payload: line(META_MESSAGE_LIMITS.payload) }, ['question', 'payload'])),
}, ['locale', 'call_to_actions']))
const GREETING = localized(META_MESSAGE_LIMITS.menus, (v, where) => shape(v, where, { locale: localeOf, text: line(META_MESSAGE_LIMITS.greeting) }, ['locale', 'text']))
const COMMANDS = localized(META_MESSAGE_LIMITS.commandSets, (v, where) => shape(v, where, {
  locale: localeOf,
  commands: list(1, META_MESSAGE_LIMITS.commands, (c, w) => shape(c, w, {
    name: (x, xw) => (typeof x === 'string' && /^[^/\s][^\s]{0,31}$/u.test(x) && META_NAME_TEXT.test(x) ? null : `${xw} is a command name: 1–32 characters, no space, not starting with /`),
    description: line(META_MESSAGE_LIMITS.commandDescription),
  }, ['name', 'description'])),
}, ['locale', 'commands']))
const DOMAINS: Judge = (v, where) => {
  const problem = list(1, META_MESSAGE_LIMITS.domains, url)(v, where)
  if (problem) return problem
  return new Set(v as string[]).size === (v as string[]).length ? null : `${where} names each domain once`
}

/** The Messenger profile properties as Nexus writes them (JSON per property; account_linking_url a plain link). */
function profileProblem(params: Params): string | null {
  const instagram = params.get('platform') === 'instagram'
  if (params.has('platform') && !instagram) return 'platform is instagram (left out: Messenger)'
  for (const key of params.keys()) {
    if (key === 'platform') continue
    if (instagram && !(META_INSTAGRAM_PROFILE_FIELDS as readonly string[]).includes(key)) return `on Instagram the profile takes ${META_INSTAGRAM_PROFILE_FIELDS.join(', ')} only (not ${key})`
    const problem = key === 'account_linking_url' ? url(params.get(key), key)
      : jsonValue(params, key, key === 'get_started' ? (v, w) => shape(v, w, { payload: line(META_MESSAGE_LIMITS.payload) }, ['payload'])
        : key === 'greeting' ? GREETING : key === 'ice_breakers' ? ICE_BREAKERS : key === 'persistent_menu' ? MENU(instagram)
          : key === 'whitelisted_domains' ? DOMAINS : COMMANDS)
    if (problem) return problem
  }
  return null
}

const CALL_HOURS: Judge = (v, where) => {
  const time = (x: unknown, w: string) => (typeof x === 'string' && /^([01]\d|2[0-3])[0-5]\d$/.test(x) ? null : `${w} is a time as hhmm (0900)`)
  const problem = shape(v, where, {
    timezone_id: (x, w) => (typeof x === 'string' && /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(x) && x.length <= 64 ? null : `${w} is a time zone (Europe/Rome)`),
    weekly_operating_hours: list(0, 7, (d, w) => shape(d, w, { day_of_week: oneOf(META_WEEK_DAYS), open_time: time, close_time: time }, ['day_of_week', 'open_time', 'close_time'])),
  }, ['timezone_id', 'weekly_operating_hours'])
  if (problem) return problem
  const days = ((v as Row).weekly_operating_hours as Row[])
  if (new Set(days.map((d) => d.day_of_week)).size !== days.length) return `${where}: each day once (Meta refuses a duplicate day)`
  return days.some((d) => String(d.close_time) <= String(d.open_time)) ? `${where}: a day closes after it opens` : null
}

const FLOW_MESSAGE: Judge = (v, where) => shape(v, where, {
  message: (m, w) => shape(m, w, { text: lines(META_MESSAGE_LIMITS.messengerText), quick_replies: QUICK_REPLIES }, ['text']),
}, ['message'])
const FLOW = list(1, META_MESSAGE_LIMITS.flowMessages, FLOW_MESSAGE)
const FLOW_PLATFORMS: Judge = (v, where) => {
  const problem = list(1, 2, oneOf(['messenger', 'instagram']))(v, where)
  if (problem) return problem
  return new Set(v as string[]).size === (v as string[]).length ? null : `${where} names each platform once`
}
function flowProblem(params: Params): string | null {
  if (params.has('flow_id') && !IDS.test(params.get('flow_id') ?? '')) return 'flow_id is a welcome flow id (digits)'
  if (params.has('name')) { const p = line(META_MESSAGE_LIMITS.flowName)(params.get('name'), 'name'); if (p) return p }
  if (params.has('welcome_message_flow')) { const p = jsonValue(params, 'welcome_message_flow', FLOW); if (p) return p }
  if (params.has('eligible_platforms')) { const p = jsonValue(params, 'eligible_platforms', FLOW_PLATFORMS); if (p) return p }
  return null
}

const PAGE_EDGE = { kinds: ['messagingpage' as const], auth: 'page' as const, edgeCall: true as const, budget: false }

// ── the rules ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Step 38 — the messaging rules (gateway meta-calls.ts writeRules). */
export const META_MESSAGING_WRITE_RULES: readonly MetaWriteRule[] = [
  // ── create-meta-message (as the chosen Page) ──
  sendRule('messenger'),
  sendRule('instagram'),
  threadRule('pass'),
  threadRule('release'),
  threadRule('take'),
  // ── set-meta-conversation-labels (as the chosen Page; Messenger) ──
  {
    // EN-912: a new inbox label of the chosen Page.
    name: 'pagelabel.create', method: 'POST', path: /^\d{1,25}\/custom_labels$/, ...PAGE_EDGE,
    required: ['page_label_name'], optional: [], text: { page_label_name: META_NAME_TEXT },
    values: (params) => line(META_MESSAGE_LIMITS.labelName)(params.get('page_label_name'), 'page_label_name'),
  },
  {
    // EN-913: put a label of the chosen Page on one person's conversation (user = their Page-scoped id).
    name: 'pagelabel.assign', method: 'POST', path: /^\d{1,25}\/label$/, kinds: ['pagelabel'], auth: 'page', edgeCall: true,
    required: ['user'], optional: [], values: (params) => digits(params.get('user'), 'user'),
    ids: (params) => [{ id: params.get('user')!, kind: 'messageperson' }], ledger: () => ({ user: '(a person)' }), budget: false,
  },
  {
    // EN-914: take it off again.
    name: 'pagelabel.unassign', method: 'DELETE', path: /^\d{1,25}\/label$/, kinds: ['pagelabel'], auth: 'page', edgeCall: true,
    required: ['user'], optional: [], values: (params) => digits(params.get('user'), 'user'),
    ids: (params) => [{ id: params.get('user')!, kind: 'messageperson' }], ledger: () => ({ user: '(a person)' }), budget: false,
  },
  {
    // EN-915: delete a label of the chosen Page (explicit ask; also the undo of a label Nexus made).
    name: 'pagelabel.delete', method: 'DELETE', path: /^\d{1,25}$/, kinds: ['pagelabel'], auth: 'page',
    required: [], optional: [], values: () => null, budget: false,
  },
  // ── set-meta-message-templates: Messenger utility templates (as the chosen Page) ──
  {
    // EN-923: a utility template of the chosen Page — its own components, or a copy of one of Meta's library templates.
    name: 'pagetemplate.create', method: 'POST', path: /^\d{1,25}\/message_templates$/, ...PAGE_EDGE,
    required: ['name', 'language', 'category'], optional: ['components', 'parameter_format', 'library_template_name', 'library_template_button_inputs'],
    text: { components: META_COMMENT_TEXT, library_template_button_inputs: META_NAME_TEXT },
    maxBody: META_MESSAGING_SETUP_MAX_BODY,
    values: (params) => {
      if (params.get('category') !== 'UTILITY') return 'category is UTILITY (Messenger templates are utility templates only)'
      const problem = nameProblem(params) ?? languageProblem(params) ?? parameterFormatProblem(params)
      if (problem) return problem
      if (params.has('components') === params.has('library_template_name')) return 'a template is its own components or a copy of a Meta library template (library_template_name), one of them'
      if (params.has('library_template_name')) {
        if (params.has('parameter_format')) return 'a copy of a library template takes no parameter_format'
        if (!META_TEMPLATE_NAME.test(params.get('library_template_name') ?? '')) return 'library_template_name is a Meta library template name'
        return params.has('library_template_button_inputs') ? jsonValue(params, 'library_template_button_inputs', list(1, META_MESSAGE_LIMITS.messengerButtons, LIBRARY_BUTTON)) : null
      }
      if (params.has('library_template_button_inputs')) return 'library_template_button_inputs goes with library_template_name'
      return componentsJson(params, 'messenger')
    },
    budget: false,
  },
  {
    // EN-924: edit a utility template of the chosen Page (Meta reviews it again).
    name: 'pagetemplate.edit', method: 'POST', path: /^\d{1,25}$/, kinds: ['messengertemplate'], auth: 'page',
    required: ['components'], optional: ['parameter_format'], text: { components: META_COMMENT_TEXT }, maxBody: META_MESSAGING_SETUP_MAX_BODY,
    values: (params) => parameterFormatProblem(params) ?? componentsJson(params, 'messenger'),
    budget: false,
  },
  {
    // EN-925: delete ONE template of the chosen Page — always its name AND template_id (the name alone deletes every language).
    name: 'pagetemplate.delete', method: 'DELETE', path: /^\d{1,25}\/message_templates$/, ...PAGE_EDGE,
    required: ['name', 'template_id'], optional: [],
    values: (params) => nameProblem(params) ?? digits(params.get('template_id'), 'template_id'),
    ids: (params) => [{ id: params.get('template_id')!, kind: 'pagetemplate' }],
  },
  // ── set-meta-message-templates: WhatsApp (system-user token, the portfolio's own WhatsApp account) ──
  {
    // EN-931: a WhatsApp template (MARKETING or UTILITY) of the business's own WhatsApp account; Meta reviews it.
    name: 'wabatemplate.create', method: 'POST', path: /^\d{1,25}\/message_templates$/, kinds: ['waba'],
    required: ['name', 'language', 'category', 'components'], optional: ['parameter_format'],
    text: { components: META_COMMENT_TEXT }, maxBody: META_MESSAGING_SETUP_MAX_BODY,
    values: (params) => {
      if (params.get('category') === 'AUTHENTICATION') return 'Nexus sends no AUTHENTICATION template: they carry one-time sign-in codes, which Nexus never sends'
      return oneOf(META_WHATSAPP_CATEGORIES)(params.get('category'), 'category') ?? nameProblem(params) ?? languageProblem(params) ?? parameterFormatProblem(params) ?? componentsJson(params, 'whatsapp')
    },
    budget: false,
  },
  {
    // EN-932: delete ONE WhatsApp template — its hsm_id AND name (the name alone deletes every language).
    name: 'wabatemplate.delete', method: 'DELETE', path: /^\d{1,25}\/message_templates$/, kinds: ['waba'],
    required: ['hsm_id', 'name'], optional: [],
    values: (params) => digits(params.get('hsm_id'), 'hsm_id') ?? nameProblem(params),
    ids: (params) => [{ id: params.get('hsm_id')!, kind: 'wabatemplate' }],
    budget: false,
  },
  {
    // EN-940: a template group of the business's own WhatsApp account.
    name: 'templategroup.create', method: 'POST', path: /^\d{1,25}\/template_groups$/, kinds: ['waba'], edgeCall: true,
    required: ['name', 'whatsapp_business_templates'], optional: ['description'], text: { name: META_NAME_TEXT, description: META_NAME_TEXT },
    values: (params) => line(META_MESSAGE_LIMITS.groupName)(params.get('name'), 'name')
      ?? (params.has('description') ? line(META_MESSAGE_LIMITS.groupDescription)(params.get('description'), 'description') : null)
      ?? jsonValue(params, 'whatsapp_business_templates', idList(1)),
    ids: (params) => templateIdsOf(params, 'whatsapp_business_templates'),
    budget: false,
  },
  {
    // EN-940: a group's name, description, templates added or taken off (a template is in one group at a time).
    name: 'templategroup.update', method: 'POST', path: /^\d{1,25}$/, kinds: ['templategroup'],
    required: [], optional: ['name', 'description', 'add_templates', 'remove_templates'], anyOf: ['name', 'description', 'add_templates', 'remove_templates'],
    text: { name: META_NAME_TEXT, description: META_NAME_TEXT },
    values: (params) => {
      if (params.has('name')) { const p = line(META_MESSAGE_LIMITS.groupName)(params.get('name'), 'name'); if (p) return p }
      if (params.has('description')) { const p = line(META_MESSAGE_LIMITS.groupDescription)(params.get('description'), 'description'); if (p) return p }
      for (const key of ['add_templates', 'remove_templates']) if (params.has(key)) { const p = jsonValue(params, key, idList(1)); if (p) return p }
      const add = new Set(templateIdsOf(params, 'add_templates').map((t) => t.id))
      return templateIdsOf(params, 'remove_templates').some((t) => add.has(t.id)) ? 'a template is added or taken off, not both' : null
    },
    ids: (params) => [...templateIdsOf(params, 'add_templates'), ...templateIdsOf(params, 'remove_templates')],
    budget: false,
  },
  {
    // EN-940: delete a group (explicit ask; also the undo of a group Nexus made) — its templates stay.
    name: 'templategroup.delete', method: 'DELETE', path: /^\d{1,25}$/, kinds: ['templategroup'],
    required: [], optional: [], values: () => null, budget: false,
  },
  // ── set-meta-messaging-setup (as the chosen Page) ──
  {
    // EN-901: Messenger (or Instagram) profile properties — only the ones in the body are overwritten.
    name: 'messengerprofile.set', method: 'POST', path: /^\d{1,25}\/messenger_profile$/, ...PAGE_EDGE,
    required: [], optional: [...META_PROFILE_FIELDS, 'platform'], anyOf: [...META_PROFILE_FIELDS],
    text: { greeting: META_COMMENT_TEXT, ice_breakers: META_COMMENT_TEXT, persistent_menu: META_COMMENT_TEXT, commands: META_COMMENT_TEXT, get_started: META_COMMENT_TEXT },
    maxBody: META_MESSAGING_SETUP_MAX_BODY,
    values: profileProblem,
  },
  {
    // EN-902: delete profile properties — only the ones named.
    name: 'messengerprofile.delete', method: 'DELETE', path: /^\d{1,25}\/messenger_profile$/, ...PAGE_EDGE,
    required: ['fields'], optional: ['platform'],
    values: (params) => {
      if (params.has('platform') && params.get('platform') !== 'instagram') return 'platform is instagram (left out: Messenger)'
      const allowed = params.get('platform') === 'instagram' ? META_INSTAGRAM_PROFILE_FIELDS : META_PROFILE_FIELDS
      return jsonValue(params, 'fields', (v, w) => {
        const problem = list(1, allowed.length, oneOf(allowed))(v, w)
        if (problem) return problem
        return new Set(v as string[]).size === (v as string[]).length ? null : `${w} names each property once`
      })
    },
  },
  {
    // EN-904: one person's own persistent menu (their Page-scoped id).
    name: 'usermenu.set', method: 'POST', path: /^\d{1,25}\/custom_user_settings$/, ...PAGE_EDGE,
    required: ['psid', 'persistent_menu'], optional: [], text: { persistent_menu: META_COMMENT_TEXT }, maxBody: META_MESSAGING_SETUP_MAX_BODY,
    values: (params) => digits(params.get('psid'), 'psid') ?? jsonValue(params, 'persistent_menu', MENU(false)),
    ids: (params) => [{ id: params.get('psid')!, kind: 'messageperson' }], ledger: () => ({ psid: '(a person)', persistent_menu: '(a menu)' }),
  },
  {
    // EN-905: take that person's own menu off (the Page's menu stays).
    name: 'usermenu.delete', method: 'DELETE', path: /^\d{1,25}\/custom_user_settings$/, ...PAGE_EDGE,
    required: ['psid', 'params'], optional: [],
    values: (params) => digits(params.get('psid'), 'psid') ?? (params.get('params') === '["persistent_menu"]' ? null : 'params is ["persistent_menu"]'),
    ids: (params) => [{ id: params.get('psid')!, kind: 'messageperson' }], ledger: () => ({ psid: '(a person)', params: '["persistent_menu"]' }),
  },
  {
    // EN-907: a persona of the chosen Page (a name and a picture Meta fetches from an https link).
    name: 'persona.create', method: 'POST', path: /^\d{1,25}\/personas$/, ...PAGE_EDGE,
    required: ['name', 'profile_picture_url'], optional: [], text: { name: META_NAME_TEXT },
    values: (params) => line(META_MESSAGE_LIMITS.personaName)(params.get('name'), 'name') ?? url(params.get('profile_picture_url'), 'profile_picture_url'),
  },
  {
    // EN-908: delete a persona of the chosen Page (a soft delete; explicit ask, or the undo of one Nexus made).
    name: 'persona.delete', method: 'DELETE', path: /^\d{1,25}$/, kinds: ['persona'], auth: 'page',
    required: [], optional: [], values: () => null, budget: false,
  },
  {
    // EN-917: Built-In NLP on or off, its language model (never a custom Wit.ai token).
    name: 'nlp.set', method: 'POST', path: /^\d{1,25}\/nlp_configs$/, ...PAGE_EDGE,
    required: ['nlp_enabled'], optional: ['model', 'n_best'],
    values: (params) => (['true', 'false'].includes(params.get('nlp_enabled') ?? '') ? null : 'nlp_enabled is true or false')
      ?? (params.has('model') ? oneOf(META_NLP_MODELS)(params.get('model'), 'model') : null)
      ?? (params.has('n_best') && !/^[1-8]$/.test(params.get('n_best') ?? '') ? 'n_best is a whole number 1 to 8' : null),
  },
  {
    // EN-921: Messenger calling — audio, video, the call icon, call hours, where calls ring.
    name: 'calling.set', method: 'POST', path: /^\d{1,25}\/messenger_call_settings$/, ...PAGE_EDGE,
    required: [], optional: ['audio_enabled', 'video_enabled', 'icon_enabled', 'call_hours', 'call_routing'], anyOf: ['audio_enabled', 'video_enabled', 'icon_enabled', 'call_hours', 'call_routing'],
    values: (params) => {
      for (const key of ['audio_enabled', 'video_enabled', 'icon_enabled']) if (params.has(key) && !['true', 'false'].includes(params.get(key)!)) return `${key} is true or false`
      if (params.has('call_hours')) { const p = jsonValue(params, 'call_hours', CALL_HOURS); if (p) return p }
      if (params.has('call_routing')) { const p = jsonValue(params, 'call_routing', (v, w) => shape(v, w, { ring_target: oneOf(['META', 'PARTNERS']) }, ['ring_target'])); if (p) return p }
      return null
    },
  },
  {
    // EN-045: a new welcome-message flow of the chosen Page (Click-to-Messenger / Click-to-Instagram-Direct ads).
    name: 'welcomeflow.create', method: 'POST', path: /^\d{1,25}\/welcome_message_flows$/, ...PAGE_EDGE,
    required: ['name', 'welcome_message_flow', 'eligible_platforms'], optional: [],
    text: { name: META_NAME_TEXT, welcome_message_flow: META_COMMENT_TEXT }, maxBody: META_MESSAGE_MAX_BODY,
    values: flowProblem,
  },
  {
    // EN-045: change one of its flows (flow_id; not one used in an ad).
    name: 'welcomeflow.update', method: 'POST', path: /^\d{1,25}\/welcome_message_flows$/, ...PAGE_EDGE,
    required: ['flow_id'], optional: ['name', 'welcome_message_flow', 'eligible_platforms'], anyOf: ['name', 'welcome_message_flow', 'eligible_platforms'],
    text: { name: META_NAME_TEXT, welcome_message_flow: META_COMMENT_TEXT }, maxBody: META_MESSAGE_MAX_BODY,
    values: flowProblem, ids: (params) => [{ id: params.get('flow_id')!, kind: 'welcomeflow' }],
  },
  {
    // EN-045: delete one of its flows (explicit ask; also the undo of a flow Nexus made).
    name: 'welcomeflow.delete', method: 'DELETE', path: /^\d{1,25}\/welcome_message_flows$/, ...PAGE_EDGE,
    required: ['flow_id'], optional: [], values: flowProblem, ids: (params) => [{ id: params.get('flow_id')!, kind: 'welcomeflow' }],
  },
  {
    // CR-216: link a WhatsApp number to the chosen Page — first the number (WhatsApp sends a code to it), then the number
    // with the code the person read on that phone. The code never reaches the call log or an answer (`secret`).
    name: 'whatsappnumber.verify', method: 'POST', path: /^\d{1,25}\/page_whatsapp_number_verification$/, ...PAGE_EDGE,
    required: ['whatsapp_number'], optional: ['verification_code'],
    values: (params) => (META_WHATSAPP_NUMBER.test(params.get('whatsapp_number') ?? '') ? null : 'whatsapp_number is a phone number in international form (+ and digits, no spaces)')
      ?? (params.has('verification_code') && !META_VERIFICATION_CODE.test(params.get('verification_code') ?? '') ? 'verification_code is the digits WhatsApp sent' : null),
    secret: (params) => (params.has('verification_code') ? [params.get('verification_code')!] : []),
  },
]

/** Step 38 — the rule names of the messaging tools (gateway.ts routes the WhatsApp ones to meta-messaging-owner.ts). */
export const META_MESSAGING_RULE_NAMES: ReadonlySet<string> = new Set(META_MESSAGING_WRITE_RULES.map((rule) => rule.name))
