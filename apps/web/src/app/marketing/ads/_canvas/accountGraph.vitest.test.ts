import { describe, it, expect } from 'vitest'
import { campaignsToObjects, visibleObjects, childParentIds, type ApiCampaign } from './accountGraph'

const camps: ApiCampaign[] = [
  { id: '1', name: 'AIREON', marketplace: 'DE', portfolioId: 'pf1', spend: '310', acos: '0.24' },
  { id: '2', name: 'MISANO', marketplace: 'DE', portfolioId: null, spend: '190', acos: '0.61' },
  { id: '3', name: 'GALE', marketplace: 'IT', portfolioId: null, spend: null, acos: null },
]

describe('campaignsToObjects', () => {
  it('builds market/portfolio/campaign objects with parent links and aggregated spend', () => {
    const objs = campaignsToObjects(camps, [{ portfolioId: 'pf1', name: 'Moto Jackets' }])
    const de = objs.find((o) => o.id === 'm:DE')!
    expect(de.kind).toBe('market')
    expect(de.spend).toBe(500) // 310 + 190
    const moto = objs.find((o) => o.id === 'p:DE:pf1')!
    expect(moto.name).toBe('Moto Jackets')
    expect(moto.parentId).toBe('m:DE')
    const noPf = objs.find((o) => o.id === 'p:DE:none')!
    expect(noPf.name).toBe('No portfolio')
    const aireon = objs.find((o) => o.id === 'c:1')!
    expect(aireon.parentId).toBe('p:DE:pf1')
    expect(aireon.health).toBe('ok') // 0.24
    expect(objs.find((o) => o.id === 'c:2')!.health).toBe('bad') // 0.61
  })

  it('coerces string/null metrics safely', () => {
    const gale = campaignsToObjects(camps).find((o) => o.id === 'c:3')!
    expect(gale.spend).toBeUndefined()
    expect(gale.acos).toBeUndefined()
    expect(gale.health).toBe('ok')
  })
})

describe('visibleObjects', () => {
  it('shows roots always; children only when every ancestor is expanded', () => {
    const objs = campaignsToObjects(camps, [])
    const noneExpanded = visibleObjects(objs, new Set())
    expect(noneExpanded.every((o) => o.kind === 'market')).toBe(true)
    const deExpanded = visibleObjects(objs, new Set(['m:DE']))
    expect(deExpanded.some((o) => o.id === 'p:DE:pf1')).toBe(true)
    expect(deExpanded.some((o) => o.id === 'c:1')).toBe(false) // portfolio not expanded
  })
})

describe('childParentIds', () => {
  it("returns the set of ids that are someone's parent", () => {
    const objs = campaignsToObjects(camps, [])
    const s = childParentIds(objs)
    expect(s.has('m:DE')).toBe(true)
    expect(s.has('c:1')).toBe(false)
  })
})

describe('detail aggregation', () => {
  it('sums child metrics into market detail, derives ACoS/ROAS, tracks latest sync', () => {
    const cs: ApiCampaign[] = [
      { id: '1', name: 'A', marketplace: 'DE', spend: '100', sales: '400', impressions: '1000', clicks: '50', orders: '8', lastSyncedAt: '2026-06-29T10:00:00Z' },
      { id: '2', name: 'B', marketplace: 'DE', spend: '100', sales: '100', impressions: '500', clicks: '20', orders: '2', lastSyncedAt: '2026-06-30T08:00:00Z' },
    ]
    const de = campaignsToObjects(cs).find((o) => o.id === 'm:DE')!
    expect(de.spend).toBe(200)
    expect(de.detail!.sales).toBe(500)
    expect(de.detail!.impressions).toBe(1500)
    expect(de.detail!.orders).toBe(10)
    expect(de.acos!).toBeCloseTo(0.4) // 200 / 500
    expect(de.detail!.roas!).toBeCloseTo(2.5) // 500 / 200
    expect(de.detail!.lastSyncedAt).toBe('2026-06-30T08:00:00Z')
  })
})
