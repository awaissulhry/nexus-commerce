/**
 * Meta ads step 15 (2026-10-21, finished 2026-10-25) — Claude's reads of conversations, message templates and the messaging
 * setup. Read only: nothing here changes Meta, and the gateway lets only GET through. Every read is of the business's
 * CHOSEN Facebook Page, Instagram account or ad account, or of a WhatsApp account the chosen ad account's own business
 * portfolio owns (marketing/meta-ads/live-messaging.ts); a caller never names a Graph field or path. The Page's own reads go
 * with the chosen Page's own token, which the gateway reads for each of them (gateway/meta-page-reads.ts).
 *
 *   meta-conversations      Messenger and Instagram Direct conversations, creator conversations (Partnership folder), one
 *                           conversation's messages, the Page's inbox labels, which app answers a person (thread owner), a
 *                           person's call permission and persistent menu; WhatsApp conversation, pricing and call analytics
 *                           (master EN-034, EN-035, EN-042, EN-043, EN-909, EN-911, EN-919, EN-936, EN-937, EN-938,
 *                           OT-009; EN-903 too — it takes and answers a person's id)
 *   meta-message-templates  Messenger utility templates, WhatsApp templates and template groups (EN-922, EN-930, EN-939)
 *   meta-messaging-setup    Messenger / Instagram profile, welcome flows, personas, calling, feature review and routing,
 *                           chat plugin, messaging and Threads destinations, Messenger lead templates (CR-207, CR-209,
 *                           CR-213, CR-227, CR-229, CR-231, CR-271, CR-900, EN-045, EN-900, EN-906, EN-916, EN-918, EN-920)
 *
 * PEOPLE'S DATA (conversations and messages: names, ids, words) — step 14's pattern:
 *   - meta-conversations needs `customers.view` on top of `ads.view` (a tool's `restrictedFields` is typed to the money
 *     permissions, so the gate is `requires`) and is Claude's door only (`surfaces: ['mcp']`): the in-app chat keeps every
 *     tool result in its run's steps, and a message is never stored;
 *   - nothing is stored, logged or cached; answers keep only named keys.
 * meta-message-templates and meta-messaging-setup hold no person's data — templates are the business's own wording (its
 * examples are the business's sample values), the setup is the Page's menus, flows, personas and settings — so both are
 * offered on both doors with `ads.view` alone.
 * Money: only the WhatsApp analytics' approximate cost (messagingCostCents, minor units of the WhatsApp account's currency).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { connectionArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'
import { isRealDay } from '../../marketing/meta-ads/live-engagement.js'
import {
  CONVERSATION_VIEWS, FLOW_PLATFORMS, liveConversations, liveMessageTemplates, liveMessagingSetup, MAX_MESSAGES, PROFILE_PLATFORMS, SETUP_VIEWS,
  TEMPLATE_QUALITY, TEMPLATE_STATUSES, TEMPLATE_VIEWS, WA_ALL_CATEGORIES, WA_ALL_DIMENSIONS, WA_ALL_DIRECTIONS, WA_ALL_TYPES, WA_GRANULARITIES,
  WHATSAPP_TEMPLATE_CATEGORIES, type ConversationsInput, type SetupInput, type TemplatesInput,
} from '../../marketing/meta-ads/live-messaging.js'

const ADSPEND = FIELDS.financialsAdspendView
/**
 * Money keys of meta-conversations' answers: the WhatsApp analytics' approximate cost. Not `costCents` — the shared registry
 * (lib/auth/financial-fields.ts) gates that name with the suppliers permission (a product's purchase cost).
 */
export const META_MESSAGING_MONEY = { messagingCostCents: ADSPEND } as const

const maxRowsArg = (dflt: number) => z.number().int().min(1).max(500).optional().describe(`at most this many rows (default ${dflt}, at most 500)`)
const utcDayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, 'not a calendar day').optional().describe(`${what} (YYYY-MM-DD, UTC)`)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const list = (v: unknown) => (Array.isArray(v) ? v as string[] : undefined)
const whatsappAccountArg = metaIdArg('WhatsApp views: the WhatsApp Business account (its id; default: the one the chosen ad account\'s business portfolio owns)')

