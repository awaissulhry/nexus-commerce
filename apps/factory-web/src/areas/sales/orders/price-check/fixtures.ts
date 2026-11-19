import type { PriceCheck } from './api'
import { draftOf } from './model'
import type { PriceCheckDialogModel } from './use-price-check'

/**
 * F-CP-114 — made-up price checks for the design cases and the tests of the ONE customer's-price window (picture 21): an order of
 * three lines in EUR, the first priced by the customer in its portal (equal), the second typed by us from its PO (5 cents a piece
 * apart: not equal), the third without the customer's price yet. Nothing here is a real company, person, order or number. Design-only
 * (a fixtures file: only fixtures and tests import it); it exports no `designScreen`.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const PRICE_ORDER_ID = uid('5151', 142)

export const PRICE_CHECK: PriceCheck = {
  orderId: PRICE_ORDER_ID,
  number: 'SO-2026-0142',
  currency: 'EUR',
  status: 'IN_PRODUCTION',
  lines: [
    {
      lineId: uid('5252', 1),
      seq: 1,
      label: 'JKT-01 Rider jacket · Black',
      pieces: 120,
      ourUnitPrice: '92',
      ourAmount: 1_104_000,
      brandAmount: 1_104_000,
      priceMatch: 'EQUAL',
      priceDiff: 0,
      row: { id: uid('5353', 1), unitPrice: '92', netAmount: null, currency: 'EUR', source: 'PORTAL', sourceFile: null, note: null, enteredBy: null, enteredAt: '2026-11-12T09:20:00.000Z', version: 1 },
    },
    {
      lineId: uid('5252', 2),
      seq: 2,
      label: 'JKT-01 Rider jacket · Navy',
      pieces: 100,
      ourUnitPrice: '96',
      ourAmount: 960_000,
      brandAmount: 955_000,
      priceMatch: 'NOT_EQUAL',
      priceDiff: 5_000,
      row: { id: uid('5353', 2), unitPrice: '95.5', netAmount: null, currency: 'EUR', source: 'CUSTOMER_PO', sourceFile: { id: uid('5454', 1), name: 'Brand Alpha PO 4471.pdf' }, note: 'PO 4471, page 2', enteredBy: { name: 'Ada Demo' }, enteredAt: '2026-11-19T10:05:00.000Z', version: 2 },
    },
    {
      lineId: uid('5252', 3),
      seq: 3,
      label: 'PAT-05 Patch set · Red',
      pieces: 40,
      ourUnitPrice: '16',
      ourAmount: 64_000,
      brandAmount: null,
      priceMatch: 'NO_BRAND_PRICE',
      priceDiff: null,
      row: null,
    },
  ],
  total: { ourPrice: 2_128_000, brandPrice: null, priceMatch: 'NOT_EQUAL', priceDiff: null, priceNotEqualLines: 1, priceMissingLines: 1, priceOtherCurrency: 0, row: null },
  fromRequest: null,
  mayWrite: { allowed: true, why: null },
}

export const PRICE_FILES = [
  { id: uid('5454', 1), name: 'Brand Alpha PO 4471.pdf' },
  { id: uid('5454', 2), name: 'Brand Alpha size chart.xlsx' },
] as const

export type PriceWindowCase = 'edit' | 'stale' | 'closed' | 'reading' | 'failed'

/** The window as the hook would hold it, for one state of the design cases. */
export function priceWindowOf(kind: PriceWindowCase, check: PriceCheck = PRICE_CHECK): PriceCheckDialogModel {
  const shown: PriceCheck = kind === 'closed' ? { ...check, status: 'CLOSED', mayWrite: { allowed: false, why: null } } : check
  const ready = kind !== 'reading' && kind !== 'failed'
  return {
    orderId: shown.orderId,
    number: shown.number,
    read: kind === 'reading' ? { status: 'reading' } : kind === 'failed' ? { status: 'failed', problem: 'problem.read.unavailable' } : { status: 'ready', check: shown },
    files: ready ? { status: 'ready', files: PRICE_FILES } : { status: 'reading' },
    draft: ready ? draftOf(shown, 'en') : null,
    busy: false,
    notice: kind === 'stale' ? { tone: 'warning', words: { key: 'priceCheck.stale' } } : null,
    fields: {},
  }
}
