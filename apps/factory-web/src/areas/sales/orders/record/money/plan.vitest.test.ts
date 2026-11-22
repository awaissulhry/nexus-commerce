import { describe, expect, it } from 'vitest'
import { depositGate as domainGate } from '@nexus/factory-domain/production/work-orders/release'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { canOf, deposit, order, PAID, SCHEDULE, SCHEDULE_NONE, SCHEDULE_OPEN, SENT_LINK, SETTLEMENT_SHIPPED, TD02, TODAY } from '../../_demo/fixtures' // F-OM-fx5w: + SETTLEMENT_SHIPPED
import type { DepositRequest, Milestone, Order, Schedule, Settlement } from '../../api' // F-OM-fx5w: + Settlement
import { depositGate } from '../../model'
import { stepAbilitiesOf, type StepAbilities } from '../schedule/model'
import { MONEY_PLAN_ACTS, MONEY_PLAN_REFUSAL_WORDS } from '@nexus/factory-domain/sales/orders/money-plan'
import { planHistoryHref, planOf, planRefusalOf, softLockedOf, type PlanRow } from './plan'
import { ApiError } from '../../../../../lib/api/errors'
import { amountsOf } from './word'

/**
 * F-OM-103 (order MONEY tab, 10-design §5; 18-lead-settles L8) — Payments, the ONE plan, read: one row per step and per request no step
 * names (the extra deposit right after the deposit), its pill, due words (a paid day is an instant, an open one a business day), notes,
 * "Set by hand", the ONE next act and the rest in ⋯ (hidden without the right, held only by state), the unfold, Earlier steps, the
 * head's answer; and the web gate = the release's gate. Every name and number is made up.
 */

const OWNER_STEPS: StepAbilities = { manageOrders: true, manageInvoices: true, waive: true }
const FINANCE_STEPS: StepAbilities = { manageOrders: false, manageInvoices: true, waive: false }
// F-OM-201: `moneyPlan` — the plan right (orders.moneyPlan, B-OM-010: the Owner and Finance once the server knows it; off by default).
// F-OM-202 (B-OM-022): `links` — Stop the page (links.manage: the Owner only; off by default).
const plan = (value: Order, over: { schedule?: Schedule; role?: Parameters<typeof canOf>[0]; stepCan?: StepAbilities | null; today?: string; stillToPay?: number | null; moneyPlan?: boolean; links?: boolean } = {}) =>
  planOf({ order: value, schedule: over.schedule ?? SCHEDULE_OPEN, settlement: null, can: { ...canOf(over.role ?? 'owner'), moneyPlan: over.moneyPlan ?? false, links: over.links ?? false }, stepCan: over.stepCan === undefined ? OWNER_STEPS : over.stepCan, today: over.today ?? TODAY, stillToPay: over.stillToPay ?? null })
const kinds = (rows: readonly PlanRow[]) => rows.map((row) => row.kind)
const acts = (row: PlanRow) => [row.act?.id ?? null, ...row.more.map((entry) => entry.id)]
const withRequests = (value: Order, requests: DepositRequest[]): Order => ({ ...value, chain: { ...value.chain, depositRequests: requests } })
const step = (over: Partial<Milestone>): Milestone => ({ ...SCHEDULE.steps[1]!, ...over })

describe('F-OM-103: one row per step, and per request no step names', () => {
  it('a confirmed order: the deposit (its request: anchor, the step\'s alias) and the balance before shipping', () => {
    const model = plan(order('CONFIRMED'))
    expect(kinds(model.rows)).toEqual(['DEPOSIT', 'BEFORE_SHIPPING'])
    const [first, balance] = model.rows as [PlanRow, PlanRow]
    expect(first.anchor).toBe(`about-DepositRequest-${deposit().id}`)
    expect(first.alias).toBe(`about-Step-${SCHEDULE.steps[0]!.id}`)
    expect(first.title).toEqual({ key: 'moneyTab.plan.title', words: { kind: { key: 'moneyTab.plan.kind.DEPOSIT' }, share: { key: 'moneyTab.plan.share', pcts: { share: '30' } } } })
    expect(first.pill).toEqual({ word: { key: 'moneyTab.plan.pill.OPEN' }, tone: 'warning' })
    expect(first.due).toEqual({ key: 'moneyTab.plan.due.on', days: { date: '2026-11-04' } })
    expect(first.notes.map((note) => note.word.key)).toEqual(['moneyTab.plan.note.productionWaits'])
    expect(first.unfolds && first.openAtFirst).toBe(true)
    expect(balance.anchor).toBe(`about-Step-${SCHEDULE.steps[1]!.id}`)
    expect(balance.notes.map((note) => note.word.key)).toEqual(['moneyTab.plan.note.holdsShipment'])
    expect(balance.unfolds).toBe(false)
  })

  it('L8: a priced change\'s extra deposit is a row by its request, right after the deposit, "of the change", with its change', () => {
    const extra = deposit({ id: 'extra-1', amount: 4392, paidAmount: 0, dueDate: '2026-11-25', depositPct: '30' })
    const schedule: Schedule = { ...SCHEDULE, requests: [{ id: 'extra-1', milestoneId: null, kind: 'ACCONTO', stepKind: 'DEPOSIT', status: 'OPEN', dueDate: '2026-11-25', fiscalDocument: 'TD02', fromChange: { amendmentId: 'a1', revision: 1 } }] }
    const model = plan(withRequests(order('IN_PRODUCTION'), [PAID, extra]), { schedule })
    expect(kinds(model.rows)).toEqual(['DEPOSIT', 'EXTRA', 'BEFORE_SHIPPING'])
    const row = model.rows[1]!
    expect(row.anchor).toBe('about-DepositRequest-extra-1')
    expect(row.fromChange).toEqual({ amendmentId: 'a1', revision: 1 })
    expect(row.title.words?.share).toEqual({ key: 'moneyTab.plan.shareOfChange', pcts: { share: '30' } })
    expect(row.notes.map((note) => note.word.key)).toEqual(['moneyTab.plan.note.extraWaits'])
    // Its page never sent: Send the page is its ONE act (Record a payment in its ⋯).
    expect(acts(row)).toEqual(['send', 'record', 'waive'])
    // The paid deposit is done: folded, no act.
    expect(model.rows[0]!.done && !model.rows[0]!.openAtFirst && model.rows[0]!.act === null).toBe(true)
  })

  it('a typed order without a schedule: its deposit request is the plan\'s one row', () => {
    const model = plan(order('CONFIRMED'), { schedule: SCHEDULE_NONE })
    expect(kinds(model.rows)).toEqual(['DEPOSIT'])
    expect(model.rows[0]!.step).toBeNull()
    expect(model.rows[0]!.alias).toBeNull()
  })

  it('the earlier steps: a step an amendment replaced, a request cancelled that no step names — kept, never deleted', () => {
    const replaced = step({ id: 'old-balance', status: 'CANCELLED', statusNote: 'Remade by amendment 1.' })
    const model = plan(withRequests(order('CONFIRMED'), [deposit(), deposit({ id: 'old-request', status: 'CANCELLED' })]), { schedule: { ...SCHEDULE_OPEN, cancelled: [replaced] } })
    expect(model.earlier.map((row) => [row.key, row.words.key])).toEqual([['old-balance', 'moneyTab.plan.earlier.step'], ['old-request', 'moneyTab.plan.earlier.cancelled']])
    expect(kinds(model.rows)).toEqual(['DEPOSIT', 'BEFORE_SHIPPING'])
  })
})

