import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { QuoteDetail } from '../../api'
import { CAN, GRAINS, model as recordModel, quote, STYLE, withoutCost } from '../fixtures'
import { TERMS } from '../lines-depth/fixtures'
import type { QuoteDepthModel } from '../lines-depth/view/DepthSlots'
import type { ListPriceLine, PriceReason, PricingLine, QuotePricing, QuoteListPrices } from './api'
import { costBreakdown, type Words } from './model'
import { PriceDepthDesign, type PriceDepthDesignModel } from './view/PriceDepthDesign'
import type { LineWaterfallModel } from './view/LineWaterfallView'
import type { PricingByLineModel } from './view/PricingByLine'

/**
 * SCR-035-prices — the quote record's price parts (B-W2b-343), made-up data only: W1's invented jacket DEMO-JKT-01 (BLK
 * 50 2 · 52 4 · 54 2, RED 50 1 · 52 3 · 54 2) priced from an invented list "LIST-DEMO" version 2 — BLK from 470 with the
 * break from 10 pieces (14 counted), a 2 % discount (Volume) and a manual change (Competition) to 450, size 54 + 20; RED
 * from 455 with the break to 440. Each case is one state a person meets: Pricing by line (Owner, Sales without cost, two
 * selected, a net typed with its reason, saving and refused, a sent version, loading, an error), the line drawer's cost
 * breakdown and waterfall (cost changed since priced, Sales, priced by hand, the net form, sent, loading, error), and a
 * style block's discount and price by size on the Lines tab.
 */

const L1 = '0190f0e2-8888-7000-8000-000000000001'
const L2 = '0190f0e2-8888-7000-8000-000000000002'
const ENTRY_BLK = '0190f0e2-3434-7000-8000-000000000001'
const ENTRY_RED = '0190f0e2-3434-7000-8000-000000000002'
const BREAK = '0190f0e2-3434-7000-8000-000000000011'
const BREAK_RED = '0190f0e2-3434-7000-8000-000000000012'
const SIZE54 = '0190f0e2-3434-7000-8000-000000000021'
const REV = '0190f0e2-7777-7000-8000-000000000021'

