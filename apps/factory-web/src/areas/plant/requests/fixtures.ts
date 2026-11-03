import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, canAs, card, CARDS, inShell, JOBS, MACHINES, PEOPLE, PREFIX, REQUEST_TILE_COUNTS, REQUESTS, SITES, SYMPTOM_LIST, TECHNICIANS, uid, type PlantRole } from '../_shared/fixtures'
import { STEP_UP_CLOSED } from '../_shared/parts'
import type { DeepRequestRecord, MachineLock } from './depth/api'
import { DEEP, DEEP_QUEUE, deep, deepRecord, media, PRESS_LOCK, trail, viewsOf } from './depth/fixtures'
import { groupOfRecord, mergeDraftOf, retarget, type MergeGroup } from './depth/model'
import type { RequestDetailModel, RequestDialog, RequestsListModel } from './view-model'
import { RequestsView } from './view/RequestsView'

/**
 * SCR-148 — Machine requests (Plant › Maintenance) with made-up data only: the queue (unsafe first, then the oldest)
 * with its tiles and the banner of a machine locked as unsafe, each tile pressed, the request's detail (an unsafe one
 * waiting for its sign-safe; one with a possible duplicate and the "third failure in 30 days" hint; photos), Make a job
 * (a new job prefilled; added to the machine's open job), Close without a job, Merge, Sign safe with its fresh code, and
 * Report a problem (the machine, the symptom's icon, a photo or a note). Roles: the maintenance lead (everything, signs
 * safe), the production manager (triages, no sign-safe), the floor supervisor (triages, picks no technician), read-only
 * (held with reasons) and sales (no plant.view: the page says so). B-W2b-140: the machines locked now (first on the page,
 * one banner each), the possible duplicates and Merge requests (into the request kept or the machine's open job), Lock as
 * unsafe, routing and escalation (the Age tone, Routed to), photos and voice notes, and what the requester sees.
 */

interface RequestsCase {
  role: PlantRole
  list: RequestsListModel
}

const sites = SITES.map((site) => ({ id: site.id, code: site.code, name: site.name }))

function list(role: PlantRole, over: Partial<RequestsListModel> = {}): RequestsCase {
  return {
    role,
    list: {
      prefix: PREFIX,
      can: canAs(role),
      address: { view: 'open', tile: null, siteId: null },
      sites,
      rows: { items: DEEP_QUEUE, truncated: false, more: false, problem: null },
      locks: { items: [LOCK_SEW, LOCK_PRESS], problem: null },
      duplicates: { items: [THREAD_GROUP], problem: null },
      tiles: REQUEST_TILE_COUNTS,
      asOf: '2026-10-30T09:42:00.000Z',
      live: 'live',
      updates: 0,
      timeZone: 'Europe/Rome',
      detail: null,
      dialog: null,
      stepUp: STEP_UP_CLOSED,
      notice: null,
      busy: false,
      ...over,
    },
  }
}

