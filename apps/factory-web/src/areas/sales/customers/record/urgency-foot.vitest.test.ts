import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import type { CustomerUrgency } from '../../../_shared/customer-urgency/api'
import { urgencyFootOf, urgencyFootTouched, workFootOf } from './urgency-foot'

/**
 * F-CW-302 (10-design §3.6; lead settle S35) — the Work tab's foot line: the order the rows stand in, in the reader's words, and the
 * customer's urgency state ("3 of at most 3 urgent now" / "Customer urgency is off for Seed Racing · Portal settings ›"). Host-only:
 * the read is made ONLY on the customer's Work tab and ONLY with workorders.view. Made-up customers only.
 */

const use = (used: number, max: number) => ({ used, max, agreed: max, left: Math.max(0, max - used), over: used > max, words: { it: '', en: '' } })
const company = (code: string, used: number, max: number): CustomerUrgency['companies'][number] => ({ company: { id: code, code, name: code }, use: use(used, max), mayOverride: true, orders: [] })
const read = (on: boolean, companies: CustomerUrgency['companies'], max = 3): Pick<CustomerUrgency, 'urgency' | 'companies'> => ({ urgency: { on, max, dormant: null }, companies })
const PORTAL = '/office/sales/customers/c1?tab=portal#production-limits'
const line = (over: Partial<Parameters<typeof workFootOf>[0]> = {}) => workFootOf({ sort: 'urgent', sortWord: 'Most urgent first', customer: 'Seed Racing', foot: { on: true, used: 3, max: 3 }, portalHref: PORTAL, mayPortal: true, ...over })

describe('F-CW-302: the customer\'s urgency for the foot', () => {
  it('"3 of at most 3": the marks that count and the quota; a customer at two companies has two lists — both summed', () => {
    expect(urgencyFootOf(read(true, [company('A', 3, 3)]))).toEqual({ on: true, used: 3, max: 3 })
    expect(urgencyFootOf(read(true, [company('A', 2, 3), company('B', 1, 3)]))).toEqual({ on: true, used: 3, max: 6 })
    expect(urgencyFootOf(read(false, [company('A', 0, 3)]))).toEqual({ on: false, used: 0, max: 3 })
    // No company in the answer: the customer's own quota, nothing marked.
    expect(urgencyFootOf(read(true, [], 5))).toEqual({ on: true, used: 0, max: 5 })
  })

  it('read again when the customer\'s urgency or its portal settings change — on nothing else', () => {
    expect(urgencyFootTouched('brand_production.urgency_changed')).toBe(true)
    expect(urgencyFootTouched('partner_portal.settings_changed')).toBe(true)
    for (const type of ['sales_order.updated', 'brand_production.stage_reached', 'thread.message_posted']) expect(urgencyFootTouched(type), type).toBe(false)
  })
})

