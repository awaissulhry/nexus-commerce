/**
 * Meta ads step 15 (2026-10-21, finished 2026-10-25) — reads of conversations, message templates and the messaging setup,
 * LIVE from Meta through the gateway (GET only). Nothing here stores, logs or caches anything.
 *
 * PEOPLE'S DATA. Conversations and messages carry people's names, ids and words. So (step 14's pattern, live-engagement.ts,
 * and step 37's comment-poll rule: keep no words, name or id a row does not need):
 *   - the tool that answers them (meta-conversations) needs customers.view and is Claude's door only (the in-app chat keeps
 *     tool results in its run's steps); a message is read live for the person who asked and never stored;
 *   - every answer keeps only NAMED keys (conversationRow, messageRow, …), never Meta's raw object (the e-mail Meta adds to a
 *     participant is never copied);
 *   - conversations and messages are read ONLY through their own edges (`/{page}/conversations`, `/{conversation}/messages`):
 *     the gateway refuses `conversations` and `messages` inside `fields` (meta-calls.ts FIELD_DENIED) and that stays;
 *   - a person's id (PSID / IGSID) travels only in a read's QUERY (user_id, recipient, psid), which the gateway's ledger and
 *     traces never keep (they keep host and path); so one person's labels (`GET /<psid>/custom_labels`, a person's id in the
 *     PATH) are not read — the Page's labels are (EN-911), and putting one on or off is step 38's change.
 * Message templates and the messaging setup hold no person's data (the business's own wording, menus, numbers and
 * settings): their tools are offered on both doors.
 *
 * ONLY the business's chosen assets (metaChosenAccount), with fixed field lists per node type (a caller never names a Graph
 * field or path), and every id a caller names is checked to be one of those assets' own before anything of it is read:
 *   - the chosen Facebook Page: Messenger conversations, inbox labels, thread owner, call permission, a person's menu,
 *     Messenger profile, personas, welcome flows, chat plugin, feature review, calling, utility templates, Messenger lead
 *     templates, Page identity fields; a conversation is read only when Meta names the chosen Page (or the chosen Instagram
 *     account) among its participants (ownConversation, one read of its id and participants); a person (PSID) only when
 *     Meta answers a conversation of the chosen Page with that person among its participants (ownPerson);
 *   - the chosen Instagram account (IG Direct, read through the Page it is linked to): only when Meta names it as the chosen
 *     Page's `instagram_business_account` (instagramOnPage);
 *   - WhatsApp: only a WhatsApp Business Account the chosen ad account's own business portfolio owns
 *     (`/{portfolio}/owned_whatsapp_business_accounts`), and only when that portfolio is not one another Nexus business's
 *     chosen ad account belongs to (nexus_meta_links_taken PORTFOLIO → its id and the flag, no call); a phone number a caller
 *     names must be one of that account's own numbers; a template group must name that account as its owner.
 * Anything another business in Nexus uses (an Instagram account) is `{ id, takenByAnotherBusiness: true }` only.
 *
 * TOKENS. Meta answers the Page's conversations and messaging setup only to the Page's OWN access token. The gateway reads
 * the chosen Page's token for each such read itself (step 36's Page token mode, meta-page-token.ts; the routes, keys and
 * fields are its allow-list in gateway/meta-page-reads.ts): conversations, a conversation and its messages, inbox labels,
 * thread owner, call permission, a person's menu, Messenger profile, personas, welcome flows, chat plugin, feature review,
 * calling, utility templates, Messenger lead templates and click-to-message eligibility. The Page node's own fields
 * (its Instagram link, messaging identities, routing), the ad account's and Instagram account's edges and every WhatsApp
 * read go with the business's system-user token. Meta's refusals are said with the access they ask for (MESSENGER_ACCESS,
 * INSTAGRAM_ACCESS, …); LIVE-PROBES.md names the reads to try once live. Meta's messaging windows and the message tags that
 * fail since 2026-04-27 are SAID in the answers (WINDOW_RULES), never assumed.
 *
 * Checked 2026-10-21 and again 2026-10-25 (curl ≥3 s apart; developers.facebook.com docs/graph-api/reference
 * page/conversations, conversation, message, page/thread_owner, page/custom_labels, page/messenger_call_permissions,
 * page/custom_user_settings, page/messenger_profile, page/personas, page/chat_plugin, page/messaging_feature_review,
 * page/messenger_call_settings, page/message_templates, page/messenger_lead_forms, page/ctx_optimization_eligibility,
 * whats-app-business-account/message_templates; documentation/business-messaging/messenger-platform conversations.md,
 * identity/custom-labels.md, send-messages/personas.md, conversation-routing.md, calling/callsettings.md,
 * calling/biz2consumer/check-permissions.md, reference/messenger-profile-api.md, send-messages/messaging-feature-review-api.md,
 * send-messages/utility-messages.md, ads/ads-welcome-message-flows.md, policy.md; …/instagram-messaging/features/ice-breakers.md;
 * instagram-platform/instagram-api-with-instagram-login/conversations-api.md and
 * …/instagram-api-with-facebook-login/creator-marketplace-messaging.md; …/whatsapp analytics.md, templates/template-groups.md,
 * templates/template-management.md, business-phone-numbers/phone-numbers.md, whatsapp-business-accounts.md,
 * pricing/conversation-based-pricing.md, reference/whatsapp-business-account/message-template-api.md; ads-commerce
 * …/ad-creative/threads-ads.md and …/messaging-ads/click-to-instagram.md; docs/graph-api/overview/rate-limiting (80001 Page,
 * 80002 Instagram, 80006 Messenger, 80008 WhatsApp); Meta's Python Business SDK main, facebook_business/adobjects page.py,
 * unifiedthread.py, pagethreadowner.py, pageusermessagethreadlabel.py, messengercallpermissions.py, messengerprofile.py,
 * customusersettings.py, persona.py, chatplugin.py, messagingfeaturereview.py, messagingfeaturestatus.py,
 * messengercallsettings.py, messengerbusinesstemplate.py, ctxpartnerappwelcomemessageflow.py,
 * messengeradspartialautomatedsteplist.py, ctxoptimizationeligibility.py, threadsuser.py, whatsappbusinessaccount.py,
 * business.py):
 *   - conversations: `GET /{page}/conversations` with platform (the guide: `messenger` | `instagram`; the SDK's enum is upper
 *     case — LIVE-PROBES EN-034), user_id (one person: PSID or IGSID), folder (`partnership`: creator conversations, Creator
 *     Marketplace Messaging; ≤ 2 calls a second per Page); no time paging; conversations in Requests inactive > 30 days are
 *     not answered; fields id, updated_time, participants (id, name, username — and an e-mail Nexus drops), is_owner (only
 *     with Conversation Routing) and the SDK's message_count, unread_count, snippet, can_reply, link. Messages: the
 *     conversation's `/messages` edge (reference/conversation, Edges) with id, created_time, from, to, message (+
 *     attachments, shares, story, is_unsupported, reply_to); "you can only get details about the 20 most recent messages" —
 *     so a read asks at most 20. One message (`GET /{message id}`) answers the same fields; its id (`m_…`, `mid.$…`) holds
 *     characters the gateway never sends in a path, so a message is read on its conversation's edge. Messenger needs
 *     pages_messaging, pages_manage_metadata, pages_read_engagement and a Page token of someone with MESSAGING (or
 *     MODERATE); Instagram also instagram_basic, instagram_manage_messages and an app owned by a verified business;
 *     Advanced Access for people without a role on the app.
 *   - labels: `/{page}/custom_labels` (fields page_label_name; pages_messaging); thread owner `/{page}/thread_owner?recipient=`
 *     ({data:[{thread_owner:{app_id, expiration}}]}; Handover Protocol is replaced by Conversation Routing, backwards
 *     compatible); call permission `/{page}/messenger_call_permissions?psid=` ({permission:{status, expiration_time},
 *     actions[…]}); a person's menu `/{page}/custom_user_settings?psid=` (page_level_persistent_menu,
 *     user_level_persistent_menu).
 *   - WhatsApp analytics: `GET /{waba}?fields=<field>.start(<unix>).end(<unix>).granularity(…)…` (analytics.md: the
 *     documented form is the field with modifiers; the SDK's edges are not used), conversation_analytics (conversation-based
 *     pricing, replaced by per-message pricing on 2025-07-01), pricing_analytics, call_analytics; lookback 1 year since
 *     2025-12-01 for conversation and pricing analytics; cost "approximate charges … in the account's currency" (not for an
 *     account billed through a Solution Partner's credit line).
 *   - templates: `/{page}/message_templates` (page_utility_messaging; params category, content, language, name,
 *     name_or_content, status; MessengerBusinessTemplate fields); `/{waba}/message_templates` (also quality_score, since,
 *     until; fields of the message-template API); `/{waba}/template_groups` (SDK only — the Graph page says "can't", the
 *     WhatsApp guide documents create / one group / update / delete) and `GET /{group}` (whatsapp_business_account,
 *     whatsapp_business_templates).
 *   - setup: `/{page}/messenger_profile` (fields = property names; platform instagram for Instagram ice breakers; 10 calls
 *     per 10 minutes per Page; in Development mode the settings show only to people with an app role); `/{page}/personas`;
 *     `/{page}/welcome_message_flows` (flow_id, limit; the flows THIS app made; Instagram flows there are the Page's flows
 *     whose eligible_platforms include instagram; the guide shows a bare list answering `welcome_message`, the SDK names
 *     welcome_message_flow and welcome_message_sequence). Review B-SF3: the Instagram account has an edge of its own too
 *     (SDK iguser.py get_welcome_message_flows; graph.instagram.com in the Instagram Login guide) for flows made on the
 *     account itself through Instagram Login — Nexus does not read it (RECHECK CR-207's "no IG edge" went too far);
 *     `/{page}/chat_plugin`; `/{page}/messaging_feature_review` (subscription messaging, gender, locale, time_zone — the
 *     Human Agent feature is not listed, RECHECK-C4 EN-037) and the Page field messaging_feature_status (hop_v2,
 *     msgr_multi_app, ig_multi_app); `/{page}/messenger_call_settings` (audio_enabled, video_enabled, icon_enabled,
 *     call_hours, call_routing); `/{page}/messenger_lead_forms` (MessengerAdsPartialAutomatedStepList; `GET /{id}` is
 *     deprecated since v24; steps: SDK get_steps); Page fields has_whatsapp_number, has_whatsapp_business_number,
 *     whatsapp_number, instagram_business_account, connected_instagram_account, page_backed_threads_account_id,
 *     messenger_ads_default_icebreakers, messenger_ads_default_quick_replies, messenger_ads_quick_replies_type (read only —
 *     RECHECK-C4 CR-272); `/act_{id}/connected_instagram_accounts_with_iabp?business_id=` (iabp_id); `/{ig}/connected_threads_user`
 *     and `/{ig}/instagram_backed_threads_user` (threads_user_id); `/{page}/ctx_optimization_eligibility` (ctm).
 * The Instagram-Login host (graph.instagram.com) is never called: Nexus reaches Meta only at graph.facebook.com.
 *
 * Step 38 (the changes: messages, inbox labels, templates, messaging setup) builds on these reads: ownConversation,
 * ownPerson, instagramOnPage, ownWhatsApp and windowOf say what a message may be sent to and when; the read* functions
 * below hand back Meta's own objects UNCHANGED (snake_case, as Meta sends and takes them), for a change's preview, basis
 * and undo.
 */
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { fieldRefused, listGroups, listPaged, readGroups, type FieldGroup, type MissingPart } from './live-objects.js'
import { pageOf, refusedFields, tidy } from './live-media.js'
import { META_THREAD_ID } from '../../gateway/meta-page-reads.js'
import { isRealDay } from './live-engagement.js'
import { part } from './live-partners.js'
import { takenIds } from './taken.js'
import { decimalToMicros, minorOf } from './money.js'

