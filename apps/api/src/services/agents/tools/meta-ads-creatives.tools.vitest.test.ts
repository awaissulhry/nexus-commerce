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

  it('refuses in words, before any call: another Page, the silent keys through parts, music by hand, political, catalog, no name', async () => {
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
    expect(await refusal({ ...image, parts: { product_set_id: '120000000000444' } })).toMatch(/catalog rule \(step 18\)/)
    expect(await refusal({ ...image, story: { link_data: { ...image.story.link_data }, instagram_actor_id: IG } })).toMatch(/instagram_user_id/)
    expect(await refusal({ ...image, postId: POST })).toMatch(/one of them/)
    expect(await refusal({ name: 'From a post', postId: '120000000000099_500000000000001' })).toMatch(/not on the Facebook Page this business chose/)
    expect(await refusal({ story: image.story })).toMatch(/name is 1 to 100/)
    expect(await refusal({ ...image, story: { link_data: { ...image.story.link_data, link: 'http://www.example.com/' } } })).toMatch(/https/)
    expect(await refusal({ ...image, shopDestination: true })).toMatch(/cannot confirm a shop is this business's own/)
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
    expect(Object.keys(checked().params).sort()).toEqual(['call_to_action', 'contextual_multi_ads', 'degrees_of_freedom_spec', 'destination_spec', 'format_transformation_spec', 'instagram_user_id', 'name', 'object_story_id'])
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
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000301', kind: 'creative', method: 'DELETE', operation: 'creative.remove' })
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

  it('B2 — saved Page welcome-message flows are answered in words (they need the Page token)', async () => {
    const p = await preview({ action: 'welcome-flow' })
    expect(p).toMatchObject({ ok: false, error: WELCOME_FLOWS_ANSWER })
    expect(WELCOME_FLOWS_ANSWER).toMatch(/Page-token mode \(step 36\)/)
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
