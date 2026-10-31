import { describe, expect, it } from 'vitest'
import { summaryOf } from '@nexus/factory-domain/floor-sync/rules'
import { QUEUED_ACTIONS } from '@nexus/factory-domain/floor-sync/kinds'
import type { FloorJob, StationMachine, Symptom } from './api'
import {
  afterHeld,
  ageParts,
  bannerOf,
  defaultSafeAfter,
  EMPTY_DRAFT,
  firstStep,
  handBackHeld,
  isUnsafe,
  lockingRequests,
  machineByTag,
  machineCan,
  moveHeld,
  movesOf,
  photosOf,
  problemBeyond,
  reportHeld,
  reportPayload,
  reporterWords,
  signHeld,
  statusKey,
  statusOnArrival,
  symptomTiles,
  workDoneText,
} from './model'

/** The machine problem's rules (SCR-179, B-W2a-73): made-up machines, symptoms and jobs. */

const symptom = (code: string, extra: Partial<Symptom> = {}): Symptom => ({ id: code, code, labelIt: `${code} it`, labelEn: `${code} en`, labelI18n: {}, icon: null, classId: null, colour: null, unsafe: false, needsDetail: false, active: true, ...extra })
const machine = (extra: Partial<StationMachine> = {}): StationMachine => ({
  id: 'm1',
  siteId: 's1',
  assetNumber: 'DEMO-SEW-21',
  class: { id: 'c1', code: 'LOCKSTITCH', labelIt: 'Lineare', labelEn: 'Lockstitch', labelI18n: {}, icon: 'needle' },
  make: null,
  modelName: null,
  station: null,
  line: null,
  workCentre: null,
  status: 'RUNNING',
  statusSince: '2026-10-31T08:00:00.000Z',
  locked: false,
  openRequests: 0,
  openJobs: 0,
  version: 1,
  symptoms: [symptom('NOISE'), symptom('GUARD_MISSING', { unsafe: true }), symptom('OTHER', { needsDetail: true }), symptom('OLD', { active: false })],
  ...extra,
})
const OPERATOR = machineCan(['floor.work', 'plant.report'])
const TECHNICIAN = machineCan(['floor.work', 'plant.report', 'plant.jobs.work', 'plant.signSafe'])

describe('where the screen opens and which machine', () => {
  it('a technician opens on My jobs, anyone else on Which machine', () => {
    expect(firstStep(TECHNICIAN)).toBe('jobs')
    expect(firstStep(OPERATOR)).toBe('which')
    expect(machineCan(['floor.work'])).toEqual({ report: false, work: false, signSafe: false })
  })

  it('finds a scanned tag among the machines the tablet read, in any case', () => {
    expect(machineByTag([machine()], ' demo-sew-21 ')?.id).toBe('m1')
    expect(machineByTag([machine()], 'DEMO-SEW-99')).toBeNull()
  })

  it('says the station in our words: locked first, then the office’s do-not-use, then down and worked on', () => {
    const lines = bannerOf([machine({ assetNumber: 'A', status: 'DOWN' }), machine({ assetNumber: 'B', status: 'DO_NOT_USE' }), machine({ assetNumber: 'C', status: 'DO_NOT_USE', locked: true }), machine({ assetNumber: 'D', status: 'UNDER_MAINTENANCE' })])
    expect(lines.map((line) => `${line.key}:${line.assetNumber}`)).toEqual(['banner.locked:C', 'banner.doNotUse:B', 'banner.down:A', 'banner.maintenance:D'])
    expect(bannerOf([machine()])).toEqual([])
    expect(statusKey({ status: 'DO_NOT_USE', locked: true })).toBe('status.LOCKED')
    expect(statusKey({ status: 'DOWN', locked: false })).toBe('status.DOWN')
  })
})