describe('F-OM-103: the row\'s state in words', () => {
  it('overdue (an advance past its day), part paid (what is left), paid (its day is an instant), waived', () => {
    const late = plan(order('CONFIRMED'), { today: '2026-11-10' }).rows[0]!
    expect(late.pill).toEqual({ word: { key: 'moneyTab.plan.pill.OVERDUE' }, tone: 'danger' })
    expect(late.due).toEqual({ key: 'moneyTab.plan.due.overdueSince', days: { date: '2026-11-04' } })
    const part = plan(withRequests(order('CONFIRMED'), [deposit({ link: SENT_LINK, paidAmount: 100000 })])).rows[0]!
    expect(part.pill.word.key).toBe('moneyTab.plan.pill.PART')
    expect(part.left).toBe(128384)
    const paid = plan(order('IN_PRODUCTION'), { schedule: SCHEDULE }).rows[0]!
    expect(paid.due).toEqual({ key: 'moneyTab.plan.due.paidOn', instants: { date: SCHEDULE.steps[0]!.paidAt } })
    expect(paid.pill.tone).toBe('success')
    const waived = plan(withRequests(order('CONFIRMED'), [deposit({ status: 'WAIVED' })]), { schedule: { ...SCHEDULE_OPEN, steps: SCHEDULE_OPEN.steps.map((entry) => (entry.kind === 'DEPOSIT' ? { ...entry, status: 'WAIVED' as const } : entry)) } }).rows[0]!
    expect(waived.pill).toEqual({ word: { key: 'moneyTab.plan.pill.WAIVED' }, tone: 'neutral' })
    expect(waived.due.key).toBe('moneyTab.plan.due.waived')
  })

  it('M4-B1: an on-invoice step is paid with the invoices (the plan read), part covered, never overdue', () => {
    const onInvoice = (over: Partial<Milestone>) => ({ ...SCHEDULE, steps: [SCHEDULE.steps[0]!, step({ id: 'oi', kind: 'ON_INVOICE', dueDate: '2026-10-01', depositRequestId: null, ...over })] })
    const settled = plan(order('SHIPPED'), { schedule: onInvoice({ settledBy: 'INVOICES' }) }).rows[1]!
    expect(settled.done).toBe(true)
    expect(settled.pill.word.key).toBe('moneyTab.plan.pill.PAID')
    expect(settled.due.key).toBe('moneyTab.plan.due.paidWithInvoices')
    const covered = plan(order('SHIPPED'), { schedule: onInvoice({ coveredByInvoices: 300000 }), today: '2026-11-20' }).rows[1]!
    expect(covered.pill.word.key).toBe('moneyTab.plan.pill.PART')
    expect(covered.left).toBe(532896 - 300000)
    // Before the plan read: open, "as the invoice says", paid when the goods' invoice is paid — never "Overdue".
    const before = plan(order('SHIPPED'), { schedule: onInvoice({}), today: '2026-11-20' }).rows[1]!
    expect(before.pill.word.key).toBe('moneyTab.plan.pill.OPEN')
    expect(before.due.key).toBe('moneyTab.plan.due.asInvoice')
    expect(before.notes.map((note) => note.word.key)).toEqual(['moneyTab.plan.note.paidWithInvoice'])
    expect(before.invoice).toEqual({ id: '0190f0e2-2121-7000-8000-000000000002', number: 'FA-2026-00052' })
  })

  it('"Set by hand" from the plan read\'s audit (who, when; the reason with the price grain)', () => {
    const hand = { act: 'MOVE_DUE', at: '2026-11-18T10:44:00Z', by: 'Bea Esempio', reason: 'The customer pays before the fair.' }
    const row = plan(order('CONFIRMED'), { schedule: { ...SCHEDULE_OPEN, steps: SCHEDULE_OPEN.steps.map((entry) => (entry.kind === 'BEFORE_SHIPPING' ? { ...entry, byHand: hand } : entry)) } }).rows[1]!
    expect(row.byHand).toEqual({ word: { key: 'moneyTab.plan.byHand.who', words: { what: { key: 'moneyTab.plan.byHand.what.MOVE_DUE' } }, params: { by: 'Bea Esempio' }, instants: { date: hand.at } }, reason: hand.reason })
    expect(MONEY_PLAN_ACTS).toContain('ACCEPT_SHORT')
    const other = plan(order('CONFIRMED'), { schedule: { ...SCHEDULE_OPEN, steps: SCHEDULE_OPEN.steps.map((entry) => ({ ...entry, byHand: { act: 'SOMETHING_NEW', at: hand.at, by: null } })) } }).rows[0]!
    expect(other.byHand!.word).toEqual({ key: 'moneyTab.plan.byHand.when', words: { what: { key: 'moneyTab.plan.byHand.what.OTHER' } }, instants: { date: hand.at } })
  })
})

