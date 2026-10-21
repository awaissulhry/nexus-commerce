/**
 * Meta ads step 14 (2026-10-21) — reads of lead forms, leads and comments, LIVE from Meta through the gateway (GET only).
 *
 * PEOPLE'S DATA. Leads and comments carry names, e-mails, phone numbers, user ids and messages. So:
 *   - nothing here stores, logs or caches a lead or a comment (no table; the gateway's ledger keeps the path and never the
 *     body of an answer that went well; the tools that answer them are Claude's door only, where a run keeps its mode and
 *     never its answer — meta-ads-engagement.tools.ts);
 *   - every answer keeps only NAMED keys (leadRow, facebookComment, instagramComment, …), never Meta's raw object;
 *   - leads, comments and lead forms are read ONLY through their own edges (`/{form}/leads`, `/{ad}/leads`,
 *     `/{form}/test_leads`, `/{post}/comments`, `/{comment}/comments`, `/{media}/comments`, `/{page}/leadgen_forms`): the
 *     gateway refuses `leads`, `comments`, `leadgen_forms` inside `fields` (meta-calls.ts FIELD_DENIED) and that stays.
 *
 * ONLY the business's chosen assets (metaChosenAccount), with fixed field lists per node type (a caller never names a Graph
 * field or path):
 *   - a lead form must be one of the chosen Page's `leadgen_forms` before anything of it is read (ownForm; when Meta will
 *     not list them, the form's own `page_id` must be the chosen Page — formOnPage, fail closed);
 *   - `/{ad}/leads` only for an ad of the chosen ad account (live.ts objectInAccount, kind 'ad');
 *   - one lead only when its ad is the chosen ad account's or its form the chosen Page's (ids read first, nothing else);
 *   - a Facebook post must be the chosen Page's (`<page id>_<post id>`, step 10's pagePostId + stillOnPage); a Facebook
 *     comment is confirmed by Meta before it or its replies are read (ownFacebookComment: its id carries the post's own id
 *     and Meta answers that same id, or its `object` is a photo or video the post is made of); a reply that does not carry
 *     that id is dropped and counted; a catalog-ad post must be one the chosen Page's post made (its dynamic_posts);
 *   - an Instagram media must be the chosen Instagram account's (step 10's ownMedia); an Instagram comment's media is read
 *     first (`media{id}`) and must be the chosen account's;
 *   - mentions and tags are read on the chosen Instagram account's own node;
 *   - Threads: only the Threads post of an ad of the chosen ad account (objectInAccount, then its creative's
 *     `threads_media_id`) and its direct replies (threadsMediaOf).
 *
 * Step 37 (set-meta-comments) uses these same checks for a comment change (ownFacebookComment, postOf, mediaOf,
 * ownInstagramComment, threadsMediaOf — exported, unchanged).
 *
 * Page reads go with the business's system-user token (master ACC-014, the Page's own token, is a later step): when Meta
 * refuses, the answer says so plainly (step 10's PAGE_TOKEN_NOTE) and LIVE-PROBES.md names the read to try once live.
 * Real leads need App Review (leads_retrieval) + Business Verification + a Live app (Owner decision D4 = B: forms and TEST
 * leads now): when Meta refuses a lead read, the answer says exactly that (LEADS_ACCESS).
 *
 * Checked 2026-10-21 (curl ≥3 s apart; developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/
 * retrieving.md and testing-troubleshooting.md, documentation/ads-commerce/graph-api/reference/adgroup/leads.md,
 * docs/graph-api/reference/object/comments and object/reactions, documentation/pages-api/comments-mentions.md,
 * documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments.md, ig-comment.md, ig-comment/replies.md,
 * ig-user/mentioned_comment.md, ig-user/mentioned_media.md, ig-user/tags.md, instagram-api-with-facebook-login/mentions.md,
 * documentation/ads-commerce/marketing-api/ad-creative/threads-ads/reply-moderation.md; and Meta's Python Business SDK main,
 * facebook_business/adobjects lead.py, leadgenform.py, page.py, pagepost.py, comment.py, rtbdynamicpost.py, igcomment.py,
 * igmedia.py, iguser.py, recommendation.py, profile.py):
 *   - leads: `/{form}/leads` and `/{ad}/leads` ("exists on both ad group and form nodes"; a form reused by many ads holds
 *     more leads than one ad); `filtering=[{field:"time_created", operator: LESS_THAN | GREATER_THAN |
 *     GREATER_THAN_OR_EQUAL, value: <unix>}]` (the guide shows it on the ad edge; the adgroup/leads page lists no
 *     parameter); fields created_time, id, ad_id, form_id, field_data, custom_disclaimer_responses (checkbox_key, is_checked
 *     "1" or ""), retailer_item_id (Advantage+ catalog ads for leads); is_organic, platform, ad / ad set / campaign ids and
 *     names are SDK lead.py only (their own group); `/{form}/test_leads` (GET: read test leads; Page token); one lead
 *     `/{lead id}`. The CSV export is `https://www.facebook.com/ads/lead_gen/export_csv/` — a www page, not the Graph API:
 *     Nexus calls Meta only through the gateway at graph.facebook.com (hard rule 4), so view export answers in words and
 *     view form with from / to reads the same leads for a date range.
 *   - forms: `/{page}/leadgen_forms` — the create guide reads it and SDK page.py has get_lead_gen_forms; the v26 edge page
 *     says reading "can't" (master LD-023 conflict: LIVE-PROBES); form fields: SDK leadgenform.py (the v26 form node page is
 *     not found) — never `creator` (a person); `is_eligible_for_in_thread_forms` is the create guide's (LD-024), its own
 *     group; statuses ACTIVE, ARCHIVED, DELETED, DRAFT (archiving and re-activating, POST /{form}, are step 36's).
 *   - Facebook comments: params filter (toplevel | stream), order (chronological | reverse_chronological), since (SDK
 *     datetime), summary (total_count changes with filter); "comment ids need the MODERATE task"; "/comments returns empty
 *     data for album, photo, post, video if read with a user token"; Comment fields (SDK comment.py). Reactions: only
 *     counts (`reactions.type(X).limit(0).summary(total_count)`; LIKE counts include CARE; type enum NONE, LIKE, LOVE, WOW,
 *     HAHA, SORRY, ANGRY); "a user or Page can only query their own reactions" — nobody's reaction is listed.
 *   - post/sharedposts (SDK pagepost.py get_shared_posts → Post); page/blocked (Profile; SDK params uid, user — not
 *     sent); page/ratings (Recommendation: created_time, has_rating, has_review, open_graph_story, rating,
 *     recommendation_type, review_text, reviewer); post/dynamic_posts (RTBDynamicPost: id, owner_id, product_id, …; edges
 *     comments, likes) — "you cannot use this endpoint to retrieve comments from Instagram".
 *   - Instagram: media/comments newest first, top level only, at most 50 per call, "cannot be filtered by timestamp" (so
 *     `since` is applied by Nexus on what Meta answered); media/ordered_comments (Facebook Login only; no media, user or
 *     legacy id; missing permission → empty data, not an error); IG Comment fields from, hidden, id, like_count, media{id,
 *     media_product_type}, parent_id, text, timestamp, username (username needs instagram_manage_comments since
 *     2024-08-27); comment/replies (no params); mentioned_comment.comment_id(<id>){…} and mentioned_media.media_id(<id>){…}
 *     on the chosen account's node; ig-user/tags (media_type, posted_after, posted_before; Meta gives cursors but no next
 *     link, so one page is read).
 *   - Threads ads: `/{threads media id}` and `/{id}/replies` with ads_read of the ad account that owns the ad (direct
 *     replies only; not for Advantage+ catalog ads, boosted posts, Instagram- or Page-backed Threads accounts); the v26
 *     ad-creative reference lists `threads_media_id` (and threads_user_id) without describing it, Meta's SDK has neither:
 *     when Meta refuses it, the answer says so (LIVE-PROBES).
 *   - lead form parts (SDK leadgencontextcard.py, leadgenthankyoupage.py, leadgenlegalcontent.py, leadgencustomdisclaimer.py,
 *     leadgenlegalcontentcheckbox.py, leadgenprivacypolicy.py); the in-thread list (create guide "Get a list of eligible
 *     lead forms": `fields=is_eligible_for_in_thread_forms` answers the eligible forms' ids).
 */
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, objectInAccount, type MetaChosenAccount } from './live.js'
import { fieldRefused, listGroups, listPaged, readGroups, type FieldGroup, type MissingPart } from './live-objects.js'
import { instagramOf, livePagePosts, onPage, ownMedia, PAGE_TOKEN_NOTE, pageOf, pagePostId, part, stillOnPage, tidy } from './live-media.js'

