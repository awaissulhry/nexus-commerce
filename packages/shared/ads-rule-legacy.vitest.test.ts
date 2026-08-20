import { describe, expect, it } from 'vitest'
import { ADS_RULE_LEGACY_CUTOVER_ISO, isLegacyRule } from './ads-rule-legacy'

describe('isLegacyRule', () => {
  it('calls every pre-existing rule legacy (newest was created 2026-08-03)', () => {
    expect(isLegacyRule({ createdAt: '2026-05-16T09:00:00.000Z' })).toBe(true)
    expect(isLegacyRule({ createdAt: '2026-08-03T23:59:59.999Z' })).toBe(true)
    expect(isLegacyRule({ createdAt: new Date('2026-06-01T00:00:00Z') })).toBe(true)
  })

  it('calls a rule created at or after the cutover NOT legacy', () => {
    expect(isLegacyRule({ createdAt: ADS_RULE_LEGACY_CUTOVER_ISO })).toBe(false)
    expect(isLegacyRule({ createdAt: '2026-08-20T00:00:00.001Z' })).toBe(false)
    expect(isLegacyRule({ createdAt: '2027-01-01T00:00:00.000Z' })).toBe(false)
  })

  it('treats absent or unreadable createdAt as NOT legacy — absence of evidence stays absent', () => {
    expect(isLegacyRule({})).toBe(false)
    expect(isLegacyRule({ createdAt: null })).toBe(false)
    expect(isLegacyRule({ createdAt: 'not-a-date' })).toBe(false)
  })
})
