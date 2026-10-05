import { describe, it, expect } from 'vitest'
import { toTradingConditionId, toInventoryCondition, ebayConditionName, EBAY_CONDITION_NAMES, ENUM_TO_CONDITION_ID, CONDITION_ID_TO_ENUM } from './ebay-condition.js'

describe('toTradingConditionId (incident #16)', () => {
  it('translates the operator words both paths accept', () => {
    expect(toTradingConditionId('NEW')).toBe('1000')
    expect(toTradingConditionId('new')).toBe('1000')
    expect(toTradingConditionId('New With Tags')).toBe('1000')
    expect(toTradingConditionId('NEW_OTHER')).toBe('1500')
    expect(toTradingConditionId('USED_EXCELLENT')).toBe('3000')
    expect(toTradingConditionId('used')).toBe('3000')
  })
  it('passes numeric ConditionIDs through', () => {
    expect(toTradingConditionId('1000')).toBe('1000')
    expect(toTradingConditionId(' 3000 ')).toBe('3000')
  })
  it('unknown/empty resolve to "" so pre-flight names them (never eBay code 37)', () => {
    expect(toTradingConditionId('SHINY')).toBe('')
    expect(toTradingConditionId('')).toBe('')
  })
  it('inverse table covers every forward entry (tables cannot drift)', () => {
    for (const [id, en] of Object.entries(CONDITION_ID_TO_ENUM)) {
      expect(ENUM_TO_CONDITION_ID[en]).toBe(id)
    }
  })
})

describe('eBay condition names in English (W3-4)', () => {
  it('names every code a listing can store: the numeric ID and the enum word (live listings store NEW)', () => {
    for (const [id, word] of Object.entries(CONDITION_ID_TO_ENUM)) {
      expect(EBAY_CONDITION_NAMES[id]).toBeTruthy()
      expect(EBAY_CONDITION_NAMES[word]).toBe(EBAY_CONDITION_NAMES[id])
    }
    for (const word of Object.keys(ENUM_TO_CONDITION_ID)) expect(EBAY_CONDITION_NAMES[word]).toBeTruthy()
    expect(EBAY_CONDITION_NAMES.NEW).toBe('New')
    expect(EBAY_CONDITION_NAMES['3000']).toBe('Used')
    expect(EBAY_CONDITION_NAMES.NEW_WITH_TAGS).toBe('New with tags')
  })
  it('1000 / 1500 follow the category\'s wording (Owner decision 7): tags on clothing, box on shoes, in any market language', () => {
    expect(ebayConditionName('NEW', 'Nuovo con etichette')).toBe('New with tags')
    expect(ebayConditionName('NEW_OTHER', 'Nuovo senza etichette')).toBe('New without tags')
    expect(ebayConditionName('1000', 'Neu mit Karton')).toBe('New with box')
    expect(ebayConditionName('1500', 'Neuf sans boîte')).toBe('New without box')
    expect(ebayConditionName('NEW', 'Nuevo con etiquetas')).toBe('New with tags')
    expect(ebayConditionName('NEW', 'Nuovo')).toBe('New')
    expect(ebayConditionName('NEW')).toBe('New')
    expect(ebayConditionName('NEW_OTHER')).toBe('New other (see details)')
    // Only 1000 and 1500 take the category's wording.
    expect(ebayConditionName('USED_EXCELLENT', 'Usato')).toBe('Used')
    expect(ebayConditionName('NEW_WITH_DEFECTS', 'Nuovo con difetti')).toBe('New with defects')
  })
  it('a code Nexus does not know stays as it is', () => {
    expect(ebayConditionName('SHINY')).toBe('SHINY')
    expect(ebayConditionName('')).toBe('')
  })
  it('the English names resolve to the code (paste, MCP, import), and the stored code is unchanged', () => {
    expect(toTradingConditionId('New with tags')).toBe('1000')
    expect(toTradingConditionId('New without box')).toBe('1500')
    expect(toTradingConditionId('Like New')).toBe('2750')
    expect(toTradingConditionId('Pre-owned - Excellent')).toBe('2990')
    expect(toTradingConditionId('For parts or not working')).toBe('7000')
    expect(toInventoryCondition('New with tags')).toBe('NEW')
    expect(toInventoryCondition('Very Good')).toBe('USED_VERY_GOOD')
    expect(toInventoryCondition('NEW')).toBe('NEW')
    // A market's word is not a code: it stays as written so publish names it (the sheet's paste resolves it first).
    expect(toInventoryCondition('Nuovo con etichette')).toBe('Nuovo con etichette')
  })
})
