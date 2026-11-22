import { describe, expect, it } from 'vitest'
import { ORDER_PRICE_SOURCES } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { canOf, order } from '../../_demo/fixtures'
import type { OrderAbilities } from '../../model'
import { OUR_PRICE_SOURCES, priceCheckSchema, whoName, type PriceCheck } from '../../price-check/api'
import { PRICE_CHECK } from '../../price-check/fixtures'
import { acceptBodyOf, checkTagOf, diffWordOf, priceCheckOf } from './price'

/**
 * F-OM-301 (order MONEY tab, 10-design §7; 18-lead-settles L3; B-OM-006, B-OM-020) — Price check, pure: the head's ONE line in each
 * state (none · equal, folded · not equal, the differing lines first · accepted by hand · not every line yet), where our price came
 * from, the doors by their rights (Customer's price… and Change our price › stay orders.manage; Accept the difference… / Undo the
 * acceptance… are the plan right + price, and only once the server knows acceptance) and held only by the order's state. Made up.
 */

const OWNER: OrderAbilities = { ...canOf('owner'), moneyPlan: true }
const FINANCE: OrderAbilities = { ...canOf('finance'), moneyPlan: true }
const view = (check: PriceCheck, can: OrderAbilities = OWNER, over: { canHistory?: boolean; status?: Parameters<typeof order>[0] } = {}) =>
  priceCheckOf({ check, order: order(over.status ?? 'IN_PRODUCTION'), can, prefix: '/w/DEMO', canHistory: over.canHistory ?? true })

const line = (index: number) => PRICE_CHECK.lines[index]!
/** Every line priced by the customer and equal to ours (to the cent). */
const EQUAL: PriceCheck = {
  ...PRICE_CHECK,
  lines: PRICE_CHECK.lines.slice(0, 1).map((entry) => ({ ...entry, ourPriceSource: 'LIST' as const })),
  total: { ...PRICE_CHECK.total, ourPrice: line(0).ourAmount, brandPrice: line(0).brandAmount, priceMatch: 'EQUAL', priceDiff: 0, priceNotEqualLines: 0, priceMissingLines: 0 },
}
/** Two lines priced, one 5 cents a piece apart: + € 50.00 we ask more on the order. */
const DIFF: PriceCheck = {
  ...PRICE_CHECK,
  lines: PRICE_CHECK.lines.slice(0, 2),
  total: { ...PRICE_CHECK.total, ourPrice: 2_064_000, brandPrice: 2_059_000, priceMatch: 'NOT_EQUAL', priceDiff: 5_000, priceNotEqualLines: 1, priceMissingLines: 0 },
  accepted: null,
}
const ACCEPTED: PriceCheck = { ...DIFF, accepted: { by: { name: 'Bea Esempio' }, at: '2026-11-19T10:00:00.000Z', reason: 'The measuring visit was extra; agreed by phone.', ourNet: 2_064_000, brandNet: 2_059_000 } }
const NONE: PriceCheck = { ...PRICE_CHECK, lines: PRICE_CHECK.lines.map((entry) => ({ ...entry, brandAmount: null, priceMatch: 'NO_BRAND_PRICE' as const, priceDiff: null, row: null })), total: { ...PRICE_CHECK.total, priceMatch: 'NO_BRAND_PRICE', priceNotEqualLines: 0, priceMissingLines: 3 } }

describe('F-OM-301: the head\'s one line in each state', () => {
  it('none: "— No customer price yet · type the prices from their PO…"; Customer\'s price… is the primary', () => {
    const model = view(NONE)
    expect(model.state).toBe('none')
    expect(model.tags).toEqual([{ word: { key: 'moneyTab.price.tag.none' }, tone: 'neutral' }])
    expect(model.answer).toEqual([{ key: 'moneyTab.price.answer.none' }])
    expect(model.edit).toEqual({ primary: true, held: null })
    expect(model.change).toBeNull()
  })

  it('equal: "= Prices equal · 1 line · from the portal", folded (Show the lines); no Change our price ›', () => {
    const model = view(EQUAL)
    expect(model.state).toBe('equal')
    expect(model.folded).toBe(true)
    expect(model.tags).toEqual([{ word: { key: 'moneyTab.price.tag.equal' }, tone: 'success' }])
    expect(model.answer).toEqual([{ key: 'priceCheck.lines', params: { count: 1 } }, { key: 'moneyTab.price.from.PORTAL' }])
    expect(model.change).toBeNull()
    expect(model.edit?.primary).toBe(false)
  })

  it('not equal: "≠ Not equal · 1 line · +€ 50.00 we ask more"; the differing line first; Change our price › on it', () => {
    const model = view(DIFF)
    expect(model.state).toBe('notEqual')
    expect(model.folded).toBe(false)
    expect(model.tags.map((tag) => [tag.word.key, tag.tone])).toEqual([['moneyTab.price.tag.notEqual', 'warning']])
    expect(model.answer).toEqual([{ key: 'priceCheck.lines', params: { count: 1 } }, { key: 'moneyTab.price.answer.more', money: { amount: 5_000 } }])
    expect(model.first.map((row) => row.seq)).toEqual([2])
    expect(model.rows.map((row) => row.seq)).toEqual([1, 2])
    expect(model.change).toEqual({ lineId: line(1).lineId, held: null })
  })

  it('accepted by hand: both tags, who and when, the reason; the differing line still first', () => {
    const model = view(ACCEPTED)
    expect(model.state).toBe('accepted')
    expect(model.tags.map((tag) => tag.word.key)).toEqual(['moneyTab.price.tag.notEqual', 'moneyTab.price.tag.accepted'])
    expect(model.accepted).toEqual({ words: { key: 'moneyTab.price.acceptedBy', params: { name: 'Bea Esempio' }, instants: { date: '2026-11-19T10:00:00.000Z' } }, reason: 'The measuring visit was extra; agreed by phone.' })
    expect(model.first.map((row) => row.seq)).toEqual([2])
  })

  it('not every line yet: how many lines lack the customer\'s price, and how many differ', () => {
    const partial: PriceCheck = { ...PRICE_CHECK, total: { ...PRICE_CHECK.total, priceMatch: 'NO_BRAND_PRICE' } }
    const model = view(partial)
    expect(model.state).toBe('partial')
    expect(model.answer).toEqual([{ key: 'priceCheck.card.missing', params: { missing: 1, lines: 3 } }, { key: 'moneyTab.price.answer.differ', params: { count: 1 } }])
  })
})