type Row = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
/** Rows of a list Meta answers as `{ data: [...] }` or as a bare list. */
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : []).map(obj).filter((r): r is Row => !!r)
/** The one object of an edge Meta answers either as `{ data: [obj] }` or as the object itself. */
const firstOf = (v: unknown): Row | null => (Array.isArray(v) || Array.isArray(obj(v)?.data) ? rowsOf(v)[0] ?? null : obj(v))
const clampRows = (n: number | undefined, dflt: number, max = 500) => Math.min(max, Math.max(1, Math.trunc(n ?? dflt)))
const missingOf = (missing: MissingPart[]) => (missing.length ? missing : undefined)
/** A day (YYYY-MM-DD, UTC) as unix seconds; `end`: the first second after it. */
const unixOf = (day: string, end = false) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + (end ? 86_400 : 0)
const isoOfUnix = (v: unknown): string | null => { const n = num(v); return n === null ? null : new Date(n * 1000).toISOString() }

// ── what Meta's rules and words mean here ────────────────────────────────────────────────────────────────────────────

/** Said with every conversation answer (MSEND, MPOL, F2 M12): Meta's windows, never assumed. */
export const WINDOW_RULES = 'Meta lets the business write to a person only inside its messaging window: 24 hours after the person\'s last message (up to 7 days after a person\'s first message sent from a Click-to-Messenger or Click-to-Instagram-Direct ad; one private reply to a comment within 7 days). Outside it, from Nexus: an approved Messenger utility template (Messenger only, not Instagram; order, shipping and account updates, never marketing: meta-message-templates view messenger) or the HUMAN_AGENT tag (a person\'s own reply within 7 days, never promotional; an App Review feature that needs Business Verification, whose state Meta lets no app read). Meta\'s paid or opt-in routes (Sponsored Messages, Marketing Messages, Messenger\'s One-time Notification) are not in Nexus. The ACCOUNT_UPDATE, POST_PURCHASE_UPDATE and CONFIRMED_EVENT_UPDATE tags fail since 2026-04-27 (Meta error 100). Nexus cannot see whether an ad opened a 7-day window: it gives the person\'s last message time and the end of the 24-hour window, nothing more. Automated replies to people in Germany must say they are automated.'
export const PEOPLES_DATA = 'People\'s names, ids and words: use them for what the person asked and nowhere else; Nexus keeps none of it.'
/** Said with the Page's own reads: the token they go with. */
export const PAGE_READ_NOTE = 'Nexus reads this with the chosen Page\'s own token, which it asks Meta for on each read with the business\'s system-user token (the system user needs the MESSAGING task on the Page; with Meta changes switched off in Nexus — NEXUS_META_ADS_WRITES — no Page token is read, so these reads wait too).'
export const MESSENGER_ACCESS = 'Meta answers Messenger conversations to the Page\'s own token of someone with the MESSAGING (or MODERATE) task, with pages_messaging, pages_manage_metadata and pages_read_engagement. With Standard access Meta answers only conversations with people who have a role on the business\'s Meta app, its Facebook Page, its Instagram account or its business portfolio; real customers\' conversations need Advanced Access for pages_messaging, which takes App Review (until Meta grants it, an empty list may mean only that).'
export const INSTAGRAM_ACCESS = 'Meta answers Instagram Direct conversations through the Facebook Page the Instagram account is linked to, to that Page\'s own token of someone with the MESSAGING task, with instagram_basic, instagram_manage_messages and pages_manage_metadata, and only for an app owned by a verified business (Business Verification); real customers need Advanced Access for instagram_manage_messages (App Review). Requests-folder conversations inactive for 30 days are never answered.'
export const CREATOR_ACCESS = 'Creator conversations (the Partnership folder) need instagram_creator_marketplace_messaging (App Review), instagram_basic, pages_read_user_content, pages_show_list and business_management, and the brand onboarded to Instagram\'s creator marketplace; Meta allows 2 Conversations API calls a second per Page.'
export const WHATSAPP_ACCESS = 'WhatsApp reads need a WhatsApp Business account owned by the chosen ad account\'s business portfolio (made in WhatsApp Manager; Click-to-WhatsApp ads need one), the WhatsApp product on the business\'s Meta app with the whatsapp_business_management and whatsapp_business_messaging permissions — Standard access is enough for the business\'s own accounts, App Review and Advanced Access only for other businesses\' — and that WhatsApp account assigned to the system user in Meta Business settings. Meta lists a portfolio\'s WhatsApp accounts only to an ADMIN system user of that portfolio (with business_management), so with an employee system user the list is refused.'
export const PAGE_FIELDS_ACCESS = 'Meta answers the Page\'s own fields to the business\'s system user when the Page is assigned to it in Meta Business settings (pages_read_engagement, pages_show_list).'
export const LABELS_ACCESS = 'Meta answers inbox labels to the Page\'s own token of someone with the MESSAGING task (pages_messaging, pages_manage_metadata, pages_show_list), and only once a Page admin has accepted Meta\'s Page Contact Terms.'
export const UTILITY_ACCESS = 'Meta answers a Page\'s Messenger utility templates to the Page\'s own token with the page_utility_messaging permission.'
export const PROFILE_NOTE = 'While the business\'s Meta app is in Development mode Meta shows the Messenger profile only to people with a role on the app; the app must be Live for customers to see it. Meta allows 10 Messenger Profile calls per 10 minutes per Page.'
export const NO_PORTFOLIO = 'The chosen ad account names no Meta business portfolio, so no WhatsApp Business account can be found for it (a person checks the ad account in Meta Business settings).'
export const WHATSAPP_PORTFOLIO_TAKEN = 'Another business in Nexus reads an ad account of this Meta business portfolio, so its WhatsApp accounts are not read here (they could be that business\'s).'
export const NO_WHATSAPP_ACCOUNT = 'Meta lists no WhatsApp Business account owned by the chosen ad account\'s business portfolio, so there is nothing to read. Click-to-WhatsApp ads and WhatsApp templates need one: a person makes it in WhatsApp Manager and assigns it to the system user.'

/** Meta's own words inside a failure sentence (errors.ts wraps them in a system user's wording). */
function metaWords(err: MetaReadError): string {
  const s = err.failure.sentence
  return /read (?:this|these numbers): (.*?) Check that the ad account/s.exec(s)?.[1] ?? /token \((.*)\)\. Make a new token/s.exec(s)?.[1] ?? s
}

/** A system-user read Meta refuses for access: Meta's words, then what it takes. */
async function onAccess<T>(work: () => Promise<T>, access: string): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && err.failure.permissionDenied) {
      throw new MetaLiveRefusal(`${err.message} ${access}`)
    }
    throw err
  }
}

/**
 * A read made with the chosen Page's own token (gateway/meta-page-reads.ts): Meta's refusal is about the PAGE's token and
 * access, never the business's system-user token (errors.ts words those for a system-user read).
 */
async function onPageRead<T>(work: () => Promise<T>, access: string): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled) {
      if (err.failure.permissionDenied) throw new MetaLiveRefusal(`Meta refused this read of the chosen Page (Meta's words: ${metaWords(err)}). ${access}`)
      if (err.failure.authLost) throw new MetaLiveRefusal(`Meta refused the chosen Page's own token for this read (Meta's words: ${metaWords(err)}); the business's system-user token is not concerned. ${access}`)
    }
    throw err
  }
}

/** A list Meta answers as `{data, paging}` or as a bare list (welcome flows), paged on the cursor while Meta gives a next link. */
async function listAny(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number): Promise<{ rows: Row[]; more: boolean }> {
  const max = clampRows(maxRows, 100)
  const limit = Math.min(100, max)
  const rows: Row[] = []
  let after: string | null = null
  for (let page = 0; page < 20; page++) {
    const { body } = await metaReadOne<unknown>({ connectionId }, { operation, path, query: { ...query, limit, ...(after ? { after } : {}) } })
    rows.push(...rowsOf(body))
    const paging = obj(obj(body)?.paging)
    const next = paging?.next ? text(obj(paging.cursors)?.after) : null
    if (rows.length >= max || !next) return { rows: rows.slice(0, max), more: rows.length > max || (!!next && rows.length >= max) }
    after = next
  }
  return { rows: rows.slice(0, max), more: true }
}

/**
 * One object of an edge Meta answers as `{data:[obj]}` (messenger_profile, chat_plugin, call settings): every group in ONE
 * call; when Meta refuses a field, each group alone (the first must answer; any other refused is named).
 */
async function edgeGroups(connectionId: string, operation: string, path: string, groups: FieldGroup[], query: Record<string, MetaQueryValue> = {}): Promise<{ body: Row; missing: MissingPart[] }> {
  try {
    return { body: firstOf((await metaReadOne<unknown>({ connectionId }, { operation, path, query: { ...query, fields: groups.map((g) => g.fields).join(',') } })).body) ?? {}, missing: [] }
  } catch (err) {
    if (groups.length < 2 || !fieldRefused(err)) throw err
  }
  const body: Row = {}
  const missing: MissingPart[] = []
  for (const [i, group] of groups.entries()) {
    try {
      Object.assign(body, firstOf((await metaReadOne<unknown>({ connectionId }, { operation: `${operation}.${group.name}`, path, query: { ...query, fields: group.fields } })).body) ?? {})
    } catch (err) {
      if (i === 0 || !fieldRefused(err)) throw err
      missing.push({ part: group.name, sentence: err.failure.sentence })
    }
  }
  return { body, missing }
}

// ── the chosen assets and the ids a caller names ────────────────────────────────────────────────────────────────────

export type MessagingPlatform = 'messenger' | 'instagram'

/**
 * A Messenger (`t_<digits>`) or Instagram conversation id (`aWdf…`, letters and digits) as Meta gives it: exactly the ids
 * the gateway reads with the chosen Page's token (gateway/meta-page-reads.ts META_THREAD_ID, a positive pattern — review
 * fix A4); nothing else goes in a path.
 */
export function conversationIdOf(value: string): string {
  const id = value.trim()
  if (!META_THREAD_ID.test(id)) throw new MetaLiveRefusal(`"${value}" is not a Meta conversation id Nexus reads (t_<digits> for Messenger, aWdf… letters and digits for Instagram, as views messenger and instagram give them).`)
  return id
}

/** The ids of a participants list (`{data:[{id,…}]}`). */
const participantIds = (v: unknown): string[] => rowsOf(v).map((p) => idText(p.id)).filter((id): id is string => !!id)

/**
 * IG Direct is read through the Page it is linked to: Meta must name the chosen Instagram account as the chosen Page's
 * `instagram_business_account` (one read of that id alone, with the system-user token), else nothing is read.
 */
export async function instagramOnPage(account: MetaChosenAccount): Promise<{ pageId: string; instagramId: string }> {
  const pageId = pageOf(account)
  if (!account.instagramId) throw new MetaLiveRefusal('No Instagram account is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).')
  const body = (await onAccess(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'messaging.instagramOnPage', path: pageId, query: { fields: 'id,instagram_business_account' } }), PAGE_FIELDS_ACCESS)).body as Row
  const linked = idText(obj(body.instagram_business_account)?.id)
  if (idText(body.id) !== pageId || linked !== account.instagramId) throw new MetaLiveRefusal('The chosen Instagram account is not the one Meta links to the chosen Facebook Page, and Instagram Direct is read through that Page, so no Instagram conversation is read (a person links them in Meta Business settings, or chooses the matching Page and account).')
  return { pageId, instagramId: account.instagramId }
}

/**
 * A conversation the check confirmed: its id, platform, the people in it other than the business (their scoped ids), and
 * which of those ids another business in Nexus uses as its Page or Instagram account (re-review N5: step 38 never writes
 * to one; the read flags them).
 */
