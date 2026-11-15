import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
// The Ri.Ba. batch and the payment proposal are pop-ups: inline the DS Modal's portal and say "hydrated", so Node renders them.
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))
vi.mock('@nexus/ui/components/useHydrated', () => ({ useHydrated: () => true }))

import { AREA_LINE_OUTCOMES as DOMAIN_AREA_OUTCOMES } from '@nexus/factory-domain/payables/area-check/rules'
import { DUAL_STEPS as DOMAIN_DUAL_STEPS } from '@nexus/factory-domain/payables/proposal/approvals'
import { DUE_BUCKETS as DOMAIN_DUE_BUCKETS, PROPOSAL_REFUSALS as DOMAIN_PROPOSAL_REFUSALS } from '@nexus/factory-domain/payables/proposal/rules'
import { MATCH_CONFIDENCES as DOMAIN_CONFIDENCES, MATCH_REASONS as DOMAIN_MATCH_REASONS } from '@nexus/factory-domain/payments/matching/match'
import { WRITE_OFF_KINDS as DOMAIN_WRITE_OFF_KINDS, WRITE_OFF_REASONS as DOMAIN_WRITE_OFF_REASONS, WRITE_OFF_REFUSALS as DOMAIN_WRITE_OFF_REFUSALS } from '@nexus/factory-domain/payments/write-offs/write-offs'
import { RIBA_REFUSALS as DOMAIN_RIBA_REFUSALS } from '@nexus/factory-domain/receivables/riba/riba'
import { STOP_REASONS as DOMAIN_STOP_REASONS, STOP_REFUSALS as DOMAIN_STOP_REFUSALS } from '@nexus/factory-domain/receivables/stops/stops'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { AREA_LINE_OUTCOMES, type AreaLine } from '../../payables/area-check/api'
import { designScreen as areaScreen } from '../../payables/area-check/fixtures'
import { claimHeld } from '../../payables/area-check/model'
import type { InvoiceDual } from '../../payables/dual-approval/api'
import { designScreen as dualScreen } from '../../payables/dual-approval/fixtures'
import { dualState } from '../../payables/dual-approval/model'
import { designScreen as batchScreen } from '../../payables/payment/fixtures'
import { batchOf, PAYMENT_LOOK_BACK, proposalsToRead } from '../../payables/payment/model'
import { DUAL_STEPS, DUE_BUCKETS, PROPOSAL_REFUSALS, type Proposal, type ProposalCandidate, type ProposalRow } from '../../payables/proposal/api'
import { designScreen as proposalScreen } from '../../payables/proposal/fixtures'
import { defaultPicks, holdPhrase, isoWeek, linesOf, mondayOf, paidHeld } from '../../payables/proposal/model'
import { STOP_REASONS, STOP_REFUSALS } from '../../receivables/reminder-stops/api'
import { designScreen as stopsScreen } from '../../receivables/reminder-stops/fixtures'
import { stopDraftHeld, stopsCanOf, trustedSteps, trustHeld } from '../../receivables/reminder-stops/model'
import { MONEY_ACTIONS, MONEY_AUDIENCES, MONEY_NOTIFICATIONS, type MoneyControl } from '../../settings/approvals/api'
import { designScreen as approvalsScreen } from '../../settings/approvals/fixtures'
import { switchHeld, yesStateOf } from '../../settings/approvals/model'
import { MATCH_CONFIDENCES, MATCH_REASONS } from '../bank-reasons/api'
import { designScreen as recordScreen } from '../bank-reasons/fixtures'
import { WRITE_OFF_KINDS, WRITE_OFF_REASONS, WRITE_OFF_REFUSALS, type PossibleWriteOff } from '../write-off/api'
import { designScreen as tilesScreen } from '../write-off/fixtures'
import { notPlacedTile, possibleHeld, reasonHeld } from '../write-off/model'
import { RIBA_REFUSALS, type RibaCandidate, type RibaItem } from './api'
import { codeAt, csvCell, csvOf, payProblem, scoped } from './depth'
import { designScreen as ribaFileScreen } from './file/fixtures'
import { designScreen as ribaScreen } from './fixtures'
import { cbiReceipts, cbiRecords, feeMinor, issueHeld, picksOf, pickedTotal, ribaProblem, settlementOf, siaProblem, windowProblem } from './model'
import { ribaUnpaidTile } from './unpaid/use-riba-unpaid'

