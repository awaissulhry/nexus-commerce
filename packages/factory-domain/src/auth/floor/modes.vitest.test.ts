import { describe, expect, it } from 'vitest'
import { CREW, CREW_LOOK, crewEndOf, crewLeaveOf, crewMemberState, crewOrder, crewPlanFor, type CrewMemberFacts } from './crew'
import { KIOSK_STEPS, kioskApplies, kioskCheck } from './kiosk'
import { choiceProblems, LOW_LITERACY, speechLang, tilePages } from './literacy'
import { DEVICE_MODES, deviceModeProblems, isDeviceMode, MODE_RULES, shownLineOf, signInRefusal, type ModeFacts } from './modes'

const LINE = '019a0000-0000-7000-8000-0000000011a1'
const OTHER_LINE = '019a0000-0000-7000-8000-0000000011a2'
const STATION = '019a0000-0000-7000-8000-00000000057a'
const WORKER = '019a0000-0000-7000-8000-00000000b0a1'
const OTHER = '019a0000-0000-7000-8000-00000000b0a2'
const base: ModeFacts = { mode: 'STATION', kind: 'TABLET', stationId: STATION, stationLineId: null, lineId: null, personalWorkerId: null }

describe('floor modes chosen at enrolment (MES-181, MES-186)', () => {
  it('knows the four modes and what each does', () => {
    expect(DEVICE_MODES).toEqual(['STATION', 'LINE', 'DISPLAY', 'PHONE'])
    expect(isDeviceMode('DISPLAY')).toBe(true)
    expect(isDeviceMode('KIOSK')).toBe(false)
    expect(MODE_RULES.DISPLAY).toMatchObject({ signIn: 'NOBODY', landing: 'LINE_BOARD', crew: false })
    expect(MODE_RULES.PHONE).toMatchObject({ signIn: 'ONE_PERSON', kiosk: false, keepsBatteryAndNetwork: false, crew: false })
    expect(MODE_RULES.LINE).toMatchObject({ signIn: 'ANYONE', landing: 'LINE_VIEW' })
    // Crew mode only on a station's tablet (Owner question 24; the database holds the same).
    expect(DEVICE_MODES.filter((mode) => MODE_RULES[mode].crew)).toEqual(['STATION'])
  })

  it('a station tablet needs nothing more; a line of its own is refused', () => {
    expect(deviceModeProblems(base)).toEqual([])
    expect(deviceModeProblems({ ...base, stationId: null })).toEqual([])
    expect(deviceModeProblems({ ...base, lineId: LINE })[0]?.path).toBe('lineId')
  })

  it('a line tablet or a line board shows one line: its own or its station\'s', () => {
    expect(deviceModeProblems({ ...base, mode: 'DISPLAY', stationId: null })[0]?.path).toBe('lineId')
    expect(deviceModeProblems({ ...base, mode: 'DISPLAY', stationId: null, lineId: LINE })).toEqual([])
    expect(deviceModeProblems({ ...base, mode: 'LINE', stationLineId: LINE })).toEqual([])
    expect(shownLineOf({ mode: 'LINE', lineId: OTHER_LINE }, LINE)).toBe(OTHER_LINE)
    expect(shownLineOf({ mode: 'DISPLAY', lineId: null }, LINE)).toBe(LINE)
    expect(shownLineOf({ mode: 'STATION', lineId: null }, LINE)).toBe(LINE)
    expect(shownLineOf({ mode: 'PHONE', lineId: null }, LINE)).toBeNull()
  })

  it('a personal phone names its person, sits at no station and is no PC; only a phone names a person', () => {
    const phone: ModeFacts = { ...base, mode: 'PHONE', kind: 'HANDHELD', stationId: null, personalWorkerId: WORKER }
    expect(deviceModeProblems(phone)).toEqual([])
    expect(deviceModeProblems({ ...phone, personalWorkerId: null }).map((issue) => issue.path)).toEqual(['personalWorkerId'])
    expect(deviceModeProblems({ ...phone, stationId: STATION }).map((issue) => issue.path)).toEqual(['stationId'])
    expect(deviceModeProblems({ ...phone, kind: 'PC' }).map((issue) => issue.path)).toEqual(['kind'])
    expect(deviceModeProblems({ ...base, personalWorkerId: WORKER }).map((issue) => issue.path)).toEqual(['personalWorkerId'])
  })

  it('nobody signs in on a line board; only its person on a phone', () => {
    expect(signInRefusal({ mode: 'DISPLAY', personalWorkerId: null }, null)?.code).toBe('DISPLAY_NO_SIGN_IN')
    expect(signInRefusal({ mode: 'PHONE', personalWorkerId: WORKER }, WORKER)).toBeNull()
    expect(signInRefusal({ mode: 'PHONE', personalWorkerId: WORKER }, OTHER)?.code).toBe('PHONE_OTHER_PERSON')
    expect(signInRefusal({ mode: 'STATION', personalWorkerId: null }, OTHER)).toBeNull()
    expect(signInRefusal({ mode: 'LINE', personalWorkerId: null }, OTHER)).toBeNull()
  })
})

