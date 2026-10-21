/**
 * Meta step 26 — create-meta-boost and set-meta-partnership-access as the approval gate uses them (Meta, the account, step 16's
 * partnership reads and the records are stand-ins): a boost is a creative of an EXISTING post made by step 25's builder —
 * every silent feature OFF unless asked, Meta's check first, nothing spends — from the chosen Page's post, the chosen Instagram
 * account's media or link, or a creator's content (the chosen Page and Instagram account as its sponsors; never the
 * business's own, never another Nexus business's); its eligibility is read first; a creator's ad code is said to be kept in
 * plain text with the request and its records (AD_CODE_KEPT) and is not in the preview's words or the change record; "was it
 * new?" from the account's creatives read just before the send. The partnership tool acts for the chosen Instagram account and
 * the chosen Page (Meta's partnership host, per item), answers the making of an ad code in words, and each action's undo is
 * its inverse (or says why there is none); undo-change runs a boost's undo. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  chosen: {} as Record<string, unknown>,
  records: [] as Array<{ toolName?: string; after: unknown }>,
  taken: new Set<string>(),
  read: vi.fn(),
  listPaged: vi.fn(),
  partners: vi.fn(),
  send: vi.fn(),
  rest: vi.fn(),
  check: vi.fn(),
  owned: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => h.chosen),
  objectInAccount: h.owned,
}))
vi.mock('../../marketing/meta-ads/live-objects.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-objects.js')>()),
  listPaged: h.listPaged,
}))
vi.mock('../../marketing/meta-ads/live-partners.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-partners.js')>()),
  livePartnership: h.partners,
}))
vi.mock('../../marketing/meta-ads/taken.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/taken.js')>()),
  takenIds: vi.fn(async (product: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(`${product}:${id}`)))),
}))
vi.mock('../../marketing/meta-ads/read-client.js', () => ({ metaReadOne: h.read }))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaSendChange: h.send,
  metaSendRest: h.rest,
  metaCheckChange: h.check,
}))
vi.mock('../../../db.js', () => ({
  default: {
    agentChange: {
      findMany: vi.fn(async ({ where }: { where: { toolName?: unknown; after: { array_contains: Array<Record<string, unknown>> } } }) => {
        const wanted = where.after.array_contains[0]
        const tools = typeof where.toolName === 'string' ? [where.toolName] : (where.toolName as { in?: string[] } | undefined)?.in ?? null
        return h.records
          .filter((r) => !tools || !r.toolName || tools.includes(r.toolName))
          .filter((r) => ((r.after as { items?: Array<Record<string, unknown>> }).items ?? []).some((i) => Object.entries(wanted).every(([k, v]) => i[k] === v)))
          .map((r, i) => ({ id: `chg-${i}`, after: r.after }))
      }),
    },
  },
}))

import { META_ADS_BOOSTS_TOOLS } from './meta-ads-boosts.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { AD_CODE_KEPT, BOOST_LINK_CTAS, CREATE_AD_CODE_ANSWER, isMetaCta, withoutAdCode } from '../../marketing/meta-ads/change-boosts.js'
import { CREATIVE_RECORD_TOOLS } from '../../marketing/meta-ads/change-creatives.js'
import { __mediaTiming } from '../../marketing/meta-ads/change-media.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { META_CREATIVE_FEATURES, META_NON_CATALOG_FORMATS } from '../../gateway/meta-creative-rules.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { ToolContext, ToolResult } from '../tool-types.js'
import { callTool, offeredOn, surfaceOf } from '../call-tool.js'

const boost = META_ADS_BOOSTS_TOOLS.find((t) => t.name === 'create-meta-boost')!
const access = META_ADS_BOOSTS_TOOLS.find((t) => t.name === 'set-meta-partnership-access')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const parse = (tool = boost) => (args: Record<string, unknown>) => tool.input.parse(args) as Record<string, unknown>
const preview = async (args: Record<string, unknown>, tool = boost) => (await tool.handler(parse(tool)(args), asker)) as ToolResult & { preview: Record<string, any>; error?: string }
const refusal = async (args: Record<string, unknown>, tool = boost) => {
  const p = await preview(args, tool)
  expect(p.ok, JSON.stringify(p)).toBe(false)
  return p.error as string
}
const run = async (args: Record<string, unknown>, tool = boost) => {
  const p = await preview(args, tool)
  expect(p.ok, JSON.stringify(p)).toBe(true)
  return (await tool.execute!(parse(tool)(args), approved(p.preview))) as ToolResult & { data: Record<string, any>; change: { before: any; after: any } }
}

const ACT = 'act_1234567890'
const PAGE = '120000000000010'
const IG = '17841400000000001'
const POST = `${PAGE}_500000000000009`
const MEDIA = '17900000000000001'
const CREATOR_IG = '17841400000000099'
const CREATOR_PAGE = '120000000000555'
const CODE = 'AbC123xyz_Code-9'
const checked = () => h.check.mock.calls[0][1] as { objectId: string; kind: string; edge: string; params: Record<string, string> }
const sentJson = (key: string) => JSON.parse(checked().params[key])
/** Meta's reads: a post of the chosen Page, the chosen account's media, the account's username. */
let reads: Record<string, Record<string, unknown>> = {}
const lookupRow = (over: Record<string, unknown> = {}) => ({
  contentId: MEDIA, platform: 'INSTAGRAM', mediaType: 'IMAGE', author: { name: 'creator', instagramId: CREATOR_IG, pageId: null },
  partnerships: [{ adEligibility: 'AD_READY', permissionStatus: 'APPROVED', eligibilityErrors: [], taggedPartner: { instagramId: IG, pageId: PAGE } }], ...over,
})

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  __mediaTiming.sleep = async () => undefined
  __mediaTiming.polls = 1
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.chosen = { connectionId: 'm-1', adAccountId: '1234567890', businessId: '9876543210', pageId: PAGE, instagramId: IG }
  h.records = []
  h.taken = new Set()
  reads = {
    [POST]: { id: POST, is_eligible_for_promotion: true, is_instagram_eligible: true },
    [MEDIA]: { id: MEDIA, owner: { id: IG }, media_type: 'IMAGE', media_product_type: 'FEED', boost_eligibility_info: { eligible_to_boost: true } },
    [IG]: { id: IG, username: 'shop_a' },
  }
  h.read.mockReset(); h.read.mockImplementation(async (_c: unknown, q: { path: string }) => ({ body: reads[q.path] ?? {}, calls: 1 }))
  h.listPaged.mockReset(); h.listPaged.mockImplementation(async () => ({ rows: [], more: false, totalCount: null }))
  h.partners.mockReset(); h.partners.mockImplementation(async (input: { view: string }) => (input.view === 'lookup' ? { items: [lookupRow()] } : { items: [] }))
  h.send.mockReset()
  h.rest.mockReset()
  h.check.mockReset(); h.check.mockImplementation(async () => undefined)
  h.owned.mockReset(); h.owned.mockImplementation(async (_a: unknown, id: string) => id)
})