describe('F-CW-302: the foot line', () => {
  it('"Most urgent first" with its rule and what follows; the customer\'s marks; no door while the switch is on', () => {
    expect(line()).toEqual({
      urgent: { rule: { ns: 'sheet', key: 'sort.urgentRule', params: { customer: 'Seed Racing' } }, after: { ns: 'parties', key: 'customers.work.foot.after' } },
      sorted: null,
      urgency: { ns: 'parties', key: 'customers.work.foot.use', params: { used: 3, max: 3 } },
      portalHref: null,
    })
  })

  it('the switch off: the rule has no middle part, the line says so, and the door is there only for a reader who may change it', () => {
    const off = line({ foot: { on: false, used: 0, max: 3 } })
    expect(off.urgent?.rule).toEqual({ ns: 'sheet', key: 'sort.urgentRuleOff' })
    expect(off.urgency).toEqual({ ns: 'parties', key: 'customers.work.foot.off', params: { customer: 'Seed Racing' } })
    expect(off.portalHref).toBe(PORTAL)
    expect(line({ foot: { on: false, used: 0, max: 3 }, mayPortal: false }).portalHref).toBeNull()
  })

  it('another sort: "Sorted: Newest first."; not read (no workorders.view, or it failed): the sort only, never "0"', () => {
    const newest = line({ sort: null, sortWord: 'Newest first' })
    expect(newest.urgent).toBeNull()
    expect(newest.sorted).toEqual({ ns: 'parties', key: 'customers.work.foot.sorted', params: { sort: 'Newest first' } })
    expect(newest.urgency).toEqual({ ns: 'parties', key: 'customers.work.foot.use', params: { used: 3, max: 3 } })
    const unread = line({ foot: null })
    expect(unread.urgency).toBeNull()
    expect(unread.portalHref).toBeNull()
    expect(unread.urgent?.rule).toEqual({ ns: 'sheet', key: 'sort.urgentRule', params: { customer: 'Seed Racing' } })
  })

  it('the words, in both languages — never "the planning order"; the door is the tab\'s real name', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      for (const key of ['customers.work.foot.after', 'customers.work.foot.sorted', 'customers.work.foot.use', 'customers.work.foot.off', 'customers.tab.portal']) expect(t(key, { sort: 'x', used: 3, max: 3, customer: 'Seed Racing' }), `${locale} ${key}`).not.toBe(key)
      for (const key of ['sort.urgent', 'sort.urgentRule', 'sort.urgentRuleOff']) expect(s(key, { customer: 'Seed Racing' }), `${locale} ${key}`).not.toBe(key)
      expect(`${s('sort.urgentRule', { customer: 'Seed Racing' })} ${t('customers.work.foot.after')}`.toLowerCase(), locale).not.toMatch(/planning order|ordine di pianificazione/)
    }
    const en = createTranslator('en', messagesFor('en', ['parties']).parties!)
    const it_ = createTranslator('it', messagesFor('it', ['parties']).parties!)
    expect(en('customers.work.foot.use', { used: 3, max: 3 })).toBe('Customer urgency: 3 of at most 3 urgent now.')
    expect(it_('customers.work.foot.use', { used: 3, max: 3 })).toBe('Urgenza cliente: 3 di al massimo 3 urgenti ora.')
    expect(en('customers.work.foot.off', { customer: 'Seed Racing' })).toBe('Customer urgency is off for Seed Racing')
    expect(en('customers.work.foot.after')).toBe('Orders that left production follow, newest first.')
    expect([en('customers.tab.portal'), it_('customers.tab.portal')]).toEqual(['Portal settings', 'Impostazioni del portale'])
  })
})

describe('F-CW-302: host-only — the read is the Work tab\'s, with workorders.view (S35; source)', () => {
  const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('the page reads it only while the Work tab is shown and only with workorders.view; the tab draws the line under its sheet', () => {
    const page = source('./CustomerRecord.tsx')
    expect(page).toContain("const urgencyFoot = useUrgencyFoot(partyId, tab === 'work' && can.orders && workCan.workorders)")
    expect(page).toContain("mayPortal={session.permissions.includes('partners.production.manage')")
    const tab = source('./view/WorkTab.tsx')
    expect(tab).toContain('<WorkFoot line={foot} />')
    expect(tab).toContain('portalHref: `${prefix}${basePath}?tab=portal#${LIMITS_ANCHOR}`')
    // The read is the shared one the work order's Customer card makes — no second route, no rule of our own.
    expect(source('./urgency-foot.ts')).toContain("import { getCustomerUrgency, type CustomerUrgency } from '../../../_shared/customer-urgency/api'")
    // A view never fetches: the line draws its model.
    expect(source('./view/WorkFoot.tsx')).not.toMatch(/useUrgencyFoot|getCustomerUrgency|useOfficeApi/)
  })

  it('Sales › Orders and Made to measure draw no foot and make no such read', () => {
    for (const host of ['../../orders/list/OrdersPage.tsx', '../../mtm/MtmPage.tsx', '../../orders/list/use-orders-sheet.ts', '../../orders/list/view/OrdersListView.tsx']) expect(source(host), host).not.toMatch(/WorkFoot|useUrgencyFoot|getCustomerUrgency/)
  })
})
