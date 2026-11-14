import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUN_STATUSES as DOMAIN_RUN_STATUSES } from '@nexus/factory-domain/invoicing/runs/runs'
import { ApiError } from '../../../../lib/api/errors'
import { messagesFor } from '../../../../lib/i18n/messages'
import { abilitiesOf } from '../../_shared/model'
import { balanceOrdersOf, releaseHeld, releaseWordsProblem } from '../balance/model'
import { designScreen as balanceScreen } from '../balance/fixtures'
import { debitableWords, debitHeld, debitInputsOf, debitProblems, emptyDebitLine, vatLimitWords } from '../debit-note/model'
import { designScreen as debitScreen } from '../debit-note/fixtures'
import { stampLineOf, payHeld, paidOnProblem, recountHeld, currentQuarter } from '../stamp-duty/model'
import { designScreen as stampScreen } from '../stamp-duty/fixtures'
import { DEPTH, depthProblem, monthName, refusalCode } from '../test-mode/depth'
import { designScreen as testModeScreen } from '../test-mode/fixtures'
import { LIVE, TESTING_FAKE, TESTING_SIMULATED } from '../test-mode/demo/fixtures'
import { answerWords, bannerOf, goLiveConsequences, goLiveHeld, makeCopiesHeld, readinessWords } from '../test-mode/model'
import { RUN_STATUSES } from './api'
import { designScreen as runScreen } from './fixtures'
import { candidateHeld, changeHeld, confirmPhraseOf, customerStateOf, issuedWords, issueHeld, pickHeld, presetPicked, runMonths, runProblem } from './model'

/** B-W2b-417 — invoices in depth on screen: the rules of its invoice parts, without a browser; made-up data only. */

const FINANCE = abilitiesOf(['invoices.view', 'invoices.manage', 'invoices.issue', 'money.price'])
const SALES = abilitiesOf(['invoices.view', 'money.price'])
const conflict = (path: string) => new ApiError('conflict', 409, 'conflict', 'English words', null, [{ path, message: 'x' }])

describe('the monthly invoice run', () => {
  it('offers two months back, the one before and this one; the one before first', () => {
    expect(runMonths('2026-11-14')).toEqual({ months: ['2026-09', '2026-10', '2026-11'], preset: '2026-10' })
    expect(runMonths('2027-01-03')).toEqual({ months: ['2026-11', '2026-12', '2027-01'], preset: '2026-12' })
    expect([...RUN_STATUSES]).toEqual([...DOMAIN_RUN_STATUSES])
  })

  it('holds a customer another preview picks, and every step with why', () => {
    expect(candidateHeld({ inRunId: 'r1' })).toEqual({ key: 'run.pick.inOtherRun' })
    expect(candidateHeld({ inRunId: 'r1' }, 'r1')).toBeNull()
    const candidates = runScreen.cases[0]!.model.run.candidates.value!.customers
    expect(presetPicked(candidates)).toHaveLength(2)
    expect(pickHeld({ picked: 0, can: FINANCE, busy: false, max: 200 })).toEqual({ key: 'run.held.pickOne' })
    expect(pickHeld({ picked: 201, can: FINANCE, busy: false, max: 200 })).toEqual({ key: 'run.held.tooMany', params: { max: 200 } })
    expect(pickHeld({ picked: 2, can: SALES, busy: false, max: 200 })).toEqual({ key: 'held.noManage' })
    const run = runScreen.cases.find((item) => item.id === 'preview')!.model.run.run!
    expect(run.customers.map(customerStateOf)).toEqual(['READY', 'HELD', 'NONE'])
    expect(issueHeld(run, FINANCE, false)).toBeNull()
    expect(issueHeld(run, SALES, false)).toEqual({ key: 'held.noIssue' })
    expect(issueHeld({ ...run, counts: { ...run.counts, ready: 0 } }, FINANCE, false)).toEqual({ key: 'run.held.noneReady' })
    expect(issueHeld({ ...run, status: 'ISSUED' }, FINANCE, false)).toEqual({ key: 'run.held.issued' })
    expect(changeHeld({ ...run, can: { ...run.can, delete: false } }, FINANCE, 'delete')).toEqual({ key: 'run.held.cannotDelete' })
    expect(confirmPhraseOf(run)).toBe('2026-10')
  })

  it('says what the issue did and words its refusals itself', () => {
    const done = runScreen.cases.find((item) => item.id === 'done')!.model.run.result!
    expect(issuedWords(done)).toEqual([{ key: 'run.done.issued', params: { count: 1 } }, { key: 'run.done.sent', params: { count: 1 } }, { key: 'run.done.held', params: { count: 1 } }])
    expect(runProblem(conflict('body/partyIds/0'))).toEqual({ key: `${DEPTH}:run.problem.otherRun`, reload: true })
    expect(runProblem(conflict('version'))).toEqual({ key: 'problem.write.moved', reload: true })
    expect(runProblem(conflict(''))).toEqual({ key: `${DEPTH}:run.problem.state`, reload: true })
  })
})