describe('F-OM-103 / 104: the acts — hidden without the right, held only by state', () => {
  it('the owner: Send the page while never sent (its ONE act), Record a payment and Waive… in its ⋯; Open for payment on the balance', () => {
    const model = plan(order('CONFIRMED'))
    expect(acts(model.rows[0]!)).toEqual(['send', 'record', 'waive'])
    // Once the page went (or money came): Record a payment is the act, the page again in its ⋯.
    const sent = plan(withRequests(order('CONFIRMED'), [deposit({ link: SENT_LINK })])).rows[0]!
    expect(acts(sent)).toEqual(['record', 'send', 'waive'])
    expect(sent.more.find((entry) => entry.id === 'send')!.label).toEqual({ key: 'moneyTab.plan.act.sendAgain' })
    expect(model.rows[0]!.more.find((entry) => entry.id === 'waive')!.label).toEqual({ key: 'moneyTab.plan.act.waive' })
    // F-OM-201 (B-OM-018): Open for payment is the plan right's now — without it no Open for payment (never held).
    expect(acts(model.rows[1]!)).toEqual([null, 'waive'])
    expect(plan(order('CONFIRMED'), { moneyPlan: true }).rows[1]!.act).toMatchObject({ id: 'open', held: null, needsDay: false })
  })

  // F-OM-202 (B-OM-022, S3 #1857): the page's own id comes with the order read; Stop the page is the Owner's only (links.manage).
  it('Stop the page… — a live page with its id, links.manage only; never the row\'s ONE act; hidden for everyone else', () => {
    const live = withRequests(order('CONFIRMED'), [deposit({ link: { ...SENT_LINK, id: '0190f0e2-1616-7000-8000-000000000009' } })])
    expect(acts(plan(live, { links: true }).rows[0]!)).toEqual(['record', 'send', 'stopPage', 'waive'])
    expect(plan(live, { links: true }).rows[0]!.more.find((entry) => entry.id === 'stopPage')).toEqual({ id: 'stopPage', label: { key: 'moneyTab.plan.act.stopPage' }, held: null })
    // Finance (no links.manage), an older read without the id, a page no longer live: no door at all.
    expect(acts(plan(live).rows[0]!)).not.toContain('stopPage')
    expect(acts(plan(withRequests(order('CONFIRMED'), [deposit({ link: SENT_LINK })]), { links: true }).rows[0]!)).not.toContain('stopPage')
    expect(acts(plan(withRequests(order('CONFIRMED'), [deposit({ link: { ...SENT_LINK, id: 'l-1', state: 'REVOKED' } })]), { links: true }).rows[0]!)).not.toContain('stopPage')
    // A closed order: no act on any row.
    expect(acts(plan(withRequests(order('CLOSED'), [deposit({ link: { ...SENT_LINK, id: 'l-1' } })]), { links: true }).rows[0]!)).not.toContain('stopPage')
  })

  it('Finance records and sends but does not waive; Sales (no payments.record, no grain) and Read-only see no money act at all', () => {
    expect(acts(plan(order('CONFIRMED'), { role: 'finance', stepCan: FINANCE_STEPS }).rows[0]!)).toEqual(['send', 'record'])
    const sales = plan(order('CONFIRMED'), { role: 'sales', stepCan: stepAbilitiesOf(['orders.manage']) })
    expect(acts(sales.rows[0]!)).toEqual([null])
    // B-OM-018: Sales (orders.manage, no price) no longer opens a payment request for money it cannot see.
    expect(acts(sales.rows[1]!)).toEqual([null])
    // Held words for a right are gone (F-OM-104): nothing in any row is held for want of a right.
    for (const row of sales.rows) for (const entry of [row.act, ...row.more]) if (entry?.held) expect(entry.held.key).not.toMatch(/noManage|noInvoice|noWaive|noPayments|noPrice/)
    const reader = plan(order('CONFIRMED'), { role: 'manager', stepCan: stepAbilitiesOf([]) })
    for (const row of reader.rows) expect(acts(row), row.anchor).toEqual([null])
  })

  it('held by state, in words: money placed on it is not waived; goods have left: the balance is not opened', () => {
    const part = plan(withRequests(order('CONFIRMED'), [deposit({ link: SENT_LINK, paidAmount: 100000 })])).rows[0]!
    expect(part.more.find((entry) => entry.id === 'waive')!.held).toEqual({ key: 'schedule.verbs.held.partPaid' })
    const shipped = plan(order('PARTLY_SHIPPED'), { schedule: SCHEDULE, moneyPlan: true }).rows[1]!
    expect(shipped.act).toMatchObject({ id: 'open', held: { key: 'schedule.verbs.held.goodsLeft' } })
  })

  it('P0-B4: Invoice this step only while a paid part waits for its TD02 (none made yet); a closed order: no act', () => {
    const paidPlan = plan(withRequests(order('IN_PRODUCTION', { chain: { ...order('IN_PRODUCTION').chain, invoices: [] } }), [PAID]), { schedule: SCHEDULE })
    expect(acts(paidPlan.rows[0]!)).toContain('invoiceStep')
    const invoiced = plan(withRequests(order('IN_PRODUCTION', { chain: { ...order('IN_PRODUCTION').chain, invoices: [TD02] } }), [PAID]), { schedule: SCHEDULE })
    expect(acts(invoiced.rows[0]!)).not.toContain('invoiceStep')
    const closed = plan(order('CLOSED'), { schedule: SCHEDULE })
    expect(closed.final).toBe(true)
    for (const row of closed.rows) expect(acts(row)).toEqual([null])
  })
})

