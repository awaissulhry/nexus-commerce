import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { PRODUCTION_LABOUR_PERMISSIONS } from './permissions'
import {
  addDays,
  answerProblems,
  blockersOf,
  changesOf,
  closeRefusal,
  dailySheetOf,
  disputeMessageOf,
  earnedMinutes,
  LABOUR_LIMITS,
  labourRecordsOf,
  lineDayState,
  offStandardCoded,
  raiseProblems,
  rangeProblems,
  readDisputeMessage,
  reopenRefusal,
  reportOf,
  sumMinutes,
  type LabourScan,
} from './rules'

/**
 * Labour records and corrections (B-W2b-45; MES-201 … MES-206): the labour record per scan with its standard minutes, the
 * daily sheet inside one record (never a ranking), what holds a line's day from closing, the changes as from → to, the
 * dispute's reason tiles and answer, the permissions and who holds them, the events (no person in a payload).
 */

const at = (time: string, day = '2026-11-17') => new Date(`${day}T${time}:00.000Z`)
const scan = (over: Partial<LabourScan> & Pick<LabourScan, 'id'>): LabourScan => ({
  kind: 'REPORT',
  correctsId: null,
  goodQuantity: 10,
  scrapQuantity: 0,
  reworkQuantity: 0,
  serverTime: at('08:00'),
  workOrderId: 'wo',
  workOrderOperationId: 'op-sew',
  bundleId: 'b1',
  workerId: 'w1',
  stationId: 's1',
  deviceId: 'd1',
  approvedById: null,
  reason: null,
  ...over,
})
const STANDARD = new Map([
  ['op-sew', '1.250'],
  ['op-press', '0.400'],
])

describe('the labour record per scan with its minutes (MES-201)', () => {
  it('is one record per REPORT: standard minutes earned = good × the operation’s standard, exact', () => {
    const records = labourRecordsOf([scan({ id: 'r1' }), scan({ id: 'r2', bundleId: 'b2', workOrderOperationId: 'op-press', goodQuantity: 7, serverTime: at('09:00') })], STANDARD, 'Europe/Rome')
    expect(records.map((record) => [record.scanId, record.state, record.earnedMinutes])).toEqual([
      ['r1', 'STANDING', '12.500'],
      ['r2', 'STANDING', '2.800'],
    ])
    expect(earnedMinutes(3, '0.333')).toBe('0.999')
    expect(earnedMinutes(4, null)).toBe('0.000')
    expect(sumMinutes(['12.500', '2.800', '0.999'])).toBe('16.299')
  })

  it("follows a lead's corrections (the latest stands) and an undo (nothing stands), on the report's own day", () => {
    const scans = [
      scan({ id: 'r1', serverTime: at('22:30', '2026-11-16') }),
      scan({ id: 'c1', kind: 'CORRECTION', correctsId: 'r1', goodQuantity: 8, scrapQuantity: 2, approvedById: 'lead', reason: 'Two stained.', serverTime: at('09:00') }),
      scan({ id: 'c2', kind: 'CORRECTION', correctsId: 'c1', goodQuantity: 9, scrapQuantity: 1, approvedById: 'lead', reason: 'One was fine.', serverTime: at('10:00') }),
      scan({ id: 'r2', bundleId: 'b2', serverTime: at('11:00') }),
      scan({ id: 'u2', kind: 'UNDO', correctsId: 'r2', goodQuantity: 0, bundleId: 'b2', reason: 'Wrong bundle.', serverTime: at('11:01') }),
    ]
    const [corrected, undone] = labourRecordsOf(scans, STANDARD, 'Europe/Rome')
    // The report's own site day (22:30 UTC is 23:30 in Rome, still the 16th), not the day of its corrections.
    expect(corrected).toMatchObject({ scanId: 'r1', state: 'CORRECTED', standingScanId: 'c2', workDate: '2026-11-16', reported: { good: 10, scrap: 0 }, counts: { good: 9, scrap: 1 }, earnedMinutes: '11.250' })
    expect(corrected!.steps.map((step) => [step.scanId, step.kind, step.approvedById])).toEqual([
      ['c1', 'CORRECTION', 'lead'],
      ['c2', 'CORRECTION', 'lead'],
    ])
    expect(undone).toMatchObject({ scanId: 'r2', state: 'UNDONE', standingScanId: null, counts: { good: 0, scrap: 0, rework: 0 }, earnedMinutes: '0.000' })
    const byId = new Map(scans.map((row) => [row.id, row]))
    expect(reportOf(byId.get('c2')!, byId)?.id).toBe('r1')
    expect(reportOf(scan({ id: 'x', kind: 'CORRECTION', correctsId: 'missing' }), byId)).toBeNull()
  })

  it("puts the site's day on the report (Rome's midnight, not UTC's)", () => {
    const [late] = labourRecordsOf([scan({ id: 'r', serverTime: new Date('2026-11-16T23:30:00.000Z') })], STANDARD, 'Europe/Rome')
    expect(late!.workDate).toBe('2026-11-17')
  })
})

