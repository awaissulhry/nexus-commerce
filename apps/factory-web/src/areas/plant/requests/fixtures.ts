import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { RequestRecord } from '../_shared/api'
import { canAs, CARDS, inShell, MACHINES, OPEN_QUEUE, PREFIX, REQUEST_TILE_COUNTS, REQUESTS, SITES, SYMPTOM_LIST, TECHNICIANS, uid, type PlantRole } from '../_shared/fixtures'
import { STEP_UP_CLOSED } from '../_shared/parts'
import type { RequestDetailModel, RequestDialog, RequestsListModel } from './view-model'
import { RequestsView } from './view/RequestsView'

/**
 * SCR-148 — Machine requests (Plant › Maintenance) with made-up data only: the queue (unsafe first, then the oldest)
 * with its tiles and the banner of a machine locked as unsafe, each tile pressed, the request's detail (an unsafe one
 * waiting for its sign-safe; one with a possible duplicate and the "third failure in 30 days" hint; photos), Make a job
 * (a new job prefilled; added to the machine's open job), Close without a job, Merge, Sign safe with its fresh code, and
 * Report a problem (the machine, the symptom's icon, a photo or a note). Roles: the maintenance lead (everything, signs
 * safe), the production manager (triages, no sign-safe), the floor supervisor (triages, picks no technician), read-only
 * (held with reasons) and sales (no plant.view: the page says so).
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
      rows: { items: OPEN_QUEUE, truncated: false, more: false, problem: null },
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

const UNSAFE_RECORD: RequestRecord = { request: REQUESTS.unsafe, card: CARDS.sew2, duplicates: [], photos: [{ id: uid('7777', 1), originalName: 'carter.jpg', contentType: 'image/jpeg' }], canTriage: false, canSignSafe: true }
const THREAD_RECORD: RequestRecord = { request: REQUESTS.thread, card: CARDS.sew3, duplicates: [REQUESTS.threadAgain], photos: [], canTriage: true, canSignSafe: false }
const NOISE_RECORD: RequestRecord = { request: REQUESTS.noise, card: CARDS.heat, duplicates: [], photos: [], canTriage: true, canSignSafe: false }

/** A made-up photo (an inline drawing standing in for a file of the files API). */
const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#8a8f98"/><rect x="60" y="70" width="200" height="100" rx="12" fill="#c4c8ce"/><text x="160" y="128" font-size="20" text-anchor="middle" fill="#1f2328">foto</text></svg>')}`

