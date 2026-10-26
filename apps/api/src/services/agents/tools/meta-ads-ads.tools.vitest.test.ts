/**
 * Meta step 27 — create-meta-ad and set-meta-ad as the approval gate uses them (Meta, the account, the live reads and the
 * records are stand-ins): a new ad is born PAUSED unless asked (then SPENDS MONEY, saying whether its ad set and campaign are
 * on), never ACTIVE with a feature generated with AI, Meta checks it first with its synchronous integrity review; the ad set,
 * campaign, creative and pixels are read first (50 ads per ad set, one in a Dynamic Creative ad set, the EU's payer and
 * beneficiary, no political ad); an inline creative is step 25's (every silent feature OFF); the undo deletes only an ad this
 * tool made that never ran, then its inline creative made new once the ad is gone. set-meta-ad renames, swaps the creative
 * (back to review), relabels and moves or clears the ad's own schedule, and its undo puts back exactly that. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  chosen: {} as Record<string, unknown>,
  records: [] as Array<{ toolName?: string; after: unknown }>,
  read: vi.fn(),
  listPaged: vi.fn(),
  send: vi.fn(),
  check: vi.fn(),
  owned: vi.fn(),
  taken: new Set<string>(),
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

import { META_ADS_ADS_TOOLS } from './meta-ads-ads.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { targetsDsaArea, isoOf } from '../../marketing/meta-ads/change-ads.js'
import { META_ACTIVATE_FEATURES } from '../../gateway/meta-ad-rules.js'
import { META_CREATIVE_FEATURES } from '../../gateway/meta-creative-rules.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { MetaReadError, localFailure } from '../../marketing/meta-ads/errors.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const create = META_ADS_ADS_TOOLS.find((t) => t.name === 'create-meta-ad')!
const setAd = META_ADS_ADS_TOOLS.find((t) => t.name === 'set-meta-ad')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const parse = (tool = create) => (args: Record<string, unknown>) => tool.input.parse(args) as Record<string, unknown>
const preview = async (args: Record<string, unknown>, tool = create) => (await tool.handler(parse(tool)(args), asker)) as ToolResult & { preview: Record<string, any>; error?: string }
const refusal = async (args: Record<string, unknown>, tool = create) => {
  const p = await preview(args, tool)
  expect(p.ok, JSON.stringify(p)).toBe(false)
  return p.error as string
}
const run = async (args: Record<string, unknown>, tool = create) => {
  const p = await preview(args, tool)
  expect(p.ok, JSON.stringify(p)).toBe(true)
  return (await tool.execute!(parse(tool)(args), approved(p.preview))) as ToolResult & { data: Record<string, any>; change: { before: any; after: any }; error?: string }
}

const ACT = 'act_1234567890'
const PAGE = '120000000000010'
const IG = '17841400000000001'
const ADSET = '120000000000002'
const CAMPAIGN = '120000000000001'
const AD = '120000000000003'
const CREATIVE = '120000000000301'
const NEW_CREATIVE = '120000000000302'
const PIXEL = '120000000000777'
const checked = () => h.check.mock.calls[0][1] as { objectId: string; kind: string; edge: string; params: Record<string, string>; adReview?: boolean; recommendations?: boolean }
const base = { name: 'Ad A', adSetId: ADSET }
/** A creative that reads OFF for every Advantage+ feature (the only kind an ACTIVE ad may show). */
const allOff = (on: string[] = []) => ({ creative_features_spec: Object.fromEntries(META_ACTIVATE_FEATURES.map((f) => [f, { enroll_status: on.includes(f) ? 'OPT_IN' : 'OPT_OUT' }])) })
const linkAd = { name: 'Creative A', story: { link_data: { link: 'https://www.example.com/shoes', message: 'Scarpe nuove', image_hash: 'abc123', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://www.example.com/shoes' } } } } }

let reads: Record<string, Record<string, unknown>> = {}
let lists: Record<string, { rows: Array<Record<string, unknown>>; more: boolean; totalCount: number | null }> = {}

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.chosen = { connectionId: 'm-1', adAccountId: '1234567890', businessId: '9876543210', pageId: PAGE, instagramId: IG, timeZone: 'Europe/Rome' }
  h.records = []
  h.taken.clear()
  reads = {
    [ADSET]: { id: ADSET, name: 'Ad set A', campaign_id: CAMPAIGN, status: 'ACTIVE', effective_status: 'ACTIVE', is_dynamic_creative: false, dsa_payor: 'Shop A', dsa_beneficiary: 'Shop A', targeting: { geo_locations: { countries: ['IT'] } } },
    [CAMPAIGN]: { id: CAMPAIGN, name: 'Campaign A', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', special_ad_categories: [] },
    [CREATIVE]: { id: CREATIVE, name: 'Creative A', status: 'ACTIVE', object_story_spec: { page_id: PAGE, link_data: { link: 'https://www.example.com/shoes' } }, degrees_of_freedom_spec: allOff(), contextual_multi_ads: { enroll_status: 'OPT_OUT' }, effective_authorization_category: 'NONE' },
    [ACT]: {},
  }
  lists = { [`${ADSET}/ads`]: { rows: [], more: false, totalCount: 0 }, [`${ACT}/adspixels`]: { rows: [{ id: PIXEL }], more: false, totalCount: null }, [`${ACT}/ads`]: { rows: [], more: false, totalCount: null } }
  h.read.mockReset(); h.read.mockImplementation(async (_c: unknown, q: { path: string }) => ({ body: reads[q.path] ?? {}, calls: 1 }))
  h.listPaged.mockReset(); h.listPaged.mockImplementation(async (_c: string, _o: string, path: string) => lists[path] ?? { rows: [], more: false, totalCount: null })
  h.send.mockReset()
  h.check.mockReset(); h.check.mockImplementation(async () => ({ success: true }))
  h.owned.mockReset(); h.owned.mockImplementation(async (_a: unknown, id: string) => id)
})

describe('the tools', () => {
  it('are changes a person always approves (ask ceiling, open world, high risk), each with an undo', () => {
    for (const tool of [create, setAd]) {
      expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'partial', requires: ['ads.campaigns.manage'] })
      expect(tool.undo).toBeDefined()
      expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(create.consequencesFor!({ action: 'undo' })).toEqual({ reversibility: 'none' })
    expect(META_CHANGE_RULES).toMatch(/a creative or an ad\)/)
    // Instant Experiences are their own tools (step 27b, meta-ads-instant-experiences.tools.ts), not ads tools.
    expect(META_ADS_ADS_TOOLS.map((t) => t.name)).toEqual(['create-meta-ad', 'set-meta-ad'])
  })
})

