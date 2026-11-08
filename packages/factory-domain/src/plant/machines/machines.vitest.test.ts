import { describe, expect, it } from 'vitest'
import { ceOnFile, categoryOf, groupOf, kindFits } from './documents'
import { addDaysTo, minutesByStatus, statusDays, statusSpans, type HistoryInput } from './history'
import { MACHINE_DEPTH_REFUSALS, releasesDoNotUse, statusChangeRefusal, statusReasonProblems } from './status'
import { machineTagZpl } from './tag'

/** Machines in depth (B-W2b-136): Change status, the status history cut by day, the documents' groups, the QR tag's ZPL. */

describe('Change status (QHS-167; Owner answer H1)', () => {
  const machine = { assetNumber: 'DEMO-SEW-01', status: 'RUNNING' as const, locked: false }
  it('refuses a retired machine, a locked one and the same status, in that order', () => {
    expect(statusChangeRefusal({ ...machine, status: 'RETIRED', to: 'RUNNING' })?.code).toBe('MACHINE_RETIRED')
    expect(statusChangeRefusal({ ...machine, status: 'DO_NOT_USE', locked: true, to: 'UNDER_MAINTENANCE' })?.code).toBe('LOCKED_UNSAFE')
    expect(statusChangeRefusal({ ...machine, to: 'RUNNING' })?.code).toBe('SAME_STATUS')
    expect(statusChangeRefusal({ ...machine, to: 'DOWN' })).toBeNull()
    expect(statusChangeRefusal({ ...machine, to: 'DO_NOT_USE' })).toBeNull()
  })
  it('a release from do-not-use asks for a technician; setting it does not', () => {
    expect(releasesDoNotUse('DO_NOT_USE', 'RUNNING')).toBe(true)
    expect(releasesDoNotUse('DO_NOT_USE', 'UNDER_MAINTENANCE')).toBe(true)
    expect(releasesDoNotUse('RUNNING', 'DO_NOT_USE')).toBe(false)
    expect(releasesDoNotUse('DOWN', 'RUNNING')).toBe(false)
  })
  it('always asks a reason of a few words', () => {
    expect(statusReasonProblems('')).toHaveLength(1)
    expect(statusReasonProblems('  ok ')).toHaveLength(1)
    expect(statusReasonProblems('Belt changed')).toEqual([])
    expect(statusReasonProblems('x'.repeat(501))[0]?.path).toBe('reason')
  })
  it('every refusal has a code of its own', () => {
    expect(new Set(MACHINE_DEPTH_REFUSALS).size).toBe(MACHINE_DEPTH_REFUSALS.length)
  })
})

describe('the status history (QHS-167)', () => {
  const base: HistoryInput = {
    from: '2026-11-02T00:00:00.000Z',
    to: '2026-11-04T00:00:00.000Z',
    now: '2026-11-03T12:00:00.000Z',
    registeredAt: '2026-01-01T00:00:00.000Z',
    before: { status: 'RUNNING', reason: null },
    current: { status: 'RUNNING', reason: null },
    events: [],
  }
  it('no change: one span from the window start to now', () => {
    expect(statusSpans(base)).toEqual([{ from: base.from, to: base.now, status: 'RUNNING', reason: null }])
  })
  it('cuts at each change and carries its reason; nothing after now', () => {
    const spans = statusSpans({
      ...base,
      events: [
        { at: '2026-11-02T08:00:00.000Z', from: 'RUNNING', to: 'DOWN', reason: 'Needle broke' },
        { at: '2026-11-02T09:30:00.000Z', from: 'DOWN', to: 'UNDER_MAINTENANCE', reason: null },
        { at: '2026-11-02T10:00:00.000Z', from: 'UNDER_MAINTENANCE', to: 'RUNNING', reason: null },
        { at: '2026-11-03T20:00:00.000Z', from: 'RUNNING', to: 'DOWN', reason: 'Later than now' },
      ],
    })
    expect(spans.map((span) => [span.status, span.from.slice(11, 16), span.to.slice(11, 16), span.reason])).toEqual([
      ['RUNNING', '00:00', '08:00', null],
      ['DOWN', '08:00', '09:30', 'Needle broke'],
      ['UNDER_MAINTENANCE', '09:30', '10:00', null],
      ['RUNNING', '10:00', '12:00', null],
    ])
    expect(minutesByStatus(spans)).toEqual({ RUNNING: 8 * 60 + 26 * 60, DOWN: 90, UNDER_MAINTENANCE: 30 })
  })
  it('without an event before the window: the first event says what it was before', () => {
    const spans = statusSpans({ ...base, before: null, events: [{ at: '2026-11-02T06:00:00.000Z', from: 'DOWN', to: 'RUNNING', reason: null }] })
    expect(spans[0]).toMatchObject({ status: 'DOWN', to: '2026-11-02T06:00:00.000Z' })
  })
  it('never changed: its status now, from when it was registered', () => {
    const spans = statusSpans({ ...base, before: null, registeredAt: '2026-11-03T06:00:00.000Z', current: { status: 'DO_NOT_USE', reason: 'Guard missing' } })
    expect(spans).toEqual([{ from: '2026-11-03T06:00:00.000Z', to: base.now, status: 'DO_NOT_USE', reason: 'Guard missing' }])
  })
  it('a window wholly before the machine was registered, or after now, is empty', () => {
    expect(statusSpans({ ...base, registeredAt: '2026-12-01T00:00:00.000Z' })).toEqual([])
    expect(statusSpans({ ...base, now: '2026-11-01T00:00:00.000Z' })).toEqual([])
  })
  it('days are cut at local midnight in the site zone (Europe/Rome, UTC+1 in November)', () => {
    const spans = statusSpans({ ...base, from: '2026-11-01T23:00:00.000Z', to: '2026-11-03T23:00:00.000Z' })
    const days = statusDays(spans, '2026-11-02', 2, 'Europe/Rome')
    expect(days.map((day) => [day.date, day.from, day.spans.length])).toEqual([
      ['2026-11-02', '2026-11-01T23:00:00.000Z', 1],
      ['2026-11-03', '2026-11-02T23:00:00.000Z', 1],
    ])
    expect(days[1]!.spans[0]!.to).toBe(base.now)
    expect(addDaysTo('2026-10-31', 1)).toBe('2026-11-01')
  })
})

