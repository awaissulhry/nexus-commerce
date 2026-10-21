/**
 * Meta ads step 14 (2026-10-21) — Claude's reads of lead forms, leads and comments. Read only: nothing here changes Meta,
 * and the gateway lets only GET through. Every read is of the business's CHOSEN Facebook Page, Instagram account or ad
 * account (marketing/meta-ads/live-engagement.ts); a caller never names a Graph field or path.
 *
 *   meta-lead-forms  the chosen Page's lead forms (also: which can be sent in Messenger) and one form with its questions
 *                    (master LD-023, LD-024, LD-025). No person's data: every door.
 *   meta-leads       leads of a form, of an ad (a call ad's callback requests too), one lead, a form's test leads, with
 *                    the consent boxes and the catalog item; the lead file download answered in words (LD-030…LD-035,
 *                    LD-038, CR-252)
 *   meta-comments    Facebook comments of a Page post or ad post, one comment, its replies, counts (reactions per type,
 *                    comments, shares), public shares, catalog-ad posts with their comments, Instagram comments (also in
 *                    Instagram's order), one Instagram comment, its replies, @mentions and tags, the Page's blocked people
 *                    and reviews; an ad's Threads post and its replies (CR-238, CR-468, EN-003…EN-005, EN-011, EN-015, EN-017…EN-020,
 *                    EN-027, EN-029, EN-030, EN-063, EN-927, EN-928)
 *
 * PEOPLE'S DATA (leads and comments: names, e-mails, phones, user ids, messages):
 *   - meta-leads and meta-comments need `customers.view` on top of `ads.view`: the permission Nexus uses for a customer's
 *     personal data (customer-lookup, privacy-requests). A tool's `restrictedFields` cannot carry it: that list is typed to
 *     the money permissions (FIELDS, financial.view only) and a `financials.view` holder skips it — so the gate is the
 *     tool's `requires`, and a person without customers.view gets no lead and no comment at all.
 *   - both are Claude's door only (`surfaces: ['mcp']`): the in-app chat keeps every tool result in its run's steps, and
 *     a lead or comment is never stored; through Claude's door a read's run keeps only its mode, never its answer.
 *   - nothing is stored, logged or cached; answers keep only named keys.
 * No answer holds money.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { connectionArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'
import {
  COMMENT_FILTERS, COMMENT_ORDERS, COMMENT_VIEWS, FORM_STATUSES, FORM_VIEWS, isRealDay, LEAD_VIEWS, liveComments, liveLeadForms, liveLeads, MAX_DYNAMIC_POSTS,
  TAG_MEDIA_TYPES, type CommentsInput, type FormsInput, type LeadsInput,
} from '../../marketing/meta-ads/live-engagement.js'

const maxRowsArg = (dflt: number) => z.number().int().min(1).max(500).optional().describe(`at most this many rows (default ${dflt}, at most 500)`)
// Review fix A4 — a real calendar day only (2026-13-01 or 2026-02-30 is refused before any call).
const utcDayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, 'not a calendar day').optional().describe(`${what} (YYYY-MM-DD, UTC)`)

/** The args as given (zod has checked them); empty strings and absent values are null. */
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

// ── meta-lead-forms ──────────────────────────────────────────────────────────────────────────────────────────────────

const metaLeadForms: AgentTool = {
  name: 'meta-lead-forms',
  title: 'Meta lead forms',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(FORM_VIEWS)).describe(FORM_VIEWS.join(' | ')),
    formId: metaIdArg('form: a lead form of the chosen Page (from view list)'),
    statuses: z.array(z.enum(FORM_STATUSES)).max(FORM_STATUSES.length).optional().describe('list: only forms in these states (ACTIVE, ARCHIVED, DELETED, DRAFT)'),
    messengerOnly: z.boolean().optional().describe('list: only forms Meta lets send inside a Messenger chat'),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'The lead forms (instant forms) of the business\'s chosen Facebook Page, read LIVE. view list: every form with its '
    + 'state in words, language, when made and how many leads Meta keeps for it (statuses narrows it; messengerOnly: the '
    + 'ones that can be sent inside a Messenger chat). form (formId): one form — its questions in order (each answer in a '
    + 'lead carries the question\'s key), privacy policy, intro, thank-you page, consent boxes and whether it is a '
    + 'higher-intent form. A form is read only when it is one of the chosen Page\'s forms. Making, archiving or '
    + 're-activating a form and making a test lead are change tools (a later Nexus step). The answers people gave are '
    + 'meta-leads. Meta\'s v26 reference says the Page\'s form list cannot be read while its '
    + 'lead-ads guide reads it, and some Page reads answer only a Page token: Meta\'s words then say so. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveLeadForms({
      connectionId: str(args.connectionId),
      view: args.view as FormsInput['view'],
      formId: str(args.formId),
      statuses: args.statuses as string[] | undefined,
      messengerOnly: args.messengerOnly === true,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-leads ───────────────────────────────────────────────────────────────────────────────────────────────────────