describe('F-OM-201: the plan\'s hand acts — orders.moneyPlan (amount acts: + the price grain), hidden without it, held only by state', () => {
  const ids = (row: PlanRow) => row.more.map((entry) => entry.id)
  const heldOf = (row: PlanRow, id: string) => row.more.find((entry) => entry.id === id)?.held ?? null

  it('an open deposit: Change the deposit… · Move due day… · Change amount… · Rename… · Remove step… (the only open step but one)', () => {
    const row = plan(order('CONFIRMED'), { moneyPlan: true }).rows[0]!
    expect(ids(row)).toEqual(['record', 'REPLACE_DEPOSIT', 'MOVE_DUE', 'CHANGE_STEP', 'RENAME_STEP', 'REMOVE_STEP', 'waive'])
    for (const id of ['REPLACE_DEPOSIT', 'MOVE_DUE', 'CHANGE_STEP', 'RENAME_STEP', 'REMOVE_STEP']) expect(heldOf(row, id), id).toBeNull()
    // Where the rest may go: the other open step with no money on it.
    expect(row.restTo.map((entry) => entry.id)).toEqual([SCHEDULE.steps[1]!.id])
  })

  it('money placed on it: Change the deposit… and the amount acts held in words; Accept short… offered (L1)', () => {
    const row = plan(withRequests(order('CONFIRMED'), [deposit({ link: SENT_LINK, paidAmount: 226884 })]), { moneyPlan: true }).rows[0]!
    expect(ids(row)).toContain('ACCEPT_SHORT')
    for (const id of ['REPLACE_DEPOSIT', 'CHANGE_STEP', 'REMOVE_STEP']) expect(heldOf(row, id), id).toEqual({ key: 'moneyTab.plan.held.moneyPlaced' })
    expect(heldOf(row, 'MOVE_DUE')).toBeNull()
    // A step with money on it is never where the rest goes.
    expect(plan(withRequests(order('CONFIRMED'), [deposit({ link: SENT_LINK, paidAmount: 100000 })]), { moneyPlan: true }).rows[1]!.restTo).toEqual([])
  })

  it('the only open step takes the whole order: Change amount… and Remove step… held; an on-invoice step\'s day comes from the invoice', () => {
    const onlyBalance = plan(order('IN_PRODUCTION'), { schedule: SCHEDULE, moneyPlan: true }).rows[1]!
    // F-OM-fx3 (W-16): the words fit the plan — the deposit is paid, so no OTHER open step takes the rest.
    expect(heldOf(onlyBalance, 'CHANGE_STEP')).toEqual({ key: 'moneyTab.plan.held.noRest' })
    expect(heldOf(onlyBalance, 'REMOVE_STEP')).toEqual({ key: 'moneyTab.plan.held.noRest' })
    expect(onlyBalance.restTo).toEqual([])
    const onInvoice = { ...SCHEDULE, steps: [SCHEDULE.steps[0]!, step({ id: 'oi', kind: 'ON_INVOICE', depositRequestId: null })] }
    expect(heldOf(plan(order('SHIPPED'), { schedule: onInvoice, moneyPlan: true }).rows[1]!, 'MOVE_DUE')).toEqual({ key: 'moneyTab.plan.held.dayFromInvoice' })
  })

  it('a balance opened for payment: Undo opening (nothing paid); after a waive: Ask for the deposit again…', () => {
    const opened = { ...SCHEDULE, steps: SCHEDULE.steps.map((entry) => (entry.kind === 'BEFORE_SHIPPING' ? { ...entry, depositRequestId: 'bal' } : entry)) }
    const balance = deposit({ id: 'bal', stepKind: 'BEFORE_SHIPPING', amount: 532896 })
    const row = plan(withRequests(order('IN_PRODUCTION'), [PAID, balance]), { schedule: opened, moneyPlan: true }).rows[1]!
    expect(ids(row)).toContain('UNDO_OPEN')
    expect(ids(row)).not.toContain('REPLACE_DEPOSIT')
    const waivedPlan = { ...SCHEDULE_OPEN, steps: SCHEDULE_OPEN.steps.map((entry) => (entry.kind === 'DEPOSIT' ? { ...entry, status: 'WAIVED' as const } : entry)) }
    const waived = plan(withRequests(order('CONFIRMED'), [deposit({ status: 'WAIVED' })]), { schedule: waivedPlan, moneyPlan: true }).rows[0]!
    expect(ids(waived)).toEqual(['ASK_AGAIN'])
  })

  it('the head: Change payment terms… · Add a step… (held on a closed order); none without the right or the price grain', () => {
    expect(plan(order('CONFIRMED'), { moneyPlan: true }).head.map((entry) => [entry.id, entry.held])).toEqual([['CHANGE_TERMS', null], ['ADD_STEP', null]])
    expect(plan(order('CLOSED'), { schedule: SCHEDULE, moneyPlan: true }).head).toEqual([{ id: 'CHANGE_TERMS', label: { key: 'moneyTab.plan.act.CHANGE_TERMS' }, held: { key: 'moneyTab.plan.held.final' } }])
    expect(plan(order('CONFIRMED')).head).toEqual([])
    expect(plan(order('CONFIRMED'), { role: 'sales', moneyPlan: true }).head).toEqual([])
    // No price grain: no amount act on any row (the money wall), the words-only acts stay.
    const words = plan(order('CONFIRMED'), { role: 'manager', moneyPlan: true, stepCan: null }).rows[0]!
    expect(ids(words)).toEqual(['MOVE_DUE', 'RENAME_STEP', 'REMOVE_STEP'])
  })

  it('without the right: no hand act anywhere (hidden, never held)', () => {
    for (const row of plan(order('CONFIRMED')).rows) for (const id of MONEY_PLAN_ACTS) expect(ids(row), id).not.toContain(id)
  })

  it('a refusal in this page\'s words (409 moneyPlan/<CODE>); the version moved; a SOFT-locked month', () => {
    const refused = (issues: string[], kind: 'conflict' | 'forbidden' = 'conflict', status = 409) => new ApiError(kind, status, 'refused', 'x', null, issues.map((path) => ({ path })))
    // S2: the planner's own refusals in the domain's words, both languages (one wording with the server).
    expect(planRefusalOf(refused(['moneyPlan/MONEY_PLACED']))).toEqual(MONEY_PLAN_REFUSAL_WORDS.MONEY_PLACED)
    expect(planRefusalOf(refused(['moneyPlan/SOMETHING_NEW']))).toEqual({ key: 'moneyTab.refusal.OTHER' })
    expect(planRefusalOf(refused(['body/version']))).toEqual({ key: 'moneyTab.refusal.MOVED' })
    expect(planRefusalOf(refused([], 'forbidden', 403))).toEqual({ key: 'moneyTab.refusal.FORBIDDEN' })
    expect(planRefusalOf(new Error('boom'))).toBeNull()
    expect(softLockedOf(refused(['period/SOFT_LOCKED']))).toBe(true)
    expect(softLockedOf(refused(['period/HARD_LOCKED']))).toBe(false)
  })
})