describe('the report', () => {
  it('shows the active symptoms in the screen’s language; an unsafe one locks, Other asks for words', () => {
    const tiles = symptomTiles(machine().symptoms, 'it')
    expect(tiles.map((tile) => tile.label)).toEqual(['NOISE it', 'GUARD_MISSING it', 'OTHER it'])
    expect(tiles.find((tile) => tile.id === 'GUARD_MISSING')?.unsafe).toBe(true)
    expect(tiles.find((tile) => tile.id === 'OTHER')?.needsDetail).toBe(true)
    expect(isUnsafe(symptom('X', { unsafe: true }), { unsafe: false })).toBe(true)
    expect(isUnsafe(symptom('X'), { unsafe: true })).toBe(true)
    expect(isUnsafe(null, { unsafe: false })).toBe(false)
  })

  it('holds the report until a symptom or words; Other needs words; a retired machine reports nothing; offline is no reason', () => {
    const m = machine()
    expect(reportHeld({ can: OPERATOR, machine: m, symptom: null, words: '' })).toBe('held.pickOrWords')
    expect(reportHeld({ can: OPERATOR, machine: m, symptom: null, words: 'Smoke' })).toBeNull()
    expect(reportHeld({ can: OPERATOR, machine: m, symptom: symptom('OTHER', { needsDetail: true }), words: '  ' })).toBe('held.words')
    expect(reportHeld({ can: OPERATOR, machine: m, symptom: symptom('NOISE'), words: '' })).toBeNull()
    expect(reportHeld({ can: OPERATOR, machine: machine({ status: 'RETIRED' }), symptom: symptom('NOISE'), words: '' })).toBe('held.retired')
    expect(reportHeld({ can: machineCan(['floor.work']), machine: m, symptom: symptom('NOISE'), words: '' })).toBe('held.noReport')
    expect(reportHeld({ can: OPERATOR, machine: null, symptom: null, words: '' })).toBe('held.machineFirst')
  })

  it('queues the API’s body: the machine by id and tag, the symptom, the words, unsafe only when marked, down from the action', () => {
    expect(reportPayload(machine(), { symptomId: 'NOISE', words: '  ', unsafe: false }, false)).toEqual({ machineId: 'm1', assetNumber: 'DEMO-SEW-21', symptomId: 'NOISE', down: false })
    expect(reportPayload(machine(), { symptomId: null, words: ' Smoke from the motor ', unsafe: true }, true)).toEqual({ machineId: 'm1', assetNumber: 'DEMO-SEW-21', description: 'Smoke from the motor', unsafe: true, down: true })
    expect(reportPayload(machine(), EMPTY_DRAFT, true)).not.toHaveProperty('symptomId')
    // The queue's kind is the plant's own permission, and the office's lists name the machine's tag, never the person.
    expect(QUEUED_ACTIONS['plant.report'].permission).toBe('plant.report')
    expect(summaryOf('plant.report', reportPayload(machine(), { symptomId: 'NOISE', words: '', unsafe: false }, true))).toEqual({ code: 'DEMO-SEW-21' })
  })

  it('knows the state the report will cause (factory-domain statusAfterReport)', () => {
    expect(statusOnArrival(machine(), true, false)).toBe('DO_NOT_USE')
    expect(statusOnArrival(machine(), false, true)).toBe('DOWN')
    expect(statusOnArrival(machine(), false, false)).toBeNull()
    expect(statusOnArrival(machine({ status: 'UNDER_MAINTENANCE' }), false, true)).toBeNull()
  })
})

const job = (extra: Partial<FloorJob> = {}): FloorJob => ({
  id: 'j1',
  number: 'MJ-1',
  machine: { id: 'm1', assetNumber: 'DEMO-SEW-21', status: 'DO_NOT_USE', locked: true, class: machine().class, station: null, line: null },
  type: 'SAFETY',
  problem: 'Guard missing',
  symptom: null,
  priority: 'P1',
  ownership: 'MINE',
  dueAt: null,
  overdue: false,
  status: 'IN_PROGRESS',
  startedAt: null,
  handedBack: null,
  requestIds: [],
  ageMinutes: 5,
  open: true,
  createdAt: '2026-10-31T08:00:00.000Z',
  version: 1,
  ...extra,
})

