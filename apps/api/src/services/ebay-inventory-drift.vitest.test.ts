/**
 * The drift comparison must be honest in BOTH directions: it may not invent a
 * difference (which would push the operator into a risky write path for
 * nothing), and it may not hide one (which is the whole reason we measure).
 *
 * Run: npx vitest run src/services/ebay-inventory-drift.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { diffLiveGroup } from './ebay-inventory-drift.service.js'

const live = (over: Record<string, unknown> = {}) => ({
  title: 'XAVIA AIRMESH Giacca',
  variantSKUs: ['A-M', 'A-L', 'A-S'],
  imageUrls: ['u1', 'u2'],
  variesBy: { specifications: [{ name: 'Taglia', values: ['S'] }] },
  aspects: { Marca: ['Xavia'] },
  description: '<div>x</div>',
  ...over,
})

describe('diffLiveGroup', () => {
  it('reports NO drift when the live group already matches what a push would send', () => {
    const { fields, drift } = diffLiveGroup(live(), { title: 'XAVIA AIRMESH Giacca', variantSkus: ['A-S', 'A-M', 'A-L'] })
    expect(drift).toBe(false)
    expect(fields.find((f) => f.field === 'title')!.drift).toBe(false)
    // order must not matter — membership is a set, not a sequence
    expect(fields.find((f) => f.field === 'variantSKUs')!.drift).toBe(false)
  })

  it('flags a title that a Full Publish would overwrite', () => {
    const { fields, drift } = diffLiveGroup(live(), { title: 'A DIFFERENT TITLE', variantSkus: ['A-S', 'A-M', 'A-L'] })
    expect(drift).toBe(true)
    expect(fields.find((f) => f.field === 'title')!.drift).toBe(true)
  })

  it('flags variant membership drift in either direction', () => {
    const added = diffLiveGroup(live(), { title: 'XAVIA AIRMESH Giacca', variantSkus: ['A-S', 'A-M', 'A-L', 'A-XL'] })
    expect(added.drift).toBe(true)
    const removed = diffLiveGroup(live(), { title: 'XAVIA AIRMESH Giacca', variantSkus: ['A-S', 'A-M'] })
    expect(removed.drift).toBe(true)
  })

  it('never lets a NON-comparable field manufacture drift', () => {
    // images/variesBy/aspects are reported for context only — if they could set
    // `drift`, the report would send operators chasing differences it cannot
    // actually prove.
    const { fields, drift } = diffLiveGroup(
      live({ imageUrls: [], variesBy: null, aspects: null }),
      { title: 'XAVIA AIRMESH Giacca', variantSkus: ['A-S', 'A-M', 'A-L'] },
    )
    expect(drift).toBe(false)
    for (const f of fields.filter((x) => !x.comparable)) expect(f.drift).toBe(false)
  })

  it('treats a missing variantSKUs array as empty rather than throwing', () => {
    const { fields } = diffLiveGroup({ title: 'T' }, { title: 'T', variantSkus: [] })
    expect(fields.find((f) => f.field === 'variantSKUs')!.live).toEqual([])
  })
})