type Row = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const clampRows = (n: number | undefined, dflt: number) => Math.min(500, Math.max(1, Math.trunc(n ?? dflt)))
/** A day (YYYY-MM-DD, UTC) as Meta's unix seconds; `end`: the first second after that day. */
const unixOf = (day: string, end = false) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + (end ? 86_400 : 0)
/** Review fix A4 — a real calendar day (YYYY-MM-DD that parses and reads back the same: no 2026-13-01, no 2026-02-30). */
export function isRealDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const d = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day
}
/** The day after a day (YYYY-MM-DD, UTC). */
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
function realDays(...days: Array<string | null | undefined>): void {
  const bad = days.find((d) => d && !isRealDay(d))
  if (bad) throw new MetaLiveRefusal(`"${bad}" is not a day (YYYY-MM-DD).`)
}

// ── what Meta's words mean here ──────────────────────────────────────────────────────────────────────────────────────

/** D4 (Owner, 2026-10-20: B) — said whenever Meta refuses a lead read. */
export const LEADS_ACCESS = 'Real leads need three things from Meta that this business has not asked for yet (Owner decision D4): App Review of the business\'s Meta app for leads_retrieval (with pages_manage_ads), Business Verification, and the app switched to Live. Until then Meta answers TEST leads (view test) and leads of people with a role on the app; real leads stay in Meta\'s Leads Center (Meta Business Suite › All tools › Leads Center), where a person can read and download them. Leads Access Manager can also keep the system user out.'

/** Review B6 — Meta's Threads reply reads cover only some ads (threads-ads/reply-moderation, "Limitations"). */
export const THREADS_NOTE = 'Meta answers Threads ad posts and their direct replies (nested replies are not available) for single image, single video, carousel, placement asset customization ads, static and existing posts; not for Advantage+ catalog ads, boosted posts, or ads of an Instagram- or Page-backed Threads account. hideStatus HUSHED: hidden.'

/** Comments a system-user token may not see (object/comments: "/comments returns empty data … with a user token"). */
export const COMMENTS_EMPTY_NOTE = 'An empty list is not proof there are no comments: Meta answers the comments of Page posts, photos and videos to a Page token (with the MODERATE task for comment ids), and Nexus reads with the business\'s system-user token for now; the Page\'s own token comes with a later Nexus step.'

/**
 * A lead read Meta refused for the access the app lacks: Meta's words, then what it takes (D4) and the Page-token note.
 * Review fix A5 — a token Meta no longer accepts keeps step 2's lost-token sentence (onPage passes it on unchanged; only
 * Meta's "needs a Page Access Token" is answered as the Page-token way).
 */
async function onLeads<T>(work: () => Promise<T>): Promise<T> {
  return onPage(async () => {
    try {
      return await work()
    } catch (err) {
      if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && err.failure.permissionDenied) {
        throw new MetaLiveRefusal(`${err.message} ${LEADS_ACCESS} ${PAGE_TOKEN_NOTE}`)
      }
      throw err
    }
  })
}

/** At most this many pages of a list Meta pages without a next link (ig-user/tags). */
export const MAX_CURSOR_PAGES = 10

/**
 * Review fix B2 — a list Meta pages on `paging.cursors.after` with no next link, and filters after each page is chosen (a
 * page may be short or empty while more come): read page after page while a NEW cursor comes back, at most
 * MAX_CURSOR_PAGES; `more` whenever the last page read still gave one.
 */
async function cursorPages(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number) {
  const limit = Math.min(100, maxRows)
  const rows: Row[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_CURSOR_PAGES; page++) {
    const read = await metaReadOne<{ data?: unknown[]; paging?: { cursors?: { after?: unknown } } }>({ connectionId }, { operation, path, query: { ...query, limit, ...(after ? { after } : {}) } })
    rows.push(...(Array.isArray(read.body.data) ? read.body.data.filter((r): r is Row => !!obj(r)) : []))
    const next = typeof read.body.paging?.cursors?.after === 'string' && read.body.paging.cursors.after ? read.body.paging.cursors.after : null
    if (!next || next === after) return { rows: rows.slice(0, maxRows), more: rows.length > maxRows }
    if (rows.length >= maxRows) return { rows: rows.slice(0, maxRows), more: true }
    after = next
  }
  return { rows: rows.slice(0, maxRows), more: true }
}

const missingOf = (missing: MissingPart[]) => (missing.length ? missing : undefined)

// ── lead forms (meta-lead-forms) ─────────────────────────────────────────────────────────────────────────────────────

export const FORM_VIEWS = ['list', 'form'] as const
export type FormView = typeof FORM_VIEWS[number]
export const FORM_STATUSES = ['ACTIVE', 'ARCHIVED', 'DELETED', 'DRAFT'] as const

/** Fixed field lists of a lead form: the guides' fields first, the SDK's and the in-thread flag in groups of their own. */
export const FORM_FIELDS = {
  /** The create and retrieving guides read these (LD-023, LD-025: `fields=questions,name,status`). */
  ListCore: 'id,name,status',
  Core: 'id,name,status,questions',
  /** SDK leadgenform.py only. Never `creator` (a person). */
  Details: 'locale,created_time,leads_count,expired_leads_count,organic_leads_count',
  /**
   * Review fix B3 — the intro, thank-you page and legal content are nodes Meta answers as ids unless their fields are
   * named: SDK leadgencontextcard.py, leadgenthankyoupage.py, leadgenlegalcontent.py (privacy_policy: url, link_text;
   * custom_disclaimer: title, body{text}, checkboxes{key, text, is_required, is_checked_by_default}). The thank-you page's
   * phone number is the business's own.
   */
  Setup: 'privacy_policy_url,follow_up_action_url,follow_up_action_text,is_optimized_for_quality,block_display_for_non_targeted_viewer,allow_organic_lead,question_page_custom_headline,context_card{title,style,content,button_text},thank_you_page{title,body,button_type,button_text,website_url,business_phone_number},legal_content{privacy_policy,custom_disclaimer},tracking_parameters',
  /**
   * LD-024 — the create guide's Messenger (in-thread) list: `fields=is_eligible_for_in_thread_forms` on the Page's forms
   * answers the ids of the eligible forms (not in SDK leadgenform.py). Review fix B1: asked only for messengerOnly, as a
   * read of its own.
   */
  Messenger: 'id,is_eligible_for_in_thread_forms',
} as const

const FORM_LIST_GROUPS: FieldGroup[] = [
  { name: 'form', fields: FORM_FIELDS.ListCore }, { name: 'details', fields: FORM_FIELDS.Details },
]
const FORM_GROUPS: FieldGroup[] = [
  { name: 'form', fields: FORM_FIELDS.Core }, { name: 'details', fields: FORM_FIELDS.Details }, { name: 'setup', fields: FORM_FIELDS.Setup },
]

const FORM_STATUS_WORDS: Readonly<Record<string, string>> = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
  DRAFT: 'a draft (not published yet)',
}

/** At most this many of the chosen Page's forms are looked through to find one. */
export const MAX_FORMS = 500

function formRow(r: Row) {
  const status = text(r.status)
  return {
    formId: idText(r.id),
    name: text(r.name),
    status,
    statusText: status ? FORM_STATUS_WORDS[status] ?? status : null,
    locale: text(r.locale),
    createdTime: text(r.created_time),
    leadsCount: num(r.leads_count),
    expiredLeadsCount: num(r.expired_leads_count),
    organicLeadsCount: num(r.organic_leads_count),
  }
}

/** Review fix B3 — a form's intro, thank-you page and legal content, by named keys. */
function formSetup(b: Row) {
  const card = obj(b.context_card)
  const thanks = obj(b.thank_you_page)
  const legal = obj(b.legal_content)
  const policy = obj(legal?.privacy_policy)
  const disclaimer = obj(legal?.custom_disclaimer)
  const listOf = (v: unknown): Row[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : []).map(obj).filter((r): r is Row => !!r)
  return {
    intro: card ? { title: text(card.title), style: text(card.style), content: Array.isArray(card.content) ? (card.content as unknown[]).filter((c) => typeof c === 'string') : [], buttonText: text(card.button_text) } : null,
    thankYouPage: thanks ? { title: text(thanks.title), body: text(thanks.body), buttonType: text(thanks.button_type), buttonText: text(thanks.button_text), websiteUrl: text(thanks.website_url), businessPhoneNumber: text(thanks.business_phone_number) } : null,
    privacyPolicy: policy ? { url: text(policy.url), linkText: text(policy.link_text) } : null,
    consentBoxes: disclaimer ? {
      title: text(disclaimer.title),
      body: text(obj(disclaimer.body)?.text) ?? text(disclaimer.body),
      checkboxes: listOf(disclaimer.checkboxes).map((c) => ({ key: text(c.key), text: text(c.text), required: bool(c.is_required), checkedByDefault: bool(c.is_checked_by_default) })),
    } : null,
  }
}

