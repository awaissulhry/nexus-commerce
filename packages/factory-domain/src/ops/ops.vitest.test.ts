import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import {
  compareFingerprints,
  DRILL_KEYS,
  DRILL_TIMER_KEY,
  drillProblems,
  drillResultOf,
  drillStatus,
  drillTimerOf,
  fingerprintLine,
  parseFingerprint,
  plusDays,
  type Fingerprint,
} from './drills'
import { affectedHolders, strandsAdmins, twoFactorLockOf, twoFactorProblems, workingAdmins, type AdminSubject, type TwoFactorRole } from './two-factor'

const NOW = new Date('2026-10-30T09:00:00.000Z')
const print = (seed: string): Fingerprint => Object.fromEntries(DRILL_KEYS.map((key, index) => [key, `${seed}${index}`.padEnd(16, '0').slice(0, 16)])) as unknown as Fingerprint

describe('restore drills (PLT-214)', () => {
  it('writes a fingerprint line and reads it back, refusing anything else in words', () => {
    const source = print('ab12')
    const line = fingerprintLine(source)
    expect(line).toMatch(/^NXF1 orders=[0-9a-f]{16} invoices=/)
    expect(parseFingerprint(line)).toEqual({ fingerprint: source, issues: [] })
    expect(parseFingerprint(`  ${line.replace(/ /g, ';')}  `).fingerprint).toEqual(source)
    expect(parseFingerprint('').issues[0]?.message).toMatch(/Paste/)
    expect(parseFingerprint(line.replace('NXF1', 'NXF9')).issues[0]?.message).toMatch(/starts with NXF1/)
    expect(parseFingerprint(line.replace(/ files=\w+/, '')).issues[0]?.message).toMatch(/misses files/)
    expect(parseFingerprint(`${line} orders=0000000000000000`).issues[0]?.message).toMatch(/named twice/)
    expect(parseFingerprint(line.replace(/orders=\w+/, 'orders=xyz')).issues[0]?.message).toMatch(/16 hex/)
    expect(parseFingerprint(`${line} stockValue=0000000000000000`).issues[0]?.message).toMatch(/not a key/)
  })

  it('passes only when every key matches', () => {
    const source = print('ab12')
    const checks = compareFingerprints(source, source)
    expect(checks.every((check) => check.match)).toBe(true)
    expect(drillResultOf(checks)).toBe('PASSED')
    const restored = { ...source, invoices: 'ffffffffffffffff' }
    const mixed = compareFingerprints(source, restored)
    expect(mixed.filter((check) => !check.match).map((check) => check.key)).toEqual(['invoices'])
    expect(drillResultOf(mixed)).toBe('FAILED')
    expect(drillResultOf([])).toBe('FAILED')
  })

  it('refuses a drill over production, from the future or of a later backup', () => {
    const ok = { drilledOn: '2026-10-29', environment: 'a local copy', backupAt: new Date('2026-10-29T02:00:00.000Z'), durationMinutes: 20 }
    expect(drillProblems(ok, NOW)).toEqual([])
    expect(drillProblems({ ...ok, environment: 'Production server' }, NOW).map((issue) => issue.path)).toEqual(['environment'])
    expect(drillProblems({ ...ok, environment: 'produzione' }, NOW).map((issue) => issue.path)).toEqual(['environment'])
    expect(drillProblems({ ...ok, environment: '  ' }, NOW).map((issue) => issue.path)).toEqual(['environment'])
    expect(drillProblems({ ...ok, drilledOn: '2026-10-31' }, NOW).map((issue) => issue.path)).toEqual(['drilledOn'])
    expect(drillProblems({ ...ok, backupAt: new Date('2026-10-31T02:00:00.000Z') }, NOW).map((issue) => issue.path)).toEqual(['backupAt', 'backupAt'])
    expect(drillProblems({ ...ok, durationMinutes: -1 }, NOW).map((issue) => issue.path)).toEqual(['durationMinutes'])
  })

  it('is due every 90 days after the last that passed, reminded 14 days before', () => {
    const at = (drilledOn: string, result: 'PASSED' | 'FAILED' = 'PASSED') => ({ drilledOn, result, createdAt: new Date(`${drilledOn}T12:00:00.000Z`) })
    expect(drillStatus([], NOW).state).toBe('none')
    expect(drillStatus([at('2026-10-01')], NOW)).toMatchObject({ state: 'ok', lastOn: '2026-10-01', daysAgo: 29, dueOn: '2026-12-30', daysLeft: 61 })
    expect(drillStatus([at('2026-08-09')], NOW)).toMatchObject({ state: 'due_soon', daysAgo: 82, daysLeft: 8 })
    expect(drillStatus([at('2026-07-01')], NOW)).toMatchObject({ state: 'overdue', daysLeft: -31 })
    // The last drill failed: the due date stays the last pass's.
    expect(drillStatus([at('2026-10-01'), at('2026-10-20', 'FAILED')], NOW)).toMatchObject({ state: 'failed', lastOn: '2026-10-20', lastResult: 'FAILED', dueOn: '2026-12-30' })
    expect(drillStatus([at('2026-10-20', 'FAILED')], NOW)).toMatchObject({ state: 'failed', dueOn: null })
    const timer = drillTimerOf('2026-10-29')
    expect(timer).toMatchObject({ timerKey: DRILL_TIMER_KEY, dueOn: '2027-01-27' })
    expect(DRILL_TIMER_KEY).toMatch(/^[A-Z][A-Z0-9_]*(:[+-]?[0-9]+[mhd])?$/)
    expect(timer.fireAt.toISOString()).toBe('2027-01-12T23:00:00.000Z')
    expect(plusDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('two-factor per role (PLT-045)', () => {
  const role = (over: Partial<TwoFactorRole> = {}): TwoFactorRole => ({ id: 'r1', key: 'planner', system: true, audience: 'office', requireMfa: false, grains: ['price'], ...over })

  it('asks it of any office role; never lowers a floor, money-seeing or ready-made role that asks it', () => {
    expect(twoFactorProblems(role(), true)).toEqual([])
    expect(twoFactorProblems(role({ requireMfa: true }), false)).toEqual([])
    expect(twoFactorProblems(role({ audience: 'floor' }), true)[0]?.message).toMatch(/floor role/)
    expect(twoFactorProblems(role({ requireMfa: true, grains: ['cost'] }), false, 2)).toEqual([{ path: 'changes/2', message: expect.stringMatching(/costs or margins/) }])
    expect(templateOf('owner')?.requireMfa).toBe(true)
    expect(twoFactorLockOf(role({ key: 'owner', requireMfa: true, grains: [] }))).toBe('template')
    expect(twoFactorLockOf(role({ key: 'custom.owner', system: false, requireMfa: true, grains: [] }))).toBeNull()
    expect(twoFactorProblems(role({ requireMfa: true }), true)[0]?.message).toMatch(/already/)
  })

  it('never strands the administrators', () => {
    const admins: AdminSubject[] = [
      { userId: 'a', twoFactor: false, requireMfa: false, adminRoleIds: ['custom'] },
      { userId: 'b', twoFactor: false, requireMfa: false, adminRoleIds: ['custom', 'other'] },
    ]
    const asksNothing = () => false
    expect(workingAdmins(admins, asksNothing)).toEqual(['a', 'b'])
    expect(strandsAdmins(admins, asksNothing, (roleId) => roleId === 'custom')).toBe(false)
    expect(strandsAdmins(admins, asksNothing, () => true)).toBe(true)
    // One administrator has two-factor: nobody is stranded.
    expect(strandsAdmins([{ ...admins[0]!, twoFactor: true }, admins[1]!], asksNothing, () => true)).toBe(false)
    // Already all waiting: a further change does not make it worse.
    expect(strandsAdmins(admins, () => true, () => true)).toBe(false)
  })

  it('lists each holder once, those without two-factor when it is asked', () => {
    const holders = [
      { userId: 'u2', name: 'Zoe', twoFactor: false },
      { userId: 'u1', name: 'Anna', twoFactor: true },
      { userId: 'u2', name: 'Zoe', twoFactor: false },
    ]
    expect(affectedHolders(holders, true).map((holder) => holder.name)).toEqual(['Zoe'])
    expect(affectedHolders(holders, false).map((holder) => holder.name)).toEqual(['Anna', 'Zoe'])
  })
})

describe('declared once', () => {
  it('holds the permissions and the events of Security & health', () => {
    expect(FACTORY_PERMISSIONS.get('security.view')?.risk).toBe('read')
    expect(FACTORY_PERMISSIONS.get('security.drills.record')?.risk).toBe('write')
    expect(templateOf('admin')?.permissions).toEqual(expect.arrayContaining(['security.view', 'security.drills.record']))
    expect(templateOf('owner')?.permissions).toEqual(expect.arrayContaining(['security.view', 'security.drills.record']))
    expect(templateOf('read_only')?.permissions).toContain('security.view')
    expect(templateOf('read_only')?.permissions).not.toContain('security.drills.record')
    expect(EVENT_CATALOGUE.find('security.drill_recorded', 1)?.live?.permission).toBe('security.view')
    expect(EVENT_CATALOGUE.find('security.two_factor_changed', 1)?.live?.permission).toBe('roles.view')
  })
})
