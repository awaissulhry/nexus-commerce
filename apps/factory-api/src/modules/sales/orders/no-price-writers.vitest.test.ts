import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { GRAINS, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { unheldMoneyInput } from '@nexus/factory-domain/money/filter'
import { mtmLineBody, mtmLineEditBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { acceptContract } from '../portal-ordering/contract'
import { addLineContract, editLineContract } from '../quotes/contract'
import { createManualContract, previewManualContract } from './daily-contract'
import { moneyPlanContract, moneyPlanPreviewContract } from './daily-contract' // B-OM-011

/**
 * Sales keeps no blind price writes (customer page lane B-CP-012; D1-c, review A8), pure: every price input of an order, a
 * quote line and a portal request's accept — the unit prices AND every percent of a price (a discount off the list price) —
 * is marked money.price, so the API's grain filter (platform/auth/roles/grain-filter.ts) refuses a body that sends one from a
 * caller without the price grain (a Sales worker, a production manager) and takes it from a price holder. The PG half is
 * no-price-writers.pg.vitest.test.ts.
 */

const NONE: ReadonlySet<Grain> = new Set()
const PRICE: ReadonlySet<Grain> = new Set<Grain>(['price'])
const ALL: ReadonlySet<Grain> = new Set(GRAINS)
const id = '00000000-0000-7000-8000-000000000001'
const paths = (schema: unknown, body: unknown, held: ReadonlySet<Grain>) => unheldMoneyInput(schema as z.ZodType, body, held).map((issue) => issue.path)

const orderLine = { styleId: id, colourwayId: id, sizes: [{ size: '50', quantity: 2 }] }
const manual = (line: Record<string, unknown>) => ({ companyId: id, partyId: id, lines: [{ ...orderLine, ...line }] })

describe('every percent of a price is a price (money.price)', () => {
  it('an order line: the unit price, a size price and the discount are refused without the price grain', () => {
    for (const schema of [createManualContract.body, previewManualContract.body]) {
      expect(paths(schema, manual({ discountPct: '10' }), NONE)).toEqual(['lines/0/discountPct'])
      expect(paths(schema, manual({ unitPrice: '100' }), NONE)).toEqual(['lines/0/unitPrice'])
      expect(paths(schema, manual({ sizes: [{ size: '50', quantity: 2, unitPrice: '105' }] }), NONE)).toEqual(['lines/0/sizes/0/unitPrice'])
      // Without any price key a no-price writer passes: the line takes the customer's price list.
      expect(paths(schema, manual({}), NONE)).toEqual([])
      // A price holder sends them.
      expect(paths(schema, manual({ discountPct: '10' }), PRICE)).toEqual([])
      expect(paths(schema, manual({ unitPrice: '100' }), ALL)).toEqual([])
    }
  })

  it('a quote line (size grid and made to measure): the discount, the unit and the list price', () => {
    const quoteLine = { version: 1, styleId: id, colourwayId: id, sizes: [{ size: '50', quantity: 1 }] }
    expect(paths(addLineContract.body, { ...quoteLine, discountPct: '5' }, NONE)).toEqual(['discountPct'])
    expect(paths(addLineContract.body, { ...quoteLine, unitPrice: '99', listUnitPrice: '120' }, NONE)).toEqual(['unitPrice', 'listUnitPrice'])
    expect(paths(addLineContract.body, quoteLine, NONE)).toEqual([])
    expect(paths(editLineContract.body, { version: 2, discountPct: '5' }, NONE)).toEqual(['discountPct'])
    expect(paths(editLineContract.body, { version: 2, discountPct: '5' }, PRICE)).toEqual([])
    const unit = { version: 1, styleId: id, colourwayId: id, measurementProfileId: id }
    expect(paths(mtmLineBody, { ...unit, discountPct: '5' }, NONE)).toEqual(['discountPct'])
    expect(paths(mtmLineEditBody, { version: 1, discountPct: '5' }, NONE)).toEqual(['discountPct'])
    expect(paths(mtmLineEditBody, { version: 1, discountPct: '5' }, PRICE)).toEqual([])
    // Even a null price key is a price key: the body is refused, never read as "no price".
    expect(paths(addLineContract.body, { ...quoteLine, discountPct: null }, NONE)).toEqual(['discountPct'])
  })

  it('a portal request accepted as an order: a typed unit price per line is a price; none is not', () => {
    expect(paths(acceptContract.body, { version: 1, as: 'ORDER', lines: [{ lineId: id, unitPrice: '100' }] }, NONE)).toEqual(['lines/0/unitPrice'])
    expect(paths(acceptContract.body, { version: 1, as: 'ORDER' }, NONE)).toEqual([])
    expect(paths(acceptContract.body, { version: 1, as: 'QUOTE' }, NONE)).toEqual([])
  })
})

// ── B-OM-011 … 016 (order money tab): the money plan's amount and share are prices (money.price) ──
describe('the money plan by hand: an amount or a share of the total is a price', () => {
  it('refused without the price grain (a custom role with the money plan and no prices); a day or a name passes', () => {
    for (const schema of [moneyPlanContract.body, moneyPlanPreviewContract.body]) {
      const replace = { act: 'REPLACE_DEPOSIT', requestId: id, version: 1, reason: 'Made-up reason.' }
      expect(paths(schema, { ...replace, amount: 40_000 }, NONE)).toEqual(['amount'])
      expect(paths(schema, { ...replace, pct: '40' }, NONE)).toEqual(['pct'])
      expect(paths(schema, { act: 'CHANGE_STEP', milestoneId: id, version: 1, reason: 'Made-up reason.', amount: 1_000, restTo: id }, NONE)).toEqual(['amount'])
      expect(paths(schema, { act: 'MOVE_DUE', milestoneId: id, version: 1, reason: 'Made-up reason.', dueDate: '2026-12-01' }, NONE)).toEqual([])
      expect(paths(schema, { act: 'RENAME_STEP', milestoneId: id, version: 1, reason: 'Made-up reason.', label: 'Saldo' }, NONE)).toEqual([])
      expect(paths(schema, { ...replace, amount: 40_000 }, PRICE)).toEqual([])
    }
  })
})
// ── end B-OM-011 … 016 ──
