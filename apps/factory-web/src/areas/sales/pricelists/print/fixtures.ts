import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { can, DETAIL, NOW, RULES, V2, V2_DATED, withoutCost } from '../_demo/fixtures'
import { PriceListPrintView, type PriceListPrintModel } from './view/PriceListPrintView'

/**
 * SCR-420 — the price list PDF (design sales.pricelists tab:pricelists.pdf "Sent to a customer or printed for a fair";
 * B-W2b-343): a print view in a new tab the browser prints or saves as a PDF, made-up data only — the invented list
 * MODA-DEMO, its draft version 2 with a season-priced glove, its quantity breaks and size surcharges. Prices need the price
 * grain; no cost or margin is ever printed.
 */

const model = (extra: Partial<PriceListPrintModel> = {}): PriceListPrintModel => ({
  person: DEMO_USER.displayName,
  at: NOW,
  company: 'Officina Demo S.r.l.',
  can: can('sales'),
  back: `/w/DEMO/sales/price-lists/${DETAIL.id}?tab=prices&version=${V2.id}`,
  list: DETAIL,
  prices: { version: V2, entries: withoutCost(V2_DATED) },
  rules: RULES,
  problem: null,
  ...extra,
})

export const designScreen = defineDesignScreen<PriceListPrintModel>({
  screen: 'SCR-420',
  title: 'Price list PDF (print view, B-W2b-343)',
  view: PriceListPrintView,
  cases: [
    { id: 'review', label: 'Sales · MODA-DEMO version 2: prices with their days, breaks, surcharges', model: model(), note: 'Print or save as PDF from the strip; the list, its version, days and currency on top.' },
    { id: 'net-only', label: 'A list whose documents show the net price only', model: model({ rules: { ...RULES, list: { ...RULES.list, showDiscount: false }, breaks: [], sizeSurcharges: [] } }) },
    { id: 'no-price', label: 'A role without selling prices: nothing printed, the reason said', model: model({ can: can('readOnly'), prices: null, rules: null }) },
    { id: 'loading', label: 'Still reading (Print held with the reason)', model: model({ prices: null, rules: null }) },
    { id: 'error', label: "The price list couldn't be read", model: model({ list: null, prices: null, rules: null, problem: 'problem.read.unavailable' }) },
    { id: 'no-permission', label: 'Planner: no pricelists.view', model: model({ can: can('planner'), list: null, prices: null, rules: null }) },
  ],
})
