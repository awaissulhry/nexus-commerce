/** Owner SKU relabeling — XML builder regression. */
import { describe, it, expect } from 'vitest'
import { buildRelabelXml, planSkulessAdoption } from './ebay-variation-relabel.service.js'

describe('buildRelabelXml', () => {
  it('one Variation per relabel, identified by specifics, carrying the NEW sku', () => {
    const xml = buildRelabelXml('256566101420', [
      { fromSku: 'T1_Ne_L', toSku: 'GALE-JACKET-BLACK-MEN-L', specifics: { Colore: 'Nero', Taglia: 'L' } },
      { fromSku: 'T1_Gi_M', toSku: 'GALE-JACKET-YELLOW-MEN-M', specifics: { Colore: 'Giallo', Taglia: 'M' } },
    ])
    expect(xml).toContain('<ItemID>256566101420</ItemID>')
    expect((xml.match(/<Variation>/g) ?? []).length).toBe(2)
    expect(xml).toContain('<SKU>GALE-JACKET-BLACK-MEN-L</SKU>')
    expect(xml).toContain('<Name>Colore</Name><Value>Nero</Value>')
    expect(xml).not.toContain('T1_Ne_L') // old sku never sent — identity is the specifics
    expect(xml).toContain('ReviseFixedPriceItemRequest')
  })
  it('escapes XML in specifics values', () => {
    const xml = buildRelabelXml('1', [
      { fromSku: 'A', toSku: 'B', specifics: { Materiale: 'Poliestere & Nylon' } },
    ])
    expect(xml).toContain('Poliestere &amp; Nylon')
  })
})


describe('incident #42 — planSkulessAdoption', () => {
  const pool = [
    { productId: 'p-black', price: 9.9, specifics: { Colore: 'Nero' } },
    { productId: 'p-blue', price: 9.9, specifics: { Colore: 'Blu' } },
  ]

  it('matches SKU-less variations onto the pool (bilingual) and ignores SKU-carrying rows', () => {
    const live = [
      { sku: '', specifics: { Color: 'Black' }, price: 12.5 },
      { sku: 'HAS-SKU', specifics: { Color: 'Blue' }, price: 12.5 },
    ]
    const plan = planSkulessAdoption(live, pool)
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0].productId).toBe('p-black')
    expect(plan.entries[0].price).toBe(12.5)
    expect(plan.unmatched).toEqual([])
  })

  it('refuses duplicate pool matches instead of colliding membership keys', () => {
    const live = [
      { sku: '', specifics: { Color: 'Black' }, price: null },
      { sku: '', specifics: { Colore: 'Nero' }, price: null }, // same product through synonyms
    ]
    const plan = planSkulessAdoption(live, pool)
    expect(plan.entries).toHaveLength(1)
    expect(plan.unmatched).toHaveLength(1)
    expect(plan.unmatched[0]).toContain('duplicate pool match')
  })

  it('reports unmatched instead of guessing', () => {
    const live = [{ sku: '', specifics: { Color: 'Purple' }, price: null }]
    const plan = planSkulessAdoption(live, pool)
    expect(plan.entries).toHaveLength(0)
    expect(plan.unmatched).toEqual(['Color=Purple'])
  })
})
