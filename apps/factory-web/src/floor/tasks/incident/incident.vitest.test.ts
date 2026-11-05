import { describe, expect, it } from 'vitest'
import { anonymousRefusal, ANONYMOUS_KINDS, INCIDENT_LIMITS, KIND_WORDS, reportRefusal } from '@nexus/factory-domain/safety/incidents/rules'
import { QUEUED_ACTIONS } from '@nexus/factory-domain/floor-sync/kinds'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { whatKeyOf } from '../../queue/actions'
import { FLOOR_PAGES } from '../../moves'
import { INCIDENT_PAGE } from '../machine/depth'
import { FLOOR_NAMESPACES, TASK_ROUTES } from '../routes'
import type { HelpStation } from '../help/api'
import { offerIncident, takeIncidentOffer } from './handoff'
import {
  EMERGENCY,
  EMPTY_DRAFT,
  helpCallOf,
  helpPress,
  isKnownRefusal,
  KINDS,
  kindPicked,
  KNOWN_REFUSALS,
  mayGoWithoutName,
  nextUpload,
  offeredWhere,
  outsideHeld,
  peopleAsked,
  personHeld,
  photoHeld,
  photoName,
  PHOTOS_MAX,
  QUEUED_KIND,
  queuedPayload,
  reportBody,
  sendHeld,
  sendsWithoutName,
  whereId,
  whereTiles,
  workerHeld,
  type IncidentDraft,
  type PersonDraft,
} from './model'

/**
 * SCR-230's rules (B-W2b-137): someone hurt first, three taps, without a name only where the API allows it and never queued,
 * the body the API reads (B-W2b-125's floorReportBody), photos and people, the call for help, and the wiring (tile, route,
 * catalogue, the machine report's hook).
 */

const SEW = { code: 'SEW-02', name: 'Cucitura 2' }
const MACHINES = [{ id: 'm1', assetNumber: 'SEW-21' }]
const AREAS = [{ id: 'a1', code: 'CUC', name: 'Cucitura' }]
const draft = (extra: Partial<IncidentDraft> = {}): IncidentDraft => ({ ...EMPTY_DRAFT, ...extra })
const person = (who: PersonDraft['who'], extra: Partial<PersonDraft> = {}): PersonDraft => ({ id: `p-${who}`, who, name: who === 'OUTSIDE' ? 'Autista Demo' : 'Ada Demo', involvement: 'INJURED', ...extra })

describe('someone hurt first', () => {
  it('112 is factory-domain’s own (it shows before any read, with no network)', () => {
    expect(EMERGENCY).toBe('112')
  })

  it('the tiles are Incident (someone hurt) · Near miss · Hazard, in factory-domain’s words in both languages', () => {
    expect(KINDS).toEqual(['INJURY', 'NEAR_MISS', 'HAZARD'])
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['floor-incident'] ?? {}
      for (const kind of KINDS) expect(words[`kind.${kind}`], `${locale} ${kind}`).toBe(KIND_WORDS[kind][locale])
    }
  })
})

describe('where: "Here: this station" first', () => {
  it('here, this station’s machines, the site’s areas, somewhere else last', () => {
    expect(whereTiles({ station: SEW, machines: MACHINES, areas: AREAS }).map(whereId)).toEqual(['here', 'machine:m1', 'area:a1', 'elsewhere'])
    // A tablet with no station (a line tablet, a phone): areas and somewhere else; never "here".
    expect(whereTiles({ station: null, machines: [], areas: AREAS }).map(whereId)).toEqual(['area:a1', 'elsewhere'])
    // Offline, never read: here and somewhere else still make a report.
    expect(whereTiles({ station: SEW, machines: [], areas: [] }).map(whereId)).toEqual(['here', 'elsewhere'])
  })

  it('the machine report’s machine comes right after "here", picked; one of this station’s is not listed twice', () => {
    const tiles = whereTiles({ station: SEW, machines: MACHINES, areas: AREAS, offered: { id: 'm9', assetNumber: 'SEW-09' } })
    expect(tiles.map(whereId)).toEqual(['here', 'machine:m9', 'machine:m1', 'area:a1', 'elsewhere'])
    expect(offeredWhere(tiles, 'm9')).toEqual({ kind: 'machine', id: 'm9', assetNumber: 'SEW-09', here: false })
    expect(whereTiles({ station: SEW, machines: MACHINES, areas: [], offered: MACHINES[0] }).map(whereId)).toEqual(['here', 'machine:m1', 'elsewhere'])
    expect(offeredWhere(tiles, null)).toBeNull()
  })
})

