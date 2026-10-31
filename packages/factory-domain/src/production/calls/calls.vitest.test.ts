import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { events } from '../../andon/events'
import { PRODUCTION_CALLS_FLOOR_PERMISSIONS, PRODUCTION_CALLS_MANAGE, PRODUCTION_CALLS_PERMISSIONS } from './permissions'
import {
  CALL_REFUSALS,
  callsByHour,
  callTimes,
  hourIn,
  isOpenCall,
  isWaiting,
  median,
  nextTypeOrder,
  secondsOpen,
  sentAtOf,
  stationCallState,
  stepChange,
  stepRefusal,
  typeDraftProblems,
  typeOrder,
  type CallState,
} from './rules'

const at = (iso: string) => new Date(iso)
const sent: CallState = { status: 'SENT', sentAt: at('2026-11-17T08:10:00Z'), seenAt: null, onTheWayAt: null }

describe('a help call moves forward only (MES-145)', () => {
  it('refuses a step on a final call, a second "seen" and a second "on my way"', () => {
    expect(stepRefusal({ ...sent, status: 'SOLVED' }, 'ON_THE_WAY')).toBe(CALL_REFUSALS.SOLVED)
    expect(stepRefusal({ ...sent, status: 'CANCELLED' }, 'SOLVED')).toBe(CALL_REFUSALS.CANCELLED)
    expect(stepRefusal({ ...sent, status: 'SEEN', seenAt: at('2026-11-17T08:11:00Z') }, 'SEEN')).toBe(CALL_REFUSALS.ALREADY_SEEN)
    expect(stepRefusal({ ...sent, status: 'ON_THE_WAY', onTheWayAt: at('2026-11-17T08:12:00Z') }, 'SEEN')).toBe(CALL_REFUSALS.ALREADY_ON_THE_WAY)
    expect(stepRefusal({ ...sent, status: 'ON_THE_WAY', onTheWayAt: at('2026-11-17T08:12:00Z') }, 'ON_THE_WAY')).toBe(CALL_REFUSALS.ALREADY_ON_THE_WAY)
    expect(stepRefusal(sent, 'SOLVED')).toBeNull()
    expect(stepRefusal({ ...sent, status: 'ON_THE_WAY', onTheWayAt: at('2026-11-17T08:12:00Z') }, 'CANCELLED')).toBeNull()
  })

  it("a responder's 'on my way' on an unseen call marks it seen at the same moment; the station's own 'solved' marks nothing else", () => {
    const now = at('2026-11-17T08:13:00Z')
    expect(stepChange(sent, 'ON_THE_WAY', { at: now, takerId: 'lead', actor: 'RESPONDER' })).toEqual({ status: 'ON_THE_WAY', seenAt: now, seenById: 'lead', onTheWayAt: now, onTheWayById: 'lead' })
    expect(stepChange(sent, 'SOLVED', { at: now, takerId: null, actor: 'STATION' })).toEqual({ status: 'SOLVED', solvedAt: now, solvedById: null, resolutionCode: null, resolutionNote: null })
    expect(stepChange(sent, 'CANCELLED', { at: now, takerId: 'w', actor: 'RESPONDER' })).toEqual({ status: 'CANCELLED', cancelledAt: now, cancelledById: 'w' })
    const seen = { ...sent, status: 'SEEN' as const, seenAt: at('2026-11-17T08:11:00Z') }
    expect(stepChange(seen, 'SOLVED', { at: now, takerId: 'm', actor: 'RESPONDER', resolutionCode: 'BROUGHT', resolutionNote: '  two metres  ' })).toEqual({ status: 'SOLVED', solvedAt: now, solvedById: 'm', resolutionCode: 'BROUGHT', resolutionNote: 'two metres' })
  })

  it('never writes a step before the time the call reached (a tablet clock behind)', () => {
    const onTheWay = { ...sent, status: 'ON_THE_WAY' as const, seenAt: at('2026-11-17T08:11:00Z'), onTheWayAt: at('2026-11-17T08:14:00Z') }
    expect(stepChange(onTheWay, 'SOLVED', { at: at('2026-11-17T08:12:00Z'), takerId: 'm', actor: 'RESPONDER' }).solvedAt).toEqual(at('2026-11-17T08:14:00Z'))
  })
})

