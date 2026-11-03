import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { Dec } from '../../tax/decimal'
import { levelOf, packProblems, packsOf, packWords } from './consumables'
import { certificateOf, coverageOf, recallWords, recordProblems, recordRefusal, recordWarnings, withdrawProblems, type RecordFacts } from './protectors'
import {
  atWorkOrderRefusal,
  correctDecision,
  describeRefusal,
  descriptionProblems,
  endDecision,
  issueDecision,
  lengthIn,
  lotCheckWords,
  lotRollCheck,
  moveDecision,
  returnDecision,
  rollDraftProblems,
  rollShadeProblem,
  rollsWords,
  scrapDecision,
  stateOf,
  tagRefusal,
  type RollFacts,
} from './rolls'

/**
 * Rolls, protector lots and consumables (B-W2b-107; SCM-260, SCM-261, SCM-263), pure: a roll's length left moving with the lot,
 * the lot's rolls against its ledger, a protector lot's certificate, refusals and the recall in words, consumables in packs with
 * the site's minimum and maximum. Made-up figures.
 */

const roll = (over: Partial<RollFacts> = {}): RollFacts => ({ code: 'RL-AB-0001-X', state: 'FULL', length: '60.0000', lengthLeft: '60.0000', uom: 'M', locationId: 'loc-store', ...over })

