import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { PRODUCTION_OFFSTANDARD_PERMISSIONS } from './permissions'
import {
  believedTime,
  codeDraftProblems,
  codeLabel,
  correctRefusal,
  decisionRefusal,
  editOf,
  endRefusal,
  isNormal,
  minutesOf,
  OFF_STANDARD_LIMITS,
  overlaps,
  reopenRefusal,
  statusWhenEnded,
  tileOrder,
  timesProblems,
  unusualOf,
  unusualWords,
} from './rules'

/**
 * Off-standard and indirect time (B-W2b-29; MES-155 … MES-158): the pure rules the API says in words before the
 * …_floor_work_w2b_guards triggers would refuse the same, the permissions and who holds them, the events.
 */

const at = (time: string) => new Date(`2026-11-17T${time}:00.000Z`)
const block = (over: Partial<Parameters<typeof unusualOf>[0]> = {}) => ({ status: 'PENDING' as const, source: 'FLOOR' as const, startedAt: at('09:40'), endedAt: at('10:05'), edited: false, ...over })

describe('off-standard codes (MES-155, MES-158)', () => {
  it('take a code, words in Italian and English, other languages by ISO code, an offered icon and colour', () => {
    expect(codeDraftProblems({ code: 'WAIT_MATERIAL', labelIt: 'Attesa materiale', labelEn: 'Waiting for material', labelI18n: { ro: 'Așteptare material' }, icon: 'package', colour: '#b87503' })).toEqual([])
    const problems = codeDraftProblems({ code: 'wait material', labelIt: ' ', labelEn: 'x'.repeat(81), labelI18n: { it: 'x', RO: 'y', ur: ' ' }, icon: 'rocket', colour: '#123456' })
    expect(problems.map((problem) => problem.path)).toEqual(['code', 'labelIt', 'labelEn', 'labelI18n/it', 'labelI18n/RO', 'labelI18n/ur', 'icon', 'colour'])
    // A change names only what changes; a language with null is taken out.
    expect(codeDraftProblems({ labelI18n: { ro: null } })).toEqual([])
  })

  it('say themselves in the reader’s language, else in English; tiles in their order', () => {
    const code = { labelIt: 'Pulizia', labelEn: 'Cleaning', labelI18n: { ro: 'Curățenie' } }
    expect([codeLabel(code, 'it'), codeLabel(code, 'en'), codeLabel(code, 'ro'), codeLabel(code, 'ur')]).toEqual(['Pulizia', 'Cleaning', 'Curățenie', 'Cleaning'])
    expect(tileOrder([{ code: 'B', sortOrder: 20 }, { code: 'C', sortOrder: 10 }, { code: 'A', sortOrder: 20 }]).map((row) => row.code)).toEqual(['C', 'A', 'B'])
  })
})

