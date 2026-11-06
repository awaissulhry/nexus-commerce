import { ANONYMOUS_KINDS } from '@nexus/factory-domain/safety/incidents/rules'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_OPERATOR, onFloor, signedInFrame } from '../../frame/fixtures'
import { EMERGENCY, EMPTY_DRAFT, whereTiles, type IncidentDraft, type PersonDraft, type PhotoUpload, type WherePick } from './model'
import type { EmergencyModel } from './view/IncidentParts'
import { IncidentView, type IncidentStep, type IncidentViewModel, type SentReport } from './view/IncidentView'

/**
 * SCR-230's cases (B-W2b-137; design floor.incident, QHS-265): someone hurt first (112, the site's first aiders, the call for help
 * in one tap — sent, open, on the way —, none on record, offline from the tablet's memory, offline before any read), What
 * happened? (a kind picked, a hazard passed on by the machine report), Where? ("Here: this station" first, this station's
 * machines, the site's areas, somewhere else in words, a tablet with no station, offline), Photo and people (a hazard, without
 * the name online and offline, an incident with its people, the name picker, someone from outside, a photo taken, the camera,
 * a photo held offline, words, a refusal, no permission, sending), Not sent yet (a report without a name with no network, the
 * office not answering), Sent (saved on this tablet, sending, recorded with its number, seen by safety, without a name, an
 * incident with the emergency again, a photo refused after the window, closed, refused by the office, the camera again).
 * Roles: an operator at a station, a team leader on a line tablet (no station), a person the API refuses. Made-up places and
 * people of a made-up "Demo" plant: no money, no injury detail.
 */

const AT = '2026-11-03T08:41:00.000Z'
const SEW = { code: 'SEW-02', name: 'Cucitura 2' }
const frame = (extra: Partial<IncidentViewModel['frame']> = {}) => signedInFrame('tile.incident', { station: { name: 'SEW-02 · Cucitura 2', site: 'Stabilimento Demo Nord' }, ...extra })
const ME = { id: 'worker-ada', name: DEMO_OPERATOR }
const ROSTER = [ME, { id: 'worker-paolo', name: 'Paolo Demo' }, { id: 'worker-sara', name: 'Sara Demo' }, { id: 'worker-bruno', name: 'Bruno Demo' }, { id: 'worker-irene', name: 'Irene Demo' }]
const MACHINES = [
  { id: 'machine-sew-21', assetNumber: 'DEMO-SEW-21' },
  { id: 'machine-sew-22', assetNumber: 'DEMO-SEW-22' },
]
const AREAS = [
  { id: 'area-cut', code: 'TAG', name: 'Taglio' },
  { id: 'area-sew', code: 'CUC', name: 'Cucitura' },
  { id: 'area-wh', code: 'MAG', name: 'Magazzino' },
  { id: 'area-yard', code: 'CORTILE', name: 'Cortile e carico' },
]
const WHERE = whereTiles({ station: SEW, machines: MACHINES, areas: AREAS })
const WHERE_FROM_MACHINE = whereTiles({ station: SEW, machines: MACHINES, areas: AREAS, offered: { id: 'machine-sew-07', assetNumber: 'DEMO-SEW-07' } })
const WHERE_NO_STATION = whereTiles({ station: null, machines: [], areas: AREAS })
const WHERE_OFFLINE = whereTiles({ station: SEW, machines: [], areas: [] })
const HERE: WherePick = { kind: 'here' }

const emergency = (extra: Partial<EmergencyModel> = {}): EmergencyModel => ({
  number: EMERGENCY,
  firstAiders: [
    { name: 'Marta Demo', shift: 'Turno A' },
    { name: 'Luca Demo', shift: 'Turno B' },
    { name: 'Gino Demo', shift: null },
  ],
  help: { kind: 'send', label: 'Sicurezza' },
  ...extra,
})