describe("a call's times are the call's, never a person's (MES-145; Statuto art. 4)", () => {
  it('measures sent → seen, on the way and solved in whole seconds', () => {
    expect(callTimes({ sentAt: at('2026-11-17T08:10:00Z'), seenAt: at('2026-11-17T08:12:00Z'), onTheWayAt: at('2026-11-17T08:14:00Z'), solvedAt: at('2026-11-17T08:22:00Z') })).toEqual({ responseSeconds: 120, onTheWaySeconds: 240, resolveSeconds: 720 })
    expect(callTimes({ sentAt: at('2026-11-17T08:10:00Z'), seenAt: null, onTheWayAt: null, solvedAt: null })).toEqual({ responseSeconds: null, onTheWaySeconds: null, resolveSeconds: null })
    expect(secondsOpen(at('2026-11-17T08:10:00Z'), at('2026-11-17T08:10:59.9Z'))).toBe(59)
  })

  it('takes the median of whole seconds', () => {
    expect(median([])).toBeNull()
    expect(median([300, 60, 120])).toBe(120)
    expect(median([60, 121])).toBe(91)
  })

  it('waits over 5 minutes only while nobody is on the way', () => {
    const now = at('2026-11-17T08:15:00Z')
    expect(isWaiting(sent, now)).toBe(true)
    expect(isWaiting(sent, at('2026-11-17T08:14:59Z'))).toBe(false)
    expect(isWaiting({ ...sent, status: 'ON_THE_WAY', onTheWayAt: at('2026-11-17T08:11:00Z') }, now)).toBe(false)
    expect(isOpenCall('SEEN')).toBe(true)
    expect(isOpenCall('SOLVED')).toBe(false)
  })

  it("keeps a queued call's tablet time only when believable", () => {
    const now = at('2026-11-17T10:00:00Z')
    expect(sentAtOf(null, now)).toEqual(now)
    expect(sentAtOf(at('2026-11-17T09:40:00Z'), now)).toEqual(at('2026-11-17T09:40:00Z'))
    expect(sentAtOf(at('2026-11-17T10:01:00Z'), now)).toEqual(now)
    expect(sentAtOf(at('2026-11-17T10:05:00Z'), now)).toEqual(now)
    expect(sentAtOf(at('2026-11-16T20:00:00Z'), now)).toEqual(now)
  })
})

describe('the line view and the line TV (MES-147)', () => {
  it('a station calls while someone is still needed, and shows who is coming once all open calls have someone on the way', () => {
    expect(stationCallState([])).toBe('CLEAR')
    expect(stationCallState([{ status: 'ON_THE_WAY' }, { status: 'SENT' }])).toBe('CALLING')
    expect(stationCallState([{ status: 'ON_THE_WAY' }])).toBe('COMING')
  })

  it('counts a day per hour of the site, by kind and line, with each kind’s median response (no person)', () => {
    expect(hourIn(at('2026-11-17T08:10:00Z'), 'Europe/Rome')).toBe(9)
    expect(hourIn(at('2026-11-17T23:10:00Z'), 'Europe/Rome')).toBe(0)
    const day = callsByHour(
      [
        { sentAt: at('2026-11-17T08:10:00Z'), seenAt: at('2026-11-17T08:12:00Z'), kind: 'MATERIAL', lineId: 'L1' },
        { sentAt: at('2026-11-17T08:40:00Z'), seenAt: null, kind: 'MATERIAL', lineId: 'L1' },
        { sentAt: at('2026-11-17T08:50:00Z'), seenAt: at('2026-11-17T08:51:00Z'), kind: 'MACHINE', lineId: null },
      ],
      'Europe/Rome',
    )
    expect(day.hours).toHaveLength(24)
    expect(day.hours[9]).toMatchObject({ hour: 9, calls: 3, byKind: { MATERIAL: 2, MACHINE: 1, QUALITY: 0 }, byLine: [{ lineId: 'L1', count: 2 }, { lineId: null, count: 1 }] })
    expect(day.byKind).toEqual([
      { kind: 'MACHINE', calls: 1, answered: 1, medianResponseSeconds: 60 },
      { kind: 'MATERIAL', calls: 2, answered: 1, medianResponseSeconds: 120 },
    ])
    expect(JSON.stringify(day)).not.toMatch(/worker|employee|user|person/i)
  })
})