describe('low-literacy rules (MES-188)', () => {
  it('every floor choice this step adds is an icon and a tone first, and no two look the same', () => {
    expect(choiceProblems(DEVICE_MODES.map((mode) => ({ code: mode, look: MODE_RULES[mode].look })))).toEqual([])
    expect(choiceProblems(KIOSK_STEPS.map((step) => ({ code: step.id, look: step.look })))).toEqual([])
    expect(choiceProblems([{ code: 'active', look: CREW_LOOK.active }, { code: 'waiting', look: CREW_LOOK.waiting }])).toEqual([])
  })

  it('refuses a word-only choice, a long label and two choices told apart only by reading', () => {
    const problems = choiceProblems([
      { code: 'A', look: null, label: 'Pause' },
      { code: 'B', look: { icon: 'pause', tone: 'warning' }, label: 'Pause for a machine problem now' },
      { code: 'C', look: { icon: 'pause', tone: 'warning' }, label: 'Pause' },
      { code: 'D', look: { icon: 'Pause!', tone: 'loud' as never }, label: '' },
    ])
    expect(problems.map((issue) => issue.path)).toEqual(['0/look/icon', '0/look/tone', '1/label', '2/look', '3/look/icon', '3/look/tone', '3/label'])
  })

  it('six tiles a page; a voice language for every floor language', () => {
    expect(LOW_LITERACY.maxTilesPerPage).toBe(6)
    expect([0, 6, 7, 13].map(tilePages)).toEqual([1, 1, 2, 3])
    expect(speechLang('it')).toBe('it-IT')
    expect(speechLang('ro')).toBe('ro-RO')
    expect(speechLang('ur')).toBe('ur-PK')
    expect(speechLang('pt-BR')).toBe('pt-BR')
    expect(speechLang('wo')).toBe('wo')
  })
})

describe('the kiosk lock guide with an honest check (PLT-227)', () => {
  it('has four steps, and applies to every mode but a person\'s own phone', () => {
    expect(KIOSK_STEPS.map((step) => step.id)).toEqual(['install', 'pinning-on', 'open-app', 'pin-app'])
    expect(DEVICE_MODES.filter(kioskApplies)).toEqual(['STATION', 'LINE', 'DISPLAY'])
  })

  it('never claims a lock: pinning is unknown until the person says what Home did, and then it is theirs, not the tablet\'s', () => {
    const untested = kioskCheck({ fullScreen: true, installed: true, homeTest: 'NOT_TESTED' })
    expect(untested.lockedKnown).toBe(false)
    expect(untested.looksLocked).toBe(false)
    expect(untested.rows).toEqual([
      { id: 'fullScreen', state: 'ok', source: 'TABLET', look: { icon: 'check', tone: 'success' } },
      { id: 'installed', state: 'ok', source: 'TABLET', look: { icon: 'check', tone: 'success' } },
      { id: 'pinned', state: 'unknown', source: 'NOBODY', look: { icon: 'help-circle', tone: 'neutral' } },
    ])
    const stayed = kioskCheck({ fullScreen: true, installed: true, homeTest: 'STAYED' })
    expect(stayed).toMatchObject({ lockedKnown: false, looksLocked: true })
    expect(stayed.rows[2]).toMatchObject({ state: 'ok', source: 'PERSON' })
    const unknownBrowser = kioskCheck({ fullScreen: null, installed: false, homeTest: 'LEFT' })
    expect(unknownBrowser.rows.map((row) => [row.state, row.source])).toEqual([['unknown', 'NOBODY'], ['no', 'TABLET'], ['no', 'PERSON']])
    expect(unknownBrowser.looksLocked).toBe(false)
  })
})