describe('the tools', () => {
  it('are changes a person always approves (ask ceiling, open world, high risk), each with an undo; the ad code is a secret argument', () => {
    for (const tool of [boost, access]) {
      expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'partial', requires: ['ads.campaigns.manage'] })
      expect(tool.undo).toBeDefined()
      expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(boost.secretArgs).toEqual(['adCode'])
    // Review round 2 — on both doors (the Undo button and the in-app assistant run it), and the truth about the code said.
    expect(boost.surfaces).toBeUndefined()
    expect(boost.description).toContain(AD_CODE_KEPT)
    expect(AD_CODE_KEPT).toMatch(/plain text .* also after it runs/)
    expect(boost.description).not.toMatch(/never (shown, )?recorded|until it runs|not in the change record|no hash/)
    expect(boost.description).toMatch(/SPENDS NOTHING/)
    expect(boost.consequencesFor!({ action: 'undo' })).toEqual({ reversibility: 'none' })
    expect(access.consequencesFor!({ action: 'delete-ad-code' })).toEqual({ reversibility: 'none' })
    expect(access.consequencesFor!({ action: 'collab-invite' })).toEqual({ reversibility: 'none' })
    expect(access.consequencesFor!({ action: 'approve-creators' })).toEqual({ reversibility: 'partial' })
    // A creative either tool claims is claimed for the other ("was it new?").
    expect(CREATIVE_RECORD_TOOLS).toEqual(['create-meta-creative', 'create-meta-boost'])
    for (const cta of BOOST_LINK_CTAS) expect(isMetaCta(cta), cta).toBe(true)
  })
})