// ---- F-OM-fx3 (fix wave 3, the walk's W-01 / W-02 / W-03; B-OM-024, B-OM-025): a short deposit within the company's tolerance, a part
// payment over it (never "short"), and an accepted short that leaves its trace. Every name and number is made up.
describe('F-OM-fx3: short within the tolerance, part paid over it, accepted short', () => {
  const PART = deposit({ link: SENT_LINK, paidAmount: 226884 })
  const value = withRequests(order('CONFIRMED'), [PART])
  const planned = (short: { amount?: number; withinTolerance: boolean } | null | undefined): Schedule => ({
    ...SCHEDULE_OPEN,
    requests: [{ id: PART.id, milestoneId: SCHEDULE.steps[0]!.id, kind: 'ACCONTO', stepKind: 'DEPOSIT', status: 'OPEN', dueDate: '2026-11-04', fiscalDocument: 'TD02', ...(short === undefined ? {} : { short }) }],
    tolerance: 2500,
  })

  it('W-01: within the tolerance, Accept short (bank charges)… is the row\'s ONE act (Record a payment in its ⋯), with the hint and the answer', () => {
    for (const [role, stepCan] of [['owner', OWNER_STEPS], ['finance', FINANCE_STEPS]] as const) {
      const model = plan(value, { schedule: planned({ amount: 1500, withinTolerance: true }), role, stepCan, moneyPlan: true, stillToPay: 534396 })
      const row = model.rows[0]!
      expect(row.act?.id, role).toBe('ACCEPT_SHORT')
      expect(row.more.map((entry) => entry.id), role).toContain('record')
      expect(row.short, role).toEqual({ amount: 1500, within: true })
      expect(row.hint, role).toEqual({ key: 'moneyTab.plan.shortHint', money: { amount: 1500 } })
      expect(model.answer.map((entry) => entry.key), role).toContain('moneyTab.plan.answer.short')
      expect(model.answer.find((entry) => entry.key === 'moneyTab.plan.answer.short'), role).toEqual({ key: 'moneyTab.plan.answer.short', money: { amount: 1500 } })
    }
    // A reader who may not accept it (no plan right): Record a payment stays the act, no Accept short anywhere.
    const plain = plan(value, { schedule: planned({ amount: 1500, withinTolerance: true }), role: 'finance', stepCan: FINANCE_STEPS })
    expect(acts(plain.rows[0]!)[0]).toBe('record')
    expect(acts(plain.rows[0]!)).not.toContain('ACCEPT_SHORT')
  })

  it('W-02: over the tolerance (or not said), a part payment is "part paid", never short; Accept short only for orders.waive (the Owner)', () => {
    for (const short of [{ amount: 1500, withinTolerance: false }, undefined, null]) {
      const finance = plan(value, { schedule: planned(short), role: 'finance', stepCan: FINANCE_STEPS, moneyPlan: true, stillToPay: 534396 })
      const row = finance.rows[0]!
      expect(row.short?.within, JSON.stringify(short)).toBe(false)
      expect(row.hint, JSON.stringify(short)).toBeNull()
      expect(acts(row), JSON.stringify(short)).not.toContain('ACCEPT_SHORT')
      expect(row.act?.id, JSON.stringify(short)).toBe('record')
      expect(finance.answer.map((entry) => entry.key), JSON.stringify(short)).toContain('moneyTab.plan.answer.partPaid')
      expect(finance.answer.map((entry) => entry.key), JSON.stringify(short)).not.toContain('moneyTab.plan.answer.short')
      // The Owner (orders.waive) may accept it — never as the row's ONE act (a fresh code follows).
      const owner = plan(value, { schedule: planned(short), role: 'owner', stepCan: OWNER_STEPS, moneyPlan: true }).rows[0]!
      expect(owner.act?.id, JSON.stringify(short)).toBe('record')
      expect(owner.more.map((entry) => entry.id), JSON.stringify(short)).toContain('ACCEPT_SHORT')
    }
  })

  it('W-02: a reader without the price grain learns "part paid" from the plan read (no amount), never "short"', () => {
    const words = plan(value, { schedule: planned({ withinTolerance: true }), role: 'sales', stepCan: null })
    const row = words.rows[0]!
    expect(row.pill.word.key).toBe('moneyTab.plan.pill.PART')
    expect(row.short).toEqual({ amount: null, within: true })
    expect(row.hint).toBeNull()
    expect(words.answer).toEqual([{ key: 'moneyTab.plan.answer.partPaid' }])
    expect(words.answer.flatMap(amountsOf)).toEqual([])
  })

  it('W-03: an accepted short tags the row "Set by hand" with who, day and reason, and says the missing part stays owed', () => {
    const at = '2026-11-03T10:05:00.000Z'
    const accepted = deposit({ link: SENT_LINK, status: 'PAID', paidAt: at, paidAmount: 228284 })
    const schedule: Schedule = { ...SCHEDULE, requests: [{ id: accepted.id, milestoneId: SCHEDULE.steps[0]!.id, kind: 'ACCONTO', stepKind: 'DEPOSIT', status: 'PAID', dueDate: '2026-11-04', fiscalDocument: 'TD02', acceptedShort: { short: 100, why: 'BANK_CHARGES', reason: 'The bank kept its charges.', at, by: 'Bea Esempio' } }] }
    const row = plan(withRequests(order('CONFIRMED'), [accepted]), { schedule }).rows[0]!
    expect(row.byHand).toEqual({ word: { key: 'moneyTab.plan.byHand.who', words: { what: { key: 'moneyTab.plan.byHand.what.ACCEPT_SHORT' } }, params: { by: 'Bea Esempio' }, instants: { date: at } }, reason: 'The bank kept its charges.' })
    expect(row.notes.map((note) => note.word)).toContainEqual({ key: 'moneyTab.plan.note.owedOnInvoice', money: { amount: 100 } })
    expect(row.pill.word.key).toBe('moneyTab.plan.pill.PAID')
    // Without the price grain: the words without the amount.
    const words = plan(withRequests(order('CONFIRMED'), [accepted]), { schedule: { ...schedule, requests: schedule.requests!.map((request) => ({ ...request, acceptedShort: { ...request.acceptedShort!, short: undefined } })) }, role: 'sales', stepCan: null }).rows[0]!
    expect(words.notes.map((note) => note.word)).toContainEqual({ key: 'moneyTab.plan.note.owedOnInvoiceWords' })
    expect(words.notes.flatMap((note) => amountsOf(note.word))).toEqual([])
  })
})