describe('create-meta-ad — the preview', () => {
  it('from an existing creative: born PAUSED, Meta checks it with its integrity review, nothing spends', async () => {
    const p = await preview({ ...base, creativeId: CREATIVE })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(checked()).toMatchObject({ objectId: ACT, kind: 'adaccount', edge: 'ads', adReview: true })
    expect(checked().recommendations).toBeUndefined()
    expect(checked().params).toEqual({ name: 'Ad A', adset_id: ADSET, creative: JSON.stringify({ creative_id: CREATIVE }), status: 'PAUSED' })
    expect(p.preview.spendsMoney).toBe(false)
    expect(p.preview.metaCheck.checked).toBe('all')
    const words = p.preview.warnings.join(' ')
    expect(words).toMatch(/created PAUSED: it spends nothing/)
    expect(words).toMatch(/synchronous_ad_review/)
    expect(words).toMatch(/EU \(DSA\)/)
    expect(h.owned).toHaveBeenCalledWith(h.chosen, ADSET, 'adset', 'ad.ownerCheck')
    expect(h.owned).toHaveBeenCalledWith(h.chosen, CREATIVE, 'creative', 'ad.creativeOwnerCheck')
  })

  it('activate: SPENDS MONEY, saying whether the ad set AND the campaign are on now', async () => {
    const on = await preview({ ...base, creativeId: CREATIVE, activate: true })
    expect(checked().params.status).toBe('ACTIVE')
    expect(on.preview.spendsMoney).toBe(true)
    expect(on.preview.spendsMoneyBecause[0]).toMatch(/created ACTIVE and its ad set "Ad set A" is ACTIVE and its campaign "Campaign A" is ACTIVE now: it starts spending as soon as Meta approves it/)
    reads[ADSET] = { ...reads[ADSET], status: 'PAUSED', effective_status: 'PAUSED' }
    const off = await preview({ ...base, creativeId: CREATIVE, activate: true })
    expect(off.preview.spendsMoneyBecause[0]).toMatch(/nothing spends until the ad set is switched on too/)
  })

  it('review A2: activate only with a creative that reads OPT_OUT for EVERY Advantage+ feature — any opt-in, any feature not said, no switches: refused', async () => {
    const rule = /create it PAUSED, preview it, then switch it on with set-meta-status \(Meta's rule for AI features\)/
    reads[CREATIVE] = { ...reads[CREATIVE], degrees_of_freedom_spec: allOff(['image_animation']) }
    expect(await refusal({ ...base, creativeId: CREATIVE, activate: true })).toMatch(/switches on image_animation: create it PAUSED/)
    const paused = await preview({ ...base, creativeId: CREATIVE })
    expect(paused.preview.warnings.join(' ')).toMatch(/keep the ad PAUSED, see each feature in the preview/)
    expect(paused.preview.warnings.join(' ')).toMatch(/Advantage\+ features ON: image_animation/)
    for (const feature of ['standard_enhancements', 'text_optimizations', 'image_touchups', 'description_automation']) {
      reads[CREATIVE] = { ...reads[CREATIVE], degrees_of_freedom_spec: allOff([feature]) }
      expect(await refusal({ ...base, creativeId: CREATIVE, activate: true }), feature).toMatch(rule)
    }
    reads[CREATIVE] = { ...reads[CREATIVE], degrees_of_freedom_spec: { creative_features_spec: { image_touchups: { enroll_status: 'OPT_OUT' } } } }
    expect(await refusal({ ...base, creativeId: CREATIVE, activate: true })).toMatch(/does not say OPT_OUT for .*\(Meta may switch such a feature on by itself\)/)
    reads[CREATIVE] = { ...reads[CREATIVE], degrees_of_freedom_spec: undefined }
    expect(await refusal({ ...base, creativeId: CREATIVE, activate: true })).toMatch(/reads no Advantage\+ feature switches/)
    // An inline creative opting into any feature (AI or not) is never created ACTIVE either; fully off it may be.
    expect(await refusal({ ...base, creative: { ...linkAd, aiFeatures: ['image_background_gen'] }, activate: true })).toMatch(/image_background_gen/)
    expect(await refusal({ ...base, creative: { ...linkAd, aiFeatures: ['image_touchups'] }, activate: true })).toMatch(rule)
    expect((await preview({ ...base, creative: linkAd, activate: true })).ok).toBe(true)
    reads[CREATIVE] = { ...reads[CREATIVE], degrees_of_freedom_spec: allOff() }
    expect((await preview({ ...base, creativeId: CREATIVE, activate: true })).ok).toBe(true)
  })

  it('review A2: an existing creative\'s other switches are named as Meta reads them (multi-advertiser, format automation, product tags, music)', async () => {
    reads[CREATIVE] = { ...reads[CREATIVE], contextual_multi_ads: undefined, format_transformation_spec: [{ format: 'carousel', data_source: ['catalog'] }], interactive_components_spec: { components: [{ type: 'product_tag', enroll_status: 'opt_in' }] }, asset_feed_spec: { audios: [{ type: 'random' }] } }
    const words = (await preview({ ...base, creativeId: CREATIVE })).preview.warnings.join(' ')
    expect(words).toMatch(/multi-advertiser ads not said/)
    expect(words).toMatch(/format automation ON: carousel/)
    expect(words).toMatch(/automatic product tags ON/)
    expect(words).toMatch(/music ON/)
    reads[CREATIVE] = { ...reads[CREATIVE], contextual_multi_ads: { enroll_status: 'OPT_OUT' }, format_transformation_spec: undefined, interactive_components_spec: undefined, asset_feed_spec: undefined }
    expect((await preview({ ...base, creativeId: CREATIVE })).preview.warnings.join(' ')).toMatch(/reads every Advantage\+ feature OFF, multi-advertiser ads OFF and no other opt-in/)
  })

  it('reads first and refuses in words: 50 ads, a Dynamic Creative ad set not empty, an ended ad set, a political campaign, a political creative', async () => {
    lists[`${ADSET}/ads`] = { rows: [], more: true, totalCount: 50 }
    expect(await refusal({ ...base, creativeId: CREATIVE })).toMatch(/at most 50 per ad set/)
    lists[`${ADSET}/ads`] = { rows: [{ id: AD }], more: false, totalCount: 1 }
    reads[ADSET] = { ...reads[ADSET], is_dynamic_creative: true }
    expect(await refusal({ ...base, creativeId: CREATIVE })).toMatch(/ONE ad in such an ad set/)
    reads[ADSET] = { ...reads[ADSET], is_dynamic_creative: false, end_time: '2020-01-01T00:00:00+0000' }
    expect(await refusal({ ...base, creativeId: CREATIVE })).toMatch(/1487007/)
    reads[ADSET] = { ...reads[ADSET], end_time: undefined }
    reads[CAMPAIGN] = { ...reads[CAMPAIGN], special_ad_categories: ['ISSUES_ELECTIONS_POLITICS'] }
    expect(await refusal({ ...base, creativeId: CREATIVE })).toMatch(/banned in the EU/)
    reads[CAMPAIGN] = { ...reads[CAMPAIGN], special_ad_categories: [] }
    reads[CREATIVE] = { ...reads[CREATIVE], effective_authorization_category: 'POLITICAL' }
    expect(await refusal({ ...base, creativeId: CREATIVE })).toMatch(/POLITICAL/)
    expect(h.check).not.toHaveBeenCalled()
  })

  it('EU (DSA): an EU ad set needs a payer and a beneficiary — its own or the account\'s defaults — else refused in words', async () => {
    reads[ADSET] = { ...reads[ADSET], dsa_payor: undefined, dsa_beneficiary: undefined }
    expect(await refusal({ ...base, creativeId: CREATIVE })).toMatch(/names neither.*3858079/)
    reads[ACT] = { default_dsa_payor: 'Shop A', default_dsa_beneficiary: 'Shop A' }
    const p = await preview({ ...base, creativeId: CREATIVE })
    expect(p.preview.warnings.join(' ')).toMatch(/account's defaults/)
    // Outside the EU nothing is read; a country group or a region without its country counts as the EU (fail-safe).
    reads[ACT] = {}
    reads[ADSET] = { ...reads[ADSET], targeting: { geo_locations: { countries: ['US'] } } }
    expect((await preview({ ...base, creativeId: CREATIVE })).ok).toBe(true)
    expect(targetsDsaArea({ geo_locations: { countries: ['US'], country_groups: ['worldwide'] } })).toBe(true)
    expect(targetsDsaArea({ geo_locations: { regions: [{ key: '1', country: 'US' }] } })).toBe(false)
    expect(targetsDsaArea({ geo_locations: { regions: [{ key: '1' }] } })).toBe(true)
    expect(targetsDsaArea(null)).toBe(true)
  })

  it('an inline creative is step 25\'s: the chosen Page and Instagram account, every Advantage+ feature OFF, multi-advertiser off', async () => {
    const p = await preview({ ...base, creative: linkAd })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    const creative = JSON.parse(checked().params.creative)
    expect(creative.object_story_spec).toMatchObject({ page_id: PAGE, instagram_user_id: IG })
    expect(Object.keys(creative.degrees_of_freedom_spec.creative_features_spec).sort()).toEqual([...META_CREATIVE_FEATURES].sort())
    expect(Object.values(creative.degrees_of_freedom_spec.creative_features_spec).every((f: any) => f.enroll_status === 'OPT_OUT')).toBe(true)
    expect(creative.contextual_multi_ads).toEqual({ enroll_status: 'OPT_OUT' })
    expect(creative.asset_feed_spec).toEqual({ audios: [] })
    expect(p.preview.changes.Creative.to).toMatch(/a new creative "Creative A"/)
    // Its name defaults to the ad's — review A5: cut to a creative's 100 characters.
    await preview({ ...base, creative: { story: linkAd.story } })
    expect(JSON.parse((h.check.mock.calls.at(-1)![1] as { params: Record<string, string> }).params.creative).name).toBe('Ad A')
    const long = `${'Annuncio '.repeat(16)}🎉🎉`
    expect((await preview({ ...base, name: long, creative: { story: linkAd.story } })).ok).toBe(true)
    expect(JSON.parse((h.check.mock.calls.at(-1)![1] as { params: Record<string, string> }).params.creative).name).toBe([...long].slice(0, 100).join(''))
    expect(await refusal({ ...base })).toMatch(/ONE creative/)
    expect(await refusal({ ...base, creativeId: CREATIVE, creative: linkAd })).toMatch(/ONE creative/)
  })

  it('CR-218: a "message us" footer only inline, only on a website ad with a website button', async () => {
    const p = await preview({ ...base, creative: linkAd, messageFooter: 'whatsapp' })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(JSON.parse(checked().params.creative).asset_feed_spec).toEqual({ message_extensions: [{ type: 'whatsapp' }], audios: [] })
    expect(p.preview.warnings.join(' ')).toMatch(/"message us" footer \(whatsapp\)/)
    const messaging = { name: 'Creative B', story: { link_data: { link: 'https://www.example.com/', image_hash: 'abc123', call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } } } } }
    expect(await refusal({ ...base, creative: messaging, messageFooter: 'messenger' })).toMatch(/only on a website ad/)
    expect(await refusal({ ...base, creativeId: CREATIVE, messageFooter: 'messenger' })).toMatch(/only with an inline creative/)
    // Review B6 — each channel only in the objectives Meta lists for it.
    reads[CAMPAIGN] = { ...reads[CAMPAIGN], objective: 'OUTCOME_ENGAGEMENT' }
    expect(await refusal({ ...base, creative: linkAd, messageFooter: 'messenger' })).toMatch(/footer of messenger runs only in sales, traffic, leads, awareness campaigns/)
    expect((await preview({ ...base, creative: linkAd, messageFooter: 'whatsapp' })).ok).toBe(true)
    reads[CAMPAIGN] = { ...reads[CAMPAIGN], objective: 'OUTCOME_AWARENESS' }
    expect(await refusal({ ...base, creative: linkAd, messageFooter: 'instagram_message' })).toMatch(/footer of instagram_message runs only in sales, traffic, leads campaigns/)
  })

  it('the ad\'s own schedule and the flexible format only in sales and app-promotion campaigns; the times as UTC Unix seconds', async () => {
    const p = await preview({ ...base, creativeId: CREATIVE, scheduleStart: '2030-01-02T08:00:00+01:00', scheduleEnd: '2030-01-05T08:00:00+01:00' })
    expect(checked().params).toMatchObject({ ad_schedule_start_time: String(Date.UTC(2030, 0, 2, 7) / 1000), ad_schedule_end_time: String(Date.UTC(2030, 0, 5, 7) / 1000) })
    expect(p.ok).toBe(true)
    const groups = [{ images: [{ hash: 'abc123' }], texts: [{ text: 'Saldi', text_type: 'headline' }], call_to_action: { type: 'SHOP_NOW', value: { link: 'https://www.example.com/' } } }]
    h.check.mockClear()
    await preview({ ...base, creativeId: CREATIVE, flexibleGroups: groups })
    expect(JSON.parse(checked().params.creative_asset_groups_spec)).toEqual({ groups })
    reads[CAMPAIGN] = { ...reads[CAMPAIGN], objective: 'OUTCOME_TRAFFIC' }
    expect(await refusal({ ...base, creativeId: CREATIVE, scheduleStart: '2030-01-02T08:00:00+01:00' })).toMatch(/only available for sales and app promotion campaigns/)
    expect(await refusal({ ...base, creativeId: CREATIVE, flexibleGroups: groups })).toMatch(/flexible ad format runs only in sales/)
  })

  it('tracking: only the chosen account\'s own pixels; a conversion domain of the creative\'s link; labels, persona, engagement audience', async () => {
    expect(await refusal({ ...base, creativeId: CREATIVE, tracking: [{ pixelId: '120000000000999' }] })).toMatch(/not one of the chosen ad account's own pixels/)
    expect(await refusal({ ...base, creativeId: CREATIVE, conversionDomain: 'example.org' })).toMatch(/no website link on example.org/)
    expect(await refusal({ ...base, creativeId: CREATIVE, conversionDomain: 'shop.example.com' })).toMatch(/first and second level only/)
    expect(await refusal({ ...base, creativeId: CREATIVE, conversionDomain: 'https://example.com' })).toMatch(/first and second level only/)
    const p = await preview({ ...base, creativeId: CREATIVE, tracking: [{ pixelId: PIXEL }, { pixelId: PIXEL, action: 'leadgen_quality_conversion' }], conversionDomain: 'example.com', labels: ['Spring'], persona: { ageMin: 25, ageMax: 44, genders: [2] }, engagementAudience: true })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(checked().params).toMatchObject({
      tracking_specs: JSON.stringify([{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }, { 'action.type': ['leadgen_quality_conversion'], fb_pixel: [PIXEL] }]),
      conversion_domain: 'example.com', adlabels: '[{"name":"Spring"}]', creative_audience_pairing_persona: '{"age_min":25,"age_max":44,"genders":[2]}', engagement_audience: 'true',
    })
    const words = p.preview.warnings.join(' ')
    expect(words).toMatch(/Engagement audience: Meta also makes a custom audience/)
    expect(words).toMatch(/creative audience pairing/)
  })

  it('AD-034 / AD-028: display_sequence and priority only when asked (no explained effect); Meta\'s recommendations as read-only words', async () => {
    h.check.mockImplementation(async () => ({ success: true, recommendations: [{ title: 'Add a video', message: 'Ads with video do better.', importance: 'HIGH' }] }))
    const p = await preview({ ...base, creativeId: CREATIVE, displaySequence: 2, priority: 1, recommendations: true })
    expect(checked()).toMatchObject({ adReview: true, recommendations: true })
    expect(checked().params).toMatchObject({ display_sequence: '2', priority: '1' })
    const words = p.preview.warnings.join(' ')
    expect(words).toMatch(/explains no effect/)
    // Step 19's way: Meta's recommendations come back in the preview as metaRecommendations (read-only).
    expect(JSON.stringify(p.preview.metaRecommendations)).toMatch(/Add a video/)
    // Review A6 — a check with recommendations is another plan than one without (never answered from the other's memory).
    const without = await preview({ ...base, creativeId: CREATIVE, displaySequence: 2, priority: 1 })
    expect(without.preview.plan).not.toBe(p.preview.plan)
  })

  it('Meta\'s check refuses: nothing is queued, in Meta\'s words', async () => {
    h.check.mockImplementation(async () => { throw new MetaWriteError({ sentence: 'Meta refused it (100/2446383): needs a website URL.', origin: 'meta', code: '100/2446383' } as never, 'ad.create.check', 'refused') })
    expect(await refusal({ ...base, creativeId: CREATIVE })).toMatch(/Meta would refuse step 1 .*2446383.*Nothing was queued/)
  })
})

describe('create-meta-ad — the run and its undo', () => {
  it('makes the ad, reads its inline creative back ("was it new?", what Meta kept) and records both', async () => {
    h.send.mockImplementation(async (_t: unknown, change: { objectId: string; edge?: string }) => (change.edge === 'ads'
      ? { node: { id: AD, success: true }, readBack: 'same-request', waitedMs: 0 }
      : { node: null, readBack: 'none', waitedMs: 0 }))
    const created = new Date().toISOString().replace('Z', '+0000')
    reads[AD] = { id: AD, name: 'Ad A', status: 'PAUSED', effective_status: 'PENDING_REVIEW', adset_id: ADSET, campaign_id: CAMPAIGN, creative: { id: NEW_CREATIVE } }
    reads[NEW_CREATIVE] = { id: NEW_CREATIVE, name: 'Creative A', status: 'ACTIVE', effective_object_story_id: `${PAGE}_500000000000001`, degrees_of_freedom_spec: { creative_features_spec: { inline_comment: { enroll_status: 'OPT_OUT' } } }, contextual_multi_ads: { enroll_status: 'OPT_OUT' } }
    reads[`${PAGE}_500000000000001`] = { id: `${PAGE}_500000000000001`, created_time: created }
    const r = await run({ ...base, creative: linkAd })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.data.steps[0].sentence).toMatch(/Meta made ad 120000000000003 \(PAUSED \(PENDING_REVIEW\)\) showing creative 120000000000302/)
    expect(r.data.steps[0].sentence).toMatch(/Its inline creative: Meta made creative 120000000000302.*new in the ad account/)
    expect(r.data.steps[0].sentence).toMatch(/It is PAUSED: see it first/)
    expect(r.change.after).toMatchObject({ kind: 'create', items: [{ kind: 'ad', adId: AD, name: 'Ad A', status: 'PAUSED' }, { kind: 'creative', creativeId: NEW_CREATIVE, adId: AD, new: true, inline: true }], accountId: 'm-1', adAccountId: '1234567890' })
    const undo = create.undo!.request(r.change)
    expect(undo).toEqual({ tool: 'create-meta-ad', args: { connectionId: 'm-1', action: 'undo', ads: [AD], why: expect.any(String) } })
    expect(create.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })

  it('undo: only an ad this tool made, not ACTIVE, never run — then its inline creative made new, only once the ad reads deleted', async () => {
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(/not one a create-meta-ad of this business made/)
    h.records = [{ toolName: 'create-meta-ad', after: { adAccountId: '1234567890', items: [{ kind: 'ad', adId: AD }, { kind: 'creative', creativeId: NEW_CREATIVE, adId: AD, new: true }] } }]
    reads[AD] = { id: AD, status: 'ACTIVE', adset_id: ADSET, created_time: '2026-10-20T10:00:00+0000', creative: { id: NEW_CREATIVE } }
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(/it is ACTIVE/)
    reads[AD] = { ...reads[AD], status: 'PAUSED' }
    reads[`${AD}/insights`] = { data: [{ spend: '1.20', impressions: '300' }] }
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(/it has run .*archive it with set-meta-status/)
    reads[`${AD}/insights`] = { data: [] }
    lists[`${ACT}/ads`] = { rows: [{ id: AD, creative: { id: NEW_CREATIVE } }], more: false, totalCount: null }
    const p = await preview({ action: 'undo', ads: [AD] })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(p.preview.requests.map((r: { label: string }) => r.label)).toEqual([`Delete ad ${AD} (made by Nexus, never run) from ad account ${ACT}`, `Delete creative ${NEW_CREATIVE} (made new with ad ${AD}) once that ad is deleted`])
    expect(h.read.mock.calls.find((c) => (c[1] as { path: string }).path === `${AD}/insights`)?.[1]).toMatchObject({ query: { fields: 'spend,impressions', time_range: { since: '2026-10-19', until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } } })
    // The run: the ad's DELETE, then the creative's only when the ad reads DELETED.
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const r = await create.execute!(parse()({ action: 'undo', ads: [AD] }), approved(p.preview)) as ToolResult & { data: Record<string, any> }
    expect(r.data.steps.map((s: { outcome: string }) => s.outcome)).toEqual(['done', 'not_sent'])
    expect(r.data.steps[1].sentence).toMatch(/does not read as deleted, so its creative 120000000000302 stays/)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: AD, kind: 'ad', method: 'DELETE', operation: 'ad.delete' })
    // A Dynamic Creative ad and an ad of an ad set with a sequence stay.
    reads[ADSET] = { ...reads[ADSET], is_dynamic_creative: true }
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(/Dynamic Creative ad.*1340029/)
    reads[ADSET] = { ...reads[ADSET], is_dynamic_creative: false, creative_sequence: [AD] }
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(/ad sequence/)
  })

  it('review A7: Meta\'s numbers lag — an ad created ACTIVE, or changed after it was made, is not deleted for 30 minutes', async () => {
    const now = Date.now()
    const recent = new Date(now - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, '+0000')
    h.records = [{ toolName: 'create-meta-ad', after: { adAccountId: '1234567890', items: [{ kind: 'ad', adId: AD, status: 'ACTIVE' }] } }]
    reads[AD] = { id: AD, status: 'PAUSED', adset_id: ADSET, created_time: recent, updated_time: recent, creative: { id: CREATIVE } }
    reads[`${AD}/insights`] = { data: [] }
    const settled = new Date(Date.parse(recent.replace('+0000', 'Z')) + 30 * 60_000).toISOString().slice(11, 16)
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(new RegExp(`created ACTIVE, and Meta's numbers lag up to 15 minutes; try again after ${settled} UTC`))
    h.records = [{ toolName: 'create-meta-ad', after: { adAccountId: '1234567890', items: [{ kind: 'ad', adId: AD, status: 'PAUSED' }] } }]
    reads[AD] = { ...reads[AD], updated_time: new Date(now - 60_000).toISOString().replace(/\.\d{3}Z$/, '+0000') }
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(/changed after it was made, and Meta's numbers lag/)
    // Created PAUSED and never touched: deletable at once.
    reads[AD] = { ...reads[AD], updated_time: recent }
    expect((await preview({ action: 'undo', ads: [AD] })).ok).toBe(true)
  })

  it('undo: the creative stays when another ad uses it; an unreadable spend keeps the ad', async () => {
    h.records = [{ toolName: 'create-meta-ad', after: { adAccountId: '1234567890', items: [{ kind: 'ad', adId: AD }, { kind: 'creative', creativeId: NEW_CREATIVE, adId: AD, new: true }] } }]
    reads[AD] = { id: AD, status: 'PAUSED', adset_id: ADSET, created_time: '2026-10-20T10:00:00+0000', creative: { id: NEW_CREATIVE } }
    reads[`${AD}/insights`] = { data: [] }
    lists[`${ACT}/ads`] = { rows: [{ id: AD, creative: { id: NEW_CREATIVE } }, { id: '120000000000004', creative: { id: NEW_CREATIVE } }], more: false, totalCount: null }
    const p = await preview({ action: 'undo', ads: [AD] })
    expect(p.preview.requests).toHaveLength(1)
    expect(p.preview.skipped.join(' ')).toMatch(/creative 120000000000302 stays: ad 120000000000004 uses it too/)
    h.read.mockImplementation(async (_c: unknown, q: { path: string }) => { if (q.path === `${AD}/insights`) throw new Error('no answer'); return { body: reads[q.path] ?? {}, calls: 1 } })
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(/could not read its numbers \(no answer\), so it cannot confirm/)
    // 2026-10-22 live — Meta's own refusal words reach the answer (never only "could not read").
    h.read.mockImplementation(async (_c: unknown, q: { path: string }) => { if (q.path === `${AD}/insights`) throw new MetaReadError(localFailure('Meta refused the read: (#100) Tried accessing nonexisting field (spend).', 'X'), 'ad.spendRead', 1); return { body: reads[q.path] ?? {}, calls: 1 } })
    expect(await refusal({ action: 'undo', ads: [AD] })).toMatch(/Ad 120000000000\d+ stays: Nexus could not read its numbers \(Meta refused the read: \(#100\) Tried accessing nonexisting field \(spend\)\), so it cannot confirm the ad never ran\./)
  })
})

describe('set-meta-ad', () => {
  const adNow = (over: Record<string, unknown> = {}) => ({ id: AD, name: 'Ad A', status: 'PAUSED', effective_status: 'PAUSED', adset_id: ADSET, campaign_id: CAMPAIGN, creative: { id: CREATIVE }, adlabels: { data: [{ name: 'Spring' }] }, ...over })

  it('renames and swaps the creative in ONE request (Meta has no check for an ad update); the swap goes back to review', async () => {
    reads[AD] = adNow()
    reads[NEW_CREATIVE] = { id: NEW_CREATIVE, status: 'ACTIVE', degrees_of_freedom_spec: { creative_features_spec: {} }, effective_authorization_category: 'NONE' }
    const p = await preview({ adId: AD, name: 'Ad B', creativeId: NEW_CREATIVE }, setAd)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(p.preview.metaCheck.checked).toBe('none')
    expect(p.preview.warnings.join(' ')).toMatch(/creative swap sends the ad back to Meta's review/)
    h.send.mockImplementation(async () => ({ node: { id: AD, name: 'Ad B', status: 'PAUSED', creative: { id: NEW_CREATIVE } }, readBack: 'second-read', waitedMs: 0 }))
    const r = await setAd.execute!(parse(setAd)({ adId: AD, name: 'Ad B', creativeId: NEW_CREATIVE }), approved(p.preview)) as ToolResult & { data: Record<string, any>; change: { before: any; after: any } }
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: AD, kind: 'ad', operation: 'ad.update', params: { name: 'Ad B', creative: JSON.stringify({ creative_id: NEW_CREATIVE }) } })
    expect(r.data.steps[0].sentence).toMatch(/creative_id 120000000000302/)
    expect(r.change.after).toMatchObject({ kind: 'set', adId: AD, name: 'Ad B', creativeId: NEW_CREATIVE })
    const undo = setAd.undo!.request(r.change)
    expect(undo).toMatchObject({ tool: 'set-meta-ad', args: { adId: AD, name: 'Ad A', creativeId: CREATIVE } })
    expect(setAd.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    // Undo reads the ad live: a later rename is never overwritten (the compare-and-swap sees another name).
    reads[AD] = adNow({ name: 'Ad C', creative: { id: NEW_CREATIVE } })
    expect(await setAd.undo!.current!(r.change)).toMatchObject({ name: 'Ad C', creativeId: NEW_CREATIVE })
  })

  it('a Meta read-back that shows another creative is not done', async () => {
    reads[AD] = adNow()
    reads[NEW_CREATIVE] = { id: NEW_CREATIVE, status: 'ACTIVE', effective_authorization_category: 'NONE' }
    const p = await preview({ adId: AD, creativeId: NEW_CREATIVE }, setAd)
    h.send.mockImplementation(async () => ({ node: { id: AD, status: 'PAUSED', creative: { id: CREATIVE } }, readBack: 'second-read', waitedMs: 0 }))
    const r = await setAd.execute!(parse(setAd)({ adId: AD, creativeId: NEW_CREATIVE }), approved(p.preview)) as ToolResult & { error?: string }
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not what was asked \(creative_id\)/)
  })

  it('a creative with a feature generated with AI goes only onto a PAUSED ad; archived ads take only a new name; deleted none', async () => {
    reads[AD] = adNow({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    reads[NEW_CREATIVE] = { id: NEW_CREATIVE, status: 'ACTIVE', degrees_of_freedom_spec: { creative_features_spec: { image_uncrop: { enroll_status: 'OPT_IN' } } } }
    expect(await refusal({ adId: AD, creativeId: NEW_CREATIVE }, setAd)).toMatch(/ad 120000000000003 is ACTIVE, and creative 120000000000302 switches on image_uncrop: create it PAUSED/)
    // Review A2 — onto an ACTIVE ad only a creative that reads OFF for every feature; partly said is refused too.
    reads[NEW_CREATIVE] = { ...reads[NEW_CREATIVE], degrees_of_freedom_spec: { creative_features_spec: { image_uncrop: { enroll_status: 'OPT_OUT' } } } }
    expect(await refusal({ adId: AD, creativeId: NEW_CREATIVE }, setAd)).toMatch(/does not say OPT_OUT/)
    reads[NEW_CREATIVE] = { ...reads[NEW_CREATIVE], degrees_of_freedom_spec: allOff() }
    expect((await preview({ adId: AD, creativeId: NEW_CREATIVE }, setAd)).ok).toBe(true)
    reads[AD] = adNow({ status: 'ARCHIVED' })
    expect(await refusal({ adId: AD, labels: ['X'] }, setAd)).toMatch(/archived: Meta lets only its name/)
    expect((await preview({ adId: AD, name: 'Ad B' }, setAd)).ok).toBe(true)
    reads[AD] = adNow({ status: 'DELETED' })
    expect(await refusal({ adId: AD, name: 'Ad B' }, setAd)).toMatch(/is deleted/)
  })

  it('its own schedule: sales campaigns only; on an ACTIVE ad it SPENDS MONEY; cleared with an empty value; undo puts the old one back', async () => {
    reads[AD] = adNow({ status: 'ACTIVE', effective_status: 'ACTIVE', ad_schedule_end_time: '2030-01-05T07:00:00+0000' })
    const p = await preview({ adId: AD, scheduleStart: '2030-01-02T08:00:00+01:00', clear: ['end'] }, setAd)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(p.preview.spendsMoney).toBe(true)
    expect(p.preview.spendsMoneyBecause[0]).toMatch(/is ACTIVE.*may spend at times it did not before/)
    h.send.mockImplementation(async () => ({ node: { id: AD, status: 'ACTIVE', ad_schedule_start_time: '2030-01-02T07:00:00+0000', creative: { id: CREATIVE } }, readBack: 'second-read', waitedMs: 0 }))
    const r = await setAd.execute!(parse(setAd)({ adId: AD, scheduleStart: '2030-01-02T08:00:00+01:00', clear: ['end'] }), approved(p.preview)) as ToolResult & { change: { before: any; after: any } }
    expect(h.send.mock.calls[0][1].params).toEqual({ ad_schedule_start_time: String(Date.UTC(2030, 0, 2, 7) / 1000), ad_schedule_end_time: '' })
    expect(r.change.after).toMatchObject({ scheduleStart: '2030-01-02T07:00:00.000Z', scheduleEnd: null })
    expect(setAd.undo!.request(r.change)).toMatchObject({ args: { clear: ['start'], scheduleEnd: '2030-01-05T07:00:00.000Z' } })
    expect(isoOf('2030-01-05T07:00:00+0000')).toBe('2030-01-05T07:00:00.000Z')
    reads[CAMPAIGN] = { ...reads[CAMPAIGN], objective: 'OUTCOME_AWARENESS' }
    expect(await refusal({ adId: AD, clear: ['end'] }, setAd)).toMatch(/only available for sales and app promotion campaigns/)
  })

  it('labels: the whole list on the ad, labels added on its labels edge', async () => {
    reads[AD] = adNow()
    const p = await preview({ adId: AD, addLabels: ['Summer'] }, setAd)
    expect(p.preview.requests.map((r: { label: string }) => r.label)).toEqual([`Add label "Summer" to ad ${AD} "Ad A"`])
    const all = await preview({ adId: AD, labels: [] }, setAd)
    expect(all.preview.changes[`Ad ${AD} labels`]).toEqual({ from: 'Spring', to: 'none' })
    expect(await refusal({ adId: AD, labels: ['Spring'] }, setAd)).toMatch(/Nothing to change/)
  })
})

describe('set-meta-ad — review round 1', () => {
  const adNow = (over: Record<string, unknown> = {}) => ({ id: AD, name: 'Ad A', status: 'PAUSED', effective_status: 'PAUSED', adset_id: ADSET, campaign_id: CAMPAIGN, creative: { id: CREATIVE }, adlabels: { data: [{ name: 'Spring' }] }, ...over })

  it('A3: only what Meta made is recorded — a rename done and labels refused leaves no labels in the record; the undo undoes the rename', async () => {
    reads[AD] = adNow()
    const p = await preview({ adId: AD, name: 'Ad B', addLabels: ['Summer'] }, setAd)
    expect(p.preview.requests).toHaveLength(2)
    h.send.mockImplementation(async (_t: unknown, change: { edge?: string }) => {
      if (change.edge === 'adlabels') throw new MetaWriteError({ sentence: 'Meta refused it (100): no.', origin: 'meta', code: '100' } as never, 'ad.addLabels', 'refused')
      return { node: { id: AD, name: 'Ad B', status: 'PAUSED', creative: { id: CREATIVE } }, readBack: 'second-read', waitedMs: 0 }
    })
    const r = await setAd.execute!(parse(setAd)({ adId: AD, name: 'Ad B', addLabels: ['Summer'] }), approved(p.preview)) as ToolResult & { data: Record<string, any>; change: { before: any; after: any } }
    expect(r.data.steps.map((s: { outcome: string }) => s.outcome)).toEqual(['done', 'refused'])
    expect(r.change.after).toMatchObject({ kind: 'set', adId: AD, name: 'Ad B' })
    expect('labels' in r.change.after).toBe(false)
    expect(setAd.undo!.request(r.change)).toEqual({ tool: 'set-meta-ad', args: { connectionId: 'm-1', adId: AD, name: 'Ad A', why: expect.any(String) } })
  })

  it('B2: tracking (own pixels only), the conversion domain (of the creative\'s link) and the persona — set, cleared and put back', async () => {
    reads[AD] = adNow({ status: 'ACTIVE', effective_status: 'ACTIVE', conversion_domain: 'example.com', creative_audience_pairing_persona: { age_min: 18, age_max: 34 } })
    expect(await refusal({ adId: AD, tracking: [{ pixelId: '120000000000999' }] }, setAd)).toMatch(/not one of the chosen ad account's own pixels/)
    expect(await refusal({ adId: AD, conversionDomain: 'example.org' }, setAd)).toMatch(/names no website link on example.org/)
    expect(await refusal({ adId: AD, conversionDomain: 'shop.example.com' }, setAd)).toMatch(/first and second level only/)
    const p = await preview({ adId: AD, tracking: [{ pixelId: PIXEL }], persona: { ageMin: 25, ageMax: 44 }, clear: ['conversionDomain'] }, setAd)
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(p.preview.spendsMoney).toBe(true)
    expect(p.preview.spendsMoneyBecause.join(' ')).toMatch(/its persona changes, so it may reach other people/)
    expect(p.preview.warnings.join(' ')).toMatch(/"were used during ad creation"/)
    h.send.mockImplementation(async () => ({ node: { id: AD, status: 'ACTIVE', creative: { id: CREATIVE } }, readBack: 'second-read', waitedMs: 0 }))
    const r = await setAd.execute!(parse(setAd)({ adId: AD, tracking: [{ pixelId: PIXEL }], persona: { ageMin: 25, ageMax: 44 }, clear: ['conversionDomain'] }), approved(p.preview)) as ToolResult & { change: { before: any; after: any } }
    expect(h.send.mock.calls[0][1].params).toEqual({
      tracking_specs: JSON.stringify([{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]), conversion_domain: '', creative_audience_pairing_persona: '{"age_min":25,"age_max":44}',
    })
    expect(r.change.after).toMatchObject({ tracking: [{ pixelId: PIXEL, action: 'offsite_conversion' }], conversionDomain: null, persona: { ageMin: 25, ageMax: 44 } })
    const undo = setAd.undo!.request(r.change)
    expect(undo).toMatchObject({ args: { conversionDomain: 'example.com', persona: { ageMin: 18, ageMax: 34 }, clear: ['tracking'] } })
    expect(setAd.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    // Tracking that holds specs Nexus does not write is never changed (its undo could not put them back).
    reads[AD] = adNow({ tracking_specs: [{ 'action.type': ['post_engagement'], post: ['1'], page: ['2'] }] })
    expect(await refusal({ adId: AD, tracking: [{ pixelId: PIXEL }] }, setAd)).toMatch(/holds specs Nexus does not write/)
  })

  it('B3: a creative swap under an EU ad set checks its payer and beneficiary (Meta: 3858152 for significantly edited ads)', async () => {
    reads[AD] = adNow()
    reads[NEW_CREATIVE] = { id: NEW_CREATIVE, status: 'ACTIVE', degrees_of_freedom_spec: allOff(), effective_authorization_category: 'NONE' }
    reads[ADSET] = { ...reads[ADSET], dsa_payor: undefined, dsa_beneficiary: undefined }
    expect(await refusal({ adId: AD, creativeId: NEW_CREATIVE }, setAd)).toMatch(/an ad with a new creative there needs who pays for it.*3858152/)
    reads[ACT] = { default_dsa_payor: 'Shop A', default_dsa_beneficiary: 'Shop A' }
    expect((await preview({ adId: AD, creativeId: NEW_CREATIVE }, setAd)).preview.warnings.join(' ')).toMatch(/EU \(DSA\)/)
  })
})

describe('create-meta-ad — catalog parts of an inline creative (CR-211, CR-464, CR-471) through step 18\'s catalog rule', () => {
  const PORTFOLIO = '120000000000090'
  const OTHER_NEXUS = '120000000000081'
  const CATALOG = '120000000000060'
  const FOREIGN_CATALOG = '120000000000063'
  const SET = '120000000000061'
  /** Meta as the catalog rule reads it: the ad account's portfolio, the set's catalog, the catalog's owner. */
  const catalogMeta = (catalog: string, fails = false) => {
    Object.assign(reads, {
      [ACT]: { id: ACT, business: { id: PORTFOLIO } },
      [SET]: { id: SET, product_catalog: { id: catalog } },
      [CATALOG]: { id: CATALOG, business: { id: PORTFOLIO } },
      [FOREIGN_CATALOG]: { id: FOREIGN_CATALOG, business: { id: OTHER_NEXUS } },
      [`${PORTFOLIO}/client_product_catalogs`]: { data: [{ id: FOREIGN_CATALOG }] },
    })
    h.read.mockImplementation(async (_c: unknown, q: { path: string }) => {
      if (fails && q.path === SET) throw new MetaReadError(localFailure('Meta refused it (100): Unsupported get request.', 'X'), 'r', 1)
      return { body: reads[q.path] ?? {}, calls: 1 }
    })
  }
  /** CR-464 — an Advantage+ creative for catalog: template_data and the creative's product set. */
  const template = { name: 'Catalog A', story: { template_data: { link: 'https://www.example.com/', message: '{{product.name}} {{product.price}}', name: '{{product.name}}', call_to_action: { type: 'SHOP_NOW' } } }, parts: { product_set_id: SET } }

  it('the business\'s own catalog passes (every format and the shop opted out); another business\'s, a shared portfolio and an unreadable one are refused before Meta\'s check', async () => {
    catalogMeta(CATALOG)
    const p = await preview({ ...base, creative: template })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    const creative = JSON.parse(checked().params.creative)
    expect(creative.product_set_id).toBe(SET)
    expect(creative.format_transformation_spec).toEqual(['da_collection', 'sa_collection', 'single_media', 'catalog_single_media', 'carousel', 'video_slideshow'].map((format) => ({ format, data_source: ['none'] })))
    expect(creative.destination_spec).toEqual({ destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' })
    expect(p.preview.warnings.join(' ')).toContain(`Catalog: product set ${SET} — each passed the catalog rule`)
    // A catalog creative fully opted out may go ACTIVE too (the activation rule reads every feature OFF).
    expect((await preview({ ...base, creative: template, activate: true })).ok).toBe(true)
    h.check.mockClear()
    catalogMeta(FOREIGN_CATALOG); h.taken.add(OTHER_NEXUS)
    expect(await refusal({ ...base, creative: template })).toMatch(/^Nothing was asked of Meta: product set 120000000000061: That catalog belongs to a business portfolio another business in Nexus uses/)
    catalogMeta(CATALOG); h.taken.clear(); h.taken.add(PORTFOLIO)
    expect(await refusal({ ...base, creative: template })).toMatch(/shared with another business in Nexus.*nothing is sent/)
    h.taken.clear(); catalogMeta(CATALOG, true)
    expect(await refusal({ ...base, creative: template })).toMatch(/could not confirm that this product set is in one of the business's catalogs/)
    expect(h.check).not.toHaveBeenCalled()
  })
})