describe('crew mode on one station tablet (PLT-059)', () => {
  const NOW = new Date('2026-11-18T09:00:00.000Z')
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
  const member = (id: string, workerId: string, joined: number, session: Partial<NonNullable<CrewMemberFacts['session']>> | null = {}): CrewMemberFacts => ({
    id,
    workerId,
    active: false,
    joinedAt: at(joined),
    leftAt: null,
    session: session === null ? null : { endedAt: null, idleExpiresAt: at(10), endsAt: at(480), endReason: null, ...session },
  })

  it('a member is in while their session lives; gone once it ended or ran out; left once recorded', () => {
    expect(crewMemberState(member('m1', WORKER, -30), NOW)).toBe('in')
    expect(crewMemberState(member('m1', WORKER, -30, { idleExpiresAt: at(-1) }), NOW)).toBe('gone')
    expect(crewMemberState(member('m1', WORKER, -30, null), NOW)).toBe('gone')
    expect(crewMemberState({ ...member('m1', WORKER, -30), leftAt: at(-5) }, NOW)).toBe('left')
  })

  it('a gone member leaves when the session ran out or ended, never before joining nor after now', () => {
    expect(crewLeaveOf(member('m1', WORKER, -30, { idleExpiresAt: at(-2) }), NOW)).toEqual({ leftAt: at(-2), reason: 'IDLE' })
    expect(crewLeaveOf(member('m1', WORKER, -30, { endsAt: at(-3), idleExpiresAt: at(-3) }), NOW)).toEqual({ leftAt: at(-3), reason: 'SHIFT_END' })
    expect(crewLeaveOf(member('m1', WORKER, -30, { endedAt: at(-4), endReason: 'PIN_RESET' }), NOW)).toEqual({ leftAt: at(-4), reason: 'PIN_RESET' })
    expect(crewLeaveOf(member('m1', WORKER, -1, { endedAt: at(-4), endReason: 'BADGE_REVOKED' }), NOW).leftAt).toEqual(at(-1))
    expect(crewLeaveOf(member('m1', WORKER, -30), NOW)).toEqual({ leftAt: NOW, reason: 'SIGNED_OUT' })
  })

  it('a member becomes active with a proof; anyone else joins while there is room (four at most)', () => {
    const three = [member('m1', 'w1', -30), member('m2', 'w2', -20), member('m3', 'w3', -10)]
    expect(crewPlanFor(three, 'w2')).toEqual({ kind: 'activate', memberId: 'm2' })
    expect(crewPlanFor(three, 'w4')).toEqual({ kind: 'join' })
    expect(CREW.maxMembers).toBe(4)
    expect(crewPlanFor([...three, member('m4', 'w4', -5)], 'w5')).toEqual({ kind: 'full' })
  })

  it('orders the chips by joining, and ends a crew at its last member\'s leaving', () => {
    expect(crewOrder([member('b', 'w2', -10), member('a', 'w1', -30), member('c', 'w3', -10)]).map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(crewEndOf([{ leftAt: at(-5), reason: 'IDLE' }, { leftAt: at(-1), reason: 'SIGNED_OUT' }], { at: NOW, reason: 'SIGNED_OUT' })).toEqual({ endedAt: at(-1), reason: 'SIGNED_OUT' })
    expect(crewEndOf([], { at: NOW, reason: 'DEVICE_REVOKED' })).toEqual({ endedAt: NOW, reason: 'DEVICE_REVOKED' })
  })
})