// ── meta-conversations ──────────────────────────────────────────────────────────────────────────────────────────────

const metaConversations: AgentTool = {
  name: 'meta-conversations',
  title: 'Meta conversations',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  // People's data: customers.view, the permission Nexus uses for a customer's personal data (see the header).
  requires: [F.adsView, F.customersView],
  // Claude's door only: the in-app chat keeps tool results in its run's steps, and a message is never stored.
  surfaces: ['mcp'],
  restrictedFields: META_MESSAGING_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(CONVERSATION_VIEWS)).describe(CONVERSATION_VIEWS.join(' | ')),
    personId: metaIdArg('messenger, instagram, creators: only the conversation with this person; thread-owner, call-permission, person-menu: the person (the Page-scoped id a conversation view gives)'),
    conversationId: z.string().trim().regex(/^[A-Za-z0-9_]{1,200}$/).optional().describe('messages: a conversation of the chosen Page or Instagram account (t_<digits> or Meta\'s letters and digits, from view messenger, instagram or creators)'),
    whatsappAccountId: whatsappAccountArg,
    from: utcDayArg('whatsapp-…: the first day'),
    to: utcDayArg('whatsapp-…: the last day'),
    granularity: z.preprocess(lower, z.enum(Object.keys(WA_GRANULARITIES) as [keyof typeof WA_GRANULARITIES, ...Array<keyof typeof WA_GRANULARITIES>])).optional().describe('whatsapp-…: half-hour | daily (default) | monthly'),
    phoneNumbers: z.array(z.string().trim().regex(/^\+?[\d\s-]{6,20}$/)).max(20).optional().describe('whatsapp-…: only these of the WhatsApp account\'s own numbers (digits, as the analytics give them)'),
    countries: z.array(z.string().trim().regex(/^[A-Z]{2}$/)).max(50).optional().describe('whatsapp-…: only these countries (ISO codes, e.g. IT, DE)'),
    dimensions: z.array(z.enum(WA_ALL_DIMENSIONS as [string, ...string[]])).max(5).optional().describe('whatsapp-…: break the numbers down by these (conversations: CONVERSATION_CATEGORY, CONVERSATION_DIRECTION, CONVERSATION_TYPE, COUNTRY, PHONE; pricing: COUNTRY, PHONE, PRICING_CATEGORY, PRICING_TYPE, TIER; calls: COUNTRY, DIRECTION, PHONE)'),
    categories: z.array(z.enum(WA_ALL_CATEGORIES as [string, ...string[]])).max(7).optional().describe('whatsapp-conversations, whatsapp-pricing: only these categories (Meta\'s own per view)'),
    types: z.array(z.enum(WA_ALL_TYPES as [string, ...string[]])).max(4).optional().describe('whatsapp-conversations (FREE_ENTRY_POINT, FREE_TIER, REGULAR), whatsapp-pricing (FREE_CUSTOMER_SERVICE, FREE_ENTRY_POINT, REGULAR): only these types'),
    directions: z.array(z.enum(WA_ALL_DIRECTIONS as [string, ...string[]])).max(3).optional().describe('whatsapp-conversations, whatsapp-calls: only these directions (BUSINESS_INITIATED, USER_INITIATED)'),
    maxRows: maxRowsArg(100).describe(`at most this many rows (default 100, at most 500; messages: at most ${MAX_MESSAGES})`),
    connectionId: connectionArg,
  }),
  description:
    'Messages people sent the business on Messenger, Instagram Direct and WhatsApp, read LIVE from Meta — people\'s names, '
    + 'ids and words: use them for what the person asked; Nexus keeps none of it. view messenger: the chosen Facebook '
    + 'Page\'s conversations, newest first (personId: the one with that person); instagram: the chosen Instagram account\'s '
    + 'Direct conversations (read through the Page it is linked to); creators: conversations with creators in the Instagram '
    + `Partnership folder; messages (conversationId): a conversation's ${MAX_MESSAGES} most recent messages (Meta answers no `
    + 'older ones) and the people in it, with the person\'s last message time and the end of the 24-hour window; labels: '
    + 'the Page\'s inbox labels (one person\'s labels are not read: Meta takes the person\'s id in the path, which Nexus\'s '
    + 'call log keeps); thread-owner (which app answers the person now), call-permission (may the Page call them in '
    + 'Messenger), person-menu (the menu they see) — each for a personId who has a conversation with the Page. Meta\'s '
    + 'windows are said in every answer: a reply only within 24 hours of the person\'s last message (up to 7 days after a '
    + 'first message from a click-to-message ad); outside it, from Nexus, only an approved Messenger utility template or a '
    + 'person\'s HUMAN_AGENT reply (an App Review feature) — Meta\'s paid or opt-in routes (Sponsored, Marketing Messages) '
    + 'are not in Nexus; the ACCOUNT_UPDATE, POST_PURCHASE_UPDATE and CONFIRMED_EVENT_UPDATE tags fail since 2026-04-27. '
    + 'A listed conversation marked readable false has an id Nexus does not read. '
    + 'whatsapp-pricing (from, to, granularity; dimensions, phoneNumbers, countries, categories, types): messages delivered '
    + 'and their approximate cost per category and type — FREE_ENTRY_POINT shows chats Click-to-WhatsApp ads opened; '
    + 'whatsapp-calls: calls, length and cost; whatsapp-conversations: the old conversation-based numbers (ended 2025-07-01, '
    + 'kept one year). WhatsApp only for an account the chosen ad account\'s own business portfolio owns (none: the answer '
    + 'says a WhatsApp Business account is needed, made in WhatsApp Manager, with the WhatsApp product and '
    + 'whatsapp_business_management on the business\'s Meta app), and never when another business in Nexus uses that '
    + 'portfolio. The Page\'s conversations are read with the chosen Page\'s own token (the system user needs the MESSAGING '
    + 'task on the Page). Meta answers real customers\' messages only with Advanced Access (App Review; Standard access '
    + 'shows only people with a role on the Meta app), Instagram only for a verified business: Meta\'s words name what is '
    + 'missing. Sending and handing over: create-meta-message; labels: set-meta-conversation-labels. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveConversations({
      connectionId: str(args.connectionId),
      view: args.view as ConversationsInput['view'],
      personId: str(args.personId),
      conversationId: str(args.conversationId),
      whatsappAccountId: str(args.whatsappAccountId),
      from: str(args.from) ?? undefined,
      to: str(args.to) ?? undefined,
      granularity: (str(args.granularity) ?? undefined) as ConversationsInput['granularity'],
      phoneNumbers: list(args.phoneNumbers),
      countries: list(args.countries),
      dimensions: list(args.dimensions),
      categories: list(args.categories),
      types: list(args.types),
      directions: list(args.directions),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-message-templates ──────────────────────────────────────────────────────────────────────────────────────────

