import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { FloorJob, FloorRequest, JobRecord, StationMachine, Symptom } from './api'
import { EMPTY_DRAFT, EMPTY_HAND_BACK, machineCan, type MachineCan } from './model'
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

const request = (extra: Partial<FloorRequest> = {}): FloorRequest => ({
  id: 'request-demo-1',
  machine: { id: LOCKED.id, assetNumber: LOCKED.assetNumber },
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
  requestIds: ['request-demo-1'],
  ageMinutes: 43,
  open: true,
  createdAt: '2026-10-31T07:58:00.000Z',
  version: 4,
  ...extra,
})

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
})

const JOBS: FloorJob[] = [
  job(),
  job({ id: 'job-demo-44', number: 'MJ-DEMO-0044', machine: { id: DOWN.id, assetNumber: DOWN.assetNumber, status: 'DOWN', locked: false, class: lockstitch, station: STATION, line: LINE }, type: 'CORRECTIVE', problem: 'Thread breaks', symptom: SYMPTOMS[1]!, priority: 'P1', status: 'NEW', ownership: 'NOBODY', startedAt: null, ageMinutes: 12 }),
  job({ id: 'job-demo-45', number: 'MJ-DEMO-0045', machine: { id: 'machine-demo-cut-03', assetNumber: 'DEMO-CUT-03', status: 'RUNNING', locked: false, class: { id: 'class-cutting', code: 'CUTTING_TABLE', labelIt: 'Tavolo di taglio', labelEn: 'Cutting table', labelI18n: {}, icon: 'scissors' }, station: place('CUT-01', 'Taglio 1'), line: null }, type: 'CORRECTIVE', problem: 'Noise', symptom: SYMPTOMS[4]!, priority: 'P3', status: 'WAITING_PARTS', ageMinutes: 1570 }),
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

    // ---- what is wrong ------------------------------------------------------------------------------------------------------
    { id: 'symptom', label: 'What is wrong? Nothing picked yet (held with the reason)', model: base({ kind: 'symptom', machine: SEW_A, draft: EMPTY_DRAFT }), note: 'DS ReasonGrid (D20): the machine’s class symptoms and every class’s. The photo is held: the floor may not send files yet.' },
    { id: 'symptom-picked', label: 'Thread breaks picked: Report · it still runs / Report · machine down', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-thread_breaks' } }) },
    { id: 'symptom-unsafe', label: 'Guard missing: locks the machine at once (H1)', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-guard_missing' } }), note: 'The main action becomes Report · lock the machine; the machine is marked do not use when the office records it.' },
    { id: 'symptom-marked-unsafe', label: 'Anyone may mark it unsafe (oil leak + "It is unsafe: lock it")', model: base({ kind: 'symptom', machine: SEW_A, draft: { symptomId: 'symptom-oil_leak', words: '', unsafe: true } }) },
    { id: 'symptom-other', label: 'Other: a few words are asked', model: base({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-other' } }) },
    { id: 'symptom-other-words', label: 'Other with words: ready', model: base({ kind: 'symptom', machine: SEW_A, draft: { symptomId: 'symptom-other', words: 'Il pedale resta giù.', unsafe: false } }) },
    { id: 'symptom-offline', label: 'Offline: the report queues on the tablet', model: offline({ kind: 'symptom', machine: SEW_A, draft: { ...EMPTY_DRAFT, symptomId: 'symptom-noise' }, asOf: AT }) },
    { id: 'symptom-locked-machine', label: 'A machine that is locked already', model: base({ kind: 'symptom', machine: LOCKED, draft: EMPTY_DRAFT }) },

    // ---- sent -------------------------------------------------------------------------------------------------------------------
    { id: 'sent-saved', label: 'Sent offline: saved on this tablet (one tick), says plainly that it waits', model: offline({ kind: 'sent', machine: SEW_A, symptom: 'Il filo si rompe', unsafe: false, down: true, ticks: 'saved' }) },
    { id: 'sent-sending', label: 'Sending', model: base({ kind: 'sent', machine: SEW_A, symptom: 'Il filo si rompe', unsafe: false, down: true, ticks: 'sending' }) },
    { id: 'sent-recorded', label: 'Recorded by the office (two ticks): the machine is now down', model: base({ kind: 'sent', machine: SEW_A, symptom: 'Il filo si rompe', unsafe: false, down: true, ticks: 'recorded', now: { status: 'DOWN', locked: false } }) },
    { id: 'sent-unsafe', label: 'Reported unsafe: the machine is locked', model: base({ kind: 'sent', machine: SEW_A, symptom: 'Protezione mancante', unsafe: true, down: true, ticks: 'recorded', now: { status: 'DO_NOT_USE', locked: true } }) },
    { id: 'sent-refused', label: 'Refused by the office (in our words)', model: base({ kind: 'sent', machine: SEW_A, symptom: null, unsafe: false, down: false, ticks: 'refused', refusal: { code: 'SYMPTOM_INACTIVE', message: 'This symptom is no longer offered.' } }) },

    // ---- the technician ----------------------------------------------------------------------------------------------------------
    { id: 'jobs', label: 'Technician: My jobs (mine or nobody’s, urgent first, waiting time)', model: base({ kind: 'jobs', jobs: JOBS }, TECHNICIAN), note: 'The keys sit in the footer’s information icon. A floor technician never sees another person’s name.' },
    { id: 'jobs-empty', label: 'My jobs: none', model: base({ kind: 'jobs', jobs: [] }, TECHNICIAN) },
    { id: 'jobs-offline', label: 'My jobs offline: as of', model: offline({ kind: 'jobs', jobs: JOBS, asOf: AT }, TECHNICIAN) },
    { id: 'job-new', label: 'A new job: Start work', model: base({ kind: 'job', record: record({ status: 'NEW', startedAt: null, ownership: 'NOBODY' }, [request({ status: 'JOB_MADE', locking: false, unsafe: false, symptom: SYMPTOMS[1]!, photos: 0 })]) }, TECHNICIAN) },
    {
      id: 'job-locked',
      label: 'In progress on a locked machine: sign the unsafe request safe, hand back, wait for parts',
      model: base({ kind: 'job', record: record() }, TECHNICIAN),
      note: 'The photos stay in the office (the floor may not open files). The repeat-failure hint: 3 problems in 30 days.',
    },
    { id: 'job-started', label: 'Just started (the line says what changed)', model: base({ kind: 'job', record: record(), done: 'started' }, TECHNICIAN) },
    { id: 'job-not-yours', label: 'Another technician’s job: read only, moves held', model: base({ kind: 'job', record: record({ ownership: 'OTHER' }) }, TECHNICIAN) },
    { id: 'job-offline', label: 'Offline: the job as read, moves held with the reason', model: offline({ kind: 'job', record: record(), asOf: AT }, TECHNICIAN) },
    { id: 'job-refused', label: 'A move refused (the job changed meanwhile)', model: base({ kind: 'job', record: record(), problem: { kind: 'refused', code: 'MOVE_NOT_ALLOWED', message: 'Job MJ-DEMO-0041 is handed back: it cannot be started now.', fix: 'Read it again.' } }, TECHNICIAN) },
    { id: 'hand-back', label: 'Hand back: what was done, the machine after (running held while locked)', model: base({ kind: 'handBack', record: record(), draft: EMPTY_HAND_BACK }, TECHNICIAN) },
    { id: 'hand-back-ready', label: 'Hand back ready: replaced a part, do not use', model: base({ kind: 'handBack', record: record({ machine: { ...job().machine, status: 'UNDER_MAINTENANCE', locked: false } }, [request({ locking: false, signedSafe: { at: AT } })]), draft: { done: 'replaced', words: 'Carter nuovo montato.', after: 'RUNNING' } }, TECHNICIAN) },
    { id: 'sign', label: 'Sign safe: what was checked, the machine after', model: base({ kind: 'sign', record: record(), request: request(), draft: { words: 'Carter rimontato e provato.', after: 'UNDER_MAINTENANCE' } }, TECHNICIAN), note: 'Owner answer H1: only a technician signs it safe; the PIN is asked at the act.' },
    { id: 'sign-pin', label: 'Sign safe: the PIN', model: base({ kind: 'sign', record: record(), request: request(), draft: { words: 'Carter rimontato e provato.', after: 'UNDER_MAINTENANCE' }, pin: true }, TECHNICIAN) },
    { id: 'sign-pin-wrong', label: 'Sign safe: a wrong PIN', model: base({ kind: 'sign', record: record(), request: request(), draft: { words: 'Carter rimontato e provato.', after: 'RUNNING' }, pin: true, pinProblem: 'wrong' }, TECHNICIAN) },
    { id: 'sign-refused', label: 'Sign safe refused: signed already', model: base({ kind: 'sign', record: record(), request: request(), draft: { words: 'Carter rimontato.', after: 'RUNNING' }, problem: { kind: 'refused', code: 'SIGNED_ALREADY', message: 'Signed already.', fix: null } }, TECHNICIAN) },
    { id: 'problem', label: 'The server does not answer', model: base({ kind: 'problem', problem: { kind: 'unavailable' }, back: 'which' }) },
  ],
})
