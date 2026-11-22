import { describe, expect, it } from 'vitest'
import { ORDER_COST_LINE_KINDS } from '@nexus/factory-domain/costing/margins/hand-lines'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { asSeenBy, DETAIL_1043 } from '../../../../finance/margins/demo/fixtures'
import { COST_LINE_KINDS, orderMarginSchema, type OrderMargin } from '../../../../finance/margins/api'
import { marginsCanOf, type MarginsCan } from '../../../../finance/margins/model'
import { canOf, order } from '../../_demo/fixtures'
import type { OrderAbilities } from '../../model'
import { costAmountOf, marginAfterOf, marginOf, targetOf, targetPctOf } from './margin'
import { amountsOf } from './word'

/**
 * F-OM-302 (order MONEY tab, 10-design §8; 18-lead-settles L2, L4; B-OM-007, B-OM-021) — Margin, pure: what the quoted cost was based
 * on, the four tiles (the difference only with the cost grain), the meter against the target set by hand else the floor, the cost
 * lines set by hand (ADD only, L2) with Put back, the bridge price − parts − freight − hand lines = margin, the doors (costing.ledger.manage
 * + cost; the target also the margin grain, L4) held only by a closed order, and what the windows send. Every figure is made up.
 */

const FULL: MarginsCan = { view: true, price: true, cost: true, margin: true, orders: true, costing: true }
const FINANCE: OrderAbilities = { ...canOf('finance'), costLedger: true }
const IN_PRODUCTION = order('IN_PRODUCTION')
const HAND: OrderMargin = {
  ...DETAIL_1043,
  estimate: { ...DETAIL_1043.estimate, freight: null, handCost: 32_000 },
  basedOn: { pricedOn: '2026-10-12', revision: 2 },
  handLines: [{ id: 'hl-1', kind: 'FREIGHT_ESTIMATE', amount: 32_000, currency: 'EUR', reason: 'Air freight: the fabric came late.', by: 'Bea Esempio', at: '2026-11-14T09:00:00.000Z' }],
  target: { pct: '38.0000', by: 'Alex Demo', at: '2026-11-02T10:00:00.000Z', reason: 'A key customer: we hold 38 %.' },
}
const view = (detail: OrderMargin, over: { can?: OrderAbilities; marginCan?: Pick<MarginsCan, 'cost' | 'margin' | 'price'>; status?: Parameters<typeof order>[0] } = {}) =>
  marginOf({ detail, order: order(over.status ?? 'IN_PRODUCTION'), can: over.can ?? FINANCE, marginCan: over.marginCan ?? FULL, prefix: '/w/DEMO' })

describe('F-OM-302: the head — what the quoted cost was based on (B-OM-007)', () => {
  it('"Based on: cost at quote 12 Oct · rev 2"; no cost sheet behind it; an older read; a closed order\'s margin is final', () => {
    expect(view(HAND).answer).toEqual([{ key: 'moneyTab.margin.basedOn.both', days: { date: '2026-10-12' }, params: { revision: 2 } }])
    expect(view({ ...HAND, basedOn: null }).answer[0]!.key).toBe('moneyTab.margin.basedOn.none')
    expect(view({ ...HAND, basedOn: { pricedOn: '2026-10-12', revision: null } }).answer[0]!.key).toBe('moneyTab.margin.basedOn.date')
    expect(view(DETAIL_1043).answer[0]!.key).toBe('moneyTab.margin.basedOn.quote')
    expect(view(HAND, { status: 'CLOSED' }).answer.map((entry) => entry.key)).toEqual(['moneyTab.margin.basedOn.both', 'moneyTab.margin.final'])
  })
})