const metaMessageTemplates: AgentTool = {
  name: 'meta-message-templates',
  title: 'Meta message templates',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  // The business's own wording (no person's data): ads.view on both doors.
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(TEMPLATE_VIEWS)).describe(TEMPLATE_VIEWS.join(' | ')),
    whatsappAccountId: whatsappAccountArg,
    groupId: metaIdArg('group: a template group of the business\'s WhatsApp account (from view groups or WhatsApp Manager)'),
    name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/).optional().describe('messenger, whatsapp: Meta\'s search in template names (lower case, digits and _; not an exact match)'),
    search: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional().describe('messenger, whatsapp: Meta\'s search in names and text'),
    languages: z.array(z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2,3})?$/)).max(20).optional().describe('messenger, whatsapp: only these languages (e.g. it, de_DE)'),
    statuses: z.array(z.enum(TEMPLATE_STATUSES)).max(TEMPLATE_STATUSES.length).optional().describe('messenger, whatsapp: only these review states'),
    categories: z.array(z.enum(WHATSAPP_TEMPLATE_CATEGORIES)).max(3).optional().describe('whatsapp: only these categories'),
    quality: z.array(z.enum(TEMPLATE_QUALITY)).max(4).optional().describe('whatsapp: only these quality ratings'),
    from: utcDayArg('whatsapp: last updated on or after this day'),
    to: utcDayArg('whatsapp: last updated on or before this day'),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'Message templates, read LIVE from Meta. view messenger: the chosen Facebook Page\'s Messenger utility templates '
    + '(order, shipping and account updates; an approved one may be sent outside the 24-hour window, never marketing) — '
    + 'Meta answers them only to the Page\'s own token with the page_utility_messaging permission. whatsapp: the business\'s WhatsApp templates '
    + '(marketing, utility, authentication) with their review state, quality rating and Meta\'s reasons when rejected; '
    + 'groups: its template groups (Meta documents this list only in its SDK); group (groupId): one group and its templates. '
    + 'Filters: name, search, languages, statuses (and for WhatsApp categories, quality, from / to). Meta reviews every '
    + 'template (it may change a WhatsApp template\'s category). WhatsApp only for an account the chosen ad account\'s own '
    + 'business portfolio owns, and never when another business in Nexus uses that portfolio. Making, editing and deleting '
    + 'templates: set-meta-message-templates. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveMessageTemplates({
      connectionId: str(args.connectionId),
      view: args.view as TemplatesInput['view'],
      whatsappAccountId: str(args.whatsappAccountId),
      groupId: str(args.groupId),
      name: str(args.name),
      search: str(args.search),
      languages: list(args.languages),
      statuses: list(args.statuses),
      categories: list(args.categories),
      quality: list(args.quality),
      from: str(args.from),
      to: str(args.to),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-messaging-setup ────────────────────────────────────────────────────────────────────────────────────────────