describe('sending: three taps, held with the reason', () => {
  it('Send waits for a kind and a place; somewhere else needs words; offline is no reason', () => {
    expect(sendHeld(draft())).toBe('held.kind')
    expect(sendHeld(draft({ kind: 'HAZARD' }))).toBe('held.where')
    expect(sendHeld(draft({ kind: 'HAZARD', where: { kind: 'elsewhere' } }))).toBe('held.place')
    expect(sendHeld(draft({ kind: 'HAZARD', where: { kind: 'elsewhere' }, place: 'Cortile' }))).toBeNull()
    expect(sendHeld(draft({ kind: 'HAZARD', where: { kind: 'here' } }))).toBeNull()
    expect(sendHeld(draft({ kind: 'HAZARD', where: { kind: 'here' } }), true)).toBe('held.busy')
  })

  it('the three-tap body: Hazard → Here → Send is the kind, "here" and the language; the API refuses none of it', () => {
    const body = reportBody(draft({ kind: 'HAZARD', where: { kind: 'here' } }), 'it')
    expect(body).toEqual({ kind: 'HAZARD', language: 'it', here: true })
    expect(reportRefusal({ kind: body.kind, anonymous: false, via: 'FLOOR', people: [], where: { stationId: 'the tablet’s' }, occurredAt: new Date(0), now: new Date() })).toBeNull()
  })

  it('where in the body: a machine here says here too; an area; somewhere else as words', () => {
    expect(reportBody(draft({ kind: 'NEAR_MISS', where: { kind: 'machine', id: 'm1', assetNumber: 'SEW-21', here: true } }), 'en')).toMatchObject({ machineId: 'm1', here: true })
    expect(reportBody(draft({ kind: 'NEAR_MISS', where: { kind: 'machine', id: 'm9', assetNumber: 'SEW-09', here: false } }), 'en')).not.toHaveProperty('here')
    expect(reportBody(draft({ kind: 'NEAR_MISS', where: { kind: 'area', id: 'a1', code: 'CUC', name: 'Cucitura' } }), 'en')).toMatchObject({ areaId: 'a1' })
    expect(reportBody(draft({ kind: 'NEAR_MISS', where: { kind: 'elsewhere' }, place: '  Cortile  ' }), 'en')).toMatchObject({ place: 'Cortile' })
    expect(reportBody(draft({ kind: 'NEAR_MISS', where: { kind: 'here' }, words: '  Cavo a terra  ' }), 'en')).toMatchObject({ what: 'Cavo a terra' })
    expect(reportBody(draft({ kind: 'NEAR_MISS', where: { kind: 'here' }, words: '   ' }), 'en')).not.toHaveProperty('what')
  })

  it('the people of an incident: me, a worker by id, someone from outside by name; none for a near miss or a hazard', () => {
    const people = [person('ME', { workerId: 'w-me' }), person('WORKER', { workerId: 'w-2', name: 'Paolo Demo', involvement: 'INVOLVED' }), person('OUTSIDE')]
    expect(reportBody(draft({ kind: 'INJURY', where: { kind: 'here' }, people }), 'it').people).toEqual([
      { who: 'ME', involvement: 'INJURED' },
      { who: 'WORKER', workerId: 'w-2', involvement: 'INVOLVED' },
      { who: 'OUTSIDE', outsideName: 'Autista Demo', involvement: 'INJURED' },
    ])
    expect(peopleAsked('INJURY')).toBe(true)
    expect(peopleAsked('HAZARD')).toBe(false)
    expect(reportBody(draft({ kind: 'HAZARD', where: { kind: 'here' }, people }), 'it')).not.toHaveProperty('people')
    // Picking another kind drops the people (the design asks them for an incident only).
    expect(kindPicked(draft({ kind: 'INJURY', people }), 'NEAR_MISS').people).toEqual([])
  })
})

