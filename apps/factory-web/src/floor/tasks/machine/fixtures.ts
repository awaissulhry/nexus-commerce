import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { FloorJob, FloorRequest, FloorRequestRecord, JobRecord, QueueEntry, RequestProgress, StationMachine, StoredMedia, Symptom } from './api'
import { closeDraftOf, type TakenMedia } from './depth'
import { EMPTY_DRAFT, machineCan, type MachineCan } from './model'
import { MachineView, type MachineViewModel } from './view/MachineView'

/**
 * SCR-179's cases (B-W2a-73; design floor.machine): the machine problem from the station and the technician's job, at
 * tablet width, with every state the design names — which machine (the station's machines, a locked one in the banner,
 * the station blocked, a tag that opens nothing, offline from the tablet's memory, a tablet without a station, a role
 * that may not report), what is wrong (a symptom picked, an unsafe one that locks at once, "Other" asking for words,
 * offline: queued), sent (saved on the tablet, recorded with the machine's new state, unsafe, refused), My jobs (a list,
 * none), the job (new, in progress with the unsafe request to sign safe, another technician's, offline), hand back (running
 * held while locked), sign safe (what was checked, the PIN, a wrong PIN, a refusal) — and the roles: an operator, a
 * technician, a worker without plant.report. Made-up machines, symptoms and jobs of a made-up "Demo" plant: no money, no
 * person's name.
 *
 * B-W2b-102 (QHS-189, QHS-180, QHS-190): a photo and a voice note with the report (taken, held offline, the camera, the
 * recorder, going up after the report, one failed), Guard missing offering Report an incident (B-W2b-137: it opens SCR-230), the
 * station's reports under way (and the list changed behind Show), one report's progress (reported, seen, on the way,
 * fixed: It works, locked, works again, joined, closed, escalated, kept offline, refused, the line lead, the technician's
 * Seen / On my way, a photo opened, adding one), the technician's queue above My jobs, the job's photos and voice notes,
 * the line lead on the job, and the one-screen close (empty, ready, Other without words, not started, a photo, going up).
 */

const SEW = 'SEW-02 · Cucitura 2'
const frame = (extra: Partial<MachineViewModel['frame']> = {}) => signedInFrame('tile.machine', { station: { name: SEW, site: 'Stabilimento Demo Nord' }, ...extra })
const AT = '2026-10-31T08:41:00.000Z'
const place = (code: string, name: string) => ({ id: `place-${code.toLowerCase()}`, code, name })
const STATION = place('SEW-02', 'Cucitura 2')
const LINE = place('L1', 'Linea 1')

const lockstitch = { id: 'class-lockstitch', code: 'LOCKSTITCH', labelIt: 'Lineare', labelEn: 'Lockstitch', labelI18n: {}, icon: 'needle' }
const postBed = { id: 'class-post-bed', code: 'POST_BED', labelIt: 'Colonna', labelEn: 'Post-bed', labelI18n: {}, icon: 'needle' }

const symptom = (code: string, labelIt: string, labelEn: string, icon: string | null, extra: Partial<Symptom> = {}): Symptom => ({
  id: `symptom-${code.toLowerCase()}`,
  code,
  labelIt,
  labelEn,
  labelI18n: {},
  icon,
  classId: null,
  colour: null,
  unsafe: false,
  needsDetail: false,
  active: true,
  ...extra,
})

const SYMPTOMS: Symptom[] = [
  symptom('WONT_START', 'Non parte', "Won't start", 'power'),
  symptom('THREAD_BREAKS', 'Il filo si rompe', 'Thread breaks', 'scissors', { classId: lockstitch.id }),
  symptom('SKIPPED_STITCHES', 'Salta i punti', 'Skipped stitches', 'needle', { classId: lockstitch.id }),
  symptom('OIL_LEAK', 'Perdita d’olio', 'Oil leak', 'droplet'),
  symptom('NOISE', 'Rumore', 'Noise', 'volume'),
  symptom('GUARD_MISSING', 'Protezione mancante', 'Guard missing', 'shield-off', { unsafe: true }),
  symptom('ELECTRICAL_FAULT', 'Guasto elettrico', 'Electrical fault', 'zap', { unsafe: true }),
  symptom('OTHER', 'Altro', 'Other', null, { needsDetail: true }),
]