export const REASONS: PriceReason[] = [
  { code: 'VOLUME', labelIt: 'Volume', labelEn: 'Volume', needsDetail: false },
  { code: 'COMPETITION', labelIt: 'Concorrenza', labelEn: 'Competition', needsDetail: false },
  { code: 'LOYALTY', labelIt: 'Fedeltà', labelEn: 'Loyalty', needsDetail: false },
  { code: 'TARGET_PRICE', labelIt: 'Prezzo obiettivo', labelEn: 'Target price', needsDetail: false },
  { code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', needsDetail: true },
]

const STEPS_BLK = [
  { kind: 'LIST' as const, unitPrice: '470', source: { type: 'PriceListEntry', id: ENTRY_BLK } },
  { kind: 'BREAK' as const, delta: '-10', unitPrice: '460', source: { type: 'PriceBreak', id: BREAK } },
  { kind: 'DISCOUNT' as const, delta: '-9.2', unitPrice: '450.8', pct: '2', reasonCode: 'VOLUME' },
  { kind: 'MANUAL' as const, delta: '-0.8', unitPrice: '450', reasonCode: 'COMPETITION', note: 'Offerta concorrente a 450' },
  { kind: 'SIZE_SURCHARGE' as const, sizes: { '54': '20' }, source: { type: 'SizeSurcharge', id: SIZE54 } },
  { kind: 'NET' as const, unitPrice: '450' },
]
const STEPS_RED = [
  { kind: 'LIST' as const, unitPrice: '455', source: { type: 'PriceListEntry', id: ENTRY_RED } },
  { kind: 'BREAK' as const, delta: '-15', unitPrice: '440', source: { type: 'PriceBreak', id: BREAK_RED } },
  { kind: 'NET' as const, unitPrice: '440' },
]

const basedOn = { revisionId: REV, revision: 1, revisionStatus: 'DRAFT', on: '2026-10-27', computedAt: '2026-10-27T09:00:00.000Z' }
const pricingLine = (over: Partial<PricingLine>): PricingLine => ({
  lineId: L1,
  seq: 10,
  kind: 'SIZE_GRID',
  feeKind: null,
  styleId: STYLE.id,
  colourwayId: STYLE.colourways[0]!.id,
  quantity: 8,
  unitPrice: '450',
  listUnitPrice: '470',
  adjustmentReason: 'COMPETITION',
  steps: STEPS_BLK,
  stepsProblem: null,
  fromList: STEPS_BLK.slice(0, 2).concat([{ kind: 'NET' as const, unitPrice: '460' }]),
  suggested: { unitPrice: '388', marginPct: '25', basedOn, problem: null },
  marginPct: '35.3272',
  belowFloor: false,
  ...over,
})

export const PRICING: QuotePricing = {
  quoteId: '0190f0e2-9999-7000-8000-000000000142',
  versionId: '0190f0e2-9999-7000-8000-100000000001',
  revision: 1,
  status: 'DRAFT',
  currency: 'EUR',
  priceBasis: 'NET',
  floor: { marginFloorPct: '25', source: 'ROLE', roleKey: 'sales', personId: null },
  lines: [
    pricingLine({}),
    pricingLine({ lineId: L2, seq: 20, colourwayId: STYLE.colourways[1]!.id, quantity: 6, unitPrice: '440', listUnitPrice: '455', adjustmentReason: null, steps: STEPS_RED, fromList: STEPS_RED, suggested: { unitPrice: '389', marginPct: '25', basedOn, problem: null }, marginPct: '22.1', belowFloor: true }),
  ],
}

const LIST_LINE = (lineId: string, entryId: string, breakId: string, sizes: ListPriceLine['sizeSurcharges']): ListPriceLine => ({
  lineId,
  seq: lineId === L1 ? 10 : 20,
  quantity: lineId === L1 ? 8 : 6,
  list: { listId: '0190f0e2-3434-7000-8000-000000000100', code: 'LIST-DEMO', versionId: '0190f0e2-3434-7000-8000-000000000101', revision: 2, entryId, validFrom: '2026-10-01', validTo: '2027-03-31', colourwayPrice: true, depth: 0 },
  listPrice: lineId === L1 ? '470' : '455',
  break: { breakId, ownBreak: true, minQuantity: 10, pieces: 14, unitPrice: lineId === L1 ? '460' : '440', discountPct: null, delta: lineId === L1 ? '-10' : '-15' },
  sizeSurcharges: sizes,
})
export const LIST_PRICES: QuoteListPrices = {
  quoteId: PRICING.quoteId,
  versionId: PRICING.versionId,
  day: '2026-10-27',
  currency: 'EUR',
  showDiscount: true,
  lines: [LIST_LINE(L1, ENTRY_BLK, BREAK, [{ size: '54', surchargeId: SIZE54, scope: 'VERSION', amount: '20', pct: null }]), LIST_LINE(L2, ENTRY_RED, BREAK_RED, [])],
}

/** The quote with its lines as the waterfall priced them (list prices, size 54's own price). */
function priced(detail: QuoteDetail): QuoteDetail {
  return {
    ...detail,
    lines: detail.lines.map((line) => (line.id === L1 ? { ...line, listUnitPrice: '470', sizes: line.sizes.map((row) => (row.size === '54' ? { ...row, unitPrice: '470' } : { ...row, unitPrice: '450' })) } : { ...line, listUnitPrice: '455', marginPct: '22.1000', belowFloor: true })),
  }
}

const QUOTE = priced(quote())
const SENT = priced(quote({ status: 'SENT', current: { status: 'SENT' } }))
const SALES_QUOTE = withoutCost(QUOTE)
const READ_ONLY_SENT = { ns: 'sales' as const, key: 'readOnly.sent', params: { revision: 1, next: 2, date: '28/11/2026' } }

const SHEET = {
  cells: (['50', '52', '54'] as const).flatMap((size) =>
    [STYLE.colourways[0]!.id, STYLE.colourways[1]!.id].map((colourwayId) => ({
      colourwayId,
      size,
      complete: true,
      missing: [],
      minutes: '95',
      material: { complete: true, amount: size === '54' ? '214.50' : '201.30', byCategory: [], lines: [] },
      labour: { complete: true, amount: '61.75', lines: [] },
      overhead: { overheadPct: '12', base: '263.05', amount: size === '54' ? '33.03' : '31.56' },
      knownTotal: size === '54' ? '309.28' : '294.61',
      total: size === '54' ? '309.28' : '294.61',
      waterfall: [],
    })),
  ),
}

const pricing = (extra: Partial<PricingByLineModel> = {}, detail: QuoteDetail = QUOTE): PricingByLineModel => ({
  quote: detail,
  pricing: { status: 'ready', value: PRICING },
  listPrices: LIST_PRICES,
  reasons: REASONS,
  grains: GRAINS.owner,
  readOnly: null,
  selected: [],
  cells: {},
  busy: false,
  notice: null,
  manual: null,
  ...extra,
})

const waterfall = (extra: Partial<LineWaterfallModel> = {}, detail: QuoteDetail = QUOTE): LineWaterfallModel => ({
  line: detail.lines[0]!,
  currency: 'EUR',
  priceBasis: 'NET',
  grains: GRAINS.owner,
  readOnly: null,
  pricing: { status: 'ready', value: { line: PRICING.lines[0]!, floorPct: '25' } },
  list: LIST_PRICES.lines[0]!,
  reasons: REASONS,
  cost: { status: 'ready', value: costBreakdown(SHEET, detail.lines[0]!) },
  net: null,
  saving: null,
  notice: null,
  ...extra,
})

const drawer = (body: LineWaterfallModel, detail: QuoteDetail = QUOTE, readOnly: Words | null = null): QuoteDepthModel['drawer'] => ({
  line: detail.lines[0]!,
  style: STYLE,
  currency: 'EUR',
  priceBasis: 'NET',
  grains: body.grains,
  readOnly,
  schedule: { status: 'ready', value: TERMS.lines[0]!, promiseDate: '2026-12-15' },
  rows: [],
  saving: false,
  problem: null,
  today: '2026-10-29',
  position: { index: 1, count: 2 },
  sections: [],
})

type Case = { id: string; label: string; model: PriceDepthDesignModel; note?: string }
const c = (id: string, label: string, model: Omit<PriceDepthDesignModel, 'record'> & { record?: Partial<PriceDepthDesignModel['record']> }, note?: string): Case => ({
  id,
  label,
  model: { ...model, record: recordModel({ grains: GRAINS.owner, can: CAN.owner, tab: 'price', quote: { status: 'ready', value: QUOTE }, ...model.record }) },
  ...(note ? { note } : {}),
})
const manual = (text: string, reasonCode: string, note = '', problem: Words | null = null): PricingByLineModel['manual'] => ({
  draft: { lineId: L2, text, reasonCode, note },
  label: '20 · DEMO-JKT-01 RED',
  current: '440',
  currency: 'EUR',
  steps: STEPS_RED,
  fromList: true,
  reasons: REASONS,
  saving: false,
  problem,
})

export const designScreen = defineDesignScreen<PriceDepthDesignModel>({
  screen: 'SCR-035-prices',
  title: 'Quote › Price & margin in depth: pricing by line, the waterfall and the manual change (B-W2b-343)',
  view: PriceDepthDesign,
  cases: [
    c('pricing', 'Owner · Price & margin › Pricing by line', { pricing: pricing() }, 'List price, options, the quantity break (from 10 pieces), the manual change with its reason, the net typed in its cell, the cost and its source, margin € and % against the floor.'),
    c('pricing-sales', 'Sales · no cost columns (margin % only)', { pricing: pricing({ quote: SALES_QUOTE, grains: GRAINS.sales }, SALES_QUOTE), record: { grains: GRAINS.sales, can: CAN.sales, quote: { status: 'ready', value: SALES_QUOTE } } }),
    c('pricing-price-only', 'A role with prices only: no cost, no margin', { pricing: pricing({ grains: GRAINS.priceOnly, quote: SALES_QUOTE }, SALES_QUOTE), record: { grains: GRAINS.priceOnly, can: CAN.viewer, quote: { status: 'ready', value: SALES_QUOTE } } }),
    c('pricing-selected', 'Two lines selected: Re-price 2 from the list · Price 2 from the cost', { pricing: pricing({ selected: [L1, L2] }) }),
    c('pricing-manual', 'A net typed in its cell: the manual change asks its reason', { pricing: pricing({ manual: manual('430', 'LOYALTY'), cells: { [L2]: 'saving' } }) }, 'Now → new, what is kept (the list start, its break), the reason from the price adjustment list.'),
    c('pricing-manual-other', 'Reason "Other" without a note: Save held with the reason', { pricing: pricing({ manual: manual('430', 'OTHER') }) }),
    c('pricing-manual-refused', 'The reason is no longer in the list (refused in words)', { pricing: pricing({ manual: manual('430', 'LOYALTY', '', { key: 'problem.reason' }), cells: { [L2]: 'failed' } }) }),
    c('pricing-done', 'Two re-priced from the list (receipt)', { pricing: pricing({ notice: { tone: 'success', words: { key: 'bulk.doneLIST', params: { count: 2 } } } }) }),
    c('pricing-sent', 'A sent version: read only, the reason said', { pricing: pricing({ readOnly: READ_ONLY_SENT }, SENT), record: { quote: { status: 'ready', value: SENT } } }),
    c('pricing-loading', 'Pricing by line while read', { pricing: pricing({ pricing: { status: 'loading' } }) }),
    c('pricing-error', "Pricing by line couldn't be read", { pricing: pricing({ pricing: { status: 'error', problem: { ns: 'sales', key: 'problem.read.unavailable' } } }) }),
    c('drawer', 'Owner · The line drawer: cost breakdown and waterfall', { pricing: pricing(), drawer: drawer(waterfall()), waterfall: waterfall() }, 'Docked on Price & margin (?line=): the steps from the list to the net, size 54 + 20, the cost sheet today against the cost the quote keeps, the margin against the floor.'),
    c('drawer-sales', 'Sales · the drawer without the cost grain', { pricing: pricing({ quote: SALES_QUOTE, grains: GRAINS.sales }, SALES_QUOTE), drawer: drawer(waterfall({ grains: GRAINS.sales, cost: { status: 'held', why: { key: 'drawer.noCostGrain' } } }, SALES_QUOTE), SALES_QUOTE), waterfall: waterfall({ grains: GRAINS.sales, cost: { status: 'held', why: { key: 'drawer.noCostGrain' } } }, SALES_QUOTE), record: { grains: GRAINS.sales, can: CAN.sales, quote: { status: 'ready', value: SALES_QUOTE } } }),
    c('drawer-no-steps', 'A line priced by hand without a waterfall', { pricing: pricing(), drawer: drawer(waterfall()), waterfall: waterfall({ pricing: { status: 'ready', value: { line: { ...PRICING.lines[0]!, steps: null, adjustmentReason: null }, floorPct: '25' } } }) }),
    c('drawer-net', 'Change the net…: the form with its reason', { pricing: pricing(), drawer: drawer(waterfall()), waterfall: waterfall({ net: { lineId: L1, text: '445', reasonCode: 'COMPETITION', note: '' } }) }),
    c('drawer-done', 'Re-priced from the list (receipt in the drawer)', { pricing: pricing(), drawer: drawer(waterfall()), waterfall: waterfall({ notice: { tone: 'success', words: { key: 'done.LIST', params: { line: 10 } } } }) }),
    c('drawer-sent', 'The drawer of a sent version: read only', { pricing: pricing({ readOnly: READ_ONLY_SENT }, SENT), drawer: drawer(waterfall({ readOnly: READ_ONLY_SENT }, SENT), SENT, READ_ONLY_SENT), waterfall: waterfall({ readOnly: READ_ONLY_SENT }, SENT), record: { quote: { status: 'ready', value: SENT } } }),
    c('drawer-loading', 'The drawer while the price is read', { pricing: pricing(), drawer: drawer(waterfall()), waterfall: waterfall({ pricing: { status: 'loading' }, cost: { status: 'loading' } }) }),
    c('drawer-error', "The line's price couldn't be read", { pricing: pricing(), drawer: drawer(waterfall()), waterfall: waterfall({ pricing: { status: 'error', problem: { ns: 'sales', key: 'problem.read.unavailable' } } }) }),
    c('lines-block', 'Lines · a style block: Discount and Price by size', { blockPricing: PRICING.lines, record: { tab: 'lines' } }, 'Under the block\'s prices: BLK discount 2 %, size 54 at 470; RED priced from its break.'),
  ],
})