const metaMessagingSetup: AgentTool = {
  name: 'meta-messaging-setup',
  title: 'Meta messaging setup',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  // The Page's own settings, menus, flows and identities (no person's data): ads.view on both doors.
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(SETUP_VIEWS)).describe(SETUP_VIEWS.join(' | ')),
    platform: z.preprocess(lower, z.enum([...new Set([...PROFILE_PLATFORMS, ...FLOW_PLATFORMS])] as [string, ...string[]])).optional().describe('profile: messenger (default) or instagram (Instagram ice breakers and menu); welcome-flows: only flows for this platform'),
    flowId: metaIdArg('welcome-flows: one flow of the chosen Page'),
    personaId: metaIdArg('personas: one persona of the chosen Page'),
    leadTemplateId: metaIdArg('lead-templates: one Messenger lead template of the chosen Page, with its steps'),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'How the business\'s chosen Facebook Page and Instagram account are set up for messages and messaging ads, read LIVE '
    + 'from Meta. view profile: the Messenger (or platform instagram: Instagram) profile — Get Started button, greeting, ice '
    + 'breakers, persistent menu, allowed domains (people from a click-to-message ad see that ad\'s own greeting instead); '
    + 'welcome-flows: the Page\'s welcome-message flows for click-to-Messenger and click-to-Instagram-Direct ads (Instagram '
    + 'flows there are those for instagram; flows made on the Instagram account itself through Instagram Login are not on '
    + 'this list); personas: names and pictures replies can carry; calling: Messenger audio / video '
    + 'calls, call icon, hours and routing; features: Meta\'s feature review for the Page and its conversation routing (Meta '
    + 'lets no app read whether the Human Agent feature is approved); chat-plugin: the website chat bubble\'s settings; '
    + 'destinations: where messaging and Threads ads can send people — the Page\'s WhatsApp number, its Instagram accounts '
    + '(with the Instagram-backed Page id for boosting Instagram posts), the Threads account (linked, Instagram-backed or '
    + 'Page-backed), the Page\'s default ice breakers and quick replies for messaging ads, and Meta\'s click-to-message '
    + 'eligibility; lead-templates: Messenger lead templates (leadTemplateId: one with its steps). An Instagram account '
    + 'another business in Nexus uses is its id only. The Page\'s own settings are read with the chosen Page\'s own token '
    + '(the system user needs the MESSAGING task on the Page); an app in Development mode shows the profile only to people '
    + 'with a role on the app: Meta\'s words say what is missing. Changes: set-meta-messaging-setup. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveMessagingSetup({
      connectionId: str(args.connectionId),
      view: args.view as SetupInput['view'],
      platform: str(args.platform),
      flowId: str(args.flowId),
      personaId: str(args.personaId),
      leadTemplateId: str(args.leadTemplateId),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

export const META_ADS_MESSAGING_TOOLS: AgentTool[] = [metaConversations, metaMessageTemplates, metaMessagingSetup]