/** B-W2b-425 — payments, collections and payables on screen: the lists match their sources, the rules, every design case's words. */

const refusal = (path: string, kind: 'conflict' | 'invalid' = 'conflict') => new ApiError(kind, kind === 'conflict' ? 409 : 400, kind, 'x', null, [{ path, message: 'x' }])

describe('the lists mirror their sources', () => {
  it('factory-domain', () => {
    expect([...RIBA_REFUSALS].sort()).toEqual(Object.keys(DOMAIN_RIBA_REFUSALS).sort())
    expect(STOP_REASONS).toEqual(DOMAIN_STOP_REASONS)
    expect([...STOP_REFUSALS].sort()).toEqual(Object.keys(DOMAIN_STOP_REFUSALS).sort())
    expect(WRITE_OFF_REFUSALS).toEqual(DOMAIN_WRITE_OFF_REFUSALS)
    expect(WRITE_OFF_KINDS).toEqual(DOMAIN_WRITE_OFF_KINDS)
    expect(WRITE_OFF_REASONS).toEqual(DOMAIN_WRITE_OFF_REASONS)
    expect(MATCH_REASONS).toEqual(DOMAIN_MATCH_REASONS)
    expect(MATCH_CONFIDENCES).toEqual(DOMAIN_CONFIDENCES)
    expect(PROPOSAL_REFUSALS).toEqual(DOMAIN_PROPOSAL_REFUSALS)
    expect(DUE_BUCKETS).toEqual(DOMAIN_DUE_BUCKETS)
    expect(DUAL_STEPS).toEqual(DOMAIN_DUAL_STEPS)
    expect(AREA_LINE_OUTCOMES).toEqual(DOMAIN_AREA_OUTCOMES)
  })

  it('the money controls and notifications of factory-api', () => {
    const controls = readFileSync(new URL('../../../../../../factory-api/src/modules/payables/proposal/controls.ts', import.meta.url), 'utf8')
    const money = readFileSync(new URL('../../../../../../factory-api/src/platform/notifications/rules/money.ts', import.meta.url), 'utf8')
    const actions = /MONEY_ACTIONS = \[([^\]]+)\]/.exec(controls)![1]!.match(/'([A-Z_]+)'/g)!.map((code) => code.slice(1, -1))
    expect(actions).toEqual([...MONEY_ACTIONS])
    expect([...money.matchAll(/code: '([A-Z_]+)'/g)].map((match) => match[1])).toEqual([...MONEY_NOTIFICATIONS])
    expect([...money.matchAll(/audience: '([A-Z_]+)'/g)].map((match) => match[1])).toEqual([...MONEY_AUDIENCES])
  })
})