describe('F-OM-301: the lines', () => {
  it('our price\'s source (B-OM-006): From the price list / Set by hand / Changed since the quote; none said when the read has none', () => {
    expect(OUR_PRICE_SOURCES).toEqual(ORDER_PRICE_SOURCES)
    const sourced: PriceCheck = { ...PRICE_CHECK, lines: PRICE_CHECK.lines.map((entry, index) => ({ ...entry, ourPriceSource: OUR_PRICE_SOURCES[index] })) }
    expect(view(sourced).rows.map((row) => row.ourSource?.key ?? null)).toEqual(['moneyTab.price.source.LIST', 'moneyTab.price.source.MANUAL', 'moneyTab.price.source.UNKNOWN'])
    expect(view(PRICE_CHECK).rows.every((row) => row.ourSource === null)).toBe(true)
  })

  it('the customer\'s unit price, or its line total; the check in words with its mark; the difference signed', () => {
    const rows = view(PRICE_CHECK).rows
    expect(rows[1]).toMatchObject({ theirUnit: '95.5', theirLineTotal: false, check: { word: { key: 'moneyTab.price.check.NOT_EQUAL' }, tone: 'warning' }, diff: 5_000, differs: true })
    expect(rows[2]).toMatchObject({ theirs: null, theirUnit: null, theirLineTotal: false, check: { word: { key: 'priceCheck.NO_BRAND_PRICE' }, tone: 'neutral' } })
    const lineTotal: PriceCheck = { ...PRICE_CHECK, lines: [{ ...line(1), row: { ...line(1).row!, unitPrice: null, netAmount: 955_000 } }] }
    expect(view(lineTotal).rows[0]).toMatchObject({ theirUnit: null, theirLineTotal: true })
    expect(checkTagOf(null)).toBeNull()
    expect(diffWordOf(-1_000)).toEqual({ key: 'moneyTab.price.answer.less', money: { amount: 1_000 } })
    expect(diffWordOf(0)).toBeNull()
  })

  it('where the customer\'s price came from: one source in the head ("from the customer\'s PO {file}"), several: none in the head', () => {
    const po: PriceCheck = { ...EQUAL, lines: [{ ...line(1), priceMatch: 'EQUAL', priceDiff: 0 }] }
    expect(view(po).answer[1]).toEqual({ key: 'moneyTab.price.from.CUSTOMER_PO_FILE', params: { file: 'Brand Alpha PO 4471.pdf' } })
    expect(view(PRICE_CHECK).sources).toHaveLength(2)
  })
})