describe('create-meta-boost — the preview', () => {
  it('a post of the chosen Page, also on Instagram: its eligibility read first, every silent key OFF, Meta checks it, nothing spends', async () => {
    const p = await preview({ name: 'Boost A', source: 'facebook-post', postId: POST })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.read.mock.calls.find((c) => (c[1] as { path: string }).path === POST)?.[1]).toMatchObject({ query: { fields: 'id,is_eligible_for_promotion,promotable_id,is_instagram_eligible' } })
    expect(checked()).toMatchObject({ objectId: ACT, kind: 'adaccount', edge: 'adcreatives' })
    expect(checked().params.object_story_id).toBe(POST)
    expect(checked().params.instagram_user_id).toBe(IG)
    const features = sentJson('degrees_of_freedom_spec').creative_features_spec
    expect(Object.keys(features).sort()).toEqual([...META_CREATIVE_FEATURES].sort())
    expect(Object.values(features).every((f: any) => f.enroll_status === 'OPT_OUT')).toBe(true)
    expect(sentJson('contextual_multi_ads')).toEqual({ enroll_status: 'OPT_OUT' })
    expect(sentJson('format_transformation_spec')).toEqual(META_NON_CATALOG_FORMATS.map((format) => ({ format, data_source: ['none'] })))
    expect(sentJson('destination_spec')).toEqual({ destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' })
    expect(checked().params.asset_feed_spec).toBeUndefined()
    expect(p.preview.spendsMoney).toBe(false)
    expect(p.preview.metaCheck.checked).toBe('all')
    const words = p.preview.warnings.join(' ')
    expect(words).toMatch(/spends nothing/)
    expect(words).toMatch(/Music: none \(an existing post keeps its own media/)
    expect(words).toMatch(/Meta reuses it/)
    expect(p.preview.changes['Runs as'].to).toMatch(/Page and Instagram account/)
  })

  it('Meta\'s eligibility answers first: a post it will not promote, one not for Instagram, its promotable post, another Page\'s post', async () => {
    reads[POST] = { id: POST, is_eligible_for_promotion: false }
    expect(await refusal({ name: 'B', source: 'facebook-post', postId: POST })).toMatch(/cannot be promoted/)
    reads[POST] = { id: POST, is_eligible_for_promotion: true, is_instagram_eligible: false }
    const p = await preview({ name: 'B', source: 'facebook-post', postId: POST })
    expect(checked().params.instagram_user_id).toBeUndefined()
    expect(p.preview.warnings.join(' ')).toMatch(/boosted on Facebook only/)
    expect(await refusal({ name: 'B', source: 'facebook-post', postId: POST, withInstagram: true })).toMatch(/cannot run on Instagram/)
    reads[POST] = { id: POST, is_eligible_for_promotion: true, promotable_id: `${PAGE}_500000000000010` }
    h.check.mockClear()
    await preview({ name: 'B', source: 'facebook-post', postId: POST })
    expect(checked().params.object_story_id).toBe(`${PAGE}_500000000000010`)
    expect(await refusal({ name: 'B', source: 'facebook-post', postId: '120000000000099_500000000000001' })).toMatch(/not on the Facebook Page this business chose/)
    expect(h.check.mock.calls.length).toBe(1)
  })

  it('the chosen Instagram account\'s media: its owner and boost eligibility first; IGTV and ineligible media refused in words', async () => {
    const p = await preview({ name: 'B', source: 'instagram-media', mediaId: MEDIA })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(checked().params).toMatchObject({ object_id: PAGE, instagram_user_id: IG, source_instagram_media_id: MEDIA })
    reads[MEDIA] = { ...reads[MEDIA], boost_eligibility_info: { eligible_to_boost: false, boost_ineligible_reason: 'copyrighted music' } }
    expect(await refusal({ name: 'B', source: 'instagram-media', mediaId: MEDIA })).toMatch(/cannot be boosted \(copyrighted music\)/)
    reads[MEDIA] = { ...reads[MEDIA], media_product_type: 'IGTV', boost_eligibility_info: { eligible_to_boost: true } }
    expect(await refusal({ name: 'B', source: 'instagram-media', mediaId: MEDIA })).toMatch(/IGTV/)
    reads[MEDIA] = { id: MEDIA, owner: { id: '17841400000000777' }, username: 'someone' }
    reads[IG] = { id: IG, username: 'shop_a' }
    expect(await refusal({ name: 'B', source: 'instagram-media', mediaId: MEDIA })).toMatch(/not the chosen Instagram account's/)
    expect(await refusal({ name: 'B', source: 'instagram-media', mediaId: MEDIA, withInstagram: false })).toMatch(/withInstagram goes with source facebook-post only/)
  })

  it('a post link only when it IS the chosen account\'s own media (instagram_permalink_url, as Meta writes it)', async () => {
    h.listPaged.mockImplementation(async (_c: string, op: string) => (op === 'boost.permalinkFind' ? { rows: [{ id: MEDIA, permalink: 'https://www.instagram.com/p/AbCdEf12345/' }], more: false, totalCount: null } : { rows: [], more: false, totalCount: null }))
    const p = await preview({ name: 'B', source: 'instagram-link', permalink: 'https://instagram.com/p/AbCdEf12345?igsh=abc' })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(checked().params).toMatchObject({ object_id: PAGE, instagram_user_id: IG, instagram_permalink_url: 'https://www.instagram.com/p/AbCdEf12345/' })
    expect(checked().params.source_instagram_media_id).toBeUndefined()
    expect(await refusal({ name: 'B', source: 'instagram-link', permalink: 'https://www.instagram.com/p/Other123456/' })).toMatch(/not one of the chosen Instagram account's own posts/)
    expect(await refusal({ name: 'B', source: 'instagram-link', permalink: 'https://www.example.com/p/AbCdEf12345/' })).toMatch(/link to an Instagram post/)
  })

  it('a creator\'s Instagram media: listed for the brand, the chosen Page and Instagram account its sponsors, ad_format said', async () => {
    const p = await preview({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, identities: 'first' })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.partners).toHaveBeenCalledWith(expect.objectContaining({ view: 'lookup', contentIds: [MEDIA] }))
    expect(checked().params).toMatchObject({ object_id: PAGE, source_instagram_media_id: MEDIA })
    expect(checked().params.instagram_user_id).toBeUndefined()
    expect(sentJson('facebook_branded_content')).toEqual({ sponsor_page_id: PAGE })
    expect(sentJson('instagram_branded_content')).toEqual({ sponsor_id: IG })
    expect(sentJson('branded_content')).toEqual({ ad_format: 2 })
    expect(p.preview.warnings.join(' ')).toMatch(/creator's account runs it and this business is its sponsor/)
    // The business's own, another Nexus business's, not listed, not eligible: refused in words, nothing checked.
    h.check.mockClear()
    h.partners.mockImplementation(async () => ({ items: [lookupRow({ author: { instagramId: IG, pageId: null } })] }))
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA })).toMatch(/is the business's own/)
    h.partners.mockImplementation(async () => ({ items: [{ contentId: MEDIA, takenByAnotherBusiness: true }] }))
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA })).toMatch(/another business in Nexus uses/)
    h.partners.mockImplementation(async () => ({ items: [lookupRow()] }))
    h.taken.add(`INSTAGRAM:${CREATOR_IG}`)
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA })).toMatch(/another business in Nexus uses/)
    h.taken.clear()
    h.partners.mockImplementation(async () => ({ items: [] }))
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA })).toMatch(/does not list content/)
    h.partners.mockImplementation(async () => ({ items: [lookupRow({ partnerships: [{ adEligibility: 'INELIGIBLE', eligibilityErrors: [{ message: 'This reel can\'t be used in ads because it contains copyrighted music.' }], taggedPartner: { instagramId: IG } }] })] }))
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA })).toMatch(/cannot be used in an ad \(INELIGIBLE: This reel can't be used/)
    h.partners.mockImplementation(async () => ({ items: [lookupRow({ platform: 'FACEBOOK' })] }))
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA })).toMatch(/is Facebook content/)
    expect(h.check).not.toHaveBeenCalled()
  })

  it('a creator\'s ad code: sent to Meta, not in the preview\'s words; the content it unlocks is what the preview stands on', async () => {
    h.partners.mockImplementation(async () => ({ items: [lookupRow()] }))
    const p = await preview({ name: 'B', source: 'creator-instagram-code', adCode: CODE })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.partners).toHaveBeenCalledWith(expect.objectContaining({ view: 'lookup', adCodes: [CODE] }))
    expect(sentJson('branded_content')).toEqual({ instagram_boost_post_access_token: CODE, ad_format: 1 })
    expect(JSON.stringify(p.preview)).not.toContain(CODE)
    expect(p.preview.warnings).toContain(AD_CODE_KEPT)
    // Review A3 — this preview's plan reads the code replaced, its basis stands on the content the code unlocks.
    expect(withoutAdCode(checked().params).branded_content).not.toContain(CODE)
    const again = await preview({ name: 'B', source: 'creator-instagram-code', adCode: 'Other0Code9' })
    expect(again.preview.plan).toBe(p.preview.plan)
    expect(again.preview.basis).toBe(p.preview.basis)
    const fb = await preview({ name: 'B', source: 'creator-facebook-code', adCode: CODE })
    expect(fb.ok).toBe(false)
    expect(fb.error).toMatch(/is Instagram content/)
    expect(fb.error).not.toContain(CODE)
    expect(await refusal({ name: 'B', source: 'facebook-post', postId: POST, adCode: CODE })).toMatch(/adCode goes with source creator-instagram-code or creator-facebook-code/)
    expect(boost.input.safeParse({ name: 'B', source: 'creator-instagram-code', adCode: 'not a code!' }).success).toBe(false)
  })

  it('buttons: a link, Messenger (and Meta\'s DOF trap for a Facebook post on Instagram), both apps, a creator\'s Messenger, profile visits', async () => {
    await preview({ name: 'B', source: 'facebook-post', postId: POST, button: { kind: 'link', type: 'SHOP_NOW', link: 'https://www.example.com/giacche' } })
    expect(sentJson('call_to_action')).toEqual({ type: 'SHOP_NOW', value: { link: 'https://www.example.com/giacche' } })
    h.check.mockClear()
    await preview({ name: 'B', source: 'facebook-post', postId: POST, button: { kind: 'messaging', apps: ['MESSENGER'] } })
    expect(sentJson('call_to_action')).toEqual({ type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } })
    expect(sentJson('asset_feed_spec')).toEqual({ optimization_type: 'DOF_MESSAGING_DESTINATION', audios: [] })
    h.check.mockClear()
    await preview({ name: 'B', source: 'facebook-post', postId: POST, withInstagram: false, button: { kind: 'messaging', apps: ['MESSENGER'] } })
    expect(checked().params.asset_feed_spec).toBeUndefined()
    h.check.mockClear()
    await preview({ name: 'B', source: 'instagram-media', mediaId: MEDIA, button: { kind: 'messaging', apps: ['MESSENGER', 'INSTAGRAM_DIRECT'] } })
    expect(checked().params.call_to_action).toBeUndefined()
    expect(sentJson('asset_feed_spec')).toMatchObject({ optimization_type: 'DOF_MESSAGING_DESTINATION', audios: [], call_to_actions: [{ type: 'MESSAGE_PAGE' }, { type: 'INSTAGRAM_MESSAGE', value: { app_destination: 'INSTAGRAM_DIRECT', link: 'https://www.instagram.com/' } }] })
    h.check.mockClear()
    // Review B7 — the partnership click-to-message guide writes a link (<LINK_URL>) and no more: the person names it.
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, button: { kind: 'messaging' } })).toMatch(/names its link/)
    h.check.mockClear()
    await preview({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, button: { kind: 'messaging', link: 'https://www.example.com/' } })
    expect(sentJson('call_to_action')).toEqual({ type: 'LEARN_MORE', value: { app_destination: 'MESSENGER', link: 'https://www.example.com/' } })
    expect(sentJson('branded_content')).toEqual({ ad_format: 1, promoted_page_id: PAGE })
    h.check.mockClear()
    await preview({ name: 'B', source: 'facebook-post', postId: POST, button: { kind: 'profile' } })
    expect(sentJson('call_to_action')).toEqual({ type: 'VISIT_PROFILE', value: { link: `https://www.facebook.com/${PAGE}` } })
    h.check.mockClear()
    await preview({ name: 'B', source: 'instagram-media', mediaId: MEDIA, button: { kind: 'profile', visit: 'both' } })
    expect(sentJson('asset_feed_spec')).toEqual({ optimization_type: 'UNIFIED_PROFILE_VISIT_DESTINATION', audios: [], call_to_actions: [
      { type: 'VIEW_INSTAGRAM_PROFILE', value: { link: 'https://www.instagram.com/shop_a', app_link: `instagram://user?username=shop_a&userid=${IG}` } },
      { type: 'VISIT_PROFILE', value: { link: `https://www.facebook.com/${PAGE}` } },
    ] })
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, button: { kind: 'profile' } })).toMatch(/business's own posts only/)
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, button: { kind: 'messaging', apps: ['INSTAGRAM_DIRECT'] } })).toMatch(/opens Messenger/)
  })

  it('review B4 / B6 — every boost sends the product-tag opt-out; a profile visit says Meta\'s limited availability', async () => {
    for (const args of [{ source: 'facebook-post', postId: POST }, { source: 'instagram-media', mediaId: MEDIA }, { source: 'creator-instagram-code', adCode: CODE }]) {
      h.check.mockClear()
      const p = await preview({ name: 'B', ...args })
      expect(p.ok, JSON.stringify(p)).toBe(true)
      expect(sentJson('interactive_components_spec')).toEqual({ components: [{ type: 'product_tag', enroll_status: 'opt_out' }] })
      expect(p.preview.warnings.join(' ')).toMatch(/Automatic product tags: OFF/)
    }
    const visit = await preview({ name: 'B', source: 'facebook-post', postId: POST, button: { kind: 'profile' } })
    expect(visit.preview.warnings.join(' ')).toMatch(/limited availability/)
  })

  it('Threads: never a creator\'s content, a story or a carousel with a video; no Threads id is sent', async () => {
    const p = await preview({ name: 'B', source: 'instagram-media', mediaId: MEDIA, threads: true })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(checked().params.threads_user_id).toBeUndefined()
    expect(p.preview.warnings.join(' ')).toMatch(/Nexus sends no Threads id/)
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, threads: true })).toMatch(/partnership boosts on Threads/)
    expect(await refusal({ name: 'B', source: 'facebook-post', postId: POST, withInstagram: false, threads: true })).toMatch(/Threads ads run on the chosen Instagram account/)
    reads[MEDIA] = { ...reads[MEDIA], media_type: 'CAROUSEL_ALBUM', children: { data: [{ media_type: 'IMAGE' }, { media_type: 'VIDEO' }] } }
    expect(await refusal({ name: 'B', source: 'instagram-media', mediaId: MEDIA, threads: true })).toMatch(/only IMAGE carousels/)
    reads[MEDIA] = { ...reads[MEDIA], media_type: 'IMAGE', media_product_type: 'STORY', children: undefined }
    expect(await refusal({ name: 'B', source: 'instagram-media', mediaId: MEDIA, threads: true })).toMatch(/not stories/)
  })
})