describe("the operator's daily sheet, inside one record (MES-202)", () => {
  it('sums pieces, production minutes and off-standard minutes by code, and lists what is open; never a percentage', () => {
    const records = labourRecordsOf(
      [scan({ id: 'r1' }), scan({ id: 'r2', bundleId: 'b2', goodQuantity: 6, scrapQuantity: 1, serverTime: at('09:00') }), scan({ id: 'r3', bundleId: 'b3', serverTime: at('10:00') }), scan({ id: 'u3', kind: 'UNDO', correctsId: 'r3', bundleId: 'b3', goodQuantity: 0, serverTime: at('10:01') })],
      STANDARD,
      'Europe/Rome',
    )
    const sheet = dailySheetOf({
      workDate: '2026-11-17',
      records,
      blocks: [
        { codeId: 'c-wait', code: 'WAIT_MATERIAL', kind: 'OFF_STANDARD', status: 'APPROVED', minutes: 25 },
        { codeId: 'c-wait', code: 'WAIT_MATERIAL', kind: 'OFF_STANDARD', status: 'PENDING', minutes: 10 },
        { codeId: 'c-clean', code: 'CLEANING', kind: 'INDIRECT', status: 'APPROVED', minutes: 15 },
        { codeId: 'c-clean', code: 'CLEANING', kind: 'INDIRECT', status: 'REJECTED', minutes: 30 },
      ],
      attendance: null,
      counts: { DISPUTE_OPEN: 1 },
    })
    expect(sheet).toMatchObject({ workDate: '2026-11-17', pieces: { good: 16, scrap: 1, rework: 0 }, records: 2, productionMinutes: '20.000', attendance: null })
    expect(sheet.offStandard).toEqual({
      minutes: 50,
      byCode: [
        { codeId: 'c-clean', code: 'CLEANING', kind: 'INDIRECT', minutes: 15, blocks: 1 },
        { codeId: 'c-wait', code: 'WAIT_MATERIAL', kind: 'OFF_STANDARD', minutes: 35, blocks: 2 },
      ],
    })
    expect(sheet.exceptions.map((entry) => [entry.kind, entry.count])).toEqual([
      ['DISPUTE_OPEN', 1],
      ['BLOCK_WAITING', 1],
      ['BLOCK_REJECTED', 1],
      ['RECORD_UNDONE', 1],
    ])
    // Statuto art. 4; Owner answers W1, F2: no percentage, pace, target, rank or comparison on one person's sheet.
    expect(JSON.stringify(sheet)).not.toMatch(/pct|percent|efficien|pace|target|rank|average/i)
  })
})

describe("closing a line's day (MES-203)", () => {
  const facts = (counts: Parameters<typeof blockersOf>[0]['counts'], closed = false) => ({ closed, counts })

  it('is READY with nothing open, OPEN while something holds it, CLOSED once closed; says what holds it in words', () => {
    expect(lineDayState(facts({}))).toBe('READY')
    expect(lineDayState(facts({ OFF_STANDARD_WAITING: 2 }))).toBe('OPEN')
    expect(lineDayState(facts({ OFF_STANDARD_WAITING: 2 }, true))).toBe('CLOSED')
    expect(offStandardCoded(facts({ OFF_STANDARD_RUNNING: 1, OFF_STANDARD_WAITING: 2, DISPUTE_OPEN: 1 }))).toEqual({ coded: false, left: 3 })
    expect(offStandardCoded(facts({ DISPUTE_OPEN: 1 }))).toEqual({ coded: true, left: 0 })
    const held = closeRefusal({ facts: facts({ OFF_STANDARD_WAITING: 2, DISPUTE_OPEN: 1, ATTENDANCE_ANOMALY: 1 }), workDate: '2026-11-17', today: '2026-11-18', lineCode: 'L1' })
    expect(held).toMatchObject({ code: 'HELD' })
    expect(held!.message).toBe('The day 2026-11-17 of line L1 closes once its off-standard time is coded and its anomalies are cleared: 2 off-standard blocks waiting for approval, 1 dispute waiting for an answer, 1 attendance anomaly to fix.')
    expect(closeRefusal({ facts: facts({}), workDate: '2026-11-17', today: '2026-11-17', lineCode: 'L1' })).toBeNull()
    expect(closeRefusal({ facts: facts({}), workDate: '2026-11-19', today: '2026-11-18', lineCode: 'L1' })?.code).toBe('NOT_YET')
    expect(closeRefusal({ facts: facts({}, true), workDate: '2026-11-16', today: '2026-11-18', lineCode: 'L1' })?.code).toBe('ALREADY_CLOSED')
    expect(reopenRefusal({ closed: false, workDate: '2026-11-17', lineCode: 'L1' })?.code).toBe('NOT_CLOSED')
    expect(reopenRefusal({ closed: true, workDate: '2026-11-17', lineCode: 'L1' })).toBeNull()
  })

  it('takes a range of at most 62 days', () => {
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
    expect(rangeProblems('2026-11-02', '2026-11-01')[0]?.path).toBe('querystring/from')
    expect(rangeProblems('2026-11-01', addDays('2026-11-01', LABOUR_LIMITS.daysPerList - 1))).toEqual([])
    expect(rangeProblems('2026-11-01', addDays('2026-11-01', LABOUR_LIMITS.daysPerList))[0]?.path).toBe('querystring/to')
  })
})