/**
 * THE check before anything of a lead form is read: it is one of the chosen Page's `leadgen_forms` (its first 500). When
 * Meta will not list them (the v26 edge page says reading "can't"; master LD-023), the form is not read, and the answer
 * says why.
 */
export async function ownForm(account: MetaChosenAccount, id: string): Promise<string> {
  const pageId = pageOf(account)
  const formId = metaObjectId(id)
  if (!formId) throw new MetaLiveRefusal(`"${id}" is not a Meta lead form id (digits).`)
  let read: Awaited<ReturnType<typeof listPaged>>
  try {
    read = await listPaged(account.connectionId, 'leads.formOwnerCheck', `${pageId}/leadgen_forms`, { fields: 'id' }, MAX_FORMS)
  } catch (err) {
    // A throttle, no answer, the gateway or a token Meta no longer accepts ends the read as it is.
    if (!(err instanceof MetaReadError) || err.failure.origin !== 'meta' || err.failure.throttled || err.failure.transient || (err.failure.authLost && !/page access token/i.test(err.failure.sentence))) throw err
    return formOnPage(account, formId, pageId, err.failure.sentence)
  }
  if (read.rows.some((r) => idText(r.id) === formId)) return formId
  throw new MetaLiveRefusal(read.more
    ? `That form is not among the first ${MAX_FORMS} lead forms of the Facebook Page this business chose, so it is not read.`
    : 'That form is not one of the lead forms of the Facebook Page this business chose, so it is not read.')
}

/**
 * Review fix B7 — LD-023's fallback: when Meta will not list the Page's forms, the form's own `page_id` (SDK
 * leadgenform.py) must be the chosen Page (one read of its id and page_id alone). Anything else is refused (fail closed).
 */
async function formOnPage(account: MetaChosenAccount, formId: string, pageId: string, listRefused: string): Promise<string> {
  let body: Row
  try {
    body = (await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'leads.formPageCheck', path: formId, query: { fields: 'id,page_id' } }))).body as Row
  } catch (err) {
    const why = err instanceof MetaReadError ? err.failure.sentence : err instanceof MetaLiveRefusal ? err.message : null
    if (why === null || (err instanceof MetaReadError && err.failure.throttled)) throw err
    throw new MetaLiveRefusal(`Meta listed neither the chosen Page's lead forms (${listRefused}) nor the form's own Page (${why}), so Nexus cannot confirm the form is the Page's and does not read it.`)
  }
  if (idText(body.id) === formId && idText(body.page_id) === pageId) return formId
  throw new MetaLiveRefusal('That form is not one of the lead forms of the Facebook Page this business chose (Meta names another Page for it, or none), so it is not read.')
}

export interface FormsInput {
  connectionId?: string | null
  view: FormView
  formId?: string | null
  statuses?: string[]
  messengerOnly?: boolean
  maxRows?: number
}

/** One form of the chosen Page with its questions (LD-025), once its id is confirmed the Page's (view form). */
async function formView(account: MetaChosenAccount, pageId: string, formId: string) {
  const read = await onPage(() => readGroups(account.connectionId, 'leads.form', formId, FORM_GROUPS))
  const b = read.body
  return {
    pageId,
    form: {
      ...formRow(b),
      questions: tidy(b.questions ?? null),
      privacyPolicyUrl: text(b.privacy_policy_url),
      followUpActionUrl: text(b.follow_up_action_url),
      followUpActionText: text(b.follow_up_action_text),
      higherIntent: bool(b.is_optimized_for_quality),
      onlyForTargetedPeople: bool(b.block_display_for_non_targeted_viewer),
      allowsOrganicLeads: bool(b.allow_organic_lead),
      questionPageHeadline: text(b.question_page_custom_headline),
      ...formSetup(b),
      trackingParameters: tidy(b.tracking_parameters ?? null),
    },
    notRead: missingOf(read.missing),
    note: 'questions: what the form asks, in order (type FULL_NAME, EMAIL, PHONE, CUSTOM …; key is the name each answer carries in a lead). higherIntent: Meta adds a review step. Making, archiving or re-activating a form and making a test lead are change tools (a later Nexus step). The answers people gave are meta-leads.',
  }
}

/** The chosen Page's lead forms (LD-023, LD-024) and one form with its questions (LD-025). No person's data. */
export async function liveLeadForms(input: FormsInput) {
  const account = await metaChosenAccount(input.connectionId)
  const pageId = pageOf(account)
  const { connectionId } = account
  if (input.view === 'form') {
    if (!input.formId) throw new MetaLiveRefusal('Name the form (formId, from view list).')
    return formView(account, pageId, await ownForm(account, input.formId))
  }
  const maxRows = clampRows(input.maxRows, 100)
  const read = await onPage(() => listGroups(connectionId, 'leads.forms', `${pageId}/leadgen_forms`, FORM_LIST_GROUPS, {}, maxRows))
  const statuses = input.statuses?.length ? new Set(input.statuses) : null
  let items: Array<ReturnType<typeof formRow> & { sendableInMessenger?: true }> = read.rows.map(formRow)
    .filter((f) => f.formId && (!statuses || (f.status !== null && statuses.has(f.status))))
  let eligibleMore = false
  if (input.messengerOnly) {
    // Review fix B1 — the guide's own read: the ids it answers are the eligible forms (one Meta answers false is not).
    const eligible = await onPage(() => listPaged(connectionId, 'leads.formsInThread', `${pageId}/leadgen_forms`, { fields: FORM_FIELDS.Messenger }, MAX_FORMS))
    const ids = new Set(eligible.rows.filter((r) => r.is_eligible_for_in_thread_forms !== false).map((r) => idText(r.id)).filter((id): id is string => !!id))
    items = items.filter((f) => f.formId && ids.has(f.formId)).map((f) => ({ ...f, sendableInMessenger: true as const }))
    eligibleMore = eligible.more
  }
  return {
    pageId,
    items,
    more: read.more || eligibleMore,
    notRead: missingOf(read.missing),
    note: `The chosen Page's lead forms${input.messengerOnly ? ' that Meta lists as sendable inside a Messenger chat' : ''}, newest first as Meta lists them. leadsCount counts leads Meta still keeps (they expire after 90 days: expiredLeadsCount). Meta's v26 reference says this list cannot be read while its lead-ads guide reads it: if Meta refuses, its words say so.`,
  }
}

// ── leads (meta-leads) ───────────────────────────────────────────────────────────────────────────────────────────────

export const LEAD_VIEWS = ['form', 'ad', 'lead', 'test', 'export'] as const
export type LeadView = typeof LEAD_VIEWS[number]

/** Fixed field lists of a lead: the guide's first, the catalog item and the SDK's source fields in groups of their own. */
export const LEAD_FIELDS = {
  Core: 'id,created_time,ad_id,form_id,field_data,custom_disclaimer_responses',
  /** LD-034 — Advantage+ catalog ads for leads. */
  Catalog: 'retailer_item_id',
  /** SDK lead.py only. */
  Source: 'is_organic,platform,ad_name,adset_id,adset_name,campaign_id,campaign_name',
} as const
const LEAD_GROUPS: FieldGroup[] = [
  { name: 'lead', fields: LEAD_FIELDS.Core }, { name: 'catalog', fields: LEAD_FIELDS.Catalog }, { name: 'source', fields: LEAD_FIELDS.Source },
]