export interface OwnConversation { conversationId: string; platform: MessagingPlatform; personIds: string[]; takenPersonIds: string[] }

/**
 * THE check before a conversation's messages are read (and before step 38 writes in one): Meta names the chosen Page
 * (Messenger) or the chosen Instagram account (Instagram Direct) among its participants — one read of its id and
 * participants, with the chosen Page's token, nothing else. Fail closed.
 */
export async function ownConversation(account: MetaChosenAccount, idArg: string): Promise<OwnConversation> {
  const pageId = pageOf(account)
  const conversationId = conversationIdOf(idArg)
  let body: Row
  try {
    body = (await onPageRead(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'messaging.conversationCheck', path: conversationId, query: { fields: 'id,participants' } }), MESSENGER_ACCESS)).body as Row
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && (err.failure.notFound || /nonexisting field|does not exist/i.test(err.failure.sentence))) throw new MetaLiveRefusal('That id is not a conversation of the chosen Facebook Page that Meta answers, so it is not read.')
    throw err
  }
  if (idText(body.id) !== conversationId) throw new MetaLiveRefusal('Meta answered with another conversation than the one asked; nothing of it is read.')
  const ids = participantIds(body.participants)
  const own = (platform: MessagingPlatform, business: string): Promise<OwnConversation> => {
    const personIds = ids.filter((id) => id !== business)
    return takenPeople(personIds.map((id) => ({ id }))).then((taken) => ({ conversationId, platform, personIds, takenPersonIds: personIds.filter((id) => taken.has(id)) }))
  }
  if (ids.includes(pageId)) return own('messenger', pageId)
  if (account.instagramId && ids.includes(account.instagramId)) {
    await instagramOnPage(account)
    return own('instagram', account.instagramId)
  }
  throw new MetaLiveRefusal('That conversation is not one of the chosen Facebook Page or Instagram account (Meta names neither among its participants), so it is not read.')
}

/** A person's Page-scoped (or Instagram-scoped) id: digits only. */
function personIdOf(value: string | null | undefined): string {
  const id = metaObjectId(value)
  if (!id) throw new MetaLiveRefusal('Name the person (personId: the Page-scoped id a conversation view gives, digits).')
  return id
}

/**
 * THE check before anything about a person is read (and before step 38 writes to one): Meta answers a conversation of the
 * chosen Page (or its linked Instagram account) with that person among its participants (`user_id` filter — in the query,
 * never the path — and its participants checked: fail closed). Returns that conversation's id.
 */
export async function ownPerson(account: MetaChosenAccount, idArg: string | null | undefined, platform: MessagingPlatform): Promise<{ personId: string; conversationId: string }> {
  const personId = personIdOf(idArg)
  const { pageId } = platform === 'instagram' ? await instagramOnPage(account) : { pageId: pageOf(account) }
  const read = await onPageRead(() => listPaged(account.connectionId, 'messaging.personCheck', `${pageId}/conversations`, { platform, user_id: personId, fields: 'id,participants' }, 5), platform === 'instagram' ? INSTAGRAM_ACCESS : MESSENGER_ACCESS)
  const business = platform === 'instagram' ? account.instagramId : pageId
  const found = read.rows.find((r) => { const ids = participantIds(r.participants); return ids.includes(personId) && !!business && ids.includes(business) })
  const conversationId = found ? text(found.id) : null
  if (!conversationId) throw new MetaLiveRefusal(`That person has no ${platform === 'instagram' ? 'Instagram Direct' : 'Messenger'} conversation with the ${platform === 'instagram' ? 'chosen Instagram account' : 'chosen Facebook Page'} that Meta answers, so nothing about them is read.`)
  return { personId, conversationId }
}

/** The business's own WhatsApp account, or why none is read. */
export interface OwnWhatsApp { wabaId: string; name: string | null; currency: string | null; timeZoneId: string | null; status: string | null }
export type WhatsAppPick = { waba: OwnWhatsApp } | { taken: { portfolioId: string; takenByAnotherBusiness: true; sentence: string } }

/**
 * A WhatsApp Business Account the chosen ad account's own portfolio owns, and only when that portfolio is not one another
 * Nexus business's ad account belongs to (its id and the flag, no call). `wabaId` must be one of them; without it, the one.
 */
export async function ownWhatsApp(account: MetaChosenAccount, wabaIdArg?: string | null): Promise<WhatsAppPick> {
  const portfolioId = account.businessId
  if (!portfolioId) throw new MetaLiveRefusal(NO_PORTFOLIO)
  if ((await takenIds('PORTFOLIO', [portfolioId])).has(portfolioId)) return { taken: { portfolioId, takenByAnotherBusiness: true, sentence: WHATSAPP_PORTFOLIO_TAKEN } }
  const asked = wabaIdArg ? metaObjectId(wabaIdArg) : null
  if (wabaIdArg && !asked) throw new MetaLiveRefusal(`"${wabaIdArg}" is not a WhatsApp Business account id (digits).`)
  const read = await onAccess(() => listPaged(account.connectionId, 'whatsapp.accounts', `${portfolioId}/owned_whatsapp_business_accounts`, { fields: 'id,name,currency,timezone_id,status' }, 50), WHATSAPP_ACCESS)
  const all: OwnWhatsApp[] = read.rows.map((r) => ({ wabaId: idText(r.id) ?? '', name: text(r.name), currency: text(r.currency), timeZoneId: idText(r.timezone_id), status: text(r.status) })).filter((w) => /^\d{1,25}$/.test(w.wabaId))
  if (!all.length) throw new MetaLiveRefusal(NO_WHATSAPP_ACCOUNT)
  if (asked) {
    const found = all.find((w) => w.wabaId === asked)
    if (!found) throw new MetaLiveRefusal(`That WhatsApp account is not one the chosen ad account's business portfolio owns, so it is not read (its own: ${all.map((w) => w.wabaId).join(', ')}).`)
    return { waba: found }
  }
  if (all.length > 1) throw new MetaLiveRefusal(`The business portfolio owns ${all.length} WhatsApp accounts: name one (whatsappAccountId): ${all.map((w) => `${w.wabaId}${w.name ? ` (${w.name})` : ''}`).join(', ')}.`)
  return { waba: all[0] }
}

/** The WhatsApp account's own numbers (digits of display_phone_number), and each number a caller names must be one. */
async function ownNumbers(account: MetaChosenAccount, wabaId: string, numbers: readonly string[]): Promise<string[]> {
  if (!numbers.length) return []
  const read = await onAccess(() => listPaged(account.connectionId, 'whatsapp.numbers', `${wabaId}/phone_numbers`, { fields: 'id,display_phone_number,verified_name' }, 100), WHATSAPP_ACCESS)
  const own = new Set(read.rows.map((r) => (text(r.display_phone_number) ?? '').replace(/\D/g, '')).filter(Boolean))
  const wanted = [...new Set(numbers.map((n) => n.replace(/\D/g, '')))]
  const foreign = wanted.filter((n) => !own.has(n))
  if (foreign.length) throw new MetaLiveRefusal(`${foreign.join(', ')} ${foreign.length === 1 ? 'is not a number' : 'are not numbers'} of this WhatsApp account, so nothing is read (its numbers: ${[...own].join(', ') || 'none'}).`)
  return wanted
}

/** At most this many WhatsApp accounts of the portfolio are searched for one phone number (a read of each one's numbers). */
const MAX_NUMBER_ACCOUNTS = 10

/**
 * Live-probe fix TG-034 / TG-035 (2026-10-26) — Meta's marketing-message estimate refused without "a valid WhatsApp
 * Business phone number ID": meta-targeting-check message-delivery names one in its promoted object
 * (`whats_app_business_phone_number_id`, ad-promoted-object reference v26 and SDK adpromotedobject.py). It must be a number
 * of a WhatsApp account the chosen ad account's own portfolio owns (a portfolio another Nexus business reads: refused, no
 * call), found among that account's own numbers (`<waba>/phone_numbers`, ids only); else refused before the estimate, with
 * the business's own numbers named so the right one can be given.
 */
export async function ownWhatsAppNumberId(account: MetaChosenAccount, phoneNumberIdArg: string): Promise<{ wabaId: string; phoneNumberId: string }> {
  const phoneNumberId = /^\d{1,25}$/.test(phoneNumberIdArg.trim()) ? phoneNumberIdArg.trim() : null
  if (!phoneNumberId) throw new MetaLiveRefusal(`"${phoneNumberIdArg}" is not a WhatsApp Business phone number id (digits, as WhatsApp Manager shows it).`)
  const portfolioId = account.businessId
  if (!portfolioId) throw new MetaLiveRefusal(NO_PORTFOLIO)
  if ((await takenIds('PORTFOLIO', [portfolioId])).has(portfolioId)) throw new MetaLiveRefusal(WHATSAPP_PORTFOLIO_TAKEN)
  const accounts = await onAccess(() => listPaged(account.connectionId, 'whatsapp.accounts', `${portfolioId}/owned_whatsapp_business_accounts`, { fields: 'id' }, 50), WHATSAPP_ACCESS)
  const wabas = accounts.rows.map((r) => idText(r.id)).filter((id): id is string => !!id && /^\d{1,25}$/.test(id))
  if (!wabas.length) throw new MetaLiveRefusal(NO_WHATSAPP_ACCOUNT)
  const own: string[] = []
  for (const wabaId of wabas.slice(0, MAX_NUMBER_ACCOUNTS)) {
    const numbers = await onAccess(() => listPaged(account.connectionId, 'whatsapp.numbers', `${wabaId}/phone_numbers`, { fields: 'id,display_phone_number' }, 100), WHATSAPP_ACCESS)
    if (numbers.rows.some((r) => idText(r.id) === phoneNumberId)) return { wabaId, phoneNumberId }
    own.push(...numbers.rows.map((r) => `${idText(r.id) ?? '?'}${text(r.display_phone_number) ? ` (${text(r.display_phone_number)})` : ''}`))
  }
  throw new MetaLiveRefusal(`That WhatsApp phone number id is not one of the numbers of the WhatsApp accounts the chosen ad account's business portfolio owns${wabas.length > MAX_NUMBER_ACCOUNTS ? ` (the first ${MAX_NUMBER_ACCOUNTS} accounts searched)` : ''}, so no estimate is asked (its numbers: ${own.join(', ') || 'none'}).`)
}

// ── Meta's own objects, unchanged (step 38's preview, basis and undo read them) ─────────────────────────────────────

/** Fixed field lists per node type: the ONLY fields these reads ask (the Page's own: gateway/meta-page-reads.ts). */
export const CONVERSATION_FIELDS = {
  /** Conversation (reference/conversation; the guide answers id, updated_time). */
  Thread: 'id,updated_time,participants',
  /** SDK unifiedthread.py only. */
  ThreadDetails: 'message_count,unread_count,snippet,can_reply,link',
  /** Only with Conversation Routing: whether this app answers the thread. */
  ThreadRouting: 'is_owner',
  /** Message (reference/message; the conversations guide's own list). */
  Message: 'id,created_time,from,to,message',
  MessageMore: 'attachments{id,name,file_url,image_data,video_data},shares{id,name,description,type,url},story,is_unsupported,reply_to',
  Label: 'id,page_label_name',
} as const

