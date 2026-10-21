/**
 * Meta step 34 review B1 — what uses a catalog or set: the chosen ad account's campaigns and ad sets whose promoted object
 * names the catalog or a set, and its ads whose creative names a set; a list cut at 500 rows or refused by Meta is said
 * (unseen = unknown, which the drafts count as spending). And Nexus's own system user: the stored id, else `me`.
 * Made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ lists: new Map<string, unknown>(), me: null as unknown }))
vi.mock('./paging.js', async (importActual) => ({
  ...(await importActual<typeof import('./paging.js')>()),
  listPaged: vi.fn(async (_c: string, _o: string, path: string) => {
    const v = h.lists.get(path)
    if (v instanceof Error) throw v
    return v ?? { rows: [], more: false, totalCount: null }
  }),
}))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, input: { path: string }) => {
    if (input.path === 'me' && h.me instanceof Error) throw h.me
    return { body: input.path === 'me' ? h.me : {}, calls: 1 }
  }),
  metaReadAll: vi.fn(),
}))

import { AUDIENCES_UNSEEN, liveCatalogUsers, liveNexusSystemUser, SDK_SET_FIELDS_UNSEEN } from './live-catalog-admin.js'
import { MetaReadError, localFailure } from './errors.js'
import type { MetaChosenAccount } from './live.js'

const account = { connectionId: 'm-1', adAccountId: '1234567890', connection: { systemUser: null } } as unknown as MetaChosenAccount
const CATALOG = '120000000000100'
const SET = '120000000000110'

beforeEach(() => { h.lists = new Map(); h.me = null })

describe('liveCatalogUsers', () => {
  it('campaigns and ad sets by their promoted object, ads by their creative\'s set', async () => {
    h.lists.set('act_1234567890/campaigns', { rows: [
      { id: '120000000000010', name: 'Campaign A', effective_status: 'ACTIVE', promoted_object: { product_catalog_id: CATALOG } },
      { id: '120000000000011', name: 'Campaign B', effective_status: 'ACTIVE', promoted_object: { product_catalog_id: '120000000000199' } },
    ], more: false })
    h.lists.set('act_1234567890/adsets', { rows: [{ id: '120000000000002', name: 'Ad set B', effective_status: 'PAUSED', promoted_object: { product_set_id: SET } }], more: false })
    h.lists.set('act_1234567890/ads', { rows: [
      { id: '120000000000020', name: 'Ad A', adset_id: '120000000000003', effective_status: 'ACTIVE', creative: { product_set_id: SET } },
      { id: '120000000000021', name: 'Ad B', adset_id: '120000000000003', effective_status: 'ACTIVE', creative: { id: '9' } },
    ], more: false })
    const byCatalog = await liveCatalogUsers(account, { catalogId: CATALOG, setIds: [SET] })
    expect(byCatalog.users.map((u) => `${u.kind}:${u.id}:${u.uses}`)).toEqual([
      'campaign:120000000000010:catalog 120000000000100', `adset:120000000000002:product set ${SET}`, `ad:120000000000020:product set ${SET}`,
    ])
    expect(byCatalog.unseen).toEqual([])
    // A set alone: the catalog-level campaign is not counted, the ad whose creative names the set is.
    const bySet = await liveCatalogUsers(account, { setIds: [SET] })
    expect(bySet.users.map((u) => u.id)).toEqual(['120000000000002', '120000000000020'])
  })
  it('a list cut at 500 rows, a list Meta refused, more sets than read: each is said (unseen)', async () => {
    h.lists.set('act_1234567890/ads', { rows: [], more: true })
    h.lists.set('act_1234567890/campaigns', new MetaReadError(localFailure('Meta refused the field promoted_object.', 'X'), 'x', 1))
    const read = await liveCatalogUsers(account, { catalogId: CATALOG, setIds: [SET], setsMore: true })
    expect(read.unseen).toEqual([
      'the catalog has more product sets than Nexus read (500): ads on the others were not checked',
      'the ad account\'s campaigns (Meta refused the field promoted_object.)',
      'more than 500 ads of the ad account (Nexus read the first 500)',
    ])
  })
})

describe('review N1 — sets named in targeting and as a boosted set; audiences Nexus cannot trace', () => {
  it('an ad set\'s product audiences (included and excluded) and a boosted set name the set', async () => {
    h.lists.set('act_1234567890/adsets', { rows: [
      { id: '120000000000002', name: 'A', effective_status: 'ACTIVE', targeting: { product_audience_specs: [{ product_set_id: SET, inclusions: [{ retention_seconds: 86400, rule: '{}' }] }] } },
      { id: '120000000000003', name: 'B', effective_status: 'PAUSED', targeting: { excluded_product_audience_specs: [{ product_set_id: SET }] } },
      { id: '120000000000004', name: 'C', effective_status: 'ACTIVE', promoted_object: { product_catalog_id: '120000000000199', boosted_product_set_id: SET } },
      { id: '120000000000005', name: 'D', effective_status: 'ACTIVE', targeting: { product_audience_specs: [{ product_set_id: '120000000000119' }] } },
    ], more: false })
    h.lists.set('act_1234567890/campaigns', { rows: [{ id: '120000000000010', name: 'E', effective_status: 'ACTIVE', promoted_object: { boosted_product_set_id: SET } }], more: false })
    const read = await liveCatalogUsers(account, { setIds: [SET] })
    expect(read.users.map((u) => `${u.kind}:${u.id}`)).toEqual(['campaign:120000000000010', 'adset:120000000000002', 'adset:120000000000003', 'adset:120000000000004'])
    expect(read.unseen).toEqual([])
  })
  it('an ad set delivering now with custom or dynamic audiences adds one fixed unseen line (a paused one does not); a set delete adds the SDK-only places', async () => {
    h.lists.set('act_1234567890/adsets', { rows: [{ id: '120000000000002', name: 'A', effective_status: 'PAUSED', targeting: { custom_audiences: [{ id: '120000000000300', name: 'X' }], dynamic_audience_ids: ['120000000000301'] } }], more: false })
    expect((await liveCatalogUsers(account, { setIds: [SET] })).unseen).toEqual([])
    h.lists.set('act_1234567890/adsets', { rows: [
      { id: '120000000000002', name: 'A', effective_status: 'ACTIVE', targeting: { custom_audiences: [{ id: '120000000000300', name: 'X' }] } },
      { id: '120000000000003', name: 'B', effective_status: 'ACTIVE', targeting: { dynamic_audience_ids: ['120000000000301'] } },
    ], more: false })
    expect((await liveCatalogUsers(account, { setIds: [SET] })).unseen).toEqual([AUDIENCES_UNSEEN])
    expect((await liveCatalogUsers(account, { setIds: [SET], forSetDelete: true })).unseen).toEqual([AUDIENCES_UNSEEN, SDK_SET_FIELDS_UNSEEN])
    h.lists.set('act_1234567890/adsets', { rows: [{ id: '120000000000002', name: 'A', effective_status: 'ACTIVE', targeting: { geo_locations: { countries: ['IT'] } } }], more: false })
    expect((await liveCatalogUsers(account, { setIds: [SET] })).unseen).toEqual([])
    expect(SDK_SET_FIELDS_UNSEEN).toMatch(/creative_sourcing_spec\.associated_product_set_id.*link_data\.boosted_product_set_id/)
  })
})

describe('liveNexusSystemUser', () => {
  it('the stored id, else `me`, else null', async () => {
    expect(await liveNexusSystemUser({ ...account, connection: { systemUser: { id: '100000000000009', name: 'Nexus' } } } as unknown as MetaChosenAccount)).toBe('100000000000009')
    h.me = { id: '100000000000008' }
    expect(await liveNexusSystemUser(account)).toBe('100000000000008')
    h.me = new MetaReadError(localFailure('no', 'X'), 'x', 1)
    expect(await liveNexusSystemUser(account)).toBeNull()
  })
})
