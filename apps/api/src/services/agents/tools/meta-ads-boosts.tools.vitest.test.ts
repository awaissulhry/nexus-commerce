/**
 * Meta step 26 — create-meta-boost and set-meta-partnership-access as the approval gate uses them (Meta, the account, step 16's
 * partnership reads and the records are stand-ins): a boost is a creative of an EXISTING post made by step 25's builder —
 * every silent feature OFF unless asked, Meta's check first, nothing spends — from the chosen Page's post, the chosen Instagram
 * account's media or link, or a creator's content (the chosen Page and Instagram account as its sponsors; never the
 * business's own, never another Nexus business's); its eligibility is read first; a creator's ad code is never in a preview or
 * a record; "was it new?" from the account's creatives read just before the send. The partnership tool asks only for the
 * chosen Instagram account, answers the Facebook side in words (C2-PAGE-TOKEN), shows a code Meta makes once and keeps its
 * fingerprint only, and each action's undo is its inverse (or says why there is none). Made-up ids.
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
import { BOOST_LINK_CTAS, fingerprintOf, isMetaCta } from '../../marketing/meta-ads/change-boosts.js'
import { CREATIVE_RECORD_TOOLS } from '../../marketing/meta-ads/change-creatives.js'
import { __mediaTiming } from '../../marketing/meta-ads/change-media.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { META_CREATIVE_FEATURES, META_NON_CATALOG_FORMATS } from '../../gateway/meta-creative-rules.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

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

  it('a creator\'s ad code: sent to Meta, never in the preview; its fingerprint is what the plan stands on', async () => {
    h.partners.mockImplementation(async () => ({ items: [lookupRow()] }))
    const p = await preview({ name: 'B', source: 'creator-instagram-code', adCode: CODE })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.partners).toHaveBeenCalledWith(expect.objectContaining({ view: 'lookup', adCodes: [CODE] }))
    expect(sentJson('branded_content')).toEqual({ instagram_boost_post_access_token: CODE, ad_format: 1 })
    expect(JSON.stringify(p.preview)).not.toContain(CODE)
    expect(p.preview.warnings.join(' ')).toMatch(/ad code goes to Meta in this request only/)
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
    await preview({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, button: { kind: 'messaging' } })
    expect(sentJson('call_to_action')).toEqual({ type: 'LEARN_MORE', value: { app_destination: 'MESSENGER', link: 'https://fb.com/messenger_doc/' } })
    expect(sentJson('branded_content')).toEqual({ ad_format: 1, promoted_page_id: PAGE })
    h.check.mockClear()
    await preview({ name: 'B', source: 'facebook-post', postId: POST, button: { kind: 'profile' } })
    expect(sentJson('call_to_action')).toEqual({ type: 'VISIT_PROFILE', value: { link: `https://www.facebook.com/${PAGE}` } })
    h.check.mockClear()
    await preview({ name: 'B', source: 'instagram-media', mediaId: MEDIA, button: { kind: 'profile', visit: 'both' } })
    expect(sentJson('asset_feed_spec')).toEqual({ optimization_type: 'UNIFIED_PROFILE_VISIT_DESTINATION', audios: [], call_to_actions: [
      { type: 'VIEW_INSTAGRAM_PROFILE', value: { link: 'https://www.instagram.com/shop_a', app_link: 'instagram://user?username=shop_a' } },
      { type: 'VISIT_PROFILE', value: { link: `https://www.facebook.com/${PAGE}` } },
    ] })
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, button: { kind: 'profile' } })).toMatch(/business's own posts only/)
    expect(await refusal({ name: 'B', source: 'creator-instagram-media', mediaId: MEDIA, button: { kind: 'messaging', apps: ['INSTAGRAM_DIRECT'] } })).toMatch(/opens Messenger/)
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

  it('a creator\'s ad code: the record keeps its fingerprint, never the code', async () => {
    h.listPaged.mockImplementation(async () => ({ rows: [], more: false, totalCount: null }))
    h.send.mockImplementation(made('120000000000303'))
    const r = await run({ name: 'Boost A', source: 'creator-instagram-code', adCode: CODE })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(JSON.stringify(r.change)).not.toContain(CODE)
    expect(r.change.after.items[0].adCode).toBe(fingerprintOf(CODE))
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
  it('the Facebook side is answered in words (C2-PAGE-TOKEN): nothing read, nothing queued', async () => {
    for (const action of ['facebook-request', 'facebook-cancel', 'facebook-accept', 'facebook-reject', 'facebook-remove', 'facebook-allowlist', 'facebook-allow-creators', 'facebook-disallow-creators', 'facebook-untag']) {
      const words = await refusal({ action }, access)
      expect(words).toMatch(/Page's own access token/)
      expect(words).toMatch(/Page-token mode \(step 36\)/)
    }
    expect(h.partners).not.toHaveBeenCalled()
    expect(h.read).not.toHaveBeenCalled()
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

  it('create-ad-code: only the chosen account\'s own media; the code Meta makes is shown ONCE in the run\'s step, the record keeps its fingerprint', async () => {
    h.send.mockImplementation(async () => ({ node: { ad_code: 'MetaMadeCode42' }, readBack: 'none', waitedMs: 0 }))
    const r = await run({ action: 'create-ad-code', mediaId: MEDIA }, access)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: MEDIA, kind: 'igmedia', edge: 'partnership_ad_code', params: {} })
    expect(r.data.steps[0].sentence).toMatch(/Meta made ad code MetaMadeCode42 — share it with the partner now/)
    expect(JSON.stringify(r.change)).not.toContain('MetaMadeCode42')
    expect(r.change.after.adCode).toBe(fingerprintOf('MetaMadeCode42'))
    expect(JSON.stringify({ ...r.data, steps: undefined })).not.toContain('MetaMadeCode42')
    expect(access.undo!.request(r.change)).toMatchObject({ args: { action: 'delete-ad-code', mediaId: MEDIA } })
    reads[MEDIA] = { id: MEDIA, owner: { id: '17841400000000777' } }
    expect(await refusal({ action: 'create-ad-code', mediaId: MEDIA }, access)).toMatch(/not the chosen Instagram account's/)
    reads[MEDIA] = { id: MEDIA, owner: { id: IG } }
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const del = await run({ action: 'delete-ad-code', mediaId: MEDIA }, access)
    expect(h.send.mock.calls.at(-1)![1]).toMatchObject({ method: 'DELETE', edge: 'partnership_ad_code' })
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
  })
})