export const SETUP_FIELDS = {
  /** Messenger Profile properties (messenger-profile-api.md; SDK messengerprofile.py — greeting is the reference's only). */
  Profile: 'get_started,ice_breakers,persistent_menu,whitelisted_domains',
  ProfileMore: 'greeting,account_linking_url,commands,subject_to_new_eu_privacy_rules',
  /**
   * CTXPartnerAppWelcomeMessageFlow (SDK); the guide's own answer carries `welcome_message` (its JSON), the SDK names
   * welcome_message_flow and welcome_message_sequence — each asked, each Meta refuses dropped on its own (review B-SF4).
   */
  Flow: 'id,name,eligible_platforms,last_update_time,is_used_in_ad',
  FlowMore: 'welcome_message,welcome_message_flow,welcome_message_sequence,is_ig_only_flow,compatible_platforms',
  Persona: 'id,name,profile_picture_url',
  Calling: 'audio_enabled,video_enabled,icon_enabled',
  CallHours: 'call_hours',
  CallRouting: 'call_routing',
  Feature: 'feature,status',
  ChatPlugin: 'alignment,desktop_bottom_spacing,desktop_side_spacing,entry_point_icon,entry_point_label,greeting_dialog_display,guest_chat_mode,mobile_bottom_spacing,mobile_chat_display,mobile_side_spacing,theme_color,welcome_screen_greeting',
  /** The Page's messaging identities (Graph Page reference; RECHECK CR-271). */
  PageIdentity: 'id,has_whatsapp_number,has_whatsapp_business_number,whatsapp_number,instagram_business_account,connected_instagram_account',
  PageThreads: 'page_backed_threads_account_id',
  PageAdDefaults: 'messenger_ads_default_icebreakers,messenger_ads_default_quick_replies,messenger_ads_quick_replies_type',
  Iabp: 'id,iabp_id',
  IabpMore: 'username',
  LeadTemplate: 'id',
  LeadTemplateMore: 'privacy_url,reminder_text,stop_question_message,first_step_id,fblead_form{id}',
  /** MessengerAdsPartialAutomatedStep (Graph reference v26.0; the SDK's steps edge names no fields — review fix A7). */
  LeadStep: 'id,step_type,message,reply_type,answers,next_step_ids',
  LeadStepMore: 'allow_to_skip,prefill_type,options_format,invalid_reply_text,answer_validation_enabled',
} as const

export const TEMPLATE_FIELDS = {
  /** MessengerBusinessTemplate (reference page/message_templates; SDK messengerbusinesstemplate.py). */
  Messenger: 'id,name,category,language,status,components',
  MessengerMore: 'parameter_format,library_template_name,rejected_reason,rejection_reasons,specific_rejection_reasons,creation_time,last_updated_time',
  /** WhatsApp message template (message-template-api: GET /{TEMPLATE_ID} "Available fields"). */
  WhatsApp: 'id,name,category,language,status,components',
  WhatsAppMore: 'parameter_format,sub_category,quality_score,rejected_reason,previous_category,correct_category,library_template_name,message_send_ttl_seconds,last_updated_time',
  Group: 'id,name,description,creation_time,update_time',
  GroupTemplates: 'whatsapp_business_templates.limit(100){id,name,status,category,language}',
} as const

export const PROFILE_PLATFORMS = ['messenger', 'instagram'] as const
export const FLOW_PLATFORMS = ['messenger', 'instagram'] as const

/** The chosen Page's inbox labels, as Meta answers them ({ id, page_label_name }). */
export async function readPageLabels(account: MetaChosenAccount, maxRows = 500): Promise<{ pageId: string; rows: Row[]; more: boolean }> {
  const pageId = pageOf(account)
  const read = await onPageRead(() => listPaged(account.connectionId, 'messaging.labels', `${pageId}/custom_labels`, { fields: CONVERSATION_FIELDS.Label }, maxRows), LABELS_ACCESS)
  return { pageId, rows: read.rows, more: read.more }
}

/**
 * The persistent menu one person sees (the Page's own and one set for that person only), as Meta answers it — the person
 * checked first (ownPerson: a Messenger conversation of the chosen Page with them), their id in the query only.
 */
export async function readPersonMenu(account: MetaChosenAccount, personIdArg: string | null | undefined): Promise<{ pageId: string; personId: string; conversationId: string; body: Row | null }> {
  const pageId = pageOf(account)
  const { personId, conversationId } = await ownPerson(account, personIdArg, 'messenger')
  const read = await onPageRead(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'messaging.personMenu', path: `${pageId}/custom_user_settings`, query: { psid: personId, fields: 'page_level_persistent_menu,user_level_persistent_menu' } }), MESSENGER_ACCESS)
  return { pageId, personId, conversationId, body: firstOf(read.body) }
}

/** The chosen Page's personas, as Meta answers them ({ id, name, profile_picture_url }). */
export async function readPersonas(account: MetaChosenAccount, maxRows = 500): Promise<{ pageId: string; rows: Row[]; more: boolean }> {
  const pageId = pageOf(account)
  const read = await onPageRead(() => listPaged(account.connectionId, 'setup.personas', `${pageId}/personas`, { fields: SETUP_FIELDS.Persona }, maxRows), MESSENGER_ACCESS)
  return { pageId, rows: read.rows, more: read.more }
}

/** The chosen Page's Messenger (or Instagram) profile, every property as Meta answers it (an undo re-sends them). */
export async function readMessengerProfile(account: MetaChosenAccount, platform: MessagingPlatform): Promise<{ pageId: string; platform: MessagingPlatform; body: Row; missing: MissingPart[] }> {
  const pageId = pageOf(account)
  const read = await onPageRead(() => edgeGroups(account.connectionId, 'setup.profile', `${pageId}/messenger_profile`, [{ name: 'profile', fields: SETUP_FIELDS.Profile }, { name: 'more', fields: SETUP_FIELDS.ProfileMore }], { platform }), MESSENGER_ACCESS)
  return { pageId, platform, ...read }
}

/** The chosen Page's Messenger calling settings, as Meta answers them (an undo re-sends them). */
export async function readCallSettings(account: MetaChosenAccount): Promise<{ pageId: string; body: Row; missing: MissingPart[] }> {
  const pageId = pageOf(account)
  const read = await onPageRead(() => edgeGroups(account.connectionId, 'setup.calling', `${pageId}/messenger_call_settings`, [
    { name: 'calling', fields: SETUP_FIELDS.Calling }, { name: 'hours', fields: SETUP_FIELDS.CallHours }, { name: 'routing', fields: SETUP_FIELDS.CallRouting },
  ]), MESSENGER_ACCESS)
  return { pageId, ...read }
}

/**
 * The chosen Page's welcome-message flows (the ones the business's Meta app made), as Meta answers them; `flowId`: that one
 * flow only, and it must be on the Page's own edge (else refused).
 */
export async function readWelcomeFlows(account: MetaChosenAccount, flowIdArg: string | null, maxRows = 500): Promise<{ pageId: string; rows: Row[]; more: boolean; missing: MissingPart[] }> {
  const pageId = pageOf(account)
  const flowId = flowIdArg ? metaObjectId(flowIdArg) : null
  if (flowIdArg && !flowId) throw new MetaLiveRefusal(`"${flowIdArg}" is not a welcome-flow id (digits).`)
  const query = flowId ? { flow_id: flowId } : {}
  // The guide's field and the SDK's: each one Meta refuses is dropped on its own (at most 4 tries), the rest still asked.
  let asked = SETUP_FIELDS.FlowMore.split(',')
  const missing: MissingPart[] = []
  let read: { rows: Row[]; more: boolean } | null = null
  for (let attempt = 0; !read; attempt++) {
    try {
      read = await onPageRead(() => listAny(account.connectionId, attempt ? 'setup.flows.fewer' : 'setup.flows', `${pageId}/welcome_message_flows`, { ...query, fields: [SETUP_FIELDS.Flow, ...asked].join(',') }, maxRows), MESSENGER_ACCESS)
    } catch (err) {
      if (!asked.length || !fieldRefused(err) || attempt >= 3) throw err
      const refused = attempt === 2 ? asked : refusedFields(asked, err)
      missing.push({ part: refused.join(', '), sentence: err.failure.sentence })
      asked = asked.filter((f) => !refused.includes(f))
    }
  }
  // The flow asked is this Page's own: Meta answers it on the chosen Page's edge, and it must be that one.
  const rows = flowId ? read.rows.filter((r) => idText(r.id) === flowId) : read.rows
  if (flowId && !rows.length) throw new MetaLiveRefusal('Meta answers no welcome flow with that id on the chosen Page (only flows the business\'s Meta app made are listed), so it is not read.')
  return { pageId, rows, more: read.more, missing }
}

export const TEMPLATE_VIEWS = ['messenger', 'whatsapp', 'groups', 'group'] as const
export type TemplateView = typeof TEMPLATE_VIEWS[number]
export const TEMPLATE_STATUSES = ['APPROVED', 'IN_APPEAL', 'PENDING', 'REJECTED', 'PENDING_DELETION', 'DELETED', 'DISABLED', 'PAUSED', 'LIMIT_EXCEEDED', 'ARCHIVED'] as const
export const WHATSAPP_TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const
export const TEMPLATE_QUALITY = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const

export interface TemplateFilters {
  name?: string | null
  search?: string | null
  languages?: string[]
  statuses?: string[]
  categories?: string[]
  quality?: string[]
  from?: string | null
  to?: string | null
}

/** The template filters Meta documents, from checked values (name: lower case, digits and _; languages: locale codes). */
function templateQuery(input: TemplateFilters, whatsapp: boolean): Record<string, MetaQueryValue> {
  const query: Record<string, MetaQueryValue> = {}
  if (input.name) query.name = input.name
  if (input.search) query.name_or_content = input.search
  const list = (values: readonly string[]) => [...new Set(values)].join(',')
  if (input.languages?.length) query.language = list(input.languages)
  if (input.statuses?.length) query.status = list(input.statuses)
  if (whatsapp && input.categories?.length) query.category = list(input.categories)
  if (whatsapp && input.quality?.length) query.quality_score = list(input.quality)
  if (whatsapp && input.from) query.since = unixOf(input.from)
  if (whatsapp && input.to) query.until = unixOf(input.to, true)
  return query
}

const MESSENGER_TEMPLATE_GROUPS: FieldGroup[] = [{ name: 'template', fields: TEMPLATE_FIELDS.Messenger }, { name: 'review', fields: TEMPLATE_FIELDS.MessengerMore }]
const WHATSAPP_TEMPLATE_GROUPS: FieldGroup[] = [{ name: 'template', fields: TEMPLATE_FIELDS.WhatsApp }, { name: 'review', fields: TEMPLATE_FIELDS.WhatsAppMore }]

/** The chosen Page's Messenger utility templates, as Meta answers them. */
export async function readMessengerTemplates(account: MetaChosenAccount, filters: TemplateFilters = {}, maxRows = 500) {
  const pageId = pageOf(account)
  const read = await onPageRead(() => listGroups(account.connectionId, 'templates.messenger', `${pageId}/message_templates`, MESSENGER_TEMPLATE_GROUPS, templateQuery(filters, false), maxRows), UTILITY_ACCESS)
  return { pageId, ...read }
}

/**
 * The business's own WhatsApp account's templates, as Meta answers them (with Meta's total). `summary` goes on EVERY page
 * (review fix A5): a WhatsApp account's template read is then never shaped like a Page's, which the gateway reads only of
 * the chosen Page with that Page's own token.
 */
export async function readWhatsAppTemplates(account: MetaChosenAccount, waba: OwnWhatsApp, filters: TemplateFilters = {}, maxRows = 500) {
  return onAccess(() => listGroups(account.connectionId, 'templates.whatsapp', `${waba.wabaId}/message_templates`, WHATSAPP_TEMPLATE_GROUPS, { ...templateQuery(filters, true), summary: 'total_count' }, maxRows, true), WHATSAPP_ACCESS)
}