describe('F-OM-301: the doors — by their rights (L3), held only by the order\'s state', () => {
  it('the Owner: Customer\'s price…, Change our price ›, Accept the difference… (once the server knows acceptance), History ›', () => {
    const model = view(DIFF)
    expect(model.accept).toEqual({ held: null })
    expect(model.undoAccept).toBeNull()
    expect(model.history).toBe(`/w/DEMO/admin/audit?type=OrderBrandPrice&record=${order('IN_PRODUCTION').id}`)
    expect(view(ACCEPTED).accept).toBeNull()
    expect(view(ACCEPTED).undoAccept).toEqual({ held: null })
    // An older server: no `accepted` in the read — no Accept door at all (hidden, never held).
    const older: PriceCheck = { ...DIFF }
    delete (older as { accepted?: unknown }).accepted
    expect(view(older).accept).toBeNull()
    // A difference whose customer total is not known yet cannot be accepted.
    expect(view({ ...PRICE_CHECK, accepted: null }).accept).toBeNull()
  })

  it('Finance (the plan right, no orders.manage): Accept only — Customer\'s price… and Change our price › stay the Owner\'s (L3)', () => {
    const model = view(DIFF, FINANCE)
    expect(model.edit).toBeNull()
    expect(model.change).toBeNull()
    expect(model.accept).toEqual({ held: null })
    // Without the plan right: no Accept door (hidden).
    expect(view(DIFF, canOf('owner')).accept).toBeNull()
    // Without audit.read: no History ›.
    expect(view(DIFF, OWNER, { canHistory: false }).history).toBeNull()
  })

  it('a closed order: every door held in words ("A closed or cancelled order keeps its prices."); Change our price › by the amendment\'s rule', () => {
    const closed: PriceCheck = { ...DIFF, status: 'CLOSED', mayWrite: { allowed: false, why: null } }
    const model = view(closed, OWNER, { status: 'CLOSED' })
    expect(model.edit?.held).toEqual({ key: 'priceCheck.closed' })
    expect(model.accept?.held).toEqual({ key: 'priceCheck.closed' })
    expect(model.change?.held).toEqual({ key: 'held.final' })
    // Shipped goods: our price no longer changes by an amendment (its own words), the check still reads.
    expect(view(DIFF, OWNER, { status: 'SHIPPED' }).change?.held?.key).toBe('held.amendShipped')
  })

  it('Accept sends the nets as read and the reason (a check that moved meanwhile is refused and read again)', () => {
    expect(acceptBodyOf(DIFF, '  Agreed by phone  ')).toEqual({ ourNet: 2_064_000, brandNet: 2_059_000, reason: 'Agreed by phone' })
    expect(acceptBodyOf(PRICE_CHECK, 'x')).toBeNull()
  })
})

describe('F-OM-301: the read — a shape this web does not know yet is left out, never a failed read', () => {
  it('ourPriceSource and accepted parse when right, and drop when unknown', () => {
    const raw = JSON.parse(JSON.stringify(ACCEPTED)) as Record<string, unknown>
    expect(priceCheckSchema.parse(raw).accepted?.ourNet).toBe(2_064_000)
    expect(priceCheckSchema.parse({ ...raw, accepted: { odd: true } }).accepted).toBeUndefined()
    const lines = (raw.lines as Record<string, unknown>[]).map((entry) => ({ ...entry, ourPriceSource: 'SOMETHING_NEW' }))
    expect(priceCheckSchema.parse({ ...raw, lines }).lines[0]!.ourPriceSource).toBeUndefined()
    expect(whoName('Ada Demo')).toBe('Ada Demo')
    expect(whoName({ name: 'Ada Demo' })).toBe('Ada Demo')
    expect(whoName(null)).toBeNull()
  })
})

describe('F-OM-301: every word it says, in both languages', () => {
  for (const locale of LOCALES) {
    it(`${locale}: each key is there`, () => {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const keys = [
        'moneyTab.price.title', 'moneyTab.price.info', 'moneyTab.price.keys', 'moneyTab.price.part', 'moneyTab.price.more', 'moneyTab.price.show', 'moneyTab.price.hide', 'moneyTab.price.onlyDiffering', 'moneyTab.price.exact',
        'moneyTab.price.tag.none', 'moneyTab.price.tag.equal', 'moneyTab.price.tag.notEqual', 'moneyTab.price.tag.partial', 'moneyTab.price.tag.accepted', 'moneyTab.price.check.EQUAL', 'moneyTab.price.check.NOT_EQUAL',
        'moneyTab.price.answer.none', 'moneyTab.price.from.CUSTOMER_PO', 'moneyTab.price.from.PORTAL', 'moneyTab.price.from.OFFICE', 'moneyTab.price.source.LIST', 'moneyTab.price.source.MANUAL', 'moneyTab.price.source.UNKNOWN',
        'moneyTab.price.accept.door', 'moneyTab.price.accept.go', 'moneyTab.price.accept.told', 'moneyTab.price.accept.never', 'moneyTab.hand.whoKept', 'moneyTab.price.accept.gone', 'moneyTab.price.accept.happens.stay', 'moneyTab.price.accept.happens.shows', 'moneyTab.price.accept.happens.reopens',
        'moneyTab.price.unaccept.door', 'moneyTab.price.unaccept.go', 'moneyTab.price.unaccept.told', 'moneyTab.price.unaccept.never', 'moneyTab.price.unaccept.happens.again', 'moneyTab.price.unaccept.happens.kept', 'moneyTab.notice.priceAccepted', 'moneyTab.notice.priceUnaccepted',
      ]
      for (const key of keys) expect(t(key), key).not.toBe(key)
      expect(t('moneyTab.price.answer.more', { amount: '€ 1,00' })).toContain('€ 1,00')
      expect(t('moneyTab.price.from.CUSTOMER_PO_FILE', { file: 'PO.pdf' })).toContain('PO.pdf')
      expect(t('moneyTab.price.acceptedBy', { name: 'Ada Demo', date: '19 Nov' })).toContain('Ada Demo')
      expect(t('moneyTab.price.accept.title', { number: 'SO-1' })).toContain('SO-1')
      expect(t('moneyTab.price.showAll', { count: 4 })).toContain('4')
    })
  }
})