// ---- F-OM-fx3 (W-05; B-OM-029): a cancelled order owes nothing — even on an older answer that still names an open step. ----
describe('F-OM-fx3: a cancelled order shows no money due', () => {
  it('its open steps read "Cancelled · not owed" (no act, nothing left, never overdue); the answer says nothing is owed; paid stays paid', () => {
    const older: Schedule = { ...SCHEDULE, stillOpen: 532896, overdue: 532896 }
    const model = plan(order('CANCELLED'), { schedule: older, today: '2026-12-20', moneyPlan: true })
    const [deposit_, balance] = model.rows as [PlanRow, PlanRow]
    expect(deposit_.pill.word.key).toBe('moneyTab.plan.pill.PAID')
    expect(balance.pill).toEqual({ word: { key: 'moneyTab.plan.pill.CANCELLED' }, tone: 'neutral' })
    expect(balance.due).toEqual({ key: 'moneyTab.plan.due.notOwed' })
    expect(balance.left).toBeNull()
    expect(balance.notes).toEqual([])
    expect(acts(balance)).toEqual([null])
    expect(balance.done).toBe(true)
    expect(model.answer).toEqual([{ key: 'moneyTab.plan.answer.cancelled' }])
    expect(model.answer.flatMap(amountsOf)).toEqual([])
    // The server's own mark (a step it cancelled) reads the same.
    const marked: Schedule = { ...SCHEDULE, steps: SCHEDULE.steps.map((entry) => (entry.kind === 'BEFORE_SHIPPING' ? { ...entry, status: 'CANCELLED' as const } : entry)), stillOpen: 0, overdue: 0 }
    expect(plan(order('CANCELLED'), { schedule: marked }).rows[1]!.pill.word.key).toBe('moneyTab.plan.pill.CANCELLED')
  })
})

// ---- F-OM-fx3 (W-08): the read doors — Show in the thread (the row's newest moment), History › (the audit of the plan's hand changes) ----
describe('F-OM-fx3: the read doors', () => {
  it('a row knows its newest moment (a hand change, paid, the page sent, asked); History › is the audit of the order', () => {
    const sent = plan(withRequests(order('CONFIRMED'), [deposit({ link: SENT_LINK })])).rows[0]!
    expect(sent.showAt).toBe(SENT_LINK.sentAt)
    const hand = { act: 'MOVE_DUE', at: '2026-11-18T10:44:00.000Z', by: 'Bea Esempio', reason: 'The customer pays before the fair.' }
    const moved = plan(order('CONFIRMED'), { schedule: { ...SCHEDULE_OPEN, steps: SCHEDULE_OPEN.steps.map((entry) => (entry.kind === 'BEFORE_SHIPPING' ? { ...entry, byHand: hand } : entry)) } }).rows[1]!
    expect(moved.showAt).toBe(hand.at)
    // A step with nothing behind it yet: no moment, no door.
    expect(plan(order('CONFIRMED')).rows[1]!.showAt).toBeNull()
    expect(planHistoryHref('/w/DEMO', 'o-1')).toBe('/w/DEMO/admin/audit?type=SalesOrder&record=o-1')
  })
})

// ---- F-OM-fx3 (W-15): a deposit replaced by hand was asked by hand, never "when the customer accepted the quote" ----
describe('F-OM-fx3: asked by hand', () => {
  it('a request made by a hand change (the step\'s or the request\'s own audit) says so; a quote\'s deposit does not', () => {
    const replaced = deposit({ id: 'new-1', depositPct: '25', amount: 190320 })
    const hand = { act: 'REPLACE_DEPOSIT', at: '2026-11-18T09:30:00.000Z', by: 'Bea Esempio', reason: 'The customer asked to pay 25 % first.' }
    const schedule: Schedule = { ...SCHEDULE_OPEN, steps: SCHEDULE_OPEN.steps.map((entry) => (entry.kind === 'DEPOSIT' ? { ...entry, depositRequestId: 'new-1', byHand: hand } : entry)) }
    expect(plan(withRequests(order('CONFIRMED'), [replaced]), { schedule }).rows[0]!.askedByHand).toBe(true)
    expect(plan(order('CONFIRMED')).rows[0]!.askedByHand).toBe(false)
    const asked: Schedule = { ...SCHEDULE_OPEN, requests: [{ id: deposit().id, milestoneId: SCHEDULE.steps[0]!.id, kind: 'ACCONTO', stepKind: 'DEPOSIT', status: 'OPEN', dueDate: '2026-11-04', fiscalDocument: 'TD02', byHand: { ...hand, act: 'ASK_AGAIN' } }] }
    expect(plan(order('CONFIRMED'), { schedule: asked }).rows[0]!.askedByHand).toBe(true)
  })
})

