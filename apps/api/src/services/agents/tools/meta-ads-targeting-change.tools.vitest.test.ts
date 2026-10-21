/**
 * Meta step 20 — set-meta-targeting, set-meta-placements and set-meta-account-controls as the approval gate uses them
 * (Meta, the account and the live reads are stand-ins; the drafts, the kit and the registration are real): each is a change
 * a person always approves; Meta has no check for any (said, never asked); the preview shows Meta's estimate before → after
 * and checks the options it adds, never on a re-check or a run; reaching more people on an ad set that is on is SPENDS
 * MONEY; a run happens only as an approved request, judged by its own read-back; undo asks for the old values through a
 * tool that parses them, and sees what moved since. Made-up ids and names only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TARGETING = { geo_locations: { countries: ['US'] }, age_min: 18, targeting_automation: { advantage_audience: 0 }, publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'], instagram_positions: ['stream'] }
const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  adSet: null as Record<string, unknown> | null,
  soft: null as Record<string, unknown> | null,
  controls: null as Record<string, unknown> | null,
  page: '120000000000010' as string | null,
  delivering: true as boolean | null,
  send: vi.fn(),
  check: vi.fn(async () => ({ recommendations: [] })),
  targetingCheck: vi.fn(),
  changes: {} as Record<string, { toolName: string; before: unknown; after: unknown; undoneAt: Date | null; undoneByApprovalId?: string | null }>,
}))
vi.mock('../../../db.js', () => ({
  default: {
    agentChange: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; toolName: string } }) => {
        const row = h.changes[where.id]
        return row && row.toolName === where.toolName ? { before: row.before, after: row.after, undoneAt: row.undoneAt, undoneByApprovalId: row.undoneByApprovalId ?? null } : null
      }),
    },
  },
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-targeting-change.js', async () => {
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  return {
    liveTargetingAdSet: vi.fn(async (_a: unknown, id: string, opts: { softOptOut?: boolean } = {}) => {
      if (!h.adSet) throw new MetaLiveRefusal(`Ad set ${id} does not belong to the ad account this business chose, so Nexus changes nothing on it.`)
      return { ...structuredClone(h.adSet), ...(opts.softOptOut ? { softOptOut: structuredClone(h.soft) } : {}) }
    }),
    liveSoftOptOut: vi.fn(async () => structuredClone(h.soft)),
    liveAccountControls: vi.fn(async () => structuredClone(h.controls)),
  }
})
vi.mock('../../marketing/meta-ads/live-create.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-create.js')>()),
  liveDsaDefaults: vi.fn(async () => null),
  liveChosenPage: vi.fn(async () => h.page),
  liveWhatsAppMarketing: vi.fn(async () => ({ status: 'MARKETING_MESSAGE_NOT_ONBOARDED' })),
}))
vi.mock('../../marketing/meta-ads/live-brand-safety.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-brand-safety.js')>()),
  accountDelivering: vi.fn(async () => h.delivering),
}))
vi.mock('../../marketing/meta-ads/live-targeting.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-targeting.js')>()),
  targetingCheck: h.targetingCheck,
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { estimateSpecOf, META_ADS_TARGETING_CHANGE_TOOLS } from './meta-ads-targeting-change.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import { listTools } from '../tool-registry.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_TARGETING_CHANGE_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(ask(name, args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (name: string, args: Record<string, unknown>) => {
  const p = await preview(name, args)
  expect(p.ok, p.error).toBe(true)
  return (await tool(name).execute!(ask(name, args), approved(p.preview))) as ToolResult & { data: Record<string, any> }
}
const AD_SET = { id: '120000000000002', name: 'Ad set B', status: 'ACTIVE', optimizationGoal: 'OFFSITE_CONVERSIONS', destinationType: 'WEBSITE', dsaPayor: null, dsaBeneficiary: null, campaign: { id: '120000000000001', name: 'Campaign A', status: 'ACTIVE', objective: 'OUTCOME_SALES', specialAdCategories: [], advantageState: 'DISABLED' }, targeting: TARGETING }
const CONTROLS = { exists: true, status: 'ACTIVE', perObjective: null, audience: { age_min: 21, geo_locations: { countries: ['US'] } }, placement: null }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.send.mockReset(); h.check.mockClear(); h.targetingCheck.mockReset()
  h.targetingCheck.mockImplementation(async (input: { check: string }) => (input.check === 'delivery'
    ? { before: { estimateMauLowerBound: 1000, estimateMauUpperBound: 1200 }, after: { estimateMauLowerBound: 2000, estimateMauUpperBound: 2400 } }
    : input.check === 'options' ? { items: [{ id: '6003000000009', valid: false }] } : { retiring: 0, items: [] }))
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.adSet = structuredClone(AD_SET)
  h.soft = null
  h.controls = structuredClone(CONTROLS)
  h.page = '120000000000010'
  h.delivering = true
  h.changes = {}
})
/** The record of a run as Nexus keeps it (its id: undo-change passes it as undoOf). */
const keep = (toolName: string, change: { before: unknown; after: unknown }, id = 'chg-1') => { h.changes[id] = { toolName, before: change.before, after: change.after, undoneAt: null }; return { ...change, id } }