/** One lead as Nexus hands it on: named keys only. `consent` is Meta's answer as given ("1" checked, "" not). */
export function leadRow(r: Row) {
  const answers = Array.isArray(r.field_data) ? (r.field_data as unknown[]).map(obj).filter((a): a is Row => !!a).map((a) => ({
    question: text(a.name),
    values: Array.isArray(a.values) ? (a.values as unknown[]).filter((v) => typeof v === 'string' || typeof v === 'number').map(String) : [],
  })) : []
  const consent = Array.isArray(r.custom_disclaimer_responses) ? (r.custom_disclaimer_responses as unknown[]).map(obj).filter((c): c is Row => !!c).map((c) => ({
    checkboxKey: text(c.checkbox_key),
    isChecked: typeof c.is_checked === 'string' || typeof c.is_checked === 'boolean' || typeof c.is_checked === 'number' ? c.is_checked : null,
  })) : []
  return {
    leadId: idText(r.id),
    createdTime: text(r.created_time),
    formId: idText(r.form_id),
    adId: idText(r.ad_id),
    adName: text(r.ad_name),
    adSetId: idText(r.adset_id),
    adSetName: text(r.adset_name),
    campaignId: idText(r.campaign_id),
    campaignName: text(r.campaign_name),
    organic: bool(r.is_organic),
    platform: text(r.platform),
    catalogItemId: text(r.retailer_item_id),
    answers,
    consent,
  }
}

/** The time filter of a leads read (UTC days), exactly Meta's documented shape. */
export function leadTimeFilter(from?: string | null, to?: string | null) {
  realDays(from, to)
  const filter: Array<{ field: 'time_created'; operator: 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN'; value: number }> = []
  if (from) filter.push({ field: 'time_created', operator: 'GREATER_THAN_OR_EQUAL', value: unixOf(from) })
  if (to) filter.push({ field: 'time_created', operator: 'LESS_THAN', value: unixOf(to, true) })
  if (from && to && unixOf(from) >= unixOf(to, true)) throw new MetaLiveRefusal('from is after to.')
  return filter
}

export interface LeadsInput {
  connectionId?: string | null
  view: LeadView
  formId?: string | null
  adId?: string | null
  leadId?: string | null
  from?: string | null
  to?: string | null
  maxRows?: number
}

const LEADS_NOTE = 'Each lead: when, from which form and ad (organic: no ad), the answers by question key, and the consent boxes as Meta gives them (isChecked "1" ticked, "" not). Nexus keeps none of it: use it now and pass it on only where the person asks. Meta keeps leads 90 days.'

/** One lead: read only when its ad is the chosen account's or its form the chosen Page's (its ids first, nothing else). */
async function ownLead(account: MetaChosenAccount, id: string): Promise<string> {
  const leadId = metaObjectId(id)
  if (!leadId) throw new MetaLiveRefusal(`"${id}" is not a Meta lead id (digits).`)
  const ids = (await onLeads(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'leads.leadOwnerCheck', path: leadId, query: { fields: 'id,ad_id,form_id' } }))).body as Row
  const adId = idText(ids.ad_id)
  const formId = idText(ids.form_id)
  const why: string[] = []
  if (adId) {
    try { await objectInAccount(account, adId, 'ad', 'leads.leadAdCheck'); return leadId } catch (err) { if (!(err instanceof MetaLiveRefusal)) throw err; why.push(err.message) }
  }
  if (formId) {
    try { await ownForm(account, formId); return leadId } catch (err) { if (!(err instanceof MetaLiveRefusal)) throw err; why.push(err.message) }
  }
  throw new MetaLiveRefusal(`That lead came neither from an ad of the ad account this business chose nor from a form of its chosen Page, so it is not read.${why.length ? ` (${why.join(' ')})` : ''}`)
}

/** Leads of a form, an ad (also a call ad's callback requests), one lead, a form's test leads; the export in words. */
export async function liveLeads(input: LeadsInput) {
  if (input.view === 'export') {
    return {
      view: 'export',
      notRead: 'Nexus does not download Meta\'s lead file: Meta serves it on www.facebook.com (ads/lead_gen/export_csv, a signed-in person\'s download), not on the Graph API, and Nexus calls Meta only through its gateway on the Graph API.',
      instead: 'view form with formId, from and to reads the same leads for those days (organic tells organic leads apart, as the file\'s is_organic does); a person can download the file in Meta\'s Leads Center or Forms library.',
    }
  }
  // Review fix A6 — the arguments are judged before any read of Meta (the form's check reads the Page's forms).
  if (input.view === 'test' && (input.from || input.to)) throw new MetaLiveRefusal('Test leads take no days (a form holds at most one).')
  const filtering = input.view === 'form' || input.view === 'ad' ? leadTimeFilter(input.from, input.to) : []
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 100)
  if (input.view === 'lead') {
    if (!input.leadId) throw new MetaLiveRefusal('Name the lead (leadId, from a leads view or Meta\'s lead notification).')
    const leadId = await ownLead(account, input.leadId)
    const read = await onLeads(() => readGroups(connectionId, 'leads.lead', leadId, LEAD_GROUPS))
    return { lead: leadRow(read.body), notRead: missingOf(read.missing), note: LEADS_NOTE }
  }
  let path: string
  let subject: Row
  if (input.view === 'ad') {
    if (!input.adId) throw new MetaLiveRefusal('Name the ad (adId).')
    const adId = await objectInAccount(account, input.adId, 'ad', 'leads.adCheck')
    path = `${adId}/leads`
    subject = { adId }
  } else {
    if (!input.formId) throw new MetaLiveRefusal('Name the form (formId, from meta-lead-forms view list).')
    const formId = await ownForm(account, input.formId)
    path = `${formId}/${input.view === 'test' ? 'test_leads' : 'leads'}`
    subject = { formId }
  }
  const read = await onLeads(() => listGroups(connectionId, `leads.${input.view}`, path, LEAD_GROUPS, filtering.length ? { filtering } : {}, maxRows))
  return {
    ...subject,
    from: input.from ?? null,
    to: input.to ?? null,
    items: read.rows.map(leadRow),
    more: read.more,
    notRead: missingOf(read.missing),
    note: input.view === 'test'
      ? 'Test leads of the form (one per form; made with Meta\'s lead ads testing tool, or by a later Nexus change). They are not tied to any ad.'
      : `${input.view === 'ad' ? 'The leads of this ad only (a form used by several ads holds more: view form). For a call ad these are its callback requests. ' : ''}${LEADS_NOTE} An empty list may only mean Meta does not let the app read real leads yet (D4: App Review for leads_retrieval, Business Verification, a Live app); real leads are in Meta's Leads Center.`,
  }
}

// ── comments and engagement (meta-comments) ─────────────────────────────────────────────────────────────────────────

export const COMMENT_VIEWS = [
  'post', 'comment', 'replies', 'engagement', 'shares', 'dynamic-posts', 'dynamic-comments',
  'instagram', 'instagram-ordered', 'instagram-comment', 'instagram-replies', 'mentioned-comment', 'mentioned-media', 'tags',
  'blocked', 'reviews', 'threads', 'threads-replies',
] as const
export type CommentView = typeof COMMENT_VIEWS[number]
export const COMMENT_FILTERS = ['toplevel', 'stream'] as const
export const COMMENT_ORDERS = ['newest', 'oldest'] as const
/**
 * The reaction types Nexus counts: Meta's SDK names (profile.py Type: SAD for the sad face; the v26 reactions page writes
 * SORRY, asked only when Meta refuses SAD). CARE is a type of its own in the SDK (the reactions page says LIKE counts
 * include it): Nexus does not count it apart.
 */
export const REACTION_TYPES = ['LIKE', 'LOVE', 'WOW', 'HAHA', 'SAD', 'ANGRY'] as const
export const TAG_MEDIA_TYPES = ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'] as const
/** view dynamic-posts reads two counts per catalog-ad post: at most this many posts. */
export const MAX_DYNAMIC_POSTS = 25