const UNSAFE_RECORD: DeepRequestRecord = deepRecord({ card: CARDS.sew2, duplicates: [], canTriage: false, canSignSafe: true }, DEEP.unsafe, {
  files: [media(1, 'PHOTO'), media(2, 'AUDIO', null, 16)],
  trail: trail(['REPORTED', at(30, 9, 12)], ['ROUTED', at(30, 9, 12)], ['ACKNOWLEDGED', at(30, 9, 14)], ['ON_THE_WAY', at(30, 9, 20)]),
  canLock: false,
})
const THREAD_RECORD: DeepRequestRecord = deepRecord({ card: CARDS.sew3, duplicates: [REQUESTS.threadAgain], canTriage: true, canSignSafe: false }, DEEP.thread, {
  trail: trail(['REPORTED', at(30, 8, 50)], ['ROUTED', at(30, 8, 50)], ['ESCALATED', at(30, 9, 0), 1], ['ESCALATED', at(30, 9, 20), 2]),
})
const NOISE_RECORD: DeepRequestRecord = deepRecord({ card: CARDS.heat, duplicates: [], canTriage: true, canSignSafe: false }, DEEP.noise, {
  trail: trail(['REPORTED', at(30, 9, 35)], ['ROUTED', at(30, 9, 35)], ['ACKNOWLEDGED', at(30, 9, 38)]),
})
/** A request whose job was handed back: the person who reported it confirms it works again. */
const FIXED_REQUEST = deep(REQUESTS.closed, {
  id: uid('5151', 31),
  machine: { id: MACHINES.sew1.id, assetNumber: MACHINES.sew1.assetNumber, status: 'RUNNING', class: MACHINES.sew1.class },
  symptom: REQUESTS.thread.symptom,
  status: 'JOB_MADE',
  closedAt: null,
  closedBy: null,
  closeReason: null,
  reportedBy: PEOPLE.me,
  acknowledgedAt: at(28, 11, 5),
  acknowledgedBy: PEOPLE.anna,
  job: { id: JOBS.closed.id, number: JOBS.closed.number, status: 'HANDED_BACK' },
  progress: { step: 'FIXED', acknowledgedAt: at(28, 11, 5), onTheWayAt: at(28, 11, 10), onTheWayBy: PEOPLE.anna, fixedAt: at(28, 14), worksAt: null, worksBy: null, closedWithoutJob: false, canConfirm: true },
})
const FIXED_RECORD: DeepRequestRecord = deepRecord({ card: card(MACHINES.sew1), duplicates: [], canTriage: false, canSignSafe: false }, FIXED_REQUEST, {
  trail: trail(['REPORTED', at(28, 11)], ['ROUTED', at(28, 11)], ['ACKNOWLEDGED', at(28, 11, 5)], ['ON_THE_WAY', at(28, 11, 10)], ['FIXED', at(28, 14)]),
  canGo: false,
  canConfirm: true,
})

const LOCK_SEW: MachineLock = { machine: MACHINES.sew2, request: DEEP.unsafe, canSignSafe: true }
const LOCK_PRESS: MachineLock = { machine: { ...MACHINES.press, status: 'DO_NOT_USE', locked: true }, request: PRESS_LOCK, canSignSafe: true }
const more = (n: number): MachineLock => ({ ...LOCK_PRESS, machine: { ...LOCK_PRESS.machine, id: uid('4141', 40 + n), assetNumber: `DEMO-CP-0${n}` }, request: { ...PRESS_LOCK, id: uid('5151', 40 + n) } })
const THREAD_GROUP: MergeGroup = groupOfRecord(THREAD_RECORD)!
const JOB_GROUP: MergeGroup = { ...THREAD_GROUP, openJob: { id: JOBS.thread.id, number: JOBS.thread.number }, suggested: { kind: 'JOB', id: JOBS.thread.id, number: JOBS.thread.number } }
/** The press's two requests: one still locks the machine (it joins a job but never another request). */
const LOCKED_GROUP: MergeGroup = { machine: PRESS_LOCK.machine, requests: [PRESS_LOCK, deep({ ...REQUESTS.oil, id: uid('5151', 22), machine: PRESS_LOCK.machine, reportedAt: at(30, 8, 20), ageMinutes: 82 })], openJob: null, withinMinutes: 15, suggested: { kind: 'REQUEST', id: PRESS_LOCK.id } }

const detail = (record: DeepRequestRecord, over: Partial<RequestDetailModel> = {}): RequestDetailModel => ({
  id: record.request.id,
  loaded: { status: 'ready', value: record },
  media: viewsOf(record.files),
  lightbox: null,
  busy: false,
  problem: null,
  ...over,
})

const merge = (group: MergeGroup, over: Partial<Extract<RequestDialog, { kind: 'mergeMany' }>> = {}): RequestDialog => ({ kind: 'mergeMany', group, draft: mergeDraftOf(group), busy: false, problem: null, ...over })

const makeJob = (over: Partial<Extract<RequestDialog, { kind: 'makeJob' }>> = {}): RequestDialog => ({
  kind: 'makeJob',
  draft: { mode: 'new', type: 'CORRECTIVE', problem: 'Il filo si rompe', priority: 'P1', assignee: `USER:${TECHNICIANS[1]!.id}`, due: '2026-10-30T14:00', plan: false },
  technicians: TECHNICIANS,
  floorListed: true,
  techniciansProblem: null,
  openJob: null,
  busy: false,
  problem: null,
  ...over,
})