describe('a roll and what is left of it (SCM-260)', () => {
  it('converts lengths and says the state what is left says', () => {
    expect(lengthIn('145', 'CM', 'M').toFixed(4)).toBe('1.4500')
    expect(lengthIn('2.5', 'M', 'MM').toFixed(4)).toBe('2500.0000')
    expect(stateOf('60', '60', false)).toBe('FULL')
    expect(stateOf('60', '44.5', false)).toBe('PARTIAL')
    expect(stateOf('60', '6', true)).toBe('END')
    expect(stateOf('60', '0', true)).toBe('CONSUMED')
  })

  it('checks a roll to tag and its description', () => {
    expect(rollDraftProblems({ length: '60' }, 'M')).toEqual([])
    expect(rollDraftProblems({ length: '0' }, 'M').map((problem) => problem.path)).toEqual(['length'])
    expect(rollDraftProblems({ length: '200000' }, 'M').map((problem) => problem.path)).toEqual(['length'])
    expect(rollDraftProblems({ length: '200000' }, 'CM')).toEqual([])
    expect(descriptionProblems({ widthCm: '0', shrinkageLengthPercent: '101', shrinkageGroup: 'S 1' }).map((problem) => problem.path)).toEqual(['widthCm', 'shrinkageLengthPercent', 'shrinkageGroup'])
    expect(descriptionProblems({ widthCm: '145.5', shrinkageLengthPercent: '1.5', shrinkageWidthPercent: '0.80', shrinkageGroup: 'S1' })).toEqual([])
    expect(describeRefusal(roll({ state: 'SCRAPPED' }))?.code).toBe('ROLL_GONE')
    expect(describeRefusal(roll({ state: 'CONSUMED', locationId: null, lengthLeft: '0' }))).toBeNull()
  })

  it('takes a length off a roll in stock, or all of it', () => {
    const part = issueDecision(roll(), '15.5')
    expect(part).toEqual({ ok: true, quantity: '15.5000', after: { lengthLeft: '44.5000', state: 'PARTIAL', locationId: 'loc-store' } })
    const whole = issueDecision(roll({ state: 'PARTIAL', lengthLeft: '44.5' }))
    expect(whole).toEqual({ ok: true, quantity: '44.5000', after: { lengthLeft: '0.0000', state: 'CONSUMED', locationId: null } })
    const fromEnd = issueDecision(roll({ state: 'END', lengthLeft: '8' }), '3')
    expect(fromEnd.ok && fromEnd.after.state).toBe('END')
    const beyond = issueDecision(roll({ lengthLeft: '10', state: 'PARTIAL' }), '12')
    expect(!beyond.ok && beyond.refusal).toEqual({ code: 'LENGTH_BEYOND_LEFT', message: 'Roll RL-AB-0001-X has 10 m left: take at most that.' })
    const gone = issueDecision(roll({ state: 'CONSUMED', lengthLeft: '0', locationId: null }))
    expect(!gone.ok && gone.refusal.code).toBe('ROLL_NOT_IN_STOCK')
  })

  it('takes the end of a roll back only when the roll went whole to a work order', () => {
    const consumed = roll({ state: 'CONSUMED', lengthLeft: '0', locationId: null })
    expect(returnDecision(consumed, '6.2', 'loc-rack')).toEqual({ ok: true, quantity: '6.2000', after: { lengthLeft: '6.2000', state: 'END', locationId: 'loc-rack' } })
    const unused = returnDecision(consumed, '60', 'loc-rack')
    expect(unused.ok && unused.after.state).toBe('FULL')
    const more = returnDecision(consumed, '61', 'loc-rack')
    expect(!more.ok && more.refusal.code).toBe('LENGTH_BEYOND_ROLL')
    const inStock = returnDecision(roll({ state: 'PARTIAL', lengthLeft: '30' }), '2', 'loc-rack')
    expect(!inStock.ok && inStock.refusal.code).toBe('ROLL_NOT_CONSUMED')
    expect(atWorkOrderRefusal(consumed, 'WO-0005', 'LT-0004', new Dec('12'), new Dec('6'), 'M')).toBeNull()
    expect(atWorkOrderRefusal(consumed, 'WO-0005', 'LT-0004', new Dec('4'), new Dec('6'), 'M')?.message).toBe('Work order WO-0005 holds 4 m of lot LT-0004: at most that comes back on roll RL-AB-0001-X.')
    expect(atWorkOrderRefusal(consumed, 'WO-0005', 'LT-0004', new Dec('0'), new Dec('6'), 'M')?.message).toBe('Work order WO-0005 holds none of lot LT-0004: roll RL-AB-0001-X did not go to it.')
  })

  it('moves, scraps, corrects and sets aside a roll in stock', () => {
    expect(moveDecision(roll(), 'loc-cut')).toEqual({ ok: true, quantity: '60.0000', after: { lengthLeft: '60.0000', state: 'FULL', locationId: 'loc-cut' } })
    const same = moveDecision(roll(), 'loc-store')
    expect(!same.ok && same.refusal.code).toBe('SAME_PLACE')
    expect(scrapDecision(roll({ state: 'PARTIAL', lengthLeft: '20' }))).toEqual({ ok: true, quantity: '20.0000', after: { lengthLeft: '20.0000', state: 'SCRAPPED', locationId: null } })
    const shorter = correctDecision(roll(), '58.5')
    expect(shorter).toEqual({ ok: true, quantity: '1.5000', direction: 'OUT', after: { lengthLeft: '58.5000', state: 'PARTIAL', locationId: 'loc-store' } })
    const longer = correctDecision(roll({ state: 'PARTIAL', lengthLeft: '40' }), '42')
    expect(longer.ok && longer.direction).toBe('IN')
    const empty = correctDecision(roll({ state: 'END', lengthLeft: '3' }), '0')
    expect(empty.ok && empty.after).toEqual({ lengthLeft: '0.0000', state: 'CONSUMED', locationId: null })
    const above = correctDecision(roll(), '61')
    expect(!above.ok && above.refusal.code).toBe('LENGTH_BEYOND_ROLL')
    const same2 = correctDecision(roll(), '60')
    expect(!same2.ok && same2.refusal.code).toBe('NOTHING_CHANGES')
    const end = endDecision(roll({ state: 'PARTIAL', lengthLeft: '4' }), true)
    expect(end.ok && end.after.state).toBe('END')
    const full = endDecision(roll(), true)
    expect(!full.ok && full.refusal.code).toBe('NOT_A_PART_ROLL')
  })

  it('sorts a roll only into a shade group of its article, colour and lot', () => {
    const facts = { code: 'RL-1', itemId: 'lin', lotId: 'lot-1', itemColourId: 'black', shadeGroupId: null }
    const group = { id: 'g1', itemId: 'lin', itemColourId: null, lotId: null, label: '1', active: true }
    expect(rollShadeProblem(group, facts)).toBeNull()
    expect(rollShadeProblem({ ...group, active: false }, facts)).toBe('Shade group 1 is retired: no roll is sorted into it.')
    expect(rollShadeProblem({ ...group, lotId: 'lot-2' }, facts)).toBe("Shade group 1 is another lot's.")
    expect(rollShadeProblem({ ...group, itemColourId: 'white' }, facts)).toBe('Shade group 1 is of another colour than roll RL-1.')
    expect(rollShadeProblem({ ...group, active: false }, { ...facts, shadeGroupId: 'g1' })).toBeNull()
  })
})

