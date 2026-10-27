/**
 * Negative Targeting page, HONEST 10 / 11 — a waiting row carries the ask's OWN change (its action, the negative's match,
 * where it lands, its words; for a pause whether it keeps it paused), never the row's verb, and how many changes the
 * ask holds. Pure. Values are made up (public repo).
 */
import { describe, expect, it } from 'vitest'
import { waitAskOf } from './asks.js'
import { waitingOfFact, type TargetFact, type WaitingFact } from './read.js'

const target = (id: string, t: Partial<TargetFact>): TargetFact => ({
  id, adGroupId: 'g1', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'made up words', status: 'ENABLED',
  isNegative: false, negativeLevel: null, externalTargetId: null, createdAt: new Date(0), retiredAt: null, ...t,
})
const targets = new Map<string, TargetFact>([
  ['k1', target('k1', { kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: 'rain jacket' })],
  ['n1', target('n1', { isNegative: true, expressionType: 'NEGATIVE_PHRASE', expressionValue: 'cheap', negativeLevel: 'CAMPAIGN' })],
  ['n2', target('n2', { isNegative: true, kind: 'PRODUCT', expressionType: 'ASIN_SAME_AS', expressionValue: 'b0made0up1', negativeLevel: 'AD_GROUP' })],
])
const place = { targetId: null, adGroupId: null, campaignId: null, text: null }
const fact: WaitingFact = { approvalId: 'appr-1', by: { kind: 'BRAIN', name: 'Brain', id: 'brain' }, at: new Date('2026-10-26T07:00:00Z'), expiresAt: null }

describe('HONEST 10 — the ask\'s own change at its row', () => {
  it('a negative: its match, where it lands (ad group or whole campaign) and its own words', () => {
    expect(waitAskOf({ ...place, action: 'NEGATE_PHRASE', adGroupId: 'g1', text: 'rain cover' }, targets)).toEqual({ action: 'NEGATE_PHRASE', match: 'PHRASE', level: 'AD_GROUP', text: 'rain cover' })
    expect(waitAskOf({ ...place, action: 'NEGATE_EXACT', campaignId: 'c1', text: 'kids' }, targets)).toEqual({ action: 'NEGATE_EXACT', match: 'EXACT', level: 'CAMPAIGN', text: 'kids' })
    expect(waitAskOf({ ...place, action: 'NEGATE_ASIN', adGroupId: 'g1', text: 'b0made0up2' }, targets)).toEqual({ action: 'NEGATE_ASIN', match: 'ASIN', level: 'AD_GROUP', text: 'B0MADE0UP2' })
  })

  it('a pause: our keyword\'s own match and words, and whether the ask keeps it paused', () => {
    expect(waitAskOf({ ...place, action: 'PAUSE', targetId: 'k1' }, targets, true)).toEqual({ action: 'PAUSE', match: 'BROAD', level: null, text: 'rain jacket', keepPaused: true })
    expect(waitAskOf({ ...place, action: 'PAUSE', targetId: 'k1' }, targets, false)).toMatchObject({ keepPaused: false })
  })

  it('a removal: the negative\'s own match, level and words; one Nexus no longer holds is said as not known', () => {
    // HONEST 18d — `atAmazon`: these two Amazon never had (no id): removing them changes Nexus only.
    expect(waitAskOf({ ...place, action: 'REMOVE_NEGATIVE', targetId: 'n1' }, targets)).toEqual({ action: 'REMOVE_NEGATIVE', match: 'PHRASE', level: 'CAMPAIGN', text: 'cheap', atAmazon: false })
    expect(waitAskOf({ ...place, action: 'REMOVE_NEGATIVE', targetId: 'n2' }, targets)).toEqual({ action: 'REMOVE_NEGATIVE', match: 'ASIN', level: 'AD_GROUP', text: 'B0MADE0UP1', atAmazon: false })
    const held = new Map([['n3', target('n3', { isNegative: true, expressionType: 'NEGATIVE_EXACT', negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-n3' })]])
    expect(waitAskOf({ ...place, action: 'REMOVE_NEGATIVE', targetId: 'n3' }, held)).toMatchObject({ action: 'REMOVE_NEGATIVE', atAmazon: true })
    expect(waitingOfFact({ ...fact, ask: waitAskOf({ ...place, action: 'REMOVE_NEGATIVE', targetId: 'n1' }, targets) })).toMatchObject({ action: 'REMOVE_NEGATIVE', atAmazon: false })
    expect(waitAskOf({ ...place, action: 'REMOVE_NEGATIVE', targetId: 'gone' }, targets)).toEqual({ action: 'REMOVE_NEGATIVE', match: null, level: null, text: null })
  })

  it('the row\'s waiting says it, with how many changes the ask holds (HONEST 11); an older fact says nothing more', () => {
    const ask = waitAskOf({ ...place, action: 'NEGATE_PHRASE', adGroupId: 'g1', text: 'rain cover' }, targets)
    expect(waitingOfFact({ ...fact, ask, changes: 3 })).toEqual({
      approvalId: 'appr-1', by: { id: 'brain', name: 'Brain' }, at: '2026-10-26T07:00:00.000Z', expiresAt: null, rows: 1,
      action: 'NEGATE_PHRASE', match: 'PHRASE', level: 'AD_GROUP', text: 'rain cover', changes: 3,
    })
    expect(waitingOfFact({ ...fact, ask: waitAskOf({ ...place, action: 'PAUSE', targetId: 'k1' }, targets, true), changes: 1 })).toMatchObject({ action: 'PAUSE', keepPaused: true, changes: 1 })
    expect(waitingOfFact(fact)).toEqual({ approvalId: 'appr-1', by: { id: 'brain', name: 'Brain' }, at: '2026-10-26T07:00:00.000Z', expiresAt: null, rows: 1 })
  })
})