describe('without a name: a near miss or a hazard, naming nobody, never queued', () => {
  it('only the kinds the API allows; an injury drops the switch', () => {
    expect(mayGoWithoutName('NEAR_MISS')).toBe(true)
    expect(mayGoWithoutName('HAZARD')).toBe(true)
    expect(mayGoWithoutName('INJURY')).toBe(false)
    expect(mayGoWithoutName(null)).toBe(false)
    expect(mayGoWithoutName('HAZARD', ['NEAR_MISS'])).toBe(false)
    expect(kindPicked(draft({ kind: 'HAZARD', withoutName: true }), 'INJURY').withoutName).toBe(false)
    expect(sendsWithoutName(draft({ kind: 'INJURY', withoutName: true }))).toBe(false)
  })

  it('its body says anonymous and names nobody, so the API accepts it (factory-domain anonymousRefusal)', () => {
    const body = reportBody(draft({ kind: 'HAZARD', where: { kind: 'here' }, withoutName: true, people: [person('ME')] }), 'en', { anonymousKinds: ANONYMOUS_KINDS, occurredAt: '2026-11-03T08:00:00.000Z' })
    expect(body).toEqual({ kind: 'HAZARD', language: 'en', occurredAt: '2026-11-03T08:00:00.000Z', here: true, anonymous: true })
    expect(anonymousRefusal({ kind: body.kind, anonymous: true, via: 'FLOOR', queued: false, people: body.people ?? [] })).toBeNull()
  })

  it('a report with the name queues as safety.incident.report without its time (the envelope carries the tap’s)', () => {
    expect(QUEUED_KIND).toBe('safety.incident.report')
    expect(QUEUED_ACTIONS[QUEUED_KIND].permission).toBe('floor.work')
    const payload = queuedPayload(reportBody(draft({ kind: 'INJURY', where: { kind: 'here' } }), 'it', { occurredAt: '2026-11-03T08:00:00.000Z' }))
    expect(payload).toEqual({ kind: 'INJURY', language: 'it', here: true })
    expect(payload).not.toHaveProperty('anonymous')
    // The queue refuses a report without a name (its ledger names the tablet): the screen never queues one.
    expect(anonymousRefusal({ kind: 'HAZARD', anonymous: true, via: 'FLOOR', queued: true, people: [] })?.code).toBe('ANONYMOUS_NOT_QUEUED')
    expect(whatKeyOf(QUEUED_KIND)).toBe('incident')
  })
})

describe('people and photos', () => {
  it('me once, another worker from the tablet’s list (never me, never twice), someone from outside by name, twenty at most', () => {
    const facts = { meId: 'w-me', roster: 3 }
    expect(personHeld(draft(), 'ME', facts)).toBeNull()
    expect(personHeld(draft({ people: [person('ME', { workerId: 'w-me' })] }), 'ME', facts)).toBe('held.meAdded')
    expect(personHeld(draft(), 'WORKER', { meId: 'w-me', roster: 0 })).toBe('held.noRoster')
    expect(personHeld(draft({ people: Array.from({ length: INCIDENT_LIMITS.people }, (_, at) => person('OUTSIDE', { id: `o${at}` })) }), 'OUTSIDE', facts)).toBe('held.peopleFull')
    expect(workerHeld(draft(), 'w-me', 'w-me')).toBe('held.thatIsMe')
    expect(workerHeld(draft({ people: [person('WORKER', { workerId: 'w-2' })] }), 'w-2', 'w-me')).toBe('held.personAdded')
    expect(workerHeld(draft(), 'w-2', 'w-me')).toBeNull()
    expect(outsideHeld('  ')).toBe('held.outsideName')
    expect(outsideHeld('Autista Demo')).toBeNull()
  })

  it('a photo needs the network, four at most, within 30 minutes of the report', () => {
    const now = new Date('2026-11-03T09:00:00.000Z')
    expect(photoHeld({ online: false, count: 0 })).toBe('held.photoOffline')
    expect(photoHeld({ online: true, count: PHOTOS_MAX })).toBe('held.photosFull')
    expect(photoHeld({ online: true, count: 1, since: '2026-11-03T08:20:00.000Z', now })).toBe('held.photoWindow')
    expect(photoHeld({ online: true, count: 1, since: '2026-11-03T08:40:00.000Z', now })).toBeNull()
    expect(photoHeld({ online: true, count: 0, busy: true })).toBe('held.busy')
    expect(PHOTOS_MAX).toBe(INCIDENT_LIMITS.floorPhotos)
  })

  it('photos go up one at a time, in order, named by the report’s number (never a person)', () => {
    expect(nextUpload([{ id: '1', name: 'a', state: 'added' }, { id: '2', name: 'b', state: 'waiting' }, { id: '3', name: 'c', state: 'waiting' }])?.id).toBe('2')
    expect(nextUpload([{ id: '1', name: 'a', state: 'sending' }, { id: '2', name: 'b', state: 'waiting' }])).toBeNull()
    expect(photoName('INC-2026-0012', 2)).toBe('INC-2026-0012-photo-2.jpg')
    expect(photoName(null, 1)).toBe('incident-photo-1.jpg')
  })
})