describe('the lot against its rolls (SCM-260)', () => {
  const onHand = new Map([['store', new Dec('120')], ['cut', new Dec('0')]])

  it('counts what no roll claims and what the rolls say beyond the ledger, per place', () => {
    const check = lotRollCheck(onHand, [
      { locationId: 'store', lengthLeftBase: new Dec('60') },
      { locationId: 'cut', lengthLeftBase: new Dec('44.5') },
    ])
    expect(check.onHand.toFixed(1)).toBe('120.0')
    expect(check.tagged.toFixed(1)).toBe('104.5')
    expect(check.untagged.toFixed(1)).toBe('60.0')
    expect(check.beyond.toFixed(1)).toBe('44.5')
    expect(lotCheckWords(check, 2, 'M', 'en')).toBe('120 m in stock: 2 rolls · 104.5 m; 60 m on no roll; the rolls say 44.5 m more than the ledger holds where they lie')
    expect(lotCheckWords(check, 2, 'M', 'it')).toBe('120 m a magazzino: 2 rotoli · 104,5 m; 60 m senza rotolo; i rotoli dicono 44,5 m in più di quanto il registro ha dove si trovano')
    expect(rollsWords(1, '1250.5', 'M', 'en')).toBe('1 roll · 1,250.5 m')
  })

  it('never tags more than a place holds without a roll', () => {
    const place = { locationId: 'store', onHand: new Dec('120'), tagged: new Dec('60') }
    expect(tagRefusal('LT-1', 'A1', place, [new Dec('30'), new Dec('30')], 'M')).toBeNull()
    expect(tagRefusal('LT-1', 'A1', place, [new Dec('30'), new Dec('31')], 'M')).toEqual({ code: 'TAGGED_BEYOND_STOCK', message: 'The 2 rolls say 61 m, but lot LT-1 has 60 m at A1 that no roll claims yet.' })
    expect(tagRefusal('LT-1', 'A9', undefined, [new Dec('1')], 'M')?.code).toBe('NOTHING_TO_TAG')
  })
})

