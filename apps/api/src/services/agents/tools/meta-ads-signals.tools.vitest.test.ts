/**
 * Meta step 32 — create-meta-dataset, set-meta-dataset, set-meta-dataset-access, set-meta-custom-conversion and
 * remove-meta-signal-items as the approval gate uses them (Meta, the database and the account are
 * stand-ins): the change contract of every Meta change tool; previews from the live state through the ONE ownership rule
 * (a pixel another business uses, or one Nexus cannot check, is never changed); Meta's one-pixel and 100-conversion rules;
 * what Meta cannot do said in words; a run only as a request a person approved, sending exactly what the preview showed;
 * the record a create leaves (and its undo deletes only that one); undo reads live and puts back what was replaced. Every
 * read the tools send passes the real read gate. Made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'conn-1', adAccountId: '1234567890' }, accountId: 'conn-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown>,
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Req[],
  w: {} as Record<string, any>,
  send: vi.fn(),
  check: vi.fn(async () => undefined),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => {
  const { MetaReadError } = await import('../../marketing/meta-ads/errors.js')
  const notFound = () => new MetaReadError({ origin: 'meta', httpStatus: 400, code: '100', authLost: false, throttled: false, permissionDenied: false, notFound: true, sentence: 'Meta says it does not exist.' }, 'test')
  return {
    metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
      h.calls.push(req)
      const w = h.w
      if (req.path.startsWith('act_')) return { body: { business: { id: w.portfolio } }, calls: 1 }
      if (req.query?.fields === 'owner_business{id}') return { body: { owner_business: { id: w.owner[req.path] ?? w.portfolio } }, calls: 1 }
      if (req.operation === 'signals.pixelSettings') return { body: w.settings[req.path] ?? {}, calls: 1 }
      if (req.operation === 'signalsRule.conversion' || req.operation === 'signals.conversion') { const c = w.conversions[req.path]; if (!c) throw notFound(); return { body: c, calls: 1 } }
      if (req.operation === 'signalsRule.group') return { body: w.group[req.path] ?? {}, calls: 1 }
      return { body: {}, calls: 1 }
    }),
    metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
      h.calls.push(req)
      const w = h.w
      const [head, edge] = req.path.split('/')
      const rows: Array<Record<string, unknown>> = edge === 'adspixels' ? w.accountPixels.map((id: string) => ({ id, name: `Pixel ${id}` }))
        : edge === 'shared_agencies' || edge === 'agencies' ? (w.agencies[head] ?? []).map((id: string) => ({ id }))
          : edge === 'shared_accounts' ? (w.accounts[`${head}:${req.query?.business}`] ?? [])
            : edge === 'event_source_groups' ? w.groups.map((id: string) => ({ id }))
              : edge === 'adsets' ? w.adSets
                : edge === 'customconversions' ? Object.entries(w.conversions).map(([id, c]) => ({ id, ...(c as object) }))
                  : []
      onRows(rows)
      return { rows: rows.length, calls: 1, truncated: false }
    }),
  }
})
vi.mock('../../../db.js', () => ({
  default: {
    $queryRaw: vi.fn(async (_sql: unknown, product: string, ids: string[]) => ids.filter((id) => (product === 'PORTFOLIO' ? h.w.takenPortfolios : product === 'AD_ACCOUNT' ? h.w.takenAccounts : new Set()).has(id)).map((id) => ({ id }))),
    agentChange: { findFirst: vi.fn(async ({ where }: { where: { AND: Array<{ after: { path: string[]; equals: unknown } }> } }) => {
      const id = where.AND.find((c) => c.after.path[0] === 'customConversionId')?.after.equals
      return typeof id === 'string' && h.w.nexusMade.has(id) ? { id: 'chg-1' } : null
    }) },
    metaAccountLink: { findFirst: vi.fn(async () => ({ id: 'link-1' })) },
  },
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_SIGNALS_TOOLS } from './meta-ads-signals.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem, metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'
import { DEFAULT_VALUE_UPDATE_HELD, SETUP_CANNOT } from '../../marketing/meta-ads/change-signals.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_SIGNALS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const parse = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>) => (await tool(name).handler(parse(tool(name), args), asker)) as ToolResult & { preview: Record<string, any>; error?: string }
const run = async (name: string, args: Record<string, unknown>, p: unknown) => (await tool(name).execute!(parse(tool(name), args), approved(p))) as ToolResult & { data: Record<string, any>; change?: { before: any; after: any } }
const sent = () => h.send.mock.calls.map(([, change]) => change as { objectId: string; kind: string; params: Record<string, string>; operation: string; edge?: string; method?: string })

const OWN = '1234567890'
const BIZ = '9876543210'
const PIXEL = '120000000000501'
const FREE_ELSEWHERE = '120000000000503'
const CC = '120000000000701'
const GROUP = '120000000000801'
const AD_SET = '120000000000002'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok', token: { checkedAt: null, scopes: [], missing: [] },
  adAccount: { adAccountId: OWN, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: BIZ, statusText: null },
  page: { pageId: '120000000000010', name: 'Shop A' }, instagram: null, read: {},
}
const SETTINGS = { id: PIXEL, name: 'Shop A pixel', enable_automatic_matching: false, automatic_matching_fields: [], first_party_cookie_status: 'FIRST_PARTY_COOKIE_ENABLED', data_use_setting: 'ADVERTISING_AND_ANALYTICS', owner_business: { id: BIZ }, is_unavailable: false }
const ok = (node: Record<string, unknown> | null = null) => ({ node, readBack: node ? 'second-read' : 'none', waitedMs: 0 })

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  h.send.mockReset(); h.check.mockReset()
  h.connections = [structuredClone(CHOSEN)]
  h.calls = []
  h.w = {
    portfolio: BIZ, accountPixels: [PIXEL], owner: {}, accounts: { [`${PIXEL}:${BIZ}`]: [{ account_id: OWN }], [`${FREE_ELSEWHERE}:${BIZ}`]: [] },
    agencies: {}, groups: [GROUP], group: { [GROUP]: { name: 'Group A', event_sources: [{ id: PIXEL }] } },
    settings: { [PIXEL]: structuredClone(SETTINGS), [FREE_ELSEWHERE]: { ...structuredClone(SETTINGS), id: FREE_ELSEWHERE, name: 'Second' } },
    adSets: [{ id: AD_SET, name: 'Ad set B', status: 'ACTIVE', campaign: { status: 'ACTIVE' }, promoted_object: { pixel_id: PIXEL, custom_conversion_id: CC } }],
    conversions: { [CC]: { account_id: `act_${OWN}`, name: 'Thank you page', custom_event_type: 'PURCHASE', default_conversion_value: 10, pixel: { id: PIXEL }, rule: '{"url":{"i_contains":"thank-you"}}', is_unavailable: false } },
    takenPortfolios: new Set(), takenAccounts: new Set(), nexusMade: new Set(),
  }
})

describe('the tools', () => {
  it('each change tool keeps the Meta change contract; nothing that only refuses is a tool', () => {
    const changes = ['create-meta-dataset', 'set-meta-dataset', 'set-meta-dataset-access', 'set-meta-custom-conversion', 'remove-meta-signal-items']
    for (const name of changes) {
      const t = tool(name)
      expect(t, name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising' })
      expect(t.requires, name).toContain('ads.campaigns.manage')
      expect(t.description.endsWith(META_CHANGE_RULES), name).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[name], name).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('create-meta-dataset')).toMatchObject({ reversibility: 'none' })
    expect(tool('create-meta-dataset').undo).toBeUndefined()
    expect(tool('remove-meta-signal-items')).toMatchObject({ reversibility: 'none' })
    expect(tool('remove-meta-signal-items').undo).toBeUndefined()
    for (const name of ['set-meta-dataset', 'set-meta-dataset-access', 'set-meta-custom-conversion']) expect(tool(name)).toMatchObject({ reversibility: 'partial', undo: expect.anything() })
    expect(tool('set-meta-custom-conversion').requires).toEqual(['ads.campaigns.manage', 'financials.adspend.view'])
    expect(tool('set-meta-dataset').consequencesFor!({ eventSourceGroup: { action: 'create' } })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-custom-conversion').consequencesFor!({ action: 'claim' })).toEqual({ reversibility: 'none' })
    expect(META_ADS_SIGNALS_TOOLS.map((t) => t.name)).toEqual(['create-meta-dataset', 'set-meta-dataset', 'set-meta-dataset-access', 'set-meta-custom-conversion', 'remove-meta-signal-items'])
    // Lane C3 decision: only the chosen ad account is connected or disconnected; no partner, server-event or people access.
    expect(tool('set-meta-dataset-access').input.safeParse({ pixelId: PIXEL, action: 'assign-person' }).success).toBe(false)
    expect(tool('set-meta-dataset-access').input.safeParse({ pixelId: PIXEL, action: 'share-with-partner' }).success).toBe(false)
    expect(tool('set-meta-dataset').description).toContain(SETUP_CANNOT)
    expect(tool('set-meta-dataset-access').description).toMatch(/Business settings/)
    // remove-meta-signal-items only on the person's explicit ask.
    expect(() => parse(tool('remove-meta-signal-items'), { items: [{ kind: 'customConversion', id: CC }] })).toThrow()
  })
})

describe('create-meta-dataset', () => {
  it('Meta makes one pixel per ad account: the account has one, so it is refused before anything is queued', async () => {
    const res = await preview('create-meta-dataset', { name: 'Shop A 2' })
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/already has 1 pixel.*6200/) })
  })
  it('none yet: one create on the account\'s edge; the run records the new id; no undo', async () => {
    h.w.accountPixels = []
    const p = await preview('create-meta-dataset', { name: 'Shop A' })
    expect(p.ok).toBe(true)
    expect(p.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none' }, requests: [{ label: expect.stringMatching(/Create the dataset/) }] })
    h.send.mockResolvedValueOnce(ok({ id: '120000000000599', name: 'Shop A' }))
    const r = await run('create-meta-dataset', { name: 'Shop A' }, p.preview)
    expect(r.ok).toBe(true)
    expect(sent()).toMatchObject([{ objectId: `act_${OWN}`, kind: 'adaccount', edge: 'adspixels', params: { name: 'Shop A' }, operation: 'dataset.create' }])
    expect(r.change!.after).toMatchObject({ part: 'dataset', id: '120000000000599', created: true, fields: { exists: 'yes' }, accountId: 'conn-1', adAccountId: OWN })
  })
  it('in the business portfolio — never in one another Nexus business shares', async () => {
    h.w.takenPortfolios.add(BIZ)
    expect(await preview('create-meta-dataset', { level: 'business', name: 'Shop A 2' })).toMatchObject({ ok: false, error: expect.stringMatching(/Another business in Nexus also has an ad account/) })
    h.w.takenPortfolios.clear()
    const p = await preview('create-meta-dataset', { level: 'business', name: 'Shop A 2' })
    expect(p.preview.warnings.join(' ')).toMatch(/SDK/)
  })
})

describe('set-meta-dataset', () => {
  it('a pixel another business in Nexus uses is never changed (its id never named back)', async () => {
    h.w.accounts[`${PIXEL}:${BIZ}`].push({ account_id: '5555555555' })
    h.w.takenAccounts.add('5555555555')
    const res = await preview('set-meta-dataset', { pixelId: PIXEL, name: 'X' })
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/another business in Nexus uses/) })
    expect(res.error).not.toContain('5555555555')
  })
  it('settings from → to, the GDPR sentence, analytics only lists the ad sets; the run sends exactly that; undo reads live', async () => {
    const args = { pixelId: PIXEL, automaticMatching: { enabled: true, fields: ['em', 'ph'] }, dataUse: 'ANALYTICS_ONLY' }
    const p = await preview('set-meta-dataset', args)
    expect(p.ok).toBe(true)
    expect(p.preview.changes).toMatchObject({ 'automatic advanced matching': { from: false, to: 'true' }, 'data use': { from: 'ADVERTISING_AND_ANALYTICS', to: 'ANALYTICS_ONLY' } })
    expect(p.preview.warnings.join(' ')).toMatch(/GDPR.*Ad set B/s)
    h.send.mockResolvedValueOnce(ok({ id: PIXEL, enable_automatic_matching: true, automatic_matching_fields: ['ph', 'em'], data_use_setting: 'ANALYTICS_ONLY' }))
    const r = await run('set-meta-dataset', args, p.preview)
    expect(r.ok).toBe(true)
    expect(sent()[0]).toMatchObject({ objectId: PIXEL, kind: 'pixel', params: { enable_automatic_matching: 'true', automatic_matching_fields: '["em","ph"]', data_use_setting: 'ANALYTICS_ONLY' } })
    // Undo: unchanged since → it asks set-meta-dataset with what was replaced.
    h.w.settings[PIXEL] = { ...SETTINGS, enable_automatic_matching: true, automatic_matching_fields: ['em', 'ph'], data_use_setting: 'ANALYTICS_ONLY' }
    const change = r.change!
    expect(await tool('set-meta-dataset').undo!.current(change)).toEqual(change.after)
    const back = tool('set-meta-dataset').undo!.request(change)
    expect(back).toMatchObject({ tool: 'set-meta-dataset', args: { connectionId: 'conn-1', pixelId: PIXEL, automaticMatching: { enabled: false }, dataUse: 'ADVERTISING_AND_ANALYTICS' } })
    expect(tool('set-meta-dataset').input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('an event source group: create from free pixels only; update of one of the portfolio\'s with its undo', async () => {
    expect(await preview('set-meta-dataset', { eventSourceGroup: { action: 'create', name: 'G', pixelIds: [PIXEL, '120000000000999'] } })).toMatchObject({ ok: false })
    const p = await preview('set-meta-dataset', { eventSourceGroup: { action: 'update', groupId: GROUP, name: 'Group B' } })
    expect(p.ok).toBe(true)
    h.send.mockResolvedValueOnce(ok({ id: GROUP, name: 'Group B' }))
    const r = await run('set-meta-dataset', { eventSourceGroup: { action: 'update', groupId: GROUP, name: 'Group B' } }, p.preview)
    expect(sent()[0]).toMatchObject({ objectId: GROUP, kind: 'eventsourcegroup', params: { name: 'Group B' } })
    const back = tool('set-meta-dataset').undo!.request(r.change!)
    expect(back).toMatchObject({ tool: 'set-meta-dataset', args: { eventSourceGroup: { action: 'update', groupId: GROUP, name: 'Group A' } } })
    expect(tool('set-meta-dataset').input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
})

describe('set-meta-dataset-access', () => {
  it('connect: the chosen ad account only — a pixel of its portfolio not on the account yet; its undo disconnects', async () => {
    h.w.accounts[`${FREE_ELSEWHERE}:${BIZ}`] = []
    const p = await preview('set-meta-dataset-access', { pixelId: FREE_ELSEWHERE, action: 'connect-ad-account' })
    expect(p.ok).toBe(true)
    h.send.mockResolvedValueOnce(ok({ success: true }))
    const r = await run('set-meta-dataset-access', { pixelId: FREE_ELSEWHERE, action: 'connect-ad-account' }, p.preview)
    expect(sent()[0]).toMatchObject({ objectId: FREE_ELSEWHERE, kind: 'pixel', edge: 'shared_accounts', params: { account_id: OWN, business: BIZ } })
    expect(tool('set-meta-dataset-access').undo!.request(r.change!)).toMatchObject({ tool: 'set-meta-dataset-access', args: { pixelId: FREE_ELSEWHERE, action: 'disconnect-ad-account' } })
  })
  it('disconnect lists the ad sets that lose the dataset — also those on a custom conversion of it; it goes as Meta\'s DELETE', async () => {
    // Review A5 — an ad set optimising on a custom conversion of this pixel (not on the pixel itself) counts too.
    h.w.adSets = [{ id: AD_SET, name: 'Ad set B', status: 'ACTIVE', campaign: { status: 'ACTIVE' }, promoted_object: { custom_conversion_id: CC } }]
    const p = await preview('set-meta-dataset-access', { pixelId: PIXEL, action: 'disconnect-ad-account' })
    expect(p.preview.warnings.join(' ')).toMatch(/1 ad set .*Ad set B/)
    h.send.mockResolvedValueOnce(ok({ success: true }))
    await run('set-meta-dataset-access', { pixelId: PIXEL, action: 'disconnect-ad-account' }, p.preview)
    expect(sent()[0]).toMatchObject({ method: 'DELETE', edge: 'shared_accounts', params: { account_id: OWN, business: BIZ } })
  })
  it('connecting a dataset ad sets of the account optimise on is SPENDS MONEY (by the ad set\'s and its campaign\'s status)', async () => {
    h.w.adSets = [{ id: AD_SET, name: 'Ad set B', status: 'ACTIVE', campaign: { status: 'PAUSED' }, promoted_object: { pixel_id: FREE_ELSEWHERE } }]
    const p = await preview('set-meta-dataset-access', { pixelId: FREE_ELSEWHERE, action: 'connect-ad-account' })
    expect(p.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringMatching(/nothing spends yet/)] })
  })
})

describe('set-meta-custom-conversion', () => {
  const rule = { or: [{ url: { i_contains: 'thank-you' } }] }
  it('create: counted against Meta\'s 100 first; the rule fixed for good said; the run records it as Nexus\'s, its undo deletes only it', async () => {
    const args = { name: 'Thanks', pixelId: PIXEL, rule, eventType: 'PURCHASE', defaultValueCents: 1250 }
    const p = await preview('set-meta-custom-conversion', args)
    expect(p.ok).toBe(true)
    expect(p.preview.warnings.join(' ')).toMatch(/never change after it is made.*2 of the 100/s)
    h.send.mockResolvedValueOnce(ok({ id: '120000000000799', is_custom_event_type_predicted: '0' }))
    const r = await run('set-meta-custom-conversion', args, p.preview)
    expect(sent()[0]).toMatchObject({ objectId: `act_${OWN}`, edge: 'customconversions', params: { default_conversion_value: '12.5', rule: '{"or":[{"url":{"i_contains":"thank-you"}}]}' } })
    expect(r.change!.after).toMatchObject({ created: true, customConversionId: '120000000000799', adAccountId: OWN })
    const back = tool('set-meta-custom-conversion').undo!.request(r.change!)
    expect(back).toEqual({ tool: 'remove-meta-signal-items', args: expect.objectContaining({ items: [{ kind: 'customConversion', id: '120000000000799' }], confirmDelete: true }) })
    expect(tool('remove-meta-signal-items').input.safeParse((back as { args: unknown }).args).success).toBe(true)
    // The 101st is refused.
    h.w.conversions = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(120000000000100 + i), { account_id: `act_${OWN}`, name: `C${i}`, custom_event_type: 'LEAD', pixel: { id: PIXEL } }]))
    expect(await preview('set-meta-custom-conversion', args)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 100/) })
  })
  it('a rule outside Meta\'s operators is refused by the argument itself', () => {
    expect(tool('set-meta-custom-conversion').input.safeParse({ name: 'X', pixelId: PIXEL, rule: { url: { is_any: ['a'] } }, eventType: 'PURCHASE' }).success).toBe(false)
  })
  it('review B1 — an update never sends a default value (its read-back unit is not documented); a name change and its undo', async () => {
    expect(await preview('set-meta-custom-conversion', { action: 'update', customConversionId: CC, defaultValueCents: 2000 })).toMatchObject({ ok: false, error: DEFAULT_VALUE_UPDATE_HELD })
    const args = { action: 'update', customConversionId: CC, name: 'Thanks' }
    const p = await preview('set-meta-custom-conversion', args)
    expect(p.preview.spendsMoney).toBe(false)
    h.send.mockResolvedValueOnce(ok({ id: CC, name: 'Thanks' }))
    const r = await run('set-meta-custom-conversion', args, p.preview)
    expect(sent()[0]).toMatchObject({ objectId: CC, kind: 'customconversion', params: { name: 'Thanks' } })
    const back = tool('set-meta-custom-conversion').undo!.request(r.change!)
    expect(back).toMatchObject({ tool: 'set-meta-custom-conversion', args: { action: 'update', customConversionId: CC, name: 'Thank you page' } })
    expect(tool('set-meta-custom-conversion').input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('review B2 — a claim reads the conversion\'s portfolio: already the chosen one\'s = nothing to change; another\'s = refused', async () => {
    h.w.conversions[CC].business = { id: BIZ }
    expect(await preview('set-meta-custom-conversion', { action: 'claim', customConversionId: CC })).toMatchObject({ ok: false, error: expect.stringMatching(/Nothing to change/) })
    h.w.conversions[CC].business = { id: '1111111111' }
    expect(await preview('set-meta-custom-conversion', { action: 'claim', customConversionId: CC })).toMatchObject({ ok: false, error: expect.stringMatching(/another business portfolio/) })
    delete h.w.conversions[CC].business
    expect((await preview('set-meta-custom-conversion', { action: 'claim', customConversionId: CC })).ok).toBe(true)
  })
})

describe('remove-meta-signal-items', () => {
  it('delete: only a custom conversion Nexus made; an event rule answers that Meta cannot; the run sends one DELETE', async () => {
    const args = { items: [{ kind: 'customConversion', id: CC }, { kind: 'eventRule', id: '120000000000901' }], confirmDelete: true }
    expect(await preview('remove-meta-signal-items', args)).toMatchObject({ ok: false, error: expect.stringMatching(/deletes only a custom conversion it made itself/) })
    h.w.nexusMade.add(CC)
    const p = await preview('remove-meta-signal-items', args)
    expect(p.preview.skipped[0]).toContain('Meta cannot change this by API')
    expect(p.preview.warnings.join(' ')).toMatch(/Ad set B/)
    h.send.mockResolvedValueOnce(ok({ success: true }))
    const r = await run('remove-meta-signal-items', args, p.preview)
    expect(r.ok).toBe(true)
    expect(sent()).toMatchObject([{ objectId: CC, kind: 'customconversion', method: 'DELETE', params: {} }])
    expect(await preview('remove-meta-signal-items', { items: [{ kind: 'parameterExtractor', id: '1' }], confirmDelete: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Meta cannot change this by API/) })
  })
})

describe('the gates the tools stand behind', () => {
  it('every read the tools send passes the real read gate; every request they build passes the real write allow-list', async () => {
    h.w.accountPixels = [PIXEL]
    h.w.nexusMade.add(CC)
    await preview('set-meta-dataset', { pixelId: PIXEL, dataUse: 'ANALYTICS_ONLY' })
    await preview('set-meta-dataset-access', { pixelId: PIXEL, action: 'disconnect-ad-account' })
    await preview('set-meta-custom-conversion', { action: 'update', customConversionId: CC, name: 'New' })
    await preview('remove-meta-signal-items', { items: [{ kind: 'customConversion', id: CC }], confirmDelete: true })
    const refused = h.calls.map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, p]) => p)
    expect(refused).toEqual([])
    // What the runs above sent, judged by the gateway's own verdict.
    h.send.mockResolvedValue(ok({ success: true }))
    const cases: Array<[string, Record<string, unknown>]> = [
      ['set-meta-dataset', { pixelId: PIXEL, name: 'Renamed', firstPartyCookieStatus: 'FIRST_PARTY_COOKIE_DISABLED' }],
      ['set-meta-dataset-access', { pixelId: PIXEL, action: 'disconnect-ad-account' }],
      ['set-meta-custom-conversion', { action: 'update', customConversionId: CC, name: 'Renamed', description: 'Thanks page' }],
      ['set-meta-custom-conversion', { name: 'Thanks', pixelId: PIXEL, rule: { and: [{ event: { eq: 'Purchase' } }, { value: { gt: 100 } }] }, eventType: 'PURCHASE', description: 'Big orders' }],
      ['remove-meta-signal-items', { items: [{ kind: 'customConversion', id: CC }], confirmDelete: true }],
    ]
    for (const [name, args] of cases) {
      h.send.mockClear()
      const p = await preview(name, args)
      expect(p.ok, `${name}: ${p.error}`).toBe(true)
      await run(name, args, p.preview)
      for (const change of sent()) {
        const path = change.edge ? `${change.objectId}/${change.edge}` : change.objectId
        const body = change.method === 'DELETE' && !Object.keys(change.params).length ? undefined : new URLSearchParams(change.params).toString()
        const v = metaWriteVerdict({ method: change.method ?? 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${path}`, kind: 'write', body, objectKind: change.kind })
        expect('write' in v ? v.write.rule : v.problem, `${name} → ${change.operation}`).not.toMatch(/ /)
      }
    }
  })
})