describe('the call for help in one tap', () => {
  const type = (code: string, kind: string) => ({ id: `t-${code}`, kind, code, labelIt: code, labelEn: code, labelI18n: {}, icon: null, colour: null }) as HelpStation['tiles'][number]['type']
  const station = (types: HelpStation['tiles'][number]['type'][], open: HelpStation['tiles'][number]['open'] = null): HelpStation => ({
    station: { id: 's', code: 'SEW-02', name: 'Cucitura 2', line: null },
    tiles: types.map((entry, index) => ({ type: entry, open: index === 0 ? open : null })),
    open: [],
  })

  it('the station’s Safety call, else its team leader’s; none at a tablet without a station', () => {
    expect(helpCallOf(station([type('MATERIAL', 'MATERIAL'), type('TEAM_LEADER', 'SUPERVISOR'), type('SAFETY', 'OTHER')]))?.code).toBe('SAFETY')
    expect(helpCallOf(station([type('MATERIAL', 'MATERIAL'), type('TEAM_LEADER', 'SUPERVISOR')]))?.code).toBe('TEAM_LEADER')
    expect(helpCallOf(station([type('MATERIAL', 'MATERIAL')]))).toBeNull()
    expect(helpCallOf({ station: null, tiles: [] })).toBeNull()
    expect(helpCallOf(null)).toBeNull()
  })

  it('one tap sends; a call on this tablet or open at the station is shown, never a second one', () => {
    const safety = type('SAFETY', 'OTHER')
    expect(helpPress(station([safety]), safety, []).kind).toBe('send')
    expect(helpPress(station([safety]), safety, [{ clientEventId: 'e1', typeId: safety.id, at: '' }])).toEqual({ kind: 'queued', clientEventId: 'e1' })
  })
})

describe('the wiring', () => {
  it('the tile’s page, its catalogue, the offline move, the machine report’s hook, the handoff taken once', () => {
    expect(TASK_ROUTES.incident).toBe('/floor/incident')
    expect(FLOOR_PAGES).toContain('/floor/incident')
    expect(FLOOR_NAMESPACES).toContain('floor-incident')
    expect(INCIDENT_PAGE).toBe(TASK_ROUTES.incident)
    offerIncident({ machine: { id: 'm1', assetNumber: 'SEW-21' }, kind: 'HAZARD' })
    expect(takeIncidentOffer()).toEqual({ machine: { id: 'm1', assetNumber: 'SEW-21' }, kind: 'HAZARD' })
    expect(takeIncidentOffer()).toBeNull()
  })

  it('every refusal this screen knows is one of the API’s, with its words in both languages', async () => {
    const { INCIDENT_REFUSALS } = await import('@nexus/factory-domain/safety/incidents/rules')
    for (const code of KNOWN_REFUSALS) {
      expect(INCIDENT_REFUSALS, code).toContain(code)
      expect(isKnownRefusal(code)).toBe(true)
      for (const locale of LOCALES) expect(CATALOGUE[locale]['floor-incident']?.[`refusal.${code}`], `${locale} ${code}`).toBeTruthy()
    }
    expect(isKnownRefusal('CLIENT_ID_REUSED')).toBe(false)
  })
})
