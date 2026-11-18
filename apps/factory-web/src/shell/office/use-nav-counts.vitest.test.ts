import { describe, expect, it } from 'vitest'
import { areaSubNavGroups } from '@nexus/ui/patterns/shell/index'
import { createTranslator, messagesFor } from '../../lib/i18n/messages'
import { LOCALES } from '../../lib/i18n/locales'
import { officeNavFor, OFFICE_NAV, translateNav } from '../nav/office-nav'
import { permissionCheck } from '../../lib/session/session'
import { INCOMING_WAITING, NAV_COUNT_EVENTS, navCountsOf, navCountsWanted, withNavCountWords } from './use-nav-counts'

/**
 * F-SA-210 (sales plan N1, pick P1; 12-lists-board §1.3): the sub-sidebar's counts — Incoming's "N waiting on us". The pure part:
 * an unknown count has no key (no badge, never a guessed 0), only a person who reaches Incoming asks, the row's screen-reader
 * name says the count in words, and the live events that move it.
 */

const shell = (locale: (typeof LOCALES)[number]) => createTranslator(locale, messagesFor(locale, ['shell']).shell!)
const incomingOf = (nav: ReturnType<typeof officeNavFor>) => nav.areas.find((area) => area.id === 'sales')!.sections!.flatMap((section) => section.items).find((item) => item.id === 'sales-incoming')!

describe('the counts by badge key', () => {
  it('unknown (no answer, or a reader who lists no kind) → no key, so no badge', () => {
    expect(navCountsOf(null)).toEqual({})
    expect(navCountsOf({ count: null })).toEqual({})
  })
  it('a known count, 0 included (the design system draws a badge only above 0)', () => {
    expect(navCountsOf({ count: 3 })).toEqual({ [INCOMING_WAITING]: 3 })
    expect(navCountsOf({ count: 0 })).toEqual({ [INCOMING_WAITING]: 0 })
  })
  it('only a person who reaches Incoming asks (sales.inquiries.view)', () => {
    expect(navCountsWanted(['sales.inquiries.view', 'orders.view'])).toBe(true)
    expect(navCountsWanted(['orders.view', 'parties.view'])).toBe(false)
    expect(navCountsWanted([])).toBe(false)
  })
  it('the live events that move it: requests, catalogue orders and change requests', () => {
    for (const type of ['inquiry.received', 'portal_order_request.sent', 'order_change_request.asked', 'order_change_request.answered']) expect(NAV_COUNT_EVENTS).toContain(type)
    expect(NAV_COUNT_EVENTS).not.toContain('sales_order.status_changed')
  })
})

describe('the Incoming row with its count', () => {
  const nav = officeNavFor(permissionCheck(['sales.inquiries.view', 'orders.view']))
  it('says the count in words for a screen reader, in both languages; nothing changes while the count is unknown', () => {
    const en = shell('en')
    const words = (_badge: string, count: number) => en('nav.sales.incomingWaiting', { count })
    expect(withNavCountWords(nav, {}, words)).toBe(nav)
    expect(incomingOf(withNavCountWords(nav, { [INCOMING_WAITING]: 3 }, words)).ariaLabel).toBe('Incoming, 3 waiting on us')
    expect(shell('it')('nav.sales.incomingWaiting', { count: 1 })).toBe('In arrivo, 1 ferma da noi')
    expect(shell('it')('nav.sales.incomingWaiting', { count: 4 })).toBe('In arrivo, 4 ferme da noi')
    // The other rows keep their names.
    const named = withNavCountWords(nav, { [INCOMING_WAITING]: 3 }, words)
    expect(named.areas.find((area) => area.id === 'sales')!.sections![0]!.items.filter((item) => item.ariaLabel).map((item) => item.id)).toEqual(['sales-incoming'])
  })
  it('the design system draws the badge from the count: above 0 only, the words kept through the translation', () => {
    for (const locale of LOCALES) {
      const t = shell(locale)
      const counted = withNavCountWords(nav, { [INCOMING_WAITING]: 12 }, (_badge, count) => t('nav.sales.incomingWaiting', { count }))
      const translated = translateNav(counted, (key) => (key.startsWith('shell:') ? t(key.slice('shell:'.length)) : t(key)))
      const sales = translated.areas.find((area) => area.id === 'sales')!
      const row = (counts: Record<string, number>) => areaSubNavGroups(sales, { path: '/sales/orders', count: (badge) => counts[badge] }).flatMap((group) => group.items).find((item) => item.id === 'sales-incoming')!
      expect(row({ [INCOMING_WAITING]: 12 }).badge, locale).toBe('12')
      expect(row({ [INCOMING_WAITING]: 12 }).ariaLabel, locale).toBe(t('nav.sales.incomingWaiting', { count: 12 }))
      expect(row({ [INCOMING_WAITING]: 0 }).badge, locale).toBeUndefined()
      expect(row({}).badge, locale).toBeUndefined()
    }
  })
  it('the full manifest declares the badge on Incoming only', () => {
    expect(incomingOf(OFFICE_NAV).badge).toBe(INCOMING_WAITING)
  })
})
