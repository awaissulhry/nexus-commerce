import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SPLIT_LIMITS } from '@nexus/factory-domain/shipping/split/split'
import type { SplitPreview } from './api'
import { cappedGroups, groupsOf, handBody, handTotals, HAND_REASONS, INTO_MAX, roomOf, splitHeld, type SplitModel } from './model'

/**
 * F-OS-302 (order SHIPMENTS tab; 13-backend B-OS-010; research X1-B3, X1-B4) — Split into several, in Warehouse's own Split window (the
 * same on Warehouse's record and the order's tab), pure: how many shipments it becomes, each new shipment's garments (a line never
 * gives more than can move; something stays; each new one takes at least one), ONE command with `groups[]` (one new shipment: today's
 * body exactly), another delivery address of the customer, and "all in one delivery" said as a warning, never a block. Made-up data.
 */

const uid = (n: number) => `0190f0e2-7498-7000-8000-${String(n).padStart(12, '0')}`

const preview = (over: Partial<SplitPreview> = {}): SplitPreview => ({
  shipmentId: uid(1),
  number: 'SEED-SH-0012',
  status: 'DRAFT',
  version: 5,
  splittable: true,
  held: false,
  lines: [
    { id: uid(11), label: 'SEED-JKT-02 · Black', size: '48', quantity: 8, packed: 0, serials: 0, movable: 8, shipBy: '2026-12-18' },
    { id: uid(12), label: 'SEED-JKT-02 · Red', size: '48', quantity: 6, packed: 0, serials: 0, movable: 6, shipBy: '2026-12-18' },
    { id: uid(13), label: 'SEED-PNT-01 · Black', size: '48', quantity: 4, packed: 1, serials: 0, movable: 3, shipBy: '2026-12-20' },
  ],
  reasons: ['CARRIER', 'SERVICE', 'SHIP_TO', 'PROMISE_DATE', 'PART_READY', 'CUSTOMER_REQUEST', 'OTHER'],
  rules: [],
  mayManage: true,
  ...over,
})

const model = (over: Partial<SplitModel> = {}): SplitModel => ({ preview: { state: 'ready', value: preview() }, mode: 'hand', quantities: {}, reason: 'PART_READY', transportBy: 'CARRIER', carrierCode: '', serviceCode: '', busy: false, problem: null, made: null, prefix: '/w/SEED', into: 2, extra: [], ...over })

describe('how many shipments: this one and up to SPLIT_LIMITS.shipments new ones', () => {
  it('2 is one new shipment (as before); `into` − 1 groups, new shipment 1 first', () => {
    expect(INTO_MAX).toBe(SPLIT_LIMITS.shipments + 1)
    expect(groupsOf({ quantities: { a: 1 } })).toEqual([{ a: 1 }])
    expect(groupsOf({ quantities: { a: 1 }, into: 4, extra: [{ b: 2 }] })).toEqual([{ a: 1 }, { b: 2 }, {}])
    expect(groupsOf({ quantities: {}, into: 99 })).toHaveLength(SPLIT_LIMITS.shipments)
  })

  it('a line never gives more than can move: earlier new shipments first; the room left for each', () => {
    const value = preview()
    const capped = cappedGroups(value, [{ [uid(13)]: 2 }, { [uid(13)]: 5 }])
    expect(capped.map((group) => group[uid(13)])).toEqual([2, 1])
    expect(roomOf(value.lines[2]!, capped, 1)).toBe(1)
    expect(roomOf(value.lines[0]!, capped, 0)).toBe(8)
    expect(handTotals(value, { [uid(11)]: 8 }, [{ [uid(12)]: 6 }])).toEqual({ moving: 14, staying: 4 })
  })
})

