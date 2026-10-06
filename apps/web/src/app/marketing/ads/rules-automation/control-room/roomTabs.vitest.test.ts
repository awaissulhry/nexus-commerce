/**
 * CR rebuild 1 — the four tabs, and the six old tab names that still reach them (links the API sends and bookmarks).
 */
import { describe, expect, it } from 'vitest'
import { readLimitsView, readTab, tabHref, LIMITS_VIEWS, ROOM_TABS } from './roomTabs'

describe('the Control Room tabs', () => {
  it('four tabs, in the order the Owner chose', () => {
    expect(ROOM_TABS.map((t) => t.label)).toEqual(['Who acts', 'Limits', 'Campaigns', 'History'])
  })

  it('every old tab name opens the place its content moved to', () => {
    expect(readTab('today', null)).toEqual({ tab: 'who', view: 'done' })
    expect(readTab('levers', null)).toEqual({ tab: 'who', view: 'done' })
    expect(readTab('strategy', null)).toEqual({ tab: 'limits', view: 'done' })
    expect(readTab('guardrails', null)).toEqual({ tab: 'campaigns', view: 'done' })
    expect(readTab('activity', null)).toEqual({ tab: 'history', view: 'done' })
    expect(readTab('foresight', null)).toEqual({ tab: 'history', view: 'next' })
  })

  it('the new names read as themselves; History reads its view; anything else opens Who acts', () => {
    expect(readTab('campaigns', null)).toEqual({ tab: 'campaigns', view: 'done' })
    expect(readTab('history', 'next')).toEqual({ tab: 'history', view: 'next' })
    expect(readTab('history', 'nonsense')).toEqual({ tab: 'history', view: 'done' })
    expect(readTab(null, null)).toEqual({ tab: 'who', view: 'done' })
    expect(readTab('toString', null)).toEqual({ tab: 'who', view: 'done' })
  })

  it('links carry the view only for History and only when it is not the first one', () => {
    expect(tabHref('limits')).toBe('/marketing/ads/rules-automation/control-room?tab=limits')
    expect(tabHref('history', 'next')).toBe('/marketing/ads/rules-automation/control-room?tab=history&view=next')
    expect(tabHref('history', 'done')).toBe('/marketing/ads/rules-automation/control-room?tab=history')
    expect(tabHref('who', 'next')).toBe('/marketing/ads/rules-automation/control-room?tab=who')
  })
})

describe('the Limits views (CR rebuild 4)', () => {
  it('four views; the old Strategy tab and a missing or unknown view open Strategy', () => {
    expect(LIMITS_VIEWS.map((v) => v.label)).toEqual(['Strategy', 'Account brakes', 'Protected terms', 'Set on the server'])
    expect(readTab('strategy', null).tab).toBe('limits')
    expect(readLimitsView(null)).toBe('strategy')
    expect(readLimitsView('next')).toBe('strategy')
    expect(readLimitsView('brakes')).toBe('brakes')
    expect(readLimitsView('server')).toBe('server')
  })

  it('a Limits link carries its view, except the first one; other tabs never carry a Limits view', () => {
    expect(tabHref('limits', 'terms')).toBe('/marketing/ads/rules-automation/control-room?tab=limits&view=terms')
    expect(tabHref('limits', 'strategy')).toBe('/marketing/ads/rules-automation/control-room?tab=limits')
    expect(tabHref('limits')).toBe('/marketing/ads/rules-automation/control-room?tab=limits')
    expect(tabHref('history', 'brakes')).toBe('/marketing/ads/rules-automation/control-room?tab=history')
    expect(tabHref('campaigns', 'server')).toBe('/marketing/ads/rules-automation/control-room?tab=campaigns')
  })
})