describe('the tools', () => {
  it('each is a change a person always approves (ask ceiling, open world, high risk), registered for the re-check and in the registry, with its undo', () => {
    const names = new Set(listTools().map((t) => t.name))
    for (const t of META_ADS_TARGETING_CHANGE_TOOLS) {
      expect(t, t.name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, requires: ['ads.campaigns.manage'], category: 'advertising' })
      expect(t.description.endsWith(META_CHANGE_RULES), t.name).toBe(true)
      expect(t.description, t.name).toMatch(/Meta documents no check for this change/)
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.undo, t.name).toBeDefined()
      expect(names.has(t.name), t.name).toBe(true)
    }
    expect(tool('set-meta-targeting').consequencesFor!({ createPlacePageSet: { name: 'Stores A' } })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-targeting').consequencesFor!({ adSets: [{ adSetId: '1', ageMin: 21 }] })).toEqual({ reversibility: 'full' })
    expect(() => tool('set-meta-targeting').input.parse({ adSets: Array.from({ length: 4 }, (_, i) => ({ adSetId: String(i + 1), ageMin: 21 })) })).toThrow()
    expect(() => tool('set-meta-placements').input.parse({ adSets: [{ adSetId: '1', instagramPositions: ['explore'] }] })).toThrow()
    expect(() => tool('set-meta-account-controls').input.parse({ placementExclusions: ['INSTAGRAM_STORIES'] })).toThrow()
  })
})