describe('what holds Split (each in words)', () => {
  it('something stays; each new shipment takes at least one garment; the reason and its detail as before', () => {
    const value = preview()
    const three = model({ into: 3, quantities: { [uid(11)]: 8 }, extra: [{ [uid(12)]: 6 }] })
    expect(splitHeld(three, value)).toBeNull()
    expect(splitHeld({ ...three, extra: [{}] }, value)).toEqual({ key: 'door.split.eachTakes', params: { n: 2 } })
    // A second new shipment asked only garments the first one already took (line 13 can move 3): it takes none, so it is held.
    expect(splitHeld({ ...three, quantities: { [uid(11)]: 8, [uid(13)]: 3 }, extra: [{ [uid(13)]: 2 }] }, value)).toEqual({ key: 'door.split.eachTakes', params: { n: 2 } })
    const all = preview({ lines: value.lines.map((line) => ({ ...line, packed: 0, movable: line.quantity })) })
    expect(splitHeld(model({ into: 3, quantities: { [uid(11)]: 8 }, extra: [{ [uid(12)]: 6, [uid(13)]: 4 }] }), all)).toEqual({ key: 'split.refusal.NOTHING_STAYS' })
    expect(splitHeld({ ...three, reason: null }, value)).toEqual({ key: 'split.held.pickReason' })
  })

  it('another delivery address needs one picked (X1-B4); it is offered only where the customer is known', () => {
    const value = preview()
    const shipTo = model({ quantities: { [uid(11)]: 2 }, reason: 'SHIP_TO' })
    expect(splitHeld(shipTo, value)).toEqual({ key: 'door.split.pickAddress' })
    expect(splitHeld({ ...shipTo, shipToAddressId: uid(90) }, value)).toBeNull()
    expect(HAND_REASONS).toContain('SHIP_TO')
    const dialog = readFileSync(new URL('./view/SplitDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain("(reason !== 'SHIP_TO' || model.shipToOffered)")
  })

  it('ship complete warns and never holds (X1-B3)', () => {
    expect(splitHeld(model({ quantities: { [uid(11)]: 2 }, shipComplete: true }), preview())).toBeNull()
    const dialog = readFileSync(new URL('./view/SplitDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain("{model.shipComplete && <Banner tone=\"warning\" title={t('door.split.shipComplete')} />}")
  })
})

describe('the request: ONE command (B-OS-010)', () => {
  it('one new shipment: today\'s body exactly; several: `groups`, each with the same reason and delivery', () => {
    const value = preview()
    expect(handBody(model({ quantities: { [uid(11)]: 3 } }), value)).toEqual({ version: 5, reason: 'PART_READY', lines: [{ lineId: uid(11), quantity: 3 }] })
    expect(handBody(model({ into: 3, quantities: { [uid(11)]: 8 }, extra: [{ [uid(12)]: 6, [uid(13)]: 9 }], reason: 'CARRIER', transportBy: 'CARRIER', carrierCode: ' demo-air ' }), value)).toEqual({
      version: 5,
      groups: [
        { reason: 'CARRIER', lines: [{ lineId: uid(11), quantity: 8 }], transportBy: 'CARRIER', carrierCode: 'demo-air' },
        { reason: 'CARRIER', lines: [{ lineId: uid(12), quantity: 6 }, { lineId: uid(13), quantity: 3 }], transportBy: 'CARRIER', carrierCode: 'demo-air' },
      ],
    })
    expect(handBody(model({ quantities: { [uid(11)]: 2 }, reason: 'SHIP_TO', shipToAddressId: uid(90) }), value)).toEqual({ version: 5, reason: 'SHIP_TO', lines: [{ lineId: uid(11), quantity: 2 }], shipToAddressId: uid(90) })
  })

  it('both pages open the same Split: Warehouse\'s record with its customer and address, the tab with the order\'s customer and ship complete', () => {
    const record = readFileSync(new URL('../record-depth.tsx', import.meta.url), 'utf8')
    expect(record).toContain('partyId={shipment.partyId} shipToAddressId={shipment.shipToAddressId ?? null}')
    const tab = readFileSync(new URL('../../../../sales/orders/record/use-shipments-acts.ts', import.meta.url), 'utf8')
    expect(tab).toContain('createElement(Split, {')
    expect(tab).toContain('partyId: order.partyId, shipComplete: order.shipComplete')
    // F-OS-305 (os-fx3): the tab knows the shipment's own address now (the order read's row) and leaves it out too.
    expect(tab).toContain('shipToAddressId: row.shipToAddressId ?? null')
    expect(tab).toContain('shipToAddressId: row.shipToAddressId /* F-OS-305')
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
    expect(api).toContain('answer.shipments ?? [answer.shipment]')
  })
})

describe('every word the Split window names in the lane\'s namespace exists in it and en (L11)', () => {
  it('each door.split.* key of the dialog and its model', async () => {
    const { CATALOGUE } = await import('../../../../../lib/i18n/messages')
    const { LOCALES } = await import('../../../../../lib/i18n/locales')
    const source = ['./view/SplitDialog.tsx', './model.ts', './Split.tsx'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
    const keys = [...new Set([...source.matchAll(/'(door\.split\.[a-zA-Z.]+)'/g)].map((match) => match[1]!))]
    expect(keys.length).toBeGreaterThan(10)
    for (const locale of LOCALES) for (const key of keys) expect(CATALOGUE[locale]['order-shipments']?.[key], `${locale} ${key}`).toBeTruthy()
  })
})

// ── os-fx7 (30-walk W-16, W-17) ──
describe('os-fx7: the split dialog\'s words and its line facts', () => {
  const view = readFileSync(new URL('./view/SplitDialog.tsx', import.meta.url), 'utf8')
  it('W-16: by hand the act says "Split into n shipments" (never "Move 0 garments"); the stray stops and the act\'s ellipsis are gone', async () => {
    const { CATALOGUE } = await import('../../../../../lib/i18n/messages')
    const { LOCALES } = await import('../../../../../lib/i18n/locales')
    expect(view).toContain("t('door.split.goInto', { count: groups.length + 1 })")
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['order-shipments'] ?? {}
      expect(words['door.split.goInto'], locale).toContain('{count}')
      for (const [key, value] of Object.entries(words)) expect(value, `${locale} ${key}`).not.toMatch(/…\.$|\.\.$/)
      const depth = CATALOGUE[locale]['warehouse-shipments-depth'] ?? {}
      expect(depth['holds.placeGoBare'], locale).toBeTruthy()
      expect(depth['holds.placeGoBare'], locale).not.toContain('…')
      expect(depth['split.goHand_one'], locale).toBeUndefined()
    }
    expect(readFileSync(new URL('../../holds/view/HoldsPanelView.tsx', import.meta.url), 'utf8')).toContain("t('holds.placeGoBare')")
  })
  it('W-17: a line\'s facts wrap in the dialog (never cut with an ellipsis); the list\'s one-line cells keep theirs', () => {
    expect(view).toContain('className="fw-sh-cell-sub fw-shd-wrap"')
    const css = readFileSync(new URL('../shared/depth.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-sh-cell-sub\.fw-shd-wrap \{\s*white-space: normal;/)
  })
})
// ── end os-fx7 ──