const machine = (assetNumber: string, extra: Partial<StationMachine> = {}): StationMachine => ({
  id: `machine-${assetNumber.toLowerCase()}`,
  siteId: 'site-demo',
  assetNumber,
  class: lockstitch,
  make: 'Demotex',
  modelName: 'DT-8700',
  station: STATION,
  line: LINE,
  workCentre: place('SEW', 'Cucitura'),
  status: 'RUNNING',
  statusSince: '2026-10-20T07:00:00.000Z',
  locked: false,
  openRequests: 0,
  openJobs: 0,
  version: 3,
  symptoms: SYMPTOMS,
  ...extra,
})

const SEW_A = machine('DEMO-SEW-21')
const SEW_B = machine('DEMO-SEW-22', { class: postBed, make: 'Demotex', modelName: 'PB-500', symptoms: SYMPTOMS.filter((entry) => entry.classId === null) })
const LOCKED = machine('DEMO-SEW-22', { class: postBed, status: 'DO_NOT_USE', locked: true, openRequests: 1, openJobs: 1, symptoms: SYMPTOMS.filter((entry) => entry.classId === null) })
const DOWN = machine('DEMO-SEW-21', { status: 'DOWN', openRequests: 1 })

const OPERATOR: MachineCan = machineCan(['floor.work', 'plant.report'])
const TECHNICIAN: MachineCan = machineCan(['floor.work', 'plant.report', 'plant.jobs.work', 'plant.signSafe'])
const NO_REPORT: MachineCan = machineCan(['floor.work', 'production.scan'])

const base = (step: MachineViewModel['step'], can: MachineCan = OPERATOR, extra: Partial<MachineViewModel> = {}): MachineViewModel => ({ frame: frame(), can, online: true, step, ...extra })
const offline = (step: MachineViewModel['step'], can: MachineCan = OPERATOR): MachineViewModel => ({ frame: frame({ online: false, pending: 1 }), can, online: false, step })

const which = (extra: Partial<Extract<MachineViewModel['step'], { kind: 'which' }>> = {}) => ({ kind: 'which' as const, station: STATION, machines: [SEW_A, SEW_B], blocked: false, ...extra })

// ---- the technician's job -------------------------------------------------------------------------------------------------

const progress = (extra: Partial<RequestProgress> = {}): RequestProgress => ({ step: 'REPORTED', acknowledgedAt: null, onTheWayAt: null, fixedAt: null, worksAt: null, closedWithoutJob: false, canConfirm: false, ...extra })