/** One template group of the business's own WhatsApp account: its owner checked first (its id and account alone), then the group. */
export async function readTemplateGroup(account: MetaChosenAccount, waba: OwnWhatsApp, groupIdArg: string | null | undefined): Promise<Row> {
  const groupId = metaObjectId(groupIdArg)
  if (!groupId) throw new MetaLiveRefusal('Name the template group (groupId, digits: from view groups or WhatsApp Manager).')
  const owner = (await onAccess(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'templates.groupOwnerCheck', path: groupId, query: { fields: 'id,whatsapp_business_account{id}' } }), WHATSAPP_ACCESS)).body as Row
  if (idText(owner.id) !== groupId || idText(obj(owner.whatsapp_business_account)?.id) !== waba.wabaId) throw new MetaLiveRefusal('That template group is not one of the business\'s own WhatsApp account, so it is not read.')
  const body = (await onAccess(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'templates.group', path: groupId, query: { fields: `${TEMPLATE_FIELDS.Group},${TEMPLATE_FIELDS.GroupTemplates}` } }), WHATSAPP_ACCESS)).body as Row
  if (idText(body.id) !== groupId) throw new MetaLiveRefusal('Meta answered with another template group than the one asked; nothing of it is read.')
  return body
}

// ── meta-conversations ──────────────────────────────────────────────────────────────────────────────────────────────

export const CONVERSATION_VIEWS = [
  'messenger', 'instagram', 'creators', 'messages', 'labels', 'thread-owner', 'call-permission', 'person-menu',
  'whatsapp-conversations', 'whatsapp-pricing', 'whatsapp-calls',
] as const
export type ConversationView = typeof CONVERSATION_VIEWS[number]

const THREAD_GROUPS: FieldGroup[] = [
  { name: 'conversation', fields: CONVERSATION_FIELDS.Thread }, { name: 'details', fields: CONVERSATION_FIELDS.ThreadDetails }, { name: 'routing', fields: CONVERSATION_FIELDS.ThreadRouting },
]
const MESSAGE_GROUPS: FieldGroup[] = [{ name: 'message', fields: CONVERSATION_FIELDS.Message }, { name: 'more', fields: CONVERSATION_FIELDS.MessageMore }]
/** Meta answers details of the 20 most recent messages of a conversation only. */
export const MAX_MESSAGES = 20

/**
 * A participant as Nexus hands it on: id, name (Messenger) or username (Instagram); never the e-mail Meta adds. Review fix
 * A9 — a Page or Instagram account another business in Nexus uses is its id and the flag only (LANE-BRIEF), even here.
 */
const personOf = (p: Row | null, taken: ReadonlySet<string>) => {
  if (!p) return null
  const id = idText(p.id)
  return id && taken.has(id) ? { id, takenByAnotherBusiness: true as const } : { id, name: text(p.name), username: text(p.username) }
}

/** The ids among these people that another business in Nexus uses as its Page or Instagram account (one look-up each). */
async function takenPeople(people: Array<Row | null>): Promise<Set<string>> {
  const ids = [...new Set(people.map((p) => idText(p?.id)).filter((id): id is string => !!id && /^\d{1,25}$/.test(id)))]
  if (!ids.length) return new Set()
  const [pages, instagram] = await Promise.all([takenIds('PAGE', ids), takenIds('INSTAGRAM', ids)])
  return new Set([...pages, ...instagram])
}

function conversationRow(r: Row, business: string[], taken: ReadonlySet<string>) {
  const people = rowsOf(r.participants)
  const id = text(r.id)
  return {
    conversationId: id,
    // B nit — an id Meta gave that Nexus would not read (not one of Meta's two thread-id forms): said, never guessed.
    ...(id && !META_THREAD_ID.test(id) ? { readable: false, readableNote: 'Nexus reads a conversation only by an id of Meta\'s t_<digits> or aWdf… form; this one is not, so view messages refuses it.' } : {}),
    updatedTime: text(r.updated_time),
    people: people.filter((p) => !business.includes(idText(p.id) ?? '')).map((p) => personOf(p, taken)),
    messageCount: num(r.message_count),
    unreadCount: num(r.unread_count),
    lastMessageSnippet: text(r.snippet),
    canReply: bool(r.can_reply),
    inboxLink: text(r.link),
    ...(typeof r.is_owner === 'boolean' ? { thisAppAnswers: r.is_owner } : {}),
  }
}

/** A message's story: `{id, link}` flat, or `{mention: {…}}` / `{reply_to: {…}}`. */
function storyOf(story: Row) {
  const inner = obj(story.mention) ?? obj(story.reply_to)
  const s = inner ?? story
  return { kind: obj(story.mention) ? 'mention' : obj(story.reply_to) ? 'reply' : null, storyId: idText(s.id), link: text(s.link) }
}

/** One message by named keys: who wrote it (the business or the person), to whom, the words and what came with them. */
export function messageRow(r: Row, business: string[], taken: ReadonlySet<string> = new Set()) {
  const from = obj(r.from)
  const story = obj(r.story)
  const replyTo = obj(r.reply_to)
  const fromId = idText(from?.id)
  return {
    messageId: text(r.id),
    createdTime: text(r.created_time),
    fromTheBusiness: fromId ? business.includes(fromId) : null,
    from: personOf(from, taken),
    to: rowsOf(r.to).map((p) => personOf(p, taken)),
    text: typeof r.message === 'string' ? r.message : null,
    attachments: rowsOf(r.attachments).map((a) => ({
      attachmentId: idText(a.id), name: text(a.name),
      url: text(a.file_url) ?? text(obj(a.image_data)?.url) ?? text(obj(a.video_data)?.url),
      kind: a.image_data ? 'image' : a.video_data ? 'video' : a.file_url ? 'file' : null,
    })),
    shares: rowsOf(r.shares).map((s) => ({ shareId: idText(s.id), name: text(s.name), description: text(s.description), type: text(s.type), url: text(s.url) })),
    // Reference/message: StoryReply / StoryMention {link, id} — flat, or under mention / reply_to (both read).
    story: story ? storyOf(story) : null,
    unsupported: r.is_unsupported === true ? true : undefined,
    replyToMessageId: text(replyTo?.mid),
  }
}

/** The person's last message among those read, and the end of the standard 24-hour window after it (said, not assumed). */
export function windowOf(messages: Array<ReturnType<typeof messageRow>>) {
  const last = messages.filter((m) => m.fromTheBusiness === false && m.createdTime).map((m) => Date.parse(m.createdTime!)).filter(Number.isFinite).sort((a, b) => b - a)[0]
  return {
    lastMessageFromPerson: last ? new Date(last).toISOString() : null,
    standardWindowEndsAt: last ? new Date(last + 24 * 3_600_000).toISOString() : null,
    rules: WINDOW_RULES,
  }
}

// WhatsApp analytics: Meta's enums (analytics.md; SDK whatsappbusinessaccount.py for the call dimensions' case).
export const WA_KINDS = { 'whatsapp-conversations': 'conversation_analytics', 'whatsapp-pricing': 'pricing_analytics', 'whatsapp-calls': 'call_analytics' } as const
export type WhatsAppAnalyticsView = keyof typeof WA_KINDS
export const WA_GRANULARITIES = { 'half-hour': 'HALF_HOUR', daily: 'DAILY', monthly: 'MONTHLY' } as const
export const WA_DIMENSIONS: Readonly<Record<WhatsAppAnalyticsView, readonly string[]>> = {
  'whatsapp-conversations': ['CONVERSATION_CATEGORY', 'CONVERSATION_DIRECTION', 'CONVERSATION_TYPE', 'COUNTRY', 'PHONE'],
  'whatsapp-pricing': ['COUNTRY', 'PHONE', 'PRICING_CATEGORY', 'PRICING_TYPE', 'TIER'],
  'whatsapp-calls': ['COUNTRY', 'DIRECTION', 'PHONE'],
}
export const WA_CATEGORIES: Readonly<Record<WhatsAppAnalyticsView, readonly string[]>> = {
  'whatsapp-conversations': ['AUTHENTICATION', 'MARKETING', 'SERVICE', 'UTILITY'],
  'whatsapp-pricing': ['AUTHENTICATION', 'AUTHENTICATION_INTERNATIONAL', 'MARKETING', 'MARKETING_LITE', 'SERVICE', 'UTILITY', 'REFERRAL_CONVERSION'],
  'whatsapp-calls': [],
}
export const WA_TYPES: Readonly<Record<WhatsAppAnalyticsView, readonly string[]>> = {
  'whatsapp-conversations': ['FREE_ENTRY_POINT', 'FREE_TIER', 'REGULAR'],
  'whatsapp-pricing': ['FREE_CUSTOMER_SERVICE', 'FREE_ENTRY_POINT', 'REGULAR'],
  'whatsapp-calls': [],
}
export const WA_DIRECTIONS: Readonly<Record<WhatsAppAnalyticsView, readonly string[]>> = {
  'whatsapp-conversations': ['BUSINESS_INITIATED', 'USER_INITIATED', 'UNKNOWN'],
  'whatsapp-pricing': [],
  'whatsapp-calls': ['BUSINESS_INITIATED', 'USER_INITIATED'],
}
/** Every value any WhatsApp filter takes (the tool's enums); each view takes its own (checked here). */
export const WA_ALL_DIMENSIONS = [...new Set(Object.values(WA_DIMENSIONS).flat())]
export const WA_ALL_CATEGORIES = [...new Set(Object.values(WA_CATEGORIES).flat())]
export const WA_ALL_TYPES = [...new Set(Object.values(WA_TYPES).flat())]
export const WA_ALL_DIRECTIONS = [...new Set(Object.values(WA_DIRECTIONS).flat())]
/** Meta keeps messaging, conversation and pricing analytics one year back (since 2025-12-01). */
export const WA_LOOKBACK_DAYS = 365

const jsonList = (values: readonly string[]) => `[${[...new Set(values)].map((v) => `"${v}"`).join(',')}]`

export interface WhatsAppAnalyticsFilters {
  from: string
  to: string
  granularity: keyof typeof WA_GRANULARITIES
  phoneNumbers?: readonly string[]
  countries?: readonly string[]
  dimensions?: readonly string[]
  categories?: readonly string[]
  types?: readonly string[]
  directions?: readonly string[]
}

/** Every filter value is one of this view's own (Meta's enums), before any call. */
function checkFilters(view: WhatsAppAnalyticsView, f: Partial<WhatsAppAnalyticsFilters>): void {
  const checks: Array<[string, readonly string[] | undefined, readonly string[]]> = [
    ['dimensions', f.dimensions, WA_DIMENSIONS[view]], ['categories', f.categories, WA_CATEGORIES[view]],
    ['types', f.types, WA_TYPES[view]], ['directions', f.directions, WA_DIRECTIONS[view]],
  ]
  for (const [name, values, allowed] of checks) {
    const bad = (values ?? []).filter((v) => !allowed.includes(v))
    if (bad.length) throw new MetaLiveRefusal(allowed.length ? `view ${view} takes ${name} ${allowed.join(', ')} only (not ${bad.join(', ')}).` : `view ${view} takes no ${name}.`)
  }
}

/**
 * The analytics field exactly as Meta's analytics guide writes it: `<field>.start(<unix>).end(<unix>).granularity(<G>)`
 * plus each filter as a JSON list (`.dimensions(["PHONE"])`) — built only from checked values (digits, ISO country codes,
 * Meta's enums).
 */
export function whatsappAnalyticsField(view: WhatsAppAnalyticsView, f: WhatsAppAnalyticsFilters, numbers: readonly string[]): string {
  const list = (name: string, values: readonly string[] | undefined) => (values?.length ? `.${name}(${jsonList(values)})` : '')
  const [categories, types, directions] = view === 'whatsapp-conversations'
    ? ['conversation_categories', 'conversation_types', 'conversation_directions']
    : view === 'whatsapp-pricing' ? ['pricing_categories', 'pricing_types', 'directions'] : ['categories', 'types', 'directions']
  return `${WA_KINDS[view]}.start(${unixOf(f.from)}).end(${unixOf(f.to, true)}).granularity(${WA_GRANULARITIES[f.granularity]})`
    + list('phone_numbers', numbers) + list('country_codes', f.countries) + list('dimensions', f.dimensions)
    + (view === 'whatsapp-calls' ? '' : list(categories, f.categories) + list(types, f.types))
    + (view === 'whatsapp-pricing' ? '' : list(directions, f.directions))
}