describe('stamp duty, the debit note, the VAT time limit, the balance before shipping', () => {
  it('says the stamp duty decision in words and asks to decide again on a mismatch', () => {
    const tax = { stampDuty: { amount: 200, charge: true, reason: 'DUE' as const, chargedAmount: 200 }, problems: [] }
    expect(stampLineOf(tax, '2,00 €')).toEqual({ ok: true, words: { key: 'stamp.check.DUE', params: { amount: '2,00 €' } }, again: false })
    expect(stampLineOf(tax, null).words).toEqual({ key: 'stamp.check.DUE_NO_PRICE' })
    expect(stampLineOf({ ...tax, stampDuty: { ...tax.stampDuty, reason: 'SWITCH_OFF' } }, null).words).toEqual({ key: 'stamp.check.SWITCH_OFF' })
    expect(stampLineOf({ ...tax, problems: [{ code: 'STAMP_DUTY', path: 'lines/stampDuty' }] }, '2,00 €')).toEqual({ ok: false, words: { key: 'stamp.check.mismatch' }, again: true })
  })

  it('holds a quarter’s recount and payment with why, and checks the payment day', () => {
    const quarters = stampScreen.cases[0]!.model
    if (quarters.kind !== 'quarters') throw new Error('quarters case')
    const year = quarters.quarters.quarters.value!
    const can = { manage: true, switch: true }
    expect(currentQuarter(year.quarters, '2026-11-14')!.quarterStart).toBe('2026-10-01')
    expect(recountHeld(year.quarters[2]!, can, false, false)).toEqual({ key: 'stamp.held.switchOff' })
    expect(recountHeld(year.quarters[0]!, can, true, false)).toEqual({ key: 'stamp.held.paid' })
    expect(payHeld(year.quarters[3]!, can, false)).toEqual({ key: 'stamp.held.running' })
    expect(payHeld(year.quarters[2]!, { manage: false, switch: false }, false)).toEqual({ key: 'held.noTaxManage' })
    expect(paidOnProblem('2026-09-15', year.quarters[2]!, '2026-11-14')).toEqual({ key: 'stamp.payProblem.beforeEnd' })
    expect(paidOnProblem('2026-11-20', year.quarters[2]!, '2026-11-14')).toEqual({ key: 'stamp.payProblem.future' })
    expect(paidOnProblem('2026-11-12', year.quarters[2]!, '2026-11-14')).toBeNull()
  })

  it('checks the debit note’s lines and sends VAT to the rules', () => {
    const line = { kind: 'CHARGE' as const, chargeKind: 'FREIGHT' as const, description: ' Trasporto ', quantity: '2', unitPrice: '75,50' }
    expect(debitProblems('i1', [line])).toEqual({ lines: {} })
    expect(debitProblems(null, [emptyDebitLine()])).toEqual({ invoice: 'debit.problem.invoice', lines: { 0: { description: 'debit.problem.description', unitPrice: 'debit.problem.unitPrice' } } })
    expect(debitInputsOf([line])).toEqual([{ kind: 'CHARGE', chargeKind: 'FREIGHT', description: 'Trasporto', quantity: '2', unitPrice: '75.50' }])
    expect(debitInputsOf([{ ...line, kind: 'SERVICE' }])[0]).not.toHaveProperty('chargeKind')
    expect(debitableWords({ debitable: { ok: false, code: 'REJECTED' } })).toEqual({ key: 'debit.refusal.REJECTED' })
    expect(debitHeld({ can: FINANCE, busy: false, problems: { lines: {} }, debitable: null, reading: true })).toEqual({ key: 'debit.held.reading' })
    expect(debitHeld({ can: SALES, busy: false, problems: { lines: {} }, debitable: null, reading: false })).toEqual({ key: 'held.noManage' })
    expect(debitHeld({ can: { ...FINANCE, price: false }, busy: false, problems: { lines: {} }, debitable: null, reading: false })).toEqual({ key: 'debit.held.noPrice' })
    const day = (value: string) => value.split('-').reverse().join('/')
    expect(vatLimitWords({ verdict: { state: 'BEYOND', limitDate: '2026-10-27' }, operationDate: '2025-10-27' }, day)).toEqual({ key: 'vatLimit.BEYOND', params: { until: '27/10/2026', operation: '27/10/2025' } })
    expect(vatLimitWords({ verdict: { state: 'ASK', limitDate: null }, operationDate: '2025-10-27' }, day)).toEqual({ key: 'vatLimit.ASK' })
  })

  it('matches the open balance and the held shipments to the invoice’s orders', () => {
    const order = { id: 'o1', number: 'SO-1' }
    const items = [
      { target: 'DEPOSIT_REQUEST' as const, id: 'd1', number: null, docType: null, fiscalDocument: null, stepKind: 'BEFORE_SHIPPING' as const, orderId: 'o1', orderNumber: 'SO-1', date: '2026-11-01', dueDate: null, currency: 'EUR', openAmount: 1000 },
      { target: 'DEPOSIT_REQUEST' as const, id: 'd2', number: null, docType: null, fiscalDocument: null, stepKind: 'DEPOSIT' as const, orderId: 'o1', orderNumber: 'SO-1', date: '2026-10-01', dueDate: null, currency: 'EUR', openAmount: 500 },
    ]
    const hold = { id: 'h1', inForce: true, bySystem: true, placedAt: '2026-11-12T07:30:00.000Z', mayRelease: true, shipment: { id: 's1', number: 'SH-1', status: 'PACKED', salesOrderId: 'o1', salesOrderNumber: 'SO-1' } }
    expect(balanceOrdersOf({ orders: [order] }, items, [hold])).toEqual([{ orderId: 'o1', number: 'SO-1', open: [{ id: 'd1', openAmount: 1000, currency: 'EUR' }], holds: [hold] }])
    expect(balanceOrdersOf({ orders: [order] }, items.slice(1), [])).toEqual([])
    expect(releaseHeld({ mayRelease: false }, false)).toEqual({ key: 'balance.held.noRelease' })
    expect(releaseWordsProblem('ok')).toEqual({ key: 'balance.releaseProblem.short' })
    expect(releaseWordsProblem('Accordo del titolare')).toBeNull()
  })
})