const draft = (extra: Partial<IncidentDraft> = {}): IncidentDraft => ({ ...EMPTY_DRAFT, ...extra })
const person = (who: PersonDraft['who'], name: string, extra: Partial<PersonDraft> = {}): PersonDraft => ({ id: `person-${name.toLowerCase().replace(/\W+/g, '-')}`, who, name, involvement: 'INJURED', ...extra })
const photo = (index: number) => ({ id: `photo-${index}`, blob: new Blob([], { type: 'image/jpeg' }), name: `incident-photo-${index}.jpg` })

type ReportStep = Extract<IncidentStep, { kind: 'report' }>
const report = (stage: ReportStep['stage'], body: IncidentDraft, extra: Partial<ReportStep> = {}): IncidentStep => ({ kind: 'report', stage, draft: body, where: WHERE, station: SEW, anonymousKinds: ANONYMOUS_KINDS, me: ME, roster: ROSTER, ...extra })

const model = (step: IncidentStep, extra: Partial<IncidentViewModel> = {}): IncidentViewModel => ({
  frame: frame(extra.online === false ? { online: false, pending: 1 } : {}),
  online: true,
  step,
  emergency: emergency(),
  ...extra,
})

const upload = (index: number, state: PhotoUpload['state'], refusal: string | null = null): PhotoUpload => ({ id: `photo-${index}`, name: `INC-2026-0012-photo-${index}.jpg`, state, refusal })
const sent = (extra: Partial<SentReport> = {}): IncidentStep => ({
  kind: 'sent',
  report: { kind: 'HAZARD', anonymous: false, ticks: 'recorded', refusal: null, number: 'INC-2026-0012', seenAt: null, uploads: [], photoHeld: null, where: HERE, ...extra },
})

const HAZARD_HERE = draft({ kind: 'HAZARD', where: HERE })
const INJURY_HERE = draft({ kind: 'INJURY', where: HERE })
const PEOPLE = [person('ME', DEMO_OPERATOR, { workerId: ME.id }), person('WORKER', 'Paolo Demo', { workerId: 'worker-paolo', involvement: 'INVOLVED' }), person('OUTSIDE', 'Autista Demo')]