describe('every edit keeps before and after (MES-204)', () => {
  it('reads as from → to per field that changed', () => {
    expect(changesOf({ startedAt: '2026-11-17T09:35:00.000Z', codeId: 'a' }, { startedAt: '2026-11-17T09:40:00.000Z', codeId: 'a' })).toEqual([{ field: 'startedAt', from: '2026-11-17T09:35:00.000Z', to: '2026-11-17T09:40:00.000Z' }])
    expect(changesOf({ good: 10, scrap: 0 }, { good: 9, scrap: 1, rework: 0 })).toEqual([
      { field: 'good', from: 10, to: 9 },
      { field: 'rework', from: null, to: 0 },
      { field: 'scrap', from: 0, to: 1 },
    ])
  })
})

describe('a dispute of an entry (MES-206)', () => {
  it('takes a reason tile of its record (and words for "other"), kept with the words', () => {
    expect(raiseProblems({ recordType: 'OperationScan', reason: 'WRONG_QUANTITY', words: undefined })).toEqual([])
    expect(raiseProblems({ recordType: 'OperationScan', reason: 'WRONG_CODE', words: 'x' })[0]?.path).toBe('body/reason')
    expect(raiseProblems({ recordType: 'OffStandardEntry', reason: 'OTHER', words: '  ' })[0]?.path).toBe('body/message')
    expect(raiseProblems({ recordType: 'OffStandardEntry', reason: 'WRONG_TIME', words: 'x'.repeat(LABOUR_LIMITS.message + 1) })[0]?.path).toBe('body/message')
    expect(disputeMessageOf('WRONG_QUANTITY', ' I sewed 12. ')).toBe('WRONG_QUANTITY: I sewed 12.')
    expect(disputeMessageOf('NOT_ME', null)).toBe('NOT_ME')
    expect(readDisputeMessage('WRONG_QUANTITY: I sewed 12.')).toEqual({ reason: 'WRONG_QUANTITY', words: 'I sewed 12.' })
    expect(readDisputeMessage('NOT_ME')).toEqual({ reason: 'NOT_ME', words: '' })
    expect(readDisputeMessage('I started at 10:40.')).toEqual({ reason: null, words: 'I started at 10:40.' })
  })

  it('is answered upheld or rejected in words; only an upheld dispute of a block corrects it', () => {
    expect(answerProblems({ outcome: 'UPHELD', answer: 'Corrected.', correcting: true, recordType: 'OffStandardEntry' })).toEqual([])
    expect(answerProblems({ outcome: 'REJECTED', answer: ' ', correcting: false, recordType: 'OperationScan' })[0]?.path).toBe('body/answer')
    expect(answerProblems({ outcome: 'REJECTED', answer: 'No.', correcting: true, recordType: 'OffStandardEntry' })[0]?.path).toBe('body/correction')
    expect(answerProblems({ outcome: 'UPHELD', answer: 'Yes.', correcting: true, recordType: 'OperationScan' })[0]?.path).toBe('body/correction')
    expect(answerProblems({ outcome: 'MAYBE', answer: 'x', correcting: false, recordType: 'OperationScan' })[0]?.path).toBe('body/outcome')
  })
})

describe('permissions, templates and events', () => {
  it('declares four office permissions, none shared with the floor; the manager holds them all, the floor supervisor all but reopen', () => {
    for (const name of PRODUCTION_LABOUR_PERMISSIONS) {
      expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
      expect(FLOOR_SHARED_PERMISSIONS).not.toContain(name)
    }
    expect(FACTORY_PERMISSIONS.get('production.labour.view')?.risk).toBe('read')
    const manager = templateOf('production_manager')!.permissions
    for (const name of PRODUCTION_LABOUR_PERMISSIONS) expect(manager).toContain(name)
    const supervisor = templateOf('floor_supervisor')!.permissions
    expect(supervisor).toEqual(expect.arrayContaining(['production.labour.view', 'production.labour.close', 'production.labour.answer']))
    expect(supervisor).not.toContain('production.labour.reopen')
    // One person's sheet is People's own permission (B-W2b-27), held by no template.
    expect(manager).not.toContain('people.figures.view')
  })

  it("declares the line-day and dispute events with no person in them; the dispute's answer reaches the tablets", () => {
    const types = ['labour_day.closed', 'labour_day.reopened', 'labour_dispute.raised', 'labour_dispute.answered', 'labour_dispute.withdrawn']
    for (const type of types) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      const keys = Object.keys(definition.payload.shape)
      expect(keys.some((key) => /worker|employee|name|message|answer|reason|note/i.test(key)), `${type}: ${keys.join(', ')}`).toBe(false)
    }
    expect(EVENT_CATALOGUE.get('labour_dispute.answered', 1).live).toMatchObject({ permission: 'production.labour.view', floor: 'floor.work' })
    expect(EVENT_CATALOGUE.get('labour_dispute.raised', 1).live).toMatchObject({ permission: 'production.labour.view', floor: null })
  })
})