const detail = (record: RequestRecord, over: Partial<RequestDetailModel> = {}): RequestDetailModel => ({
  id: record.request.id,
  loaded: { status: 'ready', value: record },
  photos: record.photos.map((photo) => ({ id: photo.id, name: photo.originalName, src: PHOTO })),
  lightbox: null,
  busy: false,
  problem: null,
  ...over,
})

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
    { id: 'tile-unsafe', label: 'Tile pressed: machines locked as unsafe', model: list('maintenance', { address: { view: 'open', tile: 'UNSAFE', siteId: null }, rows: { items: [REQUESTS.unsafe], truncated: false, more: false, problem: null } }) },
    { id: 'tile-duplicates', label: 'Tile pressed: possible duplicates', model: list('maintenance', { address: { view: 'open', tile: 'DUPLICATES', siteId: null }, rows: { items: [REQUESTS.thread, REQUESTS.threadAgain], truncated: false, more: false, problem: null } }) },
    { id: 'one-site', label: 'One site chosen (no Site column), and a closed request in "All"', model: list('maintenance', { address: { view: 'all', tile: null, siteId: SITES[0]!.id }, rows: { items: [...OPEN_QUEUE, REQUESTS.closed], truncated: false, more: true, problem: null } }) },
    { id: 'detail-unsafe', label: 'Detail: an unsafe request waiting for its sign-safe (photo, locked banner)', model: list('maintenance', { detail: detail(UNSAFE_RECORD) }), note: 'S signs it safe (a fresh code); close and merge are held while it is locked.' },
    { id: 'detail-photo', label: 'Detail: the photo full size (Lightbox)', model: list('maintenance', { detail: detail(UNSAFE_RECORD, { lightbox: 0 }) }) },
    { id: 'detail-duplicate', label: 'Detail: a request with a possible duplicate and the third-failure hint', model: list('maintenance', { detail: detail(THREAD_RECORD) }), note: 'D merges it into the other open request; M makes a job; J / K walk the queue.' },
    { id: 'detail-refused', label: 'Detail: a decision refused in words (changed by someone else)', model: list('maintenance', { detail: detail(NOISE_RECORD, { problem: { key: 'refusal.ALREADY_TRIAGED' } }) }) },
    { id: 'detail-loading', label: 'Detail: still reading', model: list('maintenance', { detail: { id: REQUESTS.noise.id, loaded: { status: 'loading' }, photos: [], lightbox: null, busy: false, problem: null } }) },
    { id: 'detail-error', label: "Detail: couldn't be read", model: list('maintenance', { detail: { id: REQUESTS.noise.id, loaded: { status: 'error', problem: 'problem.unavailable' }, photos: [], lightbox: null, busy: false, problem: null } }) },
    { id: 'make-job', label: 'Make a job: prefilled (P1, the line stopped), a technician and a due time', model: list('maintenance', { detail: detail(THREAD_RECORD), dialog: makeJob() }) },
    { id: 'make-job-join', label: 'Make a job: add it to the machine’s open job instead', model: list('maintenance', { detail: detail(NOISE_RECORD), dialog: makeJob({ openJob: { id: uid('6161', 4), number: 'MJ-D-0004' }, draft: { mode: 'join', type: 'CORRECTIVE', problem: 'Rumore', priority: 'P2', assignee: '', due: '', plan: false } }) }) },
    { id: 'make-job-supervisor', label: 'Make a job as the floor supervisor: no technician to pick (said why)', model: list('supervisor', { detail: detail(THREAD_RECORD), dialog: makeJob({ technicians: [], techniciansProblem: 'field.assigneeNoRight', draft: { mode: 'new', type: 'CORRECTIVE', problem: 'Il filo si rompe', priority: 'P1', assignee: '', due: '', plan: false } }) }) },
    { id: 'close', label: 'Close without a job: "Other" needs a note; keep the stopped machine down', model: list('maintenance', { detail: detail(THREAD_RECORD), dialog: { kind: 'close', draft: { reason: 'OTHER', note: '', keepDown: true }, machineDown: true, busy: false, problem: null } }) },
    { id: 'merge', label: 'Merge into the other open request of the machine', model: list('maintenance', { detail: detail(THREAD_RECORD), dialog: { kind: 'merge', into: REQUESTS.threadAgain, busy: false, problem: null } }) },
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
    { id: 'production', label: 'Production manager: triages, no sign-safe', model: list('production', { detail: detail(UNSAFE_RECORD, { loaded: { status: 'ready', value: { ...UNSAFE_RECORD, canSignSafe: false } } }) }) },
    { id: 'read-only', label: 'Read-only: sees the queue, every decision held with its reason', model: list('readOnly', { detail: detail(NOISE_RECORD, { loaded: { status: 'ready', value: { ...NOISE_RECORD, canTriage: false } } }) }) },
    { id: 'loading', label: 'Loading', model: list('maintenance', { rows: { items: null, truncated: false, more: false, problem: null }, tiles: null, asOf: null }) },
    { id: 'error', label: "The requests couldn't be read", model: list('maintenance', { rows: { items: null, truncated: false, more: false, problem: 'problem.unavailable' }, tiles: null }) },
    { id: 'empty', label: 'No open requests', model: list('maintenance', { rows: { items: [], truncated: false, more: false, problem: null }, tiles: { NEW: { count: 0, oldestMinutes: null }, UNSAFE: 0, DOWN: 0, WAITING: 0, DUPLICATES: 0 } }) },
    { id: 'no-match', label: 'Nothing matches the tile', model: list('maintenance', { address: { view: 'open', tile: 'WAITING', siteId: null }, rows: { items: [], truncated: false, more: false, problem: null } }) },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: list('maintenance', { helpOpen: true }) },
    { id: 'sales', label: 'Sales: no plant.view (the page says so)', model: list('sales') },
  ],
})