describe('protector lots (SCM-261)', () => {
  it('says the lot certificate as it stands today', () => {
    expect(certificateOf({ isPpeComponent: true, documents: [{ validTo: '2027-06-30' }] }, '2026-11-03')).toMatchObject({ state: 'PRESENT', validTo: '2027-06-30' })
    expect(certificateOf({ isPpeComponent: true, documents: [{ validTo: null }, { validTo: '2025-01-01' }] }, '2026-11-03')).toMatchObject({ state: 'PRESENT', validTo: null })
    expect(certificateOf({ isPpeComponent: true, documents: [{ validTo: '2026-01-31' }] }, '2026-11-03')).toMatchObject({ state: 'EXPIRED', validTo: '2026-01-31' })
    expect(certificateOf({ isPpeComponent: true, documents: [] }, '2026-11-03').state).toBe('MISSING')
    expect(certificateOf({ isPpeComponent: false, documents: [] }, '2026-11-03').state).toBe('NOT_NEEDED')
  })

  const facts = (over: Partial<RecordFacts> = {}): RecordFacts => ({
    workOrder: { number: 'WO-0001', status: 'IN_PROGRESS', siteId: 's1' },
    workOrderId: 'wo1',
    serial: null,
    lot: { code: 'PL-07', siteId: 's1' },
    item: { code: 'PRO-300', kind: 'PROTECTOR', isPpeComponent: true },
    duplicate: false,
    ...over,
  })

  it('refuses in words what the database would, and warns without refusing', () => {
    expect(recordRefusal(facts())).toBeNull()
    expect(recordRefusal(facts({ workOrder: { number: 'WO-0009', status: 'DRAFT', siteId: 's1' } }))?.code).toBe('NOTHING_BUILT')
    expect(recordRefusal(facts({ serial: { serial: 'SN-1', workOrderId: 'wo2', status: 'MADE' } }))?.code).toBe('SERIAL_NOT_OF_ORDER')
    expect(recordRefusal(facts({ serial: { serial: 'SN-1', workOrderId: 'wo1', status: 'VOID' } }))?.code).toBe('SERIAL_VOID')
    expect(recordRefusal(facts({ lot: { code: 'PL-07', siteId: 's2' } }))?.code).toBe('LOT_NOT_AT_SITE')
    expect(recordRefusal(facts({ item: { code: 'LIN-200', kind: 'LINING', isPpeComponent: false } }))?.message).toBe('Lot PL-07 is of LIN-200, which is no protector (kind PROTECTOR, or a certified PPE component).')
    expect(recordRefusal(facts({ duplicate: true }))?.message).toBe('Lot PL-07 is already recorded for batch WO-0001 at that place.')
    expect(recordWarnings({ lotCode: 'PL-07', workOrderNumber: 'WO-0001', certificate: 'MISSING', qualityStatus: 'QUARANTINE', issuedToOrder: false }).map((warning) => warning.code)).toEqual(['CERTIFICATE_MISSING', 'LOT_NOT_RELEASED', 'NOT_ISSUED_TO_ORDER'])
    expect(recordWarnings({ lotCode: 'PL-07', workOrderNumber: 'WO-0001', certificate: 'PRESENT', qualityStatus: 'RELEASED', issuedToOrder: true })).toEqual([])
    expect(recordProblems({ placement: 'x'.repeat(61) }).map((problem) => problem.path)).toEqual(['placement'])
    expect(withdrawProblems({ reason: 'no' }).map((problem) => problem.path)).toEqual(['reason'])
  })

  it("covers a batch's protectors and writes the recall", () => {
    const coverage = coverageOf(
      [{ itemId: 'shoulder', code: 'PRO-300' }, { itemId: 'back', code: 'PRO-310' }],
      [
        { itemId: 'shoulder', lotId: 'pl7', garmentSerialId: null, voided: false },
        { itemId: 'shoulder', lotId: 'pl7', garmentSerialId: 'sn1', voided: false },
        { itemId: 'elbow', lotId: 'pl9', garmentSerialId: null, voided: false },
        { itemId: 'back', lotId: 'pl8', garmentSerialId: null, voided: true },
      ],
    )
    expect(coverage).toEqual([
      { itemId: 'shoulder', code: 'PRO-300', batchLotIds: ['pl7'], garments: 1, missing: false, planned: true },
      { itemId: 'back', code: 'PRO-310', batchLotIds: [], garments: 0, missing: true, planned: true },
      { itemId: 'elbow', code: '', batchLotIds: ['pl9'], garments: 0, missing: false, planned: false },
    ])
    expect(recallWords('PL-07', ['WO-0001'], ['SN-AB-0001-X'], ['WO-0002'], 'en')).toBe('Lot PL-07 is in 1 batch and 1 garment on record: WO-0001 (whole batch), SN-AB-0001-X; issued without a record to WO-0002.')
    expect(recallWords('PL-07', [], [], [], 'it')).toBe('Il lotto PL-07 non risulta in nessun capo.')
  })
})