describe('Ri.Ba.', () => {
  const candidate = (n: number, amount: number | undefined, held: RibaCandidate['held'] = null): RibaCandidate =>
    ({ invoice: { id: `i${n}`, number: `FT-${n}`, issueDate: '2026-10-01' }, customer: { id: `c${n}`, code: 'C', name: `Cliente ${n}` }, instalment: 1, dueDate: '2026-11-30', instalmentAmount: amount, amount, currency: 'EUR', debtorBank: null, held }) as RibaCandidate
  const item = (n: number, over: Partial<RibaItem> = {}): RibaItem =>
    ({ id: `it${n}`, invoice: { id: `i${n}`, number: `FT-${n}`, issueDate: null }, customer: { id: `c${n}`, code: 'C', name: `Cliente ${n}` }, instalment: 1, dueDate: '2026-11-30', amount: 1000, status: 'ISSUED', settledOn: null, unpaidFee: null, paymentId: null, invoiceOpen: 1000, debtorBank: null, version: 1, ...over }) as RibaItem

  it('the window: both days, in order, at most a year', () => {
    expect(windowProblem('2026-11-14', '')).toEqual({ key: scoped('riba.window.missing') })
    expect(windowProblem('2026-11-14', '2026-11-01')).toEqual({ key: scoped('riba.window.order') })
    expect(windowProblem('2026-11-14', '2027-12-31')?.key).toBe(scoped('riba.window.long'))
    expect(windowProblem('2026-11-14', '2026-12-14')).toBeNull()
  })

  it('only free instalments are picked; the total needs the price grain', () => {
    const rows = [candidate(1, 1000), candidate(2, 500), candidate(3, 900, { code: 'IN_ANOTHER_BATCH' })]
    const all = new Set(['i1:1', 'i2:1', 'i3:1'])
    expect(picksOf(rows, all)).toEqual([{ invoiceId: 'i1', instalment: 1 }, { invoiceId: 'i2', instalment: 1 }])
    expect(pickedTotal(rows, all)).toBe(1500)
    expect(pickedTotal([candidate(1, undefined)], new Set(['i1:1']))).toBeNull()
  })

  it('the file waits for the SIA code and every customer\'s bank', () => {
    expect(siaProblem('a1b2')).not.toBeNull()
    expect(siaProblem(' a1b2c ')).toBeNull()
    const asks = [{ partyId: 'c2', name: 'Cliente 2', known: null }]
    expect(issueHeld({ sia: 'A1B2C', asks, typed: {}, busy: false })?.key).toBe(scoped('riba.bank.needed'))
    expect(issueHeld({ sia: 'A1B2C', asks, typed: { c2: { abi: '0000', cab: '00000' } }, busy: false })?.key).toBe(scoped('riba.bank.invalid'))
    expect(issueHeld({ sia: 'A1B2C', asks, typed: { c2: { abi: '00000', cab: '00000' } }, busy: false })).toBeNull()
  })

  it('the bank\'s report: a fee only on an unpaid one, never before the due day or in the future', () => {
    expect(feeMinor('3,50')).toBe(350)
    const items = [item(1), item(2)]
    const ok = settlementOf(items, { it1: { status: 'PAID', settledOn: '2026-12-01', fee: '' }, it2: { status: 'UNPAID', settledOn: '2026-12-02', fee: '3,50' } }, '2026-12-05')
    expect(ok.problem).toBeNull()
    expect(ok.items).toEqual([{ itemId: 'it1', status: 'PAID', settledOn: '2026-12-01' }, { itemId: 'it2', status: 'UNPAID', settledOn: '2026-12-02', unpaidFee: 350 }].map((row) => expect.objectContaining(row)))
    expect(settlementOf(items, { it1: { status: 'PAID', settledOn: '2026-11-01', fee: '' } }, '2026-12-05').problem?.key).toBe(scoped('refusal.riba.BEFORE_DUE'))
    expect(settlementOf(items, { it1: { status: 'PAID', settledOn: '2026-12-09', fee: '' } }, '2026-12-05').problem?.key).toBe(scoped('refusal.riba.FUTURE_DAY'))
    expect(settlementOf(items, {}, '2026-12-05').problem?.key).toBe(scoped('riba.settle.nothing'))
  })

  it('a receipt without bank names its customer; the switch off in words', () => {
    const items = [item(1), item(2)]
    const problem = ribaProblem(refusal('items/1/NO_DEBTOR_BANK', 'invalid'), items)
    expect(problem).toMatchObject({ key: scoped('refusalItem.riba.NO_DEBTOR_BANK'), params: { invoice: 'FT-2', customer: 'Cliente 2' }, banksFor: ['c2'] })
    expect(ribaProblem(refusal('riba/SWITCHED_OFF')).key).toBe(scoped('refusal.riba.SWITCHED_OFF'))
  })

  it('the file read back: 120-character records, one 14 per receipt', () => {
    const text = [' IB', ' 140000001', ' 200000001', ' 140000002', ' EF'].map((line) => line.padEnd(120, ' ')).join('\r\n')
    const records = cbiRecords(text)
    expect(records.map((record) => record.type)).toEqual(['IB', '14', '20', '14', 'EF'])
    expect(cbiReceipts(records)).toBe(2)
  })

  it('the unpaid tile: euro first, other currencies counted apart', () => {
    expect(ribaUnpaidTile(null)).toBeNull()
    expect(ribaUnpaidTile({ tiles: [], items: [] })).toEqual({ count: 0, open: 0, currency: 'EUR', others: 0 })
    expect(ribaUnpaidTile({ tiles: [{ currency: 'USD', count: 1, open: 10, fees: 1 }, { currency: 'EUR', count: 2, open: 300, fees: 7 }], items: [] })).toEqual({ count: 2, open: 300, currency: 'EUR', others: 1 })
  })
})

