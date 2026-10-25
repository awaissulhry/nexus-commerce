/**
 * Meta ads step 15 — conversations, message templates, messaging setup. Every read is of the business's CHOSEN Page,
 * Instagram account or ad account, or of a WhatsApp account the chosen ad account's own business portfolio owns: a
 * conversation Meta does not show with the chosen Page or Instagram account, a person with no conversation with the Page,
 * an Instagram account the Page is not linked to, a WhatsApp account of another portfolio or of a portfolio another Nexus
 * business uses, a number or template group not that account's, a flow, persona or lead template not the Page's — each is
 * refused (before any call where the id says it; after one id-only read where only Meta knows). Every call is one the real
 * gateway lets through, the Page's own reads are exactly the ones it sends with the chosen Page's token, and
 * conversations and messages are read only through their own edges. People's data comes back under named keys only, and
 * only to a person who may see customers' data, on Claude's door; a person's id never goes in a path (the ledger keeps
 * paths). Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Req[],
  reply: null as null | ((req: Req) => unknown),
  taken: new Set<string>(),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    const answer = h.reply?.(req) ?? { data: [] }
    if (answer instanceof Error) throw answer
    return { body: answer, calls: 1 }
  }),
  metaReadAll: vi.fn(async () => { throw new Error('not used here') }),
}))
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../../db.js', () => ({
  default: {
    metaAdsCampaign: { findFirst: vi.fn(async () => null) },
    metaAdsAdSet: { findFirst: vi.fn(async () => null) },
    metaAdsAd: { findFirst: vi.fn(async () => null) },
    // nexus_meta_links_taken(product, ids): the ids another business uses, for that product.
    $queryRaw: vi.fn(async (_s: unknown, product: string, ids: string[]) => ids.filter((id) => h.taken.has(`${product}:${id}`)).map((id) => ({ id }))),
  },
}))

import { META_ADS_MESSAGING_TOOLS } from './meta-ads-messaging.tools.js'
import { CREATOR_ACCESS, messageRow, NO_WHATSAPP_ACCOUNT, PAGE_READ_NOTE, WHATSAPP_ACCESS, whatsappAnalyticsField, windowOf, WINDOW_RULES } from '../../marketing/meta-ads/live-messaging.js'
import { callTool, offeredOn, visibleTo, type UserPrincipal } from '../call-tool.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaCallVerdict, metaReadOnlyProblem } from '../../gateway/meta-calls.js'

const tool = (name: string) => META_ADS_MESSAGING_TOOLS.find((t) => t.name === name)!
const ctx = { can: (p: string) => ['ads.view', 'customers.view'].includes(p), via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const ACCOUNT = '1234567890'
const BIZ = '9876543210'
const PAGE = '120000000000010'
const IG = '170000000000001'
const OTHER_IG = '170000000000099'
const PERSON = '300000000000001'
const IG_PERSON = '310000000000001'
const CONV_M = 't_400000000000001'
const CONV_IG = 'aWdfZAG06MTpJR01lc3N3Njkz'
const WABA = '500000000000001'
const GROUP = '510000000000001'
const FLOW = '520000000000001'
const PERSONA = '530000000000001'
const LEAD_TEMPLATE = '540000000000001'
const NUMBER = '390000000001'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', systemUser: { id: '100000000000001', name: null },
  adAccount: { adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: BIZ },
  page: { pageId: PAGE, name: 'Shop A' }, instagram: { instagramId: IG, username: 'shop_a' }, read: {},
}
const metaError = (code: string, words: string, errorClass = 'validation') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
/** Each recorded call as the real gateway judges it (null: it goes). */
const gatewayProblems = () => h.calls.map((c) => [c.operation, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, problem]) => problem)
/** The Page whose own token the real gateway sends a recorded call with (null: the chosen Page's; undefined: the system user's). */
const pageTokenOf = (c: Req) => metaCallVerdict({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' }).pageRead?.pageId
/** The rate bucket the real gateway takes for a recorded call (fix round 1, A1): page, whatsapp, or the ads one. */
const bucketOf = (c: Req) => { const v = metaCallVerdict({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' }); return v.pageRead ? 'page' : v.whatsappRead ? 'whatsapp' : 'ads' }

const people = (ids: Array<[string, string]>) => ({ data: ids.map(([id, name]) => ({ id, name, username: name, email: `${id}@facebook.com` })) })
const MESSAGES = [
  { id: 'm_2', created_time: '2026-10-20T10:05:00+0000', from: { id: PAGE, name: 'Shop A' }, to: { data: [{ id: PERSON, name: 'A Person', email: 'p@example.com' }] }, message: 'Which size?', unknown_raw: 'x' },
  { id: 'm_1', created_time: '2026-10-20T10:00:00+0000', from: { id: PERSON, name: 'A Person', email: 'p@example.com' }, to: { data: [{ id: PAGE, name: 'Shop A' }] }, message: 'Hello', reply_to: { mid: 'm_0', is_self_reply: false }, attachments: { data: [{ id: 'a1', image_data: { url: 'https://cdn.example.com/a.jpg' } }] } },
]

/** A Meta that knows the business's own Page, Instagram account, conversations, WhatsApp account and setup. */
function ownMeta(req: Req): unknown {
  const fields = String(req.query?.fields ?? '')
  if (req.path === PAGE && fields === 'id,instagram_business_account') return { id: PAGE, instagram_business_account: { id: IG } }
  if (req.path === `${PAGE}/conversations`) {
    const ig = req.query?.platform === 'instagram'
    const person = ig ? IG_PERSON : PERSON
    if (req.query?.user_id && req.query.user_id !== person) return { data: [] }
    return { data: [{ id: ig ? CONV_IG : CONV_M, updated_time: '2026-10-20T10:05:00+0000', participants: people([[person, 'A Person'], [ig ? IG : PAGE, 'Shop A']]), message_count: 2, unread_count: 1, snippet: 'Which size?', can_reply: true }] }
  }
  if (req.path === CONV_M) return { id: CONV_M, participants: people([[PERSON, 'A Person'], [PAGE, 'Shop A']]) }
  if (req.path === CONV_IG) return { id: CONV_IG, participants: people([[IG_PERSON, 'buyer_1'], [IG, 'shop_a']]) }
  if (/\/messages$/.test(req.path)) return { data: MESSAGES }
  if (req.path === `${PAGE}/custom_labels`) return { data: [{ id: '600000000000001', page_label_name: 'Return asked' }] }
  if (req.path === `${PAGE}/thread_owner`) return { data: [{ thread_owner: { app_id: '1234567', expiration: 1760000000 } }] }
  if (req.path === `${PAGE}/messenger_call_permissions`) return { permission: { status: 'has_permission', expiration_time: 1760000000 }, actions: [{ action_name: 'start_call', can_perform: true }] }
  if (req.path === `${PAGE}/custom_user_settings`) return { data: [{ user_level_persistent_menu: [{ locale: 'default', call_to_actions: [{ type: 'postback', title: 'Order', payload: 'ORDER' }] }] }] }
  if (req.path === `${BIZ}/owned_whatsapp_business_accounts`) return { data: [{ id: WABA, name: 'Shop A WhatsApp', currency: 'EUR', timezone_id: '1', status: 'ACTIVE' }] }
  if (req.path === `${WABA}/phone_numbers`) return { data: [{ id: '1', display_phone_number: '+39 000 000 0001', verified_name: 'Shop A' }] }
  if (req.path === WABA && fields.includes('pricing_analytics')) return { id: WABA, pricing_analytics: { data: [{ data_points: [{ start: 1760000000, end: 1760086400, phone_number: NUMBER, pricing_category: 'MARKETING', pricing_type: 'REGULAR', volume: 2, cost: 15.58 }] }] } }
  if (req.path === WABA && fields.includes('call_analytics')) return { id: WABA, call_analytics: { data_points: [{ start: 1760000000, end: 1760086400, count: 3, average_duration: 106, cost: 0.47795 }] } }
  if (req.path === WABA && fields.includes('conversation_analytics')) return { id: WABA, conversation_analytics: { data: [{ data_points: [{ start: 1760000000, end: 1760086400, conversation: 4, conversation_category: 'SERVICE', cost: 0 }] }] } }
  if (req.path === `${PAGE}/message_templates` || req.path === `${WABA}/message_templates`) {
    return { data: [{ id: '700000000000001', name: 'order_update', category: 'UTILITY', language: 'it', status: 'APPROVED', components: [{ type: 'BODY', text: 'Your order {{1}} ships', example: { body_text: [['A1']] } }], quality_score: { score: 'GREEN' } }], summary: { total_count: 1 } }
  }
  if (req.path === `${WABA}/template_groups`) return { data: [{ id: GROUP, name: 'Autumn', description: 'Sale' }] }
  if (req.path === GROUP && fields === 'id,whatsapp_business_account{id}') return { id: GROUP, whatsapp_business_account: { id: WABA } }
  if (req.path === GROUP) return { id: GROUP, name: 'Autumn', whatsapp_business_templates: { data: [{ id: '700000000000001', name: 'order_update', status: 'APPROVED' }] } }
  if (req.path === `${PAGE}/messenger_profile`) return { data: [{ get_started: { payload: 'GET_STARTED' }, ice_breakers: [{ question: 'Size?', payload: 'SIZE' }], whitelisted_domains: ['https://shop.example.com/'] }] }
  // The welcome-flow guide shows a bare list.
  if (req.path === `${PAGE}/welcome_message_flows`) return [{ id: FLOW, name: 'Size help', eligible_platforms: ['instagram', 'messenger'], welcome_message_flow: '[{"message":{"text":"Hi"}}]', is_used_in_ad: false }]
  if (req.path === `${PAGE}/personas`) return { data: [{ id: PERSONA, name: 'Anna', profile_picture_url: 'https://cdn.example.com/p.jpg' }] }
  if (req.path === `${PAGE}/messenger_call_settings`) return { data: [{ audio_enabled: true, video_enabled: false, icon_enabled: true, call_hours: { timezone_id: 'Europe/Rome', weekly_operating_hours: [] }, call_routing: { ring_target: 'META' } }] }
  if (req.path === `${PAGE}/messaging_feature_review`) return { data: [{ feature: 'subscription_messaging', status: 'rejected' }] }
  if (req.path === PAGE && fields === 'id,messaging_feature_status') return { id: PAGE, messaging_feature_status: { hop_v2: false, msgr_multi_app: true, ig_multi_app: false } }
  if (req.path === `${PAGE}/chat_plugin`) return { data: [{ theme_color: '#000000', welcome_screen_greeting: 'Hi' }] }
  if (req.path === PAGE) return { id: PAGE, has_whatsapp_number: true, whatsapp_number: '+390000000001', instagram_business_account: { id: IG }, connected_instagram_account: { id: OTHER_IG }, page_backed_threads_account_id: '800000000000001', messenger_ads_default_icebreakers: ['Size?'] }
  if (req.path === `act_${ACCOUNT}/connected_instagram_accounts_with_iabp`) return { data: [{ id: IG, username: 'shop_a', iabp_id: '810000000000001' }, { id: OTHER_IG, username: 'other_shop', iabp_id: '810000000000002' }] }
  if (req.path === `${IG}/connected_threads_user`) return { data: [{ threads_user_id: '820000000000001' }] }
  if (req.path === `${IG}/instagram_backed_threads_user`) return {}
  if (req.path === `${PAGE}/ctx_optimization_eligibility`) return { data: [{ ctm: true }] }
  if (req.path === `${PAGE}/messenger_lead_forms`) return { data: [{ id: LEAD_TEMPLATE, privacy_url: 'https://shop.example.com/privacy', fblead_form: { id: '830000000000001' } }] }
  if (req.path === `${LEAD_TEMPLATE}/steps`) return { data: [{ id: '1', message: 'Which size do you wear?' }] }
  return { data: [] }
}

beforeEach(() => { h.connections = [CHOSEN]; h.calls.length = 0; h.reply = ownMeta; h.taken = new Set([`INSTAGRAM:${OTHER_IG}`]) })

describe('three reads; conversations are people\'s data', () => {
  it('the Page\'s own reads say which token they go with', async () => {
    for (const [name, args] of [['meta-conversations', { view: 'messenger' }], ['meta-message-templates', { view: 'messenger' }], ['meta-messaging-setup', { view: 'profile' }]] as Array<[string, Record<string, unknown>]>) {
      expect(JSON.stringify((await run(name, args)).data), name).toContain(JSON.stringify(PAGE_READ_NOTE).slice(1, -1))
    }
  })
  it('none changes anything; each reaches Meta; meta-conversations needs customers.view and is Claude\'s door only', () => {
    expect(META_ADS_MESSAGING_TOOLS.map((t) => t.name)).toEqual(['meta-conversations', 'meta-message-templates', 'meta-messaging-setup'])
    for (const t of META_ADS_MESSAGING_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly, execute: t.execute, openWorld: t.openWorld, riskTier: t.riskTier, category: t.category })
        .toEqual({ name: t.name, readOnly: true, execute: undefined, openWorld: true, riskTier: 'low', category: 'insights' })
    }
    expect(tool('meta-conversations').requires).toEqual(['ads.view', 'customers.view'])
    expect([offeredOn(tool('meta-conversations'), 'app'), offeredOn(tool('meta-conversations'), 'mcp')]).toEqual([false, true])
    expect(tool('meta-conversations').restrictedFields).toEqual({ messagingCostCents: 'financials.adspend.view' })
    for (const name of ['meta-message-templates', 'meta-messaging-setup']) {
      expect(tool(name).requires, name).toEqual(['ads.view'])
      expect([offeredOn(tool(name), 'app'), offeredOn(tool(name), 'mcp')], name).toEqual([true, true])
      expect(tool(name).restrictedFields, name).toBeUndefined()
    }
  })
  it('a business without Meta, or without a chosen Page / Instagram account, is told who sets it up — before any call', async () => {
    h.connections = []
    expect((await run('meta-messaging-setup', { view: 'profile' })).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, page: null, instagram: null }]
    expect((await run('meta-conversations', { view: 'messenger' })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-conversations', { view: 'instagram' })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-message-templates', { view: 'messenger' })).error).toMatch(/No Facebook Page is chosen/)
    expect((await run('meta-messaging-setup', { view: 'personas' })).error).toMatch(/No Facebook Page is chosen/)
    h.connections = [{ ...CHOSEN, instagram: null }]
    expect((await run('meta-conversations', { view: 'instagram' })).error).toMatch(/No Instagram account is chosen/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('every view asks only what the real gateway lets through, through the edges only', () => {
  it('meta-conversations, meta-message-templates, meta-messaging-setup', async () => {
    const days = { from: '2026-10-01', to: '2026-10-20' }
    const views: Array<[string, Record<string, unknown>]> = [
      ['meta-conversations', { view: 'messenger' }], ['meta-conversations', { view: 'messenger', personId: PERSON }],
      ['meta-conversations', { view: 'instagram' }], ['meta-conversations', { view: 'instagram', personId: IG_PERSON }], ['meta-conversations', { view: 'creators' }],
      ['meta-conversations', { view: 'messages', conversationId: CONV_M }], ['meta-conversations', { view: 'messages', conversationId: CONV_IG }],
      ['meta-conversations', { view: 'labels' }],
      ['meta-conversations', { view: 'thread-owner', personId: PERSON }], ['meta-conversations', { view: 'call-permission', personId: PERSON }],
      ['meta-conversations', { view: 'person-menu', personId: PERSON }],
      ['meta-conversations', { view: 'whatsapp-pricing', ...days, dimensions: ['PRICING_CATEGORY', 'PHONE'], phoneNumbers: [NUMBER], countries: ['IT'], categories: ['MARKETING'], types: ['REGULAR', 'FREE_ENTRY_POINT'] }],
      ['meta-conversations', { view: 'whatsapp-calls', ...days, granularity: 'monthly', directions: ['USER_INITIATED'], dimensions: ['DIRECTION'] }],
      ['meta-conversations', { view: 'whatsapp-conversations', ...days, granularity: 'half-hour', directions: ['BUSINESS_INITIATED'], categories: ['SERVICE'], types: ['FREE_TIER'] }],
      ['meta-message-templates', { view: 'messenger', name: 'order_update', search: 'ordine spedito', languages: ['it', 'de_DE'], statuses: ['APPROVED', 'REJECTED'] }],
      ['meta-message-templates', { view: 'whatsapp', categories: ['UTILITY'], quality: ['GREEN'], ...days, languages: ['it'], statuses: ['APPROVED'] }],
      ['meta-message-templates', { view: 'groups' }], ['meta-message-templates', { view: 'group', groupId: GROUP }],
      ['meta-messaging-setup', { view: 'profile' }], ['meta-messaging-setup', { view: 'profile', platform: 'instagram' }],
      ['meta-messaging-setup', { view: 'welcome-flows' }], ['meta-messaging-setup', { view: 'welcome-flows', flowId: FLOW, platform: 'instagram' }],
      ['meta-messaging-setup', { view: 'personas' }], ['meta-messaging-setup', { view: 'personas', personaId: PERSONA }],
      ['meta-messaging-setup', { view: 'calling' }], ['meta-messaging-setup', { view: 'features' }], ['meta-messaging-setup', { view: 'chat-plugin' }],
      ['meta-messaging-setup', { view: 'destinations' }], ['meta-messaging-setup', { view: 'lead-templates' }],
      ['meta-messaging-setup', { view: 'lead-templates', leadTemplateId: LEAD_TEMPLATE }],
    ]
    const failed: unknown[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args.view, res.error])
    }
    expect(failed).toEqual([])
    expect(h.calls.length).toBeGreaterThan(40)
    expect(gatewayProblems()).toEqual([])
    // The Page's own reads go with the chosen Page's token (a conversation's node and messages too); everything else — the
    // Page node, the ad account's, Instagram's and WhatsApp's reads, a lead template's steps — with the system user's.
    const byToken = new Map<string, Set<string | null | undefined>>()
    for (const c of h.calls) byToken.set(c.operation, new Set([...(byToken.get(c.operation) ?? []), pageTokenOf(c)]))
    expect([...byToken].filter(([, t]) => t.has(PAGE)).map(([op]) => op).sort()).toEqual(['messaging.callPermission', 'messaging.creators', 'messaging.instagram', 'messaging.labels', 'messaging.messenger', 'messaging.personCheck', 'messaging.personMenu', 'messaging.threadOwner', 'setup.calling', 'setup.chatPlugin', 'setup.ctxEligibility', 'setup.featureReview', 'setup.flows', 'setup.leadTemplates', 'setup.personas', 'setup.profile', 'templates.messenger'])
    expect([...byToken].filter(([, t]) => t.has(null)).map(([op]) => op).sort()).toEqual(['messaging.conversationCheck', 'messaging.messages'])
    expect([...byToken].filter(([, t]) => t.has(undefined)).map(([op]) => op).sort()).toEqual([
      'messaging.instagramOnPage', 'setup.featureStatus', 'setup.iabp', 'setup.leadTemplateSteps', 'setup.pageIdentity', 'setup.threadsBacked', 'setup.threadsLinked',
      'templates.group', 'templates.groupOwnerCheck', 'templates.groups', 'templates.whatsapp', 'whatsapp.accounts', 'whatsapp.numbers',
      'whatsapp.whatsapp-calls', 'whatsapp.whatsapp-conversations', 'whatsapp.whatsapp-pricing',
    ])
    // Fix round 1 (A1) — the ads bucket pays only for the Page node, the ad account's and Instagram's own reads; the WhatsApp
    // account's reads take the whatsapp bucket.
    expect([...new Set(h.calls.filter((c) => bucketOf(c) === 'ads').map((c) => c.operation))].sort()).toEqual(['messaging.instagramOnPage', 'setup.featureStatus', 'setup.iabp', 'setup.leadTemplateSteps', 'setup.pageIdentity', 'setup.threadsBacked', 'setup.threadsLinked'])
    expect([...new Set(h.calls.filter((c) => bucketOf(c) === 'whatsapp').map((c) => c.operation))].sort()).toEqual(['templates.group', 'templates.groupOwnerCheck', 'templates.groups', 'templates.whatsapp', 'whatsapp.accounts', 'whatsapp.numbers', 'whatsapp.whatsapp-calls', 'whatsapp.whatsapp-conversations', 'whatsapp.whatsapp-pricing'])
    // A person's id never in a path (the gateway's ledger keeps paths): only in a query.
    expect(h.calls.filter((c) => c.path.includes(PERSON) || c.path.includes(IG_PERSON)).map((c) => c.path)).toEqual([])
    // Conversations and messages only through their own edges: never inside fields.
    const fields = h.calls.map((c) => String(c.query?.fields ?? '')).join(',')
    expect(fields).not.toMatch(/(^|[^a-z_])(conversations|messages|access_token)([^a-z_]|$)/)
    const paths = new Set(h.calls.map((c) => c.path.replace(/\d+/g, 'N')))
    for (const edge of ['N/conversations', 't_N/messages', `${CONV_IG}/messages`.replace(/\d+/g, 'N'), 'N/custom_labels', 'N/thread_owner', 'N/messenger_call_permissions', 'N/custom_user_settings', 'N/owned_whatsapp_business_accounts', 'N/message_templates', 'N/template_groups', 'N/messenger_profile', 'N/welcome_message_flows']) {
      expect(paths.has(edge), edge).toBe(true)
    }
  })
  it('the WhatsApp analytics field is exactly Meta\'s modifier form, built from checked values only', () => {
    const field = whatsappAnalyticsField('whatsapp-pricing', { from: '2026-10-01', to: '2026-10-20', granularity: 'daily', dimensions: ['PRICING_CATEGORY', 'PRICING_CATEGORY'], countries: ['IT'], categories: ['MARKETING'], types: ['REGULAR'] }, [NUMBER])
    expect(field).toBe(`pricing_analytics.start(${Date.UTC(2026, 9, 1) / 1000}).end(${Date.UTC(2026, 9, 21) / 1000}).granularity(DAILY).phone_numbers(["${NUMBER}"]).country_codes(["IT"]).dimensions(["PRICING_CATEGORY"]).pricing_categories(["MARKETING"]).pricing_types(["REGULAR"])`)
    expect(whatsappAnalyticsField('whatsapp-calls', { from: '2026-10-01', to: '2026-10-01', granularity: 'half-hour', directions: ['USER_INITIATED'] }, []))
      .toBe(`call_analytics.start(${Date.UTC(2026, 9, 1) / 1000}).end(${Date.UTC(2026, 9, 2) / 1000}).granularity(HALF_HOUR).directions(["USER_INITIATED"])`)
    expect(whatsappAnalyticsField('whatsapp-conversations', { from: '2026-10-01', to: '2026-10-01', granularity: 'monthly', directions: ['UNKNOWN'], types: ['FREE_TIER'] }, []))
      .toMatch(/^conversation_analytics\..*\.conversation_types\(\["FREE_TIER"\]\)\.conversation_directions\(\["UNKNOWN"\]\)$/)
  })
})

describe('only the chosen Page, its linked Instagram account and the business\'s own WhatsApp account', () => {
  it('a conversation Meta does not show with the chosen Page or Instagram account is refused after one id + participants read', async () => {
    h.reply = (req) => (req.path === 't_499' ? { id: 't_499', participants: people([[PERSON, 'A Person'], ['120000000000099', 'Other Page']]) } : ownMeta(req))
    expect((await run('meta-conversations', { view: 'messages', conversationId: 't_499' })).error).toMatch(/not one of the chosen Facebook Page or Instagram account/)
    expect(h.calls.map((c) => [c.path, c.query?.fields])).toEqual([['t_499', 'id,participants']])
    // Meta answering another conversation: nothing read.
    h.calls.length = 0
    h.reply = (req) => (req.path === 't_498' ? { id: CONV_M, participants: people([[PAGE, 'Shop A']]) } : ownMeta(req))
    expect((await run('meta-conversations', { view: 'messages', conversationId: 't_498' })).error).toMatch(/another conversation/)
    expect(h.calls).toHaveLength(1)
    // A path-breaking id is refused before any call.
    h.calls.length = 0
    expect(() => tool('meta-conversations').input.parse({ view: 'messages', conversationId: 'mid.$abc' })).toThrow()
    expect(() => tool('meta-conversations').input.parse({ view: 'messages', conversationId: '1/feed' })).toThrow()
  })
  it('a person is read only when Meta answers a conversation of the chosen Page with them among its participants', async () => {
    for (const view of ['thread-owner', 'call-permission', 'person-menu']) {
      h.calls.length = 0
      expect((await run('meta-conversations', { view, personId: '300000000000099' })).error, view).toMatch(/has no Messenger conversation with the chosen Facebook Page/)
      expect(h.calls.map((c) => c.path), view).toEqual([`${PAGE}/conversations`])
      expect(h.calls[0].query).toMatchObject({ platform: 'messenger', user_id: '300000000000099', fields: 'id,participants' })
    }
    // Meta ignoring user_id (answering someone else's conversation) does not pass.
    h.calls.length = 0
    h.reply = (req) => (req.path === `${PAGE}/conversations` ? { data: [{ id: CONV_M, participants: people([[PERSON, 'A Person'], [PAGE, 'Shop A']]) }] } : ownMeta(req))
    expect((await run('meta-conversations', { view: 'thread-owner', personId: '300000000000099' })).error).toMatch(/has no Messenger conversation/)
    expect(h.calls).toHaveLength(1)
    expect((await run('meta-conversations', { view: 'thread-owner' })).error).toMatch(/Name the person/)
  })
  it('Instagram Direct only when Meta links the chosen Instagram account to the chosen Page', async () => {
    h.reply = (req) => (req.path === PAGE && String(req.query?.fields) === 'id,instagram_business_account' ? { id: PAGE, instagram_business_account: { id: OTHER_IG } } : ownMeta(req))
    for (const args of [{ view: 'instagram' }, { view: 'creators' }, { view: 'messages', conversationId: CONV_IG }]) {
      h.calls.length = 0
      expect((await run('meta-conversations', args)).error, args.view).toMatch(/not the one Meta links to the chosen Facebook Page/)
      expect(h.calls.some((c) => c.path === `${PAGE}/conversations` || /\/messages$/.test(c.path)), args.view).toBe(false)
    }
  })
  it('WhatsApp: a portfolio another Nexus business uses is its id and the flag, with no call; another account, number or group is refused', async () => {
    h.taken.add(`PORTFOLIO:${BIZ}`)
    const taken = await run('meta-conversations', { view: 'whatsapp-pricing', from: '2026-10-01', to: '2026-10-20' })
    expect(taken.data).toEqual({ whatsappAccount: { portfolioId: BIZ, takenByAnotherBusiness: true }, sentence: expect.stringMatching(/Another business in Nexus/) })
    expect((await run('meta-message-templates', { view: 'whatsapp' })).data).toMatchObject({ whatsappAccount: { portfolioId: BIZ, takenByAnotherBusiness: true } })
    expect(h.calls).toHaveLength(0)
    h.taken.delete(`PORTFOLIO:${BIZ}`)
    expect((await run('meta-message-templates', { view: 'whatsapp', whatsappAccountId: '500000000000099' })).error).toMatch(/not one the chosen ad account's business portfolio owns/)
    expect(h.calls.map((c) => c.path)).toEqual([`${BIZ}/owned_whatsapp_business_accounts`])
    h.calls.length = 0
    expect((await run('meta-conversations', { view: 'whatsapp-pricing', from: '2026-10-01', to: '2026-10-20', phoneNumbers: ['15550000000'] })).error).toMatch(/15550000000 is not a number of this WhatsApp account/)
    expect(h.calls.some((c) => c.path === WABA)).toBe(false)
    h.calls.length = 0
    h.reply = (req) => (req.path === GROUP && String(req.query?.fields) === 'id,whatsapp_business_account{id}' ? { id: GROUP, whatsapp_business_account: { id: '500000000000099' } } : ownMeta(req))
    expect((await run('meta-message-templates', { view: 'group', groupId: GROUP })).error).toMatch(/not one of the business's own WhatsApp account/)
    expect(h.calls.filter((c) => c.path === GROUP)).toHaveLength(1)
    // None at all: the answer says a WhatsApp Business account is needed and where it is made.
    h.reply = (req) => (req.path === `${BIZ}/owned_whatsapp_business_accounts` ? { data: [] } : ownMeta(req))
    expect((await run('meta-message-templates', { view: 'whatsapp' })).error).toBe(NO_WHATSAPP_ACCOUNT)
    expect(NO_WHATSAPP_ACCOUNT).toMatch(/WhatsApp Manager/)
    // Several accounts: name one.
    h.reply = (req) => (req.path === `${BIZ}/owned_whatsapp_business_accounts` ? { data: [{ id: WABA, name: 'A' }, { id: '500000000000002', name: 'B' }] } : ownMeta(req))
    expect((await run('meta-message-templates', { view: 'whatsapp' })).error).toMatch(/owns 2 WhatsApp accounts: name one/)
    // No portfolio on the chosen ad account.
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect((await run('meta-message-templates', { view: 'groups' })).error).toMatch(/names no Meta business portfolio/)
  })
  it('a flow, persona or lead template not the chosen Page\'s is refused; the Instagram account another business uses is its id only', async () => {
    expect((await run('meta-messaging-setup', { view: 'welcome-flows', flowId: '520000000000099' })).error).toMatch(/no welcome flow with that id on the chosen Page/)
    expect(h.calls[0].query).toMatchObject({ flow_id: '520000000000099' })
    expect((await run('meta-messaging-setup', { view: 'personas', personaId: '530000000000099' })).error).toMatch(/not one of the chosen Page's/)
    h.calls.length = 0
    expect((await run('meta-messaging-setup', { view: 'lead-templates', leadTemplateId: '540000000000099' })).error).toMatch(/not one of the chosen Page's Messenger lead templates/)
    expect(h.calls.some((c) => /\/steps$/.test(c.path))).toBe(false)
    const res = await run('meta-messaging-setup', { view: 'destinations' })
    const data = res.data as Record<string, unknown> & { page: Record<string, unknown>; instagramAccountsWithPage: unknown[] }
    expect(data.page.connectedInstagramAccount).toEqual({ instagramId: OTHER_IG, takenByAnotherBusiness: true })
    expect(data.page.instagramBusinessAccount).toEqual({ instagramId: IG, chosenHere: true, takenByAnotherBusiness: false })
    expect(data.instagramAccountsWithPage).toEqual([
      { instagramId: IG, username: 'shop_a', instagramBackedPageId: '810000000000001', chosenHere: true, takenByAnotherBusiness: false },
      { instagramId: OTHER_IG, takenByAnotherBusiness: true },
    ])
    expect(JSON.stringify(data)).not.toMatch(/other_shop/)
    expect(data.threads).toEqual({ linkedToInstagram: '820000000000001', instagramBacked: null, pageBacked: '800000000000001' })
    expect(h.calls.find((c) => c.path === `act_${ACCOUNT}/connected_instagram_accounts_with_iabp`)?.query).toMatchObject({ business_id: BIZ })
  })
})

describe('fix round 1', () => {
  it('A6 — a person is read only when Meta names BOTH them and the chosen Page (or Instagram account) among the participants', async () => {
    h.reply = (req) => (req.path === `${PAGE}/conversations` ? { data: [{ id: CONV_M, participants: people([[PERSON, 'A Person'], ['120000000000099', 'Other Page']]) }] } : ownMeta(req))
    for (const view of ['thread-owner', 'call-permission', 'person-menu']) {
      h.calls.length = 0
      expect((await run('meta-conversations', { view, personId: PERSON })).error, view).toMatch(/has no Messenger conversation with the chosen Facebook Page/)
      expect(h.calls.map((c) => c.path), view).toEqual([`${PAGE}/conversations`])
    }
  })
  it('A9 — a Page or Instagram account another business in Nexus uses is its id and the flag only, in conversations and messages', async () => {
    h.taken.add(`PAGE:120000000000099`)
    h.reply = (req) => {
      if (req.path === `${PAGE}/conversations`) return { data: [{ id: CONV_M, participants: people([['120000000000099', 'Other Shop Page'], [PAGE, 'Shop A']]) }] }
      if (req.path === CONV_M) return { id: CONV_M, participants: people([['120000000000099', 'Other Shop Page'], [PAGE, 'Shop A']]) }
      if (/\/messages$/.test(req.path)) return { data: [{ id: 'm_9', created_time: '2026-10-20T10:00:00+0000', from: { id: '120000000000099', name: 'Other Shop Page' }, to: { data: [{ id: PAGE, name: 'Shop A' }] }, message: 'Hi' }] }
      return ownMeta(req)
    }
    const list = await run('meta-conversations', { view: 'messenger' })
    expect((list.data as { items: Array<{ people: unknown[] }> }).items[0].people).toEqual([{ id: '120000000000099', takenByAnotherBusiness: true }])
    const messages = await run('meta-conversations', { view: 'messages', conversationId: CONV_M })
    expect((messages.data as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ from: { id: '120000000000099', takenByAnotherBusiness: true }, fromTheBusiness: false })
    // Re-review N5 — and in personIds (what step 38 replies to), with the same look-up.
    expect((messages.data as { personIds: unknown[] }).personIds).toEqual([{ id: '120000000000099', takenByAnotherBusiness: true }])
    expect(JSON.stringify([list.data, messages.data])).not.toMatch(/Other Shop Page/)
  })
  it('re-review N4 — an Instagram account another business uses, in an Instagram conversation and in a message\'s to', async () => {
    h.reply = (req) => {
      if (req.path === `${PAGE}/conversations`) return { data: [{ id: CONV_IG, participants: people([[OTHER_IG, 'other_shop'], [IG, 'shop_a']]) }] }
      if (req.path === CONV_M) return { id: CONV_M, participants: people([[PERSON, 'A Person'], [PAGE, 'Shop A']]) }
      if (/\/messages$/.test(req.path)) return { data: [{ id: 'm_8', created_time: '2026-10-20T10:00:00+0000', from: { id: PAGE, name: 'Shop A' }, to: { data: [{ id: OTHER_IG, username: 'other_shop' }, { id: PERSON, name: 'A Person' }] }, message: 'Hi' }] }
      return ownMeta(req)
    }
    const list = await run('meta-conversations', { view: 'instagram' })
    expect((list.data as { items: Array<{ people: unknown[] }> }).items[0].people).toEqual([{ id: OTHER_IG, takenByAnotherBusiness: true }])
    const messages = await run('meta-conversations', { view: 'messages', conversationId: CONV_M })
    expect((messages.data as { items: Array<{ to: unknown[] }> }).items[0].to).toEqual([{ id: OTHER_IG, takenByAnotherBusiness: true }, { id: PERSON, name: 'A Person', username: null }])
    expect((messages.data as { personIds: unknown[] }).personIds).toEqual([{ id: PERSON, takenByAnotherBusiness: false }])
    expect(JSON.stringify([list.data, messages.data])).not.toMatch(/other_shop/)
  })
  it('B nit — a listed conversation whose id Nexus would not read is marked, never guessed', async () => {
    h.reply = (req) => (req.path === `${PAGE}/conversations` ? { data: [{ id: 't_mid.1457764197618:41d102a3e1ae206a38', participants: people([[PERSON, 'A Person'], [PAGE, 'Shop A']]) }, { id: CONV_M, participants: people([[PERSON, 'A Person'], [PAGE, 'Shop A']]) }] } : ownMeta(req))
    const items = ((await run('meta-conversations', { view: 'messenger' })).data as { items: Array<Record<string, unknown>> }).items
    expect(items[0]).toMatchObject({ readable: false, readableNote: expect.stringMatching(/view messages refuses it/) })
    expect(items[1]).not.toHaveProperty('readable')
    expect((await run('meta-conversations', { view: 'messages', conversationId: 'AbCdEfGh12345678' })).error).toMatch(/not a Meta conversation id Nexus reads/)
  })
  it('B-SF4 — welcome flows ask the guide\'s welcome_message and the SDK\'s fields; one Meta refuses is dropped on its own', async () => {
    h.reply = (req) => {
      if (req.path === `${PAGE}/welcome_message_flows` && String(req.query?.fields).includes('welcome_message,')) return metaError('100', '(#100) Tried accessing nonexisting field (welcome_message)')
      if (req.path === `${PAGE}/welcome_message_flows`) return [{ id: FLOW, name: 'Size help', eligible_platforms: ['messenger'], welcome_message_flow: '[{"message":{"text":"Hi"}}]', welcome_message_sequence: '{"steps":[]}' }]
      return ownMeta(req)
    }
    const res = await run('meta-messaging-setup', { view: 'welcome-flows' })
    expect(res.data).toMatchObject({ items: [{ flowId: FLOW, messages: [{ message: { text: 'Hi' } }], sequence: { steps: [] } }], notRead: [{ part: 'welcome_message' }] })
    const asked = h.calls.filter((c) => c.path === `${PAGE}/welcome_message_flows`).map((c) => c.query?.fields)
    expect(asked).toEqual([
      'id,name,eligible_platforms,last_update_time,is_used_in_ad,welcome_message,welcome_message_flow,welcome_message_sequence,is_ig_only_flow,compatible_platforms',
      'id,name,eligible_platforms,last_update_time,is_used_in_ad,welcome_message_flow,welcome_message_sequence,is_ig_only_flow,compatible_platforms',
    ])
    expect(gatewayProblems()).toEqual([])
    // The guide's own answer field is read too.
    h.reply = (req) => (req.path === `${PAGE}/welcome_message_flows` ? [{ id: FLOW, welcome_message: '[{"message":{"text":"Ciao"}}]', eligible_platforms: ['instagram'] }] : ownMeta(req))
    expect(((await run('meta-messaging-setup', { view: 'welcome-flows' })).data as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ messages: [{ message: { text: 'Ciao' } }] })
  })
  it('A5 — a WhatsApp account\'s template read names summary on every page, so the gateway never takes it for a Page\'s', async () => {
    h.reply = (req) => {
      if (req.path === `${WABA}/message_templates` && !req.query?.after) return { data: [{ id: '700000000000001', name: 'a', last_updated_time: 1760000000 }], paging: { cursors: { after: 'QVFIUmxtX0Z6dGFCLTNnVXc9' }, next: 'https://graph.facebook.com/next' }, summary: { total_count: 2 } }
      if (req.path === `${WABA}/message_templates`) return { data: [{ id: '700000000000002', name: 'b', last_updated_time: '2026-10-20T10:00:00+0000' }] }
      return ownMeta(req)
    }
    const res = await run('meta-message-templates', { view: 'whatsapp', maxRows: 2 })
    const pages = h.calls.filter((c) => c.path === `${WABA}/message_templates`)
    expect(pages.map((c) => [c.query?.summary, c.query?.after ?? null])).toEqual([['total_count', null], ['total_count', 'QVFIUmxtX0Z6dGFCLTNnVXc9']])
    expect(pages.map(pageTokenOf)).toEqual([undefined, undefined])
    expect(pages.map(bucketOf)).toEqual(['whatsapp', 'whatsapp'])
    // B-SF6 — last_updated_time as Meta writes it: Unix seconds or an ISO time.
    expect((res.data as { items: Array<Record<string, unknown>> }).items.map((t) => t.lastUpdatedTime)).toEqual(['2025-10-09T08:53:20.000Z', '2026-10-20T10:00:00+0000'])
  })
  it('B-SF2, B-SF5, B11 — the WhatsApp, window and creator sentences say what Meta asks', () => {
    expect(WHATSAPP_ACCESS).toMatch(/ADMIN system user/)
    expect(WHATSAPP_ACCESS).toMatch(/whatsapp_business_messaging/)
    expect(WINDOW_RULES).toMatch(/from Nexus: an approved Messenger utility template \(Messenger only, not Instagram/)
    expect(WINDOW_RULES).toMatch(/Sponsored Messages, Marketing Messages/)
    expect(CREATOR_ACCESS).toMatch(/instagram_basic, pages_read_user_content, pages_show_list and business_management/)
  })
  it('B12 — a story reply or mention is read flat or nested', () => {
    expect(messageRow({ id: 'm', story: { mention: { id: 's1', link: 'https://cdn.example.com/s1' } } }, [PAGE]).story).toEqual({ kind: 'mention', storyId: 's1', link: 'https://cdn.example.com/s1' })
    expect(messageRow({ id: 'm', story: { reply_to: { id: 's2', link: 'https://cdn.example.com/s2' } } }, [PAGE]).story).toEqual({ kind: 'reply', storyId: 's2', link: 'https://cdn.example.com/s2' })
    expect(messageRow({ id: 'm', story: { id: 's3', link: 'https://cdn.example.com/s3' } }, [PAGE]).story).toEqual({ kind: null, storyId: 's3', link: 'https://cdn.example.com/s3' })
  })
})

describe('named keys only; windows said, never assumed', () => {
  it('messages: the person and the business apart, no e-mail, no raw field; the window from the person\'s last message', async () => {
    const res = await run('meta-conversations', { view: 'messages', conversationId: CONV_M, maxRows: 500 })
    const data = res.data as { items: Array<Record<string, unknown>>; window: Record<string, unknown>; platform: string }
    expect(data.platform).toBe('messenger')
    expect((res.data as { personIds: unknown[] }).personIds).toEqual([{ id: PERSON, takenByAnotherBusiness: false }])
    expect(h.calls.find((c) => /\/messages$/.test(c.path))?.query).toMatchObject({ limit: 20 })
    expect(JSON.stringify(data)).not.toMatch(/@|unknown_raw|is_self_reply/)
    expect(data.items[1]).toMatchObject({ messageId: 'm_1', fromTheBusiness: false, from: { id: PERSON, name: 'A Person' }, text: 'Hello', replyToMessageId: 'm_0', attachments: [{ attachmentId: 'a1', url: 'https://cdn.example.com/a.jpg', kind: 'image' }] })
    expect(data.items[0]).toMatchObject({ fromTheBusiness: true })
    expect(data.window).toEqual({ lastMessageFromPerson: '2026-10-20T10:00:00.000Z', standardWindowEndsAt: '2026-10-21T10:00:00.000Z', rules: WINDOW_RULES })
    expect(WINDOW_RULES).toMatch(/24 hours/)
    expect(WINDOW_RULES).toMatch(/7 days/)
    expect(WINDOW_RULES).toMatch(/ACCOUNT_UPDATE, POST_PURCHASE_UPDATE and CONFIRMED_EVENT_UPDATE tags fail since 2026-04-27/)
    expect(windowOf([messageRow({ id: 'x', from: { id: PAGE } }, [PAGE])])).toMatchObject({ lastMessageFromPerson: null, standardWindowEndsAt: null })
    const list = await run('meta-conversations', { view: 'messenger' })
    expect(JSON.stringify(list.data)).not.toMatch(/@facebook\.com/)
    expect((list.data as { items: Array<{ people: unknown[] }> }).items[0].people).toEqual([{ id: PERSON, name: 'A Person', username: 'A Person' }])
  })
  it('WhatsApp cost in minor units of the account\'s currency, hidden from a person without ad-spend access', async () => {
    const res = await run('meta-conversations', { view: 'whatsapp-pricing', from: '2026-10-01', to: '2026-10-20' })
    const data = res.data as { items: Array<Record<string, unknown>> }
    expect(data.items[0]).toMatchObject({ phoneNumber: NUMBER, pricingCategory: 'MARKETING', messages: 2, messagingCostCents: 1558 })
    const calls = await run('meta-conversations', { view: 'whatsapp-calls', from: '2026-10-01', to: '2026-10-20' })
    expect((calls.data as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ calls: 3, averageCallSeconds: 106, messagingCostCents: 48 })
    const principal = (permissions: string[]): UserPrincipal => ({ kind: 'user', userId: 'u-15', label: 'step 15 test', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: null as never, via: 'claude' })
    const seen = (permissions: string[]) => (visibleTo(principal(permissions), tool('meta-conversations'), res.data) as { items: Array<Record<string, unknown>> }).items[0]
    expect(seen(['ads.view', 'customers.view'])).not.toHaveProperty('messagingCostCents')
    expect(seen(['ads.view', 'customers.view'])).toMatchObject({ messages: 2 })
    expect(seen(['ads.view', 'customers.view', 'financials.adspend.view'])).toMatchObject({ messagingCostCents: 1558 })
  })
  it('the analytics arguments are judged before any call: days, one year back, each view\'s own filters', async () => {
    for (const [args, words] of [
      [{ view: 'whatsapp-pricing' }, /Name the days/], [{ view: 'whatsapp-pricing', from: '2026-10-20', to: '2026-10-01' }, /from is after to/],
      [{ view: 'whatsapp-pricing', from: '2024-01-01', to: '2024-01-02' }, /one year back/],
      [{ view: 'whatsapp-calls', from: '2026-10-01', to: '2026-10-02', categories: ['MARKETING'] }, /takes no categories/],
      [{ view: 'whatsapp-pricing', from: '2026-10-01', to: '2026-10-02', dimensions: ['CONVERSATION_TYPE'] }, /takes dimensions COUNTRY, PHONE, PRICING_CATEGORY, PRICING_TYPE, TIER only/],
      [{ view: 'whatsapp-pricing', from: '2026-10-01', to: '2026-10-02', directions: ['USER_INITIATED'] }, /takes no directions/],
      [{ view: 'whatsapp-conversations', from: '2026-10-01', to: '2026-10-02', types: ['FREE_CUSTOMER_SERVICE'] }, /takes types FREE_ENTRY_POINT, FREE_TIER, REGULAR only/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      expect((await run('meta-conversations', args)).error, JSON.stringify(args)).toMatch(words)
    }
    expect(() => tool('meta-conversations').input.parse({ view: 'whatsapp-pricing', from: '2026-02-30', to: '2026-03-01' })).toThrow()
    expect(() => tool('meta-conversations').input.parse({ view: 'whatsapp-pricing', countries: ['it'] })).toThrow()
    expect(h.calls).toHaveLength(0)
  })
  it('templates and the setup by named keys; Messenger templates take no WhatsApp filters', async () => {
    expect((await run('meta-message-templates', { view: 'messenger', categories: ['MARKETING'] })).error).toMatch(/UTILITY only/)
    expect(h.calls).toHaveLength(0)
    const wa = await run('meta-message-templates', { view: 'whatsapp', statuses: ['APPROVED', 'APPROVED'] })
    expect(h.calls.find((c) => c.path === `${WABA}/message_templates`)?.query).toMatchObject({ status: 'APPROVED', summary: 'total_count' })
    expect((wa.data as { items: Array<Record<string, unknown>>; totalCount: number }).items[0]).toMatchObject({ templateId: '700000000000001', name: 'order_update', status: 'APPROVED', quality: 'GREEN' })
    expect((wa.data as { totalCount: number }).totalCount).toBe(1)
    const flows = await run('meta-messaging-setup', { view: 'welcome-flows', platform: 'instagram' })
    expect((flows.data as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({ flowId: FLOW, platforms: ['instagram', 'messenger'], usedInAnAd: false, messages: [{ message: { text: 'Hi' } }] })
    const profile = await run('meta-messaging-setup', { view: 'profile', platform: 'instagram' })
    expect(h.calls.find((c) => c.path === `${PAGE}/messenger_profile`)?.query).toMatchObject({ platform: 'instagram' })
    expect((profile.data as { profile: Record<string, unknown> }).profile).toMatchObject({ getStarted: { payload: 'GET_STARTED' }, allowlistedDomains: ['https://shop.example.com/'] })
    const features = await run('meta-messaging-setup', { view: 'features' })
    expect(features.data).toMatchObject({ featureReview: [{ feature: 'subscription_messaging', status: 'rejected' }], routing: { messengerMultiApp: true }, note: expect.stringMatching(/Human Agent/) })
  })
})

describe('Meta\'s refusals say what access is missing', () => {
  it('a permission refusal names the access and the Page\'s own token (never "this system user"); the Instagram and WhatsApp ones their own', async () => {
    h.reply = (req) => (req.path === `${PAGE}/conversations` ? metaError('200', '(#200) Requires pages_messaging permission', 'forbidden') : ownMeta(req))
    const messenger = await run('meta-conversations', { view: 'messenger' })
    expect(messenger.error).toMatch(/^Meta refused this read of the chosen Page \(Meta's words: \(#200\) Requires pages_messaging permission\)\. /)
    expect(messenger.error).toMatch(/Advanced Access for pages_messaging/)
    expect(messenger.error).not.toMatch(/system user read|ads_read/)
    // A refused Page token (Meta's 190 on a Page-token read) is the Page's, never "make a new system-user token".
    h.reply = (req) => (req.path === `${PAGE}/personas` ? metaError('190', '(#190) The Page access token is invalid', 'auth_expired') : ownMeta(req))
    const personas = await run('meta-messaging-setup', { view: 'personas' })
    expect(personas.error).toMatch(/Meta refused the chosen Page's own token for this read \(Meta's words: \(#190\) The Page access token is invalid\); the business's system-user token is not concerned/)
    expect(personas.error).not.toMatch(/Make a new token/)
    h.reply = (req) => (req.path === `${PAGE}/conversations` ? metaError('200', '(#200) Requires pages_messaging permission', 'forbidden') : ownMeta(req))
    expect((await run('meta-conversations', { view: 'instagram' })).error).toMatch(/verified business/)
    expect((await run('meta-conversations', { view: 'creators' })).error).toMatch(/instagram_creator_marketplace_messaging/)
    h.reply = (req) => (req.path === `${BIZ}/owned_whatsapp_business_accounts` ? metaError('200', '(#200) Requires whatsapp_business_management', 'forbidden') : ownMeta(req))
    expect((await run('meta-message-templates', { view: 'whatsapp' })).error).toMatch(/whatsapp_business_management/)
    h.reply = (req) => (req.path === `${PAGE}/message_templates` ? metaError('200', '(#200) Permissions error', 'forbidden') : ownMeta(req))
    expect((await run('meta-message-templates', { view: 'messenger' })).error).toMatch(/page_utility_messaging/)
    // The template-group list is SDK-only: Meta's refusal points to the documented one-group read.
    h.reply = (req) => (req.path === `${WABA}/template_groups` ? metaError('100', '(#100) Unknown path components') : ownMeta(req))
    expect((await run('meta-message-templates', { view: 'groups' })).error).toMatch(/only in its SDK; view group reads one group/)
  })
  it('a refused field group is named, the rest still answers', async () => {
    h.reply = (req) => (req.path === `${PAGE}/messenger_call_settings` && String(req.query?.fields).includes('call_routing') ? metaError('100', '(#100) Tried accessing nonexisting field (call_routing)') : ownMeta(req))
    const res = await run('meta-messaging-setup', { view: 'calling' })
    expect(res.data).toMatchObject({ calling: { audioEnabled: true, callIconShown: true }, notRead: [{ part: 'routing' }] })
    h.reply = (req) => (req.path === `${LEAD_TEMPLATE}/steps` ? metaError('100', '(#100) Unknown path components') : ownMeta(req))
    const lead = await run('meta-messaging-setup', { view: 'lead-templates', leadTemplateId: LEAD_TEMPLATE })
    expect(lead.data).toMatchObject({ leadTemplate: { leadTemplateId: LEAD_TEMPLATE, leadFormId: '830000000000001' }, steps: null, notRead: [expect.stringMatching(/steps edge/)] })
    // Review fix A7 — the steps by named keys, with the reference's fields only.
    h.reply = ownMeta
    h.calls.length = 0
    const steps = await run('meta-messaging-setup', { view: 'lead-templates', leadTemplateId: LEAD_TEMPLATE })
    expect((steps.data as { steps: unknown[] }).steps).toEqual([{ stepId: '1', stepType: null, message: 'Which size do you wear?', replyType: null, answers: [], nextStepIds: [], allowToSkip: null, prefillType: null, optionsFormat: null, invalidReplyText: null, answerValidation: null }])
    expect(h.calls.find((c) => c.path === `${LEAD_TEMPLATE}/steps`)?.query?.fields).toBe('id,step_type,message,reply_type,answers,next_step_ids,allow_to_skip,prefill_type,options_format,invalid_reply_text,answer_validation_enabled')
  })
})

describe('through the one door: conversations need customers.view, and never reach the in-app chat', () => {
  const principal = (permissions: string[], via: 'claude' | 'app'): UserPrincipal => ({
    kind: 'user', userId: 'u-meta-15', label: 'step 15 test', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: null as never, via,
  })
  it('without customers.view meta-conversations is forbidden (templates and setup are not); in the app it does not exist', async () => {
    h.connections = []
    const adsOnly = principal(['ads.view'], 'claude')
    await expect(callTool(adsOnly, 'meta-conversations', { view: 'labels' })).rejects.toMatchObject({ code: 'forbidden' })
    const both = principal(['ads.view', 'customers.view'], 'app')
    await expect(callTool(both, 'meta-conversations', { view: 'labels' })).rejects.toMatchObject({ code: 'unknown_tool' })
    expect(h.calls).toHaveLength(0)
  })
})