const metaLeads: AgentTool = {
  name: 'meta-leads',
  title: 'Meta leads',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  // People's data: customers.view, the permission Nexus uses for a customer's personal data (see the header).
  requires: [F.adsView, F.customersView],
  // Claude's door only: the in-app chat keeps tool results in its run's steps, and a lead is never stored.
  surfaces: ['mcp'],
  input: z.object({
    view: z.preprocess(lower, z.enum(LEAD_VIEWS)).describe(LEAD_VIEWS.join(' | ')),
    formId: metaIdArg('form, test: a lead form of the chosen Page (from meta-lead-forms)'),
    adId: metaIdArg('ad: an ad of the chosen ad account'),
    leadId: metaIdArg('lead: one lead (from a leads view, or the lead id of Meta\'s notification)'),
    from: utcDayArg('form, ad: leads made on or after this day'),
    to: utcDayArg('form, ad: leads made on or before this day'),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'The leads people sent through the business\'s lead forms, read LIVE from Meta — people\'s names, e-mails and phone '
    + 'numbers: use them for what the person asked and nowhere else; Nexus keeps none of it. view form (formId, from / to): '
    + 'every lead of a form of the chosen Page. ad (adId, from / to): the leads of one ad of the chosen ad account (a form '
    + 'used by several ads holds more); for a call ad, its callback requests. lead (leadId): one lead — read only when its '
    + 'ad is the chosen ad account\'s or its form the chosen Page\'s. test (formId): the form\'s test lead. Each lead: when, '
    + 'which form and ad (organic: no ad), the answers by question key, the consent boxes exactly as Meta gives them, the '
    + 'catalog item for catalog lead ads. export: Meta\'s lead file is a download on www.facebook.com, not the Graph API, so '
    + 'Nexus does not fetch it (view form with from / to reads the same leads). Real leads need Meta\'s App Review for '
    + 'leads_retrieval, Business Verification and a Live app, which this business has not asked for yet: until then Meta '
    + 'answers test leads only, its words say so when it refuses, and real leads stay in Meta\'s Leads Center. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveLeads({
      connectionId: str(args.connectionId),
      view: args.view as LeadsInput['view'],
      formId: str(args.formId),
      adId: str(args.adId),
      leadId: str(args.leadId),
      from: str(args.from),
      to: str(args.to),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-comments ────────────────────────────────────────────────────────────────────────────────────────────────────

const metaComments: AgentTool = {
  name: 'meta-comments',
  title: 'Meta comments',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  // People's words and names: customers.view, as meta-leads (see the header).
  requires: [F.adsView, F.customersView],
  // Claude's door only: the in-app chat keeps tool results in its run's steps, and a comment is never stored.
  surfaces: ['mcp'],
  input: z.object({
    view: z.preprocess(lower, z.enum(COMMENT_VIEWS)).describe(COMMENT_VIEWS.join(' | ')),
    postId: z.string().trim().regex(/^\d{1,25}_\d{1,25}$/).optional().describe('post, comment, replies, engagement, shares, dynamic-posts, dynamic-comments: a post of the chosen Page (<Page id>_<post id>, from meta-page-posts)'),
    adId: metaIdArg('post, engagement, shares, dynamic-posts, instagram, instagram-ordered: an ad of the chosen ad account instead (its Facebook post or Instagram media); threads, threads-replies: the ad whose Threads post is read'),
    commentId: z.string().trim().regex(/^\d{1,25}(_\d{1,25})?$/).optional().describe('comment, replies, engagement: a Facebook comment of that post (<post id>_<comment id>); instagram-comment, instagram-replies, mentioned-comment: an Instagram comment id'),
    mediaId: metaIdArg('instagram, instagram-ordered: a media of the chosen Instagram account; mentioned-media: a media whose caption @mentions it'),
    dynamicPostId: z.string().trim().regex(/^\d{1,25}(_\d{1,25})?$/).optional().describe('dynamic-comments: a catalog-ad post made from that post (from view dynamic-posts)'),
    filter: z.enum(COMMENT_FILTERS).optional().describe('post, replies: toplevel (default: comments on the post itself) or stream (every comment and reply in time order)'),
    order: z.enum(COMMENT_ORDERS).optional().describe('post, replies: newest first (default) or oldest first'),
    since: utcDayArg('post, replies, instagram, instagram-ordered: only comments from this day on'),
    from: utcDayArg('tags: posted after this day'),
    to: utcDayArg('tags: posted up to this day'),
    mediaTypes: z.array(z.enum(TAG_MEDIA_TYPES)).max(TAG_MEDIA_TYPES.length).optional().describe('tags: only these kinds of posts'),
    maxRows: maxRowsArg(100).describe(`at most this many rows (default 100, at most 500; dynamic-posts: default 10, at most ${MAX_DYNAMIC_POSTS})`),
    connectionId: connectionArg,
  }),
  description:
    'Comments and reactions on the business\'s chosen Facebook Page and Instagram account, read LIVE from Meta — people\'s '
    + 'names and words: use them for what the person asked; Nexus keeps none of it. Facebook: view post (postId, or the '
    + 'adId of an ad of the chosen ad account): its comments with Meta\'s total, newest first (filter toplevel | stream, '
    + 'order, since); comment (postId + commentId): one, with the private reply already sent; replies: its replies; '
    + 'engagement: counts only — reactions in all and per type, comments, shares (Meta lets nobody list who reacted); '
    + 'shares: the public shares; dynamic-posts: the catalog-ad posts made from a post with their comment and like '
    + 'counts, dynamic-comments (dynamicPostId) the comments of one; blocked: people blocked from the Page; reviews: the '
    + 'Page\'s recommendations and reviews. Instagram: instagram (mediaId or adId): comments newest first (at most 50 per '
    + 'call, top level, both the post\'s and the ad\'s for a boosted post); instagram-ordered: as Instagram shows them '
    + '(all media of an ad); instagram-comment, instagram-replies (commentId); mentioned-comment (commentId), '
    + 'mentioned-media (mediaId): where someone @mentioned the account; tags: other people\'s posts tagging it. Threads: '
    + 'threads (adId): the Threads post of an ad of the chosen ad account and its counts; threads-replies: its direct replies '
    + '(not for catalog ads, boosted posts or Instagram- / Page-backed Threads accounts). Only the chosen Page\'s posts, the '
    + 'chosen Instagram account\'s media and the chosen ad account\'s ads are read, and a comment is confirmed by Meta '
    + 'first; anything else is refused. Instagram comments arrive by these reads (Nexus has no comment webhooks). '
    + 'Meta answers some Page reads only to a Page token, and may then answer an empty list: the answer says so. '
    + 'Replying, hiding and deleting are change tools (a later Nexus step). Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveComments({
      connectionId: str(args.connectionId),
      view: args.view as CommentsInput['view'],
      postId: str(args.postId),
      adId: str(args.adId),
      commentId: str(args.commentId),
      mediaId: str(args.mediaId),
      dynamicPostId: str(args.dynamicPostId),
      filter: str(args.filter),
      order: str(args.order),
      since: str(args.since),
      from: str(args.from),
      to: str(args.to),
      mediaTypes: args.mediaTypes as string[] | undefined,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

export const META_ADS_ENGAGEMENT_TOOLS: AgentTool[] = [metaLeadForms, metaLeads, metaComments]