describe('F-OM-302: the tiles', () => {
  it('At quote · Now (−2.8 pts since the quote) · Actual so far (reads high while work is open) · Difference (cost grain)', () => {
    const tiles = view(DETAIL_1043).tiles
    expect(tiles.map((tile) => tile.id)).toEqual(['quoted', 'now', 'actual', 'difference'])
    expect(tiles[0]).toMatchObject({ value: { key: 'moneyTab.margin.value.pct', pcts: { pct: '43.0000' } }, hint: { key: 'moneyTab.margin.tile.asSold' } })
    expect(tiles[1]).toMatchObject({ points: -2.8, hint: null })
    expect(tiles[2]!.hint).toEqual({ key: 'moneyTab.margin.tile.actualOpen' })
    expect(tiles[3]).toMatchObject({ value: { key: 'moneyTab.margin.value.signed', params: { sign: '−' }, money: { amount: 34_000 } }, tone: 'danger' })
  })

  it('no work order yet: now = the cost at quote, Actual "Not yet"; without the cost grain no Difference and no amount at all', () => {
    const fresh = view({ ...DETAIL_1043, started: false })
    expect(fresh.tiles[1]!.hint).toEqual({ key: 'moneyTab.margin.tile.noWorkOrder' })
    expect(fresh.tiles[2]!.value).toEqual({ key: 'moneyTab.margin.value.notYet' })
    const sales = marginsCanOf(['costing.view', 'money.margin'])
    const seen = view(asSeenBy(HAND, sales), { marginCan: sales })
    expect(seen.tiles.map((tile) => tile.id)).toEqual(['quoted', 'now', 'actual'])
    expect(seen.bridge).toBeNull()
    expect(seen.tiles.flatMap((tile) => amountsOf(tile.value))).toEqual([])
    // A percent not known yet is said in words, never a bare dash.
    expect(view({ ...DETAIL_1043, quotedMarginPct: null }).tiles[0]!.value).toEqual({ key: 'moneyTab.margin.value.unknown' })
  })
})

describe('F-OM-302: the meter — against the target set by hand, else the floor', () => {
  it('the target (who and when), the floor of the Sales role, the flag', () => {
    const meter = view(HAND).meter
    expect(meter).toMatchObject({ now: 40.1667, floor: 42, target: 38 })
    expect(meter.words).toEqual([
      { key: 'moneyTab.margin.meter.targetBy', pcts: { pct: '38.0000' }, params: { name: 'Alex Demo' }, instants: { date: '2026-11-02T10:00:00.000Z' } },
      { key: 'moneyTab.margin.meter.floorRole', pcts: { pct: '42' }, params: { role: 'Sales' } },
      { key: 'moneyTab.margin.meter.belowFloor' },
    ])
    expect(view({ ...HAND, target: null }).meter.target).toBeNull()
    expect(targetOf(null)).toBeNull()
  })
})

describe('F-OM-302: the cost lines set by hand (L2: added only) and the bridge', () => {
  it('each line: what, how much (cost grain), why, who and when, Put back (costing.ledger.manage + cost; held when closed)', () => {
    const hand = view(HAND).hand!
    expect(hand).toEqual([{ id: 'hl-1', kind: 'FREIGHT_ESTIMATE', label: { key: 'moneyTab.margin.kind.FREIGHT_ESTIMATE' }, amount: 32_000, reason: 'Air freight: the fabric came late.', who: { key: 'moneyTab.margin.hand.who', params: { name: 'Bea Esempio' }, instants: { date: '2026-11-14T09:00:00.000Z' } }, putBack: { held: null } }])
    expect(view(HAND, { status: 'CLOSED' }).hand![0]!.putBack).toEqual({ held: { key: 'moneyTab.margin.held.final' } })
    expect(view(HAND, { can: canOf('finance') }).hand![0]!.putBack).toBeNull()
    // An older read names no hand lines: no list, no door (hidden, never held).
    expect(view(DETAIL_1043).hand).toBeNull()
    expect(view(DETAIL_1043).setCost).toBeNull()
  })

  it('price − each part − freight − the lines set by hand = margin; no freight yet: said in words (or the hand estimate stands for it)', () => {
    const rows = view(HAND).bridge!
    expect(rows.map((row) => [row.id, row.kind, row.amount])).toEqual([
      ['price', 'value', 1_200_000],
      ['MATERIAL', 'cost', 410_000],
      ['LABOUR', 'cost', 230_000],
      ['SUBCONTRACT', 'cost', 60_000],
      ['OVERHEAD', 'cost', 18_000],
      ['hand-hl-1', 'hand', 32_000],
      ['margin', 'margin', 482_000],
    ])
    expect(rows.find((row) => row.kind === 'hand')!.tag).toEqual({ key: 'moneyTab.plan.setByHand' })
    const none = view(DETAIL_1043).bridge!
    expect(none.find((row) => row.id === 'freight')).toMatchObject({ kind: 'note', label: { key: 'moneyTab.margin.bridge.noFreight' } })
    const shipped = view({ ...HAND, handLines: [], estimate: { ...HAND.estimate, freight: 24_000 } }).bridge!
    expect(shipped.find((row) => row.id === 'freight')).toMatchObject({ kind: 'freight', amount: 24_000, tag: { key: 'moneyTab.margin.bridge.fromShipments' } })
    expect(view({ ...HAND, handLines: [] }).bridge!.find((row) => row.id === 'freight')!.label.key).toBe('moneyTab.margin.bridge.noFreightSet')
  })
})

