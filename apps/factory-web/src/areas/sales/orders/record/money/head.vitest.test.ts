import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { canOf, deposit, order, PAID, SCHEDULE, SCHEDULE_NONE, SCHEDULE_OPEN, SENT_LINK, SETTLEMENT_SHIPPED, TODAY } from '../../_demo/fixtures'
import type { Order, Schedule } from '../../api'
import { moneyHeadOf } from './head'
import { MONEY_SECTIONS, PAYMENTS_ALIASES, PLAN_COLUMNS_FROM } from './layout'
import { amountsOf, type MoneyWord } from './word'

/**
 * F-OM-101 (order MONEY tab, 10-design §1–§3; 18-lead-settles L6) — the shell: the layout file draws the answer line and five sections
 * that stack, in the kit (in place), by the room; the tab's ONE answer line in every case, and the money wall said once. Every name and
 * number is made up.
 */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const part = (value: Schedule | null, problem: string | null = null) => ({ value, problem })
const keys = (words: readonly MoneyWord[]) => words.map((entry) => entry.key)
const head = (value: Order, over: { schedule?: Schedule | null; role?: Parameters<typeof canOf>[0]; today?: string; settlement?: typeof SETTLEMENT_SHIPPED | null } = {}) =>
  moneyHeadOf({ order: value, schedule: over.schedule === null ? null : part(over.schedule ?? SCHEDULE_OPEN), settlement: over.settlement ?? null, can: canOf(over.role ?? 'owner'), today: over.today ?? TODAY })