describe('test mode', () => {
  it('shows the banner for the companies in test mode, naming them when several are seen', () => {
    expect(bannerOf([LIVE]).testing).toEqual([])
    expect(bannerOf([TESTING_FAKE]).named).toBe(false)
    const two = bannerOf([TESTING_FAKE, TESTING_SIMULATED])
    expect(two.named).toBe(true)
    expect(two.testing.map((entry) => entry.answerer)).toEqual(['FAKE', 'SIMULATED'])
    expect(bannerOf([TESTING_FAKE, TESTING_SIMULATED], TESTING_SIMULATED.companyId).testing).toHaveLength(1)
    expect(answerWords({ answerer: 'SIMULATED', outcome: 'REJECTED' })).toEqual({ key: 'testMode.answer.SIMULATED.REJECTED' })
  })

  it('holds going live with why and says what going live means', () => {
    expect(goLiveHeld(TESTING_SIMULATED)).toEqual({ key: 'goLive.problem.PROVIDER_NOT_CHOSEN' })
    expect(goLiveHeld(TESTING_FAKE)).toBeNull()
    expect(goLiveHeld({ ...TESTING_FAKE, can: { manage: false, switchRules: false } })).toEqual({ key: 'held.noTestMode' })
    expect(goLiveConsequences(0)).toEqual([{ key: 'live.forReal' }, { key: 'live.noTestSends' }])
    expect(goLiveConsequences(4)[1]).toEqual({ key: 'live.testSends', params: { count: 4 } })
    expect(readinessWords({ ready: false, open: 1, missing: 2, copied: 1, providers: [] })).toEqual([{ key: 'swap.missing', params: { count: 2 } }, { key: 'swap.open', params: { count: 1 } }])
    expect(makeCopiesHeld({ ready: true, open: 0, missing: 0, copied: 3, providers: [] }, true, false)).toEqual({ key: 'held.noneMissing' })
    expect(makeCopiesHeld(null, false, false)).toEqual({ key: 'held.noIssue' })
  })

  it('reads a refusal’s code and words it itself, never the API’s English', () => {
    expect(refusalCode(conflict('refusal/GO_LIVE'))).toBe('GO_LIVE')
    expect(depthProblem(conflict('refusal/GO_LIVE'), ['GO_LIVE'])).toEqual({ key: `${DEPTH}:refusal.GO_LIVE`, reload: false })
    expect(depthProblem(conflict('refusal/UNKNOWN'), ['GO_LIVE'])).toEqual({ key: 'problem.write.state', reload: true })
    expect(depthProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'problem.write.forbidden', reload: false })
    expect(monthName('2026-10', 'en')).toBe('October 2026')
    expect(monthName('2026-08', 'it')).toBe('agosto 2026')
  })
})