describe('the technician’s job', () => {
  it('offers the moves the state allows, the main one last', () => {
    expect(movesOf(job({ status: 'NEW' }))).toEqual(['start'])
    expect(movesOf(job({ status: 'IN_PROGRESS' }))).toEqual(['wait', 'handBack'])
    expect(movesOf(job({ status: 'WAITING_PARTS' }))).toEqual(['start'])
    expect(movesOf(job({ status: 'HANDED_BACK' }))).toEqual(['reopen'])
    expect(movesOf(job({ status: 'CLOSED' }))).toEqual([])
  })

  it('holds a move for another technician’s job, a closed job, offline, without plant.jobs.work', () => {
    expect(moveHeld(job(), TECHNICIAN, true)).toBeNull()
    expect(moveHeld(job({ ownership: 'OTHER' }), TECHNICIAN, true)).toBe('held.notYours')
    expect(moveHeld(job({ open: false }), TECHNICIAN, true)).toBe('held.jobDone')
    expect(moveHeld(job(), TECHNICIAN, false)).toBe('held.offline')
    expect(moveHeld(job(), OPERATOR, true)).toBe('held.noWork')
  })

  it('lists the requests that still lock the machine, the photos, the reporters’ own words', () => {
    const requests = [
      { locking: true, photos: 2, description: ' Cover fell off ', reportedAt: '2026-10-31T08:00:00.000Z' },
      { locking: false, photos: 1, description: 'Cover fell off', reportedAt: '2026-10-31T08:05:00.000Z' },
      { locking: false, photos: 0, description: null, reportedAt: '2026-10-31T07:00:00.000Z' },
    ]
    expect(lockingRequests({ requests: requests as never }).length).toBe(1)
    expect(photosOf(requests)).toBe(3)
    expect(reporterWords(requests)).toEqual(['Cover fell off'])
  })

  it('hands back with the tile’s fixed words; running held while the machine is locked (H1)', () => {
    expect(workDoneText({ done: 'replaced', words: ' New cover ' })).toBe('Replaced a part: New cover')
    expect(workDoneText({ done: 'adjusted', words: '' })).toBe('Adjusted')
    expect(workDoneText({ done: 'other', words: 'Rewired the pedal' })).toBe('Rewired the pedal')
    expect(afterHeld('RUNNING', { locked: true })).toBe('held.signFirst')
    expect(afterHeld('DO_NOT_USE', { locked: true })).toBeNull()
    expect(handBackHeld({ done: null, words: '', after: null }, { locked: false }, true)).toBe('held.whatDone')
    expect(handBackHeld({ done: 'other', words: ' ', after: 'RUNNING' }, { locked: false }, true)).toBe('held.words')
    expect(handBackHeld({ done: 'cleaned', words: '', after: null }, { locked: false }, true)).toBe('held.after')
    expect(handBackHeld({ done: 'cleaned', words: '', after: 'RUNNING' }, { locked: true }, true)).toBe('held.signFirst')
    expect(handBackHeld({ done: 'cleaned', words: '', after: 'RUNNING' }, { locked: false }, false)).toBe('held.offline')
    expect(handBackHeld({ done: 'cleaned', words: '', after: 'RUNNING' }, { locked: false }, true)).toBeNull()
  })

  it('signs safe only with what was checked, online, as a technician; under maintenance while the job is started', () => {
    expect(signHeld({ words: '', after: 'RUNNING' }, TECHNICIAN, true)).toBe('held.checked')
    expect(signHeld({ words: 'Guard refitted', after: 'RUNNING' }, OPERATOR, true)).toBe('held.noSign')
    expect(signHeld({ words: 'Guard refitted', after: 'RUNNING' }, TECHNICIAN, false)).toBe('held.offline')
    expect(signHeld({ words: 'Guard refitted', after: 'RUNNING' }, TECHNICIAN, true)).toBeNull()
    expect(defaultSafeAfter(job({ status: 'IN_PROGRESS' }))).toBe('UNDER_MAINTENANCE')
    expect(defaultSafeAfter(job({ status: 'NEW' }))).toBe('RUNNING')
    expect(defaultSafeAfter(null)).toBe('RUNNING')
  })

  it('shows the job’s words beyond its symptom (the API writes the symptom in English first)', () => {
    const guard = symptom('GUARD_MISSING', { labelEn: 'Guard missing' })
    expect(problemBeyond({ problem: 'Guard missing', symptom: guard })).toBeNull()
    expect(problemBeyond({ problem: 'Guard missing: the cover fell off', symptom: guard })).toBe('the cover fell off')
    expect(problemBeyond({ problem: 'Yearly belt check', symptom: null })).toBe('Yearly belt check')
    expect(problemBeyond({ problem: 'Machine problem reported from the station.', symptom: guard })).toBeNull()
  })

  it('says a waiting time in minutes, hours or days', () => {
    expect(ageParts(14)).toEqual({ key: 'age.minutes', params: { count: 14 } })
    expect(ageParts(185)).toEqual({ key: 'age.hours', params: { hours: 3, minutes: '05' } })
    expect(ageParts(3000)).toEqual({ key: 'age.days', params: { count: 2 } })
  })
})
