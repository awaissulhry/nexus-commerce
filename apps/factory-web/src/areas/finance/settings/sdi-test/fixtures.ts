import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, type Role } from '../../_demo/fixtures'
import type { Readiness, SendCopy } from '../../invoices/test-mode/api'
import { LIVE, permissionsOf, TESTING_FAKE, TESTING_SIMULATED } from '../../invoices/test-mode/demo/fixtures'
import { bannerOf } from '../../invoices/test-mode/model'
import { TestModeBannerView } from '../../invoices/test-mode/view/TestModeBannerView'
import { designScreen as settingsScreen } from '../fixtures'
import { FinanceSettingsView } from '../view/FinanceSettingsView'
import { EInvoicingCards, type EInvoicingModel } from './view/EInvoicingCards'

/**
 * SCR-447 — Finance settings › E-invoicing test mode and Swap intermediary (design finance.settings sec:sdi "Test mode (W2b)"
 * and "Swap intermediary (W2b)", pop:live "Leave e-invoice test mode?"; B-W2b-417 on B-W2b-401's API; FIN-096, FIN-097),
 * made-up data only: test mode on the FAKE intermediary (Go live allowed), on a sandbox connection with answers simulated
 * and Go live held while no intermediary is chosen, the "Leave e-invoice test mode?" ActionConfirm (acknowledged, a fresh
 * code next), live with Back to test mode, a refusal, our copies ready or missing (Make the copies), the states and the
 * roles: Finance, Sales (held with why). Every connection, file and count is invented.
 */

const send = (n: number, state: SendCopy['copy']['state']): SendCopy => ({ submissionId: `0190f0e2-6161-7000-8000-${String(n).padStart(12, '0')}`, invoiceId: `0190f0e2-8181-7000-8000-${String(n).padStart(12, '0')}`, attempt: 1, fileName: `IT00000000000_000${n}A.xml`, status: 'DELIVERED', copy: { state }, providerName: 'FAKE', receipts: state === 'COMPLETE' ? [{ fileId: `0190f0e2-6262-7000-8000-${String(n).padStart(12, '0')}`, type: 'RC' }] : [], copiedAt: state === 'COMPLETE' ? '2026-11-13T10:00:00.000Z' : null })

const READY: Readiness = { ready: true, open: 0, missing: 0, copied: 3, providers: ['FAKE'] }
const MISSING: Readiness = { ready: false, open: 1, missing: 2, copied: 1, providers: ['FAKE'] }
const SENDS: SendCopy[] = [send(1, 'COMPLETE'), send(2, 'MISSING'), send(3, 'RECEIPTS_MISSING'), send(4, 'SIMULATED')]

interface SdiCase {
  role: Role
  cards: EInvoicingModel
  inPage?: boolean
}

const base = (role: Role, over: Partial<EInvoicingModel> = {}, inPage = false): SdiCase => {
  const manage = permissionsOf(role).includes('invoices.testMode.manage')
  const company = over.company?.value ?? TESTING_FAKE
  return {
    role,
    inPage,
    cards: { canIssue: permissionsOf(role).includes('invoices.issue'), copies: { value: { readiness: MISSING, sends: SENDS }, problem: null }, confirm: null, busy: false, problem: null, notice: null, ...over, company: over.company ?? { value: { ...company, can: { manage, switchRules: manage } }, problem: null } },
  }
}

function SdiDesign({ model }: { model: SdiCase }) {
  const cards = createElement(EInvoicingCards, { model: model.cards })
  if (!model.inPage) return inShell('/finance/settings', cards, model.role)
  const page = settingsScreen.cases.find((item) => item.id === 'finance')!.model.settings
  const company = model.cards.company.value
  return inShell('/finance/settings', createElement(FinanceSettingsView, { model: page, depth: { banner: createElement(TestModeBannerView, { model: bannerOf(company ? [company] : []) }), eInvoicing: cards } }), model.role)
}

export const designScreen = defineDesignScreen<SdiCase>({
  screen: 'SCR-447',
  title: 'Finance settings › E-invoicing test mode (simulated SDI answers, Leave test mode?) and Swap intermediary (our own copies)',
  view: SdiDesign,
  cases: [
    { id: 'fake', label: 'Finance · Test mode on the FAKE intermediary: Go live allowed; two sends lack our copy', model: base('finance') },
    { id: 'in-page', label: 'Finance · The cards in their place on Finance settings, with the test-mode banner', model: base('finance', {}, true) },
    { id: 'simulated', label: 'Finance · Sandbox connection, answers simulated (rejected first): Go live held — no intermediary chosen', model: base('finance', { company: { value: TESTING_SIMULATED, problem: null } }) },
    { id: 'leave', label: 'Finance · Leave e-invoice test mode? (acknowledge, then a fresh code)', model: base('finance', { confirm: 'live' }) },
    { id: 'live', label: 'Finance · Live since 09/11: Back to test mode; every copy complete', model: base('finance', { company: { value: LIVE, problem: null }, copies: { value: { readiness: READY, sends: SENDS.slice(0, 1) }, problem: null } }) },
    { id: 'back', label: 'Finance · Back to test mode?', model: base('finance', { company: { value: LIVE, problem: null }, confirm: 'test' }) },
    { id: 'refused', label: 'Finance · Refused: the company cannot go live yet (said on the card)', model: base('finance', { problem: { key: 'finance-invoices-depth:refusal.GO_LIVE', reload: false } }) },
    { id: 'went-live', label: 'Finance · Live now (notice)', model: base('finance', { company: { value: LIVE, problem: null }, notice: { tone: 'success', words: { key: 'sdi.wentLive' } } }) },
    { id: 'copies-made', label: 'Finance · Copies made (notice)', model: base('finance', { copies: { value: { readiness: READY, sends: SENDS.slice(0, 1) }, problem: null }, notice: { tone: 'success', words: { key: 'swap.made', params: { made: 2, completed: 1, remaining: 0 } } } }) },
    { id: 'sales', label: 'Sales · Go live and Make the copies held with why', model: base('sales') },
    { id: 'copies-error', label: 'Our copies could not be read (Try again); test mode shown', model: base('finance', { copies: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'loading', label: 'Loading', model: base('finance', { company: { value: null, problem: null }, copies: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base('finance', { company: { value: null, problem: 'problem.read.unavailable' } }) },
  ],
})