describe('not placed and the write-off', () => {
  it('the tile counts every currency, sums the euro', () => {
    expect(notPlacedTile({ companyId: 'c', totals: { count: 3, amounts: [{ currency: 'EUR', amount: 1200 }, { currency: 'CHF', amount: 50 }] }, payments: [], nextCursor: null })).toEqual({ count: 3, amount: 1200, others: 1 })
  })

  it('a difference is written off only within the tolerance, by who may, with a note for another reason', () => {
    const possible = { kind: 'UNDERPAYMENT', allocationId: 'a', invoiceId: 'i', number: 'FT-1', amount: 4, withinTolerance: true } as PossibleWriteOff
    const tolerance = { tolerance: { amount: 100, source: 'COMPANY' as const } }
    expect(possibleHeld(possible, tolerance, { writeOff: true, price: true }, false, false)).toBeNull()
    expect(possibleHeld(possible, tolerance, { writeOff: false, price: true }, false, false)?.key).toBe(scoped('writeOff.held.right'))
    expect(possibleHeld({ ...possible, withinTolerance: false }, tolerance, { writeOff: true, price: true }, false, false)?.key).toBe(scoped('refusal.writeOff.OVER_TOLERANCE'))
    expect(possibleHeld(possible, { tolerance: { amount: null, source: null } }, { writeOff: true, price: true }, false, false)?.key).toBe(scoped('refusal.writeOff.NO_TOLERANCE'))
    expect(reasonHeld('OTHER', ' ')?.key).toBe(scoped('refusal.writeOff.NOTE_NEEDED'))
    expect(reasonHeld('ROUNDING', '')).toBeNull()
  })
})

describe('reminder stops and trusted levels', () => {
  const finance = stopsCanOf(['receivables.view', 'receivables.reminders.manage'])
  it('a promise names its day; days are today or later', () => {
    expect(stopDraftHeld({ invoiceId: 'i', reason: 'PROMISE_TO_PAY', until: '', note: '' }, '2026-11-14', finance, false)?.key).toBe(scoped('stops.held.promiseDay'))
    expect(stopDraftHeld({ invoiceId: 'i', reason: 'DISPUTE', until: '2026-11-01', note: '' }, '2026-11-14', finance, false)?.key).toBe(scoped('stops.held.dayPast'))
    expect(stopDraftHeld({ invoiceId: 'i', reason: 'DISPUTE', until: '', note: '' }, '2026-11-14', finance, false)).toBeNull()
    expect(stopDraftHeld({ invoiceId: 'i', reason: 'DISPUTE', until: '', note: '' }, '2026-11-14', stopsCanOf(['receivables.view']), false)?.key).toBe(scoped('stops.held.right'))
  })

  it('only the Owner sets a level; only e-mail steps go by themselves', () => {
    const trust = { customer: { id: 'c', code: 'C', name: 'Cliente', version: 1 }, level: 1, companies: [{ id: 'co', code: 'ALFA', remindersEnabled: true, steps: [{ level: 1, offsetDays: 7, action: 'EMAIL' }, { level: 2, offsetDays: 21, action: 'LETTER' }, { level: 3, offsetDays: 35, action: 'EMAIL' }] }], mayChange: true }
    expect(trustHeld(trust, finance, false)?.key).toBe(scoped('trust.held.right'))
    expect(trustHeld(trust, stopsCanOf(['receivables.reminders.trust']), false)).toBeNull()
    expect(trustedSteps(trust, 3)).toEqual([{ companyCode: 'ALFA', on: true, steps: [1, 3] }])
  })
})