describe('F-OM-103: the head\'s answer', () => {
  it('still open · overdue · next (price); the plan read\'s figures first, else Totals\' one rule', () => {
    const answer = plan(order('CONFIRMED'), { stillToPay: 761280 }).answer
    expect(answer.map((entry) => entry.key)).toEqual(['moneyTab.plan.answer.stillOpen', 'moneyTab.plan.answer.nextDue'])
    expect(answer[0]).toEqual({ key: 'moneyTab.plan.answer.stillOpen', money: { amount: 761280 } })
    expect(answer[1]).toEqual({ key: 'moneyTab.plan.answer.nextDue', words: { what: { key: 'moneyTab.plan.next.DEPOSIT' } }, days: { date: '2026-11-04' } })
    const read = plan(order('CONFIRMED'), { schedule: { ...SCHEDULE_OPEN, stillOpen: 700000, overdue: 0 } }).answer
    expect(read.map((entry) => entry.key)).toEqual(['moneyTab.plan.answer.stillOpen', 'moneyTab.plan.answer.overdue', 'moneyTab.plan.answer.nextDue'])
    expect(read[0]!.money).toEqual({ amount: 700000 })
  })

  it('in words without the price grain (no amount); nothing open yet; everything paid; a closed order says its plan no longer changes', () => {
    const words = plan(order('CONFIRMED'), { role: 'sales', stillToPay: 761280 })
    expect(words.answer.map((entry) => entry.key)).toEqual(['moneyTab.plan.answer.nextDue'])
    expect(words.rows.flatMap((row) => [row.title, row.pill.word, row.due, ...row.notes.map((note) => note.word)]).concat(words.answer).flatMap(amountsOf)).toEqual([])
    expect(words.rows.every((row) => row.amount === null && row.left === null)).toBe(true)
    expect(plan(withRequests(order('CONFIRMED', { depositRequired: false }), []), { schedule: SCHEDULE_NONE }).answer).toEqual([{ key: 'moneyTab.plan.answer.none' }])
    const allPaid = { ...SCHEDULE, steps: SCHEDULE.steps.map((entry) => ({ ...entry, status: 'PAID' as const })) }
    expect(plan(order('SHIPPED'), { schedule: allPaid }).answer).toEqual([{ key: 'moneyTab.plan.answer.allPaid' }])
    // F-OM-fx3 (W-20): a closed order's "its plan no longer changes" is the tab head's, said once — not again in the answer.
    expect(plan(order('CLOSED'), { schedule: allPaid }).answer).toEqual([{ key: 'moneyTab.plan.answer.allPaid' }])
  })
})

describe('F-OM-103 (M3-B3): the web gate = the release\'s gate (factory-domain production/work-orders/release.ts depositGate)', () => {
  const cases: { name: string; required: boolean; requests: DepositRequest[] }[] = [
    { name: 'not needed', required: false, requests: [] },
    { name: 'never asked', required: true, requests: [] },
    { name: 'open', required: true, requests: [deposit()] },
    { name: 'paid', required: true, requests: [PAID] },
    { name: 'waived', required: true, requests: [deposit({ status: 'WAIVED' })] },
    { name: 'cancelled only', required: true, requests: [deposit({ status: 'CANCELLED' })] },
    { name: 'paid + an extra open', required: true, requests: [PAID, deposit({ id: 'extra', dueDate: '2026-11-25' })] },
    { name: 'waived + paid', required: true, requests: [deposit({ id: 'w', status: 'WAIVED' }), PAID] },
    { name: 'the balance before shipping is not the deposit', required: true, requests: [deposit({ id: 'b', stepKind: 'BEFORE_SHIPPING' })] },
  ]
  it.each(cases)('$name', ({ required, requests }) => {
    const web = depositGate({ depositRequired: required, chain: { ...order().chain, depositRequests: requests } })
    // The release reads the order's deposit requests only (not the balance's own request: ORDER_DEPOSIT_ONLY).
    const server = domainGate({ orderId: 'o', orderNumber: 'SO-1', depositRequired: required, requests: requests.filter((request) => request.stepKind !== 'BEFORE_SHIPPING').map((request) => ({ status: request.status, dueDate: request.dueDate as never })) })
    expect(web.state === 'NOT_NEEDED' || web.state === 'PAID' || web.state === 'WAIVED', `web ${web.state}`).toBe(server.passed)
  })
})

describe('F-OM-103: the words', () => {
  it('exist in both languages (every kind, pill, due, note, act, hand act, next and answer)', () => {
    const keys = [
      ...['DEPOSIT', 'EXTRA', 'BEFORE_SHIPPING', 'ON_INVOICE', 'ON_DELIVERY'].flatMap((kind) => [`kind.${kind}`, `next.${kind}`]),
      ...['OPEN', 'PART', 'PAID', 'WAIVED', 'OVERDUE', 'NOT_ASKED', 'CANCELLED' /* F-OM-fx3 */].map((pill) => `pill.${pill}`),
      ...['waived', 'paidWithInvoices', 'paidOn', 'paid', 'asInvoice', 'onDelivery', 'overdueSince', 'on', 'beforeGoodsLeave', 'withInvoice', 'notOwed' /* F-OM-fx3 */].map((due) => `due.${due}`),
      ...['productionWaits', 'extraWaits', 'holdsShipment', 'paidWithInvoice', 'owedOnInvoice', 'owedOnInvoiceWords' /* F-OM-fx3 */].map((note) => `note.${note}`),
      ...['send', 'sendAgain', 'payInvoice', 'waive', ...MONEY_PLAN_ACTS].map((act) => `act.${act}`),
      ...['moneyPlaced', 'noRest' /* F-OM-fx3 (W-16) */, 'dayFromInvoice', 'final', 'nothingFree'].map((held) => `held.${held}`),
      ...[...MONEY_PLAN_ACTS, 'OTHER'].map((act) => `byHand.what.${act}`),
      ...['none', 'allPaid', 'stillOpen', 'overdue', 'nextDue', 'next', 'short', 'partPaid', 'cancelled' /* F-OM-fx3 */].map((answer) => `answer.${answer}`),
      'shortHint', // F-OM-fx3 (W-01)
      ...['restOn', 'restOnPart', 'invoicesOpen'].map((answer) => `answer.${answer}`), // F-OM-fx5w (N3)
      ...['earlier.step', 'earlier.replaced', 'earlier.cancelled', 'setByHand', 'fromChange', 'fold', 'unfold', 'more', 'menu.openInvoice', 'step.page', 'step.byChange', 'step.issued', 'step.paid', 'step.byHand' /* F-OM-fx3 (W-15) */, 'payments.title', 'payments.none', 'payments.ref', 'payments.paidSoFar'],
    ]
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of keys) expect(t(`moneyTab.plan.${key}`, { date: 'D', number: 'N', revision: 1, row: 'R', ref: 'F', amount: 'A', what: 'W' }), `${locale} ${key}`).not.toMatch(/moneyTab\.|\{/)
      expect(t('depositKind.CAPARRA_PENITENZIALE'), locale).not.toBe('depositKind.CAPARRA_PENITENZIALE')
    }
  })
})