const request = (extra: Partial<FloorRequest> = {}): FloorRequest => ({
  id: 'request-demo-1',
  machine: { id: LOCKED.id, assetNumber: LOCKED.assetNumber, status: 'DO_NOT_USE', class: postBed },
  symptom: SYMPTOMS[5]!,
  description: 'Il carter del volantino è caduto.',
  unsafe: true,
  reportedAt: '2026-10-31T07:58:00.000Z',
  ageMinutes: 43,
  reportedBy: { kind: 'WORKER' },
  station: STATION,
  status: 'JOB_MADE',
  job: { id: 'job-demo-41', number: 'MJ-DEMO-0041', status: 'IN_PROGRESS' },
  signedSafe: null,
  locking: true,
  photos: 2,
  voiceNotes: 1,
  progress: progress({ step: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-31T08:02:00.000Z' }),
  routing: { routedTo: { kind: 'TEAM' }, escalationLevel: 0 },
  version: 2,
  ...extra,
})

const job = (extra: Partial<FloorJob> = {}): FloorJob => ({
  id: 'job-demo-41',
  number: 'MJ-DEMO-0041',
  machine: { id: LOCKED.id, assetNumber: LOCKED.assetNumber, status: 'DO_NOT_USE', locked: true, class: postBed, station: STATION, line: LINE },
  type: 'SAFETY',
  problem: 'Guard missing: the hand-wheel cover fell off.',
  symptom: SYMPTOMS[5]!,
  priority: 'P1',
  ownership: 'MINE',
  dueAt: '2026-10-31T10:00:00.000Z',
  overdue: false,
  status: 'IN_PROGRESS',
  startedAt: '2026-10-31T08:20:00.000Z',
  handedBack: null,
  leadConfirmed: null,
  requestIds: ['request-demo-1'],
  ageMinutes: 43,
  open: true,
  createdAt: '2026-10-31T07:58:00.000Z',
  version: 4,
  ...extra,
})

const PHOTO: StoredMedia = { id: 'file-demo-photo', kind: 'PHOTO', category: null, originalName: 'DEMO-SEW-22-photo-1.jpg', contentType: 'image/jpeg', availableAt: '2026-10-31T07:59:00.000Z' }
const VOICE: StoredMedia = { id: 'file-demo-voice', kind: 'AUDIO', category: null, originalName: 'DEMO-SEW-22-voice-2.webm', contentType: 'audio/webm', availableAt: '2026-10-31T08:00:00.000Z' }
const BEFORE: StoredMedia = { id: 'file-demo-before', kind: 'PHOTO', category: 'BEFORE_WORK', originalName: 'MJ-DEMO-0041-photo-1.jpg', contentType: 'image/jpeg', availableAt: '2026-10-31T08:22:00.000Z' }

const record = (jobExtra: Partial<FloorJob> = {}, requests: FloorRequest[] = [request()]): JobRecord => ({
  job: job(jobExtra),
  card: {
    machine: LOCKED,
    openJob: { id: 'job-demo-41', number: 'MJ-DEMO-0041', status: 'IN_PROGRESS' },
    lastJobs: [
      { id: 'job-demo-41', number: 'MJ-DEMO-0041', type: 'SAFETY', status: 'IN_PROGRESS', problem: 'Guard missing: the hand-wheel cover fell off.', createdAt: '2026-10-31T07:58:00.000Z', closedAt: null },
      { id: 'job-demo-33', number: 'MJ-DEMO-0033', type: 'CORRECTIVE', status: 'CLOSED', problem: 'Thread breaks: tension spring replaced.', createdAt: '2026-10-18T13:10:00.000Z', closedAt: '2026-10-18T15:02:00.000Z' },
      { id: 'job-demo-21', number: 'MJ-DEMO-0021', type: 'PREVENTIVE', status: 'CLOSED', problem: 'Oiling and belt check.', createdAt: '2026-09-30T06:30:00.000Z', closedAt: '2026-09-30T07:15:00.000Z' },
    ],
    requestsIn30Days: 3,
    repeatFailure: true,
  },
  requests,
  canWork: true,
  files: [],
  requestFiles: [{ ...PHOTO, requestId: 'request-demo-1' }, { ...VOICE, requestId: 'request-demo-1' }],
  close: { minutesSoFar: 21, runningHeld: true, canHandBack: true },
  canConfirm: false,
})

const JOBS: FloorJob[] = [
  job(),
  job({ id: 'job-demo-44', number: 'MJ-DEMO-0044', machine: { id: DOWN.id, assetNumber: DOWN.assetNumber, status: 'DOWN', locked: false, class: lockstitch, station: STATION, line: LINE }, type: 'CORRECTIVE', problem: 'Thread breaks', symptom: SYMPTOMS[1]!, priority: 'P1', status: 'NEW', ownership: 'NOBODY', startedAt: null, ageMinutes: 12 }),
  job({ id: 'job-demo-45', number: 'MJ-DEMO-0045', machine: { id: 'machine-demo-cut-03', assetNumber: 'DEMO-CUT-03', status: 'RUNNING', locked: false, class: { id: 'class-cutting', code: 'CUTTING_TABLE', labelIt: 'Tavolo di taglio', labelEn: 'Cutting table', labelI18n: {}, icon: 'scissors' }, station: place('CUT-01', 'Taglio 1'), line: null }, type: 'CORRECTIVE', problem: 'Noise', symptom: SYMPTOMS[4]!, priority: 'P3', status: 'WAITING_PARTS', ageMinutes: 1570 }),
]

/** The machine signed safe and worked on: running may be picked; 42 minutes since Start. */
const UNLOCKED: JobRecord = { ...record({ machine: { ...job().machine, status: 'UNDER_MAINTENANCE', locked: false } }, [request({ locking: false, signedSafe: { at: AT } })]), close: { minutesSoFar: 42, runningHeld: false, canHandBack: true } }

const LEAD: MachineCan = machineCan(['floor.work', 'plant.report', 'floor.lead'])

// ---- B-W2b-102: photos and voice notes taken with the report (made-up bytes) -------------------------------------------------
const taken = (kind: TakenMedia['kind'], index: number): TakenMedia => ({ id: `taken-${index}`, kind, blob: new Blob([], { type: kind === 'PHOTO' ? 'image/jpeg' : 'audio/webm' }), name: `DEMO-SEW-21-${kind === 'PHOTO' ? 'photo' : 'voice'}-${index}.${kind === 'PHOTO' ? 'jpg' : 'webm'}` })

// ---- B-W2b-102: the station's reports and one report's progress -------------------------------------------------------------
const FIXED = request({
  id: 'request-demo-2',
  machine: { id: SEW_A.id, assetNumber: SEW_A.assetNumber, status: 'RUNNING', class: lockstitch },
  symptom: SYMPTOMS[1]!,
  description: null,
  unsafe: false,
  locking: false,
  status: 'JOB_MADE',
  job: { id: 'job-demo-44', number: 'MJ-DEMO-0044', status: 'HANDED_BACK' },
  photos: 1,
  voiceNotes: 0,
  progress: progress({ step: 'FIXED', acknowledgedAt: '2026-10-31T07:31:00.000Z', onTheWayAt: '2026-10-31T07:35:00.000Z', fixedAt: '2026-10-31T08:30:00.000Z', canConfirm: true }),
  reportedAt: '2026-10-31T07:30:00.000Z',
})
const COMING = request({
  id: 'request-demo-3',
  machine: { id: 'machine-demo-sew-23', assetNumber: 'DEMO-SEW-23', status: 'DOWN', class: lockstitch },
  symptom: SYMPTOMS[3]!,
  description: 'Gocciola sotto il piano.',
  unsafe: false,
  locking: false,
  status: 'ACKNOWLEDGED',
  job: null,
  photos: 0,
  voiceNotes: 1,
  progress: progress({ step: 'ON_THE_WAY', acknowledgedAt: '2026-10-31T08:36:00.000Z', onTheWayAt: '2026-10-31T08:38:00.000Z' }),
  reportedAt: '2026-10-31T08:34:00.000Z',
})
const NEW_LOCK = request({ id: 'request-demo-4', status: 'NEW', job: null, progress: progress(), routing: { routedTo: { kind: 'TEAM' }, escalationLevel: 0 }, reportedAt: '2026-10-31T08:40:00.000Z' })
const REPORTED = [NEW_LOCK, COMING, FIXED]

const look = (extra: Partial<FloorRequestRecord> = {}, of: FloorRequest = FIXED): FloorRequestRecord => ({ request: of, files: [PHOTO, VOICE], canAcknowledge: false, canGo: false, canConfirm: of.progress.canConfirm, ...extra })
const requestStep = (extra: Partial<Extract<MachineViewModel['step'], { kind: 'request' }>> = {}, record: FloorRequestRecord = look()): MachineViewModel['step'] => ({ kind: 'request', record, back: 'which', ...extra })

/** A made-up photo for the dialog: a grey card of the machine's shape (a data address, so the review needs no store). */
const DEMO_PHOTO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 30'%3E%3Crect width='40' height='30' fill='%23888'/%3E%3Crect x='6' y='8' width='28' height='12' fill='%23bbb'/%3E%3C/svg%3E"

const QUEUE: QueueEntry[] = [
  { request: NEW_LOCK, toMe: true, canAcknowledge: true, canGo: true },
  { request: { ...COMING, progress: progress({ step: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-31T08:36:00.000Z' }) }, toMe: false, canAcknowledge: false, canGo: true },
  { request: { ...FIXED, id: 'request-demo-5', status: 'ACKNOWLEDGED', job: null, progress: progress({ step: 'ON_THE_WAY', acknowledgedAt: AT, onTheWayAt: AT }), routing: { routedTo: { kind: 'TECHNICIAN' }, escalationLevel: 1 } }, toMe: false, canAcknowledge: false, canGo: false },
]

export const designScreen = defineDesignScreen<MachineViewModel>({
  screen: 'SCR-179',
  title: 'Floor machine problem & technician job',
  view: onFloor(MachineView),
  cases: [
    // ---- the operator: which machine -------------------------------------------------------------------------------------
    { id: 'which', label: 'Operator: which machine? The station’s machines and the tag scan', model: base(which()), note: 'Scan the machine’s QR tag (it holds the asset number) or tap one of the station’s machines. Opened from the Machine problem tile (every station mode, plant.report).' },
    {
      id: 'which-locked',
      label: 'A machine at the station locked as unsafe (banner in our words)',
      model: base(which({ machines: [DOWN, LOCKED] })),
      note: 'The API’s banner sentence is English: the screen says it from the machines’ states. A down machine is said too.',
    },
    { id: 'which-blocked', label: 'Every machine do-not-use: the station takes no scans', model: base(which({ machines: [LOCKED], blocked: true })) },
    { id: 'which-not-found', label: 'A tag that opens nothing', model: base(which({ scanned: { code: 'DEMO-XX-99', why: 'notFound' } })) },
    { id: 'which-reading', label: 'Looking up a scanned tag', model: base(which({ reading: 'DEMO-SEW-21' })) },
    { id: 'which-offline', label: 'Offline: the machines as this tablet read them', model: offline(which({ asOf: AT })), note: 'A report still works offline: it is saved in the queue.' },
    { id: 'which-offline-tag', label: 'Offline: a tag the tablet never read', model: offline(which({ asOf: AT, scanned: { code: 'DEMO-PRS-01', why: 'offline' } })) },
    { id: 'which-no-station', label: 'A tablet without a station: scan the tag', model: base(which({ station: null, machines: [] })) },
    { id: 'which-no-permission', label: 'A worker whose role may not report (held with the reason)', model: base(which(), NO_REPORT), note: 'Fail closed: the scan field and the tiles say why. (Every floor role holds plant.report: Owner answer H1.)' },
    { id: 'loading', label: 'Reading the station’s machines', model: base({ kind: 'loading' }) },
    {
      id: 'which-reported',
      label: 'Reported here: the station’s reports under way, “does it work?” first (B-W2b-102)',
      model: base(which({ requests: REPORTED })),
      note: 'GET /plant/floor/requests: this station’s reports of the last 7 days not closed and not yet confirmed. A row opens the report’s progress. Nobody is named.',
    },
    { id: 'which-reported-changed', label: 'Reported here: the live stream changed two rows (they wait behind Show)', model: base(which({ requests: REPORTED, requestsPending: 2 })), note: 'B-W2b-28: rows never move under a finger; the station’s own step goes in at once.' },

    // ---- what is wrong ------------------------------------------------------------------------------------------------------
    { id: 'symptom', label: 'What is wrong? Nothing picked yet (held with the reason)', model: base({ kind: 'symptom', machine: SEW_A, draft: EMPTY_DRAFT }), note: 'DS ReasonGrid (D20): the machine’s class symptoms and every class’s. An optional photo or voice note (B-W2b-102).' },
    { id: 'symptom-picked', label: 'Thread breaks picked: Report · it still runs / Report · machine down', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-thread_breaks' } }) },
    { id: 'symptom-unsafe', label: 'Guard missing: locks the machine at once (H1) and offers Report an incident (it opens SCR-230 with this machine)', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-guard_missing' } }), note: 'The main action becomes Report · lock the machine; the machine is marked do not use when the office records it.' },
    { id: 'symptom-marked-unsafe', label: 'Anyone may mark it unsafe (oil leak + "It is unsafe: lock it")', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-oil_leak', unsafe: true } }) },
    { id: 'symptom-other', label: 'Other: a few words are asked', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-other' } }) },
    { id: 'symptom-other-words', label: 'Other with words: ready', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-other', words: 'Il pedale resta giù.' } }) },
    { id: 'symptom-offline', label: 'Offline: the report queues on the tablet; photo and voice note held (a picture needs the network)', model: offline({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-noise' }, asOf: AT }) },
    { id: 'symptom-locked-machine', label: 'A machine that is locked already', model: base({ kind: 'symptom', machine: LOCKED, draft: EMPTY_DRAFT }) },
    {
      id: 'symptom-media',
      label: 'A photo and a voice note taken with the report (B-W2b-102, QHS-189)',
      model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-oil_leak', media: [taken('PHOTO', 1), taken('AUDIO', 2)] } }),
      note: 'Kept in this page only (never in the queue: it has no bytes); sent to the request once the office records the report.',
    },
    { id: 'symptom-media-full', label: 'Four taken: no more (held with the reason)', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-noise', media: [taken('PHOTO', 1), taken('PHOTO', 2), taken('PHOTO', 3), taken('AUDIO', 4)] } }) },
    { id: 'symptom-photo', label: 'The camera: keep faces out, mark the spot (DS PhotoCapture)', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-oil_leak' }, capture: 'PHOTO' }) },
    { id: 'symptom-voice', label: 'The recorder: at most a minute, never a name (composed)', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-noise' }, capture: 'AUDIO' }) },

    // ---- sent -------------------------------------------------------------------------------------------------------------------
    { id: 'sent-saved', label: 'Sent offline: saved on this tablet (one tick), says plainly that it waits', model: offline({ kind: 'sent', machine: SEW_A, symptom: 'Il filo si rompe', unsafe: false, down: true, ticks: 'saved' }) },
    { id: 'sent-sending', label: 'Sending', model: base({ kind: 'sent', machine: SEW_A, symptom: 'Il filo si rompe', unsafe: false, down: true, ticks: 'sending' }) },
    { id: 'sent-recorded', label: 'Recorded by the office (two ticks): the machine is now down', model: base({ kind: 'sent', machine: SEW_A, symptom: 'Il filo si rompe', unsafe: false, down: true, ticks: 'recorded', now: { status: 'DOWN', locked: false } }) },
    { id: 'sent-unsafe', label: 'Reported unsafe: the machine is locked', model: base({ kind: 'sent', machine: SEW_A, symptom: 'Protezione mancante', unsafe: true, down: true, ticks: 'recorded', now: { status: 'DO_NOT_USE', locked: true } }) },
    {
      id: 'sent-media',
      label: 'Recorded: the photo is added, the voice note going up; Follow it opens the progress (B-W2b-102)',
      model: base({ kind: 'sent', machine: SEW_A, symptom: 'Perdita d’olio', unsafe: false, down: true, ticks: 'recorded', now: { status: 'DOWN', locked: false }, requestId: 'request-demo-3', uploads: [{ id: 'taken-1', kind: 'PHOTO', name: 'DEMO-SEW-21-photo-1.jpg', state: 'added' }, { id: 'taken-2', kind: 'AUDIO', name: 'DEMO-SEW-21-voice-2.webm', state: 'sending' }] }),
    },
    { id: 'sent-media-failed', label: 'A photo that did not go up: Try again', model: base({ kind: 'sent', machine: SEW_A, symptom: 'Perdita d’olio', unsafe: false, down: false, ticks: 'recorded', requestId: 'request-demo-3', uploads: [{ id: 'taken-1', kind: 'PHOTO', name: 'DEMO-SEW-21-photo-1.jpg', state: 'failed' }] }) },
    { id: 'sent-media-waiting', label: 'Saved offline: the photo waits for the report', model: offline({ kind: 'sent', machine: SEW_A, symptom: 'Rumore', unsafe: false, down: false, ticks: 'saved', uploads: [{ id: 'taken-1', kind: 'PHOTO', name: 'DEMO-SEW-21-photo-1.jpg', state: 'waiting' }] }) },
    { id: 'sent-incident', label: 'Guard missing reported: Report an incident offered (it opens SCR-230 with this machine)', model: base({ kind: 'sent', machine: SEW_A, symptom: 'Protezione mancante', unsafe: true, down: true, ticks: 'recorded', now: { status: 'DO_NOT_USE', locked: true }, requestId: 'request-demo-4', incident: true }) },
    { id: 'sent-refused', label: 'Refused by the office (in our words)', model: base({ kind: 'sent', machine: SEW_A, symptom: null, unsafe: false, down: false, ticks: 'refused', refusal: { code: 'SYMPTOM_INACTIVE', message: 'This symptom is no longer offered.' } }) },

    // ---- one report's progress (B-W2b-102, QHS-180) ------------------------------------------------------------------------------
    { id: 'request-fixed', label: 'Fixed: “Does it work?” — It works (the station confirms)', model: base(requestStep()), note: 'POST /plant/floor/requests/:id/works online first; offline it waits on the tablet (plant.request.progress) under the same id.' },
    { id: 'request-reported', label: 'Reported: waiting for maintenance (It works held with the reason)', model: base(requestStep({}, look({}, { ...COMING, status: 'NEW', progress: progress(), routing: { routedTo: { kind: 'TEAM' }, escalationLevel: 0 } }))) },
    { id: 'request-on-the-way', label: 'A technician is on the way', model: base(requestStep({}, look({}, COMING))) },
    { id: 'request-locked', label: 'Locked as unsafe: nobody confirms before the sign-safe (H1)', model: base(requestStep({}, look({}, NEW_LOCK))) },
    { id: 'request-escalated', label: 'Not seen in time: passed on (escalation level 1)', model: base(requestStep({}, look({}, { ...COMING, status: 'NEW', progress: progress(), routing: { routedTo: { kind: 'TECHNICIAN' }, escalationLevel: 1 } }))) },
    { id: 'request-works', label: 'It works: confirmed (the line says so)', model: base(requestStep({ done: 'works' }, look({ canConfirm: false }, { ...FIXED, progress: { ...FIXED.progress, step: 'WORKS', worksAt: AT, canConfirm: false } }))) },
    { id: 'request-merged', label: 'Joined to another report of the machine: its progress', model: base(requestStep({}, look({ files: [] }, { ...COMING, status: 'MERGED' }))) },
    { id: 'request-closed', label: 'Closed without a job: nothing to confirm', model: base(requestStep({}, look({ files: [] }, { ...COMING, status: 'CLOSED', progress: progress({ step: 'FIXED', acknowledgedAt: AT, fixedAt: AT, closedWithoutJob: true }) }))) },
    { id: 'request-kept', label: 'Offline: It works saved on the tablet', model: offline(requestStep({ done: 'kept', asOf: AT })) },
    { id: 'request-refused', label: 'It works refused: not fixed yet (in our words)', model: base(requestStep({ problem: { kind: 'refused', code: 'NOT_FIXED_YET', message: 'Not handed back yet.', fix: null } })) },
    { id: 'request-lead', label: 'The line lead confirms the handed-back machine works', model: base(requestStep(), LEAD), note: 'POST /plant/floor/jobs/:id/confirm (floor.lead): online only, once.' },
    { id: 'request-technician', label: 'Technician on a new request: Seen · On my way', model: base(requestStep({ back: 'jobs' }, look({ canAcknowledge: true, canGo: true }, NEW_LOCK)), TECHNICIAN) },
    { id: 'request-photo', label: 'A photo of the report opened on the tablet', model: base(requestStep({ peek: { fileId: PHOTO.id, kind: 'PHOTO', name: PHOTO.originalName, url: DEMO_PHOTO } })), note: 'GET /plant/floor/files/:id/download (the floor holds no files right): the bytes kept as a blob in this page only.' },
    { id: 'request-voice-opening', label: 'A voice note opening', model: base(requestStep({ peek: { fileId: VOICE.id, kind: 'AUDIO', name: VOICE.originalName, url: null } })) },
    { id: 'request-uploading', label: 'Adding a photo to a report under way', model: base(requestStep({ uploading: true }, look({}, COMING))) },
    { id: 'request-no-permission', label: 'A role that does not report: It works and Add held with the reason', model: base(requestStep(), NO_REPORT) },

    // ---- the technician ----------------------------------------------------------------------------------------------------------
    { id: 'jobs', label: 'Technician: the site’s requests (sent to me first) above My jobs (mine or nobody’s, urgent first)', model: base({ kind: 'jobs', jobs: JOBS, queue: QUEUE }, TECHNICIAN), note: 'The keys sit in the footer’s information icon. A floor technician never sees another person’s name.' },
    { id: 'jobs-empty', label: 'My jobs: none; no open request', model: base({ kind: 'jobs', jobs: [], queue: [] }, TECHNICIAN) },
    { id: 'jobs-queue-changed', label: 'Requests: a new one arrived (waits behind Show)', model: base({ kind: 'jobs', jobs: JOBS, queue: QUEUE, queuePending: 1 }, TECHNICIAN) },
    { id: 'jobs-offline', label: 'My jobs offline: as of', model: offline({ kind: 'jobs', jobs: JOBS, asOf: AT }, TECHNICIAN) },
    { id: 'job-new', label: 'A new job: Start work', model: base({ kind: 'job', record: record({ status: 'NEW', startedAt: null, ownership: 'NOBODY' }, [request({ status: 'JOB_MADE', locking: false, unsafe: false, symptom: SYMPTOMS[1]!, photos: 0 })]) }, TECHNICIAN) },
    {
      id: 'job-locked',
      label: 'In progress on a locked machine: sign the unsafe request safe, hand back, wait for parts',
      model: base({ kind: 'job', record: record() }, TECHNICIAN),
      note: 'The photos and voice notes open on the tablet (B-W2b-102). The repeat-failure hint: 3 problems in 30 days.',
    },
    { id: 'job-started', label: 'Just started (the line says what changed)', model: base({ kind: 'job', record: record(), done: 'started' }, TECHNICIAN) },
    { id: 'job-lead', label: 'Handed back: the line lead confirms it works on the job', model: base({ kind: 'job', record: { ...record({ status: 'HANDED_BACK', handedBack: { at: AT, machineAfter: 'RUNNING', failureCode: 'WORN_PART', minutesSpent: 38 } }), canConfirm: true, files: [BEFORE] } }, { ...TECHNICIAN, lead: true }) },
    { id: 'job-not-yours', label: 'Another technician’s job: read only, moves held', model: base({ kind: 'job', record: record({ ownership: 'OTHER' }) }, TECHNICIAN) },
    { id: 'job-offline', label: 'Offline: the job as read, moves held with the reason', model: offline({ kind: 'job', record: record(), asOf: AT }, TECHNICIAN) },
    { id: 'job-refused', label: 'A move refused (the job changed meanwhile)', model: base({ kind: 'job', record: record(), problem: { kind: 'refused', code: 'MOVE_NOT_ALLOWED', message: 'Job MJ-DEMO-0041 is handed back: it cannot be started now.', fix: 'Read it again.' } }, TECHNICIAN) },
    // ---- close on one screen (B-W2b-102, QHS-190) ------------------------------------------------------------------------------
    {
      id: 'hand-back',
      label: 'Close on one screen: what was done, what failed, the time, photos, the machine after (running held while locked)',
      model: base({ kind: 'handBack', record: record(), draft: closeDraftOf(record()), files: [] }, TECHNICIAN),
      note: 'Three taps on the usual path: action → failure code → Hand back (running is preselected once nothing locks the machine). The time is the office’s count from Start.',
    },
    {
      id: 'hand-back-ready',
      label: 'Close ready: replaced a part, worn part, running; a photo before the work',
      model: base({ kind: 'handBack', record: UNLOCKED, draft: { ...closeDraftOf(UNLOCKED), action: 'REPLACED_PART', failure: 'WORN_PART', words: 'Carter nuovo montato.' }, files: [BEFORE] }, TECHNICIAN),
    },
    { id: 'hand-back-other', label: 'Close: Other without words (held with the reason)', model: base({ kind: 'handBack', record: UNLOCKED, draft: { ...closeDraftOf(UNLOCKED), action: 'OTHER', failure: 'OTHER' }, files: [] }, TECHNICIAN) },
    { id: 'hand-back-not-started', label: 'Close a job never started: no time counted', model: base({ kind: 'handBack', record: { ...UNLOCKED, close: { minutesSoFar: null, runningHeld: false, canHandBack: true } }, draft: closeDraftOf(UNLOCKED), files: [] }, TECHNICIAN) },
    { id: 'hand-back-photo', label: 'Close: the camera for a photo after the work (no faces)', model: base({ kind: 'handBack', record: UNLOCKED, draft: closeDraftOf(UNLOCKED), files: [BEFORE], capture: { kind: 'PHOTO', category: 'AFTER_WORK' } }, TECHNICIAN) },
    { id: 'hand-back-voice', label: 'Close: a voice note', model: base({ kind: 'handBack', record: UNLOCKED, draft: closeDraftOf(UNLOCKED), files: [BEFORE], capture: { kind: 'AUDIO' } }, TECHNICIAN) },
    { id: 'hand-back-uploading', label: 'Close: a photo going up (Hand back waits for it)', model: base({ kind: 'handBack', record: UNLOCKED, draft: { ...closeDraftOf(UNLOCKED), action: 'CLEANED', failure: 'LUBRICATION' }, files: [BEFORE], uploading: true }, TECHNICIAN) },
    { id: 'hand-back-offline', label: 'Close offline: held with the reason', model: offline({ kind: 'handBack', record: UNLOCKED, draft: { ...closeDraftOf(UNLOCKED), action: 'ADJUSTED', failure: 'SETTINGS' }, files: [] }, TECHNICIAN) },
    { id: 'sign', label: 'Sign safe: what was checked, the machine after', model: base({ kind: 'sign', record: record(), request: request(), draft: { words: 'Carter rimontato e provato.', after: 'UNDER_MAINTENANCE' } }, TECHNICIAN), note: 'Owner answer H1: only a technician signs it safe; the PIN is asked at the act.' },
    { id: 'sign-pin', label: 'Sign safe: the PIN', model: base({ kind: 'sign', record: record(), request: request(), draft: { words: 'Carter rimontato e provato.', after: 'UNDER_MAINTENANCE' }, pin: true }, TECHNICIAN) },
    { id: 'sign-pin-wrong', label: 'Sign safe: a wrong PIN', model: base({ kind: 'sign', record: record(), request: request(), draft: { words: 'Carter rimontato e provato.', after: 'RUNNING' }, pin: true, pinProblem: 'wrong' }, TECHNICIAN) },
    { id: 'sign-refused', label: 'Sign safe refused: signed already', model: base({ kind: 'sign', record: record(), request: request(), draft: { words: 'Carter rimontato.', after: 'RUNNING' }, problem: { kind: 'refused', code: 'SIGNED_ALREADY', message: 'Signed already.', fix: null } }, TECHNICIAN) },
    { id: 'problem', label: 'The server does not answer', model: base({ kind: 'problem', problem: { kind: 'unavailable' }, back: 'which' }) },
  ],
})
