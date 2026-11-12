import { describe, expect, it } from 'vitest'
import { KINDS, readThreshold } from '../../alerts/kinds'
import { alertPhrase, phraseText, ruleSentence } from '../../alerts/rules'
import { lowStockOf, lowStockWords, minimumOf } from './rules'

describe('below the minimum (B-W2b-314, SCM-281)', () => {
  it('takes the minimum from the planning parameters by their method', () => {
    expect(minimumOf({ method: 'MIN_MAX', minStock: '20', reorderPoint: null, safetyStock: '5' })).toMatchObject({ basis: 'MIN_MAX' })
    expect(minimumOf({ method: 'MIN_MAX', minStock: null, reorderPoint: null, safetyStock: '5' })).toBeNull()
    expect(minimumOf({ method: 'REORDER_POINT', minStock: null, reorderPoint: '12', safetyStock: null })?.minimum.toFixed()).toBe('12')
    expect(minimumOf({ method: 'ORDERS', minStock: null, reorderPoint: null, safetyStock: '5' })).toMatchObject({ basis: 'SAFETY_STOCK' })
    expect(minimumOf({ method: 'ORDERS', minStock: null, reorderPoint: null, safetyStock: '0' })).toBeNull()
    expect(minimumOf({ method: 'MANUAL', minStock: null, reorderPoint: null, safetyStock: null })).toBeNull()
  })

  it('compares what the site has and expects (on hand + on order − reserved) with it', () => {
    expect(lowStockOf({ onHand: '15', onOrder: '0', reserved: '3', minimum: '20', basis: 'MIN_MAX' })).toEqual({ below: true, position: '12.0000', short: '8.0000' })
    expect(lowStockOf({ onHand: '15', onOrder: '10', reserved: '3', minimum: '20', basis: 'MIN_MAX' })).toEqual({ below: false, position: '22.0000', short: '0.0000' })
    expect(lowStockOf({ onHand: '20', onOrder: '0', reserved: '0', minimum: '20', basis: 'MIN_MAX' }).below).toBe(false)
    expect(lowStockOf({ onHand: '12', onOrder: '0', reserved: '0', minimum: '12', basis: 'REORDER_POINT' }).below).toBe(true)
    expect(lowStockOf({ onHand: '0', onOrder: '0', reserved: '0', minimum: '0', basis: 'MIN_MAX' }).below).toBe(false)
  })

  it('says it in words', () => {
    const facts = { onHand: '15', onOrder: '0', reserved: '3', minimum: '20', basis: 'MIN_MAX' as const, uom: 'M2' as const }
    expect(lowStockWords(facts, 'en')).toBe('12 m² against a minimum of 20 m² (on hand 15 m² + on order 0 m² − reserved 3 m²)')
    expect(lowStockWords(facts, 'it')).toBe('12 m² su un minimo di 20 m² (giacenza 15 m² + in arrivo 0 m² − riservato 3 m²)')
  })

  it('has its alert rule kind LOW_STOCK (a built-in for the buyer, seen with the stock, no numbers)', () => {
    expect(KINDS.LOW_STOCK).toMatchObject({ trigger: 'CONDITION', recordType: 'Item', view: 'inventory.stock.view', builtIn: { recipientRole: 'buyer', severity: 'WARNING' } })
    expect(readThreshold('LOW_STOCK', {})).toEqual({ ok: true, threshold: {} })
    const phrase = alertPhrase('LOW_STOCK', 'LEA-BLK at A1', { position: '12', minimum: '20', unit: 'm²' })
    expect(phraseText(phrase, 'LEA-BLK at A1')).toBe('LEA-BLK at A1 is below its minimum: 12 m² against 20 m².')
    expect(phraseText(phrase, 'LEA-BLK at A1', 'it')).toBe('LEA-BLK at A1 è sotto il minimo: 12 m² su 20 m².')
    expect(ruleSentence({ ruleKind: 'LOW_STOCK', threshold: {}, channels: ['IN_APP'], cooldownMinutes: 1440 }, { place: null, recipient: 'Buyer' })).toContain('When a material falls below the minimum of its planning parameters, tell Buyer')
  })
})