// ---- F-OM-fx5w (fix wave 4, the look-only walk 31-A on real data): N1 · N3 in the plan. Every name and number is made up. ----
describe('F-OM-fx5w: the walk\'s gaps in Payments', () => {
  const EXTRA = deposit({ id: 'extra-1', amount: 4392, paidAmount: 0, dueDate: '2026-11-23' })
  const fromChange: Schedule['requests'] = [{ id: 'extra-1', milestoneId: null, kind: 'ACCONTO', stepKind: 'DEPOSIT', status: 'OPEN', dueDate: '2026-11-23', fiscalDocument: 'TD02', fromChange: { amendmentId: 'a1', revision: 1 } }]

  it('N1: no deposit needed — its extra deposit is an "Extra deposit" row WITHOUT "New work orders wait for it" (the release does not wait)', () => {
    const value = withRequests(order('IN_PRODUCTION', { depositRequired: false }), [EXTRA])
    const model = plan(value, { schedule: { ...SCHEDULE_NONE, requests: fromChange } })
    expect(kinds(model.rows)).toEqual(['EXTRA'])
    expect(model.rows[0]!.notes).toEqual([])
    expect(model.answer).toEqual([{ key: 'moneyTab.plan.answer.nextDue', words: { what: { key: 'moneyTab.plan.next.EXTRA' } }, days: { date: '2026-11-23' } }])
    // Without the plan read's change: still the extra deposit (the order's terms ask none).
    expect(kinds(plan(value, { schedule: SCHEDULE_NONE }).rows)).toEqual(['EXTRA'])
    // The release's own gate passes it (no deposit required), and the web gate says the same.
    expect(domainGate({ orderId: 'o', orderNumber: 'SO-1', depositRequired: false, requests: [{ status: 'OPEN', dueDate: '2026-11-23' as never }] }).passed).toBe(true)
    expect(depositGate(value).state).toBe('NOT_NEEDED')
    // With a deposit required the same extra deposit holds new work orders: the note stays.
    const required = plan(withRequests(order('IN_PRODUCTION'), [PAID, EXTRA]), { schedule: { ...SCHEDULE, requests: fromChange } })
    expect(required.rows.find((row) => row.kind === 'EXTRA')!.notes.map((note) => note.word.key)).toEqual(['moneyTab.plan.note.extraWaits'])
  })

  it('N3: no step, invoiced and part paid — the answer names the open invoice (never "nothing is open yet"); amounts with the price grain only', () => {
    const shipped = withRequests(order('SHIPPED', { depositRequired: false }), [])
    const noStep = (role: Parameters<typeof canOf>[0], settlement: Settlement | null, stillToPay: number | null = null) => planOf({ order: shipped, schedule: SCHEDULE_NONE, settlement, can: canOf(role), stepCan: null, today: TODAY, stillToPay })
    const coded = (paymentState: 'OPEN' | 'PART_PAID'): Settlement => ({ ...SETTLEMENT_SHIPPED, invoices: SETTLEMENT_SHIPPED.invoices.map((invoice) => (invoice.docType === 'TD02' ? invoice : { ...invoice, paidAmount: paymentState === 'PART_PAID' ? 300000 : 0, openAmount: paymentState === 'PART_PAID' ? 232896 : 532896, paymentState })) })
    // Finance (the price grain): still open € … (the server's one rule) · the rest is open on FA-2026-00052: part paid.
    expect(noStep('finance', coded('PART_PAID'), 232896).answer).toEqual([{ key: 'moneyTab.plan.answer.stillOpen', money: { amount: 232896 } }, { key: 'moneyTab.plan.answer.restOnPart', params: { number: 'FA-2026-00052' } }])
    // Sales (invoices.view, no price): the settlement's word-code, in words.
    expect(noStep('sales', coded('PART_PAID')).answer).toEqual([{ key: 'moneyTab.plan.answer.restOnPart', params: { number: 'FA-2026-00052' } }])
    expect(noStep('sales', coded('OPEN')).answer).toEqual([{ key: 'moneyTab.plan.answer.restOn', params: { number: 'FA-2026-00052' } }])
    // The production manager (no invoices.view: no settlement read): the order read's own gap, never "nothing is open yet".
    expect(noStep('manager', null).answer).toEqual([{ key: 'moneyTab.plan.answer.invoicesOpen' }])
    for (const model of [noStep('sales', coded('PART_PAID')), noStep('manager', null)]) expect(model.answer.flatMap(amountsOf)).toEqual([])
    // Nothing invoiced yet: "nothing is open yet" stays.
    expect(plan(withRequests(order('CONFIRMED', { depositRequired: false }), []), { schedule: SCHEDULE_NONE }).answer).toEqual([{ key: 'moneyTab.plan.answer.none' }])
  })
})