/** One data point by named keys; cost in minor units of the WhatsApp account's currency. */
function analyticsPoint(p: Row, currency: string | null) {
  return {
    start: isoOfUnix(p.start), end: isoOfUnix(p.end),
    phoneNumber: text(p.phone_number), country: text(p.country),
    conversationCategory: text(p.conversation_category), conversationType: text(p.conversation_type), conversationDirection: text(p.conversation_direction),
    pricingCategory: text(p.pricing_category), pricingType: text(p.pricing_type), tier: text(p.tier), direction: text(p.direction),
    conversations: num(p.conversation), messages: num(p.volume), calls: num(p.count), averageCallSeconds: num(p.average_duration),
    messagingCostCents: currency ? minorOf(decimalToMicros(p.cost), currency) : null,
  }
}

/** The data points of an analytics answer: `{data:[{data_points}]}` (conversations, pricing) or `{data_points}` (calls). */
const pointsOf = (v: unknown): Row[] => {
  const o = obj(v)
  if (!o) return []
  if (Array.isArray(o.data_points)) return rowsOf(o.data_points)
  return rowsOf(o).flatMap((d) => rowsOf(d.data_points))
}

export interface ConversationsInput extends Partial<WhatsAppAnalyticsFilters> {
  connectionId?: string | null
  view: ConversationView
  personId?: string | null
  conversationId?: string | null
  whatsappAccountId?: string | null
  maxRows?: number
}

const ANALYTICS_NOTES: Readonly<Record<WhatsAppAnalyticsView, string>> = {
  'whatsapp-conversations': 'Conversation-based pricing ended on 2025-07-01 (WhatsApp charges per message since) and Meta keeps these analytics one year back, so recent days answer nothing here: view whatsapp-pricing has the per-message numbers.',
  'whatsapp-pricing': 'Messages delivered and their approximate cost per category and type. FREE_ENTRY_POINT: messages in the free window a Click-to-WhatsApp ad opened — the messaging value of those ads. Volume tiers show only with dimensions TIER, PRICING_CATEGORY and COUNTRY.',
  'whatsapp-calls': 'Calls made and received, their average length and approximate cost.',
}

/** One view of the chosen Page's and Instagram account's conversations, or of the business's own WhatsApp account. */
export async function liveConversations(input: ConversationsInput) {
  // Arguments judged before any read of Meta.
  if (input.view in WA_KINDS) {
    if (!input.from || !input.to) throw new MetaLiveRefusal('Name the days (from and to, YYYY-MM-DD, UTC).')
    const bad = [input.from, input.to].find((d) => !isRealDay(d))
    if (bad) throw new MetaLiveRefusal(`"${bad}" is not a day (YYYY-MM-DD).`)
    if (unixOf(input.from) > unixOf(input.to)) throw new MetaLiveRefusal('from is after to.')
    if (input.view !== 'whatsapp-calls' && unixOf(input.from) < Math.floor(Date.now() / 1000) - WA_LOOKBACK_DAYS * 86_400) {
      throw new MetaLiveRefusal(`Meta keeps WhatsApp conversation and pricing analytics one year back (since 2025-12-01): from must be within the last ${WA_LOOKBACK_DAYS} days.`)
    }
    checkFilters(input.view as WhatsAppAnalyticsView, input)
  }
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 100)
  const business = [account.pageId, account.instagramId].filter((id): id is string => !!id)
  switch (input.view) {
    case 'messenger': {
      const pageId = pageOf(account)
      const personId = input.personId ? personIdOf(input.personId) : null
      const read = await onPageRead(() => listGroups(connectionId, 'messaging.messenger', `${pageId}/conversations`, THREAD_GROUPS, { platform: 'messenger', ...(personId ? { user_id: personId } : {}) }, maxRows), MESSENGER_ACCESS)
      const taken = await takenPeople(read.rows.flatMap((r) => rowsOf(r.participants)))
      return {
        pageId, platform: 'messenger', items: read.rows.map((r) => conversationRow(r, business, taken)), more: read.more, notRead: missingOf(read.missing),
        note: `The chosen Page's Messenger conversations, newest first (Meta has no time filter here). messages (conversationId) reads one. ${PEOPLES_DATA} An empty list may only mean Meta's Standard access: ${MESSENGER_ACCESS} ${PAGE_READ_NOTE}`,
        window: WINDOW_RULES,
      }
    }
    case 'instagram':
    case 'creators': {
      const { pageId, instagramId } = await instagramOnPage(account)
      const creators = input.view === 'creators'
      const personId = input.personId ? personIdOf(input.personId) : null
      const access = creators ? `${CREATOR_ACCESS} ${INSTAGRAM_ACCESS}` : INSTAGRAM_ACCESS
      const read = await onPageRead(() => listGroups(connectionId, `messaging.${creators ? 'creators' : 'instagram'}`, `${pageId}/conversations`, THREAD_GROUPS, { platform: 'instagram', ...(creators ? { folder: 'partnership' } : {}), ...(personId ? { user_id: personId } : {}) }, maxRows), access)
      const taken = await takenPeople(read.rows.flatMap((r) => rowsOf(r.participants)))
      return {
        pageId, instagramId, platform: 'instagram', ...(creators ? { folder: 'partnership' } : {}),
        items: read.rows.map((r) => conversationRow(r, business, taken)), more: read.more, notRead: missingOf(read.missing),
        note: creators
          ? `Conversations with creators in the Instagram Partnership folder (Creator Marketplace). Before a creator replies Meta allows 2 messages per 30 days per creator and 250 new creators a day. ${PEOPLES_DATA} ${CREATOR_ACCESS} ${PAGE_READ_NOTE}`
          : `The chosen Instagram account's Direct conversations, read through the Page it is linked to. ${PEOPLES_DATA} An empty list may only mean Meta's Standard access: ${INSTAGRAM_ACCESS} ${PAGE_READ_NOTE}`,
        window: WINDOW_RULES,
      }
    }
    case 'messages': {
      if (!input.conversationId) throw new MetaLiveRefusal('Name the conversation (conversationId, from view messenger, instagram or creators).')
      const own = await ownConversation(account, input.conversationId)
      const read = await onPageRead(() => listGroups(connectionId, 'messaging.messages', `${own.conversationId}/messages`, MESSAGE_GROUPS, {}, Math.min(maxRows, MAX_MESSAGES)), own.platform === 'instagram' ? INSTAGRAM_ACCESS : MESSENGER_ACCESS)
      const taken = new Set([...(await takenPeople(read.rows.flatMap((r) => [obj(r.from), ...rowsOf(r.to)]))), ...own.takenPersonIds])
      const items = read.rows.map((r) => messageRow(r, business, taken))
      return {
        conversationId: own.conversationId, platform: own.platform,
        personIds: own.personIds.map((id) => ({ id, takenByAnotherBusiness: taken.has(id) })),
        items, notRead: missingOf(read.missing), window: windowOf(items),
        note: `The conversation's most recent messages, newest first: Meta answers the details of the ${MAX_MESSAGES} most recent only (older ones answer as deleted). fromTheBusiness: written by the Page or the Instagram account. personIds: the people in it (their scoped ids, what a reply is sent to; takenByAnotherBusiness: a Page or Instagram account another business in Nexus uses — nothing more of it is shown). ${PEOPLES_DATA}`,
      }
    }
    case 'labels': {
      const read = await readPageLabels(account, maxRows)
      return {
        pageId: read.pageId, items: read.rows.map((r) => ({ labelId: idText(r.id), name: text(r.page_label_name) })), more: read.more,
        note: `The chosen Page's inbox labels (Meta adds Lead Complete, Lead Disqualified, Lead in Progress and Lead Incomplete to conversations from Messenger lead ads). One person's labels are not read: Meta reads them only with the person's id in the request's path, which Nexus's call log keeps, and Nexus keeps no person's id it does not need. Making, putting on and taking off labels: set-meta-conversation-labels. ${PAGE_READ_NOTE}`,
      }
    }
    case 'thread-owner': {
      const pageId = pageOf(account)
      const { personId, conversationId } = await ownPerson(account, input.personId, 'messenger')
      const body = firstOf((await onPageRead(() => metaReadOne({ connectionId }, { operation: 'messaging.threadOwner', path: `${pageId}/thread_owner`, query: { recipient: personId, fields: 'thread_owner' } }), MESSENGER_ACCESS)).body)
      const owner = obj(body?.thread_owner)
      return {
        pageId, personId, conversationId,
        threadOwner: owner ? { appId: idText(owner.app_id), expiresAt: isoOfUnix(owner.expiration) } : null,
        note: 'Which app answers this person now (Conversation Routing; Meta replaced the Handover Protocol with it, backwards compatible). Meta names the app only to the thread owner or the Page\'s default app; null: the thread is idle (no message from the person in 24 hours) or Meta did not say. Passing, releasing and taking control: create-meta-message action handover.',
      }
    }
    case 'call-permission': {
      const pageId = pageOf(account)
      const { personId, conversationId } = await ownPerson(account, input.personId, 'messenger')
      const body = firstOf((await onPageRead(() => metaReadOne({ connectionId }, { operation: 'messaging.callPermission', path: `${pageId}/messenger_call_permissions`, query: { psid: personId, fields: 'permission,actions' } }), MESSENGER_ACCESS)).body)
      const permission = obj(body?.permission)
      return {
        pageId, personId, conversationId,
        permission: permission ? { status: text(permission.status), expiresAt: isoOfUnix(permission.expiration_time) } : null,
        actions: rowsOf(body?.actions).map((a) => ({ action: text(a.action_name), canPerform: bool(a.can_perform), limits: rowsOf(a.limits).map((l) => ({ period: text(l.time_period), maxAllowed: num(l.max_allowed), used: num(l.current_usage) })) })),
        note: 'Whether this person allowed the Page to call them in Messenger (a permission lasts 7 days; at most 2 permission requests per conversation a day). Meta refuses when audio calling is off for the Page (view calling of meta-messaging-setup).',
      }
    }
    case 'person-menu': {
      const { pageId, personId, conversationId, body } = await readPersonMenu(account, input.personId)
      return {
        pageId, personId, conversationId,
        pageMenu: tidy(body?.page_level_persistent_menu ?? null), personMenu: tidy(body?.user_level_persistent_menu ?? null),
        note: 'The persistent menu this person sees: the Page\'s own, or one set for this person only (personMenu). Setting or removing a person\'s menu: set-meta-messaging-setup section person-menu.',
      }
    }
    case 'whatsapp-conversations':
    case 'whatsapp-pricing':
    case 'whatsapp-calls':
      return whatsappAnalytics(account, input as ConversationsInput & WhatsAppAnalyticsFilters, input.view, maxRows)
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

async function whatsappAnalytics(account: MetaChosenAccount, input: ConversationsInput & WhatsAppAnalyticsFilters, view: WhatsAppAnalyticsView, maxRows: number) {
  const pick = await ownWhatsApp(account, input.whatsappAccountId)
  if ('taken' in pick) return { whatsappAccount: { portfolioId: pick.taken.portfolioId, takenByAnotherBusiness: true }, sentence: pick.taken.sentence }
  const { waba } = pick
  const numbers = await ownNumbers(account, waba.wabaId, input.phoneNumbers ?? [])
  const field = whatsappAnalyticsField(view, { ...input, granularity: input.granularity ?? 'daily' }, numbers)
  const body = (await onAccess(() => metaReadOne({ connectionId: account.connectionId }, { operation: `whatsapp.${view}`, path: waba.wabaId, query: { fields: `id,${field}` } }), WHATSAPP_ACCESS)).body as Row
  if (idText(body.id) !== waba.wabaId) throw new MetaLiveRefusal('Meta answered for another WhatsApp account than the one asked; nothing of it is returned.')
  const points = pointsOf(body[WA_KINDS[view]])
  return {
    whatsappAccount: { whatsappAccountId: waba.wabaId, name: waba.name, currency: waba.currency, timeZoneId: waba.timeZoneId },
    from: input.from, to: input.to, granularity: input.granularity ?? 'daily', phoneNumbers: numbers.length ? numbers : 'all',
    items: points.slice(0, maxRows).map((p) => analyticsPoint(p, waba.currency)), more: points.length > maxRows,
    note: `${ANALYTICS_NOTES[view]} Days are UTC. messagingCostCents: Meta's approximate charge in minor units of the WhatsApp account's currency${waba.currency ? '' : ' (Meta named no currency, so no cost is given)'}; Meta gives no cost for an account billed through a Solution Partner's credit line. The business's own numbers only.`,
  }
}

// ── meta-message-templates ──────────────────────────────────────────────────────────────────────────────────────────

function templateRow(r: Row) {
  const quality = obj(r.quality_score)
  return {
    templateId: idText(r.id), name: text(r.name), category: text(r.category), language: text(r.language), status: text(r.status),
    components: tidy(r.components ?? null),
    parameterFormat: text(r.parameter_format), libraryTemplateName: text(r.library_template_name),
    subCategory: text(r.sub_category), quality: quality ? text(quality.score) : text(r.quality_score),
    rejectedReason: text(r.rejected_reason), rejectionReasons: tidy(r.rejection_reasons ?? null), specificRejectionReasons: tidy(r.specific_rejection_reasons ?? null),
    previousCategory: text(r.previous_category), correctCategory: text(r.correct_category),
    messageSendTtlSeconds: num(r.message_send_ttl_seconds), createdTime: text(r.creation_time) ?? isoOfUnix(r.creation_time), lastUpdatedTime: text(r.last_updated_time) ?? isoOfUnix(r.last_updated_time),
  }
}

export interface TemplatesInput extends TemplateFilters {
  connectionId?: string | null
  view: TemplateView
  whatsappAccountId?: string | null
  groupId?: string | null
  maxRows?: number
}

const TEMPLATE_REVIEW = 'Meta reviews every template before it can be sent (PENDING → APPROVED or REJECTED, with its reasons) and may change a WhatsApp template\'s category.'

/** Messenger utility templates of the chosen Page; WhatsApp templates and template groups of the business's own WhatsApp account. */
export async function liveMessageTemplates(input: TemplatesInput) {
  const bad = [input.from, input.to].find((d) => d && !isRealDay(d))
  if (bad) throw new MetaLiveRefusal(`"${bad}" is not a day (YYYY-MM-DD).`)
  if (input.view === 'messenger' && (input.categories?.length || input.quality?.length || input.from || input.to)) {
    throw new MetaLiveRefusal('Messenger templates are UTILITY only and take no categories, quality or days: those filters are for view whatsapp.')
  }
  if ((input.view === 'groups' || input.view === 'group') && (input.name || input.search || input.languages?.length || input.statuses?.length || input.categories?.length || input.quality?.length || input.from || input.to)) {
    throw new MetaLiveRefusal(`view ${input.view} takes no template filters (they are for views messenger and whatsapp).`)
  }
  const account = await metaChosenAccount(input.connectionId)
  const maxRows = clampRows(input.maxRows, 100)
  if (input.view === 'messenger') {
    const read = await readMessengerTemplates(account, input, maxRows)
    return {
      pageId: read.pageId, items: read.rows.map(templateRow), more: read.more, notRead: missingOf(read.missing),
      note: `The chosen Page's Messenger utility templates (order, shipping and account updates; never marketing). An APPROVED one may be sent outside the 24-hour window as a utility message (messaging_type UTILITY). ${TEMPLATE_REVIEW} Making, editing and deleting templates: set-meta-message-templates; sending an approved one: create-meta-message mode utility. ${PAGE_READ_NOTE}`,
    }
  }
  const pick = await ownWhatsApp(account, input.whatsappAccountId)
  if ('taken' in pick) return { whatsappAccount: { portfolioId: pick.taken.portfolioId, takenByAnotherBusiness: true }, sentence: pick.taken.sentence }
  const { waba } = pick
  const whatsappAccount = { whatsappAccountId: waba.wabaId, name: waba.name }
  switch (input.view) {
    case 'whatsapp': {
      const read = await readWhatsAppTemplates(account, waba, input, maxRows)
      return {
        whatsappAccount, totalCount: read.totalCount, items: read.rows.map(templateRow), more: read.more, notRead: missingOf(read.missing),
        note: `The business's WhatsApp templates (marketing, utility, authentication). from / to: last updated on those days (UTC). quality: Meta's GREEN, YELLOW, RED or UNKNOWN. ${TEMPLATE_REVIEW} Making and deleting templates and groups: set-meta-message-templates.`,
      }
    }
    case 'groups': {
      try {
        const read = await onAccess(() => listPaged(account.connectionId, 'templates.groups', `${waba.wabaId}/template_groups`, { fields: TEMPLATE_FIELDS.Group }, maxRows), WHATSAPP_ACCESS)
        return {
          whatsappAccount, items: read.rows.map((g) => ({ groupId: idText(g.id), name: text(g.name), description: text(g.description), createdTime: text(g.creation_time), updatedTime: text(g.update_time) })), more: read.more,
          note: 'Template groups track several templates\' numbers together (a template is in one group at a time). Meta documents this list only in its SDK: if it refuses, view group reads one group by its id (documented).',
        }
      } catch (err) {
        if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && !err.failure.authLost) {
          throw new MetaLiveRefusal(`Meta refused the list of template groups (${err.failure.sentence}). Meta documents this list only in its SDK; view group reads one group by its id, which Meta's WhatsApp guide documents.`)
        }
        throw err
      }
    }
    case 'group': {
      const body = await readTemplateGroup(account, waba, input.groupId)
      return {
        whatsappAccount,
        group: { groupId: idText(body.id), name: text(body.name), description: text(body.description), createdTime: text(body.creation_time), updatedTime: text(body.update_time) },
        templates: rowsOf(body.whatsapp_business_templates).map((t) => ({ templateId: idText(t.id), name: text(t.name), status: text(t.status), category: text(t.category), language: text(t.language) })),
        note: 'A template is in one group at a time; removing one keeps the numbers it already gave the group.',
      }
    }
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

// ── meta-messaging-setup ────────────────────────────────────────────────────────────────────────────────────────────

export const SETUP_VIEWS = ['profile', 'welcome-flows', 'personas', 'calling', 'features', 'chat-plugin', 'destinations', 'lead-templates'] as const
export type SetupView = typeof SETUP_VIEWS[number]

export interface SetupInput {
  connectionId?: string | null
  view: SetupView
  platform?: string | null
  flowId?: string | null
  personaId?: string | null
  leadTemplateId?: string | null
  maxRows?: number
}

/** An Instagram id another business in Nexus uses is its id and the flag only. */
async function instagramIdRow(id: string | null, chosen: string | null) {
  if (!id) return null
  if ((await takenIds('INSTAGRAM', [id])).has(id)) return { instagramId: id, takenByAnotherBusiness: true }
  return { instagramId: id, chosenHere: id === chosen, takenByAnotherBusiness: false }
}

/** The welcome-message JSON as Meta answers it (a JSON string, or already parsed). */
const jsonOf = (v: unknown) => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v) } catch { return v } }
const flowMessages = (r: Row) => jsonOf(r.welcome_message_flow ?? r.welcome_message)