/** Fixed field lists per node type: the ONLY fields these reads ask. */
export const COMMENT_FIELDS = {
  /** Comment (SDK comment.py): `from` is who wrote it (a Page-scoped id and name). */
  Facebook: 'id,created_time,message,from{id,name},like_count,comment_count,is_hidden,can_hide,can_remove,can_reply_privately,can_comment,parent{id},permalink_url,attachment{type,url}',
  /** One comment also: whether it is private, and the private reply already sent (EN-004). */
  FacebookMore: 'is_private,private_reply_conversation{id}',
  Instagram: 'id,text,timestamp,username,from{id,username},like_count,hidden,parent_id',
  /** ordered_comments answers no media, user or legacy id. */
  InstagramOrdered: 'id,text,timestamp,username,from{id,username},like_count,hidden,parent_id',
  InstagramOne: 'id,text,timestamp,username,from{id,username},like_count,hidden,parent_id,media{id,media_product_type}',
  Share: 'id,created_time,permalink_url,from{id,name},message',
  DynamicPost: 'id,owner_id,product_id,title,created',
  Blocked: 'id,name',
  Review: 'created_time,has_rating,has_review,rating,recommendation_type,review_text,reviewer{id,name},open_graph_story{id}',
  MentionedComment: 'id,text,timestamp,like_count,media{id,permalink,username}',
  MentionedMedia: 'id,caption,media_type,media_url,timestamp,username,like_count,comments_count',
  Tagged: 'id,caption,media_type,permalink,timestamp,username,like_count,comments_count',
  /** Review fix B6 — the v26 ad-creative field that names an ad's Threads post (its meaning is not described). */
  ThreadsCreative: 'id,account_id,creative{id,threads_media_id}',
  /** threads-ads/reply-moderation: the ad's Threads post and its direct replies (owner_profile_pic not asked). */
  ThreadsMedia: 'id,caption,like_count,username,reply_count,share_count,quote_count,repost_count,hide_status,timestamp,media_url,media_type,gif_url,is_owner_verified',
  ThreadsReply: 'id,caption,like_count,username,reply_count,share_count,quote_count,repost_count,hide_status,timestamp,media_url,media_type',
  /** Review fix B5 — what a photo or video post is made of (its attachments' targets), and a comment's own object. */
  PostTargets: 'id,attachments{target{id}}',
  CommentObject: 'id,object{id}',
} as const

/**
 * A Facebook comment id and its post of the chosen Page, by shape: Meta numbers a comment `<post id>_<comment id>` (the
 * post's own part); `prefixMatches` says whether this one does (a comment on a photo or video post carries that photo's or
 * video's id instead: ownFacebookComment then asks Meta).
 */
export function facebookCommentId(pageId: string, postId: string, commentId: string): { postId: string; commentId: string; ownPart: string; prefixMatches: boolean } {
  const post = pagePostId(pageId, postId)
  const ownPart = post.slice(pageId.length + 1)
  const value = commentId.trim()
  if (!/^\d{1,25}_\d{1,25}$/.test(value)) throw new MetaLiveRefusal(`"${commentId}" is not a Facebook comment id (<post id>_<comment id>, as the comment views give it).`)
  return { postId: post, commentId: value, ownPart, prefixMatches: value.startsWith(`${ownPart}_`) }
}

const NOT_ON_POST = 'That comment is not on that post of the Facebook Page this business chose, so it is not read.'

/**
 * Review fixes A1, B5 — THE check before a Facebook comment or its replies are read: the post is the chosen Page's
 * (postOf), and Meta itself confirms the comment, by one read of its id alone (the same id must come back) — or, when its
 * id does not carry the post's own id, by its `object` (a photo's or video's comment) being one the post is made of
 * (the post's attachments' targets). Anything else is refused (fail closed). Returns the id prefixes the comment's replies
 * may carry.
 */
export async function ownFacebookComment(account: MetaChosenAccount, postIdArg: string, commentIdArg: string): Promise<{ postId: string; commentId: string; prefixes: string[] }> {
  const pageId = pageOf(account)
  const shape = facebookCommentId(pageId, postIdArg, commentIdArg)
  const postId = await postOf(account, { view: 'comment', postId: shape.postId })
  const read = (fields: string, operation: string, path = shape.commentId) => onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation, path, query: { fields } }))
  if (shape.prefixMatches) {
    const body = (await read('id', 'comments.commentCheck')).body as Row
    if (idText(body.id) !== shape.commentId) throw new MetaLiveRefusal(`${NOT_ON_POST} (Meta answered another comment for that id.)`)
    return { postId, commentId: shape.commentId, prefixes: [shape.ownPart] }
  }
  const post = (await read(COMMENT_FIELDS.PostTargets, 'comments.postTargets', postId)).body as Row
  const targets = new Set(rowsOfList(post.attachments).map((a) => idText(obj(a.target)?.id)).filter((id): id is string => !!id))
  let body: Row
  try {
    body = (await read(COMMENT_FIELDS.CommentObject, 'comments.commentObjectCheck')).body as Row
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && /nonexisting field/i.test(err.failure.sentence)) throw new MetaLiveRefusal(NOT_ON_POST)
    throw err
  }
  const objectId = idText(obj(body.object)?.id)
  if (idText(body.id) !== shape.commentId || !objectId || !targets.has(objectId)) throw new MetaLiveRefusal(NOT_ON_POST)
  // Re-review 1 — a post can carry ANOTHER Page's photo or video it shared: the object must be the chosen Page's own
  // (Photo and Video both answer `from`), one read of its id and author alone; any other answer is refused.
  let owner: Row
  try {
    owner = (await read('id,from{id}', 'comments.objectOwnerCheck', objectId)).body as Row
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && !err.failure.authLost) throw new MetaLiveRefusal(NOT_ON_POST)
    throw err
  }
  if (idText(owner.id) !== objectId || idText(obj(owner.from)?.id) !== pageId) throw new MetaLiveRefusal(`${NOT_ON_POST} (its photo or video is not the chosen Page's own.)`)
  return { postId, commentId: shape.commentId, prefixes: [shape.ownPart, objectId] }
}

/** Rows of a list Meta answers as `{ data: [...] }` (or a bare list). */
const rowsOfList = (v: unknown): Row[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : []).map(obj).filter((r): r is Row => !!r)

/** Who wrote it, in words: the chosen Page itself or a person (the person's name and Page-scoped id as Meta gives them). */
export function facebookComment(pageId: string, r: Row) {
  const from = obj(r.from)
  const attachment = obj(r.attachment)
  return {
    commentId: idText(r.id),
    createdTime: text(r.created_time),
    message: text(r.message),
    byThePage: from ? idText(from.id) === pageId : null,
    by: from ? { id: idText(from.id), name: text(from.name) } : null,
    likes: num(r.like_count),
    replies: num(r.comment_count),
    hidden: bool(r.is_hidden),
    canHide: bool(r.can_hide),
    canRemove: bool(r.can_remove),
    canReplyPrivately: bool(r.can_reply_privately),
    canReply: bool(r.can_comment),
    parentCommentId: idText(obj(r.parent)?.id),
    permalink: text(r.permalink_url),
    attachment: attachment ? { type: text(attachment.type), url: text(attachment.url) } : null,
  }
}

export function instagramComment(instagramId: string | null, r: Row) {
  const from = obj(r.from)
  const media = obj(r.media)
  return {
    commentId: idText(r.id),
    createdTime: text(r.timestamp),
    text: text(r.text),
    byTheAccount: from && instagramId ? idText(from.id) === instagramId : null,
    by: from || r.username ? { id: idText(from?.id), username: text(from?.username) ?? text(r.username) } : null,
    likes: num(r.like_count),
    hidden: bool(r.hidden),
    parentCommentId: idText(r.parent_id),
    ...(media ? { mediaId: idText(media.id), mediaProductType: text(media.media_product_type) } : {}),
  }
}

export interface CommentsInput {
  connectionId?: string | null
  view: CommentView
  postId?: string | null
  adId?: string | null
  commentId?: string | null
  mediaId?: string | null
  dynamicPostId?: string | null
  filter?: string | null
  order?: string | null
  since?: string | null
  from?: string | null
  to?: string | null
  mediaTypes?: string[]
  maxRows?: number
}

/** The chosen Page's post a view is about: postId, or the post behind one of the chosen account's ads (step 10's ad-post). */
export async function postOf(account: MetaChosenAccount, input: CommentsInput): Promise<string> {
  const pageId = pageOf(account)
  let postId = input.postId ?? null
  if (!postId && input.adId) {
    const behind = await livePagePosts({ connectionId: account.connectionId, view: 'ad-post', adId: input.adId }) as { facebookPostId?: string | null }
    if (!behind.facebookPostId) throw new MetaLiveRefusal('Meta names no Facebook post behind that ad (an Instagram-only or catalog ad): try view instagram with the adId.')
    postId = behind.facebookPostId
  }
  if (!postId) throw new MetaLiveRefusal('Name the post (postId, from meta-page-posts) or the ad (adId).')
  const own = pagePostId(pageId, postId)
  // Meta's own id for it must still be the chosen Page's (step 10's check), one read of its id alone.
  const check = await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'comments.postCheck', path: own, query: { fields: 'id' } }))
  stillOnPage(pageId, check.body as Row)
  return own
}

