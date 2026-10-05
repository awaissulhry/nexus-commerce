/**
 * Ads wave 4a — Settings → Advertising: the state of each Amazon Ads account, the reading control it offers, and the
 * confirmation that says writes stay off.
 */
import { describe, expect, it } from 'vitest'
import { validateImpact } from '@/design-system/grid'
import {
  ADS_ACCOUNT_STATE_LABEL,
  adsAccountStateOf,
  adsAccountStateTone,
  canOfferPromote,
  nextStepText,
  readActionFor,
  readConfirmImpact,
  type AdsAccountFields,
} from './adsReadState'

const WRITES = '2026-08-29T10:00:00.000Z'
const account = (over: Partial<AdsAccountFields> = {}): AdsAccountFields => ({
  marketplace: 'UK', isActive: true, mode: 'sandbox', writesEnabledAt: null, ...over,
})

describe('the three states', () => {
  it.each([
    [{ isActive: false, mode: 'sandbox', writesEnabledAt: null }, 'not_read', 'Not read', 'neutral'],
    // Not read wins: a row nobody reads is not "live", whatever its permissions say.
    [{ isActive: false, mode: 'production', writesEnabledAt: WRITES }, 'not_read', 'Not read', 'neutral'],
    [{ isActive: true, mode: 'sandbox', writesEnabledAt: null }, 'reading_only', 'Reading only', 'info'],
    [{ isActive: true, mode: 'production', writesEnabledAt: null }, 'reading_only', 'Reading only', 'info'],
    [{ isActive: true, mode: 'production', writesEnabledAt: WRITES }, 'live_writes_on', 'Live · writes on', 'success'],
  ] as const)('%o → %s', (fields, state, label, tone) => {
    expect(adsAccountStateOf(fields)).toBe(state)
    expect(ADS_ACCOUNT_STATE_LABEL[state]).toBe(label)
    expect(adsAccountStateTone(state)).toBe(tone)
  })
})

describe('the reading control a card offers', () => {
  it('offers Read when Nexus does not read the account', () => {
    expect(readActionFor(account({ isActive: false }))).toBe('read')
  })

  it('offers Stop reading while writes are off', () => {
    expect(readActionFor(account())).toBe('stop')
    expect(readActionFor(account({ mode: 'production' }))).toBe('stop')
  })

  it('offers no Stop while writes are on (the API refuses it too)', () => {
    expect(readActionFor(account({ mode: 'production', writesEnabledAt: WRITES }))).toBeNull()
  })

  it('offers Promote to production only once the account is read', () => {
    expect(canOfferPromote(account({ isActive: false }))).toBe(false)
    expect(canOfferPromote(account())).toBe(true)
    expect(canOfferPromote(account({ mode: 'production' }))).toBe(false)
  })
})

describe('the line under each account', () => {
  it('names the next step for each state', () => {
    expect(nextStepText(account({ isActive: false }))).toBe('Nexus does not read this account. Next: Read this market’s data.')
    expect(nextStepText(account())).toBe('Nexus reads this account; writes stay off. Only to spend here: Promote to production, then Enable writes.')
    expect(nextStepText(account({ mode: 'production' }))).toBe('Nexus reads this account; writes are off. Only to spend here: Enable writes.')
    expect(nextStepText(account({ mode: 'production', writesEnabledAt: WRITES }))).toMatch(/^Live · then allowlist/)
  })
})

describe('the confirmation', () => {
  it('Read says writes stay off, names the market, and is a valid DS confirmation', () => {
    const impact = readConfirmImpact(account({ isActive: false, marketplace: 'US' }), 'read')
    expect(impact.title).toBe('Read US’s Amazon Ads data?')
    expect(impact.level).toBe('confirm')
    expect(impact.consequences?.join(' ')).toContain('Writes stay off: Nexus cannot change bids, budgets or campaigns in US.')
    expect(validateImpact(impact)).toEqual([])
  })

  it('Stop says writes stay off and the data already read stays', () => {
    const impact = readConfirmImpact(account(), 'stop')
    expect(impact.title).toBe('Stop reading UK’s Amazon Ads data?')
    expect(impact.consequences).toContain('Writes are off for this account and stay off.')
    expect(impact.consequences?.[0]).toContain('The data already read stays.')
    expect(validateImpact(impact)).toEqual([])
  })

  it('a row with no market still asks a whole question', () => {
    expect(readConfirmImpact(account({ marketplace: '' }), 'read').title).toBe('Read this market’s Amazon Ads data?')
  })
})