/** The chosen Page's (and Instagram account's) messaging setup. */
export async function liveMessagingSetup(input: SetupInput) {
  if (input.platform && input.view !== 'profile' && input.view !== 'welcome-flows') throw new MetaLiveRefusal('platform is for views profile and welcome-flows only.')
  const account = await metaChosenAccount(input.connectionId)
  const maxRows = clampRows(input.maxRows, 100)
  switch (input.view) {
    case 'profile': {
      const platform: MessagingPlatform = input.platform === 'instagram' ? 'instagram' : 'messenger'
      const read = await readMessengerProfile(account, platform)
      const b = read.body
      return {
        pageId: read.pageId, platform,
        profile: {
          getStarted: tidy(b.get_started ?? null), greeting: tidy(b.greeting ?? null), iceBreakers: tidy(b.ice_breakers ?? null), persistentMenu: tidy(b.persistent_menu ?? null),
          allowlistedDomains: strings(b.whitelisted_domains), accountLinkingUrl: text(b.account_linking_url), commands: tidy(b.commands ?? null),
          subjectToNewEuPrivacyRules: bool(b.subject_to_new_eu_privacy_rules),
        },
        notRead: missingOf(read.missing),
        note: `What a person sees when they open a chat with the ${platform === 'instagram' ? 'Instagram account (ice breakers, menu)' : 'Page (Get Started button, greeting, ice breakers, menu)'}. People arriving from a click-to-message ad see that ad's own greeting and ice breakers instead (read both before changing either). subjectToNewEuPrivacyRules: Meta limits some features in Europe for this Page. ${PROFILE_NOTE} Changing it: set-meta-messaging-setup section profile. ${PAGE_READ_NOTE}`,
      }
    }
    case 'welcome-flows': {
      const platform = input.platform && (FLOW_PLATFORMS as readonly string[]).includes(input.platform) ? input.platform : null
      const read = await readWelcomeFlows(account, input.flowId ?? null, maxRows)
      const items = read.rows.map((r) => ({
        flowId: idText(r.id), name: text(r.name), platforms: strings(r.eligible_platforms), lastUpdated: text(r.last_update_time), usedInAnAd: bool(r.is_used_in_ad),
        instagramOnly: bool(r.is_ig_only_flow), compatiblePlatforms: strings(r.compatible_platforms),
        messages: tidy(flowMessages(r)), sequence: tidy(jsonOf(r.welcome_message_sequence)),
      })).filter((f) => !platform || f.platforms.includes(platform))
      return {
        pageId: read.pageId, platform: platform ?? 'all', items, more: read.more, notRead: missingOf(read.missing),
        note: `Welcome-message flows for Click-to-Messenger and Click-to-Instagram-Direct ads (an ad names one as partner_app_welcome_message_flow_id). Nexus reads the Page's flows (Instagram flows there are those whose platforms include instagram); flows made on the Instagram account itself through Instagram Login are not on this list. Meta lists only the flows the business's Meta app made. A flow used in an ad cannot be changed or deleted. Making, changing and deleting flows: set-meta-messaging-setup section welcome-flow. ${PAGE_READ_NOTE}`,
      }
    }
    case 'personas': {
      const personaId = input.personaId ? metaObjectId(input.personaId) : null
      if (input.personaId && !personaId) throw new MetaLiveRefusal(`"${input.personaId}" is not a persona id (digits).`)
      const read = await readPersonas(account, personaId ? 500 : maxRows)
      const items = read.rows.map((p) => ({ personaId: idText(p.id), name: text(p.name), pictureUrl: text(p.profile_picture_url) }))
      if (personaId) {
        const one = items.find((p) => p.personaId === personaId)
        if (!one) throw new MetaLiveRefusal('That persona is not one of the chosen Page\'s (among the first 500 Meta lists), so it is not read.')
        return { pageId: read.pageId, persona: one }
      }
      return { pageId: read.pageId, items, more: read.more, note: `Names and pictures the Page's replies can carry (a person or a bot answering for the Page). Making and deleting personas: set-meta-messaging-setup section persona (a deleted persona keeps its old messages). ${PAGE_READ_NOTE}` }
    }
    case 'calling': {
      const read = await readCallSettings(account)
      const b = read.body
      return {
        pageId: read.pageId,
        calling: { audioEnabled: bool(b.audio_enabled), videoEnabled: bool(b.video_enabled), callIconShown: bool(b.icon_enabled), callHours: tidy(b.call_hours ?? null), callRouting: tidy(b.call_routing ?? null) },
        notRead: missingOf(read.missing),
        note: `Messenger calling of the chosen Page: audio and video calls on or off, the call icon in chats, call hours (days not listed are closed) and where incoming calls ring (META: Meta's inboxes; PARTNERS: other apps). Changing them: set-meta-messaging-setup section calling. ${PAGE_READ_NOTE}`,
      }
    }
    case 'features': {
      const pageId = pageOf(account)
      const [review, status] = await Promise.all([
        part(() => onPageRead(() => listPaged(account.connectionId, 'setup.featureReview', `${pageId}/messaging_feature_review`, { fields: SETUP_FIELDS.Feature }, 100), MESSENGER_ACCESS)),
        part(() => onAccess(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'setup.featureStatus', path: pageId, query: { fields: 'id,messaging_feature_status' } }), PAGE_FIELDS_ACCESS)),
      ])
      const routing = obj(obj(status.value?.body)?.messaging_feature_status)
      return {
        pageId,
        featureReview: review.value ? review.value.rows.map((f) => ({ feature: text(f.feature), status: text(f.status) })) : null,
        routing: routing ? { conversationRoutingV2: bool(routing.hop_v2), messengerMultiApp: bool(routing.msgr_multi_app), instagramMultiApp: bool(routing.ig_multi_app) } : null,
        ...(review.notRead || status.notRead ? { notRead: [review.notRead && `feature review: ${review.notRead}`, status.notRead && `routing: ${status.notRead}`].filter(Boolean) } : {}),
        note: 'featureReview: the Page\'s submissions for subscription messaging and the gender, locale and time-zone profile fields (APPROVED, PENDING, REJECTED, LIMITED — limited: Meta withdrew it; see the Page Support Inbox). Meta lets no app read whether the Human Agent feature (HUMAN_AGENT tag) is approved: only a send that Meta refuses says so. routing: Conversation Routing for Messenger and Instagram.',
      }
    }
    case 'chat-plugin': {
      const pageId = pageOf(account)
      const body = firstOf((await onPageRead(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'setup.chatPlugin', path: `${pageId}/chat_plugin`, query: { fields: SETUP_FIELDS.ChatPlugin } }), MESSENGER_ACCESS)).body)
      return {
        pageId, chatPlugin: body ? tidy(body) : null,
        note: 'The settings of the Page\'s Messenger chat bubble for a website (read only: Meta has no API to change them). Meta no longer documents the website Chat Plugin, so these may be the settings of a discontinued plugin. null: Meta answers none for this Page.',
      }
    }
    case 'destinations':
      return destinations(account)
    case 'lead-templates':
      return leadTemplates(account, input.leadTemplateId ?? null, maxRows)
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