describe('blocks of time with no bundle (MES-156) and the lead’s approval (MES-157)', () => {
  it('wait for the team leader when ended, unless the code needs no approval', () => {
    expect(statusWhenEnded(true)).toBe('PENDING')
    expect(statusWhenEnded(false)).toBe('APPROVED')
  })

  it('count whole minutes; a running block to now', () => {
    expect(minutesOf(at('09:40'), at('10:05'))).toBe(25)
    expect(minutesOf(at('09:40'), null, new Date('2026-11-17T09:52:59.000Z'))).toBe(12)
    expect(minutesOf(at('10:05'), at('09:40'))).toBe(0)
  })

  it('are normal only when short, recorded on the floor as it happened and never changed since', () => {
    expect(unusualOf(block())).toEqual([])
    expect(isNormal(block())).toBe(true)
    expect(isNormal(block({ status: 'APPROVED' }))).toBe(false)
    expect(unusualOf(block({ endedAt: at('10:41') }))).toEqual(['LONG'])
    expect(unusualOf(block({ endedAt: at('10:40') }))).toEqual([])
    expect(unusualOf(block({ source: 'LEAD', edited: true }))).toEqual(['TYPED_AFTERWARDS', 'CHANGED'])
    expect(unusualOf(block({ source: 'SYSTEM' }))).toEqual(['BY_SYSTEM'])
    // The waiting on a help call is the floor's, as it happened.
    expect(unusualOf(block({ source: 'HELP_CALL' }))).toEqual([])
    expect(unusualWords(['LONG', 'CHANGED'])).toBe('longer than an hour; changed after it ended')
  })

  it('are decided only while waiting, never by a person they are about', () => {
    expect(decisionRefusal({ status: 'PENDING', involved: false })).toBeNull()
    expect(decisionRefusal({ status: 'PENDING', involved: true })?.code).toBe('OWN_TIME')
    expect(decisionRefusal({ status: 'OPEN', involved: false })?.code).toBe('STILL_RUNNING')
    expect(decisionRefusal({ status: 'APPROVED', involved: false })).toMatchObject({ code: 'NOT_PENDING', message: 'This block is not waiting for approval: it is approved.' })
    expect(reopenRefusal('APPROVED')).toBeNull()
    expect(reopenRefusal('REJECTED')).toBeNull()
    expect(reopenRefusal('PENDING')?.code).toBe('NOT_DECIDED')
    expect(correctRefusal('PENDING')).toBeNull()
    expect(correctRefusal('APPROVED')?.code).toBe('NOT_PENDING')
    expect(correctRefusal('OPEN')?.code).toBe('STILL_RUNNING')
    expect(endRefusal('OPEN')).toBeNull()
    expect(endRefusal('PENDING')?.code).toBe('NOT_RUNNING')
  })

  it('believe a tablet’s time only within a small skew ahead and half a day back', () => {
    const now = at('12:00')
    expect(believedTime(null, now)).toBe(now)
    expect(believedTime(at('11:30'), now)).toEqual(at('11:30'))
    expect(believedTime(new Date(now.getTime() + 60_000), now)).toBe(now)
    expect(believedTime(new Date(now.getTime() + OFF_STANDARD_LIMITS.deviceAheadMs + 1), now)).toBe(now)
    expect(believedTime(new Date(now.getTime() - OFF_STANDARD_LIMITS.deviceBehindMs - 1), now)).toBe(now)
  })

  it('typed afterwards: not in the future, ending after the start, at most 16 hours', () => {
    const now = at('12:00')
    expect(timesProblems({ startedAt: at('09:00'), endedAt: at('09:30') }, now)).toEqual([])
    expect(timesProblems({ startedAt: at('13:00'), endedAt: at('14:00') }, now).map((problem) => problem.path)).toEqual(['body/startedAt', 'body/endedAt'])
    expect(timesProblems({ startedAt: at('09:30'), endedAt: at('09:30') }, now).map((problem) => problem.path)).toEqual(['body/endedAt'])
    expect(timesProblems({ startedAt: new Date('2026-11-16T02:00:00.000Z'), endedAt: at('11:00') }, now)[0]?.message).toMatch(/at most 16 hours/)
  })

  it('know when two spans meet (a running one runs to now)', () => {
    const now = at('12:00')
    expect(overlaps({ startedAt: at('09:00'), endedAt: at('09:30') }, { startedAt: at('09:29'), endedAt: at('10:00') }, now)).toBe(true)
    expect(overlaps({ startedAt: at('09:00'), endedAt: at('09:30') }, { startedAt: at('09:30'), endedAt: at('10:00') }, now)).toBe(false)
    expect(overlaps({ startedAt: at('11:00'), endedAt: null }, { startedAt: at('11:30'), endedAt: at('11:45') }, now)).toBe(true)
  })

  it('keep only the changed fields of an edit, before and after (MES-204)', () => {
    expect(editOf({ startedAt: 'a', endedAt: 'b', codeId: 'c' }, { startedAt: 'a2', endedAt: 'b', codeId: 'c' })).toEqual({ before: { startedAt: 'a' }, after: { startedAt: 'a2' } })
    expect(editOf({ status: 'APPROVED' }, { status: 'APPROVED' })).toBeNull()
    expect(editOf({}, { lineId: 'l' })).toEqual({ before: { lineId: null }, after: { lineId: 'l' } })
  })
})

describe('permissions, templates and events', () => {
  it('declares three office permissions in production, none the floor holds', () => {
    expect(PRODUCTION_OFFSTANDARD_PERMISSIONS).toEqual(['production.offstandard.view', 'production.offstandard.codes', 'production.offstandard.approve'])
    for (const name of PRODUCTION_OFFSTANDARD_PERMISSIONS) {
      expect(FACTORY_PERMISSIONS.get(name)?.area).toBe('production')
      expect(FLOOR_SHARED_PERMISSIONS).not.toContain(name)
    }
    expect(FACTORY_PERMISSIONS.get('production.offstandard.view')?.risk).toBe('read')
  })

  it('gives the codes to the production manager and the decisions to the floor supervisor too; the floor works with floor.work and floor.lead', () => {
    expect(templateOf('production_manager')?.permissions).toEqual(expect.arrayContaining([...PRODUCTION_OFFSTANDARD_PERMISSIONS]))
    expect(templateOf('floor_supervisor')?.permissions).toEqual(expect.arrayContaining(['production.offstandard.view', 'production.offstandard.approve']))
    expect(templateOf('floor_supervisor')?.permissions).not.toContain('production.offstandard.codes')
    expect(templateOf('owner')?.permissions).toEqual(expect.arrayContaining([...PRODUCTION_OFFSTANDARD_PERMISSIONS]))
    expect(templateOf('read_only')?.permissions).toContain('production.offstandard.view')
    expect(templateOf('read_only')?.permissions).not.toContain('production.offstandard.approve')
    expect(templateOf('team_leader')?.permissions).toEqual(expect.arrayContaining(['floor.work', 'floor.lead']))
    expect(templateOf('operator')?.permissions).toContain('floor.work')
  })

  it('declares the block events with no person in a payload and a live rule for the inbox and the tablets', () => {
    for (const type of ['production.off_standard_started', 'production.off_standard_ended', 'production.off_standard_recorded', 'production.off_standard_decided', 'production.off_standard_changed']) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      expect(Object.keys(definition.payload.shape).filter((key) => /worker|employee|name|note|user/i.test(key))).toEqual([])
      expect(definition.live).toMatchObject({ permission: 'production.offstandard.view', floor: 'floor.work' })
    }
    expect(EVENT_CATALOGUE.get('production.off_standard_code_changed', 1).live).toMatchObject({ permission: 'production.offstandard.view', floor: null })
  })
})