describe('F-OM-302: the doors (L4) and the windows', () => {
  it('Set a cost by hand… (costing.ledger.manage + cost) · Set target… (+ the margin grain) · held only when the order is closed', () => {
    expect(view(HAND)).toMatchObject({ setCost: { held: null }, setTarget: { held: null }, finance: `/w/DEMO/finance/margins?open=${IN_PRODUCTION.id}` })
    expect(view(HAND, { status: 'CANCELLED' })).toMatchObject({ setCost: { held: { key: 'moneyTab.margin.held.final' } }, setTarget: { held: { key: 'moneyTab.margin.held.final' } } })
    // Without costing.ledger.manage (the Production manager, Sales): no door at all.
    expect(view(HAND, { can: canOf('finance') })).toMatchObject({ setCost: null, setTarget: null })
    // Without the cost grain: neither; without the margin grain: no target.
    expect(view(HAND, { marginCan: { ...FULL, cost: false } })).toMatchObject({ setCost: null, setTarget: null })
    expect(view(HAND, { marginCan: { ...FULL, margin: false } }).setTarget).toBeNull()
    // No `target` in the read yet: no Set target… (hidden).
    const older = { ...HAND }
    delete (older as { target?: unknown }).target
    expect(view(older).setTarget).toBeNull()
  })

  it('the kinds are the domain\'s; an amount above 0; a target above 0 and below 100 (≤ 4 decimals), empty = the floor again', () => {
    expect(COST_LINE_KINDS).toEqual(ORDER_COST_LINE_KINDS)
    expect(costAmountOf('320,00')).toBe(32_000)
    expect(costAmountOf('0')).toBeNull()
    expect(costAmountOf('abc')).toBeNull()
    expect(targetPctOf('38,5')).toEqual({ pct: '38.5' })
    expect(targetPctOf('38.5 %')).toEqual({ pct: '38.5' })
    expect(targetPctOf('')).toEqual({ pct: null })
    expect(targetPctOf('100')).toBeNull()
    expect(targetPctOf('0')).toBeNull()
    expect(marginAfterOf(DETAIL_1043, 30_000)).toBe('37.7')
    expect(marginAfterOf(asSeenBy(DETAIL_1043, { price: false, cost: true, margin: true }), 30_000)).toBeNull()
  })

  it('the read: the hand lines and the target parse as the server sends them (S3 #1857); a shape it does not know is left out', () => {
    const raw = JSON.parse(JSON.stringify(HAND)) as Record<string, unknown>
    const parsed = orderMarginSchema.parse(raw)
    expect(parsed.handLines?.[0]?.kind).toBe('FREIGHT_ESTIMATE')
    expect(parsed.target?.pct).toBe('38.0000')
    expect(parsed.estimate.handCost).toBe(32_000)
    expect(orderMarginSchema.parse({ ...raw, target: { odd: 1 }, handLines: 'x' })).toMatchObject({ target: undefined, handLines: undefined })
  })
})