/** The chosen Instagram account's media a view is about: mediaId, or the Instagram media behind one of the chosen account's ads. */
export async function mediaOf(account: MetaChosenAccount, input: CommentsInput): Promise<string> {
  instagramOf(account)
  let mediaId = input.mediaId ?? null
  if (!mediaId && input.adId) {
    const behind = await livePagePosts({ connectionId: account.connectionId, view: 'ad-post', adId: input.adId }) as { instagramMediaId?: string | null }
    if (!behind.instagramMediaId) throw new MetaLiveRefusal('Meta names no Instagram media behind that ad (Meta gives none for Advantage+ catalog ads): try view post with the adId.')
    mediaId = behind.instagramMediaId
  }
  if (!mediaId) throw new MetaLiveRefusal('Name the Instagram media (mediaId, from meta-instagram-media) or the ad (adId).')
  return (await ownMedia(account, mediaId)).mediaId
}

/** An Instagram comment of the chosen account's media: its media is read first (`media{id}` alone), then checked. */
export async function ownInstagramComment(account: MetaChosenAccount, id: string): Promise<{ commentId: string; mediaId: string }> {
  instagramOf(account)
  const commentId = metaObjectId(id)
  if (!commentId) throw new MetaLiveRefusal(`"${id}" is not an Instagram comment id (digits).`)
  let body: Row
  try {
    body = (await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'comments.instagramOwnerCheck', path: commentId, query: { fields: 'id,media{id}' } }))).body as Row
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && /nonexisting field/i.test(err.failure.sentence)) throw new MetaLiveRefusal('That id is not an Instagram comment, so it is not read.')
    throw err
  }
  const mediaId = idText(obj(body.media)?.id)
  if (!mediaId) throw new MetaLiveRefusal('Meta did not say which Instagram media that comment is on, so it is not read.')
  return { commentId, mediaId: (await ownMedia(account, mediaId)).mediaId }
}

/** The query of a Facebook comments read: Meta's filter and order, and `since` (a UTC day, Meta's datetime). */
function facebookQuery(input: CommentsInput, fields: string): Record<string, MetaQueryValue> {
  const query: Record<string, MetaQueryValue> = { fields, summary: true, order: input.order === 'oldest' ? 'chronological' : 'reverse_chronological' }
  if (input.filter) query.filter = input.filter
  if (input.since) query.since = unixOf(input.since)
  return query
}

/** Instagram answers no time filter: Nexus keeps what Meta answered from `since` on (UTC). */
const sinceKept = (rows: Row[], since: string | null | undefined) => (since ? rows.filter((r) => { const t = Date.parse(text(r.timestamp) ?? ''); return Number.isFinite(t) && t >= unixOf(since) * 1000 }) : rows)