describe('set-meta-targeting', () => {
  it('the preview: built from the live state, Meta never asked to check; Meta\'s estimate before → after and its option check said; wider is SPENDS MONEY', async () => {
    const p = await preview('set-meta-targeting', { adSets: [{ adSetId: AD_SET.id, locations: { add: { countries: ['CA'] } }, detailedTargeting: [{ interests: ['6003000000009'] }] }] })
    expect(p.ok, p.error).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(p.preview).toMatchObject({ spendsMoney: true, metaCheck: { checked: 'none', sentence: expect.stringMatching(/^Meta has no check for this change/) }, requests: [{ step: 1, metaCheck: 'no-check' }] })
    const words = p.preview.warnings.join(' ')
    expect(words).toMatch(/Meta's estimate for ad set "Ad set B" \(120000000000002\): about 1,000–1,200 monthly active people now; about 2,000–2,400 with this change/)
    expect(words).toMatch(/Meta's check says 6003000000009 is not usable/)
    const delivery = h.targetingCheck.mock.calls.find(([i]) => i.check === 'delivery')![0]
    expect(delivery).toMatchObject({ connectionId: 'm-1', adSetId: AD_SET.id, targeting: { geo_locations: { countries: ['US', 'CA'] }, flexible_spec: [{ interests: [{ id: '6003000000009' }] }] } })
  })
  it('the re-check and the run read the live state again but never ask Meta\'s estimate twice', async () => {
    h.send.mockImplementation(async (_t: unknown, change: { params: { targeting: string } }) => ({ node: { id: AD_SET.id, targeting: { ...JSON.parse(change.params.targeting), geo_locations: { countries: ['US', 'CA'], location_types: ['home', 'recent'] } } }, readBack: 'second-read', waitedMs: 0 }))
    const args = { adSets: [{ adSetId: AD_SET.id, locations: { add: { countries: ['CA'] } } }] }
    const p = await preview('set-meta-targeting', args)
    const calls = h.targetingCheck.mock.calls.length
    expect((await preview('set-meta-targeting', args, approved(p.preview))).ok).toBe(true)
    const ran = (await tool('set-meta-targeting').execute!(ask('set-meta-targeting', args), approved(p.preview))) as ToolResult & { data: Record<string, any> }
    expect(ran.ok, ran.error).toBe(true)
    expect(h.targetingCheck.mock.calls.length).toBe(calls)
    const [, change] = h.send.mock.calls[0]
    expect(change).toMatchObject({ objectId: AD_SET.id, kind: 'adsetaudience', operation: 'adset.targeting', readBackFields: 'id,targeting' })
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/Meta made it; it now reads geo_locations countries US, CA/) })
    expect(ran.change).toMatchObject({ before: { adSets: [{ id: AD_SET.id, keys: { geo_locations: { countries: ['US'] } } }], accountId: 'm-1', adAccountId: '1234567890' }, after: { adSets: [{ id: AD_SET.id, keys: { geo_locations: { countries: ['CA', 'US'] } } }] } })
  })
  it('undo: sees what moved since; asks for the old keys through set-meta-targeting, which parses them', async () => {
    h.send.mockImplementation(async (_t: unknown, change: { params: { targeting: string } }) => ({ node: { id: AD_SET.id, targeting: JSON.parse(change.params.targeting) }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-targeting', { adSets: [{ adSetId: AD_SET.id, ageMin: 25, genders: 'women' }] })
    expect(ran.ok, ran.error).toBe(true)
    h.adSet = { ...AD_SET, targeting: { ...TARGETING, age_min: 25, genders: [2] } }
    expect(await tool('set-meta-targeting').undo!.current(ran.change!)).toEqual(ran.change!.after)
    h.adSet = { ...AD_SET, targeting: { ...TARGETING, age_min: 30, genders: [2] } }
    expect(await tool('set-meta-targeting').undo!.current(ran.change!)).not.toEqual(ran.change!.after)
    const change = keep('set-meta-targeting', ran.change!)
    const back = tool('set-meta-targeting').undo!.request(change)
    // Review A1 — the record's id only: the tool reads the old values from that record itself.
    expect(back).toEqual({ tool: 'set-meta-targeting', args: { connectionId: 'm-1', undo: true, undoOf: 'chg-1', why: expect.any(String) } })
    const args = tool('set-meta-targeting').input.parse((back as { args: unknown }).args) as Record<string, unknown>
    h.adSet = { ...AD_SET, targeting: { ...TARGETING, age_min: 25, genders: [2] } }
    const p = (await tool('set-meta-targeting').handler(args, asker)) as ToolResult & { preview: Record<string, any> }
    expect(p.ok, p.error).toBe(true)
    expect(p.preview.changes).toMatchObject({ 'ad set "Ad set B" (120000000000002): age_min': { from: '25', to: '18' }, 'ad set "Ad set B" (120000000000002): genders': { from: 'women', to: 'not set (everyone)' } })
    // Re-review 2 — the undo RUNS only as the request undo-change tied to that change (its "moved since" and "already
    // waiting" checks made; the change marked undone after it). A direct call with undo + undoOf is not run.
    h.send.mockClear()
    const direct = await tool('set-meta-targeting').execute!(args, approved(p.preview))
    expect(direct).toMatchObject({ ok: false, error: expect.stringMatching(/^Not run: an undo runs through undo-change/) })
    expect(h.send).not.toHaveBeenCalled()
    h.changes['chg-1'].undoneByApprovalId = 'ap-1'
    expect((await tool('set-meta-targeting').execute!(args, approved(p.preview))).ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    h.changes['chg-1'].undoneByApprovalId = null
    // Refused: no record id, a record of another tool or account, one undone already, anything else named with it.
    expect(await tool('set-meta-targeting').handler({ undo: true }, asker)).toEqual({ ok: false, error: expect.stringMatching(/undo-change asks for it with undoOf/) })
    h.changes['chg-2'] = { ...h.changes['chg-1'], toolName: 'set-meta-placements' }
    expect(await tool('set-meta-targeting').handler({ undo: true, undoOf: 'chg-2' }, asker)).toEqual({ ok: false, error: expect.stringMatching(/not a set-meta-targeting change of this business/) })
    h.changes['chg-3'] = { ...h.changes['chg-1'], after: { ...(h.changes['chg-1'].after as object), adAccountId: '5555555555' } }
    expect(await tool('set-meta-targeting').handler({ undo: true, undoOf: 'chg-3' }, asker)).toEqual({ ok: false, error: expect.stringMatching(/another Meta ad account/) })
    h.changes['chg-1'].undoneAt = new Date()
    expect(await tool('set-meta-targeting').handler({ undo: true, undoOf: 'chg-1' }, asker)).toEqual({ ok: false, error: expect.stringMatching(/undone already/) })
    expect(await tool('set-meta-targeting').handler({ undo: true, undoOf: 'chg-1', adSets: [{ adSetId: AD_SET.id, ageMin: 30 }] }, asker)).toEqual({ ok: false, error: expect.stringMatching(/takes nothing else/) })
  })
  it('review A1 — a "restore" with a caller\'s values is refused (only an undo\'s record is put back); the schema has none', async () => {
    const raw = { adSets: [{ adSetId: AD_SET.id, restore: { geo_locations: { cities: [{ key: '2420605', country: 'US' }] } } }] }
    expect(await tool('set-meta-targeting').handler(raw, asker)).toEqual({ ok: false, error: expect.stringMatching(/takes no values to put back from a caller/) })
    expect(await tool('set-meta-placements').handler({ adSets: [{ adSetId: AD_SET.id, restoreSoftOptOut: null }] }, asker)).toEqual({ ok: false, error: expect.stringMatching(/takes no values to put back/) })
    expect(await tool('set-meta-account-controls').handler({ restore: { audienceControls: { age_min: 13 } } }, asker)).toEqual({ ok: false, error: expect.stringMatching(/takes no values to put back/) })
    // Parsed by the tool's own schema, a restore is not even an argument.
    expect((tool('set-meta-targeting').input.parse(raw) as { adSets: Array<Record<string, unknown>> }).adSets[0]).not.toHaveProperty('restore')
    expect(h.send).not.toHaveBeenCalled()
  })
  it('review B2 — a pin added reads back with Meta\'s own fields (country, key, ids): done, recorded, and undone', async () => {
    h.send.mockImplementation(async (_t: unknown, change: { params: { targeting: string } }) => {
      const t = JSON.parse(change.params.targeting)
      return { node: { id: AD_SET.id, targeting: { ...t, geo_locations: { countries: ['US'], custom_locations: [{ latitude: 40.712799, longitude: -74.006, radius: 5, distance_unit: 'kilometer', key: 'custom:1', country: 'US', primary_city_id: 2490299, region_id: 3875, name: 'Pin A' }], location_types: ['home', 'recent'] } } }, readBack: 'second-read', waitedMs: 0 }
    })
    // A new pin is a place Nexus cannot put in a country: it counts as the EU (the ad set has its payer and beneficiary).
    h.adSet = { ...AD_SET, dsaPayor: 'Shop A', dsaBeneficiary: 'Shop A' }
    const ran = await run('set-meta-targeting', { adSets: [{ adSetId: AD_SET.id, locations: { add: { customLocations: [{ latitude: 40.7128, longitude: -74.006, radius: 5 }] } } }] })
    expect(ran.ok, ran.error).toBe(true)
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done' })
    const change = keep('set-meta-targeting', ran.change!)
    expect(change.before).toMatchObject({ adSets: [{ keys: { geo_locations: { countries: ['US'] } } }] })
    expect(tool('set-meta-targeting').undo!.request(change)).toMatchObject({ tool: 'set-meta-targeting', args: { undo: true, undoOf: 'chg-1' } })
  })
  it('a place page set: under the chosen Page, its id recorded; undo says Meta has no delete', async () => {
    h.send.mockImplementation(async () => ({ node: { id: '120000000000091', name: 'Stores A' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-targeting', { createPlacePageSet: { name: 'Stores A' } })
    expect(ran.ok, ran.error).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ kind: 'adaccount', objectId: 'act_1234567890', edge: 'ad_place_page_sets', params: { name: 'Stores A', parent_page: '120000000000010' } })
    expect(ran.change!.after).toMatchObject({ placePageSet: { id: '120000000000091', name: 'Stores A' } })
    expect(tool('set-meta-targeting').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/no delete of a place page set/) })
    expect(await preview('set-meta-targeting', { createPlacePageSet: { name: 'Stores A' }, adSets: [{ adSetId: AD_SET.id, ageMin: 21 }] })).toEqual({ ok: false, error: expect.stringMatching(/one of them/) })
  })
  it('refused in words: an ad set of another account; not run without a person\'s approval', async () => {
    h.adSet = null
    expect(await preview('set-meta-targeting', { adSets: [{ adSetId: AD_SET.id, ageMin: 21 }] })).toEqual({ ok: false, error: expect.stringMatching(/does not belong to the ad account/) })
    h.adSet = structuredClone(AD_SET)
    const p = await preview('set-meta-targeting', { adSets: [{ adSetId: AD_SET.id, ageMin: 21 }] })
    const auto = await tool('set-meta-targeting').execute!(ask('set-meta-targeting', { adSets: [{ adSetId: AD_SET.id, ageMin: 21 }] }), { ...approved(p.preview), decidedVia: 'auto' })
    expect(auto.ok).toBe(false)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('the estimate takes step 9\'s spec shape; what it cannot carry is said, not estimated', () => {
    expect(estimateSpecOf({ geo_locations: { countries: ['US'], cities: [{ key: '1', name: 'X', radius: '20', distance_unit: 'kilometer' }], location_types: ['home'] }, interests: [{ id: '6', name: 'A' }] }))
      .toEqual({ spec: { geo_locations: { countries: ['US'], cities: [{ key: '1', radius: 20, distance_unit: 'kilometer' }] }, interests: [{ id: '6' }] } })
    expect(estimateSpecOf({ geo_locations: { countries: ['US'] }, product_audience_specs: [] })).toEqual({ cannot: ['product_audience_specs'] })
  })
})

describe('set-meta-placements', () => {
  it('Advantage+ placements: SPENDS MONEY on an ad set that is on; the run sends the placement kind; undo puts the platforms back', async () => {
    h.send.mockImplementation(async (_t: unknown, change: { params: { targeting: string } }) => ({ node: { id: AD_SET.id, targeting: JSON.parse(change.params.targeting) }, readBack: 'second-read', waitedMs: 0 }))
    const p = await preview('set-meta-placements', { adSets: [{ adSetId: AD_SET.id, advantagePlacements: true }] })
    expect(p.preview.spendsMoney).toBe(true)
    const ran = await run('set-meta-placements', { adSets: [{ adSetId: AD_SET.id, advantagePlacements: true }] })
    expect(ran.ok, ran.error).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ kind: 'adsetplacement', operation: 'adset.placements' })
    const change = keep('set-meta-placements', ran.change!)
    const back = tool('set-meta-placements').undo!.request(change)
    expect(back).toMatchObject({ tool: 'set-meta-placements', args: { undo: true, undoOf: 'chg-1' } })
    const args = tool('set-meta-placements').input.parse((back as { args: unknown }).args) as Record<string, unknown>
    h.adSet = { ...AD_SET, targeting: { geo_locations: { countries: ['US'] }, age_min: 18, targeting_automation: { advantage_audience: 0 } } }
    const undone = (await tool('set-meta-placements').handler(args, asker)) as ToolResult & { preview: Record<string, any> }
    expect(undone.ok, undone.error).toBe(true)
    expect(undone.preview.requests).toHaveLength(1)
    expect(await tool('set-meta-placements').execute!(args, approved(undone.preview))).toMatchObject({ ok: false, error: expect.stringMatching(/undo runs through undo-change/) })
  })
})

describe('set-meta-account-controls', () => {
  it('the controls go whole; a lower minimum age while a campaign delivers is SPENDS MONEY; undo posts the old whole controls', async () => {
    h.send.mockImplementation(async (_t: unknown, change: { params: { audience_controls: string } }) => ({ node: { data: [{ audience_controls: JSON.parse(change.params.audience_controls), status: 'ACTIVE' }] }, readBack: 'second-read', waitedMs: 0 }))
    const p = await preview('set-meta-account-controls', { ageMin: 18 })
    expect(p.preview.spendsMoney).toBe(true)
    const ran = await run('set-meta-account-controls', { ageMin: 18 })
    expect(ran.ok, ran.error).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ kind: 'adaccount', objectId: 'act_1234567890', edge: 'account_controls', params: { audience_controls: '{"age_min":18,"geo_locations":{"countries":["US"]}}' } })
    h.controls = { ...CONTROLS, audience: { age_min: 18, geo_locations: { countries: ['US'] } } }
    expect(await tool('set-meta-account-controls').undo!.current(ran.change!)).toEqual(ran.change!.after)
    const change = keep('set-meta-account-controls', ran.change!)
    const back = tool('set-meta-account-controls').undo!.request(change)
    expect(back).toMatchObject({ tool: 'set-meta-account-controls', args: { undo: true, undoOf: 'chg-1' } })
    const args = tool('set-meta-account-controls').input.parse((back as { args: unknown }).args) as Record<string, unknown>
    const undone = (await tool('set-meta-account-controls').handler(args, asker)) as ToolResult & { preview: Record<string, any> }
    expect(undone.ok, undone.error).toBe(true)
    expect(undone.preview.changes['minimum age (every campaign)']).toEqual({ from: 18, to: 21 })
    expect(await tool('set-meta-account-controls').execute!(args, approved(undone.preview))).toMatchObject({ ok: false, error: expect.stringMatching(/undo runs through undo-change/) })
  })
})
