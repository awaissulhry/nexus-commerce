/**
 * Meta step 25 — create-meta-creative and set-meta-creative as the approval gate uses them (Meta, the account and the
 * records are stand-ins): a creative is built on the business's CHOSEN Page and Instagram account, with every silent
 * feature sent OFF unless asked (every Advantage+ creative feature Meta documents, multi-advertiser ads, music, format
 * automation, shop routing) and each one asked named in the preview; Meta checks it first (validate_only); it spends
 * nothing; the run reads it back and says what Meta kept, and "was it new?" from its own post's created_time (an AdCreative
 * has none) — only a creative made new is ever deleted by the undo, and only while no ad uses it. set-meta-creative
 * changes only a name, the labels or the status, and its undo puts the old name and labels back. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  chosen: { connectionId: 'm-1', adAccountId: '1234567890', businessId: '9876543210', pageId: '120000000000010', instagramId: '17841400000000001' } as Record<string, unknown>,
  records: [] as Array<{ id: string; after: unknown }>,
  read: vi.fn(),
  listPaged: vi.fn(),
  send: vi.fn(),
  check: vi.fn(),
  owned: vi.fn(),
  taken: new Set<string>(),
  // Gap 46b — step 16's content-discovery look-up (live-partners.ts livePartnership), as create-meta-boost's tests stub it.
  partners: vi.fn(),
}))
// Step 18's catalog rule — which portfolios another Nexus business uses (nexus_meta_links_taken PORTFOLIO): a stand-in.
vi.mock('../../marketing/meta-ads/taken.js', () => {
  const takenIds = vi.fn(async (_product: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id))))
  return {
    takenIds,
    portfolioTaken: vi.fn(async (id: string) => ((await takenIds('PORTFOLIO', [id])).has(id) ? { portfolioId: id, takenByAnotherBusiness: true, sentence: 'taken' } : null)),
  }
})
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
vi.mock('../../marketing/meta-ads/read-client.js', () => ({ metaReadOne: h.read }))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaSendChange: h.send,
  metaCheckChange: h.check,
}))
vi.mock('../../../db.js', () => ({
  default: {
    agentChange: {
      findMany: vi.fn(async ({ where }: { where: { toolName: string; after: { array_contains: Array<Record<string, unknown>> } } }) => {
        const wanted = where.after.array_contains[0]
        return h.records.filter((r) => ((r.after as { items?: Array<Record<string, unknown>> }).items ?? []).some((i) => Object.entries(wanted).every(([k, v]) => i[k] === v)))
      }),
    },
  },
}))

import { META_ADS_CREATIVES_TOOLS } from './meta-ads-creatives.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { __creativeTiming, WELCOME_FLOWS_ANSWER } from '../../marketing/meta-ads/change-creatives.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { localFailure, MetaReadError } from '../../marketing/meta-ads/errors.js'
import { META_CREATIVE_FEATURES, META_NON_CATALOG_FORMATS } from '../../gateway/meta-creative-rules.js'
import { canonical } from './ads-change-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const create = META_ADS_CREATIVES_TOOLS.find((t) => t.name === 'create-meta-creative')!
const set = META_ADS_CREATIVES_TOOLS.find((t) => t.name === 'set-meta-creative')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (tool = create) => (args: Record<string, unknown>) => tool.input.parse(args) as Record<string, unknown>
const preview = async (args: Record<string, unknown>, tool = create) => (await tool.handler(ask(tool)(args), asker)) as ToolResult & { preview: Record<string, any>; error?: string }
const run = async (args: Record<string, unknown>, tool = create) => {
  const p = await preview(args, tool)
  expect(p.ok, JSON.stringify(p)).toBe(true)
  return (await tool.execute!(ask(tool)(args), approved(p.preview))) as ToolResult & { data: Record<string, any>; change: { before: any; after: any } }
}

const ACT = 'act_1234567890'
const PAGE = '120000000000010'
const IG = '17841400000000001'
const POST = `${PAGE}_500000000000009`
const image = { name: 'Creative A', story: { link_data: { link: 'https://www.example.com/shoes', message: 'Scarpe nuove — 20 € 🎉\r\nSolo oggi', name: 'Nuove scarpe', image_hash: 'abc123def456', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/shoes' } } } } }
const checked = () => h.check.mock.calls[0][1] as { objectId: string; kind: string; edge: string; params: Record<string, string> }
const sentJson = (key: string) => JSON.parse(checked().params[key])
const nowIso = () => new Date().toISOString().replace('Z', '+0000')

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  __creativeTiming.sleep = async () => undefined
  __creativeTiming.polls = 3
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.chosen = { connectionId: 'm-1', adAccountId: '1234567890', businessId: '9876543210', pageId: PAGE, instagramId: IG }
  h.records = []
  h.read.mockReset(); h.read.mockImplementation(async (_c: unknown, q: { path: string }) => {
    if (q.path === POST) return { body: { id: POST, created_time: nowIso() }, calls: 1 }
    return { body: {}, calls: 1 }
  })
  h.listPaged.mockReset(); h.listPaged.mockImplementation(async () => ({ rows: [], more: false, totalCount: null }))
  h.send.mockReset()
  h.check.mockReset(); h.check.mockImplementation(async () => undefined)
  h.owned.mockReset(); h.owned.mockImplementation(async (_a: unknown, id: string) => id)
  h.taken.clear()
  h.partners.mockReset(); h.partners.mockImplementation(async () => ({ items: [] }))
})

describe('the tools', () => {
  it('are changes a person always approves (ask ceiling, open world, high risk), each with an undo', () => {
    for (const tool of [create, set]) {
      expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'partial', requires: ['ads.campaigns.manage'] })
      expect(tool.undo).toBeDefined()
      expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(create.description).toMatch(/SPENDS NOTHING/)
    expect(create.consequencesFor!({ action: 'undo' })).toEqual({ reversibility: 'none' })
  })
})

describe('create-meta-creative — the preview', () => {
  it('builds on the chosen Page and Instagram account, sends EVERY silent feature OFF, and Meta checks it first', async () => {
    const p = await preview(image)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(checked()).toMatchObject({ objectId: ACT, kind: 'adaccount', edge: 'adcreatives' })
    const story = sentJson('object_story_spec')
    expect(story.page_id).toBe(PAGE)
    expect(story.instagram_user_id).toBe(IG)
    expect(story.link_data.message).toBe('Scarpe nuove — 20 € 🎉\nSolo oggi')
    const features = sentJson('degrees_of_freedom_spec').creative_features_spec
    expect(Object.keys(features).sort()).toEqual([...META_CREATIVE_FEATURES].sort())
    expect(Object.values(features).every((f: any) => f.enroll_status === 'OPT_OUT')).toBe(true)
    expect(sentJson('contextual_multi_ads')).toEqual({ enroll_status: 'OPT_OUT' })
    expect(sentJson('asset_feed_spec')).toEqual({ audios: [] })
    expect(sentJson('format_transformation_spec')).toEqual(META_NON_CATALOG_FORMATS.map((format) => ({ format, data_source: ['none'] })))
    expect(sentJson('destination_spec')).toEqual({ destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' })
    expect(sentJson('interactive_components_spec')).toEqual({ components: [{ type: 'product_tag', enroll_status: 'opt_out' }] })
    expect(p.preview.spendsMoney).toBe(false)
    expect(p.preview.metaCheck.checked).toBe('all')
    const words = p.preview.warnings.join(' ')
    expect(words).toMatch(/spends nothing/)
    expect(words).toMatch(new RegExp(`Every one of the ${META_CREATIVE_FEATURES.length} Advantage\\+ creative features Meta documents is sent OFF`))
    expect(words).toMatch(/Multi-advertiser ads: OFF/)
    expect(words).toMatch(/Music: none/)
    expect(words).toMatch(/A standard creative with a website destination or catalog part/)
    expect(words).toMatch(/Automatic product tags: OFF/)
    expect(words).toMatch(/swap on an ACTIVE ad sends that ad back to Meta's review/)
    expect(words).not.toMatch(/headline of up to 25 characters/)
    const long = await preview({ ...image, story: { link_data: { ...image.story.link_data, name: 'Un titolo davvero troppo lungo per Meta', message: `${'#saldi '.repeat(31)}https://www.example.com` } } })
    const advice = long.preview.warnings.join(' ')
    expect(advice).toMatch(/headline of up to 25 characters \(this one has 39\)/)
    expect(advice).toMatch(/primary text of up to 90 characters/)
    expect(advice).toMatch(/at most 30 hashtags/)
    expect(advice).toMatch(/not clickable on Instagram/)
  })

  it('names each feature switched on — and says an AI-generated one needs a PAUSED ad and a preview first', async () => {
    const p = await preview({ ...image, aiFeatures: ['image_templates', 'inline_comment'], multiAdvertiser: true, music: 'random', formatAutomation: [{ format: 'carousel', dataSources: ['site_links'] }] })
    expect(p.ok).toBe(true)
    const features = sentJson('degrees_of_freedom_spec').creative_features_spec
    expect(features.image_templates).toEqual({ enroll_status: 'OPT_IN' })
    expect(features.inline_comment).toEqual({ enroll_status: 'OPT_IN' })
    expect(features.adapt_to_placement).toEqual({ enroll_status: 'OPT_OUT' })
    expect(sentJson('contextual_multi_ads')).toEqual({ enroll_status: 'OPT_IN' })
    expect(sentJson('asset_feed_spec')).toEqual({ audios: [{ type: 'random' }] })
    expect(sentJson('format_transformation_spec').find((f: any) => f.format === 'carousel')).toEqual({ format: 'carousel', data_source: ['site_links'] })
    const words = p.preview.warnings.join(' ')
    expect(words).toMatch(/switched ON at your request: image_templates, inline_comment/)
    expect(words).toMatch(/image_templates is generated with AI: an ad using this creative must be created PAUSED and previewed first/)
    expect(words).not.toMatch(/inline_comment is generated with AI/)
    expect(words).toMatch(/Multi-advertiser ads: ON/)
    expect(p.preview.changes['Advantage+ creative features ON'].to).toBe('image_templates, inline_comment')
  })

  it('refuses in words, before any call: another Page, the silent keys through parts, music by hand, political, retailer item ids, no name', async () => {
    const refusal = async (args: Record<string, unknown>) => {
      const p = await preview(args)
      expect(p.ok, JSON.stringify(p)).toBe(false)
      return p.error ?? ''
    }
    expect(await refusal({ ...image, story: { ...image.story, page_id: '120000000000099' } })).toMatch(/fills story.page_id/)
    expect(await refusal({ ...image, parts: { degrees_of_freedom_spec: {} } })).toMatch(/this tool's own argument \(aiFeatures/)
    expect(await refusal({ ...image, parts: { contextual_multi_ads: { enroll_status: 'OPT_IN' } } })).toMatch(/multiAdvertiser/)
    expect(await refusal({ ...image, assetFeed: { audios: [{ type: 'random' }] } })).toMatch(/music is the argument music/)
    expect(await refusal({ ...image, parts: { authorization_category: 'POLITICAL' } })).toMatch(/banned in the EU/)
    expect(await refusal({ ...image, story: { link_data: { ...image.story.link_data, retailer_item_ids: ['0'] } } })).toMatch(/cannot check a retailer id against the catalog rule/)
    expect(await refusal({ ...image, story: { link_data: { ...image.story.link_data }, instagram_actor_id: IG } })).toMatch(/instagram_user_id/)
    expect(await refusal({ ...image, postId: POST })).toMatch(/one of them/)
    expect(await refusal({ name: 'From a post', postId: '120000000000099_500000000000001' })).toMatch(/not on the Facebook Page this business chose/)
    expect(await refusal({ story: image.story })).toMatch(/name is 1 to 100/)
    expect(await refusal({ ...image, story: { link_data: { ...image.story.link_data, link: 'http://www.example.com/' } } })).toMatch(/https/)
    // Step 46 — the Owner's rule (2026-10-23): every Meta ad sends people to the business's own shop; shop routing is never sent.
    expect(await refusal({ ...image, shopDestination: true })).toMatch(/every Meta ad sends people to the business's own shop/)
    expect(await refusal({ ...image, parts: { interactive_components_spec: { components: [] } } })).toMatch(/autoProductTags/)
    expect(await refusal({ ...image, featureSettings: { adapt_to_placement: { image_crop_style: 'x' } } })).toMatch(/goes only with adapt_to_placement in aiFeatures/)
    expect(await refusal({ ...image, formatAutomation: [{ format: 'da_collection', dataSources: ['catalog'] }] })).toMatch(/only as sa_collection|for a website creative only/)
    expect(await refusal({ name: 'From a post', postId: POST, assetFeed: { bodies: [{ text: 'x' }] } })).toMatch(/takes no asset feed/)
    expect(h.check).not.toHaveBeenCalled()
    expect(() => ask()({ ...image, aiFeatures: ['image_template'] })).toThrow()
  })

  it('a partnership ad: the creator as main identity runs it, the chosen Page and Instagram account are its sponsors', async () => {
    const p = await preview({ ...image, partner: { pageId: '120000000000555', instagramId: '17841400000000555', mainIdentity: 'creator' } })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('object_story_spec')).toMatchObject({ page_id: '120000000000555', instagram_user_id: '17841400000000555' })
    expect(sentJson('facebook_branded_content')).toEqual({ sponsor_page_id: PAGE })
    expect(sentJson('instagram_branded_content')).toEqual({ sponsor_id: IG })
    expect(p.preview.warnings.join(' ')).toMatch(/Meta itself sends the partner a permission request/)
  })

  it('with Meta changes switched off, Meta is not asked to check it', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const p = await preview(image)
    expect(p.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(p.preview.metaCheck.checked).toBe('none')
  })

  it('Facebook only, and a creative from an existing post of the chosen Page', async () => {
    await preview({ ...image, withInstagram: false })
    expect(sentJson('object_story_spec').instagram_user_id).toBeUndefined()
    h.check.mockClear()
    const p = await preview({ name: 'From a post', postId: POST, parts: { call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/' } } } })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(checked().params.object_story_id).toBe(POST)
    expect(checked().params.instagram_user_id).toBe(IG)
    // Review B — an existing post carries no asset feed, format or shop key.
    // Round 2 — its button links to the website, so the website keys go too (fail-safe).
    expect(Object.keys(checked().params).sort()).toEqual(['call_to_action', 'contextual_multi_ads', 'degrees_of_freedom_spec', 'destination_spec', 'format_transformation_spec', 'instagram_user_id', 'interactive_components_spec', 'name', 'object_story_id'])
    // An existing post may be an image: Meta's automatic product tags are switched off on it too (fail safe).
    expect(JSON.parse(checked().params.interactive_components_spec)).toEqual({ components: [{ type: 'product_tag', enroll_status: 'opt_out' }] })
  })
})

describe('create-meta-creative — the run', () => {
  const madeBack = (features: Record<string, string>) => async () => ({
    node: {
      id: '120000000000301', name: 'Creative A', status: 'ACTIVE', effective_object_story_id: POST,
      degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, { enroll_status: v }])) },
      contextual_multi_ads: { enroll_status: 'OPT_OUT' },
    },
    readBack: 'second-read', waitedMs: 0,
  })

  it('reads the creative back: says what Meta kept, what it dropped, and any feature ON that was not asked; new from its post', async () => {
    h.send.mockImplementation(madeBack({ image_templates: 'OPT_OUT', inline_comment: 'OPT_IN', adapt_to_placement: 'OPT_OUT' }))
    const r = await run({ ...image, aiFeatures: ['image_templates'] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: ACT, kind: 'adaccount', edge: 'adcreatives', operation: 'creative.create' })
    const step = r.data.steps[0].sentence as string
    expect(step).toMatch(/Meta made creative 120000000000301/)
    expect(step).toMatch(/new in the ad account/)
    expect(step).toMatch(/Meta dropped image_templates as ineligible/)
    expect(step).toMatch(/WARNING: Meta has inline_comment ON although Nexus did not ask/)
    expect(step).toMatch(/meta-ad-preview view creative creativeId 120000000000301/)
    expect(r.change.after).toMatchObject({ kind: 'create', items: [{ kind: 'creative', creativeId: '120000000000301', new: true, featuresOn: ['inline_comment'] }], accountId: 'm-1', adAccountId: '1234567890' })
    const undo = create.undo!.request(r.change)
    expect(undo).toMatchObject({ tool: 'create-meta-creative', args: { action: 'undo', creatives: ['120000000000301'] } })
    expect(create.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('Meta answers a duplicate (its post is older than the send): not new, and the undo never deletes it', async () => {
    h.read.mockImplementation(async (_c: unknown, q: { path: string }) => ({ body: q.path === POST ? { id: POST, created_time: '2020-01-01T00:00:00+0000' } : {}, calls: 1 }))
    h.send.mockImplementation(madeBack({}))
    const r = await run(image)
    expect(r.data.steps[0].sentence).toMatch(/Meta answered an existing creative or post/)
    expect(r.change.after.items[0].new).toBe(false)
    expect(create.undo!.request(r.change)).toMatchObject({ refusal: expect.stringMatching(/made nothing new/) })
  })

  it('the async job: the run reads its requests until Meta names the creative', async () => {
    h.send.mockImplementation(async () => ({ node: { id: '120000000000801' }, readBack: 'none', waitedMs: 0 }))
    h.read.mockImplementation(async (_c: unknown, q: { path: string }) => {
      if (q.path === '120000000000801/requests') return { body: { data: [{ status: 'SUCCESS', result: { id: '120000000000302' } }] }, calls: 1 }
      if (q.path === '120000000000302') return { body: { id: '120000000000302', status: 'ACTIVE', effective_object_story_id: POST, degrees_of_freedom_spec: { creative_features_spec: {} } }, calls: 1 }
      if (q.path === POST) return { body: { created_time: nowIso() }, calls: 1 }
      return { body: {}, calls: 1 }
    })
    const p = await preview({ ...image, async: true })
    expect(h.check).not.toHaveBeenCalled()
    expect(p.preview.metaCheck.checked).toBe('none')
    const r = await run({ ...image, async: true })
    const params = h.send.mock.calls[0][1].params as Record<string, string>
    expect(h.send.mock.calls[0][1]).toMatchObject({ edge: 'asyncadcreatives' })
    expect(params.notification_mode).toBe('OFF')
    expect(JSON.parse(params.creative_spec).degrees_of_freedom_spec.creative_features_spec.inline_comment).toEqual({ enroll_status: 'OPT_OUT' })
    expect(r.change.after.items[0]).toMatchObject({ creativeId: '120000000000302', jobId: '120000000000801', new: true })
  })
})

describe('create-meta-creative — undo', () => {
  const record = () => { h.records = [{ id: 'ch-1', after: { kind: 'create', adAccountId: '1234567890', items: [{ kind: 'creative', creativeId: '120000000000301', new: true }] } }] }

  it('deletes only a creative a create of this business made new, while no ad uses it', async () => {
    record()
    h.read.mockImplementation(async () => ({ body: { id: '120000000000301', status: 'ACTIVE' }, calls: 1 }))
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const r = await run({ action: 'undo', creatives: ['120000000000301'] })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000301', kind: 'creative', method: 'DELETE', operation: 'creative.delete' })
    expect(h.listPaged.mock.calls[0][2]).toBe(`${ACT}/ads`)
    expect(create.undo!.request(r.change)).toMatchObject({ refusal: expect.stringMatching(/cannot bring a deleted creative back/) })
  })

  it('never a creative it did not make new, nor one an ad uses', async () => {
    const none = await preview({ action: 'undo', creatives: ['120000000000301'] })
    expect(none.error).toMatch(/is not one a create-meta-creative of this business made new/)
    record()
    h.read.mockImplementation(async () => ({ body: { id: '120000000000301', status: 'ACTIVE' }, calls: 1 }))
    h.listPaged.mockImplementation(async () => ({ rows: [{ id: '120000000000901', creative: { id: '120000000000301' } }], more: false, totalCount: null }))
    const used = await preview({ action: 'undo', creatives: ['120000000000301'] })
    expect(used.error).toMatch(/stays: ad 120000000000901 uses it/)
    h.listPaged.mockImplementation(async () => ({ rows: [], more: true, totalCount: null }))
    expect((await preview({ action: 'undo', creatives: ['120000000000301'] })).error).toMatch(/cannot confirm no ad uses it/)
    h.owned.mockImplementation(async () => { throw new MetaLiveRefusal('That creative does not belong to the ad account this business chose, so it is not read.') })
    expect((await preview({ action: 'undo', creatives: ['120000000000301'] })).error).toMatch(/does not belong/)
  })
})

describe('set-meta-creative', () => {
  const now = { id: '120000000000301', name: 'Creative A', status: 'ACTIVE', adlabels: { data: [{ name: 'Spring' }] } }

  it('renames and replaces the labels in one request (no check: Meta documents none); its undo puts both back', async () => {
    h.read.mockImplementation(async () => ({ body: now, calls: 1 }))
    const p = await preview({ creativeId: '120000000000301', name: 'Creativo B — €', labels: [] }, set)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(p.preview.metaCheck.checked).toBe('none')
    h.send.mockImplementation(async () => ({ node: { id: '120000000000301', name: 'Creativo B — €', status: 'ACTIVE' }, readBack: 'second-read', waitedMs: 0 }))
    const r = await run({ creativeId: '120000000000301', name: 'Creativo B — €', labels: [] }, set)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000301', kind: 'creative', operation: 'creative.update', params: { name: 'Creativo B — €', adlabels: '[]' }, expect: { name: 'Creativo B — €' } })
    expect(r.change.before).toMatchObject({ name: 'Creative A', labels: ['Spring'] })
    const undo = set.undo!.request(r.change)
    expect(undo).toMatchObject({ tool: 'set-meta-creative', args: { creativeId: '120000000000301', name: 'Creative A', labels: ['Spring'] } })
    expect(set.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('adds labels on the creative\'s adlabels edge; refuses a deleted creative and another account\'s', async () => {
    h.read.mockImplementation(async () => ({ body: now, calls: 1 }))
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const r = await run({ creativeId: '120000000000301', addLabels: ['Summer', 'Spring'] }, set)
    expect(h.send.mock.calls[0][1]).toMatchObject({ edge: 'adlabels', operation: 'creative.addLabels', params: { adlabels: JSON.stringify([{ name: 'Summer' }]) } })
    expect(r.change.after.labels).toEqual(['Spring', 'Summer'])
    h.read.mockImplementation(async () => ({ body: { ...now, status: 'DELETED' }, calls: 1 }))
    expect((await preview({ creativeId: '120000000000301', name: 'X' }, set)).error).toMatch(/is deleted/)
    h.owned.mockImplementation(async () => { throw new MetaLiveRefusal('That creative does not belong to the ad account this business chose, so it is not read.') })
    expect((await preview({ creativeId: '120000000000301', name: 'X' }, set)).error).toMatch(/does not belong/)
    expect(() => ask(set)({ creativeId: '120000000000301', status: 'DELETED' })).toThrow()
  })
})

describe('review round 1', () => {
  it('A1 — a carousel keeps its card order unless asked; product tags only on a static image; both named', async () => {
    const card = (n: number) => ({ link: `https://www.example.com/p${n}`, name: `Card ${n}`, image_hash: 'abc123def456' })
    const carousel = { name: 'Carousel A', story: { link_data: { link: 'https://www.example.com/', message: 'Tutti', child_attachments: [card(1), card(2), card(3)] } } }
    const p = await preview(carousel)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('object_story_spec').link_data.multi_share_optimized).toBe(false)
    // Round 2 — carousel images carry the product-tag opt-out too.
    expect(sentJson('interactive_components_spec')).toEqual({ components: [{ type: 'product_tag', enroll_status: 'opt_out' }] })
    expect(p.preview.warnings.join(' ')).toMatch(/Carousel order: as given/)
    h.check.mockClear()
    const q = await preview({ ...carousel, carouselAutoOrder: true })
    expect(sentJson('object_story_spec').link_data.multi_share_optimized).toBe(true)
    expect(q.preview.warnings.join(' ')).toMatch(/Meta may reorder the cards at your request/)
    expect((await preview({ ...carousel, story: { link_data: { ...carousel.story.link_data, multi_share_optimized: true } } })).error).toMatch(/carouselAutoOrder/)
    h.check.mockClear()
    const tags = await preview({ ...image, autoProductTags: true })
    expect(sentJson('interactive_components_spec')).toEqual({ components: [{ type: 'product_tag', enroll_status: 'opt_in' }] })
    expect(tags.preview.warnings.join(' ')).toMatch(/Automatic product tags: ON at your request/)
  })

  it('A6 — opt-ins inside the parts are named; the silent keys are read back', async () => {
    const p = await preview({ ...image, parts: { media_sourcing_spec: { related_media: { opt_in_status: 'OPT_IN' } } } })
    expect(p.preview.warnings.join(' ')).toMatch(/Opt-ins inside the creative's own parts, at your request: media_sourcing_spec.related_media.opt_in_status OPT_IN/)
    h.send.mockImplementation(async () => ({
      node: { id: '120000000000301', name: 'Creative A', status: 'ACTIVE', effective_object_story_id: POST, degrees_of_freedom_spec: { creative_features_spec: {} }, format_transformation_spec: [{ format: 'carousel', data_source: ['catalog'] }], asset_feed_spec: { audios: [{ type: 'random' }] }, destination_spec: { destination_type: 'WEBSITE_AND_SHOP' }, interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_out' }] } },
      readBack: 'second-read', waitedMs: 0,
    }))
    const r = await run(image)
    const step = r.data.steps[0].sentence as string
    expect(step).toMatch(/Format automation Meta has ON: carousel/)
    expect(step).toMatch(/Music: ON/)
    expect(step).toMatch(/Shop routing reads WEBSITE_AND_SHOP/)
    expect(step).toMatch(/Automatic product tags: off/)
  })

  it('A4 — not new when Meta reads back another name, or another record already claims the creative', async () => {
    const back = (name: string) => async () => ({ node: { id: '120000000000301', name, status: 'ACTIVE', effective_object_story_id: POST, degrees_of_freedom_spec: { creative_features_spec: {} } }, readBack: 'second-read', waitedMs: 0 })
    h.send.mockImplementation(back('Another name'))
    expect((await run(image)).change.after.items[0].new).toBe(false)
    h.send.mockImplementation(back('Creative A'))
    h.records = [{ id: 'ch-0', after: { kind: 'create', adAccountId: '1234567890', items: [{ kind: 'creative', creativeId: '120000000000301', new: true }] } }]
    expect((await run(image)).change.after.items[0].new).toBe(false)
    h.records = []
    expect((await run(image)).change.after.items[0].new).toBe(true)
  })

  it('A3 — the undo of A → B refuses once a later change made it C (the live read moves)', async () => {
    h.read.mockImplementation(async () => ({ body: { id: '120000000000301', name: 'Creative A', status: 'ACTIVE', adlabels: { data: [{ name: 'Spring' }] } }, calls: 1 }))
    h.send.mockImplementation(async () => ({ node: { id: '120000000000301', name: 'Creative B', status: 'ACTIVE' }, readBack: 'second-read', waitedMs: 0 }))
    const r = await run({ creativeId: '120000000000301', name: 'Creative B', labels: ['Summer', 'Autumn'] }, set)
    expect(r.change.after.labels).toEqual(['Autumn', 'Summer'])
    h.read.mockImplementation(async () => ({ body: { id: '120000000000301', name: 'Creative B', status: 'ACTIVE', adlabels: { data: [{ name: 'Summer' }, { name: 'Autumn' }] } }, calls: 1 }))
    expect(canonical(await set.undo!.current(r.change))).toBe(canonical(r.change.after))
    h.read.mockImplementation(async () => ({ body: { id: '120000000000301', name: 'Creative C', status: 'ACTIVE', adlabels: { data: [{ name: 'Summer' }, { name: 'Autumn' }] } }, calls: 1 }))
    expect(canonical(await set.undo!.current(r.change))).not.toBe(canonical(r.change.after))
    h.read.mockImplementation(async () => ({ body: { id: '120000000000301', name: 'Creative B', status: 'ACTIVE', adlabels: { data: [{ name: 'Summer' }] } }, calls: 1 }))
    expect(canonical(await set.undo!.current(r.change))).not.toBe(canonical(r.change.after))
  })

  it('B2 — saved Page welcome-message flows are answered in words: step 38\'s set-meta-messaging-setup makes them', async () => {
    const p = await preview({ action: 'welcome-flow' })
    expect(p).toMatchObject({ ok: false, error: WELCOME_FLOWS_ANSWER })
    expect(WELCOME_FLOWS_ANSWER).toMatch(/set-meta-messaging-setup \(section welcome-flow\)/)
    expect(WELCOME_FLOWS_ANSWER).not.toMatch(/Meta Business Suite/)
  })
})

describe('review round 2', () => {
  it('the tool sends the website keys from the same rule as the gateway, and refuses a stray marker of another type', async () => {
    const ctm = { name: 'Chat A', story: { link_data: { link: 'https://www.example.com/', image_hash: 'abc123def456', call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } }, page_welcome_message: 'Ciao' } } }
    const p = await preview(ctm)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('destination_spec')).toEqual({ destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' })
    expect(p.preview.warnings.join(' ')).toMatch(/A messaging creative with a website destination/)
    const stray = await preview({ ...image, story: { link_data: { ...image.story.link_data, page_welcome_message: 'Ciao' } } })
    expect(stray.error).toMatch(/main button makes it a standard creative/)
  })
})

describe('review round 3', () => {
  it('an existing post carries the shop and format opt-outs even with no website button (its own link may lead to one)', async () => {
    const p = await preview({ name: 'From a post', postId: POST })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('destination_spec')).toEqual({ destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' })
    expect(sentJson('format_transformation_spec').every((f: any) => f.data_source.length === 1 && f.data_source[0] === 'none')).toBe(true)
    expect(checked().params.asset_feed_spec).toBeUndefined()
  })

  it('a Click-to-Messenger link (Meta\'s own) gets no shop opt-out; a link ad with no image gets the product-tag opt-out', async () => {
    await preview({ name: 'Chat A', story: { link_data: { link: 'https://fb.com/messenger_doc/', image_hash: 'abc123def456', call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } } } } })
    expect(checked().params.destination_spec).toBeUndefined()
    expect(checked().params.format_transformation_spec).toBeUndefined()
    h.check.mockClear()
    await preview({ name: 'Link A', story: { link_data: { link: 'https://www.example.com/', message: 'Senza immagine' } } })
    expect(sentJson('interactive_components_spec')).toEqual({ components: [{ type: 'product_tag', enroll_status: 'opt_out' }] })
  })
})

describe('C2-REBASE-18 — create-meta-creative names a product set or a catalog item only through step 18\'s catalog rule', () => {
  const PORTFOLIO = '120000000000090'
  const OTHER_NEXUS = '120000000000081' // a portfolio another business in Nexus uses
  const CATALOG = '120000000000060' // the portfolio's own
  const FOREIGN_CATALOG = '120000000000063' // a client catalog whose owner is another Nexus business's portfolio
  const SET = '120000000000061'
  const ITEM = '120000000000071'
  /** Meta as the catalog rule reads it: the ad account's portfolio, the set's / item's catalog, the catalog's owner. */
  const catalogMeta = (child: string, catalog: string, fails = false) => h.read.mockImplementation(async (_c: unknown, q: { path: string }) => {
    const answers: Record<string, unknown> = {
      act_1234567890: { id: 'act_1234567890', business: { id: PORTFOLIO } },
      [child]: { id: child, product_catalog: { id: catalog } },
      [CATALOG]: { id: CATALOG, business: { id: PORTFOLIO } },
      [FOREIGN_CATALOG]: { id: FOREIGN_CATALOG, business: { id: OTHER_NEXUS } },
      [`${PORTFOLIO}/client_product_catalogs`]: { data: [{ id: FOREIGN_CATALOG }] },
    }
    if (fails && q.path === child) throw new MetaReadError(localFailure('Meta refused it (100): Unsupported get request.', 'X'), 'r', 1)
    return { body: answers[q.path] ?? {}, calls: 1 }
  })
  /** Master CR-448 — an Advantage+ catalog template: template_data and the creative's product set. */
  const template = { name: 'Catalog A', story: { template_data: { link: 'https://www.example.com/', message: '{{product.name}} {{product.price}}', name: '{{product.name}}', call_to_action: { type: 'SHOP_NOW' } } }, parts: { product_set_id: SET } }
  /** Master CR-313 — a catalog item tagged by hand on the image. */
  const tagged = { ...image, productTags: [{ productId: ITEM, x: 0.5, y: 0.4 }] }

  for (const [kind, args, child, word] of [
    ['a product set (product_set_id)', template, SET, 'product set'],
    ['a catalog item (productTags)', tagged, ITEM, 'catalog item'],
  ] as const) {
    it(`${kind}: the business's own catalog passes; another business's catalog, a shared portfolio and an unreadable one are refused before Meta's check`, async () => {
      catalogMeta(child, CATALOG)
      const p = await preview(args)
      expect(p.ok, JSON.stringify(p)).toBe(true)
      expect(h.check).toHaveBeenCalledTimes(1)
      expect(p.preview.warnings.join(' ')).toContain(`Catalog: ${word} ${child} — each passed the catalog rule`)
      h.check.mockClear()
      const refusal = async () => { const r = await preview(args); expect(r.ok, JSON.stringify(r)).toBe(false); return r.error ?? '' }
      catalogMeta(child, FOREIGN_CATALOG); h.taken.add(OTHER_NEXUS)
      expect(await refusal()).toMatch(new RegExp(`^Nothing was asked of Meta: ${word} ${child}: That catalog belongs to a business portfolio another business in Nexus uses\\. Nexus names no such catalog in a change, so nothing is sent\\.$`))
      catalogMeta(child, CATALOG); h.taken.add(PORTFOLIO)
      expect(await refusal()).toMatch(/shared with another business in Nexus.*nothing is sent/)
      h.taken.clear(); catalogMeta(child, CATALOG, true)
      expect(await refusal()).toMatch(new RegExp(`could not confirm that this ${word} is in one of the business's catalogs`))
      expect(h.check).not.toHaveBeenCalled()
    })
  }

  it('products tagged by hand go instead of the automatic-tagging opt-out, never beside autoProductTags', async () => {
    catalogMeta(ITEM, CATALOG)
    const p = await preview(tagged)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('interactive_components_spec')).toEqual({ components: [{ type: 'product_tag', product_tag_spec: { product_id: ITEM }, position_spec: { x: 0.5, y: 0.4 } }] })
    expect(p.preview.warnings.join(' ')).toContain(`Products tagged by hand: item ${ITEM} at (0.5, 0.4); Meta's automatic product tagging is off`)
    expect(p.preview.warnings.join(' ')).not.toMatch(/Automatic product tags: OFF/)
    const both = await preview({ ...tagged, autoProductTags: true })
    expect(both.error).toMatch(/ask productTags or autoProductTags, not both/)
    expect(() => ask()({ ...image, productTags: [{ productId: ITEM, x: 2, y: 0 }] })).toThrow()
  })

  it('product extensions (CR-330 / CR-414) and product data (CR-041): the set and each item through the rule', async () => {
    h.read.mockImplementation(async (_c: unknown, q: { path: string }) => ({
      body: ({ act_1234567890: { business: { id: PORTFOLIO } }, [SET]: { id: SET, product_catalog: { id: CATALOG } }, [ITEM]: { id: ITEM, product_catalog: { id: CATALOG } }, [CATALOG]: { id: CATALOG, business: { id: PORTFOLIO } } } as Record<string, unknown>)[q.path] ?? {},
      calls: 1,
    }))
    const p = await preview({ ...image, aiFeatures: ['product_extensions'], parts: { creative_sourcing_spec: { associated_product_set_id: SET }, product_data: [{ product_id: Number(ITEM), product_source: 'MANUAL', product_decision: 'ACCEPT' }] } })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('product_data')).toEqual([{ product_id: ITEM, product_source: 'MANUAL', product_decision: 'ACCEPT' }])
    expect(sentJson('creative_sourcing_spec')).toEqual({ associated_product_set_id: SET })
    expect(p.preview.warnings.join(' ')).toContain(`Catalog: product set ${SET}, catalog item ${ITEM}`)
  })
})

