/**
 * FL.4.1 — Unit tests for the pure propagation planner.
 */

import { describe, it, expect } from 'vitest'
import {
  planPropagation,
  entriesNeedingTranslation,
} from '../field-resolution/propagation.js'

const members = [
  { channel: 'AMAZON', marketplace: 'IT', currentValue: 'Vecchio', language: 'it' },
  { channel: 'AMAZON', marketplace: 'DE', currentValue: 'Alt', language: 'de' },
  { channel: 'AMAZON', marketplace: 'FR', currentValue: null, language: 'fr' },
  { channel: 'EBAY', marketplace: 'IT', currentValue: 'Vecchio eBay', language: 'it' },
]

describe('planPropagation', () => {
  it('excludes the edited source coordinate', () => {
    const plan = planPropagation({
      editedValue: 'XAVIA GALE Giacca',
      sourceChannel: 'AMAZON',
      sourceMarketplace: 'IT',
      sourceLanguage: 'it',
      translatePolicy: 'TRANSLATE',
      members,
    })
    expect(plan.find((e) => e.channel === 'AMAZON' && e.marketplace === 'IT')).toBeUndefined()
    expect(plan).toHaveLength(3)
  })

  it('same-language members get verbatim copy', () => {
    const plan = planPropagation({
      editedValue: 'XAVIA GALE Giacca',
      sourceChannel: 'AMAZON',
      sourceMarketplace: 'IT',
      sourceLanguage: 'it',
      translatePolicy: 'TRANSLATE',
      members,
    })
    const ebayIt = plan.find((e) => e.channel === 'EBAY' && e.marketplace === 'IT')!
    expect(ebayIt.action).toBe('verbatim')
    expect(ebayIt.proposedValue).toBe('XAVIA GALE Giacca')
  })

  it('cross-language members are flagged translate with null proposed', () => {
    const plan = planPropagation({
      editedValue: 'XAVIA GALE Giacca',
      sourceChannel: 'AMAZON',
      sourceMarketplace: 'IT',
      sourceLanguage: 'it',
      translatePolicy: 'TRANSLATE',
      members,
    })
    const de = plan.find((e) => e.marketplace === 'DE')!
    expect(de.action).toBe('translate')
    expect(de.proposedValue).toBeNull()
    expect(entriesNeedingTranslation(plan).map((e) => e.marketplace).sort()).toEqual(['DE', 'FR'])
  })

  it('VERBATIM policy copies to every member regardless of language', () => {
    const plan = planPropagation({
      editedValue: '189',
      sourceChannel: 'AMAZON',
      sourceMarketplace: 'IT',
      sourceLanguage: 'it',
      translatePolicy: 'VERBATIM',
      members,
    })
    expect(plan.every((e) => e.action === 'verbatim')).toBe(true)
    expect(plan.every((e) => e.proposedValue === '189')).toBe(true)
  })

  it('NONE policy skips everything', () => {
    const plan = planPropagation({
      editedValue: 'x',
      sourceChannel: 'AMAZON',
      sourceMarketplace: 'IT',
      sourceLanguage: 'it',
      translatePolicy: 'NONE',
      members,
    })
    expect(plan.every((e) => e.action === 'skip')).toBe(true)
    expect(entriesNeedingTranslation(plan)).toHaveLength(0)
  })

  it('flags unchanged members (current already equals proposed)', () => {
    const plan = planPropagation({
      editedValue: 'Vecchio eBay',
      sourceChannel: 'AMAZON',
      sourceMarketplace: 'IT',
      sourceLanguage: 'it',
      translatePolicy: 'VERBATIM',
      members,
    })
    const ebayIt = plan.find((e) => e.channel === 'EBAY' && e.marketplace === 'IT')!
    expect(ebayIt.unchanged).toBe(true)
    const amzDe = plan.find((e) => e.marketplace === 'DE')!
    expect(amzDe.unchanged).toBe(false)
  })

  it('respects variantId when matching the source coordinate', () => {
    const childMembers = [
      { channel: 'AMAZON', marketplace: 'IT', variantId: 'red', currentValue: '10', language: 'it' },
      { channel: 'AMAZON', marketplace: 'IT', variantId: 'black', currentValue: '20', language: 'it' },
    ]
    const plan = planPropagation({
      editedValue: '15',
      sourceChannel: 'AMAZON',
      sourceMarketplace: 'IT',
      sourceVariantId: 'red',
      sourceLanguage: 'it',
      translatePolicy: 'VERBATIM',
      members: childMembers,
    })
    // Only the black variant remains (red is the source).
    expect(plan).toHaveLength(1)
    expect(plan[0].variantId).toBe('black')
  })
})