describe('documents & CE (QHS-165)', () => {
  it('groups a machine file by category and kind', () => {
    expect(groupOf({ category: 'MACHINE_CE', kind: 'DOCUMENT' })).toBe('MACHINE_CE')
    expect(groupOf({ category: 'MANUAL', kind: 'DOCUMENT' })).toBe('MANUAL')
    expect(groupOf({ category: null, kind: 'PHOTO' })).toBe('PHOTO')
    expect(groupOf({ category: 'OTHER', kind: 'PHOTO' })).toBe('OTHER')
    expect(groupOf({ category: null, kind: 'DOCUMENT' })).toBe('OTHER')
    expect(categoryOf('PHOTO')).toBeNull()
    expect(categoryOf('MACHINE_CE')).toBe('MACHINE_CE')
  })
  it('a CE declaration is a document or a certificate, never a photo', () => {
    expect(kindFits('MACHINE_CE', 'CERTIFICATE')).toBe(true)
    expect(kindFits('MACHINE_CE', 'PHOTO')).toBe(false)
    expect(kindFits('PHOTO', 'PHOTO')).toBe(true)
  })
  it('the CE is on file only when available', () => {
    expect(ceOnFile([{ category: 'MACHINE_CE', status: 'PENDING_UPLOAD' }])).toBe(false)
    expect(ceOnFile([{ category: 'MANUAL', status: 'AVAILABLE' }, { category: 'MACHINE_CE', status: 'AVAILABLE' }])).toBe(true)
  })
})

describe('the QR tag (QHS-164)', () => {
  const tag = { assetNumber: 'DEMO-SEW-01', typeWords: 'Lockstitch', placeWords: 'A1 · SEW-02', scanWords: 'Scan to report a problem' }
  it('holds the asset number in a QR, prints its words, the copies asked', () => {
    const zpl = machineTagZpl(tag, { dpi: 203, widthMm: 76, heightMm: 51 }, 2)
    expect(zpl.startsWith('^XA')).toBe(true)
    expect(zpl).toContain('^BQN,2,')
    expect(zpl).toContain('^FDHA,DEMO-SEW-01^FS')
    expect(zpl).toContain('A1 _C2_B7 SEW-02')
    expect(zpl).toContain('^PQ2')
    expect(zpl.trimEnd().endsWith('^XZ')).toBe(true)
  })
  it('refuses a stock too small and copies out of range', () => {
    expect(() => machineTagZpl(tag, { dpi: 203, widthMm: 20, heightMm: 20 })).toThrow(RangeError)
    expect(() => machineTagZpl(tag, { dpi: 203, widthMm: 76, heightMm: 51 }, 6)).toThrow(RangeError)
  })
})
