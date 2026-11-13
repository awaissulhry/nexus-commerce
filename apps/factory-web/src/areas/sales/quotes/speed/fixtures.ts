import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES, rolePermissions } from '../../../../shell/design-data'
import { inShell, PREFIX } from '../../../quality/_shared/fixtures'
import type { QuoteSpeed } from '../../reports/api'
import { speedCan } from './model'
import { QuoteSpeedStrip, type QuoteSpeedModel } from './view/QuoteSpeedStrip'

/**
 * SCR-428 — Sales › Quotes › Quote speed (design sales.quotes sec quotes.speed, a section of the Quotes page shown on its own),
 * made-up figures only: November so far (sales: the tiles open Sales reports), without the price grain (no value won), without
 * Sales reports in the role (the tiles open nothing, said), nothing sent or decided yet, several currencies won, loading (tile
 * skeletons), a failed read.
 */

const SPEED: QuoteSpeed = {
  company: { id: DEMO_COMPANIES[0].id, code: DEMO_COMPANIES[0].code, name: DEMO_COMPANIES[0].name },
  from: '2026-11-01',
  to: '2026-11-12',
  today: '2026-11-12',
  asOf: '2026-11-12T08:15:00.000Z',
  sight: { orders: true, quotes: true, returns: true, values: true },
  companyCurrency: 'EUR',
  answered: 9,
  medianAnswerMinutes: 380,
  fromInquiries: 4,
  accepted: 5,
  declined: 3,
  expired: 1,
  winRatePct: '62.5',
  medianDecisionHours: 70,
  won: { byCurrency: [{ currency: 'EUR', value: 4_215_000 }], value: 4_215_000, currency: 'EUR', mixedCurrencies: false },
  complete: true,
}

const SALES = [...rolePermissions('sales'), 'sales.reports.view', 'money.price']
const model = (over: Partial<QuoteSpeedModel> = {}, permissions: readonly string[] = SALES): QuoteSpeedModel => ({ prefix: PREFIX, can: speedCan(permissions), read: { status: 'ready', value: SPEED }, ...over })

function SpeedDesign({ model: value }: { model: QuoteSpeedModel }) {
  return inShell('/sales/quotes', createElement(QuoteSpeedStrip, { model: value }), 'owner')
}

export const designScreen = defineDesignScreen<QuoteSpeedModel>({
  screen: 'SCR-428',
  title: 'Quote speed (Sales › Quotes)',
  view: SpeedDesign,
  cases: [
    { id: 'month', label: 'November so far (sales)', model: model(), note: 'Each tile opens Sales reports for this month.' },
    { id: 'no-price', label: 'Without the price grain (no value won)', model: model({ read: { status: 'ready', value: { ...SPEED, sight: { ...SPEED.sight, values: false }, won: { byCurrency: [], currency: 'EUR', mixedCurrencies: false } } } }, rolePermissions('sales').filter((name) => name !== 'money.price')) },
    { id: 'no-reports', label: 'Sales reports not in the role (tiles open nothing)', model: model({}, rolePermissions('sales').filter((name) => name !== 'sales.reports.view')) },
    { id: 'nothing', label: 'Nothing sent or decided yet', model: model({ read: { status: 'ready', value: { ...SPEED, answered: 0, medianAnswerMinutes: null, fromInquiries: 0, accepted: 0, declined: 0, expired: 0, winRatePct: null, medianDecisionHours: null, won: { byCurrency: [], value: 0, currency: 'EUR', mixedCurrencies: false } } } }) },
    { id: 'currencies', label: 'Won in two currencies', model: model({ read: { status: 'ready', value: { ...SPEED, won: { byCurrency: [{ currency: 'EUR', value: 3_015_000 }, { currency: 'CHF', value: 1_200_000 }], value: null, currency: null, mixedCurrencies: true } } } }) },
    { id: 'loading', label: 'Loading (tile skeletons)', model: model({ read: { status: 'loading' } }) },
    { id: 'error', label: 'Failed', model: model({ read: { status: 'error', problem: 'problem.read' } }) },
    { id: 'no-permission', label: 'No quotes right (the section is not drawn)', model: model({}, rolePermissions('warehouse')) },
  ],
})