describe('the payment proposal, the area check, dual approval, the payment batch', () => {
  it('weeks start on Monday; a discount above the invoice is refused', () => {
    expect(mondayOf('2026-11-14')).toBe('2026-11-09')
    expect(isoWeek('2026-11-09')).toBe(46)
    const rows = [
      { invoiceId: 'a', number: 'A', supplier: { id: 's', code: 'S', name: 'S' }, issueDate: '2026-10-01', dueDate: '2026-11-12', due: 'THIS_WEEK', grossTotal: 10000, payable: 10000, account: { id: 'x', masked: 'IT**', usable: true }, held: false, inProposal: null },
      { invoiceId: 'b', number: 'B', supplier: { id: 's', code: 'S', name: 'S' }, issueDate: '2026-10-01', dueDate: '2026-11-12', due: 'THIS_WEEK', grossTotal: 5000, payable: 5000, account: null, held: true, inProposal: null },
    ] as ProposalCandidate[]
    expect(defaultPicks(rows)).toEqual(['a'])
    expect(linesOf(rows, new Set(['a']), { a: '10,00' })).toEqual({ lines: [{ invoiceId: 'a', discountAmount: 1000 }], problem: null })
    expect(linesOf(rows, new Set(['a']), { a: '100,00' }).problem?.key).toBe(scoped('refusal.proposal.TOO_MUCH'))
    expect(paidHeld({ paidOn: '2026-11-15', reference: 'CRO', today: '2026-11-14' })?.key).toBe(scoped('proposal.paid.future'))
    expect(holdPhrase('NO_PERMISSION')?.key).toBe(scoped('proposal.held.right'))
    expect(holdPhrase('OWN_PROPOSAL')?.key).toBe(scoped('refusal.proposal.OWN_PROPOSAL'))
  })

  it('an area claim opens only for a short line, by who may', () => {
    const line = { check: { outcome: 'SHORT', opensClaim: true }, claim: { opens: true, held: null, existing: [] } } as unknown as AreaLine
    expect(claimHeld(line, false)).toBeNull()
    expect(claimHeld({ ...line, claim: { ...line.claim, held: 'no right' } }, false)?.key).toBe(scoped('area.held.right'))
    expect(claimHeld({ ...line, check: { ...line.check!, outcome: 'WITHIN', opensClaim: false } }, false)?.key).toBe(scoped('area.held.nothing'))
    expect(claimHeld({ ...line, check: { ...line.check!, outcome: 'NOT_RECEIVED', opensClaim: false } }, false)?.key).toBe(scoped('area.held.notReceived'))
    expect(claimHeld({ ...line, check: null }, false)?.key).toBe(scoped('area.held.noArea'))
  })

  it('dual approval: under, both, second (never the first approver), lapsed', () => {
    const base: InvoiceDual = { invoiceId: 'i', needed: true, threshold: { amount: 1000000, currency: 'EUR', decided: false }, first: null, step: 'FIRST', held: null }
    expect(dualState({ ...base, needed: false }, 'me')).toBe('under')
    expect(dualState(base, 'me')).toBe('both')
    expect(dualState({ ...base, first: { by: { id: 'other', name: null }, at: 'x', standing: true } }, 'me')).toBe('second')
    expect(dualState({ ...base, first: { by: { id: 'me', name: null }, at: 'x', standing: true } }, 'me')).toBe('secondMine')
    expect(dualState({ ...base, first: { by: { id: 'other', name: null }, at: 'x', standing: false } }, 'me')).toBe('lapsed')
  })

  it('the batch of an invoice: the newest live proposals, the first that holds it', () => {
    const row = (n: number, status: ProposalRow['status']) => ({ id: `p${n}`, status }) as ProposalRow
    const look = proposalsToRead([row(1, 'CANCELLED'), ...Array.from({ length: PAYMENT_LOOK_BACK + 1 }, (_, index) => row(index + 2, 'PAID'))])
    expect(look.ids).toHaveLength(PAYMENT_LOOK_BACK)
    expect(look.ids[0]).toBe('p2')
    expect(look.more).toBe(true)
    const proposal = (id: string, invoiceIds: string[]) => ({ id, week: 46, weekStart: '2026-11-09', weekEnd: '2026-11-15', status: 'APPROVED', paidAt: null, currency: 'EUR', lines: invoiceIds.map((invoiceId) => ({ invoice: { id: invoiceId } })) }) as unknown as Proposal
    expect(batchOf([proposal('p1', ['a']), proposal('p2', ['b'])], 'b')?.proposal.id).toBe('p2')
    expect(batchOf([proposal('p1', ['a'])], 'z')).toBeNull()
  })
})