describe('consumables by pack (SCM-263)', () => {
  it('checks a pack and counts in packs', () => {
    expect(packProblems({ packSize: '5000', packUom: 'CONE' }, 'M')).toEqual([])
    expect(packProblems({ packSize: null, packUom: null }, 'M')).toEqual([])
    expect(packProblems({ packSize: '5000', packUom: null }, 'M').map((problem) => problem.path)).toEqual(['packUom'])
    expect(packProblems({ packSize: '0', packUom: 'M' }, 'M').map((problem) => problem.path)).toEqual(['packSize', 'packUom'])
    expect(packProblems({ packSize: '100', packUom: 'PCS' }, 'PCS').map((problem) => problem.path)).toEqual(['packUom'])
    const packs = packsOf('61250', '5000')
    expect([packs.packs.toFixed(0), packs.loose.toFixed(0)]).toEqual(['12', '1250'])
    expect(packWords('60000', 'M', { packSize: '5000', packUom: 'CONE' }, 'en')).toBe('12 cones · 60,000 m')
    expect(packWords('61250', 'M', { packSize: '5000', packUom: 'CONE' }, 'it')).toBe('12 coni + 1.250 m · 61.250 m')
    expect(packWords('5000', 'M', { packSize: '5000', packUom: 'CONE' }, 'en')).toBe('1 cone · 5,000 m')
    expect(packWords('300', 'PCS', null, 'en')).toBe('300 pz')
  })

  it('orders up to the maximum in whole packs once below the minimum', () => {
    const below = levelOf({ onHand: '12000', onOrder: '5000', reserved: '2000', minStock: '20000', maxStock: '50000', packSize: '5000' })
    expect(below.state).toBe('BELOW_MIN')
    expect(below.position.toFixed(0)).toBe('15000')
    expect([below.reorder.toFixed(0), below.reorderPacks?.toFixed(0)]).toEqual(['35000', '7'])
    const odd = levelOf({ onHand: '12000', onOrder: '0', reserved: '0', minStock: '20000', maxStock: '50000', packSize: '3000' })
    expect([odd.reorder.toFixed(0), odd.reorderPacks?.toFixed(0)]).toEqual(['39000', '13'])
    expect(levelOf({ onHand: '60000', onOrder: '0', reserved: '0', minStock: '20000', maxStock: '50000', packSize: null }).state).toBe('ABOVE_MAX')
    expect(levelOf({ onHand: '30000', onOrder: '0', reserved: '0', minStock: '20000', maxStock: '50000', packSize: null })).toMatchObject({ state: 'OK', reorderPacks: null })
    expect(levelOf({ onHand: '1', onOrder: '0', reserved: '0', minStock: null, maxStock: null, packSize: '5000' }).state).toBe('NO_LEVELS')
  })
})

describe('permissions and events (B-W2b-107)', () => {
  it('declares its permissions, gives them to the templates and shares the protector record with the floor', () => {
    expect(FACTORY_PERMISSIONS.isDeclared('inventory.rolls.manage')).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared('inventory.protectors.record')).toBe(true)
    expect(FLOOR_SHARED_PERMISSIONS).toContain('inventory.protectors.record')
    expect(FLOOR_SHARED_PERMISSIONS).not.toContain('inventory.rolls.manage')
    expect(templateOf('warehouse')?.permissions).toContain('inventory.rolls.manage')
    expect(templateOf('quality_inspector')?.permissions).toEqual(expect.arrayContaining(['inventory.rolls.manage', 'inventory.protectors.record']))
    expect(templateOf('production_manager')?.permissions).toContain('inventory.protectors.record')
    expect(templateOf('operator')?.permissions).toContain('inventory.protectors.record')
    expect(templateOf('team_leader')?.permissions).toContain('inventory.protectors.record')
    expect(templateOf('cutting_operator')?.permissions).not.toContain('inventory.protectors.record')
    expect(templateOf('owner')?.permissions).toEqual(expect.arrayContaining(['inventory.rolls.manage', 'inventory.protectors.record']))
  })

  it('declares its events with their live rules', () => {
    for (const type of ['fabric_roll.tagged', 'fabric_roll.changed', 'protector_lot.recorded', 'protector_lot.withdrawn', 'consumable.pack_changed']) expect(EVENT_CATALOGUE.find(type, 1)?.context).toBe('inventory-rolls')
    expect(EVENT_CATALOGUE.get('protector_lot.recorded', 1).live?.floor).toBe('inventory.protectors.record')
    expect(EVENT_CATALOGUE.get('consumable.pack_changed', 1).live?.floor).toBeNull()
  })
})
