import { describe, expect, it } from 'vitest'
import { FLOOR_SHARED_PERMISSIONS, FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { isOnBehalfEntry, onBehalfReasonText, onBehalfRefusal, severalWords, undoViewer, type OnBehalfFacts } from './rules'

const facts: OnBehalfFacts = { scanSubject: 'WORKER', leadId: 'lead', workerId: 'person', personHere: true, acknowledged: true, stationHere: true, reasonCode: 'BADGE_MISSING', note: null }

describe('scan on behalf (MES-099)', () => {
  it('takes a person of the site who acknowledged the notice, at a station of the site, with a reason', () => {
    expect(onBehalfRefusal(facts)).toBeNull()
  })

  it('refuses in words that never name the person', () => {
    expect(onBehalfRefusal({ ...facts, stationHere: false })?.code).toBe('BEHALF_STATION_UNKNOWN')
    expect(onBehalfRefusal({ ...facts, workerId: null })?.code).toBe('BEHALF_PERSON_NEEDED')
    expect(onBehalfRefusal({ ...facts, workerId: 'lead' })?.code).toBe('BEHALF_SELF')
    expect(onBehalfRefusal({ ...facts, personHere: false })?.code).toBe('BEHALF_PERSON_UNKNOWN')
    expect(onBehalfRefusal({ ...facts, reasonCode: 'OTHER' })?.code).toBe('BEHALF_NOTE_MISSING')
    expect(onBehalfRefusal({ ...facts, reasonCode: 'OTHER', note: 'A few words' })).toBeNull()
  })

  it('waits for the person to acknowledge the notice: a queued entry may pass later (Statuto art. 4 c.3)', () => {
    expect(onBehalfRefusal({ ...facts, acknowledged: false })).toMatchObject({ code: 'BEHALF_NO_NOTICE', final: false })
  })

  it('a site that records the station names nobody', () => {
    const station = { ...facts, scanSubject: 'STATION', workerId: null, personHere: false, acknowledged: false } as const
    expect(onBehalfRefusal(station)).toBeNull()
    expect(onBehalfRefusal({ ...station, workerId: 'person' })?.code).toBe('BEHALF_NAMES_NOBODY')
  })

  it('marks the record, tile and note', () => {
    expect(onBehalfReasonText('TABLET_DOWN', null)).toBe('Entered by the team leader: The tablet was not working')
    expect(onBehalfReasonText('OTHER', 'Hand bandaged')).toBe('Entered by the team leader: Other (say why) (Hand bandaged)')
    expect(isOnBehalfEntry(onBehalfReasonText('TABLET_DOWN', null))).toBe(true)
    expect(isOnBehalfEntry('Covering for line 2')).toBe(false)
    expect(isOnBehalfEntry(null)).toBe(false)
  })

  it('only a holder of the right stands in for the entry’s person when taking it back; a normal report stays its own', () => {
    const viewer = { scanSubject: 'WORKER', workerId: 'lead', stationId: 'sew-2' } as const
    const entry = { reason: 'Entered by the team leader: Forgot to scan', workerId: 'person', stationId: 'sew-1' }
    expect(undoViewer(viewer, entry, true)).toEqual({ scanSubject: 'WORKER', workerId: 'person', stationId: 'sew-1' })
    expect(undoViewer(viewer, entry, false)).toBe(viewer)
    expect(undoViewer(viewer, { ...entry, reason: null }, true)).toBe(viewer)
  })

  it('the right is the team leader’s on the floor (and the owner’s by every()); not an operator’s', () => {
    expect(FACTORY_PERMISSIONS.get('production.scan.behalf')).toMatchObject({ area: 'production', risk: 'write' })
    expect(FLOOR_SHARED_PERMISSIONS).toContain('production.scan.behalf')
    expect(templateOf('team_leader')?.permissions).toContain('production.scan.behalf')
    expect(templateOf('owner')?.permissions).toContain('production.scan.behalf')
    for (const key of ['operator', 'cutting_operator', 'floor_inspector', 'production_manager', 'floor_supervisor']) expect(templateOf(key)?.permissions).not.toContain('production.scan.behalf')
  })
})

describe('several bundles at once (MES-100)', () => {
  it('says the receipt in words', () => {
    expect(severalWords({ finished: 3, refused: 0, good: 60, scrap: 0, rework: 0 })).toBe('3 bundles finished · 60 good')
    expect(severalWords({ finished: 1, refused: 1, good: 18, scrap: 1, rework: 1 })).toBe('1 bundle finished · 18 good · 1 scrap · 1 rework · 1 refused')
    expect(severalWords({ finished: 0, refused: 2, good: 0, scrap: 0, rework: 0 })).toBe('0 bundles finished · 0 good · 2 refused')
  })
})
