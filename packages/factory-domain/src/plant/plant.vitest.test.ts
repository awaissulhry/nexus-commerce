import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../auth/permissions/catalogue'
import { ROLE_TEMPLATES, templateOf } from '../auth/roles/templates'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { events } from './events'
import { PLANT_FLOOR_PERMISSIONS, PLANT_PERMISSIONS, PLANT_SIGN_SAFE } from './permissions'
import {
  ASSET_NUMBER,
  codeProblems,
  defaultPriority,
  floorReporter,
  isOverdue,
  isUnsafeReport,
  jobMoveRefusal,
  joinJobRefusal,
  machineDraftProblems,
  mergedWords,
  mergeTargetRefusal,
  PLANT_CODE,
  PLANT_COLOUR,
  PLANT_ICON,
  plantWordsProblems,
  problemOf,
  reportedAtOf,
  reportRefusal,
  retireRefusal,
  signSafeRefusal,
  stationWords,
  statusAfterJobMove,
  statusAfterReport,
  statusAfterSignSafe,
  triageRefusal,
  weekStart,
  type JobMoveFacts,
} from './rules'
import { missingStarter, STARTER_CLASSES, STARTER_SYMPTOMS } from './starter'

const machine = { assetNumber: 'SEW-L1-07', status: 'RUNNING' as const, classId: 'class-lockstitch' }