describe('F-OM-302: every word it says, in both languages', () => {
  for (const locale of LOCALES) {
    it(`${locale}: each key is there`, () => {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const keys = [
        'moneyTab.margin.title', 'moneyTab.margin.info', 'moneyTab.margin.keys', 'moneyTab.margin.part', 'moneyTab.margin.more', 'moneyTab.margin.finance', 'moneyTab.margin.reading', 'moneyTab.margin.final', 'moneyTab.margin.held.final',
        'moneyTab.margin.basedOn.quote', 'moneyTab.margin.basedOn.none', 'moneyTab.margin.tile.quoted', 'moneyTab.margin.tile.now', 'moneyTab.margin.tile.actual', 'moneyTab.margin.tile.difference', 'moneyTab.margin.tile.asSold', 'moneyTab.margin.tile.noQuotedCost', 'moneyTab.margin.tile.noWorkOrder', 'moneyTab.margin.tile.sameAsQuote', 'moneyTab.margin.tile.actualFinal', 'moneyTab.margin.tile.actualOpen', 'moneyTab.margin.tile.actualNone', 'moneyTab.margin.tile.differenceHint',
        'moneyTab.margin.value.unknown', 'moneyTab.margin.value.notYet', 'moneyTab.margin.meter.label', 'moneyTab.margin.meter.belowFloor', 'moneyTab.margin.hand.adds', 'moneyTab.margin.where', 'moneyTab.margin.fold.why', 'moneyTab.margin.told', 'moneyTab.margin.who',
        'moneyTab.margin.bridge.title', 'moneyTab.margin.bridge.price', 'moneyTab.margin.bridge.FREIGHT', 'moneyTab.margin.bridge.fromShipments', 'moneyTab.margin.bridge.noFreight', 'moneyTab.margin.bridge.noFreightSet', 'moneyTab.margin.bridge.margin', 'moneyTab.margin.bridge.noCost',
        'moneyTab.margin.why.method', 'moneyTab.margin.why.provisional', 'moneyTab.margin.why.freightCounted', 'moneyTab.margin.why.freightNone', 'moneyTab.margin.why.hand', 'moneyTab.margin.why.bankCharges',
        'moneyTab.margin.setCost.door', 'moneyTab.margin.setCost.go', 'moneyTab.margin.setCost.kind', 'moneyTab.margin.setCost.kindHint', 'moneyTab.margin.setCost.problem', 'moneyTab.margin.setCost.happens.uses', 'moneyTab.margin.setCost.happens.beside', 'moneyTab.margin.setCost.never',
        'moneyTab.margin.putBack.door', 'moneyTab.margin.putBack.go', 'moneyTab.margin.putBack.gone', 'moneyTab.margin.putBack.happens.removed', 'moneyTab.margin.putBack.happens.computed', 'moneyTab.margin.putBack.never',
        'moneyTab.margin.target.door', 'moneyTab.margin.target.go', 'moneyTab.margin.target.clear', 'moneyTab.margin.target.field', 'moneyTab.margin.target.hint', 'moneyTab.margin.target.problem', 'moneyTab.margin.target.same', 'moneyTab.margin.target.happens.marks', 'moneyTab.margin.target.happens.flag', 'moneyTab.margin.target.never',
        'moneyTab.notice.costLineAdded', 'moneyTab.notice.costLineRemoved', 'moneyTab.notice.targetSet', 'moneyTab.notice.targetCleared',
        ...['MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'ADJUSTMENT'].map((part) => `moneyTab.margin.bridge.${part}`),
        ...COST_LINE_KINDS.map((kind) => `moneyTab.margin.kind.${kind}`),
      ]
      for (const key of keys) expect(t(key), key).not.toBe(key)
      expect(t('moneyTab.margin.basedOn.both', { date: '12 Oct', revision: 2 })).toContain('12 Oct')
      expect(t('moneyTab.margin.tile.points', { points: '−2.8' })).toContain('−2.8')
      expect(t('moneyTab.margin.hand.title', { count: 1 })).toContain('1')
      expect(t('moneyTab.margin.setCost.happens.after', { now: '40.2 %', after: '37.2 %' })).toContain('37.2 %')
    })
  }
})