describe('the words and the design cases', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [join(dir, entry.name)] : []))

  it('has every literal key of this step’s parts in Italian and English', () => {
    const folders = ['invoices/monthly-run', 'invoices/stamp-duty', 'invoices/debit-note', 'invoices/test-mode', 'invoices/balance', 'payables/self-invoices', 'settings/tax', 'settings/sdi-test', 'settings/terms-skip', 'settings/deposit-cancel']
    const pattern = /['`]((?:self|tax|rule|stamp|run|debit|vatLimit|balance|skip|sdi|swap|live|goLive|testMode|new|more|held|common|refusal)\.[A-Za-z0-9_.]+)['`]/g
    const keys = new Set<string>()
    for (const folder of folders) for (const file of sources(join(root, folder))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    expect(keys.size).toBeGreaterThan(300)
    for (const locale of ['it', 'en'] as const) {
      const catalogues = messagesFor(locale, [DEPTH, 'finance'])
      const words = catalogues[DEPTH]!
      // The finance words these parts read with the finance translator (common.cancel, common.retry …).
      const finance = catalogues.finance!
      const missing = [...keys].filter((key) => !words[key] && !words[`${key}_other`] && !finance[key])
      expect(missing, locale).toEqual([])
    }
  })

  it('covers the states and roles the design names, each screen with its own id', () => {
    const screens = [runScreen, stampScreen, debitScreen, testModeScreen, balanceScreen]
    expect(screens.map((screen) => screen.screen)).toEqual(['SCR-440', 'SCR-441', 'SCR-442', 'SCR-443', 'SCR-444'])
    for (const screen of screens) {
      const ids = screen.cases.map((item) => item.id)
      expect(ids.some((id) => id.includes('sales')), screen.screen).toBe(true)
    }
    for (const screen of [runScreen, stampScreen, debitScreen, balanceScreen]) {
      const ids = screen.cases.map((item) => item.id)
      expect(ids.some((id) => id.endsWith('loading')), screen.screen).toBe(true)
      expect(ids.some((id) => id.endsWith('error')), screen.screen).toBe(true)
    }
  })
})
