/**
 * 6c (review G.2, Owner S9) — the builder says plainly which days a rule reads.
 */
import { describe, expect, it } from 'vitest'
import { LATE_SALES_NOTE, SETTLED_EXCLUDE_LABEL, settledWindowText } from './ruleWindowCopy'

describe('rule window copy', () => {
  it('names the window length and where it ends, per ad product (BB-14: the newest settled day)', () => {
    expect(settledWindowText(30)).toBe('the last 30 days, ending at the newest day Amazon has settled (normally 8 days ago; 15 for Sponsored Brands and Display)')
    expect(settledWindowText(7)).toBe('the last 7 days, ending at the newest day Amazon has settled (normally 8 days ago; 15 for Sponsored Brands and Display)')
  })

  it('says why in plain words, and no longer promises a 2-day cut', () => {
    expect(LATE_SALES_NOTE).toBe('Amazon is still adding late sales to the newest days.')
    expect(settledWindowText(14)).not.toContain('2 days')
  })

  it('stores Sponsored Products’ lag as the exclude record', () => {
    expect(SETTLED_EXCLUDE_LABEL).toBe('Last 7 Days')
  })
})