/** CR-271 — every messaging and Threads identity of the chosen Page and Instagram account, each part on its own. */
async function destinations(account: MetaChosenAccount) {
  const pageId = pageOf(account)
  const { connectionId } = account
  const page = await onAccess(() => pageIdentity(connectionId, pageId), PAGE_FIELDS_ACCESS)
  const b = page.body
  if (idText(b.id) !== pageId) throw new MetaLiveRefusal('Meta answered for another Page than the chosen one; nothing of it is returned.')
  const igId = account.instagramId
  const noIg = 'No Instagram account is chosen for this business.'
  const [iabp, linkedThreads, backedThreads, ctx] = await Promise.all([
    part(() => listGroups(connectionId, 'setup.iabp', `act_${account.adAccountId}/connected_instagram_accounts_with_iabp`, [{ name: 'account', fields: SETUP_FIELDS.Iabp }, { name: 'username', fields: SETUP_FIELDS.IabpMore }], account.businessId ? { business_id: account.businessId } : {}, 100)),
    igId ? part(() => metaReadOne({ connectionId }, { operation: 'setup.threadsLinked', path: `${igId}/connected_threads_user`, query: { fields: 'threads_user_id' } })) : Promise.resolve({ value: null, notRead: noIg }),
    igId ? part(() => metaReadOne({ connectionId }, { operation: 'setup.threadsBacked', path: `${igId}/instagram_backed_threads_user`, query: { fields: 'threads_user_id' } })) : Promise.resolve({ value: null, notRead: noIg }),
    part(() => onPageRead(() => metaReadOne({ connectionId }, { operation: 'setup.ctxEligibility', path: `${pageId}/ctx_optimization_eligibility`, query: { fields: 'ctm' } }), MESSENGER_ACCESS)),
  ])
  const iabpRows = iabp.value?.rows ?? []
  const taken = await takenIds('INSTAGRAM', iabpRows.map((r) => idText(r.id)).filter((id): id is string => !!id))
  const threadsId = (v: { value: { body: unknown } | null }) => idText(firstOf(v.value?.body)?.threads_user_id)
  const notRead = [
    ...page.missing.map((m) => `${m.part}: ${m.sentence}`),
    iabp.notRead && `Instagram accounts with a Page id: ${iabp.notRead}`, linkedThreads.notRead && `linked Threads account: ${linkedThreads.notRead}`,
    backedThreads.notRead && `Instagram-backed Threads account: ${backedThreads.notRead}`, ctx.notRead && `click-to-message eligibility: ${ctx.notRead}`,
  ].filter(Boolean)
  return {
    pageId,
    page: {
      hasWhatsAppNumber: bool(b.has_whatsapp_number), hasWhatsAppBusinessNumber: bool(b.has_whatsapp_business_number), whatsappNumber: text(b.whatsapp_number),
      instagramBusinessAccount: await instagramIdRow(idText(obj(b.instagram_business_account)?.id), igId),
      connectedInstagramAccount: await instagramIdRow(idText(obj(b.connected_instagram_account)?.id), igId),
      pageBackedThreadsAccountId: idText(b.page_backed_threads_account_id),
      messengerAdDefaults: { iceBreakers: strings(b.messenger_ads_default_icebreakers), quickReplies: strings(b.messenger_ads_default_quick_replies), quickRepliesType: text(b.messenger_ads_quick_replies_type) },
    },
    instagramAccountsWithPage: iabp.value ? iabpRows.map((r) => {
      const id = idText(r.id)
      return id && taken.has(id) ? { instagramId: id, takenByAnotherBusiness: true } : { instagramId: id, username: text(r.username), instagramBackedPageId: idText(r.iabp_id), chosenHere: id === igId, takenByAnotherBusiness: false }
    }) : null,
    instagramId: igId,
    threads: { linkedToInstagram: threadsId(linkedThreads), instagramBacked: threadsId(backedThreads), pageBacked: idText(b.page_backed_threads_account_id) },
    clickToMessageEligibility: ctx.value ? tidy(firstOf(ctx.value.body)) : null,
    ...(notRead.length ? { notRead } : {}),
    note: 'Where a messaging or Threads ad can send people: the Page\'s WhatsApp number (Click-to-WhatsApp), its Instagram account, Instagram accounts of the ad account with their Instagram-backed Page id (iabp: used as object_id when boosting an Instagram post), and the Threads account to run Threads ads as (linked to the Instagram account, Instagram-backed, or Page-backed). Threads accounts made after 2026-01-29 must be added to the business portfolio by hand. messengerAdDefaults: the Page\'s default ice breakers and quick replies for messaging ads (read only — Meta takes no change of them on the Page: they are set per ad, or as a welcome flow). clickToMessageEligibility: Meta\'s answer on click-to-message optimisation (its field ctm; Meta does not describe it further). Linking a WhatsApp number: set-meta-messaging-setup section whatsapp-number; making a Page- or Instagram-backed Threads account: create-meta-backed-account.',
  }
}

/** The Page's identity fields in groups (each group Meta refuses is named, step 6's readGroups), with the system-user token. */
function pageIdentity(connectionId: string, pageId: string): Promise<{ body: Row; missing: MissingPart[] }> {
  return readGroups(connectionId, 'setup.pageIdentity', pageId, [
    { name: 'identity', fields: SETUP_FIELDS.PageIdentity }, { name: 'threads', fields: SETUP_FIELDS.PageThreads }, { name: 'messenger-ad-defaults', fields: SETUP_FIELDS.PageAdDefaults },
  ])
}

const LEAD_TEMPLATE_ACCESS = 'Meta answers Messenger lead templates with pages_read_engagement, pages_read_user_content, pages_manage_ads or pages_manage_metadata (error 283 names them); 80005: too many lead calls for this Page.'

/** CR-209 — the Page's Messenger lead templates; one (checked in the list) with its steps (SDK get_steps). */
async function leadTemplates(account: MetaChosenAccount, idArg: string | null, maxRows: number) {
  const pageId = pageOf(account)
  const { connectionId } = account
  const id = idArg ? metaObjectId(idArg) : null
  if (idArg && !id) throw new MetaLiveRefusal(`"${idArg}" is not a Messenger lead template id (digits).`)
  const read = await onPageRead(() => listGroups(connectionId, 'setup.leadTemplates', `${pageId}/messenger_lead_forms`, [{ name: 'template', fields: SETUP_FIELDS.LeadTemplate }, { name: 'details', fields: SETUP_FIELDS.LeadTemplateMore }], {}, id ? 500 : maxRows), LEAD_TEMPLATE_ACCESS)
  const row = (r: Row) => ({ leadTemplateId: idText(r.id), privacyUrl: text(r.privacy_url), reminderText: text(r.reminder_text), stopQuestionMessage: text(r.stop_question_message), firstStepId: idText(r.first_step_id), leadFormId: idText(obj(r.fblead_form)?.id) })
  if (!id) {
    return { pageId, items: read.rows.map(row), more: read.more, notRead: missingOf(read.missing), note: `The Page's Messenger lead templates (automated question flows in Messenger lead ads). leadTemplateId reads one with its steps. Making one is a change tool (a later Nexus step). ${PAGE_READ_NOTE}` }
  }
  const found = read.rows.find((r) => idText(r.id) === id)
  if (!found) throw new MetaLiveRefusal('That lead template is not one of the chosen Page\'s Messenger lead templates (among the first 500 Meta lists), so it is not read.')
  // Meta lists a template's own node read (GET /{id}) as deprecated since v24; its steps are an SDK edge (system-user token).
  const steps = await part(() => listGroups(connectionId, 'setup.leadTemplateSteps', `${id}/steps`, [{ name: 'step', fields: SETUP_FIELDS.LeadStep }, { name: 'details', fields: SETUP_FIELDS.LeadStepMore }], {}, 100))
  const stepRow = (r: Row) => ({
    stepId: idText(r.id), stepType: text(r.step_type), message: text(r.message), replyType: text(r.reply_type), answers: strings(r.answers),
    nextStepIds: strings(r.next_step_ids), allowToSkip: bool(r.allow_to_skip), prefillType: text(r.prefill_type), optionsFormat: text(r.options_format),
    invalidReplyText: text(r.invalid_reply_text), answerValidation: bool(r.answer_validation_enabled),
  })
  const stepsNotRead = [steps.notRead && `steps: ${steps.notRead} (Meta's steps edge, reference messenger-ads-partial-automated-step-list/steps)`, ...(steps.value?.missing ?? []).map((m) => `steps' ${m.part}: ${m.sentence}`)].filter(Boolean)
  return {
    pageId, leadTemplate: row(found), steps: steps.value ? steps.value.rows.map(stepRow) : null,
    ...(stepsNotRead.length ? { notRead: stepsNotRead } : {}),
    note: 'The template\'s questions in order (steps). Meta answers a template\'s own node read only up to v23, so it is read from the Page\'s list.',
  }
}