describe('the help-call types (MES-144)', () => {
  it('checks the code, the escalation minutes and the order, each at its field', () => {
    expect(typeDraftProblems({ code: 'MATERIAL', escalateAfterMinutes: 10, sortOrder: 0 })).toEqual([])
    expect(typeDraftProblems({ escalateAfterMinutes: null })).toEqual([])
    expect(typeDraftProblems({ code: 'material call', escalateAfterMinutes: 241, sortOrder: -1 }).map((problem) => problem.path)).toEqual(['code', 'escalateAfterMinutes', 'sortOrder'])
    expect(typeDraftProblems({ escalateAfterMinutes: 0 }).map((problem) => problem.path)).toEqual(['escalateAfterMinutes'])
  })

  it('orders the tiles by order, then code, and puts a new type last', () => {
    expect(typeOrder([{ sortOrder: 20, code: 'B' }, { sortOrder: 10, code: 'Z' }, { sortOrder: 20, code: 'A' }]).map((type) => type.code)).toEqual(['Z', 'A', 'B'])
    expect(nextTypeOrder([])).toBe(10)
    expect(nextTypeOrder([10, 30, 20])).toBe(40)
  })
})

describe('permissions, templates and events', () => {
  it('declares the three permissions; the floor shares reading and answering, never keeping the types', () => {
    for (const name of PRODUCTION_CALLS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    for (const name of PRODUCTION_CALLS_FLOOR_PERMISSIONS) expect(FLOOR_SHARED_PERMISSIONS).toContain(name)
    expect(FLOOR_SHARED_PERMISSIONS).not.toContain(PRODUCTION_CALLS_MANAGE)
  })

  it('gives answering to the responders, keeping the types to the production manager; sending needs only floor.work', () => {
    const of = (key: string) => ROLE_TEMPLATES.find((template) => template.key === key)!.permissions
    expect(of('production_manager')).toEqual(expect.arrayContaining(['production.calls.view', 'production.calls.answer', 'production.calls.manage']))
    for (const key of ['floor_supervisor', 'maintenance', 'warehouse', 'quality_inspector', 'team_leader', 'technician', 'floor_inspector']) {
      expect(of(key)).toEqual(expect.arrayContaining(['production.calls.view', 'production.calls.answer']))
      expect(of(key)).not.toContain('production.calls.manage')
    }
    for (const key of ['operator', 'cutting_operator']) {
      expect(of(key)).toContain('floor.work')
      expect(of(key).filter((name) => name.startsWith('production.calls.'))).toEqual([])
    }
    expect(of('read_only')).toContain('production.calls.view')
    expect(of('read_only')).not.toContain('production.calls.answer')
  })

  it('declares four events with no person, no typed word and no time in their payloads, live to the office and the floor', () => {
    expect(events.map((event) => event.type)).toEqual(['help_call.raised', 'help_call.answered', 'help_call.changed', 'help_call_type.changed'])
    for (const event of events) {
      expect(EVENT_CATALOGUE.find(event.type, 1)).toBeDefined()
      expect(event.live).toMatchObject({ permission: 'production.calls.view', floor: 'floor.work' })
      expect(Object.keys((event.payload as unknown as { shape: Record<string, unknown> }).shape).join(' ')).not.toMatch(/worker|employee|user|by[A-Z]|note|seconds|name/i)
    }
  })
})