describe('permissions and templates (H1: anyone reports, only a technician signs safe)', () => {
  it('declares every plant permission; the floor holds report, the technician work and sign-safe', () => {
    for (const name of PLANT_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
    for (const name of PLANT_FLOOR_PERMISSIONS) expect((FLOOR_SHARED_PERMISSIONS as readonly string[]).includes(name), name).toBe(true)
    for (const key of ['operator', 'cutting_operator', 'floor_inspector', 'team_leader', 'technician']) expect(templateOf(key)?.permissions, key).toContain('plant.report')
    const signers = ROLE_TEMPLATES.filter((entry) => entry.permissions.includes(PLANT_SIGN_SAFE)).map((entry) => entry.key)
    // The owner holds every office permission by itself; otherwise only the technicians' templates.
    expect(signers.sort()).toEqual(['maintenance', 'owner', 'technician'])
    expect(templateOf('technician')).toMatchObject({ audience: 'floor', requireMfa: false, grains: [] })
    expect(templateOf('technician')?.permissions).toEqual(['floor.work', 'plant.jobs.work', 'plant.report', 'plant.signSafe', 'print.labels', 'print.view', /* B-W2b-35 */ 'production.calls.answer', 'production.calls.view'])
    expect(templateOf('maintenance')).toMatchObject({ audience: 'office', grains: [] })
    expect(templateOf('read_only')?.permissions.filter((name) => name.startsWith('plant.'))).toEqual(['plant.view'])
    expect(templateOf('production_manager')?.permissions).toEqual(expect.arrayContaining(['plant.view', 'plant.requests.triage', 'plant.jobs.manage', 'plant.machines.manage', 'plant.report']))
    expect(templateOf('production_manager')?.permissions).not.toContain('plant.signSafe')
    expect(templateOf('planner')?.permissions.filter((name) => name.startsWith('plant.'))).toEqual(['plant.view'])
  })

  it('declares the events in the catalogue; every one but the lists reaches the floor of its site; no money on a screen', () => {
    for (const definition of events) {
      expect(EVENT_CATALOGUE.find(definition.type, definition.version), definition.type).toBeDefined()
      expect(definition.live?.permission).toBe('plant.view')
      // B-W2a-F5: the station's machine card (plant.report, every floor role) and the technician's My jobs (plant.jobs.work).
      const floor = definition.type === 'plant.lists_changed' ? null : definition.type.startsWith('maintenance_job.') ? 'plant.jobs.work' : 'plant.report'
      expect(definition.live?.floor, definition.type).toBe(floor)
    }
  })
})

describe('codes, words and machines', () => {
  it('checks codes, asset numbers, icons, colours and words as the guards do', () => {
    expect(PLANT_CODE.test('THREAD_BREAKS')).toBe(true)
    expect(codeProblems('thread breaks')).toHaveLength(1)
    expect(ASSET_NUMBER.test('SEED-SEW-L1-01')).toBe(true)
    expect(ASSET_NUMBER.test('SEW 01')).toBe(false)
    expect(machineDraftProblems({ assetNumber: 'sew l1' }, true).map((problem) => problem.path)).toEqual(['assetNumber'])
    expect(machineDraftProblems({ assetNumber: 'sew-l1-01', year: 1850, purchaseCost: -1 }, true).map((problem) => problem.path)).toEqual(['year', 'purchaseCost'])
    expect(machineDraftProblems({ year: 2021 }, false)).toEqual([])
    expect(plantWordsProblems({ labelIt: ' ', icon: 'Shield Off', colour: 'red', labelI18n: { it: 'x', ro: '' } }, 'symptom').map((problem) => problem.path)).toEqual(['labelIt', 'labelI18n/it', 'labelI18n/ro', 'icon', 'colour'])
    expect(plantWordsProblems({ labelIt: 'Filo', labelEn: 'Thread', icon: 'shield-off', colour: '#DC2626' }, 'symptom')).toEqual([])
    expect(mergedWords({ ro: 'a', de: 'b' }, { ro: null, fr: ' c ' })).toEqual({ de: 'b', fr: 'c' })
  })

  it('the starter set is valid and adds only what is missing', () => {
    const classCodes = new Set(STARTER_CLASSES.map((entry) => entry.code))
    for (const entry of STARTER_CLASSES) expect(PLANT_CODE.test(entry.code) && PLANT_ICON.test(entry.icon), entry.code).toBe(true)
    for (const entry of STARTER_SYMPTOMS) {
      expect(PLANT_CODE.test(entry.code), entry.code).toBe(true)
      expect(entry.classCode === null || classCodes.has(entry.classCode), entry.code).toBe(true)
      expect(entry.icon === null || PLANT_ICON.test(entry.icon)).toBe(true)
      expect(entry.colour === null || PLANT_COLOUR.test(entry.colour)).toBe(true)
    }
    expect(STARTER_SYMPTOMS.filter((entry) => entry.unsafe).map((entry) => entry.code)).toEqual(['GUARD_MISSING', 'TWO_HAND_CONTROL', 'ELECTRICAL_FAULT'])
    const missing = missingStarter(new Set(['LOCKSTITCH']), new Set(['WONT_START']))
    expect(missing.classes.map((entry) => entry.code)).not.toContain('LOCKSTITCH')
    expect(missing.symptoms.map((entry) => entry.code)).not.toContain('WONT_START')
    expect(missingStarter(classCodes, new Set(STARTER_SYMPTOMS.map((entry) => entry.code)))).toEqual({ classes: [], symptoms: [] })
  })

  it('a machine retires only without open work', () => {
    expect(retireRefusal({ assetNumber: 'M1', status: 'RUNNING', openRequests: 0, openJobs: 0 })).toBeNull()
    expect(retireRefusal({ assetNumber: 'M1', status: 'RUNNING', openRequests: 1, openJobs: 0 })?.code).toBe('OPEN_WORK')
    expect(retireRefusal({ assetNumber: 'M1', status: 'RETIRED', openRequests: 0, openJobs: 0 })?.code).toBe('RETIRED')
  })
})

describe('a report from the station (QHS-178, H1)', () => {
  const symptom = { classId: null, active: true, unsafe: false, needsDetail: false }

  it('refuses a retired machine, a retired symptom, another class, and words missing', () => {
    expect(reportRefusal({ machine, symptom, description: null })).toBeNull()
    expect(reportRefusal({ machine: { ...machine, status: 'RETIRED' }, symptom, description: null })?.code).toBe('RETIRED')
    expect(reportRefusal({ machine, symptom: { ...symptom, active: false }, description: null })?.code).toBe('SYMPTOM_INACTIVE')
    expect(reportRefusal({ machine, symptom: { ...symptom, classId: 'class-press' }, description: null })?.code).toBe('SYMPTOM_OTHER_CLASS')
    expect(reportRefusal({ machine, symptom: { ...symptom, needsDetail: true }, description: null })?.code).toBe('DETAIL_NEEDED')
    expect(reportRefusal({ machine, symptom: null, description: null })?.code).toBe('DETAIL_NEEDED')
    expect(reportRefusal({ machine, symptom: null, description: 'It smokes.' })).toBeNull()
  })

  it('unsafe locks the machine at once; down stops a running machine only', () => {
    expect(isUnsafeReport({ symptomUnsafe: false, markedUnsafe: true })).toBe(true)
    expect(isUnsafeReport({ symptomUnsafe: true, markedUnsafe: false })).toBe(true)
    expect(statusAfterReport({ status: 'RUNNING', unsafe: true, down: false })).toBe('DO_NOT_USE')
    expect(statusAfterReport({ status: 'UNDER_MAINTENANCE', unsafe: true, down: true })).toBe('DO_NOT_USE')
    expect(statusAfterReport({ status: 'DO_NOT_USE', unsafe: true, down: false })).toBeNull()
    expect(statusAfterReport({ status: 'RUNNING', unsafe: false, down: true })).toBe('DOWN')
    expect(statusAfterReport({ status: 'UNDER_MAINTENANCE', unsafe: false, down: true })).toBeNull()
    expect(statusAfterReport({ status: 'RUNNING', unsafe: false, down: false })).toBeNull()
    expect(statusAfterReport({ status: 'RETIRED', unsafe: true, down: true })).toBeNull()
  })

  it('names the worker only where the site records workers and they acknowledged the notice; else the station', () => {
    const base = { workerId: 'w1', workerAcknowledged: true, deviceStationId: 's-dev', machineStationId: 's-mach' }
    expect(floorReporter({ scanSubject: 'WORKER', ...base })).toEqual({ ok: true, reportedByWorkerId: 'w1', stationId: 's-dev' })
    expect(floorReporter({ scanSubject: 'WORKER', ...base, workerAcknowledged: false })).toEqual({ ok: true, reportedByWorkerId: null, stationId: 's-dev' })
    expect(floorReporter({ scanSubject: 'STATION', ...base })).toEqual({ ok: true, reportedByWorkerId: null, stationId: 's-dev' })
    expect(floorReporter({ scanSubject: 'STATION', ...base, deviceStationId: null })).toEqual({ ok: true, reportedByWorkerId: null, stationId: 's-mach' })
    const none = floorReporter({ scanSubject: 'STATION', ...base, deviceStationId: null, machineStationId: null })
    expect(none.ok ? null : none.refusal.code).toBe('NO_REPORTER')
  })

  it('prefills a job from the request; keeps the tablet time when plausible', () => {
    expect(defaultPriority({ unsafe: true, down: false })).toBe('P1')
    expect(defaultPriority({ unsafe: false, down: true })).toBe('P1')
    expect(defaultPriority({ unsafe: false, down: false })).toBe('P2')
    expect(problemOf('Thread breaks', ' on heavy leather ')).toBe('Thread breaks: on heavy leather')
    expect(problemOf(null, null)).toBe('Machine problem reported from the station.')
    const now = new Date('2026-11-20T10:00:00Z')
    expect(reportedAtOf(new Date('2026-11-20T09:00:00Z'), now).toISOString()).toBe('2026-11-20T09:00:00.000Z')
    expect(reportedAtOf(new Date('2026-11-20T11:00:00Z'), now)).toBe(now)
    expect(reportedAtOf(new Date('2026-11-01T09:00:00Z'), now)).toBe(now)
  })
})

describe('triage and the sign-safe', () => {
  const open = { status: 'NEW' as const, unsafe: false, signedSafe: false }

  it('an unsafe request not signed safe is neither merged nor closed (H1)', () => {
    expect(triageRefusal({ request: open, assetNumber: 'M1' }, 'close')).toBeNull()
    expect(triageRefusal({ request: { ...open, unsafe: true }, assetNumber: 'M1' }, 'close')?.code).toBe('LOCKED_UNSAFE')
    expect(triageRefusal({ request: { ...open, unsafe: true }, assetNumber: 'M1' }, 'merge')?.code).toBe('LOCKED_UNSAFE')
    expect(triageRefusal({ request: { ...open, unsafe: true }, assetNumber: 'M1' }, 'job')).toBeNull()
    expect(triageRefusal({ request: { ...open, unsafe: true, signedSafe: true }, assetNumber: 'M1' }, 'close')).toBeNull()
    expect(triageRefusal({ request: { ...open, status: 'JOB_MADE' }, assetNumber: 'M1' }, 'acknowledge')?.code).toBe('ALREADY_TRIAGED')
    expect(triageRefusal({ request: { ...open, status: 'ACKNOWLEDGED' }, assetNumber: 'M1' }, 'acknowledge')?.code).toBe('ALREADY_TRIAGED')
  })

  it('merges and joins only within the machine, into what is still open', () => {
    expect(mergeTargetRefusal({ requestId: 'r1', machineId: 'm1', target: { id: 'r1', machineId: 'm1', status: 'NEW' } })?.code).toBe('MERGE_SELF')
    expect(mergeTargetRefusal({ requestId: 'r1', machineId: 'm1', target: { id: 'r2', machineId: 'm2', status: 'NEW' } })?.code).toBe('MERGE_OTHER_MACHINE')
    expect(mergeTargetRefusal({ requestId: 'r1', machineId: 'm1', target: { id: 'r2', machineId: 'm1', status: 'CLOSED' } })?.code).toBe('MERGE_TARGET_DONE')
    expect(mergeTargetRefusal({ requestId: 'r1', machineId: 'm1', target: { id: 'r2', machineId: 'm1', status: 'JOB_MADE' } })).toBeNull()
    expect(joinJobRefusal({ machineId: 'm1', job: { machineId: 'm2', status: 'NEW', number: 'MJ-1' } })?.code).toBe('JOB_OTHER_MACHINE')
    expect(joinJobRefusal({ machineId: 'm1', job: { machineId: 'm1', status: 'CANCELLED', number: 'MJ-1' } })?.code).toBe('JOB_DONE')
  })

  it('signs only an unsafe request, once; the machine then runs, or is under maintenance while its job is started', () => {
    expect(signSafeRefusal({ unsafe: false, signedSafe: false })?.code).toBe('NOT_UNSAFE')
    expect(signSafeRefusal({ unsafe: true, signedSafe: true })?.code).toBe('SIGNED_ALREADY')
    expect(signSafeRefusal({ unsafe: true, signedSafe: false })).toBeNull()
    expect(statusAfterSignSafe({ asked: undefined, startedJob: false })).toBe('RUNNING')
    expect(statusAfterSignSafe({ asked: undefined, startedJob: true })).toBe('UNDER_MAINTENANCE')
    expect(statusAfterSignSafe({ asked: 'RUNNING', startedJob: true })).toBe('RUNNING')
  })
})

describe('jobs (QHS-184)', () => {
  const facts = (status: JobMoveFacts['job']['status'], extra: Partial<JobMoveFacts> = {}): JobMoveFacts => ({
    job: { number: 'MJ-2026-0001', status },
    machine: { assetNumber: 'M1', status: 'DO_NOT_USE', locked: true },
    floor: false,
    ownership: 'NOBODY',
    ...extra,
  })

  it('moves by the machine of moves; the floor works only its own or nobody\'s jobs', () => {
    expect(jobMoveRefusal(facts('NEW'), 'start')).toBeNull()
    expect(jobMoveRefusal(facts('HANDED_BACK'), 'start')?.code).toBe('MOVE_NOT_ALLOWED')
    expect(jobMoveRefusal(facts('IN_PROGRESS'), 'close')?.code).toBe('MOVE_NOT_ALLOWED')
    expect(jobMoveRefusal(facts('NEW', { floor: true, ownership: 'OTHER' }), 'start')?.code).toBe('NOT_YOUR_JOB')
    expect(jobMoveRefusal(facts('NEW', { floor: false, ownership: 'OTHER' }), 'start')).toBeNull()
    expect(jobMoveRefusal(facts('NEW', { machine: { assetNumber: 'M1', status: 'RETIRED', locked: false } }), 'start')?.code).toBe('RETIRED')
  })

  it('hands back running only once the machine is signed safe (H1)', () => {
    expect(jobMoveRefusal(facts('IN_PROGRESS', { machineAfter: 'RUNNING' }), 'handBack')?.code).toBe('LOCKED_UNSAFE')
    expect(jobMoveRefusal(facts('IN_PROGRESS', { machineAfter: 'DO_NOT_USE' }), 'handBack')).toBeNull()
    expect(jobMoveRefusal(facts('IN_PROGRESS', { machineAfter: 'RUNNING', machine: { assetNumber: 'M1', status: 'UNDER_MAINTENANCE', locked: false } }), 'handBack')).toBeNull()
  })

  it("moves the machine's status with the work", () => {
    const after = (move: Parameters<typeof statusAfterJobMove>[0]['move'], status: Parameters<typeof statusAfterJobMove>[0]['status'], extra: Partial<Parameters<typeof statusAfterJobMove>[0]> = {}) =>
      statusAfterJobMove({ move, status, floor: false, otherStartedJob: false, ...extra })
    expect(after('start', 'DOWN')).toBe('UNDER_MAINTENANCE')
    expect(after('start', 'DO_NOT_USE')).toBeNull()
    expect(after('handBack', 'UNDER_MAINTENANCE', { machineAfter: 'RUNNING' })).toBe('RUNNING')
    expect(after('handBack', 'UNDER_MAINTENANCE', { machineAfter: 'DO_NOT_USE' })).toBe('DO_NOT_USE')
    expect(after('handBack', 'UNDER_MAINTENANCE', { machineAfter: 'RETIRED' })).toBe('RETIRED')
    expect(after('handBack', 'UNDER_MAINTENANCE', { machineAfter: 'RETIRED', floor: true })).toBe('DO_NOT_USE')
    expect(after('close', 'DO_NOT_USE', { machineAfter: 'RETIRED' })).toBe('RETIRED')
    expect(after('close', 'RUNNING', { machineAfter: 'RUNNING' })).toBeNull()
    expect(after('reopen', 'RUNNING')).toBe('UNDER_MAINTENANCE')
    expect(after('cancel', 'UNDER_MAINTENANCE')).toBe('DOWN')
    expect(after('cancel', 'UNDER_MAINTENANCE', { otherStartedJob: true })).toBeNull()
    expect(after('start', 'RETIRED')).toBeNull()
  })

  it('is overdue past its due time unless handed back; the week starts on Monday in Rome', () => {
    const now = new Date('2026-11-20T10:00:00Z')
    expect(isOverdue({ status: 'PLANNED', dueAt: new Date('2026-11-20T08:00:00Z') }, now)).toBe(true)
    expect(isOverdue({ status: 'HANDED_BACK', dueAt: new Date('2026-11-20T08:00:00Z') }, now)).toBe(false)
    expect(isOverdue({ status: 'CLOSED', dueAt: new Date('2026-11-20T08:00:00Z') }, now)).toBe(false)
    expect(isOverdue({ status: 'NEW', dueAt: null }, now)).toBe(false)
    // Friday 20 Nov 2026 → Monday 16 Nov, 00:00 in Rome (23:00 UTC the day before).
    expect(weekStart(now).toISOString()).toBe('2026-11-15T23:00:00.000Z')
    expect(weekStart(new Date('2026-11-15T23:30:00Z')).toISOString()).toBe('2026-11-15T23:00:00.000Z')
  })
})

describe('the station says it in words', () => {
  it('names the do-not-use machines and blocks the station when none is usable', () => {
    expect(stationWords([{ assetNumber: 'A', status: 'RUNNING', locked: false }])).toEqual({ blocked: false, message: null, fix: null })
    const one = stationWords([
      { assetNumber: 'A', status: 'DO_NOT_USE', locked: true },
      { assetNumber: 'B', status: 'RUNNING', locked: false },
    ])
    expect(one.blocked).toBe(false)
    expect(one.message).toBe('Machine A is marked do not use (unsafe): do not work on it.')
    const all = stationWords([
      { assetNumber: 'A', status: 'DO_NOT_USE', locked: true },
      { assetNumber: 'C', status: 'RETIRED', locked: false },
    ])
    expect(all.blocked).toBe(true)
    expect(all.fix).toContain('signs it safe')
  })
})