describe('step 25b — the catalog review in the tool: catalog opt-outs, product extensions, one read per catalog, template cards', () => {
  const PORTFOLIO = '120000000000090'
  const CATALOG = '120000000000060'
  const SET = '120000000000061'
  const ITEM = '120000000000071'
  const ITEM2 = '120000000000072'
  const ownMeta = () => h.read.mockImplementation(async (_c: unknown, q: { path: string }) => ({
    body: ({ act_1234567890: { business: { id: PORTFOLIO } }, [SET]: { id: SET, product_catalog: { id: CATALOG } }, [ITEM]: { id: ITEM, product_catalog: { id: CATALOG } }, [ITEM2]: { id: ITEM2, product_catalog: { id: CATALOG } }, [CATALOG]: { id: CATALOG, business: { id: PORTFOLIO } } } as Record<string, unknown>)[q.path] ?? {},
    calls: 1,
  }))
  const messenger = { name: 'Chat A', story: { link_data: { link: 'https://fb.com/messenger_doc/', image_hash: 'abc123def456', name: 'Chat', call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } } } } }

  it('fix 1 — a messenger creative with an associated set or tagged products carries all six format opt-outs and the shop opt-out', async () => {
    ownMeta()
    for (const args of [{ ...messenger, parts: { creative_sourcing_spec: { associated_product_set_id: SET } } }, { ...messenger, productTags: [{ productId: ITEM, x: 0.5, y: 0.5 }] }]) {
      h.check.mockClear()
      const p = await preview(args)
      expect(p.ok, JSON.stringify(p)).toBe(true)
      expect(sentJson('format_transformation_spec')).toEqual(['da_collection', 'sa_collection', 'single_media', 'catalog_single_media', 'carousel', 'video_slideshow'].map((format) => ({ format, data_source: ['none'] })))
      expect(sentJson('destination_spec')).toEqual({ destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' })
    }
  })

  it('fix 2 — product extensions go ON with action_metadata MANUAL beside the associated set; never without one', async () => {
    ownMeta()
    const p = await preview({ ...messenger, aiFeatures: ['product_extensions'], parts: { creative_sourcing_spec: { associated_product_set_id: SET } } })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('degrees_of_freedom_spec').creative_features_spec.product_extensions).toEqual({ enroll_status: 'OPT_IN', action_metadata: { type: 'MANUAL' } })
    expect(sentJson('degrees_of_freedom_spec').creative_features_spec.inline_comment).toEqual({ enroll_status: 'OPT_OUT' })
    const none = await preview({ ...messenger, aiFeatures: ['product_extensions'] })
    expect(none.error).toMatch(/product_extensions goes ON only beside creative_sourcing_spec.associated_product_set_id/)
  })

  it('fix 3 — one draft reads the ad account\'s portfolio once and each catalog once; more than 5 sets and items are refused', async () => {
    ownMeta()
    const p = await preview({ ...messenger, productTags: [{ productId: ITEM, x: 0.2, y: 0.2 }, { productId: ITEM2, x: 0.8, y: 0.8 }] })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.read.mock.calls.map((c) => (c[1] as { path: string }).path)).toEqual(['act_1234567890', ITEM, CATALOG, ITEM2])
    const six = await preview({ ...messenger, productTags: Array.from({ length: 6 }, (_, i) => ({ productId: `12000000000007${i}`, x: 0.1, y: 0.1 })) })
    expect(six.error).toMatch(/at most 5 product sets and catalog items/)
  })

  it('fix 4 — a catalog template\'s own cards: their order is said (multi_share_optimized), never by hand', async () => {
    ownMeta()
    const template = { name: 'Catalog A', story: { template_data: { link: 'https://www.example.com/', message: 'Tutti', child_attachments: [{ link: 'https://www.example.com/coupon', name: 'Coupon', static_card: true }, { link: 'https://www.example.com/', name: '{{product.name}}' }] } }, parts: { product_set_id: SET } }
    const p = await preview(template)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('object_story_spec').template_data.multi_share_optimized).toBe(false)
    const byHand = await preview({ ...template, story: { template_data: { ...template.story.template_data, multi_share_optimized: true } } })
    expect(byHand.error).toMatch(/the card order is the argument carouselAutoOrder/)
  })
})

