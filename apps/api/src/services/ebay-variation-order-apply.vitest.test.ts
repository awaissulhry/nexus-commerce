import { describe, expect, it } from 'vitest'
import { planSpecificsSetReorder, buildReorderXml } from './ebay-variation-order-apply.service.js'
import { axisSynonymKey } from './ebay-theme-axes.js'

const SIZE = axisSynonymKey('Taglia')
const COLOR = axisSynonymKey('Colore')

describe('planSpecificsSetReorder', () => {
  it('reorders values by the stored order, keyed by axis synonym', () => {
    const plan = planSpecificsSetReorder(
      { Taglia: ['XL', 'S', 'M'] },
      undefined,
      { [SIZE]: ['S', 'M', 'XL'] },
    )
    expect(plan.set.Taglia).toEqual(['S', 'M', 'XL'])
    expect(plan.changed).toBe(true)
    expect(plan.valueChanges).toEqual([{ axis: 'Taglia', from: ['XL', 'S', 'M'], to: ['S', 'M', 'XL'] }])
  })

  it('emits the EXACT live strings, not the trimmed authority forms', () => {
    const plan = planSpecificsSetReorder(
      { Colore: ['Rosso ', 'Nero'] },
      undefined,
      { [COLOR]: ['nero', 'rosso'] },
    )
    // Trailing space preserved — the value itself is never rewritten.
    expect(plan.set.Colore).toEqual(['Nero', 'Rosso '])
  })

  it('is ALWAYS a permutation: live-only values unknown to the stored order are kept', () => {
    const plan = planSpecificsSetReorder(
      { Taglia: ['3XL', 'S', 'M'] },
      undefined,
      { [SIZE]: ['S', 'M'] },
    )
    expect([...plan.set.Taglia].sort()).toEqual(['3XL', 'M', 'S'])
    expect(plan.set.Taglia.slice(0, 2)).toEqual(['S', 'M'])
  })

  it('resequences axes by the stored axis list via synonyms; live-only axes keep live order after', () => {
    const plan = planSpecificsSetReorder(
      { Taglia: ['S'], Materiale: ['Pelle'], Colore: ['Nero'] },
      ['Colore', 'Taglia'],
      undefined,
    )
    expect(plan.names).toEqual(['Colore', 'Taglia', 'Materiale'])
    expect(plan.axisOrder).toEqual({ from: ['Taglia', 'Materiale', 'Colore'], to: ['Colore', 'Taglia', 'Materiale'] })
    expect(plan.changed).toBe(true)
  })

  it('reports changed:false when live order already matches', () => {
    const plan = planSpecificsSetReorder(
      { Taglia: ['S', 'M', 'XL'] },
      ['Taglia'],
      { [SIZE]: ['S', 'M', 'XL'] },
    )
    expect(plan.changed).toBe(false)
    expect(plan.valueChanges).toEqual([])
  })

  it('collision guard: trim/case-colliding live values keep the live order untouched', () => {
    const plan = planSpecificsSetReorder(
      { Colore: ['Nero', 'nero ', 'Rosso'] },
      undefined,
      { [COLOR]: ['Rosso', 'Nero'] },
    )
    expect(plan.set.Colore).toEqual(['Nero', 'nero ', 'Rosso'])
  })

  it('size axes canonicalize without a stored order (push parity)', () => {
    const plan = planSpecificsSetReorder({ Taglia: ['XL', 'M', 'S'] }, undefined, undefined)
    expect(plan.set.Taglia).toEqual(['S', 'M', 'XL'])
  })
})

describe('buildReorderXml', () => {
  it('carries ONLY VariationSpecificsSet — no Variation nodes, values escaped', () => {
    const plan = planSpecificsSetReorder(
      { Taglia: ['S'], Colore: ['Nero & Blu'] },
      ['Taglia', 'Colore'],
      undefined,
    )
    const xml = buildReorderXml('256011224335', plan)
    expect(xml).toContain('<ItemID>256011224335</ItemID>')
    expect(xml).toContain('<VariationSpecificsSet>')
    expect(xml).toContain('Nero &amp; Blu')
    expect(xml).not.toContain('<Variation>')
    expect(xml).not.toContain('<StartPrice>')
    expect(xml.indexOf('<Name>Taglia</Name>')).toBeLessThan(xml.indexOf('<Name>Colore</Name>'))
  })
})
