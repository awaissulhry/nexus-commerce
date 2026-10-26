import { describe, expect, it } from 'vitest'
import { NEW_RULE_FORM } from './ruleForm'
import { previewBody, whenItSends, type TimingPreview } from './whenItSends'

const AMAZON: TimingPreview = {
  scheduledFor: '2026-10-30T09:00:00Z',
  anchorUsed: 'DELIVERY',
  anchorDate: '2026-10-26T11:00:00Z',
  delayDays: 4,
  effectiveDelayDays: 4,
  source: 'rule-override',
  sendHour: 10,
  sendHourSource: 'rule',
  tz: 'Europe/Berlin',
  productType: 'jacket',
  channel: 'AMAZON',
}

describe('when it sends', () => {
  it('says delivered → first try → daily until day 30 for Amazon', () => {
    const w = whenItSends(AMAZON)
    expect(w.line).toBe('Delivered Mon 26 Oct → first try Fri 30 Oct 10:00 → daily until day 30')
    expect(w.steps).toEqual([
      { label: 'Delivered', when: 'Mon 26 Oct', detail: 'today, for this preview — a jacket order' },
      { label: 'First try', when: 'Fri 30 Oct 10:00', detail: 'delivery + 4 days · this rule’s own day · this rule’s fixed hour' },
      { label: 'If Amazon says too early', when: 'daily until day 30', detail: 'the last day is Wed 25 Nov' },
    ])
    expect(w.note).toBe('Buyer’s local time (Europe/Berlin). Delivery is our estimate when no carrier scan exists: shipped + 3 working days.')
  })

  it('says where the day comes from for an email rule counted from shipping', () => {
    const w = whenItSends({ ...AMAZON, channel: 'EBAY', anchorUsed: 'SHIP', source: 'timing-table', sendHourSource: 'window', effectiveDelayDays: 14 })
    expect(w.line).toBe('Shipped Mon 26 Oct → first try Fri 30 Oct 10:00 → one email, once per order')
    expect(w.steps[1].detail).toBe('shipping + 14 days · the product-type table (“jacket”) · the best hour of that weekday (Timing)')
    expect(w.steps[2]).toEqual({ label: 'If our email fails', when: 'again after 4, 8 and 16 hours', detail: 'three tries in all, once per order' })
    expect(whenItSends({ ...AMAZON, source: 'default', sendHourSource: 'none' }).steps[1].detail).toBe('delivery + 4 days · the built-in default (no row of the product-type table matched)')
  })

  it('says so when there is no date to count from', () => {
    expect(whenItSends({ ...AMAZON, scheduledFor: null, anchorDate: null }).line).toBe('No first try: the order has no date to count from.')
  })

  it('asks the preview with the unsaved timing, Amazon counted from delivery', () => {
    const body = previewBody({ ...NEW_RULE_FORM, scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', anchor: 'SHIP', productTypes: ['jacket', 'giacca'], firstTryMode: 'custom', firstTryDays: 6, fixedHour: true, sendHour: 9 })
    expect(body).toEqual({
      scope: 'AMAZON_PER_MARKETPLACE', marketplace: 'DE', productType: 'jacket', sendDelayDays: 6, anchor: 'DELIVERY', sendHourLocal: 9,
      skipWeekends: false, shiftToBestDay: false, minDaysSinceDelivery: 4, maxDaysSinceDelivery: 30,
    })
    expect(previewBody(NEW_RULE_FORM)).toMatchObject({ marketplace: null, productType: null, sendDelayDays: null, sendHourLocal: null })
  })
})