describe('gap 46b (master CR-331) — introPost: an EXISTING post as a partnership Advantage+ catalog ad\'s intro card', () => {
  const PORTFOLIO = '120000000000090'
  const OUTSIDE = '120000000000082' // a business outside Nexus that shares a client catalog
  const CATALOG = '120000000000060'
  const CLIENT_CATALOG = '120000000000064'
  const SET = '120000000000061'
  const PARTNER_PAGE = '120000000000555'
  const PARTNER_IG = '17841400000000555'
  const MEDIA = '17900000000000001'
  const partner = { pageId: PARTNER_PAGE, instagramId: PARTNER_IG, mainIdentity: 'brand' as const }
  const catalog = { name: 'Catalog A', story: { template_data: { link: 'https://www.example.com/', message: '{{product.name}}', call_to_action: { type: 'SHOP_NOW' } } }, parts: { product_set_id: SET }, partner }
  /** Meta as the catalog rule and step 10's media owner check read it. */
  const meta = (setCatalog = CATALOG, mediaOwner = IG) => h.read.mockImplementation(async (_c: unknown, q: { path: string }) => {
    const answers: Record<string, unknown> = {
      act_1234567890: { id: 'act_1234567890', business: { id: PORTFOLIO } },
      [SET]: { id: SET, product_catalog: { id: setCatalog } },
      [CATALOG]: { id: CATALOG, business: { id: PORTFOLIO } },
      [CLIENT_CATALOG]: { id: CLIENT_CATALOG, business: { id: OUTSIDE } },
      [`${PORTFOLIO}/client_product_catalogs`]: { data: [{ id: CLIENT_CATALOG }] },
      [MEDIA]: { id: MEDIA, owner: { id: mediaOwner }, media_product_type: 'FEED' },
    }
    return { body: answers[q.path] ?? {}, calls: 1 }
  })
  const lookup = (author: Record<string, unknown>, platform = 'INSTAGRAM', contentId = MEDIA) => h.partners.mockImplementation(async (input: { view: string }) => (input.view === 'lookup'
    ? { items: [{ contentId, platform, mediaType: 'IMAGE', author, partnerships: [{ adEligibility: 'AD_READY', permissionStatus: 'APPROVED', taggedPartner: { pageId: PAGE, instagramId: IG } }] }] }
    : { items: [] }))
  const warnings = (p: { preview: Record<string, any> }) => p.preview.warnings.join(' ')

  it('the chosen Page\'s post: sent as branded_content.parent_source_facebook_post_id beside the partner, named in the preview, Meta checks it first', async () => {
    meta()
    const post = `${PAGE}_500000000000001`
    const p = await preview({ ...catalog, introPost: { source: 'facebook-post', id: post } })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('branded_content')).toEqual({ parent_source_facebook_post_id: post })
    expect(sentJson('facebook_branded_content')).toEqual({ sponsor_page_id: PARTNER_PAGE })
    expect(checked().params.product_set_id).toBe(SET)
    expect(JSON.stringify(p.preview.changes)).toContain(`post ${post} of the chosen Facebook Page`)
    expect(warnings(p)).toMatch(/Intro card: post .* the first card of this partnership catalog ad \(branded_content\.parent_source_facebook_post_id\)/)
    expect(warnings(p)).toMatch(/names no client catalog/)
    expect(h.partners).not.toHaveBeenCalled()
  })
  it('the chosen Instagram account\'s media (step 10\'s owner check), with Meta\'s note on a video still processing', async () => {
    meta()
    const p = await preview({ ...catalog, introPost: { source: 'instagram-media', id: MEDIA } })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(sentJson('branded_content')).toEqual({ parent_source_instagram_media_id: MEDIA })
    expect(warnings(p)).toMatch(/When using an Instagram post that is a video, call the \/advideos endpoint/)
    // Another account's media is not the business's own.
    h.check.mockClear(); meta(CATALOG, PARTNER_IG)
    const other = await preview({ ...catalog, introPost: { source: 'instagram-media', id: MEDIA } })
    expect(other.ok).toBe(false)
    expect(h.check).not.toHaveBeenCalled()
  })
  it('the partner\'s: Meta\'s content discovery lists it for the brand, by the partner named — else refused before Meta\'s check', async () => {
    meta(); lookup({ instagramId: PARTNER_IG, pageId: null })
    const p = await preview({ ...catalog, introPost: { source: 'creator-instagram-media', id: MEDIA } })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.partners).toHaveBeenCalledWith(expect.objectContaining({ view: 'lookup', contentIds: [MEDIA] }))
    expect(JSON.stringify(p.preview.changes)).toContain('the partner\'s Instagram media 17900000000000001 (Meta\'s content discovery lists it for the brand)')
    const refusal = async (args: Record<string, unknown>) => { h.check.mockClear(); const r = await preview(args); expect(r.ok, JSON.stringify(r)).toBe(false); expect(h.check).not.toHaveBeenCalled(); return r.error ?? '' }
    // By another creator than the partner named.
    lookup({ instagramId: '17841400000000999', pageId: null })
    expect(await refusal({ ...catalog, introPost: { source: 'creator-instagram-media', id: MEDIA } })).toMatch(/is by another account than the partner this ad names \(partner\)/)
    // The business's own content named as the partner's: said with this tool's words.
    lookup({ instagramId: IG, pageId: null })
    expect(await refusal({ ...catalog, introPost: { source: 'creator-instagram-media', id: MEDIA } })).toMatch(/is the business's own: name it as introPost source facebook-post or instagram-media/)
    // Not listed: no partnership-ad access to it.
    h.partners.mockImplementation(async () => ({ items: [] }))
    expect(await refusal({ ...catalog, introPost: { source: 'creator-instagram-media', id: MEDIA } })).toMatch(/content discovery does not list content 17900000000000001/)
    // By a partner another business in Nexus uses: the masked row is refused.
    h.partners.mockImplementation(async () => ({ items: [{ contentId: MEDIA, takenByAnotherBusiness: true }] }))
    expect(await refusal({ ...catalog, introPost: { source: 'creator-instagram-media', id: MEDIA } })).toMatch(/another business in Nexus uses: no creative of this business shows it/)
    // A partner's Facebook post: its Page part is the partner named.
    lookup({ pageId: PARTNER_PAGE, instagramId: null }, 'FACEBOOK', '500000000000001')
    const fb = await preview({ ...catalog, introPost: { source: 'creator-facebook-post', id: `${PARTNER_PAGE}_500000000000001` } })
    expect(fb.ok, JSON.stringify(fb)).toBe(true)
    expect(sentJson('branded_content')).toEqual({ parent_source_facebook_post_id: `${PARTNER_PAGE}_500000000000001` })
  })
  it('only on a partnership Advantage+ catalog creative of the business portfolio\'s OWN catalog; the parent source only through introPost', async () => {
    meta()
    const refusal = async (args: Record<string, unknown>) => { h.check.mockClear(); const r = await preview(args); expect(r.ok, JSON.stringify(r)).toBe(false); expect(h.check).not.toHaveBeenCalled(); return r.error ?? '' }
    const intro = { source: 'facebook-post', id: `${PAGE}_500000000000001` }
    expect(await refusal({ ...catalog, partner: undefined, introPost: intro })).toMatch(/goes on a partnership ad — name the partner/)
    expect(await refusal({ ...image, partner, introPost: intro })).toMatch(/goes on an Advantage\+ catalog creative — story\.template_data with parts\.product_set_id/)
    expect(await refusal({ name: 'From a post', postId: POST, partner, introPost: intro })).toMatch(/goes on an Advantage\+ catalog creative/)
    expect(await refusal({ ...catalog, parts: { product_set_id: SET, branded_content: { parent_source_instagram_media_id: MEDIA } } })).toMatch(/branded_content\.parent_source_instagram_media_id is this tool's own argument \(introPost\)/)
    // A catalog creative without its product set: the gateway's own judge says it (the tool asks it first).
    expect(await refusal({ ...catalog, parts: {}, introPost: intro })).toMatch(/goes only on an Advantage\+ catalog creative: object_story_spec\.template_data with the creative's own product_set_id/)
    // A client catalog (even of a business outside Nexus) with an intro card: refused; without one it keeps the read rule.
    meta(CLIENT_CATALOG)
    expect(await refusal({ ...catalog, introPost: intro })).toMatch(/product set 120000000000061: A partnership catalog ad with an existing post as its intro card names only a catalog the chosen ad account's business portfolio owns/)
    const plain = await preview(catalog)
    expect(plain.ok, JSON.stringify(plain)).toBe(true)
    expect(() => create.input.parse({ ...catalog, introPost: { source: 'creator-instagram-media', id: '0179' } })).toThrow()
    expect(() => create.input.parse({ ...catalog, introPost: { source: 'someone-else', id: MEDIA } })).toThrow()
  })
})
