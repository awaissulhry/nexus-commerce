/**
 * Meta step 41, Owner option 1 — a dataset's own check (liveAccessPixel): one of the chosen ad account's pixels no other
 * Nexus business uses (step 32's ownSignalPixel, stood in here) AND owned by the chosen ad account's portfolio (its
 * owner_business); and a dataset's server-event businesses read with another Nexus business's portfolio as its id and
 * the flag only. Made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ ownRefusal: null as string | null, owner: '9876543210' as string | null, rows: [] as Array<Record<string, unknown>>, taken: new Set<string>(), asked: [] as string[] }))
vi.mock('./signals-rule.js', async () => {
  const live = await import('./live.js')
  return { ownSignalPixel: vi.fn(async (_a: unknown, id: string) => { if (h.ownRefusal) throw new live.MetaLiveRefusal(h.ownRefusal); return id }) }
})
vi.mock('./read-client.js', () => ({ metaReadOne: vi.fn(async () => ({ body: { id: '120000000000050', name: 'Dataset A', ...(h.owner ? { owner_business: { id: h.owner } } : {}) }, calls: 1 })) }))
vi.mock('./paging.js', async (importActual) => ({ ...(await importActual<typeof import('./paging.js')>()), listPaged: vi.fn(async () => ({ rows: h.rows, more: false, totalCount: null })),
  listWithFallback: vi.fn(async (_c: string, _o: string, _p: string, core: string, more: string) => { h.asked.push(`${core}|${more}`); return { rows: h.rows, more: false, totalCount: null, note: null } }) }))
vi.mock('./taken.js', () => ({ takenIds: vi.fn(async (_p: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id)))) }))

import { liveAccessPixel, liveAssetPartners, liveServerEventBusinesses } from './live-access-change.js'
import type { MetaChosenAccount } from './live.js'

const ACCOUNT = { connectionId: 'm-1', adAccountId: '1234567890' } as MetaChosenAccount

beforeEach(() => { h.ownRefusal = null; h.owner = '9876543210'; h.rows = []; h.taken = new Set(); h.asked = [] })

describe('liveAccessPixel', () => {
  it('a pixel of the chosen ad account, free and owned by its portfolio: the dataset', async () => {
    expect(await liveAccessPixel(ACCOUNT, '120000000000050', '9876543210')).toEqual({ asset: 'pixel', nodeId: '120000000000050', label: 'dataset 120000000000050 ("Dataset A")' })
  })
  it('owned by another portfolio, or Meta does not say: refused; step 32\'s refusal is passed on', async () => {
    h.owner = '5555555555'
    await expect(liveAccessPixel(ACCOUNT, '120000000000050', '9876543210')).rejects.toThrow(/not owned by the chosen ad account's business portfolio/)
    h.owner = null
    await expect(liveAccessPixel(ACCOUNT, '120000000000050', '9876543210')).rejects.toThrow(/not owned/)
    h.ownRefusal = 'That pixel is not on the ad account this business chose.'
    await expect(liveAccessPixel(ACCOUNT, '120000000000050', '9876543210')).rejects.toThrow(/not on the ad account this business chose/)
  })
})

describe('liveServerEventBusinesses', () => {
  it('another Nexus business\'s portfolio is its id and the flag only', async () => {
    h.rows = [{ id: '120000000000071', name: 'Partner A' }, { id: '120000000000072', name: 'Business B' }]
    h.taken.add('120000000000072')
    const read = await liveServerEventBusinesses(ACCOUNT, '120000000000050')
    expect([...read.businesses.values()]).toEqual([
      { id: '120000000000071', name: 'Partner A', takenByAnotherBusiness: false },
      { id: '120000000000072', name: null, takenByAnotherBusiness: true },
    ])
  })
})

describe('liveAssetPartners', () => {
  it('option-1 review SF4 — a dataset\'s partners are asked permitted_tasks only (its edge documents no access_status)', async () => {
    h.rows = [{ id: '120000000000071', name: 'Partner A', permitted_tasks: ['ANALYZE'] }]
    const read = await liveAssetPartners(ACCOUNT, '120000000000050', 'pixel')
    expect(read.partners.get('120000000000071')).toMatchObject({ tasks: ['ANALYZE'] })
    await liveAssetPartners(ACCOUNT, '1234567890', 'ad-account')
    expect(h.asked).toEqual(['id,name|permitted_tasks', 'id,name|access_status,permitted_tasks'])
  })
})