export const designScreen = defineDesignScreen<IncidentViewModel>({
  screen: 'SCR-230',
  title: 'Floor › Report an incident',
  view: onFloor(IncidentView),
  cases: [
    // ---- someone hurt first; What happened? ------------------------------------------------------------------------------------
    { id: 'what', label: 'What happened? The emergency first: 112, the first aiders, the call for help in one tap', model: model(report('what', draft())), note: 'Three taps on the usual path: Hazard → Here → Send. A tap on a tile moves on; arrows only move the pick.' },
    { id: 'what-picked', label: 'A kind picked (Next, for the keyboard)', model: model(report('what', draft({ kind: 'NEAR_MISS' }))) },
    { id: 'what-from-machine', label: 'From the machine report (Guard missing): a hazard picked for the person', model: model(report('what', draft({ kind: 'HAZARD', where: { kind: 'machine', id: 'machine-sew-07', assetNumber: 'DEMO-SEW-07', here: false } }), { where: WHERE_FROM_MACHINE })) },
    { id: 'what-help-called', label: 'The call for help saved on this tablet: its ticks', model: model(report('what', draft()), { emergency: emergency({ help: { kind: 'queued', label: 'Sicurezza', ticks: 'sending', refusal: null } }) }) },
    { id: 'what-help-coming', label: 'The station’s Safety call: someone on the way', model: model(report('what', draft()), { emergency: emergency({ help: { kind: 'open', label: 'Sicurezza', status: 'ON_THE_WAY' } }) }) },
    { id: 'what-help-lead', label: 'No Safety call at this station: the team leader’s call', model: model(report('what', draft()), { emergency: emergency({ help: { kind: 'send', label: 'Capo squadra' } }) }) },
    { id: 'what-help-page', label: 'No call type to send in one tap: Call for help opens', model: model(report('what', draft()), { emergency: emergency({ help: { kind: 'page' } }) }) },
    { id: 'what-no-aiders', label: 'No first aider on record for this site', model: model(report('what', draft()), { emergency: emergency({ firstAiders: [] }) }) },
    { id: 'what-offline', label: 'Offline: the first aiders from this tablet’s memory, the report saves on the tablet', model: model(report('what', draft()), { online: false, emergency: emergency({ asOf: AT }) }) },
    { id: 'what-offline-cold', label: 'Offline before any read: 112 still first, the first aiders unknown', model: model(report('what', draft()), { online: false, emergency: emergency({ firstAiders: null, help: { kind: 'page' } }) }) },

    // ---- Where? ---------------------------------------------------------------------------------------------------------------
    { id: 'where', label: 'Where? "Here: this station" first, its machines, the site’s areas, somewhere else', model: model(report('where', draft({ kind: 'HAZARD' }))) },
    { id: 'where-picked', label: 'Here picked (Next, for the keyboard)', model: model(report('where', HAZARD_HERE)) },
    { id: 'where-injury', label: 'An incident: the emergency line says call 112 first', model: model(report('where', draft({ kind: 'INJURY' }))) },
    { id: 'where-from-machine', label: 'The machine report’s machine, picked', model: model(report('where', draft({ kind: 'HAZARD', where: { kind: 'machine', id: 'machine-sew-07', assetNumber: 'DEMO-SEW-07', here: false } }), { where: WHERE_FROM_MACHINE })) },
    { id: 'where-elsewhere', label: 'Somewhere else: a few words (Next held until then)', model: model(report('where', draft({ kind: 'NEAR_MISS', where: { kind: 'elsewhere' } }))) },
    { id: 'where-no-station', label: 'A team leader’s line tablet (no station): areas and somewhere else', model: model(report('where', draft({ kind: 'HAZARD' }), { where: WHERE_NO_STATION, station: null }), { frame: signedInFrame('tile.incident', { station: { name: null, site: 'Stabilimento Demo Nord' } }) }) },
    { id: 'where-offline', label: 'Offline, never read: here and somewhere else still work', model: model(report('where', draft({ kind: 'HAZARD' }), { where: WHERE_OFFLINE, asOf: null }), { online: false, emergency: emergency({ firstAiders: null, help: { kind: 'page' } }) }) },
    { id: 'where-offline-kept', label: 'Offline: areas and machines from this tablet’s memory, with the time', model: model(report('where', draft({ kind: 'HAZARD' }), { asOf: AT }), { online: false, emergency: emergency({ asOf: AT }) }) },

    // ---- Photo and people (optional); Send ----------------------------------------------------------------------------------
    { id: 'details', label: 'A hazard here: photo, words and the name switch; Send', model: model(report('details', HAZARD_HERE)) },
    { id: 'details-without-name', label: 'Without my name: "Your name is not stored with this report"', model: model(report('details', { ...HAZARD_HERE, withoutName: true })) },
    { id: 'details-without-name-offline', label: 'Without my name, offline: it waits on this screen, never on the tablet', model: model(report('details', { ...HAZARD_HERE, withoutName: true }), { online: false }) },
    { id: 'details-injury', label: 'An incident: the people (me hurt, a worker there, someone from outside); no anonymous switch', model: model(report('details', { ...INJURY_HERE, people: PEOPLE })) },
    { id: 'details-injury-empty', label: 'An incident with nobody named yet', model: model(report('details', INJURY_HERE)) },
    { id: 'details-pick-worker', label: 'Another worker: their name from this tablet’s list', model: model(report('details', { ...INJURY_HERE, people: [PEOPLE[0]!] }, { open: 'worker' })) },
    { id: 'details-no-roster', label: 'A tablet with no list of names: Another worker held with the reason', model: model(report('details', INJURY_HERE, { roster: [ME] })) },
    { id: 'details-outside', label: 'Someone from outside: their name (Add held while empty)', model: model(report('details', INJURY_HERE, { open: 'outside', outsideName: '' })) },
    { id: 'details-photo', label: 'A photo taken (no faces); it goes up once the office has the report', model: model(report('details', { ...HAZARD_HERE, photos: [photo(1)] })) },
    { id: 'details-camera', label: 'The camera: keep faces out, mark the spot (DS PhotoCapture)', model: model(report('details', HAZARD_HERE, { open: 'photo' })) },
    { id: 'details-photo-offline', label: 'Offline: the photo held with the reason, the report still saves', model: model(report('details', HAZARD_HERE), { online: false }) },
    { id: 'details-photos-full', label: 'Four photos: Add held', model: model(report('details', { ...HAZARD_HERE, photos: [photo(1), photo(2), photo(3), photo(4)] })) },
    { id: 'details-words', label: 'A few words, open', model: model(report('details', { ...HAZARD_HERE, wordsOpen: true, words: 'Cavo a terra davanti alla macchina.' })) },
    { id: 'details-elsewhere', label: 'Somewhere else, said in words', model: model(report('details', draft({ kind: 'NEAR_MISS', where: { kind: 'elsewhere' }, place: 'Porta del cortile' }))) },
    { id: 'details-refused', label: 'The office refused it: the reason in our words', model: model(report('details', HAZARD_HERE, { problem: { kind: 'refused', code: 'WHERE_OTHER_SITE', message: 'The area, station or machine is one of this site’s.', fix: null } })) },
    { id: 'details-no-permission', label: 'A person the API does not let report from this tablet', model: model(report('details', HAZARD_HERE, { problem: { kind: 'forbidden', path: null, message: null } })) },
    { id: 'details-sending', label: 'Sending without the name: Send held', model: model(report('details', { ...HAZARD_HERE, withoutName: true }, { busy: true })) },

    // ---- Not sent yet (without a name) ------------------------------------------------------------------------------------------
    { id: 'waiting-offline', label: 'Without a name, no network: it waits on this screen; or send with my name', model: model({ kind: 'held', draft: { ...HAZARD_HERE, withoutName: true }, why: 'offline' }, { online: false }) },
    { id: 'waiting-unavailable', label: 'Without a name, the office does not answer: it tries again by itself', model: model({ kind: 'held', draft: { ...HAZARD_HERE, withoutName: true }, why: 'unavailable' }) },
    { id: 'waiting-sending', label: 'Trying again', model: model({ kind: 'held', draft: { ...HAZARD_HERE, withoutName: true }, why: 'unavailable', busy: true }) },

    // ---- Sent -----------------------------------------------------------------------------------------------------------------
    { id: 'sent-saved', label: 'Saved on this tablet (no network): one tick, nothing lost', model: model(sent({ ticks: 'saved', number: null, uploads: [upload(1, 'waiting')], photoHeld: 'held.photoOffline' }), { online: false }) },
    { id: 'sent-sending', label: 'Sending to the office', model: model(sent({ ticks: 'sending', number: null })) },
    { id: 'sent', label: 'Recorded: the number; not seen yet; a photo going up', model: model(sent({ uploads: [upload(1, 'added'), upload(2, 'sending')] })) },
    { id: 'sent-seen', label: '"Seen by safety at 10:45"', model: model(sent({ seenAt: '2026-11-03T09:45:00.000Z', uploads: [upload(1, 'added')] })) },
    { id: 'sent-anonymous', label: 'Sent without a name: "Your name is not stored with this report"', model: model(sent({ anonymous: true })) },
    { id: 'sent-injury', label: 'An incident sent: the emergency again (112, first aiders, the call for help)', model: model(sent({ kind: 'INJURY' })) },
    { id: 'sent-photo-window', label: 'A photo after 30 minutes: refused in our words, Add held', model: model(sent({ uploads: [upload(1, 'failed', 'PHOTO_WINDOW')], photoHeld: 'held.photoWindow' })) },
    { id: 'sent-closed', label: 'Seen and closed by safety', model: model(sent({ seenAt: '2026-11-03T09:45:00.000Z', closed: true })) },
    { id: 'sent-refused', label: 'Refused by the office (the queue’s answer), the photos dropped', model: model(sent({ ticks: 'refused', number: null, refusal: { code: 'WHERE_MISSING', message: 'Say where it happened.' }, uploads: [upload(1, 'waiting')] })) },
    { id: 'sent-camera', label: 'Another photo after sending (within 30 minutes)', model: model({ ...(sent() as Extract<IncidentStep, { kind: 'sent' }>), capture: true }) },
  ],
})