describe('create-meta-boost — the run', () => {
  const made = (id: string) => async () => ({
    node: { id, name: 'Boost A', status: 'ACTIVE', degrees_of_freedom_spec: { creative_features_spec: { inline_comment: { enroll_status: 'OPT_OUT' } } }, contextual_multi_ads: { enroll_status: 'OPT_OUT' } },
    readBack: 'second-read', waitedMs: 0,
  })

  it('new only when Meta answers an id that was not among the account\'s creatives just before the send; its undo deletes only that', async () => {
    h.listPaged.mockImplementation(async () => ({ rows: [{ id: '120000000000111' }], more: false, totalCount: null }))
    h.send.mockImplementation(made('120000000000302'))
    const r = await run({ name: 'Boost A', source: 'facebook-post', postId: POST })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.listPaged).toHaveBeenCalledWith('m-1', 'boost.creativesBefore', `${ACT}/adcreatives`, { fields: 'id' }, 500)
    expect(r.data.steps[0].sentence).toMatch(/Meta made creative 120000000000302/)
    expect(r.change.after).toMatchObject({ kind: 'create', items: [{ kind: 'creative', creativeId: '120000000000302', new: true, source: 'facebook-post' }], accountId: 'm-1', adAccountId: '1234567890' })
    const undo = boost.undo!.request(r.change)
    expect(undo).toMatchObject({ tool: 'create-meta-boost', args: { action: 'undo', creatives: ['120000000000302'] } })
    expect(boost.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    // The same post boosted before: Meta answers THAT creative — not new, never deleted.
    h.listPaged.mockImplementation(async () => ({ rows: [{ id: '120000000000302' }], more: false, totalCount: null }))
    const again = await run({ name: 'Boost A', source: 'facebook-post', postId: POST })
    expect(again.change.after.items[0].new).toBe(false)
    expect(boost.undo!.request(again.change)).toMatchObject({ refusal: expect.stringMatching(/made nothing new/) })
    // More creatives than Nexus reads: not proven new.
    h.listPaged.mockImplementation(async () => ({ rows: [], more: true, totalCount: null }))
    expect((await run({ name: 'Boost A', source: 'facebook-post', postId: POST })).change.after.items[0].new).toBeNull()
  })

  it('a creator\'s ad code: the change record names the content it unlocked, not the code', async () => {
    h.listPaged.mockImplementation(async () => ({ rows: [], more: false, totalCount: null }))
    h.send.mockImplementation(made('120000000000303'))
    const r = await run({ name: 'Boost A', source: 'creator-instagram-code', adCode: CODE })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(JSON.stringify(r.change)).not.toContain(CODE)
    expect(r.change.after.items[0].contentId).toBe(MEDIA)
    expect(r.change.after.items[0].adCode).toBeUndefined()
  })

  it('review round 2 — undo-change runs a boost\'s undo on both doors (the Undo button and the in-app assistant: app; Claude: mcp)', async () => {
    h.listPaged.mockImplementation(async () => ({ rows: [], more: false, totalCount: null }))
    h.send.mockImplementation(made('120000000000306'))
    const r = await run({ name: 'Boost A', source: 'facebook-post', postId: POST })
    const undo = boost.undo!.request(r.change) as { tool: string; args: Record<string, unknown> }
    expect(undo.tool).toBe('create-meta-boost')
    h.records = [{ toolName: 'create-meta-boost', after: { adAccountId: '1234567890', items: [{ creativeId: '120000000000306', new: true }] } }]
    h.read.mockImplementation(async () => ({ body: { id: '120000000000306', status: 'ACTIVE' }, calls: 1 }))
    for (const via of ['app', 'claude'] as const) {
      expect(offeredOn(boost, surfaceOf(via)), via).toBe(true)
      // The gate's own dry run (callTool) as a person on that door: the tool exists there and previews the delete.
      const call = await callTool({ kind: 'user', userId: 'u-owner', label: 'Owner', permissions: { isOwner: true, permissions: new Set() } as never, via }, undo.tool, undo.args)
      expect(call.raw.ok, JSON.stringify(call.raw)).toBe(true)
      expect((call.raw as { preview: { requests: Array<{ label: string }> } }).preview.requests[0].label).toMatch(/Delete creative 120000000000306/)
    }
  })

  it('undo: deletes only a creative a create-meta-boost of this business made new, while no ad uses it', async () => {
    h.records = [{ toolName: 'create-meta-boost', after: { adAccountId: '1234567890', items: [{ creativeId: '120000000000302', new: true }] } }]
    h.read.mockImplementation(async () => ({ body: { id: '120000000000302', status: 'ACTIVE' }, calls: 1 }))
    const p = await preview({ action: 'undo', creatives: ['120000000000302'] })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(p.preview.requests[0].label).toMatch(/Delete creative 120000000000302/)
    // A creative create-meta-creative made is not this tool's to delete.
    h.records = [{ toolName: 'create-meta-creative', after: { adAccountId: '1234567890', items: [{ creativeId: '120000000000302', new: true }] } }]
    expect(await refusal({ action: 'undo', creatives: ['120000000000302'] })).toMatch(/not one a create-meta-boost of this business made new/)
  })

  it('copy-creator-video (MD-138): the code must unlock exactly that video; the video\'s undo is create-meta-media\'s', async () => {
    h.partners.mockImplementation(async () => ({ items: [lookupRow({ mediaType: 'VIDEO' })] }))
    h.send.mockImplementation(async () => ({ node: { id: '120000000000401', created_time: new Date().toISOString() }, readBack: 'same-request', waitedMs: 0 }))
    h.read.mockImplementation(async () => ({ body: { id: '120000000000401', created_time: new Date().toISOString(), status: { video_status: 'ready' } }, calls: 1 }))
    const p = await preview({ action: 'copy-creator-video', mediaId: MEDIA, adCode: CODE })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(JSON.stringify(p.preview)).not.toContain(CODE)
    expect(p.preview.metaCheck.checked).toBe('none')
    const r = await run({ action: 'copy-creator-video', mediaId: MEDIA, adCode: CODE })
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: ACT, edge: 'advideos', params: { source_instagram_media_id: MEDIA, partnership_ad_ad_code: CODE, is_partnership_ad: 'true' } })
    expect(JSON.stringify(r.change)).not.toContain(CODE)
    expect(r.change.after.items[0]).toMatchObject({ kind: 'video', videoId: '120000000000401', new: true })
    expect(boost.undo!.request(r.change)).toMatchObject({ tool: 'create-meta-media', args: { kind: 'undo', uploads: [{ kind: 'video', videoId: '120000000000401' }] } })
    h.partners.mockImplementation(async () => ({ items: [lookupRow({ contentId: '17900000000000002', mediaType: 'VIDEO' })] }))
    expect(await refusal({ action: 'copy-creator-video', mediaId: MEDIA, adCode: CODE })).toMatch(/unlocks other content/)
    h.partners.mockImplementation(async () => ({ items: [lookupRow({ mediaType: 'IMAGE' })] }))
    expect(await refusal({ action: 'copy-creator-video', mediaId: MEDIA, adCode: CODE })).toMatch(/not a video/)
  })
})