/** One view of the comments on the chosen Page's posts and the chosen Instagram account's media, and around them. */
export async function liveComments(input: CommentsInput) {
  if (input.since) realDays(input.since)
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId } = account
  const maxRows = clampRows(input.maxRows, 100)
  switch (input.view) {
    case 'post': {
      const pageId = pageOf(account)
      const postId = await postOf(account, input)
      const read = await onPage(() => listPaged(connectionId, 'comments.post', `${postId}/comments`, facebookQuery(input, COMMENT_FIELDS.Facebook), maxRows))
      return {
        pageId, postId, filter: input.filter ?? 'toplevel', order: input.order ?? 'newest', since: input.since ?? null,
        totalCount: read.totalCount, items: read.rows.map((r) => facebookComment(pageId, r)), more: read.more,
        note: `toplevel: comments on the post itself (replies: view replies); stream: every comment and reply in time order. totalCount is Meta's count for that filter (it can be higher than what Meta shows, for privacy or deleted comments). Replying, hiding and deleting: set-meta-comments. ${COMMENTS_EMPTY_NOTE}`,
      }
    }
    case 'comment':
    case 'replies': {
      const pageId = pageOf(account)
      if (!input.commentId) throw new MetaLiveRefusal('Name the comment (commentId) and its post (postId).')
      if (!input.postId) throw new MetaLiveRefusal('Name the comment\'s post too (postId): a comment is read only on a post of the chosen Page.')
      const own = await ownFacebookComment(account, input.postId, input.commentId)
      const ids = { postId: own.postId, commentId: own.commentId }
      if (input.view === 'replies') {
        const read = await onPage(() => listPaged(connectionId, 'comments.replies', `${ids.commentId}/comments`, facebookQuery(input, COMMENT_FIELDS.Facebook), maxRows))
        // Review fix A1 — a reply that does not carry the post's (or its photo's or video's) id is not shown, only counted.
        const kept = read.rows.filter((r) => own.prefixes.some((p) => idText(r.id)?.startsWith(`${p}_`)))
        return {
          pageId, ...ids, totalCount: read.totalCount, items: kept.map((r) => facebookComment(pageId, r)), droppedNotOnPost: read.rows.length - kept.length, more: read.more,
          note: COMMENTS_EMPTY_NOTE,
        }
      }
      const read = await onPage(() => readGroups(connectionId, 'comments.comment', ids.commentId, [{ name: 'comment', fields: COMMENT_FIELDS.Facebook }, { name: 'private', fields: COMMENT_FIELDS.FacebookMore }]))
      if (idText(read.body.id) !== ids.commentId) throw new MetaLiveRefusal('Meta answered with another comment than the one asked; nothing of it is returned.')
      return {
        pageId, ...ids,
        comment: { ...facebookComment(pageId, read.body), private: bool(read.body.is_private), privateReplyConversationId: idText(obj(read.body.private_reply_conversation)?.id) },
        notRead: missingOf(read.missing),
        note: 'privateReplyConversationId: the Messenger conversation of a private reply already sent (Meta allows one, within 7 days of the comment).',
      }
    }
    case 'engagement':
      return engagement(account, input)
    case 'shares': {
      const pageId = pageOf(account)
      const postId = await postOf(account, input)
      const read = await onPage(() => listPaged(connectionId, 'comments.shares', `${postId}/sharedposts`, { fields: COMMENT_FIELDS.Share }, maxRows))
      return {
        pageId, postId,
        items: read.rows.map((r) => { const from = obj(r.from); return { postId: idText(r.id), createdTime: text(r.created_time), permalink: text(r.permalink_url), by: from ? { id: idText(from.id), name: text(from.name) } : null, message: text(r.message) } }),
        more: read.more,
        note: 'The public shares Meta lets this token see (a share on a private profile is never listed); view engagement gives the full share count.',
      }
    }
    case 'dynamic-posts': {
      const pageId = pageOf(account)
      const postId = await postOf(account, input)
      // Two count reads per catalog-ad post: at most 25 of them (default 10).
      const read = await onPage(() => listPaged(connectionId, 'comments.dynamicPosts', `${postId}/dynamic_posts`, { fields: COMMENT_FIELDS.DynamicPost }, Math.min(input.maxRows ?? 10, MAX_DYNAMIC_POSTS)))
      const items = []
      for (const r of read.rows) {
        const id = dynamicId(r.id)
        if (!id) continue
        const [comments, likes] = await Promise.all([
          // Review fix B8 — limit 0: the count only, no person's id is fetched.
          part(() => metaReadOne({ connectionId }, { operation: 'comments.dynamicCommentCount', path: `${id}/comments`, query: { fields: 'id', summary: true, limit: 0 } })),
          part(() => metaReadOne({ connectionId }, { operation: 'comments.dynamicLikeCount', path: `${id}/likes`, query: { fields: 'id', summary: true, limit: 0 } })),
        ])
        items.push({
          dynamicPostId: id, productId: idText(r.product_id), title: text(r.title), created: text(r.created),
          comments: totalOf(comments.value?.body), likes: totalOf(likes.value?.body),
          ...(comments.notRead || likes.notRead ? { countsNotRead: [comments.notRead, likes.notRead].filter(Boolean).join(' ') } : {}),
        })
      }
      return {
        pageId, postId, items, more: read.more,
        note: 'The catalog-ad posts Meta made from this post, one per product, with each one\'s comment and like counts (view dynamic-comments reads one). Meta does not answer Instagram comments here, nor posts of Placement Asset Customization ads.',
      }
    }
    case 'dynamic-comments': {
      const pageId = pageOf(account)
      const postId = await postOf(account, input)
      const dynamicPostId = dynamicId(input.dynamicPostId)
      if (!dynamicPostId) throw new MetaLiveRefusal('Name the catalog-ad post (dynamicPostId, from view dynamic-posts).')
      const made = await onPage(() => listPaged(connectionId, 'comments.dynamicOwnerCheck', `${postId}/dynamic_posts`, { fields: 'id' }, 500))
      if (!made.rows.some((r) => dynamicId(r.id) === dynamicPostId)) throw new MetaLiveRefusal('That catalog-ad post was not made from that post of the chosen Page, so it is not read.')
      // Meta's default order and filter (the catalog-ad post's id is not a Page post's: no filter, order or since is sent).
      const read = await onPage(() => listPaged(connectionId, 'comments.dynamic', `${dynamicPostId}/comments`, { fields: COMMENT_FIELDS.Facebook, summary: true }, maxRows))
      return { pageId, postId, dynamicPostId, totalCount: read.totalCount, items: read.rows.map((r) => facebookComment(pageId, r)), more: read.more, note: COMMENTS_EMPTY_NOTE }
    }
    case 'instagram':
    case 'instagram-ordered': {
      const instagramId = instagramOf(account)
      const mediaId = await mediaOf(account, input)
      const ordered = input.view === 'instagram-ordered'
      const read = await onPage(() => listPaged(connectionId, `comments.instagram${ordered ? 'Ordered' : ''}`, `${mediaId}/${ordered ? 'ordered_comments' : 'comments'}`, { fields: ordered ? COMMENT_FIELDS.InstagramOrdered : COMMENT_FIELDS.Instagram }, maxRows, false, 50))
      const rows = sinceKept(read.rows, input.since)
      return {
        instagramId, mediaId, since: input.since ?? null,
        items: rows.map((r) => instagramComment(instagramId, r)), more: read.more,
        note: ordered
          ? 'As Instagram shows them; for an ad with several Instagram media (a boosted post, placement customization) the comments of all of them. Meta answers an empty list, not an error, when the token lacks the permission.'
          : 'Top-level comments, newest first (replies: view instagram-replies); for a boosted post both the post\'s and the ad\'s. Meta has no time filter here: since keeps what Meta answered from that day (UTC) on. A commenter\'s username needs instagram_manage_comments; comments of people the account restricted are not answered.',
      }
    }
    case 'instagram-comment':
    case 'instagram-replies': {
      const instagramId = instagramOf(account)
      if (!input.commentId) throw new MetaLiveRefusal('Name the Instagram comment (commentId).')
      const own = await ownInstagramComment(account, input.commentId)
      if (input.view === 'instagram-replies') {
        const read = await onPage(() => listPaged(connectionId, 'comments.instagramReplies', `${own.commentId}/replies`, { fields: COMMENT_FIELDS.Instagram }, maxRows, false, 50))
        return { instagramId, ...own, items: read.rows.map((r) => instagramComment(instagramId, r)), more: read.more }
      }
      const read = await onPage(() => metaReadOne({ connectionId }, { operation: 'comments.instagramComment', path: own.commentId, query: { fields: COMMENT_FIELDS.InstagramOne } }))
      const body = read.body as Row
      if (idText(body.id) !== own.commentId) throw new MetaLiveRefusal('Meta answered with another comment than the one asked; nothing of it is returned.')
      return { instagramId, ...own, comment: instagramComment(instagramId, body) }
    }
    case 'mentioned-comment':
    case 'mentioned-media': {
      const instagramId = instagramOf(account)
      const comment = input.view === 'mentioned-comment'
      const id = metaObjectId(comment ? input.commentId : input.mediaId)
      if (!id) throw new MetaLiveRefusal(comment ? 'Name the comment the account was @mentioned in (commentId, from Meta\'s mention notification or the person).' : 'Name the media whose caption @mentions the account (mediaId).')
      const field = comment ? `mentioned_comment.comment_id(${id}){${COMMENT_FIELDS.MentionedComment}}` : `mentioned_media.media_id(${id}){${COMMENT_FIELDS.MentionedMedia}}`
      const read = await onPage(() => metaReadOne({ connectionId }, { operation: `comments.${comment ? 'mentionedComment' : 'mentionedMedia'}`, path: instagramId, query: { fields: `id,${field}` } }))
      const found = obj((read.body as Row)[comment ? 'mentioned_comment' : 'mentioned_media'])
      if (!found) throw new MetaLiveRefusal('Meta answered no such mention of the chosen Instagram account.')
      if (comment) {
        const media = obj(found.media)
        return {
          instagramId,
          mention: { commentId: idText(found.id), createdTime: text(found.timestamp), text: text(found.text), likes: num(found.like_count), media: media ? { mediaId: idText(media.id), permalink: text(media.permalink), username: text(media.username) } : null },
          note: 'A comment someone wrote on another account\'s media naming this account. Replying: set-meta-comments action reply-to-mention. Meta refuses this when comments are off on that media.',
        }
      }
      return {
        instagramId,
        mention: { mediaId: idText(found.id), caption: text(found.caption), mediaType: text(found.media_type), mediaUrl: text(found.media_url), createdTime: text(found.timestamp), username: text(found.username), likes: num(found.like_count), comments: num(found.comments_count) },
        note: 'A post of another account whose caption names this account (Meta drops the @ unless the account made it). Stories are never answered.',
      }
    }
    case 'tags': {
      const instagramId = instagramOf(account)
      realDays(input.from, input.to)
      if (input.from && input.to && input.from > input.to) throw new MetaLiveRefusal('from is after to.')
      const query: Record<string, MetaQueryValue> = { fields: COMMENT_FIELDS.Tagged }
      // Meta's bounds are strict: after the start of `from`, before the start of the day after `to` (UTC).
      if (input.from) query.posted_after = `${input.from}T00:00:00`
      if (input.to) query.posted_before = `${nextDay(input.to)}T00:00:00`
      if (input.mediaTypes?.length) query.media_type = input.mediaTypes.join(',')
      const read = await onPage(() => cursorPages(connectionId, 'comments.tags', `${instagramId}/tags`, query, maxRows))
      return {
        instagramId,
        items: read.rows.map((r) => ({ mediaId: idText(r.id), caption: text(r.caption), mediaType: text(r.media_type), permalink: text(r.permalink), createdTime: text(r.timestamp), username: text(r.username), likes: num(r.like_count), comments: num(r.comments_count) })),
        more: read.more,
        note: `Public posts of other accounts that tag this account, newest first. Meta pages this list with a cursor only and filters each page after choosing it (a page may be short or empty): Nexus reads up to ${MAX_CURSOR_PAGES} pages, and more says Meta still gave a cursor. from / to (UTC) are rolling out at Meta and may be ignored for this app yet.`,
      }
    }
    case 'blocked': {
      const pageId = pageOf(account)
      const read = await onPage(() => listPaged(connectionId, 'comments.blocked', `${pageId}/blocked`, { fields: COMMENT_FIELDS.Blocked }, maxRows))
      return { pageId, items: read.rows.map((r) => ({ id: idText(r.id), name: text(r.name) })), more: read.more, note: 'People and Pages blocked from the chosen Page (Page-scoped ids). Blocking and unblocking: set-meta-comments. Meta answers this to a Page token.' }
    }
    case 'threads':
    case 'threads-replies': {
      const threadsMediaId = await threadsMediaOf(account, input.adId)
      if (input.view === 'threads-replies') {
        const read = await listPaged(connectionId, 'comments.threadsReplies', `${threadsMediaId}/replies`, { fields: COMMENT_FIELDS.ThreadsReply }, maxRows)
        return { adId: input.adId, threadsMediaId, items: read.rows.map(threadsRow), more: read.more, note: THREADS_NOTE }
      }
      const read = await metaReadOne({ connectionId }, { operation: 'comments.threadsMedia', path: threadsMediaId, query: { fields: COMMENT_FIELDS.ThreadsMedia } })
      const body = read.body as Row
      if (idText(body.id) !== threadsMediaId) throw new MetaLiveRefusal('Meta answered with another Threads post than the ad\'s; nothing of it is returned.')
      return { adId: input.adId, threadsMediaId, post: { ...threadsRow(body), gifUrl: text(body.gif_url), ownerVerified: bool(body.is_owner_verified) }, note: THREADS_NOTE }
    }
    case 'reviews': {
      const pageId = pageOf(account)
      const read = await onPage(() => listPaged(connectionId, 'comments.reviews', `${pageId}/ratings`, { fields: COMMENT_FIELDS.Review }, maxRows))
      return {
        pageId,
        items: read.rows.map((r) => {
          const reviewer = obj(r.reviewer)
          return {
            createdTime: text(r.created_time), recommends: text(r.recommendation_type), rating: num(r.rating), hasRating: bool(r.has_rating), hasReview: bool(r.has_review),
            text: text(r.review_text), by: reviewer ? { id: idText(reviewer.id), name: text(reviewer.name) } : null, storyId: idText(obj(r.open_graph_story)?.id),
          }
        }),
        more: read.more,
        note: 'The chosen Page\'s recommendations and reviews (recommends: positive or negative). storyId is what a reply goes to (a later Nexus step). Meta answers this only to a Page token (pages_read_user_content and a CREATE_CONTENT, MANAGE or MODERATE task on the Page): until Nexus holds one, Meta\'s refusal says so.',
      }
    }
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

/**
 * Review fix B6 — CR-238, EN-029, EN-030: the Threads post of one of the chosen account's ads. The ad is checked
 * (objectInAccount), then its creative's `threads_media_id` (v26 ad-creative reference; not in Meta's SDK) names the post;
 * the reads are Meta's reply-moderation ones (ads_read of the ad account that owns the ad).
 */
export async function threadsMediaOf(account: MetaChosenAccount, adIdArg: string | null | undefined): Promise<string> {
  if (!adIdArg) throw new MetaLiveRefusal('Name the ad (adId: an ad of the chosen ad account that runs on Threads).')
  const adId = await objectInAccount(account, adIdArg, 'ad', 'comments.threadsAdCheck')
  let body: Row
  try {
    body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'comments.threadsCreative', path: adId, query: { fields: COMMENT_FIELDS.ThreadsCreative } })).body as Row
  } catch (err) {
    if (fieldRefused(err)) throw new MetaLiveRefusal(`Meta did not answer which Threads post the ad's creative uses (${err.failure.sentence}), so no Threads reply is read.`)
    throw err
  }
  if (idText(body.account_id) !== account.adAccountId) throw new MetaLiveRefusal('That ad does not belong to the ad account this business chose, so it is not read.')
  const mediaId = idText(obj(body.creative)?.threads_media_id)
  if (!mediaId || !/^\d{1,25}$/.test(mediaId)) throw new MetaLiveRefusal(`Meta names no Threads post on that ad's creative: it does not run on Threads, or it is an ad Meta's Threads reply reads do not cover. ${THREADS_NOTE}`)
  return mediaId
}