describe('approvals & notifications', () => {
  const control = (over: Partial<MoneyControl>): MoneyControl => ({ code: 'CREDIT_NOTE', kind: null, stepUp: null, dual: null, ...over })
  it('what asks a yes, in a code the view words', () => {
    expect(yesStateOf(control({ code: 'PAYMENT_PROPOSAL' }))).toBe('SEPARATION')
    expect(yesStateOf(control({ code: 'MANUAL_PAYMENT' }))).toBe('NO_KIND')
    expect(yesStateOf(control({ kind: { code: 'PRICE_CHANGE', registered: false, rules: 0, active: 0 } }))).toBe('NOT_REGISTERED')
    expect(yesStateOf(control({ kind: { code: 'CREDIT_WITHOUT_RETURN', registered: true, rules: 2, active: 0 } }))).toBe('NO_RULE')
    expect(yesStateOf(control({ kind: { code: 'CREDIT_WITHOUT_RETURN', registered: true, rules: 2, active: 1 } }))).toBe('RULES')
  })
  it('a mail switch is the Owner\'s', () => {
    expect(switchHeld({ read: true, mayChange: false, busy: false })?.key).toBe(scoped('approvals.held.owner'))
    expect(switchHeld({ read: false, mayChange: true, busy: false })?.key).toBe(scoped('approvals.held.unread'))
    expect(switchHeld({ read: true, mayChange: true, busy: false })).toBeNull()
  })
})

describe('words of a refused write and the CSV', () => {
  it('a known code in this step\'s words, else the finance words', () => {
    expect(codeAt(refusal('refusal/OWN_PROPOSAL'), 'refusal')).toBe('OWN_PROPOSAL')
    expect(payProblem(refusal('refusal/OWN_PROPOSAL'), 'proposal', PROPOSAL_REFUSALS).key).toBe(scoped('refusal.proposal.OWN_PROPOSAL'))
    expect(payProblem(refusal('body/version'), 'proposal', PROPOSAL_REFUSALS)).toMatchObject({ key: 'problem.write.moved', reload: true })
  })
  it('a formula is kept as text; commas and quotes are quoted', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('a, "b"')).toBe('"a, ""b"""')
    expect(csvOf(['x'], [['1']])).toBe('x\n1\n')
  })
})

const LEFT_KEY = /\b(?:riba|ribaFile|ribaUnpaid|notPlaced|writeOff|bankLine|unlock|tile|band|rows|stops|trust|proposal|area|dual|batch|approvals|refusal|refusalItem|stepUp)\.[a-zA-Z_]+(?:\.[a-zA-Z0-9_]+)*\b/

/** The DS Modal names document.body for its (inlined) portal: a bare document for the render, then the global as it was. */
function withDocument<T>(run: () => T): T {
  const scope = globalThis as Record<string, unknown>
  const saved = scope.document
  const noop = () => undefined
  scope.document = { body: {}, activeElement: null, documentElement: {}, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop }
  try {
    return run()
  } finally {
    if (saved === undefined) delete scope.document
    else scope.document = saved
  }
}

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return withDocument(() => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'finance', 'finance-daily', 'finance-payables', 'finance-receivables', 'finance-payments-depth', 'lists']) }, createElement(View, { model }))))
}

describe('every design case of SCR-510 to SCR-519 draws in both languages with no key left on screen', () => {
  const screens = [ribaScreen, ribaFileScreen, tilesScreen, recordScreen, stopsScreen, proposalScreen, areaScreen, dualScreen, batchScreen, approvalsScreen] as unknown as DesignScreen<unknown>[]
  it('the ten screen ids', () => {
    expect(screens.map((screen) => screen.screen)).toEqual(['SCR-510', 'SCR-511', 'SCR-512', 'SCR-513', 'SCR-514', 'SCR-515', 'SCR-516', 'SCR-517', 'SCR-518', 'SCR-519'])
  })
  for (const screen of screens) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/href="[^"]*"/g, '')
          expect(html.length, item.id).toBeGreaterThan(40)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