describe('F-OM-101: the shell — five sections that stack, in the kit, by the room', () => {
  it('the layout file draws the answer line, then Totals · Payments · Invoices & credit notes · Price check · Margin', () => {
    expect(MONEY_SECTIONS).toEqual(['totals', 'payments', 'invoices', 'price-check', 'margin'])
    expect(PAYMENTS_ALIASES).toEqual(['deposit', 'schedule'])
    const tab = source('./view/MoneyTab.tsx')
    expect(tab).toContain('<div className="fw-pt fw-om">')
    const order_ = ['<MoneyHead', '<TotalsSection', '<PaymentsSection', '<InvoicesSection', '<PriceCheckSection', '<MarginTab']
    for (let index = 1; index < order_.length; index += 1) expect(tab.indexOf(order_[index]!), order_[index]).toBeGreaterThan(tab.indexOf(order_[index - 1]!))
    // Each section is its own file, drawn with the Production kit's Section (reused IN PLACE: a type only was added to it).
    expect(source('./view/TotalsSection.tsx')).toContain('<Section id="totals"')
    expect(source('./view/PaymentsSection.tsx')).toContain('<Section id="payments"')
    expect(source('./view/InvoicesSection.tsx')).toContain('<Section id="invoices"')
    expect(source('../view/production/Kit.tsx')).toContain('id: SectionId | ChangesSectionId /* F-OC-101 */ | MoneySectionId /* F-OM-101 */')
    // #deposit and #schedule (the cards that went into Payments) land on it: elements at its top.
    expect(source('./view/PaymentsSection.tsx')).toContain('PAYMENTS_ALIASES.map((alias) => <span key={alias} id={alias} className="fw-om-alias" tabIndex={-1} />)')
    // The old file is gone (one path per job): the page draws the new layout and mounts the plan's windows once.
    expect(() => source('../view/MoneyTab.tsx')).toThrow()
    const page = source('../view/OrderRecordView.tsx')
    expect(page).toContain("import { MoneyTab } from '../money/view/MoneyTab'")
    expect(page.match(/<MoneyDialogs model=\{model\} actions=\{actions\} \/>/g)?.length).toBe(1)
  })

  it('the stylesheet: the room, never the viewport (no @media); the list and each request box are their own size containers; tokens only', () => {
    const css = source('./view/money.css')
    expect(css).not.toMatch(/@media/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    expect(css).toContain('.fw-om-pl { container: ompl / inline-size;')
    expect(css).toContain('container: omrq / inline-size;')
    for (const width of Object.values(PLAN_COLUMNS_FROM)) expect(css).toContain(`@container ompl (min-width: ${width}px)`)
    // Pairs only inside Totals (L6): its tiles | what is left from 1200 px of the section; the sections themselves always stack.
    expect(css).toContain('@container sec (min-width: 1200px)')
    expect(source('./view/MoneyTab.tsx')).not.toContain('fw-pt-pairs')
  })

  it('views draw their models and fetch nothing (no API client, no acts hook)', () => {
    const dir = new URL('./view/', import.meta.url)
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'))) {
      const text = readFileSync(new URL(file, dir), 'utf8')
      expect(text, file).not.toMatch(/lib\/api|use-money-acts|useMoneyActs|fetch\(/)
    }
  })
})

describe('F-OM-101: the tab\'s one answer line', () => {
  it('a deposit open: its amount and day, the page not sent yet, production waits; then the balance before shipping', () => {
    const answer = head(order('CONFIRMED'))
    expect(answer.reading).toBe(false)
    expect(answer.tone).toBe('warning')
    expect(keys(answer.parts)).toEqual(['moneyTab.head.depositOpen', 'moneyTab.head.pageNotSent', 'moneyTab.head.productionWaits', 'moneyTab.head.beforeShipping'])
    expect(answer.parts[0]).toMatchObject({ money: { amount: 228384 }, days: { date: '2026-11-04' } })
    expect(answer.parts[3]).toMatchObject({ pcts: { share: '70' }, days: { date: '2026-12-10' } })
    expect(answer.wall).toEqual([])
    expect(answer.closed).toBeNull()
  })

  it('the page sent (an instant, said as its day); overdue (danger); part paid: what is short', () => {
    const sent = order('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [deposit({ link: SENT_LINK })] } })
    expect(head(sent).parts[1]).toEqual({ key: 'moneyTab.head.pageSent', instants: { date: SENT_LINK.sentAt } })
    const late = head(order('CONFIRMED'), { today: '2026-11-10' })
    expect(late.tone).toBe('danger')
    expect(late.parts[0]!.key).toBe('moneyTab.head.depositOverdue')
    const short = order('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [deposit({ link: SENT_LINK, paidAmount: 226884 })] } })
    expect(head(short).parts.slice(0, 2)).toEqual([{ key: 'moneyTab.head.depositShort', money: { amount: 1500 } }, { key: 'moneyTab.head.productionWaits' }])
  })

  it('a priced change\'s extra deposit beside the paid one (L8): "deposit paid · extra deposit open (change rev 1)"', () => {
    const extra = deposit({ id: 'extra-1', amount: 4392, paidAmount: 0, dueDate: '2026-11-25' })
    const value = order('IN_PRODUCTION', { chain: { ...order('IN_PRODUCTION').chain, depositRequests: [PAID, extra] } })
    const schedule: Schedule = { ...SCHEDULE, requests: [{ id: 'extra-1', milestoneId: null, kind: 'ACCONTO', stepKind: 'DEPOSIT', status: 'OPEN', amount: 4392, paid: 0, dueDate: '2026-11-25', fiscalDocument: 'TD02', fromChange: { amendmentId: 'a1', revision: 1 } }] }
    const answer = head(value, { schedule })
    expect(keys(answer.parts).slice(0, 2)).toEqual(['moneyTab.head.depositPaid', 'moneyTab.head.extraOpenFrom'])
    expect(answer.parts[1]).toEqual({ key: 'moneyTab.head.extraOpenFrom', money: { amount: 4392 }, params: { revision: 1 } })
    // Without the plan read's change (S1 not there yet): still the extra deposit, without the revision.
    expect(head(value).parts[1]!.key).toBe('moneyTab.head.extraOpen')
  })

  it('an open goods invoice replaces "deposit paid": invoiced in full · what is still to pay on it', () => {
    const shipped = order('SHIPPED')
    const paidPlan: Schedule = { ...SCHEDULE, steps: SCHEDULE.steps.map((step) => ({ ...step, status: 'PAID' as const })) }
    const answer = head(shipped, { schedule: paidPlan, settlement: { ...SETTLEMENT_SHIPPED, fullyInvoiced: true } })
    expect(keys(answer.parts)).toEqual(['moneyTab.head.invoicedAll', 'moneyTab.head.stillToPayOn'])
    expect(answer.parts[1]).toEqual({ key: 'moneyTab.head.stillToPayOn', money: { amount: 532896 }, params: { number: 'FA-2026-00052' } })
  })

  it('nothing to collect yet (the terms); a deposit never asked (danger); settled; cancelled; reading', () => {
    const none = order('CONFIRMED', { depositRequired: false, chain: { ...order('CONFIRMED').chain, depositRequests: [] } })
    expect(head(none, { schedule: SCHEDULE_NONE }).parts).toEqual([{ key: 'moneyTab.head.nothingTerms', params: { terms: 'Bonifico 30 gg d.f.' } }])
    const missing = head(order('CONFIRMED', { chain: { ...order('CONFIRMED').chain, depositRequests: [] } }), { schedule: SCHEDULE_NONE })
    expect(missing.tone).toBe('danger')
    expect(keys(missing.parts)).toEqual(['moneyTab.head.depositMissing', 'moneyTab.head.productionWaits'])
    const settled = head(order('CLOSED', { settled: true }))
    expect(settled.tone).toBe('success')
    expect(settled.parts[0]!.key).toBe('moneyTab.head.settledOn')
    expect(settled.closed?.key).toBe('moneyTab.head.closed')
    expect(head(order('CANCELLED')).parts).toEqual([{ key: 'moneyTab.head.cancelled' }])
    expect(head(order('CONFIRMED'), { schedule: null }).reading).toBe(true)
    // A failed plan read still answers (without the balance's part): the section says its own failure.
    expect(moneyHeadOf({ order: order('CONFIRMED'), schedule: part(null, 'problem.read.unavailable'), settlement: null, can: canOf('owner'), today: TODAY }).reading).toBe(false)
  })

  it('the money wall: without the price grain the same line in words — no amount anywhere — and said ONCE for the tab', () => {
    for (const role of ['sales', 'manager'] as const) {
      const answer = head(order('CONFIRMED'), { role })
      expect(answer.parts.flatMap(amountsOf), role).toEqual([])
      expect(answer.parts[0]!.key, role).toBe('moneyTab.head.depositOpenWords')
      expect(answer.wall[0], role).toEqual({ key: 'moneyTab.head.wallPrice' })
    }
    // Sales sees invoices; the production manager does not: the second sentence, once.
    expect(head(order('CONFIRMED'), { role: 'sales' }).wall).toHaveLength(1)
    expect(head(order('CONFIRMED'), { role: 'manager' }).wall).toEqual([{ key: 'moneyTab.head.wallPrice' }, { key: 'money.noInvoiceRight' }])
    // Said once: the old Totals' "Shown to people who see prices" line is gone from the tab's files.
    for (const file of ['./view/TotalsSection.tsx', './view/PaymentsSection.tsx', './view/PlanRow.tsx', './view/MoneyTab.tsx']) expect(source(file), file).not.toContain("t('summary.noPrice')")
  })

  it('every word of the head exists in both languages with the same placeholders', () => {
    const heads = ['wallPrice', 'closed', 'cancelled', 'settledOn', 'settled', 'reading', 'depositMissing', 'productionWaits', 'depositPaid', 'depositWaived', 'extraOpen', 'extraOpenFrom', 'extraOpenWords', 'extraOpenFromWords', 'depositShort', 'depositPartPaid', 'depositOpen', 'depositOpenWords', 'depositOverdue', 'depositOverdueWords', 'pageSent', 'pageNotSent', 'beforeShipping', 'beforeShippingNoDay', 'balanceBeforeShipping', 'invoicedAll', 'stillToPayOn', 'invoicesOpen', 'allPaid', 'nothing', 'nothingTerms', 'restOnInvoice']
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of heads) expect(t(`moneyTab.head.${key}`, { amount: 'A', date: 'D', revision: 1, share: 'S', number: 'N', terms: 'T' }), `${locale} ${key}`).not.toMatch(/moneyTab\.|\{/)
    }
  })
})