describe('set-meta-partnership-access', () => {
  it('review B1 — the Facebook permissions: the chosen Page, partners read first (only those that can move go), one list, Meta per item', async () => {
    const PARTNER = '120000000000555'
    const OTHER = '120000000000556'
    h.partners.mockImplementation(async (input: { view: string }) => (input.view === 'facebook-permissions'
      ? { items: [{ partnerPageId: OTHER, status: 'APPROVED', direction: 'sent' }] }
      : { items: [] }))
    h.rest.mockImplementation(async () => ({ node: { items: [{ partner_page_id: PARTNER, alp_permission_id: 9, alp_permission_status: 1, status: 'success' }] }, readBack: 'same-request', waitedMs: 0 }))
    const p = await preview({ action: 'facebook-request', pages: [PARTNER, OTHER] }, access)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(p.preview.skipped.join(' ')).toMatch(/Page 120000000000556: a request is pending or the permission is approved already/)
    expect(p.preview.metaCheck.sentence).toMatch(/Meta has no check/)
    expect(p.preview.warnings.join(' ')).toMatch(/not all or nothing/)
    const r = await run({ action: 'facebook-request', pages: [PARTNER, OTHER] }, access)
    expect(h.rest.mock.calls[0][1]).toMatchObject({ path: `partnership-ads/fb-account-level-permissions/${PAGE}`, method: 'POST', body: `[{"partner_page_id":${PARTNER},"action":"send-request"}]` })
    expect(r.data.steps[0].sentence).toMatch(/120000000000555 done \(status 1\)/)
    expect(r.change.after.pages).toEqual([{ pageId: PARTNER }])
    const undo = access.undo!.request(r.change)
    expect(undo).toMatchObject({ tool: 'set-meta-partnership-access', args: { action: 'facebook-cancel', pages: [PARTNER] } })
    expect(access.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    // Ending a permission sends Meta's example spelling, revoke-permission.
    h.rest.mockClear()
    await run({ action: 'facebook-remove', pages: [OTHER] }, access)
    expect(h.rest.mock.calls[0][1].body).toBe(`[{"partner_page_id":${OTHER},"action":"revoke-permission"}]`)
    // Meta made none of the list: the step is refused, nothing recorded.
    h.rest.mockImplementation(async () => ({ node: { items: [{ partner_page_id: PARTNER, status: 'failure', error_code: 404, error_message: 'No active permission found for this partner.' }] }, readBack: 'same-request', waitedMs: 0 }))
    h.partners.mockImplementation(async () => ({ items: [{ partnerPageId: PARTNER, status: 'APPROVED', direction: 'received' }] }))
    const none = await access.execute!(parse(access)({ action: 'facebook-remove', pages: [PARTNER] }), approved((await preview({ action: 'facebook-remove', pages: [PARTNER] }, access)).preview)) as ToolResult
    expect(none.ok).toBe(false)
    // The chosen Page itself, another Nexus business's Page: refused in words, nothing read.
    expect(await refusal({ action: 'facebook-request', pages: [PAGE] }, access)).toMatch(/another Page than the business's own chosen one/)
    h.taken.add(`PAGE:${PARTNER}`)
    expect(await refusal({ action: 'facebook-accept', pages: [PARTNER] }, access)).toMatch(/another business in Nexus uses/)
    expect(access.undo!.request({ before: {}, after: { kind: 'partnership', action: 'facebook-reject', pageId: PAGE, pages: [{ pageId: PARTNER }] } })).toMatchObject({ refusal: expect.stringMatching(/rejected partnership request/) })
    expect(access.consequencesFor!({ action: 'facebook-reject' })).toEqual({ reversibility: 'none' })
    expect(access.consequencesFor!({ action: 'facebook-untag' })).toEqual({ reversibility: 'none' })
  })

  it('round 2 — a MIXED answer (some made, some refused): only what Meta made is recorded and undone; ids never start with 0', async () => {
    const A = '120000000000561'
    const B = '120000000000562'
    h.partners.mockImplementation(async () => ({ allowlistStatus: 'ENABLED', creators: [] }))
    h.rest.mockImplementation(async () => ({ node: { items: [{ creator_page_id: A, status_code: 200 }, { creator_page_id: B, status_code: 400, error_message: 'Creator is not eligible for branded content.' }] }, readBack: 'same-request', waitedMs: 0 }))
    const r = await run({ action: 'facebook-allow-creators', pages: [A, B] }, access)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.data.steps[0].sentence).toMatch(/120000000000561 done; 120000000000562 Meta refused it: Creator is not eligible/)
    expect(r.change.after.pages).toEqual([{ pageId: A, listed: true }])
    expect(r.change.before.pages).toEqual([{ pageId: A, listed: false }])
    expect(access.undo!.request(r.change)).toMatchObject({ args: { action: 'facebook-disallow-creators', pages: [A] } })
    // Review round 2 — an id with a leading 0 is not an id (it would pass "not the chosen one" while Meta reads the same id).
    for (const args of [{ action: 'facebook-request', pages: [`0${PAGE}`] }, { action: 'facebook-untag', postIds: ['0505613696297499'] }, { action: 'request', creators: [{ instagramId: `0${IG}` }] }, { action: 'delete-ad-code', mediaId: `0${MEDIA}` }]) {
      expect(access.input.safeParse(args).success, JSON.stringify(args)).toBe(false)
    }
    expect(boost.input.safeParse({ name: 'B', source: 'facebook-post', postId: `0${POST}` }).success).toBe(false)
    expect(boost.input.safeParse({ name: 'B', source: 'instagram-media', mediaId: `0${MEDIA}` }).success).toBe(false)
  })

  it('review B1 — the branded-content allowlist: switched from what it reads, creators added / taken off, posts untagged', async () => {
    const CREATOR = '120000000000557'
    h.partners.mockImplementation(async (input: { view: string }) => {
      if (input.view === 'allowlist') return { allowlistStatus: 'DISABLED', creators: [{ creatorPageId: '120000000000558' }] }
      if (input.view === 'tagged-posts') return { items: [{ postId: '505613696297499', creatorPageId: CREATOR, creatorPageName: 'Creator One' }] }
      return { items: [] }
    })
    h.rest.mockImplementation(async (_t: unknown, call: { method: string }) => ({ node: call.method === 'PUT' ? { allowlist_status: 'ENABLED' } : { items: [{ creator_page_id: CREATOR, fb_post_id: '505613696297499', status_code: 200 }] }, readBack: 'same-request', waitedMs: 0 }))
    const on = await run({ action: 'facebook-allowlist', enabled: true }, access)
    expect(h.rest.mock.calls[0][1]).toMatchObject({ method: 'PUT', path: `partnership-ads/fb-branded-content/${PAGE}/brand-allowlist-status`, query: { is_enabled: 'true' } })
    expect(on.data.steps[0].sentence).toMatch(/reads it ENABLED/)
    expect(access.undo!.request(on.change)).toMatchObject({ args: { action: 'facebook-allowlist', enabled: false } })
    expect(await refusal({ action: 'facebook-allowlist', enabled: false }, access)).toMatch(/already reads DISABLED/)
    h.rest.mockClear()
    const add = await run({ action: 'facebook-allow-creators', pages: [CREATOR, '120000000000558'] }, access)
    expect(h.rest.mock.calls[0][1]).toMatchObject({ method: 'POST', body: `{"creator_page_ids":[${CREATOR}]}` })
    expect(access.undo!.request(add.change)).toMatchObject({ args: { action: 'facebook-disallow-creators', pages: [CREATOR] } })
    h.rest.mockClear()
    await run({ action: 'facebook-disallow-creators', pages: ['120000000000558'] }, access)
    expect(h.rest.mock.calls[0][1]).toMatchObject({ method: 'DELETE', query: { creator_page_ids: '[120000000000558]' } })
    h.rest.mockClear()
    const untag = await run({ action: 'facebook-untag', postIds: ['505613696297499'] }, access)
    expect(h.rest.mock.calls[0][1]).toMatchObject({ method: 'DELETE', path: `partnership-ads/fb-branded-content/${PAGE}/branded-content-posts`, query: { post_ids: '[505613696297499]' } })
    expect(access.undo!.request(untag.change)).toMatchObject({ refusal: expect.stringMatching(/only the creator can tag the Page again/) })
    expect(await refusal({ action: 'facebook-untag', postIds: ['505613696297400'] }, access)).toMatch(/not among the branded-content posts/)
    // Round 2 — a post whose creator Page Meta does not name is refused (Nexus cannot tell whose it is).
    h.partners.mockImplementation(async (input: { view: string }) => (input.view === 'tagged-posts' ? { items: [{ postId: '505613696297499' }] } : { items: [] }))
    expect(await refusal({ action: 'facebook-untag', postIds: ['505613696297499'] }, access)).toMatch(/names no creator Page/)
    h.partners.mockImplementation(async (input: { view: string }) => (input.view === 'tagged-posts' ? { items: [{ postId: '505613696297499', creatorPageId: CREATOR, takenByAnotherBusiness: true }] } : { items: [] }))
    expect(await refusal({ action: 'facebook-untag', postIds: ['505613696297499'] }, access)).toMatch(/another business in Nexus uses/)
    h.partners.mockImplementation(async () => ({ allowlistStatusNotRead: 'Meta: (#200) Permissions error' }))
    expect(await refusal({ action: 'facebook-allowlist', enabled: true }, access)).toMatch(/could not read the allowlist status first.*Permissions error/)
  })

  it('request: a creator by username or id — never the chosen account, never another Nexus business\'s; one already asked is said, not sent', async () => {
    h.partners.mockImplementation(async (input: { view: string; username?: string }) => {
      if (input.view === 'creator-id') return { instagramId: CREATOR_IG, username: input.username }
      if (input.view === 'instagram-permissions') return { items: [{ creatorInstagramId: '17841400000000098', status: 'APPROVED' }] }
      return { items: [] }
    })
    const p = await preview({ action: 'request', creators: [{ username: '@creator_x' }, { instagramId: '17841400000000098' }] }, access)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(p.preview.requests).toHaveLength(1)
    expect(p.preview.skipped.join(' ')).toMatch(/17841400000000098 already reads APPROVED/)
    expect(p.preview.metaCheck.sentence).toMatch(/Meta has no check/)
    expect(p.preview.warnings.join(' ')).toMatch(/request in the Instagram app/)
    expect(h.check).not.toHaveBeenCalled()
    expect(await refusal({ action: 'request', creators: [{ instagramId: IG }] }, access)).toMatch(/another Instagram account than the business's own/)
    h.taken.add(`INSTAGRAM:${CREATOR_IG}`)
    expect(await refusal({ action: 'request', creators: [{ instagramId: CREATOR_IG }] }, access)).toMatch(/another business in Nexus uses/)
    h.taken.clear()
    h.partners.mockImplementation(async (input: { view: string }) => (input.view === 'creator-id' ? { instagramId: CREATOR_IG, takenByAnotherBusiness: true } : { items: [] }))
    expect(await refusal({ action: 'request', creators: [{ username: 'creator_x' }] }, access)).toMatch(/another business in Nexus uses/)
  })

  it('request runs as the chosen Instagram account\'s edge call; its undo is a revoke of the same creators', async () => {
    h.send.mockImplementation(async () => ({ node: { id: '900000000000001', status: 'PENDING' }, readBack: 'second-read', waitedMs: 0 }))
    const r = await run({ action: 'request', creators: [{ instagramId: CREATOR_IG }] }, access)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: IG, kind: 'iguser', edge: 'branded_content_ad_permissions', params: { creator_instagram_account: CREATOR_IG }, readBackFields: 'id,permission_type,status' })
    expect(r.data.steps[0].sentence).toMatch(/permission 900000000000001, PENDING/)
    const undo = access.undo!.request(r.change)
    expect(undo).toMatchObject({ tool: 'set-meta-partnership-access', args: { action: 'revoke', creators: [{ instagramId: CREATOR_IG }] } })
    expect(access.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('approve-creators: the list read first (only those not on it go, as Meta\'s comma list); a list Meta will not show changes nothing', async () => {
    h.partners.mockImplementation(async (input: { view: string }) => (input.view === 'tag-approvals' ? { items: [{ instagramId: '17841400000000098', approvedToTag: true }, { instagramId: CREATOR_IG, approvedToTag: false }] } : { items: [] }))
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const r = await run({ action: 'approve-creators', creators: [{ instagramId: CREATOR_IG }, { instagramId: '17841400000000098' }] }, access)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: IG, kind: 'iguser', edge: 'branded_content_tag_approval', params: { user_ids: CREATOR_IG } })
    expect(access.undo!.request(r.change)).toMatchObject({ args: { action: 'unapprove-creators', creators: [{ instagramId: CREATOR_IG }] } })
    h.send.mockClear()
    await run({ action: 'unapprove-creators', creators: [{ instagramId: '17841400000000098' }] }, access)
    expect(h.send.mock.calls[0][1]).toMatchObject({ method: 'DELETE', params: { user_ids: '17841400000000098' } })
    h.partners.mockImplementation(async () => { throw new MetaLiveRefusal('Meta: (#10) Application does not have permission for this action. This read needs Advanced Access.') })
    expect(await refusal({ action: 'approve-creators', creators: [{ instagramId: CREATOR_IG }] }, access)).toMatch(/could not read the approved-tagging list first.*Advanced Access/)
  })

  it('review A2 — create-ad-code is answered in words (nobody could read the code); delete-ad-code only for the chosen account\'s own media, no undo', async () => {
    expect(await refusal({ action: 'create-ad-code', mediaId: MEDIA }, access)).toBe(CREATE_AD_CODE_ANSWER)
    expect(CREATE_AD_CODE_ANSWER).toMatch(/Nexus cannot show it to you later/)
    expect(h.send).not.toHaveBeenCalled()
    reads[MEDIA] = { id: MEDIA, owner: { id: '17841400000000777' } }
    expect(await refusal({ action: 'delete-ad-code', mediaId: MEDIA }, access)).toMatch(/not the chosen Instagram account's/)
    reads[MEDIA] = { id: MEDIA, owner: { id: IG } }
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const del = await run({ action: 'delete-ad-code', mediaId: MEDIA }, access)
    expect(h.send.mock.calls.at(-1)![1]).toMatchObject({ method: 'DELETE', edge: 'partnership_ad_code', kind: 'igmedia', objectId: MEDIA })
    expect(access.undo!.request(del.change)).toMatchObject({ refusal: expect.stringMatching(/cannot bring a deleted ad code back/) })
  })

  it('collab-invite: only an invite the chosen account has pending, from no other Nexus business\'s account; no undo', async () => {
    h.partners.mockImplementation(async (input: { view: string }) => {
      if (input.view === 'collab-invites') return { items: [{ mediaId: MEDIA, ownerUsername: 'creator_x' }], nextAfter: null }
      if (input.view === 'creator-id') throw new MetaLiveRefusal('Meta found no Instagram professional account with that username (personal and age-gated accounts are not returned).')
      return { items: [] }
    })
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const r = await run({ action: 'collab-invite', mediaId: MEDIA, accept: true }, access)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: IG, edge: 'collaboration_invites', params: { media_id: MEDIA, accept: 'true' } })
    expect(access.undo!.request(r.change)).toMatchObject({ refusal: expect.stringMatching(/no way to take back/) })
    expect(await refusal({ action: 'collab-invite', mediaId: '17900000000000002', accept: false }, access)).toMatch(/not among the Collab invites/)
    expect(await refusal({ action: 'collab-invite', mediaId: MEDIA }, access)).toMatch(/accept true/)
    h.partners.mockImplementation(async (input: { view: string }) => {
      if (input.view === 'collab-invites') return { items: [{ mediaId: MEDIA, ownerUsername: 'creator_x' }], nextAfter: null }
      if (input.view === 'creator-id') return { instagramId: CREATOR_IG, takenByAnotherBusiness: true }
      return { items: [] }
    })
    expect(await refusal({ action: 'collab-invite', mediaId: MEDIA, accept: true }, access)).toMatch(/another business in Nexus uses/)
    // Review A5 — an invite whose sender Meta does not name: refused.
    h.partners.mockImplementation(async (input: { view: string }) => (input.view === 'collab-invites' ? { items: [{ mediaId: MEDIA }], nextAfter: null } : { items: [] }))
    expect(await refusal({ action: 'collab-invite', mediaId: MEDIA, accept: true }, access)).toMatch(/does not name who sent/)
  })
})