/** A Threads post or reply, by named keys (the author's username is a person's for a reply). */
function threadsRow(r: Row) {
  const hide = text(r.hide_status)
  return {
    threadsMediaId: idText(r.id), createdTime: text(r.timestamp), caption: text(r.caption), username: text(r.username), mediaType: text(r.media_type), mediaUrl: text(r.media_url),
    likes: num(r.like_count), replies: num(r.reply_count), shares: num(r.share_count), quotes: num(r.quote_count), reposts: num(r.repost_count),
    hidden: hide === 'HUSHED' ? true : hide === 'UNHUSHED' ? false : null,
  }
}

/** A catalog-ad post's id as Meta gives it: digits, or <id>_<id>. */
function dynamicId(v: unknown): string | null {
  const id = idText(v)
  return id && /^\d{1,25}(_\d{1,25})?$/.test(id) ? id : null
}

const totalOf = (body: unknown): number | null => num(obj(obj(body)?.summary)?.total_count)
const reactionTotal = (body: unknown): number | null => totalOf(obj(body)?.reactions)

/** EN-011, EN-927 — counts only: reactions (all and per type), comments, shares. Nobody's reaction is listed. */
async function engagement(account: MetaChosenAccount, input: CommentsInput) {
  const pageId = pageOf(account)
  const postId = await postOf(account, input)
  const ids = input.commentId ? await ownFacebookComment(account, postId, input.commentId) : null
  const target = ids ? ids.commentId : postId
  const { connectionId } = account
  const main = await onPage(() => metaReadOne({ connectionId }, { operation: 'comments.engagement', path: target, query: { fields: `id,reactions.limit(0).summary(total_count)${ids ? ',comment_count' : ',shares'}` } }))
  const body = main.body as Row
  if (idText(body.id) !== target) throw new MetaLiveRefusal('Meta answered with another object than the one asked; nothing of it is returned.')
  const byType: Record<string, number | null> = {}
  const notRead: string[] = []
  // One count per type (Meta's own example: reactions.type(LOVE).limit(0).summary(total_count)); none lists a person.
  const count = (type: string) => metaReadOne({ connectionId }, { operation: 'comments.reactionsByType', path: target, query: { fields: `id,reactions.type(${type}).limit(0).summary(total_count)` } })
  let sadAskedAs: 'SORRY' | null = null
  const types = await Promise.all(REACTION_TYPES.map((type) => part(async () => {
    try {
      return await count(type)
    } catch (err) {
      // Review fix B4 (re-review 3) — Meta's SDK (profile.py) names SAD, the v26 reactions page SORRY: SORRY only on #100.
      if (type !== 'SAD' || !(err instanceof MetaReadError) || err.failure.origin !== 'meta' || !/^100(\/|$)/.test(err.failure.code ?? '')) throw err
      sadAskedAs = 'SORRY'
      return count('SORRY')
    }
  })))
  REACTION_TYPES.forEach((type, i) => {
    byType[type] = types[i].value ? reactionTotal(types[i].value!.body) : null
    if (types[i].notRead) notRead.push(`${type}: ${types[i].notRead}`)
  })
  let comments: number | null = num(body.comment_count)
  if (!ids) {
    const all = await part(() => metaReadOne({ connectionId }, { operation: 'comments.count', path: `${postId}/comments`, query: { fields: 'id', summary: true, filter: 'stream', limit: 0 } }))
    comments = totalOf(all.value?.body)
    if (all.notRead) notRead.push(`comments: ${all.notRead}`)
  }
  return {
    pageId, postId, ...(ids ? { commentId: ids.commentId } : {}),
    reactions: reactionTotal(body), reactionsByType: byType, ...(sadAskedAs ? { sadAskedAs } : {}),
    comments, shares: ids ? undefined : num(obj(body.shares)?.count) ?? 0,
    ...(notRead.length ? { notRead } : {}),
    note: 'Counts only: Meta lets nobody list who reacted. Meta\'s reactions page says LIKE counts include CARE, its SDK lists CARE apart: Nexus does not count CARE on its own. comments counts comments and replies (a comment: its replies). shares: the post\'s share count (view shares lists the public ones). Meta may answer a count only to a Page token.',
  }
}

// ── step 36 (set-meta-lead-form) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Meta step 36 — the ids of a lead form's test leads and nothing else of them (Meta allows one per form): read only after
 * the form is confirmed the chosen Page's (ownForm), through the same edge as view test (`/{form}/test_leads`,
 * `fields=id`). No answer, no person, nothing kept.
 */
export async function formTestLeadIds(input: { connectionId?: string | null; formId: string }): Promise<string[]> {
  const account = await metaChosenAccount(input.connectionId)
  const formId = await ownFormForChange(account, input.formId)
  const read = await onLeads(() => listPaged(account.connectionId, 'leads.testLeadIds', `${formId}/test_leads`, { fields: 'id' }, 10))
  return read.rows.map((r) => idText(r.id)).filter((id): id is string => !!id)
}

/** ownForm's refusals when the chosen Page's list ANSWERED and did not name the form (not when the list itself failed). */
const NOT_IN_LIST = /^That form is not (one of the lead forms|among the first \d+ lead forms) of the Facebook Page this business chose, so it is not read\.$/

/**
 * Meta step 36 review B1 — the form check of a lead-form CHANGE (archive, re-activate, test leads): ownForm first; when
 * the chosen Page's list answered without the form — an ARCHIVED form may be left out of it — the form's own `page_id`
 * must be the chosen Page (formOnPage: one read of id and page_id), still fail closed. View form / list (step 14) keep
 * ownForm alone.
 */
export async function ownFormForChange(account: MetaChosenAccount, id: string): Promise<string> {
  try {
    return await ownForm(account, id)
  } catch (err) {
    if (!(err instanceof MetaLiveRefusal) || !NOT_IN_LIST.test(err.message)) throw err
    return formOnPage(account, metaObjectId(id)!, pageOf(account), 'the Page\'s list of forms did not name it (an archived form may be left out)')
  }
}

/** Meta step 36 review B1 — one form of the chosen Page as a change reads it: view form's read, after ownFormForChange. */
export async function liveLeadFormForChange(input: { connectionId?: string | null; formId: string }) {
  const account = await metaChosenAccount(input.connectionId)
  return formView(account, pageOf(account), await ownFormForChange(account, input.formId))
}