const report = (over: Partial<Extract<RequestDialog, { kind: 'report' }>> = {}): RequestDialog => ({
  kind: 'report',
  draft: { query: '', machine: null, symptomId: null, description: '', unsafe: false, down: true, photo: null, photoStep: false },
  found: null,
  searching: false,
  symptoms: null,
  busy: false,
  problem: null,
  ...over,
})

function RequestsDesign({ model }: { model: RequestsCase }) {
  return inShell('/plant/requests', createElement(RequestsView, { model: model.list }), model.role)
}

const lockstitch = SYMPTOM_LIST.filter((entry) => entry.classId === null || entry.classId === MACHINES.sew3.class.id)

export const designScreen = defineDesignScreen<RequestsCase>({
  screen: 'SCR-148',
  title: 'Machine requests (breakdowns from the stations, triaged in order)',
  view: RequestsDesign,
  cases: [
    { id: 'maintenance', label: 'Maintenance lead: the queue, unsafe first, the locked-machine banner', model: list('maintenance'), note: 'Enter opens a request; t starts triage; r reports a problem.' },
    { id: 'tile-unsafe', label: 'Tile pressed: machines locked as unsafe', model: list('maintenance', { address: { view: 'open', tile: 'UNSAFE', siteId: null }, rows: { items: [DEEP.unsafe], truncated: false, more: false, problem: null } }) },
    { id: 'tile-duplicates', label: 'Tile pressed: possible duplicates', model: list('maintenance', { address: { view: 'open', tile: 'DUPLICATES', siteId: null }, rows: { items: [DEEP.thread, DEEP.threadAgain], truncated: false, more: false, problem: null } }) },
    { id: 'one-site', label: 'One site chosen (no Site column), and a closed request in "All"', model: list('maintenance', { address: { view: 'all', tile: null, siteId: SITES[0]!.id }, rows: { items: [...DEEP_QUEUE, DEEP.closed], truncated: false, more: true, problem: null } }) },
    { id: 'detail-unsafe', label: 'Detail: an unsafe request waiting for its sign-safe (photo, voice note, a technician on the way)', model: list('maintenance', { detail: detail(UNSAFE_RECORD) }), note: 'S signs it safe (a fresh code); close and merge are held while it is locked; L is held: the machine is locked already.' },
    { id: 'detail-photo', label: 'Detail: the photo full size (Lightbox)', model: list('maintenance', { detail: detail(UNSAFE_RECORD, { lightbox: 0 }) }) },
    { id: 'detail-duplicate', label: 'Detail: escalated twice (Routed to, the trail), a possible duplicate and the third-failure hint', model: list('maintenance', { detail: detail(THREAD_RECORD) }), note: 'D opens Merge requests; L locks the machine as unsafe; M makes a job; J / K walk the queue.' },
    { id: 'detail-fixed', label: 'Detail: what the requester sees — fixed, It works again offered', model: list('maintenance', { detail: detail(FIXED_RECORD) }), note: 'On my way is held: the job was handed back.' },
    { id: 'detail-media-unread', label: 'Detail: photos and voice notes without the files right (said)', model: list('production', { can: { ...canAs('production'), readFiles: false }, detail: detail(UNSAFE_RECORD, { media: viewsOf(UNSAFE_RECORD.files, false) }) }) },
    { id: 'detail-step-refused', label: 'Detail: On my way refused in words (said already)', model: list('maintenance', { detail: detail(NOISE_RECORD, { problem: { key: 'depthRefusal.ON_THE_WAY_ALREADY' } }) }) },
    { id: 'detail-refused', label: 'Detail: a decision refused in words (changed by someone else)', model: list('maintenance', { detail: detail(NOISE_RECORD, { problem: { key: 'refusal.ALREADY_TRIAGED' } }) }) },
    { id: 'detail-loading', label: 'Detail: still reading', model: list('maintenance', { detail: { id: REQUESTS.noise.id, loaded: { status: 'loading' }, media: [], lightbox: null, busy: false, problem: null } }) },
    { id: 'detail-error', label: "Detail: couldn't be read", model: list('maintenance', { detail: { id: REQUESTS.noise.id, loaded: { status: 'error', problem: 'problem.unavailable' }, media: [], lightbox: null, busy: false, problem: null } }) },
    { id: 'make-job', label: 'Make a job: prefilled (P1, the line stopped), a technician and a due time', model: list('maintenance', { detail: detail(THREAD_RECORD), dialog: makeJob() }) },
    { id: 'make-job-join', label: 'Make a job: add it to the machine’s open job instead', model: list('maintenance', { detail: detail(NOISE_RECORD), dialog: makeJob({ openJob: { id: uid('6161', 4), number: 'MJ-D-0004' }, draft: { mode: 'join', type: 'CORRECTIVE', problem: 'Rumore', priority: 'P2', assignee: '', due: '', plan: false } }) }) },
    { id: 'make-job-supervisor', label: 'Make a job as the floor supervisor: no technician to pick (said why)', model: list('supervisor', { detail: detail(THREAD_RECORD), dialog: makeJob({ technicians: [], techniciansProblem: 'field.assigneeNoRight', draft: { mode: 'new', type: 'CORRECTIVE', problem: 'Il filo si rompe', priority: 'P1', assignee: '', due: '', plan: false } }) }) },
    { id: 'close', label: 'Close without a job: "Other" needs a note; keep the stopped machine down', model: list('maintenance', { detail: detail(THREAD_RECORD), dialog: { kind: 'close', draft: { reason: 'OTHER', note: '', keepDown: true }, machineDown: true, busy: false, problem: null } }) },
    { id: 'merge', label: 'Merge requests: into the request kept (the oldest), every reporter kept', model: list('maintenance', { dialog: merge(THREAD_GROUP) }), note: 'From the duplicates panel or D in the detail; Merge 1.' },
    { id: 'merge-job', label: 'Merge requests: into the machine’s open job (suggested)', model: list('maintenance', { detail: detail(THREAD_RECORD), dialog: merge(JOB_GROUP) }) },
    { id: 'merge-locked', label: 'Merge requests: the locking request is kept; another request target holds it (H1)', model: list('maintenance', { dialog: merge(LOCKED_GROUP, { draft: retarget(LOCKED_GROUP, { target: `REQUEST:${LOCKED_GROUP.requests[1]!.id}`, picked: [] }) }) }), note: 'Merge is held: nothing may go into the newer request; pick the locking one or a job.' },
    { id: 'merge-refused', label: 'Merge requests refused in words (changed by someone else)', model: list('maintenance', { dialog: merge(THREAD_GROUP, { problem: { key: 'refusal.MERGE_TARGET_DONE' } }) }) },
    { id: 'lock', label: 'Lock as unsafe: the reach, the reversal and the law (Enter locks)', model: list('maintenance', { detail: detail(THREAD_RECORD), dialog: { kind: 'lock', note: 'Il carter vibra e si allenta.', busy: false, problem: null } }) },
    { id: 'lock-refused', label: 'Lock as unsafe refused in words (locked already by someone else)', model: list('maintenance', { detail: detail(THREAD_RECORD), dialog: { kind: 'lock', note: '', busy: false, problem: { key: 'depthRefusal.LOCKED_ALREADY' } } }) },
    { id: 'locks-many', label: 'Four machines locked: three banners, then "1 more · Show them"', model: list('maintenance', { locks: { items: [LOCK_SEW, LOCK_PRESS, more(2), more(3)], problem: null } }) },
    { id: 'locks-loading', label: 'Unsafe machines: still reading (never drawn as none)', model: list('maintenance', { locks: { items: null, problem: null }, duplicates: { items: null, problem: null } }) },
    { id: 'locks-error', label: "Unsafe machines and duplicates couldn't be read (Try again)", model: list('maintenance', { locks: { items: null, problem: 'problem.unavailable' }, duplicates: { items: null, problem: 'problem.unavailable' } }) },
    { id: 'dupes-job', label: 'Possible duplicates: the machine has an open job (suggested)', model: list('maintenance', { duplicates: { items: [JOB_GROUP, LOCKED_GROUP], problem: null } }) },
    { id: 'sign-safe', label: 'Sign safe: what was checked, the state after (H1)', model: list('maintenance', { detail: detail(UNSAFE_RECORD), dialog: { kind: 'signSafe', draft: { note: 'Carter rimontato e fissato; prova a vuoto ok.', machineAfter: null }, busy: false, problem: null } }) },
    { id: 'sign-safe-code', label: 'Sign safe: the fresh two-factor code', model: list('maintenance', { detail: detail(UNSAFE_RECORD), dialog: { kind: 'signSafe', draft: { note: 'Carter rimontato.', machineAfter: 'RUNNING' }, busy: true, problem: null }, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.signSafe', problem: null } }) },
    { id: 'report', label: 'Report a problem: find the machine first', model: list('maintenance', { dialog: report() }) },
    {
      id: 'report-symptom',
      label: 'Report a problem: machine found, symptom picked, a note',
      model: list('production', { dialog: report({ draft: { query: 'SEW-03', machine: MACHINES.sew3, symptomId: lockstitch[5]!.id, description: 'Si rompe ogni 2-3 capi.', unsafe: false, down: true, photo: null, photoStep: false }, found: [MACHINES.sew3], symptoms: lockstitch }) }),
    },
    {
      id: 'report-unsafe',
      label: 'Report a problem: an unsafe symptom marks the machine do-not-use at once',
      model: list('maintenance', { dialog: report({ draft: { query: 'SEW-03', machine: MACHINES.sew3, symptomId: lockstitch[3]!.id, description: '', unsafe: false, down: true, photo: null, photoStep: false }, found: [MACHINES.sew3], symptoms: lockstitch }) }),
    },
    { id: 'report-photo', label: 'Report a problem: the photo step (camera or a file)', model: list('maintenance', { dialog: report({ draft: { query: 'SEW-03', machine: MACHINES.sew3, symptomId: null, description: 'Vedi foto', unsafe: false, down: false, photo: null, photoStep: true }, found: [MACHINES.sew3], symptoms: lockstitch }) }) },
    { id: 'selected', label: 'Two requests selected: Acknowledge 2, Export 2 (CSV)', model: list('maintenance', { selected: [REQUESTS.thread.id, REQUESTS.oil.id] }) },
    { id: 'notice', label: 'Receipt after a decision (the next request opens by itself)', model: list('maintenance', { notice: { tone: 'success', words: { key: 'done.jobMade', params: { number: 'MJ-D-0007' } } } }) },
    { id: 'updates', label: 'Two new requests waiting behind "2 new · Show"', model: list('maintenance', { updates: 2 }) },
    { id: 'offline', label: 'Live updates paused: last known list with its time', model: list('maintenance', { live: 'offline' }) },
    { id: 'production', label: 'Production manager: triages, no sign-safe', model: list('production', { detail: detail({ ...UNSAFE_RECORD, canSignSafe: false }) }) },
    { id: 'read-only', label: 'Read-only: sees the queue, every decision held with its reason', model: list('readOnly', { detail: detail({ ...NOISE_RECORD, canTriage: false, canGo: false, canLock: false }) }), note: 'Merge, Lock as unsafe, On my way and It works are held with their reasons.' },
    { id: 'loading', label: 'Loading', model: list('maintenance', { rows: { items: null, truncated: false, more: false, problem: null }, tiles: null, asOf: null }) },
    { id: 'error', label: "The requests couldn't be read", model: list('maintenance', { rows: { items: null, truncated: false, more: false, problem: 'problem.unavailable' }, tiles: null }) },
    { id: 'empty', label: 'No open requests', model: list('maintenance', { rows: { items: [], truncated: false, more: false, problem: null }, tiles: { NEW: { count: 0, oldestMinutes: null }, UNSAFE: 0, DOWN: 0, WAITING: 0, DUPLICATES: 0 }, locks: { items: [], problem: null }, duplicates: { items: [], problem: null } }) },
    { id: 'no-match', label: 'Nothing matches the tile', model: list('maintenance', { address: { view: 'open', tile: 'WAITING', siteId: null }, rows: { items: [], truncated: false, more: false, problem: null } }) },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: list('maintenance', { helpOpen: true }) },
    { id: 'sales', label: 'Sales: no plant.view (the page says so)', model: list('sales') },
  ],
})
